// Video file -> landmark frames for analyzeSwing(), using MediaPipe Pose (runs fully on the device).
// Needs `npm run setup` once so www/lib has the MediaPipe runtime and the pose model.
//
// We step through the clip one frame at a time (seek, detect, repeat) instead of playing it, so the
// result does not depend on the phone keeping up in real time.

let landmarker = null;
let loading = null;
let tsBase = 0;                       // MediaPipe wants strictly increasing timestamps across calls

const here = (p) => new URL(p, import.meta.url).href;

async function create(vision, fileset, delegate) {
  return vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: here('../lib/pose_landmarker_full.task'), delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

export function loadPose() {
  if (landmarker) return Promise.resolve(landmarker);
  if (loading) return loading;
  loading = (async () => {
    const probe = await fetch(here('../lib/pose_landmarker_full.task'), { method: 'HEAD' }).catch(() => null);
    if (!probe || !probe.ok) throw new Error('The pose model is missing. On your computer run "npm install" then "npm run setup", then sync the app again.');
    const vision = await import(here('../lib/vision_bundle.mjs'));
    const fileset = await vision.FilesetResolver.forVisionTasks(here('../lib/wasm'));
    try { landmarker = await create(vision, fileset, 'GPU'); }
    catch { landmarker = await create(vision, fileset, 'CPU'); }
    return landmarker;
  })().finally(() => { loading = null; });
  return loading;
}

function waitFor(target, ok, bad, ms) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); target.removeEventListener(ok, onOk); target.removeEventListener(bad, onBad); fn(v); };
    const onOk = () => done(resolve);
    const onBad = () => done(reject, new Error('The video could not be read. Try a different clip.'));
    const timer = setTimeout(() => done(reject, new Error('Reading the video timed out.')), ms);
    target.addEventListener(ok, onOk);
    target.addEventListener(bad, onBad);
  });
}

/**
 * @param file  a video File/Blob
 * @param opts  fps: frame rate the clip was recorded at (30/60/120/240). Sampling is capped at 120.
 *              maxSeconds: only the first N seconds are analysed. onProgress(0..1).
 * @returns {{frames, fps, aspect, duration, analysedSeconds}}
 */
export async function extractFrames(file, { fps = 60, maxSeconds = 12, onProgress = () => {} } = {}) {
  const lm = await loadPose();
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const meta = waitFor(v, 'loadedmetadata', 'error', 15000);
    v.src = url;
    await meta;
    if (!Number.isFinite(v.duration) || v.duration <= 0) throw new Error('The video has no readable length.');
    if (!v.videoWidth || !v.videoHeight) throw new Error('The video has no picture.');

    const procFps = Math.min(Math.max(fps, 24), 120);
    const seconds = Math.min(v.duration, maxSeconds);
    const n = Math.floor(seconds * procFps);
    const frames = [];
    let found = 0;
    const base = tsBase;
    for (let i = 0; i < n; i++) {
      const seeked = waitFor(v, 'seeked', 'error', 5000);
      v.currentTime = i / procFps + 0.0005;     // tiny offset so the very first seek always fires
      await seeked;
      const res = lm.detectForVideo(v, base + Math.round((i * 1000) / procFps) + 1);
      const pts = res && res.landmarks && res.landmarks[0];
      if (pts) found++;
      frames.push({ t: i / procFps, lm: pts || null });
      if (i % 8 === 0) { onProgress(i / n); await new Promise((r) => setTimeout(r)); }   // let the UI breathe
    }
    tsBase = base + Math.round(seconds * 1000) + 1000;
    onProgress(1);
    if (!found) throw new Error('No golfer was detected in the video. Check the whole body is in frame and the light is good.');
    return { frames, fps: procFps, aspect: v.videoWidth / v.videoHeight, duration: v.duration, analysedSeconds: seconds };
  } finally {
    URL.revokeObjectURL(url);
  }
}
