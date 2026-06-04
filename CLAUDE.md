# CLAUDE.md — agent guide for digdir-gym-leaderboard

Read this first. It's the contract for working in this repo. Keep it accurate: if
you change the architecture, conventions, or deploy flow, update this file in the
same change.

## What this is

A digital version of our office gym whiteboard: squat / bench / deadlift personal
records, a combined total, podiums, and a "Hall of Fame" for fun achievements.
Hand-drawn whiteboard aesthetic. Live-updating across everyone's screens.

- **Live:** https://587763.github.io/digdir-gym-leaderboard/
- **Repo:** `587763/digdir-gym-leaderboard` (remote `origin`)
- This project is predominantly AI-maintained. Optimize for the next agent:
  small, verified changes; keep this guide and the README current.

## Architecture (and the non-negotiables)

**Buildless static site + Supabase. There is no backend and no build step.**

- The browser talks to Supabase directly via the `@supabase/supabase-js` UMD bundle
  loaded from a CDN `<script>` (global `window.supabase`). **Do not add a bundler,
  framework, npm runtime deps, or a transpile step** unless explicitly asked — the
  whole point is that the repo root deploys to GitHub Pages as-is.
- Plain ES5/ES6 vanilla JS in `<script>` tags loaded in order (see `index.html`).
  Globals are intentional: `window.LEADERBOARD_CONFIG`, `window.ACHIEVEMENTS`,
  `window.renderAvatar`, `window.Store`, and `app`.
- Security model is **Row Level Security (RLS)** in Postgres, not client code:
  anyone can read; only signed-in (GitHub) users can write. Never rely on the
  client to enforce permissions.

### Why these choices (don't relitigate without reason)
- GitHub Pages can't run a server, so the original Express+JSON-file backend was
  removed. Supabase gives shared persistence + auth + realtime with zero servers.
- Auth = GitHub sign-in to edit. Hard-gating edits to the `felleslosninger` GitHub
  org was deliberately deferred (org OAuth-app restrictions + private membership
  make it unreliable; would need a Supabase Edge Function). See README "Future ideas".

## Repo map

```
index.html           markup; loads scripts in dependency order
styles.css           whiteboard theme (Permanent Marker / Caveat fonts, SVG roughen filter)
js/config.js         Supabase URL + publishable key (committed — safe, see below)
js/store.js          ALL Supabase access: data CRUD, auth, realtime. UI never calls Supabase directly.
js/app.js            UI controller (class LeaderboardApp, global `app`); rendering, modals, tabs
js/avatar.js         window.renderAvatar(athlete, size) — stick figure derived from name
js/achievements.js   window.ACHIEVEMENTS registry (extensible)
supabase/schema.sql  full DB state for a fresh install: tables + RLS + functions + seed
supabase/migrations/ incremental SQL to apply to the live DB (run manually in SQL editor)
.github/workflows/deploy.yml  Pages deploy on push to main
.claude/launch.json  preview server config (used by the preview tooling)
```

Data model (3 tables):
- `athletes` — the board: `id` (uuid), `name`, `bench`/`squat`/`deadlift` (numerics),
  `achievements` (text[] of achievement ids), `avatar` (jsonb, reserved), timestamps.
  These are the *verified/displayed* values.
- `profiles` — one per GitHub user: `user_id`, `github_login`, `is_admin`, `status`
  ('pending'|'active'|'blocked'), `athlete_id` (the linked athlete; unique).
- `proposals` — the pending-change queue AND the verified-change history: `kind`
  ('claim'|'new_athlete'|'rename'|'pr'|'achievement'), `approval` ('admin'|'peer'),
  `athlete_id`, `proposer`, `payload` (jsonb), `status`, `decided_by`, timestamps.

## Run & verify locally

```bash
npm run dev      # http://localhost:3000 via npx serve (no install). Or: python3 -m http.server 3000
```

