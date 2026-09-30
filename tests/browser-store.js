// Browser-only fixtures served by npm run dev. No Supabase client or remote writes.
(() => {
  const fixture = new URLSearchParams(location.search).get('fixture');
  const names = ['Alex','Daniel','Hallvard','Jens','Solveig','An exceptionally long athlete name that needs to wrap'];
  let athletes = fixture === 'empty' ? [] : Array.from({length:fixture==='large'?65:6},(_,i)=>({
    id:`athlete-${i}`,name:names[i] || `Athlete ${i + 1}`,bench:140-i,squat:160-i,deadlift:180-i,
    lifts:{deadhang:90+i,pullups:12,run1k:240+i},achievements:['gripper90kg'],
    updated_at:'2026-09-01T08:00:00Z',
  }));
  if (fixture === 'layout') athletes = athletes.map((a, i) => ({
    ...a, name: i < 3 ? `${'Longathletename'.repeat(4)} ${i + 1}` : a.name,
    bench: 99999 - i / 10, squat: 99999 - i / 10, deadlift: 99999 - i / 10,
    lifts: {deadhang:99999 - i, pullups:99999 - i, pushups:99999 - i, run1k:99999 - i},
  }));
  const day = 86400000;
  const ago = (days) => new Date(Date.now() - days * day).toISOString();
  const profile = {user_id:'admin',github_login:'preview-admin',is_admin:true,status:'active',athlete_id:'athlete-0'};
  let profiles = [profile,
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
  ];
  const copy = (data) => structuredClone(data);
  const signedIn = fixture === 'admin';
  window.Store = {
    configured:true, userLabel:()=>profile.github_login,
    getSession:async()=>signedIn?{user:{id:'admin'}}:null,
    myProfile:async()=>copy(profile), listProfiles:async()=>copy(profiles),
    listAthletes:async()=>{if(fixture==='error') throw new Error('Fixture connection failure'); return copy(athletes);},
    listPendingProposals:async()=>copy(proposals),
    listRecentPrs:async()=>copy(history).reverse(),
    listAthleteHistory:async(id)=>copy(history.filter((h)=>h.athlete_id===id)),
    subscribe:(_cb,status)=>status('SUBSCRIBED'), onAuthChange(){},
    signIn:async()=>{},signOut:async()=>{},
    propose:async(kind,id,payload)=>{proposals.push({id:crypto.randomUUID(),kind,athlete_id:id,payload,proposer:'admin',approval:['pr','achievement'].includes(kind)?'peer':'admin',status:'pending',created_at:new Date().toISOString()});},
    decide:async(id)=>{proposals=proposals.filter((p)=>p.id!==id);},
    withdraw:async(id)=>{proposals=proposals.filter((p)=>p.id!==id);},
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
