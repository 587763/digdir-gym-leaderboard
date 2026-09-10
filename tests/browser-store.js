// Browser-only fixtures served by npm run dev. No Supabase client or remote writes.
(() => {
  const fixture = new URLSearchParams(location.search).get('fixture');
  const names = ['Alex','Daniel','Hallvard','Jens','Solveig','An exceptionally long athlete name that needs to wrap'];
  let athletes = fixture === 'empty' ? [] : Array.from({length:fixture==='large'?65:6},(_,i)=>({
    id:`athlete-${i}`,name:names[i] || `Athlete ${i + 1}`,bench:140-i,squat:160-i,deadlift:180-i,
    lifts:{deadhang:90+i,pullups:12,run1k:240+i},achievements:['gripper90kg'],
  }));
  if (fixture === 'layout') athletes = athletes.map((a, i) => ({
    ...a, name: i < 3 ? `${'Longathletename'.repeat(4)} ${i + 1}` : a.name,
    bench: 99999 - i / 10, squat: 99999 - i / 10, deadlift: 99999 - i / 10,
    lifts: {deadhang:99999 - i, pullups:99999 - i, pushups:99999 - i, run1k:99999 - i},
  }));
  const profile = {user_id:'admin',github_login:'preview-admin',is_admin:true,status:'active',athlete_id:'athlete-0'};
  let proposals = [{id:'proposal-1',kind:'pr',approval:'peer',athlete_id:'athlete-1',proposer:'peer',payload:{lift:'bench',value:145}}];
  const copy = (data) => structuredClone(data);
  window.Store = {
    configured:true, userLabel:()=>profile.github_login,
    getSession:async()=>fixture==='admin'?{user:{id:'admin'}}:null,
    myProfile:async()=>copy(profile), listProfiles:async()=>[copy(profile)],
    listAthletes:async()=>{if(fixture==='error') throw new Error('Fixture connection failure'); return copy(athletes);},
    listPendingProposals:async()=>copy(proposals),
    listAthleteHistory:async()=>[
      {payload:{lift:'bench',value:100},decided_at:'2026-06-01'},
      {payload:{lift:'bench',value:110},decided_at:'2026-06-03'},
      {payload:{lift:'bench',value:120},decided_at:'2026-08-01'},
    ],
    subscribe:(_cb,status)=>status('SUBSCRIBED'), onAuthChange(){},
    signIn:async()=>{},signOut:async()=>{},
    propose:async(kind,id,payload)=>proposals.push({id:crypto.randomUUID(),kind,athlete_id:id,payload,proposer:'admin',approval:'peer'}),
    decide:async(id)=>{proposals=proposals.filter((p)=>p.id!==id);},
    adminUpdateProfile:async(_id,patch)=>Object.assign(profile,patch),
    adminCreateAthlete:async(data)=>athletes.push({...data,id:crypto.randomUUID()}),
    adminUpdateAthlete:async(id,patch)=>Object.assign(athletes.find((a)=>a.id===id),patch),
    adminDeleteAthlete:async(id)=>{athletes=athletes.filter((a)=>a.id!==id);},
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const banner=document.createElement('div');
    banner.className='config-banner fixture-banner'; banner.textContent=`Local test fixture: ${fixture}. Changes stay in this tab.`;
    const style = document.createElement('style');
    style.textContent = '.tv-mode .fixture-banner { position: fixed; bottom: 6px; left: 28px; z-index: 10; margin: 0; padding: 2px 6px; font: 12px/1.5 system-ui; }';
    document.head.appendChild(style);
    document.querySelector('.container').prepend(banner);
  });
})();
