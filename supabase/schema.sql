-- Digdir Gym Leaderboard — full database schema (fresh install).
-- Paste into Supabase → SQL Editor → Run. Recreates everything from scratch.
-- For an EXISTING database, use the incremental files in supabase/migrations/ instead.
--
-- Governance model: GitHub login for identity; an admin (bootstrapped below) approves
-- people and links each to one athlete; PR/achievement changes are peer-verified;
-- name changes / new athletes are admin-approved. Members may withdraw their own pending
-- requests, and at least one working admin always remains. Enforced by RLS + functions.

-- ───────────────────────────────────────────────────────────────────────────
-- Athletes (the board)
-- ───────────────────────────────────────────────────────────────────────────
drop table if exists public.proposals cascade;
drop table if exists public.profiles cascade;
drop table if exists public.athletes cascade;

create table public.athletes (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  bench        numeric(6,1) not null default 0 check (bench    >= 0),
  squat        numeric(6,1) not null default 0 check (squat    >= 0),
  deadlift     numeric(6,1) not null default 0 check (deadlift >= 0),
  lifts        jsonb not null default '{}'::jsonb,   -- "other lifts" map: lift_id -> value (see js/lifts.js)
  achievements text[] not null default '{}',
  avatar       jsonb not null default '{}'::jsonb,   -- reserved (future avatar customizer)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
create trigger athletes_touch_updated_at
  before update on public.athletes for each row execute function public.touch_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- Profiles (one per GitHub user) + signup trigger / admin bootstrap
-- ───────────────────────────────────────────────────────────────────────────
create table public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  github_login text,
  display_name text,
  is_admin     boolean not null default false,
  status       text not null default 'pending' check (status in ('pending','active','blocked')),
  athlete_id   uuid references public.athletes(id) on delete set null,
  created_at   timestamptz not null default now()
);
create unique index profiles_athlete_unique on public.profiles(athlete_id) where athlete_id is not null;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare login text;
begin
  login := coalesce(new.raw_user_meta_data->>'user_name', new.raw_user_meta_data->>'preferred_username');
  insert into public.profiles (user_id, github_login, display_name, is_admin, status)
  values (new.id, login, coalesce(new.raw_user_meta_data->>'full_name', login),
          coalesce(login = '587763' and new.raw_app_meta_data->>'provider' = 'github', false),
          case when login = '587763' and new.raw_app_meta_data->>'provider' = 'github' then 'active' else 'pending' end)
  on conflict (user_id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

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

-- ───────────────────────────────────────────────────────────────────────────
-- Helper functions
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select is_admin and status <> 'blocked' from public.profiles where user_id = auth.uid()), false);
$$;
create or replace function public.is_active_linked()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select status='active' and athlete_id is not null
                   from public.profiles where user_id = auth.uid()), false);
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- Proposals (pending-change queue + verified-change history)
-- ───────────────────────────────────────────────────────────────────────────
create table public.proposals (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('claim','new_athlete','rename','pr','achievement')),
  approval    text not null check (approval in ('admin','peer')),
  athlete_id  uuid references public.athletes(id) on delete cascade,
  proposer    uuid not null references public.profiles(user_id) on delete cascade,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by  uuid references public.profiles(user_id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ───────────────────────────────────────────────────────────────────────────
alter table public.athletes  enable row level security;
alter table public.profiles  enable row level security;
alter table public.proposals enable row level security;

create policy "Public read access" on public.athletes for select using (true);
create policy "admins insert athletes" on public.athletes for insert to authenticated with check (public.is_admin());
create policy "admins update athletes" on public.athletes for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins delete athletes" on public.athletes for delete to authenticated using (public.is_admin());

create policy "profiles readable by authenticated" on public.profiles for select to authenticated using (true);
create policy "admins manage profiles" on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "proposals readable by authenticated" on public.proposals for select to authenticated using (true);
-- Approved PRs are public so the progression charts work for signed-out visitors.
-- Narrow on purpose; pending/rejected and other kinds stay member-only (policies OR).
create policy "approved PRs are public history" on public.proposals for select using (status = 'approved' and kind = 'pr');

-- ───────────────────────────────────────────────────────────────────────────
-- Governed write paths
-- ───────────────────────────────────────────────────────────────────────────
-- Whether a lift takes one decimal (kg) instead of whole repetitions or seconds.
-- Keep aligned with js/lifts.js: list each extra exercise whose unit is 'kg', changing
-- the list in a new migration. A test fails until both agree.
create or replace function public.lift_allows_decimals(p_lift text)
returns boolean language sql immutable set search_path = public as $$
  -- The main lifts, then each extra exercise whose unit is 'kg' (none yet).
  select coalesce(p_lift in ('squat','bench','deadlift'), false);
$$;

-- Apply the same basic validation to governed and direct admin writes.
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
drop trigger if exists athletes_validate_values on public.athletes;
create trigger athletes_validate_values before insert or update on public.athletes
  for each row execute function public.validate_athlete_values();

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
    if not coalesce(prof.is_admin or (prof.status='active' and prof.athlete_id is not null and uid <> pr.proposer), false) then
      raise exception 'a different active member (peer) or an admin must verify this';
    end if;
  end if;

  if not p_approve then
    update public.proposals set status='rejected', decided_by=uid, decided_at=now() where id=p_id;
    return;
  end if;

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
  end if;

  update public.proposals set status='approved', decided_by=uid, decided_at=now() where id = p_id;
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

create index if not exists proposals_pending_created on public.proposals(created_at) where status = 'pending';
create index if not exists proposals_history_athlete on public.proposals(athlete_id, decided_at) where status = 'approved' and kind = 'pr';
-- Public feed of recently verified PRs (approved PRs are already public through RLS).
create index if not exists proposals_recent_prs on public.proposals (decided_at desc) where status = 'approved' and kind = 'pr';

-- ───────────────────────────────────────────────────────────────────────────
-- Realtime + seed
-- ───────────────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table public.athletes;
alter publication supabase_realtime add table public.proposals;
alter publication supabase_realtime add table public.profiles;

insert into public.athletes (name, bench, squat, deadlift, achievements, lifts) values
  ('Alexander', 132.5, 120.0, 137.5, '{gripper90kg}', '{"deadhang": 95}'),
  ('Daniel',    110.0, 137.5, 160.0, '{}',            '{"deadhang": 72}'),
  ('Hallvard',  110.0,  80.0,  90.0, '{}',            '{}'),
  ('Jens',      137.5,   0.0,   0.0, '{}',            '{}');
