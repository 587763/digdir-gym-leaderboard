-- The gym planner: members post when they plan to train and what (a plan), and others say
-- they will join and when they will come. Only members on the board (active and linked to an athlete) and admins can
-- see plans, since they tell when someone will be at the gym; signed-out visitors and the
-- TV see only the Friday lift rotation, which needs no data. Writes go through save_plan(),
-- delete_plan() and join_plan(). Deleting a member's account removes their plans and joins.
-- Existing athletes, profiles and history are preserved; no rows are rewritten.
-- Apply after 0009 as one transaction. Safe to re-run.
begin;

-- Who may see and use the planner: an unblocked admin, or an active member linked to an athlete.
create or replace function public.can_plan()
returns boolean language sql security definer stable set search_path = public as $$
  select public.is_admin() or public.is_active_linked();
$$;

create table if not exists public.plans (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references public.profiles(user_id) on delete cascade,
  starts_at  timestamptz not null,
  activity   text not null check (length(activity) between 1 and 60),
  note       text check (length(note) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists plans_starts_at on public.plans(starts_at);

create table if not exists public.plan_joins (
  plan_id    uuid not null references public.plans(id) on delete cascade,
  user_id    uuid not null references public.profiles(user_id) on delete cascade,
  arrives_at timestamptz not null,  -- when they come; people drop in at different times
  created_at timestamptz not null default now(),
  primary key (plan_id, user_id)
);
create index if not exists plan_joins_user on public.plan_joins(user_id);

-- Members read plans; nobody writes them directly (no write policies), only through the functions.
alter table public.plans enable row level security;
alter table public.plan_joins enable row level security;
drop policy if exists "members read plans" on public.plans;
create policy "members read plans" on public.plans for select to authenticated using (public.can_plan());
drop policy if exists "members read plan joins" on public.plan_joins;
create policy "members read plan joins" on public.plan_joins for select to authenticated using (public.can_plan());

-- Create (p_id null) or change one of your own plans. A plan starts at most two hours ago
-- ("I'm at the gym now, come along") and at most 60 days ahead.
create or replace function public.save_plan(p_id uuid, p_starts_at timestamptz, p_activity text, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles; plan public.plans; what text := btrim(p_activity);
  remark text := nullif(btrim(p_note), ''); new_id uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  -- Serializes one member's saves, including double clicks and request retries.
  select * into prof from public.profiles where user_id = uid for update;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  if not coalesce(prof.is_admin or (prof.status = 'active' and prof.athlete_id is not null), false) then
    raise exception 'claim your spot on the board before planning sessions';
  end if;
  if what is null or length(what) not between 1 and 60 then
    raise exception 'say what you will do in 1 to 60 characters';
  end if;
  if length(remark) > 200 then raise exception 'notes have at most 200 characters'; end if;
  if p_starts_at is null or p_starts_at < now() - interval '2 hours' then
    raise exception 'that time has passed; pick a time from now on';
  end if;
  if p_starts_at > now() + interval '60 days' then raise exception 'plans can be at most 60 days ahead'; end if;

  if p_id is null then
    select id into new_id from public.plans
      where owner = uid and starts_at = p_starts_at and activity = what and note is not distinct from remark limit 1;
    if found then return new_id; end if;
    if (select count(*) from public.plans where owner = uid and starts_at > now()) >= 20 then
      raise exception 'you already have 20 upcoming plans';
    end if;
    insert into public.plans(owner, starts_at, activity, note) values (uid, p_starts_at, what, remark)
      returning id into new_id;
    return new_id;
  end if;

  select * into plan from public.plans where id = p_id for update;
  if not found then raise exception 'plan not found'; end if;
  if plan.owner <> uid then raise exception 'you can only change your own plans'; end if;
  update public.plans set starts_at = p_starts_at, activity = what, note = remark, updated_at = now() where id = p_id;
  -- Moving a session moves everyone's arrival with it.
  update public.plan_joins set arrives_at = arrives_at + (p_starts_at - plan.starts_at) where plan_id = p_id;
  return p_id;
end; $$;

-- The owner removes their plan, or an admin removes anyone's. Its joins go with it.
create or replace function public.delete_plan(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles; plan public.plans;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  select * into plan from public.plans where id = p_id for update;
  if not found then raise exception 'plan not found or already removed'; end if;
  if plan.owner <> uid and not coalesce(prof.is_admin, false) then
    raise exception 'you can only remove your own plans';
  end if;
  delete from public.plans where id = p_id;
end; $$;

-- Join (p_join true) someone else's plan, coming at p_arrives_at (null: at its start) within six
-- hours of its start, or change that time; or leave it. Joining closes two hours after the start.
create or replace function public.join_plan(p_id uuid, p_join boolean, p_arrives_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles; plan public.plans; arrival timestamptz;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  if not coalesce(prof.is_admin or (prof.status = 'active' and prof.athlete_id is not null), false) then
    raise exception 'claim your spot on the board before joining sessions';
  end if;
  if p_join is null then raise exception 'join must be true or false'; end if;
  select * into plan from public.plans where id = p_id for share;
  if not found then raise exception 'plan not found or already removed'; end if;
  if not p_join then
    delete from public.plan_joins where plan_id = p_id and user_id = uid;
    return;
  end if;
  if plan.owner = uid then raise exception 'this is your own plan'; end if;
  if plan.starts_at < now() - interval '2 hours' then raise exception 'this session is over'; end if;
  arrival := coalesce(p_arrives_at, plan.starts_at);
  if arrival not between plan.starts_at - interval '6 hours' and plan.starts_at + interval '6 hours' then
    raise exception 'pick a time within six hours of the session''s start';
  end if;
  insert into public.plan_joins(plan_id, user_id, arrives_at) values (p_id, uid, arrival)
    on conflict (plan_id, user_id) do update set arrives_at = excluded.arrives_at;
end; $$;

-- Live updates for members watching the planner.
do $$
declare t text;
begin
  foreach t in array array['plans', 'plan_joins'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

commit;
