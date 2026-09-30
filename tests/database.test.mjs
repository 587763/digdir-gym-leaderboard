import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { read, environment } from './helpers.mjs';

let db;
const ids = Object.fromEntries(['admin','member','peer','pending','blocked','missing','deputy','newcomer','reviewer'].map((key,i)=>[key,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const governance='supabase/migrations/0005_governance_hardening.sql', safeguards='supabase/migrations/0006_member_safeguards.sql';
let athletes, freshCatalog;
async function as(user) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)",[ids[user] || '']);
  await db.exec('set role authenticated');
}
async function propose(kind, athleteId, payload) {
  return (await db.query('select public.propose($1,$2,$3::jsonb) as id',[kind,athleteId,JSON.stringify(payload)])).rows[0].id;
}
async function decide(id, approve=true) { return db.query('select public.decide($1,$2)',[id,approve]); }
async function withdraw(id) { return db.query('select public.withdraw($1)',[id]); }
// A Supabase-like database installed from the fresh schema alone.
async function database() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create publication supabase_realtime;
  `);
  await pg.exec(read('supabase/schema.sql'));
  return pg;
}
// Columns, constraints, indexes, triggers, policies and functions, to detect schema drift.
async function catalog(pg) {
  return (await pg.query(`
    select 'column' as kind, table_name::text||'.'||column_name as name, concat_ws(' ',data_type,is_nullable,column_default) as def from information_schema.columns where table_schema='public'
    union all select 'constraint', conrelid::regclass::text||'.'||conname, pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
    union all select 'index', indexname, indexdef from pg_indexes where schemaname='public'
    union all select 'trigger', tgrelid::regclass::text||'.'||tgname, pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
    union all select 'policy', tablename||'.'||policyname, concat_ws(' ',permissive,cmd,roles::text,qual,with_check) from pg_policies where schemaname='public'
    union all select 'function', oid::regprocedure::text, pg_get_functiondef(oid) from pg_proc where pronamespace='public'::regnamespace
    order by 1,2`)).rows;
}
const fresh=()=>freshCatalog??=database().then(async(pg)=>{try{return await catalog(pg);}finally{await pg.close();}});
before(async()=>{
  db = await database();
  for(const file of [governance,governance,safeguards,safeguards]) await db.exec(read(file));
  await db.exec('grant usage on schema public,auth to authenticated,anon; grant select,insert,update,delete on all tables in schema public to authenticated; grant select on all tables in schema public to anon;');
  for(const [name,id] of Object.entries(ids)) {
    if(name==='missing') continue;
    await db.query('insert into auth.users(id,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3)',[id,{user_name:name==='admin'?'587763':name},{provider:'github'}]);
  }
  athletes=(await db.query('select id,name from athletes order by name')).rows;
  await db.query("update profiles set status='active',athlete_id=$1 where user_id=$2",[athletes[0].id,ids.member]);
  await db.query("update profiles set status='active',athlete_id=$1 where user_id=$2",[athletes[1].id,ids.peer]);
  await db.query("update profiles set status='blocked' where user_id=$1",[ids.blocked]);
});
after(async()=>{await db?.close();});

test('fresh schema and idempotent migration preserve the seeded athletes',async()=>{
  assert.equal(athletes.length,4);
  await as('admin');
  assert.equal((await db.query('select is_admin() as ok')).rows[0].ok,true);
});
test('fresh schema already contains every migrated definition',async()=>{
  assert.deepEqual(await catalog(db),await fresh());
});
test('signup without metadata succeeds and cannot bootstrap an admin',async()=>{
  await db.exec('reset role');
  const id='00000000-0000-4000-8000-000000000010';
  await db.query('insert into auth.users(id) values($1)',[id]);
  assert.equal((await db.query('select is_admin from profiles where user_id=$1',[id])).rows[0].is_admin,false);
  const spoof='00000000-0000-4000-8000-000000000011';
  await db.query('insert into auth.users(id,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3)',[spoof,{user_name:'587763'},{provider:'email'}]);
  assert.equal((await db.query('select is_admin from profiles where user_id=$1',[spoof])).rows[0].is_admin,false);
});
test('unlinked and blocked users cannot exploit NULL authorization checks',async()=>{
  await as('pending');
  await assert.rejects(()=>propose('pr',athletes[0].id,{lift:'bench',value:200}),/own linked/);
  await assert.rejects(()=>propose('rename',null,{name:'intruder'}),/own linked/);
  await assert.rejects(()=>propose('claim',null,{}),/athlete not found/);
  await as('blocked');
  await assert.rejects(()=>propose('new_athlete',null,{name:'Blocked'}),/blocked/);
});
test('invalid payloads fail before entering the review queue',async()=>{
  await as('member');
  for(const payload of [{lift:'bench',value:-1},{lift:'bench',value:'100'},{lift:'bench',value:100.55},{lift:'total',value:20},{lift:null,value:20},{lift:'pushups',value:100000}]) {
    await assert.rejects(()=>propose('pr',athletes[0].id,payload));
  }
  await assert.rejects(()=>propose('rename',athletes[0].id,{name:'   '}),/name/);
  await assert.rejects(()=>propose('achievement',athletes[0].id,{achievement_id:'gripper90kg',op:'oops'}),/operation/);
});
test('retries deduplicate and only a different member can verify',async()=>{
  await as('member');
  const payload={lift:'bench',value:140};
  const id=await propose('pr',athletes[0].id,payload);
  assert.equal(await propose('pr',athletes[0].id,payload),id);
  await assert.rejects(()=>decide(id),/different active/);
  await as('missing');
  await assert.rejects(()=>decide(id),/no profile/);
  await as('peer');
  await decide(id);
  assert.equal(Number((await db.query('select bench from athletes where id=$1',[athletes[0].id])).rows[0].bench),140);
  await assert.rejects(()=>decide(id),/already decided/);
});
test('stale PR approval cannot overwrite a newer verified record',async()=>{
  await as('member');
  const older=await propose('pr',athletes[0].id,{lift:'bench',value:145});
  const newer=await propose('pr',athletes[0].id,{lift:'bench',value:150});
  await as('peer'); await decide(newer);
  await assert.rejects(()=>decide(older),/changed since submission/);
  await decide(older,false);
});
test('approval rechecks blocked proposers and preserves rejected history',async()=>{
  await as('member');
  const id=await propose('pr',athletes[0].id,{lift:'squat',value:135});
  await as('admin'); await db.query("update profiles set status='blocked' where user_id=$1",[ids.member]);
  await assert.rejects(()=>decide(id),/blocked/);
  await decide(id,false);
  await db.query("update profiles set status='active' where user_id=$1",[ids.member]);
});
test('multiple claims cannot relink an already-approved proposer',async()=>{
  await as('pending');
  const one=await propose('claim',athletes[2].id,{});
  const two=await propose('claim',athletes[3].id,{});
  await as('admin'); await decide(one);
  await assert.rejects(()=>decide(two),/already linked/);
  await decide(two,false);
});
test('direct admin writes validate names and extra lift values',async()=>{
  await as('admin');
  for(const lifts of [[],{pushups:-1},{pushups:'five'},{bench:10}]) {
    await assert.rejects(()=>db.query('update athletes set lifts=$1 where id=$2',[lifts,athletes[0].id]));
  }
  await assert.rejects(()=>db.query("update athletes set name=' ' where id=$1",[athletes[0].id]),/name/);
});
test('RLS exposes approved PR history publicly and blocks member direct writes',async()=>{
  await as('member');
  assert.equal((await db.query("update athletes set bench=999 where id=$1 returning id",[athletes[0].id])).rows.length,0);
  await assert.rejects(()=>db.query("insert into athletes(name) values('intruder')"),/row-level security/);
  await db.exec('reset role; set role anon');
  const history=(await db.query('select kind,status from proposals')).rows;
  assert.ok(history.length>0);
  assert.ok(history.every((row)=>row.kind==='pr'&&row.status==='approved'));
  assert.equal((await db.query('select * from profiles')).rows.length,0);
});
test('members can withdraw each kind of pending request they made',async()=>{
  await as('member');
  const own=[await propose('pr',athletes[0].id,{lift:'deadlift',value:170}),
    await propose('achievement',athletes[0].id,{achievement_id:'gripper90kg',op:'remove'}),
    await propose('rename',athletes[0].id,{name:'Alex'})];
  for(const id of own) await withdraw(id);
  await as('newcomer');
  const joins=[await propose('claim',athletes[3].id,{}),await propose('new_athlete',null,{name:'Newcomer'})];
  for(const id of joins) await withdraw(id);
  const rows=(await db.query('select proposer,status,decided_by,decided_at from proposals where id=any($1::uuid[])',[[...own,...joins]])).rows;
  assert.deepEqual(rows.map((row)=>[row.status,row.decided_by===row.proposer,row.decided_at!==null]),Array(5).fill(['rejected',true,true]));
  const alexander=(await db.query('select name,deadlift,achievements from athletes where id=$1',[athletes[0].id])).rows[0];
  assert.deepEqual([alexander.name,Number(alexander.deadlift),alexander.achievements],['Alexander',137.5,['gripper90kg']]);
  // Withdrawn requests stop absorbing retries, so the same request can be made again.
  const again=await propose('claim',athletes[3].id,{});
  assert.notEqual(again,joins[0]);
  await withdraw(again);
});
test('only the unblocked proposer can withdraw, and only while pending',async()=>{
  await as('member');
  const id=await propose('pr',athletes[0].id,{lift:'deadlift',value:175});
  for(const user of ['peer','admin']) { await as(user); await assert.rejects(()=>withdraw(id),/your own requests/); }
  await as('missing'); await assert.rejects(()=>withdraw(id),/no profile/);
  await as('signed-out'); await assert.rejects(()=>withdraw(id),/not authenticated/);
  await db.exec('reset role');
  await db.query("update profiles set status='blocked' where user_id=$1",[ids.member]);
  await as('member'); await assert.rejects(()=>withdraw(id),/blocked/);
  await db.exec('reset role');
  await db.query("update profiles set status='active' where user_id=$1",[ids.member]);
  await as('peer'); await decide(id);
  await as('member');
  await assert.rejects(()=>withdraw(id),/already decided/);
  await assert.rejects(()=>withdraw('00000000-0000-4000-8000-0000000000ff'),/not found/);
  assert.deepEqual((await db.query('select status,decided_by from proposals where id=$1',[id])).rows,[{status:'approved',decided_by:ids.peer}]);
});
test('exercise units set the allowed precision on every write path',async()=>{
  await as('member');
  for(const payload of [{lift:'pullups',value:12.5},{lift:'pushups',value:0.5},{lift:'deadhang',value:95.5},{lift:'run1k',value:245.1}]) {
    await assert.rejects(()=>propose('pr',athletes[0].id,payload),/whole numbers/,payload.lift);
  }
  await assert.rejects(()=>propose('pr',athletes[0].id,{lift:'squat',value:132.55}),/one decimal/);
  const accepted=[];
  for(const payload of [{lift:'squat',value:132.5},{lift:'pullups',value:12},{lift:'deadhang',value:125},{lift:'run1k',value:245}]) {
    accepted.push(await propose('pr',athletes[0].id,payload));
  }
  for(const id of accepted) await withdraw(id);
  await as('admin');
  for(const lifts of [{pullups:12.5},{deadhang:72.5},{run1k:245.25}]) {
    await assert.rejects(()=>db.query('update athletes set lifts=$1 where id=$2',[lifts,athletes[1].id]),/whole numbers/,JSON.stringify(lifts));
  }
  assert.equal((await db.query('update athletes set squat=132.5,lifts=$1 where id=$2 returning id',[{deadhang:72,pullups:12,run1k:245},athletes[1].id])).rows.length,1);
  // Approval validates again, so an older pending request with a fractional count cannot apply.
  await db.exec('reset role');
  const legacy=(await db.query("insert into proposals(kind,approval,athlete_id,proposer,payload) values('pr','peer',$1,$2,$3) returning id",[athletes[0].id,ids.member,{lift:'pushups',value:12.5,previous_value:0}])).rows[0].id;
  await as('peer');
  await assert.rejects(()=>decide(legacy),/whole numbers/);
  await decide(legacy,false);
});
test('SQL decimal rules match the units in the exercise registry',async()=>{
  const { EXERCISES, Lifts } = environment(['lifts']);
  const allows=async(id)=>(await db.query('select public.lift_allows_decimals($1) as ok',[id])).rows[0].ok;
  // Main lifts are the fixed kg columns; every other kg exercise must be listed in SQL.
  assert.deepEqual([...Lifts.main].sort(),['bench','deadlift','squat']);
  for(const {id,unit} of EXERCISES) {
    assert.equal(await allows(id),unit==='kg',`${id} (${unit}): update public.lift_allows_decimals in a new migration`);
  }
});
test('PR proposals must change the recorded value',async()=>{
  await as('member');
  const {bench,lifts}=(await db.query('select bench,lifts from athletes where id=$1',[athletes[0].id])).rows[0];
  for(const payload of [{lift:'bench',value:Number(bench)},{lift:'deadhang',value:lifts.deadhang},{lift:'pushups',value:0}]) {
    await assert.rejects(()=>propose('pr',athletes[0].id,payload),/no change/,payload.lift);
  }
  // Zero still clears a recorded exercise.
  await withdraw(await propose('pr',athletes[0].id,{lift:'deadhang',value:0}));
});
test('deleting a reviewer keeps the requests they decided',async()=>{
  await as('reviewer');
  await withdraw(await propose('claim',athletes[3].id,{}));
  await db.exec('reset role');
  await db.query("update profiles set status='active',athlete_id=$1 where user_id=$2",[athletes[3].id,ids.reviewer]);
  await as('member');
  const id=await propose('pr',athletes[0].id,{lift:'pushups',value:40});
  await as('reviewer'); await decide(id);
  await db.exec('reset role');
  await db.query('delete from auth.users where id=$1',[ids.reviewer]);
  assert.deepEqual((await db.query('select status,decided_by from proposals where id=$1',[id])).rows,[{status:'approved',decided_by:null}]);
  // Their own requests still go with their profile.
  assert.equal((await db.query('select count(*)::int as n from proposals where proposer=$1',[ids.reviewer])).rows[0].n,0);
});
test('the last working admin cannot be demoted, blocked or deleted',async()=>{
  await db.exec('reset role');
  for(const sql of ["update profiles set is_admin=false where user_id=$1","update profiles set status='blocked' where user_id=$1",
    'delete from profiles where user_id=$1','delete from auth.users where id=$1']) {
    await assert.rejects(()=>db.query(sql,[ids.admin]),/active admin must remain/,sql);
  }
  // Blocked admins do not count, and edits that keep an admin working still save.
  await db.query("update profiles set is_admin=true,status='blocked' where user_id=$1",[ids.deputy]);
  await as('admin');
  await assert.rejects(()=>db.query('update profiles set is_admin=false where user_id=$1',[ids.admin]),/active admin must remain/);
  assert.equal((await db.query("update profiles set display_name='Admin' where user_id=$1 returning user_id",[ids.admin])).rows.length,1);
  // With a second working admin either may step down, but not both in one statement.
  await db.query("update profiles set status='active' where user_id=$1",[ids.deputy]);
  await assert.rejects(()=>db.query('update profiles set is_admin=false where is_admin'),/active admin must remain/);
  await db.query('update profiles set is_admin=false where user_id=$1',[ids.admin]);
  await as('deputy');
  await assert.rejects(()=>db.query("update profiles set status='blocked' where user_id=$1",[ids.deputy]),/active admin must remain/);
  await db.query('update profiles set is_admin=true where user_id=$1',[ids.admin]);
  await db.query("update profiles set is_admin=false,status='pending' where user_id=$1",[ids.deputy]);
  // PGlite has one connection, so check that removals (not promotions) take the lock that
  // makes concurrent removals wait for each other.
  await db.exec('reset role; begin');
  try {
    const locks=async()=>(await db.query("select count(*)::int as n from pg_locks where locktype='advisory' and pid=pg_backend_pid()")).rows[0].n;
    await db.query('update profiles set is_admin=true where user_id=$1',[ids.deputy]);
    assert.equal(await locks(),0);
    await db.query('update profiles set is_admin=false where user_id=$1',[ids.deputy]);
    assert.equal(await locks(),1);
  } finally { await db.exec('rollback'); }
  assert.deepEqual((await db.query('select user_id from profiles where is_admin')).rows,[{user_id:ids.admin}]);
});
test('blocked admins lose direct database privileges',async()=>{
  await db.exec('reset role');
  // The only admin can be blocked once another working admin remains.
  await db.query("update profiles set is_admin=true,status='active' where user_id=$1",[ids.deputy]);
  await db.query("update profiles set status='blocked' where user_id=$1",[ids.admin]);
  await as('admin');
  assert.equal((await db.query('select is_admin() as ok')).rows[0].ok,false);
  await assert.rejects(()=>db.query("insert into athletes(name) values('blocked admin')"),/row-level security/);
});
test('fresh schema and migration use identical governance functions',()=>{
  const extract=(sql,name)=>{const start=sql.indexOf(`create or replace function public.${name}(`);assert.ok(start>=0,name);return sql.slice(start,sql.indexOf('$$;',start)+3);};
  // Each function is compared with the migration that last defines it.
  for(const [file,names] of [[governance,['handle_new_user','is_admin','decide']],
    [safeguards,['lift_allows_decimals','validate_athlete_values','propose','withdraw','protect_last_admin']]]) {
    for(const name of names) assert.equal(extract(read('supabase/schema.sql'),name),extract(read(file),name),`${file}: ${name}`);
  }
});
test('upgrade preserves existing rows and can approve a legacy pending PR',async()=>{
  await db.exec('reset role');
  const oldGovernance=read('supabase/migrations/0002_self_governance.sql');
  const start=oldGovernance.indexOf('create or replace function public.propose(');
  await db.exec(oldGovernance.slice(start,oldGovernance.indexOf('$$;',start)+3));
  await db.exec(read('supabase/migrations/0003_other_lifts.sql'));
  await as('member');
  const id=await propose('pr',athletes[0].id,{lift:'squat',value:130});
  await db.exec('reset role');
  const before=await db.query('select * from proposals order by id');
  await db.exec(read('supabase/migrations/0005_governance_hardening.sql'));
  assert.deepEqual((await db.query('select * from proposals order by id')).rows,before.rows);
  await as('peer');await decide(id);
  assert.equal(Number((await db.query('select squat from athletes where id=$1',[athletes[0].id])).rows[0].squat),130);
});
test('upgrading 0005 to 0006 preserves rows and matches the fresh schema',async()=>{
  await as('member');
  const pending=await propose('pr',athletes[0].id,{lift:'pullups',value:15});
  await db.exec('reset role');
  // Recreate a 0005 database: older function bodies, no safeguards, another reviewer key name.
  await db.exec(read(governance));
  await db.exec(`drop trigger profiles_protect_last_admin on profiles;
    drop function protect_last_admin(), withdraw(uuid), lift_allows_decimals(text);
    drop index proposals_recent_prs;
    alter table proposals drop constraint proposals_decided_by_fkey,
      add constraint proposals_reviewer_fkey foreign key (decided_by) references profiles(user_id);`);
  // A stored value that breaks the new unit rules stops the upgrade before anything changes.
  const odd=(await db.query(`insert into athletes(name,lifts) values('Odd','{"pullups":12.5}') returning id`)).rows[0].id;
  await assert.rejects(()=>db.exec(read(safeguards)),/"Odd" has pullups = 12\.5/);
  await db.exec('rollback');
  assert.equal((await db.query("select to_regprocedure('public.withdraw(uuid)') as fn")).rows[0].fn,null);
  await db.query('delete from athletes where id=$1',[odd]);
  const rows=()=>Promise.all(['athletes','profiles','proposals'].map(async(table)=>(await db.query(`select * from ${table} order by 1`)).rows));
  const before=await rows();
  await db.exec(read(safeguards));
  await db.exec(read(safeguards));
  assert.deepEqual(await rows(),before);
  assert.deepEqual(await catalog(db),await fresh());
  await as('member'); await withdraw(pending);
});
