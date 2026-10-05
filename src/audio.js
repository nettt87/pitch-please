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

// Fades the last stretch of a note so long-ringing timbres stop with `duration`.
function releaseBus(audio, start, duration, level) {
  const bus = audio.createGain();
  const rel = Math.min(0.25, duration * 0.3);
  bus.gain.setValueAtTime(level, start);
  bus.gain.setValueAtTime(level, start + duration - rel);
  bus.gain.linearRampToValueAtTime(0, start + duration);
  bus.connect(audio.destination);
  return bus;
}

let noise;

function noiseBuffer(audio) {
  if (!noise || noise.sampleRate !== audio.sampleRate) {
    noise = audio.createBuffer(1, Math.round(audio.sampleRate * 0.06), audio.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noise;
}

// Struck string: slightly stretched partials, each decaying faster the higher it
// is, two detuned strings for the low partials, a soft hammer thump, and a tone
// that darkens as it rings. Low notes sustain longer than high ones.
function playAcoustic(audio, hz, start, duration) {
  const bus = releaseBus(audio, start, duration, 1);
  const tone = audio.createBiquadFilter();
  tone.type = "lowpass";
  tone.Q.value = 0.4;
  tone.frequency.setValueAtTime(Math.min(16000, hz * 16 + 2500), start);
  tone.frequency.setTargetAtTime(Math.min(9000, hz * 5 + 700), start + 0.03, 0.45);
  tone.connect(bus);

  const B = 0.0004;
  const tau1 = Math.max(0.35, Math.min(3, 1.8 * (261.6 / hz) ** 0.4));
  const partials = [];
  for (let n = 1; n <= 24 && n * hz < 12000; n += 1) {
    // The hammer strikes about 1/8 along the string, which mutes partials near 8.
    const amp = (1 / n ** 1.1) * (0.35 + 0.65 * Math.abs(Math.sin((n * Math.PI) / 8.3)));
    partials.push([n, amp]);
  }
  const total = partials.reduce((sum, [, amp]) => sum + amp, 0);

  for (const [n, amp] of partials) {
    const freq = n * hz * Math.sqrt((1 + B * n * n) / (1 + B));
    const g = audio.createGain();
    const peak = (amp / total) * 0.32;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.004);
    g.gain.setTargetAtTime(0, start + 0.004, tau1 / (1 + 0.35 * (n - 1)));
    g.connect(tone);
    const strings = n <= 8 ? [-0.8, 0.8] : [0];
    for (const cents of strings) {
      const osc = audio.createOscillator();
      osc.frequency.setValueAtTime(freq, start);
      osc.detune.setValueAtTime(cents, start);
      const share = audio.createGain();
      share.gain.value = 1 / strings.length;
      osc.connect(share);
      share.connect(g);
      osc.start(start);
      osc.stop(start + duration + 0.05);
    }
  }

  const thump = audio.createBufferSource();
  thump.buffer = noiseBuffer(audio);
  const band = audio.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = Math.min(3000, hz * 2);
  band.Q.value = 0.8;
  const tg = audio.createGain();
  tg.gain.setValueAtTime(0.05, start);
  tg.gain.exponentialRampToValueAtTime(0.0001, start + 0.04);
  thump.connect(band);
  band.connect(tg);
  tg.connect(bus);
  thump.start(start);
}

// Plucked string (Karplus-Strong). The loop is N samples of delay plus a two-tap
// damping filter weighted s, so its period is N + s samples; the buffer is rendered
// at exactly (N + s) * hz samples per second, which keeps every note in tune to the
// cent, and the browser resamples it on playback. High notes get a lighter filter,
// since the classic 50/50 average would silence them within half a second.
function playGuitar(audio, hz, start, duration) {
  const s = Math.max(0.03, Math.min(0.5, 100 / hz));
  const N = Math.max(2, Math.round(audio.sampleRate / hz - s));
  const rate = (N + s) * hz;
  const len = Math.ceil(rate * (duration + 0.05));
  const buf = audio.createBuffer(1, len, rate);
  const y = buf.getChannelData(0);

  // Pluck: a noise burst softened above ~3.5 kHz, thinned where a pick about 1/5
  // along the string can't excite it.
  const raw = new Float32Array(N);
  const smooth = Math.exp((-2 * Math.PI * 3500) / rate);
  let prev = 0;
  for (let i = 0; i < N; i += 1) {
    prev = prev * smooth + (Math.random() * 2 - 1) * (1 - smooth);
    raw[i] = prev;
  }
  const pick = Math.max(1, Math.round(N * 0.2));
  const burst = new Float32Array(N);
  let mean = 0;
  for (let i = 0; i < N; i += 1) {
    burst[i] = raw[i] - (i >= pick ? raw[i - pick] * 0.9 : 0);
    mean += burst[i] / N;
  }

  // Loss per trip round the string, for a ring of about 6 s low and 3.5 s high.
  const t60 = Math.max(3.5, Math.min(7, 6 * (110 / hz) ** 0.35));
  const g = 0.001 ** (1 / (hz * t60));
  let peak = 0;
  for (let i = 0; i < len; i += 1) {
    const excite = i < N ? burst[i] - mean : 0;
    const a = i >= N ? y[i - N] : 0;
    const b = i >= N + 1 ? y[i - N - 1] : 0;
    y[i] = excite + g * ((1 - s) * a + s * b);
    peak = Math.max(peak, Math.abs(y[i]));
  }

  const src = audio.createBufferSource();
  src.buffer = buf;
  const body = audio.createBiquadFilter();
  body.type = "peaking";
  body.frequency.value = 180;
  body.Q.value = 1.1;
  body.gain.value = 4;
  const bus = releaseBus(audio, start, duration, 0.3 / (peak || 1));
  src.connect(body);
  body.connect(bus);
  src.start(start);
}

export function playHz(hz, { duration = 1.15, timbre = "piano", when } = {}) {
  const audio = getContext();
  const start = when ?? audio.currentTime;
  if (timbre === "acoustic") return playAcoustic(audio, hz, start, duration);
  if (timbre === "guitar") return playGuitar(audio, hz, start, duration);
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
