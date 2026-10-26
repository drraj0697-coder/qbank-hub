// Invoked by the existing isolated PostgreSQL history fixture.
export async function threeSureCases({db,file,assert,one,run,q,event}) {
 await db.exec(`reset role;
 create role anon;
 create table subjects(id uuid primary key default gen_random_uuid(),name text);
 insert into subjects(name) values('Medicine');
 alter table questions add column subject_id uuid default (null), add column is_grand_test boolean default false;
 update questions set subject_id=(select id from subjects limit 1);
 create table bookmarks(user_id uuid,question_id uuid);
 create table pyq_concept_importance(question_ids uuid[],subject text,concept_id text,primary_concept text,global_importance_tier text,global_importance_score numeric);
 alter table user_question_state add column srm_consecutive_incorrect int default 0,add column recall_due_at timestamptz,add column srm_last_reviewed_at timestamptz,add column updated_at timestamptz default now();
 alter table active_recall_reliable_map add column primary_concept text,add column global_importance_tier text,add column global_importance_score numeric,add column neet_pg_occurrences int,add column ini_cet_occurrences int,add column aiims_occurrences int,add column subject text,add column question_ids uuid[];
 grant select on subjects,bookmarks,pyq_concept_importance to authenticated;
 insert into questions(id) select ('00000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid from generate_series(6,7) i;
 insert into user_question_state(user_id,question_id,wrong,last_is_correct) select auth.uid(),id,false,true from questions where id in ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000007');
 insert into question_attempts(user_id,question_id,selected_option,is_correct,answered_at,confidence)
 select auth.uid(),q.id,case when n=0 then 'B' else 'A' end,n>0,now()-interval '10 days'+n*interval '1 hour',case when n>0 and q.id='00000000-0000-0000-0000-000000000006' then 'sure' else null end
 from questions q cross join generate_series(0,3) n where q.id in ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000007');
 `);
 const immutable=await one('select jsonb_agg(to_jsonb(a) order by id) data from question_attempts a');
 await db.exec(file('supabase/migrations/20261025092318_three_sure_incorrect_resolution.sql'));
 assert.deepEqual(await one('select jsonb_agg(to_jsonb(a) order by id) data from question_attempts a'),immutable,'historical confidence and attempts unchanged');
 await db.exec('set role authenticated');
 const state=id=>one('select wrong,mistake_sure_streak,bookmarked,marked_for_review from user_question_state where user_id=auth.uid() and question_id=$1',[q(id)]);
 assert.equal((await state(6)).wrong,false,'historical explicit SURE can resolve');
 assert.equal((await state(6)).mistake_sure_streak,3);
 assert.equal((await state(7)).wrong,true,'historical confidence absent never resolves');
 assert.equal((await state(7)).mistake_sure_streak,0);
 let next=100;
 const answer=async(option,confidence,mode='qbank')=>{
   const e=event(next++);
   const result=await one('select qbank_record_attempt_v2($1,$2,$3,$4,null,1,$5) result',[q(1),option,mode,e,confidence]);
   return {e,result};
 };
 await answer('B','sure');assert.equal((await state(1)).mistake_sure_streak,0);assert.equal((await state(1)).wrong,true);
 const sure=await answer('A','sure');assert.equal((await state(1)).mistake_sure_streak,1);
 for(const confidence of ['guess','unsure',null]){
   const {e}=await answer('A',confidence,'recall');
   assert.equal((await state(1)).mistake_sure_streak,1);
   assert.equal((await one('select confidence from question_attempts where client_event_id=$1',[e])).confidence,confidence,'original confidence preserved');
 }
 await one('select qbank_record_attempt_v2($1,$2,$3,$4,null,1,$5)',[q(1),'A','qbank',sure.e,'sure']);
 assert.equal((await state(1)).mistake_sure_streak,1,'duplicate does not advance streak');
 await one("select qbank_active_recall_record($1,'A',$2,null,1,'strong')",[q(1),event(next++)]);
 assert.equal((await state(1)).mistake_sure_streak,2,'explicit Active Recall strong maps to SURE');
 // A QBank Test contributes confidence only when explicitly supplied.
 async function test(confidence){
   const s='30000000-0000-0000-0000-'+String(next++).padStart(12,'0');
   await run("insert into test_sessions(id,user_id,mode,total_questions) values($1,auth.uid(),'test',1)",[s]);
   await run("insert into test_session_questions values($1,$2,0,'{\"correct_answer\":\"A\"}')",[s,q(1)]);
   await run("insert into test_answers(session_id,question_id,selected_option,answered_at,client_event_id,confidence) values($1,$2,'A',clock_timestamp(),$3,$4)",[s,q(1),event(next++),confidence]);
   const done=await one('select to_jsonb(submit_test_session($1,false)) result',[s]);
   assert.equal(done.result.total_correct,1);assert.deepEqual(await one('select to_jsonb(submit_test_session($1,false)) result',[s]),done);
 }
 await test(null);assert.equal((await state(1)).mistake_sure_streak,2);
 await test('sure');assert.equal((await state(1)).mistake_sure_streak,3);assert.equal((await state(1)).wrong,false);
 assert.equal((await state(1)).bookmarked,true);assert.equal((await state(1)).marked_for_review,true);
 // Resolution removes only the mistake bucket and repeated-mistake reason.
 await run("update user_question_state set srm_consecutive_incorrect=2,srm_active=true,srm_due_at=now()-interval '1 hour' where question_id=$1 and user_id=auth.uid()",[q(1)]);
 const pools=(await one('select smart_recall_personal_candidates(null,100) result')).result;
 assert(!pools.mistakes.some(x=>x.question_id===q(1)));
 assert(pools.bookmarks.some(x=>x.question_id===q(1)));
 assert(pools.due.some(x=>x.question_id===q(1)&&x.repeated===0));
 const schedule=await one('select srm_active,srm_due_at,srm_interval_minutes,srm_state from user_question_state where question_id=$1',[q(1)]);
 await one('select qbank_refresh_mistake_state($1)',[q(1)]);
 assert.deepEqual(await one('select srm_active,srm_due_at,srm_interval_minutes,srm_state from user_question_state where question_id=$1',[q(1)]),schedule);
 await answer('B',null);assert.equal((await state(1)).wrong,true);assert.equal((await state(1)).mistake_sure_streak,0);
 const before=(await one('select * from qbank_question_history($1)',[[q(1)]])).correct_count;
 await answer('A',null);assert.equal((await state(1)).mistake_sure_streak,0);assert.equal((await state(1)).wrong,true);
 assert.equal((await one('select * from qbank_question_history($1)',[[q(1)]])).correct_count,before+1);
 assert.equal((await one('select qbank_home_review_counts() result')).result.incorrect,(await one('select count(*) n from user_question_state where user_id=auth.uid() and wrong')).n);
 // A late SURE before the latest wrong contributes to lifetime history, not the new streak.
 const late='30000000-0000-0000-0000-000000000999';
 await run("insert into test_sessions(id,user_id,mode,total_questions) values($1,auth.uid(),'practice',1)",[late]);
 await run("insert into test_answers(session_id,question_id,selected_option,answered_at,client_event_id,confidence) values($1,$2,'A',now()-interval '2 days',$3,'sure')",[late,q(1),event(999)]);
 const latest=await one('select last_attempted_at,last_is_correct from user_question_state where user_id=auth.uid() and question_id=$1',[q(1)]);
 await one("select qbank_record_attempt_v2($1,'A','qbank',$2,$3,1,'sure')",[q(1),event(999),late]);
 assert.equal((await state(1)).mistake_sure_streak,0);
 assert.deepEqual(await one('select last_attempted_at,last_is_correct from user_question_state where user_id=auth.uid() and question_id=$1',[q(1)]),latest);
 console.log('PASS: wrong → three explicit SURE → resolved; GUESS/UNSURE/null ignored and preserved; wrong resets; Practice/Smart Recall/Active Recall/Test; replay; historical confidence-only rebuild; scores/bookmarks/history preserved; mistake priority removed, due schedule retained');
}
