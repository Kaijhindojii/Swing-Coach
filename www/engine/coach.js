// Coaching layer: engine metrics in -> prioritised, human-readable coaching out.
// Rules decide WHAT is wrong (numbers you can trust); wording is a coach's, and an optional LLM
// call (coachWithLLM) can rephrase it. No API keys live in the app: point it at your own proxy.
//
// Thresholds are in the units analyzeSwing() reports (torso lengths, degrees, ratio). Tempo bands
// are tuned to what the engine measures (first visible hand movement -> top -> impact), which reads
// a little lower than the textbook 3:1, so a tour-like swing shows up around 2.4-3.4.

const TORSO_PER_HEIGHT = 0.3;                       // neck-to-hip length as a fraction of height (approx.)
const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;

export const DEFAULT_PROFILE = { heightCm: 175 };

function sevOf(value, minor, major) {
  if (value >= major) return 'major';
  if (value >= minor) return 'minor';
  return null;
}

/** @returns {{ok:boolean, headline:string, focus:object|null, findings:object[], strengths:string[], notes:string[], confidence:number}} */
export function coachSwing(result, profile = {}) {
  const p = { ...DEFAULT_PROFILE, ...profile };
  if (!result || !result.ok) {
    return { ok: false, headline: result?.message || 'No swing found.', focus: null, findings: [], strengths: [], notes: [], confidence: 0 };
  }
  const m = result.metrics;
  const faceOn = result.viewHint === 'face_on';
  const torsoCm = p.heightCm * TORSO_PER_HEIGHT;
  const cm = (v) => r0(Math.abs(v) * torsoCm);
  const findings = [];
  const strengths = [];
  const add = (f) => findings.push(f);

  // ---- Posture / early extension (down-the-line only) ----------------------------------------
  let postureFlagged = false;
  if (!faceOn) {
    const ee = sevOf(m.hipThrust, 0.12, 0.22);
    const sl = sevOf(m.spineLoss, 8, 14);
    postureFlagged = !!(ee || sl);
    if (ee) {
      const alsoStands = sl ? ` and your spine tilt drops from ${r0(m.spineAddr)}° to ${r0(m.spineImpact)}°` : '';
      add({
        id: 'early_extension', priority: 1, severity: sl === 'major' || ee === 'major' ? 'major' : 'minor',
        title: 'Hips move toward the ball (early extension)',
        seen: `Your hips travel about ${cm(m.hipThrust)} cm toward the ball between address and impact${alsoStands}.`,
        why: 'When the hips thrust at the ball there is no room left for the arms, so the hands get stuck or flip. It costs strike quality and start-line control.',
        fix: 'Turn the belt buckle around, not forward. Keep your tailbone back and your chest over the ball a moment longer.',
        drill: 'Chair drill: set up with your backside lightly touching a chair or wall. Make half swings and keep your trail cheek in contact through impact.',
        target: 'Hip travel under 10 cm and spine tilt within 6° of address.',
      });
    } else if (sl) {
      add({
        id: 'posture_loss', priority: 1, severity: sl,
        title: 'Standing up through impact',
        seen: `Your spine tilt goes from ${r0(m.spineAddr)}° at address to ${r0(m.spineImpact)}° at impact: about ${r0(m.spineLoss)}° of lost posture.`,
        why: 'Standing up lifts the hands and club off plane, so you have to rescue the shot with your wrists. That is where thin shots and pulls come from.',
        fix: 'Feel your chest staying "over the ball" until the club has passed it. Keep the same bend in your hips you set at address.',
        drill: 'Pump drill: from the top, make three half-downswings stopping at hip height with your chest still over the ball, then swing through on the fourth.',
        target: 'Spine tilt within 6° of address at impact.',
      });
    } else if (m.spineLoss <= -10) {
      add({
        id: 'dipping', priority: 3, severity: 'minor',
        title: 'Dipping toward the ball',
        seen: `Your spine tilt increases by about ${r0(-m.spineLoss)}° from address to impact, so you are bending further over.`,
        why: 'Dropping the chest toward the ball usually means the club bottoms out behind it, which causes fat shots.',
        fix: 'Hold the angle you set at address and let the turn, not a dip, bring the club down.',
        drill: 'Alignment-rod drill: hold a rod against your spine. Keep the rod pointing at the same spot on the ground from address through impact.',
        target: 'Spine tilt within 6° of address at impact.',
      });
    }

    // Head movement, only if not already explained by standing up.
    if (!postureFlagged) {
      const up = sevOf(Math.abs(m.headY), 0.12, 0.22);
      const toward = sevOf(m.headX, 0.15, 0.3);
      if (up) {
        add({
          id: 'head_height', priority: 3, severity: up,
          title: m.headY > 0 ? 'Head lifts during the swing' : 'Head drops during the swing',
          seen: `Your head ${m.headY > 0 ? 'rises' : 'drops'} about ${cm(m.headY)} cm between takeaway and impact.`,
          why: 'Your head height is your swing\'s reference point. When it moves, the low point of the swing moves with it.',
          fix: 'Keep your eyes on a spot just behind the ball and let your shoulders turn under a quiet head.',
          drill: 'Tee-behind-the-ball drill: push a tee into the turf a ball-width behind the ball. Stare at the tee and hit the ball without moving your gaze until after impact.',
          target: 'Head height change under 6 cm.',
        });
      } else if (toward) {
        add({
          id: 'head_lunge', priority: 3, severity: toward,
          title: 'Head moves toward the ball',
          seen: `Your head moves about ${cm(m.headX)} cm toward the ball by impact.`,
          why: 'Lunging at the ball shifts the low point forward and tends to crowd the arms.',
          fix: 'Stay balanced over the middle of your feet and rotate around a steady head.',
          drill: 'Feet-together drill: hit half shots with your feet touching. You can only stay balanced if your head and hips stay put.',
          target: 'Head travel under 8 cm toward the ball.',
        });
      }
    }

    // Over the top / too far inside
    const ott = sevOf(m.overTheTop, 0.15, 0.3);
    if (ott) {
      add({
        id: 'over_the_top', priority: 2, severity: ott,
        title: 'Hands move outward from the top (over the top)',
        seen: `Halfway down, your hands are about ${cm(m.overTheTop)} cm further from your body than they were halfway back.`,
        why: 'An outside-in path produces pulls, slices and weak contact on the toe side.',
        fix: 'Start the downswing with the lower body and let your trail elbow drop toward your hip so the club approaches from the inside.',
        drill: 'Headcover drill: place a headcover just outside and behind the ball. Swing without touching it, which forces the club to come from the inside.',
        target: 'Hands within 8 cm of the backswing path at halfway.',
      });
    } else if (m.overTheTop <= -0.2) {
      add({
        id: 'too_inside', priority: 4, severity: 'minor',
        title: 'Club drops too far behind you',
        seen: `Halfway down, your hands are about ${cm(m.overTheTop)} cm closer to your body than on the way back.`,
        why: 'Getting stuck behind the body often leads to blocks and hooks as you try to rescue it with your hands.',
        fix: 'Keep your chest turning through the shot and let the club swing out toward the target after impact.',
        drill: 'Step-through drill: swing and let your trail foot step toward the target after impact. It frees the turn and stops the hands from trapping behind you.',
        target: 'Hands within 8 cm of the backswing path at halfway.',
      });
    }

    // Setup posture
    if (m.spineAddr < 22 || m.spineAddr > 48) {
      add({
        id: 'setup_posture', priority: 5, severity: 'minor',
        title: m.spineAddr < 22 ? 'Setup is too upright' : 'Setup is too hunched over',
        seen: `Your spine tilts ${r0(m.spineAddr)}° from vertical at address. Most players are comfortable around 25 to 45°.`,
        why: 'Posture at address sets the angles you have to repeat during the swing.',
        fix: m.spineAddr < 22 ? 'Push your hips back and tilt from the hips until your arms hang naturally under your shoulders.' : 'Stand a little taller and keep your chest open, bending from the hips rather than the back.',
        drill: 'Club-across-the-thighs drill: hold a club across your thighs and hinge until it points at the ball. Then take your grip without changing the angle.',
        target: 'Spine tilt between 25 and 45° at address.',
      });
    }
  }

  // ---- Leg flex (either view) -------------------------------------------------------------------
  const knee = sevOf(m.kneeLoss, 10, 18);
  if (knee) {
    add({
      id: 'leg_flex', priority: 4, severity: knee,
      title: 'Legs straighten before impact',
      seen: `Your knee flex goes from ${r0(m.kneeAddr)}° to ${r0(m.kneeImpact)}°, so your legs straighten by about ${r0(m.kneeLoss)}°.`,
      why: 'Straight legs push your body up and toward the ball, and they take away the power from the ground.',
      fix: 'Keep some flex in both knees until after the ball is gone, and feel the pressure staying in the middle of your feet.',
      drill: 'Half-swing knee drill: make slow half swings keeping the same knee bend from setup to impact, and finish with a balanced hold for three seconds.',
      target: 'Knee angle change under 8° at impact.',
    });
  }

  // ---- Tempo (either view) ------------------------------------------------------------------------
  const ratio = m.tempoRatio;
  const ms = `${r0(m.backswingMs)} ms back, ${r0(m.downswingMs)} ms down`;
  if (ratio < 2.0) {
    add({
      id: 'tempo_rushed', priority: 2, severity: ratio < 1.6 ? 'major' : 'minor',
      title: 'Rushed backswing',
      seen: `Your backswing takes only ${r1(ratio)} times as long as your downswing (${ms}).`,
      why: 'A quick backswing leaves no time to transition. The downswing then starts from the arms and the body gets left behind.',
      fix: 'Take the club back slower. Think "slow back, smooth change of direction". The speed should come from the downswing.',
      drill: 'Count drill: say "one-two-three" on the way back and "hit" on the way down, using a steady metronome (around 60 beats per minute) if you have one.',
      target: 'Tempo ratio between 2.2 and 3.6.',
    });
  } else if (ratio > 4.0) {
    add({
      id: 'tempo_late_hit', priority: 4, severity: 'minor',
      title: 'Slow back, then a sudden hit',
      seen: `Your backswing takes ${r1(ratio)} times as long as your downswing (${ms}).`,
      why: 'A long wind-up followed by a lash from the top usually means a late, rushed transition.',
      fix: 'Start the downswing smoothly with your lower body and keep the same rhythm as the backswing.',
      drill: 'Pause drill: pause for a beat at the top, then let the downswing build gradually and finish in balance.',
      target: 'Tempo ratio between 2.2 and 3.6.',
    });
  } else if (ratio >= 2.2 && ratio <= 3.8) {
    strengths.push(`Your tempo is smooth and repeatable (${ms}).`);
  }

  // ---- Short backswing ----------------------------------------------------------------------------
  if (m.topHandHeight < -0.1) {
    add({
      id: 'short_backswing', priority: 4, severity: 'minor',
      title: 'Short backswing',
      seen: 'Your hands stop below shoulder height at the top.',
      why: 'A short backswing limits the room you have to build speed.',
      fix: 'Keep turning your chest until your back faces the target. Let your lead arm stay connected to your chest rather than lifting it.',
      drill: 'Towel drill: tuck a towel under both armpits and swing to the top without dropping it. It builds a bigger turn while keeping the arms connected.',
      target: 'Hands at or above shoulder height at the top.',
    });
  }

  // ---- Strengths ----------------------------------------------------------------------------------
  if (!faceOn && !postureFlagged) strengths.push(`You keep your posture through the hit (spine tilt changes by only ${r0(Math.abs(m.spineLoss))}°).`);
  if (!faceOn && m.overTheTop < 0.15 && m.overTheTop > -0.2) strengths.push('Your downswing path stays on the same plane as your backswing.');
  if (knee === null) strengths.push('You hold your knee flex into impact.');

  // ---- Prioritise -----------------------------------------------------------------------------------
  const sevRank = { major: 0, minor: 1 };
  findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.priority - b.priority);
  const top = findings.slice(0, 3);

  const notes = [...result.warnings];
  if (faceOn) notes.unshift('This looks like a face-on view, so I only checked tempo, knee flex and backswing length. For posture and hip checks, film from behind you looking down the target line.');
  if (result.confidence < 0.6) notes.push('Confidence is low for this clip. Treat these tips as a hint, and re-record with better light and your whole body in view.');

  return {
    ok: true,
    headline: top.length ? `Work on one thing: ${top[0].title.toLowerCase()}.` : 'Clean swing. Nothing big to fix on this one.',
    focus: top[0] || null,
    findings: top,
    strengths: strengths.slice(0, 3),
    notes,
    confidence: result.confidence,
  };
}

/** Prompt for an optional LLM pass that rewrites the findings in a coach's voice. */
export function buildCoachPrompt(report, profile = {}) {
  return [
    'You are an experienced PGA teaching professional giving feedback after a swing recorded on a phone.',
    'Use ONLY the findings below. Do not invent measurements or faults. Be warm, specific and brief.',
    'Give: one sentence of overall feedback, then the single most important fix with one drill, then one thing to praise.',
    profile.handicap != null ? `Player handicap: ${profile.handicap}.` : '',
    '',
    'Findings (JSON):',
    JSON.stringify({ focus: report.focus, findings: report.findings, strengths: report.strengths }, null, 2),
  ].filter(Boolean).join('\n');
}

/**
 * Optionally rewrite the report with an LLM through YOUR proxy (never ship an API key in the app).
 * The endpoint receives {prompt} and should return {text}. Falls back silently to the rule-based text.
 */
export async function coachWithLLM(endpoint, report, profile = {}, fetchFn = globalThis.fetch) {
  if (!endpoint || !report?.ok) return null;
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: buildCoachPrompt(report, profile) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.text === 'string' ? data.text : null;
  } catch {
    return null;
  }
}
