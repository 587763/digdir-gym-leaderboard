// verify-editor — server-side GitHub org-membership check.
//
// Called by the frontend right after sign-in (when the GitHub provider token is
// still available). It asks GitHub whether the signed-in user is an active member
// of the configured org, and records them in the `editors` table (via the service
// role) if so. Row Level Security on `athletes` then allows writes only for users
// who have an `editors` row — so this function is the ONLY way to become an editor,
// and the client cannot fake it.
//
// Deploy:  supabase functions deploy verify-editor
// Env (auto-injected by Supabase): SUPABASE_URL, SUPABASE_ANON_KEY,
//                                  SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.107.0';

const ORG = 'felleslosninger';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Who is calling? Derive identity from their JWT — never trust client input for this.
    const asUser = createClient(url, anon, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !user) return json({ editor: false, reason: 'not-authenticated' }, 401);

    const { provider_token } = await req.json().catch(() => ({}));
    if (!provider_token) return json({ editor: false, reason: 'no-provider-token' }, 400);

    // Ask GitHub about the user's OWN membership (works for private membership too,
    // given the read:org scope). 200 + state:active => member; 404 => not a member;
    // 403 => the org blocks this OAuth app (needs an org owner to approve it).
    const gh = await fetch(`https://api.github.com/user/memberships/orgs/${ORG}`, {
      headers: {
        Authorization: `Bearer ${provider_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'digdir-gym-leaderboard',
      },
    });

    let isMember = false;
    if (gh.ok) {
      const m = await gh.json();
      isMember = m?.state === 'active';
    }

    const admin = createClient(url, service);
    if (isMember) {
      await admin.from('editors').upsert({
        user_id: user.id,
        github_login: (user.user_metadata as Record<string, unknown>)?.user_name ?? null,
        verified_at: new Date().toISOString(),
      });
    } else {
      // Revoke if they were previously an editor but are no longer a member.
      await admin.from('editors').delete().eq('user_id', user.id);
    }

    return json({ editor: isMember, github_status: gh.status });
  } catch (e) {
    return json({ editor: false, reason: String(e) }, 500);
  }
});
