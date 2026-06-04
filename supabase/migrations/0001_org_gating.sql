-- Org-gating: only verified `felleslosninger` members can write.
-- Apply to the existing live DB by pasting into Supabase → SQL Editor → Run.
-- (Idempotent-ish: safe to re-run.)

-- Verified editors. Rows are created ONLY by the verify-editor Edge Function
-- (service role); nothing else can write to this table.
create table if not exists public.editors (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  github_login text,
  verified_at  timestamptz not null default now()
);

alter table public.editors enable row level security;

-- A user may read their own editor row, so the UI knows their status on return
-- visits (when the GitHub provider token is no longer available to re-verify).
drop policy if exists "read own editor row" on public.editors;
create policy "read own editor row" on public.editors
  for select to authenticated using (user_id = auth.uid());
-- No insert/update/delete policies => only the service role can modify editors.

-- Swap the old "any authenticated user" write policies for editor-gated ones.
drop policy if exists "Authenticated can insert" on public.athletes;
drop policy if exists "Authenticated can update" on public.athletes;
drop policy if exists "Authenticated can delete" on public.athletes;

drop policy if exists "Editors can insert" on public.athletes;
drop policy if exists "Editors can update" on public.athletes;
drop policy if exists "Editors can delete" on public.athletes;

create policy "Editors can insert" on public.athletes
  for insert to authenticated
  with check (exists (select 1 from public.editors e where e.user_id = auth.uid()));

create policy "Editors can update" on public.athletes
  for update to authenticated
  using      (exists (select 1 from public.editors e where e.user_id = auth.uid()))
  with check (exists (select 1 from public.editors e where e.user_id = auth.uid()));

create policy "Editors can delete" on public.athletes
  for delete to authenticated
  using (exists (select 1 from public.editors e where e.user_id = auth.uid()));
