/* Headless smoke test for Neon Pups: boots the REAL built bundle (dist/neon-pups.html)
 * under jsdom with a duck-typed THREE, then races it.
 *
 *     npm install jsdom            (one-off, dev only)
 *     python3 build.py && node tools/smoke-neon.js
 *
 * Same contract as tools/smoke.js -- wiring, not pixels -- and the same output format, so
 * tools/revert-neon.py can parse it. Kept as a separate file rather than more cases in
 * smoke.js because it boots a different bundle on a different page.
 *
 * What it is here to catch: a course that is not a connected path, a ribbon tighter than
 * its own width (the inside edge folds through itself), a board that escapes the bumpers,
 * bumpers that do not cost speed, gravity that does nothing, a record set by a run that
 * switched gravity half way, and a top-level name that shadows a window global in the
 * flattened bundle (`let screen` did exactly that during development).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = process.argv[2] || path.join(__dirname, '..');

// ---------- THREE stub ----------
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; if (z !== undefined) this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new V3(this.x, this.y, this.z); }
  setScalar(s) { return this.set(s, s, s); }
  multiplyScalar(s) { return this.set(this.x * s, this.y * s, this.z * s); }
  add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v) { return this.set(this.x - v.x, this.y - v.y, this.z - v.z); }
  normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; return this.multiplyScalar(1 / l); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lerp(v, t) { return this.set(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t); }
  applyAxisAngle() { return this; } applyQuaternion() { return this; } applyMatrix4() { return this; }
  addScaledVector(v, k) { return this.set(this.x + v.x * k, this.y + v.y * k, this.z + v.z * k); }
  subVectors(a, b) { return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
  addVectors(a, b) { return this.set(a.x + b.x, a.y + b.y, a.z + b.z); }
  divideScalar(s) { return this.multiplyScalar(s ? 1 / s : 0); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return this.set(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x); }
  crossVectors(a, b) { return this.copy(a).cross(b); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  negate() { return this.multiplyScalar(-1); } setLength(l) { return this.normalize().multiplyScalar(l); }
  lerpVectors(a, b, t) { return this.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
  setFromMatrixPosition() { return this; } fromArray(a, o = 0) { return this.set(a[o], a[o + 1], a[o + 2]); }
  toArray() { return [this.x, this.y, this.z]; } equals(v) { return this.x === v.x && this.y === v.y && this.z === v.z; }
}
class Obj3D {
  constructor() {
    this.position = new V3(); this.rotation = new V3(); this.scale = new V3(1, 1, 1);
    this.children = []; this.visible = true; this.name = ''; this.userData = {}; this.frustumCulled = true;
  }
  add(...o) { for (const c of o) if (c) { this.children.push(c); c.parent = this; } return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse && c.traverse(fn); }
  getObjectByName(n) { let f = null; this.traverse(o => { if (!f && o.name === n) f = o; }); return f; }
  lookAt(x, y, z) { this.lookedAt = { x, y, z }; } updateProjectionMatrix() {} updateMatrixWorld() {}
}
class Geometry {
  constructor(...a) { this.attributes = {}; this.index = null; this.args = a; this.userData = {}; }
  setAttribute(k, v) { this.attributes[k] = v; return this; }
  getAttribute(k) { return this.attributes[k]; }
  setIndex(i) { this.index = i; return this; }
  computeVertexNormals() {} translate() { return this; } rotateX() { return this; } rotateY() { return this; }
  rotateZ() { return this; } scale() { return this; } dispose() {} center() { return this; }
  applyMatrix4() { return this; } computeBoundingBox() { this.boundingBox = { min: new V3(), max: new V3() }; }
}
class Color {
  constructor(c) { this.r = this.g = this.b = 1; if (c !== undefined) this.set(c); }
  set(c) {
    if (c instanceof Color) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
    if (typeof c === 'number') { this.r = ((c >> 16) & 255) / 255; this.g = ((c >> 8) & 255) / 255; this.b = (c & 255) / 255; return this; }
    if (typeof c === 'string' && c[0] === '#') { const h = c.slice(1); return this.set(parseInt(h.length === 3 ? h.replace(/./g, m => m + m) : h, 16)); }
    return this;
  }
  setHex(h) { return this.set(h); } copy(c) { return this.set(c); } clone() { return new Color(this); }
  getHex() { return (Math.round(this.r * 255) << 16) | (Math.round(this.g * 255) << 8) | Math.round(this.b * 255); }
  lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; }
}
class Material {
  constructor(p = {}) { Object.assign(this, p); if ('color' in p) this.color = new Color(p.color); if (this.opacity === undefined) this.opacity = 1; }
  dispose() {} clone() { return new Material(this); }
}
const withGeo = class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } };
const stats = { renders: 0 };
const THREE = {
  Vector2: V3, Vector3: V3, Euler: V3, Object3D: Obj3D, Group: Obj3D, Color,
  Mesh: class extends withGeo { constructor(g, m) { super(g, m); this.isMesh = true; } },
  Line: withGeo, LineLoop: withGeo, LineSegments: class extends withGeo { constructor(g, m) { super(g, m); this.isLineSegments = true; } },
  Points: class extends withGeo { constructor(g, m) { super(g, m); this.isPoints = true; } },
  Sprite: class extends Obj3D { constructor(m) { super(); this.material = m; this.isSprite = true; } },
  BufferGeometry: Geometry,
  BufferAttribute: class { constructor(a, s) { this.array = a; this.itemSize = s; this.count = a.length / s; } },
  Float32BufferAttribute: class { constructor(a, s) { this.array = Float32Array.from(a); this.itemSize = s; this.count = a.length / s; } },
  Scene: class extends Obj3D { constructor() { super(); this.background = null; this.fog = null; } },
  PerspectiveCamera: class extends Obj3D { constructor(f, a, n, fa) { super(); this.fov = f; this.aspect = a; this.near = n; this.far = fa; } },
  WebGLRenderer: class {
    constructor(o = {}) { this.domElement = o.canvas || { style: {} }; this.shadowMap = {}; }
    setPixelRatio() {} setSize() {} render() { stats.renders++; } setClearColor() {}
  },
  Fog: class { constructor(c, n, f) { this.color = new Color(c); this.near = n; this.far = f; } },
  HemisphereLight: class extends Obj3D { constructor(s, g, i) { super(); this.color = new Color(s); this.groundColor = new Color(g); this.intensity = i; } },
  DirectionalLight: class extends Obj3D { constructor(c, i) { super(); this.intensity = i; this.shadow = { mapSize: { set() {} }, camera: {}, bias: 0 }; } },
  AmbientLight: class extends Obj3D {},
  DataTexture: class { dispose() {} }, Texture: class { dispose() {} },
  CanvasTexture: class { constructor() { this.repeat = { set() {} }; } dispose() {} },
  CatmullRomCurve3: class { constructor(p) { this.points = p; } getPoints() { return this.points; } },
  Matrix4: class { makeRotationY() { return this; } makeTranslation() { return this; } multiply() { return this; } },
  Quaternion: class {},
  NearestFilter: 1, LinearFilter: 2, RepeatWrapping: 3, LuminanceFormat: 4, DoubleSide: 2, FrontSide: 0, BackSide: 1,
  sRGBEncoding: 5, PCFSoftShadowMap: 6, AdditiveBlending: 2, NormalBlending: 1,
  MathUtils: { lerp: (a, b, t) => a + (b - a) * t },
};
for (const n of ['MeshToonMaterial', 'MeshBasicMaterial', 'MeshStandardMaterial', 'MeshLambertMaterial', 'LineBasicMaterial',
  'PointsMaterial', 'SpriteMaterial', 'ShaderMaterial']) THREE[n] = Material;
for (const n of ['BoxGeometry', 'PlaneGeometry', 'SphereGeometry', 'CylinderGeometry', 'ConeGeometry', 'DodecahedronGeometry',
  'IcosahedronGeometry', 'TorusGeometry', 'CircleGeometry', 'RingGeometry', 'ExtrudeGeometry', 'ShapeGeometry', 'LatheGeometry',
  'TubeGeometry', 'TetrahedronGeometry', 'OctahedronGeometry']) THREE[n] = Geometry;
THREE.Shape = class { constructor(p) { this.points = p || []; this.holes = []; } moveTo() {} lineTo() {} quadraticCurveTo() {}
  bezierCurveTo() {} absarc() {} arc() {} closePath() {} getPoints() { return this.points; } };
THREE.Path = THREE.Shape;

// ---------- DOM ----------
const html = fs.readFileSync(path.join(ROOT, 'neon/index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/neon/', pretendToBeVisual: true });
{
  // jsdom ignores <link rel=stylesheet>; inline it so data-screen rules are real
  const style = dom.window.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(ROOT, 'styles/neon.css'), 'utf8');
  dom.window.document.head.appendChild(style);
}
const { window } = dom;
const WINDOW_NAMES = new Set();
for (let o = window; o; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) WINDOW_NAMES.add(k);
global.window = window; global.document = window.document; global.navigator = window.navigator;
global.location = window.location; global.THREE = THREE; window.THREE = THREE;
global.URLSearchParams = window.URLSearchParams; global.localStorage = window.localStorage;
global.requestAnimationFrame = fn => { global.__raf = fn; }; window.requestAnimationFrame = global.requestAnimationFrame;
global.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
window.matchMedia = global.matchMedia;
global.devicePixelRatio = 2; global.screen = { width: 1440, height: 900 };
global.performance = { now: () => Date.now() };
global.atob = s => Buffer.from(s, 'base64').toString('binary');
const ctx2d = new Proxy({}, {
  get(_, k) {
    if (k === 'measureText') return () => ({ width: 40 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    return typeof k === 'string' ? (() => {}) : undefined;
  }, set() { return true; },
});
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = (tag, ...rest) => {
  const el = origCreate(tag, ...rest);
  if (String(tag).toLowerCase() === 'canvas') el.getContext = () => ctx2d;
  return el;
};
{
  const pad = window.document.getElementById('tSteer');
  if (pad) pad.getBoundingClientRect = () => ({ left: 100, top: 600, width: 240, height: 84, right: 340, bottom: 684 });
}
for (const id of ['c', 'preview', 'minimap']) {
  const cv = window.document.getElementById(id);
  cv.getContext = () => (id === 'c' ? null : ctx2d);
  Object.defineProperty(cv, 'clientWidth', { value: id === 'c' ? 1200 : 240 });
  Object.defineProperty(cv, 'clientHeight', { value: id === 'c' ? 800 : 240 });
}
global.fetch = window.fetch = async (url) => {
  const file = path.join(ROOT, String(url).replace(/^.*?\/neon\//, '').replace(/^(\.\.\/)+/, ''));
  if (!fs.existsSync(file)) return { ok: false, status: 404, async json() { throw new Error('404'); } };
  return { ok: true, status: 200, async json() { return JSON.parse(fs.readFileSync(file, 'utf8')); } };
};
const audioLog = { nodes: [], filters: [], buffers: 0, samples: [] };
global.audioLog = audioLog;
class FakeParam { constructor() { this.value = 0; } setValueAtTime(v) { this.value = v; return this; } exponentialRampToValueAtTime(v) { this.value = v; return this; } linearRampToValueAtTime(v) { this.value = v; return this; } }
class FakeNode {
  constructor(kind) { this.kind = kind; this.frequency = new FakeParam(); this.gain = new FakeParam(); this.Q = new FakeParam(); audioLog.nodes.push(this); }
  connect(d) { if (d == null) throw new TypeError('connect(null)'); return d; } start() {} stop() {}
}
global.AudioContext = window.AudioContext = class {
  constructor() { this.state = 'running'; this.sampleRate = 44100; this.destination = new FakeNode('dest'); }
  get currentTime() { return 5; } resume() { return Promise.resolve(); }
  createOscillator() { return new FakeNode('osc'); }
  createBiquadFilter() { const n = new FakeNode('filter'); audioLog.filters.push(n); return n; }
  createGain() { return new FakeNode('gain'); } createBufferSource() { return new FakeNode('buffersource'); }
  createBuffer(c, l) {
    // ONE array per buffer, kept: the app fills it, and the assertions read what it wrote
    const data = new Float32Array(l);
    audioLog.buffers++; audioLog.samples.push(data);
    return { length: l, sampleRate: 44100, getChannelData() { return data; } };
  }
};

// ---------- run the real bundle ----------
const bundleHtml = fs.readFileSync(path.join(ROOT, 'dist/neon-pups.html'), 'utf8');
const scripts = [...bundleHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts[scripts.length - 1];
console.log(`app bundle: ${(app.length / 1024) | 0} KB`);
const errors = [];
process.on('unhandledRejection', e => errors.push('unhandledRejection: ' + (e && e.stack)));
const origError = console.error;
console.error = (...a) => errors.push('console.error: ' + a.map(String).join(' '));
/* let/const at the top of an indirect eval are private to it, so anything the assertions
   need that is not a function declaration has to be handed out from inside the same eval. */
