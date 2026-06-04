// Data + auth layer. Wraps Supabase so app.js never talks to it directly.
//
// Exposes a global `Store`. All methods are async and throw on error; the UI
// layer is responsible for showing toasts.

(function () {
  const cfg = window.LEADERBOARD_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes('YOUR_PROJECT_REF') &&
    !cfg.SUPABASE_ANON_KEY.includes('YOUR_ANON');

  let client = null;
  if (configured) {
    // `supabase` is the global from the CDN UMD build (see index.html).
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  window.Store = {
    configured,
    client,

    // --- auth ---------------------------------------------------------------
    async getUser() {
      if (!client) return null;
      const { data } = await client.auth.getSession();
      return data.session?.user ?? null;
    },

    async getSession() {
      if (!client) return null;
      const { data } = await client.auth.getSession();
      return data.session ?? null;
    },

    // Friendly display name for the signed-in user.
    userLabel(user) {
      if (!user) return '';
      const m = user.user_metadata || {};
      return m.user_name || m.preferred_username || m.full_name || m.name || user.email || 'signed in';
    },

    async signIn() {
      if (!client) return;
      await client.auth.signInWithOAuth({
        provider: 'github',
        // read:org lets the verify-editor function check felleslosninger membership.
        options: {
          scopes: 'read:org',
          redirectTo: window.location.origin + window.location.pathname,
        },
      });
    },

    async signOut() {
      if (!client) return;
      await client.auth.signOut();
    },

    // Passes the full session so callers can read session.provider_token (only
    // present right after a fresh OAuth sign-in, used to verify org membership).
    onAuthChange(cb) {
      if (!client) return;
      client.auth.onAuthStateChange((_event, session) => cb(session ?? null));
    },

    // --- editor (org membership) -------------------------------------------
    // Server-verifies GitHub org membership and records the user as an editor.
    // Returns true only if the Edge Function confirms active membership.
    async verifyEditor(providerToken) {
      if (!client) return false;
      try {
        const { data, error } = await client.functions.invoke('verify-editor', {
          body: { provider_token: providerToken },
        });
        if (error) {
          console.error('verify-editor failed', error);
          return false;
        }
        return !!data?.editor;
      } catch (e) {
        console.error('verify-editor threw', e);
        return false;
      }
    },

    // Cheap check for return visits (no GitHub call): is there an editors row for
    // me? Readable thanks to the "read own editor row" RLS policy.
    async isEditorCached() {
      if (!client) return false;
      const { data, error } = await client.from('editors').select('user_id').maybeSingle();
      if (error) return false;
      return !!data;
    },

    // --- data ---------------------------------------------------------------
    async list() {
      if (!client) return [];
      const { data, error } = await client
        .from('athletes')
        .select('*')
        .order('name', { ascending: true });
      if (error) throw error;
      return data;
    },

    async create(athlete, user) {
      const row = { ...athlete, updated_by: Store.userLabel(user) || null };
      const { data, error } = await client.from('athletes').insert(row).select().single();
      if (error) throw error;
      return data;
    },

    async update(id, patch, user) {
      const row = { ...patch, updated_by: Store.userLabel(user) || null };
      const { data, error } = await client
        .from('athletes')
        .update(row)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async remove(id) {
      const { error } = await client.from('athletes').delete().eq('id', id);
      if (error) throw error;
    },

    // --- realtime -----------------------------------------------------------
    // Calls `cb` whenever any athlete row changes (from anyone, anywhere).
    subscribe(cb) {
      if (!client) return;
      client
        .channel('athletes-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'athletes' }, cb)
        .subscribe();
    },
  };
})();
