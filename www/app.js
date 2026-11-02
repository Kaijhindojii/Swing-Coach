import { analyzeSwing } from './engine/swing.js';
import { coachSwing, coachWithLLM, DEFAULT_PROFILE } from './engine/coach.js';
import { makeSwing, DEMO_PRESETS } from './engine/demo.js';
import { ArousalEstimator } from './engine/arousal.js';
import { PLANS, planFor, breathAt, tipsFor, LEVEL_TEXT } from './engine/calm.js';
import { nervesVsSwing } from './engine/insights.js';
import { WatchSource, BluetoothSource, SimulatedSource } from './engine/hr-sources.js';

const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.id); toast.id = setTimeout(() => { t.hidden = true; }, 3500); };

let profile = { ...DEFAULT_PROFILE, ...store.get('sc.profile', {}) };
let history = store.get('sc.history', []);

/* ------------------------------------------------------------------ tabs */
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
  if (name === 'history') renderHistory();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

/* ---------------------------------------------------------------- settings */
$('btnSettings').addEventListener('click', () => {
  $('sHeight').value = profile.heightCm ?? '';
  $('sHandicap').value = profile.handicap ?? '';
  $('sEndpoint').value = profile.coachEndpoint ?? '';
  $('settings').showModal();
});
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const ht = Number($('sHeight').value);
  const hc = $('sHandicap').value === '' ? null : Number($('sHandicap').value);
  profile = { ...profile, heightCm: ht >= 120 && ht <= 230 ? ht : DEFAULT_PROFILE.heightCm, handicap: hc, coachEndpoint: $('sEndpoint').value.trim() || null };
  store.set('sc.profile', profile);
  toast('Settings saved');
});

/* ------------------------------------------------------------------- swing */
$('fps').value = String(store.get('sc.fps', 60));
$('fps').addEventListener('change', () => store.set('sc.fps', Number($('fps').value)));

for (const [key, p] of Object.entries(DEMO_PRESETS)) {
  $('demoButtons').append(h('button', { class: 'btn', type: 'button', 'data-demo': key }, p.label));
}
$('demoButtons').addEventListener('click', (e) => {
  const key = e.target?.dataset?.demo;
  if (!key) return;
  const s = makeSwing(DEMO_PRESETS[key].opts);
  finishAnalysis(s.frames, { fps: s.fps, aspect: s.aspect }, currentArousal(), [`Demo swing (${DEMO_PRESETS[key].label}). This is generated data, not your swing.`]);
});

for (const id of ['videoInput', 'videoPick']) {
  $(id).addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) await analyseFile(file);
  });
}

function setBusy(on, text) {
  $('progress').hidden = !on;
  $('progressBar').style.width = '0%';
  $('progressText').textContent = text || 'Working…';
  for (const b of document.querySelectorAll('#tab-swing .btn, #tab-swing select')) b.toggleAttribute('disabled', on);
  $('videoInput').disabled = on; $('videoPick').disabled = on;
}
function showError(msg) { const e = $('swingError'); e.textContent = msg || ''; e.hidden = !msg; }

async function analyseFile(file) {
  showError('');
  setBusy(true, 'Loading the pose model…');
  try {
    const { extractFrames } = await import('./engine/pose.js');
    const fps = Number($('fps').value);
    const ex = await extractFrames(file, {
      fps,
      onProgress: (p) => { $('progressBar').style.width = `${Math.round(p * 100)}%`; $('progressText').textContent = `Finding your body in each frame… ${Math.round(p * 100)}%`; },
    });
    const notes = [];
    if (ex.duration > ex.analysedSeconds + 0.5) notes.push(`Only the first ${Math.round(ex.analysedSeconds)} seconds of the clip were analysed. Trim the video to one swing for best results.`);
    finishAnalysis(ex.frames, { fps: ex.fps, aspect: ex.aspect }, arousalForFile(file), notes);
  } catch (err) {
    showError(err && err.message ? err.message : 'Something went wrong reading the video.');
  } finally {
    setBusy(false);
  }
}

