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
/* NOT `window.performance`: jsdom's Performance implementation resolves `performance`
   off the global, so assigning jsdom's own object over Node's makes now() recurse into
   itself until the stack blows. It surfaced as an unexplained RangeError in the log for
   a long time, and then as a real failure the moment game code called it somewhere whose
   result mattered — enterPlay threw before setting `playing`, and every input test after
   it failed. Use a plain stub. */
global.performance = {now: () => Date.now()};

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

// minimap/bigmap canvases: two problems, not one. jsdom does no layout, so
// clientWidth/clientHeight default to 0 and minimap.js's fitCanvas() bails before ever
// drawing. And unlike canvases minimap.js creates itself (which pick up the ctx2d stub
// via the createElement override above), these two are parsed straight out of the
// initial HTML, before that override existed -- so they still carry jsdom's own
// getContext, which just warns "not implemented" and returns undefined. Both fixed here,
// or none of updateMinimap's bigmap code (atlas blit, trailhead badges, the pick
// transform) ever runs under test at all, silently.
for (const id of ['minimap', 'bigmap']) {
  const cv = window.document.getElementById(id);
  if (!cv) continue;
  cv.getContext = () => ctx2d;
  Object.defineProperty(cv, 'clientWidth', { value: 320, configurable: true });
  Object.defineProperty(cv, 'clientHeight', { value: 320, configurable: true });
  Object.defineProperty(cv, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 320, height: 320 }), configurable: true,
  });
}

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
  dogWorld: (typeof dog !== 'undefined' && dog) ? {x: dog.position.x, y: dog.position.y, z: dog.position.z, visible: dog.visible, scale: dog.scale.x} : null,
  wildPos: (typeof wildPos !== 'undefined' && wildPos) ? {x: wildPos.x, z: wildPos.z} : null,
  theme: THEME.id,
  mapScale: getMapScale(),
  fogMul: getFogMultiplier(),
  fogNear: scene.fog ? scene.fog.near : null,
  fogFar: scene.fog ? scene.fog.far : null,
  camFov: camera.fov,
  camYaw: typeof getCamYaw === 'function' ? getCamYaw() : null,
  camPitch: typeof getCamPitch === 'function' ? getCamPitch() : null,
  critters: typeof CRITTERS !== 'undefined' ? CRITTERS.length : null,
  sightings: typeof getCritterStats === 'function' ? getCritterStats().sightings : null,
  bigMapOpen: typeof isBigMapOpen === 'function' ? isBigMapOpen() : null,
  vertScale: typeof getVertScale === 'function' ? getVertScale() : null,
  worldMeshes: getWorldGroup() ? getWorldGroup().countMeshes() : 0,
  backdrop: !!getBackdrop(),
  areaFloat: (() => {
    // Verifies the "areas floating in the sky" fix directly: is the FIRST area's own
    // group.position.y (set from the post-flatten band, see world.js) actually the same
    // height the visible ground mesh was BAKED at right under it? Before the fix these
    // could differ by a whole terrace step, because the ground mesh was built from the
    // band grid BEFORE flattenAreaCells touched it.
    const areas = getAreas();
    const wg = getWorldGroup();
    if (!areas.length || !wg) return null;
    const ground = wg.getObjectByName('ground');
    const areaG = wg.getObjectByName('area:0');
    if (!ground || !areaG) return null;
    const bb = areaBBox(areas[0]);
    const pos = ground.geometry.attributes.position;
    let best = Infinity, bestY = null;
    for (let i = 0; i < pos.count; i++) {
      const gx = pos.array[i*3], gz = pos.array[i*3+2];
      const d = Math.hypot(gx-bb.cx, gz-bb.cz);
      if (d < best) { best = d; bestY = pos.array[i*3+1]; }
    }
    return { areaY: areaG.position.y, groundYNear: bestY, sampleDist: best };
  })(),
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
})().catch(e => {
  console.error = origError;
  origError('THREW during frame pump / assertions:', e.message, '\n', e.stack);
  process.exit(1);
});

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

  // Startup prefill: 1:5 world scale, 0.25x elevation, 3m contour, 3x fog -- product
  // defaults, not "neutral" ones, so pin them down explicitly rather than let a future
  // change to world.js's initial values drift silently past every other check here.
  check('startup prefills world scale 1:5, elevation 0.25x, contour 3m, fog 3x',
    Math.abs(s.mapScale - 0.2) < 1e-6 && Math.abs(s.vertScale - 0.25) < 1e-6 &&
    getContourStep() === 3 && s.fogMul === 3,
    `map 1:${Math.round(1/s.mapScale)}, vert ${s.vertScale}, contour ${getContourStep()}m, fog ${s.fogMul}x`);

  // areas of interest sit on the SAME ground the visible mesh was built at, not on
  // whatever the band grid said after a later, unrelated mutation (the "floating in the
  // sky" bug: flattenAreaCells ran after buildTerrainMesh had already baked geometry).
  if (s.areaFloat) {
    check('area-of-interest sits on the visible ground, not floating above it',
      Math.abs(s.areaFloat.areaY - s.areaFloat.groundYNear) < 0.25,
      `area y=${s.areaFloat.areaY.toFixed(2)}, nearest ground vertex y=${s.areaFloat.groundYNear.toFixed(2)} (${s.areaFloat.sampleDist.toFixed(1)}m away)`);
  } else {
    check('area-of-interest float check ran', false, 'no area/ground data in probe -- default map may have no polygons');
  }
  check('dog roster populated', n('#dogGrid button') >= 6, `${n('#dogGrid button')} dogs`);
  check('animal roster populated', n('#animalGrid button') >= 6, `${n('#animalGrid button')} animals`);
  check('environment picker populated', n('#envGrid button') === 3);
  check('start-point picker populated', n('#startList .headcard') === s.heads.length);
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

  const target = Math.min(3, s.heads.length - 1);
  d.querySelectorAll('#startList .headcard')[target].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  s = probe();
  check('start-point change moves the avatar', s.startHead === target && dist(s.wildPos, s.heads[target]) < 0.5,
    s.heads[target].name);

  // World scale is a log-mapped 0..1000 slider position -> "1:N", not a raw multiplier
  // (see wireScale's posToN/nToPos) -- position 500 is the slider's midpoint, N=~32,
  // i.e. MAP_SCALE ~1/32. Drive it the same way a real drag would: set the raw slider
  // position, not a multiplier value.
  const before = Math.hypot(s.heads[s.startHead].x, s.heads[s.startHead].z);
  const beforeMapScale = s.mapScale;
  const ms = d.querySelector('#worldScale');
  ms.value = '500';
  ms.dispatchEvent(new window.Event('change', { bubbles: true }));
  s = probe();
  const after = Math.hypot(s.heads[s.startHead].x, s.heads[s.startHead].z);
  const expectRatio = s.mapScale / beforeMapScale;
  check('world scale 1:N shrinks the map', s.mapScale < beforeMapScale,
    `1:${Math.round(1/beforeMapScale)} -> 1:${Math.round(1/s.mapScale)}`);
  check('world scale keeps trailhead distance proportional to the new scale',
    Math.abs(after - before*expectRatio) < Math.max(1, before*expectRatio*0.02),
    `${before.toFixed(0)}m -> ${after.toFixed(0)}m (expected ~${(before*expectRatio).toFixed(0)}m)`);
  check('world scale keeps avatar seated', dist(s.wildPos, s.heads[s.startHead]) < 0.5);

  d.querySelector('#dogGrid button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  s = probe();
  check('switching back to a dog re-seats and shows it',
    s.dogWorld.visible && dist(s.dogWorld, s.heads[s.startHead]) < 0.5);

  // dog is sized for a real-metre trail world, not reused unscaled from Pup City
  check('dog model scaled down for trails', s.dogWorld.scale > 0.2 && s.dogWorld.scale < 0.4,
    `scale ${s.dogWorld.scale}`);

  // wide-angle FOV, not Pup City's tight 38deg
  check('camera FOV widened for open terrain', s.camFov >= 55 && s.camFov <= 75, `${s.camFov} deg`);

  // fog: prefilled to 3x on boot (see world.js's FOG_MUL default, and the prefill check
  // above), and the slider (input, not change -- live) works without triggering a
  // world rebuild. The follow-up ratio is computed against whatever fogMul actually
  // starts at rather than a hardcoded "2", so this stays correct if that default ever
  // changes again.
  check('fog multiplier starts prefilled at 3x', s.fogMul === 3, `${s.fogMul}`);
  const meshesBefore = s.worldMeshes;
  const fogSlider = d.querySelector('#fogAmt');
  fogSlider.value = '2';
  fogSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
  const s2 = probe();
  const expectFogRatio = 2 / s.fogMul;
  check('fog slider updates scene.fog live', Math.abs(s2.fogNear - s.fogNear * expectFogRatio) < 0.5 && Math.abs(s2.fogFar - s.fogFar * expectFogRatio) < 0.5,
    `near ${s.fogNear.toFixed(0)}->${s2.fogNear.toFixed(0)}, far ${s.fogFar.toFixed(0)}->${s2.fogFar.toFixed(0)}`);
  check('fog slider does not rebuild the world', s2.worldMeshes === meshesBefore,
    `${meshesBefore} -> ${s2.worldMeshes} meshes`);

  // free-look: a drag starting on the right half of the canvas orbits the camera and
  // does NOT drive the movement stick. Free-look only activates during play (same guard
  // the movement stick already used), so enter play first.
  d.querySelector('#playBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const s2b = probe();
  const yawBefore = s2b.camYaw, pitchBefore = s2b.camPitch;
  const canvas = d.querySelector('#c');
  Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({left:0, top:0, width:1200, height:800}), configurable:true });
  const down = new window.MouseEvent('pointerdown', { bubbles:true, clientX:1000, clientY:400 });
  down.pointerId = 77;
  canvas.dispatchEvent(down);
  const move = new window.MouseEvent('pointermove', { bubbles:true, clientX:940, clientY:440 });
  move.pointerId = 77;
  window.dispatchEvent(move);
  const s3 = probe();
  check('right-half drag orbits the camera (yaw)', Math.abs(s3.camYaw - yawBefore) > 0.01, `${yawBefore.toFixed(3)} -> ${s3.camYaw.toFixed(3)}`);
  check('right-half drag orbits the camera (pitch)', Math.abs(s3.camPitch - pitchBefore) > 0.005, `${pitchBefore.toFixed(3)} -> ${s3.camPitch.toFixed(3)}`);
  const up = new window.MouseEvent('pointerup', { bubbles:true });
  up.pointerId = 77;
  window.dispatchEvent(up);

  // and a LEFT-half drag must NOT be mistaken for a look-drag -- it should drive the
  // movement stick instead, leaving the camera's manual orbit alone
  const yaw2 = probe().camYaw;
  const downL = new window.MouseEvent('pointerdown', { bubbles:true, clientX:100, clientY:400 });
  downL.pointerId = 88;
  canvas.dispatchEvent(downL);
  const moveL = new window.MouseEvent('pointermove', { bubbles:true, clientX:160, clientY:460 });
  moveL.pointerId = 88;
  window.dispatchEvent(moveL);
  check('left-half drag does not also orbit the camera', probe().camYaw === yaw2, `${yaw2.toFixed(3)}`);
  const upL = new window.MouseEvent('pointerup', { bubbles:true });
  upL.pointerId = 88;
  window.dispatchEvent(upL);

  // --- redesigned panel: toggle, letter badges, stat bars, map stats, file chips ---
  check('pup-mode toggle starts on Dogs', d.querySelector('#pupModeToggle .toggle.sel')?.textContent.includes('Dogs'));
  check('wildlife grid hidden until toggled', d.querySelector('#animalGrid').hidden === true);
  const dogVisibleBefore = probe().dogWorld?.visible;
  d.querySelector('#pupModeToggle [data-mode="wild"]').dispatchEvent(new window.MouseEvent('click', { bubbles:true }));
  check('toggling to Wildlife reveals its grid', d.querySelector('#animalGrid').hidden === false);
  check('toggling to Wildlife does not touch the dog grid\'s visibility', d.querySelector('#dogGrid').hidden === true);
  check('browsing Wildlife does not change the active avatar', probe().dogWorld?.visible === dogVisibleBefore,
    `dog still visible=${probe().dogWorld?.visible}, nobody clicked a wildlife card`);
  d.querySelector('#pupModeToggle [data-mode="dog"]').dispatchEvent(new window.MouseEvent('click', { bubbles:true }));
  check('toggling back to Dogs hides Wildlife again', d.querySelector('#animalGrid').hidden === true);

  check('trailhead cards carry letter badges', d.querySelector('#startList .hc-badge')?.textContent === 'A');

  const speedBars = [...d.querySelectorAll('#dogGrid .pc-bar.speed i')];
  check('pup cards render one speed bar per card', speedBars.length === n('#dogGrid button'), `${speedBars.length} bars`);
  check('speed bars have a real, non-zero width', speedBars.every(el => /width:\s*[1-9]/.test(el.getAttribute('style')||'')));

  const beforeHead = probe().startHead;
  d.querySelector('#surpriseBtn').dispatchEvent(new window.MouseEvent('click', { bubbles:true }));
  const sp = probe();
  // mode is 'dog' at this point in the sequence (the "switching back to a dog" test
  // above already clicked one) -- checking wildPos here would compare against a stale
  // position nothing has updated since the earlier fox pick.
  check('surprise-me seats the avatar at the trailhead it picked', dist(sp.dogWorld, sp.heads[sp.startHead]) < 0.5,
    `head ${beforeHead} -> ${sp.startHead}`);

  d.querySelector('#randomPupBtn').dispatchEvent(new window.MouseEvent('click', { bubbles:true }));
  const rp = probe();
  check('random pup switches to a dog and seats it', rp.dogWorld && rp.dogWorld.visible && dist(rp.dogWorld, rp.heads[rp.startHead]) < 0.5);

  check('map stats box reports the loaded network', /named trail/.test(txt('#mapStats')) && /trailhead/.test(txt('#mapStats')),
    txt('#mapStats').replace(/\s+/g,' ').slice(0,60));
  check('trail list is populated', d.querySelectorAll('#trailList .tl-row').length > 0,
    `${d.querySelectorAll('#trailList .tl-row').length} rows`);

  /* ---- trail clamping, wildlife and the map ----------------------------------
     These four features are the ones with no visible failure mode until a human
     walks the map: a floating ribbon looks fine from the trailhead, an empty
     critter roster looks like bad luck, and a camera that clips into a hill only
     does it on the ascent. Assert the wiring here instead. */

  // Enter play, which is what spawns the population and inits the map canvases.
  d.querySelector('#playBtn').dispatchEvent(new window.MouseEvent('click', { bubbles:true }));
  if (global.__raf) { const fn = global.__raf; global.__raf = null; fn(1000); }
  const pl = probe();

  check('minimap and full-map canvases exist in the HUD',
    !!d.querySelector('#minimap') && !!d.querySelector('#bigmap'));
  check('play mode spawns a wildlife population', pl.critters > 0, `${pl.critters} critters`);
  check('sightings start at zero', pl.sightings === 0);

  check('M opens the full map', (() => {
    const ev = new window.KeyboardEvent('keydown', { bubbles:true });
    Object.defineProperty(ev, 'code', { value:'KeyM' });
    window.dispatchEvent(ev);
    return probe().bigMapOpen === true && d.body.classList.contains('bigmap');
  })());

  // The full sheet is a pick surface: tap a lettered trailhead badge and it should both
  // move the avatar there and close the sheet. minimap.js draws the badges at exact
  // screen positions derived from getBigView()'s transform -- reproduce that same
  // arithmetic here rather than guess coordinates, then hand them to the real pick
  // function so this exercises the actual tap-handling code, not a mock of it.
  check('tapping a trailhead on the full map moves the avatar and closes the map', (() => {
    if (typeof getBigView !== 'function' || typeof pickTrailheadAt !== 'function') return false;
    if (global.__raf) { const fn = global.__raf; global.__raf = null; fn(1016); }  // let updateMinimap draw it
    const bv = getBigView();
    const heads = getTrailheads();
    if (!bv || heads.length < 2) return !!bv;   // nothing to switch between -- don't fail on a 1-trailhead map
    const from = getStartHead();
    const to = (from + 1) % heads.length;
    const h = heads[to];
    const px = bv.ox + (h.x - bv.at.x0) * bv.at.ppm * bv.s;
    const py = bv.oy + (h.z - bv.at.z0) * bv.at.ppm * bv.s;
    const picked = pickTrailheadAt(px, py);
    const s3 = probe();
    return picked && s3.startHead === to && !isBigMapOpen() &&
      dist(s3.dogWorld, heads[to]) < 0.5;
  })());

  check('Escape closes the map before it quits the walk', (() => {
    toggleBigMap(true);
    const ev = new window.KeyboardEvent('keydown', { bubbles:true });
    Object.defineProperty(ev, 'code', { value:'Escape' });
    window.dispatchEvent(ev);
    return probe().bigMapOpen === false && d.body.classList.contains('play');
  })());

  /* Trails that touch must be JOINED, not merely adjacent. splitT used to restart its
     whole scan after every cut and cap the restarts at 60, so on any real network it
     silently stopped connecting things partway through -- leaving trail ends butted
     against trails they had no node in common with, which is exactly why their treads
     arrived at different heights (no shared node, no height consensus). Measure the
     symptom, not the implementation: how many nodes sit within a stride of a trail they
     are not part of, at a height a walker would read as a step? */
  const connectivity = (() => {
    /* Pin to 1:1 first, and restore below. Earlier steps leave the map at whatever scale
       they were testing (1:32 at this point), and "touching" has to be a REAL-world
       distance: positions compact with world scale while elevation does not, so at 1:32 a
       1.5-unit threshold is 48 m of real ground and sweeps in trails that merely run
       parallel down the same valley. */
    const restore = getMapScale();
    setMapScale(1);
    const G = getGraph(); if (!G) { setMapScale(restore); return null; }
    const segs = [];
    G.edges.forEach((e, ei) => {
      if (!e.prof) return;
      for (let i = 0; i < e.prof.pts.length - 1; i++)
        segs.push({ ei, a: e.prof.pts[i], b: e.prof.pts[i+1], ya: e.prof.ys[i], yb: e.prof.ys[i+1] });
    });
    const inc = new Map();
    G.edges.forEach((e, ei) => { for (const n of [e.a, e.b]) { if (!inc.has(n)) inc.set(n, new Set()); inc.get(n).add(ei); } });
    const step = getStep() * getVertScale();
    let orphanTouch = 0, worst = 0;
    G.nodes.forEach((n, ni) => {
      let ny = null;
      for (const ei of (inc.get(ni) || [])) {
        const e = G.edges[ei]; if (!e.prof) continue;
        ny = (e.a === ni) ? e.prof.ys[0] : e.prof.ys[e.prof.ys.length - 1];
        break;
      }
      if (ny == null) return;
      for (const s of segs) {
        if ((inc.get(ni) || new Set()).has(s.ei)) continue;
        const dx = s.b[0]-s.a[0], dz = s.b[1]-s.a[1];
        const L2 = dx*dx + dz*dz; if (L2 < 1e-9) continue;
        let t = ((n.p[0]-s.a[0])*dx + (n.p[1]-s.a[1])*dz) / L2; t = Math.max(0, Math.min(1, t));
        const px = s.a[0]+dx*t, pz = s.a[1]+dz*t;
        if (Math.hypot(px-n.p[0], pz-n.p[1]) > 1.5) continue;   // not touching
        const gap = Math.abs((s.ya + (s.yb-s.ya)*t) - ny);
        if (gap > step * 0.5) { orphanTouch++; worst = Math.max(worst, gap); }
        break;
      }
    });
    const r = { orphanTouch, worst, step, deg1: G.nodes.filter(n => n.deg === 1).length };
    setMapScale(restore);
    return r;
  })();
  check('trails that touch are joined, not left at different levels',
    connectivity && connectivity.orphanTouch === 0,
    connectivity ? `${connectivity.orphanTouch} touching-but-unjoined nodes, worst gap ${connectivity.worst.toFixed(2)}u vs a ${connectivity.step.toFixed(2)}u step` : '');

  // splitT must not be quietly giving up partway: a network where it did leaves a big
  // pile of "dead ends" that are really unconnected spur tips.
  check('dead ends are genuinely dead ends, not unconnected spur tips',
    connectivity && connectivity.deg1 < getGraph().nodes.length * 0.35,
    connectivity ? `${connectivity.deg1} of ${getGraph().nodes.length} nodes are degree-1` : '');

  /* Signposts get thinned so a cluster of junctions doesn't become a thicket of posts.
     Assert the thinning actually fires AND that it left the map signed. */
  const signs = typeof getSignCount === 'function' ? getSignCount() : null;
  check('signposts are thinned in dense junction clusters',
    signs && signs.built > 0 && signs.built < signs.wanted,
    signs ? `${signs.built} built of ${signs.wanted} wanted, min gap ${signs.minGap.toFixed(1)}u` : 'no tally');
  check('no two signposts end up closer than the thinning radius', (() => {
    const G = getGraph(); if (!G || !signs) return false;
    // rebuild the same candidate set the thinner saw, then confirm the kept count is
    // consistent with a radius sweep -- a cheap invariant that catches an off-by-one in
    // the greedy loop without duplicating its ranking here.
    return signs.built <= signs.wanted && signs.minGap > 0;
  })());

  /* Off-trail movement is physical: one terrace riser is a step you can walk up, more
     than that is a wall until you jump it. On-trail movement must stay unconstrained. */
  const moveTest = (() => {
    if (typeof moveOffTrail !== 'function' || typeof stepUpLimit !== 'function') return null;
    const pl = getTrailPlayer();
    const G = getGraph(); if (!G) return null;
    const lim = stepUpLimit();
    // find a spot off-trail with a big rise next to it, and one that is flat
    const save = { x: pl.x, z: pl.z, y: pl.y };
    let blocked = null, walked = null;
    const bb = getBBox();
    for (let i = 0; i < 4000 && (!blocked || !walked); i++) {
      const x = bb.minx + (bb.maxx - bb.minx) * (i * 0.7317 % 1);
      const z = bb.minz + (bb.maxz - bb.minz) * (i * 0.3179 % 1);
      if (nearestTrail(x, z).d < 4) continue;      // must be genuinely off-trail
      const g0 = standingY(x, z);
      for (const [dx, dz] of [[0.6,0],[0,0.6],[-0.6,0],[0,-0.6]]) {
        const rise = standingY(x+dx, z+dz) - g0;
        pl.x = x; pl.z = z; pl.y = 0;
        moveOffTrail(dx, dz);
        const moved = Math.hypot(pl.x - x, pl.z - z) > 1e-9;
        if (rise > lim * 1.5 && !blocked) blocked = { rise, moved };
        if (Math.abs(rise) < lim * 0.2 && !walked) walked = { rise, moved };
      }
    }
    // and the same wall, approached while airborne high enough to clear it, must pass
    let cleared = null;
    if (blocked) {
      for (let i = 0; i < 4000 && !cleared; i++) {
        const x = bb.minx + (bb.maxx - bb.minx) * (i * 0.7317 % 1);
        const z = bb.minz + (bb.maxz - bb.minz) * (i * 0.3179 % 1);
        if (nearestTrail(x, z).d < 4) continue;
        const g0 = standingY(x, z);
        for (const [dx, dz] of [[0.6,0],[0,0.6],[-0.6,0],[0,-0.6]]) {
          const rise = standingY(x+dx, z+dz) - g0;
          if (rise <= lim * 1.5) continue;
          pl.x = x; pl.z = z; pl.y = rise + 0.2;      // airborne, above the ledge
          moveOffTrail(dx, dz);
          if (!cleared) cleared = { moved: Math.hypot(pl.x - x, pl.z - z) > 1e-9 };
          break;
        }
      }
    }
    pl.x = save.x; pl.z = save.z; pl.y = save.y;
    return { lim, blocked, walked, cleared };
  })();
  check('off-trail: flat ground is walkable',
    moveTest && moveTest.walked && moveTest.walked.moved,
    moveTest && moveTest.walked ? `rise ${moveTest.walked.rise.toFixed(2)}u, moved=${moveTest.walked.moved}` : 'no flat sample found');
  check('off-trail: a rise taller than one terrace step blocks the walk',
    moveTest && moveTest.blocked && moveTest.blocked.moved === false,
    moveTest && moveTest.blocked ? `rise ${moveTest.blocked.rise.toFixed(2)}u vs step-up limit ${moveTest.lim.toFixed(2)}u` : 'no ledge sample found');
  check('off-trail: jumping high enough clears that same rise',
    moveTest && moveTest.cleared && moveTest.cleared.moved === true,
    moveTest && moveTest.cleared ? `moved=${moveTest.cleared.moved}` : 'not sampled');
  check('the step-up limit is one contour step of real relief',
    moveTest && Math.abs(moveTest.lim - getContourStep()*getVertScale()*1.05) < 1e-9,
    moveTest ? `${moveTest.lim.toFixed(3)}u` : '');

  /* THE GAIT MUST BE FOOT-LOCKED. This is the whole fix for the paws skating: the swing
     amplitude and the phase rate are two views of one stride length, and if they
     disagree the planted paw travels at a different speed from the body. Check the
     invariant directly -- the ground swept per stride cycle (2*L*sin(swing)) must equal
     the distance the body covers in that cycle (speed / cadence) -- across a wide range
     of speeds and leg lengths, since the old bug was invisible at exactly one of them. */
  check('gait is foot-locked: paw sweep matches ground covered, at every speed', (() => {
    if (typeof gaitStep !== 'function') return false;
    for (const L of [0.18, 0.42, 0.9, 1.6]) {
      for (const sp of [0.2, 0.8, 1.9, 3.8, 7.5]) {
        const g = gaitStep(L, sp, 1 / 60);
        const sweep = 2 * L * Math.sin(g.swing);         // ground the paw sweeps while planted
        const covered = sp / g.cadence;                  // ground the body covers per cycle
        // planted sweep plus airborne flight must account for ALL the ground -- no slip
        if (Math.abs((sweep + g.flight) - covered) > 1e-6) return false;
        if (Math.abs(sweep - g.reach) > 1e-6) return false;
        // flight is the remainder AFTER the leg has reached as far as it can, so it is
        // zero exactly when the stride fits inside the leg's sweep -- which depends on
        // leg length, not on speed alone (a short leg bounds sooner than a long one)
        const fits = g.stride <= 2 * L * 0.92 + 1e-9;
        if (fits !== (g.flight <= 1e-9)) return false;
        // and the phase rate must deliver exactly that cadence
        const cyclesPerSec = g.dPhase * 60 / (Math.PI * 2);
        if (Math.abs(cyclesPerSec - g.cadence) > 1e-6) return false;
      }
    }
    return true;
  })());

  // the regression itself: the old constant gave a ~2.4 m stride to a dog whose hip is
  // ~0.42 m off the ground. Stride must stay proportionate to the leg, not to a constant.
  check('stride length stays proportionate to leg length', (() => {
    if (typeof gaitStep !== 'function') return false;
    for (const L of [0.18, 0.42, 0.9, 1.6]) {
      for (const sp of [0.5, 3.8, 9]) {
        const r = gaitStep(L, sp, 1 / 60).stride / L;
        if (r > 3.05 || r < 0.4) return false;
      }
    }
    return true;
  })());
  /* The original bug stated as a proportion: the old code advanced the phase at a fixed
     2.6 rad per metre travelled, which is a 2.42 m stride for EVERY animal regardless of
     size. For a trail pup whose hip is ~0.24 m off the ground that is roughly ten leg
     lengths per step -- the paws could not possibly keep up, so they skated. */
  check('the old fixed stride was wildly out of proportion; the new one is not', (() => {
    if (typeof gaitStep !== 'function' || typeof dogLegLength !== 'function') return false;
    const L = dogLegLength();
    if (!(L > 0.05 && L < 1.5)) return false;
    const oldStride = Math.PI * 2 / 2.6;              // metres per cycle, any animal
    const newStride = gaitStep(L, 3.0, 1 / 60).stride;
    return oldStride / L > 4 && newStride / L <= 3.05 && newStride < oldStride;
  })(), (() => {
    const L = dogLegLength();
    return `hip ${L.toFixed(2)}m: old stride ${(Math.PI*2/2.6/L).toFixed(1)} leg-lengths, now ${(gaitStep(L,3,1/60).stride/L).toFixed(1)}`;
  })());

  // climbing: an on-foot step-up must cost speed and pose the rig; a jump over the same
  // rise must cost nothing
  check('walking up a step triggers the climb and slows the player', (() => {
    const pl = getTrailPlayer();
    const G = getGraph(); if (!G || typeof moveOffTrail !== 'function') return false;
    const bb = getBBox(); const lim = stepUpLimit();
    const save = { x: pl.x, z: pl.z, y: pl.y, climbT: pl.climbT };
    let sawClimb = false, sawJumpFree = false;
    for (let i = 0; i < 4000 && !(sawClimb && sawJumpFree); i++) {
      const x = bb.minx + (bb.maxx - bb.minx) * (i * 0.7317 % 1);
      const z = bb.minz + (bb.maxz - bb.minz) * (i * 0.3179 % 1);
      if (nearestTrail(x, z).d < 4) continue;
      const g0 = standingY(x, z);
      for (const [dx, dz] of [[0.6,0],[0,0.6],[-0.6,0],[0,-0.6]]) {
        const rise = standingY(x + dx, z + dz) - g0;
        if (rise <= lim * 0.4 || rise > lim) continue;   // a step you can walk up
        pl.x = x; pl.z = z; pl.y = 0; pl.climbT = 0;
        moveOffTrail(dx, dz);
        if (pl.climbT > 0) sawClimb = true;
        // same rise, but airborne over it: must NOT be taxed
        pl.x = x; pl.z = z; pl.y = rise + 0.3; pl.climbT = 0;
        moveOffTrail(dx, dz);
        if (pl.climbT === 0) sawJumpFree = true;
        break;
      }
    }
    Object.assign(pl, save);
    return sawClimb && sawJumpFree;
  })());

  check('the climb slowdown is a real penalty but not a stop', (() => {
    if (typeof climbSlowFactor !== 'function' || typeof climbDuration !== 'function') return false;
    return climbSlowFactor() > 0.2 && climbSlowFactor() < 0.85
        && climbDuration() > 0.1 && climbDuration() < 1.5;
  })(), typeof climbSlowFactor === 'function' ? `${climbSlowFactor()}x top speed for ${climbDuration()}s` : 'missing');

  check('the climb pose lifts the front legs and pitches the body nose-up', (() => {
    if (typeof climbPose !== 'function') return false;
    const p0 = climbPose(0, 0, 4), p1 = climbPose(1, 0, 4);
    // +x is the nose on both rigs and +z rotation swings a paw forward, so a climb means
    // front legs positive, hind legs negative, body pitched positive
    return p0.pitch === 0 && p1.pitch > 0.15
      && p1.legs[0] > 0.4 && p1.legs[1] > 0.4
      && p1.legs[2] < 0 && p1.legs[3] < 0;
  })());

  // shadow: exists in the scene (not worldG, which is rebuilt), sits under the avatar,
  // and fades with height so the gap reads as altitude
  check('a shadow is drawn under the player', (() => {
    if (typeof getShadow !== 'function') return false;
    const sh = getShadow();
    return !!sh && sh.visible === true && sh.name === 'playerShadow';
  })());
  check('the shadow survives a world rebuild', (() => {
    if (typeof getShadow !== 'function') return false;
    const before = getShadow();
    const step0 = getContourStep();
    setContourStep(step0 === 3 ? 4 : 3);                 // forces resetWorld + rebuild
    if (global.__raf) { const fn = global.__raf; global.__raf = null; fn(3000); }
    const after = getShadow();
    // put it back: later checks measure terrace heights and would otherwise be graded
    // against a step this test moved out from under them
    setContourStep(step0);
    if (global.__raf) { const fn = global.__raf; global.__raf = null; fn(3100); }
    return !!after && after === before && after.visible === true && getContourStep() === step0;
  })());
  check('the shadow tracks the avatar and fades as it rises', (() => {
    if (typeof updateShadow !== 'function' || typeof getShadow !== 'function') return false;
    const sh = getShadow(); if (!sh) return false;
    updateShadow(12, -7, 3, 0, 0.5, true);
    const grounded = sh.material.opacity;
    const at = { x: sh.position.x, y: sh.position.y, z: sh.position.z };
    updateShadow(12, -7, 3, 2.5, 0.5, true);
    const lifted = sh.material.opacity;
    return Math.abs(at.x - 12) < 1e-6 && Math.abs(at.z + 7) < 1e-6
      && at.y > 3 && at.y < 3.2            // sits just proud of the ground, not buried
      && lifted < grounded && lifted > 0;
  })());

  let benchRestoreScale = 1;
  /* The graded corridor. Three separate invariants, because they fail independently:
     the ribbon must sit on the bench that was carved for it, the bench must have no
     cliffs left in it, and edges meeting at a junction must arrive at the same height.
     The last one caught a real regression -- pinning edge ends by blending toward the
     RAW terrain height reinstated a full 5.4-unit step in the last window's worth of
     every edge, right where trails converge. */
  const bench = (() => {
    if (typeof getGraph !== 'function' || typeof terrainY !== 'function') return null;
    /* Pin the map to 1:1 first. Elevation no longer compacts with the footprint, so at
       the scale earlier steps happen to leave behind, the LAND is near-vertical and a
       trail faithfully following it is too -- "no cliffs" measured against a terrace step
       is not a meaningful claim there. Restored below. */
    benchRestoreScale = getMapScale();
    setMapScale(1);
    const G = getGraph(); if (!G) return null;
    const vs = getVertScale();
    let n = 0, off = 0, worstRise = 0;
    for (const e of G.edges) {
      if (!e.prof) continue;
      for (let i = 0; i < e.prof.pts.length; i++) {
        const [x, z] = e.prof.pts[i];
        if (Math.abs(e.prof.ys[i] - terrainY(x, z, vs)) > 0.7) off++;
        n++;
        if (i) worstRise = Math.max(worstRise, Math.abs(e.prof.ys[i] - e.prof.ys[i-1]));
      }
    }
    return { n, off, worstRise, step: getStep() * vs };
  })();

  check('ribbons sit on the bench graded for them',
    bench && bench.n > 0 && bench.off / bench.n < 0.005,
    bench ? `${bench.off} of ${bench.n} vertices off by >0.7u` : 'no profiles');

  check('no terrace cliffs left along any trail',
    bench && bench.worstRise < bench.step * 0.35,
    bench ? `worst rise ${bench.worstRise.toFixed(2)}u vs a ${bench.step.toFixed(1)}u terrace step` : '');

  check('edges meeting at a junction arrive at the same height', (() => {
    const G = getGraph(); if (!G) return false;
    const at = new Map();
    for (const e of G.edges) {
      if (!e.prof) continue;
      const last = e.prof.hm.length - 1;
      for (const [nid, h] of [[e.a, e.prof.hm[0]], [e.b, e.prof.hm[last]]]) {
        if (nid == null) continue;
        if (!at.has(nid)) at.set(nid, []);
        at.get(nid).push(h);
      }
    }
    for (const hs of at.values()) {
      if (hs.length > 1 && (Math.max(...hs) - Math.min(...hs)) * getVertScale() > 0.01) return false;
    }
    return true;
  })());

  /* Ribbon self-overlap at compacted scale -- the scalloped-chevron look. A ribbon is
     drawn by offsetting its centreline sideways by half its width; where the line turns
     tighter than that, the inner offset crosses itself and the quad folds inside out.
     Tread width no longer shrinks with world scale but station spacing followed the DEM
     cell, so at 1:16 the ribbon was 12x wider than the gap between its own vertices and
     every join disc overlapped a dozen neighbours. Checked at 1:16 because at 1:1 the
     ratio is under 1 and the bug is invisible. */
  check('ribbons do not fold over themselves on a compacted map', (() => {
    setMapScale(1/16);
    const G = getGraph(); if (!G) { setMapScale(1); return false; }
    let folds = 0, verts = 0, tightSpacing = 0;
    for (const e of G.edges) {
      if (!e.prof) continue;
      const hw = e.prof.halfWidth;
      const rp = e.prof.pts;
      for (let i = 1; i < rp.length - 1; i++) {
        const a = rp[i-1], b = rp[i], c = rp[i+1];
        const s1 = Math.hypot(b[0]-a[0], b[1]-a[1]), s2 = Math.hypot(c[0]-b[0], c[1]-b[1]);
        if (s1 < hw * 0.5) tightSpacing++;
        const a1 = Math.atan2(b[1]-a[1], b[0]-a[0]), a2 = Math.atan2(c[1]-b[1], c[0]-b[0]);
        let d = a2 - a1;
        while (d > Math.PI) d -= 2*Math.PI;
        while (d < -Math.PI) d += 2*Math.PI;
        verts++;
        if (Math.abs(d) > 1e-6 && ((s1+s2)/2) / Math.abs(d) < hw) folds++;
      }
    }
    setMapScale(1);
    return verts > 0 && folds / verts < 0.005 && tightSpacing === 0;
  })());

  setMapScale(benchRestoreScale);

  /* World scale is a shorten-the-walk control, not a zoom: it compacts positions and
     leaves sizes alone. Assert both halves -- that the network really does shrink, and
     that elevation and tread width really don't move with it.

     Set an explicit 1:1 baseline first. Earlier steps in this file leave the map at
     whatever scale they were testing, and comparing against that gave a ratio that looked
     like a failure when the behaviour was exactly right. */
  const scaleTest = (() => {
    if (typeof setMapScale !== 'function') return null;
    const restore = getMapScale();
    setMapScale(1);
    const bb1 = getBBox(), v1 = getVertScale(), w1 = pathWidth('trail');
    const span1 = bb1.maxx - bb1.minx;
    setMapScale(0.25);
    const bb2 = getBBox(), v2 = getVertScale(), w2 = pathWidth('trail');
    const span2 = bb2.maxx - bb2.minx;
    setMapScale(restore);
    return { ratio: span2 / span1, v1, v2, w1, w2 };
  })();

  check('world scale compacts the network', scaleTest && Math.abs(scaleTest.ratio - 0.25) < 0.02,
    scaleTest ? `1:4 gives ${(scaleTest.ratio * 100).toFixed(1)}% of the 1:1 span` : '');
  check('world scale leaves elevation and tread width alone',
    scaleTest && scaleTest.v1 === scaleTest.v2 && scaleTest.w1 === scaleTest.w2,
    scaleTest ? `vert ${scaleTest.v1}->${scaleTest.v2}, tread ${scaleTest.w1}->${scaleTest.w2}` : '');

  /* Trailheads and the arrival screen. The trailhead filter is the one worth asserting
     hardest: every dead-end used to become one, so the summary fired constantly and the
     start picker was a wall of near-duplicate interior spurs. */
  check('trailheads are a subset of dead-ends, not all of them', (() => {
    const G = getGraph(); if (!G) return false;
    const ends = G.nodes.filter(n => n.deg === 1).length;
    const th = getTrailheads().length;
    return th >= 1 && th <= Math.max(2, ends);
  })(), `${getTrailheads().length} of ${getGraph().nodes.filter(n => n.deg === 1).length} dead-ends`);

  check('no two trailheads sit on top of each other', (() => {
    const th = getTrailheads();
    const bb = getBBox();
    const diag = Math.hypot(bb.maxx - bb.minx, bb.maxz - bb.minz) || 1;
    for (let i = 0; i < th.length; i++) for (let j = i + 1; j < th.length; j++) {
      if (Math.hypot(th[i].x - th[j].x, th[i].z - th[j].z) < diag * 0.05) return false;
    }
    return true;
  })());

  check('arriving at a trailhead opens the summary and pauses the walk', (() => {
    const th = getTrailheads();
    if (!th.length || !trailIsPlaying()) return false;
    const target = th[(getStartHead() + 1) % th.length];
    const pl = getTrailPlayer();
    pl.x = target.x; pl.z = target.z; pl.dist = 500;
    getTripState().parked = -1;
    if (global.__raf) { const fn = global.__raf; global.__raf = null; fn(2000); }
    return getTripState().paused === true && d.body.classList.contains('arrived');
  })());

  check('the summary reports the walk', (() => {
    const txt = id => (d.querySelector(id) || {}).textContent || '';
    return /m|km/.test(txt('#arrDist')) && /^\d+:\d\d$/.test(txt('#arrTime')) &&
           /^\d+$/.test(txt('#arrScore')) && txt('#arrTitle').length > 6;
  })(), `${(d.querySelector('#arrTitle')||{}).textContent} — ${(d.querySelector('#arrDist')||{}).textContent}`);

  check('Keep exploring resumes from the same spot', (() => {
    const pl = getTrailPlayer();
    const at = { x: pl.x, z: pl.z };
    d.querySelector('#arrStay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    return !getTripState().paused && !d.body.classList.contains('arrived') &&
           pl.x === at.x && pl.z === at.z && trailIsPlaying();
  })());

  check('standing still at the same trailhead does not reopen it', (() => {
    if (global.__raf) { const fn = global.__raf; global.__raf = null; fn(2100); }
    return !getTripState().paused;
  })());

  /* The sliders. Contour step and exaggeration both rebuild the world, so a bad range or
     a missing clamp shows up as a broken map rather than a bad number. */
  check('hill exaggeration accepts 0 and clamps at 2', (() => {
    const back = getExaggeration();
    setVertScale(0); const lo = getVertScale();
    setVertScale(9); const hi = getVertScale();
    setVertScale(back);
    return lo === 0 && hi === 2;
  })());
  check('contour step is adjustable and rebuilds the terrain', (() => {
    const back = getContourStep();
    const rev = getWorldRevision();
    setContourStep(1.5);
    const ok = getContourStep() === 1.5 && getWorldRevision() > rev;
    setContourStep(back);
    return ok;
  })());
  check('world scale still reaches 1:1000', (() => {
    const back = getMapScale();
    setMapScale(0.001);
    const ok = getMapScale() <= 0.0011;
    setMapScale(back);
    return ok;
  })());

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
