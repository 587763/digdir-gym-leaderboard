// Main UI controller for the Digdir Gym Leaderboard.
// Governance: admins manage everything; signed-in users claim an athlete (admin
// approves); linked users propose PR/achievement changes (peer-verified) and name
// changes / new athletes (admin-approved). Rules are enforced in the DB; this is UI.

const LIFTS = ['squat', 'bench', 'deadlift'];
// Height reserved at the bottom of a TV-mode tab for the page dots (so paged rows
// never tuck under them). See fitTvPaging.
const TV_PAGE_PAD = 48;
const LIFT_META = {
  squat: { emoji: '🦵', label: 'Squat' },
  bench: { emoji: '🏋️', label: 'Bench Press' },
  deadlift: { emoji: '💀', label: 'Deadlift' },
  total: { emoji: '🏆', label: 'Total' },
};

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
    this.tvMode = params.has('tv') || localStorage.getItem('lb.tv') === '1';
    this.rotateMs = Math.min(120000, Math.max(5000, (Number(params.get('rotate')) || 15) * 1000));
    this.rotateTimer = null;
    this.tvPage = 0;   // current page within the active tab (TV mode paginates tall boards)
    this.tvPages = 1;  // page count for the active tab, recomputed by fitTvPaging

    this.init();
  }

  // --- derived state --------------------------------------------------------
  get signedIn() { return !!this.user; }
  get isAdmin() { return !!this.profile?.is_admin; }
  get isLinked() { return !!this.profile?.athlete_id; }
  get isActive() { return this.profile?.status === 'active' && this.isLinked; }
  get myAthleteId() { return this.profile?.athlete_id ?? null; }

  async init() {
    if (!window.Store.configured) return this.showConfigBanner();

    this.buildAchievementFields('achievementFields');
    this.buildAchievementFields('mineAchievementFields');
    this.buildOtherLiftSections();
    this.buildOtherLiftFields('mineOtherLiftFields', 'mineOther_', true, false);
    this.buildOtherLiftFields('adminOtherLiftFields', 'adminOther_', false, true);
    this.setupEventListeners();

    await this.loadIdentity();
    await this.loadData();

    // Any DB change → re-fetch everything, INCLUDING my own profile, so an admin
    // approving/linking me updates my permissions live without a manual refresh.
    window.Store.subscribe(() => this.refreshAll());
    window.Store.onAuthChange(async (session) => {
      this.user = session?.user ?? null;
      this.profile = this.user ? await window.Store.myProfile() : null;
      await this.loadData();
      this.reflectAuth();
      this.render();
    });

    this.reflectAuth();
    this.applyTvMode(this.tvMode); // renders; starts tab rotation if TV mode is on
  }

  async loadIdentity() {
    const session = await window.Store.getSession();
    this.user = session?.user ?? null;
    this.profile = this.user ? await window.Store.myProfile() : null;
  }

  // Re-fetch my identity + all board data, then re-render everything. Used by the
  // realtime subscription and on tab-focus, so role/permission changes apply live.
  async refreshAll() {
    if (!window.Store.configured) return;
    this.profile = this.user ? await window.Store.myProfile() : null;
    await this.loadData();
    this.reflectAuth();
    this.render();
    this.refreshOpenModals();
  }

  async loadData() {
    try {
      this.athletes = await window.Store.listAthletes();
      if (this.signedIn) {
        this.profiles = await window.Store.listProfiles();
        this.proposals = await window.Store.listPendingProposals();
      } else {
        this.profiles = [];
        this.proposals = [];
      }
    } catch (e) {
      console.error(e);
      this.showToast('Could not load the board', 'error');
    }
  }

  // --- auth UI --------------------------------------------------------------
  reflectAuth() {
    const b = document.body.classList;
    b.toggle('signed-in', this.signedIn);
    b.toggle('is-admin', this.isAdmin);
    b.toggle('is-active', this.isActive);
    b.toggle('can-claim', this.signedIn && !this.isLinked);
    b.toggle('can-review', this.signedIn && (this.isAdmin || this.isActive));

    const area = document.getElementById('authArea');
    if (!this.signedIn) {
      area.innerHTML = `<button id="signInBtn" class="btn btn-primary">Sign in with GitHub</button>`;
      document.getElementById('signInBtn').onclick = () => window.Store.signIn();
      return;
    }
    const name = this.escapeHtml(window.Store.userLabel(this.user));
    let badge;
    if (this.isAdmin) badge = `<span class="auth-user">🛡️ ${name} · admin</span>`;
    else if (this.isActive) badge = `<span class="auth-user">🏋️ ${name}</span>`;
    else badge = `<span class="auth-user view-only" title="Claim an athlete and wait for an admin to approve">⏳ ${name} · awaiting a spot</span>`;
    area.innerHTML = `${badge}<button id="signOutBtn" class="btn btn-ghost">Sign out</button>`;
    document.getElementById('signOutBtn').onclick = () => window.Store.signOut();
  }

  // --- setup ----------------------------------------------------------------
  buildAchievementFields(containerId) {
    const cls = containerId === 'mineAchievementFields' ? 'mine-achievement-check' : 'achievement-check';
    document.getElementById(containerId).innerHTML = window.ACHIEVEMENTS.map(
      (a) => `<label class="form-check"><input type="checkbox" class="${cls}" value="${a.id}"><span>${a.emoji} ${this.escapeHtml(a.name)}</span></label>`
    ).join('');
  }

  // One leaderboard section per "other lift" (js/lifts.js); first one focused by default.
  buildOtherLiftSections() {
    const root = document.getElementById('otherLiftsBoards');
    if (!root) return;
    if (window.OTHER_LIFTS.length === 0) {
      root.innerHTML = '<p class="empty-state">No other lifts configured yet.</p>';
      return;
    }
    root.innerHTML = window.OTHER_LIFTS.map((l, i) => {
      const head = l.unit === 'time' ? 'Time (m:ss)' : 'PR (kg)';
      return `<div class="leaderboard-section${i === 0 ? ' focused' : ''}" data-lift="${l.id}">
        <h2 class="lift-header" data-lift="${l.id}">${l.emoji} ${this.escapeHtml(l.label)}</h2>
        <table class="leaderboard-table" id="${l.id}Table"><thead><tr><th>Rank</th><th>Name</th><th>${head}</th></tr></thead><tbody></tbody></table>
      </div>`;
    }).join('');
  }

  // Number inputs for the "other lifts", reused by the My-PRs (peer) and admin forms.
  buildOtherLiftFields(containerId, prefix, peer, zero) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = window.OTHER_LIFTS.map((l) => {
      const unit = l.unit === 'time' ? 'sec' : 'kg';
      const step = l.unit === 'time' ? '1' : '0.5';
      const tag = peer ? ' <span class="tag tag-peer">peer verify</span>' : '';
      return `<div class="form-group"><label for="${prefix}${l.id}">${l.emoji} ${this.escapeHtml(l.label)} (${unit})${tag}</label><input type="number" id="${prefix}${l.id}" step="${step}" min="0"${zero ? ' value="0"' : ''}></div>`;
    }).join('');
  }

  setupEventListeners() {
    document.querySelectorAll('.tab-btn').forEach((btn) =>
      btn.addEventListener('click', () => { this.switchTab(btn.dataset.tab); this.restartRotationTimer(); }));
    document.querySelectorAll('.lift-header').forEach((h) =>
      h.addEventListener('click', () => this.focusLift(h.dataset.lift)));
    document.getElementById('tvModeBtn').onclick = () => this.toggleTvMode();

    document.getElementById('myAthleteBtn').onclick = () => this.openMine();
    document.getElementById('claimBtn').onclick = () => this.openClaim();
    document.getElementById('reviewBtn').onclick = () => this.openReview();
    document.getElementById('adminBtn').onclick = () => this.openAdmin();
    document.getElementById('manageAthletesBtn').onclick = () => this.openManage();
    document.getElementById('addNewAthleteBtn').onclick = () => { this.closeAll(); this.openAthleteModal(); };

    document.getElementById('athleteForm').addEventListener('submit', (e) => { e.preventDefault(); this.saveAthlete(); });
    document.getElementById('mineForm').addEventListener('submit', (e) => { e.preventDefault(); this.submitMine(); });
    document.getElementById('claimSubmit').onclick = () => this.submitClaim();
    document.getElementById('athleteName').addEventListener('input', () => this.updateAvatarPreview());

    document.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => this.closeModal(el.dataset.close)));
    window.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) e.target.style.display = 'none';
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeAll(); });

    // Fallback if a realtime event is missed: refresh when the tab regains focus.
    // Also pause/resume TV rotation so off-screen time doesn't burn through tabs.
    document.addEventListener('visibilitychange', () => {
      if (this.tvMode) (document.hidden ? this.stopRotation() : this.startRotation());
      if (!document.hidden) this.refreshAll();
    });
    window.addEventListener('focus', () => this.refreshAll());

    // Re-fit TV pagination when the screen size changes (e.g. the TV reconnects).
    let resizeT;
    window.addEventListener('resize', () => {
      if (!this.tvMode) return;
      clearTimeout(resizeT);
      resizeT = setTimeout(() => this.fitTvPaging(), 150);
    });
  }

  // --- modal plumbing -------------------------------------------------------
  openModal(id) { document.getElementById(id).style.display = 'block'; }
  closeModal(id) { document.getElementById(id).style.display = 'none'; }
  closeAll() { document.querySelectorAll('.modal').forEach((m) => (m.style.display = 'none')); }
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
    try {
      if (newName) {
        await window.Store.propose('new_athlete', null, { name: newName });
      } else if (athleteId) {
        await window.Store.propose('claim', athleteId, {});
      } else {
        return this.showToast('Pick an athlete or enter a name', 'error');
      }
      this.closeModal('claimModal');
      await this.loadData();
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
    for (const l of window.OTHER_LIFTS) document.getElementById('mineOther_' + l.id).value = a.lifts?.[l.id] ?? 0;
    const earned = a.achievements || [];
    document.querySelectorAll('.mine-achievement-check').forEach((c) => (c.checked = earned.includes(c.value)));
    this.mineSnapshot = { name: a.name, squat: a.squat, bench: a.bench, deadlift: a.deadlift, lifts: { ...(a.lifts || {}) }, achievements: [...earned] };
    this.openModal('mineModal');
  }

  async submitMine() {
    const a = this.athleteById(this.myAthleteId);
    const snap = this.mineSnapshot;
    const num = (id) => Math.max(0, parseFloat(document.getElementById(id).value) || 0);
    const proposals = [];

    const name = document.getElementById('mineName').value.trim();
    if (name && name !== snap.name) proposals.push(['rename', { name }]);
    for (const lift of LIFTS) {
      const v = num('mine' + lift.charAt(0).toUpperCase() + lift.slice(1));
      if (v !== Number(snap[lift])) proposals.push(['pr', { lift, value: v }]);
    }
    for (const l of window.OTHER_LIFTS) {
      const v = num('mineOther_' + l.id);
      if (v !== Number(snap.lifts?.[l.id] ?? 0)) proposals.push(['pr', { lift: l.id, value: v }]);
    }
    const checked = [...document.querySelectorAll('.mine-achievement-check')].filter((c) => c.checked).map((c) => c.value);
    for (const id of checked) if (!snap.achievements.includes(id)) proposals.push(['achievement', { achievement_id: id, op: 'add' }]);
    for (const id of snap.achievements) if (!checked.includes(id)) proposals.push(['achievement', { achievement_id: id, op: 'remove' }]);

    if (proposals.length === 0) { this.closeModal('mineModal'); return this.showToast('No changes', 'success'); }

    try {
      for (const [kind, payload] of proposals) await window.Store.propose(kind, a.id, payload);
      this.closeModal('mineModal');
      await this.loadData();
      this.render();
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
      default: text = p.kind;
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
          <button class="btn btn-edit" onclick="app.decide('${p.id}', true)">Approve</button>
          <button class="btn btn-danger" onclick="app.decide('${p.id}', false)">Reject</button>
        </div>
      </div>`).join('');
  }

  async decide(id, approve) {
    try {
      await window.Store.decide(id, approve);
      await this.loadData();
      this.render();
      this.renderReview();
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
          <select onchange="app.adminLink('${p.user_id}', this.value)">${opts}</select>
          <label class="form-check"><input type="checkbox" ${p.is_admin ? 'checked' : ''} onchange="app.adminToggleAdmin('${p.user_id}', this.checked)"> admin</label>
          <button class="btn btn-ghost" onclick="app.adminBlock('${p.user_id}', ${p.status === 'blocked'})">${p.status === 'blocked' ? 'Unblock' : 'Block'}</button>
        </div>
      </div>`;
    }).join('');
  }

  async adminLink(userId, athleteId) {
    try {
      await window.Store.adminUpdateProfile(userId, { athlete_id: athleteId || null, status: athleteId ? 'active' : 'pending' });
      await this.loadData(); this.renderUsers(); this.render();
      this.showToast('Updated', 'success');
    } catch (e) { this.showToast(this.errText(e), 'error'); }
  }
  async adminToggleAdmin(userId, val) {
    try { await window.Store.adminUpdateProfile(userId, { is_admin: val }); await this.loadData(); this.renderUsers(); this.showToast('Updated', 'success'); }
    catch (e) { this.showToast(this.errText(e), 'error'); }
  }
  async adminBlock(userId, currentlyBlocked) {
    try { await window.Store.adminUpdateProfile(userId, { status: currentlyBlocked ? 'pending' : 'blocked' }); await this.loadData(); this.renderUsers(); this.showToast('Updated', 'success'); }
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
      document.getElementById('modalTitle').textContent = 'Edit athlete';
      document.getElementById('athleteName').value = a.name;
      document.getElementById('bench').value = a.bench;
      document.getElementById('squat').value = a.squat;
      document.getElementById('deadlift').value = a.deadlift;
      for (const l of window.OTHER_LIFTS) document.getElementById('adminOther_' + l.id).value = a.lifts?.[l.id] ?? 0;
      document.querySelectorAll('#achievementFields .achievement-check').forEach((c) => (c.checked = (a.achievements || []).includes(c.value)));
      this.editingId = athleteId;
    } else {
      document.getElementById('modalTitle').textContent = 'Add athlete';
      this.editingId = null;
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
    const num = (id) => Math.max(0, parseFloat(document.getElementById(id).value) || 0);
    const lifts = {};
    for (const l of window.OTHER_LIFTS) lifts[l.id] = num('adminOther_' + l.id);
    const data = {
      name: document.getElementById('athleteName').value.trim(),
      bench: num('bench'), squat: num('squat'), deadlift: num('deadlift'),
      lifts,
      achievements: [...document.querySelectorAll('#achievementFields .achievement-check')].filter((c) => c.checked).map((c) => c.value),
    };
    if (!data.name) return this.showToast('Please enter a name', 'error');
    try {
      if (this.editingId) await window.Store.adminUpdateAthlete(this.editingId, data);
      else await window.Store.adminCreateAthlete(data);
      this.closeModal('athleteModal');
      await this.loadData(); this.render(); this.renderAthletesList();
      this.showToast('Saved', 'success');
    } catch (e) { this.showToast(this.errText(e), 'error'); }
  }

  async deleteAthlete(id) {
    const a = this.athleteById(id);
    if (!confirm(`Delete ${a?.name ?? 'this athlete'}? This can't be undone.`)) return;
    try {
      await window.Store.adminDeleteAthlete(id);
      await this.loadData(); this.renderAthletesList(); this.render();
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
            <span>🏋️ <strong>${a.bench.toFixed(1)}</strong></span>
            <span>🦵 <strong>${a.squat.toFixed(1)}</strong></span>
            <span>💀 <strong>${a.deadlift.toFixed(1)}</strong></span>
            <span>🏆 <strong>${(a.bench + a.squat + a.deadlift).toFixed(1)}</strong></span>
            ${window.OTHER_LIFTS.map((l) => `<span>${l.emoji} <strong>${this.displayValue(l.id, this.valueFor(a, l.id))}</strong></span>`).join('')}
          </div>
        </div>
        <div class="athlete-card-actions">
          <button class="btn btn-edit" onclick="app.openAthleteModal('${a.id}')">Edit</button>
          <button class="btn btn-danger" onclick="app.deleteAthlete('${a.id}')">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  // --- tabs / focus ---------------------------------------------------------
  switchTab(tabName) {
    this.activeTab = tabName;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
    if (this.tvMode) { this.tvPage = 0; this.fitTvPaging(); }
  }
  // Spotlight a lift (podium) within its own tab — works for main and other lifts.
  focusLift(liftType) {
    const section = document.querySelector(`.leaderboard-section[data-lift="${liftType}"]`);
    if (!section) return;
    const group = section.closest('.leaderboards');
    group.querySelectorAll('.leaderboard-section').forEach((s) => s.classList.remove('focused'));
    section.classList.add('focused');
    this.render();
  }

  // --- TV / display mode ----------------------------------------------------
  // Big landscape layout + hands-free tab cycling, toggled by ?tv or the 📺 button.
  // Rotation pauses while the browser tab is hidden (the office TV cycles between a
  // few pages) and resumes where it left off, so every tab gets airtime over time.
  applyTvMode(on) {
    this.tvMode = on;
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

  // Tabs to cycle, in on-screen order; skip Other Lifts when none are configured.
  rotationTabs() {
    return [...document.querySelectorAll('.tab-btn')]
      .map((b) => b.dataset.tab)
      .filter((t) => !(t === 'other' && window.OTHER_LIFTS.length === 0));
  }

  startRotation() {
    this.stopRotation();
    this.scheduleTick();
  }
  // One self-rescheduling tick. Page dwells vary (see currentDwellMs), so a fixed
  // setInterval won't do — each tick schedules the next using the current dwell.
  scheduleTick() {
    if (!this.tvMode || document.hidden) return;
    this.restartProgress();
    this.rotateTimer = setTimeout(() => { this.advanceTab(); this.scheduleTick(); }, this.currentDwellMs());
  }
  stopRotation() {
    if (this.rotateTimer) { clearTimeout(this.rotateTimer); this.rotateTimer = null; }
    document.querySelectorAll('.tab-btn.rotating').forEach((b) => b.classList.remove('rotating'));
  }
  restartRotationTimer() { if (this.tvMode) this.startRotation(); } // e.g. after a manual tab click

  // rotateMs is the budget *per tab* (the configured cadence), so a multi-page tab
  // still hands off on time. Pages split that budget; page 1 (podium + top ranks)
  // gets double the dwell of the rest, which viewers mostly scan for their own name.
  currentDwellMs() {
    const pages = Math.max(1, this.tvPages);
    const weight = this.tvPage === 0 ? 2 : 1;
    return Math.round((this.rotateMs * weight) / (pages + 1));
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
  valueFor(a, lift) {
    if (lift === 'total') return a.bench + a.squat + a.deadlift;
    if (window.getOtherLift(lift)) return Number(a.lifts?.[lift] ?? 0);
    return a[lift];
  }
  // Sorts descending, so for time lifts (seconds) a LONGER hang ranks higher.
  sorted(lift) { return [...this.athletes].sort((a, b) => this.valueFor(b, lift) - this.valueFor(a, lift)); }

  liftUnit(lift) { return window.getOtherLift(lift)?.unit || 'kg'; }
  displayValue(lift, value) {
    return this.liftUnit(lift) === 'time' ? window.formatLiftTime(value) : Number(value).toFixed(1);
  }
  displayValueUnit(lift, value) {
    return this.liftUnit(lift) === 'time' ? this.displayValue(lift, value) : `${this.displayValue(lift, value)} kg`;
  }

  render() {
    LIFTS.forEach((l) => this.renderLeaderboard(l));
    this.renderLeaderboard('total');
    window.OTHER_LIFTS.forEach((l) => this.renderLeaderboard(l.id));
    this.renderHallOfFame();
    this.updateReviewCount();
    if (this.tvMode) this.fitTvPaging();
  }

  updateReviewCount() {
    const badge = document.getElementById('reviewCount');
    const n = this.reviewable().length;
    badge.textContent = n;
    badge.hidden = n === 0;
  }

  renderLeaderboard(liftType) {
    const section = document.querySelector(`#${liftType}Table`).closest('.leaderboard-section');
    const tbody = section.querySelector('tbody');
    const ranked = this.sorted(liftType).filter((a) => liftType === 'total' || this.valueFor(a, liftType) > 0);
    section.querySelector('.podium-container')?.remove();

    if (ranked.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-state">No entries yet.</td></tr>`;
      return;
    }
    const showPodium = section.classList.contains('focused') || this.tvMode;
    const tableAthletes = showPodium ? ranked.slice(3) : ranked;
    const startRank = showPodium ? 4 : 1;
    if (showPodium) this.renderPodium(section, ranked.slice(0, 3), liftType);

    tbody.innerHTML = tableAthletes.map((a, i) => {
      const rank = startRank + i;
      return `<tr>
        <td><span class="rank">${this.rankDisplay(rank)}</span></td>
        <td><button type="button" class="athlete-name athlete-link" onclick="app.openHistory('${a.id}')" title="See progression">${this.escapeHtml(a.name)}</button>${this.badgesFor(a)}${this.pendingForAthlete(a.id) ? '<span class="badge-chip pending" title="Has a pending change">⏳</span>' : ''}</td>
        <td><span class="pr-value">${this.displayValue(liftType, this.valueFor(a, liftType))}</span></td>
      </tr>`;
    }).join('');
  }

  renderPodium(section, top3, liftType) {
    const container = document.createElement('div');
    container.className = 'podium-container';
    const order = [top3[1], top3[0], top3[2]];
    const positions = ['second', 'first', 'third'];
    const ranks = [2, 1, 3];
    order.forEach((athlete, i) => {
      if (!athlete) return;
      const spot = document.createElement('div');
      spot.className = `podium-spot ${positions[i]}`;
      spot.innerHTML = `
        <div class="podium-athlete">
          <div class="podium-avatar">${window.renderAvatar(athlete, this.tvMode ? 48 : 84)}</div>
          <div class="podium-medal">${this.medalMark(ranks[i], this.tvMode ? 26 : 32)}</div>
          <div class="podium-name"><button type="button" class="athlete-link" onclick="app.openHistory('${athlete.id}')" title="See progression">${this.escapeHtml(athlete.name)}</button></div>
          <div class="podium-value">${this.displayValueUnit(liftType, this.valueFor(athlete, liftType))}</div>
        </div>
        <div class="podium-stand"><div class="podium-rank">${ranks[i]}</div></div>`;
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

  // TV mode: a roster can outgrow one screen. Rather than clip the overflow rows
  // (rank 4+ under each podium), measure how many fit beneath the podium and split
  // the rest into screen-sized pages that the tab rotation cycles through, so every
  // athlete gets airtime. No-op for small rosters (everything fits → a single page).
  // Runs after render, on tab switch and on resize — never on a hidden tab.
  // TODO(tv): the podium eats the most vertical room; a more compact top-3 in dense
  //   layouts would free rows and shrink the page count.
  fitTvPaging() {
    const frame = document.querySelector('.tab-content.active');
    if (!this.tvMode || !frame) { this.tvPages = 1; return; }
    const bottom = frame.getBoundingClientRect().bottom - TV_PAGE_PAD;
    this.tvBoards = [];
    let pages = 1;
    frame.querySelectorAll('.leaderboard-section').forEach((section) => {
      const tbody = section.querySelector('tbody');
      const rows = tbody && !tbody.querySelector('.empty-state') ? [...tbody.rows] : [];
      if (rows.length === 0) return;
      rows.forEach((tr) => { tr.hidden = false; }); // un-hide so we measure the full table, not a prior page
      const rowH = rows[0].getBoundingClientRect().height || 1;
      const perPage = Math.max(1, Math.floor((bottom - tbody.getBoundingClientRect().top) / rowH));
      this.tvBoards.push({ rows, perPage, pages: Math.ceil(rows.length / perPage) });
      pages = Math.max(pages, Math.ceil(rows.length / perPage));
    });
    this.tvPages = pages;
    this.tvPage = Math.min(this.tvPage, pages - 1);
    this.applyTvPage();
  }

  // Show only the current page's slice of each board's overflow rows, then draw the
  // page dots. A board with fewer pages pins to its last page, so a shorter board
  // never blinks empty while a longer one is still paging.
  applyTvPage() {
    (this.tvBoards || []).forEach(({ rows, perPage, pages }) => {
      const start = Math.min(this.tvPage, pages - 1) * perPage;
      rows.forEach((tr, i) => { tr.hidden = i < start || i >= start + perPage; });
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
      const body = achievers.length === 0
        ? `<div class="empty-achievement"><p>${this.escapeHtml(ach.emptyText)}</p></div>`
        : `<div class="hall-of-fame">${achievers.map((a) => `<div class="achievement-badge"><div class="badge-avatar">${window.renderAvatar(a, 66)}</div><div class="badge-name">${this.escapeHtml(a.name)}</div><div class="badge-subtitle">${this.escapeHtml(ach.title)}</div></div>`).join('')}</div>
           <div class="achievement-count">${achievers.length} ${achievers.length === 1 ? 'person has' : 'people have'} earned this</div>`;
      return `<div class="achievement-section"><h2>${ach.emoji} ${this.escapeHtml(ach.name)}</h2><p class="achievement-description">${this.escapeHtml(ach.description)}</p>${body}</div>`;
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
    const id = this.historyAthleteId;
    const a = this.athleteById(id);
    const body = document.getElementById('historyBody');
    if (!a || !body) return;
    try {
      const rows = await window.Store.listAthleteHistory(id);
      // Bail if the user switched/closed the modal while we were fetching.
      if (this.historyAthleteId !== id || !this.isOpen('historyModal')) return;
      this.renderHistory(rows);
    } catch (e) {
      body.innerHTML = `<p class="empty-state">${this.escapeHtml(this.errText(e))}</p>`;
    }
  }

  renderHistory(rows) {
    const body = document.getElementById('historyBody');
    const byLift = new Map();
    for (const r of rows) {
      const lift = r.payload?.lift;
      if (!lift) continue;
      if (!byLift.has(lift)) byLift.set(lift, []);
      byLift.get(lift).push({ value: Number(r.payload.value), at: r.decided_at });
    }
    if (byLift.size === 0) {
      body.innerHTML = '<p class="empty-state">No verified PRs yet — progression shows up here once PRs are peer-verified.</p>';
      return;
    }
    // Main lifts first, then "other lifts", in their registry order; unknowns last.
    const order = [...LIFTS, ...window.OTHER_LIFTS.map((l) => l.id)];
    const liftIds = [...byLift.keys()].sort((x, y) => {
      const ix = order.indexOf(x), iy = order.indexOf(y);
      return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
    });
    body.innerHTML = liftIds.map((lid) => this.renderHistoryLift(lid, byLift.get(lid))).join('');
  }

  renderHistoryLift(lid, series) {
    const meta = LIFT_META[lid] || window.getOtherLift(lid) || { emoji: '', label: lid };
    const first = series[0].value;
    const last = series[series.length - 1].value;
    const delta = last - first;
    const head = series.length === 1
      ? '<span class="history-delta first">first PR</span>'
      : `<span class="history-delta ${delta >= 0 ? 'up' : 'down'}">${this.displaySignedDelta(lid, delta)}</span>`;
    const points = series.map((p) =>
      `<li><span class="hist-date">${this.formatDate(p.at)}</span><span class="hist-val">${this.escapeHtml(this.displayValueUnit(lid, p.value))}</span></li>`
    ).join('');
    return `<div class="history-lift">
      <div class="history-lift-head">
        <h3>${meta.emoji} ${this.escapeHtml(meta.label)}</h3>
        ${head}
      </div>
      ${this.sparkline(lid, series)}
      <ul class="history-points">${points}</ul>
    </div>`;
  }

  // Hand-rolled inline SVG line chart. Uniform scaling (no preserveAspectRatio
  // tricks) so dots stay round; #squiggle gives it the whiteboard look.
  sparkline(lid, series) {
    const W = 320, H = 90, pad = 12;
    const vals = series.map((s) => s.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const n = series.length;
    const x = (i) => n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad);
    const y = (v) => max === min ? H / 2 : H - pad - ((v - min) / (max - min)) * (H - 2 * pad);
    const dot = (s, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s.value).toFixed(1)}" r="4"><title>${this.escapeHtml(this.formatDate(s.at) + ': ' + this.displayValueUnit(lid, s.value))}</title></circle>`;
    const dots = series.map(dot).join('');
    const line = n > 1
      ? `<polyline class="spark-line" points="${series.map((s, i) => `${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ')}" filter="url(#squiggle)"/>`
      : '';
    return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progression chart">${line}${dots}</svg>`;
  }

  // Signed change for the lift's unit ("+12.5 kg" / "−0:08" for time lifts).
  displaySignedDelta(lid, delta) {
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
    const mag = Math.abs(delta);
    return this.liftUnit(lid) === 'time' ? `${sign}${window.formatLiftTime(mag)}` : `${sign}${mag.toFixed(1)} kg`;
  }

  formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // --- misc -----------------------------------------------------------------
  showConfigBanner() {
    const banner = document.createElement('div');
    banner.className = 'config-banner';
    banner.innerHTML = `<strong>⚙️ Not connected yet.</strong> Set your Supabase URL/key in <code>js/config.js</code> and run <code>supabase/schema.sql</code>. See the README.`;
    document.querySelector('.container').prepend(banner);
  }

  errText(e) {
    const m = e?.message || String(e);
    return m.replace(/^.*?:\s*/, '').slice(0, 140) || 'Something went wrong';
  }
  escapeHtml(text) { const d = document.createElement('div'); d.textContent = text ?? ''; return d.innerHTML; }
  showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.animation = 'slideInRight 0.3s ease reverse'; setTimeout(() => toast.remove(), 300); }, 3200);
  }
}

let app;
document.addEventListener('DOMContentLoaded', () => { app = new LeaderboardApp(); });
