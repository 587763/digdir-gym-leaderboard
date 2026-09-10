// Main UI controller for the Digdir Gym Leaderboard.
// Governance: admins manage everything; signed-in users claim an athlete (admin
// approves); linked users propose PR/achievement changes (peer-verified) and name
// changes / new athletes (admin-approved). Rules are enforced in the DB; this is UI.

const LIFTS = window.Lifts.main;
const LIFT_META = window.Lifts.meta;
const TV_PAGE_PAD = 48;
const TV_MIN_DWELL_MS = 5000;
const REFRESH_CHECK_MS = 60000;

// Extra-lift tabs: a lift's `group` (js/lifts.js; default 'other') routes its board
// to one of these tabs, each backed by a DOM container. Both draw from athletes.lifts.
const OTHER_LIFT_TABS = [
  { tab: 'other',  container: 'otherLiftsBoards' },
  { tab: 'cardio', container: 'cardioBoards' },
];
const liftGroup = (l) => l.group || 'other';

class LeaderboardApp {
  constructor() {
    this.athletes = [];
    this.profiles = [];
    this.proposals = [];
    this.user = null;
    this.profile = null;
    this.editingId = null;
    this.mineSnapshot = null;
    this.activeTab = 'lifts';

    // TV / display mode: ?tv (or the saved toggle) shows a big landscape layout and
    // cycles the tabs hands-free; ?rotate=<seconds> overrides the 15s default.
    const params = new URLSearchParams(location.search);
    let savedTv = false;
    try { savedTv = localStorage.getItem('lb.tv') === '1'; } catch { /* Storage may be disabled. */ }
    this.tvMode = params.has('tv') || savedTv;
    this.rotateMs = Math.min(120000, Math.max(5000, (Number(params.get('rotate')) || 15) * 1000));
    this.rotateTimer = null;
    this.tvPage = 0;   // current page within the active tab (TV mode paginates tall boards)
    this.tvPages = 1;  // page count for the active tab, recomputed by fitTvPaging

    this.busyActions = new Set();
    this.identityVersion = 0;
    this.loading = true;
    this.ready = this.init();
  }

  // --- derived state --------------------------------------------------------
  get signedIn() { return !!this.user; }
  get isAdmin() { return !!this.profile?.is_admin && this.profile.status !== 'blocked'; }
  get isLinked() { return !!this.profile?.athlete_id; }
  get isActive() { return this.profile?.status === 'active' && this.isLinked; }
  get myAthleteId() { return this.profile?.athlete_id ?? null; }

  async init() {
    this.buildAchievementFields('achievementFields');
    this.buildAchievementFields('mineAchievementFields');
    this.buildOtherLiftSections();
    this.buildOtherLiftFields('mineOtherLiftFields', 'mineOther_', true, false);
    this.buildOtherLiftFields('adminOtherLiftFields', 'adminOther_', false, true);
    this.setupEventListeners();

    this.reflectAuth();
    this.applyTvMode(this.tvMode);
    if (!window.Store.configured) {
      this.loading = false;
      this.showConfigBanner();
      this.render();
      return;
    }

    window.Store.onAuthChange((session) => {
      if (session?.user?.id !== this.user?.id) {
        this.identityVersion++;
        this.user = session?.user ?? null;
        this.profile = null;
        this.profiles = [];
        this.proposals = [];
        this.closeAll();
        this.reflectAuth();
        this.render(); // Clear private pending markers even if the public data stays unchanged.
      }
      this.refreshAll();
    });
    window.Store.subscribe(() => this.refreshAll(), (status) => {
      this.realtimeConnected = status === 'SUBSCRIBED';
      this.updateBoardStatus();
      if (this.realtimeConnected) this.refreshAll();
    });
    await this.refreshAll();
    this.scheduleRefreshCheck();
    document.fonts?.ready.then(() => { if (this.tvMode) this.fitTvPaging(); });
  }

  // A wall display may never regain focus. Periodically reconcile missed events
  // and failed reads even if the realtime connection claims to be healthy.
  scheduleRefreshCheck() {
    clearTimeout(this.refreshCheckTimer);
    if (!window.Store.configured || document.hidden) return;
    this.refreshCheckTimer = setTimeout(async () => {
      if (!document.hidden) await this.refreshAll();
      this.scheduleRefreshCheck();
    }, REFRESH_CHECK_MS);
  }

  // Serialize refreshes and coalesce bursts, while discarding responses for old identities.
  async refreshAll() {
    if (!window.Store.configured) return;
    this.refreshRequested = true;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      while (this.refreshRequested) {
        this.refreshRequested = false;
        const version = this.identityVersion;
        const before = this.boardSnapshot();
        try {
          const session = await window.Store.getSession();
          const user = session?.user ?? null;
          const [athletes, profile, profiles, proposals] = await Promise.all([
            window.Store.listAthletes(),
            user ? window.Store.myProfile(user.id) : null,
            user ? window.Store.listProfiles() : [],
            user ? window.Store.listPendingProposals() : [],
          ]);
          if (version !== this.identityVersion) { this.refreshRequested = true; continue; }
          Object.assign(this, { user, athletes, profile, profiles, proposals, loadError: null });
        } catch (error) {
          if (version !== this.identityVersion) { this.refreshRequested = true; continue; }
          this.loadError = error;
        }
        this.loading = false;
        // Periodic checks with unchanged data must not replace focused controls
        // or redraw a history dialog the visitor is reading.
        if (before !== this.boardSnapshot()) {
          this.reflectAuth();
          this.render();
          this.refreshOpenModals();
        } else this.updateBoardStatus();
      }
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  boardSnapshot() {
    return JSON.stringify([this.user, this.profile, this.athletes, this.profiles,
      this.proposals, this.loading, !!this.loadError]);
  }

  updateBoardStatus() {
    const status = document.getElementById('boardStatus');
    const count = document.getElementById('athleteCount');
    count.textContent = `${this.athletes.length} ${this.athletes.length === 1 ? 'athlete' : 'athletes'} on the board`;
    const failed = !!this.loadError;
    status.dataset.state = failed ? 'error' : this.realtimeConnected ? 'live' : 'idle';
    status.textContent = this.loading ? 'Opening the record book…'
      : failed ? (this.athletes.length ? 'Updates paused · showing the last loaded board' : 'Could not load the board')
      : !window.Store.configured ? 'Not connected'
      : this.realtimeConnected ? 'Live from the gym' : 'Board loaded · reconnecting…';
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
      area.innerHTML = `<button id="signInBtn" class="btn btn-primary" ${window.Store.configured ? '' : 'disabled'}>Sign in with GitHub</button>`;
      document.getElementById('signInBtn').onclick = (e) => this.runAction('auth', e.currentTarget, () => window.Store.signIn());
      return;
    }
    const name = this.escapeHtml(window.Store.userLabel(this.user));
    let badge;
    if (this.isAdmin) badge = `<span class="auth-user">🛡️ ${name} · admin</span>`;
    else if (this.isActive) badge = `<span class="auth-user">🏋️ ${name}</span>`;
    else if (this.profile?.status === 'blocked') badge = `<span class="auth-user view-only">${name} · blocked</span>`;
    else badge = `<span class="auth-user view-only" title="Claim an athlete and wait for an admin to approve">⏳ ${name} · awaiting a spot</span>`;
    area.innerHTML = `${badge}<button id="signOutBtn" class="btn btn-ghost">Sign out</button>`;
    document.getElementById('signOutBtn').onclick = (e) => this.runAction('auth', e.currentTarget, () => window.Store.signOut());
  }

