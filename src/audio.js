const TIMBRES = {
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

// The piano is a recorded grand (Salamander Grand Piano, a Yamaha C5), sampled
// every minor third from A1 to C7. Each note plays the nearest recording, shifted
// at most a semitone and a half, so it keeps that note's own hammer and strings.
const SAMPLE_NAMES = ["C", "Ds", "Fs", "A"];
const SAMPLE_PCS = [0, 3, 6, 9];
// How far each recording sits from equal temperament, in cents (MIDI note -> cents),
// measured from its fundamental. A piano is tuned stretched, flat in the bass and almost
// a quarter tone sharp at the top; a pitch trainer has to sound exact pitches,
// so playback takes this back out.
const SAMPLE_CENTS = {
  33: -5, 36: -8.5, 39: -9.5, 42: -5.5, 45: -5.5, 48: -7.5, 51: -2, 54: -7, 57: 0.5, 60: -4, 63: 0,
  66: -2.5, 69: 0.5, 72: 3.5, 75: 5.5, 78: 4.5, 81: 6.5, 84: 8.5, 87: 7, 90: 14.5, 93: 11, 96: 23,
};
// Average level of a strike's first 0.3 s that every recording is matched to, and
// the most any one may be raised to get there.
const TARGET_RMS = 10 ** (-21 / 20);
const MAX_PEAK = 0.6;
const piano = new Map();
let pianoLoad;

function sampleMidis() {
  const out = [];
  for (let midi = 33; midi <= 96; midi += 3) out.push(midi);
  return out;
}

function sampleUrl(midi) {
  const name = SAMPLE_NAMES[SAMPLE_PCS.indexOf(midi % 12)];
  return new URL(`../samples/piano/${name}${Math.floor(midi / 12) - 1}.mp3`, import.meta.url);
}

// Fetch and decode the recordings in the background. Until a note's recording is
// ready, the synthesized piano below plays it instead.
export function loadPiano() {
  if (pianoLoad) return pianoLoad;
  // Decoding needs no running audio, so a silent offline context does it before
  // the first tap has unlocked sound.
  const decoder = new OfflineAudioContext(1, 1, 48000);
  pianoLoad = Promise.all(
    sampleMidis().map(async (midi) => {
      try {
        const res = await fetch(sampleUrl(midi));
        if (!res.ok) return;
        const buffer = await decoder.decodeAudioData(await res.arrayBuffer());
        const { peak, rms } = attackLevel(buffer);
        const gain = Math.min(TARGET_RMS / rms, MAX_PEAK / peak);
        piano.set(midi, { buffer, gain, lead: leadIn(buffer, peak) });
      } catch {
        // A missing or undecodable file leaves that note to the synthesized piano.
      }
    }),
  );
  return pianoLoad;
}

// Peak and average level of the strike. Matching the average keeps high notes,
// which fade fastest, as loud to the ear as low ones.
function attackLevel(buffer) {
  let peak = 0;
  let sum = 0;
  const end = Math.min(buffer.length, Math.round(buffer.sampleRate * 0.3));
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < end; i += 1) {
      peak = Math.max(peak, Math.abs(data[i]));
      sum += data[i] * data[i];
    }
  }
  return { peak: peak || 1, rms: Math.sqrt(sum / (end * buffer.numberOfChannels)) || 1 };
}

// The MP3s open with a few milliseconds of silence; skip to just before the hammer lands.
function leadIn(buffer, peak) {
  const data = buffer.getChannelData(0);
  const floor = peak * 0.01;
  let i = 0;
  while (i < data.length && Math.abs(data[i]) < floor) i += 1;
  return Math.max(0, i / buffer.sampleRate - 0.002);
}

function nearestSample(midi) {
  let best = null;
  for (const [m, sample] of piano) {
    if (!best || Math.abs(m - midi) < Math.abs(best.midi - midi)) best = { midi: m, ...sample };
  }
  return best && Math.abs(best.midi - midi) <= 1.5 ? best : null;
}

function playPiano(audio, hz, start, duration) {
  // Sample pitches are concert pitch (A4 = 440 Hz); the playback rate carries any other A4.
  const midi = 69 + 12 * Math.log2(hz / 440);
  const sample = nearestSample(midi);
  if (!sample) return playAcoustic(audio, hz, start, duration);

  const src = audio.createBufferSource();
  src.buffer = sample.buffer;
  const recorded = 440 * 2 ** ((sample.midi - 69 + (SAMPLE_CENTS[sample.midi] ?? 0) / 100) / 12);
  src.playbackRate.value = hz / recorded;
  // The key comes up at `duration` and the damper stops the strings within a tenth of a second.
  const damper = audio.createGain();
  damper.gain.setValueAtTime(sample.gain, start);
  damper.gain.setTargetAtTime(0, start + duration, 0.05);
  src.connect(damper);
  damper.connect(audio.destination);
  src.start(start, sample.lead);
  src.stop(start + duration + 0.4);
}

// Synthesized piano, heard only while a note's recording is still loading.
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

  // Two-stage decay, as in a real piano: a quick drop right after the strike
  // (the "prompt sound"), then a long, slow ring (the "aftersound").
  const prompt = Math.max(0.06, Math.min(0.2, 0.16 * (261.6 / hz) ** 0.3));
  for (const [n, amp] of partials) {
    const freq = n * hz * Math.sqrt((1 + B * n * n) / (1 + B));
    const g = audio.createGain();
    const peak = (amp / total) * 0.32;
    const knee = start + 0.004 + prompt * 2;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.004);
    g.gain.setTargetAtTime(peak * (0.32 / (1 + 0.15 * (n - 1))), start + 0.004, prompt / (1 + 0.1 * (n - 1)));
    g.gain.setTargetAtTime(0, knee, tau1 / (1 + 0.35 * (n - 1)));
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
  if (timbre === "guitar") return playGuitar(audio, hz, start, duration);
  // Everything else is the piano, including "acoustic", a name earlier versions saved.
  if (!(timbre in TIMBRES)) return playPiano(audio, hz, start, duration);
  const master = audio.createGain();
  if (timbre === "organ") {
    // Pipes speak and hold at full level for as long as the key is down.
    master.gain.setValueAtTime(0, start);
    master.gain.linearRampToValueAtTime(0.13, start + 0.025);
    master.gain.setValueAtTime(0.13, start + duration - 0.09);
    master.gain.linearRampToValueAtTime(0, start + duration);
  } else {
    master.gain.setValueAtTime(0.0001, start);
    master.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    master.gain.exponentialRampToValueAtTime(0.08, start + 0.28);
    master.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  }
  master.connect(audio.destination);

  const partials = TIMBRES[timbre];
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
