#!/usr/bin/env node
/**
 * demo-app.mjs — 一个刻意做成"真实长相"的小应用，用来生成 examples/demo.har
 *
 * 它模拟了真实产品里最常见的几件事：
 *   · 登录页 + 表单提交
 *   · NDJSON 流式响应（进度事件逐行推）
 *   · 多轮问答（同一端点被调用多次）
 *   · 最后一轮返回图表数据，前端用 SVG 画出来
 *
 * 所有内容都是合成的，跟任何真实产品无关。
 *
 *   node examples/demo-app.mjs          # http://127.0.0.1:8890
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 8890);

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme Insights</title>
<link rel="stylesheet" href="/assets/app.css"></head>
<body>
  <div id="root"></div>
  <script type="module" src="/assets/app.js"></script>
</body></html>`;

const CSS = `*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1216;color:#e7ecf3}
.wrap{max-width:720px;margin:0 auto;padding:48px 24px}
.card{background:#161b22;border:1px solid #232a33;border-radius:12px;padding:24px;margin-bottom:16px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#8b97a6;font-size:13px;margin-bottom:24px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #2b333d;background:#0f1216;color:#e7ecf3;font-size:14px}
button{margin-top:12px;padding:10px 16px;border-radius:8px;border:0;background:#2f81f7;color:#fff;font-size:14px;cursor:pointer}
button.ghost{background:#21262d;color:#c9d4e0}
button:disabled{opacity:.5;cursor:default}
.q{font-size:15px;margin-bottom:12px}.ask{color:#8b97a6;font-size:13px;margin-bottom:8px}
.chart{margin-top:16px}svg{display:block;width:100%;height:auto}
.log{color:#6b7785;font-size:12px;margin-top:12px;white-space:pre-wrap}
`;

const JS = `const root = document.getElementById('root');
const api = (p, body) => fetch(p, {
  method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});

async function readNdjson(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(JSON.parse(line));
    }
  }
  if (buf.trim()) onLine(JSON.parse(buf.trim()));
}

let state = null;

function render() {
  if (!state) return renderLogin();
  if (state.chart) return renderResult();
  if (state.ask) return renderAsk();
  if (state.done) return renderConfirm();
  return renderHome();
}

function renderLogin() {
  root.innerHTML = '<div class="wrap"><div class="card"><h1>Acme Insights</h1>' +
    '<div class="sub">Sign in to continue</div>' +
    '<input id="email" placeholder="Email" autocomplete="username">' +
    '<input id="pw" type="password" placeholder="Password" autocomplete="current-password">' +
    '<button id="go">Sign in</button></div></div>';
  document.getElementById('go').onclick = async () => {
    const r = await api('/api/auth/login', { email: document.getElementById('email').value, password: document.getElementById('pw').value });
    if (r.ok) { sessionStorage.setItem('t', '1'); state = { phase: 'idle' }; render(); }
  };
}

function renderHome() {
  root.innerHTML = '<div class="wrap"><div class="card"><h1>Plan an analysis</h1>' +
    '<div class="sub">Ask a business question</div>' +
    '<input id="q" placeholder="Ask anything about your business">' +
    '<button id="plan">Plan it</button></div></div>';
  document.getElementById('plan').onclick = () => {
    const q = document.getElementById('q').value || 'untitled';
    root.querySelector('#plan').disabled = true;
    api('/api/plan', { question: q }).then((r) => readNdjson(r, (msg) => {
      if (msg.state) { state = msg.state; render(); }
      else if (msg.progress) log(msg.progress.text);
    }));
  };
}

function log(text) {
  let box = root.querySelector('.log');
  if (!box) { box = document.createElement('div'); box.className = 'log'; root.querySelector('.card')?.appendChild(box); }
  box.textContent += (box.textContent ? '\\n' : '') + text;
}

function renderAsk() {
  const a = state.ask;
  root.innerHTML = '<div class="wrap"><div class="card">' +
    '<div class="ask">QUESTION ' + state.asked + '</div>' +
    '<div class="q">' + a.text + '</div>' +
    a.options.map((o, i) => '<button class="ghost" data-i="' + i + '">' + o.label + '</button>').join('<br>') +
    '</div></div>';
  root.querySelectorAll('button[data-i]').forEach((b) => {
    b.onclick = () => {
      const opt = a.options[Number(b.dataset.i)];
      b.disabled = true;
      api('/api/answer', { question: a.id, answer: opt.id }).then((r) => readNdjson(r, (msg) => {
        if (msg.state) { state = msg.state; render(); }
        else if (msg.progress) log(msg.progress.text);
      }));
    };
  });
}

function renderConfirm() {
  root.innerHTML = '<div class="wrap"><div class="card"><div class="q">Ready to run the analysis.</div>' +
    '<button id="run">Confirm and run</button></div></div>';
  document.getElementById('run').onclick = () => {
    root.querySelector('#run').disabled = true;
    api('/api/run', {}).then((r) => readNdjson(r, (msg) => {
      if (msg.state) { state = msg.state; render(); }
      else if (msg.progress) log(msg.progress.text);
    }));
  };
}

function renderResult() {
  const pts = state.chart.points;
  const w = 640, h = 220, pad = 32;
  const xs = pts.map((p, i) => pad + i * (w - pad * 2) / (pts.length - 1));
  const min = Math.min(...pts.map((p) => p.v)), max = Math.max(...pts.map((p) => p.v));
  const ys = pts.map((p) => h - pad - (p.v - min) / (max - min || 1) * (h - pad * 2));
  const line = xs.map((x, i) => x + ',' + ys[i]).join(' ');
  root.innerHTML = '<div class="wrap"><div class="card"><h1>' + state.chart.title + '</h1>' +
    '<div class="sub">' + state.chart.subtitle + '</div>' +
    '<div class="chart"><svg viewBox="0 0 ' + w + ' ' + h + '" role="img">' +
    '<polyline fill="none" stroke="#2f81f7" stroke-width="2" points="' + line + '"/>' +
    pts.map((p, i) => '<circle cx="' + xs[i] + '" cy="' + ys[i] + '" r="2.5" fill="#2f81f7"/>').join('') +
    '</svg></div></div></div>';
}

if (sessionStorage.getItem('t')) state = { phase: 'idle' };
render();
`;

const QUESTIONS = [
  {
    id: 'q1',
    text: 'Shall I plan this as a comparison over the last 12 months?',
    options: [
      { id: 'o1', label: 'Yes, go that way' },
      { id: 'o2', label: 'Compare with the same months last year' },
      { id: 'o3', label: 'Only explain the change' },
    ],
  },
  {
    id: 'q2',
    text: 'Which result would make you say no action is needed?',
    options: [
      { id: 'o1', label: 'A change under 1 percentage point' },
      { id: 'o2', label: 'A change under 5 percent' },
    ],
  },
];

const sessions = new Map();

function ndjson(res, lines) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  for (const l of lines) res.write(JSON.stringify(l) + '\n');
  res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
    });
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/' || u.pathname === '/login' || u.pathname === '/app') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }
  if (u.pathname === '/assets/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(JS);
  }
  if (u.pathname === '/assets/app.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    return res.end(CSS);
  }
  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (u.pathname === '/api/auth/login' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ access_token: 'demo.header.payload', user: { email: 'demo@example.com', role: 'analyst' } }));
  }

  if (u.pathname === '/api/plan' && req.method === 'POST') {
    const body = await readBody(req);
    const sid = 's1';
    sessions.set(sid, { step: 0, question: body.question || '' });
    return ndjson(res, [
      { progress: { stage: 'understanding', text: 'Reading your question' } },
      { progress: { stage: 'planning', text: 'Drafting the plan' } },
      { state: { phase: 'planning', asked: 1, ask: QUESTIONS[0], question: body.question || '' } },
    ]);
  }

  if (u.pathname === '/api/answer' && req.method === 'POST') {
    const s = sessions.get('s1') || { step: 0 };
    s.step += 1;
    sessions.set('s1', s);
    if (s.step === 1) {
      return ndjson(res, [
        { progress: { stage: 'phrasing', text: 'Writing the next question' } },
        { state: { phase: 'planning', asked: 2, ask: QUESTIONS[1] } },
      ]);
    }
    return ndjson(res, [
      { progress: { stage: 'phrasing', text: 'Writing the next question' } },
      { state: { phase: 'planning', done: true, asked: 2 } },
    ]);
  }

  if (u.pathname === '/api/run' && req.method === 'POST') {
    return ndjson(res, [
      { progress: { stage: 'querying', text: 'Running 2 checks' } },
      { progress: { stage: 'drawing', text: 'Plotting the result' } },
      {
        state: {
          phase: 'results',
          chart: {
            title: 'Revenue by month',
            subtitle: 'Last 12 months vs. previous year',
            points: [
              { m: '2025-01', v: 118 }, { m: '2025-02', v: 121 }, { m: '2025-03', v: 115 },
              { m: '2025-04', v: 127 }, { m: '2025-05', v: 131 }, { m: '2025-06', v: 124 },
              { m: '2025-07', v: 133 }, { m: '2025-08', v: 129 }, { m: '2025-09', v: 137 },
              { m: '2025-10', v: 142 }, { m: '2025-11', v: 139 }, { m: '2025-12', v: 147 },
            ],
          },
        },
      },
    ]);
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: u.pathname }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`  demo app → http://127.0.0.1:${PORT}/login`);
});
