// Minimal touch-first chess board: tap-tap or drag to move, animated moves,
// highlight layers. Knows nothing about rules; the app supplies legal dests.

const FILES = 'abcdefgh';
const ANIM_MS = 180;

export class Board {
  constructor(el, { onMove }) {
    this.el = el;
    this.onMove = onMove;
    this.orientation = 'white';
    this.pieces = new Map(); // square -> <img>
    this.squares = new Map(); // square -> <div>
    this.movableColor = null;
    this.dests = new Map(); // from -> Set(to)
    this.selected = null;
    this.drag = null;
    this.marks = { last: [], check: null, hint: [], wrong: null };

    this.squareLayer = document.createElement('div');
    this.squareLayer.className = 'squares';
    this.pieceLayer = document.createElement('div');
    this.pieceLayer.className = 'pieces';
    el.append(this.squareLayer, this.pieceLayer);
    this.buildSquares();

    el.addEventListener('pointerdown', (e) => this.pointerDown(e));
    el.addEventListener('pointermove', (e) => this.pointerMove(e));
    el.addEventListener('pointerup', (e) => this.pointerUp(e));
    el.addEventListener('pointercancel', () => this.cancelDrag());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---- geometry ----

  colRow(square) {
    const f = FILES.indexOf(square[0]);
    const r = Number(square[1]);
    return this.orientation === 'white' ? [f, 8 - r] : [7 - f, r - 1];
  }

  squareAt(col, row) {
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.orientation === 'white'
      ? FILES[col] + (8 - row)
      : FILES[7 - col] + (row + 1);
  }

  squareFromPoint(x, y) {
    const rect = this.el.getBoundingClientRect();
    const col = Math.floor(((x - rect.left) / rect.width) * 8);
    const row = Math.floor(((y - rect.top) / rect.height) * 8);
    return this.squareAt(col, row);
  }

  place(img, square) {
    const [c, r] = this.colRow(square);
    img.style.transform = `translate(${c * 100}%, ${r * 100}%)`;
  }

  // ---- rendering ----

  buildSquares() {
    this.squareLayer.textContent = '';
    this.squares.clear();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = this.squareAt(col, row);
        const div = document.createElement('div');
        const light = (FILES.indexOf(sq[0]) + Number(sq[1])) % 2 === 1;
        div.className = `sq ${light ? 'light' : 'dark'}`;
        div.dataset.square = sq;
        if (col === 0) div.insertAdjacentHTML('beforeend', `<span class="coord rank">${sq[1]}</span>`);
        if (row === 7) div.insertAdjacentHTML('beforeend', `<span class="coord file">${sq[0]}</span>`);
        this.squareLayer.append(div);
        this.squares.set(sq, div);
      }
    }
  }

  setOrientation(orientation) {
    if (orientation === this.orientation) return;
    this.orientation = orientation;
    this.buildSquares();
  }

  // `board` is chess.js game.board(): rows from rank 8 down, cells {square,type,color}|null.
  setPosition(board) {
    this.pieceLayer.textContent = '';
    this.pieces.clear();
    for (const rank of board) {
      for (const cell of rank) {
        if (!cell) continue;
        const img = document.createElement('img');
        img.className = 'piece';
        img.src = `img/pieces/${cell.color}${cell.type.toUpperCase()}.svg`;
        img.alt = '';
        img.draggable = false;
        this.place(img, cell.square);
        this.pieceLayer.append(img);
        this.pieces.set(cell.square, img);
      }
    }
  }

  animateMove(from, to) {
    const img = this.pieces.get(from);
    if (!img) return Promise.resolve();
    const captured = this.pieces.get(to);
    if (captured) captured.classList.add('captured');
    img.classList.add('moving');
    this.place(img, to);
    return new Promise((resolve) => setTimeout(resolve, ANIM_MS));
  }

  setMarks(partial) {
    Object.assign(this.marks, partial);
    this.renderMarks();
  }

  clearMarks() {
    this.marks = { last: [], check: null, hint: [], wrong: null };
    this.selected = null;
    this.renderMarks();
  }

  renderMarks() {
    for (const div of this.squares.values()) {
      div.classList.remove('last', 'selected', 'dest', 'dest-capture', 'check', 'hint', 'wrong');
    }
    const add = (sq, cls) => sq && this.squares.get(sq)?.classList.add(cls);
    this.marks.last.forEach((sq) => add(sq, 'last'));
    this.marks.hint.forEach((sq) => add(sq, 'hint'));
    add(this.marks.check, 'check');
    add(this.marks.wrong, 'wrong');
    if (this.selected) {
      add(this.selected, 'selected');
      for (const to of this.dests.get(this.selected) ?? []) {
        add(to, this.pieces.has(to) ? 'dest-capture' : 'dest');
      }
    }
  }

  // color: 'w' | 'b' | null (no input). dests: Map(from -> Set(to)).
  setMovable(color, dests = new Map()) {
    this.movableColor = color;
    this.dests = dests;
    this.el.classList.toggle('interactive', !!color);
    if (!color) {
      this.selected = null;
      this.cancelDrag();
    }
    this.renderMarks();
  }

  // ---- input ----

  select(sq) {
    this.selected = sq;
    this.renderMarks();
  }

  canMoveFrom(sq) {
    return this.movableColor && this.dests.has(sq);
  }

  tryMove(from, to) {
    if (!this.dests.get(from)?.has(to)) return false;
    this.selected = null;
    this.renderMarks();
    this.onMove(from, to);
    return true;
  }

  pointerDown(e) {
    if (!this.movableColor || (e.button !== undefined && e.button !== 0)) return;
    const sq = this.squareFromPoint(e.clientX, e.clientY);
    if (!sq) return;
    e.preventDefault();

    if (this.selected && this.selected !== sq && this.tryMove(this.selected, sq)) return;

    if (this.canMoveFrom(sq)) {
      const wasSelected = this.selected === sq;
      this.select(sq);
      this.drag = { from: sq, x: e.clientX, y: e.clientY, active: false, wasSelected, id: e.pointerId };
      this.el.setPointerCapture(e.pointerId);
    } else {
      this.select(null);
    }
  }

  pointerMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    const img = this.pieces.get(d.from);
    if (!img) return;
    d.active = true;
    const rect = this.el.getBoundingClientRect();
    const size = rect.width / 8;
    img.classList.add('dragging');
    img.style.transform = `translate(${e.clientX - rect.left - size / 2}px, ${e.clientY - rect.top - size / 2}px) scale(1.15)`;
    const over = this.squareFromPoint(e.clientX, e.clientY);
    for (const div of this.squares.values()) div.classList.toggle('drag-over', div.dataset.square === over);
  }

  pointerUp(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    const img = this.pieces.get(d.from);
    for (const div of this.squares.values()) div.classList.remove('drag-over');

    if (d.active) {
      const to = this.squareFromPoint(e.clientX, e.clientY);
      img?.classList.remove('dragging');
      if (to && to !== d.from && this.dests.get(d.from)?.has(to)) {
        // Drop in place without the slide animation.
        img.classList.add('no-anim');
        this.place(img, to);
        this.tryMove(d.from, to);
      } else if (img) {
        this.place(img, d.from);
      }
    } else if (d.wasSelected) {
      this.select(null); // tapping the selected piece again deselects it
    }
  }

  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const img = this.pieces.get(d.from);
    if (img) {
      img.classList.remove('dragging');
      this.place(img, d.from);
    }
  }
}
