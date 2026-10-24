#!/usr/bin/env node
/**
 * walk.mjs — 让真浏览器自动走一遍录过的流程，检查 mock 够不够
 *
 * 它不做断言，只做两件事：
 *   1. 按优先级点按钮（确认类 → 选项卡片 → 下一步 → 提交）
 *   2. 每步记录：点了什么、命中哪些接口、有没有出图
 *
 * 出图判定覆盖 canvas / Plotly / Recharts / ECharts / 任意大尺寸 svg。
 * 出图 → 退出码 0；没出图 → 退出码 1，并列出 404 的接口。
 *
 * 用法:
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-walk about:blank
 *
 *   node scripts/walk.mjs --base http://127.0.0.1:8787 --path /analysis-planning
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, newPage, sleep } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = {
    port: 9222,
    base: 'http://127.0.0.1:8787',
    path: '/',
    loginPath: '/login',
    email: 'demo@example.com',
    password: 'demo',
    question: 'Why did revenue drop?',
    steps: 14,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--path') out.path = argv[++i];
    else if (a === '--login-path') out.loginPath = argv[++i];
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--question') out.question = argv[++i];
    else if (a === '--steps') out.steps = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/walk.mjs [--base http://127.0.0.1:8787] [--path /] [--question "..."] [--steps 14]');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE = args.base.replace(/\/$/, '');

const { cdp, version } = await connect(args.port).catch(() => {
  console.error(`
  连不上 127.0.0.1:${args.port}。先起一个可接管的 Chrome：

    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
      --remote-debugging-port=${args.port} --user-data-dir=/tmp/chrome-walk about:blank
`);
  process.exit(2);
});

const { sessionId } = await newPage(cdp);
for (const d of ['Runtime', 'Log', 'Network', 'Page']) await cdp.send(`${d}.enable`, {}, sessionId);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

const api = [];
const errors = [];
cdp.on('Network.responseReceived', (p, sid) => {
  if (sid !== sessionId || !p.response.url.includes('/api/')) return;
  api.push({ status: p.response.status, url: p.response.url.replace(BASE, '') });
});
cdp.on('Runtime.exceptionThrown', (p, sid) => {
  if (sid !== sessionId) return;
  errors.push(String(p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 200));
});
cdp.on('Runtime.consoleAPICalled', (p, sid) => {
  if (sid !== sessionId || p.type !== 'error') return;
  errors.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
});

const ev = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result.value;

const SNAP_JS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const btns = [...document.querySelectorAll('button, [role=button], a[role=button]')]
    .filter(visible)
    .map((el) => ({
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
      disabled: !!el.disabled,
      w: Math.round(el.getBoundingClientRect().width),
      left: Math.round(el.getBoundingClientRect().left),
    }))
    .filter((b) => b.text && b.w > 40);
  const canvas = document.querySelectorAll('canvas').length;
  const libs = document.querySelectorAll('.js-plotly-plot, .recharts-wrapper, [class*=echarts], [class*=highcharts], [class*=chart-container]').length;
  const bigSvg = [...document.querySelectorAll('svg')].filter((s) => s.getBoundingClientRect().width > 200).length;
  const hasPassword = !!document.querySelector('input[type=password]');
  return { btns, canvas, libs, bigSvg, charts: canvas + libs + bigSvg, hasPassword };
})()`;

const CONSENT = /^(i understand|i agree|accept|agree|got it|我明白了|我知道了|同意|接受)/i;
const CONFIRM = /^(correct,? start|looks (right|good)|yes,? go that way|yes\b|confirm|continue|next|start|继续|下一步|确认|是的)/i;
const SUBMIT = /^(send|submit|plan it|plan|ask|go|run|search|提交|发送|生成|开始|运行)/i;
const STEP = /^(skip|use default|decide\b|only explain|run \d|run the|build)/i;
const SKIP = /^(change$|new plan|sign out|logout|help|home|settings|history|saved|data dictionary|analytics|english|中文|繁體|简体|copy|add the plan)/i;

// 页面上出现过的按钮记次数，避免死循环
const clicked = new Map();
const ok = (t) => (clicked.get(t) || 0) < 3;

function choose(snap, allowConsent = false) {
  const usable = snap.btns.filter((b) => !b.disabled && !SKIP.test(b.text));
  const order = allowConsent ? [CONSENT, CONFIRM, STEP, SUBMIT] : [CONFIRM, STEP, SUBMIT];
  for (const re of order) {
    const hit = usable.find((b) => re.test(b.text) && ok(b.text));
    if (hit) return hit;
  }
  return usable.find((b) => ok(b.text)) || null;
}

async function click(text) {
  return ev(`(() => {
    const b = [...document.querySelectorAll('button, [role=button]')]
      .find((el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) === ${JSON.stringify(text)});
    if (!b) return 'gone';
    b.click();
    return 'ok';
  })()`);
}

async function typeInto(re, value) {
  return ev(`(() => {
    const el = [...document.querySelectorAll('input:not([type=password]), textarea')]
      .find((e) => ${re}.test(e.placeholder || '') || e.tagName === 'TEXTAREA');
    if (!el) return 'no-input';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'typed';
  })()`);
}

// ---------- 登录 ----------
await cdp.send('Page.navigate', { url: `${BASE}${args.loginPath}` }, sessionId);
await sleep(2000);
let snap = await ev(SNAP_JS);

if (!snap.hasPassword) {
  // 有些站点直接在目标页登录
  await cdp.send('Page.navigate', { url: `${BASE}${args.path}` }, sessionId);
  await sleep(2500);
  snap = await ev(SNAP_JS);
}

if (snap.hasPassword) {
  await ev(`(() => {
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const pw = document.querySelector('input[type=password]');
    const mail = [...document.querySelectorAll('input')].find((e) => e !== pw) || pw;
    set(mail, ${JSON.stringify(args.email)}); set(pw, ${JSON.stringify(args.password)});
    const btn = [...document.querySelectorAll('button')].find((b) => /sign in|log in|login|登录/i.test(b.textContent));
    if (btn) btn.click();
  })()`);
  await sleep(2500);
}

// 同意条款之类的一次性弹窗
for (let i = 0; i < 3; i++) {
  const s = await ev(SNAP_JS);
  const c = s.btns.find((b) => CONSENT.test(b.text));
  if (!c) break;
  await click(c.text);
  await sleep(1200);
}
console.log('  ✓ 登录/前置完成');

// ---------- 进入目标页并提问 ----------
await cdp.send('Page.navigate', { url: `${BASE}${args.path}` }, sessionId);
await sleep(3000);
await typeInto(/ask|question|type|输入|提问/i, args.question);
const started = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((e) => ${SUBMIT.toString()}.test((e.textContent || '').trim()));
  if (!b) return 'no-submit';
  b.click();
  return 'ok';
})()`);
console.log(`  ✓ 已提交问题 (${started})`);
await sleep(8000);

// ---------- 走流程 ----------
const trace = [];
let victory = false;

for (let step = 1; step <= args.steps; step++) {
  snap = await ev(SNAP_JS);
  if (snap.charts > 0) { victory = true; trace.push({ step, note: `出图 canvas=${snap.canvas} libs=${snap.libs} svg=${snap.bigSvg}` }); break; }

  const target = choose(snap);
  if (!target) { trace.push({ step, note: '没有可点的按钮了' }); break; }

  const before = api.length;
  clicked.set(target.text, (clicked.get(target.text) || 0) + 1);
  await click(target.text);
  await sleep(3000);

  const row = { step, clicked: target.text };
  const after = await ev(SNAP_JS);
  if (after.charts > 0) {
    victory = true;
    row.note = `出图 canvas=${after.canvas} libs=${after.libs} svg=${after.bigSvg}`;
    trace.push(row);
    break;
  }
  const fresh = [...new Set(api.slice(before).map((a) => `${a.status} ${a.url.split('?')[0]}`))];
  if (fresh.length) row.api = fresh;
  else row.note = '无接口调用';
  trace.push(row);
}

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
const outFile = args.out ? path.resolve(args.out) : path.join(ROOT, 'logs', 'walk-last.png');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));

const fails = [...new Set(api.filter((a) => a.status >= 400).map((a) => `${a.status} ${a.url.split('?')[0]}`))];
const final = await ev(SNAP_JS);

console.log('');
console.log('  ── 点击轨迹 ──');
for (const t of trace) {
  console.log(`   ${String(t.step).padStart(2)}. ${t.clicked || t.note || ''}${t.api ? `   →  ${t.api.join(', ')}` : ''}${t.note && t.clicked ? `   (${t.note})` : ''}`);
}
console.log('');
console.log(`  浏览器      ${version.Browser}`);
console.log(`  图表        canvas=${final.canvas} libs=${final.libs} bigSvg=${final.bigSvg}`);
console.log(`  失败接口    ${fails.length ? fails.join(' | ') : '无'}`);
console.log(`  控制台错误  ${errors.length ? [...new Set(errors)].slice(0, 3).join(' | ') : '无'}`);
console.log(`  截图        ${outFile}`);
console.log('');
console.log(victory ? '  ✅ 出图了' : '  ❌ 没出图');
console.log('');

cdp.close();
process.exit(victory ? 0 : 1);
