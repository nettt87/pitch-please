import { PITCH_CLASSES, noteFromMidi } from "./notes.js?v=10";

// Answer pads for Identify. Every answer button carries data-pc (pitch class it
// answers) and data-pos (a stable id, so a wrong pick can be re-marked after a rebuild).
// When the session spans several octaves (`range` = { lo, hi } in octave numbers),
// the pads show real pitches and also carry data-midi, so the octave counts.

const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
// Black key pitch class -> index of the white-key boundary it sits on.
const BLACK_KEYS = [
  [1, 1],
  [3, 2],
  [6, 4],
  [8, 5],
  [10, 6],
];

export function rangeMidi(range) {
  return { lo: (range.lo + 1) * 12, hi: (range.hi + 1) * 12 + 11 };
}

function answerButton(className, note, pos, enabledPcs, onPick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.dataset.pc = String(note.pc);
  btn.dataset.pos = pos;
  btn.style.setProperty("--c", note.color);
  btn.disabled = Boolean(enabledPcs) && !enabledPcs.includes(note.pc);
  btn.addEventListener("click", () => onPick(note.pc, btn));
  return btn;
}

export function buildAnswerPiano(el, enabledPcs, onPick, range = null) {
  el.innerHTML = "";
  const octaves = range ? range.hi - range.lo + 1 : 1;
  const whiteW = 100 / (7 * octaves);
  const blackW = whiteW * 0.62;
  const keys = document.createElement("div");
  keys.className = "piano-keys";
  keys.style.minWidth = range ? `${7 * octaves * 34}px` : "";
  el.classList.toggle("is-multi", Boolean(range));

  for (let o = 0; o < octaves; o += 1) {
    const base = range ? (range.lo + o + 1) * 12 : null;
    const offset = o * 7 * whiteW;
    const tag = (pc) => (range ? noteFromMidi(base + pc) : PITCH_CLASSES[pc]);

    WHITE_PCS.forEach((pc, i) => {
      const note = tag(pc);
      const label = range ? `${note.name}${note.octave}` : note.name;
      const key = answerButton("pkey white", note, range ? `p${note.midi}` : `p${pc}`, enabledPcs, onPick);
      if (range) key.dataset.midi = String(note.midi);
      key.style.left = `${offset + i * whiteW}%`;
      key.style.width = `${whiteW}%`;
      key.setAttribute("aria-label", label);
      const shown = range && pc !== 0 ? note.name : label;
      key.innerHTML = `<span class="pkey-dot"></span><span class="pkey-name">${shown}</span>`;
      keys.appendChild(key);
    });

    for (const [pc, boundary] of BLACK_KEYS) {
      const note = tag(pc);
      const label = range ? `${note.name}${note.octave}` : note.name;
      const key = answerButton("pkey black", note, range ? `p${note.midi}` : `p${pc}`, enabledPcs, onPick);
      if (range) key.dataset.midi = String(note.midi);
      key.style.left = `${offset + boundary * whiteW - blackW / 2}%`;
      key.style.width = `${blackW}%`;
      key.setAttribute("aria-label", label);
      key.innerHTML = `<span class="pkey-name">${note.name}</span><span class="pkey-dot"></span>`;
      keys.appendChild(key);
    }
  }
  el.appendChild(keys);
}

