// Browser-only fixtures served by npm run dev. No Supabase client or remote writes.
(() => {
  const fixture = new URLSearchParams(location.search).get('fixture');
  const names = ['Alex','Daniel','Hallvard','Jens','Solveig','An exceptionally long athlete name that needs to wrap'];
  let athletes = fixture === 'empty' ? [] : Array.from({length:fixture==='large'?65:6},(_,i)=>({
    id:`athlete-${i}`,name:names[i] || `Athlete ${i + 1}`,bench:140-i,squat:160-i,deadlift:180-i,
    lifts:{deadhang:90+i,pullups:12,run1k:240+i,strictcurl:55-i/2},achievements:['gripper90kg'],
    // Every third athlete keeps their bodyweight to themselves (off the ⚖️ boards).
    bodyweight:i % 3 === 2 ? null : 72 + (i * 7) % 40,
    updated_at:'2026-09-01T08:00:00Z',
  }));
  if (fixture === 'layout') athletes = athletes.map((a, i) => ({
    ...a, name: i < 3 ? `${'Longathletename'.repeat(4)} ${i + 1}` : a.name,
    bench: 99999 - i / 10, squat: 99999 - i / 10, deadlift: 99999 - i / 10, bodyweight: 30 + i / 10,
    lifts: {deadhang:99999 - i, pullups:99999 - i, pushups:99999 - i, run1k:99999 - i, strictcurl:99999 - i / 10},
  }));
  // An archived athlete: off the boards, records and verified history kept.
  if (fixture !== 'empty') athletes.push({id:'athlete-archived',name:'Rita Retired',bench:95,squat:120,deadlift:140,
    lifts:{deadhang:60},achievements:[],archived_at:'2026-08-01T10:00:00Z',updated_at:'2026-08-01T10:00:00Z'});
  const day = 86400000;
  const ago = (days) => new Date(Date.now() - days * day).toISOString();
  const profile = {user_id:'admin',github_login:'preview-admin',is_admin:true,status:'active',athlete_id:'athlete-0'};
  // ?fixture=returning signs in as a member whose athlete was archived while they were away.
  const returning = {user_id:'rita',github_login:'rita-returns',is_admin:false,status:'active',athlete_id:'athlete-archived'};
  const me = fixture === 'returning' ? returning : profile;
  let profiles = [profile, returning,
    {user_id:'peer',github_login:'daniel-lifts',is_admin:false,status:'active',athlete_id:'athlete-1'},
    {user_id:'newbie',github_login:'new-member',is_admin:false,status:'pending',athlete_id:null},
    {user_id:'banned',github_login:'blocked-member',is_admin:false,status:'blocked',athlete_id:null},
  ];
  let proposals = [
    {id:'proposal-1',kind:'pr',approval:'peer',athlete_id:'athlete-1',proposer:'peer',status:'pending',created_at:ago(2),payload:{lift:'bench',value:145,previous_value:139}},
    {id:'proposal-2',kind:'claim',approval:'admin',athlete_id:'athlete-3',proposer:'newbie',status:'pending',created_at:ago(0.1),payload:{}},
  ];
  const history = [
    {id:'pr-1',athlete_id:'athlete-1',payload:{lift:'bench',value:100},decided_at:'2026-06-01T10:00:00Z'},
    {id:'pr-2',athlete_id:'athlete-1',payload:{lift:'bench',value:110,previous_value:100},decided_at:'2026-06-03T10:00:00Z'},
    {id:'pr-3',athlete_id:'athlete-1',payload:{lift:'bench',value:120,previous_value:110},decided_at:'2026-08-01T10:00:00Z'},
    {id:'pr-4',athlete_id:'athlete-archived',payload:{lift:'squat',value:120,previous_value:110},decided_at:'2026-07-15T10:00:00Z'},
  ];
  // Planned sessions this week and next, relative to today, with people joining them.
  const at = (days, hour, minute = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, minute, 0, 0); return d.toISOString(); };
  const friday = (5 - new Date().getDay() + 7) % 7;
  // Each join is [user, arrival]; people come at different times.
  const join = (...people) => people.map(([user_id, arrives_at], i) => ({user_id, arrives_at, created_at:ago(1 - i / 10)}));
  let plans = fixture === 'empty' ? [] : [
    {id:'plan-1',owner:'peer',starts_at:at(0, 16),activity:'Squat',note:'Working up to a heavy triple. Spotters welcome!',plan_joins:join(['admin',at(0, 16, 30)])},
    {id:'plan-2',owner:'admin',starts_at:at(1, 11, 30),activity:'Upper body',note:null,plan_joins:join(['peer',at(1, 11, 30)])},
    {id:'plan-3',owner:'peer',starts_at:at(friday, 15),activity:'Bench Press',note:'Friday bench. Bring chalk.',plan_joins:join(['rita',at(friday, 14, 30)])},
    {id:'plan-4',owner:'admin',starts_at:at(friday + 3, 7, 30),activity:'5 km run along the river',note:null,plan_joins:[]},
    {id:'plan-5',owner:'rita',starts_at:at(-1, 12),activity:'Deadlift',note:null,plan_joins:join(['peer',at(-1, 12)],['admin',at(-1, 12, 15)])},
  ];
  if (fixture === 'admin') plans.push({id:'plan-long',owner:'peer',starts_at:at(2, 17, 45),activity:'Longactivitynamewithoutanyspaces'.repeat(2).slice(0, 60),
    note:'A long note that keeps going, because someone had a lot to say about their plans for the afternoon session and the kettlebells.'.slice(0, 200),
    plan_joins:join(['admin',at(2, 18)],['rita',at(2, 17, 45)],['newbie',at(2, 19, 15)])});
  const copy = (data) => structuredClone(data);
  const signedIn = ['admin', 'returning'].includes(fixture);
  window.Store = {
    configured:true, userLabel:()=>me.github_login,
    getSession:async()=>signedIn?{user:{id:me.user_id}}:null,
    myProfile:async()=>copy(profiles.find((p)=>p.user_id===me.user_id)), listProfiles:async()=>copy(profiles),
    listAthletes:async()=>{if(fixture==='error') throw new Error('Fixture connection failure'); return copy(athletes);},
    listPendingProposals:async()=>copy(proposals),
    listRecentPrs:async()=>copy(history).reverse(),
    listAthleteHistory:async(id)=>copy(history.filter((h)=>h.athlete_id===id)),
    listPlans:async(from,to)=>copy(plans.filter((p)=>p.starts_at>=from&&p.starts_at<to).sort((a,b)=>a.starts_at.localeCompare(b.starts_at))),
    savePlan:async(id,starts_at,activity,note)=>{const plan=plans.find((p)=>p.id===id);
      if(!plan) return plans.push({id:crypto.randomUUID(),owner:me.user_id,starts_at,activity,note,plan_joins:[]});
      const moved=Date.parse(starts_at)-Date.parse(plan.starts_at);
      plan.plan_joins.forEach((j)=>{j.arrives_at=new Date(Date.parse(j.arrives_at)+moved).toISOString();});
      Object.assign(plan,{starts_at,activity,note});},
    deletePlan:async(id)=>{plans=plans.filter((p)=>p.id!==id);},
    joinPlan:async(id,joining,arrives_at)=>{const plan=plans.find((p)=>p.id===id); plan.plan_joins=plan.plan_joins.filter((j)=>j.user_id!==me.user_id);
      if(joining) plan.plan_joins.push({user_id:me.user_id,arrives_at:arrives_at??plan.starts_at,created_at:new Date().toISOString()});},
    subscribe:(_cb,status)=>status('SUBSCRIBED'), onAuthChange(){},
    signIn:async()=>{},signOut:async()=>{},
    propose:async(kind,id,payload)=>{proposals.push({id:crypto.randomUUID(),kind,athlete_id:id,payload,proposer:'admin',approval:['pr','achievement'].includes(kind)?'peer':'admin',status:'pending',created_at:new Date().toISOString()});},
    decide:async(id)=>{proposals=proposals.filter((p)=>p.id!==id);},
    withdraw:async(id)=>{proposals=proposals.filter((p)=>p.id!==id);},
    restoreMyAthlete:async()=>{const a=athletes.find((x)=>x.id===me.athlete_id); if(a) a.archived_at=null;},
    setMyBodyweight:async(kg)=>{athletes.find((x)=>x.id===me.athlete_id).bodyweight=kg;},
    adminSetArchived:async(id,archived)=>{athletes.find((a)=>a.id===id).archived_at=archived?new Date().toISOString():null;},
    adminUpdateProfile:async(id,patch)=>Object.assign(profiles.find((p)=>p.user_id===id),patch),
    adminCreateAthlete:async(data)=>athletes.push({...data,id:crypto.randomUUID()}),
    adminUpdateAthlete:async(id,patch)=>Object.assign(athletes.find((a)=>a.id===id),patch),
    adminDeleteAthlete:async(id)=>{athletes=athletes.filter((a)=>a.id!==id);},
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const banner=document.createElement('div');
    banner.className='config-banner fixture-banner'; banner.textContent=`Local test fixture: ${fixture}. Changes stay in this tab.`;
    // A constructed stylesheet, because the page's CSP forbids inline <style> elements.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.tv-mode .fixture-banner { position: fixed; bottom: 6px; left: 28px; z-index: 10; margin: 0; padding: 2px 6px; font: 12px/1.5 system-ui; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    document.querySelector('.container').prepend(banner);
  });
})();
