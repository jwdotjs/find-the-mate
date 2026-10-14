import { Chess } from './vendor/chess.js';
import { Board } from './board.js';
import { store, RESULT } from './storage.js';
import { sound, unlockAudio, setSoundEnabled } from './sound.js';
import { pick, rate, ratingFor, SCORE, PROVISIONAL } from './skill.js';

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
const MIX = 'mix';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tierOf = (rating) => TIERS.findIndex(([max]) => rating < max);

let depthsMeta = [];
const cache = new Map(); // depth -> puzzles
let mode = 'level'; // 'level': one depth in order. MIX: adaptive, any depth.
let depth = 1; // depth of the puzzle on the board
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

async function loadPuzzle(i, { rated = false } = {}) {
  const my = ++session;
  idx = Math.max(0, Math.min(i, puzzles.length - 1));
  const [id, fen, moves, rating] = puzzles[idx];
  const game = new Chess(fen);
  p = {
    id,
    depth,
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
    rated, // Mix mode: rating already updated for this puzzle
    delta: null,
  };
  if (mode !== MIX) store.setCurrent(depth, id);

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
  const delta = settle(SCORE.MISS);
  const prevLast = p.lastMove;
  p.game.move({ from, to, promotion });
  render([from, to]);
  board.setMarks({ wrong: to });
  sound.wrong();
  setStatus(`Not that one${delta === null ? '' : ` (${fmtDelta(delta)})`}. Try again.`, 'bad');
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
  settle(p.revealed ? SCORE.MISS : p.hinted ? SCORE.HINTED : SCORE.WIN);
  const link = `<a href="https://lichess.org/training/${p.id}" target="_blank" rel="noopener">Analyze</a>`;
  const msg = {
    [RESULT.CLEAN]: 'Checkmate! Clean solve.',
    [RESULT.ASSISTED]: 'Checkmate! Solved with help.',
    [RESULT.REVEALED]: 'That’s the mate.',
  }[result];
  const delta = p.delta === null ? '' : ` ${fmtDelta(p.delta)}`;
  setStatus(`${msg}${delta} ${link}`, result === RESULT.REVEALED ? '' : 'good');
  setButtons();
  renderProgress();
}

// Mix mode: the first miss, or the finish, sets the rating change. Once per puzzle.
function settle(score) {
  if (mode !== MIX || p.rated) return null;
  p.rated = true;
  const { skill, delta } = rate(store.skills, depth, p.rating, score);
  store.setSkill(depth, skill);
  store.setMixCurrent(null);
  p.delta = delta;
  renderSkill();
  return delta;
}

const fmtDelta = (d) => `<span class="delta">${d >= 0 ? '+' : '−'}${Math.abs(d)}</span>`;

function next() {
  if (mode !== MIX) return loadPuzzle(idx + 1);
  if (p && !p.done && p.ply > 0) settle(SCORE.MISS); // skipping counts as a miss
  nextMix();
}

function nextMix() {
  const sets = new Map(depthsMeta.filter((d) => d.count).map((d) => [d.depth, cache.get(d.depth)]));
  const choice = pick({
    sets,
    skills: store.skills,
    lastDepth: p ? depth : null,
    avoid: (d, id) => store.isRecent(id),
    seen: (d, id) => store.result(d, id) !== undefined,
  });
  if (!choice) return setStatus('No puzzles left to serve.', 'bad');
  loadMix(choice.depth, choice.puzzle[0]);
}

function loadMix(d, id, opts) {
  depth = d;
  puzzles = cache.get(d);
  store.addRecent(id);
  if (!opts?.rated) store.setMixCurrent({ d, id });
  loadPuzzle(puzzles.findIndex(([x]) => x === id), opts);
  renderSkill();
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
  $('puzzle-num').hidden = mode === MIX;
  $('mate-in').textContent = `Mate in ${depth}`;
  $('mate-in').hidden = mode !== MIX;
  const pill = $('difficulty');
  pill.textContent = `${TIERS[t][1]} · ${p.rating}`;
  pill.dataset.tier = t;
  pill.title = 'Lichess puzzle rating';
}

function setButtons() {
  const mix = mode === MIX;
  const skip = mix && !p?.done;
  $('btn-prev').hidden = mix;
  $('btn-prev').disabled = idx === 0;
  $('btn-next').disabled = !mix && idx >= puzzles.length - 1;
  $('btn-next').setAttribute('aria-label', skip ? 'Skip puzzle' : 'Next puzzle');
  $('btn-next').title = skip ? 'Skip (counts as a miss)' : '';
  $('btn-next').classList.toggle('primary', !!p?.done);
  $('btn-hint').hidden = !!p?.done;
  $('btn-solution').hidden = !!p?.done;
  $('btn-retry').hidden = !p?.done;
}

