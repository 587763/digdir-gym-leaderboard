import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { read } from './helpers.mjs';

let db;
const ids = Object.fromEntries(['admin','member','peer','pending','blocked','missing'].map((key,i)=>[key,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
let athletes;
async function as(user) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)",[ids[user] || '']);
  await db.exec('set role authenticated');
}
async function propose(kind, athleteId, payload) {
  return (await db.query('select public.propose($1,$2,$3::jsonb) as id',[kind,athleteId,JSON.stringify(payload)])).rows[0].id;
}
async function decide(id, approve=true) { return db.query('select public.decide($1,$2)',[id,approve]); }
before(async()=>{
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create publication supabase_realtime;
  `);
  await db.exec(read('supabase/schema.sql'));
  await db.exec(read('supabase/migrations/0005_governance_hardening.sql'));
  await db.exec(read('supabase/migrations/0005_governance_hardening.sql'));
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
test('blocked admins lose direct database privileges',async()=>{
  await db.exec('reset role');
  await db.query("update profiles set status='blocked' where user_id=$1",[ids.admin]);
  await as('admin');
  assert.equal((await db.query('select is_admin() as ok')).rows[0].ok,false);
  await assert.rejects(()=>db.query("insert into athletes(name) values('blocked admin')"),/row-level security/);
});
test('fresh schema and migration use identical governance functions',()=>{
  for(const name of ['handle_new_user','is_admin','validate_athlete_values','propose','decide']) {
    const extract=(sql)=>{const start=sql.indexOf(`create or replace function public.${name}(`);return sql.slice(start,sql.indexOf('$$;',start)+3);};
    assert.equal(extract(read('supabase/schema.sql')),extract(read('supabase/migrations/0005_governance_hardening.sql')),name);
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
