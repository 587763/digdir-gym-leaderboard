-- Digdir Gym Leaderboard — full database schema (fresh install).
-- Paste into Supabase → SQL Editor → Run. Recreates everything from scratch.
-- For an EXISTING database, use the incremental files in supabase/migrations/ instead.
--
-- Governance model: GitHub login for identity; an admin (bootstrapped below) approves
-- people and links each to one athlete; PR/achievement changes are peer-verified;
-- name changes / new athletes are admin-approved. Enforced by RLS + functions.

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
          login = '587763',
          case when login = '587763' then 'active' else 'pending' end)
  on conflict (user_id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ───────────────────────────────────────────────────────────────────────────
-- Helper functions
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select is_admin from public.profiles where user_id = auth.uid()), false);
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
  decided_by  uuid references public.profiles(user_id),
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

-- ───────────────────────────────────────────────────────────────────────────
-- Governed write paths
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.propose(p_kind text, p_athlete uuid, p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles; appr text; new_id uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if prof is null then raise exception 'no profile'; end if;

  if p_kind in ('pr','achievement') then
    appr := 'peer';
    if not (prof.is_admin or (prof.status='active' and prof.athlete_id = p_athlete)) then
      raise exception 'you can only propose for your own linked athlete';
    end if;
  elsif p_kind = 'rename' then
    appr := 'admin';
    if not (prof.is_admin or (prof.status='active' and prof.athlete_id = p_athlete)) then
      raise exception 'you can only rename your own linked athlete';
    end if;
  elsif p_kind = 'claim' then
    appr := 'admin';
    if prof.athlete_id is not null then raise exception 'you are already linked to an athlete'; end if;
    if exists (select 1 from public.profiles where athlete_id = p_athlete) then
      raise exception 'that athlete is already claimed';
    end if;
  elsif p_kind = 'new_athlete' then
    appr := 'admin';
  else raise exception 'unknown proposal kind: %', p_kind;
  end if;

  insert into public.proposals(kind, approval, athlete_id, proposer, payload)
  values (p_kind, appr, p_athlete, uid, coalesce(p_payload, '{}'::jsonb))
  returning id into new_id;
  return new_id;
end; $$;

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
  else
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