function renderDepths() {
  const nav = $('depths');
  nav.innerHTML =
    `<button data-depth="${MIX}" class="mix" aria-label="Mix: puzzles from every depth, matched to your level">
      <span class="n">Mix</span>
      <span class="c">adaptive</span>
    </button>` +
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
    if (btn) selectDepth(btn.dataset.depth === MIX ? MIX : Number(btn.dataset.depth));
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

function markActive(value) {
  for (const b of document.querySelectorAll('#depths button')) {
    const on = b.dataset.depth === String(value);
    b.classList.toggle('active', on);
    if (on) b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
}

function applyMode() {
  const mix = mode === MIX;
  $('level-progress').hidden = mix;
  $('skill').hidden = !mix;
  $('btn-progress').setAttribute('aria-label', mix ? 'Your ratings' : 'All puzzles in this level');
}

async function selectDepth(n) {
  if (n === MIX) return selectMix();
  const my = ++session;
  mode = 'level';
  depth = n;
  store.setSetting('depth', n);
  markActive(n);
  applyMode();
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

async function selectMix() {
  const my = ++session;
  mode = MIX;
  store.setSetting('depth', MIX);
  markActive(MIX);
  applyMode();
  setStatus('Loading…');
  try {
    await Promise.all(depthsMeta.filter((d) => d.count).map((d) => loadDepth(d.depth)));
  } catch (e) {
    setStatus(`Couldn’t load puzzles. ${e.message}`, 'bad');
    return;
  }
  if (my !== session) return;
  // Resume an unfinished puzzle so reloading doesn't dodge a miss.
  const cur = store.mixCurrent;
  if (cur && cache.get(cur.d)?.some(([id]) => id === cur.id)) loadMix(cur.d, cur.id);
  else nextMix();
}

function renderSkill() {
  if (mode !== MIX) return;
  const skills = store.skills;
  const chips = depthsMeta
    .filter(({ depth: d, count }) => count && (skills[d]?.n || d === depth))
    .map(({ depth: d }) => {
      const provisional = (skills[d]?.n ?? 0) < PROVISIONAL;
      const delta = p?.depth === d && p.delta !== null ? fmtDelta(p.delta) : '';
      return `<span class="chip${d === depth ? ' cur' : ''}" title="Mate in ${d}${provisional ? ' (provisional)' : ''}">
        <span class="d">M${d}</span><b>${ratingFor(skills, d)}${provisional ? '?' : ''}</b>${delta}
      </span>`;
    })
    .join('');
  $('skill').innerHTML = `<span class="skill-label">Rating</span>${chips}`;
}

function renderSkillTable() {
  const skills = store.skills;
  $('sheet-title').textContent = 'Your rating by depth';
  const rows = depthsMeta
    .filter((d) => d.count)
    .map(({ depth: d }) => {
      const n = skills[d]?.n ?? 0;
      const r = ratingFor(skills, d);
      const t = tierOf(r);
      return `<div class="row${d === depth ? ' cur' : ''}">
        <span class="name">Mate in ${d}</span>
        <span class="muted">${n ? `${n} played` : 'not played yet'}</span>
        <span class="pill" data-tier="${t}">${TIERS[t][1]} · ${r}${n < PROVISIONAL ? '?' : ''}</span>
      </div>`;
    })
    .join('');
  $('skill-table').innerHTML =
    `<p class="muted">Each depth has its own rating. It moves fast at first, then settles (the ? goes away after ${PROVISIONAL} puzzles). A wrong move, a skip or the solution counts as a miss; a hint counts as half.</p>` +
    rows;
}

function openSheet() {
  const mix = mode === MIX;
  $('legend').hidden = mix;
  $('grid').hidden = mix;
  $('btn-reset-level').hidden = mix;
  $('skill-table').hidden = !mix;
  $('btn-reset-skill').hidden = !mix;
  if (mix) {
    renderSkillTable();
    $('sheet').showModal();
    return;
  }
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
$('btn-next').onclick = next;
$('btn-retry').onclick = () => (mode === MIX ? loadMix(depth, p.id, { rated: true }) : loadPuzzle(idx));
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
  if (mode === MIX) nextMix();
  else loadPuzzle(0);
};
$('btn-reset-skill').onclick = () => {
  if (!confirm('Reset your Mix ratings for every depth?')) return;
  store.resetSkills();
  $('sheet').close();
  nextMix();
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
  if (mode === MIX) {
    if (e.key === 'ArrowRight' && p?.done) next();
    return;
  }
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
  const saved = store.settings.depth;
  const start = saved === MIX || depthsMeta.some((d) => d.depth === saved && d.count) ? saved : 1;
  selectDepth(start);
})();
