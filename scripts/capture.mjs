#!/usr/bin/env node
/**
 * capture.mjs — 通过 CDP 录一份 HAR（等价于 DevTools 的 "Export HAR"）
 *
 * 为什么不用 Network.getHAR：Chrome 152 的协议里已经没有这个命令了，
 * 所以这里监听 Network.* 事件 + getResponseBody 自己拼标准 HAR 1.2。
 *
 * 前提：一个开着远程调试端口的 Chrome（Chrome 136+ 不允许用默认 profile 开调试口）：
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-replay
 *
 * 用法：
 *   node scripts/capture.mjs --url https://example.com/app
 *   node scripts/capture.mjs --url https://example.com/app --wait 60      # 无人值守
 *   node scripts/capture.mjs --url https://example.com/app --out my.har
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { connect, newPage, sleep } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { port: 9222, url: null, out: null, wait: null, cache: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--wait') out.wait = Number(argv[++i]);
    else if (a === '--keep-cache') out.cache = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/capture.mjs --url <地址> [--port 9222] [--out file.har] [--wait 秒]');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.url) {
  console.error('必须给 --url。例：node scripts/capture.mjs --url https://example.com/app');
  process.exit(1);
}

const headerArr = (h) => Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));

function buildEntry(rec) {
  const resp = rec.response || {};
  let queryString = [];
  try { queryString = [...new URL(rec.url).searchParams].map(([name, value]) => ({ name, value })); } catch { /* ignore */ }

  const bodyLen = rec.body?.body
    ? (rec.body.base64Encoded ? Buffer.from(rec.body.body, 'base64').length : Buffer.byteLength(rec.body.body))
    : 0;
  const ms = rec.ts && rec.endTs ? Math.max(0, Math.round((rec.endTs - rec.ts) * 1000)) : 0;

  const entry = {
    startedDateTime: rec.startedDateTime,
    time: ms,
    request: {
      method: rec.method,
      url: rec.url,
      httpVersion: resp.protocol || 'http/2',
      cookies: [],
      headers: headerArr(rec.reqHeaders),
      queryString,
      headersSize: -1,
      bodySize: rec.postData ? Buffer.byteLength(rec.postData) : 0,
    },
    response: {
      status: resp.status ?? 0,
      statusText: resp.statusText || '',
      httpVersion: resp.protocol || 'http/2',
      cookies: [],
      headers: headerArr(resp.headers),
      content: {
        size: bodyLen,
        mimeType: resp.mimeType || 'application/octet-stream',
        ...(rec.body?.body ? { text: rec.body.body } : {}),
        ...(rec.body?.base64Encoded ? { encoding: 'base64' } : {}),
      },
      redirectURL: resp.headers?.location || resp.headers?.Location || '',
      headersSize: -1,
      bodySize: rec.encodedDataLength ?? -1,
      _resourceType: rec.type,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: ms, receive: 0, ssl: -1 },
  };

  if (rec.postData) {
    entry.request.postData = {
      mimeType: rec.reqHeaders?.['Content-Type'] || rec.reqHeaders?.['content-type'] || 'application/json',
      text: rec.postData,
    };
  }
  return entry;
}

