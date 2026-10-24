#!/usr/bin/env node
/**
 * to-site.mjs — 把 HAR 里的静态资源还原成一个本地站点目录
 *
 * 用法:
 *   node scripts/to-site.mjs capture.har
 *   node scripts/to-site.mjs capture.har --out site --origin https://example.com
 *
 * 只取同源 GET 200 的 html/js/css/字体/图片/svg/json，按 URL 路径重建目录结构。
 * 顺带做体检：框架线索、有没有 source map、抓到了哪些接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { har: null, out: 'site', origin: null, allOrigins: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--origin') out.origin = argv[++i];
    else if (a === '--all-origins') out.allOrigins = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/to-site.mjs <file.har> [--out site] [--origin https://...]');
      process.exit(0);
    } else if (!a.startsWith('-')) out.har = a;
  }
  return out;
}

const TEXTY = /^(text\/|application\/(javascript|json|xml|x-javascript|ecmascript)|image\/svg)/i;
const BINARY_OK = /^(image\/|font\/|application\/(font|octet-stream))/i;
const ASSET_PATH = /\.(js|mjs|css|map|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|wasm)$/i;

function extOf(mime, urlPath) {
  const ext = path.extname(urlPath.split('?')[0]);
  if (ext) return ext;
  if (/javascript|ecmascript/.test(mime)) return '.js';
  if (/css/.test(mime)) return '.css';
  if (/html/.test(mime)) return '.html';
  if (/json/.test(mime)) return '.json';
  if (/svg/.test(mime)) return '.svg';
  if (/woff2/.test(mime)) return '.woff2';
  return '';
}

function localPathFor(urlPath) {
  let p = urlPath.split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch { /* 保留原样 */ }
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  const parts = p.split('/').filter((seg) => seg && seg !== '.' && seg !== '..');
  if (!parts.length || p.endsWith('/')) parts.push('index.html');
  return parts;
}

const args = parseArgs(process.argv.slice(2));
if (!args.har) {
  console.error('用法: node scripts/to-site.mjs <file.har>');
  process.exit(1);
}

const harPath = path.resolve(args.har);
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
const entries = har?.log?.entries;
if (!Array.isArray(entries) || !entries.length) {
  console.error('这个 HAR 里没有 log.entries，可能导出时没勾选内容。');
  process.exit(1);
}

const outDir = path.resolve(ROOT, args.out);
fs.mkdirSync(outDir, { recursive: true });

