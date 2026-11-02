// Calm-down coaching: what to do about a reading. Breathing plans, a pacer clock, and pre-shot tips.
// Not medical advice. Slow breathing with a longer exhale is a common, low-risk way to settle down.

/** Breathing plans. Times in seconds. */
export const PLANS = {
  settle: { id: 'settle', label: 'Settle', inhaleS: 4, holdS: 0, exhaleS: 6, cycles: 6,
    blurb: 'About 6 breaths a minute, longer out than in. Takes one minute.' },
  reset: { id: 'reset', label: 'Reset', inhaleS: 4, holdS: 0, exhaleS: 7, cycles: 9,
    blurb: 'Slightly longer exhale for a racing heart. Takes about 100 seconds.' },
  sigh: { id: 'sigh', label: 'Quick sigh', inhaleS: 3, holdS: 0, exhaleS: 8, cycles: 3,
    blurb: 'Three slow breaths out when you only have a moment on the tee.' },
};

export function planFor(level, trend) {
  if (level === 'high') return PLANS.reset;
  if (level === 'elevated' && trend === 'rising') return PLANS.reset;
  if (level === 'elevated') return PLANS.settle;
  return PLANS.settle;
}

export const planSeconds = (p) => (p.inhaleS + p.holdS + p.exhaleS) * p.cycles;

/**
 * Where we are in the breathing exercise `t` seconds after it started.
 * progress is 0..1 inside the current phase; scale is 0..1 for drawing the circle (grows on the inhale).
 */
export function breathAt(plan, t) {
  const cycleLen = plan.inhaleS + plan.holdS + plan.exhaleS;
  const total = cycleLen * plan.cycles;
  if (t >= total) return { done: true, phase: 'done', progress: 1, scale: 0.4, cycle: plan.cycles, remainingS: 0 };
  const cycle = Math.floor(t / cycleLen);
  const u = t - cycle * cycleLen;
  const ease = (x) => x * x * (3 - 2 * x);
  let phase, progress, scale;
  if (u < plan.inhaleS) { phase = 'inhale'; progress = u / plan.inhaleS; scale = 0.4 + 0.6 * ease(progress); }
  else if (u < plan.inhaleS + plan.holdS) { phase = 'hold'; progress = (u - plan.inhaleS) / plan.holdS; scale = 1; }
  else { phase = 'exhale'; progress = (u - plan.inhaleS - plan.holdS) / plan.exhaleS; scale = 1 - 0.6 * ease(progress); }
  return { done: false, phase, progress, scale, cycle: cycle + 1, remainingS: Math.ceil(total - t) };
}

const TIPS = {
  breathe: (plan) => ({
    id: 'breathe', title: `Breathe: ${plan.inhaleS} in, ${plan.exhaleS} out`,
    body: `Breathe in through your nose for ${plan.inhaleS} seconds, then out slowly through pursed lips for ${plan.exhaleS}. Do ${plan.cycles} breaths. The long exhale is what slows your heart.`,
  }),
  shoulders: { id: 'shoulders', title: 'Drop your shoulders and soften your grip',
    body: 'Let your shoulders sink on the exhale. Hold the club at about 4 out of 10 pressure. Tension in the hands shows up as a rushed swing.' },
  routine: { id: 'routine', title: 'Run your pre-shot routine in full',
    body: 'Pick the target, take one practice swing, settle, then go. When nerves rise, players skip steps. A fixed routine gives your mind a job.' },
  process: { id: 'process', title: 'Pick one swing thought, not an outcome',
    body: 'Choose a single feel, for example "smooth to the top". Thinking about the hazard or the score gives your nerves more to work with.' },
  slowdown: { id: 'slowdown', title: 'Take an extra five seconds',
    body: 'Your heart rate is climbing fast. Step back from the ball, look at the horizon, and take two slow breaths before you start your routine again.' },
  tempo: { id: 'tempo', title: 'Start the swing with the count',
    body: 'Count "one-two-three" on the way back and "hit" on the way down. A steady count keeps the swing from speeding up under pressure.' },
  settled: { id: 'settled', title: 'You look settled. Stay with your routine',
    body: 'Heart rate is close to your baseline. Do the same routine as always and commit to the shot.' },
};

/**
 * Up to three tips for a reading from ArousalEstimator.state().
 * Returns [] when there is no reading to act on.
 */
export function tipsFor(state) {
  if (!state) return [];
  if (state.status === 'moving') return [{ id: 'moving', title: 'Walking', body: 'Nerves are only checked while you are standing still. Stop at the ball and the reading will update.' }];
  if (state.status === 'settling') return [{ id: 'settling', title: 'Letting your heart rate settle', body: 'Your heart rate is still coming down from the walk, so it is not read as nerves yet. Use the time to pick your target and take a practice swing.' }];
  if (state.status === 'calibrating') return [{ id: 'calibrating', title: 'Learning your baseline', body: 'Stand still for about 30 seconds so the app can learn your calm heart rate.' }];
  if (state.status !== 'ok') return [];
  const plan = planFor(state.level, state.trend);
  switch (state.level) {
    case 'calm': return [TIPS.settled];
    case 'steady': return [state.trend === 'rising' ? TIPS.slowdown : TIPS.routine, TIPS.tempo].slice(0, 2);
    case 'elevated': return [TIPS.breathe(plan), TIPS.shoulders, TIPS.routine];
    case 'high': return [state.trend === 'rising' ? TIPS.slowdown : TIPS.breathe(plan), TIPS.breathe(plan), TIPS.process]
      .filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i).slice(0, 3);
    default: return [];
  }
}

export const LEVEL_TEXT = {
  calm: 'Calm',
  steady: 'Steady',
  elevated: 'Nervous',
  high: 'Very tense',
};