async function main() {
  let cdp;
  try {
    ({ cdp } = await connect(args.port));
  } catch {
    console.error(`
  连不上 127.0.0.1:${args.port}。先起一个"可被接管"的 Chrome：

    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
      --remote-debugging-port=${args.port} --user-data-dir=/tmp/chrome-replay

  注意：Chrome 136+ 禁止用默认 profile 开调试口，所以必须给独立的 --user-data-dir。
`);
    process.exit(2);
  }

  const { sessionId } = await newPage(cdp);
  await cdp.send('Network.enable', { maxTotalBufferSize: 300 * 1024 * 1024, maxResourceBufferSize: 100 * 1024 * 1024 }, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  if (!args.cache) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);

  const records = [];
  const byId = new Map();
  const bodyTasks = [];

  // 页面跳转会取消在途请求的响应体，失败就稍等重试
  async function fetchBody(requestId, rec, attempt = 0) {
    try {
      rec.body = await cdp.send('Network.getResponseBody', { requestId }, sessionId);
    } catch {
      if (attempt < 2) { await sleep(150); return fetchBody(requestId, rec, attempt + 1); }
    }
  }

  cdp.on('Network.requestWillBeSent', (p, sid) => {
    if (sid !== sessionId) return;
    if (p.redirectResponse) {
      const prev = byId.get(p.requestId);
      if (prev) { prev.response = p.redirectResponse; prev.endTs = p.timestamp; prev._redirect = true; }
    }
    const rec = {
      method: p.request.method,
      url: p.request.url,
      reqHeaders: p.request.headers,
      postData: p.request.postData,
      startedDateTime: new Date((p.wallTime || Date.now() / 1000) * 1000).toISOString(),
      ts: p.timestamp,
      type: p.type,
    };
    byId.set(p.requestId, rec);
    records.push(rec);
  });

  cdp.on('Network.responseReceived', (p, sid) => {
    if (sid !== sessionId) return;
    const rec = byId.get(p.requestId);
    if (rec) rec.response = p.response;
  });

  cdp.on('Network.loadingFinished', (p, sid) => {
    if (sid !== sessionId) return;
    const rec = byId.get(p.requestId);
    if (!rec) return;
    rec.endTs = p.timestamp;
    rec.encodedDataLength = p.encodedDataLength;
    bodyTasks.push(fetchBody(p.requestId, rec));
  });

  let lastUrl = '';
  cdp.on('Page.frameNavigated', (p, sid) => {
    if (sid !== sessionId || p.frame?.parentId) return;
    lastUrl = p.frame.url || '';
  });

  await cdp.send('Page.navigate', { url: args.url }, sessionId);

  console.log(`
  正在录制新开的那个标签页。请在里面：
    · 把每个页面、每个 tab 都点一遍
    · 走一次完整的核心流程（输入 → 提交 → 出结果）
    · 展开下拉、翻页（真正的 chunk 往往在这些动作里才加载）
`);

  if (args.wait != null) {
    console.log(`  无人值守：录制 ${args.wait} 秒…`);
    await sleep(args.wait * 1000);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('  点完之后回这里按回车，开始导出 … ');
    rl.close();
  }

  process.stdout.write('\n  收尾：等响应体下载完 … ');
  await Promise.allSettled(bodyTasks);
  await sleep(400);
  await Promise.allSettled(bodyTasks);
  console.log('ok');

  const entries = records.filter((r) => r.response && r.response.status).map(buildEntry);
  fs.mkdirSync(path.join(ROOT, 'captures'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = args.out ? path.resolve(args.out) : path.join(ROOT, 'captures', `capture-${stamp}.har`);

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'har-replay-lab/capture.mjs', version: '1.0' },
      browser: { name: 'Chrome', version: String('') },
      pages: [{ startedDateTime: entries[0]?.startedDateTime || new Date().toISOString(), id: 'page_1', title: lastUrl, pageTimings: { onContentLoad: -1, onLoad: -1 } }],
      entries,
    },
  };
  fs.writeFileSync(outFile, JSON.stringify(har, null, 1));

  const withBody = entries.filter((e) => typeof e.response.content.text === 'string').length;
  console.log('');
  console.log(`  文件   ${outFile}`);
  console.log(`  大小   ${(fs.statSync(outFile).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  请求   ${entries.length} 条 · ${withBody} 条带响应体`);
  console.log('');
  console.log('  下一步: node scripts/to-site.mjs ' + path.relative(process.cwd(), outFile));
  console.log('');

  cdp.close();
}

main().catch((err) => {
  console.error(`\n  出错: ${err.message}\n`);
  process.exit(1);
});
