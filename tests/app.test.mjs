import test from 'node:test';
import assert from 'node:assert/strict';
import { application, athlete } from './helpers.mjs';

test('unconfigured app still renders all tabs and explains the missing connection', async () => {
  const { app, document } = await application({configured:false});
  assert.ok(document.querySelector('.config-banner'));
  assert.equal(document.querySelectorAll('.leaderboard-section').length, 8);
  app.switchTab('cardio');
  assert.equal(document.getElementById('tab-cardio').getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('signInBtn').disabled, true);
});
test('a failed refresh preserves the last board and exposes retry', async () => {
  const { app, store, document } = await application({listAthletes: async () => [athlete('A',{bench:100})]});
  store.listAthletes = async () => { throw new Error('offline'); };
  await app.refreshAll();
  assert.equal(app.athletes[0].name, 'A');
  assert.equal(document.getElementById('retryBtn').hidden, false);
  store.listAthletes = async () => [];
  await app.refreshAll();
  assert.equal(document.getElementById('retryBtn').hidden, true);
});
test('refresh bursts serialize reads and perform one trailing refresh', async () => {
  const { app, store } = await application();
  let release, calls = 0;
  store.listAthletes = async () => { calls++; if (calls === 1) await new Promise((resolve) => { release = resolve; }); return []; };
  const first = app.refreshAll();
  await new Promise(setImmediate);
  const second = app.refreshAll();
  const third = app.refreshAll();
  release();
  await Promise.all([first, second, third]);
  assert.equal(calls, 2);
});
test('signout during a refresh cannot restore the old private state', async () => {
  let authCallback;
  const { app, store } = await application({onAuthChange: (cb) => { authCallback = cb; }});
  store.getSession = async () => ({user:{id:'old'}});
  let release;
  store.myProfile = async () => { await new Promise((resolve) => { release = resolve; }); return {is_admin:true}; };
  const request = app.refreshAll();
  await new Promise(setImmediate);
  store.getSession = async () => null;
  app.user = {id:'old'};
  authCallback(null);
  release();
  await request;
  assert.equal(app.user, null);
  assert.equal(app.profile, null);
  assert.equal(app.isAdmin, false);
});
test('large medal ties fall back to a complete table, with no missing athletes', async () => {
  const athletes = Array.from({length:12}, (_, i) => athlete(`Person ${i}`, {bench:100}));
  const {document} = await application({listAthletes:async()=>athletes});
  assert.equal(document.querySelectorAll('#benchTable tbody tr').length, 12);
  assert.equal(document.querySelectorAll('[data-lift="bench"] .podium-container').length, 0);
});
test('repeated actions run once while pending', async () => {
  const {app} = await application();
  let count = 0, release;
  const action = () => { count++; return new Promise((resolve) => {release=resolve;}); };
  const pending = app.runAction('same', null, action);
  await app.runAction('same', null, action);
  assert.equal(count, 1);
  release(); await pending;
});
test('partial proposal failure retains accepted fields for a safe retry', async () => {
  const me = athlete('me', {bench:100, squat:100});
  const {app, document, store} = await application({
    getSession:async()=>({user:{id:'user'}}), myProfile:async()=>({athlete_id:'me',status:'active'}),
    listAthletes:async()=>[me],
  });
  app.openMine();
  document.getElementById('mineSquat').value = '110';
  document.getElementById('mineBench').value = '105';
  const sent = [];
  store.propose = async (kind, id, payload) => { sent.push(payload.lift); if(sent.length===2) throw new Error('offline'); };
  await app.submitMine();
  assert.equal(app.mineSnapshot.squat,110);
  assert.equal(app.mineSnapshot.bench,100);
  store.propose = async (kind,id,payload) => sent.push(payload.lift);
  await app.submitMine();
  assert.deepEqual(sent,['squat','bench','bench']);
});
test('blocked admins lose all write UI and unblocking linked members restores active status', async () => {
  const {app,store} = await application();
  app.profile={is_admin:true,status:'blocked'};
  assert.equal(app.isAdmin,false);
  app.profiles=[{user_id:'peer',athlete_id:'athlete'}];
  let patch;
  store.adminUpdateProfile=async (_id,value)=>{patch=value;};
  await app.adminBlock('peer',true);
  assert.equal(patch.status,'active');
});
test('TV paging accounts for wrapped rows and keeps every row reachable', async () => {
  const {app}=await application();
  const rows=[20,50,20,30].map((height)=>({getBoundingClientRect:()=>({height})}));
  const pages=app.partitionRows(rows,70);
  assert.deepEqual(Array.from(pages,(page)=>page.length),[2,2]);
  assert.deepEqual(Array.from(pages.flat()),rows);
  app.tvMode=true;app.tvPage=0;app.tvPages=2;app.tvBoards=[{rows,slices:pages}];
  app.applyTvPage();
  assert.deepEqual(rows.map((r)=>r.hidden),[false,false,true,true]);
  assert.equal(app.advanceTvPage(),true);
  assert.deepEqual(rows.map((r)=>r.hidden),[true,true,false,false]);
  assert.equal(app.advanceTvPage(),false);
});
test('editing an athlete preserves unregistered achievements and uses the opening version', async () => {
  const original=athlete('me',{bench:100,updated_at:'2026-01-01T00:00:00Z',achievements:['legacy-achievement'],lifts:{legacy_lift:10}});
  const {app,store,document}=await application({listAthletes:async()=>[original]});
  app.profile={is_admin:true,status:'active'};
  // LinkeDOM omits native form.reset(); this test prefills every field from the athlete.
  document.getElementById('athleteForm').reset=()=>{};
  app.openAthleteModal('me');
  document.getElementById('athleteName').value='New name';
  app.athletes=[{...original,updated_at:'2026-01-02T00:00:00Z'}];
  let submitted;
  store.adminUpdateAthlete=async(id,patch,version)=>{submitted={id,patch,version};};
  await app.saveAthlete();
  assert.deepEqual(Array.from(submitted.patch.achievements),['legacy-achievement']);
  assert.equal(submitted.patch.lifts.legacy_lift,10);
  assert.equal(submitted.version,original.updated_at);
});
test('My PRs never propose removing achievements that have no visible form field', async () => {
  const {app,store,document}=await application({
    getSession:async()=>({user:{id:'user'}}),myProfile:async()=>({status:'active',athlete_id:'me'}),
    listAthletes:async()=>[athlete('me',{achievements:['legacy-achievement']})],
  });
  app.openMine();
  document.getElementById('mineBench').value='20';
  const sent=[];
  store.propose=async(kind)=>sent.push(kind);
  await app.submitMine();
  assert.deepEqual(sent,['pr']);
});
