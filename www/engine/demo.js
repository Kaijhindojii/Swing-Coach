// Synthetic swing generator. Produces MediaPipe-style landmark frames for a down-the-line view so
// the engine, the tests and the in-app demo mode all work without a camera or a real golfer.
// Units: normalised image coords (y grows downward). L = torso length.

const L = 0.15;
const D2R = Math.PI / 180;

function rng(seed) {                      // mulberry32: deterministic jitter for repeatable tests
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (u) => u * u * (3 - 2 * u);
const clamp01 = (u) => Math.max(0, Math.min(1, u));

export const DEMO_PRESETS = {
  solid:          { label: 'Solid swing',      opts: {} },
  earlyExtension: { label: 'Early extension',  opts: { hipThrust: 0.3, spineLoss: 16, hipRise: 0.12, kneeLoss: 16, headUp: 0.15 } },
  overTheTop:     { label: 'Over the top',     opts: { overTheTop: 0.38 } },
  rushed:         { label: 'Rushed tempo',     opts: { backswingS: 0.55, downswingS: 0.34 } },
};

/**
 * @param opts fps, backswingS, downswingS, spineAddr (deg), spineLoss (deg), hipThrust (L toward ball),
 *             hipRise (L), headToward (L), headUp (L), kneeAddr/kneeLoss (deg), overTheTop (L),
 *             topHands (L above shoulders), view 'dtl'|'faceon', dir +1|-1, noise, seed
 */
export function makeSwing(opts = {}) {
  const o = {
    fps: 60, backswingS: 0.9, downswingS: 0.3, addressS: 1.2, followS: 0.8,
    spineAddr: 35, spineLoss: 0, hipThrust: 0, hipRise: 0, headToward: 0, headUp: 0,
    kneeAddr: 160, kneeLoss: 0, overTheTop: 0, topHands: 0.25,
    view: 'dtl', dir: 1, noise: 0.0008, seed: 7, ...opts,
  };
  const { dir, fps } = o;
  const rand = rng(o.seed);
  const jit = () => (rand() - 0.5) * 2 * o.noise;

  const hip0 = { x: dir > 0 ? 0.40 : 0.60, y: 0.5 };
  const sh0 = { x: hip0.x + dir * Math.sin(o.spineAddr * D2R) * L, y: hip0.y - Math.cos(o.spineAddr * D2R) * L };
  const A = { x: hip0.x + dir * 0.6 * L, y: hip0.y - 0.03 };                     // hands at address
  const T = { x: hip0.x - dir * 0.02, y: sh0.y - o.topHands * L };               // hands at top
  const F = { x: hip0.x - dir * 0.06, y: sh0.y - 0.45 * L };                     // hands at finish
  const shSep = o.view === 'faceon' ? 0.19 : 0.02;

  const tTop = o.addressS + o.backswingS;
  const tImp = tTop + o.downswingS;
  const total = tImp + o.followS;
  const n = Math.round(total * fps);

  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    let f = 0, v = 0, follow = 0;                       // f: hands progress A(0)->T(1); v: downswing 0..1
    if (t >= o.addressS && t < tTop) f = smooth((t - o.addressS) / o.backswingS);
    else if (t >= tTop && t < tImp) { v = (t - tTop) / o.downswingS; f = 1 - v * v; }
    else if (t >= tImp) { v = 1; f = 0; follow = clamp01((t - tImp) / o.followS); }

    // hands
    let wr = { x: A.x + f * (T.x - A.x), y: A.y + f * (T.y - A.y) };
    if (t >= tTop && t < tImp) wr.x += dir * o.overTheTop * L * 4 * f * (1 - f);
    if (follow > 0) { const e = 1 - (1 - follow) ** 2; wr = { x: A.x + e * (F.x - A.x), y: A.y + e * (F.y - A.y) }; }

    // body
    const hip = { x: hip0.x + dir * o.hipThrust * L * v, y: hip0.y - o.hipRise * L * v };
    const spine = (o.spineAddr - o.spineLoss * v) * D2R;
    const sh = { x: hip.x + dir * Math.sin(spine) * L, y: hip.y - Math.cos(spine) * L };
    const nose = {
      x: sh.x + dir * 0.035 + dir * o.headToward * L * v,
      y: sh.y - 0.065 - o.headUp * L * v,
    };
    const kneeAng = (o.kneeAddr + o.kneeLoss * v) * D2R;
    const thigh = 0.14;
    const d = 2 * thigh * Math.sin(kneeAng / 2);
    const ankle = { x: hip.x, y: hip.y + d };
    const knee = { x: hip.x + dir * thigh * Math.cos(kneeAng / 2), y: hip.y + d / 2 };

    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
    const put = (idx, p, dx = 0) => { lm[idx] = { x: p.x + dx + jit(), y: p.y + jit(), z: 0, visibility: 0.9 }; };
    put(0, nose);
    put(11, sh, -shSep / 2); put(12, sh, shSep / 2);
    put(13, { x: (sh.x + wr.x) / 2, y: (sh.y + wr.y) / 2 }); put(14, { x: (sh.x + wr.x) / 2, y: (sh.y + wr.y) / 2 });
    put(15, wr, -0.01); put(16, wr, 0.01);
    put(23, hip, -0.01); put(24, hip, 0.01);
    put(25, knee, -0.01); put(26, knee, 0.01);
    put(27, ankle, -0.01); put(28, ankle, 0.01);
    frames.push({ t, lm });
  }
  return { frames, fps, aspect: 1, truth: { top: tTop, impact: tImp, backswingS: o.backswingS, downswingS: o.downswingS } };
}
