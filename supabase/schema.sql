-- Digdir Gym Leaderboard — database schema
-- Paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- Safe to re-run: it drops and recreates the table.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
drop table if exists public.athletes cascade;

create table public.athletes (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  bench        numeric(6,1) not null default 0 check (bench    >= 0),
  squat        numeric(6,1) not null default 0 check (squat    >= 0),
  deadlift     numeric(6,1) not null default 0 check (deadlift >= 0),
  -- Earned achievement ids (extensible — add new ones in js/achievements.js).
  achievements text[] not null default '{}',
  -- Reserved for the future avatar customizer; ignored for now.
  avatar       jsonb not null default '{}'::jsonb,
  -- Who last touched this row (GitHub login), for a light audit trail.
  updated_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Keep updated_at fresh on every write.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger athletes_touch_updated_at
  before update on public.athletes
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--   • anyone (even signed-out) can READ the board
--   • only signed-in (GitHub) users can add / edit / delete
-- ---------------------------------------------------------------------------
alter table public.athletes enable row level security;

create policy "Public read access"
  on public.athletes for select
  using (true);

create policy "Authenticated can insert"
  on public.athletes for insert to authenticated
  with check (true);

create policy "Authenticated can update"
  on public.athletes for update to authenticated
  using (true) with check (true);

create policy "Authenticated can delete"
  on public.athletes for delete to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Realtime — push live changes to every open board (e.g. the gym wall screen)
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.athletes;

-- ---------------------------------------------------------------------------
-- Seed (the current whiteboard). Remove or edit freely.
-- ---------------------------------------------------------------------------
insert into public.athletes (name, bench, squat, deadlift, achievements) values
  ('Alexander', 132.5, 120.0, 137.5, '{gripper90kg}'),
  ('Daniel',    110.0, 137.5, 160.0, '{}'),
  ('Hallvard',  110.0,  80.0,  90.0, '{}'),
  ('Jens',      137.5,   0.0,   0.0, '{}');
