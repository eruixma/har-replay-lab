#!/usr/bin/env node
/**
 * to-fixtures.mjs — 把 HAR 里的接口响应变成 serve.mjs 能用的 mock 数据
 *
 * 关键行为：
 *   · 同一端点被调用多次（多轮问答）→ 存成 __1 __2 __3，按录制顺序回放
 *   · NDJSON / SSE 逐字节保留原始分行（美化会让客户端的按行解析崩掉）
 *   · 响应里的 JWT 把 exp 顺延 30 天（签名不变，本地 mock 不校验签名）
 *   · 录制时通常已登录，HAR 里没有 /auth/login → 用 /auth/refresh 的响应补一份
 *
 * 用法:
 *   node scripts/to-fixtures.mjs capture.har
 *   node scripts/to-fixtures.mjs capture.har --out fixtures --only /api/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASSET_PATH = /\.(js|mjs|css|map|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|wasm)$/i;

function parseArgs(argv) {
  const out = { har: null, out: 'fixtures', only: '/api/', bumpJwt: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--no-bump-jwt') out.bumpJwt = false;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/to-fixtures.mjs <file.har> [--out fixtures] [--only /api/]');
      process.exit(0);
    } else if (!a.startsWith('-')) out.har = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.har) {
  console.error('用法: node scripts/to-fixtures.mjs <file.har>');
  process.exit(1);
}

const har = JSON.parse(fs.readFileSync(path.resolve(args.har), 'utf8'));
const outDir = path.resolve(ROOT, args.out);
fs.mkdirSync(outDir, { recursive: true });

const baseName = (method, pathname) =>
  `${method.toUpperCase()}_${pathname.replace(/\/+$/, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root'}`;

const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const b64urlEncode = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function bumpJwtExp(token, days = 30) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return { token, bumped: false };
  try {
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (!payload.exp) return { token, bumped: false };
    const target = Math.floor(Date.now() / 1000) + days * 86400;
    if (payload.exp >= target) return { token, bumped: false };
    payload.exp = target;
    return { token: `${parts[0]}.${b64urlEncode(JSON.stringify(payload))}.${parts[2]}`, bumped: true };
  } catch {
    return { token, bumped: false };
  }
}

function walkBump(node, hits) {
  if (Array.isArray(node)) return node.forEach((x) => walkBump(x, hits));
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && /^(access|refresh|id)_token$/.test(k) && v.split('.').length === 3) {
      const r = bumpJwtExp(v);
      node[k] = r.token;
      if (r.bumped) hits.push(k);
    } else if (v && typeof v === 'object') {
      walkBump(v, hits);
    }
  }
}

const groups = new Map();
const skipped = [];

for (const e of har.log?.entries || []) {
  const req = e.request || {};
  const res = e.response || {};
  let u;
  try { u = new URL(req.url); } catch { continue; }

  const mime = res.content?.mimeType || '';
  const text = res.content?.text;
  if (args.only && !u.pathname.includes(args.only)) continue;
  if (ASSET_PATH.test(u.pathname) || !/json/.test(mime)) continue;
  if (!(res.status >= 200 && res.status < 300)) { skipped.push(`${req.method} ${u.pathname} → ${res.status}`); continue; }
  if (typeof text !== 'string' || !text.trim()) { skipped.push(`${req.method} ${u.pathname} → 无响应体`); continue; }

  // DevTools 对非 text/* 的响应（比如 application/x-ndjson）会返回 base64，得先解码
  const raw = res.content?.encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text;

  // NDJSON / SSE 必须原样保留分行
  const isStream = /ndjson|event-stream/i.test(mime);
  let body = raw;
  let bumped = [];
  if (!isStream) {
    try {
      const obj = JSON.parse(raw);
      if (args.bumpJwt) walkBump(obj, bumped);
      body = JSON.stringify(obj, null, 2);
    } catch { /* 非 JSON：原样 */ }
  }

  const key = `${req.method} ${u.pathname}`;
  if (!groups.has(key)) groups.set(key, { method: req.method, path: u.pathname, mimeType: mime, status: res.status, bodies: [], bumped: [] });
  const g = groups.get(key);
  g.bodies.push(body);
  if (bumped.length) g.bumped.push(...bumped);
}

const routes = [];
let written = 0;

for (const g of groups.values()) {
  const base = baseName(g.method, g.path);
  const multi = g.bodies.length > 1;
  const files = g.bodies.map((body, i) => {
    const file = multi ? `${base}__${i + 1}.json` : `${base}.json`;
    fs.writeFileSync(path.join(outDir, file), body);
    written++;
    return file;
  });
  routes.push({
    method: g.method,
    path: g.path,
    file: files[0],
    ...(multi ? { files } : {}),
    status: g.status,
    mimeType: g.mimeType,
    ...(g.bumped.length ? { refreshedJwt: [...new Set(g.bumped)] } : {}),
  });
}

// 录制时已登录 → HAR 里没有 /auth/login，用 refresh 补一份
{
  const hasLogin = routes.some((r) => r.method === 'POST' && r.path === '/api/auth/login');
  const refresh = routes.find((r) => r.method === 'POST' && r.path === '/api/auth/refresh');
  if (!hasLogin && refresh) {
    const file = 'POST_api_auth_login.json';
    fs.copyFileSync(path.join(outDir, refresh.files ? refresh.files[0] : refresh.file), path.join(outDir, file));
    routes.push({ method: 'POST', path: '/api/auth/login', file, status: 200, mimeType: 'application/json', derivedFrom: '/api/auth/refresh' });
    console.log('  ↳ 补了 /api/auth/login（复用 refresh 的响应）');
  }
}

// 清掉本轮没再出现的旧 fixture
const keep = new Set(routes.flatMap((r) => (r.files ? r.files : [r.file])));
for (const f of fs.readdirSync(outDir)) {
  if (!f.endsWith('.json') || f === '_routes.json') continue;
  if (!keep.has(f)) fs.rmSync(path.join(outDir, f));
}

fs.writeFileSync(path.join(outDir, '_routes.json'), JSON.stringify({ source: path.resolve(args.har), routes }, null, 2));

console.log('');
console.log(`  HAR → fixtures   ${outDir}`);
console.log('  ────────────────────────────────────────────');
console.log(`  ${written} 个文件 / ${routes.length} 个端点`);
for (const r of routes) {
  const seq = r.files ? `  ← 序列 ${r.files.length} 条，按序回放` : '';
  console.log(`    ${r.method.padEnd(5)} ${r.path.slice(0, 56).padEnd(56)} ${(r.files ? `${r.files.length}x` : '1x').padEnd(3)}${seq}`);
}
if (skipped.length) {
  console.log('');
  console.log(`  跳过 ${skipped.length} 条:`);
  for (const s of skipped.slice(0, 10)) console.log(`    ${s}`);
}
console.log('');
console.log('  下一步: node scripts/serve.mjs');
console.log('');
