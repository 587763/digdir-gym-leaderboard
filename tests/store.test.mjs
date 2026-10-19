import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { environment,read } from './helpers.mjs';

function storeWith(client) {
  const context=environment([]);
  context.LEADERBOARD_CONFIG={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public-key'};
  if(client) context.supabase={createClient:()=>client};
  vm.runInContext(read('js/store.js'),context);
  return context.Store;
}
test('missing CDN library degrades into a connection message',()=>{
  const store=storeWith();
  assert.equal(store.configured,false);
  assert.match(store.connectionError.message,/could not load/);
});
test('auth failures propagate to the UI instead of silently succeeding',async()=>{
  const error=new Error('OAuth failed');
  const store=storeWith({auth:{signInWithOAuth:async()=>({error}),signOut:async()=>({error}),getSession:async()=>({error})}});
  await assert.rejects(()=>store.signIn(),/OAuth failed/);
  await assert.rejects(()=>store.signOut(),/OAuth failed/);
  await assert.rejects(()=>store.getSession(),/OAuth failed/);
});
test('auth callbacks defer all consumer work until after the auth lock is released',async()=>{
  let callback,inside=false,called=false;
  const store=storeWith({auth:{onAuthStateChange:(cb)=>{callback=cb;return {data:{subscription:{unsubscribe(){}}}};}}});
  store.onAuthChange(()=>{assert.equal(inside,false);called=true;});
  inside=true;callback('SIGNED_IN',{user:{id:'1'}});inside=false;
  assert.equal(called,false);
  await new Promise((resolve)=>setTimeout(resolve,10));
  assert.equal(called,true);
});
test('admin edits compare the opening timestamp and report concurrent changes',async()=>{
  const filters=[];
  const query={update(){return this;},eq(key,value){filters.push([key,value]);return this;},select(){return this;},single:async()=>({error:{code:'PGRST116'}})};
  const store=storeWith({from:()=>query});
  await assert.rejects(()=>store.adminUpdateAthlete('athlete',{name:'New'},'2026-01-01'),/changed or your access expired/);
  assert.deepEqual(filters,[['id','athlete'],['updated_at','2026-01-01']]);
});
test('bodyweight is saved through its RPC and failures propagate',async()=>{
  const calls=[];
  const store=storeWith({rpc:async(name,args)=>{calls.push([name,{...args}]);return {error:calls.length>1?new Error('denied'):null};}});
  await store.setMyBodyweight(82.5);
  await assert.rejects(()=>store.setMyBodyweight(null),/denied/);
  assert.deepEqual(calls,[['set_my_bodyweight',{p_bodyweight:82.5}],['set_my_bodyweight',{p_bodyweight:null}]]);
});
test('plans are read for a time span and written through their RPCs',async()=>{
  const calls=[];
  const query={select(columns){calls.push(['select',columns]);return this;},gte(...a){calls.push(['gte',...a]);return this;},lt(...a){calls.push(['lt',...a]);return this;},
    order(column){calls.push(['order',column]);return Promise.resolve({data:[{id:'p'}],error:null});}};
  const store=storeWith({from:(table)=>{calls.push(['from',table]);return query;},rpc:async(name,args)=>{calls.push([name,{...args}]);return {data:name==='save_plan'?'p':null,error:name==='join_plan'?new Error('denied'):null};}});
  assert.deepEqual(await store.listPlans('2026-10-19T00:00:00Z','2026-12-21T00:00:00Z'),[{id:'p'}]);
  assert.equal(await store.savePlan(null,'2026-10-23T14:00:00Z','Bench',null),'p');
  await store.deletePlan('p');
  await assert.rejects(()=>store.joinPlan('p',true,'2026-10-23T14:30:00Z'),/denied/);
  assert.deepEqual(calls.map((c)=>JSON.parse(JSON.stringify(c))),[
    ['from','plans'],['select','id, owner, starts_at, activity, note, plan_joins(user_id, arrives_at, created_at)'],
    ['gte','starts_at','2026-10-19T00:00:00Z'],['lt','starts_at','2026-12-21T00:00:00Z'],['order','starts_at'],
    ['save_plan',{p_id:null,p_starts_at:'2026-10-23T14:00:00Z',p_activity:'Bench',p_note:null}],
    ['delete_plan',{p_id:'p'}],['join_plan',{p_id:'p',p_join:true,p_arrives_at:'2026-10-23T14:30:00Z'}],
  ]);
});
