// Screenshot driver for Sky Courier — Ring Run. Written from scratch here.
// Drives the headless Chromium on this machine over CDP with Node 22's
// built-in WebSocket (stdlib only). Captures real renders of game/index.html
// at ?shot=<scene> into screenshots/ as JPEGs.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell';
const GAME = 'file:///home/hatch/workspace/makefun/entries/flight-game-20261126/game/index.html';
const OUT = '/home/hatch/workspace/makefun/entries/flight-game-20261126/screenshots';
const PORT = 9333;

const SHOTS = [
  { shot: 'cruise', file: '01-cruise.jpg' },
  { shot: 'ring', file: '02-ring.jpg' },
  { shot: 'final', file: '03-final.jpg' },
  { shot: 'menu', file: '04-menu.jpg' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`CDP endpoint ${path} never came up`);
}

async function main() {
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1280,720', '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: 'ignore' });
  try {
    const targets = await getJson('/json/list');
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params.exceptionDetails));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    for (const s of SHOTS) {
      await send('Page.navigate', { url: `${GAME}?shot=${s.shot}` });
      await sleep(2500);
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
      const buf = Buffer.from(shot.data, 'base64');
      writeFileSync(join(OUT, s.file), buf);
      console.log(`${s.file}: ${buf.length} bytes (shot=${s.shot})`);
    }
    if (errors.length) {
      console.log('PAGE ERRORS:');
      for (const e of errors) console.log('  ' + e);
    } else {
      console.log('no page errors');
    }
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
