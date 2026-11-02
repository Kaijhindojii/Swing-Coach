import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSwing, DEMO_PRESETS } from '../www/engine/demo.js';
import { analyzeSwing } from '../www/engine/swing.js';
import { coachSwing, coachWithLLM, buildCoachPrompt } from '../www/engine/coach.js';

const run = (opts = {}, profile) => {
  const s = makeSwing(opts);
  const result = analyzeSwing(s.frames, { fps: s.fps, aspect: s.aspect });
  return { s, result, report: coachSwing(result, profile) };
};

test('solid swing: phases are found and nothing major is flagged', () => {
  const { s, result, report } = run();
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.phases.times.top - s.truth.top) < 0.06, 'top of backswing');
  assert.ok(Math.abs(result.phases.times.impact - s.truth.impact) < 0.1, 'impact');
  assert.equal(result.dir, 1);
  assert.equal(result.viewHint, 'down_the_line');
  assert.ok(result.metrics.tempoRatio > 2.0 && result.metrics.tempoRatio < 3.8);
  assert.equal(report.findings.filter((f) => f.severity === 'major').length, 0);
  assert.ok(report.strengths.length >= 2);
  assert.match(report.headline, /Clean swing/);
});

test('early extension is the top finding and sizes the hip travel in cm', () => {
  const { report } = run(DEMO_PRESETS.earlyExtension.opts, { heightCm: 175 });
  assert.equal(report.focus.id, 'early_extension');
  assert.equal(report.focus.severity, 'major');
  assert.match(report.focus.seen, /about 15 cm|about 16 cm|about 14 cm/);   // 0.3 torso lengths of 52.5 cm
  assert.ok(report.focus.drill.length > 20);
  assert.ok(!report.findings.some((f) => f.id === 'head_height'), 'head lift is explained by the posture finding');
});

test('over the top is detected', () => {
  const { report } = run(DEMO_PRESETS.overTheTop.opts);
  assert.equal(report.focus.id, 'over_the_top');
});

test('rushed backswing is flagged as major', () => {
  const { report } = run(DEMO_PRESETS.rushed.opts);
  assert.equal(report.focus.id, 'tempo_rushed');
  assert.equal(report.focus.severity, 'major');
});

test('left-handed golfer: direction is inferred and results match the mirror image', () => {
  const right = run(DEMO_PRESETS.overTheTop.opts);
  const left = run({ ...DEMO_PRESETS.overTheTop.opts, dir: -1 });
  assert.equal(left.result.dir, -1);
  assert.equal(left.report.focus.id, 'over_the_top');
  assert.ok(Math.abs(left.result.metrics.overTheTop - right.result.metrics.overTheTop) < 0.05);
  assert.equal(run({ dir: -1 }).report.findings.length, 0);
});

test('face-on clip: warns and only runs view-independent checks', () => {
  const { result, report } = run({ ...DEMO_PRESETS.earlyExtension.opts, view: 'faceon' });
  assert.equal(result.viewHint, 'face_on');
  assert.ok(report.notes.some((n) => /face-on/.test(n)));
  assert.ok(!report.findings.some((f) => ['early_extension', 'posture_loss', 'over_the_top'].includes(f.id)));
  assert.ok(report.findings.some((f) => f.id === 'leg_flex'));
});

test('30 fps clip works but warns about coarse timing', () => {
  const { result } = run({ fps: 30 });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => /fps/.test(w)));
});

test('240 fps clip analyses to the same answer', () => {
  const slow = run({ fps: 240, ...DEMO_PRESETS.earlyExtension.opts });
  assert.equal(slow.report.focus.id, 'early_extension');
});

test('too-short clip fails with a message the user can act on', () => {
  const s = makeSwing();
  const result = analyzeSwing(s.frames.slice(0, 20), { fps: 60 });
  assert.equal(result.ok, false);
  const report = coachSwing(result);
  assert.equal(report.ok, false);
  assert.match(report.headline, /too short/i);
});

test('no person in frame', () => {
  const frames = Array.from({ length: 200 }, (_, i) => ({ t: i / 60, lm: null }));
  const result = analyzeSwing(frames, { fps: 60 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_person');
});

test('landmark jitter does not change the diagnosis', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { report } = run({ ...DEMO_PRESETS.earlyExtension.opts, noise: 0.003, seed });
    assert.equal(report.focus?.id, 'early_extension', `seed ${seed}`);
  }
});

test('LLM hook: returns text from the proxy, and falls back to null on any failure', async () => {
  const { report } = run(DEMO_PRESETS.earlyExtension.opts);
  const prompt = buildCoachPrompt(report);
  assert.match(prompt, /early_extension/);
  const ok = await coachWithLLM('https://example.test/coach', report, {}, async (_u, init) => {
    assert.match(JSON.parse(init.body).prompt, /PGA teaching professional/);
    return { ok: true, json: async () => ({ text: 'Nice swing.' }) };
  });
  assert.equal(ok, 'Nice swing.');
  assert.equal(await coachWithLLM('https://example.test/coach', report, {}, async () => { throw new Error('offline'); }), null);
  assert.equal(await coachWithLLM('', report), null);
});
