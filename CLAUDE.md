# CLAUDE.md — agent guide: digdir-gym-leaderboard

Office gym leaderboard: public PRs, podiums, peer verification, achievements and progression.
Live: https://587763.github.io/digdir-gym-leaderboard/ · Origin: `587763/digdir-gym-leaderboard`.

## Non-negotiables
- Buildless static site; no backend, framework or npm runtime dependencies. Supabase is a
  pinned CDN script with SRI. Node and dev dependencies are only for local tooling/tests.
- Script order: config → achievements → lifts → avatar → store → history → app.
  Public globals: `LEADERBOARD_CONFIG`, `ACHIEVEMENTS`/`getAchievement`, `OTHER_LIFTS`/
  `getOtherLift`/`formatLiftTime`/`parseLiftTime`, `Lifts`, `renderAvatar`/`escapeAttr`,
  `Store`, `HistoryView`, `app`.
- All Supabase access belongs in `js/store.js`. Authorization belongs in Postgres RLS + RPCs;
  UI gating is cosmetic. Never reintroduce GitHub-org gating (the org restricts OAuth apps).
- After changes: remove dead code and stale references, update this guide and README, run
  relevant tests, then check the page in a browser with screenshots and console logs.
- Commit/push only when asked; never directly to main. Use a branch and PR. For GitHub writes,
  prefix `gh` with `env -u GH_TOKEN` (the environment token is read-only; keyring token can write).

## Files
- `index.html`: markup, accessible tabs/dialogs, CDN pin and local asset cache version (`?v=3.0.1`).
  Bump the local asset version together when deploying coordinated JS/CSS changes.
- `styles.css`: whiteboard theme, marker lettering, stick figures, responsive layout and TV rules.
- `js/lifts.js`: exercise registry and pure `Lifts` parsing/formatting/ranking. Numeric-string
  totals, competition ranks (1, 1, 3), zero/missing scores excluded. Invalid times return `NaN`.
- `js/avatar.js`: deterministic name-derived SVG figures; `escapeAttr` escapes text and attributes.
- `js/achievements.js`: achievement registry shared by forms and Hall of Fame.
- `js/store.js`: auth, reads, governed writes, admin writes and realtime. Errors propagate;
  admin writes select a row so RLS-denied no-ops cannot appear successful. Athlete edits
  compare the opening `updated_at` value to reject concurrent edits. Auth callbacks
  defer consumers with `setTimeout` to avoid re-entering Supabase's auth lock.
- `js/history.js`: pure `HistoryView` rendering; groups approved PRs, escapes labels, ignores
  invalid points and plots actual elapsed dates. Admin direct edits are not history.
- `js/app.js`: controller, serialized/coalesced refreshes, identity generation checks, forms,
  delegated `data-action` events, modal focus/inert management, board rendering and TV paging.
  Reconciles every 60s while visible and on browser online/focus; unchanged refreshes preserve
  rendered controls and open history. Linking a blocked profile preserves its blocked status.
  `app.ready` resolves after initialization; do not assert data synchronously on load.
- `supabase/schema.sql`: destructive fresh-install schema + seed. Never run against production.
- `supabase/migrations/`: hand-applied live upgrades. 0001 superseded; 0002 governance;
  0003 extra lifts; 0004 public history; 0005 validation, authorization and decision hardening.
- `scripts/dev-server.mjs`: Node static allowlist server, no caching, localhost only. Does not
  serve `.env`, `.git`, SQL or arbitrary workspace files. `PORT` overrides 3000.
- `tests/`: Node tests, LinkeDOM UI tests, PGlite Postgres/RLS tests, isolated browser fixtures.
- `.github/workflows/deploy.yml`: tests PRs and main; deploys main only after tests pass.
  Copies only public assets into the Pages artifact. No compilation/build step.
- `.github/workflows/backup.yml`: daily table dumps, 90-day workflow artifacts.
- `.claude/launch.json`: local preview server named `leaderboard`.

## Run and verify
```
npm run dev                 # Node >=22, http://localhost:3000; no install needed
npm ci                      # development-only test dependencies
npm test                    # no credentials, external DB or browser needed
```
Browser checks: desktop, 390px phone, TV at 1080p and 720p; tabs, progression, forms, errors,
keyboard focus/Escape, no console errors. Missing config/CDN leaves usable tabs and an
explanation instead of crashing. Refresh failures preserve the last board and expose Retry.

Local-only fixtures: `/?fixture=admin`, `empty`, `error`, `large` (65 athletes), or `layout`
(long medalist names and maximum scores). TV fixture labels do not consume board height.
The dev server replaces Store with `tests/browser-store.js` and removes the Supabase CDN
script. Writes stay in memory. Use `?fixture=large&tv&rotate=120` for TV layout inspection.
Fixture controls/data are never included in the deployed artifact.

## Data and governance
- `athletes`: name; fixed bench/squat/deadlift kg columns; `lifts` JSONB extra-exercise map;
  achievements text array; reserved avatar JSONB; timestamps.
- `profiles`: GitHub identity, is_admin, status (pending/active/blocked), unique athlete link.
- `proposals`: claim/new_athlete/rename/pr/achievement, admin/peer approval, payload, proposer,
  pending/approved/rejected status and decision timestamps. Approved PRs are public history;
  remaining proposals and profiles are member-readable.
