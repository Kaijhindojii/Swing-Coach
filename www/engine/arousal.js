// Arousal ("nerves") estimator: heart-rate samples in -> a calm/steady/elevated/high reading out.
//
// This is a coarse stress indicator, not a medical measurement. It compares the golfer's heart rate
// with their own still baseline, how fast it is climbing, and (when the sensor provides beat-to-beat
// RR intervals, e.g. a Bluetooth chest strap) how much heart-rate variability has dropped.
// Apple Watch does not expose live RR intervals, so with a watch the reading uses heart rate only.
//
// Walking raises heart rate for reasons that have nothing to do with nerves, so a reading is only
// produced while the golfer is still. A sample may carry `still: false` (the watch works this out
// from its motion sensors); when `still` is missing the golfer is assumed to be still.
//
// Time is in seconds. Pure logic with no DOM, so it runs in the app and in Node tests.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Root mean square of successive RR differences (ms): the standard short-term HRV number. */
export function rmssd(rrMs) {
  if (rrMs.length < 3) return NaN;
  let sum = 0;
  for (let i = 1; i < rrMs.length; i++) sum += (rrMs[i] - rrMs[i - 1]) ** 2;
  return Math.sqrt(sum / (rrMs.length - 1));
}

/** Least-squares slope of bpm over time, in bpm per 10 seconds. NaN if the data is too thin. */
export function slopePer10s(points) {
  if (points.length < 4) return NaN;
  const t0 = points[0].t;
  if (points[points.length - 1].t - t0 < 8) return NaN;
  const n = points.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of points) { const x = p.t - t0; sx += x; sy += p.bpm; sxy += x * p.bpm; sxx += x * x; }
  const den = n * sxx - sx * sx;
  return den ? ((n * sxy - sx * sy) / den) * 10 : NaN;
}

export const LEVELS = ['calm', 'steady', 'elevated', 'high'];

export function levelFromScore(score) {
  if (score < 25) return 'calm';
  if (score < 50) return 'steady';
  if (score < 75) return 'elevated';
  return 'high';
}

export class ArousalEstimator {
  /**
   * @param opts.restingHR   resting heart rate from the person's health data (optional)
   * @param opts.baselineRMSSD  resting RMSSD in ms (optional, only used when RR data arrives)
   */
  constructor(opts = {}) {
    this.o = {
      windowS: 8,            // heart rate now = median over this window
      slopeWindowS: 20,
      hrvWindowS: 60,
      historyS: 900,
      stillGapS: 4,          // any moving sample in the last few seconds means "moving"
      settleS: 20,           // after movement stops, wait this long (from the last moving sample) before scoring
      calibrateMinS: 30,     // still data needed before a learned baseline is trusted
      calibrateWindowS: 240,
      ...opts,
    };
    this.samples = [];       // {t, bpm, still}
    this.rr = [];            // {t, ms}
    this.restingHR = opts.restingHR > 30 ? opts.restingHR : null;
    this.baselineRMSSD = opts.baselineRMSSD > 0 ? opts.baselineRMSSD : null;
    this.learnedHR = null;
    this.learnedRMSSD = null;
  }

  setRestingHR(bpm) { this.restingHR = bpm > 30 && bpm < 120 ? bpm : null; }

  /** Add one reading. Returns false if it was rejected as implausible. */
  add({ t, bpm, rr, still }) {
    if (!(bpm >= 30 && bpm <= 230) || !Number.isFinite(t)) return false;
    this.samples.push({ t, bpm, still: still !== false });
    if (Array.isArray(rr)) for (const ms of rr) if (ms >= 300 && ms <= 2000) this.rr.push({ t, ms });
    const cut = t - this.o.historyS;
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift();
    while (this.rr.length && this.rr[0].t < cut) this.rr.shift();
    return true;
  }

  get hasRR() { return this.rr.length > 0; }

