// Online multiplayer over WebRTC data channels (PeerJS, vendor/peerjs.min.js, loaded as a classic script).
// The free PeerJS cloud broker is only used for the handshake; game data then flows peer-to-peer.
//
// No codes: every location has a few well-known sessions (peer ids skywright-v2-<location>-<n>, n = 1..ROOMS).
// Pressing FLY joins the first session at that location, or starts session 1 if nobody is flying there, so
// everyone ends up together by default. The flight screen scans ("peeks" at) each session to show who's flying.
// If the host leaves, the session lives on: the remaining pilots race to re-register the same id (lowest player
// id first); one wins and becomes host, the others join it.
//
// Star topology: every client connects to the host; the host relays each update to everyone else.
// Messages (JSON):
//   client -> host  {type:'hello', name, design, realism, id?, broken?}   (id: keep my id/colour after a host hand-off)
//                   {type:'peek'}  -> host replies {type:'info', count, max, names, cfg} and hangs up
//   host -> client  {type:'welcome', you, host, slot, cfg, players:[{id,name,design,realism,slot,broken}]}
//   host -> all     {type:'join', player} / {type:'left', id} / {type:'full'}
//   any             ['s', id, t, ...] (state, ~15 Hz, see remote.js), {type:'event', id, kind:'break', i},
//                   {type:'event', id, kind:'bldg', p, E, d, s} (a building hit: point, energy J, direction, speed),
//                   {type:'respawn', id}, {type:'ping'}, {type:'bye'}
import { encodeDesign, decodeDesign } from './design.js';
import { RemotePlane, SnapBuffer, packState, unpackState, PLAYER_COLORS } from './remote.js';
import { LOCATIONS, RUNWAYS, RWY } from './world.js';
import { REALISM } from './aircraft.js';

