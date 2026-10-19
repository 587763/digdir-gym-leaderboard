# 💪 Digdir Gym Leaderboard

A digital version of our office gym whiteboard — squat / bench / deadlift personal
records, a combined total, podiums, "other lifts" (a timed dead hang, push-up & pull-up
counts, a strict curl), a Cardio tab (e.g. a fastest 1 km), optional bodyweight rankings, a feed of the
latest verified PRs, per-athlete progression charts, and a Hall of Fame for fun
achievements. Hand-drawn whiteboard look; the board updates live across everyone's screens.

**Live:** https://587763.github.io/digdir-gym-leaderboard/

- View is open to everyone. **Sign in with GitHub** to take part.
- Changes appear in real time (nice on a wall-mounted display).
- **Tap any athlete's name** to see their progression — a sparkline of every
  peer-verified PR over time. Direct admin edits are not part of that history.
- **Latest** lists the newest verified PRs with how much they improved; 🔥 marks a
  record set in the last week, and a PR verified while you watch gets a little cheer.
- **⚖️ Bodyweight ranking** (the header button) re-ranks the boards by bodyweight, for
  athletes who choose to share theirs. Lifts and the total are divided by bodyweight (`1.52×`
  means 1.52 times your bodyweight). Chill-ups, push-ups and dead hang are multiplied by it,
  since there your body is the weight (kilograms moved, kilogram-minutes held). Cardio stays
  as it is: running costs about the same energy per kilogram for everyone, so a time already
  reflects fitness per kilogram. It's off until you turn it on, and your browser remembers
  the choice. Neither rule is a scientific formula: dividing a little favours lighter
  athletes, multiplying a little favours heavier ones.
- **📅 Friday lift**: a sticky note next to the buttons says which lift is up this Friday,
  and that lift's board gets a little sticker. Fridays rotate squat, bench, deadlift, then
  other lifts, by the calendar (a skipped Friday still uses its turn). The TV shows the note
  as one line in its header; a TV signed in as a member also shows the next session.
- **📅 Planner** (the button on that note): say when you're heading to the gym and what
  you'll do, and tap **🙋 I'm in** to join someone else at the time you'll come down. Each
  session shows who comes when, and its earliest time with a + when others come later
  (13:00+). The note itself shows the next session and how many are in; a session before
  Friday comes first there. The planner covers this week and the eight after it; each
  Friday carries its lift, and a Friday plan starts as that lift. Only members on the board
  see the plans, since they tell when someone will be at the gym.
- **✨ What's new** (above the tabs) lists what changed in each release, with a dot until
  you've seen the latest one.
- Tab links can be shared: add `#total`, `#cardio`, `#latest` and so on to the URL.
- **Putting it on a TV?** Open the board with `?tv` (e.g. the live URL + `?tv`), or hit
  the **📺 TV mode** button. You get a full-screen landscape layout that auto-cycles
  through the tabs hands-free — and pauses while the browser tab is off-screen, so it
  plays nicely with a screen that rotates between several pages. A big roster is paged
  through automatically. Add `&rotate=20` to change the target seconds per tab (default
  15), and `&tabs=lifts,total,latest` to show only some tabs. The TV never ranks by
  bodyweight unless you ask for it: add `&bodyweight`, or turn it on in that browser before
  starting TV mode. Large rosters extend that time so every page gets at least five seconds to read;
  the first page gets double the time. Podium steps scale with their numbers when Chrome
  zoom changes, and crowded screens use complete ranked tables when podiums leave too
  little room. Connection trouble stays visible, and the board checks for missed updates
  every minute while the page is visible. If the screen cycles between several pages, the
  countdown resumes where it left off, so every tab still gets its turn.

## Who can change what

It governs itself, mirroring our whiteboard culture (a PR isn't real until someone
witnesses it):

- **Claim your spot** — sign in, then link your GitHub to your athlete (or add a new
  one). An **admin approves** the link.
