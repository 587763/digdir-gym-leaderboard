-- Archive athletes instead of deleting them: an archived athlete leaves the boards but keeps
-- its records and verified history. Admins archive and restore by setting archived_at, a
-- linked member restores their own athlete, and approving a claim restores the claimed one.
-- Archived athletes take no PR, achievement or name changes until restored. Deleting a
-- member's account keeps the requests they made, without a proposer; those can be rejected
-- but not approved or withdrawn. Deleting an athlete still erases its requests and
-- history, for data-erasure requests.
-- Existing athletes, profiles and history are preserved; no rows are rewritten.
-- Apply after 0006 as one transaction. Safe to re-run.
begin;

-- Null keeps an athlete on the boards. Admins archive and restore with ordinary updates.
alter table public.athletes add column if not exists archived_at timestamptz;

-- Deleting a member's account keeps the requests they made, so verified history stays.
-- Older databases may name this key differently, so replace whichever foreign key covers proposer.
alter table public.proposals alter column proposer drop not null;
do $$
declare con name;
begin
  for con in select conname from pg_constraint
    where conrelid = 'public.proposals'::regclass and contype = 'f'
      and conkey = array[(select attnum from pg_attribute
                          where attrelid = 'public.proposals'::regclass and attname = 'proposer')]
  loop
    execute format('alter table public.proposals drop constraint %I', con);
  end loop;
  alter table public.proposals add constraint proposals_proposer_fkey
    foreign key (proposer) references public.profiles(user_id) on delete set null;
end $$;

