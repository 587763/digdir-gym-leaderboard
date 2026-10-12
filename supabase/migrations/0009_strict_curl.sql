-- Strict Curl joins Other Lifts as a weight in kilograms, so it takes one decimal (42.5 kg)
-- like the main lifts instead of the whole numbers of repetitions and seconds.
-- Existing athletes, profiles and history are preserved; no rows are rewritten.
-- Apply after 0008 as one transaction. Safe to re-run.
begin;

-- Whether a lift takes one decimal (kg) instead of whole repetitions or seconds.
-- Keep aligned with js/lifts.js: list each extra exercise whose unit is 'kg', changing
-- the list in a new migration. A test fails until both agree.
create or replace function public.lift_allows_decimals(p_lift text)
returns boolean language sql immutable set search_path = public as $$
  -- The main lifts, then each extra exercise whose unit is 'kg'.
  select coalesce(p_lift in ('squat','bench','deadlift','strictcurl'), false);
$$;

commit;
