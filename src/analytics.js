// Anonymous usage analytics, sent to the project's PostHog (EU cloud) with a tiny hand-rolled client
// instead of posthog-js: no cookies, no session recording, no autocapture, no GeoIP lookup.
//
// Each device gets a random id on first launch (localStorage 'skywright.deviceId'). It is not derived
// from the hardware, means nothing outside Skywright, and resets if the browser's site data is cleared.
// The id is shown in Settings so a device can be found and labelled by hand in PostHog.
//
// Events are queued and sent in batches (every 20 s, and when the page is hidden). Batches that fail
// to send (offline tablet) are kept in localStorage and retried on the next launch.
// Off on local checkouts (COMMIT 'dev') unless ?analytics=1 is in the URL; Settings has an opt-out.

const HOST = 'https://eu.i.posthog.com';
const KEY = 'phc_twxQofoeQ7hVZx8MxQmvrrEUE2hkTbQ5iX2McJ97BbJu'; // public project key (write-only)
const LS_ID = 'skywright.deviceId', LS_Q = 'skywright.analyticsQueue', MAX_Q = 300;
const SESSION_IDLE = 30 * 60e3;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
// UUIDv7 (time-ordered): PostHog wants these for $session_id
function uuid7() {
  const t = Date.now().toString(16).padStart(12, '0'), r = hex(10);
  return `${t.slice(0, 8)}-${t.slice(8)}-7${r.slice(0, 3)}-${((parseInt(r[3], 16) & 3) | 8).toString(16)}${r.slice(4, 7)}-${r.slice(7, 19)}`;
}

function deviceInfo() {
  const ua = navigator.userAgent || '';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac OS X' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const short = Math.min(screen.width, screen.height), touch = navigator.maxTouchPoints > 0;
  const deviceType = !touch || os === 'Windows' || os === 'Mac OS X' || os === 'Linux' ? 'Desktop' : short < 600 ? 'Mobile' : 'Tablet';
  const installed = matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  return { $os: os, $browser: browser, $device_type: deviceType, $screen_width: screen.width, $screen_height: screen.height, installed, cpu_cores: navigator.hardwareConcurrency || null, memory_gb: navigator.deviceMemory || null };
}

export class Analytics {
  constructor({ version, commit, enabled = true }) {
    this.version = version; this.commit = commit;
    const params = new URLSearchParams(location.search);
    this.allowed = commit !== 'dev' || params.get('analytics') === '1'; // keep local testing out of the stats
    this.enabled = enabled;
    this.id = ls.get(LS_ID); this.newDevice = !this.id;
    if (!this.id) { this.id = 'd-' + hex(8); ls.set(LS_ID, this.id); }
    this.queue = []; try { this.queue = JSON.parse(ls.get(LS_Q) || '[]'); } catch { /* corrupt queue: drop it */ }
    ls.del(LS_Q);
    this.session = uuid7(); this.lastActive = Date.now();
    this.device = deviceInfo();
    this.errors = new Set();
    setInterval(() => this.flush(), 20e3);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(true); });
    addEventListener('pagehide', () => { try { this.onLeave?.(); } catch { /* never block unload */ } this.flush(true); }); // onLeave: main.js closes out a flight in progress
    addEventListener('online', () => this.flush());
    addEventListener('error', (e) => this.error(e.message, e.filename, e.lineno));
    addEventListener('unhandledrejection', (e) => this.error(String(e.reason?.message || e.reason), e.reason?.stack?.split('\n')[1]?.trim()));
  }
  get on() { return this.allowed && this.enabled; }
  setEnabled(on) {
    if (!on && this.on) { this.capture('analytics_off'); this.flush(true); } // the one event that says why a device went quiet
    this.enabled = on;
    if (!on) { this.queue = []; ls.del(LS_Q); }
  }
  capture(event, props = {}) {
    if (!this.on) return;
    const now = Date.now();
    if (now - this.lastActive > SESSION_IDLE) this.session = uuid7(); // back after a long break: new session
    this.lastActive = now;
    this.queue.push({
      event, distinct_id: this.id, timestamp: new Date(now).toISOString(), uuid: uuid7(),
      properties: { ...this.device, ...props, app_version: this.version, commit: this.commit, $session_id: this.session, $lib: 'skywright', $geoip_disable: true, $current_url: location.origin + location.pathname },
    });
    if (this.queue.length > MAX_Q) this.queue.splice(0, this.queue.length - MAX_Q);
  }
  // first launch of the page: person properties ride along on this event
  open(extra = {}) {
    this.capture('$pageview');
    this.capture('app_open', { ...extra, $set: { ...this.device, app_version: this.version, ...extra }, $set_once: { first_version: this.version, first_seen: new Date().toISOString() } });
    this.flush();
  }
  error(message, source, line) {
    const key = `${message}@${source}:${line}`;
    if (!message || this.errors.has(key) || this.errors.size >= 10) return; // each distinct error once per session
    this.errors.add(key);
    this.capture('js_error', { message: String(message).slice(0, 300), source: String(source || '').replace(location.origin, '').slice(0, 200), line: line || null });
  }
  flush(leaving = false) {
    if (!this.on || !this.queue.length) return;
    const batch = this.queue; this.queue = [];
    const body = JSON.stringify({ api_key: KEY, batch });
    // text/plain keeps it a "simple" request (no CORS preflight); PostHog parses the JSON body regardless
    if (leaving) {
      ls.set(LS_Q, JSON.stringify(batch)); // if the beacon doesn't make it, the next launch retries (duplicates are dropped by uuid)
      if (navigator.sendBeacon?.(`${HOST}/batch/`, new Blob([body], { type: 'text/plain' }))) setTimeout(() => ls.del(LS_Q), 3000);
      return;
    }
    fetch(`${HOST}/batch/`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: body.length < 60000 })
      .then((r) => { if (!r.ok && r.status >= 500) throw new Error(r.status); })
      .catch(() => { this.queue = batch.concat(this.queue).slice(-MAX_Q); ls.set(LS_Q, JSON.stringify(this.queue)); });
  }
}
