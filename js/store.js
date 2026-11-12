// Data + auth layer. Wraps Supabase so app.js never talks to it directly.
// Governance lives in the database (RLS + propose()/decide()/withdraw() functions);
// this is just a thin client over it. All methods are async and throw on error.

(function () {
  const cfg = window.LEADERBOARD_CONFIG || {};
  const hasConfig = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

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
  const ATHLETE_COLUMNS = 'id, name, bench, squat, deadlift, lifts, achievements, bodyweight, archived_at, updated_at';
  const PROFILE_COLUMNS = 'user_id, github_login, is_admin, status, athlete_id';
  const PROPOSAL_COLUMNS = 'id, kind, approval, athlete_id, proposer, payload, status, created_at';
  const PLAN_COLUMNS = 'id, owner, starts_at, activity, note, plan_joins(user_id, arrives_at, created_at)';
  const FRIDAY_JOIN_COLUMNS = 'day, user_id, arrives_at, created_at';

  const connected = () => {
    if (!client) throw new Error('Not connected to the leaderboard database.');
    return client;
  };
  const rows = async (query) => {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  };
  // Calls a database function: resolves to what it returns, throws what it raises.
  const call = (name, args) => rows(connected().rpc(name, args));
  // The one row an admin write touched. It is selected so that a write RLS refused, or a row
  // that is gone, cannot look successful: that comes back as "no rows" (PGRST116).
  const one = async (query, gone = 'That changed or your access expired. Reload and try again.') => {
    const { data, error } = await query.single();
    if (error?.code === 'PGRST116') throw new Error(gone);
    if (error) throw error;
    return data;
  };
  const RETURN_KEY = 'lb.return'; // the view to go back to after signing in

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

    // GitHub returns to the bare page (the only address Supabase allows), so the view the
    // visitor was on (?tv&tabs=…, #total) is kept for takeReturnView().
    async signIn() {
      try { sessionStorage.setItem(RETURN_KEY, window.location.search + window.location.hash); } catch { /* not remembered */ }
      const { error } = await connected().auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw error;
    },

    // The view sign-in left behind, handed out once; "" when there is none.
    takeReturnView() {
      try {
        const view = sessionStorage.getItem(RETURN_KEY) || '';
        sessionStorage.removeItem(RETURN_KEY);
        return view;
      } catch { return ''; }
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

    // Latest verified PRs across the board, newest first. Public through RLS.
    // Enough for the Latest feed and for 🔥 on every record of the past week.
    async listRecentPrs(limit = 60) {
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

    // Planned sessions starting in [from, to), each with who joins it. Members only: RLS
    // returns no rows to visitors and to members not yet on the board.
    async listPlans(from, to) {
      if (!client) return [];
      return rows(client.from('plans').select(PLAN_COLUMNS)
        .gte('starts_at', from).lt('starts_at', to).order('starts_at'));
    },

    // Who joins the Friday lift on the Fridays from fromDay up to toDay (YYYY-MM-DD). Members only.
    async listFridayJoins(fromDay, toDay) {
      if (!client) return [];
      return rows(client.from('friday_joins').select(FRIDAY_JOIN_COLUMNS).gte('day', fromDay).lt('day', toDay));
    },

    // --- governed writes (the database functions enforce all the rules) -----
    async propose(kind, athleteId, payload) { return call('propose', { p_kind: kind, p_athlete: athleteId, p_payload: payload || {} }); },
    async decide(proposalId, approve) { await call('decide', { p_id: proposalId, p_approve: approve }); },
    // The proposer retracts their own pending request.
    async withdraw(proposalId) { await call('withdraw', { p_id: proposalId }); },
    // A returning member puts their own archived athlete back on the boards.
    async restoreMyAthlete() { await call('restore_my_athlete'); },
    // A linked member shares, changes or clears (null) their own bodyweight, without review.
    async setMyBodyweight(kg) { await call('set_my_bodyweight', { p_bodyweight: kg }); },

    // Planner: create (id null) or change your own plan, remove it, join one (coming at
    // arrivesAt; joining again changes the time) or leave it.
    async savePlan(id, startsAt, activity, note) { return call('save_plan', { p_id: id, p_starts_at: startsAt, p_activity: activity, p_note: note }); },
    async deletePlan(id) { await call('delete_plan', { p_id: id }); },
    async joinPlan(id, join, arrivesAt = null) { await call('join_plan', { p_id: id, p_join: join, p_arrives_at: arrivesAt }); },
    // Join a Friday's lift (day: YYYY-MM-DD) coming at arrivesAt, change that time, or leave.
    async joinFriday(day, join, arrivesAt = null) { await call('join_friday', { p_day: day, p_join: join, p_arrives_at: arrivesAt }); },

    // --- admin-only direct writes (RLS gates these to admins) ---------------
    async adminUpdateProfile(userId, patch) {
      await one(connected().from('profiles').update(patch).eq('user_id', userId).select('user_id'));
    },
    async adminCreateAthlete(athlete) {
      return one(connected().from('athletes').insert(athlete).select(ATHLETE_COLUMNS));
    },
    // expectedUpdatedAt: the version the editor opened, so a concurrent change is not overwritten.
    async adminUpdateAthlete(id, patch, expectedUpdatedAt) {
      let query = connected().from('athletes').update(patch).eq('id', id);
      if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
      await one(query.select('id'), 'This athlete changed or your access expired. Reopen the editor and try again.');
    },
    // Archived athletes leave the boards but keep their records and verified history.
    async adminSetArchived(id, archived) {
      await one(connected().from('athletes').update({ archived_at: archived ? new Date().toISOString() : null })
        .eq('id', id).select('id'));
    },
    // Permanent: also erases their proposals, including verified history (for erasure requests).
    async adminDeleteAthlete(id) {
      await one(connected().from('athletes').delete().eq('id', id).select('id'));
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
      // The planner has a channel of its own, so trouble there never stops the boards' updates.
      const planner = client
        .channel('planner-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'plans' }, cb)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'plan_joins' }, cb)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'friday_joins' }, cb)
        .subscribe();
      return () => { client.removeChannel(channel); client.removeChannel(planner); };
    },
  };
})();
