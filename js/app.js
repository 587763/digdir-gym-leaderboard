// Main UI controller for the Digdir Gym Leaderboard.
// Governance: admins manage everything; signed-in users claim an athlete (admin
// approves); linked users propose PR/achievement changes (peer-verified) and name
// changes / new athletes (admin-approved). Rules are enforced in the DB; this is UI.

const LIFTS = ['squat', 'bench', 'deadlift'];
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
    this.focusedLift = 'bench';
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
    this.render();
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

  setupEventListeners() {
    document.querySelectorAll('.tab-btn').forEach((btn) =>
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab)));
    document.querySelectorAll('.lift-header').forEach((h) =>
      h.addEventListener('click', () => this.focusLift(h.dataset.lift)));

    document.getElementById('myAthleteBtn').onclick = () => this.openMine();
    document.getElementById('claimBtn').onclick = () => this.openClaim();
    document.getElementById('reviewBtn').onclick = () => this.openReview();
    document.getElementById('adminBtn').onclick = () => this.openAdmin();
    document.getElementById('manageAthletesBtn').onclick = () => this.openManage();
    document.getElementById('addNewAthleteBtn').onclick = () => { this.closeAll(); this.openAthleteModal(); };
    document.getElementById('exportBtn').onclick = () => this.exportData();

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
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refreshAll(); });
    window.addEventListener('focus', () => this.refreshAll());
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
    const earned = a.achievements || [];
    document.querySelectorAll('.mine-achievement-check').forEach((c) => (c.checked = earned.includes(c.value)));
    this.mineSnapshot = { name: a.name, squat: a.squat, bench: a.bench, deadlift: a.deadlift, achievements: [...earned] };
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
      case 'pr': text = `<strong>${aName}</strong>: ${LIFT_META[p.payload.lift]?.emoji || ''} ${this.escapeHtml(p.payload.lift)} → <strong>${this.escapeHtml(String(p.payload.value))} kg</strong>`; break;
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
    const data = {
      name: document.getElementById('athleteName').value.trim(),
      bench: num('bench'), squat: num('squat'), deadlift: num('deadlift'),
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
  }
  focusLift(liftType) {
    this.focusedLift = liftType;
    const tab = document.getElementById('lifts-tab');
    tab.querySelectorAll('.leaderboard-section').forEach((s) => s.classList.remove('focused'));
    tab.querySelector(`[data-lift="${liftType}"]`)?.classList.add('focused');
    this.render();
  }

  // --- board rendering (unchanged core) ------------------------------------
  valueFor(a, lift) { return lift === 'total' ? a.bench + a.squat + a.deadlift : a[lift]; }
  sorted(lift) { return [...this.athletes].sort((a, b) => this.valueFor(b, lift) - this.valueFor(a, lift)); }

  render() {
    LIFTS.forEach((l) => this.renderLeaderboard(l));
    this.renderLeaderboard('total');
    this.renderHallOfFame();
    this.updateReviewCount();
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
    const ranked = this.sorted(liftType).filter((a) => liftType === 'total' || a[liftType] > 0);
    section.querySelector('.podium-container')?.remove();

    if (ranked.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-state">No entries yet.</td></tr>`;
      return;
    }
    const showPodium = section.classList.contains('focused');
    const tableAthletes = showPodium ? ranked.slice(3) : ranked;
    const startRank = showPodium ? 4 : 1;
    if (showPodium) this.renderPodium(section, ranked.slice(0, 3), liftType);

    tbody.innerHTML = tableAthletes.map((a, i) => {
      const rank = startRank + i;
      return `<tr>
        <td><span class="rank">${this.rankDisplay(rank)}</span></td>
        <td><span class="athlete-name">${this.escapeHtml(a.name)}</span>${this.badgesFor(a)}${this.pendingForAthlete(a.id) ? '<span class="badge-chip pending" title="Has a pending change">⏳</span>' : ''}</td>
        <td><span class="pr-value">${this.valueFor(a, liftType).toFixed(1)}</span></td>
      </tr>`;
    }).join('');
  }

  renderPodium(section, top3, liftType) {
    const container = document.createElement('div');
    container.className = 'podium-container';
    const order = [top3[1], top3[0], top3[2]];
    const positions = ['second', 'first', 'third'];
    const medals = ['🥈', '🥇', '🥉'];
    const ranks = [2, 1, 3];
    order.forEach((athlete, i) => {
      if (!athlete) return;
      const spot = document.createElement('div');
      spot.className = `podium-spot ${positions[i]}`;
      spot.innerHTML = `
        <div class="podium-athlete">
          <div class="podium-avatar">${window.renderAvatar(athlete, 84)}</div>
          <div class="podium-medal">${medals[i]}</div>
          <div class="podium-name">${this.escapeHtml(athlete.name)}</div>
          <div class="podium-value">${this.valueFor(athlete, liftType).toFixed(1)} kg</div>
        </div>
        <div class="podium-stand"><div class="podium-rank">${ranks[i]}</div></div>`;
      container.appendChild(spot);
    });
    section.querySelector('h2').after(container);
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

  // --- misc -----------------------------------------------------------------
  exportData() {
    const blob = new Blob([JSON.stringify(this.athletes, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `leaderboard-backup-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
    this.showToast('Backup downloaded', 'success');
  }

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
