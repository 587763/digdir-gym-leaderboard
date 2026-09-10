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
test('an unchanged refresh preserves rendered controls and open history', async () => {
  const {app, document}=await application({listAthletes:async()=>[athlete('A',{bench:100})]});
  const trigger=document.querySelector('[data-action="history"]');
  app.refreshOpenModals=()=>{throw new Error('Unchanged data should not redraw dialogs');};
  await app.refreshAll();
  assert.equal(document.querySelector('[data-action="history"]'),trigger);
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
test('signout clears private pending markers even when the public board stays unchanged', async () => {
  let auth;
  const {app,store,document}=await application({
    onAuthChange:(cb)=>{auth=cb;},getSession:async()=>({user:{id:'member'}}),
    myProfile:async()=>({status:'active',athlete_id:'0'}),
    listAthletes:async()=>Array.from({length:4},(_,i)=>athlete(String(i),{bench:100-i})),
    listPendingProposals:async()=>[{kind:'pr',athlete_id:'3'}],
  });
  assert.ok(document.querySelector('#benchTable .pending'));
  store.getSession=async()=>null;
  auth(null);
  await app.refreshAll();
  assert.equal(document.querySelector('#benchTable .pending'),null);
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
test('changing a blocked member athlete link does not silently unblock them', async () => {
  const {app,store}=await application();
  app.profiles=[{user_id:'peer',status:'blocked'}];
  app.refreshAll=async()=>{};
  const patches=[];
  store.adminUpdateProfile=async(_id,patch)=>patches.push(patch);
  await app.adminLink('peer','athlete');
  await app.adminLink('peer','');
  assert.deepEqual(patches.map(p=>p.status),['blocked','blocked']);
  assert.deepEqual(patches.map(p=>p.athlete_id),['athlete',null]);
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
test('large TV rosters get readable dwell times, while a single page respects the configured duration', async () => {
  const {app} = await application();
  app.tvPages=30; app.tvPage=0;
  assert.equal(app.currentDwellMs(),10000);
  app.tvPage=1;
  assert.equal(app.currentDwellMs(),5000);
  app.tvPages=1; app.tvPage=0; app.rotateMs=5000;
  assert.equal(app.currentDwellMs(),5000);
  app.rotateMs=120000; app.tvPages=3;
  assert.equal(app.currentDwellMs(),60000);
  app.tvPage=1;
  assert.equal(app.currentDwellMs(),30000);
});
test('TV falls back to all ranked rows when podiums leave too little room and restores them when space returns', async () => {
  const athletes=Array.from({length:6},(_,i)=>athlete(`Person ${i}`,{bench:100-i}));
  const {app,context,document}=await application({listAthletes:async()=>athletes});
  context.innerHeight=1080;
  app.tvMode=true;
  app.restartRotationTimer=()=>{};
  let bottom=600;
  document.querySelector('.tab-content.active').getBoundingClientRect=()=>({bottom});
  const render=app.renderLeaderboard.bind(app);
  app.renderLeaderboard=(lift,allow)=>{
    render(lift,allow);
    const section=document.querySelector(`[data-lift="${lift}"]`);
    const podium=section.querySelector('.podium-container');
    if(podium) podium.getBoundingClientRect=()=>({bottom:450});
    const tbody=section.querySelector('tbody');
    tbody.getBoundingClientRect=()=>({top:podium?500:100});
    Object.defineProperty(tbody,'rows',{configurable:true,get:()=>tbody.querySelectorAll('tr')});
    tbody.querySelectorAll('tr').forEach(row=>{row.getBoundingClientRect=()=>({height:80});});
  };
  app.fitTvPaging();
  assert.equal(document.querySelector('[data-lift="bench"] .podium-container'),null);
  assert.equal(document.querySelectorAll('#benchTable tbody tr').length,6);
  assert.equal(app.tvPages,2);
  assert.equal(app.tvBoards[0].slices.flat().length,6);
  bottom=1000;
  app.fitTvPaging();
  assert.ok(document.querySelector('[data-lift="bench"] .podium-container'));
  assert.equal(document.querySelectorAll('#benchTable tbody tr').length,3);
  assert.equal(app.tvPages,1);
});
test('TV notices expose connection failures and periodic reconciliation pauses while hidden', async () => {
  const {app, context, document} = await application();
  let tick, delay, reads=0;
  clearTimeout(app.refreshCheckTimer);
  context.setTimeout=(fn,ms)=>{tick=fn;delay=ms;return 1;};
  context.clearTimeout=()=>{};
  app.refreshAll=async()=>{reads++;};
  app.scheduleRefreshCheck();
  assert.equal(delay,60000);
  await tick();
  assert.equal(reads,1);
  document.hidden=true;
  tick=null;
  app.scheduleRefreshCheck();
  assert.equal(tick,null);
  app.loadError=new Error('offline'); app.updateBoardStatus();
  assert.ok(document.querySelector('.board-meta').classList.contains('connection-warning'));
  app.loadError=null; app.realtimeConnected=true; app.updateBoardStatus();
  assert.ok(!document.querySelector('.board-meta').classList.contains('connection-warning'));
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