  // --- setup ----------------------------------------------------------------
  buildAchievementFields(containerId) {
    const cls = containerId === 'mineAchievementFields' ? 'mine-achievement-check' : 'achievement-check';
    document.getElementById(containerId).innerHTML = window.ACHIEVEMENTS.map(
      (a) => `<label class="form-check"><input type="checkbox" class="${cls}" value="${a.id}"><span>${a.emoji} ${this.escapeHtml(a.name)}</span></label>`
    ).join('');
  }

  // One leaderboard section per "other lift" (js/lifts.js), grouped into its tab
  // (Other Lifts / Cardio). Every board has its own podium.
  buildOtherLiftSections() {
    for (const { tab, container } of OTHER_LIFT_TABS) {
      const root = document.getElementById(container);
      if (!root) continue;
      const lifts = window.OTHER_LIFTS.filter((l) => liftGroup(l) === tab);
      if (lifts.length === 0) {
        root.innerHTML = '<p class="empty-state">Nothing here yet.</p>';
        continue;
      }
      root.innerHTML = lifts.map((l) => {
        const head = l.unit === 'time' ? 'Time (m:ss)' : l.unit === 'reps' ? 'Reps' : 'PR (kg)';
        return `<div class="leaderboard-section" data-lift="${l.id}">
          <h2>${l.emoji} ${this.escapeHtml(l.label)}</h2>
          <table class="leaderboard-table" id="${l.id}Table"><thead><tr><th scope="col">Rank</th><th scope="col">Name</th><th scope="col">${head}</th></tr></thead><tbody></tbody></table>
        </div>`;
      }).join('');
    }
  }