- Active linked members propose changes to their own athlete. Another linked member or an
  admin verifies PRs/achievements; admins can resolve their own requests. Claims, new athletes
  and renames need an admin. Blocked accounts have no write authority, even if is_admin is true.
- `propose()` validates payloads and serializes per-user submissions to deduplicate pending
  retries. PR payloads include a server-owned `previous_value`. `decide()` locks the proposal,
  rechecks the proposer's current eligibility and rejects stale PRs after a record changes.
  Old proposals without `previous_value` remain compatible with the upgrade.
- Names: trimmed, 1–80 characters. Scores: 0–99999; kg inputs allow one decimal, reps and
  time inputs whole units. Zero clears an entry through the same verification process.
  A trigger also checks direct admin athlete writes, including numeric JSONB values.
- Bootstrap admin is GitHub login `587763`, only with GitHub provider metadata. Missing login
  metadata creates an ordinary pending profile. Existing roles are not rewritten by 0005.

## TV / display mode
Enable with `?tv` or the header toggle. State is persisted defensively in `localStorage['lb.tv']`.
`?rotate=<seconds>` sets a 5–120s target budget per tab, default 15s. Multi-page tabs give
page one double the dwell of later pages. Later pages get at least 5s (page one 10s),
extending the target for large rosters; a single page still respects a 5s target.
Timeouts pause while hidden or a modal is open; closing it starts a fresh dwell.
- Every board has a podium in normal mode. Equal scores share a medal position; groups of
  more than six medalists use the full ranked table. TV below 760px high also uses tables to
  reserve enough vertical space. Above that cutoff, measure podiums and switch to complete
  tables if there is insufficient room for up to two ranked rows. Reconsider after refits.
  Steps, padding and rank type share rem scaling with explicit line-height and minimum
  height. Table columns scale with text; totals reserve six digits. Cards stack below 960px outside TV mode.
- `fitTvPaging` measures each row, including wrapped names. `partitionRows` packs rows into
  pages; `applyTvPage` toggles `hidden` and page dots. Smaller boards pin to their final page.
  Hall of Fame uses paged tables on TV. `TV_PAGE_PAD` reserves 48px for the dots.
- Refits after render, tab switches, fonts loading and resize; changing page counts restarts
  the rotation clock so late data does not leave a stale countdown.
- Connection warnings and Retry remain visible in the TV footer reserve. See `REVIEW.md`
  for the review scope, remaining follow-ups and browser verification matrix.

## Extending
- Achievement: add to `ACHIEVEMENTS`; forms, badges and Hall of Fame follow automatically.
- Extra lift: add to `OTHER_LIFTS` with id/label/emoji/unit (`kg`, `reps`, `time`). Optional
  `group:'cardio'` selects Cardio; `lowerIsBetter:true` ranks smaller positive values first.
  No schema change: generic numeric JSONB storage. Times accept strict `m:ss` or whole seconds.
- Main lift: requires fixed-column schema + migration and corresponding registry/forms/markup.
- Preserve unknown extra-lift keys and unregistered achievements on admin edits; My PRs
  must not remove achievements absent from the form. Never interpolate unescaped user text
  into markup; `escapeAttr` / `app.escapeHtml` handle both text and quoted attributes.

## Database upgrades and deployment
0005 is a transactional, idempotent upgrade; apply it before deploying these changes.
It does not rewrite existing athlete rows, profiles, proposals or history. Tests execute
its functions in local Postgres (PGlite); production migrations are a separate operation.

For a live upgrade: paste the numbered migration into Supabase SQL Editor, or use a SQL
client that supports multi-statement transactions. Never use `supabase db push`: the
hand-numbered files are not in the CLI migration ledger and it would replay superseded 0001.
The installed `supabase db query -f` sends one prepared statement and cannot execute this
multi-statement migration as-is; use the SQL Editor instead of splitting its transaction.

Production DB URL is in the gitignored `.env`, with spaces around `=`. Do not source it or
print credentials. Config in `js/config.js` is a safe publishable key; never commit a
service-role/secret key. Supabase project ref: `hqrqmkherwdkfvhjypuk`.
Auth redirects allow localhost:3000 and the Pages URL. A new serving origin needs an Auth
URL Configuration entry. Use port 3000 for real sign-in; fixtures work on any local port.

CDN upgrade: bump the pinned supabase-js version and recompute SHA-384 on the exact UMD
file. Never use the floating `@2` URL (CDN minification can invalidate SRI).

## Backups and icons
Daily backup uses `SUPABASE_DB_URL` Actions secret and fails clearly if missing. Dumps cover
public athletes/profiles/proposals only; they are not complete Supabase/Auth backups. Restoring
requires compatible functions, roles and matching auth.users IDs. Never commit dumps.

`favicon.svg` is the mark; theme-color is `--whiteboard` (#fbfbf8). The 180px iOS icon is a
full-bleed variant of it. Regenerate via macOS `qlmanage -t -s 1024` on a full-bleed SVG, then
`sips -z 180 180` on the PNG; no ImageMagick required.
