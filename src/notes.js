export const PITCH_CLASSES = [
  { pc: 0, name: "C", color: "#e35d5b" },
  { pc: 1, name: "C♯", color: "#e57a4a" },
  { pc: 2, name: "D", color: "#f0a05a" },
  { pc: 3, name: "D♯", color: "#e8c15a" },
  { pc: 4, name: "E", color: "#e8d16a" },
  { pc: 5, name: "F", color: "#6fcf97" },
  { pc: 6, name: "F♯", color: "#5bc4b0" },
  { pc: 7, name: "G", color: "#5bb8e8" },
  { pc: 8, name: "G♯", color: "#6a8eef" },
  { pc: 9, name: "A", color: "#7a7cf0" },
  { pc: 10, name: "A♯", color: "#a56de3" },
  { pc: 11, name: "B", color: "#c86dd7" },
];

export const PRESETS = {
  ceg: [0, 4, 7],
  cmajor: [0, 4, 5, 7, 9],
  white: [0, 2, 4, 5, 7, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export function midiToHz(midi, a4 = 440) {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function hzToMidi(hz, a4 = 440) {
  return 69 + 12 * Math.log2(hz / a4);
}

export function noteFromMidi(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return { midi, pc, octave, ...PITCH_CLASSES[pc] };
}

export function midiPool(pcs, loOct, hiOct) {
  const out = [];
  for (let oct = loOct; oct <= hiOct; oct += 1) {
    for (const pc of pcs) {
      out.push((oct + 1) * 12 + pc);
    }
  }
  return out;
}

export function centsOff(hz, midi, a4) {
  const target = midiToHz(midi, a4);
  return 1200 * Math.log2(hz / target);
}

// Cents from the nearest octave of the target pitch class (range -600..600),
// so any voice register can match the chroma.
export function chromaCentsOff(hz, midi, a4) {
  const c = centsOff(hz, midi, a4);
  return c - 1200 * Math.round(c / 1200);
}
