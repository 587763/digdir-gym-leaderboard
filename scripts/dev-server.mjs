import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const publicFiles = new Set(['index.html','styles.css','favicon.svg','apple-touch-icon.png']);
const scriptFiles = new Set(['config','achievements','lifts','avatar','store','history','app'].map((name)=>`js/${name}.js`));

createServer(async (req,res)=>{
  try {
    const url = new URL(req.url, 'http://localhost');
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    // Serve the site, never .env, .git, SQL dumps or other workspace files.
    if (!publicFiles.has(file) && !scriptFiles.has(file) && file !== 'tests/browser-store.js') {
      res.writeHead(404); res.end('Not found'); return;
    }
    let body = await readFile(resolve(root,file));
    if (file === 'index.html' && url.searchParams.has('fixture')) {
      body = Buffer.from(body.toString()
        .replace(/<script\s+src="https:\/\/cdn\.jsdelivr\.net[\s\S]*?<\/script>/,'')
        .replace(/src="js\/store\.js[^\"]*"/,'src="tests/browser-store.js"'));
    }
    res.writeHead(200,{'Content-Type':`${types[extname(file)] || 'application/octet-stream'}; charset=utf-8`,'Cache-Control':'no-store'});
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port,'localhost',()=>console.log(`Leaderboard: http://localhost:${port}`));
