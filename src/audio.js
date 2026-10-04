const TIMBRES = {
  piano: [
    [1, 1],
    [2, 0.48],
    [3, 0.22],
    [4, 0.14],
    [5, 0.09],
    [6, 0.05],
    [7, 0.03],
  ],
  sine: [[1, 1]],
  organ: [
    [1, 0.7],
    [2, 0.9],
    [3, 0.25],
    [4, 0.55],
    [6, 0.2],
    [8, 0.12],
  ],
  reed: [
    [1, 0.5],
    [2, 0.7],
    [3, 0.85],
    [4, 0.4],
    [5, 0.55],
    [6, 0.25],
    [7, 0.3],
  ],
};

let ctx;

export function getContext() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function playHz(hz, { duration = 1.15, timbre = "piano", when } = {}) {
  const audio = getContext();
  const start = when ?? audio.currentTime;
  const master = audio.createGain();
  master.gain.setValueAtTime(0.0001, start);
  master.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
  master.gain.exponentialRampToValueAtTime(0.08, start + 0.28);
  master.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  master.connect(audio.destination);

  const partials = TIMBRES[timbre] ?? TIMBRES.piano;
  // Normalize so every timbre peaks at the same level and never clips.
  const total = partials.reduce((sum, [, amp]) => sum + amp, 0);
  for (const [ratio, amp] of partials) {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = timbre === "reed" && ratio === 1 ? "sawtooth" : "sine";
    osc.frequency.setValueAtTime(hz * ratio, start);
    g.gain.value = (amp / total) * 1.6;
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }
}
