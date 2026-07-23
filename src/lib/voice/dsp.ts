/**
 * Small, allocation-free DSP helpers shared by the trackers.
 *
 * These run inside the ~60fps analysis loop, so every function here is
 * written to avoid per-call allocations (no Array.push in hot paths, no
 * closures over large buffers).
 */

/** Hz per frequency bin for a given FFT size. */
export function binHz(sampleRate: number, fftSize: number): number {
  return sampleRate / fftSize;
}

/**
 * Spectral centroid: the magnitude-weighted average frequency. A brightness
 * proxy — higher centroid ≈ brighter / more forward resonance (Module 2).
 * Returns Hz, or 0 for a silent frame.
 */
export function spectralCentroid(
  freq: Uint8Array,
  sampleRate: number,
  fftSize: number,
): number {
  let num = 0;
  let den = 0;
  const hz = binHz(sampleRate, fftSize);
  for (let i = 0; i < freq.length; i++) {
    const m = freq[i];
    if (m === 0) continue;
    num += i * hz * m;
    den += m;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Normalized autocorrelation at a single lag (amplitude-independent,
 * range [-1, 1]). Used both for pitch detection and the HNR estimate.
 */
export function normalizedAcfAt(
  buf: Float32Array,
  lag: number,
): number {
  const end = buf.length - lag;
  if (end <= 0) return 0;
  let corr = 0;
  let e1 = 0;
  let e2 = 0;
  for (let i = 0; i < end; i++) {
    const a = buf[i];
    const b = buf[i + lag];
    corr += a * b;
    e1 += a * a;
    e2 += b * b;
  }
  const denom = Math.sqrt(e1 * e2);
  return denom > 0 ? corr / denom : 0;
}

/**
 * Detect the fundamental frequency via normalized autocorrelation (peak
 * picking over plausible voice lags), with octave correction. Returns
 * `{ freq, clarity }` where `clarity` ∈ [-1, 1] is the peak correlation
 * (≈ periodicity), or null for unvoiced / noisy frames.
 *
 * This is intentionally more permissive than strict YIN so voiced speech
 * registers reliably, while a clarity floor filters silence / breath.
 */
export function detectPitchAutocorrelation(
  buf: Float32Array,
  sampleRate: number,
  minHz = 65,
  maxHz = 600,
): { freq: number; clarity: number } | null {
  const n = buf.length;
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 1, Math.ceil(sampleRate / minHz));
  if (maxLag <= minLag) return null;

  let bestLag = -1;
  let bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = normalizedAcfAt(buf, lag);
    if (r > bestVal) {
      bestVal = r;
      bestLag = lag;
    }
  }

  // Clarity floor: voiced speech typically peaks above ~0.4; noise hovers
  // near 0 (magnitude ~1/√N), so even 0.3 cleanly separates the two. Kept
  // permissive so breathy / lighter phonation still registers.
  if (bestLag < 0 || bestVal < 0.3) return null;

  // Octave correction: if half the best lag is nearly as periodic, the true
  // fundamental is the smaller lag (avoid reporting an octave too low).
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag) {
    const rHalf = normalizedAcfAt(buf, halfLag);
    if (rHalf >= 0.9 * bestVal) {
      bestLag = halfLag;
    }
  }

  return { freq: sampleRate / bestLag, clarity: bestVal };
}

/**
 * Harmonics-to-noise ratio (dB) estimated from the magnitude spectrum:
 * compares energy at harmonic peaks (integer multiples of the pitch) to
 * the energy in the inter-harmonic valleys (the noise floor).
 *
 * Unlike autocorrelation-based HNR — which stays near-saturated for *any*
 * voiced speech because periodicity is always high — this spectral form
 * actually responds to breathiness / aspiration noise filling in the
 * valleys (lower HNR) versus a clean, well-defined harmonic structure
 * (higher HNR). Returns null when no pitch is available or harmonics can't
 * be resolved.
 */
