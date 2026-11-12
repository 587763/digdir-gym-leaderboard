// TV / display mode: a big landscape layout that cycles the tabs hands-free.
// Rotation pauses while a dialog is open (closing it starts a fresh dwell) and while
// the browser tab is hidden: an office screen may rotate between several pages, so
// the countdown resumes where it left off and every tab still gets its airtime.
window.TvDisplay = class TvDisplay {
  static PAGE_PAD = 48;       // px reserved under the boards for the page dots
  static MIN_DWELL_MS = 5000; // later pages stay readable even for huge rosters

  // app provides: activeTab, switchTab(tab), render(), renderBoard(liftId, podiumFits),
  // renderHallOfFame(asTables), and hasContent(tab) to skip empty tabs.
  constructor(app, params = new URLSearchParams(location.search)) {
    this.app = app;
    this.enabled = UI.hasParam('tv', params) || UI.stored.get('lb.tv') === '1';
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
    // The label says which way the button goes, so it carries no aria-pressed as well.
    document.getElementById('tvModeBtn').textContent = on ? '✕ Exit TV mode' : '📺 TV mode';
    document.documentElement.classList.toggle('tv-mode', on);
    if (on) {
      UI.dialogs.closeAll();
      this.showRotationTab();
    } else { this.page = 0; document.querySelectorAll('.tv-page-dots').forEach((d) => d.remove()); }
    this.app.render(); // podium sizes and Hall of Fame layout differ in TV mode
    if (on) this.start(); else this.stop();
  }

  toggle() {
    const on = !this.enabled;
    UI.stored.set('lb.tv', on ? '1' : '0');
    UI.setParam('tv', on);
    this.apply(on);
  }

  // The display starts on a tab of its rotation. The app calls this again once the first
  // data is in, because only then is it known which tabs have something to show.
  showRotationTab() {
    if (!this.enabled) return;
    const tabs = this.rotationTabs();
    if (!tabs.includes(this.app.activeTab)) this.app.switchTab(tabs[0]);
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
  // Fit variable-height rows (including wrapped names) into the actual screen space.
  // What gives way when rows don't fit, in order: a podium that leaves no room for two
  // ranked rows, the Hall of Fame's badge cards, the latest-PRs line, then the badges.
  fit() {
    const frame = document.querySelector('.tab-content.active');
    if (!this.enabled || !frame) { this.pages = 1; return; }
    const previousPages = this.pages;
    const previousPage = this.page;
    // Everything withdrawn takes its room back on every fit (fonts, screen size or the
    // active tab may have changed), and gives way again below if it must.
    const root = document.documentElement;
    root.classList.remove('tv-latest-withdrawn', 'tv-badges-withdrawn');
    const bottom = () => frame.getBoundingClientRect().bottom - TvDisplay.PAGE_PAD;
    this.fitPodiums(frame, bottom());
    if (frame.querySelector('#hallOfFame') && this.app.renderHallOfFame(false).getBoundingClientRect().bottom > bottom()) {
      this.app.renderHallOfFame(true); // badge cards don't fit: paged tables
    }
    // A ranked row taller than a whole page (a long name wrapping in a narrow column on a
    // small TV) would run off the screen.
    if (this.hasOversizedRow(frame, bottom()) && !document.getElementById('tvLatest').hidden) root.classList.add('tv-latest-withdrawn');
    if (this.hasOversizedRow(frame, bottom())) root.classList.add('tv-badges-withdrawn');
    this.boards = this.paginate(frame, bottom());
    this.pages = Math.max(1, ...this.boards.map((board) => board.slices.length));
    this.page = Math.min(this.page, this.pages - 1);
    this.applyPage();
    if (previousPages !== this.pages || previousPage !== this.page) this.restart();
  }

  // Draw every board with its podium, then withdraw a podium that leaves no room for up to
  // two ranked rows on its first page.
  fitPodiums(frame, bottom) {
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
  }

  // The ranked rows of a board (none for an empty board's message), all showing.
  rankedRows(section) {
    const tbody = section.querySelector('tbody');
    if (!tbody || tbody.querySelector('.empty-state')) return [];
    const rows = [...tbody.querySelectorAll('tr')];
    rows.forEach((tr) => { tr.hidden = false; }); // measure the full table, not a prior page
    return rows;
  }

  hasOversizedRow(frame, bottom) {
    return [...frame.querySelectorAll('.leaderboard-section')].some((section) => {
      const rows = this.rankedRows(section);
      const room = rows.length && bottom - section.querySelector('tbody').getBoundingClientRect().top;
      return rows.some((tr) => tr.getBoundingClientRect().height > room);
    });
  }

  // Each board's rows cut into pages. A podium shows on the first page only, so the pages
  // after it have its room for rows too (fewer pages, and a shorter wait for the next tab).
  paginate(frame, bottom) {
    const boards = [];
    for (const section of frame.querySelectorAll('.leaderboard-section')) {
      const rows = this.rankedRows(section);
      if (rows.length === 0) continue;
      const tbody = section.querySelector('tbody');
      const podium = section.querySelector('.podium-container');
      const room = (showPodium) => {
        if (podium) podium.hidden = !showPodium;
        return Math.max(1, bottom - tbody.getBoundingClientRect().top);
      };
      const later = room(false), first = room(true);
      boards.push({ rows, podium, slices: this.partitionRows(rows, first, later) });
    }
    return boards;
  }

  // Rows packed into pages: `room` px on the first page, `laterRoom` on those after it.
  partitionRows(rows, room, laterRoom = room) {
    const slices = [[]];
    let height = 0, limit = room;
    for (const row of rows) {
      const rowHeight = row.getBoundingClientRect().height || 1;
      if (height + rowHeight > limit && slices.at(-1).length) { slices.push([]); height = 0; limit = laterRoom; }
      slices.at(-1).push(row);
      height += rowHeight;
    }
    return slices;
  }

  // Show the current page's slice of each board, then draw the page dots. A board
  // with fewer pages pins to its last page, so it never blinks empty.
  applyPage() {
    this.boards.forEach(({ rows, slices, podium }) => {
      const page = Math.min(this.page, slices.length - 1);
      const visible = new Set(slices[page]);
      rows.forEach((row) => { row.hidden = !visible.has(row); });
      if (podium) podium.hidden = page > 0;
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
