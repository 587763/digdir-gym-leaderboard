-- Self-governance model: admins, self-claim, peer-verified PRs/achievements.
-- Replaces the GitHub-org gating from 0001. Apply to the live DB by pasting into
-- Supabase → SQL Editor → Run. Does NOT touch existing athlete rows.
--
-- Bootstrap admin: the GitHub login below is made admin automatically (on signup
-- and via the backfill at the bottom). Change it if needed.

-- ───────────────────────────────────────────────────────────────────────────
-- 0. Tear down the org-gating from migration 0001
-- ───────────────────────────────────────────────────────────────────────────
drop policy if exists "Editors can insert" on public.athletes;
drop policy if exists "Editors can update" on public.athletes;
drop policy if exists "Editors can delete" on public.athletes;
drop table if exists public.editors cascade;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Profiles — one per signed-in GitHub user
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  github_login text,
  display_name text,
  is_admin     boolean not null default false,
  status       text not null default 'pending' check (status in ('pending','active','blocked')),
  athlete_id   uuid references public.athletes(id) on delete set null,
  created_at   timestamptz not null default now()
);
-- One GitHub account per athlete.
create unique index if not exists profiles_athlete_unique
  on public.profiles(athlete_id) where athlete_id is not null;

-- Auto-create a profile on signup; bootstrap the first admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare login text;
begin
  login := coalesce(new.raw_user_meta_data->>'user_name', new.raw_user_meta_data->>'preferred_username');
  insert into public.profiles (user_id, github_login, display_name, is_admin, status)
  values (
    new.id, login,
    coalesce(new.raw_user_meta_data->>'full_name', login),
    login = '587763',
    case when login = '587763' then 'active' else 'pending' end
  )
  on conflict (user_id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Helper functions (security definer so policies can use them safely)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select is_admin from public.profiles where user_id = auth.uid()), false);
$$;

create or replace function public.is_active_linked()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select status = 'active' and athlete_id is not null
                   from public.profiles where user_id = auth.uid()), false);
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Proposals — the pending-change queue AND the history of verified changes
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.proposals (
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
-- 4. Row Level Security
-- ───────────────────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.proposals enable row level security;
alter table public.athletes enable row level security;

-- profiles: signed-in users can read the roster (login + link + role); only admins write.
drop policy if exists "profiles readable by authenticated" on public.profiles;
create policy "profiles readable by authenticated"
  on public.profiles for select to authenticated using (true);
drop policy if exists "admins manage profiles" on public.profiles;
create policy "admins manage profiles"
  on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- (inserts happen only via the signup trigger; no insert policy)

-- proposals: signed-in users can read the queue/history; all writes go through the
-- propose()/decide() functions below (no direct insert/update policies).
drop policy if exists "proposals readable by authenticated" on public.proposals;
create policy "proposals readable by authenticated"
  on public.proposals for select to authenticated using (true);

-- athletes: public read; only admins write DIRECTLY. Everyone else changes athletes
-- through the verified/approved proposal flow (decide() runs as definer).
drop policy if exists "Public read access" on public.athletes;
create policy "Public read access" on public.athletes for select using (true);
drop policy if exists "admins write athletes" on public.athletes;
create policy "admins insert athletes" on public.athletes
  for insert to authenticated with check (public.is_admin());
create policy "admins update athletes" on public.athletes
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins delete athletes" on public.athletes
  for delete to authenticated using (public.is_admin());

-- ───────────────────────────────────────────────────────────────────────────
-- 5. propose() / decide() — the governed write paths
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
  else
    raise exception 'unknown proposal kind: %', p_kind;
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
    update public.athletes set
      bench    = case when pr.payload->>'lift'='bench'    then (pr.payload->>'value')::numeric else bench end,
      squat    = case when pr.payload->>'lift'='squat'    then (pr.payload->>'value')::numeric else squat end,
      deadlift = case when pr.payload->>'lift'='deadlift' then (pr.payload->>'value')::numeric else deadlift end
    where id = pr.athlete_id;
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
-- 6. Realtime + backfill existing users (so the live admin exists immediately)
-- ───────────────────────────────────────────────────────────────────────────
do $$ begin
  alter publication supabase_realtime add table public.proposals;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null; end $$;

insert into public.profiles (user_id, github_login, display_name, is_admin, status)
select u.id,
       u.raw_user_meta_data->>'user_name',
       coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'user_name'),
       (u.raw_user_meta_data->>'user_name') = '587763',
       case when (u.raw_user_meta_data->>'user_name') = '587763' then 'active' else 'pending' end
from auth.users u
on conflict (user_id) do nothing;
