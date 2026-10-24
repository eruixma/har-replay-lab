#!/usr/bin/env node
/**
 * serve.mjs — 本地托管还原出来的前端，并把后端接口换掉
 *
 *   site/      静态资源（由 to-site.mjs 生成）
 *   fixtures/  mock 响应（由 to-fixtures.mjs 生成）
 *
 * 匹配顺序：精确路径 → 归一化路径（会话 id 换成 :id）→ 末两段
 * 请求体不参与匹配；同一端点录了多次就按序回放。
 *
 * 用法:
 *   node scripts/serve.mjs                 # http://127.0.0.1:8787
 *   node scripts/serve.mjs --port 3000
 *   node scripts/serve.mjs --spa-fallback /index.html
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { port: 8787, host: '127.0.0.1', spaFallback: null, site: 'site', fixtures: 'fixtures' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--site') out.site = argv[++i];
    else if (a === '--fixtures') out.fixtures = argv[++i];
    else if (a === '--spa-fallback') out.spaFallback = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/serve.mjs [--port 8787] [--host 127.0.0.1] [--site site] [--fixtures fixtures] [--spa-fallback /index.html]');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SITE = path.resolve(ROOT, args.site);
const FIXTURES = path.resolve(ROOT, args.fixtures);
const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
const MISSES = path.join(LOGS, 'misses.jsonl');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const ASSET_EXT = /\.(js|mjs|css|map|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|wasm|txt|json)$/i;
const ID_SEG = /^(p[0-9a-f]{10,}|[0-9a-f]{16,}|[0-9a-f-]{32,}|\d{6,})$/i;

const cursors = new Map();
const normPath = (p) => p.split('/').map((seg) => (ID_SEG.test(seg) ? ':id' : seg)).join('/');
const tailPath = (p) => p.split('/').filter(Boolean).slice(-2).join('/');
const filesOf = (route) => (route.files?.length ? route.files : [route.file]);

function loadRoutes() {
  try {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES, '_routes.json'), 'utf8')).routes || [];
  } catch {
    return [];
  }
}

function pickFromSequence(route) {
  const files = filesOf(route);
  if (files.length === 1) return files[0];
  const key = `${route.method} ${route.path}`;
  const i = Math.min(cursors.get(key) ?? 0, files.length - 1);
  cursors.set(key, i + 1);
  return files[i];
}

function resolveFixture(method, pathname) {
  const routes = loadRoutes().filter((r) => r.method.toUpperCase() === method.toUpperCase());
  if (!routes.length) return null;

  let hits = routes.filter((r) => r.path === pathname);
  let how = 'exact';
  if (!hits.length) {
    const t = normPath(pathname);
    hits = routes.filter((r) => normPath(r.path) === t);
    how = 'normalized';
  }
  if (!hits.length) {
    const t = tailPath(pathname);
    hits = routes.filter((r) => tailPath(r.path) === t);
    how = 'tail';
  }
  if (!hits.length) return null;

  const route = hits.find((r) => r.files?.length > 1) || hits[hits.length - 1];
  return { route, file: path.join(FIXTURES, pickFromSequence(route)), how, total: filesOf(route).length };
}

function safeJoin(root, urlPath) {
  const parts = urlPath.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const resolved = path.resolve(root, ...parts);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

function pickSpaFallback() {
  if (args.spaFallback) return path.join(SITE, args.spaFallback.replace(/^\//, ''));
  const idx = path.join(SITE, 'index.html');
  if (fs.existsSync(idx)) return idx;
  const walk = (dir, depth = 0) => {
    if (depth > 3) return null;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isFile() && name.endsWith('.html')) return p;
      if (st.isDirectory()) { const found = walk(p, depth + 1); if (found) return found; }
    }
    return null;
  };
  return walk(SITE);
}

if (!fs.existsSync(SITE) || !fs.readdirSync(SITE).length) {
  console.error('');
  console.error('  site/ 是空的 —— 先把 HAR 转过来：');
  console.error('    node scripts/to-site.mjs captures/xxx.har');
  console.error('');
  process.exit(1);
}

if (!pickSpaFallback()) {
  console.log('');
  console.log('  ⚠️  site/ 里没有 HTML —— 打开只会看到接口 404。');
  console.log('      多半是导出 HAR 时过滤器停在 "Fetch/XHR"，重新导出一次（All + Disable cache + 刷新）。');
  console.log('');
}

let served = 0;
let mockHit = 0;
let missCount = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  const send = (status, body, headers = {}) => {
    res.writeHead(status, {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      ...headers,
    });
    res.end(body);
  };

  if (req.method === 'OPTIONS') return send(204, '');

  if (pathname === '/__mock/status') {
    return send(200, JSON.stringify({ served, mockHit, missCount, sequences: Object.fromEntries(cursors), missesLog: MISSES }, null, 2), {
      'content-type': 'application/json; charset=utf-8',
    });
  }

  // 1) 静态资源
  const target = safeJoin(SITE, pathname);
  if (target) {
    let file = target;
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && !path.extname(pathname)) {
      for (const cand of [`${target}.html`, `${target}.json`, path.join(target, 'index.html')]) {
        if (fs.existsSync(cand)) { file = cand; break; }
      }
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      served++;
      const ext = path.extname(file).toLowerCase();
      return send(200, fs.readFileSync(file), {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60',
      });
    }
  }

  // 2) 接口 → fixtures
  if (req.method === 'POST' && pathname === '/api/analysis-plan/sessions') cursors.clear();
  const fx = resolveFixture(req.method, pathname);
  if (fx && fs.existsSync(fx.file)) {
    mockHit++;
    const seq = fx.total > 1 ? `  [${fx.route.files.indexOf(path.basename(fx.file)) + 1}/${fx.total}]` : '';
    console.log(`  mock  ${req.method} ${pathname}  → ${path.basename(fx.file)}${seq}${fx.how !== 'exact' ? `  (${fx.how})` : ''}`);
    return send(200, fs.readFileSync(fx.file), {
      'content-type': fx.route.mimeType || MIME[path.extname(fx.file).toLowerCase()] || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
  }

  // Cloudflare 的 RUM/beacon，本地直接吞掉
  if (pathname.startsWith('/cdn-cgi/')) return send(204, '');

  // 3) 静态资源缺失 → 404（不掩盖）
  if (ASSET_EXT.test(pathname) || pathname.startsWith('/assets/') || pathname.startsWith('/static/')) {
    missCount++;
    fs.appendFileSync(MISSES, JSON.stringify({ at: new Date().toISOString(), kind: 'asset', method: req.method, path: pathname }) + '\n');
    console.log(`  ✗ 资源缺失  ${pathname}`);
    return send(404, `/* not captured: ${pathname} */`, { 'content-type': MIME['.js'] });
  }

  // 4) 前端路由 → SPA fallback（/api/ 不参与）
  const looksLikeApi = pathname.startsWith('/api/') || pathname.startsWith('/graphql');
  const spa = pickSpaFallback();
  if (spa && req.method === 'GET' && !path.extname(pathname) && !looksLikeApi) {
    return send(200, fs.readFileSync(spa), { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
  }

  // 5) 没 mock 到的接口
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    missCount++;
    fs.appendFileSync(MISSES, JSON.stringify({ at: new Date().toISOString(), kind: 'api', method: req.method, path: pathname, query: url.search, body: body.slice(0, 4000) }) + '\n');
    console.log(`  ??  未 mock  ${req.method} ${pathname}   （已记到 logs/misses.jsonl）`);
    send(404, JSON.stringify({ error: 'not mocked', method: req.method, path: pathname }), {
      'content-type': 'application/json; charset=utf-8',
    });
  });
});

server.listen(args.port, args.host, () => {
  const base = `http://${args.host}:${args.port}`;
  console.log('');
  console.log(`  ${base}`);
  console.log('  ────────────────────────────────────────────');
  console.log(`  静态   site/     ${fs.readdirSync(SITE).length} 项`);
  console.log(`  mock   ${args.fixtures}/   ${loadRoutes().length} 个端点`);
  console.log(`  日志   logs/misses.jsonl`);
  console.log(`  自检   ${base}/__mock/status`);
  console.log('');
});

process.on('SIGINT', () => { console.log('\n  已停止\n'); process.exit(0); });
