import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArousalEstimator, rmssd, slopePer10s, levelFromScore } from '../www/engine/arousal.js';
import { planFor, breathAt, planSeconds, PLANS, tipsFor } from '../www/engine/calm.js';
import { nervesVsSwing } from '../www/engine/insights.js';
import { parseHeartRateMeasurement, SimulatedSource } from '../www/engine/hr-sources.js';

const feed = (est, from, to, fn) => { for (let t = from; t <= to; t++) est.add({ t, ...fn(t) }); };

test('rmssd and slope helpers', () => {
  assert.ok(Math.abs(rmssd([800, 820, 800, 820]) - 20) < 1e-9);
  assert.ok(Number.isNaN(rmssd([800, 800])));
  const pts = Array.from({ length: 21 }, (_, i) => ({ t: i, bpm: 70 + i * 0.5 }));   // +5 bpm per 10 s
  assert.ok(Math.abs(slopePer10s(pts) - 5) < 1e-9);
  assert.ok(Number.isNaN(slopePer10s(pts.slice(0, 3))));
});

test('no samples -> no signal; implausible values are rejected', () => {
  const e = new ArousalEstimator();
  assert.equal(e.state().status, 'no_signal');
  assert.equal(e.add({ t: 1, bpm: 12 }), false);
  assert.equal(e.add({ t: 1, bpm: 300 }), false);
  assert.equal(e.add({ t: NaN, bpm: 70 }), false);
  assert.equal(e.state().status, 'no_signal');
});

test('learns a baseline from still data, then reads calm', () => {
  const e = new ArousalEstimator();
  feed(e, 0, 10, () => ({ bpm: 70 }));
  const s = e.state();
  assert.equal(s.status, 'calibrating');
  assert.ok(s.progress < 1);
  feed(e, 11, 60, (t) => ({ bpm: 68 + (t % 3) }));
  const r = e.state();
  assert.equal(r.status, 'ok');
  assert.equal(r.baselineSource, 'learned');
  assert.equal(r.level, 'calm');
  assert.ok(r.score < 25);
});

test('walking gives no verdict and does not corrupt the baseline', () => {
  const e = new ArousalEstimator({ restingHR: 60 });
  feed(e, 0, 40, () => ({ bpm: 98, still: false }));
  assert.equal(e.state().status, 'moving');
  feed(e, 41, 60, () => ({ bpm: 68, still: true }));
  const r = e.state();
  assert.equal(r.status, 'ok');
  assert.equal(r.level, 'calm');
});

test('after walking, a still-high heart rate reads "settling", not nervous', () => {
  const e = new ArousalEstimator({ restingHR: 60 });
  feed(e, 0, 40, () => ({ bpm: 70 }));
  feed(e, 41, 70, () => ({ bpm: 98, still: false }));              // walk to the ball
  feed(e, 71, 80, () => ({ bpm: 92, still: true }));               // just stopped, HR still high
  const s = e.state();
  assert.equal(s.status, 'settling', JSON.stringify(s));
  assert.ok(s.progress > 0 && s.progress < 1);
  assert.equal(tipsFor(s)[0].id, 'settling');
  feed(e, 81, 100, () => ({ bpm: 92, still: true }));              // still high 30 s later: now it counts
  assert.equal(e.state().status, 'ok');
});

test('a pressure spike against a resting HR from health data reads high', () => {
  const e = new ArousalEstimator({ restingHR: 62 });
  feed(e, 0, 30, () => ({ bpm: 70 }));
  const calm = e.state();
  assert.equal(calm.level, 'calm', JSON.stringify(calm));
  feed(e, 31, 60, (t) => ({ bpm: 70 + (t - 30) * 1.0 }));          // 70 -> 100 over 30 s
  const hot = e.state();
  assert.ok(hot.score >= 75, JSON.stringify(hot));
  assert.equal(hot.level, 'high');
  assert.equal(hot.trend, 'rising');
  assert.equal(hot.baselineSource, 'resting');
});

test('same high heart rate that is flat reads lower than one that is still climbing', () => {
  const a = new ArousalEstimator({ restingHR: 62 });
  feed(a, 0, 60, () => ({ bpm: 88 }));
  const b = new ArousalEstimator({ restingHR: 62 });
  feed(b, 0, 40, () => ({ bpm: 70 }));
  feed(b, 41, 60, (t) => ({ bpm: 70 + (t - 40) * 0.9 }));
  assert.ok(b.state().score > a.state().score);
});

test('HRV drop raises the score when RR intervals are available', () => {
  const mk = (variability) => {
    const e = new ArousalEstimator({ restingHR: 62, baselineRMSSD: 50 });
    for (let t = 0; t <= 60; t++) {
      const rr = [800 + (t % 2 ? variability : -variability), 800 + (t % 2 ? -variability : variability)];
      e.add({ t, bpm: 76, rr });
    }
    return e.state();
  };
  const relaxed = mk(25), tense = mk(3);
  assert.equal(relaxed.usedHrv, true);
  assert.ok(tense.score > relaxed.score, `${tense.score} vs ${relaxed.score}`);
  assert.ok(tense.rmssd < relaxed.rmssd);
});

