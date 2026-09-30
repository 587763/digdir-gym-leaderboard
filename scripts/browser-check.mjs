// Layout checks in real Chrome against the local fixtures: no horizontal overflow,
// scores stay inside their boards, table text stays inside its cells, the selected
// tab is visible, TV mode never scrolls and every ranked row is
// reachable on some page, dialogs open cleanly, and the console stays quiet.
// Zero dependencies: drives Chrome over the DevTools protocol with Node's WebSocket.
//
//   npm run test:browser            (CHROME=/path/to/chrome to override detection)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 3100);
const BASE = `http://localhost:${PORT}/`;
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);
if (!CHROME) { console.error('Chrome not found; set CHROME=/path/to/chrome'); process.exit(2); }

const TABS = ['lifts', 'total', 'other', 'cardio', 'latest', 'fun'];
const DIALOGS = ['app.openMine()', 'app.openReview()', 'app.openMembers()', 'app.openAthletes()',
  "app.openAthleteEditor('athlete-1')", "app.openHistory('athlete-1')", "UI.dialogs.open('claimModal')"];
const SCREENS = [
  { name: 'desktop', width: 1440, height: 1000, fixtures: ['admin', 'returning', 'layout', 'empty', 'error'] },
  { name: 'tablet', width: 820, height: 1180, fixtures: ['admin'] },
  { name: 'phone', width: 390, height: 844, fixtures: ['admin', 'returning', 'layout'] },
  { name: 'tv-1080p', width: 1920, height: 1080, tv: true, fixtures: ['large', 'layout', 'admin'] },
  { name: 'tv-720p', width: 1280, height: 720, tv: true, fixtures: ['large', 'layout'] },
  { name: 'tv-zoomed', width: 2400, height: 1350, tv: true, fixtures: ['layout'] },
];

// Runs in the page for the active tab; returns a list of problems.
const CHECK_PAGE = `(() => {
  const problems = [];
  const box = (el) => el.getBoundingClientRect();
  const inside = (inner, outer, slack = 1) => inner.left >= outer.left - slack && inner.right <= outer.right + slack
    && inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack;
  const label = (el) => (el.closest('[data-lift]')?.dataset.lift || el.closest('.achievement-section, .latest-board')?.className || '?') + ' ' + el.textContent.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('page scrolls horizontally (' + document.documentElement.scrollWidth + 'px)');
  for (const el of document.querySelectorAll('.tab-content.active :is(.pr-value, .podium-value, .rank, .podium-name, .badge-name)')) {
    if (!el.getClientRects().length) continue;
    const section = el.closest('.leaderboard-section, .achievement-section');
    if (section && !inside(box(el), box(section))) problems.push('overflows its board: ' + label(el));
  }
  // Fixed table layouts clip nothing: text wider than its cell spills over its neighbours.
  for (const cell of document.querySelectorAll('.tab-content.active :is(th, td)')) {
    if (cell.getClientRects().length && cell.scrollWidth > cell.clientWidth + 1) problems.push('text overflows its table cell: ' + label(cell));
  }
  // The selected tab must be scrolled into view in a scrolling tab strip.
  const strip = document.querySelector('.tab-navigation'), active = strip.querySelector('.tab-btn.active');
  if (!inside(box(active), box(strip), 2)) problems.push('selected tab is scrolled out of view');
  return problems;
})()`;

// TV only: step through every page and require each visible row to sit on screen.
const CHECK_TV = `(() => {
  const problems = [];
  const frame = document.querySelector('.tab-content.active');
  if (document.documentElement.scrollHeight > innerHeight + 1) problems.push('TV page scrolls vertically');
  const limit = frame.getBoundingClientRect().bottom + 1;
  const rows = [...frame.querySelectorAll('.leaderboard-section tbody tr:not(.empty-row)')];
  const seen = new Set();
  for (let page = 0; page < app.tv.pages; page++) {
    app.tv.page = page; app.tv.applyPage();
    for (const row of rows) {
      if (!row.getClientRects().length) continue; // what renders, not just the hidden flag
      seen.add(row);
      if (row.getBoundingClientRect().bottom > limit) problems.push('row below the screen on page ' + (page + 1) + ': ' + row.textContent.trim().slice(0, 30));
    }
    for (const el of frame.querySelectorAll('.podium-container, .hall-of-fame')) {
      if (el.getBoundingClientRect().bottom > limit) problems.push('cut off at the bottom: ' + el.className);
    }
  }
  if (seen.size !== rows.length) problems.push((rows.length - seen.size) + ' ranked rows never shown on any page');
  app.tv.page = 0; app.tv.applyPage();
  return problems;
})()`;

