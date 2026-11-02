// One-time setup: copy the MediaPipe runtime out of node_modules into www/lib and download the
// pose model, so the app works offline inside the iOS WebView. Run `npm install` first.
import { cp, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const lib = join(root, 'www', 'lib');
const pkg = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

const exists = (p) => stat(p).then(() => true, () => false);

await mkdir(lib, { recursive: true });

if (!(await exists(pkg))) {
  console.error('Missing node_modules/@mediapipe/tasks-vision. Run `npm install` first.');
  process.exit(1);
}
await cp(join(pkg, 'vision_bundle.mjs'), join(lib, 'vision_bundle.mjs'));
await cp(join(pkg, 'wasm'), join(lib, 'wasm'), { recursive: true });
console.log('Copied MediaPipe runtime to www/lib');

const modelPath = join(lib, 'pose_landmarker_full.task');
if (await exists(modelPath)) {
  console.log('Pose model already present');
} else {
  console.log('Downloading pose model (~9 MB)...');
  const res = await fetch(MODEL_URL);
  if (!res.ok) { console.error(`Model download failed: HTTP ${res.status}\nDownload it manually from ${MODEL_URL} and save it as www/lib/pose_landmarker_full.task`); process.exit(1); }
  await writeFile(modelPath, Buffer.from(await res.arrayBuffer()));
  console.log('Saved www/lib/pose_landmarker_full.task');
}
