/**
 * e2e-full.mjs — end-to-end FizzShare check against a running server.
 *   1. sender tab: pick a real file → landing reverts → create room
 *      → share link + QR canvas painted → transfer auto-starts
 *   2. receiver tab: open the share link → received & verified
 *      → download lands on disk with the exact source SHA-256
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';

const CDP_HTTP = 'http://127.0.0.1:9222';
const BASE = process.env.E2E_APP || 'http://127.0.0.1:8123/';
const FIXTURE = '/tmp/opencode/e2e-file.bin';
const DL = '/tmp/opencode/dl-full';
const SIZE = 512 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// deterministic fixture
rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });
const buf = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i += 1) buf[i] = (i * 31 + 7) & 0xff;
writeFileSync(FIXTURE, buf);
const expectSha = createHash('sha256').update(buf).digest('hex');
console.log('fixture:', FIXTURE, SIZE, 'bytes, sha', expectSha.slice(0, 16), '…');

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.p = new Map();
    this.opened = new Promise((r, j) => {
      this.ws.addEventListener('open', r, { once: true });
      this.ws.addEventListener('error', () => j(new Error('ws error')), { once: true });
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const { r, j } = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? j(new Error(m.error.message)) : r(m.result);
      }
    });
  }
  send(method, params = {}, ss = null) {
    const id = ++this.id;
    return new Promise((r, j) => {
      this.p.set(id, { r, j });
      const msg = { id, method, params };
      if (ss) msg.sessionId = ss;
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + method)); } }, 30000);
    });
  }
}

async function connectCdp() {
  const ver = await (await fetch(CDP_HTTP + '/json/version')).json();
  const c = new CDP(ver.webSocketDebuggerUrl);
  await c.opened;
  return c;
}

function makePage(cdp, sessionId) {
  const send = (method, params) => cdp.send(method, params, sessionId);
  return {
    sessionId,
    sendRaw: (method, params) => cdp.send(method, params),
    pageSend: (method, params) => cdp.send(method, params, sessionId),
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r && r.result ? r.result.value : undefined;
    },
    async waitFor(expression, label, timeoutMs = 60000) {
      const t0 = Date.now();
      for (;;) {
        try { if (await this.eval(expression)) return; } catch { /* mid-nav */ }
        if (Date.now() - t0 > timeoutMs) throw new Error('TIMEOUT: ' + label);
        await sleep(400);
      }
    },
  };
}

async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url, background: false });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return makePage(cdp, sessionId);
}

const visible = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && !el.closest('.hidden') && el.offsetParent !== null; })()`;
const hidden = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && !!el.closest('.hidden'); })()`;
const logHas = (needle) => `(() => { const el = document.getElementById('phase-log'); if (!el) return false; return el.textContent.includes(${JSON.stringify(needle)}); })()`;

const FIXTURE_B64 = buf.toString('base64');

/** Feed the fixture through the real <input type=file> change path (same as tapping "Select files"). */
async function setFileInput(page) {
  await page.eval(`(() => {
    const bin = atob(${JSON.stringify(FIXTURE_B64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], 'e2e-file.bin', { type: 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function main() {
  const cdp = await connectCdp();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

  // close stale page tabs
  const stale = await (await fetch(CDP_HTTP + '/json')).json();
  for (const t of stale.filter((x) => x.type === 'page' && x.url !== 'about:blank')) {
    try { await cdp.send('Target.closeTarget', { targetId: t.id }); } catch { /* gone */ }
  }

  // ---------------- sender ----------------
  const A = await openTab(cdp, BASE);
  await A.waitFor("!!document.getElementById('file-input')", 'landing loaded', 20000);
  await A.waitFor("document.readyState === 'complete'", 'page load complete', 30000);
  // Re-arm the change event until the app's listener is bound and picks it up
  // (onFilesPicked is idempotent, so re-dispatching is safe).
  let picked = false;
  for (let i = 0; i < 40 && !picked; i += 1) {
    await setFileInput(A);
    picked = await A.eval(visible('#send-flow')).catch(() => false);
    if (!picked) await sleep(1000);
  }
  if (!picked) throw new Error('file pick never reached the app (send-flow stayed hidden)');
  const landingHidden = await A.eval(hidden('#landing'));
  console.log('sender: file picked → send-flow visible; landing reverted =', landingHidden);
  if (!landingHidden) throw new Error('landing did not revert after file selection');

  await A.eval("document.getElementById('btn-create-room').click();");
  await A.waitFor(visible('#share-box'), 'share box with link + QR', 20000);
  const link = await A.eval("document.getElementById('share-link').value");
  console.log('sender: share link =', link);
  if (!/\/c\/[A-HJ-NP-Z2-9]{6}$/.test(link)) throw new Error('bad share link: ' + link);

  const qr = await A.eval(`(() => { const c = document.getElementById('qr-canvas'); if (!c) return null; const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) dark++; return { w: c.width, h: c.height, dark }; })()`);
  console.log('sender: QR canvas =', JSON.stringify(qr));
  if (!qr || qr.dark < 50) throw new Error('QR code not painted');

  // ---------------- receiver ----------------
  const B = await openTab(cdp, link);
  await B.waitFor("!!document.getElementById('received-list')", 'receiver page loaded', 20000);
  await B.waitFor(logHas('received & verified'), 'receiver verified', 180000);
  const listInfo = await B.eval("[...document.querySelectorAll('#received-list li')].map(li => ({ name: li.querySelector('a').textContent, size: li.querySelector('.sz').textContent }))");
  console.log('receiver: received list =', JSON.stringify(listInfo));
  if (!listInfo.length) throw new Error('no received-file entries');

  const connState = await A.eval("document.getElementById('conn-state').textContent");
  const connPath = await A.eval("document.getElementById('conn-path').textContent");
  console.log('sender: conn-state =', connState, '| path =', connPath);

  // sender must report a verified transfer
  await A.waitFor(logHas('transfer complete — SHA-256 verified'), 'sender verified', 60000);
  console.log('sender: transfer complete — SHA-256 verified');

  // ---------------- download ----------------
  await B.eval("document.getElementById('btn-download-all').click();");
  let saved = [];
  for (let i = 0; i < 60 && saved.length === 0; i += 1) {
    await sleep(500);
    saved = readdirSync(DL).filter((f) => f.startsWith('e2e-file'));
  }
  if (!saved.length) throw new Error('download did not land in ' + DL);
  const sha = createHash('sha256').update(readFileSync(`${DL}/${saved[0]}`)).digest('hex');
  console.log('download:', saved[0], 'sha', sha.slice(0, 16), '…');
  if (sha !== expectSha) throw new Error('SHA mismatch on downloaded file');
  console.log('E2E FULL PASS (link+QR+transfer+download+integrity)');
  process.exit(0);
}

main().catch((e) => { console.error('E2E FULL FAIL:', e.message); process.exit(1); });