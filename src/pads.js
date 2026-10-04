import { PITCH_CLASSES, noteFromMidi } from "./notes.js";

// Answer pads for Identify. Every answer button carries data-pc (pitch class it
// answers) and data-pos (a stable id, so a wrong pick can be re-marked after a rebuild).

const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
// Black key pitch class -> index of the white-key boundary it sits on.
const BLACK_KEYS = [
  [1, 1],
  [3, 2],
  [6, 4],
  [8, 5],
  [10, 6],
];

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

export function buildAnswerPiano(el, enabledPcs, onPick) {
  el.innerHTML = "";
  const whiteW = 100 / 7;
  const blackW = whiteW * 0.62;

  WHITE_PCS.forEach((pc, i) => {
    const note = PITCH_CLASSES[pc];
    const key = answerButton("pkey white", note, `p${pc}`, enabledPcs, onPick);
    key.style.left = `${i * whiteW}%`;
    key.style.width = `${whiteW}%`;
    key.setAttribute("aria-label", note.name);
    key.innerHTML = `<span class="pkey-dot"></span><span class="pkey-name">${note.name}</span>`;
    el.appendChild(key);
  });

  for (const [pc, boundary] of BLACK_KEYS) {
    const note = PITCH_CLASSES[pc];
    const key = answerButton("pkey black", note, `p${pc}`, enabledPcs, onPick);
    key.style.left = `${boundary * whiteW - blackW / 2}%`;
    key.style.width = `${blackW}%`;
    key.setAttribute("aria-label", note.name);
    key.innerHTML = `<span class="pkey-name">${note.name}</span><span class="pkey-dot"></span>`;
    el.appendChild(key);
  }
}

// Standard tuning, drawn the way a player looks down at the neck: high E on top.
const STRINGS = [64, 59, 55, 50, 45, 40];
const FRETS = 12;
const MARKERS = { 3: 1, 5: 1, 7: 1, 9: 1, 12: 2 };

export function buildFretboard(el, enabledPcs, onPick) {
  el.innerHTML = "";
  const board = document.createElement("div");
  board.className = "fretboard";

  STRINGS.forEach((openMidi, s) => {
    for (let fret = 0; fret <= FRETS; fret += 1) {
      const note = noteFromMidi(openMidi + fret);
      const cell = answerButton(
        `fret${fret === 0 ? " open" : ""}`,
        note,
        `g${s}-${fret}`,
        enabledPcs,
        onPick,
      );
      cell.dataset.midi = String(openMidi + fret);
      cell.style.setProperty("--gauge", `${1 + s * 0.45}px`);
      cell.setAttribute("aria-label", `${note.name}, string ${s + 1}, fret ${fret}`);
      cell.innerHTML = `<span class="fret-dot">${note.name}</span>`;
      board.appendChild(cell);
    }
  });

  for (let fret = 0; fret <= FRETS; fret += 1) {
    const mark = document.createElement("div");
    mark.className = "fret-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = fret ? `<span>${"●".repeat(MARKERS[fret] ?? 0)}</span><small>${fret}</small>` : "";
    board.appendChild(mark);
  }

  el.appendChild(board);
}
