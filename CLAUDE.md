# CLAUDE.md — agent guide: digdir-gym-leaderboard

Office gym leaderboard (squat/bench/deadlift PRs + total, podium, achievements).
Buildless static site + Supabase. Predominantly AI-maintained.
Live: https://587763.github.io/digdir-gym-leaderboard/ · Repo: `587763/digdir-gym-leaderboard` (origin)

## Non-negotiables
- No build step, no backend, no framework, no npm runtime deps. Repo root deploys to
  Pages as-is. `supabase-js` is a CDN `<script>` (global `window.supabase`).
- Vanilla JS. Script load order in index.html: config → achievements → lifts → avatar → store → app.
  Intentional globals: `LEADERBOARD_CONFIG`, `ACHIEVEMENTS`, `OTHER_LIFTS`/`getOtherLift`/`formatLiftTime`,
  `renderAvatar`, `Store`, `app`.
- Authorization is enforced in Postgres (RLS + functions), never the client. UI gating is cosmetic.

## After any change (keep it lean)
Sweep before finishing: remove dead code/files, fix/remove stale references, and update
this file + README in the same change. Don't add docs/comments that restate the obvious.
Then verify (below). Keep this file dense — facts agents need, nothing else.

## Repo map
```
index.html           markup + script load order
styles.css           whiteboard theme (Permanent Marker/Caveat fonts; #roughen/#squiggle SVG filters)
js/config.js         Supabase URL + publishable key (safe to commit)
js/store.js          ALL Supabase access (data/auth/realtime/RPCs); UI never calls Supabase directly
js/app.js            UI controller (class LeaderboardApp, global `app`)
js/avatar.js         renderAvatar(athlete, size) — stick figure from name
js/achievements.js   ACHIEVEMENTS registry (extensible)
js/lifts.js          OTHER_LIFTS registry (extra non-main lifts: id/label/emoji/unit kg|time) + time fmt
supabase/schema.sql  canonical fresh-install DB (tables + RLS + functions + seed)
supabase/migrations/ hand-applied SQL for the live DB (0001 SUPERSEDED; 0002 = governance; 0003 = other lifts; 0004 = public PR history)
.github/workflows/deploy.yml  Pages deploy on push to main
.github/workflows/backup.yml  daily DB dump → 90-day artifact (needs SUPABASE_DB_URL secret)
.claude/launch.json  preview server "leaderboard"
```

## Data model
- `athletes` — board (verified/displayed): name, bench/squat/deadlift (fixed main-lift columns, kg),
  lifts jsonb (`{lift_id: value}` map for "other lifts" — see js/lifts.js, no per-lift column),
  achievements text[], avatar jsonb (reserved), timestamps.
- `profiles` — per GitHub user: user_id, github_login, is_admin, status (pending|active|blocked), athlete_id (unique link).
- `proposals` — pending queue + verified history: kind (claim|new_athlete|rename|pr|achievement), approval (admin|peer), athlete_id, proposer, payload jsonb, status, decided_by, decided_at.
  - Approved `pr` rows ARE the progression history. Tapping an athlete name opens the history
    modal (`app.openHistory`): `Store.listAthleteHistory` fetches approved `pr` proposals
    ordered by `decided_at`, grouped per lift, drawn as a hand-rolled inline SVG sparkline
    (`app.sparkline`, no chart lib; time lifts shown mm:ss). Public read: migration 0004
    adds an RLS policy exposing approved `pr` proposals to anon (the rest of the table
    stays member-only), so progression works for signed-out visitors too.

## Governance (RLS + propose()/decide() SECURITY DEFINER functions)
- Read: public. Admin (`is_admin`): writes athletes directly, decides admin-proposals, manages profiles.
- Everyone else changes the board only via proposals applied by `decide()`:
  - pr / achievement → peer: a *different* active+linked member (or admin) verifies; approval updates the athlete; the row is the PR history.
  - rename / new_athlete / claim → admin; approving claim/new_athlete links the proposer (status=active).
- GitHub is login/identity only — there is no GitHub-org check (an org-gating attempt was
  abandoned: the org restricts OAuth apps). Don't reintroduce one.
- Bootstrap admin = GitHub login `587763`, set in `handle_new_user()` (schema.sql + migration 0002).
  Promote others via the in-app Members panel.

## Run & verify
```
npm run dev   # localhost:3000 (or python3 -m http.server 3000)
```
Done = loads in a browser, no console errors. Use the preview tooling (server `leaderboard`)
to screenshot + read logs. Unfilled config.js → "not connected" banner, not a crash.
Mock without a DB: `app.athletes=[...]; app.render()`.

## TV / display mode
Opt-in big-screen view for the office TV: full-width landscape layout (no page scroll, rem
fonts scaled up) + hands-free tab cycling. Enable with `?tv` (set-and-forget for the TV
browser) or the 📺 button in the header; `?rotate=<seconds>` overrides the 15s interval.
- CSS-driven: the `TV / display mode` block in styles.css keys off `html.tv-mode`
  (3-col Main Lifts with a podium per board, centered Total, capped+centered Other Lifts &
  Hall of Fame, hidden controls/auth/hints). `renderLeaderboard` shows a podium for every
  board when `app.tvMode` (not just the focused one). Layout clips, never scrolls — tuned
  for 1080p; a top-N row cap is the future move if the roster outgrows the screen.
