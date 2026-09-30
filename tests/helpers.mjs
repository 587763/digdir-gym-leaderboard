import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

export const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Browsers coerce values assigned to innerHTML to strings (UI.html returns SafeHtml);
// LinkeDOM passes objects straight to its parser, so coerce like the DOM spec says.
function coerceInnerHtml(window) {
  let proto = Object.getPrototypeOf(window.document.body);
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'innerHTML')) proto = Object.getPrototypeOf(proto);
  const { get, set } = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
  Object.defineProperty(proto, 'innerHTML', { configurable: true, get, set(value) { set.call(this, String(value ?? '')); } });
}

// LinkeDOM has no <dialog> behaviour; model the parts the app relies on.
function polyfillDialogs(window) {
  for (const dialog of window.document.querySelectorAll('dialog')) {
    Object.defineProperty(dialog, 'open', { get() { return this.hasAttribute('open'); } });
    dialog.showModal = function showModal() { this.setAttribute('open', ''); };
    dialog.close = function close() {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      this.dispatchEvent(new window.Event('close'));
    };
  }
}

// A fresh document and script context per call. `files` are js/<name>.js, loaded in order.
export function environment(files = ['ui', 'lifts', 'avatar', 'history']) {
  const window = parseHTML(read('index.html'));
  coerceInnerHtml(window);
  polyfillDialogs(window);
  const context = vm.createContext({
    document: window.document, Event: window.Event, console, URL, URLSearchParams, Date, Intl, structuredClone,
    location: { search: '', hash: '', origin: 'http://localhost:3000', pathname: '/', href: 'http://localhost:3000/' },
    localStorage: { getItem: () => null, setItem: () => {} }, history: { replaceState() {} },
    setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
    clearTimeout, addEventListener() {}, innerHeight: 900, confirm: () => true,
  });
  context.window = context;
  for (const name of files) vm.runInContext(read(`js/${name}.js`), context, { filename: `${name}.js` });
  return context;
}

// The full app against an in-memory Store double; override any Store method.
export async function application(overrides = {}, { search = '', hash = '' } = {}) {
  const context = environment(['ui', 'achievements', 'lifts', 'avatar', 'history', 'board', 'tv']);
  Object.assign(context.location, { search, hash });
  const store = {
    configured: true, getSession: async () => null, listAthletes: async () => [],
    myProfile: async () => null, listProfiles: async () => [], listPendingProposals: async () => [],
    listRecentPrs: async () => [], listAthleteHistory: async () => [], onAuthChange() {}, subscribe() {},
    userLabel: () => 'member', ...overrides,
  };
  context.Store = store;
  vm.runInContext(read('js/app.js'), context, { filename: 'app.js' });
  const app = vm.runInContext('app = new LeaderboardApp(); app', context);
  await app.ready;
  return { app, context, store, document: context.document };
}
export const athlete = (id, values = {}) => ({ id, name: id, bench: 0, squat: 0, deadlift: 0, lifts: {}, achievements: [], ...values });
