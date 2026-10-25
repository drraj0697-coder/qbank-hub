-- Incorrect is an unresolved mistake, independent of latest correctness and SRM scheduling.
alter table public.user_question_state add column mistake_sure_streak smallint not null default 0
  check (mistake_sure_streak between 0 and 3);
-- Bounded lookup of at most three explicit successes, even after long runs of UNSURE answers.
create index question_attempts_explicit_sure_idx on public.question_attempts(user_id,question_id,answered_at)
 where is_correct is true and confidence='sure' and nullif(trim(selected_option),'') is not null;

create or replace function public.qbank_refresh_mistake_state(p_question_id uuid)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.user_question_state; n integer;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 select * into s from public.user_question_state where user_id=auth.uid() and question_id=p_question_id for update;
 if not found then return; end if;
 select count(*) into n from (
   select 1 from public.question_attempts a where a.user_id=auth.uid() and a.question_id=p_question_id
     and a.is_correct is true and a.confidence='sure' and nullif(trim(a.selected_option),'') is not null
     and a.answered_at>coalesce(s.last_wrong_at,'-infinity'::timestamptz)
   order by a.answered_at limit 3
 ) explicit_successes;
 update public.user_question_state set mistake_sure_streak=n,
   wrong=(s.last_wrong_at is not null or s.wrong or s.last_is_correct is false) and n<3
 where user_id=auth.uid() and question_id=p_question_id;
end;
$$;
revoke all on function public.qbank_refresh_mistake_state(uuid) from public;
grant execute on function public.qbank_refresh_mistake_state(uuid) to authenticated;

-- One-time reconstruction only. Never rewrite attempts/confidence, scores, or scheduling.
with mistakes as (
 select user_id,question_id,max(answered_at) last_wrong_at from public.question_attempts
 where is_correct is false and nullif(trim(selected_option),'') is not null group by user_id,question_id
), rebuilt as (
 select u.user_id,u.question_id,greatest(u.last_wrong_at,m.last_wrong_at) last_wrong_at,
   (m.question_id is not null or u.wrong or u.last_is_correct is false or u.last_wrong_at is not null) ever_wrong,
   (select count(*) from (select 1 from public.question_attempts a
      where a.user_id=u.user_id and a.question_id=u.question_id and a.is_correct is true
      and a.confidence='sure' and nullif(trim(a.selected_option),'') is not null
      and a.answered_at>coalesce(greatest(u.last_wrong_at,m.last_wrong_at),'-infinity'::timestamptz)
      order by a.answered_at limit 3) sure) streak
 from public.user_question_state u left join mistakes m using(user_id,question_id)
)
update public.user_question_state u set last_wrong_at=r.last_wrong_at,mistake_sure_streak=r.streak,wrong=coalesce(r.ever_wrong,false) and r.streak<3
from rebuilt r where r.user_id=u.user_id and r.question_id=u.question_id;

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
    v_occurred_at,greatest(coalesce(p_time_spent_seconds,0),0),p_confidence,
    p_error_reason,p_event_id)
  on conflict(user_id,client_event_id) where client_event_id is not null do nothing
  returning id into v_attempt_id;

  if v_attempt_id is not null then
    insert into public.user_question_state(user_id,question_id,attempts,correct_attempts,wrong,last_answer,last_is_correct,
      last_time_seconds,last_confidence,last_error_reason,last_attempted_at,last_wrong_at,total_time_seconds)
    values(v_user,p_question_id,1,case when v_correct then 1 else 0 end,not v_correct,p_selected_option,v_correct,
      greatest(coalesce(p_time_spent_seconds,0),0),p_confidence,
      p_error_reason,v_occurred_at,case when v_correct then null else v_occurred_at end,greatest(coalesce(p_time_spent_seconds,0),0))
    on conflict(user_id,question_id) do update set
      attempts=public.user_question_state.attempts+1,
      correct_attempts=public.user_question_state.correct_attempts+case when v_correct then 1 else 0 end,
      last_answer=case when v_latest then p_selected_option else public.user_question_state.last_answer end,
      last_is_correct=case when v_latest then v_correct else public.user_question_state.last_is_correct end,
      last_time_seconds=case when v_latest then greatest(coalesce(p_time_spent_seconds,0),0) else public.user_question_state.last_time_seconds end,
      last_confidence=case when v_latest then p_confidence else public.user_question_state.last_confidence end,
      last_error_reason=case when v_latest then p_error_reason else public.user_question_state.last_error_reason end,
      last_attempted_at=greatest(public.user_question_state.last_attempted_at,v_occurred_at),
      last_wrong_at=case when v_correct then public.user_question_state.last_wrong_at else greatest(public.user_question_state.last_wrong_at,v_occurred_at) end,
      total_time_seconds=public.user_question_state.total_time_seconds+greatest(coalesce(p_time_spent_seconds,0),0);
  end if;
  if v_attempt_id is not null then
    perform public.qbank_refresh_mistake_state(p_question_id);
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
 result:=public.qbank_record_attempt_v2(p_question_id,p_selected_option,'recall',p_event_id,p_test_session_id,p_time_spent_seconds,case when exists(select 1 from public.test_answers a where a.session_id=p_test_session_id and a.question_id=p_question_id and a.client_event_id=p_event_id)
   then (select a.confidence from public.test_answers a where a.session_id=p_test_session_id and a.question_id=p_question_id and a.client_event_id=p_event_id)
   else case when p_strength='strong' then 'sure' else 'unsure' end end,p_error_reason);
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