// Circle of pitch classes. With a range, one ring per octave: low octave inside,
// high octave outside, chroma names around the rim.
export function buildWheel(el, enabledPcs, onPick, range = null) {
  el.innerHTML = "";
  el.classList.toggle("is-multi", Boolean(range));
  const size = el.clientWidth || 420;
  const angle = (pc) => (pc / 12) * Math.PI * 2 - Math.PI / 2;
  const place = (node, r, pc) => {
    node.style.left = `${size / 2 + r * Math.cos(angle(pc))}px`;
    node.style.top = `${size / 2 + r * Math.sin(angle(pc))}px`;
  };

  if (!range) {
    const r = size / 2 - 46;
    PITCH_CLASSES.forEach((note) => {
      const btn = answerButton("chroma", note, `w${note.pc}`, enabledPcs, onPick);
      btn.textContent = note.name;
      btn.style.background = note.color;
      place(btn, r, note.pc);
      el.appendChild(btn);
    });
    return;
  }

  const rings = range.hi - range.lo + 1;
  // Largest button that still leaves the inner ring room for 12 buttons.
  let s = 46;
  let outer = 0;
  let step = 0;
  for (; s > 16; s -= 1) {
    outer = size / 2 - 26 - s / 2;
    step = s * 1.14;
    if (outer - (rings - 1) * step >= s * 2.2) break;
  }

  PITCH_CLASSES.forEach((pc) => {
    const label = document.createElement("span");
    label.className = "chroma-rim";
    label.textContent = pc.name;
    label.style.color = pc.color;
    label.setAttribute("aria-hidden", "true");
    place(label, size / 2 - 12, pc.pc);
    el.appendChild(label);
  });

  for (let i = 0; i < rings; i += 1) {
    const octave = range.lo + i;
    const r = outer - (rings - 1 - i) * step;
    for (let pc = 0; pc < 12; pc += 1) {
      const note = noteFromMidi((octave + 1) * 12 + pc);
      const btn = answerButton("chroma ring", note, `w${note.midi}`, enabledPcs, onPick);
      btn.dataset.midi = String(note.midi);
      btn.textContent = String(octave);
      btn.setAttribute("aria-label", `${note.name}${octave}`);
      btn.title = `${note.name}${octave}`;
      btn.style.background = note.color;
      btn.style.width = btn.style.height = `${s}px`;
      btn.style.margin = `${-s / 2}px 0 0 ${-s / 2}px`;
      btn.style.fontSize = `${Math.max(10, Math.round(s * 0.36))}px`;
      place(btn, r, pc);
      el.appendChild(btn);
    }
  }
}

// Standard tuning, drawn the way a player looks down at the neck: high E on top.
const STRINGS = [64, 59, 55, 50, 45, 40];
const MARKERS = { 3: 1, 5: 1, 7: 1, 9: 1, 12: 2, 15: 1, 17: 1, 19: 1, 21: 1, 24: 2 };
export const GUITAR_LOW = STRINGS[STRINGS.length - 1];

// Enough frets to reach the top of the range, 12 to 24.
export function guitarFrets(range) {
  if (!range) return 12;
  return Math.max(12, Math.min(24, rangeMidi(range).hi - STRINGS[0]));
}

export function buildFretboard(el, enabledPcs, onPick, range = null) {
  el.innerHTML = "";
  const frets = guitarFrets(range);
  const span = range ? rangeMidi(range) : null;
  const board = document.createElement("div");
  board.className = `fretboard${range ? " is-multi" : ""}`;
  board.style.gridTemplateColumns = `46px repeat(${frets}, minmax(42px, 1fr))`;
  board.style.minWidth = `${46 + frets * 46}px`;

  STRINGS.forEach((openMidi, s) => {
    for (let fret = 0; fret <= frets; fret += 1) {
      const midi = openMidi + fret;
      const note = noteFromMidi(midi);
      const cell = answerButton(
        `fret${fret === 0 ? " open" : ""}`,
        note,
        `g${s}-${fret}`,
        enabledPcs,
        onPick,
      );
      if (span && (midi < span.lo || midi > span.hi)) cell.disabled = true;
      cell.dataset.midi = String(midi);
      cell.style.setProperty("--gauge", `${1 + s * 0.45}px`);
      cell.setAttribute("aria-label", `${note.name}${range ? note.octave : ""}, string ${s + 1}, fret ${fret}`);
      cell.innerHTML = range
        ? `<span class="fret-dot">${note.name}<sub>${note.octave}</sub></span>`
        : `<span class="fret-dot">${note.name}</span>`;
      board.appendChild(cell);
    }
  });

  for (let fret = 0; fret <= frets; fret += 1) {
    const mark = document.createElement("div");
    mark.className = "fret-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = fret ? `<span>${"●".repeat(MARKERS[fret] ?? 0)}</span><small>${fret}</small>` : "";
    board.appendChild(mark);
  }

  el.appendChild(board);
}
