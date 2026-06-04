# 💪 Digdir Gym Leaderboard

A digital version of our gym whiteboard — squat / bench / deadlift PRs, a combined
total, podiums, and a Hall of Fame for fun achievements. Hand-drawn whiteboard look,
live-updating across everyone's screens.

- **Static site** (no build step) — deploys to GitHub Pages as-is.
- **Supabase** for shared, persistent storage + GitHub sign-in + realtime updates.
- **View is open to everyone; you sign in with GitHub to edit.**

---

## How it fits together

```
index.html          markup + loads scripts (Supabase from CDN)
styles.css          whiteboard theme
js/config.js        ← your Supabase URL + anon key go here
js/store.js         all Supabase calls (data, auth, realtime)
js/app.js           UI logic
js/avatar.js        stick-figure avatars (derived from name)
js/achievements.js  achievement registry (add new ones here)
supabase/schema.sql  paste-and-run database setup + seed data
```

There is **no backend to run** — the browser talks to Supabase directly, and Row
Level Security in the database is what actually enforces "only signed-in users can edit".

---

## Setup (one time, ~10 minutes)

### 1. Create the database
1. Make a free project at [supabase.com](https://supabase.com).
2. In the dashboard → **SQL Editor** → paste all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   This creates the `athletes` table, the security policies, realtime, and seeds the current board.

### 2. Turn on GitHub sign-in
1. Create a GitHub OAuth App: GitHub → Settings → Developer settings → **OAuth Apps** → New.
   - **Homepage URL**: your site URL (e.g. `https://<org>.github.io/digdir-leaderboard/`)
   - **Authorization callback URL**: `https://<your-project-ref>.supabase.co/auth/v1/callback`
2. In Supabase → **Authentication → Providers → GitHub**: paste the OAuth app's
   Client ID + secret and enable it.
3. In Supabase → **Authentication → URL Configuration**: add your site URL to
   **Redirect URLs** (and as the Site URL). Add `http://localhost:3000` too for local dev.

### 3. Connect the frontend
Open [`js/config.js`](js/config.js) and paste your **Project URL** and **anon public key**
(Supabase → Settings → API):

```js
window.LEADERBOARD_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ...your-anon-key...',
};
```

> ℹ️ The anon key is **meant to be public** and committed — security comes from the
> RLS policies, not from hiding it. Never commit the *service_role* key.

---

## Run locally

```bash
npm run dev      # serves on http://localhost:3000 (uses npx serve, no install)
# or:
python3 -m http.server 3000
```

## Deploy (GitHub Pages)

1. Push to `main`.
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The included [workflow](.github/workflows/deploy.yml) publishes the site on every push.

---

## Editing the board

- Anyone can **view**.
- Click **Sign in with GitHub** to add/edit/delete athletes.
- Changes appear **live** on every open screen (great for a wall-mounted display).
- **Backup** downloads the current board as JSON anytime.

## Adding a new achievement

Append one entry to [`js/achievements.js`](js/achievements.js) — the edit form, badges,
and Hall of Fame all update automatically. The achievement `id` is stored in the
`athletes.achievements` array.

---

## Future ideas (not built yet)

- Avatar **customizer** (avatars are currently auto-generated from the name).
- Restricting editing to members of a specific GitHub org via a Supabase Edge Function.
- Weight classes / bodyweight, history graphs, "PR of the week".
