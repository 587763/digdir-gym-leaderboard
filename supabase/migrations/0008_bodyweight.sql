-- Opt-in bodyweight for the ⚖️ Bodyweight boards, which rank kilograms lifted per kilogram of
-- bodyweight. A linked member shares, changes or clears their own bodyweight at once, without
-- review: it is their personal data, and clearing it leaves no copy in the request history.
-- Admins correct or clear it with an ordinary update. Like the rest of the board it is public
-- (a ratio next to a public lift reveals it anyway). Null keeps an athlete off those boards.
-- Existing athletes, profiles and history are preserved; no rows are rewritten.
-- Apply after 0007 as one transaction. Safe to re-run.
begin;

alter table public.athletes add column if not exists bodyweight numeric(4,1)
  check (bodyweight between 30 and 300);

-- A member linked to an athlete sets their own bodyweight, or clears it with null.
create or replace function public.set_my_bodyweight(p_bodyweight numeric)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  if prof.athlete_id is null then raise exception 'you are not linked to an athlete'; end if;
  if p_bodyweight not between 30 and 300 or p_bodyweight <> round(p_bodyweight, 1) then
    raise exception 'bodyweight must be between 30 and 300 kg, with at most one decimal';
  end if;
  update public.athletes set bodyweight = p_bodyweight where id = prof.athlete_id;
end; $$;

commit;
