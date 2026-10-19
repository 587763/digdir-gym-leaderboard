-- Join the Friday lift: members say they will come to a Friday's rotation session and when,
-- like joining a planned session. The rotation itself is computed by the app and stored
-- nowhere, so a join names its Friday by date. Members on the board and admins read the
-- joins (as plans); join_friday() is the only write path. Deleting a member's account
-- removes their joins.
-- Existing athletes, profiles, plans and history are preserved; no rows are rewritten.
-- Apply after 0010 as one transaction. Safe to re-run.
begin;

create table if not exists public.friday_joins (
  day        date not null check (extract(isodow from day) = 5),  -- a Friday
  user_id    uuid not null references public.profiles(user_id) on delete cascade,
  arrives_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (day, user_id)
);
create index if not exists friday_joins_user on public.friday_joins(user_id);

alter table public.friday_joins enable row level security;
drop policy if exists "members read friday joins" on public.friday_joins;
create policy "members read friday joins" on public.friday_joins for select to authenticated using (public.can_plan());

-- Join (p_join true) a Friday's lift, coming at p_arrives_at on that Friday, or change that
-- time; or leave it. Fridays take joins from today up to 60 days ahead. The app checks the
-- local day; this allows a day's slack either side, since the database runs in UTC.
create or replace function public.join_friday(p_day date, p_join boolean, p_arrives_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  if not coalesce(prof.is_admin or (prof.status = 'active' and prof.athlete_id is not null), false) then
    raise exception 'claim your spot on the board before joining sessions';
  end if;
  if p_join is null then raise exception 'join must be true or false'; end if;
  if p_day is null or extract(isodow from p_day) <> 5 then raise exception 'pick a Friday'; end if;
  if not p_join then
    delete from public.friday_joins where day = p_day and user_id = uid;
    return;
  end if;
  if p_day < current_date - 1 then raise exception 'that Friday has passed'; end if;
  if p_day > current_date + 60 then raise exception 'Fridays can be joined at most 60 days ahead'; end if;
  if p_arrives_at is null or p_arrives_at not between p_day::timestamptz - interval '1 day'
                                                  and p_day::timestamptz + interval '2 days' then
    raise exception 'pick a time on that Friday';
  end if;
  insert into public.friday_joins(day, user_id, arrives_at) values (p_day, uid, p_arrives_at)
    on conflict (day, user_id) do update set arrives_at = excluded.arrives_at;
end; $$;

-- Live updates for members watching the planner.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friday_joins') then
    alter publication supabase_realtime add table public.friday_joins;
  end if;
end $$;

commit;