create or replace function public.propose(p_kind text, p_athlete uuid, p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles; appr text; new_id uuid; val numeric; old_val numeric;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  -- Serializes submissions by one user, including double clicks / request retries.
  select * into prof from public.profiles where user_id = uid for update;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'payload must be an object'; end if;

  if p_kind in ('pr','achievement','rename') then
    appr := case when p_kind = 'rename' then 'admin' else 'peer' end;
    if not coalesce(prof.is_admin or (prof.status='active' and prof.athlete_id = p_athlete), false) then
      raise exception 'you can only propose for your own linked athlete';
    end if;
  elsif p_kind in ('claim','new_athlete') then
    appr := 'admin';
    if prof.athlete_id is not null then raise exception 'you are already linked to an athlete'; end if;
    if p_kind = 'claim' and exists (select 1 from public.profiles where athlete_id = p_athlete) then
      raise exception 'that athlete is already claimed';
    end if;
  else raise exception 'unknown proposal kind';
  end if;

  if p_kind <> 'new_athlete' then
    if p_athlete is null or not exists (select 1 from public.athletes where id = p_athlete) then
      raise exception 'athlete not found';
    end if;
    -- An archived athlete's records stay as they are until it is restored (a claim may restore it).
    if p_kind in ('pr','achievement','rename')
       and exists (select 1 from public.athletes where id = p_athlete and archived_at is not null) then
      raise exception 'that athlete is archived';
    end if;
  else
    p_athlete := null;
  end if;
  if p_kind in ('rename','new_athlete') then
    if jsonb_typeof(p_payload->'name') is distinct from 'string'
       or length(btrim(p_payload->>'name')) not between 1 and 80 then
      raise exception 'name must have between 1 and 80 characters';
    end if;
    p_payload := jsonb_build_object('name', btrim(p_payload->>'name'));
  elsif p_kind = 'pr' then
    if jsonb_typeof(p_payload->'lift') is distinct from 'string'
       or p_payload->>'lift' !~ '^[a-z][a-z0-9_]{0,39}$' or p_payload->>'lift' = 'total'
       or jsonb_typeof(p_payload->'value') is distinct from 'number' then
      raise exception 'invalid lift or value';
    end if;
    val := (p_payload->>'value')::numeric;
    if val not between 0 and 99999 then
      raise exception 'lift values must be between 0 and 99999';
    elsif val <> round(val) and not public.lift_allows_decimals(p_payload->>'lift') then
      raise exception 'repetitions and times must be whole numbers';
    elsif val <> round(val, 1) then
      raise exception 'weights may have at most one decimal';
    end if;
    select case p_payload->>'lift' when 'bench' then bench when 'squat' then squat
      when 'deadlift' then deadlift else coalesce((lifts->>(p_payload->>'lift'))::numeric, 0) end
      into old_val from public.athletes where id = p_athlete;
    if val = old_val then raise exception 'no change: that value is already recorded'; end if;
    -- The base is server-owned; approval must not overwrite a newer verified change.
    p_payload := jsonb_build_object('lift', p_payload->>'lift', 'value', val, 'previous_value', old_val);
  elsif p_kind = 'achievement' then
    if jsonb_typeof(p_payload->'achievement_id') is distinct from 'string'
       or p_payload->>'achievement_id' !~ '^[a-z][a-z0-9_]{0,79}$'
       or coalesce(p_payload->>'op', '') not in ('add','remove') then
      raise exception 'invalid achievement operation';
    end if;
    p_payload := jsonb_build_object('achievement_id', p_payload->>'achievement_id', 'op', p_payload->>'op');
  else p_payload := '{}'::jsonb;
  end if;

  select id into new_id from public.proposals where proposer = uid and status = 'pending'
    and kind = p_kind and athlete_id is not distinct from p_athlete and payload = p_payload limit 1;
  if found then return new_id; end if;
  insert into public.proposals(kind, approval, athlete_id, proposer, payload)
    values (p_kind, appr, p_athlete, uid, p_payload) returning id into new_id;
  return new_id;
end; $$;

create or replace function public.decide(p_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles; pr public.proposals; new_ath uuid; proposer_profile public.profiles; current_value numeric;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  if p_approve is null then raise exception 'approval must be true or false'; end if;
  select * into pr from public.proposals where id = p_id and status = 'pending' for update;
  if not found then raise exception 'proposal not found or already decided'; end if;

  if pr.approval = 'admin' then
    if not coalesce(prof.is_admin, false) then raise exception 'only an admin can decide this'; end if;
  else
    -- A request left by a deleted account (no proposer) is someone else's, so a peer may reject it.
    if not coalesce(prof.is_admin or (prof.status='active' and prof.athlete_id is not null and uid is distinct from pr.proposer), false) then
      raise exception 'a different active member (peer) or an admin must verify this';
    end if;
  end if;

  if not p_approve then
    update public.proposals set status='rejected', decided_by=uid, decided_at=now() where id=p_id;
    return;
  end if;

  -- Also refuses requests whose proposer's account was deleted; those can only be rejected.
  select * into proposer_profile from public.profiles where user_id = pr.proposer for update;
  if not found or proposer_profile.status = 'blocked' then raise exception 'proposer is unavailable or blocked'; end if;
  if pr.kind in ('claim','new_athlete') and proposer_profile.athlete_id is not null then
    raise exception 'proposer is already linked to an athlete';
  end if;
  if pr.kind in ('pr','achievement','rename') and not coalesce(proposer_profile.is_admin or
      (proposer_profile.status = 'active' and proposer_profile.athlete_id = pr.athlete_id), false) then
    raise exception 'proposer is no longer linked to this athlete';
  end if;
  if pr.kind <> 'new_athlete' then
    perform 1 from public.athletes where id = pr.athlete_id for update;
    if not found then raise exception 'athlete not found'; end if;
    if pr.kind in ('pr','achievement','rename')
       and exists (select 1 from public.athletes where id = pr.athlete_id and archived_at is not null) then
      raise exception 'that athlete is archived; restore it first';
    end if;
  end if;
  if pr.kind = 'pr' and pr.payload ? 'previous_value' then
    select case pr.payload->>'lift' when 'bench' then bench when 'squat' then squat
      when 'deadlift' then deadlift else coalesce((lifts->>(pr.payload->>'lift'))::numeric, 0) end
      into current_value from public.athletes where id = pr.athlete_id;
    if current_value is distinct from (pr.payload->>'previous_value')::numeric then
      raise exception 'this lift changed since submission; reject this request and submit the current value again';
    end if;
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
    -- A returning person's approved claim puts their archived athlete back on the boards.
    update public.athletes set archived_at = null where id = pr.athlete_id and archived_at is not null;
  end if;

  update public.proposals set status='approved', decided_by=uid, decided_at=now() where id = p_id;
end; $$;

-- A member withdraws one of their own pending requests of any kind. It is recorded as
-- the proposer rejecting it, so history keeps who closed it and when. A request left by a
-- deleted account has no proposer, so nobody can withdraw it; reviewers reject it instead.
create or replace function public.withdraw(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles; pr public.proposals;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  select * into pr from public.proposals where id = p_id and status = 'pending' for update;
  if not found then raise exception 'proposal not found or already decided'; end if;
  if pr.proposer is distinct from uid then raise exception 'you can only withdraw your own requests'; end if;
  update public.proposals set status='rejected', decided_by=uid, decided_at=now() where id = p_id;
end; $$;

-- A member who signs in again with the same account is still linked, so they may put their
-- own archived athlete back on the boards. An athlete that is not archived stays unchanged.
create or replace function public.restore_my_athlete()
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  if prof.athlete_id is null then raise exception 'you are not linked to an athlete'; end if;
  perform 1 from public.athletes where id = prof.athlete_id for update;
  if not found then raise exception 'athlete not found'; end if;
  update public.athletes set archived_at = null where id = prof.athlete_id and archived_at is not null;
  return prof.athlete_id;
end; $$;

commit;
