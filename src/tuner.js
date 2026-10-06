import { getContext } from "./audio.js?v=16";
import { hzToMidi, midiToHz, noteFromMidi } from "./notes.js?v=16";

// Chromatic tuner. Each frame analyses the last 8192 samples (about 170 ms), long
// enough for several cycles of a bass's low E. The pitch detector is the McLeod
// method computed with FFTs, then refined by measuring many cycles at once: the
// k-th repeat of the waveform sits k periods along, so fitting a line through
// those repeats pins the period down k times more finely than one cycle can.

const WINDOW = 8192;
const SIZE = WINDOW * 2;
// Below this a frame is silence; below CLARITY it is noise or a chord, not one note.
const MIN_RMS = 0.003;
const CLARITY = 0.8;
// Within this many cents the meter shows "In tune".
const IN_TUNE = 2;
// Readings combined into the displayed one (a running median, then a light glide).
const HISTORY = 5;

function makeFft(n) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    let r = 0;
    for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  // In-place forward transform.
  return (re, im) => {
    for (let i = 0; i < n; i += 1) {
      const j = rev[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0, k = 0; j < half; j += 1, k += step) {
          const a = start + j;
          const b = a + half;
          const tre = re[b] * cos[k] + im[b] * sin[k];
          const tim = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
  };
}

const fft = makeFft(SIZE);
const re = new Float64Array(SIZE);
const im = new Float64Array(SIZE);
const x = new Float64Array(WINDOW);
const nsdf = new Float64Array(WINDOW / 2 + 2);

function parabolic(tau) {
  const a = nsdf[tau - 1];
  const b = nsdf[tau];
  const c = nsdf[tau + 1];
  const d = a - 2 * b + c;
  return d === 0 ? tau : tau + (a - c) / (2 * d);
}

// The pitch of one frame, or null for silence, noise or more than one note.
// Returns { hz, clarity, rms }; `rms` is also set on a null-pitch result's input check.
export function detectTunerPitch(input, sampleRate, { minHz = 25, maxHz = 4500 } = {}) {
  const n = Math.min(WINDOW, input.length);
  const offset = input.length - n;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += input[offset + i];
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i += 1) {
    x[i] = input[offset + i] - mean;
    energy += x[i] * x[i];
  }
  const rms = Math.sqrt(energy / n);
  if (rms < MIN_RMS) return { hz: null, clarity: 0, rms };

  // Autocorrelation by FFT: the transform of the power spectrum.
  re.fill(0);
  im.fill(0);
  re.set(x.subarray(0, n));
  fft(re, im);
  for (let i = 0; i < SIZE; i += 1) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft(re, im);

  // Normalized square difference; the running sum m drops the two end samples
  // that leave the overlap at each lag.
  const maxTau = Math.min(Math.floor(n / 2), Math.floor(sampleRate / minHz));
  let m = 2 * energy;
  nsdf[0] = 1;
  for (let tau = 1; tau <= maxTau + 1; tau += 1) {
    m -= x[tau - 1] * x[tau - 1] + x[n - tau] * x[n - tau];
    nsdf[tau] = m > 0 ? (2 * re[tau]) / SIZE / m : 0;
  }

  // Highest point of each positive lobe after the first zero crossing; take the
  // first that reaches 0.9 of the best, which avoids landing an octave low.
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  let tau = 1;
  while (tau < maxTau && nsdf[tau] > 0) tau += 1;
  const peaks = [];
  let best = 0;
  while (tau < maxTau) {
    while (tau < maxTau && nsdf[tau] <= 0) tau += 1;
    let peak = -1;
    while (tau < maxTau && nsdf[tau] > 0) {
      if (peak < 0 || nsdf[tau] > nsdf[peak]) peak = tau;
      tau += 1;
    }
    if (peak > 0 && peak >= minTau) {
      peaks.push(peak);
      best = Math.max(best, nsdf[peak]);
    }
  }
  const first = peaks.find((p) => nsdf[p] >= best * 0.9);
  if (!first || nsdf[first] < CLARITY) return { hz: null, clarity: nsdf[first] ?? 0, rms };

  // Fit the period through the k-th repeats: tau_k ≈ k * T, least squares through 0.
  const t1 = parabolic(first);
  let num = t1;
  let den = 1;
  for (let k = 2; k * t1 + 3 < maxTau; k += 1) {
    const guess = Math.round(k * t1);
    let p = guess;
    for (let d = -2; d <= 2; d += 1) if (nsdf[guess + d] > nsdf[p]) p = guess + d;
    if (nsdf[p] < nsdf[first] * 0.75 || p <= 1) break;
    num += k * parabolic(p);
    den += k * k;
  }
  const periodic = sampleRate / (num / den);
  return { hz: fundamental(input, sampleRate, periodic), clarity: nsdf[first], rms };
}