export function spectralHnr(
  freq: Uint8Array,
  sampleRate: number,
  fftSize: number,
  pitchHz: number,
): number | null {
  if (!(pitchHz > 0)) return null;
  const binHz = sampleRate / fftSize;
  const f0bin = pitchHz / binHz; // pitch in FFT bins
  // Need the fundamental to span enough bins to resolve harmonics.
  if (f0bin < 1.5) return null;

  const maxBin = freq.length - 1;
  const maxHarmonic = Math.floor(maxBin / f0bin);
  if (maxHarmonic < 3) return null;
  // Upper harmonics are weak/noisy; cap the count analyzed.
  const H = Math.min(maxHarmonic, 16);

  let harmSum = 0;
  let noiseSum = 0;
  let harmN = 0;
  let noiseN = 0;

  const halfWin = Math.max(1, Math.round(f0bin * 0.3));
  for (let h = 1; h <= H; h++) {
    const center = Math.round(h * f0bin);
    const lo = Math.max(1, center - halfWin);
    const hi = Math.min(maxBin, center + halfWin);
    let peak = 0;
    for (let i = lo; i <= hi; i++) if (freq[i] > peak) peak = freq[i];
    if (peak <= 0) continue;
    harmSum += peak * peak;
    harmN++;

    if (h < H) {
      // Inter-harmonic valley midpoint at (h + 0.5)·f0; average a couple of
      // bins for stability. Floor at 1 so deep valleys don't blow up the ratio.
      const vCenter = Math.round((h + 0.5) * f0bin);
      const vlo = Math.max(1, vCenter - 1);
      const vhi = Math.min(maxBin, vCenter + 1);
      let vsum = 0;
      let vcnt = 0;
      for (let i = vlo; i <= vhi; i++) {
        vsum += freq[i];
        vcnt++;
      }
      let valley = vcnt > 0 ? vsum / vcnt : 0;
      if (valley < 1) valley = 1;
      noiseSum += valley * valley;
      noiseN++;
    }
  }

  if (harmN === 0 || noiseN === 0) return null;
  const hAvg = harmSum / harmN;
  const nAvg = noiseSum / noiseN;
  if (nAvg <= 0) return null;
  let db = 10 * Math.log10(hAvg / nAvg);
  // Clamp to a sensible, displayable range.
  if (db < 0) db = 0;
  if (db > 40) db = 40;
  return db;
}

/** Clamp a value into [min, max]. */
export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Map x from [inMin, inMax] to [0, 1], clamped. */
export function normClamped(
  x: number,
  inMin: number,
  inMax: number,
): number {
  if (inMax === inMin) return 0;
  return clamp((x - inMin) / (inMax - inMin), 0, 1);
}

// ──────────────────────────────────────────────────────────────────────────
// Streaming statistics (single-pass, no stored samples)
// ──────────────────────────────────────────────────────────────────────────

/** Minimum / maximum / sum / count accumulator for streaming numeric data. */
export interface RunningStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Values for median / stddev are kept as a capped reservoir, not all. */
  samples: number[];
}

const MAX_SAMPLES = 4000;

export function makeStats(): RunningStats {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity, samples: [] };
}

export function pushStat(s: RunningStats, x: number): void {
  s.count++;
  s.sum += x;
  if (x < s.min) s.min = x;
  if (x > s.max) s.max = x;
  if (s.samples.length < MAX_SAMPLES) {
    s.samples.push(x);
  } else {
    // Reservoir-sample over the rest so median stays representative.
    const idx = Math.floor(Math.random() * s.count);
    if (idx < MAX_SAMPLES) s.samples[idx] = x;
  }
}

export function mean(s: RunningStats): number {
  return s.count > 0 ? s.sum / s.count : 0;
}

/** Median over the (possibly reservoir-sampled) collected values. */
export function median(s: RunningStats): number {
  if (s.samples.length === 0) return 0;
  const sorted = Float64Array.from(s.samples).sort();
  const n = sorted.length;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
}

/** Sample standard deviation over collected values. */
export function stddev(s: RunningStats): number {
  if (s.samples.length < 2) return 0;
  const m = s.sum / s.count;
  let acc = 0;
  for (let i = 0; i < s.samples.length; i++) {
    const d = s.samples[i] - m;
    acc += d * d;
  }
  return Math.sqrt(acc / s.samples.length);
}
