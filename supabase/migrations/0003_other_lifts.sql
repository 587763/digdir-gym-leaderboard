-- "Other lifts" — extra lifts beyond squat/bench/deadlift, stored in a generic
-- jsonb map on athletes (NO per-lift column), so new lifts need no migration.
-- The lift registry + units (kg / time-in-seconds) live in js/lifts.js.
-- Apply to the live DB by pasting into Supabase → SQL Editor → Run.
-- Safe to re-run; does NOT touch existing athlete values.

-- 1. The generic value store: lift_id -> value (numeric; seconds for time lifts).
alter table public.athletes
  add column if not exists lifts jsonb not null default '{}'::jsonb;

-- 2. Teach decide() to route 'pr' proposals: the three fixed lifts keep their
--    columns; anything else lands in the lifts jsonb map. Rest of the function
--    is unchanged from 0002.
create or replace function public.decide(p_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles; pr public.proposals; new_ath uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  select * into pr from public.proposals where id = p_id and status = 'pending';
  if pr is null then raise exception 'proposal not found or already decided'; end if;

  if pr.approval = 'admin' then
    if not prof.is_admin then raise exception 'only an admin can decide this'; end if;
  else  -- peer
    if not (prof.is_admin or (prof.status='active' and prof.athlete_id is not null and uid <> pr.proposer)) then
      raise exception 'a different active member (peer) or an admin must verify this';
    end if;
  end if;

  if not p_approve then
    update public.proposals set status='rejected', decided_by=uid, decided_at=now() where id=p_id;
    return;
  end if;

  if pr.kind = 'pr' then
    if pr.payload->>'lift' in ('bench','squat','deadlift') then
      update public.athletes set
        bench    = case when pr.payload->>'lift'='bench'    then (pr.payload->>'value')::numeric else bench end,
        squat    = case when pr.payload->>'lift'='squat'    then (pr.payload->>'value')::numeric else squat end,
        deadlift = case when pr.payload->>'lift'='deadlift' then (pr.payload->>'value')::numeric else deadlift end
      where id = pr.athlete_id;
    else  -- "other lift": store in the jsonb map under its lift_id (no per-lift column)
      update public.athletes
        set lifts = jsonb_set(coalesce(lifts, '{}'::jsonb),
                              array[pr.payload->>'lift'],
                              to_jsonb((pr.payload->>'value')::numeric), true)
      where id = pr.athlete_id;
    end if;
  elsif pr.kind = 'achievement' then
    if pr.payload->>'op' = 'add' then
      update public.athletes
        set achievements = (select array(select distinct unnest(achievements || array[pr.payload->>'achievement_id'])))
        where id = pr.athlete_id;
    else
      update public.athletes set achievements = array_remove(achievements, pr.payload->>'achievement_id')
        where id = pr.athlete_id;
    end if;
  elsif pr.kind = 'rename' then
    update public.athletes set name = pr.payload->>'name' where id = pr.athlete_id;
  elsif pr.kind = 'new_athlete' then
    insert into public.athletes(name) values (pr.payload->>'name') returning id into new_ath;
    update public.proposals set athlete_id = new_ath where id = pr.id;
    if (select athlete_id from public.profiles where user_id = pr.proposer) is null then
      update public.profiles set athlete_id = new_ath, status='active' where user_id = pr.proposer;
    end if;
  elsif pr.kind = 'claim' then
    if exists (select 1 from public.profiles where athlete_id = pr.athlete_id and user_id <> pr.proposer) then
      raise exception 'that athlete is already claimed';
    end if;
    update public.profiles set athlete_id = pr.athlete_id, status='active' where user_id = pr.proposer;
  end if;

  update public.proposals set status='approved', decided_by=uid, decided_at=now() where id = p_id;
end; $$;
