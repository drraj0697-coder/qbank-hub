-- Bounded aggregate, using the existing (user_id,question_id,answered_at) index.
create or replace function public.qbank_question_history(p_question_ids uuid[])
returns table(question_id uuid,correct_count bigint,wrong_count bigint)
language plpgsql stable security invoker set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if cardinality(p_question_ids)>100 then raise exception 'Maximum 100 question IDs'; end if;
 return query select ids.id,count(a.id) filter(where a.is_correct is true),count(a.id) filter(where a.is_correct is false)
 from (select distinct unnest(p_question_ids) id) ids
 left join public.question_attempts a on a.question_id=ids.id and a.user_id=(select auth.uid()) and nullif(trim(a.selected_option),'') is not null
 group by ids.id;
end;
$$;
-- Minimal shared history. No backfill, score rewrite, new table, or scheduling-rule change.
create or replace function public.qbank_record_attempt_v2(
  p_question_id uuid,
  p_selected_option text,
  p_mode text,
  p_event_id uuid,
  p_test_session_id uuid default null,
  p_time_spent_seconds integer default null,
  p_confidence text default null,
  p_error_reason text default null
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_correct boolean;
  v_attempt_id uuid;
  v_state public.user_question_state;
  v_srm jsonb;
  v_occurred_at timestamptz := now();
  v_latest boolean;
  v_existing public.question_attempts;
  v_snapshot jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_event_id is null then raise exception 'Event ID is required'; end if;
  if nullif(trim(p_selected_option),'') is null then raise exception 'Answered option required'; end if;
  -- Same lock as Active Recall v2; retries and concurrent modes serialize per learner.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select * into v_existing from public.question_attempts
    where user_id=v_user and client_event_id=p_event_id;
  if found and (v_existing.question_id<>p_question_id or v_existing.selected_option<>p_selected_option) then
    raise exception 'Conflicting attempt event';
  end if;
  if v_existing.id is null and p_mode='test' and p_test_session_id is not null then
    select * into v_existing from public.question_attempts where user_id=v_user
      and test_session_id=p_test_session_id and question_id=p_question_id order by answered_at desc limit 1;
  end if;
  if v_existing.id is not null then
    select * into v_state from public.user_question_state where user_id=v_user and question_id=p_question_id;
    return jsonb_build_object('attempt_inserted',false,'is_correct',v_existing.is_correct,'history_only',v_existing.answered_at<v_state.last_attempted_at,'answered_at',v_existing.answered_at,
      'history',(select to_jsonb(h) from public.qbank_question_history(array[p_question_id]) h),
      'attempts',v_state.attempts,'correct_attempts',v_state.correct_attempts,
      'active',v_state.srm_active,'state',v_state.srm_state,'due_at',v_state.srm_due_at,'interval_minutes',v_state.srm_interval_minutes);
  end if;
  if p_test_session_id is not null and not exists(select 1 from public.test_sessions where id=p_test_session_id and user_id=v_user) then
    raise exception 'Test session not found';
  end if;
  if not exists(select 1 from public.questions q where q.id=p_question_id and (q.is_usable or p_mode='test')) then
    raise exception 'Question is missing or quarantined';
  end if;
  -- The saved answer supplies event time, not the time a delayed request arrives.
  select least(coalesce(a.answered_at,now()),now()) into v_occurred_at
    from public.test_answers a where a.session_id=p_test_session_id and a.question_id=p_question_id
      and coalesce(a.client_event_id,a.id)=p_event_id and a.selected_option=p_selected_option;
  v_occurred_at:=coalesce(v_occurred_at,now());
  v_correct := public.qbank_is_answer_correct(p_question_id,p_selected_option);
  if p_mode='test' then
    if not exists(select 1 from public.test_sessions where id=p_test_session_id and user_id=v_user and status in ('completed','timed_out')) then
      raise exception 'Complete the test before recording outcomes';
    end if;
    select sq.question_snapshot into v_snapshot from public.test_session_questions sq
      join public.test_answers a using(session_id,question_id)
      where sq.session_id=p_test_session_id and sq.question_id=p_question_id and a.selected_option=p_selected_option;
    if v_snapshot is null then raise exception 'Saved test answer not found'; end if;
    v_correct:=public.qbank_normalize_answer_keys(p_selected_option)=public.qbank_normalize_answer_keys(coalesce(
      (select string_agg(k,',') from jsonb_array_elements_text(case when jsonb_typeof(v_snapshot->'correct_option_keys')='array' then v_snapshot->'correct_option_keys' else '[]'::jsonb end) k),
      case when coalesce(v_snapshot->>'correct_answer','') ~ '^\s*[[:alnum:]]+\s*[.):\-]\s*.+'
        then substring(v_snapshot->>'correct_answer' from '^\s*([[:alnum:]]+)') else v_snapshot->>'correct_answer' end));
  end if;
  select * into v_state from public.user_question_state where user_id=v_user and question_id=p_question_id for update;
  v_latest:=v_state.last_attempted_at is null or v_occurred_at>=v_state.last_attempted_at;

  insert into public.question_attempts(user_id,question_id,selected_option,is_correct,mode,test_session_id,
    answered_at,time_spent_seconds,confidence,error_reason,client_event_id)
  values(v_user,p_question_id,p_selected_option,v_correct,coalesce(p_mode,'qbank'),p_test_session_id,
    v_occurred_at,greatest(coalesce(p_time_spent_seconds,0),0),case when v_correct then coalesce(nullif(p_confidence,'guess'),'unsure') end,
    p_error_reason,p_event_id)
  on conflict(user_id,client_event_id) where client_event_id is not null do nothing
  returning id into v_attempt_id;

  if v_attempt_id is not null then
    insert into public.user_question_state(user_id,question_id,attempts,correct_attempts,wrong,last_answer,last_is_correct,
      last_time_seconds,last_confidence,last_error_reason,last_attempted_at,last_wrong_at,total_time_seconds)
    values(v_user,p_question_id,1,case when v_correct then 1 else 0 end,not v_correct,p_selected_option,v_correct,
      greatest(coalesce(p_time_spent_seconds,0),0),case when v_correct then coalesce(nullif(p_confidence,'guess'),'unsure') end,
      p_error_reason,v_occurred_at,case when v_correct then null else v_occurred_at end,greatest(coalesce(p_time_spent_seconds,0),0))
    on conflict(user_id,question_id) do update set
      attempts=public.user_question_state.attempts+1,
      correct_attempts=public.user_question_state.correct_attempts+case when v_correct then 1 else 0 end,
      wrong=case when v_latest then not v_correct else public.user_question_state.wrong end,
      last_answer=case when v_latest then p_selected_option else public.user_question_state.last_answer end,
      last_is_correct=case when v_latest then v_correct else public.user_question_state.last_is_correct end,
      last_time_seconds=case when v_latest then greatest(coalesce(p_time_spent_seconds,0),0) else public.user_question_state.last_time_seconds end,
      last_confidence=case when v_latest then case when v_correct then coalesce(nullif(p_confidence,'guess'),'unsure') end else public.user_question_state.last_confidence end,
      last_error_reason=case when v_latest then p_error_reason else public.user_question_state.last_error_reason end,
      last_attempted_at=greatest(public.user_question_state.last_attempted_at,v_occurred_at),
      last_wrong_at=case when v_correct then public.user_question_state.last_wrong_at else greatest(public.user_question_state.last_wrong_at,v_occurred_at) end,
      total_time_seconds=public.user_question_state.total_time_seconds+greatest(coalesce(p_time_spent_seconds,0),0);
  end if;
  if v_attempt_id is not null and v_latest then
  v_srm := public.qbank_apply_srm_event(p_question_id,p_event_id,case when v_correct then 'correct' else 'incorrect' end,
    p_confidence,case when p_mode='recall' then 'recall' when p_mode='test' then 'test' else 'qbank' end,now());
  end if;
  select * into v_state from public.user_question_state where user_id=v_user and question_id=p_question_id;
  return coalesce(v_srm,jsonb_build_object('active',v_state.srm_active,'state',v_state.srm_state,'due_at',v_state.srm_due_at,'interval_minutes',v_state.srm_interval_minutes)) || jsonb_build_object('attempt_inserted',v_attempt_id is not null,'is_correct',v_correct,'history_only',not v_latest,'answered_at',v_occurred_at,
    'history',(select to_jsonb(h) from public.qbank_question_history(array[p_question_id]) h),
      'attempts',v_state.attempts,'correct_attempts',v_state.correct_attempts);
end;
$$;

-- Exact snapshot answer sets for future submissions. Existing completed scores remain unchanged.
CREATE OR REPLACE FUNCTION public.submit_test_session(p_session_id uuid, p_timed_out boolean DEFAULT false)
 RETURNS test_sessions
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_session public.test_sessions;
  v_correct integer := 0;
  v_answered integer := 0;
  v_total integer := 0;
  v_timed_out boolean := false;
  v_answer record;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  select * into v_session from public.test_sessions
  where id = p_session_id and user_id = auth.uid() for update;
  if not found then raise exception 'Test session not found'; end if;
  if v_session.status <> 'in_progress' then return v_session; end if;

  v_timed_out := p_timed_out or (
    case when v_session.timer_state->>'version'='1' then public.qbank_session_elapsed_ms(v_session.timer_state)>=v_session.total_questions*50000 else v_session.duration_minutes is not null and now() >= v_session.started_at + make_interval(mins => v_session.duration_minutes) end
  );
  select count(*) into v_total from public.test_session_questions where session_id = p_session_id;
  select count(*) into v_answered from public.test_answers
    where session_id = p_session_id and nullif(selected_option, '') is not null;
  select count(*) into v_correct
  from public.test_session_questions sq
  join public.test_answers a on a.session_id = sq.session_id and a.question_id = sq.question_id
  where sq.session_id = p_session_id
    and nullif(trim(a.selected_option),'') is not null
    and public.qbank_normalize_answer_keys(a.selected_option) =
      public.qbank_normalize_answer_keys(coalesce(
        (select string_agg(k,',') from jsonb_array_elements_text(
          case when jsonb_typeof(sq.question_snapshot->'correct_option_keys')='array'
            then sq.question_snapshot->'correct_option_keys' else '[]'::jsonb end) k),
        case when coalesce(sq.question_snapshot->>'correct_answer','') ~ '^\s*[[:alnum:]]+\s*[.):\-]\s*.+'
          then substring(sq.question_snapshot->>'correct_answer' from '^\s*([[:alnum:]]+)')
          else sq.question_snapshot->>'correct_answer' end));

  update public.test_sessions
  set status = case when v_timed_out then 'timed_out' else 'completed' end,
      completed_at = now(), timed_out = v_timed_out,
      total_questions = v_total, total_correct = v_correct,
      incorrect_count = v_answered - v_correct,
      unanswered_count = v_total - v_answered,
      total_time_seconds = case when timer_state->>'version'='1' then floor(public.qbank_session_elapsed_ms(timer_state)/1000)::integer else greatest(0, extract(epoch from now() - started_at)::integer) end
  where id = p_session_id returning * into v_session;
  -- One transaction and one browser request; no change to scoring or old completed tests.
  if v_session.mode='test' then
    for v_answer in select a.* from public.test_answers a join public.test_session_questions sq using(session_id,question_id)
      where a.session_id=p_session_id and nullif(trim(a.selected_option),'') is not null
      order by a.answered_at nulls first, a.question_id
    loop
      perform public.qbank_record_attempt_v2(v_answer.question_id,v_answer.selected_option,'test',
        coalesce(v_answer.client_event_id,v_answer.id),p_session_id,v_answer.time_spent_seconds,v_answer.confidence,v_answer.error_reason);
    end loop;
  end if;
  return v_session;
end;
$function$;

create or replace function public.qbank_home_review_counts()
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object('incorrect',count(*) filter(where u.wrong or u.last_is_correct=false),
  'bookmarked',count(*) filter(where u.bookmarked),'marked',count(*) filter(where u.marked_for_review or u.revision))
 from public.user_question_state u
 where u.user_id=(select auth.uid());
$$;
revoke all on function public.qbank_question_history(uuid[]) from public;
revoke all on function public.qbank_home_review_counts() from public;
grant execute on function public.qbank_question_history(uuid[]) to authenticated;
grant execute on function public.qbank_home_review_counts() to authenticated;
notify pgrst,'reload schema';

-- A successful immediate relearning retrieval earns one day but no spaced mastery credit.
create or replace function public.qbank_active_recall_record(p_question_id uuid,p_selected_option text,p_event_id uuid,p_test_session_id uuid,p_time_spent_seconds integer,p_strength text,p_error_reason text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare prior jsonb; result jsonb; key text; correct boolean; strong boolean; spaced boolean; failures integer; successes integer; step integer; minutes integer; mastery text; ladder integer[]:=array[15,1440,4320,10080,20160,43200,86400];
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if p_strength not in ('failed','partial','strong') or p_strength is null then raise exception 'Invalid strength'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select coalesce(m.unit_key,'q:'||p_question_id) into key from (select 1) x left join public.active_recall_reliable_map m on m.question_id=p_question_id;
 if exists(select 1 from public.active_recall_retrievals where user_id=auth.uid() and event_id=p_event_id) then
  if not exists(select 1 from public.active_recall_retrievals where user_id=auth.uid() and event_id=p_event_id and question_id=p_question_id) then raise exception 'Conflicting event'; end if;
  return (select to_jsonb(u)||jsonb_build_object('state',u.mastery) from public.active_recall_units u where user_id=auth.uid() and unit_key=key);
 end if;
 select unit into prior from public.qbank_active_recall_rows() r where r.unit_key=key;
 result:=public.qbank_record_attempt_v2(p_question_id,p_selected_option,'recall',p_event_id,p_test_session_id,p_time_spent_seconds,case when p_strength='strong' then 'sure' else 'unsure' end,p_error_reason);
 -- Late outcomes contribute to history but cannot roll back a newer unit schedule.
 if (result->>'history_only')::boolean or (result->>'answered_at')::timestamptz<(prior->>'last_reviewed_at')::timestamptz then return result; end if;
 select a.is_correct into correct from public.question_attempts a where a.user_id=auth.uid() and a.client_event_id=p_event_id and a.question_id=p_question_id;
 if correct is null then raise exception 'Attempt was not recorded'; end if;
 strong:=correct and p_strength='strong';
 spaced:=prior->>'last_reviewed_at' is null or now()-(prior->>'last_reviewed_at')::timestamptz>=interval '20 hours';
 select coalesce(max(i),1) into step from generate_subscripts(ladder,1) i where ladder[i]<=coalesce((prior->>'interval_minutes')::integer,0);
 if not correct or p_strength='failed' then
  step:=1;failures:=coalesce((prior->>'consecutive_failures')::integer,0)+1;successes:=0;
 else
  failures:=0;successes:=coalesce((prior->>'spaced_successes')::integer,0)+case when strong and spaced then 1 else 0 end;
  if strong and (spaced or step=1) then step:=least(7,step+1);elsif not strong then step:=greatest(1,least(step-1,3));end if;
 end if;
 minutes:=ladder[step];mastery:=case when failures>=2 then 'WEAK' when successes>=5 and step>=6 then 'MASTERED' when successes>=3 and step>=4 then 'STABLE' else 'LEARNING' end;
 insert into public.active_recall_units(user_id,unit_key,active,mastery,interval_minutes,due_at,last_reviewed_at,last_question_id,consecutive_failures,spaced_successes)
 values(auth.uid(),key,true,mastery,minutes,now()+make_interval(mins=>minutes),now(),p_question_id,failures,successes)
 on conflict(user_id,unit_key) do update set active=true,mastery=excluded.mastery,interval_minutes=excluded.interval_minutes,due_at=excluded.due_at,last_reviewed_at=excluded.last_reviewed_at,last_question_id=excluded.last_question_id,consecutive_failures=excluded.consecutive_failures,spaced_successes=excluded.spaced_successes,updated_at=now();
 insert into public.active_recall_retrievals(user_id,event_id,unit_key,question_id,strength,is_correct,mastery,interval_minutes) values(auth.uid(),p_event_id,key,p_question_id,p_strength,correct,mastery,minutes);
 return result||jsonb_build_object('active',true,'state',mastery,'due_at',now()+make_interval(mins=>minutes),'interval_minutes',minutes,'relearn',not correct or p_strength='failed');
end;
$$;

revoke all on function public.qbank_record_attempt_v2(uuid,text,text,uuid,uuid,integer,text,text) from public;
revoke all on function public.submit_test_session(uuid,boolean) from public;
grant execute on function public.qbank_record_attempt_v2(uuid,text,text,uuid,uuid,integer,text,text) to authenticated;
grant execute on function public.submit_test_session(uuid,boolean) to authenticated;
