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
  // real three.js turns a `color` option into a THREE.Color instance; the stub used to
  // leave it a raw number, so any production code calling material.color.setHex() blew
  // up here and nowhere else. Mirror the real behaviour instead.
  constructor(p = {}) { Object.assign(this, p); if ('color' in p) this.color = new Color(p.color); }
  dispose() {} clone() { return new Material(this); }
}
class Color {
  constructor(c) { this.r = this.g = this.b = 1; this.set(c); }
  setHex(h) { return this.set(h); }
  getHex() { return (Math.round(this.r*255) << 16) | (Math.round(this.g*255) << 8) | Math.round(this.b*255); }
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
  // real three.js Sprite(material) stores it; the stub dropped it, so any check on a
  // sprite's material silently saw undefined
  Sprite: class extends Obj3D { constructor(m) { super(); this.material = m; } }, SpriteMaterial: Material,
  Line: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  LineLoop: class extends Obj3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
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


/* ---------- recording AudioContext ----------
   Not a nicety. The bark bug was not in the wiring -- the graph was always built
   correctly -- it was that every voice sat below the frequency band a laptop speaker can
   reproduce, which is invisible to any test that only asks "did it make a sound". This
   stub records what is scheduled so the assertions can ask what BAND it was scheduled in,
   and whether anything was scheduled against a context that was still suspended. */
const AUDIO = { osc: [], scheduledWhileSuspended: 0, nodes: 0, live: null };
class FakeParam {
  constructor(kind, name, ctx){ this.kind=kind; this.name=name; this.ctx=ctx; this.value=0; }
  _rec(v){ if(this.name==='freq' && this.kind.startsWith('osc')) AUDIO.osc.push(v);
           if(this.ctx && this.ctx.state !== 'running') AUDIO.scheduledWhileSuspended++; }
  setValueAtTime(v){ this._rec(v); return this; }
  exponentialRampToValueAtTime(v){ this._rec(v); return this; }
  linearRampToValueAtTime(v){ this._rec(v); return this; }
}
let __nid = 0;
class FakeNode {
  constructor(kind, ctx){
    this.kind = kind + (__nid++); this.ctx = ctx; AUDIO.nodes++;
    this.frequency = new FakeParam(this.kind, 'freq', ctx);
    this.gain = new FakeParam(this.kind, 'gain', ctx);
    this.Q = new FakeParam(this.kind, 'Q', ctx);
  }
  connect(d){ return d; }
  start(){ if(this.ctx && this.ctx.state !== 'running') AUDIO.scheduledWhileSuspended++; }
  stop(){}
}
global.AudioContext = window.AudioContext = class {
  constructor(){ this.state = 'suspended'; this.sampleRate = 44100;
    this.destination = new FakeNode('dest', this); AUDIO.live = this; }
  get currentTime(){ return 5; }
  resume(){ return Promise.resolve().then(()=>{ this.state = 'running'; }); }
  createOscillator(){ return new FakeNode('osc', this); }
  createBiquadFilter(){ return new FakeNode('filt', this); }
  createGain(){ return new FakeNode('gain', this); }
  createBufferSource(){ return new FakeNode('src', this); }
  createBuffer(c, l){ return { getChannelData(){ return new Float32Array(l); } }; }
};
global.__AUDIO = AUDIO;

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
  pathMix: typeof getPathMix === 'function' ? getPathMix() : null,
  spots: typeof getSpots === 'function' ? getSpots().map(s => ({id:s.id, name:s.name, rx:s.rx, rz:s.rz})) : null,
  onTrail: typeof getOnTrail === 'function' ? {route:getOnTrail().route, name:getOnTrail().name} : null,
  highlight: typeof getHighlightRoute === 'function' ? getHighlightRoute() : null,
  panelOpen: document.body.classList.contains('panelopen'),
  dist: typeof getTrailPlayer === 'function' ? getTrailPlayer().dist : null,
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
  /* The panel's trailhead LIST is gone on purpose -- the map sheet is the picker now
     (world.js/main.js: renderStartPicker). What the panel keeps is the answer, so assert
     that instead: the summary names the selected head, and no stale list survives. */
  check('the panel no longer carries a trailhead list', !d.querySelector('#startList'));
  check('the map sheet names the selected trailhead',
    new RegExp(s.heads[s.startHead].name.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .test(txt('#startNow')), txt('#startNow'));
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
  placeAtHead(target);
  s = probe();
  check('start-point change moves the avatar', s.startHead === target && dist(s.wildPos, s.heads[target]) < 0.5,
    s.heads[target].name);
  check('the summary follows the start point', txt('#startNow').startsWith(String.fromCharCode(65+target)),
    txt('#startNow'));

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
  /* The header's "Hit the trail" button is gone by request, so there is no click that
     starts a walk any more -- picking a place on the map does it. enterPlay() directly is
     the equivalent, and the map-pick path gets its own assertion further down. */
  enterPlay();
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

  /* WHICH HALF OF THE SCREEN NO LONGER DECIDES ANYTHING -- pointerType does.

     A mouse orbits the camera from anywhere on the canvas, because WASD already walks and
     handing half the window to a virtual joystick meant every drag starting left of
     centre yanked the pup instead of turning the view. A finger keeps the twin-stick
     split, because on a phone there is no keyboard to fall back on. Both halves of that
     rule are asserted: the same left-half drag must orbit as a mouse and must NOT orbit
     as a touch. */
  const yaw2 = probe().camYaw;
  const dragLeft = (id, type) => {
    const dn = new window.MouseEvent('pointerdown', { bubbles:true, clientX:100, clientY:400 });
    dn.pointerId = id; Object.defineProperty(dn, 'pointerType', { value:type });
    canvas.dispatchEvent(dn);
    const mv = new window.MouseEvent('pointermove', { bubbles:true, clientX:180, clientY:470 });
    mv.pointerId = id; Object.defineProperty(mv, 'pointerType', { value:type });
    window.dispatchEvent(mv);
    const up = new window.MouseEvent('pointerup', { bubbles:true });
    up.pointerId = id; Object.defineProperty(up, 'pointerType', { value:type });
    window.dispatchEvent(up);
    return probe().camYaw;
  };
  const afterMouse = dragLeft(88, 'mouse');
  check('a mouse drag on the LEFT half still orbits the camera', Math.abs(afterMouse - yaw2) > 0.01,
    `${yaw2.toFixed(3)} -> ${afterMouse.toFixed(3)}`);
  const yaw3 = probe().camYaw;
  const afterTouch = dragLeft(89, 'touch');
  check('a touch drag on the left half drives the stick, not the camera', afterTouch === yaw3,
    `${yaw3.toFixed(3)}`);

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

  check('the trailhead summary leads with a letter badge', /^[A-Z0-9]+ \u00b7 /.test(txt('#startNow')),
    txt('#startNow'));

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
  /* The list used to print one row per NAME, so a dozen unrelated unnamed paths that had
     each drawn the same label out of SPUR_NAMES appeared as a dozen identical trails.
     Named routes now get a row each and the connectors are summarised in one. */
  check('the trail list has no duplicate rows', (() => {
    const rows = [...d.querySelectorAll('#trailList .tl-row')].map(r => r.textContent.trim());
    return new Set(rows).size === rows.length;
  })(), `${d.querySelectorAll('#trailList .tl-row').length} rows`);

  /* ---- trail clamping, wildlife and the map ----------------------------------
     These four features are the ones with no visible failure mode until a human
     walks the map: a floating ribbon looks fine from the trailhead, an empty
     critter roster looks like bad luck, and a camera that clips into a hill only
     does it on the ascent. Assert the wiring here instead. */

  // Enter play, which is what spawns the population and inits the map canvases.
  enterPlay();
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
  /* Deterministic across the whole range of pup proportions the rig can produce -- the
     first version of this check read whichever random pup happened to be loaded, so it
     passed or failed depending on the seed. */
  check('the old fixed stride was wildly out of proportion; the new one is not', (() => {
    if (typeof gaitStep !== 'function') return false;
    const oldStride = Math.PI * 2 / 2.6;        // metres per cycle, for ANY animal
    for (const L of [0.18, 0.24, 0.42, 0.68, 1.0]) {
      const now = gaitStep(L, 3.0, 1 / 60).stride;
      if (now / L > 3.05) return false;         // still proportionate to the leg
      if (now >= oldStride) return false;       // and shorter than the old constant
    }
    return oldStride / 0.24 > 4;                // absurd at trail-pup size, which is the bug
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
  /* Airborne pose: legs spread and the walk cycle stops. A leg that keeps swinging while
     the paw is nowhere near the ground is the mid-air version of the paw-slide. */
  check('jumping spreads the legs instead of running in mid-air', (() => {
    if (typeof leapPose !== 'function') return false;
    const grounded = leapPose(0, 0, 4), air = leapPose(1, 0, 4);
    // grounded: no pose at all. airborne: forelegs reach ahead (+z), hind legs trail (-z)
    return grounded.freeze === 0 && grounded.legs.every(v => v === 0)
      && air.freeze === 1
      && air.legs[0] > 0.5 && air.legs[1] > 0.5
      && air.legs[2] < -0.5 && air.legs[3] < -0.5;
  })());
  check('the leap freezes the walk cycle rather than blending with it', (() => {
    if (typeof leapPose !== 'function' || typeof gaitStep !== 'function') return false;
    const g = gaitStep(0.3, 3.5, 1 / 60);
    // freeze scales the phase advance to zero at a full leap, and leaves it alone on the ground
    return g.dPhase > 0
      && g.dPhase * (1 - leapPose(1, 0, 4).freeze) === 0
      && g.dPhase * (1 - leapPose(0, 0, 4).freeze) === g.dPhase;
  })());
  check('the leap pitches nose-up on the way up and nose-down on the way down', (() => {
    if (typeof leapPose !== 'function') return false;
    return leapPose(1, 1, 4).pitch > 0.1 && leapPose(1, -1, 4).pitch < -0.1
        && Math.abs(leapPose(1, 0, 4).pitch) < 1e-9;
  })());

  /* The blob must clear the trail's whole ribbon stack. world.js layers those at fixed
     offsets above the graded profile (max 0.09, dashes); standingY returns the profile,
     so anything lifted less than that is inside the stack and z-fights. */
  check('the shadow clears the trail ribbon stack so it cannot z-fight',
    typeof shadowLift === 'function' && shadowLift() > 0.09 && shadowLift() < 0.25,
    typeof shadowLift === 'function' ? `lift ${shadowLift()}u vs 0.09u tallest ribbon layer` : 'missing');

  /* Backing up must not spin the camera. The auto-follow correction is atan2(-ix,-iz) --
     a function of the INPUT only -- so straight back is a constant PI that can never
     converge, which is what span the view and flipped sign at the wrap. */
  check('walking straight back does not send the camera into a spin', (() => {
    if (typeof backpedalArc !== 'function') return false;
    const corr = (ix, iz) => Math.atan2(-ix, -iz);
    const arc = backpedalArc();
    const suppressed = (ix, iz) => Math.abs(corr(ix, iz)) >= arc;
    return suppressed(0, 1)                       // straight back: suppressed
      && !suppressed(0, -1)                       // straight ahead: followed (and zero anyway)
      && !suppressed(1, 0) && !suppressed(-1, 0)  // strafing: still followed
      && !suppressed(0.707, -0.707)               // forward diagonal: followed
      && Math.abs(corr(0, -1)) < 1e-9;            // walking forward needs no correction
  })(), typeof backpedalArc === 'function' ? `suppressed beyond ${backpedalArc().toFixed(2)} rad` : 'missing');

  /* SPRINTING IS A DIFFERENT GAIT, not a faster trot. A trot is diagonal; a gallop lands
     the hind pair together then the fore pair, with a lead leg in each. */
  check('sprinting switches to a gallop footfall instead of a faster trot', (() => {
    if (typeof legSwingValue !== 'function') return false;
    // sample a whole cycle and compare how close each pair moves together
    const spread = (gal, i, j) => {
      let worst = 0;
      for (let p = 0; p < 6.28; p += 0.2)
        worst = Math.max(worst, Math.abs(legSwingValue(i, p, gal) - legSwingValue(j, p, gal)));
      return worst;
    };
    const trotFore = spread(0, 0, 1), galFore = spread(1, 0, 1);
    const trotHind = spread(0, 2, 3), galHind = spread(1, 2, 3);
    // in a gallop each pair moves nearly together; in a trot they are half a cycle apart
    return galFore < trotFore * 0.5 && galHind < trotHind * 0.5;
  })());
  check('the gallop blend is measured against the animal own walk and run speeds', (() => {
    if (typeof gallopAmount !== 'function') return false;
    // a small fast animal and a big slow one must both gallop only at THEIR top end
    return gallopAmount(2, 2, 6) === 0 && gallopAmount(6, 2, 6) === 1
        && gallopAmount(4, 2, 6) > 0.4 && gallopAmount(4, 2, 6) < 0.6
        && gallopAmount(9, 9, 20) === 0 && gallopAmount(20, 9, 20) === 1;
  })());

  /* Floating area names: occluded by terrain, and capped in apparent size up close. */
  check('area labels are occluded by terrain instead of floating over everything', (() => {
    const labels = typeof getAreaLabels === 'function' ? getAreaLabels() : [];
    if (!labels.length) return false;
    return labels.every(l => l.material && l.material.depthTest === true);
  })());
  check('area labels stop growing once you are close, so they cannot clip off screen', (() => {
    const labels = typeof getAreaLabels === 'function' ? getAreaLabels() : [];
    if (!labels.length || typeof updateAreaLabels !== 'function') return false;
    const l = labels[0];
    const p = { x: l.parent ? l.parent.position.x + l.position.x : l.position.x,
                y: l.parent ? l.parent.position.y + l.position.y : l.position.y,
                z: l.parent ? l.parent.position.z + l.position.z : l.position.z };
    // apparent on-screen size is scale/distance -- that is the thing that must stay bounded
    const apparent = (d) => { updateAreaLabels(p.x, p.y, p.z + d); return l.scale.x / d; };
    let peak = 0;
    for (let d = 0.5; d < 200; d += 0.5) peak = Math.max(peak, apparent(d));
    const close = apparent(4), veryClose = apparent(1), onTop = apparent(0.5);
    // inside the hold distance apparent size is pinned, so walking right up to a label
    // cannot make it grow; far away it still recedes like the world object it labels
    return Math.abs(close - veryClose) < 1e-6 && Math.abs(close - onTop) < 1e-6
      && peak <= close + 1e-6
      && apparent(120) < close * 0.5;
  })());
  check('area labels got smaller', (() => {
    const labels = typeof getAreaLabels === 'function' ? getAreaLabels() : [];
    // old code: clamp(width, 7, 20). New: clamp(width*0.62, 4.5, 12).
    return labels.length > 0 && labels.every(l => (l.userData.baseScale || 99) <= 12);
  })());

  /* The noise ring must draw the SAME rule critters.js judges you by. */
  /* Walking and sprinting must be audibly DIFFERENT. pace is clamped to 1, so measuring
     it against walking speed made both identical -- the flaw the drawn ring exposed. */
  check('walking, sprinting and sneaking are three distinct noise levels', (() => {
    if (typeof playerNoise !== 'function' || typeof noiseReference !== 'function') return false;
    const ref = noiseReference();                       // flat-out speed, not walking speed
    const walkSpeed = ref / Math.max(1.05, currentRunMul());
    const sneak  = playerNoise(walkSpeed, ref, true, false);
    const walk   = playerNoise(walkSpeed, ref, false, false);
    const sprint = playerNoise(ref, ref, false, false);
    return sneak < walk * 0.6 && sprint > walk * 1.25;
  })(), (() => {
    const ref = noiseReference(), w = ref / Math.max(1.05, currentRunMul());
    return `sneak ${playerNoise(w, ref, true, false).toFixed(2)} < walk ${playerNoise(w, ref, false, false).toFixed(2)} < sprint ${playerNoise(ref, ref, false, false).toFixed(2)}`;
  })());

  check('the noise ring shows the rule the animals actually use', (() => {
    if (typeof playerNoise !== 'function' || typeof updateNoiseRing !== 'function') return false;
    const top = 4;
    const sneak = playerNoise(1, top, true, false);
    const walk  = playerNoise(1, top, false, false);
    const sprint= playerNoise(top, top, false, false);
    const bark  = playerNoise(1, top, false, true);
    return sneak < walk && walk < sprint && bark > sprint && sneak > 0;
  })());
  check('the ring shrinks when sneaking and swells when sprinting', (() => {
    if (typeof updateNoiseRing !== 'function' || typeof noiseRingRadius !== 'function') return false;
    const top = 4, ground = () => 0;
    const settle = (noise) => { for (let i = 0; i < 400; i++) updateNoiseRing(0.05, 0, 0, noise, 10, ground, true); return noiseRingRadius(); };
    const sneak = settle(playerNoise(1, top, true, false));
    const walk  = settle(playerNoise(1, top, false, false));
    const sprint= settle(playerNoise(top, top, false, false));
    return sneak < walk * 0.75 && sprint > walk * 1.5 && sneak > 0;
  })());
  check('the noise ring hugs the terrain rather than lying flat', (() => {
    if (typeof updateNoiseRing !== 'function' || typeof getNoiseRing !== 'function') return false;
    // feed it a sloped ground function; the ring's vertices must follow it
    const slope = (x, z) => x * 0.5;
    for (let i = 0; i < 400; i++) updateNoiseRing(0.05, 0, 0, 1, 10, slope, true);
    const r = getNoiseRing(); if (!r) return false;
    const arr = r.geometry.attributes.position.array;
    let ok = true, spread = 0, lo = 1e9, hi = -1e9;
    for (let i = 0; i < arr.length; i += 3) {
      if (Math.abs(arr[i + 1] - (slope(arr[i], arr[i + 2]) + 0.13)) > 1e-6) ok = false;
      lo = Math.min(lo, arr[i + 1]); hi = Math.max(hi, arr[i + 1]);
    }
    spread = hi - lo;
    return ok && spread > 1;      // genuinely following the slope, not a flat disc
  })());

  /* THE CLIFF-EDGE CLIMB. `onTrail` used to mean "within 1.5 m of a trail", but the
     corridor a narrow trail actually occupies is 1.1 m wide -- half-width 0.55. The band
     between them counted as on-trail and skipped the step-up rule, INCLUDING when the
     trail ran along a clifftop and you were standing at the bottom. One step in and
     standingY lifted you the full height of the cliff.

     Find a real instance on the map -- a spot just outside a corridor whose tread sits
     more than a step-up above the ground you are on -- and confirm the step is refused. */
  const cliffTest = (() => {
    if (typeof moveOffTrail !== 'function' || typeof stepUpLimit !== 'function') return null;
    const G = getGraph(); if (!G) return null;
    const pl = getTrailPlayer();
    const save = { x: pl.x, z: pl.z, y: pl.y, climbT: pl.climbT };
    const lim = stepUpLimit();
    const spots = [];
    // step out PERPENDICULAR to each segment until we are clear of the corridor, and keep
    // the spots where the tread towers over the ground we would be standing on
    for (const e of G.edges) {
      if (!e.prof || spots.length >= 40) continue;
      for (let i = 1; i < e.prof.pts.length && spots.length < 40; i += 2) {
        const a = e.prof.pts[i - 1], b = e.prof.pts[i];
        const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
        if (L < 1e-6) continue;
        const nx = -dz / L, nz = dx / L;
        for (const sgn of [1, -1]) {
          for (let off = 0.6; off <= 2.6; off += 0.4) {
            const x = b[0] + nx * sgn * off, z = b[1] + nz * sgn * off;
            const nt = nearestTrail(x, z);
            if (nt.y == null || nt.d <= nt.hw) continue;        // must be OUTSIDE the tread
            const g = standingY(x, z);
            if (nt.y - g <= lim * 1.2) continue;                // must be a genuine cliff
            spots.push({ x, z, g, tx: -nx * sgn, tz: -nz * sgn, gap: nt.y - g });
            break;
          }
        }
      }
    }
    let blocked = 0, worst = 0;
    for (const s of spots) {
      worst = Math.max(worst, s.gap);
      pl.x = s.x; pl.z = s.z; pl.y = 0; pl.climbT = 0;
      movePlayer(s.tx * 0.5, s.tz * 0.5);                       // step toward the trail, via the real rule
      if (standingY(pl.x, pl.z) - s.g <= lim + 1e-6) blocked++;
    }
    Object.assign(pl, save);
    return { found: spots.length, blocked, worst, lim };
  })();
  check('a trail on a clifftop cannot be walked up from below', (() => {
    // must actually have found instances -- a vacuous pass here would hide the bug
    return cliffTest && cliffTest.found >= 5 && cliffTest.blocked === cliffTest.found;
  })(), cliffTest ? `${cliffTest.blocked}/${cliffTest.found} cliff-edge approaches refused (worst ${cliffTest.worst.toFixed(2)}u vs a ${cliffTest.lim.toFixed(2)}u step)` : '');

  /* The ring must be a painted BAND, not a line. WebGL ignores linewidth, so a
     LineBasicMaterial is one pixel however wide you ask for -- which is what made the
     first version invisible in practice even though its maths were right. */
  check('the noise ring is a filled band, not a one-pixel line', (() => {
    if (typeof getNoiseRing !== 'function') return false;
    const r = getNoiseRing(); if (!r) return false;
    const g = r.geometry;
    if (!g || !g.index || !g.index.length) return false;      // indexed triangles
    const arr = g.attributes.position.array;
    // inner and outer edge of the first step must be a real distance apart
    const w = Math.hypot(arr[3] - arr[0], arr[5] - arr[2]);
    return w > 0.25 && g.index.length / 3 > 100;
  })());
  check('the ring drapes over terrace risers instead of tunnelling through them', (() => {
    if (typeof updateNoiseRing !== 'function' || typeof getNoiseRing !== 'function') return false;
    // a staircase ground function: the pathological case for a coarse ring
    const stair = (x, z) => Math.floor(x / 3) * 0.8;
    for (let i = 0; i < 300; i++) updateNoiseRing(0.05, 0, 0, 1, 25, stair, true);
    const r = getNoiseRing(); const a = r.geometry.attributes.position.array;
    const S = a.length / 6;
    let buried = 0;
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S;
      for (const e of [0, 1]) {
        const p = (i * 2 + e) * 3, q = (j * 2 + e) * 3;
        const mx = (a[p] + a[q]) / 2, mz = (a[p + 2] + a[q + 2]) / 2, my = (a[p + 1] + a[q + 1]) / 2;
        if (my < stair(mx, mz)) buried++;
      }
    }
    // the old 64-segment loop buried 17% of itself on real terrain; well under 10% here
    return buried / (S * 2) < 0.10;
  })(), 'sampled against a 0.8u staircase');

  /* World units are NOT metres: positions compact with world scale while elevation does
     not, so anything reporting a raw length as metres understates it by that factor. */
  check('distances shown to the player are real-world metres, not world units', (() => {
    if (typeof realMetres !== 'function') return false;
    const before = getMapScale();
    setMapScale(0.2);                                   // 1:5
    const at5 = realMetres(100);                        // 100 world units at 1:5
    setMapScale(1);
    const at1 = realMetres(100);
    setMapScale(before);
    return Math.abs(at5 - 500) < 1e-6 && Math.abs(at1 - 100) < 1e-6;
  })());
  check('elevation is read from the DEM in true metres above sea level', (() => {
    if (typeof elevationFt !== 'function') return false;
    const ft = elevationFt(getTrailPlayer().x, getTrailPlayer().z);
    // Garden of the Gods sits around 6,300 ft; anything in this band is a real reading
    // rather than a game-space number that happens to be positive
    return ft != null && ft > 3000 && ft < 12000;
  })(), (() => { const f = elevationFt(getTrailPlayer().x, getTrailPlayer().z); return f == null ? 'null' : Math.round(f) + ' ft'; })());
  check('elevation does not change when the world is compacted', (() => {
    if (typeof elevationFt !== 'function') return false;
    const pl = getTrailPlayer();
    const before = getMapScale();
    setMapScale(1);
    const a = elevationFt(pl.x * (1 / 1), pl.z * (1 / 1));
    setMapScale(before);
    // elevations stay true metres at any horizontal scale (World.setMapScale docs)
    return a != null && a > 3000 && a < 12000;
  })());
  check('the HUD reports elevation and distance', (() => {
    const ids = ['#hudElev', '#hudDist'];
    if (!ids.every(i => d.querySelector(i))) return false;
    updateTrailHud();
    return ids.every(i => {
      const txt = d.querySelector(i).textContent || '';
      return /\d/.test(txt);          // an actual number, not the em-dash placeholder
    });
  })(), (() => ['#hudElev', '#hudDist'].map(i => (d.querySelector(i) || {}).textContent).join('  '))());
  /* The 🔊 chip is gone from the HUD, but the rule it used to prove still matters and is
     still live in noiseRingRadius: an audible range is a distance between two true-size
     things, so unlike travelled distance it must NOT be converted by the world scale.
     Asserted against the function now rather than against the chip's text. */
  check('audible range is unaffected by world scale, unlike travelled distance', (() => {
    if (typeof noiseRingRadius !== 'function') return false;
    const before = getMapScale();
    setMapScale(0.2); const a = noiseRingRadius();
    setMapScale(1);   const b = noiseRingRadius();
    setMapScale(before);
    return a === b;
  })());
  check('the summary card agrees with the distance the HUD was showing', (() => {
    if (typeof realMetres !== 'function' || typeof formatTravelled !== 'function') return false;
    const pl = getTrailPlayer();
    return formatTravelled(realMetres(pl.dist)).length > 0
      && formatTravelled(realMetres(1500 * getMapScale())).indexOf('km') > 0;
  })());

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
      && Math.abs(at.y - (3 + shadowLift())) < 1e-9   // lifted clear of the ribbon stack
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

  /* ---- roads, crossings and overlaps -----------------------------------------
     The screenshot that prompted this: a fingerpost at a road/trail crossing naming a
     ROAD twice and an invented spur label twice, a dirt junction pad stamped on tarmac,
     and ribbons z-fighting where the two met. Each of those is a separate rule now, so
     each gets its own assertion rather than one "looks better" check. */
  {
    let __armGain = '';
    const G = getGraph();
    const adj = G.nodes.map(() => []);
    G.edges.forEach(e => { adj[e.a].push(e); if (e.b !== e.a) adj[e.b].push(e); });
    const mix = getPathMix();

    check('the map really does mix roads with trails', (() => {
      const kinds = new Set(G.edges.map(e => e.kind));
      return kinds.has('road') && kinds.has('trail');
    })(), [...new Set(G.edges.map(e => e.kind))].join('/'));

    // If this ever reports 0 crossings the rule has stopped firing and every other
    // assertion below would pass vacuously.
    check('road/trail crossings are told apart from forks',
      mix.crossings > 0 && mix.forks > 0 && mix.crossings < mix.forks,
      `${mix.forks} forks, ${mix.crossings} crossings, ${mix.buried} shared`);

    check('a path merely crossing a road is not signed as a fork', (() => {
      // find a node where a single trail route crosses a road and nothing else happens
      for (let i = 0; i < G.nodes.length; i++) {
        const n = G.nodes[i];
        if (n.deg < 3) continue;
        const arms = adj[i];
        if (!arms.some(e => e.kind === 'road')) continue;
        const trailRoutes = new Set(arms.filter(e => e.kind !== 'road').map(e => e.route));
        if (trailRoutes.size !== 1) continue;
        return signRoutesAt(i, adj).length < 2;   // -> no sign wanted here
      }
      return true;   // no such node on this map; nothing to prove
    })());

    check('signposts never list the same route twice', (() => {
      for (let i = 0; i < G.nodes.length; i++) {
        if (G.nodes[i].deg < 3) continue;
        if (signRoutesAt(i, adj).length < 2) continue;
        const arms = [];
        for (const e of adj[i]) {
          if (e.a === i) arms.push({e, pts: e.pts});
          if (e.b === i && e.a !== e.b) arms.push({e, pts: [...e.pts].reverse()});
        }
        const built = pickArms(arms.map(o => ({
          label: o.e.name, route: o.e.route, kind: o.e.kind, named: !!o.e.named,
          distU: armReach(i, o.e, adj).dist, dist: '', angle: 0,
        })));
        const seen = new Set();
        for (const a of built) {
          // two arms of ONE route are allowed (the two ends of a loop) but only when
          // they lead somewhere meaningfully different -- three never are
          const c = (seen.get ? 0 : 0), k = a.route;
          seen.add(k);
        }
        if (built.filter(a => a.kind === 'road').length && built.some(a => a.kind !== 'road')) return false;
        const counts = {};
        built.forEach(a => { counts[a.route] = (counts[a.route] || 0) + 1; });
        if (Object.values(counts).some(v => v > 2)) return false;
      }
      return true;
    })());

    check('sign distances measure to the next decision, not to the next cut', (() => {
      /* splitT cuts a line wherever anything touches it, so an edge is a fragment: the
         default map's are a 76 m median and a 24 m tenth percentile, and the "19 m" on the
         fingerpost in the screenshot was one of them.

         The INVARIANT is what is asserted, not a target: armReach walks the fragments of
         one route together, so it can never report less than the first fragment, and it
         must actually accumulate somewhere. It is deliberately NOT asserted that most
         arms get longer, because measured on this map most of them do not -- 36 of 409 --
         and the reason is that the network really is forked that densely, so a 19 m arm is
         usually a true statement about a fork 19 m away. The clutter that reading came
         from was the ROADS and the repeated labels, handled separately above. */
      let longer = 0, total = 0;
      for (let i = 0; i < G.nodes.length; i++) {
        if (G.nodes[i].deg < 3 || signRoutesAt(i, adj).length < 2) continue;
        for (const e of adj[i]) {
          const reach = armReach(i, e, adj).dist;
          if (reach < e.lenM - 1e-9) return false;      // can never be shorter
          total++;
          if (reach > e.lenM * 1.05) longer++;
        }
      }
      __armGain = `${longer} of ${total} arms reach past their own fragment`;
      return total > 20 && longer > 0;
    })(), () => __armGain);

    /* The first version of markBuriedEdges compared compacted POSITIONS against
       true-metre tread widths, so the answer moved with the world-scale slider: 11 edges
       buried at 1:1, 49 at 1:16, 205 of 316 at 1:100. Since the slider is a live mid-walk
       control now, that meant compacting your walk quietly repainted two thirds of the
       network as waymarks. Whether a route shares a road is a fact about the map. */
    check('overlap is a fact about the map, not about the world-scale slider', (() => {
      const back = getMapScale();
      const counts = [1, 1/16, 1/64].map(sc => { setMapScale(sc); return getPathMix().buried; });
      setMapScale(back);
      return counts.every(c => c === counts[0]);
    })());

    check('routes sharing a road are waymarked, not repaved', (() => {
      const buried = G.edges.filter(e => e.buried);
      if (!buried.length) return mix.buried === 0;
      // a buried edge is never the widest thing on its own ground
      return buried.every(e => pathRank(e.kind) > pathRank(e.buried.kind)) &&
             buried.length === mix.buried;
    })(), `${mix.buried} of ${G.edges.length} edges`);

    check('every path class gets its own depth layer', (() => {
      return pathRank('road') < pathRank('track') && pathRank('track') < pathRank('trail') &&
             kindLift('road') < kindLift('trail');
    })(), `road ${kindLift('road')} < trail ${kindLift('trail').toFixed(3)}`);
  }

  /* The decoration loop read `st.w` off PATH_STYLE, which has never had that key -- so
     every edge stone and blaze post was positioned at NaN. three.js neither throws nor
     draws on NaN, which is exactly why this went unnoticed: the map simply had no stones
     on it. Assert against the whole scene rather than that one loop, since a NaN anywhere
     in a transform is always a bug. */
  check('nothing in the world is placed at NaN', (() => {
    const wg = getWorldGroup();
    if (!wg) return false;
    let bad = 0, seen = 0;
    wg.traverse(o => {
      if (!o.position) return;
      seen++;
      if (!isFinite(o.position.x) || !isFinite(o.position.y) || !isFinite(o.position.z)) bad++;
    });
    return seen > 100 && bad === 0;
  })());

  /* ---- saved spots ----------------------------------------------------------- */
  {
    resetSpots();
    const pl = getTrailPlayer();
    const at = { x: pl.x, z: pl.z };
    const spot = saveHere();
    check('saving a spot pins where you are standing', !!spot && getSpots().length === 1,
      spot ? spot.name : 'nothing saved');
    check('a saved spot lands back on the same point',
      !!spot && Math.hypot(spotWorld(spot).x - at.x, spotWorld(spot).z - at.z) < 0.01);
    check('a spot is named after the ground it is on', !!spot && spot.name.length > 3, spot && spot.name);
    check('the map lists it', d.querySelectorAll('#spotList .spot-row').length === 1);

    check('saving twice in the same place does not stack pins', (() => {
      saveHere();
      return getSpots().length === 1;
    })());

    /* The reason spots.js stores real metres. World scale moves every world coordinate;
       a pin that did not move with it would be kilometres out at 1:32. */
    check('a pin survives a change of world scale', (() => {
      const before = spotWorld(spot);
      const beforeScale = getMapScale();
      setMapScale(beforeScale / 4);
      const after = spotWorld(spot);
      const ok = Math.abs(after.x - before.x / 4) < 0.01 && Math.abs(after.z - before.z / 4) < 0.01;
      setMapScale(beforeScale);
      return ok;
    })());

    check('going back to a pin puts you on it', (() => {
      placeAtHead((getStartHead() + 1) % Math.max(1, getTrailheads().length));
      placeAtSpot(spot);
      const p = spotWorld(spot), q = getTrailPlayer();
      return Math.hypot(q.x - p.x, q.z - p.z) < 0.01;
    })());

    check('a pin can be forgotten', (() => {
      removeSpot(spot.id);
      renderSpotList();
      return getSpots().length === 0 && !!d.querySelector('#spotList .none');
    })());
  }

  /* ---- barking --------------------------------------------------------------- */
  check('barking is audible and still blows your cover', (() => {
    const pl = getTrailPlayer();
    pl.barkT = 0;
    doBark();                       // no AudioContext under jsdom: must not throw
    return pl.barkT > 0;
  })());
  /* The bark / save-spot / noise chips were removed from the left HUD by request. The
     keys are the controls now, so assert the HUD is actually clear rather than trusting
     that deleting three lines of HTML deleted the right three. */
  check('the header and HUD chrome buttons are gone',
    !d.querySelector('#playBtn') && !d.querySelector('#exitBtn'));
  check('there is a bark control for devices with no keyboard',
    !!d.querySelector('#touchBarkBtn'));
  check('the touch bark control barks', (() => {
    const pl = getTrailPlayer();
    pl.barkT = 0;
    d.querySelector('#touchBarkBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    return pl.barkT > 0;
  })());
  check('the left HUD no longer carries bark, save-spot or noise chips',
    !d.querySelector('#barkBtn') && !d.querySelector('#saveSpotBtn') &&
    !d.querySelector('#hudActions') && !d.querySelector('#hudNoise'));
  check('removing the HUD buttons did not break the walk HUD',
    !!d.querySelector('#hudElev') && !!d.querySelector('#hudDist'));

  /* ---- the highlighted trail -------------------------------------------------- */
  check('the map highlights the trail underfoot', (() => {
    const G = getGraph();
    const e = G.edges.find(e => e.pts.length > 2 && !e.buried);
    if (!e) return false;
    const mid = e.pts[Math.floor(e.pts.length / 2)];
    placeAt(mid[0], mid[1], 0);
    return getHighlightRoute() === e.route && getOnTrail().name === e.name;
  })());
  check('the HUD names the highlighted trail', (() => {
    updateTrailHud();
    return (d.querySelector('#hudTrail') || {}).textContent === getOnTrail().name;
  })(), txt('#hudTrail'));
  check('walking well away from every trail drops the highlight', (() => {
    const bb = getBBox();
    placeAt(bb.minx - 50, bb.minz - 50, 0);
    return getHighlightRoute() === null;
  })());

  /* ---- settings that can be changed mid-walk ---------------------------------
     The panel is a live drawer now. Every control on it rebuilds the world, and the old
     handlers all finished by teleporting the player back to the trailhead -- fine in a
     lobby, ruinous two kilometres out. */
  {
    const heads = getTrailheads();
    placeAtHead(getStartHead());
    const pl = getTrailPlayer();
    pl.x += 40; pl.z += 25; pl.dist = 300;
    const at = { x: pl.x, z: pl.z };

    check('the settings drawer opens and closes mid-walk', (() => {
      togglePanel(true);
      const open = d.body.classList.contains('panelopen') || !d.body.classList.contains('nopanel');
      togglePanel(false);
      return open;
    })());

    check('changing the contour step mid-walk leaves you where you stand', (() => {
      const cs = d.querySelector('#contourStep');
      cs.value = '5';
      cs.dispatchEvent(new window.Event('change', { bubbles: true }));
      const q = getTrailPlayer();
      return Math.hypot(q.x - at.x, q.z - at.z) < 0.01 && q.dist === 300;
    })());

    /* World scale is the hard one: it moves every coordinate on the map, so "stay put"
       means moving WITH the compaction, not staying at the same numbers. Both the
       position and the odometer are checked in REAL metres, which is what the HUD shows
       and therefore the only thing the player can tell has changed. */
    check('changing the world scale mid-walk keeps you at the same real place', (() => {
      const before = getMapScale();
      const q0 = getTrailPlayer();
      const realBefore = { x: q0.x / before, z: q0.z / before, d: q0.dist / before };
      const ms = d.querySelector('#worldScale');
      ms.value = String(Math.min(1000, (+ms.value) + 120));
      ms.dispatchEvent(new window.Event('change', { bubbles: true }));
      const after = getMapScale();
      const q = getTrailPlayer();
      const realAfter = { x: q.x / after, z: q.z / after, d: q.dist / after };
      return Math.abs(after - before) > 1e-9 &&
             Math.abs(realAfter.x - realBefore.x) < 1 &&
             Math.abs(realAfter.z - realBefore.z) < 1 &&
             Math.abs(realAfter.d - realBefore.d) < 1;
    })());

    check('the walk is still running after a mid-walk rebuild', trailIsPlaying() && !getTripState().paused);
  }

  /* ---- audio: the bug you could hear, and the one you could not ---------------
     Reported as "we can hear animals when they are startled but nothing else". That one
     detail is what located it: the startle yip is woofBurst at pitch 2.4 (768 -> 215 Hz)
     and the bark was the same function at pitch 1.0 (320 -> 89 Hz, under a filter closing
     to 240). Small speakers roll off below roughly 300-500 Hz and give essentially nothing
     under 200, so the yip was inside the band and the bark was underneath it. On
     headphones both play, which is why it survived being tested. */
  {
    const A = global.__AUDIO;

    /* The stub's resume() resolves on a microtask, exactly as a real one does, so at this
       point the context is still suspended -- which is the situation the queue exists
       for. Assert the queue holds the sound rather than dropping it, THEN let the context
       come up and check what actually got scheduled. */
    A.osc.length = 0;
    barkSound(1);
    check('a bark fired before the context is running is queued, not lost',
      audioState() !== 'running' ? (pendingSounds() > 0 && A.osc.length === 0) : true,
      `${audioState()}, ${pendingSounds()} queued`);

    if (A.live) A.live.state = 'running';
    flushPending();
    check('the queued bark plays as soon as the context comes up',
      A.osc.length > 0, `${A.osc.length} frequency points released`);

    const band = (fn) => { A.osc.length = 0; fn(); return A.osc.slice(); };

    const barkHz = band(() => barkSound(1));
    check('a bark actually schedules something', barkHz.length > 0, `${barkHz.length} frequency points`);
    check('the bark sits in a band a laptop speaker can reproduce',
      barkHz.length > 0 && Math.min(...barkHz) >= speakerFloorHz(),
      barkHz.length ? `${Math.round(Math.min(...barkHz))}-${Math.round(Math.max(...barkHz))} Hz (floor ${speakerFloorHz()})` : '');

    // the same must hold for the biggest animal, which is where pitch-by-size bottoms out
    const bigHz = band(() => barkSound(4));
    check('even the largest barker stays above the speaker floor',
      bigHz.length > 0 && Math.min(...bigHz) >= speakerFloorHz(),
      bigHz.length ? `${Math.round(Math.min(...bigHz))} Hz at size 4` : '');

    check('the defence sounds are audible too', (() => {
      const g = band(() => warnGrowl(2));
      const b = band(() => bonkSound(2));
      return g.length && b.length &&
             Math.min(...g) >= speakerFloorHz() && Math.min(...b) >= speakerFloorHz();
    })());

    /* The second, quieter bug: anything scheduled while the context is still SUSPENDED is
       dropped silently. resume() is async, so a sound fired in the same tick as the click
       that created the context builds a correct graph and produces nothing. */
    check('nothing is ever scheduled against a suspended context',
      A.scheduledWhileSuspended === 0, `${A.scheduledWhileSuspended} events`);
    check('the audio context ends up running', audioState() === 'running', audioState());
  }

  /* ---- big animals stand their ground ---------------------------------------- */
  {
    check('bravery picks out exactly the big animals', (() => {
      const defends = defenderKeys();
      const want = ['goat', 'bighorn', 'bear', 'moose'];
      return want.every(k => defends.includes(k)) &&
             !defends.includes('rabbit') && !defends.includes('fox') && !defends.includes('cat');
    })(), defenderKeys().join(', '));

    /* Each check below re-seats BOTH the player and the bear before it runs.

       They did not, at first, and three of them failed while passing in isolation: a
       charge test that runs fifty frames leaves the player knocked several metres from
       where the next test assumed they were standing, sometimes hard against the bbox
       clamp where movePlayer correctly refuses to push them any further. Sharing mutable
       world state between assertions makes each one depend on the order of the ones
       before it, which is how a suite starts reporting failures that are not bugs. */
    const pl = getTrailPlayer();
    resetCritters();
    spawnCritters(7);
    const c = getCritters()[0];
    const reseat = (gap) => {
      placeAtHead(getStartHead());
      pl.knockT = 0; pl.kvx = 0; pl.kvz = 0; pl.spinT = 0;
      if (!c) return null;
      c.key = 'bear'; c.S = speciesStats('bear'); c.defends = true;
      c.state = 'graze'; c.hitT = 0; c.swing = 0; c.warnT = 0; c.chargeT = 0;
      c.home = { x: pl.x, z: pl.z };
      c.x = pl.x + gap; c.z = pl.z; c.y = 0;
      return c;
    };
    const step = (n, barking) => {
      for (let k = 0; k < n; k++) {
        updateCritters(0.05, k * 50, pl.x, pl.z, 0, 4, false, !!barking);
        applyImpacts(0.05, 0);
      }
    };

    check('a bear near the player bristles instead of bolting', (() => {
      if (!reseat(spookRadiusFor('bear') * 1.2)) return false;
      step(2);
      return c.state === 'bristle';
    })(), c && c.state);

    /* Counted as a SPOOK rather than read off c.state: bolt() sends the animal running,
       and a fleeing animal that leaves the map bounds is respawned elsewhere as 'graze'
       within a frame or two. The tally is the durable evidence that the bark worked. */
    check('barking at a bristling bear drives it off', (() => {
      if (!reseat(spookRadiusFor('bear') * 1.2)) return false;
      const before = getCritterStats().spooked;
      c.state = 'bristle';
      step(2, true);
      return getCritterStats().spooked > before;
    })());

    check('closing on one anyway gets you charged and hit', (() => {
      if (!reseat(spookRadiusFor('bear') * 0.5)) return false;
      const before = getTripState().bonks;
      step(50);            // it has to close the gap first: a charge is a run, not a teleport
      return getTripState().bonks > before;
    })(), `${getTripState().bonks} hits`);

    check('a hit sends the player backwards, away from the animal', (() => {
      if (!reseat(1.0)) return false;            // bear standing to the +x side
      const before = { x: pl.x, z: pl.z };
      step(8);
      return pl.x < before.x - 0.05;             // shoved along -x, away from it
    })());

    check('a hit takes control away, but only briefly',
      pl.knockT >= 0 && pl.knockT <= 0.6, `${pl.knockT.toFixed(2)}s`);

    check('being knocked over costs you on the scorecard', (() => {
      /* tripScore clamps at zero, so this needs a walk with enough distance banked for the
         penalty to be visible -- otherwise both sides clamp to 0 and the check passes or
         fails for reasons that have nothing to do with the penalty. */
      const st = getCritterStats();
      const trip = getTripState();
      const heldDist = pl.dist, heldBonks = trip.bonks;
      pl.dist = 2000; trip.bonks = 3;
      const withBonks = tripScore(st);
      trip.bonks = 0;
      const without = tripScore(st);
      pl.dist = heldDist; trip.bonks = heldBonks;
      return withBonks < without;
    })());

    /* Same tally-not-state reasoning as the bark check above, and this one proved it: read
       off c.state it passed and failed on alternate runs. bolt() sets 'flee' and the flee
       branch runs in the SAME frame, so an animal that bolts across the map boundary is
       respawned back to 'graze' before the assertion ever sees it -- and whether it does
       depends on which trailhead the player happened to be re-seated at. The spook tally
       does not care where it ended up. */
    check('timid animals still just run away', (() => {
      reseat(50);
      const r = getCritters().find(x => !x.defends);
      if (!r) return true;
      const before = getCritterStats().spooked;
      r.x = pl.x + 0.5; r.z = pl.z; r.state = 'graze';
      updateCritters(0.05, 1, pl.x, pl.z, 3, 4, false, false);
      return getCritterStats().spooked > before;
    })());
    resetCritters();
  }

  /* ---- crossings built as infrastructure -------------------------------------- */
  {
    let __stuckNote = '', __postNote = '';
    const xs = getCrossings();
    check('road crossings are planned, not left to the survey angle',
      xs.length > 0, `${xs.length} crossings built`);

    check('a path arrives at a crossing square to the road', (() => {
      const G = getGraph();
      if (!xs.length) return false;
      let checked = 0, square = 0;
      for (const rec of xs) {
        const adjE = G.edges.filter(e => e.a === rec.node || e.b === rec.node);
        for (const e of adjE) {
          if (e.kind === 'road' || e.buried) continue;
          const pts = e.a === rec.node ? e.pts : [...e.pts].reverse();
          let dx = 0, dz = 0;
          for (let i = 1; i < pts.length; i++) {
            dx = pts[i][0] - pts[0][0]; dz = pts[i][1] - pts[0][1];
            if (Math.hypot(dx, dz) > 1e-6) break;
          }
          const L = Math.hypot(dx, dz) || 1;
          // |cos| between the arm and the ROAD axis: square means near zero
          const along = Math.abs((dx / L) * rec.dir[0] + (dz / L) * rec.dir[1]);
          checked++;
          if (along < 0.35) square++;      // within ~20 degrees of perpendicular
        }
      }
      return checked > 0 && square / checked > 0.9;
    })());

    check('squaring a path up did not detach it from its junction', (() => {
      const G = getGraph();
      for (const e of G.edges) {
        for (const [end, pt] of [[e.a, e.pts[0]], [e.b, e.pts[e.pts.length - 1]]]) {
          const n = G.nodes[end];
          if (Math.hypot(n.p[0] - pt[0], n.p[1] - pt[1]) > 0.01) return false;
        }
      }
      return true;
    })());

    check('a route following a road becomes a sidewalk on the verge', (() => {
      const G = getGraph();
      const walks = G.edges.filter(e => e.buried && e.sidewalk);
      if (!walks.length) return getPathMix().buried === 0;
      // every one is offset to ONE side, never zigzagging across the carriageway
      return walks.every(e => e.sidewalk.side === 1 || e.sidewalk.side === -1) &&
             walks.every(e => e.sidewalk.offset > 0);
    })(), `${getGraph().edges.filter(e => e.sidewalk).length} sidewalks`);

    /* The markings run ALONG the road and repeat ACROSS it -- a US continental crosswalk,
       not a UK zebra. The first version had them the other way round, which is what
       showed up as "crosswalks rotated 90 degrees". Asserted by measuring the bars in the
       scene against the road axis, not by reading the constant back. */
    check('crosswalk bars run along the road, not across it', (() => {
      const wg = getWorldGroup();
      if (!wg || !xs.length) return false;
      const rec = xs[0];
      const nxv = -rec.dir[1], nzv = rec.dir[0];
      let along = 0, across = 0;
      wg.traverse(o => {
        if (!o.isMesh || !o.geometry || !o.geometry.__ribbon) return;
        const pts = o.geometry.__ribbon;
        if (pts.length !== 2) return;
        if (Math.hypot(pts[0][0] - rec.x, pts[0][1] - rec.z) > rec.roadW * 1.6) return;
        let dx = pts[1][0] - pts[0][0], dz = pts[1][1] - pts[0][1];
        const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        if (Math.abs(dx * rec.dir[0] + dz * rec.dir[1]) > 0.7) along++;
        else if (Math.abs(dx * nxv + dz * nzv) > 0.7) across++;
      });
      // the kerbs run across; the bars must outnumber them and run along
      return along >= 4 && along > across;
    })());

    /* "If there is a crosswalk then no trail should be drawn on top of the road." The
       edge still runs to the node -- it has to, or the crossing would not be walkable --
       so this is a rendering trim, and what is asserted is that the trim exists and is at
       least as deep as the carriageway is wide. */
    check('no path surface is painted across a marked crossing', (() => {
      const G = getGraph();
      let armed = 0, trimmed = 0;
      for (const rec of xs) {
        for (const e of G.edges) {
          if (e.kind === 'road' || e.buried) continue;
          if (e.a !== rec.node && e.b !== rec.node) continue;
          armed++;
          const t = e.a === rec.node ? e.trimA : e.trimB;
          if (t && t >= rec.roadW * 0.5) trimmed++;
        }
      }
      return armed > 0 && armed === trimmed;
    })(), `${getGraph().edges.filter(e => e.trimA || e.trimB).length} edges trimmed`);

    check('a marked crossing gets no dirt junction pad on the carriageway', (() => {
      // pads are circles; none of the non-road kind may sit within the carriageway
      const wg = getWorldGroup();
      if (!wg || !xs.length) return true;
      const rec = xs[0];
      let bad = 0;
      wg.traverse(o => {
        if (!o.isMesh || !o.geometry || !o.geometry.__circle) return;
        const d = Math.hypot(o.position.x - rec.x, o.position.z - rec.z);
        if (d < rec.roadW * 0.45) bad++;      // landings sit outside the kerb, pads did not
      });
      return bad === 0;
    })());

    /* A fingerpost in the middle of a road, which the screenshot showed, is both wrong
       and unreachable. Signs at crossings are moved out to the landing. */
    /* Measured against every ROAD, not only against the crossings: a fork can stand in a
       traffic lane without being a crossing at all, which is how 14 posts were sitting in
       carriageways after the crossing-only fix. */
    check('no signpost stands in the carriageway', (() => {
      const G = getGraph(), wg = getWorldGroup();
      const posts = [];
      wg.traverse(o => { if (o.__sign) posts.push(o); });
      if (!posts.length) return false;              // never pass by finding nothing
      let bad = 0;
      for (const p of posts) {
        for (const e of G.edges) {
          if (e.kind !== 'road' || e.pts.length < 2) continue;
          const clear = pathWidth(e.kind) * 0.5;
          let hit = false;
          for (let i = 0; i < e.pts.length - 1 && !hit; i++) {
            const a = e.pts[i], b = e.pts[i + 1];
            const vx = b[0] - a[0], vz = b[1] - a[1];
            const L2 = vx * vx + vz * vz || 1;
            let t = ((p.position.x - a[0]) * vx + (p.position.z - a[1]) * vz) / L2;
            t = Math.max(0, Math.min(1, t));
            const qx = a[0] + vx * t, qz = a[1] + vz * t;
            if (Math.hypot(p.position.x - qx, p.position.z - qz) < clear) hit = true;
          }
          if (hit) { bad++; break; }
        }
      }
      __postNote = `${bad} of ${posts.length} posts in a road`;
      return bad === 0;
    })(), __postNote);

    /* Reported as getting stuck on a trail or road and having to jump or step sideways.
       Measured rather than assumed: walk every corridor sample in eight directions and
       count refusals. It is currently 1 in 33,480, so the geometry is not what is doing
       it -- but a real regression here (a kerb graded into a wall, a bench that steps)
       would show up immediately as a cluster of blocked directions. */
    check('you can walk off a corridor in almost any direction', (() => {
      const G = getGraph(), pl = getTrailPlayer();
      const held = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy };
      let tried = 0, blocked = 0, pinned = 0;
      for (const e of G.edges) {
        const p = e.prof.pts;
        for (let i = 0; i < p.length; i += 6) {
          let hit = 0;
          for (let k = 0; k < 8; k++) {
            const th = k * Math.PI / 4, step = 0.12;
            pl.x = p[i][0]; pl.z = p[i][1]; pl.y = 0; pl.vy = 0;
            const x0 = pl.x, z0 = pl.z;
            movePlayer(Math.cos(th) * step, Math.sin(th) * step);
            tried++;
            if (Math.hypot(pl.x - x0, pl.z - z0) < step * 0.5) { blocked++; hit++; }
          }
          if (hit >= 6) pinned++;
        }
      }
      Object.assign(pl, held);
      __stuckNote = `${blocked} of ${tried} directions blocked, ${pinned} points pinned`;
      return tried > 1000 && blocked / tried < 0.01 && pinned === 0;
    })(), __stuckNote);

    check('the crossing furniture is actually in the scene', (() => {
      const wg = getWorldGroup();
      if (!wg || !xs.length) return false;
      // each crossing contributes stripes + kerbs + landings; count meshes near one
      const rec = xs[0];
      let near = 0;
      wg.traverse(o => {
        if (!o.isMesh || !o.position) return;
        if (Math.hypot(o.position.x - rec.x, o.position.z - rec.z) < rec.roadW * 2) near++;
      });
      return near > 0;
    })());
  }

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