const probe = `
;globalThis.__neon = { state: neonState, scene: () => scene, camera: () => camera,
  keys: neonKeys, touch: neonTouch, skills: NEON_SKILL, setScale, setReverse, setGravity,
  reverseTrack, trackFrame, trackFor, buildTrack, mph, miles, feet,
  setClass, setCam, cycleCam, topSpeed, placeCells, stepCells, classes: NEON_CLASS, cams: NEON_CAM,
  makeRecorder, recordFrame, finishRecording, bestGhosts, keepGhost, ghostDt: GHOST_DT };`;
try { (0, eval)(app + probe); }
catch (e) { origError('THREW during boot:', e.message, '\n', e.stack.split('\n').slice(0, 6).join('\n')); process.exit(1); }

const pump = async (n, t0 = 0) => {
  for (let i = 0; i < n; i++) {
    await new Promise(r => setImmediate(r));
    if (global.__raf) { const fn = global.__raf; global.__raf = null; fn(t0 + i * 16.667); }
  }
};
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const click = id => window.document.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const finite = a => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

(async () => {
  await pump(30);
  const N = global.__neon;
  let S = N.state();

  // ---- boot ----
  check('the default map loads and the menu is up', S.screen === 'menu' && S.courses.length > 0 && S.hasDem,
    `${S.courses.length} courses`);
  check('START is enabled once courses exist', !window.document.getElementById('startBtn').disabled);
  check('the course list shows every course',
    window.document.querySelectorAll('#courseList .course').length === S.courses.length);
  check('the rider list offers starter pups and wildlife',
    window.document.querySelectorAll('#riderSel option').length >= 6 + 10);

  // ---- courses ----
  const G = S.graph;
  {
    let broken = [], short = [];
    for (const c of S.courses) {
      const seen = new Set();
      c.steps.forEach((st, i) => {
        if (seen.has(st.ei)) broken.push(c.name + ': edge twice');
        seen.add(st.ei);
        const e = G.edges[st.ei], end = st.fwd ? e.b : e.a;
        const nx = c.steps[(i + 1) % c.steps.length], ne = G.edges[nx.ei], start = nx.fwd ? ne.a : ne.b;
        if ((i < c.steps.length - 1 || c.kind === 'circuit') && end !== start && c.steps.length > 1) broken.push(c.name + ': gap after step ' + i);
      });
      if (c.lenM < 400) short.push(c.name);
    }
    check('every course is one connected path that never reuses an edge', !broken.length, broken.slice(0, 3).join('; '));
    check('no course is too short to be a race', !short.length, short.join(', '));
    check('the courses cover the map', S.coverInfo.coverage >= 0.85, `${(S.coverInfo.coverage * 100).toFixed(1)}%`);
    check('the course list is a usable length', S.courses.length >= 8 && S.courses.length <= 40, String(S.courses.length));
    check('both course shapes are offered', S.courses.some(c => c.kind === 'circuit') && S.courses.some(c => c.kind === 'sprint'));
    const sigs = new Set(S.courses.map(c => c.sig)), names = new Set(S.courses.map(c => c.name));
    check('course signatures and names are unique', sigs.size === S.courses.length && names.size === S.courses.length);
    const again = buildCourses(G, null).courses.map(c => c.kind + c.steps.map(s => s.ei).sort().join('.')).sort().join('|');
    const again2 = buildCourses(G, null).courses.map(c => c.kind + c.steps.map(s => s.ei).sort().join('.')).sort().join('|');
    check('course generation is deterministic', again === again2);
    const big = buildCourses({ nodes: [{ p: [0, 0] }, { p: [20000, 0] }],
      edges: [{ a: 0, b: 1, pts: [[0, 0], [20000, 0]], lenM: 20000, name: 'Long Road', route: 'Long Road', named: true, kind: 'road' }] }, null);
    check('a very long road is split into stages', big.courses.length >= 3 && big.courses.every(c => c.clip && c.lenM < 8000),
      `${big.courses.length} stages`);
  }

  // ---- tracks ----
  {
    const T_ = N.state().tuning;
    let tight = [], bad = [], off = [];
    for (const c of S.courses) {
      const T = trackFor(c);
      let worst = 0;
      for (let i = 0; i < T.n; i++) worst = Math.max(worst, Math.abs(T.k[i]) * (T.halfW[i] + T_.minRadiusPad));
      if (worst > 1.08) tight.push(`${c.name} (${worst.toFixed(2)})`);
      if (!['x', 'z', 'elev', 'yaw', 'k', 'slope', 'halfW'].every(k => finite(T[k]))) bad.push(c.name);
      if (Math.abs(T.L - c.lenM) / c.lenM > 0.15) off.push(`${c.name} ${T.L | 0} vs ${c.lenM | 0}`);
    }
    check('no ribbon bends tighter than its own width allows', !tight.length, tight.slice(0, 3).join('; '));
    check('every track array is finite', !bad.length, bad.join(', '));
    check('rounding the hairpins does not change a course length much', !off.length, off.slice(0, 3).join('; '));
  }

  // ---- scene ----
  {
    const sc = N.scene();
    const tr = sc.getObjectByName('neonTrack');
    check('the environment is in the scene', !!sc.getObjectByName('neonGrid') && !!sc.getObjectByName('neonLand') && !!sc.getObjectByName('neonGhost'));
    check('the selected course has a ribbon with a deck, two bumpers and a gate',
      !!tr && !!tr.getObjectByName('neonDeck') && !!tr.getObjectByName('neonBumperL') && !!tr.getObjectByName('neonBumperR') && !!tr.getObjectByName('neonGate'));
    const before = tr;
    window.document.querySelectorAll('#courseList .course')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const after = N.scene().getObjectByName('neonTrack');
    let count = 0; N.scene().traverse(o => { if (o.name === 'neonTrack') count++; });
    check('picking another course swaps the ribbon rather than stacking a second one', after !== before && count === 1, `${count} ribbons`);
  }

  // ---- physics, straight from the bundle's own functions ----
  {
    const T_ = N.state().tuning;
    const c = S.courses.find(c => c.kind === 'sprint') || S.courses[0];
    const T = trackFor(c);
    // drive flat out with the wheel held over: must hit the wall, must stay inside, must pay for it
    const r = makeRacer({ s: 5, d: 0, yaw: trackFrame(T, 5, {}).yaw });
    let escaped = 0, bumps = 0, lost = [], nan = false;
    for (let i = 0; i < 120 * 30 && r.s < T.L - 5; i++) {
      const v0 = r.v;
      const ev = stepRacer(r, T, { steer: 1, throttle: 1, brake: 0, boost: false }, { gravity: false }, 1 / 120);
      const lim = trackFrame(T, r.s, {}).halfW - T_.bodyWide * 0.5;
      if (Math.abs(r.d) > lim + 0.02) escaped++;
      if (ev) { bumps++; lost.push(r.v / Math.max(0.01, v0)); }
      if (![r.s, r.d, r.v, r.yaw].every(Number.isFinite)) nan = true;
    }
    check('a board held into the wall bounces off it', bumps >= 3, `${bumps} bumps`);
    check('a board never gets past the bumpers', escaped === 0 && !nan, `${escaped} frames outside`);
    const meanKeep = lost.reduce((a, b) => a + b, 0) / Math.max(1, lost.length);
    check('hitting a bumper costs speed, but not all of it', meanKeep < 0.9 && meanKeep > 0.5, `keeps ${(meanKeep * 100).toFixed(0)}%`);

    // gravity: find real up and down grades and coast them both ways
    let up = null, down = null;
    for (const cc of S.courses) {
      const TT = trackFor(cc);
      for (let i = 10; i < TT.n - 40; i++) {
        let mn = Infinity, mx = -Infinity;
        for (let q = 0; q < 25; q++) { mn = Math.min(mn, TT.slope[i + q]); mx = Math.max(mx, TT.slope[i + q]); }
        if (!up && mn > 0.05) up = { T: TT, s: i * TT.ds };
        if (!down && mx < -0.05) down = { T: TT, s: i * TT.ds };
      }
      if (up && down) break;
    }
    const coast = (spot, gravity) => {
      const q = makeRacer({ s: spot.s, d: 0, yaw: trackFrame(spot.T, spot.s, {}).yaw, v: 15 });
      for (let i = 0; i < 120 * 3; i++) {
        const f = trackFrame(spot.T, q.s, {});
        q.yaw = f.yaw; q.d = 0;                            // hold the centreline: isolate the slope term
        stepRacer(q, spot.T, { steer: 0, throttle: 0.6, brake: 0, boost: false }, { gravity }, 1 / 120);
      }
      return q.v;
    };
    check('the map has real grades to race on', !!up && !!down);
    if (up && down) {
      const uOn = coast(up, true), uOff = coast(up, false), dOn = coast(down, true), dOff = coast(down, false);
      check('gravity on: uphill is slower than with gravity off', uOn < uOff - 0.5, `${uOn.toFixed(1)} vs ${uOff.toFixed(1)} m/s`);
      check('gravity on: downhill is faster than with gravity off', dOn > dOff + 0.5, `${dOn.toFixed(1)} vs ${dOff.toFixed(1)} m/s`);
      check('gravity off: a hill changes nothing', Math.abs(uOff - dOff) < 0.05, `${uOff.toFixed(2)} vs ${dOff.toFixed(2)}`);
      check('even the steepest climb can be ridden', coast(up, true) > 4);
    }

    // a full field of rivals, start to finish, on a circuit and on a sprint
    for (const kind of ['circuit', 'sprint']) {
      const cc = S.courses.find(x => x.kind === kind); if (!cc) continue;
      const TT = trackFor(cc);
      const field = [];
      for (let i = 0; i < 6; i++) {
        const s0 = 5 + Math.floor(i / 2) * 7;
        field.push(makeRacer({ s: s0, d: (i % 2 ? -1 : 1) * 1.5, yaw: trackFrame(TT, s0, {}).yaw,
          skill: N.skills.fair, paceMul: 0.96 + i * 0.01, lane: (i % 3 - 1) * 0.5, seed: i + 1 }));
      }
      let t = 0, bad = false, outside = 0;
      while (t < 900 && !field.every(r => r.done)) {
        for (const r of field) {
          stepRacer(r, TT, rivalInput(r, TT, field, { gravity: true }, t), { gravity: true }, 1 / 60);
          if (![r.s, r.d, r.v, r.yaw].every(Number.isFinite)) bad = true;
          if (Math.abs(r.d) > trackFrame(TT, r.s, {}).halfW) outside++;
        }
        resolveContacts(field, TT); t += 1 / 60;
      }
      const dist = raceDistance(TT), slow = Math.max(...field.map(r => r.finishT || Infinity));
      check(`six rivals all finish a ${kind}, cleanly`, field.every(r => r.done) && !bad && outside === 0,
        `${(dist / 1000).toFixed(1)} km in ${slow.toFixed(0)} s, ${field.reduce((a, r) => a + r.bumps, 0)} bumps`);
      check(`rivals on a ${kind} ride at a sane pace`, dist / slow > 11 && dist / slow < 34, `${(dist / slow).toFixed(1)} m/s`);
      const bumpRate = field.reduce((a, r) => a + r.bumps, 0) / field.length / (slow / 60);
      check(`rivals on a ${kind} are not pinballing`, bumpRate < 6, `${bumpRate.toFixed(1)} bumps/min each`);
    }
  }

  // ---- the race itself, through the UI ----
  {
    const d = window.document;
    const sprintIdx = S.courses.findIndex(c => c.kind === 'sprint');
    d.querySelectorAll('#courseList .course')[sprintIdx].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    S = N.state();
    const want = S.settings.rivals + 1;
    click('startBtn');
    await pump(2, 1000);
    S = N.state();
    check('START begins a countdown', S.screen === 'count' && !!S.race && S.race.phase === 'count');
    check('the grid is you plus the rivals asked for', S.race.racers.length === want && S.race.riders.length === want, `${S.race.racers.length}`);
    check('you start at the back of the grid', S.race.racers[S.race.me].isPlayer && S.race.racers.every(r => r.isPlayer || r.s >= S.race.racers[S.race.me].s));
    let riders = 0; N.scene().traverse(o => { if (o.name === 'neonRider') riders++; });
    check('every racer has a board and rider in the scene', riders === want, `${riders}`);
    const s0 = S.race.racers.map(r => r.s);
    await pump(60, 1100);
    check('nobody moves before GO', N.state().race.racers.every((r, i) => Math.abs(r.s - s0[i]) < 1e-6));
    await pump(260, 2200);
    S = N.state();
    check('after GO the screen is the race and the rivals are away', S.screen === 'race' && S.race.racers.some(r => !r.isPlayer && r.v > 5));
    N.keys.add('w');
    await pump(240, 7000);
    S = N.state();
    const me = S.race.racers[S.race.me];
    check('holding W drives the board', me.v > 8 && me.s > s0[S.race.me] + 20, `${me.v.toFixed(1)} m/s`);
    check('the HUD shows speed and place', +d.getElementById('speedVal').textContent > 20 && /^\d+$/.test(d.getElementById('placeVal').textContent));
    const cam = N.camera();
    check('the camera chases the player', Number.isFinite(cam.position.x) && Math.hypot(cam.position.x - cam.lookedAt.x, cam.position.z - cam.lookedAt.z) < 80);

    check('the HUD reports the settings the race started with', /GRAVITY/.test(d.getElementById('hudMode').textContent));
    check('there is no in-race gravity control', !d.getElementById('gravBtn'));
    {
      // the G key is a menu shortcut; during a race it must not change the run
      const before = S.settings.gravity;
      N.keys.delete('g');
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'g' }));
      S = N.state();
      check('G does nothing once the lights are out', S.settings.gravity === before && S.race.gravity === before);
      N.keys.delete('g');
    }
    me.s = S.race.T.L - 3; me.yaw = trackFrame(S.race.T, me.s, {}).yaw; me.d = 0;
    await pump(90, 12000);
    S = N.state();
    check('crossing the line shows the finish card', S.screen === 'finish' && S.race.racers[S.race.me].done);
    check('the finish board lists every racer', d.querySelectorAll('#finBoard li').length === want);
    const keys = Object.keys(S.bests);
    check('finishing records a best time keyed to gravity, scale, direction and class',
      keys.length === 1 && /\|g[01]\|s\d/.test(keys[0]) && keys[0].indexOf('|c' + S.settings.cls) > 0
      && S.bests[keys[0]] > 0, keys[0]);
    check('the finish time is shown as minutes and seconds', /^\d:\d\d\.\d$/.test(d.getElementById('finTime').textContent));
    N.keys.clear();
    click('menuBtn');
    await pump(3, 30000);
    S = N.state();
    riders = 0; N.scene().traverse(o => { if (o.name === 'neonRider') riders++; });
    check('back to the menu removes the race and its riders', S.screen === 'menu' && !S.race && riders === 0);
    check('the course list now shows the best time', /★/.test(d.querySelector('#courseList .course.on .best').textContent));
  }

  // ---- imperial units on screen ----
  {
    const d = window.document;
    S = N.state();
    check('the map line is in miles', /[\d.]+ mi\b/.test(d.getElementById('mapLine').textContent) && !/ km\b/.test(d.getElementById('mapLine').textContent));
    check('course lengths are in miles', [...d.querySelectorAll('#courseList .meta')].every(e => / mi\b/.test(e.textContent)));
    check('climb is in feet', /ft\b/.test(d.getElementById('courseInfo').textContent) && !/ m\b/.test(d.getElementById('courseInfo').textContent));
    check('30 m/s reads as 67 mph', Math.round(N.mph(30)) === 67, String(N.mph(30).toFixed(2)));
  }

  // ---- reverse direction ----
  {
    const d = window.document;
    const c = N.state().courses.find(x => x.kind === 'circuit') || N.state().courses[0];
    const F = trackFor(c, { reverse: false }), B = trackFor(c, { reverse: true });
    check('reversing keeps the same ribbon', B.n === F.n && Math.abs(B.L - F.L) < 1e-6 && B.reversed === true);
    let sameLine = true, turned = true, kFlip = true, slopeFlip = true;
    for (let i = 0; i < F.n; i++) {
      const j = F.closed ? (F.n - i) % F.n : F.n - 1 - i;
      if (Math.abs(B.x[i] - F.x[j]) > 1e-6 || Math.abs(B.z[i] - F.z[j]) > 1e-6 || Math.abs(B.elev[i] - F.elev[j]) > 1e-6) sameLine = false;
      if (Math.abs(Math.cos(B.yaw[i] - F.yaw[j] - Math.PI)) < 0.999999) turned = false;
      if (Math.abs(B.k[i] + F.k[j]) > 1e-9) kFlip = false;
      if (Math.abs(B.slope[i] + F.slope[j]) > 1e-9) slopeFlip = false;
    }
    check('the reversed track runs the same points backwards', sameLine);
    // the heading must point the way the track now goes, not the way it used to
    let heads = 0;
    for (let i = 0; i < B.n - 1; i++) {
      const want = Math.atan2(-(B.z[i + 1] - B.z[i]), B.x[i + 1] - B.x[i]);
      if (Math.cos(want - B.yaw[i]) < 0.9) heads++;
    }
    check('the reversed heading points the way the track now goes', heads === 0, `${heads} of ${B.n} samples backwards`);
    check('reversing turns the heading round and flips every bend and grade', turned && kFlip && slopeFlip);
    check('a climb one way is a descent the other', Math.abs(B.climb - (F.climb - (F.maxE - F.minE) * 0)) >= 0 && (F.closed ? Math.abs(B.climb - F.climb) < 1 : B.climb !== F.climb),
      `${F.climb.toFixed(0)} / ${B.climb.toFixed(0)} m`);
    // and it is still raceable: drive it with the AI
    const q = makeRacer({ s: 4, d: 0, yaw: trackFrame(B, 4, {}).yaw, skill: N.skills.chill, paceMul: 1, lane: 0, seed: 4 });
    let t = 0, outside = 0;
    while (t < 900 && !q.done) {
      stepRacer(q, B, rivalInput(q, B, [q], { gravity: true }, t), { gravity: true }, 1 / 60);
      if (Math.abs(q.d) > trackFrame(B, q.s, {}).halfW) outside++;
      t += 1 / 60;
    }
    check('a rival can race the reversed course', q.done && outside === 0, `${q.finishT ? q.finishT.toFixed(0) : '-'} s`);
    N.setReverse(true);
    S = N.state();
    check('the Reverse button sticks and is shown on the course', S.settings.reverse === true
      && d.querySelector('#dirSeg .btn[data-dir="rev"]').classList.contains('on')
      && /reverse/.test(d.getElementById('courseInfo').textContent));
    N.setReverse(false);
  }

  // ---- map scale ----
  {
    const d = window.document;
    const one = N.state().courses.map(c => ({ c, T: trackFor(c) }));
    const oneRatio = one.map(o => o.c.lenM / o.T.L).sort((p, q) => p - q)[one.length >> 1];
    const oneSlope = Math.max(...one.map(o => Math.max(...Array.from(o.T.slope).map(Math.abs))));
    const oneCount = one.length;
    N.setScale(4);
    S = N.state();
    const four = S.courses.map(c => ({ c, T: trackFor(c) }));
    const race4 = four.filter(o => o.T.ok);
    check('1:4 regenerates the course set', S.courses.length > 3 && S.settings.scale === 4, `${S.courses.length} courses`);
    const fourRatio = race4.map(o => o.c.lenM / o.T.L).sort((p, q) => p - q)[race4.length >> 1];
    check('at 1:4 a metre of racing covers four metres of trail', Math.abs(fourRatio / oneRatio / 4 - 1) < 0.25,
      `${oneRatio.toFixed(2)} -> ${fourRatio.toFixed(2)} real m per scene m`);
    let worst = 0;
    for (const o of race4) for (let i = 0; i < o.T.n; i++) worst = Math.max(worst, Math.abs(o.T.k[i]) * (o.T.halfW[i] + o.T.pad));
    check('every course offered at 1:4 is wider than its own corners', worst <= 1.08, worst.toFixed(2));
    check('most courses survive the scaling', race4.length / four.length >= 0.85, `${race4.length} of ${four.length} raceable`);
    const fourSlope = Math.max(...race4.map(o => Math.max(...Array.from(o.T.slope).map(Math.abs))));
    check('scaling down does not turn the hills into cliffs', Math.abs(fourSlope - oneSlope) < 0.08,
      `${oneSlope.toFixed(2)} vs ${fourSlope.toFixed(2)}`);
    /* Compare the narrowest point of each ribbon against that course's own board, not
       sample 0 against sample 0: the first sample of one course may be on a fire road and
       of another on singletrack, which is a two-to-one difference in width that has
       nothing to do with scale. */
    const roomy = list => list.map(o => Math.min(...o.T.halfW) / o.T.bodyWide);
    const r1 = roomy(one), r4 = roomy(race4);
    check('the board, the riders and the ribbon all narrow together at 1:4',
      race4.every(o => o.T.bodyWide < N.state().tuning.bodyWide)
      && Math.min(...r4) >= Math.min(...r1) * 0.9 && Math.max(...r4) <= Math.max(...r1) * 1.1,
      `${race4[0].T.bodyWide.toFixed(2)} m board on a ${(Math.min(...race4[0].T.halfW) * 2).toFixed(1)} m ribbon`);
    check('a 1:4 race is a shorter ride than the same map at 1:1',
      race4.every(o => o.T.L < 4000) && race4.some(o => o.T.L > 250));
    check('the scale is shown in the menu', /1:4/.test(d.getElementById('mapLine').textContent) && d.getElementById('scaleSel').value === '4');
    const land = N.scene().getObjectByName('neonLand');
    check('the scenery is rebuilt at the new scale', !!land && land.geometry.attributes.position.array.some(v => Math.abs(v) > 0));
    // an unraceable course is offered to nobody
    const bad = four.find(o => !o.T.ok);
    if (bad) {
      const idx = S.courses.indexOf(bad.c);
      window.document.querySelectorAll('#courseList .course')[idx].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      check('a course too tight at this scale is struck out and cannot be started',
        d.querySelectorAll('#courseList .course')[idx].classList.contains('off') && d.getElementById('startBtn').disabled);
      click('startBtn');
      check('pressing START on it does nothing', N.state().screen === 'menu' && !N.state().race);
    }
    N.setScale(1);
    S = N.state();
    check('going back to 1:1 restores the full-size course set', S.courses.length === oneCount && S.settings.scale === 1);
    await pump(40, 40000);
    S = N.state();
    check('the menu measures every course in the background', S.scanLeft === 0 && S.trackMeta.size >= S.courses.length,
      `${S.trackMeta.size} measured`);
    check('measured rows show the real length and climb',
      [...d.querySelectorAll('#courseList .course:not(.off) .meta')].every(e => / mi\b/.test(e.textContent) && /ft\b/.test(e.textContent)));
  }

  // ---- the course you were last on ----
  {
    const d = window.document;
    const pick = Math.min(3, N.state().courses.length - 1);
    d.querySelectorAll('#courseList .course')[pick].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    S = N.state();
    check('the selected course is remembered by signature, not by index',
      S.settings.course === S.courses[pick].sig && S.selCourse === pick, S.settings.course);
  }

  // ---- speed classes ----
  {
    N.setScale(1);
    const T = trackFor(N.state().courses[0]);
    const runFlat = speedK => {
      const r = makeRacer({ s: 5, d: 0, yaw: trackFrame(T, 5, {}).yaw, speedK });
      for (let i = 0; i < 120 * 40; i++) {
        const f = trackFrame(T, r.s, {});
        r.yaw = f.yaw; r.d = 0;
        stepRacer(r, T, { steer: 0, throttle: 1, brake: 0, boost: false }, { gravity: false }, 1 / 120);
      }
      return r.v;
    };
    const base = N.classes.standard.top;
    const slow = runFlat(N.classes.cruiser.top), fast = runFlat(N.classes.turbo.top);
    const mid = runFlat(base);
    check('a Cruiser tops out slower and a Turbo faster', slow < mid - 2 && fast > mid + 2,
      `${N.mph(slow) | 0} / ${N.mph(mid) | 0} / ${N.mph(fast) | 0} mph`);
    check('top speed follows the class multiplier', Math.abs(fast / mid / (N.classes.turbo.top / base) - 1) < 0.04
      && Math.abs(slow / mid / (N.classes.cruiser.top / base) - 1) < 0.04);
    check('rivals race the class you picked', Math.abs(N.topSpeed({ speedK: N.classes.turbo.top }) / N.topSpeed({ speedK: base })
      - N.classes.turbo.top / base) < 1e-9);
    const d = window.document;
    N.setClass('turbo');
    check('the class sticks and is shown', N.state().settings.cls === 'turbo'
      && d.querySelector('#classSeg .btn[data-cls="turbo"]').classList.contains('on'));
    N.setClass('standard');
  }

  // ---- boost is one burn per press ----
  {
    const T = trackFor(N.state().courses[0]);
    const tune = N.state().tuning;
    const r = makeRacer({ s: 5, d: 0, yaw: trackFrame(T, 5, {}).yaw, v: 14, battery: 1 });
    let burns = 0, boostFrames = 0, battAtFire = null;
    const drive = (boost, secs) => {
      for (let i = 0; i < 120 * secs; i++) {
        const f = trackFrame(T, r.s, {});
        r.yaw = f.yaw; r.d = 0;
        stepRacer(r, T, { steer: 0, throttle: 1, brake: 0, boost }, { gravity: false }, 1 / 120);
        if (r.burnFired) { burns++; if (battAtFire == null) battAtFire = r.battery; }
        if (r.burnT > 0) boostFrames++;
      }
    };
    const batt0 = r.battery;
    drive(true, 6);                                  // held down for six seconds
    check('holding boost lights exactly one burn', burns === 1, `${burns} burns`);
    /* Measured by THRUST, not by the timer that is supposed to drive it: two identical
       boards, one holding the button, and the burn is the window over which the boosted
       one out-accelerates its twin. A version that simply reports r.burnT would pass even
       if the timer were wired to nothing. */
    {
      const seat = v => makeRacer({ s: 5, d: 0, yaw: trackFrame(T, 5, {}).yaw, v, battery: 1 });
      const hot = seat(14), cold = seat(14);
      let boostSecs = 0;
      for (let i = 0; i < 120 * 6; i++) {
        const h0 = hot.v, c0 = cold.v;
        for (const [q, boost] of [[hot, true], [cold, false]]) {
          const f = trackFrame(T, q.s, {});
          q.yaw = f.yaw; q.d = 0;
          stepRacer(q, T, { steer: 0, throttle: 1, brake: 0, boost }, { gravity: false }, 1 / 120);
        }
        if ((hot.v - h0) - (cold.v - c0) > 0.005) boostSecs += 1 / 120;
      }
      check('the burn is a fixed length', Math.abs(boostSecs - tune.burnS) < 0.15,
        `${boostSecs.toFixed(2)} s of extra thrust vs ${tune.burnS} s`);
    }
    check('a burn spends a fixed slice of the pack', battAtFire != null
      && Math.abs((batt0 - battAtFire) - tune.burnCost) < 0.02,
      `${battAtFire == null ? 'never fired' : (batt0 - battAtFire).toFixed(3) + ' of ' + tune.burnCost}`);
    drive(false, 0.1); burns = 0;
    drive(true, 3);
    check('releasing and pressing again lights another', burns === 1);
    // a burn actually accelerates
    const a = makeRacer({ s: 5, d: 0, yaw: trackFrame(T, 5, {}).yaw, v: 14, battery: 1 });
    const b = makeRacer({ s: 5, d: 0, yaw: trackFrame(T, 5, {}).yaw, v: 14, battery: 1 });
    for (let i = 0; i < 120 * 1.5; i++) {
      for (const [q, boost] of [[a, true], [b, false]]) {
        const f = trackFrame(T, q.s, {});
        q.yaw = f.yaw; q.d = 0;
        stepRacer(q, T, { steer: 0, throttle: 1, brake: 0, boost }, { gravity: false }, 1 / 120);
      }
    }
    check('a burn is worth having', a.v > b.v + 2, `${a.v.toFixed(1)} vs ${b.v.toFixed(1)} m/s`);
    const flat = makeRacer({ s: 5, d: 0, yaw: trackFrame(T, 5, {}).yaw, v: 14, battery: 0.05 });
    let fired = false;
    for (let i = 0; i < 120; i++) {
      stepRacer(flat, T, { steer: 0, throttle: 1, brake: 0, boost: i % 2 === 0 }, { gravity: false }, 1 / 120);
      if (flat.burnFired) fired = true;
    }
    check('an empty pack cannot burn', !fired);
  }

  // ---- boost cells on the course ----
  {
    const T = trackFor(N.state().courses.find(c => c.kind === 'sprint') || N.state().courses[0]);
    const tune = N.state().tuning;
    const cells = N.placeCells(T);
    check('cells are laid along the whole course', cells.length >= Math.floor(T.L / tune.cellEveryM) - 1
      && cells.every(c => c.s >= 0 && c.s <= T.L), `${cells.length} cells over ${(T.L / 1000).toFixed(2)} km`);
    check('cells sit on the track, not in the bumpers',
      cells.every(c => Math.abs(c.d) < trackFrame(T, c.s, {}).halfW - T.bodyWide * 0.5));
    check('cells are placed the same way every time',
      N.placeCells(T).map(c => c.s.toFixed(2) + ':' + c.d.toFixed(2)).join() === cells.map(c => c.s.toFixed(2) + ':' + c.d.toFixed(2)).join());
    // drive through one
    const c0 = cells[1];
    const r = makeRacer({ s: c0.s - 30, d: c0.d, yaw: trackFrame(T, c0.s - 30, {}).yaw, v: 18, battery: 0.2 });
    let took = 0;
    for (let i = 0; i < 120 * 5; i++) {
      const f = trackFrame(T, r.s, {});
      r.yaw = f.yaw; r.d = c0.d;
      stepRacer(r, T, { steer: 0, throttle: 1, brake: 0, boost: false }, { gravity: false }, 1 / 120);
      took += N.stepCells(cells, [r], T, 1 / 120).length;
    }
    check('driving through a cell takes it', took === 1 && r.cells === 1 && r.battery > 0.2 + tune.cellGive * 0.8,
      `battery ${r.battery.toFixed(2)}`);
    check('a taken cell goes away and comes back', !c0.live && c0.backT > 0);
    N.stepCells(cells, [], T, tune.cellBackS + 0.1);
    check('it is back after its timer', c0.live);
    // missing it by a wide margin takes nothing
    const c1 = cells[2];
    const wide = trackFrame(T, c1.s, {}).halfW;
    const miss = makeRacer({ s: c1.s - 20, d: c1.d + (c1.d > 0 ? -1 : 1) * Math.min(wide * 1.5, 4.5), yaw: trackFrame(T, c1.s - 20, {}).yaw, v: 18 });
    let missTook = 0;
    for (let i = 0; i < 120 * 4; i++) {
      const f = trackFrame(T, miss.s, {});
      const keep = miss.d;
      miss.yaw = f.yaw;
      stepRacer(miss, T, { steer: 0, throttle: 1, brake: 0, boost: false }, { gravity: false }, 1 / 120);
      miss.d = keep;
      missTook += N.stepCells(cells, [miss], T, 1 / 120).length;
    }
    check('passing wide of a cell leaves it there', missTook === 0 && cells[2].live);
  }

  // ---- ghosts ----
  {
    const d = window.document;
    const T = trackFor(N.state().courses[0]);
    const rec = N.makeRecorder();
    const r = makeRacer({ s: 5, d: 0, yaw: trackFrame(T, 5, {}).yaw, v: 16 });
    for (let i = 0; i < 60 * 12; i++) {
      stepRacer(r, T, { steer: 0.08, throttle: 1, brake: 0, boost: false }, { gravity: false }, 1 / 60);
      N.recordFrame(rec, r, 1 / 60);
    }
    r.finishT = r.time;
    const g = N.finishRecording(rec, r, { id: 'k:test', label: 'Test pup' });
    check('a run is recorded as a ghost', !!g && g.s.length > 20 && g.dt === N.ghostDt && g.rider === 'k:test',
      `${g.s.length} samples for ${r.time.toFixed(0)} s`);
    check('a ghost is small enough to keep', JSON.stringify(g).length / r.time < 400,
      `${Math.round(JSON.stringify(g).length / r.time)} bytes per second`);
    const store = {};
    check('a ghost is kept per rider', N.keepGhost(store, 'K', g)
      && N.keepGhost(store, 'K', { ...g, rider: 'w:elk', label: 'Elk', time: g.time + 3 })
      && N.bestGhosts(store, 'K').length === 2);
    check('a slower run does not replace a rider\'s ghost', !N.keepGhost(store, 'K', { ...g, time: g.time + 5 })
      && N.bestGhosts(store, 'K')[0].time === g.time);
    check('a faster run does', N.keepGhost(store, 'K', { ...g, time: g.time - 5 })
      && N.bestGhosts(store, 'K')[0].time === g.time - 5);
    // and in the race itself: Fierce lines them up, Fair does not.
    // The stored ghost belongs to one course, so race that one.
    const haveKey = Object.keys(N.state().ghostStore)[0] || '';
    const withGhost = N.state().courses.findIndex(c => haveKey.indexOf(c.sig) >= 0);
    check('the run raced earlier left a ghost behind', withGhost >= 0, haveKey);
    d.querySelectorAll('#courseList .course')[Math.max(0, withGhost)].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    d.querySelectorAll('#skillSeg .btn')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    click('startBtn');
    await pump(3, 50000);
    const fairField = N.state().race.racers.length;
    check('a ghost only appears at Fierce', N.state().race.racers.every(x => !x.isGhost));
    click('quitBtn');
    await pump(2, 51000);
    d.querySelectorAll('#skillSeg .btn')[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('the menu says what Fierce adds', /ghost/i.test(d.getElementById('ghostNote').textContent));
    click('startBtn');
    await pump(3, 52000);
    S = N.state();
    const ghosts = S.race.racers.filter(x => x.isGhost);
    check('at Fierce the stored ghost lines up with the field', ghosts.length >= 1
      && S.race.racers.length === fairField + ghosts.length, `${ghosts.length} ghost(s)`);
    check('a ghost gets a rider in the scene', S.race.riders.length === S.race.racers.length);
    // it replays rather than driving
    await pump(300, 53000);
    S = N.state();
    const gh = S.race.racers.find(x => x.isGhost);
    check('a ghost follows its recording', gh.prog > 0 && Number.isFinite(gh.s) && Number.isFinite(gh.yaw)
      && Math.abs(gh.d) <= trackFrame(S.race.T, gh.s, {}).halfW + 0.01);
    const before = { s: gh.s, d: gh.d };
    const me = S.race.racers[S.race.me];
    me.s = gh.s; me.d = gh.d;                        // park right on top of it
    resolveContacts(S.race.racers, S.race.T);
    check('a ghost cannot be shoved', gh.s === before.s && gh.d === before.d);
    check('ghosts are ranked with everyone else', S.race.racers.every(x => x.place >= 1));
    click('quitBtn');
    await pump(2, 54000);
    d.querySelectorAll('#skillSeg .btn')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }

  // ---- camera distance ----
  {
    const d = window.document;
    click('startBtn');
    await pump(200, 60000);
    const camDist = () => {
      const c = N.camera(), l = c.lookedAt;
      return Math.hypot(c.position.x - l.x, c.position.z - l.z);
    };
    N.setCam('normal'); await pump(30, 64000);
    const normal = camDist();
    N.setCam('close'); await pump(30, 65000);
    const close = camDist();
    N.setCam('far'); await pump(30, 66000);
    const far = camDist();
    check('the camera toggle actually moves the camera', close < normal - 1 && far > normal + 1,
      `${close.toFixed(1)} / ${normal.toFixed(1)} / ${far.toFixed(1)} m`);
    check('C cycles the camera in a race', (() => {
      const was = N.state().settings.cam;
      N.cycleCam();
      const now = N.state().settings.cam;
      N.setCam(was);
      return now !== was;
    })());
    N.setCam('normal');
    click('quitBtn');
    await pump(2, 67000);
  }

  // ---- the jet ----
  {
    const log = global.audioLog;
    /* Not just "a buffer exists": a real noise source is AT LEAST a few thousand samples
       of varying signal. A one-line stub that allocates eight zeroes would satisfy a
       buffer count, and sound like nothing at all. */
    const noise = log.samples.filter(a => {
      if (a.length < 8000) return false;
      let sum = 0, sumSq = 0;
      for (let i = 0; i < a.length; i += 7) { sum += a[i]; sumSq += a[i] * a[i]; }
      const n = Math.ceil(a.length / 7);
      return Math.sqrt(sumSq / n - (sum / n) ** 2) > 0.01;
    });
    check('the engine is filtered noise, not an oscillator',
      noise.length > 0 && log.filters.length >= 2,
      `${noise.length} noise buffer(s) of ${log.samples.length}, ${log.filters.length} filters`);
  }

  // ---- touch ----
  {
    const d = window.document;
    const pad = d.getElementById('tSteer');
    check('there is one steering pad, not two buttons', !!pad && !d.getElementById('tLeft'));
    const css = fs.readFileSync(path.join(ROOT, 'styles/neon.css'), 'utf8');
    check('the speed readout stays at the bottom on a touch screen',
      /body\.touch #hudB\{[^}]*bottom:calc\(10px/.test(css) && !/body\.touch #hudB\{[^}]*bottom:calc\(112px/.test(css));
    check('the page-wide backstop against double-tap zoom is in the stylesheet',
      /html,body\{[^}]*touch-action:manipulation/.test(css));
    // analog steering: where the thumb is across the pad sets the lock, and sliding changes it
    const at = (x, type, id) => {
      const e = new window.Event(type, { bubbles: true, cancelable: true });
      e.clientX = x; e.clientY = 640; e.pointerId = id == null ? 1 : id;
      pad.dispatchEvent(e);
    };
    const steerNow = () => { let v = 0; for (let i = 0; i < 40; i++) v = readNeonInput(1 / 60).steer; return v; };
    at(340, 'pointerdown');                       // right-hand edge
    const right = steerNow();
    at(100, 'pointermove');                       // slide to the left-hand edge
    const left = steerNow();
    at(220, 'pointermove');                       // and back towards the middle
    const mid = steerNow();
    at(220, 'pointerup');
    const released = steerNow();
    check('the steering pad is analog and follows a sliding thumb',
      right < -0.85 && left > 0.85 && Math.abs(mid) < 0.25 && Math.abs(released) < 0.05,
      `${right.toFixed(2)} -> ${left.toFixed(2)} -> ${mid.toFixed(2)} -> ${released.toFixed(2)}`);
    check('touching the pad puts the page in touch mode', d.body.classList.contains('touch'));
  }

  // ---- geojson dropped as .txt ----
  {
    const d = window.document;
    const accept = d.getElementById('worldFile').getAttribute('accept');
    check('a .txt geojson can be picked', /\.txt/.test(accept) && /text\/plain/.test(accept), accept);
    const txt = fs.readFileSync(path.join(ROOT, 'data/world.json'), 'utf8');
    await loadNeonMap([JSON.parse(txt)], 'dropped.txt');
    S = N.state();
    check('a map loaded from a .txt file races like any other', S.courses.length > 3 && /dropped\.txt/.test(d.getElementById('mapLine').textContent),
      `${S.courses.length} courses`);
    await loadNeonMap('../data/world.json', 'Garden of the Gods');
    await pump(40, 70000);
  }

  // ---- the scenery ----
  {
    const sc = N.scene();
    const land = sc.getObjectByName('neonLand');
    check('the terrain mesh is fine-grained', land && land.userData.samples > 12000, land ? String(land.userData.samples) : 'missing');
    check('the terrain mesh is indexed, so it costs one vertex per sample',
      land && land.geometry.index && land.geometry.index.length > land.geometry.attributes.position.count);
    /* Fills are ShapeGeometry, which the THREE stub above does not triangulate, so only
       the outlines can be asserted here; the fills are checked by eye in a real browser. */
    const kinds = [...new Set(S.areas.map(a => a.kind))];
    check('every kind of map area is drawn', S.areas.length > 0 && kinds.length > 2
      && kinds.every(k => !!sc.getObjectByName('neonAreaEdge_' + k)), `${S.areas.length} areas: ${kinds.join(', ')}`);
    let calls = 0; sc.getObjectByName('neonEnv').traverse(o => { if (o.geometry) calls++; });
    check('the whole environment is a handful of draws', calls <= 24, `${calls} objects`);
    /* Every trail ribbon is draped on the terrain, so no triangle of one should be
       standing on end: a tall triangle means a segment SPANNED a fin instead of following
       it, which on screen is a sheet of light hanging in the sky. */
    {
      const ghost = sc.getObjectByName('neonGhost');
      const pos = ghost && ghost.geometry.attributes.position.array;
      let tallest = 0;
      for (let i = 0; pos && i + 8 < pos.length; i += 9) {
        const ys = [pos[i + 1], pos[i + 4], pos[i + 7]];
        tallest = Math.max(tallest, Math.max(...ys) - Math.min(...ys));
      }
      check('the trail ribbons lie on the ground rather than spanning the cliffs',
        !!pos && tallest < 25, `tallest triangle ${tallest.toFixed(1)} m`);
    }
    check('the far plane is well beyond the fog', N.camera().far > 2000 && sc.fog.far > 800, `far ${N.camera().far | 0}, fog ${sc.fog.far | 0}`);
  }

  // ---- rival pace ----
  {
    check('the easiest rivals are as quick as the old hardest', N.skills.chill.pace >= 1.0 && N.skills.chill.corner >= 1.04);
    check('the pace ladder still goes up', N.skills.fair.pace > N.skills.chill.pace && N.skills.fierce.pace > N.skills.fair.pace);
  }

  // ---- bundle hygiene ----
  {
    const clash = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'src/neon'))) {
      const src = fs.readFileSync(path.join(ROOT, 'src/neon', f), 'utf8');
      for (const m of src.matchAll(/^(?:let|const|var|function|class)\s+([^;=(]+)/gm)) {
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/[\s=]/)[0];
          if (name && WINDOW_NAMES.has(name)) clash.push(`${f}: ${name}`);
        }
      }
    }
    check('no top-level name shadows a window global in the flattened bundle', !clash.length, clash.join(', '));
    const css = fs.readFileSync(path.join(ROOT, 'styles/neon.css'), 'utf8');
    check('always-visible overlays opt out of browser gestures', /#c\{[^}]*touch-action:none/.test(css) && /#hud > div\{[^}]*touch-action:none/.test(css) && /\.tbtn\{[^}]*touch-action:none/.test(css));
  }

  console.error = origError;
  console.log('-------------------------------------------');
  for (const r of results) console.log(`${r.ok ? ' ok   ' : ' FAIL '} ${r.name}${r.detail ? '   (' + r.detail + ')' : ''}`);
  console.log('-------------------------------------------');
  for (const e of errors) console.log(' ERR   ' + e.split('\n').slice(0, 4).join('\n       '));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${failed} failed, ${errors.length} runtime error(s)`);
  process.exit(failed || errors.length ? 1 : 0);
})().catch(e => {
  console.error = origError;
  for (const r of results) if (!r.ok) console.log(' FAIL  ' + r.name + (r.detail ? '   (' + r.detail + ')' : ''));
  for (const x of errors) console.log(' ERR   ' + x);
  origError('THREW during assertions:', e.stack); process.exit(1);
});
