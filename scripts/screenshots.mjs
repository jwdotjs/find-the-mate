// Regenerates the README screenshots in docs/ by driving headless Chrome
// over the DevTools protocol (no npm dependencies).
//
//   python3 -m http.server 8765   # in another terminal
//   CHROME="/path/to/chrome" node scripts/screenshots.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE || 'http://localhost:8765/';
const PORT = 9333;
const VIEWPORT = { width: 375, height: 690, deviceScaleFactor: 2, mobile: true };
const OUT = new URL('../docs/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ftm-shots-'))}`,
    '--no-first-run',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('Chrome did not start');

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const goto = async (url) => {
    await send('Page.navigate', { url });
    await sleep(2200); // load + opponent's opening move
  };
  const scheme = (value) =>
    send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  };
  const clickSelector = async (sel) => {
    const { x, y } = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await clickAt(x, y);
  };
  const clickSquare = (sq) => clickSelector(`.sq[data-square="${sq}"]`);
  const playUci = async (uci) => {
    await clickSquare(uci.slice(0, 2));
    await clickSquare(uci.slice(2, 4));
  };
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'));
    console.log(`docs/${name}`);
  };
  const puzzleLine = () => evaluate(`(() => {
    const id = JSON.parse(localStorage.getItem('ftm:v1')).cur[document.querySelector('#depths .active').dataset.depth];
    return fetch('data/mate-' + document.querySelector('#depths .active').dataset.depth + '.json')
      .then((r) => r.json()).then((d) => d.puzzles.find((p) => p[0] === id)[2].split(' '));
  })()`);

  mkdirSync(OUT, { recursive: true });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  // Seed believable progress in Mate in 1 so the counters and grid have content.
  const mate1 = JSON.parse(readFileSync(new URL('../data/mate-1.json', import.meta.url))).puzzles.map((p) => p[0]);
  const done = {};
  mate1.slice(0, 45).forEach((id, i) => (done[id] = i % 7 === 3 ? 2 : i % 13 === 8 ? 3 : 1));
  const seed = { v: 1, settings: { sound: true, depth: 1 }, cur: { 1: mate1[45] }, done: { 1: done } };

  // 1. Puzzle in progress, piece selected with legal moves shown (light).
  await scheme('light');
  await goto(BASE);
  await evaluate(`localStorage.setItem('ftm:v1', ${JSON.stringify(JSON.stringify(seed))})`);
  await goto(BASE);
  const line1 = await puzzleLine();
  await clickSquare(line1[1].slice(0, 2));
  await sleep(200);
  await shot('puzzle.png');

  // 2. Mate in 2 solved (dark).
  await scheme('dark');
  await clickSelector('#depths [data-depth="2"]');
  await sleep(2000);
  const line2 = await puzzleLine();
  for (let i = 1; i < line2.length; i += 2) {
    await playUci(line2[i]);
    await sleep(1200); // opponent reply
  }
  await shot('solved.png');

  // 3. Progress grid for Mate in 1 (light).
  await scheme('light');
  await clickSelector('#depths [data-depth="1"]');
  await sleep(2000);
  await clickSelector('#btn-progress');
  await sleep(400);
  await shot('progress.png');

  ws.close();
} finally {
  chrome.kill();
}
