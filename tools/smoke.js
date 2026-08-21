/* Headless smoke test: boots the REAL built bundle and drives the UI.
 *
 *     npm install jsdom      (one-off, dev only -- nothing here ships)
 *     python3 build.py && node tools/smoke.js
 *
 * tools/check.py proves the code parses. This proves it RUNS: that the default map
 * loads, that the rosters populate, that clicking a dog or an animal actually seats an
 * avatar at the trailhead, and that switching environment or scale keeps it there.
 * Two classes of bug got past check.py and reached a human before this existed --
 * an unwritten dogPos (avatar built but never positioned) and an aliased import
 * (undefined name in the bundle only). Both are asserted below.
 *
 * three.js needs a GPU, so THREE is replaced with a duck-typed stub that records what
 * the game builds. Everything else is the actual shipped code on its actual boot path;
 * this checks wiring, not pixels.
   three.js needs a GPU, so THREE is replaced with a duck-typed stub that records what
   the game builds. Everything else -- world.js, geo.js, terrain.js, the drivers, main.js
   -- is the actual shipped code, run through its actual boot path. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = process.argv[2] || path.join(__dirname, '..');

// ---------- THREE stub ----------
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new V3(this.x, this.y, this.z); }
  lerp(v) { return this.copy(v); }
  setScalar(s) { return this.set(s, s, s); }
  add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v) { return this.set(this.x - v.x, this.y - v.y, this.z - v.z); }
  subVectors(a, b) { return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
  addVectors(a, b) { return this.set(a.x + b.x, a.y + b.y, a.z + b.z); }
  multiplyScalar(s) { return this.set(this.x * s, this.y * s, this.z * s); }
  divideScalar(s) { return this.multiplyScalar(s ? 1 / s : 0); }
  normalize() { const l = this.length() || 1; return this.divideScalar(l); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return this.set(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x); }
  crossVectors(a, b) { return this.copy(a).cross(b); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  applyAxisAngle() { return this; } applyQuaternion() { return this; } applyMatrix4() { return this; }
  setFromMatrixPosition() { return this; } negate() { return this.multiplyScalar(-1); }
  addScaledVector(v, k) { return this.set(this.x + v.x * k, this.y + v.y * k, this.z + v.z * k); }
  setLength(l) { return this.normalize().multiplyScalar(l); }
  lerpVectors(a, b, t) { return this.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
  equals(v) { return this.x === v.x && this.y === v.y && this.z === v.z; }
  fromArray(a, o = 0) { return this.set(a[o], a[o + 1], a[o + 2]); }
  toArray() { return [this.x, this.y, this.z]; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  toString() { return `(${this.x.toFixed(1)}, ${this.y.toFixed(1)}, ${this.z.toFixed(1)})`; }
}
class Obj3D {
  constructor() {
    this.position = new V3(); this.rotation = new V3(); this.scale = new V3(1, 1, 1);
    this.children = []; this.visible = true; this.name = ''; this.userData = {};
  }
  add(...o) { for (const c of o) if (c) { this.children.push(c); c.parent = this; } return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse && c.traverse(fn); }
  lookAt() {} updateProjectionMatrix() {} updateMatrixWorld() {}
  getObjectByName(n) { let f = null; this.traverse(o => { if (o.name === n) f = o; }); return f; }
  countMeshes() { let n = 0; this.traverse(o => { if (o.isMesh) n++; }); return n; }
}
class Mesh extends Obj3D {
  constructor(geometry, material) { super(); this.isMesh = true; this.geometry = geometry; this.material = material; }
}
class Geometry {
  constructor() { this.attributes = {}; this.index = null; }
  setAttribute(k, v) { this.attributes[k] = v; return this; }
  getAttribute(k) { return this.attributes[k]; }
  setIndex(i) { this.index = i; return this; }
  computeVertexNormals() {} translate() { return this; } rotateX() { return this; }
  scale() { return this; } dispose() {} center() { return this; }
  applyMatrix4() { return this; } computeBoundingBox() { this.boundingBox = { min: new V3(), max: new V3() }; }
}
class Material {
  constructor(p = {}) { Object.assign(this, p); }
  dispose() {} clone() { return new Material(this); }
}
class Color {
  constructor(c) { this.r = this.g = this.b = 1; this.set(c); }
  set(c) {
    if (c instanceof Color) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
    if (typeof c === 'number') { this.r = ((c >> 16) & 255) / 255; this.g = ((c >> 8) & 255) / 255; this.b = (c & 255) / 255; return this; }
    if (typeof c === 'string' && c[0] === '#') {
      const h = c.slice(1); const n = parseInt(h.length === 3 ? h.replace(/./g, m => m + m) : h, 16);
      return this.set(n);
    }
    return this;
  }
  getHex() { return (Math.round(this.r * 255) << 16) | (Math.round(this.g * 255) << 8) | Math.round(this.b * 255); }
  getHexString() { return this.getHex().toString(16).padStart(6, '0'); }
  clone() { return new Color(this); }
}
const stats = { renders: 0 };
const THREE = {
  Vector2: V3, Vector3: V3, Object3D: Obj3D, Group: Obj3D, Mesh, Color,
  BufferGeometry: Geometry,
  BufferAttribute: class { constructor(a, s) { this.array = a; this.itemSize = s; this.count = a.length / s; } },
  Float32BufferAttribute: class { constructor(a, s) { this.array = a; this.itemSize = s; this.count = a.length / s; } },
  Scene: class extends Obj3D { constructor() { super(); this.background = null; this.fog = null; } },
  PerspectiveCamera: class extends Obj3D { constructor(f, a, n, fa) { super(); this.fov = f; this.aspect = a; this.near = n; this.far = fa; } },
  WebGLRenderer: class {
    constructor(o = {}) { this.domElement = o.canvas || { addEventListener() {}, style: {} }; this.shadowMap = {}; }
    setPixelRatio() {} setSize() {} render() { stats.renders++; } setClearColor() {}
  },
  Fog: class { constructor(c, n, f) { this.color = c; this.near = n; this.far = f; } },
  HemisphereLight: class extends Obj3D { constructor(s, g, i) { super(); this.color = new Color(s); this.groundColor = new Color(g); this.intensity = i; } },
  DirectionalLight: class extends Obj3D { constructor(c, i) { super(); this.color = new Color(c); this.intensity = i; this.shadow = { mapSize: { set() {} }, camera: {}, bias: 0 }; } },
  AmbientLight: class extends Obj3D {},
  Clock: class { constructor() { this.elapsedTime = 0; } getDelta() { this.elapsedTime += 0.016; return 0.016; } },
  DataTexture: class { constructor() { this.needsUpdate = false; } dispose() {} },
  CanvasTexture: class { constructor() { this.repeat = { set() {} }; this.wrapS = this.wrapT = 0; } dispose() {} },
  Texture: class { constructor() { this.repeat = { set() {} }; } dispose() {} },
  Sprite: class extends Obj3D {}, SpriteMaterial: Material,
  NearestFilter: 1, LinearFilter: 2, RepeatWrapping: 3, LuminanceFormat: 4,
  DoubleSide: 2, FrontSide: 0, BackSide: 1, sRGBEncoding: 5, PCFSoftShadowMap: 6,
  MathUtils: { lerp: (a, b, t) => a + (b - a) * t },
};
for (const n of ['MeshToonMaterial', 'MeshBasicMaterial', 'MeshStandardMaterial', 'MeshLambertMaterial', 'LineBasicMaterial', 'ShaderMaterial']) THREE[n] = Material;
for (const n of ['BoxGeometry', 'PlaneGeometry', 'SphereGeometry', 'CylinderGeometry', 'ConeGeometry',
  'DodecahedronGeometry', 'IcosahedronGeometry', 'TorusGeometry', 'CircleGeometry', 'RingGeometry',
  'ExtrudeGeometry', 'ShapeGeometry', 'LatheGeometry', 'TubeGeometry', 'CapsuleGeometry', 'TetrahedronGeometry', 'OctahedronGeometry']) THREE[n] = Geometry;
THREE.Shape = class {
  constructor(pts) { this.points = pts || []; this.holes = []; this.curves = []; }
  moveTo() {} lineTo() {} quadraticCurveTo() {} bezierCurveTo() {} absarc() {} arc() {}
  closePath() {} splineThru() {} setFromPoints() { return this; } getPoints() { return this.points; }
};
THREE.Path = THREE.Shape;
THREE.Line = class extends Obj3D {}; THREE.LineSegments = class extends Obj3D {}; THREE.Points = class extends Obj3D {};
THREE.CatmullRomCurve3 = class { constructor(p) { this.points = p; } getPoints(n) { return this.points; } };
THREE.Matrix4 = class { makeRotationY() { return this; } makeTranslation() { return this; } multiply() { return this; } };
THREE.Euler = V3; THREE.Quaternion = class {};

// ---------- DOM ----------
const html = fs.readFileSync(path.join(ROOT, 'trails/index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/trails/', pretendToBeVisual: true });
const { window } = dom;
global.window = window; global.document = window.document;
global.navigator = window.navigator; global.location = window.location;
global.THREE = THREE; window.THREE = THREE;
global.addEventListener = window.addEventListener.bind(window);
global.URLSearchParams = window.URLSearchParams;
global.requestAnimationFrame = fn => { global.__raf = fn; };   // manual pumping
window.requestAnimationFrame = global.requestAnimationFrame;
global.localStorage = window.localStorage;
global.matchMedia = window.matchMedia || (q => ({matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}}));
window.matchMedia = global.matchMedia;
global.devicePixelRatio = 2; window.devicePixelRatio = 2;
global.screen = window.screen || {width:1440, height:900};
global.innerWidth = 1200; global.innerHeight = 800;
global.performance = window.performance || {now: () => Date.now()};

// 2D canvas stub: the game paints ground/sign/plaque textures procedurally, and jsdom
// has no canvas backend. A no-op context is enough -- we are testing wiring, not pixels.
const ctx2d = new Proxy({}, {
  get(_, k) {
    if (k === 'canvas') return {width:256, height:256};
    if (k === 'measureText') return () => ({width: 40});
    if (k === 'createLinearGradient' || k === 'createRadialGradient')
      return () => ({addColorStop(){}} );
    if (k === 'getImageData') return () => ({data: new Uint8ClampedArray(4)});
    return typeof k === 'string' ? (() => {}) : undefined;
  },
  set() { return true; },
});
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = (tag, ...rest) => {
  const el = origCreate(tag, ...rest);
  if (String(tag).toLowerCase() === 'canvas') el.getContext = () => ctx2d;
  return el;
};
global.document = window.document;

// canvas stub so core/render.js can construct
const canvas = window.document.getElementById('c');
canvas.getContext = () => null;
Object.defineProperty(canvas, 'clientWidth', { value: 1200 });
Object.defineProperty(canvas, 'clientHeight', { value: 800 });

// fetch straight off disk, the way a static server would serve it
global.fetch = async (url) => {
  const rel = String(url).replace(/^.*?\/trails\//, '').replace(/^\.\.\//, '');
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404, async json() { throw new Error('404'); } };
  return { ok: true, status: 200, async json() { return JSON.parse(fs.readFileSync(file, 'utf8')); } };
};
window.fetch = global.fetch;

// ---------- run the real bundle ----------
const bundleHtml = fs.readFileSync(path.join(ROOT, 'dist/pup-trails.html'), 'utf8');
const scripts = [...bundleHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts[scripts.length - 1];       // last block is the app; earlier one is three.js
console.log(`app bundle: ${(app.length / 1024) | 0} KB`);

const errors = [];
process.on('unhandledRejection', e => errors.push('unhandledRejection: ' + (e && e.message)));
const origError = console.error;
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ')); };

const probe = `
;globalThis.__probe = () => ({
  heads: getTrailheads().map(h => ({name: h.name, x: h.x, z: h.z})),
  startHead: getStartHead(),
  graph: !!getGraph(),
  dogPos: dogPos ? {x: dogPos.x, z: dogPos.z} : null,
  dogWorld: (typeof dog !== 'undefined' && dog) ? {x: dog.position.x, y: dog.position.y, z: dog.position.z, visible: dog.visible} : null,
  wildPos: (typeof wildPos !== 'undefined' && wildPos) ? {x: wildPos.x, z: wildPos.z} : null,
  theme: THEME.id,
  mapScale: getMapScale(),
  worldMeshes: getWorldGroup() ? getWorldGroup().countMeshes() : 0,
  backdrop: !!getBackdrop(),
});`;

try {
  (0, eval)(app + probe);
} catch (e) {
  origError('THREW during boot:', e.message, '\n', e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

// pump frames so the async boot() promise chain resolves and the loop runs
(async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setImmediate(r));
    if (global.__raf) { const fn = global.__raf; global.__raf = null; fn(i * 16); }
  }
  console.error = origError;
  assertAll(window, errors, stats);
})();

// ---------- assertions ----------
function assertAll(window, errors, stats) {
  const d = window.document;
  const probe = () => global.__probe();
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const clickText = (sel, re) => {
    const b = [...d.querySelectorAll(sel)].find(x => re.test(x.textContent));
    if (!b) throw new Error(`no ${sel} matching ${re}`);
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  };

  let s = probe();
  const txt = sel => (d.querySelector(sel)?.textContent || '').trim();
  const n = sel => d.querySelectorAll(sel).length;

  check('default map preloads', s.graph && s.heads.length > 0, `${s.heads.length} trailheads`);
  check('world geometry built', s.worldMeshes > 100, `${s.worldMeshes} meshes`);
  check('horizon backdrop built', s.backdrop);
  check('dog roster populated', n('#dogGrid button') >= 6, `${n('#dogGrid button')} dogs`);
  check('animal roster populated', n('#animalGrid button') >= 6, `${n('#animalGrid button')} animals`);
  check('environment picker populated', n('#envGrid button') === 3);
  check('start-point picker populated', n('#startSel option') === s.heads.length);
  check('a dog is selected on boot', !!d.querySelector('#dogGrid button.sel'), txt('#dogGrid button.sel'));
  check('frames render', stats.renders > 0, `${stats.renders} frames`);

  // the bug that shipped: rig built, never positioned
  let head = s.heads[s.startHead];
  check('dog rig stands on the trailhead', s.dogWorld && dist(s.dogWorld, head) < 0.5,
    s.dogWorld ? `(${s.dogWorld.x.toFixed(1)}, ${s.dogWorld.z.toFixed(1)}) vs (${head.x.toFixed(1)}, ${head.z.toFixed(1)})` : 'rig not built');

  clickText('#animalGrid button', /fox/i);
  s = probe(); head = s.heads[s.startHead];
  check('picking an animal seats it', dist(s.wildPos, head) < 0.5);
  check('picking an animal hides the dog', s.dogWorld && s.dogWorld.visible === false);

  clickText('#envGrid button', /Red rock/i);
  s = probe();
  check('environment switch applies theme', s.theme === 'redrock');
  check('environment switch keeps avatar seated', dist(s.wildPos, s.heads[s.startHead]) < 0.5);
  check('environment switch rebuilds world', s.worldMeshes > 100, `${s.worldMeshes} meshes`);

  const sel = d.querySelector('#startSel');
  const target = Math.min(3, s.heads.length - 1);
  sel.value = String(target);
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  s = probe();
  check('start-point change moves the avatar', s.startHead === target && dist(s.wildPos, s.heads[target]) < 0.5,
    s.heads[target].name);

  const before = Math.hypot(s.heads[s.startHead].x, s.heads[s.startHead].z);
  const ms = d.querySelector('#mapScale');
  ms.value = '0.5';
  ms.dispatchEvent(new window.Event('change', { bubbles: true }));
  s = probe();
  const after = Math.hypot(s.heads[s.startHead].x, s.heads[s.startHead].z);
  check('map scale halves the map', Math.abs(after - before / 2) < 1, `${before.toFixed(0)}m -> ${after.toFixed(0)}m`);
  check('map scale keeps avatar seated', dist(s.wildPos, s.heads[s.startHead]) < 0.5);

  d.querySelector('#dogGrid button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  s = probe();
  check('switching back to a dog re-seats and shows it',
    s.dogWorld.visible && dist(s.dogWorld, s.heads[s.startHead]) < 0.5);

  const failed = results.filter(r => !r.ok);
  console.log('\n---------------- smoke test ----------------');
  for (const r of results) console.log(` ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? '   (' + r.detail + ')' : ''}`);
  if (errors.length) console.log('\n runtime errors:\n  ' + errors.join('\n  '));
  console.log('-------------------------------------------');
  console.log(failed.length || errors.length
    ? `\n${failed.length} failed, ${errors.length} runtime error(s)`
    : `\nall ${results.length} checks passed`);
  process.exit(failed.length || errors.length ? 1 : 0);
}
