# 💪 Digdir Gym Leaderboard

A digital version of our office gym whiteboard — squat / bench / deadlift personal
records, a combined total, podiums, "other lifts" (e.g. a timed dead hang), and a Hall of
Fame for fun achievements. Hand-drawn whiteboard look; the board updates live across
everyone's screens.

**Live:** https://587763.github.io/digdir-gym-leaderboard/

- View is open to everyone. **Sign in with GitHub** to take part.
- Changes appear in real time (nice on a wall-mounted display).

## Who can change what

It governs itself, mirroring our whiteboard culture (a PR isn't real until someone
witnesses it):

- **Claim your spot** — sign in, then link your GitHub to your athlete (or add a new
  one). An **admin approves** the link.
- **Your PRs & achievements** need a **peer** to verify them — any other linked member
  (you can't verify your own). Until verified, the change is pending.
- **Name changes & new athletes** need an **admin**.
- **Admins** manage members and can edit the board directly.

## How it works

- **Static site, no build step.** Plain HTML/CSS/vanilla JS served straight from the
  repo root by GitHub Pages. Push to `main` → it deploys automatically.
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
npm run dev      # http://localhost:3000  (or: python3 -m http.server 3000)
```

## Backups

The Supabase project is on the free tier, which has no reliable automatic backups (and
idle free projects can be paused or deleted). A scheduled GitHub Actions workflow
([`.github/workflows/backup.yml`](.github/workflows/backup.yml)) dumps the data daily and
keeps each dump as a **workflow artifact for 90 days**; dumps are never committed to this
public repo.

It authenticates via the `SUPABASE_DB_URL` repository secret (the project's full Postgres
connection string — full DB access, so it lives only in Actions secrets). If that secret
is ever missing, the workflow fails fast with a message saying so.

To restore: download a backup artifact, `gunzip` it, and load it into a (fresh) project
with `psql "<target-connection-string>" -f leaderboard-backup-*.sql`.

## License

MIT
