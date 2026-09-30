// Data + auth layer. Wraps Supabase so app.js never talks to it directly.
// Governance lives in the database (RLS + propose()/decide()/withdraw() functions);
// this is just a thin client over it. All methods are async and throw on error.

(function () {
  const cfg = window.LEADERBOARD_CONFIG || {};
  const hasConfig =
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes('YOUR_PROJECT_REF') &&
    !cfg.SUPABASE_ANON_KEY.includes('YOUR_ANON');

  let client = null;
  let connectionError = null;
  if (hasConfig && window.supabase?.createClient) {
    try {
      client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
    } catch (error) { connectionError = error; }
  } else if (hasConfig) {
    connectionError = new Error('The connection library could not load. Check your connection and reload.');
  }

  // Explicit columns: the live table also carries legacy fields the app never reads.
  const ATHLETE_COLUMNS = 'id, name, bench, squat, deadlift, lifts, achievements, archived_at, updated_at';
  const PROFILE_COLUMNS = 'user_id, github_login, display_name, is_admin, status, athlete_id';
  const PROPOSAL_COLUMNS = 'id, kind, approval, athlete_id, proposer, payload, status, created_at';

  const connected = () => {
    if (!client) throw new Error('Not connected to the leaderboard database.');
    return client;
  };
  const rows = async (query) => {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  };

  window.Store = {
    configured: !!client,
    connectionError,

    // --- auth ---------------------------------------------------------------
    async getSession() {
      if (!client) return null;
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session ?? null;
    },

    userLabel(user) {
      if (!user) return '';
      const m = user.user_metadata || {};
      return m.user_name || m.preferred_username || m.full_name || m.name || user.email || 'signed in';
    },

    async signIn() {
      const { error } = await connected().auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw error;
    },

    async signOut() {
      if (!client) return;
      const { error } = await client.auth.signOut();
      if (error) throw error;
    },

    onAuthChange(cb) {
      if (!client) return;
      // Leave the auth callback's lock before any consumer makes a Supabase call.
      const { data } = client.auth.onAuthStateChange((event, session) => {
        setTimeout(() => cb(session ?? null, event), 0);
      });
      return () => data.subscription.unsubscribe();
    },

    // --- reads --------------------------------------------------------------
    async listAthletes() {
      if (!client) return [];
      return rows(client.from('athletes').select(ATHLETE_COLUMNS).order('name'));
    },

    // My own profile row (role/status/link). Null if signed out or not yet created.
    async myProfile(uid) {
      if (!client || !uid) return null;
      return rows(client.from('profiles').select(PROFILE_COLUMNS).eq('user_id', uid).maybeSingle());
    },

    // Roster of all profiles (authenticated only) — for admin UI + owner mapping.
    async listProfiles() {
      if (!client) return [];
      return rows(client.from('profiles').select(PROFILE_COLUMNS));
    },

    // Pending proposals (the review queue). Authenticated only.
    async listPendingProposals() {
      if (!client) return [];
      return rows(client.from('proposals').select(PROPOSAL_COLUMNS).eq('status', 'pending').order('created_at'));
    },

    // Latest verified PRs across the board, newest first. Public through RLS (0004).
    async listRecentPrs(limit = 20) {
      if (!client) return [];
      return rows(client.from('proposals').select('id, athlete_id, payload, decided_at')
        .eq('kind', 'pr').eq('status', 'approved')
        .order('decided_at', { ascending: false }).limit(limit));
    },

    // An athlete's verified PR history (approved 'pr' proposals), oldest → newest.
    async listAthleteHistory(athleteId) {
      if (!client) return [];
      return rows(client.from('proposals').select('payload, decided_at')
        .eq('athlete_id', athleteId).eq('kind', 'pr').eq('status', 'approved')
        .order('decided_at', { ascending: true }));
    },

    // --- governed writes (RPCs enforce all the rules) -----------------------
    async propose(kind, athleteId, payload) {
      return rows(connected().rpc('propose', { p_kind: kind, p_athlete: athleteId, p_payload: payload || {} }));
    },

    async decide(proposalId, approve) {
      await rows(connected().rpc('decide', { p_id: proposalId, p_approve: approve }));
    },

    // The proposer retracts their own pending request (migration 0006).
    async withdraw(proposalId) {
      const { error } = await connected().rpc('withdraw', { p_id: proposalId });
      if (error?.code === 'PGRST202') throw new Error('Withdrawing requests is not available yet. Ask an admin to reject it instead.');
      if (error) throw error;
    },

    // A returning member puts their own archived athlete back on the boards (0007).
    async restoreMyAthlete() {
      const { error } = await connected().rpc('restore_my_athlete');
      if (error?.code === 'PGRST202') throw new Error('Restoring is not available yet. Ask an admin to restore your athlete.');
      if (error) throw error;
    },

    // --- admin-only direct writes (RLS gates these to admins) ---------------
    // Each selects the affected row, so an RLS-denied no-op cannot look successful.
    async adminUpdateProfile(userId, patch) {
      await rows(connected().from('profiles').update(patch).eq('user_id', userId).select('user_id').single());
    },
    async adminCreateAthlete(athlete) {
      return rows(connected().from('athletes').insert(athlete).select(ATHLETE_COLUMNS).single());
    },
    async adminUpdateAthlete(id, patch, expectedUpdatedAt) {
      let query = connected().from('athletes').update(patch).eq('id', id);
      if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
      const { error } = await query.select('id').single();
      if (error?.code === 'PGRST116') throw new Error('This athlete changed or your access expired. Reopen the editor and try again.');
      if (error) throw error;
    },
    // Archived athletes leave the boards but keep their records and verified history.
    async adminSetArchived(id, archived) {
      await rows(connected().from('athletes').update({ archived_at: archived ? new Date().toISOString() : null })
        .eq('id', id).select('id').single());
    },
    // Permanent: also erases their proposals, including verified history (for erasure requests).
    async adminDeleteAthlete(id) {
      await rows(connected().from('athletes').delete().eq('id', id).select('id').single());
    },

    // --- realtime -----------------------------------------------------------
    subscribe(cb, onStatus) {
      if (!client) return;
      const channel = client
        .channel('board-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'athletes' }, cb)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'proposals' }, cb)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, cb)
        .subscribe(onStatus);
      return () => client.removeChannel(channel);
    },
  };
})();
