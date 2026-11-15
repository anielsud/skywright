// LAN multiplayer over WebRTC data channels (PeerJS, vendor/peerjs.min.js, loaded as a classic script).
// The free PeerJS cloud broker is only used for the handshake; game data then flows peer-to-peer
// (directly across the Wi-Fi when everyone is on the same network).
//
// Star topology: every client connects to the host; the host relays each update to everyone else.
// Messages (JSON):
//   client -> host  {type:'hello', name, design, realism}
//   host -> client  {type:'welcome', you, slot, code, cfg, players:[{id,name,design,realism,broken}]}
//   host -> all     {type:'join', player} / {type:'left', id} / {type:'full'}
//   any             ['s', id, t, ...] (state, ~15 Hz, see remote.js), {type:'event', id, kind:'break', i},
//                   {type:'respawn', id}, {type:'ping'}, {type:'bye'}
import { encodeDesign, decodeDesign } from './design.js';
import { RemotePlane, SnapBuffer, packState, unpackState, PLAYER_COLORS } from './remote.js';
import { LOCATIONS, WEATHER } from './world.js';
import { REALISM } from './aircraft.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O (look like 1 / 0)
const PREFIX = 'skywright-';
const MAX_PLAYERS = 6;
const SEND_DT = 1 / 15;
const TIMEOUT = 15000; // ms without hearing from someone before we give up on them
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cleanName = (s) => (String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Pilot');
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export class Net {
  // ctx: { ui, hud, audio, LS, getDesign(), getCfg(), startFlight(cfg) }
  constructor(ctx) {
    this.ctx = ctx;
    this.name = cleanName(ctx.LS.get('mpName', 'Pilot'));
    this.reset();
    setInterval(() => this.heartbeat(), 1000);
  }
  reset() {
    this.role = null; this.peer = null; this.conn = null; this.code = ''; this.cfg = null;
    this.myId = 0; this.mySlot = 0; this.nextId = 2; this.myBroken = []; this.hasFlown = false;
    this.players = new Map(); // id -> { id, name, design, designCode, realism, color, slot, broken, buf, remote, conn, seen }
    this.hostSeen = 0; this.sendT = 0;
  }
  get active() { return !!this.role; }
  get count() { return this.players.size + (this.role ? 1 : 0); }

  // ---------- connection setup ----------
  openPeer(id) {
    return new Promise((resolve, reject) => {
      const P = window.Peer;
      if (!P) { reject(new Error('Multiplayer library failed to load. Are you online?')); return; }
      const peer = id ? new P(id, { debug: 1 }) : new P({ debug: 1 });
      let done = false;
      const timer = setTimeout(() => { if (done) return; done = true; peer.destroy(); reject(new Error('Couldn’t reach the matchmaking server. Check the internet connection.')); }, 12000);
      peer.on('open', () => { if (done) return; done = true; clearTimeout(timer); resolve(peer); });
      peer.on('error', (e) => {
        if (!done) { done = true; clearTimeout(timer); peer.destroy(); reject(e); return; }
        if (peer !== this.peer) return;
        console.warn('peer error', e.type, e.message);
        if (e.type === 'peer-unavailable' && this.joinReject) this.joinReject(new Error('No game found with that code.'));
      });
      peer.on('disconnected', () => { if (peer === this.peer && this.role === 'host' && !peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch { /* ignore */ } }, 2000); });
    });
  }

  async host() {
    let peer = null, code = '';
    for (let tries = 0; tries < 6 && !peer; tries++) {
      code = randomCode();
      try { peer = await this.openPeer(PREFIX + code); } catch (e) { if (e.type !== 'unavailable-id') throw e; }
    }
    if (!peer) throw new Error('Couldn’t get a room code. Try again.');
    this.reset();
    const c = this.ctx.getCfg();
    Object.assign(this, { role: 'host', peer, code, myId: 1, mySlot: 0, cfg: { location: c.location, time: c.time, weather: c.weather, realism: c.realism } });
    this.myDesign = encodeDesign(this.ctx.getDesign());
    peer.on('connection', (conn) => this.onClientConn(conn));
    return code;
  }

  async join(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) throw new Error('Codes are 4 letters.');
    const peer = await this.openPeer();
    this.reset();
    this.peer = peer;
    try {
      const welcome = await new Promise((resolve, reject) => {
        this.joinReject = reject;
        const conn = peer.connect(PREFIX + code, { serialization: 'json', reliable: true });
        const timer = setTimeout(() => reject(new Error('No answer from that game. Check the code.')), 15000);
        conn.on('open', () => conn.send({ type: 'hello', name: this.name, design: encodeDesign(this.ctx.getDesign()), realism: this.ctx.getCfg().realism }));
        conn.on('data', (m) => {
          if (this.role) { this.onData(m, null); return; }
          if (m?.type === 'full') { clearTimeout(timer); reject(new Error('That game is full (6 pilots max).')); }
          if (m?.type === 'welcome') { clearTimeout(timer); this.conn = conn; resolve(m); }
        });
        conn.on('close', () => { if (this.conn === conn) this.hostLost('The host left the game. You’re flying solo now.'); else reject(new Error('The game closed the connection.')); });
        conn.on('error', (e) => console.warn('conn error', e));
      });
      this.joinReject = null;
      Object.assign(this, { role: 'client', code, myId: welcome.you, mySlot: welcome.slot, cfg: welcome.cfg, hostSeen: performance.now() });
      for (const p of welcome.players) this.addPlayer(p);
      return welcome;
    } catch (e) { this.joinReject = null; peer.destroy(); this.reset(); throw e; }
  }

  // host: a new client connected
  onClientConn(conn) {
    let pl = null;
    conn.on('data', (m) => {
      if (pl) { pl.seen = performance.now(); this.onData(m, pl); return; }
      if (m?.type !== 'hello') return;
      if (this.count >= MAX_PLAYERS) { conn.send({ type: 'full' }); setTimeout(() => conn.close(), 500); return; }
      const used = new Set([0, ...[...this.players.values()].map((p) => p.slot)]);
      let slot = 1; while (used.has(slot)) slot++;
      let design;
      try { design = decodeDesign(m.design); } catch { conn.close(); return; }
      if (!design.parts.length) { conn.close(); return; }
      pl = this.addPlayer({ id: this.nextId++, name: m.name, design: m.design, realism: this.cfg.realism, slot, broken: [] });
      pl.conn = conn; pl.seen = performance.now();
      conn.send({ type: 'welcome', you: pl.id, slot, code: this.code, cfg: this.cfg, players: [this.myInfo(), ...[...this.players.values()].filter((p) => p !== pl).map((p) => this.info(p))] });
      this.broadcast({ type: 'join', player: this.info(pl) }, pl.id);
    });
    conn.on('close', () => { if (pl && this.players.has(pl.id)) { this.removePlayer(pl.id, 'left'); this.broadcast({ type: 'left', id: pl.id }); } });
    conn.on('error', (e) => console.warn('conn error', e));
  }

  info(p) { return { id: p.id, name: p.name, design: p.designCode, realism: p.realism, slot: p.slot, broken: p.broken }; }
  myInfo() { return { id: this.myId, name: this.name, design: this.myDesign, realism: this.cfg.realism, slot: 0, broken: this.myBroken }; }

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
    try { pl.remote = new RemotePlane(pl, this.F.scene, this.labels); } catch (e) { console.warn('remote plane failed', e); }
  }

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
        else this.hostLost('The host left the game. You’re flying solo now.');
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

  hostLost(msg) {
    if (this.role !== 'client') return;
    const inFlight = !!this.F;
    for (const p of this.players.values()) p.remote?.dispose();
    const peer = this.peer, labels = this.labels, panel = this.panel, F = this.F;
    this.reset(); // before destroy(): it fires 'close' synchronously, which would land back here
    try { peer?.destroy(); } catch { /* ignore */ }
    this.F = F; this.labels = labels; this.panel = panel; // keep flying solo
    this.renderPanel();
    if (inFlight) { this.ctx.hud.center('Host left', 2500); this.ctx.hud.toast(msg, 'bad'); }
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
    if (!this.role) return;
    const now = performance.now();
    this.send({ type: 'ping' });
    if (this.role === 'host') {
      for (const p of [...this.players.values()]) if (now - p.seen > TIMEOUT) { p.conn?.close(); this.removePlayer(p.id, 'timeout'); this.broadcast({ type: 'left', id: p.id }); }
    } else if (now - this.hostSeen > TIMEOUT) this.hostLost('Lost the connection to the host. You’re flying solo now.');
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
    if (this.role === 'host') this.ctx.hud.toast(`Room code ${this.code}: others tap Multiplayer → Join`, 'good');
    else this.ctx.hud.toast(`Joined room ${this.code}`, 'good');
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
    for (const p of this.players.values()) {
      const r = p.remote; if (!r) continue;
      r.update(dt, f.env); r.effects(f.effects); r.updateLabel(camera, units);
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
    if (!this.role) { this.panel.style.display = 'none'; return; }
    this.panel.style.display = '';
    const rows = [`<li><b style="color:#ffd400">●</b> ${esc(this.name)} <small>(you${this.role === 'host' ? ', host' : ''})</small></li>`,
      ...[...this.players.values()].map((p) => `<li><b style="color:${p.color}">●</b> ${esc(p.name)}${p.id === 1 ? ' <small>(host)</small>' : ''}</li>`)];
    this.panel.innerHTML = `<div class="mp-code">Room <b>${esc(this.code)}</b></div><ul>${rows.join('')}</ul>`;
  }
  pauseHTML() {
    if (!this.role) return '';
    return `<div class="mp-pause">Multiplayer room <b>${esc(this.code)}</b> · ${this.count} pilot${this.count === 1 ? '' : 's'}${this.role === 'host' ? '<br><small>Others join with this code. Leaving to the hangar ends the game for everyone.</small>' : ''}</div>`;
  }

  // ---------- lobby ----------
  openModal() {
    const { ui, getCfg, getDesign, LS } = this.ctx, c = getCfg();
    const where = `${LOCATIONS[c.location]?.name || c.location} · ${WEATHER[c.weather]?.name || c.weather} · ${REALISM[c.realism]?.name || c.realism}`;
    const m = ui.modal(`
      <h2>Multiplayer</h2>
      <p class="mp-note">Fly together on the same Wi-Fi. Connecting needs the internet for a moment; after that the planes talk to each other directly.</p>
      <label class="lbl">Your name</label>
      <input id="mp-name" class="mp-input" maxlength="16" autocomplete="off" value="${esc(this.name)}">
      <div class="mp-cols">
        <div class="mp-box"><h3>Host a game</h3><p>Uses your flight settings:<br><b>${esc(where)}</b></p><button class="primary big" id="mp-host">Host</button></div>
        <div class="mp-box"><h3>Join a game</h3><input id="mp-code" class="mp-input mp-code-in" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="primary big" id="mp-join">Join</button></div>
      </div>
      <p id="mp-status" class="mp-status"></p>
      <p class="mp-note small">Flying <b>${esc(getDesign().name || 'your plane')}</b>. Up to 6 pilots, free flight only. Planes pass through each other.</p>
      <div class="modal-foot"><button data-close>Back</button></div>`, 'wide sticky');
    const el = m.el, status = el.querySelector('#mp-status');
    const nameIn = el.querySelector('#mp-name'), codeIn = el.querySelector('#mp-code');
    nameIn.addEventListener('input', () => { this.name = cleanName(nameIn.value); LS.set('mpName', this.name); });
    codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    const busy = (on, msg = '', bad = false) => { el.querySelectorAll('#mp-host, #mp-join').forEach((b) => (b.disabled = on)); status.textContent = msg; status.classList.toggle('bad', bad); };
    let closed = false; el.querySelector('[data-close]').addEventListener('click', () => { closed = true; });
    const go = async (fn, msg) => {
      busy(true, msg);
      try {
        const cfg = await fn();
        if (closed) { this.leave(); return; }
        m.close(); this.ctx.startFlight(cfg);
      } catch (e) { console.warn(e); busy(false, e.message || String(e), true); }
    };
    el.querySelector('#mp-host').addEventListener('click', () => go(async () => { await this.host(); return { ...getCfg(), mode: 'free', mpSlot: 0 }; }, 'Opening a room…'));
    el.querySelector('#mp-join').addEventListener('click', () => go(async () => { const w = await this.join(codeIn.value); return { ...getCfg(), ...w.cfg, mode: 'free', start: 'air', mpSlot: w.slot }; }, 'Connecting…'));
    codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.querySelector('#mp-join').click(); });
  }
}
