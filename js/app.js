// Main UI controller for the Digdir Gym Leaderboard.
// Governance: admins manage everything; signed-in users claim an athlete (admin
// approves); linked users propose PR/achievement changes (peer-verified) and name
// changes / new athletes (admin-approved). The database enforces every rule; this is UI.
const { html, raw } = UI;
const REFRESH_CHECK_MS = 60000;
// A hung request must not freeze an unattended display: give up, show it, retry later.
const READ_TIMEOUT_MS = 20000;
const NAME_MAX = 80;
// Proposal kinds that mark an athlete as having a pending change on the board.
const ATHLETE_CHANGE_KINDS = ['pr', 'achievement', 'rename'];
const LATEST_LIMIT = 12;             // rows in the Latest PRs feed
const FRESH_MS = 7 * 86400000;       // 🔥 marks PRs verified within a week
const CELEBRATE_MS = 30 * 60000;     // cheer PRs verified in the last half hour

class LeaderboardApp {
  constructor() {
    this.athletes = [];
    this.profiles = [];
    this.proposals = [];
    this.recentPrs = [];
    this.seenPrIds = null; // verified PRs already on screen; null until the first load
    this.user = null;
    this.profile = null;
    this.activeTab = 'lifts';
    this.loading = true;
    this.loadError = null;
    this.realtimeConnected = false;
    this.busyActions = new Set();
    this.identityVersion = 0;
    this.readTimeoutMs = READ_TIMEOUT_MS;
    this.tv = new TvDisplay(this);
    this.ready = this.init();
  }

  // --- derived state --------------------------------------------------------
  get signedIn() { return !!this.user; }
  get isAdmin() { return !!this.profile?.is_admin && this.profile.status !== 'blocked'; }
  get isLinked() { return !!this.profile?.athlete_id; }
  get isActive() { return this.profile?.status === 'active' && this.isLinked; }
  get myAthleteId() { return this.profile?.athlete_id ?? null; }

  async init() {
    this.buildForms();
    this.bindEvents();
    UI.dialogs.setup();
    UI.dialogs.onChange((open) => (open ? this.tv.stop() : this.tv.restart()));
    const linked = location.hash.slice(1);
    if (document.getElementById(`${linked}-tab`)) this.switchTab(linked);
    this.reflectAuth();
    this.tv.apply(this.tv.enabled);
    if (!Store.configured) {
      this.loading = false;
      this.showConfigBanner();
      this.render();
      return;
    }

    Store.onAuthChange((session) => {
      if (session?.user?.id !== this.user?.id) {
        this.identityVersion++;
        this.user = session?.user ?? null;
        this.profile = null;
        this.profiles = [];
        this.proposals = [];
        UI.dialogs.closeAll();
        this.reflectAuth();
        this.render(); // Clear private pending markers even if the public data stays unchanged.
      }
      this.refreshAll();
    });
    Store.subscribe(() => this.refreshAll(), (status) => {
      this.realtimeConnected = status === 'SUBSCRIBED';
      this.updateBoardStatus();
      if (this.realtimeConnected) this.refreshAll();
    });
    await this.refreshAll();
    this.scheduleRefreshCheck();
    // Web fonts change text widths: re-measure the tab strip and TV pages once loaded.
    document.fonts?.ready.then(() => { this.revealActiveTab(); if (this.tv.enabled) this.tv.fit(); });
  }

  // --- data -----------------------------------------------------------------
  // A wall display may never regain focus. Periodically reconcile missed events
  // and failed reads even if the realtime connection claims to be healthy.
  scheduleRefreshCheck() {
    clearTimeout(this.refreshCheckTimer);
    if (!Store.configured || document.hidden) return;
    this.refreshCheckTimer = setTimeout(async () => {
      if (!document.hidden) await this.refreshAll();
      this.scheduleRefreshCheck();
    }, REFRESH_CHECK_MS);
  }

