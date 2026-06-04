# AGENTS.md

This repo's agent/development guide lives in **[CLAUDE.md](CLAUDE.md)** — read that
first. It covers the architecture (buildless static site + Supabase, no backend),
the repo map, how to run and verify locally, the deploy flow, the Supabase/RLS
security model, common tasks, and gotchas.

Quick orientation:

- **No build step.** Vanilla JS in `<script>` tags; Supabase loaded from CDN. Don't
  introduce a bundler/framework without being asked.
- **Run:** `npm run dev` (or `python3 -m http.server 3000`).
- **Deploy:** push to `main` → GitHub Pages (auto).
- **Verify:** load it in a browser, confirm no console errors.
- **Security:** enforced by Postgres Row Level Security, not the client.

See [README.md](README.md) for user-facing setup, and [CLAUDE.md](CLAUDE.md) for
everything else.
