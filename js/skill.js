// Mix mode: one Elo-style rating per mate depth, and a picker that serves a
// puzzle near the player's rating, hopping between depths for variety.
//
// Ratings move fast at first (K starts high) and settle as more puzzles are
// played, so a few misses quickly find the level where the player starts to fail.
// Puzzle ratings are Lichess ratings, so they're on the same scale.

export const START_RATING = 1200;
export const PROVISIONAL = 8; // puzzles played before a rating counts as settled

const K_START = 160;
const K_DECAY = 0.85;
const K_MIN = 32;
const MIN_RATING = 400;
const MAX_RATING = 3000;
const JITTER = 150; // aim a little above or below the rating each time
const WINDOW = 250; // a depth joins the rotation if it has a puzzle this close
const NEAREST = 4; // pick at random among this many closest puzzles
const REPEAT_WEIGHT = 0.3; // makes the same depth twice in a row less likely

export const SCORE = { WIN: 1, HINTED: 0.5, MISS: 0 };

const expected = (r, puzzleRating) => 1 / (1 + 10 ** ((puzzleRating - r) / 400));
const kFactor = (n) => Math.max(K_MIN, K_START * K_DECAY ** n);

// Rating at `depth`. An unplayed depth borrows from the nearest played one.
export function ratingFor(skills, depth) {
  if (skills[depth]?.n) return skills[depth].r;
  let best = null;
  for (const [d, s] of Object.entries(skills)) {
    if (!s.n) continue;
    const dist = Math.abs(Number(d) - depth);
    if (!best || dist < best.dist || (dist === best.dist && Number(d) < best.d)) best = { d: Number(d), dist, r: s.r };
  }
  return best ? best.r : START_RATING;
}

// Returns the new { r, n } for `depth` plus the change in rating.
export function rate(skills, depth, puzzleRating, score) {
  const r = ratingFor(skills, depth);
  const n = skills[depth]?.n ?? 0;
  const next = Math.round(Math.min(MAX_RATING, Math.max(MIN_RATING, r + kFactor(n) * (score - expected(r, puzzleRating)))));
  return { skill: { r: next, n: n + 1 }, delta: next - r };
}

// sets: Map of depth -> puzzles ([id, fen, moves, rating]).
// avoid(depth, id): played recently, never serve. seen(depth, id): played before, serve only if nothing else fits.
export function pick({ sets, skills, lastDepth, avoid, seen, rand = Math.random }) {
  const options = [];
  for (const [depth, list] of sets) {
    const open = list.filter((p) => !avoid(depth, p[0]));
    const fresh = open.filter((p) => !seen(depth, p[0]));
    const pool = fresh.length ? fresh : open;
    if (!pool.length) continue;
    const target = ratingFor(skills, depth) + (rand() * 2 - 1) * JITTER;
    const near = pool
      .map((p) => ({ p, dist: Math.abs(p[3] - target) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, NEAREST);
    const choice = near[Math.floor(rand() * near.length)];
    // Shorter mates come up a bit more often: they're quicker and there are more of them.
    const weight = (1 / Math.sqrt(depth)) * (depth === lastDepth ? REPEAT_WEIGHT : 1);
    options.push({ depth, puzzle: choice.p, dist: choice.dist, weight });
  }
  if (!options.length) return null;

  let eligible = options.filter((o) => o.dist <= WINDOW);
  if (!eligible.length) eligible = [options.reduce((a, b) => (b.dist < a.dist ? b : a))];
  let roll = rand() * eligible.reduce((sum, o) => sum + o.weight, 0);
  for (const o of eligible) {
    roll -= o.weight;
    if (roll <= 0) return o;
  }
  return eligible[eligible.length - 1];
}
