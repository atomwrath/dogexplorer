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
class FakeParam { constructor() { this.value = 0; } setValueAtTime() { return this; } exponentialRampToValueAtTime() { return this; } linearRampToValueAtTime() { return this; } }
class FakeNode { constructor() { this.frequency = new FakeParam(); this.gain = new FakeParam(); this.Q = new FakeParam(); } connect(d) { if (d == null) throw new TypeError('connect(null)'); return d; } start() {} stop() {} }
global.AudioContext = window.AudioContext = class {
  constructor() { this.state = 'running'; this.sampleRate = 44100; this.destination = new FakeNode(); }
  get currentTime() { return 5; } resume() { return Promise.resolve(); }
  createOscillator() { return new FakeNode(); } createBiquadFilter() { return new FakeNode(); }
  createGain() { return new FakeNode(); } createBufferSource() { return new FakeNode(); }
  createBuffer(c, l) { return { getChannelData() { return new Float32Array(l); } }; }
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
  keys: neonKeys, touch: neonTouch, skills: NEON_SKILL };`;
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
      check(`rivals on a ${kind} ride at a sane pace`, dist / slow > 9 && dist / slow < 26, `${(dist / slow).toFixed(1)} m/s`);
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

    // gravity switched mid-race: legal, but sets no record
    const gravBefore = S.settings.gravity;
    click('gravBtn');
    S = N.state();
    check('the gravity button flips gravity in the race', S.settings.gravity === !gravBefore && /OFF|ON/.test(d.getElementById('gravBtn').textContent));
    check('a run that switched gravity is marked as mixed', S.race.mixed === true);
    me.s = S.race.T.L - 3; me.yaw = trackFrame(S.race.T, me.s, {}).yaw; me.d = 0;
    await pump(90, 12000);
    S = N.state();
    check('crossing the line shows the finish card', S.screen === 'finish' && S.race.racers[S.race.me].done);
    check('a mixed-gravity run sets no record', Object.keys(S.bests).length === 0, JSON.stringify(S.bests));
    check('the finish board lists every racer', d.querySelectorAll('#finBoard li').length === want);

    // a clean run does set one
    click('againBtn');
    await pump(330, 20000);
    S = N.state();
    const me2 = S.race.racers[S.race.me];
    me2.s = S.race.T.L - 3; me2.yaw = trackFrame(S.race.T, me2.s, {}).yaw; me2.d = 0;
    await pump(90, 27000);
    S = N.state();
    const keys = Object.keys(S.bests);
    check('a clean run records a best time for that gravity setting', keys.length === 1 && keys[0].endsWith('|g' + (S.settings.gravity ? 1 : 0)) && S.bests[keys[0]] > 0, keys[0]);
    N.keys.clear();
    click('menuBtn');
    await pump(3, 30000);
    S = N.state();
    riders = 0; N.scene().traverse(o => { if (o.name === 'neonRider') riders++; });
    check('back to the menu removes the race and its riders', S.screen === 'menu' && !S.race && riders === 0);
    check('the course list now shows the best time', /★/.test(d.querySelector('#courseList .course.on .best').textContent));
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
