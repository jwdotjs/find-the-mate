// Checks every puzzle in data/: legal line, ends in checkmate, correct depth,
// no duplicate IDs. Run: node scripts/validate.mjs
import { readFileSync } from 'node:fs';
import { Chess } from '../js/vendor/chess.js';

const dataDir = new URL('../data/', import.meta.url);
const { depths } = JSON.parse(readFileSync(new URL('index.json', dataDir)));
const seen = new Set();
let errors = 0;

for (const { depth } of depths) {
  const { puzzles } = JSON.parse(readFileSync(new URL(`mate-${depth}.json`, dataDir)));
  let prev = 0;
  for (const [id, fen, moves, rating] of puzzles) {
    const fail = (msg) => { errors++; console.error(`mate-${depth} ${id}: ${msg}`); };
    if (seen.has(id)) fail('duplicate id');
    seen.add(id);
    if (rating < prev) fail('not sorted by rating');
    prev = rating;
    const line = moves.split(' ');
    if (line.length !== depth * 2) fail(`line length ${line.length}`);
    const game = new Chess(fen);
    try {
      for (const uci of line) {
        game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      }
      if (!game.isCheckmate()) fail('line does not end in checkmate');
    } catch (e) {
      fail(`illegal move: ${e.message}`);
    }
  }
  console.log(`mate in ${depth}: ${puzzles.length} ok`);
}

if (errors) {
  console.error(`${errors} error(s)`);
  process.exit(1);
}