  // Serialize refreshes and coalesce bursts, while discarding responses for old identities.
  async refreshAll() {
    if (!Store.configured) return;
    this.refreshRequested = true;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      while (this.refreshRequested) {
        this.refreshRequested = false;
        const version = this.identityVersion;
        try {
          const board = await this.withTimeout(this.readBoard());
          if (version !== this.identityVersion) { this.refreshRequested = true; continue; }
          Object.assign(this, board, { loadError: null });
          this.cheerNewPrs();
        } catch (error) {
          if (version !== this.identityVersion) { this.refreshRequested = true; continue; }
          this.loadError = error;
        }
        this.loading = false;
        // Periodic checks that would draw what is already on screen must not replace
        // focused controls or redraw a dialog the visitor is reading.
        if (this.boardSnapshot() !== this.shownSnapshot) {
          this.reflectAuth();
          this.render();
          this.refreshOpenDialogs();
        } else this.updateBoardStatus();
      }
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async readBoard() {
    const session = await Store.getSession();
    const user = session?.user ?? null;
    const [athletes, recentPrs, profile, profiles, proposals] = await Promise.all([
      Store.listAthletes(),
      Store.listRecentPrs(),
      user ? Store.myProfile(user.id) : null,
      user ? Store.listProfiles() : [],
      user ? Store.listPendingProposals() : [],
    ]);
    return { user, athletes, recentPrs, profile, profiles, proposals };
  }

  withTimeout(promise, ms = this.readTimeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The leaderboard took too long to answer.')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // What the screen shows. The relative-time labels are part of it, so a periodic check
  // re-renders once "just now" should read "5 minutes ago" or a 🔥 week runs out, while
  // truly unchanged refreshes still leave focused controls and open dialogs alone.
  boardSnapshot() {
    return JSON.stringify([this.user, this.profile, this.athletes, this.profiles,
      this.proposals, this.recentPrs, this.loading, !!this.loadError,
      this.latestPrs().map((item) => UI.timeAgo(item.at)), [...this.freshPrs().keys()],
      this.proposals.map((p) => UI.timeAgo(p.created_at))]);
  }

  // Verified improvements, newest first, joined to athletes still on the board.
  latestPrs() {
    return this.recentPrs.map((p) => ({
      id: p.id, athlete: this.athleteById(p.athlete_id), lift: p.payload?.lift, at: p.decided_at,
      value: Number(p.payload?.value), previous: Number(p.payload?.previous_value ?? 0),
    })).filter((item) => item.athlete && Lifts.get(item.lift) && Lifts.improves(item.lift, item.previous, item.value))
      .slice(0, LATEST_LIMIT);
  }

  // "athleteId:liftId" → verified date, for recent PRs that are still the record.
  freshPrs(now = Date.now()) {
    const fresh = new Map();
    for (const item of this.latestPrs()) {
      const key = `${item.athlete.id}:${item.lift}`;
      if (now - Date.parse(item.at) < FRESH_MS && Lifts.value(item.athlete, item.lift) === item.value && !fresh.has(key)) fresh.set(key, item.at);
    }
    return fresh;
  }

  // Cheer a PR verified while the board is open: the office TV notices it too.
  cheerNewPrs() {
    const ids = this.recentPrs.map((p) => p.id);
    const seen = this.seenPrIds;
    this.seenPrIds = new Set(ids);
    if (!seen) return;
    const now = Date.now();
    const cheers = this.latestPrs().filter((item) => !seen.has(item.id) && now - Date.parse(item.at) < CELEBRATE_MS);
    if (cheers.length === 0) return;
    const [first] = cheers;
    const lift = Lifts.get(first.lift);
    const more = cheers.length > 1 ? ` (and ${cheers.length - 1} more)` : '';
    UI.toast(`🎉 New PR! ${first.athlete.name} · ${lift.emoji} ${lift.label} ${Lifts.formatUnit(first.lift, first.value)}${more}`, 'celebrate');
  }

  // --- lookups --------------------------------------------------------------
  athleteById(id) { return this.athletes.find((a) => a.id === id); }
  profileByUser(id) { return this.profiles.find((p) => p.user_id === id); }
  ownerOf(athleteId) { return this.profiles.find((p) => p.athlete_id === athleteId); }
  unclaimedAthletes() { return this.athletes.filter((a) => !this.ownerOf(a.id)); }
  // Proposals the current user may decide: admins everything, members their peers' PRs.
  reviewable() {
    if (!this.signedIn) return [];
    return this.proposals.filter((p) => this.isAdmin
      || (this.isActive && p.approval === 'peer' && p.proposer !== this.user.id));
  }
  ownRequests(kinds = null) {
    if (!this.signedIn) return [];
    return this.proposals.filter((p) => p.proposer === this.user.id && (!kinds || kinds.includes(p.kind)));
  }
  pendingAthletes() {
    return new Set(this.proposals.filter((p) => ATHLETE_CHANGE_KINDS.includes(p.kind)).map((p) => p.athlete_id));
  }

  // --- rendering ------------------------------------------------------------
  boardContext(podiumFits = true, hallTable = false) {
    return {
      athletes: this.athletes, tv: this.tv.enabled, loading: this.loading, error: !!this.loadError,
      pending: this.pendingAthletes(), fresh: this.freshPrs(), latest: this.latestPrs(),
      me: this.myAthleteId, podiumFits, hallTable, viewportHeight: window.innerHeight,
    };
  }

  render() {
    this.shownSnapshot = this.boardSnapshot();
    const ctx = this.boardContext();
    UI.keepFocus(() => {
      document.querySelectorAll('[data-board-group]').forEach((container) => {
        container.innerHTML = BoardView.group(container.dataset.boardGroup, ctx);
      });
      document.getElementById('hallOfFame').innerHTML = BoardView.hallOfFame(ctx);
    });
    this.updateReviewCount();
    this.updateBoardStatus();
    if (this.tv.enabled) this.tv.fit();
  }

  // Re-render one board in place (TV fitting decides whether its podium fits).
  renderBoard(liftId, podiumFits = true) {
    const current = document.querySelector(`.leaderboard-section[data-lift="${liftId}"]`);
    const template = document.createElement('template');
    template.innerHTML = BoardView.section(liftId, this.boardContext(podiumFits));
    const next = template.content.firstElementChild;
    current.replaceWith(next);
    return next;
  }

  // Re-render the Hall of Fame as badge cards, or as paged tables for a full TV screen.
  renderHallOfFame(asTables) {
    const root = document.getElementById('hallOfFame');
    root.innerHTML = BoardView.hallOfFame(this.boardContext(true, asTables));
    return root;
  }

  // Tabs with nothing to show are skipped by the TV rotation.
  hasContent(tab) {
    if (tab === 'other' || tab === 'cardio') return Lifts.inGroup(tab).length > 0;
    if (tab === 'latest') return this.latestPrs().length > 0;
    return !!document.getElementById(`${tab}-tab`);
  }

  updateReviewCount() {
    const badge = document.getElementById('reviewCount');
    const n = this.reviewable().length;
    badge.textContent = n;
    badge.hidden = n === 0;
  }

  updateBoardStatus() {
    const status = document.getElementById('boardStatus');
    const failed = !!this.loadError;
    const text = this.loading ? 'Opening the record book…'
      : failed ? (this.athletes.length ? 'Updates paused · showing the last loaded board' : 'Could not load the board')
      : !Store.configured ? 'Not connected'
      : this.realtimeConnected ? 'Live from the gym' : 'Board loaded · reconnecting…';
    // Only touch the live region when the message changes, so it isn't re-announced.
    if (status.textContent !== text) status.textContent = text;
    status.dataset.state = failed ? 'error' : this.realtimeConnected ? 'live' : 'idle';
    const count = `${this.athletes.length} ${this.athletes.length === 1 ? 'athlete' : 'athletes'} on the board`;
    document.getElementById('athleteCount').textContent = count;
    document.getElementById('retryBtn').hidden = !failed;
    document.querySelector('.board-meta').classList.toggle('connection-warning',
      !this.loading && (failed || !this.realtimeConnected));
  }

  // --- auth UI --------------------------------------------------------------
  reflectAuth() {
    const b = document.body.classList;
    b.toggle('signed-in', this.signedIn);
    b.toggle('is-admin', this.isAdmin);
    b.toggle('is-active', this.isActive);
    b.toggle('can-claim', this.signedIn && !this.isLinked && this.profile?.status !== 'blocked');
    b.toggle('can-review', this.signedIn && (this.isAdmin || this.isActive));

    const area = document.getElementById('authArea');
    if (!this.signedIn) {
      area.innerHTML = html`<button type="button" id="signInBtn" class="btn btn-primary" data-action="sign-in"${!Store.configured && raw(' disabled')}>Sign in with GitHub</button>`;
      return;
    }
    const name = Store.userLabel(this.user);
    const badge = this.isAdmin ? html`<span class="auth-user">🛡️ ${name} · admin</span>`
      : this.isActive ? html`<span class="auth-user">🏋️ ${name}</span>`
      : this.profile?.status === 'blocked' ? html`<span class="auth-user view-only">${name} · blocked</span>`
      : html`<span class="auth-user view-only" title="Claim an athlete and wait for an admin to approve">⏳ ${name} · awaiting a spot</span>`;
    area.innerHTML = html`${badge}<button type="button" id="signOutBtn" class="btn btn-ghost" data-action="sign-out">Sign out</button>`;
  }

  showConfigBanner() {
    const banner = document.createElement('div');
    banner.className = 'config-banner';
    banner.innerHTML = Store.connectionError
      ? html`${Store.connectionError.message}`
      : html`<strong>⚙️ Not connected yet.</strong> Set your Supabase URL/key in <code>js/config.js</code> and run <code>supabase/schema.sql</code>. See the README.`;
    document.querySelector('.container').prepend(banner);
  }

  // --- events ---------------------------------------------------------------
  bindEvents() {
    document.addEventListener('click', (e) => this.onAction(e, 'click'));
    document.addEventListener('change', (e) => this.onAction(e, 'change'));
    document.addEventListener('submit', (e) => this.onSubmit(e));
    const tabs = document.querySelector('.tab-navigation');
    tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab-btn');
      if (!tab) return;
      this.switchTab(tab.dataset.tab, { remember: true });
      this.tv.restart();
    });
    tabs.addEventListener('keydown', (e) => this.onTabKey(e));
    document.getElementById('athleteName').addEventListener('input', () => this.updateAvatarPreview());
    document.getElementById('achievementFields').addEventListener('change', () => this.updateAvatarPreview());
    document.getElementById('athleteFilter').addEventListener('input', () => this.renderAthletesList());
    document.addEventListener('input', (e) => { if (e.target.classList?.contains('time-input')) this.updateTimeHint(e.target); });

    // Fallback if a realtime event is missed: refresh when the tab regains focus.
    // Also pause/resume TV rotation so off-screen time doesn't burn through tabs.
    document.addEventListener('visibilitychange', () => {
      if (this.tv.enabled) (document.hidden ? this.tv.pause() : this.tv.resume());
      if (!document.hidden) this.refreshAll();
      this.scheduleRefreshCheck();
    });
    window.addEventListener('focus', () => this.refreshAll());
    window.addEventListener('online', () => this.refreshAll());
    window.addEventListener('hashchange', () => {
      const tab = location.hash.slice(1);
      if (document.getElementById(`${tab}-tab`) && tab !== this.activeTab) { this.switchTab(tab); this.tv.restart(); }
    });
    // Re-fit TV pagination when the screen size changes (e.g. the TV reconnects).
    let resizeTimer;
    window.addEventListener('resize', () => {
      if (!this.tv.enabled) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { this.render(); this.tv.restart(); }, 150);
    });
  }

  // One delegated action map for static and generated controls: no inline handlers.
  get actions() {
    return {
      'sign-in': () => Store.signIn(),
      'sign-out': () => Store.signOut(),
      'toggle-tv': () => this.tv.toggle(),
      retry: () => this.refreshAll(),
      'open-mine': () => this.openMine(),
      'open-claim': () => this.openClaim(),
      'open-review': () => this.openReview(),
      'open-members': () => this.openMembers(),
      'open-athletes': () => this.openAthletes(),
      'add-athlete': () => this.openAthleteEditor(),
      'close-dialog': (_id, el) => UI.dialogs.close(el.closest('dialog').id),
      history: (id) => this.openHistory(id),
      edit: (id) => this.openAthleteEditor(id),
      delete: (id) => this.deleteAthlete(id),
      approve: (id) => this.decide(id, true),
      reject: (id) => this.decide(id, false),
      withdraw: (id) => this.withdraw(id),
      link: (id, el) => this.adminLink(id, el.value),
      admin: (id, el) => this.adminToggleAdmin(id, el.checked),
      block: (id, el) => this.adminBlock(id, el.dataset.blocked === 'true'),
    };
  }

  onAction(event, type) {
    const target = event.target.closest?.('[data-action]');
    if (!target || (target.matches('input, select') ? 'change' : 'click') !== type) return;
    const action = this.actions[target.dataset.action];
    if (!action) return;
    const id = target.dataset.id;
    this.runAction(`${target.dataset.action}:${id ?? ''}`, target, () => action(id, target));
  }

  onSubmit(event) {
    const forms = { athleteForm: () => this.saveAthlete(), mineForm: () => this.submitMine(), claimForm: () => this.submitClaim() };
    const submit = forms[event.target.id];
    if (!submit) return;
    event.preventDefault();
    this.runAction(event.target.id, event.submitter, submit);
  }

  // Runs an action once at a time, marks its control busy while async work is
  // pending and reports failures. Synchronous openers keep focus on their trigger.
  async runAction(key, control, action) {
    if (this.busyActions.has(key)) return;
    this.busyActions.add(key);
    let busy = false;
    try {
      const result = action();
      if (result && typeof result.then === 'function') {
        busy = !!control;
        if (busy) { control.disabled = true; control.setAttribute('aria-busy', 'true'); }
        await result;
      }
    } catch (error) {
      UI.toast(this.errText(error), 'error');
    } finally {
      this.busyActions.delete(key);
      if (busy) { control.disabled = false; control.removeAttribute('aria-busy'); }
    }
  }

  errText(error) {
    const message = error?.message || String(error);
    return message.slice(0, 220) || 'Something went wrong';
  }

  onTabKey(event) {
    const tabs = [...document.querySelectorAll('.tab-btn')];
    const index = tabs.indexOf(event.target);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus();
  }

  // --- tabs -----------------------------------------------------------------
  // remember: a visitor's choice becomes the URL hash, so board links can be shared.
  switchTab(tab, { remember = false } = {}) {
    if (!document.getElementById(`${tab}-tab`)) return;
    this.activeTab = tab;
    document.querySelector('.skip-link').setAttribute('href', `#${tab}-tab`);
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
      b.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `${tab}-tab`));
    this.revealActiveTab();
    if (remember && !this.tv.enabled) history.replaceState(null, '', `#${tab}`);
    this.tv.onTabChange();
  }

  // A phone's tab strip scrolls sideways: keep the selected tab in view.
  revealActiveTab() {
    const button = document.querySelector('.tab-btn.active');
    const strip = button.parentElement;
    const outer = strip.getBoundingClientRect(), box = button.getBoundingClientRect();
    if (box.left < outer.left) strip.scrollLeft -= outer.left - box.left + 16;
    else if (box.right > outer.right) strip.scrollLeft += box.right - outer.right + 16;
  }

  // --- forms: fields from the registries --------------------------------------
  buildForms() {
    const checks = (cls) => html`${window.ACHIEVEMENTS.map((a) => html`<label class="form-check"><input type="checkbox" class="${cls}" value="${a.id}"><span><span aria-hidden="true">${a.emoji}</span> ${a.name}</span></label>`)}`;
    document.getElementById('achievementFields').innerHTML = checks('achievement-check');
    document.getElementById('mineAchievementFields').innerHTML = checks('mine-achievement-check');
    document.getElementById('mineLiftFields').innerHTML = this.liftFields('mine');
    document.getElementById('adminLiftFields').innerHTML = this.liftFields('admin');
  }

  // One fieldset per board group; each input is named after its exercise id.
  liftFields(prefix) {
    return html`${Lifts.groups.filter((g) => Lifts.inGroup(g.id).length).map((g) => html`
      <fieldset class="lift-fields">
        <legend class="form-section-title"><span aria-hidden="true">${g.emoji}</span> ${g.label}</legend>
        <div class="form-grid">${Lifts.inGroup(g.id).map((e) => html`
          <div class="form-group">
            <label for="${prefix}-${e.id}"><span aria-hidden="true">${e.emoji}</span> ${e.label} <span class="unit">(${Lifts.unitHint(e.id)})</span></label>
            ${e.unit === 'time'
              ? html`<input type="text" id="${prefix}-${e.id}" class="time-input" inputmode="decimal" autocomplete="off" placeholder="m:ss" pattern="[0-9]+([:.,][0-5][0-9])?" title="Minutes and seconds, like 1:30" aria-describedby="${prefix}-${e.id}-hint"><span class="field-hint" id="${prefix}-${e.id}-hint" aria-live="polite"></span>`
              : html`<input type="number" id="${prefix}-${e.id}" min="0" max="${Lifts.MAX}" step="${e.unit === 'kg' ? '0.1' : '1'}" inputmode="${e.unit === 'kg' ? 'decimal' : 'numeric'}" placeholder="0"><span class="field-hint"></span>`}
          </div>`)}
        </div>
      </fieldset>`)}`;
  }

  fillLiftFields(prefix, athlete) {
    for (const e of Lifts.all) {
      const input = document.getElementById(`${prefix}-${e.id}`);
      input.value = athlete ? Lifts.inputValue(e.id, Lifts.value(athlete, e.id)) : '';
      if (e.unit === 'time') this.updateTimeHint(input);
    }
  }

  // Say how a time entry will be read: "90" means 1:30, and "130" is 2:10, not 1:30.
  updateTimeHint(input) {
    const hint = document.getElementById(`${input.id}-hint`);
    const raw = input.value.trim();
    const seconds = Lifts.parseTime(raw);
    hint.textContent = !raw || /^\d+:[0-5]\d$/.test(raw) ? ''
      : Number.isFinite(seconds) ? `= ${Lifts.formatTime(seconds)}` : 'use m:ss, like 1:30';
  }

  readLift(liftId, inputId) {
    const input = document.getElementById(inputId);
    const value = Lifts.parse(liftId, input.value);
    if (!Number.isFinite(value)) {
      input.focus();
      const hint = Lifts.unit(liftId) === 'time' ? 'm:ss or whole seconds'
        : Lifts.unit(liftId) === 'reps' ? 'a whole number' : 'kilograms with at most one decimal';
      throw new Error(`${Lifts.get(liftId).label}: enter ${hint} (maximum ${Lifts.MAX}).`);
    }
    return value;
  }

  readName(inputId) {
    const name = document.getElementById(inputId).value.trim();
    if (!name || name.length > NAME_MAX) throw new Error(`Enter a name between 1 and ${NAME_MAX} characters.`);
    return name;
  }

  // Pending requests by the signed-in member, each with a Withdraw button.
  renderOwnRequests(containerId, kinds) {
    const el = document.getElementById(containerId);
    const mine = this.ownRequests(kinds);
    el.hidden = mine.length === 0;
    el.innerHTML = html`<h3 class="form-section-title">⏳ Waiting for approval</h3>
      <ul class="request-list">${mine.map((p) => html`<li>
        <span>${this.describeRequest(p)}</span>
        <button type="button" class="btn btn-ghost btn-small" data-action="withdraw" data-id="${p.id}" aria-label="Withdraw ${this.requestLabel(p)}">Withdraw</button>
      </li>`)}</ul>`;
  }

  // --- claim ------------------------------------------------------------------
  openClaim() {
    if (!this.signedIn) return UI.toast('Sign in first', 'error');
    if (this.isLinked) return UI.toast("You're already linked to an athlete", 'error');
    const unclaimed = this.unclaimedAthletes();
    const select = document.getElementById('claimSelect');
    select.innerHTML = html`<option value="">${unclaimed.length ? '— choose an existing athlete —' : '— every athlete is claimed; add yourself below —'}</option>${
      unclaimed.map((a) => html`<option value="${a.id}">${a.name}</option>`)}`;
    select.disabled = unclaimed.length === 0;
    document.getElementById('claimNewName').value = '';
    this.renderOwnRequests('claimPending', ['claim', 'new_athlete']);
    UI.dialogs.open('claimModal');
  }

  async submitClaim() {
    const athleteId = document.getElementById('claimSelect').value;
    const newName = document.getElementById('claimNewName').value.trim();
    if (newName && athleteId) throw new Error('Choose an existing athlete or enter a new name, not both.');
    if (!newName && !athleteId) throw new Error('Pick an athlete or enter your name.');
    if (newName) await Store.propose('new_athlete', null, { name: this.readName('claimNewName') });
    else await Store.propose('claim', athleteId, {});
    UI.dialogs.close('claimModal');
    await this.refreshAll();
    UI.toast('Request sent — an admin will approve it', 'success');
  }

  // --- my athlete (propose changes) -------------------------------------------
  openMine() {
    if (!this.isActive) return UI.toast('Claim an athlete first (and wait for approval)', 'error');
    const a = this.athleteById(this.myAthleteId);
    if (!a) return UI.toast('Your athlete is missing', 'error');
    document.getElementById('mineName').value = a.name;
    this.fillLiftFields('mine', a);
    const earned = a.achievements || [];
    document.querySelectorAll('.mine-achievement-check').forEach((c) => { c.checked = earned.includes(c.value); });
    this.mineSnapshot = {
      name: a.name, achievements: [...earned],
      values: Object.fromEntries(Lifts.all.map((e) => [e.id, Lifts.value(a, e.id)])),
    };
    this.renderOwnRequests('minePending', null);
    UI.dialogs.open('mineModal');
  }

  async submitMine() {
    const a = this.athleteById(this.myAthleteId);
    const snap = this.mineSnapshot;
    if (!a || !snap || !this.isActive) throw new Error('Your athlete is no longer available. Reopen My PRs.');
    const proposals = [];
    const name = this.readName('mineName');
    if (name !== snap.name) proposals.push(['rename', { name }]);
    for (const e of Lifts.all) {
      const value = this.readLift(e.id, `mine-${e.id}`);
      if (value !== snap.values[e.id]) proposals.push(['pr', { lift: e.id, value }]);
    }
    const checked = [...document.querySelectorAll('.mine-achievement-check')].filter((c) => c.checked).map((c) => c.value);
    for (const id of checked) if (!snap.achievements.includes(id)) proposals.push(['achievement', { achievement_id: id, op: 'add' }]);
    // Only achievements with a form field can be removed from here.
    for (const id of snap.achievements) if (window.getAchievement(id) && !checked.includes(id)) proposals.push(['achievement', { achievement_id: id, op: 'remove' }]);

    if (proposals.length === 0) { UI.dialogs.close('mineModal'); return UI.toast('No changes', 'success'); }
    for (const [kind, payload] of proposals) {
      await Store.propose(kind, a.id, payload);
      // Remember accepted fields so a retry after a failure sends only the rest.
      if (kind === 'rename') snap.name = payload.name;
      else if (kind === 'pr') snap.values[payload.lift] = payload.value;
      else if (payload.op === 'add') snap.achievements.push(payload.achievement_id);
      else snap.achievements = snap.achievements.filter((id) => id !== payload.achievement_id);
    }
    UI.dialogs.close('mineModal');
    await this.refreshAll();
    const peer = proposals.filter(([kind]) => kind !== 'rename').length;
    const admin = proposals.length - peer;
    UI.toast(`Submitted — ${[peer && `${peer} awaiting a peer`, admin && `${admin} awaiting an admin`].filter(Boolean).join(', ')}`, 'success');
  }

  async withdraw(id) {
    await Store.withdraw(id);
    await this.refreshAll();
    UI.toast('Request withdrawn', 'success');
  }

  // --- review queue -----------------------------------------------------------
  openReview() {
    if (!(this.isAdmin || this.isActive)) return UI.toast('Only members can review', 'error');
    this.renderReview();
    UI.dialogs.open('reviewModal');
  }

  // What a request changes, e.g. "Daniel: Bench Press 136.0 → 145.0 kg (+9.0 kg)".
  describeRequest(p) {
    const athlete = this.athleteById(p.athlete_id);
    const name = athlete?.name || p.payload?.name || 'an athlete';
    switch (p.kind) {
      case 'pr': {
        const lift = Lifts.get(p.payload.lift) || { emoji: '', label: p.payload.lift };
        const before = p.payload.previous_value ?? (athlete ? Lifts.value(athlete, p.payload.lift) : null);
        const after = Number(p.payload.value);
        const delta = before != null && Number(before) > 0 && after > 0
          && html` <span class="delta ${Lifts.improves(p.payload.lift, before, after) ? 'up' : 'down'}">${Lifts.formatDelta(p.payload.lift, after - Number(before))}</span>`;
        const from = before != null && Number(before) > 0 && html`${Lifts.format(p.payload.lift, before)} → `;
        return html`<strong>${name}</strong>: <span aria-hidden="true">${lift.emoji}</span> ${lift.label} ${from}<strong>${after > 0 ? Lifts.formatUnit(p.payload.lift, after) : 'clear entry'}</strong>${delta}`;
      }
      case 'achievement': {
        const ach = window.getAchievement(p.payload.achievement_id);
        return html`<strong>${name}</strong>: ${p.payload.op === 'add' ? 'earn' : 'remove'} ${ach ? html`<span aria-hidden="true">${ach.emoji}</span> ${ach.name}` : p.payload.achievement_id}`;
      }
      case 'rename': return html`<strong>${name}</strong>: rename to <strong>${p.payload.name}</strong>`;
      case 'new_athlete': return html`Add a new athlete: <strong>${p.payload.name}</strong>`;
      case 'claim': return html`Link to athlete <strong>${name}</strong>`;
      default: return html`${p.kind}`;
    }
  }

  // Plain words for a request, for control labels: "Approve Bench Press PR for Daniel".
  requestLabel(p) {
    const name = this.athleteById(p.athlete_id)?.name || p.payload?.name || 'an athlete';
    switch (p.kind) {
      case 'pr': return `${Lifts.get(p.payload.lift)?.label || p.payload.lift} PR for ${name}`;
      case 'achievement': return `${window.getAchievement(p.payload.achievement_id)?.name || p.payload.achievement_id} for ${name}`;
      case 'rename': return `rename of ${name}`;
      case 'new_athlete': return `new athlete ${p.payload.name}`;
      case 'claim': return `claim of ${name}`;
      default: return p.kind;
    }
  }

  // A PR request is stale once the record changed after it was submitted.
  isStale(p) {
    if (p.kind !== 'pr' || p.payload?.previous_value == null) return false;
    const athlete = this.athleteById(p.athlete_id);
    return !!athlete && Lifts.value(athlete, p.payload.lift) !== Number(p.payload.previous_value);
  }

  renderReview() {
    const list = document.getElementById('reviewList');
    const items = this.reviewable().filter((p) => p.proposer !== this.user?.id);
    const own = this.ownRequests();
    const row = (p, actions) => {
      const who = this.profileByUser(p.proposer)?.github_login;
      const stale = this.isStale(p);
      return html`<div class="review-row">
        <div class="review-desc">
          <span class="tag ${p.approval === 'peer' ? 'tag-peer' : 'tag-admin'}">${p.approval === 'peer' ? 'peer' : 'admin'}</span>
          ${this.describeRequest(p)}
          <span class="by">· ${who ? `@${who}` : 'someone'}${p.created_at && ` · ${UI.timeAgo(p.created_at)}`}</span>
          ${stale && html`<span class="tag tag-warn" title="The record changed after this was submitted">outdated — reject it and submit again</span>`}
        </div>
        <div class="review-actions">${actions(stale)}</div>
      </div>`;
    };
    const approve = (p) => html`<button type="button" class="btn btn-edit" data-action="approve" data-id="${p.id}" aria-label="Approve ${this.requestLabel(p)}">Approve</button>`;
    const decide = (p) => (stale) => html`${!stale && approve(p)}<button type="button" class="btn btn-danger" data-action="reject" data-id="${p.id}" aria-label="Reject ${this.requestLabel(p)}">Reject</button>`;
    const retract = (p) => () => html`${this.isAdmin && approve(p)}<button type="button" class="btn btn-ghost" data-action="withdraw" data-id="${p.id}" aria-label="Withdraw ${this.requestLabel(p)}">Withdraw</button>`;
    if (items.length === 0 && own.length === 0) {
      list.innerHTML = html`<p class="empty-state">Nothing to review right now. 🎉</p>`;
      return;
    }
    list.innerHTML = html`
      ${items.length > 0 && html`<h3 class="form-section-title">To review</h3>${items.map((p) => row(p, decide(p)))}`}
      ${own.length > 0 && html`<h3 class="form-section-title">Your requests</h3>${own.map((p) => row(p, retract(p)))}`}`;
  }

  async decide(id, approve) {
    await Store.decide(id, approve);
    await this.refreshAll();
    UI.toast(approve ? 'Approved' : 'Rejected', 'success');
  }

  // --- admin: members ---------------------------------------------------------
  openMembers() {
    if (!this.isAdmin) return UI.toast('Admins only', 'error');
    this.renderMembers();
    UI.dialogs.open('adminModal');
  }

  renderMembers() {
    const list = document.getElementById('usersList');
    if (this.profiles.length === 0) { list.innerHTML = html`<p class="empty-state">No members yet.</p>`; return; }
    const order = { pending: 0, active: 1, blocked: 2 };
    const sorted = [...this.profiles].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)
      || (a.github_login || '').localeCompare(b.github_login || ''));
    list.innerHTML = html`${sorted.map((p) => {
      const self = p.user_id === this.user?.id;
      const linked = this.athleteById(p.athlete_id);
      const asks = this.proposals.filter((q) => q.proposer === p.user_id && ['claim', 'new_athlete'].includes(q.kind));
      const login = p.github_login || p.user_id;
      const options = this.athletes.map((a) => {
        const takenBy = this.ownerOf(a.id);
        const taken = takenBy && takenBy.user_id !== p.user_id;
        return html`<option value="${a.id}"${a.id === p.athlete_id && raw(' selected')}${taken && raw(' disabled')}>${a.name}${taken && ' (claimed)'}</option>`;
      });
      const selfNote = self && raw(' disabled title="You can\'t change your own admin access or block yourself"');
      return html`<div class="user-row">
        <div class="user-info">
          <strong>${login}</strong>${self && html` <span class="status-chip status-self">you</span>`}
          <span class="status-chip status-${p.status}">${p.status}</span>
          ${p.is_admin && html`<span class="status-chip status-admin">admin</span>`}
          ${linked && html`<span class="linked-to">→ ${linked.name}</span>`}
          ${asks.map((q) => html`<span class="linked-to">asks: ${q.kind === 'claim' ? this.athleteById(q.athlete_id)?.name || 'an athlete' : `new athlete “${q.payload.name}”`}</span>`)}
        </div>
        <div class="user-controls">
          <select aria-label="Linked athlete for ${login}" data-action="link" data-id="${p.user_id}"><option value="">— not linked —</option>${options}</select>
          <label class="form-check"><input type="checkbox"${p.is_admin && raw(' checked')} data-action="admin" data-id="${p.user_id}" aria-label="Admin access for ${login}"${selfNote}> admin</label>
          <button type="button" class="btn btn-ghost" data-action="block" data-id="${p.user_id}" data-blocked="${p.status === 'blocked'}" aria-label="${p.status === 'blocked' ? 'Unblock' : 'Block'} ${login}"${selfNote}>${p.status === 'blocked' ? 'Unblock' : 'Block'}</button>
        </div>
      </div>`;
    })}`;
  }

  // Member edits re-render on failure, so a control never shows an unsaved state.
  async updateMember(userId, patch) {
    try {
      await Store.adminUpdateProfile(userId, patch);
    } catch (error) {
      UI.keepFocus(() => this.renderMembers());
      throw error;
    }
    await this.refreshAll();
    UI.toast('Updated', 'success');
  }
  adminLink(userId, athleteId) {
    // Linking never silently unblocks; Unblock stays an explicit action.
    const status = this.profileByUser(userId)?.status === 'blocked' ? 'blocked' : athleteId ? 'active' : 'pending';
    return this.updateMember(userId, { athlete_id: athleteId || null, status });
  }
  adminToggleAdmin(userId, isAdmin) { return this.updateMember(userId, { is_admin: isAdmin }); }
  adminBlock(userId, currentlyBlocked) {
    const status = currentlyBlocked ? (this.profileByUser(userId)?.athlete_id ? 'active' : 'pending') : 'blocked';
    return this.updateMember(userId, { status });
  }

  // --- admin: athletes (direct edits) -----------------------------------------
  openAthletes() {
    if (!this.isAdmin) return UI.toast('Admins only', 'error');
    document.getElementById('athleteFilter').value = '';
    this.renderAthletesList();
    UI.dialogs.open('manageModal');
  }

  renderAthletesList() {
    const container = document.getElementById('athletesList');
    if (this.athletes.length === 0) { container.innerHTML = html`<p class="empty-state">No athletes yet.</p>`; return; }
    const query = document.getElementById('athleteFilter').value.trim().toLocaleLowerCase();
    const shown = [...this.athletes].sort((a, b) => a.name.localeCompare(b.name))
      .filter((a) => !query || a.name.toLocaleLowerCase().includes(query));
    if (shown.length === 0) { container.innerHTML = html`<p class="empty-state">No athlete matches “${query}”.</p>`; return; }
    const pending = this.pendingAthletes();
    container.innerHTML = html`${shown.map((a) => {
      const owner = this.ownerOf(a.id);
      const stats = [...Lifts.all, Lifts.get('total')].filter((e) => Lifts.value(a, e.id) > 0);
      return html`<div class="athlete-card">
        <div class="athlete-card-avatar">${raw(window.renderAvatar(a, 52, { decorative: true }))}</div>
        <div class="athlete-card-info">
          <h3>${a.name}${BoardView.badges(a)}${pending.has(a.id) && raw('<span class="badge-chip pending" title="Has a pending change">⏳</span>')}${owner && html`<span class="linked-to">@${owner.github_login}</span>`}</h3>
          <div class="athlete-stats">${stats.length ? stats.map((e) => html`<span title="${e.label}"><span aria-hidden="true">${e.emoji}</span> <strong>${Lifts.format(e.id, Lifts.value(a, e.id))}</strong></span>`) : html`<span>No records yet</span>`}</div>
        </div>
        <div class="athlete-card-actions">
          <button type="button" class="btn btn-edit" data-action="edit" data-id="${a.id}" aria-label="Edit ${a.name}">Edit</button>
          <button type="button" class="btn btn-danger" data-action="delete" data-id="${a.id}" aria-label="Delete ${a.name}">Delete</button>
        </div>
      </div>`;
    })}`;
  }

  openAthleteEditor(athleteId = null) {
    if (!this.isAdmin) return UI.toast('Admins only', 'error');
    const a = athleteId ? this.athleteById(athleteId) : null;
    if (athleteId && !a) throw new Error('This athlete is no longer on the board.');
    // The opening version detects concurrent edits; unknown data is preserved on save.
    this.editing = a ? structuredClone(a) : null;
    document.getElementById('modalTitle').textContent = a ? 'Edit athlete' : 'Add athlete';
    document.getElementById('athleteName').value = a?.name ?? '';
    this.fillLiftFields('admin', a);
    document.querySelectorAll('#achievementFields .achievement-check').forEach((c) => { c.checked = !!a?.achievements?.includes(c.value); });
    this.updateAvatarPreview();
    UI.dialogs.open('athleteModal');
  }

  updateAvatarPreview() {
    const name = document.getElementById('athleteName').value || 'New athlete';
    const achievements = [...document.querySelectorAll('#achievementFields .achievement-check')].filter((c) => c.checked).map((c) => c.value);
    document.getElementById('avatarPreview').innerHTML = window.renderAvatar({ name, achievements }, 110);
  }

  async saveAthlete() {
    const original = this.editing;
    const data = { name: this.readName('athleteName') };
    for (const id of Lifts.main) data[id] = this.readLift(id, `admin-${id}`);
    // Keep unknown extra-lift keys and unregistered achievements from older versions.
    data.lifts = { ...(original?.lifts || {}) };
    for (const e of Lifts.extra) data.lifts[e.id] = this.readLift(e.id, `admin-${e.id}`);
    data.achievements = [
      ...(original?.achievements || []).filter((id) => !window.getAchievement(id)),
      ...[...document.querySelectorAll('#achievementFields .achievement-check')].filter((c) => c.checked).map((c) => c.value),
    ];
    if (original) await Store.adminUpdateAthlete(original.id, data, original.updated_at);
    else await Store.adminCreateAthlete(data);
    UI.dialogs.close('athleteModal');
    await this.refreshAll();
    UI.toast('Saved', 'success');
  }

  async deleteAthlete(id) {
    const a = this.athleteById(id);
    if (!confirm(`Delete ${a?.name ?? 'this athlete'}? Their verified PR history is deleted too. This can't be undone.`)) return;
    await Store.adminDeleteAthlete(id);
    await this.refreshAll();
    UI.toast('Deleted', 'success');
  }

  // --- history / progression --------------------------------------------------
  // Verified PRs are approved 'pr' proposals; HistoryView draws them per exercise.
  openHistory(athleteId) {
    const a = this.athleteById(athleteId);
    if (!a) return;
    this.historyAthleteId = athleteId;
    document.getElementById('historyTitle').textContent = `📈 ${a.name} — progression`;
    document.getElementById('historyBody').innerHTML = html`<p class="empty-state">Loading…</p>`;
    UI.dialogs.open('historyModal');
    this.reloadHistory();
  }

  async reloadHistory() {
    const request = this.historyRequest = (this.historyRequest || 0) + 1;
    const id = this.historyAthleteId;
    const body = document.getElementById('historyBody');
    if (!this.athleteById(id)) return;
    // Bail if the visitor switched or closed the dialog while we were fetching.
    const current = () => request === this.historyRequest && this.historyAthleteId === id && UI.dialogs.isOpen('historyModal');
    try {
      const rows = await Store.listAthleteHistory(id);
      if (current()) body.innerHTML = HistoryView.render(rows, this.athleteById(id));
    } catch (error) {
      if (current()) body.innerHTML = html`<p class="empty-state">${this.errText(error)}</p>`;
    }
  }

  refreshOpenDialogs() {
    UI.keepFocus(() => {
      if (UI.dialogs.isOpen('reviewModal')) this.renderReview();
      if (UI.dialogs.isOpen('adminModal')) this.renderMembers();
      if (UI.dialogs.isOpen('manageModal')) this.renderAthletesList();
      if (UI.dialogs.isOpen('mineModal')) this.renderOwnRequests('minePending', null);
      if (UI.dialogs.isOpen('claimModal')) this.renderOwnRequests('claimPending', ['claim', 'new_athlete']);
    });
    if (UI.dialogs.isOpen('historyModal')) this.reloadHistory();
  }
}

let app;
document.addEventListener('DOMContentLoaded', () => { app = new LeaderboardApp(); });
