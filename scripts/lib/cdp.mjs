// 极简 Chrome DevTools Protocol 客户端：零依赖，靠 Node 内置的 WebSocket
export class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        const cb = this.handlers.get(msg.method);
        if (cb) { try { cb(msg.params, msg.sessionId); } catch { /* 单个 handler 出错不影响整体 */ } }
      }
    });
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify(payload)); } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  on(method, cb) { this.handlers.set(method, cb); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** 连上一个开着远程调试端口的 Chrome，返回 { cdp, version } */
export async function connect(port = 9222) {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready();
  return { cdp, version };
}

/** 新开一个标签页并 attach，返回 { targetId, sessionId } */
export async function newPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