// A realtime re-render keeps keyboard focus on the same control of the same board
// (the athlete's name also appears on the other boards).
const CHECK_FOCUS = `(() => {
  UI.dialogs.closeAll(); app.switchTab('lifts');
  const button = document.querySelector('[data-lift="deadlift"] tbody [data-action="history"]');
  button.focus(); app.render();
  const now = document.activeElement;
  return now?.dataset.id === button.dataset.id && now.closest('[data-lift]')?.dataset.lift === 'deadlift'
    ? [] : ['a re-render moved focus to ' + (now?.closest('[data-lift]')?.dataset.lift || now?.tagName)];
})()`;

const CHECK_DIALOG = `(() => {
  const dialog = document.querySelector('dialog[open]');
  if (!dialog) return ['dialog did not open'];
  const card = dialog.querySelector('.modal-content');
  return card.scrollWidth > card.clientWidth + 1 ? ['dialog content scrolls horizontally: ' + dialog.id] : [];
})()`;

async function browser() {
  const profile = mkdtempSync(join(tmpdir(), 'leaderboard-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let log = '';
    proc.stderr.on('data', (chunk) => { log += chunk; const m = log.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
    proc.on('exit', (code) => reject(new Error(`Chrome exited (${code}): ${log}`)));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map(), handlers = new Set();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else handlers.forEach((fn) => fn(msg));
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const logs = [];
  handlers.add((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') logs.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') logs.push(msg.params.entry.text);
  });
  await page('Page.enable'); await page('Runtime.enable'); await page('Log.enable');
  await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  return {
    logs,
    async open(path, width, height) {
      await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      const loaded = new Promise((resolve) => { const fn = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { handlers.delete(fn); resolve(); } }; handlers.add(fn); });
      await page('Page.navigate', { url: BASE + path });
      await loaded;
      await this.run('(async () => { await app.ready; await document.fonts.ready; })()');
    },
    async run(expression) {
      const { result, exceptionDetails } = await page('Runtime.evaluate', { expression: `(async () => { const r = await ${expression}; await new Promise((f) => requestAnimationFrame(() => requestAnimationFrame(f))); return r; })()`, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    },
    async close() {
      try { await send('Browser.close'); } catch { /* already gone */ }
      proc.kill();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

const server = spawn(process.execPath, ['scripts/dev-server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.once('data', resolve));
const chrome = await browser();
const failures = [];
let checks = 0;
try {
  for (const screen of SCREENS) {
    for (const fixture of screen.fixtures) {
      await chrome.open(`?fixture=${fixture}${screen.tv ? '&tv&rotate=120' : ''}`, screen.width, screen.height);
      // Freeze rotation so tabs change only when the check says so.
      if (screen.tv) await chrome.run('(() => { app.tv.scheduleTick = () => {}; app.tv.stop(); })()');
      for (const tab of TABS) {
        const problems = await chrome.run(`(() => { UI.dialogs.closeAll(); app.switchTab('${tab}'); scrollTo(0, 0); return ${screen.tv ? `[...${CHECK_PAGE}, ...${CHECK_TV}]` : CHECK_PAGE}; })()`);
        checks++;
        problems.forEach((p) => failures.push(`${screen.name} ${fixture} ${tab}: ${p}`));
      }
      if (fixture === 'admin' && screen.name === 'desktop') {
        (await chrome.run(CHECK_FOCUS)).forEach((p) => failures.push(`${screen.name} focus: ${p}`));
        checks++;
      }
      if (fixture === 'admin' && !screen.tv) {
        for (const open of DIALOGS) {
          const problems = await chrome.run(`(async () => { UI.dialogs.closeAll(); ${open}; await new Promise((r) => setTimeout(r, 50)); return ${CHECK_DIALOG}; })()`);
          checks++;
          problems.forEach((p) => failures.push(`${screen.name} dialog ${open}: ${p}`));
        }
      }
      chrome.logs.splice(0).forEach((log) => failures.push(`${screen.name} ${fixture}: console: ${log}`));
    }
  }
} finally {
  await chrome.close();
  server.kill();
}
if (failures.length) {
  console.error(`✖ ${failures.length} browser check problem(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`✔ ${checks} browser checks passed`);
