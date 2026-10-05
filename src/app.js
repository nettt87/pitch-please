import { playHz, getContext } from "./audio.js?v=12";
import { detectPitch, rms } from "./pitch.js?v=12";
import { buildAnswerPiano, buildFretboard, buildWheel, guitarFrets, GUITAR_LOW } from "./pads.js?v=12";
import {
  PITCH_CLASSES,
  PRESETS,
  midiToHz,
  hzToMidi,
  noteFromMidi,
  midiPool,
  chromaCentsOff,
} from "./notes.js?v=12";
import {
  loadStats,
  saveStats,
  emptyStats,
  loadSettings,
  saveSettings,
  recordIdentify,
} from "./storage.js?v=12";

const LOCK_CENTS = 20;
const LOCK_HOLD_MS = 700;
// Play takes a struck or plucked note: it only has to settle, not sustain.
const PLAY_CENTS = 30;
const PLAY_SETTLE_MS = 120;
// A gap longer than this ends a note; a rise in level this sharp is a new attack.
const PLAY_GAP_MS = 250;
const PLAY_ONSET_RATIO = 1.6;
const PADS = ["wheel", "piano", "guitar"];

const saved = loadSettings();

const state = {
  mode: "identify",
  preset: saved.preset ?? "white",
  pcs: Array.isArray(saved.pcs) && saved.pcs.length ? saved.pcs : [...PRESETS.white],
  lo: saved.lo ?? 4,
  hi: saved.hi ?? 4,
  timbre: saved.timbre ?? "piano",
  a4: saved.a4 ?? 440,
  autoNext: saved.autoNext ?? true,
  answerPad: saved.answerPad ?? "wheel",
  explorePad: saved.explorePad ?? "wheel",
  pickPos: null,
  target: null,
  heard: false,
  streak: 0,
  sessionHits: 0,
  sessionN: 0,
  locked: false,
  advanceTimer: 0,
  stats: loadStats(),
  mic: null,
  produceMidi: null,
  produceLocked: false,
  holdMs: 0,
  playMidi: null,
  playLocked: false,
  playMisses: 0,
  // The note ringing now: its nearest pitch class, how long that has held, and the pitch classes already scored.
  playNote: null,
  playLevel: 0,
  lastTick: 0,
  muteMicUntil: 0,
  resetTimer: 0,
};

const $ = (id) => document.getElementById(id);

function persistSettings() {
  const { preset, pcs, lo, hi, timbre, a4, autoNext, answerPad, explorePad } = state;
  saveSettings({ preset, pcs, lo, hi, timbre, a4, autoNext, answerPad, explorePad });
}

// Spanning more than one octave turns Identify into naming the exact key.
function octaveRange() {
  return state.hi > state.lo ? { lo: state.lo, hi: state.hi } : null;
}