const PREFIX = 'skywright-v2-';
export const ROOMS = 4; // sessions per location
export const MAX_PLAYERS = 6;
const SEND_DT = 1 / 15;
const TIMEOUT = 15000; // ms without hearing from someone before we give up on them
const LOAD_TIMEOUT = 45000; // ...or one who just joined and is still loading
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cleanName = (s) => (String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Pilot');
const roomId = (loc, n) => `${PREFIX}${loc}-${n}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unavailableIn = (e) => /(\S+)\s*$/.exec(e?.message || '')?.[1]; // "Could not connect to peer <id>"

export class Net {
  // ctx: { ui, hud, audio, LS, getDesign(), getCfg() }
  constructor(ctx) {
    this.ctx = ctx;
    this.name = cleanName(ctx.LS.get('mpName', 'Pilot'));
    this.rooms = {}; // location -> [{ n, count, max, names, cfg }] from the last scan; taken-but-unreachable rooms have count -1
    this.reset();
    setInterval(() => this.heartbeat(), 1000);
  }
  reset() {
    this.role = null; this.peer = null; this.conn = null; this.room = null; this.cfg = null;
    this.myId = 0; this.hostId = 0; this.mySlot = 0; this.nextId = 2; this.myBroken = []; this.hasFlown = false;
    this.players = new Map(); // id -> { id, name, design, designCode, realism, color, slot, broken, buf, remote, conn, seen }
    this.hostSeen = 0; this.sendT = 0;
  }
  get active() { return !!this.role; }
  get count() { return this.players.size + (this.role ? 1 : 0); }
  realism() { return this.F?.cfg?.realism || this.ctx.getCfg().realism; }
  setName(n) { this.name = cleanName(n); this.ctx.LS.set('mpName', this.name); }

  // ---------- connection setup ----------
  // onError: errors after the peer is open (e.g. 'peer-unavailable' when connecting to an id nobody holds)
  openPeer(id, onError) {
    return new Promise((resolve, reject) => {
      const P = window.Peer;
      if (!P) { reject(new Error('Multiplayer library failed to load. Are you online?')); return; }
      // debug 0: "peer unavailable" is a normal answer for probes and joiners (and hosts see it when a peeker hangs up)
      const peer = id ? new P(id, { debug: 0 }) : new P({ debug: 0 });
      let done = false;
      const timer = setTimeout(() => { if (done) return; done = true; peer.destroy(); reject(new Error('Couldn’t reach the multiplayer server. Check the internet connection.')); }, 10000);
      peer.on('open', () => { if (done) return; done = true; clearTimeout(timer); resolve(peer); });
      peer.on('error', (e) => {
        if (!done) { done = true; clearTimeout(timer); peer.destroy(); reject(e); return; }
        onError?.(e);
      });
      peer.on('disconnected', () => { if (peer === this.peer && this.role === 'host' && !peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch { /* ignore */ } }, 2000); });
    });
  }
  sessionError(e) {
    if (e.type === 'peer-unavailable') this.joinReject?.(Object.assign(new Error('That session has ended.'), { type: 'peer-unavailable' })); // (a host also sees this when a peeker hangs up early)
    else console.warn('peer error', e.type, e.message);
  }

  // ---------- finding sessions ----------
  // Peek at every session of the given locations. onUpdate() fires as answers come in; resolves when all are known.
  scan(locs, onUpdate) {
    if (this.scanning) return this.scanning;
    const pending = new Map(); // peer id -> resolve(false) when the broker says nobody holds it
    this.scanning = (async () => {
      let peer;
      try { peer = await this.openPeer(null, (e) => { if (e.type === 'peer-unavailable') pending.get(unavailableIn(e))?.(false); }); }
      catch (e) { this.scanError = e; onUpdate?.(); return false; }
      this.scanError = null;
      const found = {};
      await Promise.all(locs.flatMap((loc) => { found[loc] = []; return Array.from({ length: ROOMS }, (_, i) => this.peek(peer, loc, i + 1, pending).then((r) => {
        if (r === false) return;
        found[loc].push(r || { n: i + 1, count: -1 }); found[loc].sort((a, b) => a.n - b.n);
        this.rooms[loc] = found[loc]; onUpdate?.();
      })); }));
      for (const loc of locs) this.rooms[loc] = found[loc];
      this.scanned = performance.now();
      setTimeout(() => peer.destroy(), 500);
      onUpdate?.();
      return true;
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  // false: nobody there; null: someone holds the id but didn't answer; else the session's info
  peek(peer, loc, n, pending) {
    const id = roomId(loc, n);
    return new Promise((resolve) => {
      let conn = null;
      const fin = (r) => { pending.delete(id); clearTimeout(timer); setTimeout(() => { try { conn?.close(); } catch { /* ignore */ } }, 50); resolve(r); };
      const timer = setTimeout(() => fin(null), 8000);
      pending.set(id, fin);
      conn = peer.connect(id, { serialization: 'json', reliable: true });
      conn.on('open', () => conn.send({ type: 'peek' }));
      conn.on('data', (m) => { if (m?.type === 'info') fin({ n, count: m.count | 0, max: m.max | 0 || MAX_PLAYERS, names: (m.names || []).map(cleanName), cfg: m.cfg || {} }); });
      conn.on('error', () => {});
    });
  }
  sessionsAt(loc) { return this.rooms[loc] || []; }

  // ---------- joining / hosting ----------
  // choice: { auto: true } | { join: n } | { host: true }. Resolves to flight-config overrides.
  async connect(cfg, choice = { auto: true }) {
    const loc = cfg.location;
    if (choice.auto) {
      if (this.scanning) await Promise.race([this.scanning, sleep(9000)]);
      else if (!this.scanned || performance.now() - this.scanned > 20000) await Promise.race([this.scan([loc]), sleep(9000)]);
      for (const r of this.sessionsAt(loc)) {
        if (r.count < 1 || r.count >= (r.max || MAX_PLAYERS)) continue;
        try { return await this.join(loc, r.n); } catch (e) { console.warn('join failed', r.n, e); }
      }
      return this.hostFree(cfg);
    }
    if (choice.join) return this.join(loc, choice.join);
    return this.hostFree(cfg);
  }
  async hostFree(cfg) {
    const taken = new Set(this.sessionsAt(cfg.location).map((r) => r.n));
    for (const pass of [0, 1]) for (let n = 1; n <= ROOMS; n++) {
      if (!pass && taken.has(n)) continue; // first try the ones the scan says are free
      try { return await this.host(cfg, n); } catch (e) { if (e.type !== 'unavailable-id') throw e; }
    }
    throw new Error(`All ${ROOMS} sessions at ${LOCATIONS[cfg.location]?.name || 'this location'} are in use.`);
  }
  async host(c, n, keep) {
    const peer = await this.openPeer(roomId(c.location, n), (e) => this.sessionError(e));
    const k = keep || { myId: 1, nextId: 2, myBroken: [], hasFlown: false };
    this.reset();
    Object.assign(this, { role: 'host', peer, room: { loc: c.location, n }, myId: k.myId, hostId: k.myId, nextId: k.nextId, myBroken: k.myBroken, hasFlown: k.hasFlown, mySlot: 0,
      cfg: { location: c.location, time: c.time, weather: c.weather } });
    this.myDesign = encodeDesign(this.ctx.getDesign());
    peer.on('connection', (conn) => this.onClientConn(conn));
    return { ...this.cfg, mpSlot: 0, rwy: 0 };
  }

  async join(loc, n, keep, timeout = 15000) {
    const peer = await this.openPeer(null, (e) => this.sessionError(e));
    const k = keep || { myId: 0, myBroken: [], hasFlown: false };
    try {
      const welcome = await new Promise((resolve, reject) => {
        this.joinReject = reject;
        const conn = peer.connect(roomId(loc, n), { serialization: 'json', reliable: true });
        const timer = setTimeout(() => reject(new Error('No answer from that session.')), timeout);
        conn.on('open', () => conn.send({ type: 'hello', name: this.name, design: encodeDesign(this.ctx.getDesign()), realism: this.realism(), id: k.myId || undefined, broken: k.myBroken }));
        conn.on('data', (m) => {
          if (this.conn === conn) { this.onData(m, null); return; }
          if (m?.type === 'full') { clearTimeout(timer); reject(new Error(`That session is full (${MAX_PLAYERS} pilots max).`)); }
          if (m?.type === 'welcome') { clearTimeout(timer); this.reset(); this.conn = conn; this.peer = peer; resolve(m); }
        });
        conn.on('close', () => { if (this.conn === conn) this.hostLost(); else reject(new Error('The session closed the connection.')); });
        conn.on('error', (e) => console.warn('conn error', e));
      });
      this.joinReject = null;
      Object.assign(this, { role: 'client', room: { loc, n }, myId: welcome.you, hostId: welcome.host || 1, mySlot: welcome.slot, cfg: welcome.cfg, hostSeen: performance.now(), myBroken: k.myBroken, hasFlown: k.hasFlown });
      for (const p of welcome.players) this.addPlayer(p);
      await sleep(700); // collect everyone's positions so we can pick a free runway
      return { ...welcome.cfg, location: loc, mpSlot: welcome.slot };
    } catch (e) { this.joinReject = null; peer.destroy(); if (this.peer === peer) this.reset(); throw e; }
  }

  // The runway with the fewest pilots on it (on or just above the ground), for runway starts in a session.
  freeRunway(world) {
    const busy = RUNWAYS.map(() => 0);
    for (const p of this.players.values()) {
      const s = p.buf.snaps.at(-1); if (!s) continue;
      RUNWAYS.forEach((r, i) => { if (Math.abs(s.x.x - r.x) < 70 && Math.abs(s.x.z) < RWY.len / 2 + 300 && s.x.y < world.loc.rwyH + 25) busy[i]++; });
    }
    return busy.indexOf(Math.min(...busy));
  }

  // host: a new client connected
  onClientConn(conn) {
    let pl = null;
    conn.on('data', (m) => {
      if (pl) { pl.seen = performance.now(); this.onData(m, pl); return; }
      if (m?.type === 'peek') { // someone's flight screen asking who's here
        conn.send({ type: 'info', count: this.count, max: MAX_PLAYERS, names: [this.name, ...[...this.players.values()].map((p) => p.name)], cfg: this.cfg });
        setTimeout(() => conn.close(), 1000); return;
      }
      if (m?.type !== 'hello') return;
      if (this.count >= MAX_PLAYERS) { conn.send({ type: 'full' }); setTimeout(() => conn.close(), 500); return; }
      const used = new Set([0, ...[...this.players.values()].map((p) => p.slot)]);
      let slot = 1; while (used.has(slot)) slot++;
      let design;
      try { design = decodeDesign(m.design); } catch { conn.close(); return; }
      if (!design.parts.length) { conn.close(); return; }
      // after a host hand-off, pilots ask to keep their old id (and so their colour)
      const id = Number.isInteger(m.id) && m.id > 0 && m.id !== this.myId && !this.players.has(m.id) ? m.id : this.nextId;
      this.nextId = Math.max(this.nextId, id + 1);
      const broken = Array.isArray(m.broken) ? m.broken.filter(Number.isInteger).slice(0, 200) : [];
      pl = this.addPlayer({ id, name: m.name, design: m.design, realism: REALISM[m.realism] ? m.realism : 'pilot', slot, broken });
      pl.conn = conn; pl.seen = performance.now();
      conn.send({ type: 'welcome', you: pl.id, host: this.myId, slot, cfg: this.cfg, players: [this.myInfo(), ...[...this.players.values()].filter((p) => p !== pl).map((p) => this.info(p))] });
      this.broadcast({ type: 'join', player: this.info(pl) }, pl.id);
    });
    conn.on('close', () => { if (pl && this.players.has(pl.id)) { this.removePlayer(pl.id, 'left'); this.broadcast({ type: 'left', id: pl.id }); } });
    conn.on('error', (e) => console.warn('conn error', e));
  }

  info(p) { return { id: p.id, name: p.name, design: p.designCode, realism: p.realism, slot: p.slot, broken: p.broken }; }
  myInfo() { return { id: this.myId, name: this.name, design: this.myDesign, realism: this.realism(), slot: 0, broken: this.myBroken }; }

  addPlayer(p) {
    if (this.players.has(p.id)) this.removePlayer(p.id, null);
    let design; try { design = decodeDesign(p.design); } catch { design = { name: '?', parts: [] }; }
    const pl = { id: p.id, name: cleanName(p.name), design, designCode: p.design, realism: p.realism, slot: p.slot, color: PLAYER_COLORS[(p.id - 1) % PLAYER_COLORS.length],
      broken: [...(p.broken || [])], buf: new SnapBuffer(), remote: null, conn: null, seen: performance.now() };
    this.players.set(pl.id, pl);
    if (this.F) { this.spawnRemote(pl); this.ctx.hud.toast(`${pl.name} joined`, 'good'); this.ctx.audio.play('click'); }
    this.renderPanel();
    return pl;
  }
  removePlayer(id, why) {
    const pl = this.players.get(id); if (!pl) return;
    pl.remote?.dispose(); pl.remote = null;
    this.players.delete(id);
    if (why && this.F) this.ctx.hud.toast(`${pl.name} ${why === 'timeout' ? 'lost connection' : 'left'}`);
    this.renderPanel();
  }
  spawnRemote(pl) {
    if (!pl.design.parts.length) return;
    try { pl.remote = new RemotePlane(pl, this.F.scene, this.labels); } catch (e) { console.warn('remote plane failed', e); return; }
    // someone else broke the sound barrier: the boom reaches us at the speed of sound
    pl.remote.sonic.onBoom = (pos) => {
      const d = this.lastCam ? this.lastCam.distanceTo(pos) : 0;
      if (d > 12000) return;
      setTimeout(() => { if (this.F) this.ctx.audio.play('sonicboom', Math.max(0.3, 1.5 - d / 6000), pos); }, Math.min(20, d / 340) * 1000);
      this.ctx.hud.toast(`${pl.name} broke the sound barrier!`, 'good');
    };
  }

  building(m) { if (this.role && this.F) this.send({ type: 'event', id: this.myId, kind: 'bldg', p: m.p, E: m.E, d: m.d, s: m.s }); }
  send(m) { if (this.role === 'client') { if (this.conn?.open) this.conn.send(m); } else if (this.role === 'host') this.broadcast(m); }
  broadcast(m, exceptId) { for (const p of this.players.values()) if (p.id !== exceptId && p.conn?.open) p.conn.send(m); }

  // a message from someone. On the host, `from` is the sender's player record (never trust ids it claims).
  onData(m, from) {
    if (this.role === 'client') this.hostSeen = performance.now();
    if (Array.isArray(m)) {
      if (m[0] !== 's' || m.length < 19) return;
      if (from) m[1] = from.id;
      this.players.get(m[1])?.buf.push(unpackState(m));
      if (from) this.broadcast(m, from.id);
      return;
    }
    if (!m || typeof m !== 'object') return;
    const id = from ? from.id : m.id, pl = this.players.get(id);
    switch (m.type) {
      case 'event':
        if (m.kind === 'bldg') this.F?.world.destruct?.remote(m); // a building someone flew into (destruction.js)
        if (pl && m.kind === 'break' && Number.isInteger(m.i)) {
          if (!pl.broken.includes(m.i)) pl.broken.push(m.i);
          if (pl.remote) { pl.remote.ac.breakPart(m.i, 'impact'); this.remoteEvents(pl); }
        }
        if (from) this.broadcast({ ...m, id }, id);
        break;
      case 'respawn':
        if (pl) { pl.broken = []; pl.buf.clear(); if (pl.remote) { pl.remote.dispose(); this.spawnRemote(pl); } }
        if (from) this.broadcast({ type: 'respawn', id }, id);
        break;
      case 'join': if (!from && m.player) this.addPlayer(m.player); break;
      case 'left': if (!from) this.removePlayer(m.id, 'left'); break;
      case 'bye':
        if (from) { this.removePlayer(from.id, 'left'); this.broadcast({ type: 'left', id: from.id }); from.conn?.close(); }
        else this.hostLost();
        break;
    }
  }

  // debris, sparks and sounds for a remote plane's broken parts, like main.js handleEvents does for ours
  remoteEvents(pl) {
    const f = this.F, ac = pl.remote.ac, { effects } = f, { audio, hud } = this.ctx;
    for (const e of ac.events) {
      if (e.type === 'debris') {
        f.debris.push(e.debris); f.scene.add(e.debris.group);
        audio.play('crack', 1, e.pos);
        effects.sparks(e.pos, ac.v, 25);
        effects.puff(e.pos, { x: 0, y: 1, z: 0 }, { color: [0.3, 0.3, 0.3], s0: 2, s1: 10, life: 3 });
        if (f.debris.length > 40) { const old = f.debris.shift(); f.scene.remove(old.group); }
      } else if (e.type === 'wreck') {
        effects.explosion(e.pos, Math.min(2, 0.6 + e.speed / 50)); audio.play('explosion', 1, e.pos);
        hud.toast(`${pl.name} crashed!`, 'bad');
      } else if (e.type === 'msg') hud.toast(`${pl.name}: ${e.text}`);
    }
    ac.events.length = 0;
  }

  // The host left or vanished. Keep the session going: everyone races to take over its id. The lowest player id
  // tries first; the broker only lets one of us have it, and the rest join whoever got it.
  async hostLost() {
    if (this.role !== 'client' || this.migrating) return;
    const room = this.room, cfg = this.cfg, keep = { myId: this.myId, myBroken: this.myBroken, hasFlown: this.hasFlown };
    const others = [...this.players.keys()].filter((id) => id !== this.hostId);
    const rank = others.filter((id) => id < this.myId).length;
    keep.nextId = Math.max(this.myId, ...others) + 1;
    for (const p of this.players.values()) p.remote?.dispose();
    const peer = this.peer;
    this.reset(); // before destroy(): it fires 'close' synchronously, which would land back here
    try { peer?.destroy(); } catch { /* ignore */ }
    this.renderPanel();
    if (!this.F) return; // not flying: nothing to keep
    this.migrating = true;
    this.ctx.hud.toast('The host left. Keeping the session going…');
    const F = this.F, until = performance.now() + 45000;
    // the first in line keeps trying to claim the id (the broker frees it a moment after the old host goes);
    // everyone else tries to join, and only claims it themselves if nobody has it
    await sleep(rank ? 1500 + rank * 700 : 300);
    const tryHost = async () => {
      try { await this.host(cfg, room.n, keep); if (this.F !== F) { this.leave(); return true; } this.renderPanel(); this.ctx.hud.toast('You’re hosting the session now', 'good'); return true; }
      catch (e) { if (e.type !== 'unavailable-id') console.warn(e); return false; }
    };
    try {
      while (this.F === F && performance.now() < until) {
        if (!rank && await tryHost()) return;
        try { await this.join(room.loc, room.n, keep, 8000); if (this.F !== F) { this.leave(); return; } this.ctx.hud.toast(`Back together · ${this.count} pilots`, 'good'); return; }
        catch (e) { if (this.F !== F) return; if (rank && e.type === 'peer-unavailable' && await tryHost()) return; }
        await sleep(700);
      }
      if (this.F === F) this.ctx.hud.toast('Lost the session. You’re flying solo now.', 'bad');
    } finally { this.migrating = false; this.renderPanel(); }
  }

  leave() {
    if (!this.role) return;
    try { this.send({ type: 'bye' }); } catch { /* ignore */ }
    const peer = this.peer;
    setTimeout(() => { try { peer?.destroy(); } catch { /* ignore */ } }, 300); // let the bye go out
    for (const p of this.players.values()) p.remote?.dispose();
    this.reset();
  }

  heartbeat() {
    const now = performance.now(), frozen = now - (this.beat || now) > 3000; this.beat = now;
    if (!this.role) return;
    // Our page was frozen (building a world takes seconds, longer on a busy tablet): messages that arrived meanwhile
    // are still queued, so silence says nothing about the others. Start their clocks again instead of dropping them.
    if (frozen) { this.hostSeen = now; for (const p of this.players.values()) p.seen = now; }
    this.send({ type: 'ping' });
    if (this.role === 'host') {
      // a pilot who hasn't sent a position yet is probably still building their world: give them longer
      for (const p of [...this.players.values()]) if (now - p.seen > (p.buf.snaps.length ? TIMEOUT : LOAD_TIMEOUT)) { p.conn?.close(); this.removePlayer(p.id, 'timeout'); this.broadcast({ type: 'left', id: p.id }); }
    } else if (now - this.hostSeen > TIMEOUT) this.hostLost();
  }

  // ---------- flight hooks (called from main.js) ----------
  attach(F) {
    if (!this.role) return;
    this.F = F;
    const fui = document.getElementById('flight-ui');
    this.labels = document.createElement('div'); this.labels.id = 'mp-labels'; fui.appendChild(this.labels);
    this.panel = document.createElement('div'); this.panel.className = 'mp-panel';
    (document.querySelector('#hud .hud-tr') || fui).appendChild(this.panel);
    for (const p of this.players.values()) this.spawnRemote(p);
    // tell everyone when one of our parts breaks off
    const ac = F.ac, orig = ac.breakPart.bind(ac);
    ac.breakPart = (i, why) => {
      const p = ac.parts.find((pp) => pp.i === i), was = p?.alive;
      orig(i, why);
      if (was && this.role && this.F?.ac === ac) { this.myBroken.push(i); this.send({ type: 'event', id: this.myId, kind: 'break', i }); }
    };
    if (this.hasFlown) { this.myBroken = []; this.send({ type: 'respawn', id: this.myId }); }
    this.hasFlown = true;
    this.renderPanel();
    const where = `${LOCATIONS[this.room.loc]?.name || ''} · Session ${this.room.n}`;
    if (this.count > 1) this.ctx.hud.toast(`Flying with ${this.count - 1} other pilot${this.count === 2 ? '' : 's'} · ${where}`, 'good');
    else this.ctx.hud.toast(`Online: ${where}. Anyone who flies here joins you.`, 'good');
  }
  detach() {
    for (const p of this.players.values()) { p.remote?.dispose(); p.remote = null; }
    this.labels?.remove(); this.panel?.remove();
    this.labels = this.panel = this.F = null;
  }
  update(dt, f, camera, units) {
    if (!this.F || f !== this.F) return;
    if (this.role) {
      this.sendT += dt;
      if (this.sendT >= SEND_DT) { this.sendT %= SEND_DT; if (!f.ac.dead) this.send(packState(this.myId, f.ac)); }
    }
    this.lastCam = camera.position.clone();
    for (const p of this.players.values()) {
      const r = p.remote; if (!r) continue;
      r.update(dt, f.env); r.effects(f.effects); r.updateLabel(camera, units);
      r.sonic.update(dt, { effects: f.effects, world: f.world });
    }
  }
  // remote planes for the minimap
  markers() {
    if (!this.F) return null;
    const out = [];
    for (const p of this.players.values()) { const ac = p.remote?.ac; if (ac && ac.root.visible && !ac.dead) { const fw = ac.forward; out.push({ x: ac.x.x, z: ac.x.z, hdg: Math.atan2(fw.x, -fw.z), color: p.color }); } }
    return out;
  }
  renderPanel() {
    if (!this.panel) return;
    if (!this.role) { this.panel.style.display = this.migrating ? '' : 'none'; if (this.migrating) this.panel.innerHTML = '<div class="mp-code">Reconnecting…</div>'; return; }
    this.panel.style.display = '';
    const rows = [`<li><b style="color:#ffd400">●</b> ${esc(this.name)} <small>(you${this.role === 'host' ? ', host' : ''})</small></li>`,
      ...[...this.players.values()].map((p) => `<li><b style="color:${p.color}">●</b> ${esc(p.name)}${p.id === this.hostId ? ' <small>(host)</small>' : ''}</li>`)];
    this.panel.innerHTML = `<div class="mp-code">Session <b>${this.room?.n || ''}</b></div><ul>${rows.join('')}</ul>`;
  }
  pauseHTML() {
    if (!this.role) return '';
    return `<div class="mp-pause">Online · ${esc(LOCATIONS[this.room.loc]?.name || '')} · <b>Session ${this.room.n}</b> · ${this.count} pilot${this.count === 1 ? '' : 's'}</div>`;
  }
}
