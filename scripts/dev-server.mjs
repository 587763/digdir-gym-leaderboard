// Local static server for the site: an allowlist of its files, no caching, localhost only.
// It never serves .env, .git, SQL or other workspace files. PORT overrides 3000.
//
// With ?fixture=<name> the page gets the in-memory Store from tests/browser-store.js instead
// of js/store.js and the Supabase library, so forms can be tried without touching the board.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const FIXTURE_STORE = 'tests/browser-store.js';
// The scripts index.html loads, in order. A new script needs an entry here.
const scripts = ['config', 'ui', 'achievements', 'changelog', 'lifts', 'avatar', 'store', 'history', 'board', 'planner', 'tv', 'app'];
const served = new Set(['index.html', 'styles.css', 'favicon.svg', 'apple-touch-icon.png', FIXTURE_STORE,
  ...scripts.map((name) => `js/${name}.js`)]);

const withFixtureStore = (html) => html
  .replace(/<script\s+src="https:\/\/cdn\.jsdelivr\.net[\s\S]*?<\/script>/, '')
  .replace(/src="js\/store\.js[^"]*"/, `src="${FIXTURE_STORE}"`);

createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (!served.has(file)) { res.writeHead(404); res.end('Not found'); return; }
    let body = await readFile(resolve(root, file));
    if (file === 'index.html' && url.searchParams.has('fixture')) body = Buffer.from(withFixtureStore(body.toString()));
    res.writeHead(200, { 'Content-Type': `${types[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, 'localhost', () => console.log(`Leaderboard: http://localhost:${port}`));
