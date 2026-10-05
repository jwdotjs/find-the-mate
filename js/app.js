import { Chess } from './vendor/chess.js';
import { Board } from './board.js';
import { store, RESULT } from './storage.js';
import { sound, unlockAudio, setSoundEnabled } from './sound.js';

const $ = (id) => document.getElementById(id);

const TIERS = [
  [1000, 'Beginner'],
  [1400, 'Easy'],
  [1800, 'Medium'],
  [2200, 'Hard'],
  [2600, 'Expert'],
  [Infinity, 'Master'],
];
const COLOR_NAME = { w: 'White', b: 'Black' };
const OPENING_DELAY = 550;
const REPLY_DELAY = 400;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tierOf = (rating) => TIERS.findIndex(([max]) => rating < max);

let depthsMeta = [];
const cache = new Map(); // depth -> puzzles
let depth = 1;
let puzzles = [];
let idx = 0;
let p = null; // active puzzle state
let session = 0; // bumps on every puzzle load; stale async steps bail out

const board = new Board($('board'), { onMove: onUserMove });

// ---------- data ----------

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function loadDepth(n) {
  if (!cache.has(n)) cache.set(n, (await fetchJSON(`data/mate-${n}.json`)).puzzles);
  return cache.get(n);
}

// ---------- chess helpers ----------

function kingSquare(game, color) {
  for (const rank of game.board()) {
    for (const c of rank) if (c && c.type === 'k' && c.color === color) return c.square;
  }
  return null;
}

function legalDests(game) {
  const dests = new Map();
  for (const m of game.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, new Set());
    dests.get(m.from).add(m.to);
  }
  return dests;
}