  /** The baseline in use: health-data resting HR if we have it, otherwise one learned from still data. */
  baseline(now) {
    if (this.restingHR) return { bpm: this.restingHR, source: 'resting' };
    const from = now - this.o.calibrateWindowS;
    const still = this.samples.filter((s) => s.t >= from && s.still);
    if (still.length >= 10 && still[still.length - 1].t - still[0].t >= this.o.calibrateMinS) {
      this.learnedHR = percentile(still.map((s) => s.bpm), 0.1);
      return { bpm: this.learnedHR, source: 'learned' };
    }
    return null;
  }

  /** Current reading. `now` defaults to the time of the latest sample. */
  state(now) {
    const last = this.samples[this.samples.length - 1];
    if (!last) return { status: 'no_signal' };
    now = now ?? last.t;

    const recent = this.samples.filter((s) => s.t >= now - this.o.stillGapS);
    if (recent.some((s) => !s.still)) return { status: 'moving', bpm: last.bpm };

    // Heart rate stays up for a while after walking stops. Scoring straight away would read that
    // as nerves, so hold off until it has had time to come down.
    let lastMoving = null;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      if (this.samples[i].t > now) continue;
      if (!this.samples[i].still) { lastMoving = this.samples[i]; break; }
    }
    if (lastMoving && now - lastMoving.t < this.o.settleS) {
      return { status: 'settling', bpm: last.bpm, progress: clamp((now - lastMoving.t) / this.o.settleS, 0, 1) };
    }

    const winSamples = this.samples.filter((s) => s.t >= now - this.o.windowS && s.still);
    const bpm = Math.round(median(winSamples.map((s) => s.bpm)));
    const base = this.baseline(now);
    if (!base) {
      const from = now - this.o.calibrateWindowS;
      const still = this.samples.filter((s) => s.t >= from && s.still);
      const span = still.length ? still[still.length - 1].t - still[0].t : 0;
      return { status: 'calibrating', bpm, progress: clamp(span / this.o.calibrateMinS, 0, 1) };
    }

    // Heart rate above baseline. A resting HR from health data is a lying-down number, so an
    // awake, standing, calm golfer already sits ~12% above it. A learned baseline is already
    // an awake-and-still number, so no allowance is needed.
    const allowance = base.source === 'resting' ? 0.12 : 0;
    const elevation = (bpm - base.bpm) / base.bpm;
    const sElev = clamp((elevation - allowance) / 0.35, 0, 1);

    const slope = slopePer10s(this.samples.filter((s) => s.t >= now - this.o.slopeWindowS && s.still));
    const sSlope = Number.isFinite(slope) ? clamp(slope / 8, 0, 1) : null;

    // HRV, only when RR intervals exist and a baseline for them is known.
    let hrv = null, sHrv = null;
    const rrWin = this.rr.filter((r) => r.t >= now - this.o.hrvWindowS).map((r) => r.ms);
    if (rrWin.length >= 20) {
      hrv = rmssd(rrWin);
      if (!this.baselineRMSSD && base.source === 'learned') {
        const all = this.rr.filter((r) => r.t >= now - this.o.calibrateWindowS).map((r) => r.ms);
        if (all.length >= 60) this.learnedRMSSD = rmssd(all);
      }
      const ref = this.baselineRMSSD || this.learnedRMSSD;
      if (ref && Number.isFinite(hrv)) sHrv = clamp((1 - hrv / ref) / 0.5, 0, 1);
    }

    const parts = [[sElev, 0.6], [sSlope, 0.25], [sHrv, 0.15]].filter(([v]) => v !== null);
    const wsum = parts.reduce((a, [, w]) => a + w, 0);
    const score = Math.round((100 * parts.reduce((a, [v, w]) => a + v * w, 0)) / wsum);
    const trend = !Number.isFinite(slope) ? 'flat' : slope > 3 ? 'rising' : slope < -3 ? 'falling' : 'flat';

    return {
      status: 'ok', bpm, score, level: levelFromScore(score), trend,
      baseline: Math.round(base.bpm), baselineSource: base.source,
      elevationPct: Math.round(elevation * 100),
      slope10: Number.isFinite(slope) ? Math.round(slope * 10) / 10 : null,
      rmssd: hrv !== null && Number.isFinite(hrv) ? Math.round(hrv) : null,
      usedHrv: sHrv !== null,
    };
  }
}