// Low notes have their peaks only a few spectrum bins apart in 170 ms, so a strong
// second harmonic leaks into a weak fundamental. Below LONG_BELOW Hz the spectral
// step looks at the last 0.68 s instead, which spreads them four times further.
const LONG = 32768;
const LONG_BELOW = 120;
const spec = new Float64Array(LONG);
const hanns = new Map();

function hannOf(n) {
  if (!hanns.has(n)) hanns.set(n, new Float64Array(n).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
  return hanns.get(n);
}

// Spectrum magnitude of the windowed frame in `spec` at one frequency.
function magnitude(n, sampleRate, hz) {
  const w = (2 * Math.PI * hz) / sampleRate;
  const c = Math.cos(w);
  const s = Math.sin(w);
  let cr = 1;
  let ci = 0;
  let sr = 0;
  let si = 0;
  for (let i = 0; i < n; i += 1) {
    sr += spec[i] * cr;
    si -= spec[i] * ci;
    const t = cr * c - ci * s;
    ci = cr * s + ci * c;
    cr = t;
  }
  return Math.hypot(sr, si);
}

// A struck or plucked string's overtones run slightly sharp, which drags the
// waveform's repeat rate above the fundamental (a few cents on a piano, more in
// the bass). Tuners read the fundamental itself, so find the exact top of its
// spectral peak near the repeat rate. If the fundamental is too weak to trust
// (a small speaker, say), the repeat rate stands.
function fundamental(input, sampleRate, hz) {
  const n = hz < LONG_BELOW && input.length >= LONG ? LONG : Math.min(WINDOW, input.length);
  const offset = input.length - n;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += input[offset + i];
  mean /= n;
  const win = hannOf(n);
  for (let i = 0; i < n; i += 1) spec[i] = (input[offset + i] - mean) * win[i];

  const bin = sampleRate / n;
  const span = Math.min(hz * (2 ** (25 / 1200) - 1), 1.5 * bin);
  let lo = hz - span;
  let hi = hz + span;
  const golden = (Math.sqrt(5) - 1) / 2;
  let a = hi - golden * (hi - lo);
  let b = lo + golden * (hi - lo);
  let fa = magnitude(n, sampleRate, a);
  let fb = magnitude(n, sampleRate, b);
  while (hi - lo > hz * 1e-6) {
    if (fa > fb) {
      hi = b;
      b = a;
      fb = fa;
      a = hi - golden * (hi - lo);
      fa = magnitude(n, sampleRate, a);
    } else {
      lo = a;
      a = b;
      fa = fb;
      b = lo + golden * (hi - lo);
      fb = magnitude(n, sampleRate, b);
    }
  }
  const peak = (lo + hi) / 2;
  const own = magnitude(n, sampleRate, peak);
  let strongest = own;
  for (let k = 2; k <= 4 && k * hz < sampleRate / 2; k += 1) strongest = Math.max(strongest, magnitude(n, sampleRate, k * hz));
  // An edge of the search span means no peak inside it; -26 dB means too weak.
  const edge = peak - (hz - span) < span * 0.02 || hz + span - peak < span * 0.02;
  return !edge && own >= strongest * 0.05 ? peak : hz;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

// The dial: ±50 cents across ±50 degrees, pivoting at (160, 186) in the face's drawing.
const PIVOT_X = 160;
const PIVOT_Y = 186;
// Pegs stop the needle just past the end of the scale; at rest it lies on the left one.
const STOP = 54;
const REST = -STOP;
// The needle is a damped spring, like a meter movement: it swings with a little
// weight, overshoots slightly and settles. Reduced motion drops the overshoot.
const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const SPRING_HZ = calm ? 3 : 2.2;
const DAMPING = calm ? 1 : 0.6;

const SVG = "http://www.w3.org/2000/svg";

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [PIVOT_X + r * Math.sin(a), PIVOT_Y - r * Math.cos(a)];
}

function svg(tag, attrs, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent.appendChild(node);
  return node;
}

function arc(r, from, to) {
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

// Ticks every cent near the centre, every 5 cents beyond, a label every 10, and
// coloured bands: green for the ±2 cent in-tune window, red past ±10.
function drawScale(group) {
  svg("path", { class: "ct-band", d: arc(122, -2, 2), stroke: "#3f9c62" }, group);
  svg("path", { class: "ct-band", d: arc(122, -50, -10), stroke: "rgba(192, 57, 43, 0.38)" }, group);
  svg("path", { class: "ct-band", d: arc(122, 10, 50), stroke: "rgba(192, 57, 43, 0.38)" }, group);
  for (let c = -50; c <= 50; c += 1) {
    const major = c % 10 === 0;
    const mid = c % 5 === 0;
    if (!major && !mid && Math.abs(c) > 10) continue;
    const inner = major ? 128 : mid ? 135 : 140;
    const [x1, y1] = polar(inner, c);
    const [x2, y2] = polar(146, c);
    svg("line", { class: "ct-tick", x1, y1, x2, y2, "stroke-width": major ? 2 : mid ? 1.4 : 0.8 }, group);
    if (major) {
      const [lx, ly] = polar(160, c);
      const label = svg("text", { class: `ct-label${c === 0 ? " is-zero" : ""}`, x: lx, y: ly }, group);
      label.textContent = c === 0 ? "0" : `${c < 0 ? "−" : "+"}${Math.abs(c)}`;
    }
  }
}

export function createTuner({ getA4, setA4, beforeOpen }) {
  const $ = (id) => document.getElementById(id);
  const panel = $("tuner");
  let mic = null;
  let raf = 0;
  let history = [];
  let note = null;
  let shownCents = 0;
  let lastHeard = 0;
  let inTuneSince = 0;
  const needle = { angle: REST, speed: 0, target: REST, last: 0, raf: 0 };
  drawScale($("ct-scale"));
  $("ct-needle").setAttribute("transform", `rotate(${REST} ${PIVOT_X} ${PIVOT_Y})`);

  // Step the spring every frame while the tuner is open, whatever the mic is doing.
  function swing(now) {
    const dt = needle.last ? Math.min(0.05, (now - needle.last) / 1000) : 1 / 60;
    needle.last = now;
    const w = 2 * Math.PI * SPRING_HZ;
    const steps = 4;
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      needle.speed += (w * w * (needle.target - needle.angle) - 2 * DAMPING * w * needle.speed) * h;
      needle.angle += needle.speed * h;
      // The pegs: a hard stop with a small bounce.
      if (Math.abs(needle.angle) > STOP) {
        needle.angle = Math.sign(needle.angle) * STOP;
        needle.speed *= -0.3;
      }
    }
    $("ct-needle").setAttribute("transform", `rotate(${needle.angle.toFixed(3)} ${PIVOT_X} ${PIVOT_Y})`);
    needle.raf = requestAnimationFrame(swing);
  }

  function lamps(flat, inTune, sharp) {
    $("ct-lamp-flat").classList.toggle("is-lit", flat);
    $("ct-lamp-in").classList.toggle("is-lit", inTune);
    $("ct-lamp-sharp").classList.toggle("is-lit", sharp);
  }

  function rest() {
    needle.target = REST;
    lamps(false, false, false);
  }

  function renderA4() {
    $("ct-a4").textContent = String(getA4());
    $("ct-a4-down").disabled = getA4() <= 430;
    $("ct-a4-up").disabled = getA4() >= 446;
  }

  function nudgeA4(step) {
    setA4(Math.max(430, Math.min(446, getA4() + step)));
    renderA4();
    history = [];
  }

  async function start() {
    if (mic) return;
    $("ct-status").textContent = "Starting microphone…";
    try {
      const audio = getContext();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (panel.hidden) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const src = audio.createMediaStreamSource(stream);
      const analyser = audio.createAnalyser();
      analyser.fftSize = LONG;
      src.connect(analyser);
      mic = { stream, src, analyser, buf: new Float32Array(LONG), rate: audio.sampleRate };
      $("ct-mic").textContent = "Stop microphone";
      $("ct-status").textContent = "Play a single note";
      raf = requestAnimationFrame(tick);
    } catch {
      $("ct-status").textContent =
        "The microphone isn't available here. Allow mic access in your browser, or open the app on your own computer.";
    }
  }

  function stop() {
    cancelAnimationFrame(raf);
    if (mic) {
      mic.stream.getTracks().forEach((t) => t.stop());
      mic.src.disconnect();
      mic = null;
    }
    history = [];
    note = null;
    $("ct-mic").textContent = "Start microphone";
    $("ct-status").textContent = "Microphone off";
    $("ct-level").style.width = "0%";
    $("ct-display").classList.add("is-idle");
    rest();
  }

  function tick(now) {
    if (!mic) return;
    mic.analyser.getFloatTimeDomainData(mic.buf);
    const { hz, rms } = detectTunerPitch(mic.buf, mic.rate);
    const db = 20 * Math.log10(rms || 1e-9);
    $("ct-level").style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;

    if (hz) {
      const a4 = getA4();
      const nearest = Math.round(hzToMidi(hz, a4));
      if (nearest !== note) {
        note = nearest;
        history = [];
        shownCents = (hzToMidi(hz, a4) - nearest) * 100;
      }
      history.push(hz);
      if (history.length > HISTORY) history.shift();
      const steady = median(history);
      const cents = (hzToMidi(steady, a4) - nearest) * 100;
      shownCents += (cents - shownCents) * 0.5;
      lastHeard = now;
      // The spring smooths the needle itself; the digits get a light glide.
      needle.target = Math.max(-60, Math.min(60, cents));
      render(nearest, steady, shownCents, now);
    } else if (now - lastHeard > 700) {
      $("ct-display").classList.add("is-idle");
      $("ct-status").textContent = "Play a single note";
      $("ct-display").classList.remove("is-in", "is-near");
      inTuneSince = 0;
      rest();
    }
    raf = requestAnimationFrame(tick);
  }

  function render(midi, hz, cents, now) {
    const n = noteFromMidi(midi);
    const display = $("ct-display");
    display.classList.remove("is-idle");
    $("ct-name").textContent = n.name;
    $("ct-name").style.color = n.color;
    $("ct-octave").textContent = String(n.octave);
    $("ct-cents").textContent = `${cents >= 0 ? "+" : "−"}${Math.abs(cents).toFixed(1)}¢`;
    $("ct-hz").textContent = `${hz.toFixed(2)} Hz`;
    $("ct-target").textContent = `${n.name}${n.octave} = ${midiToHz(midi, getA4()).toFixed(2)} Hz`;
    const inTune = Math.abs(cents) <= IN_TUNE;
    if (inTune && !inTuneSince) inTuneSince = now;
    if (!inTune) inTuneSince = 0;
    // Hold green only once the note has stayed in tune briefly, so a sweep past 0 doesn't flash it.
    const locked = inTune && now - inTuneSince > 250;
    display.classList.toggle("is-in", locked);
    display.classList.toggle("is-near", !locked && Math.abs(cents) <= 10);
    lamps(!locked && cents < 0, locked, !locked && cents > 0);
    $("ct-status").textContent = locked ? "In tune" : cents < 0 ? "Flat — tune up" : "Sharp — tune down";
  }

  function open() {
    beforeOpen?.();
    panel.hidden = false;
    renderA4();
    $("ct-display").classList.add("is-idle");
    $("close-tuner").focus();
    needle.last = 0;
    needle.raf = requestAnimationFrame(swing);
    start();
  }

  function close() {
    if (panel.hidden) return false;
    stop();
    cancelAnimationFrame(needle.raf);
    panel.hidden = true;
    $("tuner-btn").focus();
    return true;
  }

  $("tuner-btn").addEventListener("click", open);
  $("close-tuner").addEventListener("click", close);
  panel.addEventListener("click", (e) => {
    if (e.target === panel) close();
  });
  $("ct-mic").addEventListener("click", () => (mic ? stop() : start()));
  $("ct-a4-down").addEventListener("click", () => nudgeA4(-1));
  $("ct-a4-up").addEventListener("click", () => nudgeA4(1));

  return { open, close, isOpen: () => !panel.hidden, renderA4 };
}