const parseUci = (uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

function isPromotion(game, from, to) {
  const piece = game.get(from);
  return piece?.type === 'p' && (to[1] === '8' || to[1] === '1');
}

// ---------- board sync ----------

function render(lastMove = p.lastMove) {
  board.setPosition(p.game.board());
  board.setMarks({
    last: lastMove ?? [],
    check: p.game.inCheck() ? kingSquare(p.game, p.game.turn()) : null,
    hint: [],
    wrong: null,
  });
}

async function playMove(uci, { animate = true } = {}) {
  const m = parseUci(uci);
  const move = p.game.move(m);
  if (animate) await board.animateMove(m.from, m.to);
  p.lastMove = [m.from, m.to];
  render();
  if (p.game.isCheckmate()) sound.mate();
  else if (p.game.inCheck()) sound.check();
  else if (move.captured) sound.capture();
  else sound.move();
  return move;
}

function enableInput() {
  board.setMovable(p.color, legalDests(p.game));
}

function disableInput() {
  board.setMovable(null);
}

// ---------- puzzle flow ----------

const movesLeft = () => (p.line.length - p.ply + 1) / 2;

async function loadPuzzle(i) {
  const my = ++session;
  idx = Math.max(0, Math.min(i, puzzles.length - 1));
  const [id, fen, moves, rating] = puzzles[idx];
  const game = new Chess(fen);
  p = {
    id,
    rating,
    game,
    line: moves.split(' '),
    ply: 0,
    color: game.turn() === 'w' ? 'b' : 'w', // first move belongs to the opponent
    lastMove: null,
    mistakes: false,
    hinted: false,
    revealed: false,
    done: false,
  };
  store.setCurrent(depth, id);

  board.setOrientation(p.color === 'w' ? 'white' : 'black');
  disableInput();
  board.clearMarks();
  render();
  renderMeta();
  setStatus('Opponent to move…');
  setButtons();

  await wait(OPENING_DELAY);
  if (my !== session) return;
  await playMove(p.line[0]);
  if (my !== session) return;
  p.ply = 1;
  setStatus(`<b>${COLOR_NAME[p.color]}</b> to move. Find mate in ${depth}.`);
  enableInput();
}

async function onUserMove(from, to) {
  const my = session;
  let promotion;
  if (isPromotion(p.game, from, to)) {
    disableInput();
    promotion = await askPromotion(p.color);
    if (my !== session) return;
    if (!promotion) {
      render();
      enableInput();
      return;
    }
  }
  const uci = from + to + (promotion ?? '');
  const expected = p.line[p.ply];

  // Any immediate checkmate is accepted, even if it differs from the stored line.
  const probe = new Chess(p.game.fen());
  probe.move({ from, to, promotion });
  const mates = probe.isCheckmate();

  disableInput();

  if (uci === expected || mates) {
    await playMove(uci, { animate: false });
    if (my !== session) return;
    p.ply++;
    if (p.game.isCheckmate()) return finish();

    setStatus('Good…', 'good');
    await wait(REPLY_DELAY);
    if (my !== session) return;
    await playMove(p.line[p.ply]);
    if (my !== session) return;
    p.ply++;
    setStatus(`<b>${COLOR_NAME[p.color]}</b> to move. Mate in ${movesLeft()}.`);
    enableInput();
    return;
  }

  // Wrong: show the move briefly, then take it back.
  p.mistakes = true;
  const prevLast = p.lastMove;
  p.game.move({ from, to, promotion });
  render([from, to]);
  board.setMarks({ wrong: to });
  sound.wrong();
  setStatus('Not that one. Try again.', 'bad');
  await wait(650);
  if (my !== session) return;
  p.game.undo();
  render(prevLast);
  enableInput();
}

function finish() {
  p.done = true;
  disableInput();
  const result = p.revealed ? RESULT.REVEALED : p.mistakes || p.hinted ? RESULT.ASSISTED : RESULT.CLEAN;
  store.record(depth, p.id, result);
  const link = `<a href="https://lichess.org/training/${p.id}" target="_blank" rel="noopener">Analyse</a>`;
  const msg = {
    [RESULT.CLEAN]: 'Checkmate! Clean solve.',
    [RESULT.ASSISTED]: 'Checkmate! Solved with help.',
    [RESULT.REVEALED]: 'That’s the mate.',
  }[result];
  setStatus(`${msg} ${link}`, result === RESULT.REVEALED ? '' : 'good');
  setButtons();
  renderProgress();
}

function hint() {
  if (!p || p.done || p.ply % 2 === 0) return;
  const { from, to } = parseUci(p.line[p.ply]);
  // First tap: the piece to move. Second tap: its target too.
  const showTarget = p.hinted && board.marks.hint.length === 1;
  p.hinted = true;
  board.setMarks({ hint: showTarget ? [from, to] : [from] });
}

async function showSolution() {
  if (!p || p.done || p.ply === 0) return;
  const my = session;
  p.revealed = true;
  disableInput();
  setStatus('Showing solution…');
  while (p.ply < p.line.length) {
    await playMove(p.line[p.ply]);
    if (my !== session) return;
    p.ply++;
    if (p.ply < p.line.length) await wait(700);
    if (my !== session) return;
  }
  finish();
}

// ---------- promotion picker ----------

function askPromotion(color) {
  const dlg = $('promo');
  dlg.innerHTML = ['q', 'r', 'b', 'n']
    .map((t) => `<button value="${t}"><img src="img/pieces/${color}${t.toUpperCase()}.svg" alt="${t}"></button>`)
    .join('');
  return new Promise((resolve) => {
    const done = (v) => {
      dlg.close();
      resolve(v);
    };
    dlg.onclick = (e) => {
      const btn = e.target.closest('button');
      done(btn ? btn.value : null);
    };
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
  });
}

// ---------- UI ----------

function setStatus(html, tone = '') {
  const el = $('status');
  el.innerHTML = `<span>${html}</span>`;
  el.dataset.tone = tone;
}

function renderMeta() {
  const t = tierOf(p.rating);
  $('turn').innerHTML = `<i class="side ${p.color}"></i>${COLOR_NAME[p.color]} to mate`;
  $('puzzle-num').textContent = `#${idx + 1} of ${puzzles.length}`;
  const pill = $('difficulty');
  pill.textContent = `${TIERS[t][1]} · ${p.rating}`;
  pill.dataset.tier = t;
  pill.title = 'Lichess puzzle rating';
}

function setButtons() {
  $('btn-prev').disabled = idx === 0;
  $('btn-next').disabled = idx >= puzzles.length - 1;
  $('btn-next').classList.toggle('primary', !!p?.done);
  $('btn-hint').hidden = !!p?.done;
  $('btn-solution').hidden = !!p?.done;
  $('btn-retry').hidden = !p?.done;
}

function renderDepths() {
  const nav = $('depths');
  nav.innerHTML =
    '<span class="depths-label">Mate in</span>' +
    depthsMeta
      .map(
        ({ depth: n, count }) => `
      <button data-depth="${n}" aria-label="Mate in ${n}" ${count ? '' : 'disabled'}>
        <span class="n">${n}</span>
        <span class="c" id="depth-count-${n}"></span>
      </button>`,
      )
      .join('');
  nav.onclick = (e) => {
    const btn = e.target.closest('button[data-depth]');
    if (btn) selectDepth(Number(btn.dataset.depth));
  };
  for (const { depth: n } of depthsMeta) updateDepthCount(n);
}

function updateDepthCount(n) {
  const meta = depthsMeta.find((d) => d.depth === n);
  const ids = cache.get(n)?.map((x) => x[0]);
  const solved = ids ? store.solvedCount(n, ids) : Math.min(store.doneCount(n), meta.count);
  const el = $(`depth-count-${n}`);
  el.textContent = solved ? `${solved}/${meta.count}` : `${meta.count}`;
  el.parentElement.classList.toggle('complete', solved === meta.count && meta.count > 0);
}

function renderProgress() {
  const ids = puzzles.map((x) => x[0]);
  const solved = store.solvedCount(depth, ids);
  $('bar-fill').style.width = `${(solved / ids.length) * 100}%`;
  $('level-count').textContent = `${solved} / ${ids.length} solved`;
  updateDepthCount(depth);
}

// First unsolved puzzle at or after `from`, wrapping around; `from` if all solved.
function nextUnsolved(from = 0) {
  for (let k = 0; k < puzzles.length; k++) {
    const i = (from + k) % puzzles.length;
    if (!store.isSolved(depth, puzzles[i][0])) return i;
  }
  return from;
}

async function selectDepth(n) {
  const my = ++session;
  depth = n;
  store.setSetting('depth', n);
  for (const b of document.querySelectorAll('#depths button')) {
    b.classList.toggle('active', Number(b.dataset.depth) === n);
    if (Number(b.dataset.depth) === n) b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
  setStatus('Loading…');
  try {
    puzzles = await loadDepth(n);
  } catch (e) {
    setStatus(`Couldn’t load puzzles. ${e.message}`, 'bad');
    return;
  }
  if (my !== session) return;
  // Resume where the player left off; if that one is solved, move on.
  const saved = puzzles.findIndex(([id]) => id === store.current(n));
  renderProgress();
  loadPuzzle(saved === -1 ? nextUnsolved(0) : nextUnsolved(saved));
}

function openSheet() {
  const ids = puzzles.map((x) => x[0]);
  $('sheet-title').textContent = `Mate in ${depth} · ${store.solvedCount(depth, ids)}/${ids.length}`;
  let lastTier = -1;
  $('grid').innerHTML = puzzles
    .map(([id, , , rating], i) => {
      const t = tierOf(rating);
      const head = t !== lastTier ? `<h3 class="tier" data-tier="${t}">${TIERS[t][1]}</h3>` : '';
      lastTier = t;
      const r = store.result(depth, id) ?? 0;
      return `${head}<button class="cell s${r}${i === idx ? ' cur' : ''}" data-i="${i}" title="${rating}">${i + 1}</button>`;
    })
    .join('');
  $('sheet').showModal();
  $('grid').querySelector('.cur')?.scrollIntoView({ block: 'center' });
}

// ---------- events ----------

$('btn-prev').onclick = () => loadPuzzle(idx - 1);
$('btn-next').onclick = () => loadPuzzle(idx + 1);
$('btn-retry').onclick = () => loadPuzzle(idx);
$('btn-hint').onclick = hint;
$('btn-solution').onclick = showSolution;
$('btn-progress').onclick = openSheet;
$('sheet-close').onclick = () => $('sheet').close();
$('sheet').onclick = (e) => {
  if (e.target === $('sheet')) $('sheet').close(); // backdrop tap
};
$('grid').onclick = (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  $('sheet').close();
  loadPuzzle(Number(cell.dataset.i));
};
$('btn-reset-level').onclick = () => {
  if (!confirm(`Reset progress for Mate in ${depth}?`)) return;
  store.resetDepth(depth);
  $('sheet').close();
  renderProgress();
  loadPuzzle(0);
};
$('btn-reset-all').onclick = () => {
  if (!confirm('Reset ALL progress for every level?')) return;
  store.resetAll();
  $('sheet').close();
  for (const { depth: n } of depthsMeta) updateDepthCount(n);
  renderProgress();
  loadPuzzle(0);
};

function applySound(on) {
  setSoundEnabled(on);
  const btn = $('btn-sound');
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
}
$('btn-sound').onclick = () => {
  const on = !store.settings.sound;
  store.setSetting('sound', on);
  applySound(on);
  if (on) sound.move();
};

document.addEventListener('pointerdown', unlockAudio, { capture: true });
document.addEventListener('keydown', (e) => {
  unlockAudio();
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'ArrowLeft' && idx > 0) loadPuzzle(idx - 1);
  if (e.key === 'ArrowRight' && idx < puzzles.length - 1) loadPuzzle(idx + 1);
});

// ---------- boot ----------

(async function init() {
  applySound(store.settings.sound);
  try {
    depthsMeta = (await fetchJSON('data/index.json')).depths;
  } catch (e) {
    setStatus(`Couldn’t load puzzles. ${e.message}`, 'bad');
    return;
  }
  renderDepths();
  const start = depthsMeta.some((d) => d.depth === store.settings.depth && d.count) ? store.settings.depth : 1;
  selectDepth(start);
})();
