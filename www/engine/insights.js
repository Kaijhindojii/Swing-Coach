// Links nerves to swings: do your swings change when your heart rate is up?
// A saved swing looks like { metrics: {tempoRatio, downswingMs, ...}, arousal: {score, level, bpm} | null }.

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

export function nervesVsSwing(swings) {
  const tagged = (swings || []).filter((s) => s?.arousal && Number.isFinite(s.arousal.score) && s.metrics);
  const tense = tagged.filter((s) => s.arousal.score >= 50);
  const calm = tagged.filter((s) => s.arousal.score < 50);
  const out = [];
  if (calm.length < 2 || tense.length < 2) {
    if (tagged.length) out.push(`${tagged.length} swing${tagged.length > 1 ? 's' : ''} recorded with heart rate. Record a few more under pressure to compare calm and tense swings.`);
    return out;
  }
  const dTempo = mean(tense.map((s) => s.metrics.tempoRatio)) - mean(calm.map((s) => s.metrics.tempoRatio));
  const dDown = mean(tense.map((s) => s.metrics.downswingMs)) - mean(calm.map((s) => s.metrics.downswingMs));
  if (dTempo <= -0.3) out.push(`When you are tense your backswing gets rushed: tempo ${mean(tense.map((s) => s.metrics.tempoRatio)).toFixed(1)}:1 against ${mean(calm.map((s) => s.metrics.tempoRatio)).toFixed(1)}:1 when calm.`);
  else if (dTempo >= 0.3) out.push(`When you are tense your downswing gets rushed: tempo ${mean(tense.map((s) => s.metrics.tempoRatio)).toFixed(1)}:1 against ${mean(calm.map((s) => s.metrics.tempoRatio)).toFixed(1)}:1 when calm.`);
  if (dDown <= -40) out.push(`Your downswing is ${Math.round(-dDown)} ms quicker when you are tense.`);
  if (!out.length) out.push('Your tempo holds steady when your heart rate is up. That is a good sign under pressure.');
  return out;
}
