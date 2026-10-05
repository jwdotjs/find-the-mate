// Progress lives under one versioned localStorage key.
//
// Shape (v1):
//   {
//     v: 1,
//     settings: { sound: true, depth: 1 },
//     cur:  { "2": "aB3dE" },               // last puzzle viewed per depth
//     done: { "2": { "aB3dE": 1, ... } },   // result per puzzle ID
//   }
//
// Results: 1 = clean solve, 2 = solved with a mistake or hint, 3 = solution viewed.
// Only the best (lowest) result is kept.
//
// Everything is keyed by stable Lichess puzzle IDs, never by array position,
// so puzzles can be added, removed or re-sorted without breaking progress.
// Each solved puzzle costs ~10 bytes; 10,000 solves is ~100KB of a ~5MB quota.

const KEY = 'ftm:v1';

export const RESULT = { CLEAN: 1, ASSISTED: 2, REVEALED: 3 };

function empty() {
  return { v: 1, settings: { sound: true, depth: 1 }, cur: {}, done: {} };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const data = JSON.parse(raw);
    if (data?.v !== 1) return empty(); // future: migrate older versions here
    return { ...empty(), ...data, settings: { ...empty().settings, ...data.settings } };
  } catch {
    return empty();
  }
}

let state = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode or quota exceeded: keep working in memory.
  }
}

export const store = {
  get settings() {
    return state.settings;
  },
  setSetting(key, value) {
    state.settings[key] = value;
    save();
  },
  current(depth) {
    return state.cur[depth];
  },
  setCurrent(depth, id) {
    state.cur[depth] = id;
    save();
  },
  result(depth, id) {
    return state.done[depth]?.[id];
  },
  record(depth, id, result) {
    const level = (state.done[depth] ??= {});
    const prev = level[id];
    if (prev === undefined || result < prev) {
      level[id] = result;
      save();
    }
  },
  // Solved = clean or assisted. Viewing the solution doesn't count.
  isSolved(depth, id) {
    const r = state.done[depth]?.[id];
    return r !== undefined && r < RESULT.REVEALED;
  },
  // Raw count, used before a level's puzzle file is loaded.
  doneCount(depth) {
    return Object.values(state.done[depth] ?? {}).filter((r) => r < RESULT.REVEALED).length;
  },
  // Counts only IDs that still exist in the current puzzle set.
  solvedCount(depth, ids) {
    let n = 0;
    for (const id of ids) if (this.isSolved(depth, id)) n++;
    return n;
  },
  resetDepth(depth) {
    delete state.done[depth];
    delete state.cur[depth];
    save();
  },
  resetAll() {
    const { settings } = state;
    state = { ...empty(), settings };
    save();
  },
};
