-- 0012: hardening after the November 2026 review. Function bodies only: no table, column,
-- policy or row changes, and the frontend works with or without it. Idempotent; run it in the
-- SQL Editor or with `supabase db query --linked -f` (see CLAUDE.md).
--
--   handle_new_user()  Only GitHub vouches for a login and a name. A sign-up through another
--                      Auth provider (the email provider is on by default) sent its own
--                      metadata, and its profile showed whatever login it claimed. The
--                      bootstrap admin now applies only while there is no admin.
--   propose()          At most 30 pending requests per account, so nobody floods the queue.
--   decide()           Locks the proposer's profile "for no key update": two members verifying
--                      each other's requests at the same instant could deadlock on the
--                      foreign-key check of decided_by. Drops a check that could not fail.
--   save_plan()        The 20-plan limit counts sessions still open (starting them "now" got
--                      around it). A session that is over can't be changed (moving one into
--                      the future took its joiners along). Arrivals move by exact seconds.
--   join_plan(), join_friday()
--                      Leaving needs no spot on the board, so someone unlinked after joining
--                      can step out. The 60-day Friday limit gets the same day of slack ahead
--                      as behind (it failed early on Mondays, when UTC is still on Sunday).
begin;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare github boolean := coalesce(new.raw_app_meta_data->>'provider' = 'github', false); login text; first_admin boolean;
begin
  if github then
    login := coalesce(new.raw_user_meta_data->>'user_name', new.raw_user_meta_data->>'preferred_username');
  end if;
  first_admin := coalesce(login = '587763', false) and not exists (select 1 from public.profiles where is_admin);
  insert into public.profiles (user_id, github_login, display_name, is_admin, status)
  values (new.id, login, case when github then coalesce(new.raw_user_meta_data->>'full_name', login) end,
          first_admin, case when first_admin then 'active' else 'pending' end)
  on conflict (user_id) do nothing;
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
  -- One My PRs form sends about ten requests; the cap keeps an account from flooding the queue.
  if (select count(*) from public.proposals where proposer = uid and status = 'pending') >= 30 then
    raise exception 'you already have 30 requests waiting; wait for a review or withdraw some';
  end if;
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
  -- "No key" still serializes changes to the proposer's link and status, without blocking the
  -- foreign-key checks of another decision (two members verifying each other could deadlock).
  select * into proposer_profile from public.profiles where user_id = pr.proposer for no key update;
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
    update public.profiles set athlete_id = new_ath, status='active' where user_id = pr.proposer;
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
    -- Sessions still open count too, so starting them just now is no way around the limit.
    if (select count(*) from public.plans where owner = uid and starts_at > now() - interval '2 hours') >= 20 then
      raise exception 'you already have 20 upcoming plans';
    end if;
    insert into public.plans(owner, starts_at, activity, note) values (uid, p_starts_at, what, remark)
      returning id into new_id;
    return new_id;
  end if;

  select * into plan from public.plans where id = p_id for update;
  if not found then raise exception 'plan not found'; end if;
  if plan.owner <> uid then raise exception 'you can only change your own plans'; end if;
  -- It stays where it was, with the people who came; otherwise they would move with it.
  if plan.starts_at < now() - interval '2 hours' then raise exception 'this session is over; plan a new one'; end if;
  update public.plans set starts_at = p_starts_at, activity = what, note = remark, updated_at = now() where id = p_id;
  -- Moving a session moves everyone's arrival with it, by the seconds between the two starts
  -- (an interval in days would shift people across a daylight saving change outside UTC).
  update public.plan_joins set arrives_at = arrives_at + make_interval(secs => extract(epoch from p_starts_at - plan.starts_at))
    where plan_id = p_id;
  return p_id;
end; $$;

create or replace function public.join_plan(p_id uuid, p_join boolean, p_arrives_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles; plan public.plans; arrival timestamptz;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  if p_join is null then raise exception 'join must be true or false'; end if;
  if not p_join then
    delete from public.plan_joins where plan_id = p_id and user_id = uid;
    return;
  end if;
  if not coalesce(prof.is_admin or (prof.status = 'active' and prof.athlete_id is not null), false) then
    raise exception 'claim your spot on the board before joining sessions';
  end if;
  select * into plan from public.plans where id = p_id for share;
  if not found then raise exception 'plan not found or already removed'; end if;
  if plan.owner = uid then raise exception 'this is your own plan'; end if;
  if plan.starts_at < now() - interval '2 hours' then raise exception 'this session is over'; end if;
  arrival := coalesce(p_arrives_at, plan.starts_at);
  if arrival not between plan.starts_at - interval '6 hours' and plan.starts_at + interval '6 hours' then
    raise exception 'pick a time within six hours of the session''s start';
  end if;
  insert into public.plan_joins(plan_id, user_id, arrives_at) values (p_id, uid, arrival)
    on conflict (plan_id, user_id) do update set arrives_at = excluded.arrives_at;
end; $$;

create or replace function public.join_friday(p_day date, p_join boolean, p_arrives_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); prof public.profiles;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into prof from public.profiles where user_id = uid;
  if not found then raise exception 'no profile'; end if;
  if prof.status = 'blocked' then raise exception 'your account is blocked'; end if;
  if p_join is null then raise exception 'join must be true or false'; end if;
  if p_day is null or extract(isodow from p_day) <> 5 then raise exception 'pick a Friday'; end if;
  if not p_join then
    delete from public.friday_joins where day = p_day and user_id = uid;
    return;
  end if;
  if not coalesce(prof.is_admin or (prof.status = 'active' and prof.athlete_id is not null), false) then
    raise exception 'claim your spot on the board before joining sessions';
  end if;
  if p_day < current_date - 1 then raise exception 'that Friday has passed'; end if;
  if p_day > current_date + 61 then raise exception 'Fridays can be joined at most 60 days ahead'; end if;
  if p_arrives_at is null or p_arrives_at not between p_day::timestamptz - interval '1 day'
                                                  and p_day::timestamptz + interval '2 days' then
    raise exception 'pick a time on that Friday';
  end if;
  insert into public.friday_joins(day, user_id, arrives_at) values (p_day, uid, p_arrives_at)
    on conflict (day, user_id) do update set arrives_at = excluded.arrives_at;
end; $$;

commit;
