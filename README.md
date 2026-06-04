# 💪 Digdir Gym Leaderboard

A digital version of our office gym whiteboard — squat / bench / deadlift personal
records, a combined total, podiums, and a Hall of Fame for fun achievements. Hand-drawn
whiteboard look; the board updates live across everyone's screens.

**Live:** https://587763.github.io/digdir-gym-leaderboard/

- View is open to everyone. **Sign in with GitHub to edit.**
- Changes appear in real time (nice on a wall-mounted display).

## How it works

- **Static site, no build step.** Plain HTML/CSS/vanilla JS served straight from the
  repo root by GitHub Pages. Push to `main` → it deploys automatically.
- **[Supabase](https://supabase.com)** (hosted Postgres) provides the shared data,
  GitHub sign-in, and realtime updates. The browser talks to it directly — there is
  no server to run.
- **Security is enforced by the database** (Row Level Security), not the frontend:
  anyone can read; only signed-in users can write.

That's the whole design: keep it dead simple to host (a folder of static files) and
let a managed service handle the stateful parts.

## Developing

This repo is predominantly **AI-agent maintained**. If you're working on it (agent or
human), start with **[CLAUDE.md](CLAUDE.md)** — it's the source of truth for
architecture, the repo map, how to run/verify locally, the deploy flow, and gotchas.

Quick start:

```bash
npm run dev      # http://localhost:3000  (or: python3 -m http.server 3000)
```

## License

MIT
