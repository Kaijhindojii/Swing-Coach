// Swing analysis engine: pose frames in -> phases + biomechanical metrics out.
// Pure functions, no DOM, so it runs in the browser, in a WebView and in Node tests.
//
// Input frame: { t: seconds, lm: [33 x {x, y, z, visibility}] }  (MediaPipe Pose layout,
// x/y normalised 0..1, y grows downward).
//
// Camera assumption: "down-the-line" (phone behind the golfer, looking toward the target
// along the ball-target line) or a true side-on view. Metrics are scaled by torso length so
// they do not depend on how far the phone is from the golfer. The direction "toward the ball"
// is inferred from where the hands hang relative to the hips at address, so the engine works
// for right- and left-handers without being told.

export const LM = {
  NOSE: 0, L_SH: 11, R_SH: 12, L_EL: 13, R_EL: 14, L_WR: 15, R_WR: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANK: 27, R_ANK: 28,
};

const DEG = 180 / Math.PI;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function movingAvg(arr, win) {
  const h = win >> 1;
  return arr.map((_, i) => {
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(arr.length - 1, i + h); j++) { sum += arr[j]; c++; }
    return sum / c;
  });
}

function angleAt(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (!m) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, dot / m))) * DEG;
}

const KEY = [LM.NOSE, LM.L_SH, LM.R_SH, LM.L_WR, LM.R_WR, LM.L_HIP, LM.R_HIP];

/** Turn raw landmark frames into smoothed 1-D/2-D series. */
function extractSeries(frames, aspect, fps) {
  const raw = { nose: [], sh: [], hip: [], wr: [], knee: [], vis: [], shSep: [] };
  let last = null;
  for (const f of frames) {
    const lm = f && f.lm;
    if (!lm || lm.length < 29) {
      if (last) for (const k of Object.keys(raw)) raw[k].push(last[k]);
      else for (const k of Object.keys(raw)) raw[k].push(null);
      continue;
    }
    const P = (i) => ({ x: lm[i].x * aspect, y: lm[i].y });
    const cur = {
      nose: P(LM.NOSE),
      sh: mid(P(LM.L_SH), P(LM.R_SH)),
      hip: mid(P(LM.L_HIP), P(LM.R_HIP)),
      wr: mid(P(LM.L_WR), P(LM.R_WR)),
      shSep: Math.abs(P(LM.L_SH).x - P(LM.R_SH).x),
      vis: Math.min(...KEY.map((i) => (lm[i].visibility ?? 1))),
    };
    const kl = angleAt(P(LM.L_HIP), P(LM.L_KNEE), P(LM.L_ANK));
    const kr = angleAt(P(LM.R_HIP), P(LM.R_KNEE), P(LM.R_ANK));
    cur.knee = [kl, kr].filter(Number.isFinite).reduce((a, b, _, r) => a + b / r.length, 0);
    for (const k of Object.keys(cur)) raw[k].push(cur[k]);
    last = cur;
  }
  // leading nulls (no detection at start) -> fill from first valid
  const firstValid = raw.nose.findIndex((v) => v);
  if (firstValid < 0) return null;
  for (const k of Object.keys(raw)) for (let i = 0; i < firstValid; i++) raw[k][i] = raw[k][firstValid];

  const win = fps >= 100 ? 7 : 5;
  const smoothPts = (pts) => {
    const xs = movingAvg(pts.map((p) => p.x), win);
    const ys = movingAvg(pts.map((p) => p.y), win);
    return pts.map((_, i) => ({ x: xs[i], y: ys[i] }));
  };
  return {
    n: frames.length,
    nose: smoothPts(raw.nose),
    sh: smoothPts(raw.sh),
    hip: smoothPts(raw.hip),
    wr: smoothPts(raw.wr),
    knee: movingAvg(raw.knee, win),
    vis: raw.vis,
    shSep: raw.shSep,
  };
}

/** x value (interpolated) where a series first crosses a y level, scanning [from,to]. */
function crossX(wr, from, to, level, goingUp) {
  for (let i = from + 1; i <= to; i++) {
    const a = wr[i - 1].y, b = wr[i].y;
    const hit = goingUp ? a > level && b <= level : a < level && b >= level;
    if (hit) {
      const t = (level - a) / (b - a || 1e-9);
      return wr[i - 1].x + t * (wr[i].x - wr[i - 1].x);
    }
  }
  return NaN;
}