  // Inputs for the "other lifts", reused by the My-PRs (peer) and admin forms.
  // Time lifts get a text field entered as m:ss (parseLiftTime); others stay numeric.
  buildOtherLiftFields(containerId, prefix, peer, zero) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = window.OTHER_LIFTS.map((l) => {
      const tag = peer ? ' <span class="tag tag-peer">peer verify</span>' : '';
      if (l.unit === 'time') {
        return `<div class="form-group"><label for="${prefix}${l.id}">${l.emoji} ${this.escapeHtml(l.label)} (m:ss)${tag}</label><input type="text" inputmode="numeric" pattern="([0-9]+:[0-5][0-9])|[0-9]+" placeholder="m:ss" id="${prefix}${l.id}"${zero ? ' value="0:00"' : ''}></div>`;
      }
      const unit = l.unit === 'reps' ? 'reps' : 'kg';
      const step = l.unit === 'kg' ? '0.1' : '1';
      return `<div class="form-group"><label for="${prefix}${l.id}">${l.emoji} ${this.escapeHtml(l.label)} (${unit})${tag}</label><input type="number" id="${prefix}${l.id}" step="${step}" min="0" max="99999"${zero ? ' value="0"' : ''}></div>`;
    }).join('');
  }

  // Prefill/read a single "other lift" input, formatting/parsing time as m:ss.
  otherLiftInputValue(l, raw) {
    return l.unit === 'time' ? window.formatLiftTime(raw) : (Number(raw) || 0);
  }
  readOtherLift(l, id) {
    return this.readLift(l.id, id);
  }

  setupEventListeners() {
    document.querySelectorAll('.tab-btn').forEach((btn) =>
      btn.addEventListener('click', () => { this.switchTab(btn.dataset.tab); this.restartRotationTimer(); }));
    document.getElementById('retryBtn').onclick = () => this.refreshAll();
    document.querySelector('.tab-navigation').addEventListener('keydown', (event) => {
      const tabs = [...document.querySelectorAll('.tab-btn')];
      const index = tabs.indexOf(event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click();
      tabs[next].focus();
    });
    document.getElementById('tvModeBtn').onclick = () => this.toggleTvMode();

    document.getElementById('myAthleteBtn').onclick = () => this.openMine();
    document.getElementById('claimBtn').onclick = () => this.openClaim();
    document.getElementById('reviewBtn').onclick = () => this.openReview();
    document.getElementById('adminBtn').onclick = () => this.openAdmin();
    document.getElementById('manageAthletesBtn').onclick = () => this.openManage();
    document.getElementById('addNewAthleteBtn').onclick = () => { this.closeAll(); this.openAthleteModal(); };

    document.getElementById('athleteForm').addEventListener('submit', (e) => { e.preventDefault(); this.runAction('save', e.submitter, () => this.saveAthlete()); });
    document.getElementById('mineForm').addEventListener('submit', (e) => { e.preventDefault(); this.runAction('mine', e.submitter, () => this.submitMine()); });
    document.getElementById('claimSubmit').onclick = (e) => this.runAction('claim', e.currentTarget, () => this.submitClaim());
    document.getElementById('athleteName').addEventListener('input', () => this.updateAvatarPreview());
    document.getElementById('achievementFields').addEventListener('change', () => this.updateAvatarPreview());

    document.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => this.closeModal(el.dataset.close)));
    window.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) this.closeModal(e.target.id);
    });
    window.addEventListener('keydown', (e) => this.handleModalKey(e));
    document.addEventListener('click', (e) => this.handleAction(e, 'click'));
    document.addEventListener('change', (e) => this.handleAction(e, 'change'));
    document.querySelectorAll('.modal').forEach((modal) => {
      const heading = modal.querySelector('h2');
      heading.id ||= `${modal.id}Title`;
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', heading.id);
      modal.tabIndex = -1;
    });

    // Fallback if a realtime event is missed: refresh when the tab regains focus.
    // Also pause/resume TV rotation so off-screen time doesn't burn through tabs.
    document.addEventListener('visibilitychange', () => {
      if (this.tvMode) (document.hidden ? this.stopRotation() : this.startRotation());
      if (!document.hidden) this.refreshAll();
      this.scheduleRefreshCheck();
    });
    window.addEventListener('focus', () => this.refreshAll());
    window.addEventListener('online', () => this.refreshAll());

    // Re-fit TV pagination when the screen size changes (e.g. the TV reconnects).
    let resizeT;
    window.addEventListener('resize', () => {
      if (!this.tvMode) return;
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { this.render(); this.restartRotationTimer(); }, 150);
    });
  }

  // --- modal plumbing -------------------------------------------------------
  openModal(id) {
    const alreadyOpen = this.anyModalOpen();
    if (!alreadyOpen) this.modalTrigger = document.activeElement;
    this.closeAll(false);
    const modal = document.getElementById(id);
    modal.style.display = 'block';
    document.body.classList.add('modal-open');
    [...document.querySelector('.container').children].forEach((el) => { el.inert = el !== modal; });
    (modal.querySelector('input:not([disabled]), select, button') || modal).focus();
    if (this.tvMode) this.stopRotation();
  }
  closeModal(id) {
    document.getElementById(id).style.display = 'none';
    if (!this.anyModalOpen()) {
      document.body.classList.remove('modal-open');
      [...document.querySelector('.container').children].forEach((el) => { el.inert = false; });
      this.restoreModalFocus();
      this.restartRotationTimer();
    }
  }
  closeAll(restoreFocus = true) {
    const wasOpen = this.anyModalOpen();
    document.querySelectorAll('.modal').forEach((m) => { m.style.display = 'none'; });
    document.body.classList.remove('modal-open');
    [...document.querySelector('.container').children].forEach((el) => { el.inert = false; });
    if (restoreFocus && wasOpen) this.restoreModalFocus();
    if (restoreFocus && wasOpen) this.restartRotationTimer();
  }
  restoreModalFocus() {
    const trigger = this.modalTrigger?.isConnected ? this.modalTrigger
      : [...document.querySelectorAll('.tab-content.active [data-action]')].find((el) =>
        el.dataset.action === this.modalTrigger?.dataset.action && el.dataset.id === this.modalTrigger?.dataset.id);
    (trigger || document.querySelector('.tab-btn.active'))?.focus();
  }
  handleModalKey(event) {
    const modal = [...document.querySelectorAll('.modal')].find((m) => this.isOpen(m.id));
    if (!modal) return;
    if (event.key === 'Escape') { event.preventDefault(); this.closeAll(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button, input, select, a[href], [tabindex="0"]')]
      .filter((el) => !el.disabled && el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (!first) { event.preventDefault(); modal.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  // One delegated action map, with no executable strings in generated markup.
  handleAction(event, type) {
    const target = event.target.closest('[data-action]');
    if (!target || (target.matches('input, select') ? 'change' : 'click') !== type) return;
    const actions = {
      history: () => this.openHistory(target.dataset.id),
      edit: () => this.openAthleteModal(target.dataset.id),
      delete: () => this.deleteAthlete(target.dataset.id),
      approve: () => this.decide(target.dataset.id, true),
      reject: () => this.decide(target.dataset.id, false),
      link: () => this.adminLink(target.dataset.id, target.value),
      admin: () => this.adminToggleAdmin(target.dataset.id, target.checked),
      block: () => this.adminBlock(target.dataset.id, target.dataset.blocked === 'true'),
    };
    if (actions[target.dataset.action]) this.runAction(`${target.dataset.action}:${target.dataset.id}`, target, actions[target.dataset.action]);
  }
  async runAction(key, button, action) {
    if (this.busyActions.has(key)) return;
    this.busyActions.add(key);
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try { await action(); }
    catch (error) { this.showToast(this.errText(error), 'error'); }
    finally {
      this.busyActions.delete(key);
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
  }
  readLift(lift, id) {
    const input = document.getElementById(id);
    const value = window.Lifts.parse(lift, input.value);
    if (!Number.isFinite(value)) {
      input.focus();
      throw new Error(`${(LIFT_META[lift] || window.getOtherLift(lift)).label}: enter ${this.liftUnit(lift) === 'time' ? 'm:ss or whole seconds' : 'a valid non-negative value'} (maximum 99999).`);
    }
    return value;
  }
  isOpen(id) { return document.getElementById(id).style.display === 'block'; }
  refreshOpenModals() {
    if (this.isOpen('reviewModal')) this.renderReview();
    if (this.isOpen('adminModal')) this.renderUsers();
    if (this.isOpen('manageModal')) this.renderAthletesList();
    if (this.isOpen('historyModal')) this.reloadHistory();
  }

  // --- lookups --------------------------------------------------------------
  athleteById(id) { return this.athletes.find((a) => a.id === id); }
  profileByUser(id) { return this.profiles.find((p) => p.user_id === id); }
  ownerOf(athleteId) { return this.profiles.find((p) => p.athlete_id === athleteId); }
  unclaimedAthletes() { return this.athletes.filter((a) => !this.ownerOf(a.id)); }

  // proposals the current user is allowed to decide
  reviewable() {
    return this.proposals.filter((p) => {
      if (this.isAdmin) return true;
      if (this.isActive) return p.approval === 'peer' && p.proposer !== this.user.id;
      return false;
    });
  }
  pendingForAthlete(athleteId) {
    return this.proposals.some((p) => p.athlete_id === athleteId && ['pr', 'achievement', 'rename'].includes(p.kind));
  }

  // --- claim ----------------------------------------------------------------
  openClaim() {
    if (!this.signedIn) return this.showToast('Sign in first', 'error');
    if (this.isLinked) return this.showToast("You're already linked to an athlete", 'error');
    const select = document.getElementById('claimSelect');
    const options = this.unclaimedAthletes()
      .map((a) => `<option value="${a.id}">${this.escapeHtml(a.name)}</option>`)
      .join('');
    select.innerHTML = `<option value="">— choose an existing athlete —</option>${options}`;
    document.getElementById('claimNewName').value = '';
    this.openModal('claimModal');
  }

  async submitClaim() {
    const athleteId = document.getElementById('claimSelect').value;
    const newName = document.getElementById('claimNewName').value.trim();
    if (newName.length > 80) throw new Error('Names can have at most 80 characters.');
    if (newName && athleteId) throw new Error('Choose an existing athlete or enter a new name, not both.');
    try {
      if (newName) {
        await window.Store.propose('new_athlete', null, { name: newName });
      } else if (athleteId) {
        await window.Store.propose('claim', athleteId, {});
      } else {
        return this.showToast('Pick an athlete or enter a name', 'error');
      }
      this.closeModal('claimModal');
      await this.refreshAll();
      this.showToast('Request sent — an admin will approve it', 'success');
    } catch (e) {
      this.showToast(this.errText(e), 'error');
    }
  }

  // --- my athlete (propose changes) ----------------------------------------
  openMine() {
    if (!this.isActive) return this.showToast('Claim an athlete first (and wait for approval)', 'error');
    const a = this.athleteById(this.myAthleteId);
    if (!a) return this.showToast('Your athlete is missing', 'error');
    document.getElementById('mineName').value = a.name;
    document.getElementById('mineSquat').value = a.squat;
    document.getElementById('mineBench').value = a.bench;
    document.getElementById('mineDeadlift').value = a.deadlift;
    for (const l of window.OTHER_LIFTS) document.getElementById('mineOther_' + l.id).value = this.otherLiftInputValue(l, a.lifts?.[l.id] ?? 0);
    const earned = a.achievements || [];
    document.querySelectorAll('.mine-achievement-check').forEach((c) => (c.checked = earned.includes(c.value)));
    this.mineSnapshot = { name: a.name, squat: a.squat, bench: a.bench, deadlift: a.deadlift, lifts: { ...(a.lifts || {}) }, achievements: [...earned] };
    this.openModal('mineModal');
  }

  async submitMine() {
    const a = this.athleteById(this.myAthleteId);
    const snap = this.mineSnapshot;
    if (!a || !snap || !this.isActive) throw new Error('Your athlete is no longer available. Reopen My PRs.');
    const num = (id, lift = id) => this.readLift(lift, id);
    const proposals = [];

    const name = document.getElementById('mineName').value.trim();
    if (!name || name.length > 80) throw new Error('Enter a name between 1 and 80 characters.');
    if (name !== snap.name) proposals.push(['rename', { name }]);
    for (const lift of LIFTS) {
      const v = num('mine' + lift.charAt(0).toUpperCase() + lift.slice(1), lift);
      if (v !== Number(snap[lift])) proposals.push(['pr', { lift, value: v }]);
    }
    for (const l of window.OTHER_LIFTS) {
      const v = this.readOtherLift(l, 'mineOther_' + l.id);
      if (v !== Number(snap.lifts?.[l.id] ?? 0)) proposals.push(['pr', { lift: l.id, value: v }]);
    }
    const checked = [...document.querySelectorAll('.mine-achievement-check')].filter((c) => c.checked).map((c) => c.value);
    for (const id of checked) if (!snap.achievements.includes(id)) proposals.push(['achievement', { achievement_id: id, op: 'add' }]);
    for (const id of snap.achievements) if (window.getAchievement(id) && !checked.includes(id)) proposals.push(['achievement', { achievement_id: id, op: 'remove' }]);

    if (proposals.length === 0) { this.closeModal('mineModal'); return this.showToast('No changes', 'success'); }

    try {
      for (const [kind, payload] of proposals) {
        await window.Store.propose(kind, a.id, payload);
        // Preserve accepted fields if a later request fails; retry only the unsent changes.
        if (kind === 'rename') snap.name = payload.name;
        else if (kind === 'pr' && LIFTS.includes(payload.lift)) snap[payload.lift] = payload.value;
        else if (kind === 'pr') snap.lifts[payload.lift] = payload.value;
        else if (payload.op === 'add') snap.achievements.push(payload.achievement_id);
        else snap.achievements = snap.achievements.filter((id) => id !== payload.achievement_id);
      }
      this.closeModal('mineModal');
      await this.refreshAll();
      const peer = proposals.filter((p) => p[0] !== 'rename').length;
      const adm = proposals.length - peer;
      this.showToast(`Submitted — ${peer ? peer + ' awaiting peer verify' : ''}${peer && adm ? ', ' : ''}${adm ? adm + ' awaiting admin' : ''}`, 'success');
    } catch (e) {
      this.showToast(this.errText(e), 'error');
    }
  }

  // --- review queue ---------------------------------------------------------
  openReview() {
    if (!(this.isAdmin || this.isActive)) return this.showToast('Only members can review', 'error');
    this.renderReview();
    this.openModal('reviewModal');
  }

  describeProposal(p) {
    const who = this.escapeHtml(this.profileByUser(p.proposer)?.github_login || 'someone');
    const aName = this.escapeHtml(this.athleteById(p.athlete_id)?.name || p.payload?.name || 'athlete');
    const tag = p.approval === 'peer' ? '<span class="tag tag-peer">peer</span>' : '<span class="tag tag-admin">admin</span>';
    let text;
    switch (p.kind) {
      case 'pr': { const lid = p.payload.lift; const meta = LIFT_META[lid] || window.getOtherLift(lid); text = `<strong>${aName}</strong>: ${meta?.emoji || ''} ${this.escapeHtml(meta?.label || lid)} → <strong>${this.escapeHtml(this.displayValueUnit(lid, p.payload.value))}</strong>`; break; }
      case 'achievement': { const ach = window.getAchievement(p.payload.achievement_id); text = `<strong>${aName}</strong>: ${p.payload.op === 'add' ? 'earn' : 'remove'} ${ach ? ach.emoji + ' ' + this.escapeHtml(ach.name) : this.escapeHtml(p.payload.achievement_id)}`; break; }
      case 'rename': text = `Rename to <strong>${this.escapeHtml(p.payload.name)}</strong>`; break;
      case 'new_athlete': text = `${who} wants to add athlete <strong>${this.escapeHtml(p.payload.name)}</strong>`; break;
      case 'claim': text = `${who} wants to be <strong>${aName}</strong>`; break;
      default: text = this.escapeHtml(p.kind);
    }
    return `${tag} ${text} <span class="by">· by ${who}</span>`;
  }

  renderReview() {
    const list = document.getElementById('reviewList');
    const items = this.reviewable();
    if (items.length === 0) { list.innerHTML = '<p class="empty-state">Nothing to review right now. 🎉</p>'; return; }
    list.innerHTML = items.map((p) => `
      <div class="review-row">
        <div class="review-desc">${this.describeProposal(p)}</div>
        <div class="review-actions">
          <button class="btn btn-edit" data-action="approve" data-id="${p.id}">Approve</button>
          <button class="btn btn-danger" data-action="reject" data-id="${p.id}">Reject</button>
        </div>
      </div>`).join('');
  }

  async decide(id, approve) {
    try {
      await window.Store.decide(id, approve);
      await this.refreshAll();
      this.showToast(approve ? 'Approved' : 'Rejected', 'success');
    } catch (e) {
      this.showToast(this.errText(e), 'error');
    }
  }

  // --- admin: members -------------------------------------------------------
  openAdmin() {
    if (!this.isAdmin) return this.showToast('Admins only', 'error');
    this.renderUsers();
    this.openModal('adminModal');
  }

  renderUsers() {
    const list = document.getElementById('usersList');
    if (this.profiles.length === 0) { list.innerHTML = '<p class="empty-state">No members yet.</p>'; return; }
    const sorted = [...this.profiles].sort((a, b) => (a.github_login || '').localeCompare(b.github_login || ''));
    list.innerHTML = sorted.map((p) => {
      const linked = this.athleteById(p.athlete_id);
      const opts = ['<option value="">— not linked —</option>']
        .concat(this.athletes.map((a) => {
          const takenBy = this.ownerOf(a.id);
          const disabled = takenBy && takenBy.user_id !== p.user_id;
          return `<option value="${a.id}" ${a.id === p.athlete_id ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${this.escapeHtml(a.name)}${disabled ? ' (claimed)' : ''}</option>`;
        })).join('');
      return `<div class="user-row">
        <div class="user-info">
          <strong>${this.escapeHtml(p.github_login || p.user_id)}</strong>
          <span class="status-chip status-${p.status}">${p.status}</span>
          ${p.is_admin ? '<span class="status-chip status-admin">admin</span>' : ''}
          ${linked ? `<span class="linked-to">→ ${this.escapeHtml(linked.name)}</span>` : ''}
        </div>
        <div class="user-controls">
          <select aria-label="Linked athlete for ${this.escapeHtml(p.github_login)}" data-action="link" data-id="${p.user_id}">${opts}</select>
          <label class="form-check"><input type="checkbox" ${p.is_admin ? 'checked' : ''} data-action="admin" data-id="${p.user_id}"> admin</label>
          <button class="btn btn-ghost" data-action="block" data-id="${p.user_id}" data-blocked="${p.status === 'blocked'}">${p.status === 'blocked' ? 'Unblock' : 'Block'}</button>
        </div>
      </div>`;
    }).join('');
  }

  async adminLink(userId, athleteId) {
    try {
      const status = this.profileByUser(userId)?.status === 'blocked' ? 'blocked' : athleteId ? 'active' : 'pending';
      await window.Store.adminUpdateProfile(userId, { athlete_id: athleteId || null, status });
      await this.refreshAll();
      this.showToast('Updated', 'success');
    } catch (e) { this.showToast(this.errText(e), 'error'); }
  }
  async adminToggleAdmin(userId, val) {
    try { await window.Store.adminUpdateProfile(userId, { is_admin: val }); await this.refreshAll(); this.showToast('Updated', 'success'); }
    catch (e) { this.showToast(this.errText(e), 'error'); }
  }
  async adminBlock(userId, currentlyBlocked) {
    try { await window.Store.adminUpdateProfile(userId, { status: currentlyBlocked ? (this.profileByUser(userId)?.athlete_id ? 'active' : 'pending') : 'blocked' }); await this.refreshAll(); this.showToast('Updated', 'success'); }
    catch (e) { this.showToast(this.errText(e), 'error'); }
  }

  // --- admin: athletes (direct) --------------------------------------------
  openManage() {
    if (!this.isAdmin) return this.showToast('Admins only', 'error');
    this.renderAthletesList();
    this.openModal('manageModal');
  }

  openAthleteModal(athleteId = null) {
    if (!this.isAdmin) return this.showToast('Admins only', 'error');
    const form = document.getElementById('athleteForm');
    form.reset();
    if (athleteId) {
      const a = this.athleteById(athleteId);
      if (!a) throw new Error('This athlete is no longer on the board.');
      this.editingSnapshot = structuredClone(a);
      document.getElementById('modalTitle').textContent = 'Edit athlete';
      document.getElementById('athleteName').value = a.name;
      document.getElementById('bench').value = a.bench;
      document.getElementById('squat').value = a.squat;
      document.getElementById('deadlift').value = a.deadlift;
      for (const l of window.OTHER_LIFTS) document.getElementById('adminOther_' + l.id).value = this.otherLiftInputValue(l, a.lifts?.[l.id] ?? 0);
      document.querySelectorAll('#achievementFields .achievement-check').forEach((c) => (c.checked = (a.achievements || []).includes(c.value)));
      this.editingId = athleteId;
    } else {
      document.getElementById('modalTitle').textContent = 'Add athlete';
      this.editingId = null;
      this.editingSnapshot = null;
    }
    this.updateAvatarPreview();
    this.openModal('athleteModal');
    document.getElementById('athleteName').focus();
  }

  updateAvatarPreview() {
    const name = document.getElementById('athleteName').value || 'New athlete';
    const achievements = [...document.querySelectorAll('#achievementFields .achievement-check')].filter((c) => c.checked).map((c) => c.value);
    document.getElementById('avatarPreview').innerHTML = window.renderAvatar({ name, achievements }, 110);
  }

  async saveAthlete() {
    const num = (id, lift = id) => this.readLift(lift, id);
    const lifts = { ...(this.athleteById(this.editingId)?.lifts || {}) };
    for (const l of window.OTHER_LIFTS) lifts[l.id] = this.readOtherLift(l, 'adminOther_' + l.id);
    const data = {
      name: document.getElementById('athleteName').value.trim(),
      bench: num('bench'), squat: num('squat'), deadlift: num('deadlift'),
      lifts,
      achievements: [
        ...(this.editingSnapshot?.achievements || []).filter((id) => !window.getAchievement(id)),
        ...[...document.querySelectorAll('#achievementFields .achievement-check')].filter((c) => c.checked).map((c) => c.value),
      ],
    };
    if (!data.name || data.name.length > 80) throw new Error('Enter a name between 1 and 80 characters.');
    try {
      if (this.editingId) await window.Store.adminUpdateAthlete(this.editingId, data, this.editingSnapshot?.updated_at);
      else await window.Store.adminCreateAthlete(data);
      this.closeModal('athleteModal');
      await this.refreshAll();
      this.showToast('Saved', 'success');
    } catch (e) { this.showToast(this.errText(e), 'error'); }
  }

  async deleteAthlete(id) {
    const a = this.athleteById(id);
    if (!confirm(`Delete ${a?.name ?? 'this athlete'}? This can't be undone.`)) return;
    try {
      await window.Store.adminDeleteAthlete(id);
      await this.refreshAll();
      this.showToast('Deleted', 'success');
    } catch (e) { this.showToast(this.errText(e), 'error'); }
  }

  renderAthletesList() {
    const container = document.getElementById('athletesList');
    if (this.athletes.length === 0) { container.innerHTML = '<p class="empty-state">No athletes yet.</p>'; return; }
    const sorted = [...this.athletes].sort((a, b) => a.name.localeCompare(b.name));
    container.innerHTML = sorted.map((a) => {
      const owner = this.ownerOf(a.id);
      return `<div class="athlete-card">
        <div class="athlete-card-avatar">${window.renderAvatar(a, 52)}</div>
        <div class="athlete-card-info">
          <h3>${this.escapeHtml(a.name)}${this.badgesFor(a)}${owner ? `<span class="linked-to">@${this.escapeHtml(owner.github_login)}</span>` : ''}</h3>
          <div class="athlete-stats">
            <span>🏋️ <strong>${this.displayValue('bench', a.bench)}</strong></span>
            <span>🦵 <strong>${this.displayValue('squat', a.squat)}</strong></span>
            <span>💀 <strong>${this.displayValue('deadlift', a.deadlift)}</strong></span>
            <span>🏆 <strong>${this.displayValue('total', this.valueFor(a, 'total'))}</strong></span>
            ${window.OTHER_LIFTS.map((l) => `<span>${l.emoji} <strong>${this.displayValue(l.id, this.valueFor(a, l.id))}</strong></span>`).join('')}
          </div>
        </div>
        <div class="athlete-card-actions">
          <button class="btn btn-edit" data-action="edit" data-id="${a.id}">Edit</button>
          <button class="btn btn-danger" data-action="delete" data-id="${a.id}">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  // --- tabs ---------------------------------------------------------
  switchTab(tabName) {
    if (!document.getElementById(`${tabName}-tab`)) return;
    this.activeTab = tabName;
    document.querySelector('.skip-link').setAttribute('href', `#${tabName}-tab`);
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const active = b.dataset.tab === tabName;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
      b.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
    if (this.tvMode) { this.tvPage = 0; this.fitTvPaging(); }
  }
  // --- TV / display mode ----------------------------------------------------
  // Big landscape layout + hands-free tab cycling, toggled by ?tv or the 📺 button.
  // Rotation pauses while the browser tab is hidden (the office TV cycles between a
  // few pages) and resumes where it left off, so every tab gets airtime over time.
  applyTvMode(on) {
    this.tvMode = on;
    document.getElementById('tvModeBtn').setAttribute('aria-pressed', String(on));
    document.getElementById('tvModeBtn').textContent = on ? '✕ Exit TV mode' : '📺 TV mode';
    document.documentElement.classList.toggle('tv-mode', on);
    if (on) this.closeAll();
    else { this.tvPage = 0; document.querySelectorAll('.tv-page-dots').forEach((d) => d.remove()); }
    this.render(); // add/remove the per-board podiums + pagination TV mode shows
    if (on) this.startRotation(); else this.stopRotation();
  }

  toggleTvMode() {
    const on = !this.tvMode;
    try { localStorage.setItem('lb.tv', on ? '1' : '0'); } catch { /* private mode */ }
    // Keep the URL honest so a reload matches what's on screen.
    const url = new URL(location.href);
    if (on) url.searchParams.set('tv', '1'); else url.searchParams.delete('tv');
    history.replaceState(null, '', url);
    this.applyTvMode(on);
  }

  // Tabs to cycle, in on-screen order; skip an extra-lift tab that has no exercises.
  rotationTabs() {
    const empty = new Set(OTHER_LIFT_TABS
      .filter(({ tab }) => !window.OTHER_LIFTS.some((l) => liftGroup(l) === tab))
      .map(({ tab }) => tab));
    return [...document.querySelectorAll('.tab-btn')]
      .map((b) => b.dataset.tab)
      .filter((t) => !empty.has(t));
  }

  startRotation() {
    this.stopRotation();
    this.scheduleTick();
  }
  // One self-rescheduling tick. Page dwells vary (see currentDwellMs), so a fixed
  // setInterval won't do — each tick schedules the next using the current dwell.
  scheduleTick() {
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (!this.tvMode || document.hidden || this.anyModalOpen()) return;
    this.restartProgress();
    this.rotateTimer = setTimeout(() => { this.advanceTab(); this.scheduleTick(); }, this.currentDwellMs());
  }
  stopRotation() {
    if (this.rotateTimer) { clearTimeout(this.rotateTimer); this.rotateTimer = null; }
    document.querySelectorAll('.tab-btn.rotating').forEach((b) => b.classList.remove('rotating'));
  }
  restartRotationTimer() { if (this.tvMode) this.startRotation(); } // e.g. after a manual tab click

  // rotateMs is the budget *per tab* (the configured cadence), so a multi-page tab
  // splits that budget; page 1 gets double the dwell of the rest. A large roster
  // extends the tab budget instead of flashing unreadable sub-second pages.
  currentDwellMs() {
    const pages = Math.max(1, this.tvPages);
    const weight = this.tvPage === 0 ? 2 : 1;
    return Math.max(TV_MIN_DWELL_MS * (pages === 1 ? 1 : weight), Math.round((this.rotateMs * weight) / (pages + 1)));
  }

  advanceTab() {
    if (this.anyModalOpen()) return; // don't yank a tab out from under someone reading
    if (this.advanceTvPage()) return; // page through a tall board before leaving the tab
    const tabs = this.rotationTabs();
    const i = tabs.indexOf(this.activeTab);
    this.switchTab(tabs[(i + 1) % tabs.length]);
  }

  // Step to the next page of the active tab; false when it's already the last page
  // (so advanceTab moves on to the next tab). The progress bar restarts via scheduleTick.
  advanceTvPage() {
    if (!this.tvMode || this.tvPage + 1 >= this.tvPages) return false;
    this.tvPage++;
    this.applyTvPage();
    return true;
  }

  anyModalOpen() {
    return [...document.querySelectorAll('.modal')].some((m) => m.style.display === 'block');
  }

  // Restart the CSS countdown bar under the active tab (remove → reflow → re-add),
  // matching its duration to the current page's dwell.
  restartProgress() {
    document.querySelectorAll('.tab-btn.rotating').forEach((b) => b.classList.remove('rotating'));
    const bar = document.querySelector('.tab-btn.active');
    if (!bar) return;
    document.documentElement.style.setProperty('--rotate-ms', `${this.currentDwellMs()}ms`);
    void bar.offsetWidth;
    if (this.tvMode && !document.hidden && !this.anyModalOpen()) bar.classList.add('rotating');
  }

  // --- board rendering ------------------------------------------------------
  // lift may be a main lift, 'total', or an "other lift" id (value in athletes.lifts).
  valueFor(a, lift) { return window.Lifts.value(a, lift); }
  liftUnit(lift) { return window.Lifts.unit(lift); }
  displayValue(lift, value) { return window.Lifts.format(lift, value); }
  displayValueUnit(lift, value) { return window.Lifts.formatUnit(lift, value); }

  render() {
    LIFTS.forEach((l) => this.renderLeaderboard(l));
    this.renderLeaderboard('total');
    window.OTHER_LIFTS.forEach((l) => this.renderLeaderboard(l.id));
    this.renderHallOfFame();
    this.updateReviewCount();
    this.updateBoardStatus();
    if (this.tvMode) this.fitTvPaging();
  }

  updateReviewCount() {
    const badge = document.getElementById('reviewCount');
    const n = this.reviewable().length;
    badge.textContent = n;
    badge.hidden = n === 0;
  }

  renderLeaderboard(liftType, allowPodium = true) {
    const section = document.querySelector(`#${liftType}Table`).closest('.leaderboard-section');
    const tbody = section.querySelector('tbody');
    const ranked = window.Lifts.ranked(this.athletes, liftType);
    section.querySelector('.podium-container')?.remove();
    section.querySelector('table').hidden = false;

    if (ranked.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-state">${this.loading ? 'Loading the board…' : this.loadError ? 'The board is unavailable. Try again above.' : 'A record waiting to happen.<br><span>Be the first on this board.</span>'}</td></tr>`;
      return;
    }
    // Tied medal positions share a rank. Keep the full podium group together.
    const winners = ranked.filter((row) => row.rank <= 3);
    const showPodium = allowPodium && winners.length <= 6 && (!this.tvMode || window.innerHeight >= 760);
    if (showPodium) this.renderPodium(section, winners, liftType);
    const tableAthletes = showPodium ? ranked.filter((row) => row.rank > 3) : ranked;
    section.querySelector('table').hidden = tableAthletes.length === 0;
    tbody.innerHTML = tableAthletes.map(({ athlete: a, rank }) => {
      return `<tr>
        <td><span class="rank">${this.rankDisplay(rank)}</span></td>
        <td><button type="button" class="athlete-name athlete-link" data-action="history" data-id="${a.id}" title="See progression">${this.escapeHtml(a.name)}</button>${this.badgesFor(a)}${this.pendingForAthlete(a.id) ? '<span class="badge-chip pending" title="Has a pending change">⏳</span>' : ''}</td>
        <td><span class="pr-value">${this.displayValue(liftType, this.valueFor(a, liftType))}</span></td>
      </tr>`;
    }).join('');
  }

  renderPodium(section, top3, liftType) {
    const container = document.createElement('div');
    container.className = 'podium-container';
    [2, 1, 3].forEach((rank) => {
      const athletes = top3.filter((row) => row.rank === rank);
      if (!athletes.length) return;
      const spot = document.createElement('div');
      spot.className = `podium-spot ${['', 'first', 'second', 'third'][rank]}`;
      const avatarSize = this.tvMode ? 48 : 64;
      spot.innerHTML = `
        <div class="podium-athlete">
          <div class="podium-avatars">${athletes.map(({ athlete }) => window.renderAvatar(athlete, athletes.length > 1 ? 36 : avatarSize)).join('')}</div>
          <div class="podium-medal">${this.medalMark(rank, this.tvMode ? 26 : 28)}</div>
          <div class="podium-name">${athletes.map(({ athlete }) => `<button type="button" class="athlete-link" data-action="history" data-id="${athlete.id}" title="See progression">${this.escapeHtml(athlete.name)}</button>`).join('<span class="tie-join"> &amp; </span>')}</div>
          <div class="podium-value">${this.displayValueUnit(liftType, athletes[0].value)}</div>
        </div><div class="podium-stand"><div class="podium-rank">${rank}</div></div>`;
      container.appendChild(spot);
    });
    section.querySelector('h2').after(container);
  }

  // Inline SVG medal (gold/silver/bronze + rank), symmetric about the viewBox center
  // so it sits dead-centered under the figure. Replaces the 🥇/🥈/🥉 emoji, whose
  // glyph paints left of its box on many platforms (and matches the marker look better).
  medalMark(rank, size = 32) {
    const fill = { 1: 'var(--gold)', 2: 'var(--silver)', 3: 'var(--bronze)' }[rank] || 'var(--gold)';
    const edge = { 1: '#d99e16', 2: '#94a3b8', 3: '#b06a44' }[rank] || '#d99e16';
    return `<svg class="medal-svg" viewBox="0 0 40 50" width="${size}" height="${size * 1.25}"
         role="img" aria-label="rank ${rank}" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 3 L21 27 L11 29 Z" fill="#8aa0c4"/>
      <path d="M27 3 L19 27 L29 29 Z" fill="#d09a9a"/>
      <circle cx="20" cy="34" r="14" fill="${fill}" stroke="${edge}" stroke-width="2.5"/>
      <text x="20" y="39.5" text-anchor="middle" font-size="15" font-weight="700" fill="#5a4636"
            font-family="'Permanent Marker','Caveat',cursive">${rank}</text>
    </svg>`;
  }

  // Fit variable-height rows (including wrapped names) into actual screen space.
  // Short TV viewports use tables without podiums, leaving room for ranked rows.
  fitTvPaging() {
    const frame = document.querySelector('.tab-content.active');
    if (!this.tvMode || !frame) { this.tvPages = 1; return; }
    const previousPages = this.tvPages;
    const previousPage = this.tvPage;
    const bottom = frame.getBoundingClientRect().bottom - TV_PAGE_PAD;
    // Reconsider podiums after fonts, available height or the active tab change.
    // A fixed viewport cutoff alone cannot account for long names or large text.
    frame.querySelectorAll('[data-lift]').forEach((section) => {
      this.renderLeaderboard(section.dataset.lift);
      const podium = section.querySelector('.podium-container');
      if (!podium) return;
      const rows = [...section.querySelectorAll('tbody tr')];
      const rowHeight = Math.max(0, ...rows.map((row) => row.getBoundingClientRect().height));
      const needed = rowHeight * Math.min(2, rows.length);
      const table = section.querySelector('table');
      const start = table.hidden ? podium.getBoundingClientRect().bottom
        : section.querySelector('tbody').getBoundingClientRect().top;
      if (start + needed > bottom) this.renderLeaderboard(section.dataset.lift, false);
    });
    this.tvBoards = [];
    let pages = 1;
    frame.querySelectorAll('.leaderboard-section').forEach((section) => {
      const tbody = section.querySelector('tbody');
      const rows = tbody && !tbody.querySelector('.empty-state') ? [...tbody.rows] : [];
      if (rows.length === 0) return;
      rows.forEach((tr) => { tr.hidden = false; }); // un-hide so we measure the full table, not a prior page
      const room = Math.max(1, bottom - tbody.getBoundingClientRect().top);
      const slices = this.partitionRows(rows, room);
      this.tvBoards.push({ rows, slices });
      pages = Math.max(pages, slices.length);
    });
    this.tvPages = pages;
    this.tvPage = Math.min(this.tvPage, pages - 1);
    this.applyTvPage();
    if (previousPages !== pages || previousPage !== this.tvPage) this.restartRotationTimer();
  }

  partitionRows(rows, room) {
    const slices = [[]];
    let height = 0;
    for (const row of rows) {
      const rowHeight = row.getBoundingClientRect().height || 1;
      if (height + rowHeight > room && slices.at(-1).length) { slices.push([]); height = 0; }
      slices.at(-1).push(row);
      height += rowHeight;
    }
    return slices;
  }

  // Show only the current page's slice of each board's overflow rows, then draw the
  // page dots. A board with fewer pages pins to its last page, so a shorter board
  // never blinks empty while a longer one is still paging.
  applyTvPage() {
    (this.tvBoards || []).forEach(({ rows, slices }) => {
      const visible = new Set(slices[Math.min(this.tvPage, slices.length - 1)]);
      rows.forEach((row) => { row.hidden = !visible.has(row); });
    });
    const frame = document.querySelector('.tab-content.active');
    if (!frame) return;
    frame.querySelector('.tv-page-dots')?.remove();
    if (this.tvPages <= 1) return;
    const dots = document.createElement('div');
    dots.className = 'tv-page-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.innerHTML = Array.from({ length: this.tvPages }, (_, i) =>
      `<span class="tv-page-dot${i === this.tvPage ? ' active' : ''}"></span>`).join('');
    frame.appendChild(dots);
  }

  renderHallOfFame() {
    const root = document.getElementById('hallOfFame');
    root.innerHTML = window.ACHIEVEMENTS.map((ach) => {
      const achievers = this.athletes.filter((a) => (a.achievements || []).includes(ach.id)).sort((a, b) => a.name.localeCompare(b.name));
      const body = this.tvMode && achievers.length > 0
        ? `<table class="leaderboard-table"><thead><tr><th scope="col">Member</th><th scope="col">Achievement</th></tr></thead><tbody>${achievers.map((a) => `<tr><td><span class="athlete-name">${this.escapeHtml(a.name)}</span></td><td>${this.escapeHtml(ach.title)}</td></tr>`).join('')}</tbody></table>`
        : achievers.length === 0
        ? `<div class="empty-achievement"><p>${this.escapeHtml(ach.emptyText)}</p></div>`
        : `<div class="hall-of-fame">${achievers.map((a) => `<div class="achievement-badge"><div class="badge-avatar">${window.renderAvatar(a, 66)}</div><div class="badge-name">${this.escapeHtml(a.name)}</div><div class="badge-subtitle">${this.escapeHtml(ach.title)}</div></div>`).join('')}</div>
           <div class="achievement-count">${achievers.length} ${achievers.length === 1 ? 'person has' : 'people have'} earned this</div>`;
      return `<div class="achievement-section${this.tvMode ? ' leaderboard-section' : ''}"><h2>${ach.emoji} ${this.escapeHtml(ach.name)}</h2><p class="achievement-description">${this.escapeHtml(ach.description)}</p>${body}</div>`;
    }).join('');
  }

  badgesFor(a) {
    return (a.achievements || []).map((id) => window.getAchievement(id)).filter(Boolean)
      .map((x) => `<span class="badge-chip" title="${this.escapeHtml(x.name)}">${x.emoji}</span>`).join('');
  }
  rankDisplay(rank) { return { 1: '🥇', 2: '🥈', 3: '🥉' }[rank] || rank; }

  // --- history / progression ------------------------------------------------
  // Verified PRs are stored as approved 'pr' proposals (payload.lift/value, decided_at).
  // This view groups them per lift and draws a hand-rolled SVG sparkline — no chart lib.
  openHistory(athleteId) {
    const a = this.athleteById(athleteId);
    if (!a) return;
    this.historyAthleteId = athleteId;
    document.getElementById('historyTitle').textContent = `📈 ${a.name} — progression`;
    document.getElementById('historyBody').innerHTML = '<p class="empty-state">Loading…</p>';
    this.openModal('historyModal');
    this.reloadHistory();
  }

  async reloadHistory() {
    const request = this.historyRequest = (this.historyRequest || 0) + 1;
    const id = this.historyAthleteId;
    const a = this.athleteById(id);
    const body = document.getElementById('historyBody');
    if (!a || !body) return;
    try {
      const rows = await window.Store.listAthleteHistory(id);
      // Bail if the user switched/closed the modal while we were fetching.
      if (request !== this.historyRequest || this.historyAthleteId !== id || !this.isOpen('historyModal')) return;
      this.renderHistory(rows);
    } catch (e) {
      if (request !== this.historyRequest || this.historyAthleteId !== id || !this.isOpen('historyModal')) return;
      body.innerHTML = `<p class="empty-state">${this.escapeHtml(this.errText(e))}</p>`;
    }
  }

  renderHistory(rows) { document.getElementById('historyBody').innerHTML = window.HistoryView.render(rows); }

  // --- misc -----------------------------------------------------------------
  showConfigBanner() {
    const banner = document.createElement('div');
    banner.className = 'config-banner';
    banner.innerHTML = window.Store.connectionError ? this.escapeHtml(window.Store.connectionError.message) : `<strong>⚙️ Not connected yet.</strong> Set your Supabase URL/key in <code>js/config.js</code> and run <code>supabase/schema.sql</code>. See the README.`;
    document.querySelector('.container').prepend(banner);
  }

  errText(e) {
    const m = e?.message || String(e);
    return m.slice(0, 220) || 'Something went wrong';
  }
  escapeHtml(text) { return escapeAttr(text); }
  showToast(message, type = 'success') {
    document.querySelector('.toast')?.remove();
    const toast = document.createElement('div');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.animation = 'slideInRight 0.3s ease reverse'; setTimeout(() => toast.remove(), 300); }, type === 'error' ? 7000 : 4000);
  }
}

let app;
document.addEventListener('DOMContentLoaded', () => { app = new LeaderboardApp(); });