const originCount = new Map();
for (const e of entries) {
  try {
    const u = new URL(e.request.url);
    if ((e.response?.content?.mimeType || '').includes('html')) {
      originCount.set(u.origin, (originCount.get(u.origin) || 0) + 1);
    }
  } catch { /* ignore */ }
}
const mainOrigin = args.origin || [...originCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

const written = [];
const skipped = { notGet: 0, badStatus: 0, crossOrigin: 0, noBody: 0, badMime: 0, dup: 0 };
const apiCalls = [];
const seenLocal = new Set();

for (const e of entries) {
  if (!e || !e.request || !e.request.url) continue;
  const req = e.request;
  const res = e.response || {};
  let u;
  try { u = new URL(req.url); } catch { continue; }

  const mime = res.content?.mimeType || '';
  const isAssetPath = ASSET_PATH.test(u.pathname);

  if (!isAssetPath && (/json/.test(mime) || req.method !== 'GET' || /\/api\//.test(u.pathname) || /graphql/.test(u.pathname))) {
    apiCalls.push({
      method: req.method,
      path: u.pathname + u.search,
      status: res.status,
      mime,
      hasBody: typeof res.content?.text === 'string',
    });
  }

  if (req.method !== 'GET') { skipped.notGet++; continue; }
  if (!(res.status >= 200 && res.status < 300)) { skipped.badStatus++; continue; }
  if (!args.allOrigins && mainOrigin && u.origin !== mainOrigin) { skipped.crossOrigin++; continue; }
  if (!(TEXTY.test(mime) || BINARY_OK.test(mime))) { skipped.badMime++; continue; }

  const text = res.content?.text;
  if (typeof text !== 'string') { skipped.noBody++; continue; }

  const buf = res.content?.encoding === 'base64' ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf8');
  const parts = localPathFor(u.pathname);
  const lastIdx = parts.length - 1;
  if (!path.extname(parts[lastIdx])) {
    const guess = extOf(mime, u.pathname);
    if (guess) parts[lastIdx] += guess;
  }
  let rel = parts.join('/');
  if (!path.extname(rel)) rel = `${rel.replace(/\/+$/, '')}/index.html`;

  if (seenLocal.has(rel)) { skipped.dup++; continue; }
  seenLocal.add(rel);

  const target = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  written.push({ rel, url: req.url, bytes: buf.length, mime });
}

fs.writeFileSync(
  path.join(outDir, '.capture-manifest.json'),
  JSON.stringify({ capturedAt: new Date().toISOString(), harFile: harPath, origin: mainOrigin, files: written, apiCalls, skipped }, null, 2)
);

// ---------- 体检 ----------
const htmlFiles = written.filter((w) => w.rel.endsWith('.html'));
const jsFiles = written.filter((w) => w.rel.endsWith('.js'));
const mapFiles = new Set(written.filter((w) => w.rel.endsWith('.map')).map((w) => w.rel));
const htmlText = htmlFiles.map((h) => fs.readFileSync(path.join(outDir, h.rel), 'utf8')).join('\n');

const frameworks = [];
if (/__NEXT_DATA__|\/_next\//.test(htmlText) || written.some((w) => w.rel.includes('_next/'))) frameworks.push('Next.js');
if (/__NUXT__|\/_nuxt\//.test(htmlText)) frameworks.push('Nuxt');
if (/assets\/index-[\w-]+\.js/.test(written.map((w) => w.rel).join(' '))) frameworks.push('Vite');
if (/data-v-[0-9a-f]{6,}/.test(htmlText)) frameworks.push('Vue');
if (written.some((w) => /webpack/i.test(w.rel))) frameworks.push('webpack');

const mapRefs = [];
for (const j of jsFiles) {
  const body = fs.readFileSync(path.join(outDir, j.rel), 'utf8');
  for (const m of body.matchAll(/[#@]\s*sourceMappingURL=([^\s*'"]+)/g)) {
    const mapUrl = m[1];
    mapRefs.push({ js: j.rel, map: mapUrl, captured: mapFiles.has(path.posix.join(path.posix.dirname(j.rel), mapUrl)) });
  }
}

const totalBytes = written.reduce((s, w) => s + w.bytes, 0);
const fmt = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

console.log('');
console.log('  HAR → 本地站点');
console.log('  ────────────────────────────────────────────');
console.log(`  源站      ${mainOrigin || '(未识别)'}`);
console.log(`  输出      ${outDir}`);
console.log(`  文件      ${written.length} 个 (${fmt(totalBytes)})`);
console.log(`  HTML      ${htmlFiles.length} 个 ${htmlFiles.slice(0, 5).map((h) => `/${h.rel}`).join(', ')}${htmlFiles.length > 5 ? ' …' : ''}`);
console.log(`  跳过      ${JSON.stringify(skipped)}`);
console.log('');
console.log(`  框架线索  ${frameworks.length ? frameworks.join(' / ') : '未识别'}`);

if (!htmlFiles.length) {
  console.log('');
  console.log('  ✗ 这份 HAR 里没有任何 HTML —— 前端外壳没抓到，跑不出 UI。');
  console.log('    最常见原因：导出时 Network 的过滤器停在 "Fetch/XHR"（或某次录制前没重新加载）。');
  console.log('    修法：过滤器点回 "All"，勾 Disable cache，刷新页面后再导出。');
}

if (mapRefs.length) {
  console.log('');
  console.log('  source map:');
  for (const m of mapRefs.slice(0, 8)) {
    console.log(`    ${m.js} → ${m.map}  ${m.captured ? '已抓到' : '未抓到（需要单独下载）'}`);
  }
} else {
  console.log('');
  console.log('  未发现 sourceMappingURL —— 没有 source map，只能靠美化和字符串定位来读。');
}

if (apiCalls.length) {
  const uniq = [...new Set(apiCalls.map((a) => `${a.method} ${a.path.split('?')[0]}`))];
  console.log('');
  console.log(`  接口 ${uniq.length} 个:`);
  for (const u of uniq.slice(0, 12)) console.log(`    ${u}`);
  if (uniq.length > 12) console.log(`    … 共 ${uniq.length} 个`);
}

console.log('');
console.log('  下一步: node scripts/to-fixtures.mjs ' + path.relative(process.cwd(), harPath));
console.log('');
