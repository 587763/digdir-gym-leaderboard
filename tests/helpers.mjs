import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

export const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
export function environment(files = ['lifts', 'avatar', 'history']) {
  const { document } = parseHTML(read('index.html'));
  const context = vm.createContext({
    document, console, URL, URLSearchParams, Date, structuredClone,
    location: { search: '', origin: 'http://localhost:3000', pathname: '/', href: 'http://localhost:3000/' },
    localStorage: { getItem: () => null, setItem: () => {} }, history: { replaceState() {} },
    setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
    clearTimeout, addEventListener() {},
  });
  context.window = context;
  for (const name of files) vm.runInContext(read(`js/${name}.js`), context, { filename: `${name}.js` });
  return context;
}
export async function application(overrides = {}) {
  const context = environment(['achievements', 'lifts', 'avatar', 'history']);
  const store = {
    configured: true, getSession: async () => null, listAthletes: async () => [],
    myProfile: async () => null, listProfiles: async () => [], listPendingProposals: async () => [],
    listAthleteHistory: async () => [], onAuthChange() {}, subscribe() {}, userLabel: () => 'member',
    ...overrides,
  };
  context.Store = store;
  vm.runInContext(read('js/app.js'), context);
  const app = vm.runInContext('app = new LeaderboardApp(); app', context);
  await app.ready;
  return { app, context, store, document: context.document };
}
export const athlete = (id, values = {}) => ({ id, name: id, bench: 0, squat: 0, deadlift: 0, lifts: {}, achievements: [], ...values });