// What the active pad can answer. The guitar neck stops at E2 and fret 24.
function targetPool() {
  const all = midiPool(state.pcs, state.lo, state.hi);
  const range = octaveRange();
  if (!range || state.answerPad !== "guitar") return all;
  const top = 64 + guitarFrets(range);
  const playable = all.filter((m) => m >= GUITAR_LOW && m <= top);
  return playable.length ? playable : all;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Each pad sounds like its instrument; Sing has no pad and uses the chosen timbre.
const PAD_TIMBRE = { wheel: "organ", piano: "acoustic", guitar: "guitar" };

function currentTimbre() {
  if (state.mode === "identify") return PAD_TIMBRE[state.answerPad];
  if (state.mode === "explore") return PAD_TIMBRE[state.explorePad];
  return state.timbre;
}

function playMidi(midi, duration = 1.2) {
  // Keep the tuner from hearing the speakers and locking on its own playback.
  state.muteMicUntil = performance.now() + duration * 1000 + 150;
  playHz(midiToHz(midi, state.a4), { duration, timbre: currentTimbre() });
}

function newIdentifyNote(avoid) {
  clearTimeout(state.advanceTimer);
  const all = targetPool();
  const pool = all.filter((m) => m !== avoid);
  const midi = randomFrom(pool.length ? pool : all);
  state.target = noteFromMidi(midi);
  state.heard = false;
  state.locked = false;
  $("identify-feedback").textContent = "";
  $("identify-feedback").className = "feedback";
  $("identify-orb-label").textContent = "Play";
  $("play-target").classList.remove("is-right", "is-wrong");
  state.pickPos = null;
  for (const b of answerButtons()) {
    b.classList.remove("is-correct", "is-wrong");
  }
}

function speakIdentify(correct, pickedPc, pickedMidi) {
  const fb = $("identify-feedback");
  const label = `${state.target.name}${state.target.octave}`;
  if (correct) {
    fb.textContent = `${label} — yes`;
    fb.className = "feedback good";
  } else if (octaveRange()) {
    const picked = noteFromMidi(pickedMidi);
    const lead = picked.pc === state.target.pc ? "Right note, wrong octave. " : "";
    fb.textContent = `${lead}You played ${picked.name}${picked.octave} — that was ${label}`;
    fb.className = "feedback bad";
  } else {
    fb.textContent = `You played ${PITCH_CLASSES[pickedPc].name} — that was ${label}`;
    fb.className = "feedback bad";
  }
  $("identify-orb-label").textContent = label;
  $("play-target").classList.add(correct ? "is-right" : "is-wrong");
}

function updateSessionHud() {
  $("streak").textContent = String(state.streak);
  $("round-n").textContent = String(state.sessionN);
  $("session-acc").textContent = state.sessionN
    ? `${Math.round((100 * state.sessionHits) / state.sessionN)}%`
    : "—";
}

function renderStats() {
  const stats = state.stats;
  let hits = 0;
  let n = 0;
  stats.byPc.forEach((row) => {
    hits += row.hits;
    n += row.hits + row.misses;
  });
  $("life-acc").textContent = n ? `${Math.round((100 * hits) / n)}%` : "—";
  $("life-n").textContent = `${n} identification${n === 1 ? "" : "s"}`;
  $("best-streak").textContent = String(stats.bestStreak);
  $("sung-locks").textContent = String(stats.produceLocks);
  $("played-notes").textContent = String(stats.playLocks);
  $("played-first").textContent = stats.playLocks
    ? `${Math.round((100 * stats.playFirstTry) / stats.playLocks)}% on the first try`
    : "found on an instrument";

  const bars = $("stat-bars");
  bars.innerHTML = "";
  PITCH_CLASSES.forEach((note) => {
    const row = stats.byPc[note.pc];
    const total = row.hits + row.misses;
    const pct = total ? Math.round((100 * row.hits) / total) : 0;
    const wrap = document.createElement("div");
    wrap.className = "bar-row";
    wrap.innerHTML = `<span>${note.name}</span><div class="bar-track"><div class="bar-fill"></div></div><span>${total ? pct + "%" : "—"}</span>`;
    wrap.title = total ? `${row.hits} of ${total} correct` : "Not heard yet";
    wrap.querySelector(".bar-fill").style.width = `${pct}%`;
    wrap.querySelector(".bar-fill").style.background = note.color;
    bars.appendChild(wrap);
  });
}

function renderPicks() {
  const box = $("chroma-picks");
  box.innerHTML = "";
  PITCH_CLASSES.forEach((note) => {
    const b = document.createElement("button");
    b.type = "button";
    const on = state.pcs.includes(note.pc);
    b.className = `pick${on ? " on" : ""}`;
    b.setAttribute("aria-pressed", String(on));
    b.textContent = note.name;
    b.addEventListener("click", () => {
      if (state.pcs.includes(note.pc)) {
        if (state.pcs.length === 1) return;
        state.pcs = state.pcs.filter((p) => p !== note.pc);
      } else {
        state.pcs = [...state.pcs, note.pc].sort((a, c) => a - c);
      }
      state.preset = "custom";
      $("preset").value = "custom";
      persistSettings();
      renderPicks();
      refreshWheels();
    });
    box.appendChild(b);
  });
}

const wheelSize = { answer: 0, explore: 0 };

function onExplore(pc) {
  playMidi((4 + 1) * 12 + pc);
}

function onExploreFret(pc, btn) {
  playMidi(Number(btn.dataset.midi), 1.4);
  btn.classList.add("is-down");
  setTimeout(() => btn.classList.remove("is-down"), 220);
}

function layoutWheels() {
  const wheels = [
    ["answer", $("answer-wheel"), state.pcs, onIdentify, octaveRange()],
    ["explore", $("explore-wheel"), null, onExplore, null],
  ];
  for (const [key, el, pcs, onPick, range] of wheels) {
    // Size class first, so the width measured below is the one drawn into.
    el.classList.toggle("is-multi", Boolean(range));
    const w = el.clientWidth;
    if ((w && w !== wheelSize[key]) || !el.childElementCount) {
      wheelSize[key] = w;
      buildWheel(el, pcs, onPick, range);
    }
  }
  if (state.locked && state.target) markAnswer();
}

function refreshWheels() {
  wheelSize.answer = 0;
  wheelSize.explore = 0;
  $("answer-wheel").innerHTML = "";
  $("explore-wheel").innerHTML = "";
  const range = octaveRange();
  buildAnswerPiano($("answer-piano"), state.pcs, onIdentify, range);
  buildFretboard($("answer-guitar"), state.pcs, onIdentify, range);
  $("identify-hint").textContent = range
    ? `Hear a pitch. Find the exact key, octave included (${state.lo}–${state.hi}). Space replays.`
    : "Hear a pitch. Name its chroma — not the octave. Space replays.";
  layoutWheels();
}

function answerButtons() {
  return $("answer-area").querySelectorAll("[data-pc]");
}

function isTarget(b) {
  if (octaveRange()) return Number(b.dataset.midi) === state.target.midi;
  return Number(b.dataset.pc) === state.target.pc;
}

function markAnswer() {
  for (const b of answerButtons()) {
    if (isTarget(b)) b.classList.add("is-correct");
    else if (b.dataset.pos === state.pickPos) b.classList.add("is-wrong");
  }
}

function setAnswerPad(pad) {
  state.answerPad = PADS.includes(pad) ? pad : "wheel";
  document.querySelectorAll(".pad-opt[data-pad]").forEach((b) => {
    const on = b.dataset.pad === state.answerPad;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("answer-wheel").hidden = state.answerPad !== "wheel";
  $("answer-piano").hidden = state.answerPad !== "piano";
  $("answer-guitar").hidden = state.answerPad !== "guitar";
  // The guitar can't reach every pitch of a wide range; draw one it can.
  if (state.target && !state.locked && !targetPool().includes(state.target.midi)) newIdentifyNote();
  requestAnimationFrame(layoutWheels);
}

function setExplorePad(pad) {
  state.explorePad = PADS.includes(pad) ? pad : "wheel";
  document.querySelectorAll(".pad-opt[data-explore-pad]").forEach((b) => {
    const on = b.dataset.explorePad === state.explorePad;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("explore-wheel").hidden = state.explorePad !== "wheel";
  $("piano").hidden = state.explorePad !== "piano";
  $("explore-guitar").hidden = state.explorePad !== "guitar";
  requestAnimationFrame(layoutWheels);
}

function onIdentify(pc, btn) {
  if (!state.target || state.locked) return;
  if (!state.heard) {
    // Guessing before hearing anything is meaningless; play the note instead.
    playCurrent();
    return;
  }
  state.locked = true;
  state.sessionN += 1;
  const prev = state.target.midi;
  const guessMidi = btn?.dataset.midi ? Number(btn.dataset.midi) : nearestMidi(pc, prev);
  const correct = btn ? isTarget(btn) : pc === state.target.pc;
  if (correct) {
    state.sessionHits += 1;
    state.streak += 1;
    state.stats.bestStreak = Math.max(state.stats.bestStreak, state.streak);
  } else {
    state.streak = 0;
  }
  state.pickPos = btn?.dataset.pos ?? null;
  markAnswer();
  state.stats = recordIdentify(state.stats, state.target.pc, correct);
  saveStats(state.stats);
  speakIdentify(correct, pc, guessMidi);
  updateSessionHud();

  // Play what was pressed: a pad showing real octaves sounds that pitch; a
  // chroma-only pad sounds the guess in the octave nearest the target.
  playMidi(guessMidi, 0.9);
  if (!correct) {
    // Then the real note, so the two can be compared.
    setTimeout(() => playMidi(prev, 1.1), 1000);
  }

  if (correct && state.autoNext) {
    state.advanceTimer = setTimeout(() => {
      newIdentifyNote(prev);
      playCurrent();
    }, 1300);
  } else {
    state.advanceTimer = setTimeout(() => newIdentifyNote(prev), correct ? 900 : 2800);
  }
}

function nearestMidi(pc, nearMidi) {
  let diff = (((pc - nearMidi) % 12) + 12) % 12;
  if (diff > 6) diff -= 12;
  return nearMidi + diff;
}

function playCurrent() {
  if (!state.target) newIdentifyNote();
  getContext();
  state.heard = true;
  const orb = $("play-target");
  orb.classList.add("is-playing");
  playMidi(state.target.midi);
  setTimeout(() => orb.classList.remove("is-playing"), 900);
}

function buildPiano() {
  const el = $("piano");
  el.innerHTML = "";
  const start = 48;
  const end = 72;
  for (let midi = start; midi <= end; midi += 1) {
    const n = noteFromMidi(midi);
    const isBlack = [1, 3, 6, 8, 10].includes(n.pc);
    const key = document.createElement("button");
    key.className = `key${isBlack ? " black" : ""}`;
    key.type = "button";
    key.textContent = n.name;
    key.title = `${n.name}${n.octave}`;
    key.setAttribute("aria-label", `${n.name}${n.octave}`);
    key.addEventListener("click", () => {
      playMidi(midi, 1.4);
      key.classList.add("is-down");
      setTimeout(() => key.classList.remove("is-down"), 220);
    });
    el.appendChild(key);
  }
}

// The mic serves one view at a time; each has its own tuner.
const MIC_VIEWS = {
  produce: { btn: "mic-btn", readout: "tuner-readout", needle: "tuner-needle" },
  play: { btn: "play-mic-btn", readout: "play-readout", needle: "play-needle" },
};

function showMode(mode) {
  if (state.mic && state.mic.view !== mode) stopMic();
  state.mode = mode;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.mode === mode;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = v.dataset.view !== mode;
  });
  if (mode === "stats") renderStats();
  if (mode === "produce" && !state.produceMidi) nextProduce();
  if (mode === "play" && state.playMidi === null) nextPlay();
  requestAnimationFrame(layoutWheels);
}

function nextProduce() {
  const pool = midiPool(state.pcs, Math.max(3, state.lo), Math.min(5, state.hi));
  const fallback = midiPool(state.pcs, 4, 4);
  state.produceMidi = randomFrom(pool.length ? pool : fallback);
  const n = noteFromMidi(state.produceMidi);
  $("produce-name").textContent = n.name;
  $("produce-name").style.color = n.color;
  $("produce-octave").textContent = `any octave · reference ${n.name}${n.octave}`;
  $("produce-feedback").textContent = "";
  $("produce-feedback").className = "feedback";
  state.holdMs = 0;
  state.produceLocked = false;
}

function nextPlay() {
  const all = midiPool(state.pcs, state.lo, state.hi);
  // A new name each time, so a note still ringing never answers the next round.
  const prevPc = state.playMidi === null ? -1 : state.playMidi % 12;
  const fresh = all.filter((m) => m % 12 !== prevPc);
  state.playMidi = randomFrom(fresh.length ? fresh : all);
  const n = noteFromMidi(state.playMidi);
  $("play-name").textContent = n.name;
  $("play-name").style.color = n.color;
  $("play-octave").textContent = `any octave · reference ${n.name}${n.octave}`;
  $("play-feedback").textContent = "";
  $("play-feedback").className = "feedback";
  state.playLocked = false;
  state.playMisses = 0;
}

async function enableMic(view) {
  const audio = getContext();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const src = audio.createMediaStreamSource(stream);
  const analyser = audio.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  state.mic = { view, stream, src, analyser, buf: new Float32Array(analyser.fftSize) };
  state.lastTick = 0;
  state.playNote = null;
  state.playLevel = 0;
  $(MIC_VIEWS[view].btn).textContent = "Turn microphone off";
  $(MIC_VIEWS[view].readout).textContent = "Listening…";
  requestAnimationFrame(tickMic);
}

function stopMic() {
  if (!state.mic) return;
  const ui = MIC_VIEWS[state.mic.view];
  state.mic.stream.getTracks().forEach((t) => t.stop());
  state.mic.src.disconnect();
  state.mic = null;
  state.holdMs = 0;
  state.playNote = null;
  $(ui.btn).textContent = "Enable microphone";
  $(ui.readout).textContent = "Mic off";
  $(ui.needle).style.left = "50%";
  $(ui.needle).classList.remove("is-in");
}

function toggleMic(view) {
  if (state.mic) {
    stopMic();
    return;
  }
  enableMic(view).catch(() => {
    $(MIC_VIEWS[view].readout).textContent =
      "The microphone isn't available here. Allow mic access in your browser, or open the app on your own computer.";
  });
}

function tickMic(t) {
  if (!state.mic) return;
  const dt = state.lastTick ? Math.min(t - state.lastTick, 100) : 16;
  state.lastTick = t;
  const ui = MIC_VIEWS[state.mic.view];
  const needle = $(ui.needle);
  const readout = $(ui.readout);

  if (performance.now() < state.muteMicUntil) {
    readout.textContent = "Playing reference…";
    state.holdMs = 0;
    // Whatever still rings from the speakers is the reference, not an answer.
    if (state.playMidi !== null) {
      state.playNote = newPlayNote();
      state.playNote.scored.add(state.playMidi % 12);
    }
    requestAnimationFrame(tickMic);
    return;
  }

  state.mic.analyser.getFloatTimeDomainData(state.mic.buf);
  if (state.mic.view === "play") tickPlay(dt, needle, readout);
  else tickSing(dt, needle, readout);
  requestAnimationFrame(tickMic);
}

function tickSing(dt, needle, readout) {
  const hz = detectPitch(state.mic.buf, getContext().sampleRate);

  if (!hz || !state.produceMidi || state.produceLocked) {
    if (!state.produceLocked) readout.textContent = "Listening…";
    needle.classList.remove("is-in");
    state.holdMs = 0;
    return;
  }

  const raw = chromaCentsOff(hz, state.produceMidi, state.a4);
  const cents = Math.max(-50, Math.min(50, raw));
  const heard = noteFromMidi(Math.round(hzToMidi(hz, state.a4)));
  const inTune = Math.abs(raw) <= LOCK_CENTS;
  needle.style.left = `${50 + cents}%`;
  needle.classList.toggle("is-in", inTune);

  if (inTune) {
    state.holdMs += dt;
    const pct = Math.min(100, Math.round((100 * state.holdMs) / LOCK_HOLD_MS));
    readout.textContent = `${heard.name}${heard.octave}  ${raw >= 0 ? "+" : ""}${raw.toFixed(0)}¢ · hold ${pct}%`;
    if (state.holdMs >= LOCK_HOLD_MS) {
      state.produceLocked = true;
      $("produce-feedback").textContent = "Locked — that is the pitch.";
      $("produce-feedback").className = "feedback good";
      readout.textContent = `${heard.name}${heard.octave} locked`;
      state.stats.produceLocks += 1;
      saveStats(state.stats);
      setTimeout(nextProduce, 1100);
    }
  } else {
    state.holdMs = 0;
    const dir = Math.abs(raw) > 50 ? (raw > 0 ? "far sharp" : "far flat") : `${raw >= 0 ? "+" : ""}${raw.toFixed(0)}¢`;
    readout.textContent = `${heard.name}${heard.octave}  ${dir}`;
  }
}

function newPlayNote() {
  return { pc: -1, ms: 0, gapMs: 0, scored: new Set() };
}

// An instrument note is scored once, as soon as its pitch settles; it may then
// fade freely. Striking again (a sharp rise in level) starts a new note.
// A note glitching to another pitch for a moment (a muted string, a fading
// overtone) stays the same note, so its pitch classes are remembered until then.
function tickPlay(dt, needle, readout) {
  const level = rms(state.mic.buf);
  if (state.playLevel && level > 0.02 && level > state.playLevel * PLAY_ONSET_RATIO) state.playNote = null;
  // A falling peak follower: it rides down with a fading note, so only a fresh attack jumps above it.
  state.playLevel = Math.max(level, state.playLevel * 0.9);

  const hz = detectPitch(state.mic.buf, getContext().sampleRate, { maxHz: 2100 });
  if (!hz) {
    if (state.playNote) {
      state.playNote.gapMs += dt;
      if (state.playNote.gapMs > PLAY_GAP_MS) state.playNote = null;
    }
    if (!state.playLocked) readout.textContent = "Listening…";
    needle.classList.remove("is-in");
    return;
  }

  const heard = noteFromMidi(Math.round(hzToMidi(hz, state.a4)));
  if (!state.playNote) state.playNote = newPlayNote();
  const note = state.playNote;
  if (note.pc !== heard.pc) {
    note.pc = heard.pc;
    note.ms = 0;
  }
  note.ms += dt;
  note.gapMs = 0;

  // A note struck while "yes" is showing belongs to no round.
  if (state.playLocked || state.playMidi === null) {
    note.scored.add(heard.pc);
    return;
  }

  const raw = chromaCentsOff(hz, state.playMidi, state.a4);
  const inTune = Math.abs(raw) <= PLAY_CENTS;
  const off = `${raw >= 0 ? "+" : ""}${raw.toFixed(0)}¢`;
  needle.style.left = `${50 + Math.max(-50, Math.min(50, raw))}%`;
  needle.classList.toggle("is-in", inTune);
  readout.textContent = Math.abs(raw) > 50 ? `${heard.name}${heard.octave}` : `${heard.name}${heard.octave}  ${off}`;

  if (note.scored.has(heard.pc) || note.ms < PLAY_SETTLE_MS) return;
  note.scored.add(heard.pc);
  const fb = $("play-feedback");

  if (inTune) {
    state.playLocked = true;
    fb.textContent = `${heard.name}${heard.octave} — yes`;
    fb.className = "feedback good";
    state.stats.playLocks += 1;
    if (!state.playMisses) state.stats.playFirstTry += 1;
    saveStats(state.stats);
    setTimeout(nextPlay, 1100);
  } else if (heard.pc === state.playMidi % 12) {
    // The right key, just outside the window: that's the instrument's tuning, not the note.
    fb.textContent = `Right note, ${off} off. Tune your instrument or set A4 in Settings.`;
    fb.className = "feedback bad";
  } else {
    state.playMisses += 1;
    fb.textContent = `That was ${heard.name}${heard.octave} — try again`;
    fb.className = "feedback bad";
  }
}

function openSettings() {
  $("settings").hidden = false;
  $("preset").focus();
}

function closeSettings() {
  if ($("settings").hidden) return;
  $("settings").hidden = true;
  newIdentifyNote();
  if (state.mode === "produce") nextProduce();
  else state.produceMidi = null;
  if (state.mode === "play") nextPlay();
  else state.playMidi = null;
  $("settings-btn").focus();
}

function syncOctaveOutputs() {
  $("oct-lo").value = String(state.lo);
  $("oct-hi").value = String(state.hi);
  $("oct-lo-out").textContent = String(state.lo);
  $("oct-hi-out").textContent = String(state.hi);
}

function applySettingsToControls() {
  $("preset").value = state.preset;
  syncOctaveOutputs();
  $("timbre").value = state.timbre;
  $("a4").value = String(state.a4);
  $("a4-out").textContent = String(state.a4);
  $("auto-next").checked = state.autoNext;
}

function bind() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showMode(tab.dataset.mode));
  });
  $("play-target").addEventListener("click", playCurrent);
  document.querySelectorAll(".pad-opt[data-pad]").forEach((b) => {
    b.addEventListener("click", () => {
      setAnswerPad(b.dataset.pad);
      persistSettings();
      if (state.locked && state.target) markAnswer();
    });
  });
  document.querySelectorAll(".pad-opt[data-explore-pad]").forEach((b) => {
    b.addEventListener("click", () => {
      setExplorePad(b.dataset.explorePad);
      persistSettings();
    });
  });
  $("settings-btn").addEventListener("click", openSettings);
  $("close-settings").addEventListener("click", closeSettings);
  $("settings").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSettings();
      return;
    }
    const typing = e.target.closest?.("button, input, select, textarea");
    if (e.key === " " && !typing && $("settings").hidden && state.mode === "identify") {
      e.preventDefault();
      playCurrent();
    }
  });
  $("preset").addEventListener("change", (e) => {
    const v = e.target.value;
    state.preset = v;
    if (PRESETS[v]) state.pcs = [...PRESETS[v]];
    persistSettings();
    renderPicks();
    refreshWheels();
  });
  $("oct-lo").addEventListener("input", (e) => {
    state.lo = Number(e.target.value);
    if (state.lo > state.hi) state.hi = state.lo;
    syncOctaveOutputs();
    persistSettings();
    refreshWheels();
  });
  $("oct-hi").addEventListener("input", (e) => {
    state.hi = Number(e.target.value);
    if (state.hi < state.lo) state.lo = state.hi;
    syncOctaveOutputs();
    persistSettings();
    refreshWheels();
  });
  $("timbre").addEventListener("change", (e) => {
    state.timbre = e.target.value;
    persistSettings();
  });
  $("a4").addEventListener("input", (e) => {
    state.a4 = Number(e.target.value);
    $("a4-out").textContent = String(state.a4);
    persistSettings();
  });
  $("auto-next").addEventListener("change", (e) => {
    state.autoNext = e.target.checked;
    persistSettings();
  });
  $("mic-btn").addEventListener("click", () => toggleMic("produce"));
  $("hear-target").addEventListener("click", () => {
    if (state.produceMidi) playMidi(state.produceMidi);
  });
  $("next-produce").addEventListener("click", nextProduce);
  $("play-mic-btn").addEventListener("click", () => toggleMic("play"));
  $("hear-play").addEventListener("click", () => {
    if (state.playMidi !== null) playMidi(state.playMidi);
  });
  $("next-play").addEventListener("click", nextPlay);
  $("reset-stats").addEventListener("click", () => {
    // Two-step confirm built into the button (browser dialogs are blocked in some embeds).
    const btn = $("reset-stats");
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.textContent = "Tap again to erase all stats";
      btn.classList.add("is-armed");
      state.resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    state.stats = emptyStats();
    saveStats(state.stats);
    renderStats();
  });
}

function disarmReset() {
  clearTimeout(state.resetTimer);
  const btn = $("reset-stats");
  delete btn.dataset.armed;
  btn.textContent = "Reset stats";
  btn.classList.remove("is-armed");
}

function init() {
  applySettingsToControls();
  bind();
  renderPicks();
  refreshWheels();
  setAnswerPad(state.answerPad);
  buildPiano();
  buildFretboard($("explore-guitar"), null, onExploreFret);
  setExplorePad(state.explorePad);
  renderStats();
  updateSessionHud();
  newIdentifyNote();
  const ro = new ResizeObserver(() => layoutWheels());
  ro.observe($("answer-wheel"));
  ro.observe($("explore-wheel"));
}

init();