**Definition of done for any UI/logic change:** load it in a browser and confirm it
renders and the browser console has **no errors**. Use the preview tooling
(`.claude/launch.json` defines a `leaderboard` server) to start the server,
screenshot, and read console logs. The app needs `js/config.js` filled in to load
real data; if it isn't, it shows a "not connected" banner instead of crashing.

To exercise render paths without a live DB, you can inject mock data in the page:
`app.athletes = [...]; document.body.classList.add('signed-in'); app.render();`

## Deploy

Push to `main` → the workflow publishes to GitHub Pages automatically.

```bash
git add -A && git commit -m "..."
git push          # origin/main → Pages → live in ~1 min
```

Follow the repo convention: only commit/push when the user asks. Pages was enabled
with build type `workflow`; the workflow self-enables it (`configure-pages` with
`enablement: true`).

## Supabase

- Schema lives in `supabase/schema.sql`. If you change the data model, update that
  file AND describe the migration (the live DB won't auto-migrate — a human runs SQL).
- `js/config.js` holds the **publishable** key (`sb_publishable_…`) and project URL.
  Both are **safe to commit publicly**: the publishable key is the browser/`anon`
  role and is fully constrained by RLS. **Never** put the `sb_secret_…`
  (service_role) key in the frontend or the repo — it bypasses RLS.
- Auth: GitHub OAuth via Supabase. Sign-in is required to write. New deploy origins
  must be added to Supabase → Authentication → URL Configuration (Site URL +
  Redirect URLs, e.g. `https://…/**`).

## Security model & hardening

- **Threat model:** an internal, trust-based office board. The data is not secret
  (it's a public leaderboard). The main thing we protect against is anonymous
  drive-by vandalism.
- **What's enforced (self-governance):** public read; all writes are governed by
  RLS + two SECURITY DEFINER functions, so the client can't bypass the rules:
  - **Admins** (`profiles.is_admin`) write `athletes` directly (RLS: `is_admin()`),
    decide admin-proposals, and manage `profiles` (approve/link/grant-admin/block).
  - **Everyone else** changes the board only through `proposals`, applied by the
    `decide()` function:
    - `pr` / `achievement` → `approval='peer'`: a *different* active+linked member (or
      an admin) verifies. On approve, `decide()` updates the athlete and the approved
      proposal row becomes the PR history.
    - `rename` / `new_athlete` / `claim` → `approval='admin'`: an admin approves.
      Approving a claim/new_athlete links the proposer (`status='active'`).
  - `propose(kind, athlete, payload)` enforces who may propose what; `decide(id, ok)`
    enforces who may approve and applies the effect. Both run as definer (bypass RLS),
    which is why direct table writes can stay locked to admins.
- **Bootstrap admin:** the signup trigger `handle_new_user()` (and the 0002 backfill)
  marks GitHub login **`587763`** as admin+active. Change that literal in
  `schema.sql` / the latest migration to change the first admin; everyone else is
  promoted via the in-app Members panel.
- **No external dependency:** governance is pure Postgres — no GitHub org, no Edge
  Function, no extra OAuth scopes. Rollout = run the migration SQL.
- **No secret key in the repo.** Only `sb_publishable_…` is committed. The
  `sb_secret_…` / service_role key bypasses RLS and must never appear in frontend
  code, config, or git history. (If one ever leaks, rotate it in the Supabase
  dashboard immediately.)
- **Third-party JS is pinned + SRI'd.** `index.html` loads an exact supabase-js
  version with a Subresource Integrity hash, so a tampered CDN response is rejected.
  To upgrade: change the version, recompute the hash from the same
  `/dist/umd/supabase.js` URL (`curl -sL <url> | openssl dgst -sha384 -binary |
  openssl base64 -A`), and update both attributes. Don't switch to the bare
  `@2`/unversioned URL — it's auto-minified by the CDN and breaks SRI.
- **Input handling:** athlete names are user-controlled. Always escape before
  inserting into HTML (`app.escapeHtml` for element text; `escapeAttr` in avatar.js
  for attributes). Lift values are coerced to non-negative numbers; the DB also has
  `check (… >= 0)` constraints.
- **GitHub Actions:** the deploy workflow runs only on push to `main` / manual
  dispatch (never on fork PRs) and uses least-privilege permissions. Keep it that way.

## Operational state (external services — not in the repo)

These live outside git; a fresh session can't see them. Current config:

- **Supabase project** ref `hqrqmkherwdkfvhjypuk` (URL in `js/config.js`). On the
  free tier. Created with Data API enabled, "automatically expose new tables" on, and
  "automatic RLS" on. Schema is `supabase/schema.sql` (run manually in the SQL editor
  for any model change — there is no migration runner).
- **Auth:** GitHub provider enabled in Supabase with "allow users without email" on.
  Backed by a **GitHub OAuth App** (owned by the user's account; Client ID + secret
  stored only in Supabase, never in the repo). The OAuth callback URL is the Supabase
  one: `https://hqrqmkherwdkfvhjypuk.supabase.co/auth/v1/callback`.
- **Auth URL allowlist** (Supabase → Authentication → URL Configuration) must include
  every origin the app is served from, or sign-in redirects fail. Currently: Site URL
  = the Pages URL; Redirect URLs = `http://localhost:3000/**` and
  `https://587763.github.io/digdir-gym-leaderboard/**`. **Add a new entry whenever you
  serve from a new origin** (custom domain, preview, etc.).
- **GitHub Pages** was enabled with build type `workflow`. On a brand-new repo the
  Actions integration token can't create the Pages site itself, so it was enabled once
  via `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow` using a token
  with `repo` scope. After that the workflow's `configure-pages` (`enablement: true`)
  manages it.
- **No Edge Functions / no special OAuth scopes.** Governance is pure Postgres
  (run the migration). Sign-in requests only the default scope. (An earlier
  `verify-editor` Edge Function was abandoned — if it's still deployed in the
  Supabase dashboard, it's unused and can be deleted.)
- **Migrations are applied by hand:** paste each new file in `supabase/migrations/`
  into the SQL editor in order. There's no automated migration runner. `0001` set up
  org-gating (since removed); `0002` installed the current self-governance model.
- **Maintenance TODO:** the workflow's actions (`checkout@v4`, `configure-pages@v5`,
  `deploy-pages@v4`, `upload-pages-artifact@v3`) emit a Node 20 deprecation warning;
  bump them when convenient.

## Common tasks

- **Add an achievement:** append one entry to `js/achievements.js`. The edit form,
  badges, and Hall of Fame all read from `window.ACHIEVEMENTS` — no other code
  changes needed. The `id` is stored in `athletes.achievements[]`.
- **Add a lift:** touch `index.html` (form field + leaderboard section/table),
  `js/app.js` (`LIFTS`, `LIFT_META`, `formData`, value handling), and
  `supabase/schema.sql` (new column + a migration note). Total is computed from the
  three core lifts.
- **Restyle:** everything is in `styles.css`. Keep the whiteboard/hand-drawn feel
  (marker fonts, the `#roughen` / `#squiggle` SVG filters defined in `index.html`).

## Gotchas

- **The live Supabase DB is production.** Edits/deletes you make while testing affect
  the real gym board. Prefer adding a clearly-named test athlete and deleting it
  after, or point `js/config.js` at a separate dev Supabase project locally (don't
  commit that). Don't bulk-delete real athletes.
- **GitHub CLI on this machine:** the environment sets `GH_TOKEN` to a *read-only*
  PAT, which overrides the user's full token. For write operations (create repo,
  push via gh, enable Pages, rerun workflows) prefix with `env -u GH_TOKEN` so `gh`
  falls back to the keyring token (scopes: repo, workflow). Read-only `gh` calls work
  either way.
- **Realtime/load timing:** `app.athletes` is empty for a moment right after load
  until the first fetch resolves; don't assert on it synchronously.
- Keep script load order in `index.html`: config → achievements → avatar → store → app.