-- Selection only: resolved mistakes retain due/bookmark/importance eligibility.
create or replace function public.smart_recall_personal_candidates(p_subject text default null,p_limit integer default 90) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 with gi as materialized (
 select unnest(c.question_ids) question_id,c.subject,c.concept_id,c.primary_concept,c.global_importance_tier tier,c.global_importance_score score from public.pyq_concept_importance c
 ), ids as (
 select question_id from public.user_question_state where user_id=(select auth.uid())
 union select question_id from public.bookmarks where user_id=(select auth.uid())
 ), personal as materialized (
 select q.id question_id,coalesce(g.subject,s.name) subject,g.concept_id,g.primary_concept,g.tier,coalesce(g.score,0) score,
 coalesce(u.attempts,0) attempts,coalesce(u.wrong,false) incorrect,
 case when u.wrong then coalesce(u.srm_consecutive_incorrect,0) else 0 end repeated,
 coalesce(u.bookmarked,false) or exists(select 1 from public.bookmarks b where b.user_id=(select auth.uid()) and b.question_id=q.id) bookmarked,
 coalesce(u.marked_for_review,false) or coalesce(u.revision,false) marked_for_review,
 u.last_attempted_at,case when u.srm_active then u.srm_due_at else u.recall_due_at end due_at
 from ids join public.questions q on q.id=ids.question_id join public.subjects s on s.id=q.subject_id
 left join public.user_question_state u on u.user_id=(select auth.uid()) and u.question_id=q.id
 left join gi g on g.question_id=q.id
 where q.is_usable and not coalesce(q.is_grand_test,false) and q.id<>'4c7dc09f-5a20-5bf5-a4f6-febc9ef48842'::uuid
 and (p_subject is null or coalesce(g.subject,case when s.name='ENT' then 'Otorhinolaryngology' else s.name end)=p_subject)
 ), mistakes as (
 select * from personal where incorrect
 order by (tier='HIGH' and repeated>1) desc nulls last,repeated desc,score desc,last_attempted_at nulls first limit greatest(1,least(p_limit,100))
 ), saved as (
 select * from personal where bookmarked or marked_for_review
 order by (due_at<=now()) desc nulls last,last_attempted_at nulls first,question_id limit greatest(1,least(p_limit,100))
 ), due as (
 select * from personal where due_at<=now() or (due_at is null and attempts>0 and last_attempted_at<now()-interval '7 days')
 order by due_at nulls last,last_attempted_at nulls first,question_id limit greatest(1,least(p_limit,100))
 )
 select jsonb_build_object('mistakes',coalesce((select jsonb_agg(to_jsonb(m)) from mistakes m),'[]'),
 'bookmarks',coalesce((select jsonb_agg(to_jsonb(b)) from saved b),'[]'),'due',coalesce((select jsonb_agg(to_jsonb(d)) from due d),'[]'));
$$;
revoke all on function public.smart_recall_personal_candidates(text,integer) from public,anon;
grant execute on function public.smart_recall_personal_candidates(text,integer) to authenticated;

