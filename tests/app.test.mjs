import test from 'node:test';
import assert from 'node:assert/strict';
import { application, athlete } from './helpers.mjs';

test('unconfigured app still renders all tabs and explains the missing connection', async () => {
  const { app, document } = await application({configured:false});
  assert.ok(document.querySelector('.config-banner'));
  assert.equal(document.querySelectorAll('.leaderboard-section').length, 9); // 7 exercises, total, latest
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
  app.refreshOpenDialogs=()=>{throw new Error('Unchanged data should not redraw dialogs');};
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
  document.getElementById('mine-squat').value = '110';
  document.getElementById('mine-bench').value = '105';
  const sent = [];
  store.propose = async (kind, id, payload) => { sent.push(payload.lift); if(sent.length===2) throw new Error('offline'); };
  await assert.rejects(()=>app.submitMine(),/offline/);
  assert.equal(app.mineSnapshot.values.squat,110);
  assert.equal(app.mineSnapshot.values.bench,100);
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
  const pages=app.tv.partitionRows(rows,70);
  assert.deepEqual(Array.from(pages,(page)=>page.length),[2,2]);
  assert.deepEqual(Array.from(pages.flat()),rows);
  app.tv.enabled=true;app.tv.page=0;app.tv.pages=2;app.tv.boards=[{rows,slices:pages}];
  app.tv.applyPage();
  assert.deepEqual(rows.map((r)=>r.hidden),[false,false,true,true]);
  assert.equal(app.tv.advancePage(),true);
  assert.deepEqual(rows.map((r)=>r.hidden),[true,true,false,false]);
  assert.equal(app.tv.advancePage(),false);
});
test('large TV rosters get readable dwell times, while a single page respects the configured duration', async () => {
  const {app} = await application();
  const {tv}=app;
  tv.pages=30; tv.page=0;
  assert.equal(tv.dwellMs(),10000);
  tv.page=1;
  assert.equal(tv.dwellMs(),5000);
  tv.pages=1; tv.page=0; tv.rotateMs=5000;
  assert.equal(tv.dwellMs(),5000);
  tv.rotateMs=120000; tv.pages=3;
  assert.equal(tv.dwellMs(),60000);
  tv.page=1;
  assert.equal(tv.dwellMs(),30000);
});
test('TV falls back to all ranked rows when podiums leave too little room and restores them when space returns', async () => {
  const athletes=Array.from({length:6},(_,i)=>athlete(`Person ${i}`,{bench:100-i}));
  const {app,context,document}=await application({listAthletes:async()=>athletes});
  context.innerHeight=1080;
  app.tv.enabled=true;
  app.tv.restart=()=>{};
  let bottom=600;
  document.querySelector('.tab-content.active').getBoundingClientRect=()=>({bottom});
  // LinkeDOM has no layout: give each re-rendered board fixed geometry.
  const renderBoard=app.renderBoard.bind(app);
  app.renderBoard=(lift,podiumFits)=>{
    const section=renderBoard(lift,podiumFits);
    const podium=section.querySelector('.podium-container');
    if(podium) podium.getBoundingClientRect=()=>({bottom:450});
    section.querySelector('tbody').getBoundingClientRect=()=>({top:podium?500:100});
    section.querySelectorAll('tbody tr').forEach(row=>{row.getBoundingClientRect=()=>({height:80});});
    return section;
  };
  app.tv.fit();
  assert.equal(document.querySelector('[data-lift="bench"] .podium-container'),null);
  assert.equal(document.querySelectorAll('#benchTable tbody tr').length,6);
  assert.equal(app.tv.pages,2);
  assert.equal(app.tv.boards[0].slices.flat().length,6);
  bottom=1000;
  app.tv.fit();
  assert.ok(document.querySelector('[data-lift="bench"] .podium-container'));
  assert.equal(document.querySelectorAll('#benchTable tbody tr').length,3);
  assert.equal(app.tv.pages,1);
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
  app.openAthleteEditor('me');
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
  document.getElementById('mine-bench').value='20';
  const sent=[];
  store.propose=async(kind)=>sent.push(kind);
  await app.submitMine();
  assert.deepEqual(sent,['pr']);
});
test('TV resumes the rest of a dwell after the page was hidden, so rotated screens still advance', async () => {
  const {app}=await application();
  const {tv}=app;
  tv.enabled=true;
  tv.tick={startedAt:Date.now()-10000,wait:15000};
  tv.pause();
  assert.ok(Math.abs(tv.remaining-5000)<200);
  let resumed;
  tv.scheduleTick=(remaining)=>{resumed=remaining;};
  tv.resume();
  assert.ok(Math.abs(resumed-5000)<200);
  assert.equal(tv.remaining,null);
  tv.remaining=1234; tv.start();
  assert.equal(resumed??null,null,'a manual start begins a fresh dwell');
});
test('TV rotation can be limited to chosen tabs and skips an empty latest feed', async () => {
  const {app}=await application({}, {search:'?tv&tabs=total,latest,fun'});
  assert.deepEqual([...app.tv.rotationTabs()],['total','fun']);
  const all=await application();
  assert.deepEqual([...all.app.tv.rotationTabs()],['lifts','total','other','cardio','fun']);
});
test('a shared tab link opens that board', async () => {
  const {app,document}=await application({}, {hash:'#cardio'});
  assert.equal(app.activeTab,'cardio');
  assert.ok(document.getElementById('cardio-tab').classList.contains('active'));
});
test('a hung request surfaces as an error instead of freezing every later refresh', async () => {
  const {app,store,document}=await application({listAthletes:async()=>[athlete('A',{bench:100})]});
  app.readTimeoutMs=20;
  store.listAthletes=()=>new Promise(()=>{});
  await app.refreshAll();
  assert.match(app.loadError.message,/too long/);
  assert.equal(document.getElementById('retryBtn').hidden,false);
  store.listAthletes=async()=>[athlete('A',{bench:100})];
  await app.refreshAll();
  assert.equal(app.loadError,null);
});
test('dragging a text selection out of a dialog does not close it; a backdrop click does', async () => {
  const {document,context}=await application();
  const dialog=document.getElementById('claimModal');
  context.UI.dialogs.open('claimModal');
  const press=(target)=>target.dispatchEvent(new context.Event('pointerdown',{bubbles:true}));
  press(document.getElementById('claimNewName'));
  dialog.dispatchEvent(new context.Event('click',{bubbles:true}));
  assert.equal(dialog.open,true);
  press(dialog);
  dialog.dispatchEvent(new context.Event('click',{bubbles:true}));
  assert.equal(dialog.open,false);
});
test('reviewers see what a PR changes and outdated requests cannot be approved', async () => {
  const {app,document}=await application({
    getSession:async()=>({user:{id:'rev'}}),myProfile:async()=>({user_id:'rev',status:'active',athlete_id:'b',is_admin:false}),
    listAthletes:async()=>[athlete('a',{name:'Ada',bench:110}),athlete('b')],
    listProfiles:async()=>[{user_id:'p1',github_login:'ada'}],
    listPendingProposals:async()=>[
      {id:'fresh',kind:'pr',approval:'peer',athlete_id:'a',proposer:'p1',payload:{lift:'bench',value:120,previous_value:110},created_at:new Date().toISOString()},
      {id:'stale',kind:'pr',approval:'peer',athlete_id:'a',proposer:'p1',payload:{lift:'bench',value:115,previous_value:100},created_at:new Date().toISOString()},
    ],
  });
  app.openReview();
  const list=document.getElementById('reviewList');
  assert.match(list.textContent,/110\.0 → 120\.0 kg/);
  assert.match(list.textContent,/\+10\.0 kg/);
  assert.ok(list.querySelector('[data-action="approve"][data-id="fresh"]'));
  assert.equal(list.querySelector('[data-action="approve"][data-id="stale"]'),null);
  assert.ok(list.querySelector('[data-action="reject"][data-id="stale"]'));
  assert.equal(list.querySelector('[data-id="fresh"]').getAttribute('aria-label'),'Approve Bench Press PR for Ada');
});
test('members can withdraw their own pending requests', async () => {
  let withdrawn;
  const {app,store,document}=await application({
    getSession:async()=>({user:{id:'me'}}),myProfile:async()=>({user_id:'me',status:'pending',athlete_id:null}),
    listAthletes:async()=>[athlete('a',{name:'Ada'})],
    listPendingProposals:async()=>[{id:'c1',kind:'claim',approval:'admin',athlete_id:'a',proposer:'me',payload:{}}],
    withdraw:async(id)=>{withdrawn=id;},
  });
  app.openClaim();
  const pending=document.getElementById('claimPending');
  assert.equal(pending.hidden,false);
  assert.match(pending.textContent,/Link to athlete Ada/);
  store.listPendingProposals=async()=>[];
  await app.withdraw('c1');
  assert.equal(withdrawn,'c1');
  assert.equal(document.getElementById('claimPending').hidden,true);
});
test('admins cannot demote or block themselves, and failed member edits show the saved state', async () => {
  const {app,store,document}=await application({
    getSession:async()=>({user:{id:'boss'}}),myProfile:async()=>({user_id:'boss',is_admin:true,status:'active'}),
    listProfiles:async()=>[{user_id:'boss',github_login:'boss',is_admin:true,status:'active'},{user_id:'peer',github_login:'peer',is_admin:false,status:'active'}],
  });
  app.openMembers();
  const control=(action,id)=>document.querySelector(`[data-action="${action}"][data-id="${id}"]`);
  assert.equal(control('admin','boss').disabled,true);
  assert.equal(control('block','boss').disabled,true);
  assert.equal(control('admin','peer').disabled,false);
  const toggled=control('admin','peer');
  toggled.setAttribute('checked','');
  store.adminUpdateProfile=async()=>{throw new Error('denied');};
  await assert.rejects(()=>app.adminToggleAdmin('peer',true),/denied/);
  assert.notEqual(control('admin','peer'),toggled,'the list is redrawn from saved data');
  assert.equal(control('admin','peer').hasAttribute('checked'),false);
});
test('the latest feed lists verified improvements and cheers PRs verified while watching', async () => {
  const now=Date.now();
  const pr=(id,lift,value,previous,minutesAgo)=>({id,athlete_id:'a',payload:{lift,value,previous_value:previous},decided_at:new Date(now-minutesAgo*60000).toISOString()});
  const {app,store,document}=await application({
    listAthletes:async()=>[athlete('a',{name:'Ada',bench:120,squat:90})],
    listRecentPrs:async()=>[pr('p2','bench',120,110,60),pr('p1','squat',90,100,120)],
  });
  assert.deepEqual(app.latestPrs().map((item)=>item.id),['p2'],'a lower squat is a correction, not a PR');
  assert.equal(app.tv.rotationTabs().includes('latest'),true);
  assert.ok(document.querySelector('[data-action="history"][data-id="a"] ~ .fresh'));
  assert.equal(document.querySelector('.toast'),null,'nothing to cheer on the first load');
  store.listAthletes=async()=>[athlete('a',{name:'Ada',bench:125,squat:90})];
  store.listRecentPrs=async()=>[pr('p3','bench',125,120,1),pr('p2','bench',120,110,60)];
  await app.refreshAll();
  assert.match(document.querySelector('.toast.celebrate').textContent,/New PR! Ada · 🏋️ Bench Press 125\.0 kg/);
});
test('time fields preview how an entry will be read', async () => {
  const {app,document}=await application();
  const input=document.getElementById('mine-run1k');
  for (const [typed,hint] of [['130','= 2:10'],['1.30','= 1:30'],['1:30',''],['6:99','use m:ss, like 1:30'],['','']]) {
    input.value=typed; app.updateTimeHint(input);
    assert.equal(document.getElementById('mine-run1k-hint').textContent,hint,typed);
  }
});
test('the claim dialog explains when every athlete is already claimed', async () => {
  const {app,document}=await application({
    getSession:async()=>({user:{id:'me'}}),myProfile:async()=>({user_id:'me',status:'pending',athlete_id:null}),
    listAthletes:async()=>[athlete('a')],listProfiles:async()=>[{user_id:'other',athlete_id:'a'}],
  });
  app.openClaim();
  const select=document.getElementById('claimSelect');
  assert.equal(select.disabled,true);
  assert.match(select.textContent,/every athlete is claimed/);
});
test('relative times refresh on screen as they age, without any data changing', async () => {
  const at=new Date().toISOString();
  const {app,document}=await application({
    listAthletes:async()=>[athlete('a',{name:'Ada',bench:120})],
    listRecentPrs:async()=>[{id:'p',athlete_id:'a',payload:{lift:'bench',value:120,previous_value:110},decided_at:at}],
  });
  const feed=()=>document.querySelector('[data-feed="latest"]').textContent;
  assert.match(feed(),/just now/);
  const realNow=Date.now;
  try {
    Date.now=()=>realNow()+3*3600000;
    await app.refreshAll();
    assert.match(feed(),/3 hours ago/);
    Date.now=()=>realNow()+8*86400000;
    await app.refreshAll();
    assert.equal(document.querySelector('.badge-chip.fresh'),null,'🔥 expires after a week');
  } finally { Date.now=realNow; }
});
test('a TV limited with ?tabs starts on a chosen tab and never pages through others', async () => {
  const {app}=await application({}, {search:'?tv&tabs=total,fun'});
  assert.equal(app.activeTab,'total');
  app.switchTab('lifts'); app.tv.pages=5; app.tv.page=0;
  app.tv.advance();
  assert.equal(app.activeTab,'total','an excluded tab is left after one dwell');
});
test('archived athletes leave the boards and feeds but stay available for lookups', async () => {
  const at=new Date().toISOString();
  const {app,document}=await application({
    listAthletes:async()=>[athlete('a',{name:'Ada',bench:100}),athlete('r',{name:'Rita',bench:150,achievements:['gripper90kg'],archived_at:'2026-08-01T00:00:00Z'})],
    listRecentPrs:async()=>[{id:'p',athlete_id:'r',payload:{lift:'bench',value:150,previous_value:140},decided_at:at}],
  });
  assert.deepEqual(app.athletes.map((a)=>a.id),['a']);
  assert.equal(document.querySelector('[data-id="r"]'),null,'not on any board or in the Hall of Fame');
  assert.equal(app.latestPrs().length,0);
  assert.match(document.getElementById('athleteCount').textContent,/^1 athlete /);
  assert.equal(app.athleteById('r').name,'Rita','still found for reviews and member links');
});
test('a returning member linked to an archived athlete can bring it back', async () => {
  let restored=false;
  const {app,store,document}=await application({
    getSession:async()=>({user:{id:'rita'}}),myProfile:async()=>({user_id:'rita',status:'active',athlete_id:'r'}),
    listAthletes:async()=>[athlete('r',{name:'Rita',archived_at:'2026-08-01T00:00:00Z'})],
    restoreMyAthlete:async()=>{restored=true;},
  });
  const banner=document.getElementById('welcomeBack');
  assert.equal(banner.hidden,false);
  assert.match(banner.textContent,/Welcome back, Rita/);
  assert.ok(!document.body.classList.contains('is-active'),'My PRs stays hidden while archived');
  store.listAthletes=async()=>[athlete('r',{name:'Rita',archived_at:null})];
  await app.restoreMine();
  assert.equal(restored,true);
  assert.equal(banner.hidden,true);
  assert.ok(document.body.classList.contains('is-active'));
});
test('admins archive and restore athletes, and delete permanently only from the archive', async () => {
  const calls=[];
  const {app,store,document}=await application({
    getSession:async()=>({user:{id:'boss'}}),myProfile:async()=>({user_id:'boss',is_admin:true,status:'active'}),
    listAthletes:async()=>[athlete('a',{name:'Ada'}),athlete('r',{name:'Rita',archived_at:'2026-08-01T00:00:00Z'})],
    adminSetArchived:async(id,archived)=>calls.push([id,archived]),
  });
  app.openAthletes();
  const list=document.getElementById('athletesList');
  const control=(action,id)=>list.querySelector(`[data-action="${action}"][data-id="${id}"]`);
  assert.ok(control('archive','a') && !control('delete','a'),'active athletes are archived, not deleted');
  assert.ok(control('restore','r') && control('delete','r'));
  assert.ok(control('restore','r').closest('details'),'archived athletes sit in their own section');
  await app.setArchived('a',true);
  await app.setArchived('r',false);
  assert.deepEqual(calls,[['a',true],['r',false]]);
});
test('the claim dialog offers archived athletes to people coming back', async () => {
  const {app,document}=await application({
    getSession:async()=>({user:{id:'me'}}),myProfile:async()=>({user_id:'me',status:'pending',athlete_id:null}),
    listAthletes:async()=>[athlete('a',{name:'Ada'}),athlete('r',{name:'Rita',archived_at:'2026-08-01T00:00:00Z'})],
  });
  app.openClaim();
  const group=document.querySelector('#claimSelect optgroup');
  assert.match(group.getAttribute('label'),/Archived/);
  assert.ok(group.querySelector('option[value="r"]'));
  assert.equal(document.querySelector('#claimSelect > option[value="a"]').textContent,'Ada');
  assert.match(String(app.describeRequest({kind:'claim',athlete_id:'r',payload:{}})),/approving brings them back/);
});