- Logic on `LeaderboardApp`: `applyTvMode`/`toggleTvMode`/`startRotation`/`stopRotation`/
  `advanceTab`/`rotationTabs`; state from the URL + `localStorage['lb.tv']`. Rotation
  pauses via `visibilitychange` while the browser tab is hidden and resumes where it left
  off (the TV cycles several pages); it skips a tick while a modal is open. Toggling syncs
  the `?tv` URL param + localStorage. A `--rotate-ms` CSS var drives the countdown bar.

## Branches, PRs & deploy
- Commit/push only when the user asks — and never straight to `main`. Work on a branch
  (e.g. `fix/…`, `feat/…`), then open a PR with `env -u GH_TOKEN gh pr create` (GH_TOKEN is
  read-only — see Gotchas).
- Write the PR description for a human: clear and concise — what changed and why, not a
  restatement of the diff. Don't attach screenshots — `gh` can't upload images from the CLI;
  the user adds any PR visuals. (Still screenshot to *verify* GUI changes — see Run & verify.)
- Merging the PR to `main` → Pages workflow auto-deploys (~1 min).

## Backups (free-tier has none)
`.github/workflows/backup.yml` runs daily (cron 03:17 UTC) + on manual dispatch: `pg_dump`s
`public.{athletes,profiles,proposals}` and uploads a gzipped `.sql` as a 90-day workflow artifact.
Dumps are NEVER committed (public repo). Requires repo secret **`SUPABASE_DB_URL`** (full Postgres
URI, Supabase → Project Settings → Database → Connection string) — a human adds it under
Settings → Secrets and variables → Actions; the run errors with a clear message until it's set.
Restore: download the artifact, `gunzip`, then `psql "<target-db-url>" -f leaderboard-backup-*.sql`
(into a fresh project; the dump has no owner/privilege statements).

## Supabase / secrets
- `js/config.js` = project URL + **publishable** key (`sb_publishable_…`), safe to commit (RLS protects).
  NEVER commit the `sb_secret_…`/service_role key.
- Project ref `hqrqmkherwdkfvhjypuk`. Data-model change = edit schema.sql AND add a numbered migration file.
- Applying a migration to the live DB (when you judge the change safe):
  - **DB URL**: lives in `.env` at the repo root (gitignored). Format is `SUPABASE_DB_URL = postgres…`
    **with spaces around `=`**, so `source .env` / `. ./.env` FAILS (`command not found: SUPABASE_DB_URL`).
    Parse it instead:
    `DBURL=$(grep -E '^[[:space:]]*SUPABASE_DB_URL[[:space:]]*=' .env | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//')`.
    Never echo the value. (Also available as the same-named GitHub Actions secret.)
  - **Tool**: there is NO local `psql`/`pg_dump`. Use the installed `supabase` CLI's direct-query path,
    which bypasses the migration ledger: `supabase db query --db-url "$DBURL" -f supabase/migrations/000N_*.sql`.
    Do NOT use `supabase db push` — our hand-numbered files aren't in the CLI ledger, so it would replay
    the superseded 0001.
  - **Gotcha**: `db query -f <file>` sends the whole file as ONE prepared statement → fails with
    `cannot insert multiple commands into a prepared statement` if the file has >1 statement. For a
    multi-statement migration, run each statement as its own `supabase db query "<sql>"` call
    (or wrap the body in a single `do $$ … $$;` block).
  - Migrations are written idempotent (`if [not] exists`, or `drop policy if exists` before `create policy`),
    so re-running is safe. If you have no DB creds (e.g. a sandboxed run), tell the user to paste the file
    into the Supabase SQL editor at deploy time — that's the correct fallback, not a failure.
- New serving origin → add it in Supabase → Auth → URL Configuration (Site URL + Redirect URLs
  `https://…/**`) or sign-in breaks. Currently allows localhost:3000 + the Pages URL.
- supabase-js is pinned + SRI'd in index.html. Upgrade: bump version, recompute
  `curl -sL <…/dist/umd/supabase.js> | openssl dgst -sha384 -binary | openssl base64 -A`,
  update both attrs. Don't use the bare `@2` URL (CDN-minified → breaks SRI).

## Gotchas
- Live DB is production — test with a throwaway athlete and clean up; don't bulk-delete real ones.
- `gh`: env sets a read-only `GH_TOKEN` that overrides the user's token. Prefix write ops with
  `env -u GH_TOKEN` (keyring token has repo+workflow).
- Escape user input: `app.escapeHtml` (element text) / `escapeAttr` in avatar.js (attributes).
- `app.athletes` is empty for a beat after load; don't assert synchronously.
- Realtime fires `app.refreshAll()` (re-fetches own profile too, so approvals apply live).

## Common tasks
- Add achievement: one entry in `js/achievements.js` (form, badges, Hall of Fame all read `ACHIEVEMENTS`).
- Add an "other lift" (the easy path, e.g. a time-based one): one entry in `js/lifts.js` — the
  Other-Lifts tab section, the My-PRs + admin form fields, and the `decide()` jsonb branch all
  handle it generically. No DB or schema change (value lives in the `lifts` jsonb map; `unit:'time'`
  stores seconds, displays mm:ss, longer ranks higher).
- Add a *main* lift (new fixed column): DB (athletes column in schema.sql + migration; `decide()` pr
  branch) and frontend (`LIFTS`/`LIFT_META`, admin + My-PRs form in index.html + logic, a leaderboard section).
- Restyle: `styles.css`; keep the whiteboard look.