test('score bands', () => {
  assert.deepEqual([0, 24, 25, 49, 50, 74, 75, 100].map(levelFromScore),
    ['calm', 'calm', 'steady', 'steady', 'elevated', 'elevated', 'high', 'high']);
});

test('simulated round: calm -> walking -> pressure -> recovery', () => {
  const e = new ArousalEstimator({ restingHR: 62 });
  const at = (k) => { const v = SimulatedSource.valueAt(k); e.add({ t: k, ...v }); };
  for (let k = 0; k <= 44; k++) at(k);
  assert.equal(e.state().level, 'calm');
  for (let k = 45; k <= 74; k++) at(k);
  assert.equal(e.state().status, 'moving');
  for (let k = 75; k <= 134; k++) at(k);
  const pressure = e.state();
  assert.ok(['elevated', 'high'].includes(pressure.level), JSON.stringify(pressure));
  for (let k = 135; k <= 199; k++) at(k);
  assert.ok(e.state().score < pressure.score);
});

test('breathing pacer clock', () => {
  const p = PLANS.settle;
  assert.equal(planSeconds(p), 60);
  assert.equal(breathAt(p, 0).phase, 'inhale');
  assert.ok(breathAt(p, 0).scale < 0.45);
  assert.equal(breathAt(p, 3.9).phase, 'inhale');
  assert.ok(breathAt(p, 3.99).scale > 0.95);
  assert.equal(breathAt(p, 4.1).phase, 'exhale');
  assert.equal(breathAt(p, 10).phase, 'inhale');
  assert.equal(breathAt(p, 10).cycle, 2);
  assert.equal(breathAt(p, 60).done, true);
  assert.equal(breathAt(p, 0).remainingS, 60);
  const withHold = { ...p, holdS: 2 };
  assert.equal(breathAt(withHold, 5).phase, 'hold');
});

test('plans and tips follow the reading', () => {
  assert.equal(planFor('high', 'flat').id, 'reset');
  assert.equal(planFor('elevated', 'flat').id, 'settle');
  assert.equal(tipsFor({ status: 'ok', level: 'calm', trend: 'flat' })[0].id, 'settled');
  const high = tipsFor({ status: 'ok', level: 'high', trend: 'rising' });
  assert.ok(high.length >= 2 && high.length <= 3);
  assert.equal(new Set(high.map((t) => t.id)).size, high.length);
  assert.ok(high.some((t) => t.id === 'breathe'));
  assert.equal(tipsFor({ status: 'moving' })[0].id, 'moving');
  assert.equal(tipsFor({ status: 'calibrating' })[0].id, 'calibrating');
  assert.deepEqual(tipsFor({ status: 'no_signal' }), []);
  assert.deepEqual(tipsFor(null), []);
});

test('Bluetooth heart-rate measurement parsing', () => {
  const dv = (bytes) => new DataView(new Uint8Array(bytes).buffer);
  assert.deepEqual(parseHeartRateMeasurement(dv([0x00, 72])), { bpm: 72, rr: [], contact: null });
  // 16-bit bpm = 300, contact supported & detected
  assert.equal(parseHeartRateMeasurement(dv([0x07, 0x2c, 0x01])).bpm, 300);
  assert.equal(parseHeartRateMeasurement(dv([0x07, 0x2c, 0x01])).contact, true);
  assert.equal(parseHeartRateMeasurement(dv([0x04, 70])).contact, false);
  // RR present: 1024 units = 1000 ms, 512 = 500 ms
  const m = parseHeartRateMeasurement(dv([0x10, 70, 0x00, 0x04, 0x00, 0x02]));
  assert.deepEqual(m.rr, [1000, 500]);
  // energy expended + RR
  assert.deepEqual(parseHeartRateMeasurement(dv([0x18, 60, 0x10, 0x00, 0x00, 0x04])).rr, [1000]);
});

test('nerves vs swing insight', () => {
  const sw = (score, tempoRatio, downswingMs) => ({ arousal: { score, level: 'x', bpm: 80 }, metrics: { tempoRatio, downswingMs } });
  assert.deepEqual(nervesVsSwing([]), []);
  assert.match(nervesVsSwing([sw(10, 3, 300)])[0], /1 swing recorded/);
  const msgs = nervesVsSwing([sw(10, 3.0, 300), sw(20, 2.9, 310), sw(70, 2.0, 250), sw(80, 2.1, 240)]);
  assert.match(msgs[0], /backswing gets rushed/);
  assert.ok(msgs.some((m) => /quicker/.test(m)));
  const quick = nervesVsSwing([sw(10, 2.5, 300), sw(20, 2.6, 300), sw(70, 3.4, 300), sw(80, 3.3, 300)]);
  assert.match(quick[0], /downswing gets rushed/);
  assert.match(nervesVsSwing([sw(10, 3, 300), sw(20, 3, 300), sw(70, 3, 300), sw(80, 3.1, 300)])[0], /holds steady/);
  assert.deepEqual(nervesVsSwing([{ arousal: null, metrics: {} }]), []);
});
