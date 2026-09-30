-- Member safeguards: members withdraw their own pending requests, the last working admin
-- cannot be removed, extra exercises validate by unit, PRs must change the recorded value,
-- deleting a reviewer keeps decided history, and recent verified PRs are indexed.
-- Existing athletes, profiles and history are preserved; no rows are rewritten.
-- Apply after 0005 as one transaction. Safe to re-run.
begin;

-- Whether a lift takes one decimal (kg) instead of whole repetitions or seconds.
-- Keep aligned with js/lifts.js: list each extra exercise whose unit is 'kg', changing
-- the list in a new migration. A test fails until both agree.
create or replace function public.lift_allows_decimals(p_lift text)
returns boolean language sql immutable set search_path = public as $$
  -- The main lifts, then each extra exercise whose unit is 'kg' (none yet).
  select coalesce(p_lift in ('squat','bench','deadlift'), false);
$$;

-- The stricter rules apply to later writes. Rows are never rewritten, so stop here if a
-- stored value could no longer be saved (production was audited and has none).
do $$
declare bad record;
begin
  select a.name, e.key, e.value into bad from public.athletes a, jsonb_each(a.lifts) e
   where jsonb_typeof(e.value) = 'number' and (e.value::text)::numeric
         <> round((e.value::text)::numeric, case when public.lift_allows_decimals(e.key) then 1 else 0 end)
   limit 1;
  if found then
    raise exception 'athlete "%" has % = %, which its unit does not allow; correct it, then rerun this migration',
      bad.name, bad.key, bad.value;
  end if;
end $$;

create or replace function public.validate_athlete_values()
returns trigger language plpgsql set search_path = public as $$
declare entry record; val numeric;
begin
  new.name := btrim(new.name);
  if new.name is null or length(new.name) not between 1 and 80 then
    raise exception 'name must have between 1 and 80 characters';
  end if;
  if jsonb_typeof(new.lifts) is distinct from 'object' then
    raise exception 'lifts must be an object';
  end if;
  for entry in select * from jsonb_each(new.lifts) loop
    if entry.key !~ '^[a-z][a-z0-9_]{0,39}$' or entry.key in ('bench','squat','deadlift','total')
       or jsonb_typeof(entry.value) <> 'number' then
      raise exception 'invalid extra lift';
    end if;
    val := (entry.value::text)::numeric;
    if val not between 0 and 99999 then
      raise exception 'lift values must be between 0 and 99999';
    elsif val <> round(val) and not public.lift_allows_decimals(entry.key) then
      raise exception 'repetitions and times must be whole numbers';
    elsif val <> round(val, 1) then
      raise exception 'weights may have at most one decimal';
    end if;
  end loop;
  if new.bench not between 0 and 99999 or new.squat not between 0 and 99999
     or new.deadlift not between 0 and 99999 then
    raise exception 'lift values must be between 0 and 99999';
  end if;
  return new;
end; $$;

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

-- A member withdraws one of their own pending requests of any kind. It is recorded as
-- the proposer rejecting it, so history keeps who closed it and when.
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
  if pr.proposer <> uid then raise exception 'you can only withdraw your own requests'; end if;
  update public.proposals set status='rejected', decided_by=uid, decided_at=now() where id = p_id;
end; $$;

-- At least one working admin (is_admin and not blocked) must remain. Each removal takes
-- the same transaction lock before counting, so concurrent removals are checked one at
-- a time; under READ COMMITTED (PostgREST, SQL Editor) the count sees committed changes.
create or replace function public.protect_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.is_admin and old.status <> 'blocked'
     and (tg_op = 'DELETE' or not (new.is_admin and new.status <> 'blocked')) then
    perform pg_advisory_xact_lock(hashtext('public.profiles:admins'));
    if not exists (select 1 from public.profiles where user_id <> old.user_id
                   and is_admin and status <> 'blocked') then
      raise exception 'at least one active admin must remain';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;
drop trigger if exists profiles_protect_last_admin on public.profiles;
create trigger profiles_protect_last_admin before update or delete on public.profiles
  for each row execute function public.protect_last_admin();

-- Deleting a reviewer's account keeps the requests they decided. Older databases may name
-- this key differently, so replace whichever foreign key covers decided_by.
do $$
declare con name;
begin
  for con in select conname from pg_constraint
    where conrelid = 'public.proposals'::regclass and contype = 'f'
      and conkey = array[(select attnum from pg_attribute
                          where attrelid = 'public.proposals'::regclass and attname = 'decided_by')]
  loop
    execute format('alter table public.proposals drop constraint %I', con);
  end loop;
  alter table public.proposals add constraint proposals_decided_by_fkey
    foreign key (decided_by) references public.profiles(user_id) on delete set null;
end $$;

-- Public feed of recently verified PRs (approved PRs are already public through RLS).
create index if not exists proposals_recent_prs on public.proposals (decided_at desc) where status = 'approved' and kind = 'pr';

commit;
