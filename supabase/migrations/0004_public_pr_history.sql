-- Public progression history: let ANYONE read approved PR proposals, so the
-- per-athlete progression charts work for signed-out visitors (the board itself
-- is already public). Scope is deliberately narrow — only status='approved' AND
-- kind='pr'. Pending/rejected proposals and all other kinds (claim/rename/
-- new_athlete/achievement) stay hidden from anon.
--
-- RLS ORs permissive SELECT policies, so the existing authenticated-all policy is
-- untouched: members still see every proposal; anon sees only approved PRs.
-- Apply to the live DB by pasting into Supabase → SQL Editor → Run. Safe to re-run.

drop policy if exists "approved PRs are public history" on public.proposals;
create policy "approved PRs are public history" on public.proposals
  for select using (status = 'approved' and kind = 'pr');
