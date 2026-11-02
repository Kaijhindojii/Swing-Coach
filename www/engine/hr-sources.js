// Heart-rate sources. Each source calls onSample({ t, bpm, rr?, still? }) with t in seconds.
//   WatchSource      Apple Watch through the native WatchHeart plugin (iOS app only)
//   BluetoothSource  any standard Bluetooth heart-rate sensor (chest strap, many watches in
//                    broadcast mode) via Web Bluetooth: Chrome on Android/desktop. Gives RR intervals.
//   SimulatedSource  a scripted round for trying the app without any hardware

/** Parse a Bluetooth "Heart Rate Measurement" (0x2A37) value. */
export function parseHeartRateMeasurement(view) {
  const flags = view.getUint8(0);
  let i = 1;
  let bpm;
  if (flags & 0x01) { bpm = view.getUint16(i, true); i += 2; } else { bpm = view.getUint8(i); i += 1; }
  const contactSupported = !!(flags & 0x04);
  const contact = contactSupported ? !!(flags & 0x02) : null;
  if (flags & 0x08) i += 2;                                   // energy expended
  const rr = [];
  if (flags & 0x10) {
    for (; i + 1 < view.byteLength; i += 2) rr.push(Math.round((view.getUint16(i, true) / 1024) * 1000));
  }
  return { bpm, rr, contact };
}

export class BluetoothSource {
  static get supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }
  async start(onSample, onStatus = () => {}) {
    if (!BluetoothSource.supported) throw new Error('Bluetooth is not available in this browser. On iPhone use the Apple Watch option.');
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => onStatus('disconnected'));
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    this.char = await service.getCharacteristic('heart_rate_measurement');
    this.handler = (e) => {
      const m = parseHeartRateMeasurement(e.target.value);
      if (m.contact === false) return;                        // sensor not on skin
      onSample({ t: Date.now() / 1000, bpm: m.bpm, rr: m.rr });
    };
    this.char.addEventListener('characteristicvaluechanged', this.handler);
    await this.char.startNotifications();
    onStatus('connected');
    return device.name || 'Heart-rate sensor';
  }
  async stop() {
    try { this.char?.removeEventListener('characteristicvaluechanged', this.handler); await this.char?.stopNotifications(); } catch { /* already gone */ }
    try { this.device?.gatt?.disconnect(); } catch { /* ignore */ }
  }
}

export class WatchSource {
  /** @param plugin the Capacitor WatchHeart plugin object */
  constructor(plugin) { this.plugin = plugin; }
  static get supported() { return !!WatchSource.getPlugin(); }
  static getPlugin() {
    const cap = globalThis.Capacitor;
    if (!cap || !(cap.isNativePlatform?.() ?? false)) return null;
    return cap.Plugins?.WatchHeart || cap.registerPlugin?.('WatchHeart') || null;
  }
  async start(onSample, onStatus = () => {}) {
    this.sub = await this.plugin.addListener('heartRate', (e) => onSample({ t: e.t || Date.now() / 1000, bpm: e.bpm, still: e.still }));
    this.sub2 = await this.plugin.addListener('status', (e) => onStatus(e.workoutActive ? 'connected' : e.reachable ? 'watch_ready' : 'watch_unreachable'));
    await this.plugin.start();
    return 'Apple Watch';
  }
  async stop() {
    try { await this.plugin.stop(); } catch { /* ignore */ }
    try { await this.sub?.remove(); await this.sub2?.remove(); } catch { /* ignore */ }
  }
  /** Resting heart rate from Apple Health (14-day average), or null. */
  async restingHR() {
    try { const r = await this.plugin.getBaseline(); return r?.restingHR || null; } catch { return null; }
  }
  /** Tap the wrist: pattern is 'breatheIn' | 'breatheOut' | 'nudge'. */
  haptic(pattern) { try { this.plugin.haptic({ pattern }); } catch { /* ignore */ } }
}

/**
 * A scripted round, one sample per simulated second:
 *   0-45 s   standing still, calm       (~66 bpm)
 *   45-75 s  walking to the ball         (~96 bpm, still:false)
 *   75-100 s at the ball, settling       (~72 bpm)
 *   100-135 s a pressure moment          (climbs to ~98 bpm)
 *   135-200 s slow breathing recovery    (falls back to ~72 bpm)
 * then it loops. `speed` ticks per real second (3 plays the script three times faster).
 */
export class SimulatedSource {
  constructor({ speed = 1, seed = 3 } = {}) { this.speed = speed; this.seed = seed; this.k = 0; }
  static valueAt(k, noise = 0) {
    const s = k % 200;
    let bpm, still = true;
    if (s < 45) bpm = 66;
    else if (s < 75) { bpm = 66 + (30 * Math.min(1, (s - 45) / 8)); still = false; }
    else if (s < 100) bpm = 96 - 24 * Math.min(1, (s - 75) / 12);
    else if (s < 135) bpm = 72 + 26 * Math.min(1, (s - 100) / 30);
    else bpm = 98 - 26 * Math.min(1, (s - 135) / 50);
    return { bpm: Math.round(bpm + noise), still };
  }
  async start(onSample, onStatus = () => {}) {
    let a = this.seed;
    const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 - 0.5; };
    let t = Date.now() / 1000;
    const tick = () => { const v = SimulatedSource.valueAt(this.k++, rnd() * 2); t += 1; onSample({ t, bpm: v.bpm, still: v.still }); };
    tick();
    this.timer = setInterval(tick, 1000 / this.speed);
    onStatus('connected');
    return 'Simulated watch';
  }
  async stop() { clearInterval(this.timer); }
  haptic() {}
}
