// Data + auth layer. Wraps Supabase so app.js never talks to it directly.
// Governance lives in the database (RLS + propose()/decide() functions); this is
// just a thin client over it. All methods are async and throw on error.

(function () {
  const cfg = window.LEADERBOARD_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes('YOUR_PROJECT_REF') &&
    !cfg.SUPABASE_ANON_KEY.includes('YOUR_ANON');

  let client = null;
  if (configured) {
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  window.Store = {
    configured,
    client,

    // --- auth ---------------------------------------------------------------
    async getSession() {
      if (!client) return null;
      const { data } = await client.auth.getSession();
      return data.session ?? null;
    },

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
      client.auth.onAuthStateChange((_event, session) => cb(session ?? null));
    },

    // --- reads --------------------------------------------------------------
    async listAthletes() {
      if (!client) return [];
      const { data, error } = await client.from('athletes').select('*').order('name');
      if (error) throw error;
      return data;
    },

    // My own profile row (role/status/link). Null if signed out or not yet created.
    async myProfile() {
      if (!client) return null;
      const { data } = await client.auth.getSession();
      const uid = data.session?.user?.id;
      if (!uid) return null;
      const { data: prof, error } = await client
        .from('profiles').select('*').eq('user_id', uid).maybeSingle();
      if (error) return null;
      return prof;
    },

    // Roster of all profiles (authenticated only) — for admin UI + owner mapping.
    async listProfiles() {
      if (!client) return [];
      const { data, error } = await client.from('profiles').select('*');
      if (error) return [];
      return data;
    },

    // Pending proposals (the review queue). Authenticated only.
    async listPendingProposals() {
      if (!client) return [];
      const { data, error } = await client
        .from('proposals').select('*').eq('status', 'pending').order('created_at');
      if (error) return [];
      return data;
    },

    // An athlete's verified PR history (approved 'pr' proposals), oldest → newest.
    // The progression view reads this. Authenticated only (RLS gates proposals reads).
    async listAthleteHistory(athleteId) {
      if (!client) return [];
      const { data, error } = await client
        .from('proposals')
        .select('payload, decided_at')
        .eq('athlete_id', athleteId)
        .eq('kind', 'pr')
        .eq('status', 'approved')
        .order('decided_at', { ascending: true });
      if (error) throw error;
      return data;
    },

    // --- governed writes (RPCs enforce all the rules) -----------------------
    async propose(kind, athleteId, payload) {
      const { data, error } = await client.rpc('propose', {
        p_kind: kind, p_athlete: athleteId, p_payload: payload || {},
      });
      if (error) throw error;
      return data;
    },

    async decide(proposalId, approve) {
      const { error } = await client.rpc('decide', { p_id: proposalId, p_approve: approve });
      if (error) throw error;
    },

    // --- admin-only direct writes (RLS gates these to admins) ---------------
    async adminUpdateProfile(userId, patch) {
      const { error } = await client.from('profiles').update(patch).eq('user_id', userId);
      if (error) throw error;
    },
    async adminCreateAthlete(athlete) {
      const { data, error } = await client.from('athletes').insert(athlete).select().single();
      if (error) throw error;
      return data;
    },
    async adminUpdateAthlete(id, patch) {
      const { error } = await client.from('athletes').update(patch).eq('id', id);
      if (error) throw error;
    },
    async adminDeleteAthlete(id) {
      const { error } = await client.from('athletes').delete().eq('id', id);
      if (error) throw error;
    },

    // --- realtime -----------------------------------------------------------
    subscribe(cb) {
      if (!client) return;
      client
        .channel('board-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'athletes' }, cb)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'proposals' }, cb)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, cb)
        .subscribe();
    },
  };
})();