const fail = (error, message) => ({ ok: false, error, message });

/**
 * Analyse one swing.
 * @param frames  array of {t, lm}
 * @param opts    { fps, aspect (videoWidth/videoHeight, default 1) }
 */
export function analyzeSwing(frames, opts = {}) {
  const fps = opts.fps || 30;
  const aspect = opts.aspect || 1;
  const warnings = [];

  if (!frames || frames.length < Math.round(fps * 1.2)) {
    return fail('too_short', 'The clip is too short. Record from a still address position through to the finish (3+ seconds).');
  }
  const S = extractSeries(frames, aspect, fps);
  if (!S) return fail('no_person', 'No golfer was detected in the video.');
  const n = S.n;

  // Torso length = our unit of distance.
  const L = median(S.sh.map((p, i) => dist(p, S.hip[i])));
  if (!(L > 0.03)) return fail('too_small', 'The golfer is too small in frame. Move the phone closer so your whole body fills most of the screen.');

  // Wrist speed (torso-lengths / second), finite difference over ~0.1 s to damp jitter.
  const k = Math.max(2, Math.round(fps / 10));
  const speed = S.wr.map((p, i) => (i < k ? 0 : dist(p, S.wr[i - k]) / (k / fps) / L));

  // ---- Address: first stretch where the hands are still -------------------------------
  const need = Math.max(4, Math.round(0.2 * fps));
  let run = 0, aEnd = -1;
  for (let i = k; i < n; i++) {
    run = speed[i] < 0.4 ? run + 1 : 0;
    if (run >= need) { aEnd = i; break; }
  }
  let aStart;
  if (aEnd < 0) {
    warnings.push('Could not find a still address position; the first moments of the clip were used instead. Hold still for a second before swinging.');
    aStart = 0; aEnd = need;
  } else {
    while (aEnd + 1 < n && speed[aEnd + 1] < 0.5) aEnd++;
    aStart = Math.max(0, aEnd - Math.max(need, Math.round(0.3 * fps)) + 1);
  }
  const win = (arr) => arr.slice(aStart, aEnd + 1);
  const medPt = (pts) => ({ x: median(win(pts).map((p) => p.x)), y: median(win(pts).map((p) => p.y)) });
  const A = { wr: medPt(S.wr), hip: medPt(S.hip), sh: medPt(S.sh), nose: medPt(S.nose), knee: median(win(S.knee)) };

  // Which way is the ball? Hands hang out in front of the hips at address.
  let dir = Math.sign(A.wr.x - A.hip.x);
  if (!dir || Math.abs(A.wr.x - A.hip.x) < 0.1 * L) {
    dir = dir || 1;
    warnings.push('Hands are almost directly over the hips at address, so the ball direction was guessed. Results that depend on direction may be mirrored.');
  }

  // ---- Top of backswing: highest hands before the big drop ----------------------------
  let minY = Infinity, top = -1;
  for (let i = aEnd; i < n; i++) {
    if (S.wr[i].y < minY) { minY = S.wr[i].y; top = i; }
    else if ((S.wr[i].y - minY) / L > 0.3 && (A.wr.y - minY) / L > 0.5) break;
  }
  if (top < 0 || (A.wr.y - minY) / L < 0.5) {
    return fail('no_swing', 'No full swing was found. Make sure the whole swing, including the backswing, is in the clip and your hands are visible.');
  }

  // ---- Backswing start: last frame before top still near address ----------------------
  let start = top;
  while (start > aStart && dist(S.wr[start], A.wr) / L > 0.08) start--;

  // ---- Impact: hands come back down to address height ---------------------------------
  let impact = -1;
  for (let i = top + 1; i < n; i++) {
    if ((S.wr[i].y - A.wr.y) / L >= -0.1) { impact = i; break; }
  }
  if (impact < 0) {
    let best = -1, bs = -1;
    for (let i = top + 1; i < n; i++) if (speed[i] > bs) { bs = speed[i]; best = i; }
    impact = best;
    warnings.push('Impact was estimated from peak hand speed because the hands never returned to address height in view.');
  }
  if (impact <= top + 1) return fail('no_swing', 'Could not find the downswing. Try recording again with the full swing in view.');

  // ---- Metrics -------------------------------------------------------------------------
  const tilt = (sh, hip) => Math.atan2((sh.x - hip.x) * dir, hip.y - sh.y) * DEG;
  const spineAddr = tilt(A.sh, A.hip);
  const spineTop = tilt(S.sh[top], S.hip[top]);
  const spineImpact = tilt(S.sh[impact], S.hip[impact]);

  const hipThrust = ((S.hip[impact].x - A.hip.x) * dir) / L;       // + = toward the ball
  const hipRise = (A.hip.y - S.hip[impact].y) / L;                 // + = hips rose (standing up)

  const signedExtreme = (fn, a, b) => {
    let best = 0;
    for (let i = a; i <= b; i++) { const v = fn(i); if (Math.abs(v) > Math.abs(best)) best = v; }
    return best;
  };
  const headX = signedExtreme((i) => ((S.nose[i].x - A.nose.x) * dir) / L, start, impact);   // + toward ball
  const headY = signedExtreme((i) => (A.nose.y - S.nose[i].y) / L, start, impact);           // + up

  const kneeAddr = A.knee;
  const kneeImpact = S.knee[impact];
  const kneeLoss = kneeImpact - kneeAddr;                          // + = straightened

  const midY = (A.wr.y + minY) / 2;
  const xUp = crossX(S.wr, start, top, midY, true);
  const xDown = crossX(S.wr, top, impact, midY, false);
  const overTheTop = Number.isFinite(xUp) && Number.isFinite(xDown) ? ((xDown - xUp) * dir) / L : 0;

  const backswingS = (top - start) / fps;
  const downswingS = (impact - top) / fps;
  const tempoRatio = backswingS / Math.max(downswingS, 1 / fps);

  const topHandHeight = (S.sh[top].y - S.wr[top].y) / L;           // + = hands above shoulders

  // ---- Quality / warnings --------------------------------------------------------------
  const meanVis = S.vis.slice(aStart, Math.min(n, impact + 1)).reduce((a, b) => a + b, 0) / Math.max(1, impact + 1 - aStart);
  const shSepAddr = median(win(S.shSep).map((v) => v / L));
  const viewHint = shSepAddr > 0.8 ? 'face_on' : 'down_the_line';
  if (viewHint === 'face_on') {
    warnings.push('This looks like a face-on view (both shoulders clearly visible). Posture, hip-thrust and over-the-top checks are tuned for a down-the-line view from behind the golfer, so treat them with caution.');
  }
  if (fps < 60) warnings.push(`Recorded at ${Math.round(fps)} fps. The downswing lasts only ~${Math.max(1, Math.round(downswingS * fps))} frames, so timing is coarse. Use slow-motion 120 or 240 fps if you can.`);
  if (downswingS * fps < 4) warnings.push('The downswing is only a few frames long. Impact timing is rough.');
  if (backswingS < 0.35 || backswingS > 2.5) warnings.push('The backswing time looks unusual. Check that only one swing is in the clip.');
  if (meanVis < 0.5) warnings.push('Some body points were hard to see. Better light and a plain background will improve accuracy.');

  let confidence = Math.max(0, Math.min(1, meanVis));
  if (fps < 60) confidence *= 0.85;
  if (viewHint === 'face_on') confidence *= 0.7;
  if (warnings.length >= 3) confidence *= 0.85;

  const pt = (i) => ({ wr: S.wr[i], hip: S.hip[i], sh: S.sh[i], nose: S.nose[i] });
  return {
    ok: true,
    fps, dir, viewHint,
    confidence: Number(confidence.toFixed(2)),
    warnings,
    phases: {
      address: aEnd, start, top, impact,
      times: { start: frames[start].t, top: frames[top].t, impact: frames[impact].t },
    },
    metrics: {
      tempoRatio, backswingMs: backswingS * 1000, downswingMs: downswingS * 1000,
      spineAddr, spineTop, spineImpact, spineLoss: spineAddr - spineImpact,
      hipThrust, hipRise, headX, headY,
      kneeAddr, kneeImpact, kneeLoss,
      overTheTop, topHandHeight,
      torsoLen: L,
    },
    keyframes: { address: A, top: pt(top), impact: pt(impact) },
  };
}
