function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i += 1) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

function parabolic(nsdf, tau) {
  const s0 = nsdf[tau - 1];
  const s1 = nsdf[tau];
  const s2 = nsdf[tau + 1];
  const a = (s0 + s2) / 2 - s1;
  const b = (s2 - s0) / 2;
  if (a === 0) return tau;
  return tau - b / (2 * a);
}

// McLeod pitch method: normalized square difference, then the first key
// maximum that reaches 0.85 of the highest one (after the first zero crossing).
export function detectPitch(floatBuf, sampleRate, { minHz = 60, maxHz = 1200 } = {}) {
  if (rms(floatBuf) < 0.012) return null;

  const n = floatBuf.length;
  const maxTau = Math.min(Math.floor(sampleRate / minHz), Math.floor(n / 2));
  const nsdf = new Float32Array(maxTau + 2);

  for (let tau = 0; tau < nsdf.length; tau += 1) {
    let ac = 0;
    let m = 0;
    for (let i = 0; i < n - tau; i += 1) {
      const a = floatBuf[i];
      const b = floatBuf[i + tau];
      ac += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m ? (2 * ac) / m : 0;
  }

  let start = 1;
  while (start < maxTau && nsdf[start] > 0) start += 1;

  const peaks = [];
  let best = 0;
  let i = start;
  while (i < maxTau) {
    while (i < maxTau && !(nsdf[i] > 0)) i += 1;
    let peak = -1;
    while (i < maxTau && nsdf[i] > 0) {
      if (peak < 0 || nsdf[i] > nsdf[peak]) peak = i;
      i += 1;
    }
    if (peak > 0) {
      peaks.push(peak);
      best = Math.max(best, nsdf[peak]);
    }
  }
  if (best < 0.5) return null;

  const minTau = Math.floor(sampleRate / maxHz);
  const tau = peaks.find((p) => p >= minTau && nsdf[p] >= best * 0.85);
  if (!tau) return null;
  return sampleRate / parabolic(nsdf, tau);
}
