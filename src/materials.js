import * as THREE from 'three';
import { makeNoise } from './noise.js';

const cache = new Map();
function cached(key, make) { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); }

// Subtle procedural grime/roughness texture so surfaces don't look like plastic.
let _grime;
export function grimeTexture() {
  if (_grime) return _grime;
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), img = g.createImageData(s, s), n = makeNoise(7);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    // tileable-ish by sampling on a torus
    const a = (x / s) * Math.PI * 2, b = (y / s) * Math.PI * 2;
    const v = n.fbm(Math.cos(a) * 1.5 + Math.cos(b) * 0.7, Math.sin(a) * 1.5 + Math.sin(b) * 0.7, 4);
    const k = 200 + v * 40 + (Math.random() - 0.5) * 10;
    const i = (y * s + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = k; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  _grime = new THREE.CanvasTexture(c);
  _grime.wrapS = _grime.wrapT = THREE.RepeatWrapping;
  return _grime;
}

// Panel seams and rivet lines (bump map) so bodies read as real aircraft skins.
let _panel;
export function panelTexture() {
  if (_panel) return _panel;
  const s = 512, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, s, s);
  g.strokeStyle = '#3a3a3a'; g.lineWidth = 2;
  for (let x = 0; x <= s; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke(); }
  for (let y = 0; y <= s; y += 128) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
  for (let y = 32; y < s; y += 128) for (let x = 0; x < s; x += 64) { g.beginPath(); g.moveTo(x + 6, y + 40); g.lineTo(x + 58, y + 40); g.stroke(); }
  g.fillStyle = '#5c5c5c';
  for (let x = 0; x <= s; x += 64) for (let y = 4; y < s; y += 9) { g.beginPath(); g.arc(x + 5, y, 1.2, 0, 7); g.fill(); }
  for (let y = 0; y <= s; y += 128) for (let x = 4; x < s; x += 9) { g.beginPath(); g.arc(x, y + 5, 1.2, 0, 7); g.fill(); }
  _panel = new THREE.CanvasTexture(c); _panel.wrapS = _panel.wrapT = THREE.RepeatWrapping; _panel.repeat.set(1, 1); _panel.anisotropy = 8;
  return _panel;
}

export const M = {
  paint(color, finish = 'gloss') {
    return cached('paint' + color + finish, () => new THREE.MeshPhysicalMaterial({
      color, metalness: finish === 'metal' ? 0.85 : 0.15, roughness: finish === 'matte' ? 0.7 : 0.38,
      clearcoat: finish === 'gloss' ? 0.8 : 0.1, clearcoatRoughness: 0.15, roughnessMap: grimeTexture(),
      bumpMap: panelTexture(), bumpScale: 1.2,
    }));
  },
  aluminum: () => cached('alu', () => new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.9, roughness: 0.32, roughnessMap: grimeTexture() })),
  darkMetal: () => cached('dm', () => new THREE.MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.7, roughness: 0.45 })),
  steel: () => cached('steel', () => new THREE.MeshStandardMaterial({ color: 0x8b9097, metalness: 1, roughness: 0.25 })),
  chrome: () => cached('chrome', () => new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.08 })),
  rubber: () => cached('rub', () => new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0, roughness: 0.9 })),
  black: () => cached('blk', () => new THREE.MeshStandardMaterial({ color: 0x111215, metalness: 0.3, roughness: 0.6 })),
  intake: () => cached('intake', () => new THREE.MeshStandardMaterial({ color: 0x050506, metalness: 0.2, roughness: 0.9, side: THREE.DoubleSide })),
  prop: () => cached('prop', () => new THREE.MeshStandardMaterial({ color: 0x222326, metalness: 0.4, roughness: 0.5 })),
  propTip: () => cached('propTip', () => new THREE.MeshStandardMaterial({ color: 0xf2c300, metalness: 0.2, roughness: 0.5 })),
  glass: (tint = 0x9fc6e0) => cached('glass' + tint, () => new THREE.MeshPhysicalMaterial({
    color: tint, metalness: 0.1, roughness: 0.04, transparent: true, opacity: 0.38, envMapIntensity: 1.6,
    clearcoat: 1, side: THREE.DoubleSide, depthWrite: false,
  })),
  propDisc: () => cached('pdisc', () => new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })),
  flame: () => cached('flame', () => new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.5, 0.5), transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })),
  flameCore: () => cached('flameCore', () => new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.2, 5), transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false })),
  light: (color) => cached('light' + color, () => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(4) })),
  burnt: () => cached('burnt', () => new THREE.MeshStandardMaterial({ color: 0x1c1a18, metalness: 0.4, roughness: 0.85 })),
  pilot: () => cached('pilot', () => new THREE.MeshStandardMaterial({ color: 0xeaeaea, metalness: 0.1, roughness: 0.5 })),
  visor: () => cached('visor', () => new THREE.MeshStandardMaterial({ color: 0x332200, metalness: 0.9, roughness: 0.1 })),
};

// Soft round puff texture (clouds/smoke)
export function puffTexture() {
  return cached('puff', () => {
    const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    const n = makeNoise(3);
    const img = g.createImageData(s, s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = x / s - 0.5, dy = y / s - 0.5, r = Math.sqrt(dx * dx + dy * dy) * 2;
      const nn = n.fbm(x / 28, y / 28, 4) * 0.35;
      let a = Math.max(0, 1 - (r + nn * 0.6)); a = a * a * (3 - 2 * a);
      const i = (y * s + x) * 4;
      const shade = 230 + 25 * (0.5 - dy) ;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.min(255, shade); img.data[i + 3] = a * 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

export function glowTexture() {
  return cached('glow', () => {
    const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(c);
  });
}