- **Your PRs & achievements** need a **peer** to verify them — any other linked member
  (you can't verify your own). Until verified, the change is pending.
- **Name changes & new athletes** need an **admin**.
- **Your bodyweight** is optional and yours alone: add, change or clear it in My PRs. It
  applies at once, without review, and clearing it takes you off the bodyweight rankings
  without leaving a copy in the request history. Like everything on the board it is public:
  anyone can work it out from your scores there.
- **Admins** manage members and can edit the board directly. The database always keeps
  at least one working admin, and the members list won't let admins demote or block
  themselves.
- **Changed your mind?** Withdraw your own pending request from My PRs, the claim dialog,
  or the review list.
- **Plans** are yours: change or remove your own, and join anyone's (or change your time, or
  leave) until two hours after it starts. Moving a session moves everyone's time with it.
  Admins can remove any plan. No review is needed.
- **Leaving the office?** Admins archive athletes instead of deleting them: they leave the
  boards but keep every record and verified PR. Sign in again with the same GitHub account
  and you'll be offered to bring your athlete back; athletes without a linked account can
  be claimed again. Permanent deletion is still there for data-removal requests.
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
npm run dev           # Node 22+, http://localhost:3000; no install needed
npm ci                # install development-only test tools
npm test              # frontend + local Postgres/RLS regression tests
npm run test:browser  # layout checks in your local Chrome (desktop, phone, TV)
```

The local server serves only the website files, with caching disabled. It never exposes
workspace files such as `.env`. To try forms without touching the real board, open
`http://localhost:3000/?fixture=admin`. Other local fixtures: `returning` (a member whose
athlete was archived), `empty`, `error`, and `large` (65 athletes; combine with
`&tv&rotate=120` to inspect TV pagination), and `layout` (long medalist names and maximum
scores). Add `&bodyweight` to rank them by bodyweight. All fixture writes
stay in memory, and fixtures are excluded from the deployed site.

The boards use shared ranks for ties (1, 1, 3). A zero value means no entry. Enter weights
to one decimal, repetitions as whole numbers, and times as `m:ss` (or `m.ss` on a phone
keypad) or whole seconds; the form shows how a time will be read before you submit.
Keyboard users can move between tabs with arrow keys and close dialogs with Escape.
Equal decimal totals share the same rank. TV rotation pauses while a dialog is open.

The [repository review](REVIEW.md) records what the September 2026 reviews changed, how it
was verified, and the remaining follow-ups.

For an existing database, apply the numbered files in
[`supabase/migrations/`](supabase/migrations/) in order (the Supabase SQL Editor, or
`supabase db query --linked -f <file>`) before deploying the frontend that needs them (the
live database has everything through `0010_planner.sql`). They preserve existing data. For a
fresh installation, use `supabase/schema.sql` instead; that file resets the tables.

## Backups

The Supabase project is on the free tier, which has no reliable automatic backups (and
idle free projects can be paused or deleted). A scheduled GitHub Actions workflow
([`.github/workflows/backup.yml`](.github/workflows/backup.yml)) dumps the data daily and
keeps each dump as a **workflow artifact for 90 days**; dumps are never committed to this
public repo.

GitHub pauses scheduled workflows in repositories without commits for 60 days (the backups
stopped this way on 30 August 2026). Each backup run now re-enables its own schedule; if it
ever shows as disabled in the Actions tab, enable it there. It authenticates via the
`SUPABASE_DB_URL` repository secret (the project's full Postgres
connection string — full DB access, so it lives only in Actions secrets). If that secret
is ever missing, the workflow fails fast with a message saying so.

To restore: download a backup artifact, `gunzip` it, and load it into a compatible project
with `psql "<target-connection-string>" -f leaderboard-backup-*.sql`. These are public-table
backups, not full Supabase backups: the target needs compatible functions and roles, plus
the matching `auth.users` records referenced by the profiles. See the agent guide.

## License

MIT