function finishAnalysis(frames, opts, arousal, extraNotes = []) {
  showError('');
  const result = analyzeSwing(frames, opts);
  const report = coachSwing(result, profile);
  if (report.ok) report.notes.push(...extraNotes);
  renderResult(result, report, arousal);
  if (report.ok) {
    history.unshift({
      id: Date.now(), ts: Date.now(), headline: report.headline, focus: report.focus?.title || null,
      metrics: result.metrics, confidence: result.confidence, arousal: arousal || null,
    });
    history = history.slice(0, 60);
    store.set('sc.history', history);
    if (profile.coachEndpoint) {
      coachWithLLM(profile.coachEndpoint, report, profile).then((text) => {
        if (text) $('result').prepend(h('div', { class: 'card' }, h('h2', {}, 'Coach says'), ...text.split(/\n{2,}/).map((p) => h('p', {}, p))));
      });
    }
  }
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const r0 = (v) => Math.round(v);
function renderResult(result, report, arousal) {
  const root = $('result');
  root.replaceChildren();
  if (!report.ok) {
    root.append(h('div', { class: 'card' }, h('div', { class: 'headline' }, 'Could not analyse that clip'), h('p', {}, report.headline)));
    return;
  }
  const head = h('div', { class: 'card' },
    h('div', { class: 'headline' }, report.headline),
    h('span', { class: 'pill' }, `Confidence ${Math.round(report.confidence * 100)}%`));
  if (arousal) head.append(h('p', { class: 'note' }, `Heart rate when you swung: ${arousal.bpm} bpm (${LEVEL_TEXT[arousal.level] || arousal.level}).`));
  root.append(head);

  if (result.keyframes) {
    const names = [['address', 'Address'], ['top', 'Top'], ['impact', 'Impact']];
    const canvases = names.map(([k, label]) => ({ k, label, canvas: h('canvas', { width: 240, height: 300, 'aria-label': `${label} position` }) }));
    root.append(h('div', { class: 'card' }, h('h2', {}, 'Your positions'),
      h('div', { class: 'frames' }, canvases.map(({ label, canvas }) => h('figure', {}, canvas, h('figcaption', {}, label)))),
      h('p', { class: 'note' }, 'Faint figure = address. Compare how the hips, shoulders and head move.')));
    drawFrames(canvases, result);
  }

  report.findings.forEach((f, i) => {
    root.append(h('div', { class: 'card finding' },
      h('span', { class: `pill ${f.severity}` }, i === 0 ? `Focus · ${f.severity}` : f.severity),
      h('h3', {}, f.title),
      h('dl', {},
        h('dt', {}, 'What I see'), h('dd', {}, f.seen),
        h('dt', {}, 'Why it matters'), h('dd', {}, f.why),
        h('dt', {}, 'Try this'), h('dd', {}, f.fix),
        h('dt', {}, 'Drill'), h('dd', {}, f.drill),
        h('dt', {}, 'Target'), h('dd', {}, f.target))));
  });
  if (report.strengths.length) root.append(h('div', { class: 'card' }, h('h2', {}, 'What is working'), report.strengths.map((s) => h('p', { class: 'strength' }, `✓ ${s}`))));

  const m = result.metrics;
  const cmPer = (profile.heightCm || 175) * 0.3;
  const met = (label, value) => h('div', { class: 'metric' }, h('b', {}, value), h('span', {}, label));
  root.append(h('div', { class: 'card' }, h('h2', {}, 'The numbers'), h('div', { class: 'metrics' },
    met('Tempo (back : down)', `${m.tempoRatio.toFixed(1)} : 1`),
    met('Backswing / downswing', `${r0(m.backswingMs)} / ${r0(m.downswingMs)} ms`),
    met('Spine tilt address → impact', `${r0(m.spineAddr)}° → ${r0(m.spineImpact)}°`),
    met('Hip travel toward ball', `${r0(m.hipThrust * cmPer)} cm`),
    met('Head height change', `${r0(m.headY * cmPer)} cm`),
    met('Knee flex change', `${r0(m.kneeLoss)}°`))));

  if (report.notes.length) root.append(h('div', { class: 'card' }, h('h2', {}, 'Notes'), report.notes.map((n) => h('p', { class: 'note' }, n))));
}

function drawFrames(items, result) {
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim() || '#000';
  const accent = css.getPropertyValue('--accent').trim() || '#1f8a4c';
  const muted = css.getPropertyValue('--muted').trim() || '#888';
  const kf = result.keyframes;
  const pts = (k) => [k.hip, k.sh, k.nose, k.wr];
  const all = ['address', 'top', 'impact'].flatMap((n) => pts(kf[n]));
  const minX = Math.min(...all.map((p) => p.x)), maxX = Math.max(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y)), maxY = Math.max(...all.map((p) => p.y));
  const pad = 0.06, w = maxX - minX + pad * 2, hgt = maxY - minY + pad * 2;
  for (const { k, canvas } of items) {
    const c = canvas.getContext('2d');
    const s = Math.min(canvas.width / w, canvas.height / hgt);
    const ox = (canvas.width - w * s) / 2, oy = (canvas.height - hgt * s) / 2;
    const P = (p) => [ox + (p.x - minX + pad) * s, oy + (p.y - minY + pad) * s];
    const figure = (f, color, width, alpha) => {
      c.globalAlpha = alpha; c.strokeStyle = color; c.fillStyle = color; c.lineWidth = width; c.lineCap = 'round';
      const [hx, hy] = P(f.hip), [sx, sy] = P(f.sh), [nx, ny] = P(f.nose), [wx, wy] = P(f.wr);
      c.beginPath(); c.moveTo(hx, hy); c.lineTo(sx, sy); c.lineTo(wx, wy); c.stroke();
      c.beginPath(); c.arc(nx, ny, 7, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(hx, hy, 5, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(wx, wy, 5, 0, Math.PI * 2); c.fill();
    };
    c.clearRect(0, 0, canvas.width, canvas.height);
    if (k !== 'address') figure(kf.address, muted, 3, 0.45);
    figure(kf[k], k === 'address' ? ink : accent, 4, 1);
    c.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------------ nerves */
const SOURCES = [];
if (WatchSource.supported) SOURCES.push({ id: 'watch', label: 'Apple Watch' });
if (BluetoothSource.supported) SOURCES.push({ id: 'ble', label: 'Bluetooth strap' });
SOURCES.push({ id: 'sim', label: 'Simulated round' });
for (const s of SOURCES) $('sources').append(h('button', { class: 'btn', type: 'button', 'data-source': s.id }, s.label));
$('sources').append(h('button', { class: 'btn danger', type: 'button', id: 'btnDisconnect', hidden: true }, 'Disconnect'));
if (!WatchSource.supported) $('sourceStatus').textContent = 'Apple Watch heart rate works in the iPhone app. In a browser you can use a Bluetooth strap or the simulated round.';
$('breathCard').hidden = false;

let source = null, est = null, ticker = null, lastState = null, lastAlertAt = 0;

$('sources').addEventListener('click', (e) => {
  if (e.target.id === 'btnDisconnect') return disconnect();
  const id = e.target?.dataset?.source;
  if (id) connect(id);
});

async function disconnect() {
  clearInterval(ticker); ticker = null;
  if (source) { try { await source.stop(); } catch { /* ignore */ } }
  source = null; est = null; lastState = null;
  $('gaugeCard').hidden = true; $('alertBanner').hidden = true; $('tips').replaceChildren();
  $('btnDisconnect').hidden = true;
  for (const b of document.querySelectorAll('[data-source]')) b.disabled = false;
}

async function connect(id) {
  await disconnect();
  $('sourceStatus').textContent = 'Connecting…';
  try {
    source = id === 'watch' ? new WatchSource(WatchSource.getPlugin()) : id === 'ble' ? new BluetoothSource() : new SimulatedSource({ speed: 4 });
    est = new ArousalEstimator();
    const name = await source.start((s) => est && est.add(s), (st) => {
      const text = { connected: 'Connected', watch_ready: 'Watch found. Open SwingCoach on the watch if it does not start.', watch_unreachable: 'Watch not reachable. Check it is on your wrist and nearby.', disconnected: 'Sensor disconnected.' }[st];
      if (text) $('sourceStatus').textContent = text;
    });
    // Read resting HR only now: start() is what asks for Health permission, so asking earlier
    // returns nothing on the first run.
    if (id === 'watch') { const r = await source.restingHR(); if (r && est) est.setRestingHR(r); }
    $('sourceStatus').textContent = id === 'sim' ? 'Simulated round: calm, walking, a pressure moment, then recovery (4× speed).' : `Connected to ${name}.`;
    $('btnDisconnect').hidden = false;
    for (const b of document.querySelectorAll('[data-source]')) b.disabled = true;
    $('gaugeCard').hidden = false;
    renderNerves();
    ticker = setInterval(renderNerves, 1000);
  } catch (err) {
    $('sourceStatus').textContent = err && err.message ? err.message : 'Could not connect.';
    await disconnect();
  }
}

function renderNerves() {
  if (!est) return;
  const st = est.state();
  lastState = st;
  const arc = $('gaugeArc');
  const C = 326.7;
  if (st.status === 'ok') {
    arc.style.strokeDashoffset = String(C * (1 - st.score / 100));
    arc.style.stroke = `var(--${st.level})`;
    $('gBpm').textContent = st.bpm;
    $('gLevel').textContent = LEVEL_TEXT[st.level];
    $('gLevel').style.color = `var(--${st.level})`;
    const arrow = st.trend === 'rising' ? ' ↑ rising' : st.trend === 'falling' ? ' ↓ falling' : '';
    $('gDetail').textContent = `${st.elevationPct >= 0 ? '+' : ''}${st.elevationPct}% vs your calm ${st.baseline} bpm${arrow}`;
    $('gauge').setAttribute('aria-label', `Nerves: ${LEVEL_TEXT[st.level]}, ${st.bpm} beats per minute`);
  } else {
    arc.style.strokeDashoffset = String(C);
    $('gBpm').textContent = st.bpm ?? '--';
    $('gLevel').style.color = '';
    $('gLevel').textContent = { moving: 'Walking', settling: 'Settling…', calibrating: 'Learning…', no_signal: 'Waiting…' }[st.status] || '--';
    $('gDetail').textContent = st.status === 'calibrating' ? `Stand still to learn your baseline (${Math.round(st.progress * 100)}%)`
      : st.status === 'moving' ? 'Nerves are only read while you stand still.'
      : st.status === 'settling' ? 'Letting your heart rate come down after the walk.'
      : 'Waiting for heart-rate data.';
  }

  const tipsBox = $('tips');
  tipsBox.replaceChildren(...tipsFor(st).map((t) => h('div', { class: 'card tip' }, h('h3', {}, t.title), h('p', { class: 'muted' }, t.body))));

  const banner = $('alertBanner');
  const hot = st.status === 'ok' && (st.level === 'elevated' || st.level === 'high');
  banner.hidden = !hot;
  if (hot) {
    banner.textContent = `Your heart rate is ${st.elevationPct}% above calm. Take a few slow breaths before you hit.`;
    const now = Date.now();
    if (now - lastAlertAt > 90000) { lastAlertAt = now; source?.haptic?.('nudge'); }
  }
}

function currentArousal() {
  return snapshot(est && est.state());
}
function snapshot(st) {
  return st && st.status === 'ok' ? { score: st.score, level: st.level, bpm: st.bpm } : null;
}
/** The reading at the time the video was recorded, when we have heart-rate history for that moment. */
function arousalForFile(file) {
  if (!est || !est.samples.length) return null;
  const t = (file.lastModified || 0) / 1000;
  const first = est.samples[0].t, last = est.samples[est.samples.length - 1].t;
  const real = source && !(source instanceof SimulatedSource);
  return snapshot(real && t >= first && t <= last ? est.state(t) : est.state());
}

/* breathing pacer */
let breath = null;
$('btnBreathe').addEventListener('click', () => {
  if (breath) return stopBreathing('Stopped');
  const plan = lastState && lastState.status === 'ok' ? planFor(lastState.level, lastState.trend) : PLANS.settle;
  breath = { plan, start: performance.now(), phase: null };
  $('btnBreathe').textContent = 'Stop';
  requestAnimationFrame(stepBreath);
});
function stepBreath(now) {
  if (!breath) return;
  const b = breathAt(breath.plan, (now - breath.start) / 1000);
  if (b.done) return stopBreathing('Nice. Take that calm into your routine.');
  $('pacer').style.transform = `scale(${b.scale})`;
  $('pacerText').textContent = { inhale: 'Breathe in', hold: 'Hold', exhale: 'Breathe out' }[b.phase];
  $('pacerSub').textContent = `Breath ${b.cycle} of ${breath.plan.cycles} · ${b.remainingS}s left`;
  if (b.phase !== breath.phase) { breath.phase = b.phase; source?.haptic?.(b.phase === 'inhale' ? 'breatheIn' : b.phase === 'exhale' ? 'breatheOut' : 'nudge'); }
  requestAnimationFrame(stepBreath);
}
function stopBreathing(msg) {
  breath = null;
  $('btnBreathe').textContent = 'Start breathing';
  $('pacer').style.transform = 'scale(.4)';
  $('pacerText').textContent = 'Ready';
  $('pacerSub').textContent = msg;
}

/* ----------------------------------------------------------------- history */
function renderHistory() {
  const list = $('historyList');
  list.replaceChildren(...history.map((s) => h('li', {},
    h('div', { class: 'when' }, new Date(s.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })),
    h('div', {}, s.focus || 'Clean swing'),
    h('div', { class: 'note' }, `Tempo ${s.metrics.tempoRatio.toFixed(1)}:1${s.arousal ? ` · ${s.arousal.bpm} bpm (${LEVEL_TEXT[s.arousal.level]})` : ''}`))));
  $('historyEmpty').hidden = history.length > 0;
  $('btnClear').hidden = history.length === 0;
  const ins = nervesVsSwing(history);
  $('insightCard').hidden = ins.length === 0;
  $('insightList').replaceChildren(...ins.map((t) => h('li', {}, t)));
}
$('btnClear').addEventListener('click', () => {
  if (!confirm('Delete all saved swings?')) return;
  history = []; store.set('sc.history', history); renderHistory();
});

showTab('swing');

/* Offline support when running as a website (not inside the native iOS/Android shell). */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !globalThis.Capacitor?.isNativePlatform?.()) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
