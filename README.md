# Find the Mate

Mobile-first checkmate trainer. Pick a depth (mate in 1 through mate in 10) and solve puzzles ordered from easiest to hardest. Static site, no build step, hosted on GitHub Pages.

## Run locally

```bash
python3 -m http.server 8765
```

Open http://localhost:8765. A server is needed because the app loads its puzzle files with `fetch`, which doesn't work from `file://`.

## Deploy (GitHub Pages)

Settings → Pages → Source: "Deploy from a branch" → `main` / root. Every path is relative, so the site works under `https://<user>.github.io/<repo>/`.

## How it works

| Path | Purpose |
| --- | --- |
| `index.html`, `css/style.css` | Layout; light/dark theme |
| `js/app.js` | Puzzle flow: opponent's setup move, checking moves, hints, solution playback |
| `js/board.js` | Touch board: tap-tap or drag, animations, highlights |
| `js/storage.js` | Progress in localStorage |
| `js/sound.js` | Move/capture/check/mate sounds generated with the Web Audio API |
| `js/vendor/chess.js` | [chess.js](https://github.com/jhlywa/chess.js) 1.4.0, for move rules |
| `data/mate-N.json` | Puzzles for each depth, sorted by rating |

**Difficulty** is the Lichess puzzle rating, grouped into tiers: Beginner <1000, Easy <1400, Medium <1800, Hard <2200, Expert <2600, Master.

**Correct moves:** each turn, the move in the puzzle line is accepted, and so is any move that checkmates immediately.

**Progress** is saved under one localStorage key, `ftm:v1`, keyed by stable Lichess puzzle IDs. Adding, removing or re-sorting puzzles never breaks saved progress. Each solved puzzle costs about 10 bytes, so 10,000 solves is about 100KB of the roughly 5MB browsers allow.

## Adding or refreshing puzzles

```bash
curl -s https://database.lichess.org/lichess_db_puzzle.csv.zst | zstd -dc | awk 'NR==1 || /mateIn/' > mates.csv
python3 scripts/build_puzzles.py mates.csv
node scripts/validate.mjs
```

Change `TARGET_PER_DEPTH` in `scripts/build_puzzles.py` to adjust how many puzzles each depth gets (currently 300). Lichess labels mates as `mateIn1` through `mateIn5`, where `mateIn5` means 5 or more, so the script works out the exact depth from the length of the solution. Mate in 8–10 puzzles are rare in the database: currently 69, 17 and 4.

## Credits

- Puzzles: [Lichess puzzle database](https://database.lichess.org/#puzzles), CC0
- Pieces: Colin M.L. Burnett, via [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces/Standard_transparent), BSD-3-Clause (`img/pieces/LICENSE`)
- Move rules: [chess.js](https://github.com/jhlywa/chess.js), BSD-2-Clause (`js/vendor/chess.js.LICENSE`)

## License

Code is [MIT](LICENSE). Bundled third-party assets keep their own licenses (see Credits).
