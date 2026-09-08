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
