// Main UI controller for the Digdir Gym Leaderboard.

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
    this.user = null;
    this.isEditor = false;
    this.editingId = null;
    this.activeTab = 'lifts';
    this.focusedLift = 'bench';
    this.init();
  }

  async init() {
    if (!window.Store.configured) {
      this.showConfigBanner();
      return;
    }
    this.buildAchievementFields();
    this.setupEventListeners();

    this.user = await window.Store.getUser();
    this.isEditor = this.user ? await window.Store.isEditorCached() : false;
    window.Store.onAuthChange(async (session) => {
      this.user = session?.user ?? null;
      this.isEditor = await this.resolveEditor(session);
      this.reflectAuth();
      this.render();
      if (this.isManageOpen()) this.renderAthletesList();
    });

    try {
      this.athletes = await window.Store.list();
    } catch (e) {
      this.showToast('Could not load the leaderboard', 'error');
      console.error(e);
    }

    // Live updates from anyone editing, anywhere.
    window.Store.subscribe(async () => {
      try {
        this.athletes = await window.Store.list();
        this.render();
        if (this.isManageOpen()) this.renderAthletesList();
      } catch (e) {
        console.error(e);
      }
    });

    this.reflectAuth();
    this.render();
  }

  // --- auth -----------------------------------------------------------------
  // Determine editor status: fresh sign-in (provider_token present) => verify org
  // membership at GitHub; otherwise fall back to the cached editors row.
  async resolveEditor(session) {
    if (!session?.user) return false;
    if (session.provider_token) return window.Store.verifyEditor(session.provider_token);
    return window.Store.isEditorCached();
  }

  reflectAuth() {
    const signedIn = !!this.user;
    document.body.classList.toggle('signed-in', signedIn);
    document.body.classList.toggle('can-edit', this.isEditor);

    const authArea = document.getElementById('authArea');
    if (!signedIn) {
      authArea.innerHTML = `<button id="signInBtn" class="btn btn-primary">Sign in with GitHub to edit</button>`;
      document.getElementById('signInBtn').addEventListener('click', () => window.Store.signIn());
      return;
    }

    const label = this.escapeHtml(window.Store.userLabel(this.user));
    const badge = this.isEditor
      ? `<span class="auth-user">✍️ ${label}</span>`
      : `<span class="auth-user view-only" title="Only felleslosninger members can edit">👀 ${label} · view only</span>`;
    authArea.innerHTML = `${badge}<button id="signOutBtn" class="btn btn-ghost">Sign out</button>`;
    document.getElementById('signOutBtn').addEventListener('click', () => window.Store.signOut());
  }

  // --- setup ----------------------------------------------------------------
  buildAchievementFields() {
    const container = document.getElementById('achievementFields');
    container.innerHTML = window.ACHIEVEMENTS.map(
      (a) => `
        <label class="form-check">
          <input type="checkbox" class="achievement-check" value="${a.id}">
          <span>${a.emoji} ${this.escapeHtml(a.name)}</span>
        </label>`
    ).join('');
  }

  setupEventListeners() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    document.querySelectorAll('.lift-header').forEach((header) => {
      header.addEventListener('click', () => this.focusLift(header.dataset.lift));
    });

    document.getElementById('manageAthletesBtn').addEventListener('click', () => this.openManageModal());
    document.getElementById('addNewAthleteBtn').addEventListener('click', () => {
      this.closeManageModal();
      this.openModal();
    });
    document.querySelector('.close-manage').addEventListener('click', () => this.closeManageModal());
    document.querySelector('.close').addEventListener('click', () => this.closeModal());
    document.getElementById('cancelBtn').addEventListener('click', () => this.closeModal());
    document.getElementById('athleteForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveAthlete();
    });
    document.getElementById('athleteName').addEventListener('input', () => this.updateAvatarPreview());

    window.addEventListener('click', (e) => {
      if (e.target === document.getElementById('athleteModal')) this.closeModal();
      if (e.target === document.getElementById('manageModal')) this.closeManageModal();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeModal();
        this.closeManageModal();
      }
    });

    document.getElementById('exportBtn').addEventListener('click', () => this.exportData());
  }

  // --- modals ---------------------------------------------------------------
  openModal(athleteId = null) {
    if (!this.isEditor) return this.showToast('Only felleslosninger members can edit', 'error');
    const form = document.getElementById('athleteForm');
    const title = document.getElementById('modalTitle');
    form.reset();

    if (athleteId) {
      const a = this.athletes.find((x) => x.id === athleteId);
      title.textContent = 'Edit athlete';
      document.getElementById('athleteName').value = a.name;
      document.getElementById('bench').value = a.bench;
      document.getElementById('squat').value = a.squat;
      document.getElementById('deadlift').value = a.deadlift;
      document.querySelectorAll('.achievement-check').forEach((c) => {
        c.checked = (a.achievements || []).includes(c.value);
      });
      this.editingId = athleteId;
    } else {
      title.textContent = 'Add athlete';
      this.editingId = null;
    }

    this.updateAvatarPreview();
    document.getElementById('athleteModal').style.display = 'block';
    document.getElementById('athleteName').focus();
  }

  closeModal() {
    document.getElementById('athleteModal').style.display = 'none';
    document.getElementById('athleteForm').reset();
    this.editingId = null;
  }

  openManageModal() {
    if (!this.isEditor) return this.showToast('Only felleslosninger members can edit', 'error');
    document.getElementById('manageModal').style.display = 'block';
    this.renderAthletesList();
  }

  closeManageModal() {
    document.getElementById('manageModal').style.display = 'none';
  }

  isManageOpen() {
    return document.getElementById('manageModal').style.display === 'block';
  }

  updateAvatarPreview() {
    const preview = document.getElementById('avatarPreview');
    const name = document.getElementById('athleteName').value || 'New athlete';
    const achievements = [...document.querySelectorAll('.achievement-check')]
      .filter((c) => c.checked)
      .map((c) => c.value);
    preview.innerHTML = window.renderAvatar({ name, achievements }, 110);
  }

  // --- CRUD -----------------------------------------------------------------
  formData() {
    const num = (id) => Math.max(0, parseFloat(document.getElementById(id).value) || 0);
    return {
      name: document.getElementById('athleteName').value.trim(),
      bench: num('bench'),
      squat: num('squat'),
      deadlift: num('deadlift'),
      achievements: [...document.querySelectorAll('.achievement-check')]
        .filter((c) => c.checked)
        .map((c) => c.value),
    };
  }

  async saveAthlete() {
    const data = this.formData();
    if (!data.name) return this.showToast('Please enter a name', 'error');

    try {
      if (this.editingId) {
        await window.Store.update(this.editingId, data, this.user);
        this.showToast('Athlete updated', 'success');
      } else {
        await window.Store.create(data, this.user);
        this.showToast('Athlete added', 'success');
      }
      this.athletes = await window.Store.list();
      this.closeModal();
      this.render();
    } catch (e) {
      console.error(e);
      this.showToast('Save failed — are you still signed in?', 'error');
    }
  }

  async deleteAthlete(id) {
    const a = this.athletes.find((x) => x.id === id);
    if (!confirm(`Delete ${a?.name ?? 'this athlete'}? This can't be undone.`)) return;
    try {
      await window.Store.remove(id);
      this.athletes = await window.Store.list();
      this.renderAthletesList();
      this.render();
      this.showToast('Athlete deleted', 'success');
    } catch (e) {
      console.error(e);
      this.showToast('Delete failed', 'error');
    }
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
    const target = tab.querySelector(`[data-lift="${liftType}"]`);
    if (target) target.classList.add('focused');
    this.render();
  }

  // --- rendering ------------------------------------------------------------
  valueFor(athlete, liftType) {
    return liftType === 'total'
      ? athlete.bench + athlete.squat + athlete.deadlift
      : athlete[liftType];
  }

  sorted(liftType) {
    return [...this.athletes].sort((a, b) => this.valueFor(b, liftType) - this.valueFor(a, liftType));
  }

  render() {
    LIFTS.forEach((l) => this.renderLeaderboard(l));
    this.renderLeaderboard('total');
    this.renderHallOfFame();
  }

  renderLeaderboard(liftType) {
    const section = document.querySelector(`#${liftType}Table`).closest('.leaderboard-section');
    const tbody = section.querySelector('tbody');
    const ranked = this.sorted(liftType).filter((a) => liftType === 'total' || a[liftType] > 0);

    // remove any stale podium
    const oldPodium = section.querySelector('.podium-container');
    if (oldPodium) oldPodium.remove();

    if (ranked.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-state">No entries yet — add an athlete to get started!</td></tr>`;
      return;
    }

    const showPodium = section.classList.contains('focused');
    const tableAthletes = showPodium ? ranked.slice(3) : ranked;
    const startRank = showPodium ? 4 : 1;

    if (showPodium) this.renderPodium(section, ranked.slice(0, 3), liftType);

    tbody.innerHTML = tableAthletes
      .map((a, i) => {
        const rank = startRank + i;
        return `<tr>
          <td><span class="rank">${this.rankDisplay(rank)}</span></td>
          <td><span class="athlete-name">${this.escapeHtml(a.name)}</span>${this.badgesFor(a)}</td>
          <td><span class="pr-value">${this.valueFor(a, liftType).toFixed(1)}</span></td>
        </tr>`;
      })
      .join('');
  }

  renderPodium(section, top3, liftType) {
    const container = document.createElement('div');
    container.className = 'podium-container';

    const order = [top3[1], top3[0], top3[2]]; // 2nd, 1st, 3rd
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
        <div class="podium-stand">
          <div class="podium-rank">${ranks[i]}</div>
        </div>`;
      container.appendChild(spot);
    });

    section.querySelector('h2').after(container);
  }

  renderHallOfFame() {
    const root = document.getElementById('hallOfFame');
    root.innerHTML = window.ACHIEVEMENTS.map((ach) => {
      const achievers = this.athletes
        .filter((a) => (a.achievements || []).includes(ach.id))
        .sort((a, b) => a.name.localeCompare(b.name));

      const body =
        achievers.length === 0
          ? `<div class="empty-achievement"><p>${this.escapeHtml(ach.emptyText)}</p></div>`
          : `<div class="hall-of-fame">
              ${achievers
                .map(
                  (a) => `<div class="achievement-badge">
                    <div class="badge-avatar">${window.renderAvatar(a, 66)}</div>
                    <div class="badge-name">${this.escapeHtml(a.name)}</div>
                    <div class="badge-subtitle">${this.escapeHtml(ach.title)}</div>
                  </div>`
                )
                .join('')}
            </div>
            <div class="achievement-count">${achievers.length} ${achievers.length === 1 ? 'person has' : 'people have'} earned this</div>`;

      return `<div class="achievement-section">
          <h2>${ach.emoji} ${this.escapeHtml(ach.name)}</h2>
          <p class="achievement-description">${this.escapeHtml(ach.description)}</p>
          ${body}
        </div>`;
    }).join('');
  }

  renderAthletesList() {
    const container = document.getElementById('athletesList');
    if (this.athletes.length === 0) {
      container.innerHTML = '<p class="empty-state">No athletes yet. Add your first one!</p>';
      return;
    }
    const sorted = [...this.athletes].sort((a, b) => a.name.localeCompare(b.name));
    container.innerHTML = sorted
      .map(
        (a) => `<div class="athlete-card">
          <div class="athlete-card-avatar">${window.renderAvatar(a, 52)}</div>
          <div class="athlete-card-info">
            <h3>${this.escapeHtml(a.name)}${this.badgesFor(a)}</h3>
            <div class="athlete-stats">
              <span>🏋️ <strong>${a.bench.toFixed(1)}</strong></span>
              <span>🦵 <strong>${a.squat.toFixed(1)}</strong></span>
              <span>💀 <strong>${a.deadlift.toFixed(1)}</strong></span>
              <span>🏆 <strong>${(a.bench + a.squat + a.deadlift).toFixed(1)}</strong></span>
            </div>
          </div>
          <div class="athlete-card-actions">
            <button class="btn btn-edit" onclick="app.openModal('${a.id}')">Edit</button>
            <button class="btn btn-danger" onclick="app.deleteAthlete('${a.id}')">Delete</button>
          </div>
        </div>`
      )
      .join('');
  }

  badgesFor(athlete) {
    return (athlete.achievements || [])
      .map((id) => window.getAchievement(id))
      .filter(Boolean)
      .map((a) => `<span class="badge-chip" title="${this.escapeHtml(a.name)}">${a.emoji}</span>`)
      .join('');
  }

  rankDisplay(rank) {
    return { 1: '🥇', 2: '🥈', 3: '🥉' }[rank] || rank;
  }

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
    banner.innerHTML = `
      <strong>⚙️ Not connected yet.</strong>
      Add your Supabase URL and anon key in <code>js/config.js</code>, then run the SQL in
      <code>supabase/schema.sql</code>. See the README.`;
    document.querySelector('.container').prepend(banner);
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  }

  showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideInRight 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new LeaderboardApp();
});
