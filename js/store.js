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
        options: { redirectTo: window.location.origin + window.location.pathname },
      });
    },

    async signOut() {
      if (!client) return;
      await client.auth.signOut();
    },

    onAuthChange(cb) {
      if (!client) return;
      client.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
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
