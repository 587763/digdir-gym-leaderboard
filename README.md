# 💪 Digdir Gym Leaderboard

A digital version of our office gym whiteboard — squat / bench / deadlift personal
records, a combined total, podiums, "other lifts" (a timed dead hang, push-up & pull-up
counts), a Cardio tab (e.g. a fastest 1 km), per-athlete progression charts, and a Hall
of Fame for fun achievements. Hand-drawn whiteboard look; the board updates live across
everyone's screens.

**Live:** https://587763.github.io/digdir-gym-leaderboard/

- View is open to everyone. **Sign in with GitHub** to take part.
- Changes appear in real time (nice on a wall-mounted display).
- **Tap any athlete's name** to see their progression — a sparkline of every
  peer-verified PR over time. Direct admin edits are not part of that history.
- **Putting it on a TV?** Open the board with `?tv` (e.g. the live URL + `?tv`), or hit
  the **📺 TV mode** button. You get a full-screen landscape layout that auto-cycles
  through the tabs hands-free — and pauses while the browser tab is off-screen, so it
  plays nicely with a screen that rotates between several pages. A big roster is paged
  through automatically. Add `&rotate=20` to change the target seconds per tab (default
  15). Large rosters extend that time so every page gets at least five seconds to read;
  the first page gets double the time. Podium steps scale with their numbers when Chrome
  zoom changes, and crowded screens use complete ranked tables when podiums leave too
  little room. Connection trouble stays visible, and the board checks for missed updates
  every minute while the page is visible.

## Who can change what

It governs itself, mirroring our whiteboard culture (a PR isn't real until someone
witnesses it):

- **Claim your spot** — sign in, then link your GitHub to your athlete (or add a new
  one). An **admin approves** the link.
- **Your PRs & achievements** need a **peer** to verify them — any other linked member
  (you can't verify your own). Until verified, the change is pending.
- **Name changes & new athletes** need an **admin**.
- **Admins** manage members and can edit the board directly.
- Blocked accounts cannot submit or approve changes. Requests are validated, repeated
  submissions are deduplicated, and stale PR requests cannot overwrite newer records.
  Admin forms also detect concurrent edits instead of overwriting someone else’s changes.

## How it works

- **Static site, no build step.** Plain HTML/CSS/vanilla JS served straight from the
  repo by GitHub Pages. PRs run the test suite; pushes to `main` deploy after tests pass.
  Only public site assets are published.
- **[Supabase](https://supabase.com)** (hosted Postgres) provides the shared data,
  GitHub sign-in, and realtime updates. The browser talks to it directly — there is
  no server to run.
- **The rules are enforced by the database**, not the frontend — Row Level Security
  plus a couple of Postgres functions decide who can change what (see above). The
  governance is pure Postgres: no extra servers, no GitHub-org dependency.

That's the whole design: keep it dead simple to host (a folder of static files) and
let a managed service handle the stateful, governed parts.

## Developing

This repo is predominantly **AI-agent maintained**. If you're working on it (agent or
human), start with **[CLAUDE.md](CLAUDE.md)** — it's the source of truth for
architecture, the repo map, how to run/verify locally, the deploy flow, and gotchas.

Quick start:

```bash
npm run dev      # Node 22+, http://localhost:3000; no install needed
npm ci           # install development-only test tools
npm test         # frontend + local Postgres/RLS regression tests
```

The local server serves only the website files, with caching disabled. It never exposes
workspace files such as `.env`. To try forms without touching the real board, open
`http://localhost:3000/?fixture=admin`. Other local fixtures: `empty`, `error`, and `large`
(65 athletes; combine with `&tv&rotate=120` to inspect TV pagination), and `layout`
(long medalist names and maximum scores). All fixture writes
stay in memory, and fixtures are excluded from the deployed site.

The boards use shared ranks for ties (1, 1, 3). A zero value means no entry. Enter weights
to one decimal, repetitions as whole numbers, and times as `m:ss` or whole seconds.
Keyboard users can move between tabs with arrow keys and close dialogs with Escape.
Equal decimal totals share the same rank. TV rotation pauses while a dialog is open.

The [September 2026 repository review](REVIEW.md) records the display fixes, verification,
and recommended database and maintenance follow-ups.

For an existing database, apply
[`0005_governance_hardening.sql`](supabase/migrations/0005_governance_hardening.sql)
in the Supabase SQL Editor before deploying this version. It preserves existing data.
For a fresh installation, use `supabase/schema.sql` instead; that file resets the tables.

## Backups

The Supabase project is on the free tier, which has no reliable automatic backups (and
idle free projects can be paused or deleted). A scheduled GitHub Actions workflow
([`.github/workflows/backup.yml`](.github/workflows/backup.yml)) dumps the data daily and
keeps each dump as a **workflow artifact for 90 days**; dumps are never committed to this
public repo.

It authenticates via the `SUPABASE_DB_URL` repository secret (the project's full Postgres
connection string — full DB access, so it lives only in Actions secrets). If that secret
is ever missing, the workflow fails fast with a message saying so.

To restore: download a backup artifact, `gunzip` it, and load it into a compatible project
with `psql "<target-connection-string>" -f leaderboard-backup-*.sql`. These are public-table
backups, not full Supabase backups: the target needs compatible functions and roles, plus
the matching `auth.users` records referenced by the profiles. See the agent guide.

## License

MIT
