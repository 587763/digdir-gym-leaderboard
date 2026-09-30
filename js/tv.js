// TV / display mode: a big landscape layout that cycles the tabs hands-free.
// Rotation pauses while a dialog is open (closing it starts a fresh dwell) and while
// the browser tab is hidden: an office screen may rotate between several pages, so
// the countdown resumes where it left off and every tab still gets its airtime.
window.TvDisplay = class TvDisplay {
  static PAGE_PAD = 48;       // px reserved under the boards for the page dots
  static MIN_DWELL_MS = 5000; // later pages stay readable even for huge rosters

  // app provides: activeTab, switchTab(tab), render(), renderBoard(liftId, podiumFits),
  // and hasContent(tab) to skip empty tabs.
  constructor(app, params = new URLSearchParams(location.search)) {
    this.app = app;
    let saved = false;
    try { saved = localStorage.getItem('lb.tv') === '1'; } catch { /* Storage may be disabled. */ }
    this.enabled = params.has('tv') || saved;
    // ?rotate=<seconds>: target time per tab (5–120 s, default 15).
    this.rotateMs = Math.min(120000, Math.max(5000, (Number(params.get('rotate')) || 15) * 1000));
    // ?tabs=lifts,total: optionally restrict which tabs the display cycles through.
    this.onlyTabs = (params.get('tabs') || '').split(',').map((t) => t.trim()).filter(Boolean);
    this.timer = null;
    this.tick = null;      // { startedAt, wait } of the scheduled advance
    this.remaining = null; // ms left on the current page when the tab was hidden
    this.page = 0;   // current page within the active tab
    this.pages = 1;  // page count for the active tab, recomputed by fit()
    this.boards = [];
  }

  apply(on) {
    this.enabled = on;
    const button = document.getElementById('tvModeBtn');
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? '✕ Exit TV mode' : '📺 TV mode';
    document.documentElement.classList.toggle('tv-mode', on);
    if (on) {
      UI.dialogs.closeAll();
      const tabs = this.rotationTabs();
      if (!tabs.includes(this.app.activeTab)) this.app.switchTab(tabs[0]);
    } else { this.page = 0; document.querySelectorAll('.tv-page-dots').forEach((d) => d.remove()); }
    this.app.render(); // podium sizes and Hall of Fame layout differ in TV mode
    if (on) this.start(); else this.stop();
  }

  toggle() {
    const on = !this.enabled;
    try { localStorage.setItem('lb.tv', on ? '1' : '0'); } catch { /* private mode */ }
    // Keep the URL honest so a reload matches what's on screen.
    const url = new URL(location.href);
    if (on) url.searchParams.set('tv', '1'); else url.searchParams.delete('tv');
    history.replaceState(null, '', url);
    this.apply(on);
  }

  // Tabs to cycle, in on-screen order, skipping tabs with nothing to show.
  rotationTabs() {
    const tabs = [...document.querySelectorAll('.tab-btn')].map((b) => b.dataset.tab)
      .filter((tab) => this.app.hasContent(tab));
    const chosen = tabs.filter((tab) => this.onlyTabs.includes(tab));
    return chosen.length ? chosen : tabs;
  }

  // --- rotation ----------------------------------------------------------------
  start() { this.remaining = null; this.stop(); this.scheduleTick(); }
  restart() { if (this.enabled) this.start(); } // e.g. after a manual tab click
  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.tick = null;
    document.querySelectorAll('.tab-btn.rotating').forEach((b) => b.classList.remove('rotating'));
  }
  // Hidden → remember the rest of this page's dwell; visible → continue with it.
  pause() {
    if (this.tick) this.remaining = Math.max(0, this.tick.wait - (Date.now() - this.tick.startedAt));
    this.stop();
  }
  resume() {
    const remaining = this.remaining;
    this.remaining = null;
    this.stop();
    this.scheduleTick(remaining);
  }
  // One self-rescheduling tick: page dwells vary, so a fixed interval won't do.
  scheduleTick(remaining = null) {
    clearTimeout(this.timer);
    if (!this.enabled || document.hidden || UI.dialogs.anyOpen()) return;
    const dwell = this.dwellMs();
    const wait = remaining == null ? dwell : Math.min(remaining, dwell);
    this.tick = { startedAt: Date.now(), wait };
    this.restartProgress(dwell, dwell - wait);
    this.timer = setTimeout(() => { this.tick = null; this.advance(); this.scheduleTick(); }, wait);
  }

  // rotateMs is the budget *per tab*, so a multi-page tab splits it; page one gets
  // double the dwell of the rest. Large rosters extend the budget instead of
  // flashing unreadable sub-second pages.
  dwellMs() {
    const pages = Math.max(1, this.pages);
    const weight = this.page === 0 ? 2 : 1;
    return Math.max(TvDisplay.MIN_DWELL_MS * (pages === 1 ? 1 : weight), Math.round((this.rotateMs * weight) / (pages + 1)));
  }

  advance() {
    if (UI.dialogs.anyOpen()) return; // don't yank a tab out from under someone reading
    const tabs = this.rotationTabs();
    // Page through a tall board before leaving it, unless it is outside the rotation.
    if (tabs.includes(this.app.activeTab) && this.advancePage()) return;
    const i = tabs.indexOf(this.app.activeTab);
    this.app.switchTab(tabs[(i + 1) % tabs.length]);
  }

  // Step to the next page of the active tab; false on the last page.
  advancePage() {
    if (!this.enabled || this.page + 1 >= this.pages) return false;
    this.page++;
    this.applyPage();
    return true;
  }

  // Restart the CSS countdown bar under the active tab (remove → reflow → re-add);
  // a negative delay starts it part-way when resuming.
  restartProgress(dwell = this.dwellMs(), elapsed = 0) {
    document.querySelectorAll('.tab-btn.rotating').forEach((b) => b.classList.remove('rotating'));
    const bar = document.querySelector('.tab-btn.active');
    if (!bar) return;
    document.documentElement.style.setProperty('--rotate-ms', `${dwell}ms`);
    document.documentElement.style.setProperty('--rotate-delay', `${-elapsed}ms`);
    void bar.offsetWidth;
    if (this.enabled && !document.hidden && !UI.dialogs.anyOpen()) bar.classList.add('rotating');
  }

  // --- fitting and paging ------------------------------------------------------
  // Fit variable-height rows (including wrapped names) into the actual screen space,
  // withdrawing a podium when it leaves no room for up to two ranked rows.
  fit() {
    const frame = document.querySelector('.tab-content.active');
    if (!this.enabled || !frame) { this.pages = 1; return; }
    const previousPages = this.pages;
    const previousPage = this.page;
    const bottom = frame.getBoundingClientRect().bottom - TvDisplay.PAGE_PAD;
    // Reconsider podiums after fonts, available height or the active tab change.
    for (const liftId of [...frame.querySelectorAll('[data-lift]')].map((s) => s.dataset.lift)) {
      const section = this.app.renderBoard(liftId, true);
      const podium = section.querySelector('.podium-container');
      if (!podium) continue;
      const rows = [...section.querySelectorAll('tbody tr')];
      const rowHeight = Math.max(0, ...rows.map((row) => row.getBoundingClientRect().height));
      const needed = rowHeight * Math.min(2, rows.length);
      const start = section.querySelector('table').hidden ? podium.getBoundingClientRect().bottom
        : section.querySelector('tbody').getBoundingClientRect().top;
      if (start + needed > bottom) this.app.renderBoard(liftId, false);
    }
    // Hall of Fame: badge cards when they fit, otherwise paged tables.
    if (frame.querySelector('#hallOfFame') && this.app.renderHallOfFame(false).getBoundingClientRect().bottom > bottom) {
      this.app.renderHallOfFame(true);
    }
    this.boards = [];
    let pages = 1;
    frame.querySelectorAll('.leaderboard-section').forEach((section) => {
      const tbody = section.querySelector('tbody');
      const rows = tbody && !tbody.querySelector('.empty-state') ? [...tbody.querySelectorAll('tr')] : [];
      if (rows.length === 0) return;
      rows.forEach((tr) => { tr.hidden = false; }); // measure the full table, not a prior page
      const room = Math.max(1, bottom - tbody.getBoundingClientRect().top);
      const slices = this.partitionRows(rows, room);
      this.boards.push({ rows, slices });
      pages = Math.max(pages, slices.length);
    });
    this.pages = pages;
    this.page = Math.min(this.page, pages - 1);
    this.applyPage();
    if (previousPages !== pages || previousPage !== this.page) this.restart();
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

  // Show the current page's slice of each board, then draw the page dots. A board
  // with fewer pages pins to its last page, so it never blinks empty.
  applyPage() {
    this.boards.forEach(({ rows, slices }) => {
      const visible = new Set(slices[Math.min(this.page, slices.length - 1)]);
      rows.forEach((row) => { row.hidden = !visible.has(row); });
    });
    const frame = document.querySelector('.tab-content.active');
    if (!frame) return;
    frame.querySelector('.tv-page-dots')?.remove();
    if (this.pages <= 1) return;
    const dots = document.createElement('div');
    dots.className = 'tv-page-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.innerHTML = Array.from({ length: this.pages }, (_, i) =>
      `<span class="tv-page-dot${i === this.page ? ' active' : ''}"></span>`).join('');
    frame.appendChild(dots);
  }

  // A tab switch starts at the first page.
  onTabChange() { if (this.enabled) { this.page = 0; this.fit(); } }
};