create or replace function public.qbank_analytics_tab(p_tab text default 'overview',p_subject_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare output jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in required';end if;
 if p_tab='overview' then
  select jsonb_build_object('attempted',count(*) filter(where attempts>0),'attempts',coalesce(sum(attempts),0),'correct_attempts',coalesce(sum(correct_attempts),0),
   'currently_incorrect',count(*) filter(where wrong),'bookmarked',count(*) filter(where bookmarked),'marked',count(*) filter(where marked_for_review or revision),
   'time_seconds',coalesce(sum(total_time_seconds),0)) into output from public.user_question_state where user_id=auth.uid();
 elsif p_tab='subjects' then
  select coalesce(jsonb_agg(to_jsonb(t) order by t.subject),'[]'::jsonb) into output from (
   select q.subject_id,coalesce(s.name,'Unassigned') subject,count(*) filter(where u.attempts>0) attempted,coalesce(sum(u.attempts),0) attempts,coalesce(sum(u.correct_attempts),0) correct_attempts,
   count(*) filter(where u.wrong) incorrect from public.user_question_state u join public.questions q on q.id=u.question_id
   left join public.subjects s on s.id=q.subject_id where u.user_id=auth.uid() and (p_subject_id is null or q.subject_id=p_subject_id) group by q.subject_id,s.name
  ) t;
 elsif p_tab='weaknesses' then
  select coalesce(jsonb_agg(unit),'[]'::jsonb) into output from (
   select unit from public.qbank_active_recall_rows() where (unit->>'incorrect')::integer>0
   order by (unit->>'importance')::numeric desc nulls last,(unit->>'consecutive_failures')::integer desc,(unit->>'incorrect')::integer desc limit 30
  ) t;
 elsif p_tab='performance' then
  output:=public.qbank_session_history(20,0,false);
 else raise exception 'Unknown analytics tab';end if;
 return output;
end;
$$;
revoke all on function public.qbank_analytics_tab(text,uuid) from public;
grant execute on function public.qbank_analytics_tab(text,uuid) to authenticated;


notify pgrst,'reload schema';

-- Retain the existing safe UNSURE scheduling fallback without inventing stored confidence.
create or replace function public.qbank_active_recall_rows()
returns table(unit_key text,unit jsonb) language sql stable security invoker set search_path='' as $$
with mapped as materialized (
 select s.*, coalesce(m.unit_key,'q:'||s.question_id) key,
 m.primary_concept,m.global_importance_tier,m.global_importance_score,m.neet_pg_occurrences,m.ini_cet_occurrences,m.aiims_occurrences,
 coalesce(m.subject,su.name,'Unassigned') subject,m.question_ids variants
 from public.user_question_state s join public.questions q on q.id=s.question_id and q.is_usable
 left join public.active_recall_reliable_map m on m.question_id=s.question_id
 left join public.subjects su on su.id=q.subject_id
 where s.user_id=(select auth.uid())
), grouped as (
 select key,max(primary_concept) primary_concept,max(subject) subject,max(global_importance_tier) tier,max(global_importance_score) importance,
 max(neet_pg_occurrences) neet,max(ini_cet_occurrences) ini,max(aiims_occurrences) aiims,
 array_agg(question_id order by last_attempted_at nulls first,question_id) encountered,
 bool_or(srm_active) enrolled,min(srm_due_at) filter(where srm_active) legacy_due,
 max(srm_last_reviewed_at) reviewed,max(srm_last_reviewed_at) filter(where last_is_correct=false or last_confidence in ('unsure','guess') or last_confidence is null) problem_reviewed,max(updated_at) changed,
 min(srm_interval_minutes) filter(where srm_active) legacy_interval,
 max(srm_consecutive_incorrect) failures,sum(attempts) attempts,sum(correct_attempts) correct,
 jsonb_agg(jsonb_build_object('question_id',question_id,'last_attempted_at',last_attempted_at,'error_reason',last_error_reason)) questions
 from mapped group by key
), effective as (
 select g.*,u.last_question_id,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.active else g.enrolled end active,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.due_at else g.legacy_due end due,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.interval_minutes else coalesce(g.legacy_interval,15) end minutes,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.mastery else case when g.failures>=2 then 'WEAK' else 'LEARNING' end end mastery,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.consecutive_failures else coalesce(g.failures,0) end consecutive_failures,case when g.problem_reviewed>u.updated_at then 0 else coalesce(u.spaced_successes,0) end spaced_successes,
 greatest(u.last_reviewed_at,g.reviewed) last_reviewed
 from grouped g left join public.active_recall_units u on u.user_id=(select auth.uid()) and u.unit_key=g.key
)
select key,jsonb_build_object('unit_key',key,'primary_concept',primary_concept,'subject',subject,
 'tier',tier,'importance',importance,'neet_pg_occurrences',neet,'ini_cet_occurrences',ini,'aiims_occurrences',aiims,
 'encountered_question_ids',encountered,'question_id',coalesce((select x from unnest(encountered) x where x is distinct from last_question_id limit 1),encountered[1]),
 'active',coalesce(active,false),'due_at',due,'interval_minutes',minutes,'mastery',mastery,'last_reviewed_at',last_reviewed,
 'consecutive_failures',consecutive_failures,'spaced_successes',spaced_successes,'attempts',attempts,'correct',correct,'incorrect',attempts-correct,'questions',questions)
from effective;
$$;

