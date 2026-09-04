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
  chase: (()=>{ try{
    const out={typical:+typicalSpookRadius().toFixed(2), reach:+catchRadius().toFixed(2), species:[]};
    for(const k of ['rabbit','squirrel','chipmunk','fox']){
      const R=spookRadiusFor(k);
      out.species.push({k, spook:+R.toFixed(2),
        boltMovingSneak:+(R*playerNoise(3,6,true,false,0)).toFixed(2),
        boltSettledSneak:+(R*playerNoise(0,6,true,false,1)).toFixed(2),
        boltMovingWalk:+(R*playerNoise(3,6,false,false,0)).toFixed(2),
        boltSettledWalk:+(R*playerNoise(0,6,false,false,1)).toFixed(2),
        reachable: R*playerNoise(3,6,true,false,0) < catchRadius() });
    }
    return out;
  }catch(e){ return {err:e.message, st:e.stack}; } })(),
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
  let __areaNote = '', __solidNote = '', __carryNote = '', blockedNote = '', __ringNote = '';
  let __topNote = '', __climbNote = '', __reachNote = '', __sneakNote = '';
  let __losNote = '', __seeNote = '';
  let __frameNote = '', __embedNote = '', __outsideNote = '';
  let __catchNote = '', __chainNote = '', __slideNote = '', __hangNote = '', __poseNote = '';
  let __faceNote = '', __walkInNote = '', __jumpNote = '', __boundsNote = '';
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

  /* THE GAME OPENS ON A WALK, not on a lobby. Finding the 🗺 button and working out that
     tapping a lettered badge is how a game begins was a tutorial step in front of a game
     with no other tutorial steps. Asserted at both levels because they are separately
     breakable: `playing` is what the input handlers gate on, and body.play is what the
     HUD, the settings drawer and the touch controls key off. */
  check('boot starts a walk without anyone opening the map', trailIsPlaying());
  check('boot puts the page into play mode', d.body.classList.contains('play'));
  check('boot does not open the map sheet over the walk', !d.body.classList.contains('bigmap'));

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

  /* World scale is a log-mapped 0..1000 slider POSITION -> "1:N", not a raw multiplier
     (see wireScale's posToN/nToPos). The range is now 1:1..1:15, so the far end of the
     handle is N=15 -- it used to run to 1:1000 and this test drove the midpoint expecting
     N=32. Driven to the top of the range rather than a midpoint so the assertion stays
     "more compacted than wherever we were" regardless of what an earlier test left the
     scale at, which is what it was always trying to say.

     NOT the top of the handle, deliberately: a later test ('changing the world scale
     mid-walk') nudges this same slider by +120 and asserts the scale actually moved, so
     parking it at 1000 here silently turns that nudge into a no-op and fails a test three
     hundred lines away for a reason that looks nothing like the cause. */
  const before = Math.hypot(s.heads[s.startHead].x, s.heads[s.startHead].z);
  const beforeMapScale = s.mapScale;
  const ms = d.querySelector('#worldScale');
  ms.value = '800';
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
  /* Elevation does not compact with the footprint, so at 1:N the same hills are N times
     steeper. Exaggeration is now re-linked whenever the scale moves so the ratio stays at
     true slope -- the thing the panel hint used to tell you to go and do by hand. */
  check('changing world scale keeps the slope true',
    Math.abs(getExaggeration() - s.mapScale) < 1e-6,
    `exaggeration ${getExaggeration().toFixed(3)} vs map scale ${s.mapScale.toFixed(3)}`);
  check('the exaggeration slider followed the scale',
    Math.abs(+d.querySelector('#vertScale').value - Math.sqrt(getExaggeration()/2)*1000) < 2,
    `handle at ${d.querySelector('#vertScale').value}`);

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
  /* The slider's max and world.js's clamp have to agree. Raising the input's max to 5 on
     its own did nothing at all -- the value arrived at setFogMultiplier and was clamped
     straight back to 3, so the handle moved and the view did not, which is exactly the
     kind of change that looks done from the markup. Asserted through the setter, because
     that is the half that was wrong. */
  check('fog reaches the top of its slider', (() => {
    const max = +d.querySelector('#fogAmt').max;
    setFogMultiplier(max);
    const got = getFogMultiplier();
    setFogMultiplier(2);
    return max >= 5 && Math.abs(got - max) < 1e-9;
  })(), `slider max ${d.querySelector('#fogAmt').max}`);

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

  /* ---- the on-screen controls a phone or tablet has instead of a keyboard ----------
     The drag-stick was always there; NOTHING ON SCREEN SAID SO, and jump (space) and
     sneak (C) had no touch equivalent at all -- so on an iPad two of the four verbs were
     unreachable and a third was undiscoverable. These assert the visible half, which is
     the part that was missing, not the pointer maths above.

     Note the `touch` class is already on <body> by this point: the dragLeft(89,'touch')
     above is a real touch pointerdown, which is exactly what is supposed to mark a hybrid
     device mid-session. jsdom's matchMedia always reports false, so this is the ONLY path
     that sets it here -- which makes the assertion meaningful rather than tautological. */
  check('a touch marks the device, revealing the on-screen controls',
    d.body.classList.contains('touch'));
  check('the touch control layer exists', !!d.querySelector('#stickBase') &&
    !!d.querySelector('#stickKnob') && !!d.querySelector('#tJump') && !!d.querySelector('#tSneak'));

  /* The visible stick is a READOUT of the same object movement reads. Asserting it
     follows the thumb is asserting it cannot show one thing while the pup does another --
     a stick frozen at centre while the pup sprints is the failure this catches. */
  check('the stick follows the thumb and springs back on release', (() => {
    const base = d.querySelector('#stickBase'), knob = d.querySelector('#stickKnob');
    const dn = new window.MouseEvent('pointerdown', { bubbles:true, clientX:200, clientY:500 });
    dn.pointerId = 91; Object.defineProperty(dn, 'pointerType', { value:'touch' });
    canvas.dispatchEvent(dn);
    const held = base.classList.contains('on');
    const mv = new window.MouseEvent('pointermove', { bubbles:true, clientX:240, clientY:530 });
    mv.pointerId = 91; Object.defineProperty(mv, 'pointerType', { value:'touch' });
    window.dispatchEvent(mv);
    // knob offset must be real, and must be pinned inside the base's travel radius
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(knob.style.transform || '');
    const moved = !!m && Math.hypot(+m[1], +m[2]) > 1 && Math.hypot(+m[1], +m[2]) <= 52.5;
    const up = new window.MouseEvent('pointerup', { bubbles:true });
    up.pointerId = 91; Object.defineProperty(up, 'pointerType', { value:'touch' });
    window.dispatchEvent(up);
    const rested = !base.classList.contains('on') && !base.style.left &&
      /translate\(0px,\s*0px\)/.test(knob.style.transform || '');
    return held && moved && rested;
  })());

  check('the JUMP button gets the pup off the ground', (() => {
    const pl = getTrailPlayer();
    pl.y = 0; pl.vy = 0; pl.knockT = 0;
    d.querySelector('#tJump').dispatchEvent(new window.MouseEvent('click', { bubbles:true }));
    return pl.vy > 0;
  })());

  /* Sneak is a toggle AND is cleared out from under the player by being knocked over, so
     the lit state has to be pushed from the flag by the frame loop rather than flipped by
     the tap -- otherwise the button claims you are sneaking after a moose says otherwise. */
  check('the SNEAK button toggles sneaking and lights up', (() => {
    const pl = getTrailPlayer();
    pl.sneaking = false;
    d.querySelector('#tSneak').dispatchEvent(new window.MouseEvent('click', { bubbles:true }));
    return pl.sneaking === true && d.querySelector('#tSneak').classList.contains('on');
  })());
  check('the lit state follows the flag, not the tap', (() => {
    const pl = getTrailPlayer();
    pl.sneaking = false;                       // as a knock-back would clear it
    syncTouchButtons();
    return !d.querySelector('#tSneak').classList.contains('on');
  })());

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

  /* "Surprise me" is gone: a dice roll was the wrong answer to a spatial question on a
     sheet built for seeing where things are, and the only reason it existed was that the
     game used to open with no walk at all. What replaced it is asserted instead --
     pickDefaultHead lands on the trailhead nearest the middle of the network, so the
     first thirty seconds have trail leading away in several directions and are the SAME
     thirty seconds on every reload. */
  check('the surprise-me button is gone from the map sheet', !d.querySelector('#surpriseBtn'));
  check('the default start is the trailhead nearest the middle of the network', (() => {
    const heads = getTrailheads(); if (!heads.length) return false;
    const bb = getBBox();
    const cx = (bb.minx + bb.maxx) / 2, cz = (bb.minz + bb.maxz) / 2;
    let best = 0, bd = Infinity;
    heads.forEach((h, i) => { const dd = Math.hypot(h.x - cx, h.z - cz); if (dd < bd) { bd = dd; best = i; } });
    return pickDefaultHead() === best;
  })(), `head ${pickDefaultHead()} of ${getTrailheads().length}`);
  // mode is 'dog' at this point in the sequence (the "switching back to a dog" test
  // above already clicked one) -- checking wildPos here would compare against a stale
  // position nothing has updated since the earlier fox pick.
  placeAtHead(pickDefaultHead());
  const sp = probe();
  check('the default start seats the avatar at that trailhead', dist(sp.dogWorld, sp.heads[sp.startHead]) < 0.5,
    `head ${sp.startHead}`);

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

  /* ---- areas: grading, and the ground they claim ------------------------------
     The reported symptom was a pond floating at rock-formation height. The cause was not
     in how water is drawn -- it was flattenAreaCells handing a polygon a level graded for
     a NEIGHBOUR, off a single shared boundary cell picked in Set-iteration order. So the
     assertion is the general rule, not the water special case: whatever level an area
     claims has to be defensible from its OWN footprint. That is the check that would have
     caught this before it shipped, and it keeps working on maps that have no water at all
     (the default map has none -- both ponds are in data/rrworld.json). */
  check('no area is graded to a level its own ground cannot justify', (() => {
    const areas = getAreas(), W = getWorld();
    if (!areas.length || !W) return false;
    let worst = 0, who = '';
    for (const a of areas) {
      if (a.groundY == null) continue;
      const bb = areaBBox(a);
      const inside = [];
      for (let i = 0; i <= 14; i++) for (let j = 0; j <= 14; j++) {
        const x = bb.mnx + bb.w * i / 14, z = bb.mnz + bb.h * j / 14;
        if (pointInArea(x, z, a)) inside.push(W.heightAt(x, z));
      }
      if (inside.length < 4) continue;
      inside.sort((p, q) => p - q);
      // datum-relative, the same units groundY is in (terrain.js: lvl*STEP - GROUND_M)
      const lo = inside[0] - W.minM, hi = inside[inside.length - 1] - W.minM;
      // one contour step of slack either side: grading quantises to a band by design
      const over = Math.max(lo - getContourStep() - a.groundY, a.groundY - hi - getContourStep());
      if (over > worst) { worst = over; who = (a.kind + ' ' + (a.name || '')).trim(); }
    }
    __areaNote = worst > 0 ? `worst ${worst.toFixed(1)}m outside its own relief (${who})`
                           : 'every area within its own relief';
    return worst <= 0;
  })(), () => __areaNote);

  /* Solid areas are walls OFF the trail and are not walls ON it. Both halves matter and
     they pull in opposite directions, so both are asserted: a collider that yields to
     nothing fences off the ~5 m of trail that runs through Kissing Camels, and one that
     yields to everything is not a collider. */
  {
    const solids = getAreaSolids();
    check('rock masses and buildings are registered as solid',
      /* Pinned to the literal list rather than read back out of AREA_STYLE. Asserting a
         table against itself passes no matter what the table says; naming the kinds here
         is what makes "meadows and car parks are not walls" a thing the suite defends. */
      solids.length > 0 && solids.every(s => ['building','rock','redrock','lightrock'].includes(s.kind)),
      `${solids.length} solid areas: ${[...new Set(solids.map(s => s.kind))].join('/')}`);

    /* Interior points are FOUND by scanning, not assumed to be the centroid. These are
       digitised rock formations -- Kissing Camels is a long thin crescent -- and its
       bounding-box centre is outside the polygon entirely, so the first version of this
       check tested nothing and reported it as a failure. */
    check('you cannot walk into a rock mass off-trail', (() => {
      if (!solids.length) return false;
      let tested = 0, blocked = 0, leaked = 0;
      for (const s of solids) {
        const bb = s.bb;
        for (let i = 1; i < 26 && tested < 600; i++) for (let j = 1; j < 26; j++) {
          const x = bb.mnx + bb.w * i / 26, z = bb.mnz + bb.h * j / 26;
          if (!pointInArea(x, z, s.area)) continue;
          // a point genuinely inside a solid polygon, and off-trail, must be blocked
          const nt = nearestTrail(x, z);
          if (nt.d <= nt.hw) continue;                 // the tread wins; tested elsewhere
          tested++;
          if (areaBlocked(x, z, 0.45)) blocked++; else leaked++;
        }
        // and open ground a good way outside it must not be
        const out = { x: bb.mnx - 12, z: bb.mnz - 12 };
        if (areaBlocked(out.x, out.z, 0.45)) leaked++;
      }
      blockedNote = `${blocked} of ${tested} interior samples blocked, ${leaked} leaks`;
      return tested > 20 && leaked === 0 && blocked === tested;
    })(), () => blockedNote);

    /* What this defends is narrow and deliberate: the COLLIDER must never be the reason a
       trail station is impassable. It is not a general "every trail is walkable" check --
       that one already exists ('no terrace cliffs left along any trail') and is already
       failing on a 5.8u riser that happens to sit inside the Kissing Camels corridor. If
       this assertion counted that too it would report a pre-existing terrain bug as a
       collider regression every time, which is the fastest way to teach someone to ignore
       a red line. So a station stopped by ground the player could not have climbed anyway
       is excluded by name, and only a stop the collider caused is a failure here. */
    check('the colliders never wall off a trail', (() => {
      const G = getGraph(), pl = getTrailPlayer();
      const held = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy };
      const limit = getContourStep() * getVertScale() * 1.05;
      let crossed = 0, byCollider = 0, byTerrain = 0;
      for (const s of solids) {
        for (const e of G.edges) {
          const p = e.prof && e.prof.pts ? e.prof.pts : e.pts;
          for (let i = 0; i < p.length - 1; i++) {
            if (!pointInArea(p[i][0], p[i][1], s.area)) continue;
            const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1];
            const L = Math.hypot(dx, dz) || 1;
            const x0 = p[i][0], z0 = p[i][1];
            const tx = x0 + dx / L * 0.2, tz = z0 + dz / L * 0.2;
            pl.x = x0; pl.z = z0; pl.y = 0; pl.vy = 0;
            movePlayer(dx / L * 0.2, dz / L * 0.2);
            crossed++;
            if (Math.hypot(pl.x - x0, pl.z - z0) >= 0.1) continue;
            // stopped. Would the ground alone have stopped it, collider or no collider?
            if (Math.abs(standingY(tx, tz) - standingY(x0, z0)) > limit) byTerrain++;
            else byCollider++;
          }
        }
      }
      Object.assign(pl, held);
      __solidNote = `${crossed} trail stations inside a solid area, ${byCollider} walled by a collider` +
                    (byTerrain ? `, ${byTerrain} already impassable terrain` : '');
      return byCollider === 0;
    })(), () => __solidNote);

    /* Standing ON a rock, not stuck IN one. Reported as getting stuck inside a formation,
       and the fix was to stop answering "is this blocked" and start answering "how high is
       the ground here" -- so that is what gets asserted, at the level the player
       experiences it: the surface under a point inside a footprint has to be the top of
       the mesh they can see, and it has to be above the terrain it stands on. If this ever
       returns raw terrain again, the pup is back inside the boulder. */
    check('the ground inside a rock or building is its top, not the terrain under it', (() => {
      let tested = 0, wrong = 0, tallest = 0;
      for (const s of solids) {
        if (s.top == null) continue;
        const bb = s.bb;
        for (let i = 1; i < 18 && tested < 300; i++) for (let j = 1; j < 18; j++) {
          const x = bb.mnx + bb.w * i / 18, z = bb.mnz + bb.h * j / 18;
          if (!pointInArea(x, z, s.area)) continue;
          const nt = nearestTrail(x, z);
          if (nt.d <= nt.hw) continue;                  // the tread wins; asserted above
          tested++;
          const top = areaSolidTop(x, z);
          if (top == null || Math.abs(top - s.top) > 1e-6) { wrong++; continue; }
          const rel = top - standingY(x, z);
          if (rel <= 0) { wrong++; continue; }           // a solid you cannot stand on
          /* THROUGH THE PLAYER'S OWN GROUND FUNCTION, not just world.js's query. The
             first version of this check called areaSolidTop directly and therefore passed
             with main.js's playerGroundY stubbed back to plain standingY -- it proved the
             surface existed while proving nothing about the pup ever standing on it, which
             is the entire bug. Asserting the function movement and the avatar actually
             read is what closes that. */
          if (Math.abs(playerGroundY(x, z) - top) > 1e-6) wrong++;
          if (rel > tallest) tallest = rel;
        }
      }
      __topNote = `${tested} interior samples, ${wrong} not standing on the mesh top, tallest ${tallest.toFixed(1)}u above terrain`;
      return tested > 20 && wrong === 0;
    })(), () => __topNote);

    /* And the top has to be reachable, or "stand on top of it" is a promise the game does
       not keep. Asserted as a property of the CLAMBER rule rather than by driving a jump,
       because what matters is the guarantee: every solid whose top is within MOUNT_REACH
       can be mounted, and the terrain rules are untouched (raw terrain is never eligible,
       which is what keeps the cliff-walking bug fixed). */
    check('most rocks and every building can actually be climbed', (() => {
      let reachable = 0, walls = 0;
      for (const s of solids) {
        if (s.top == null) continue;
        const bb = s.bb;
        let base = null;
        for (let i = 1; i < 18 && base == null; i++) for (let j = 1; j < 18; j++) {
          const x = bb.mnx + bb.w * i / 18, z = bb.mnz + bb.h * j / 18;
          if (pointInArea(x, z, s.area)) { base = standingY(x, z); break; }
        }
        if (base == null) continue;
        if (s.top - base <= mountReach()) reachable++; else walls++;
      }
      __climbNote = `${reachable} climbable, ${walls} too tall to mount`;
      return reachable > 0;
    })(), () => __climbNote);

    /* ---- wall jumping ----------------------------------------------------------
       Replaces a hold-to-ascend climb, which asked nothing of the player but patience.
       Driven through the real functions and, where it matters, the real frame loop -- both
       bugs that shipped in the climb were invisible to tests that called the mechanic
       directly: the trigger was unreachable from half the compass while every test passed,
       and the frame that ran the climb returned before renderer.render. */
    const findWall = () => {
      for (const s of solids) {
        if (s.top == null) continue;
        const bb = s.bb;
        for (const ring of s.area.rings) {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            const f = nearestSolidFace((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 3);
            if (!f) continue;
            const base = standingY(f.x + f.ox * 0.55, f.z + f.oz * 0.55);
            if (f.top - base > stepUpLimit() + 1) return { f, base, h: f.top - base, area: s.area };
          }
        }
      }
      return null;
    };
    const wall = findWall();
    check('there is a wall to test against', !!wall, wall ? `${wall.h.toFixed(1)}u face` : 'none');

    if (wall) {
      const pl = getTrailPlayer();
      const parked = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy, wall: pl.wall, regrabT: pl.regrabT };
      /* `lift` is height UP THE FACE, measured from the face's own base -- not player.y,
         which is height above whatever is underfoot and drifts from the face datum as soon
         as the terrain beside a formation slopes. tryWallCatch has a minimum catch height
         measured from the same base, so a test that set player.y directly was asking a
         different question than the rule answers and failed on sloping ground. */
      const atFace = (lift) => {
        pl.wall = null; pl.regrabT = 0;
        pl.x = wall.f.x + wall.f.ox * 1.1; pl.z = wall.f.z + wall.f.oz * 1.1;
        pl.y = Math.max(0, (wall.base + lift) - standingY(pl.x, pl.z));
        pl.vy = 4;
      };

      check('you cannot catch a wall while standing on the ground', (() => {
        atFace(0); pl.y = 0; pl.vy = 0;
        const got = tryWallCatch(-wall.f.ox, -wall.f.oz);
        pl.wall = null;
        return !got;
      })());

      check('jumping at a face in mid-air catches it', (() => {
        atFace(2.0);
        const got = tryWallCatch(-wall.f.ox, -wall.f.oz);
        const stuck = got && !!pl.wall;
        __catchNote = stuck ? `caught at ${pl.y.toFixed(2)}u` : 'no catch';
        pl.wall = null;
        return stuck;
      })());

      check('leaping ALONGSIDE a face does not catch it', (() => {
        atFace(2.0);
        const got = tryWallCatch(-wall.f.oz, wall.f.ox);   // tangent, not into the rock
        pl.wall = null;
        return !got;
      })());

      /* The mechanic: each push-off has to gain height, and a chain of them has to reach
         the top. If a wall jump did not gain, the rock would be unclimbable; if one jump
         cleared everything, there would be no skill in it. */
      check('a chain of wall jumps climbs the rock, and one jump does not', (() => {
        // start at the LOWEST legal catch, the way a player starting from the ground does;
        // beginning halfway up let a single jump top out and the test stopped meaning
        // anything about chaining
        atFace(1.1);
        if (!tryWallCatch(-wall.f.ox, -wall.f.oz)) return false;
        const first = pl.y;
        wallJump();
        const oneJumpPeak = first + (pl.vy * pl.vy) / (2 * 26);
        // now chain: fall, re-catch, push off again
        let jumps = 1, topped = false, best = first;
        for (let f = 0; f < 1200 && !topped; f++) {
          const dt = 1 / 60;
          if (pl.regrabT > 0) pl.regrabT = Math.max(0, pl.regrabT - dt);
          if (pl.wall) {
            updateWall(dt);
            if (!pl.wall) {
              /* Topping out sets player.y to 0 because the pup is now STANDING on the
                 rock -- so "y is zero" cannot mean "fell off" here. Ask the ground instead:
                 on the summit, playerGroundY is the rock's top. The first version of this
                 test read the zero as a fall and reported a successful climb as stopping
                 87% of the way up. */
              topped = Math.abs(playerGroundY(pl.x, pl.z) - wall.f.top) < 0.5;
              break;
            }
            best = Math.max(best, pl.y);
            wallJump(); jumps++;
          } else {
            pl.vy -= 26 * dt; pl.y = Math.max(0, pl.y + pl.vy * dt);
            if (pl.y <= 0 && pl.vy < 0) break;                 // landed: chain broken
            tryWallCatch(-wall.f.ox, -wall.f.oz);
          }
        }
        const reached = best + wall.base;
        __chainNote = `${jumps} wall jumps, reached ${best.toFixed(1)}u of a ${wall.h.toFixed(1)}u face` +
                      (topped ? ' -- topped out' : ' -- did NOT top out');
        pl.wall = null;
        /* Both halves matter. A chain has to REACH THE TOP or the rock is decoration, and a
           single jump must not, or there is no skill in it and we are back to a button that
           teleports you upward. */
        /* Two properties, and no arbitrary jump count beyond them: a single push-off must
           not clear the face (or there is no skill in it) and a chain must reach the top
           (or the rock is decoration). How many jumps that takes is a property of the
           formation's height, not of the mechanic. */
        return topped && jumps >= 2 && oneJumpPeak - first < wall.h;
      })(), () => __chainNote);

      check('clinging slides you down, so dithering costs height', (() => {
        atFace(3.4);
        if (!tryWallCatch(-wall.f.ox, -wall.f.oz)) return false;
        const y0 = pl.y;
        for (let f = 0; f < 30; f++) updateWall(1 / 60);
        const slid = pl.wall ? y0 - pl.y : y0;
        pl.wall = null;
        __slideNote = `slid ${slid.toFixed(2)}u in half a second`;
        return slid > 0.05;
      })(), () => __slideNote);

      check('you cannot hang on a wall forever', (() => {
        atFace(3.4);
        if (!tryWallCatch(-wall.f.ox, -wall.f.oz)) return false;
        let f = 0;
        for (; f < 900 && pl.wall; f++) updateWall(1 / 60);
        pl.wall = null;
        __hangNote = `let go after ${(f / 60).toFixed(1)}s`;
        return f < 900;
      })(), () => __hangNote);

      check('the pup hangs on the OUTSIDE of the rock', (() => {
        atFace(2.0);
        if (!tryWallCatch(-wall.f.ox, -wall.f.oz)) return false;
        let inside = 0, n = 0;
        for (let f = 0; f < 60 && pl.wall; f++) {
          updateWall(1 / 60);
          if (!pl.wall) break;
          n++;
          if (pointInArea(pl.x, pl.z, wall.area)) inside++;
        }
        pl.wall = null;
        __outsideNote = `${n} frames clinging, ${inside} inside the footprint`;
        return n > 10 && inside === 0;
      })(), () => __outsideNote);

      /* THE ORIENTATION. Reported with a screenshot: the pup stuck out of the rock
         nose-first, lying horizontally like a shelf bracket, because the wall reused the
         kerb-scramble pose -- a ~26 degree tip that is right for hopping a terrace riser
         and wrong for hanging off a wall. Asserted at the RIG, through syncAvatar, because
         the pose is only correct if it survives the whole path from player state to
         bodyG.rotation: checking wallPose's return value alone would have passed on the
         very screenshot that prompted this. */
      check('the pup hangs vertically on a wall, not horizontally', (() => {
        atFace(2.0);
        if (!tryWallCatch(-wall.f.ox, -wall.f.oz)) return false;
        /* Several frames, not one: the drivers EASE between poses, so a single frame after
           catching still has most of the previous leap blended in. Twenty frames is a third
           of a second -- long enough for the blend to settle, short enough that a pose which
           never actually arrives will still be caught. */
        for (let f = 0; f < 20; f++) {
          updateWall(1 / 60);
          if (!pl.wall) break;
          syncAvatar(1 / 60, f * 16, pl.y, 0, false, false, false);
        }
        const pitch = dogBodyPitch();
        pl.wall = null;
        __poseNote = pitch == null ? 'no rig to read'
                   : `body pitched ${(pitch * 180 / Math.PI).toFixed(0)} degrees`;
        // upright-ish: well past the ~26 degree scramble tip, and nose UP not down
        return pitch != null && pitch > 1.0;
      })(), () => __poseNote);

      /* LEGS OUT OF THE ROCK, NOT INTO IT. Reported as the dog positioned backwards with
         its legs sticking through the formation. Pitched ~76 degrees nose-up the legs swing
         to the body's backward axis, so which way the pup FACES decides which side its paws
         end up on -- facing away from the rock buries them in it. Measured as the dot of
         forward against the outward normal: it was +1 (facing away), it must be negative. */
      check('the pup faces the rock so its legs stay outside it', (() => {
        atFace(2.0);
        if (!tryWallCatch(-wall.f.ox, -wall.f.oz)) return false;
        updateWall(1 / 60);
        const fx = Math.cos(pl.yaw), fz = -Math.sin(pl.yaw);
        const dotOut = fx * wall.f.ox + fz * wall.f.oz;
        pl.wall = null;
        __faceNote = `forward vs outward normal ${dotOut.toFixed(2)}`;
        return dotOut < -0.7;
      })(), () => __faceNote);

      /* WALKING INTO A ROCK. areaSolidTop used to exempt trail corridors so a collider
         could not fence off a route -- which meant that along the ~5 m of trail running
         through Kissing Camels the rock simply was not there, and the pup walked 1.66 units
         into the mass and vanished. Asserted by walking at every face on the map. */
      check('you cannot walk into a rock formation at all', (() => {
        const parkedW = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy, wall: pl.wall };
        let worst = 0, where = '';
        for (const s of solids) {
          if (s.top == null) continue;
          for (const ring of s.area.rings) {
            for (let i = 0; i < ring.length; i++) {
              const a = ring[i], b = ring[(i + 1) % ring.length];
              const f = nearestSolidFace((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 3);
              if (!f) continue;
              pl.x = f.x + f.ox * 2.5; pl.z = f.z + f.oz * 2.5;
              pl.y = 0; pl.vy = 0; pl.wall = null;
              for (let k = 0; k < 60; k++) movePlayer(-f.ox * 0.08, -f.oz * 0.08);
              if (!pointInArea(pl.x, pl.z, s.area)) continue;
              // standing ON the slab is fine; being inside it below the top is not
              if (playerGroundY(pl.x, pl.z) + pl.y >= s.top - 0.3) continue;
              const d = distToSolid(pl.x, pl.z, s.area).d;
              if (d > worst) { worst = d; where = s.kind; }
            }
          }
        }
        Object.assign(pl, parkedW);
        __walkInNote = worst > 0 ? `${worst.toFixed(2)}u inside a ${where}` : 'never got inside one';
        return worst < 0.3;
      })(), () => __walkInNote);

      /* JUMPING BESIDE A ROCK. Catching had no minimum height, so a jump taken while stood
         against a formation grabbed the face at ankle height -- and a cling that low slides
         to the ground within a few frames and lets go, swallowing the jump. The pup ended
         up pinned to the bottom edge, unable to leave the floor. */
      check('jumping next to a rock is not swallowed by the wall', (() => {
        const parkedJ = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy, wall: pl.wall, regrabT: pl.regrabT };
        pl.x = wall.f.x + wall.f.ox * 1.0; pl.z = wall.f.z + wall.f.oz * 1.0;
        pl.y = 0; pl.vy = 0; pl.wall = null; pl.regrabT = 0;
        pl.yaw = Math.atan2(wall.f.oz, -wall.f.ox);
        trailJump();
        let peak = 0;
        for (let f = 0; f < 40; f++) {
          const dt = 1 / 60;
          if (pl.wall) { updateWall(dt); } else {
            pl.vy -= 26 * dt; pl.y = Math.max(0, pl.y + pl.vy * dt);
            tryWallCatch(-wall.f.ox, -wall.f.oz);
          }
          peak = Math.max(peak, pl.y);
        }
        const stuck = peak < 0.5;
        pl.wall = null;
        Object.assign(pl, parkedJ);
        __jumpNote = `jump reached ${peak.toFixed(2)}u beside the face`;
        return !stuck;
      })(), () => __jumpNote);

      /* THE BOUNDS MUST MATCH WHAT IS DRAWN. Reported with two screenshots: a pup clinging
         with its body sunk into the rock, and a pup with only its head out of a wall. The
         cause was not the standoff but the outline it was measured from -- ExtrudeGeometry's
         bevel pushes a landform's surface up to 0.75 units past its polygon, and every
         collision test used the bare polygon. So the pup stood the correct distance from a
         boundary that was not where the rock actually was.

         Asserted against the INFLATED outline, which is the drawn surface. Testing against
         the polygon is what let this ship: by that measure the pup was correctly outside
         the whole time. */
      check('a clinging pup is clear of the DRAWN rock, not just the polygon', (() => {
        const parkedB = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy, wall: pl.wall };
        let worst = Infinity, n = 0;
        for (const s of solids) {
          if (s.top == null) continue;
          /* The skirt is recomputed HERE from the geometry's own formula rather than read
             off s.inflate, and that is deliberate. The first version of this check used
             s.inflate -- the very number the fix writes -- so reverting the fix set it to
             zero and the assertion happily passed, measuring the pup against the same bare
             polygon that caused the bug. A test that sources its expectation from the code
             under test cannot fail. This mirrors pieces.js's buildLandform: bevel is
             min(1, min(w,h)*0.1) and the surface is pushed out by bevelSize = bevel*0.75. */
          const bevel = s.kind === 'building' ? 0 : Math.min(1.0, Math.min(s.bb.w, s.bb.h) * 0.1);
          const inf = bevel * 0.75;
          for (const ring of s.area.rings) {
            for (let i = 0; i < ring.length; i++) {
              const a = ring[i], b = ring[(i + 1) % ring.length];
              const f = nearestSolidFace((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 3);
              if (!f) continue;
              const base = standingY(f.x + f.ox * 0.55, f.z + f.oz * 0.55);
              if (f.top - base <= stepUpLimit() + 1) continue;
              pl.wall = null; pl.regrabT = 0;
              pl.x = f.x + f.ox * 1.1; pl.z = f.z + f.oz * 1.1;
              pl.y = Math.max(0, (base + 2.0) - standingY(pl.x, pl.z));
              pl.vy = 4;
              if (!tryWallCatch(-f.ox, -f.oz)) continue;
              updateWall(1 / 60);
              if (!pl.wall) continue;
              n++;
              /* Clearance from the drawn surface: distance to the polygon, minus the
                 bevel skirt, negative when the pup is inside the stone. */
              const info = distToSolid(pl.x, pl.z, s.area);
              const clear = (info.inside ? -info.d : info.d) - inf;
              if (clear < worst) worst = clear;
            }
          }
        }
        pl.wall = null;
        Object.assign(pl, parkedB);
        __boundsNote = n ? `${n} faces tested, tightest clearance ${worst.toFixed(2)}u from the drawn surface`
                         : 'no faces caught';
        return n > 5 && worst > 0.05;
      })(), () => __boundsNote);

      /* THE FROZEN SCREEN, kept from the climb version because the failure mode belongs to
         the frame loop and not to any particular mechanic: an early return past
         renderer.render stops the picture while the game runs on underneath. */
      check('the frame still renders while the pup is on a wall', (() => {
        atFace(2.0);
        if (!tryWallCatch(-wall.f.ox, -wall.f.oz)) { Object.assign(pl, parked); return false; }
        const before = stats.renders;
        let pumped = 0;
        for (let f = 0; f < 20; f++) {
          if (!global.__raf) break;
          const fn = global.__raf; global.__raf = null;
          fn(30000 + f * 16);
          pumped++;
        }
        const drew = stats.renders - before;
        pl.wall = null;
        __frameNote = `${pumped} frames pumped on a wall, ${drew} rendered`;
        return pumped > 5 && drew === pumped;
      })(), () => __frameNote);

      Object.assign(pl, parked);
    }
  }

  /* ---- you have to be able to SEE it ------------------------------------------
     Watching was banked on distance alone, so a deer twelve metres away on the far side
     of a brow filled the meter while the screen showed you a slope. Watching is the one
     mechanic whose entire subject is looking at something, so a sighting you could not
     have witnessed is the worst thing it could award. */
  {
    check('line of sight is blocked by ground that stands between you', (() => {
      const W = getWorld();
      if (!W) return false;
      let clearShort = 0, blockedFound = 0, tried = 0;
      const bb = getBBox();
      for (let i = 0; i < 400 && blockedFound < 1; i++) {
        const ax = bb.minx + Math.random() * (bb.maxx - bb.minx);
        const az = bb.minz + Math.random() * (bb.maxz - bb.minz);
        const ang = Math.random() * Math.PI * 2, L = 12 + Math.random() * 25;
        const bx = ax + Math.cos(ang) * L, bz = az + Math.sin(ang) * L;
        tried++;
        if (!lineOfSight(ax, az, bx, bz, 1.4, 0.9)) blockedFound++;
      }
      // and a point can always see itself, whatever the terrain is doing
      for (let i = 0; i < 30; i++) {
        const ax = bb.minx + Math.random() * (bb.maxx - bb.minx);
        const az = bb.minz + Math.random() * (bb.maxz - bb.minz);
        if (lineOfSight(ax, az, ax + 0.2, az + 0.2, 1.4, 0.9)) clearShort++;
      }
      __losNote = `${blockedFound} blocked sightline(s) in ${tried} tries, ${clearShort}/30 self-views clear`;
      // on real terrain SOMETHING has to occlude, or the check is not doing anything
      return blockedFound > 0 && clearShort === 30;
    })(), () => __losNote);

    check('a sighting cannot be banked through a hillside', (() => {
      resetCritters();
      spawnCritters(5150);
      const pl = getTrailPlayer();
      const held = { x: pl.x, z: pl.z };
      const c = getCritters()[0];
      // park the player just inside the notice radius but behind whatever is in the way
      let blocked = null;
      for (let a = 0; a < 32 && !blocked; a++) {
        const th = a / 32 * Math.PI * 2, d = spookRadiusFor(c.key) * 1.6;
        const x = c.x + Math.cos(th) * d, z = c.z + Math.sin(th) * d;
        if (!lineOfSight(x, z, c.x, c.z, 1.4, 0.9)) blocked = { x, z };
      }
      if (!blocked) { resetCritters(); Object.assign(pl, held); __seeNote = 'no occluded angle on this map'; return true; }
      pl.x = blocked.x; pl.z = blocked.z;
      c.sighted = false; c.watchT = 0;
      for (let f = 0; f < 400; f++) updateCritters(1 / 60, f * 16, pl.x, pl.z, 0, 6, true, false, 1);
      const bankedBlind = c.sighted;
      resetCritters();
      Object.assign(pl, held);
      __seeNote = bankedBlind ? 'banked a sighting through solid ground' : 'meter held while out of sight';
      return !bankedBlind;
    })(), () => __seeNote);
  }

  /* ---- wildlife stays put while you are looking at it -------------------------
     Chasing something made it blink out at the seven-second mark and reappear elsewhere,
     because the recycle fired on a timer with no reference to where the player was. The
     recycle still exists (a map that never re-seeds slowly empties as everything flees to
     the edges), so this asserts the GATE rather than its absence: nothing is removed while
     it is close enough to watch. Driven through the real update loop with the player
     pinned to the animal, which is exactly the situation that produced the report. */
  {
    resetCritters();
    spawnCritters(31337);
    const pl = getTrailPlayer();
    const held = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy };
    const c = getCritters()[0];
    const startKey = c.key;
    let jumped = 0, maxHop = 0;
    // 12 seconds of chase, well past the 7s recycle timer, staying right on top of it
    for (let f = 0; f < 720; f++) {
      const bx = c.x, bz = c.z;
      pl.x = c.x + 2; pl.z = c.z;
      updateCritters(1 / 60, f * 16, pl.x, pl.z, 5, 6, false, false, 0);
      const hop = Math.hypot(c.x - bx, c.z - bz);
      if (hop > maxHop) maxHop = hop;
      if (hop > 12) jumped++;          // a frame-to-frame move no animal could run
    }
    Object.assign(pl, held);
    check('an animal you are chasing never blinks out and respawns elsewhere',
      jumped === 0 && c.key === startKey,
      `${jumped} teleports in 12s of chase, biggest single-frame move ${maxHop.toFixed(2)}u`);
    resetCritters();
  }

  /* ---- catching a small animal ------------------------------------------------
     The mechanic IS the two rings, so that is what gets asserted: not "catch works" but
     the ordering that makes it legible. Sneaking and settling has to put the noise ring
     inside the reach ring; anything else has to leave it outside. If that ordering ever
     inverts, the ring the player is reading stops predicting what the animals do, which
     is the failure that matters. */
  {
    const ref = 6, reach = catchRadius(), typ = typicalSpookRadius();
    const ringAt = (sp, sneak, still) => typ * playerNoise(sp, ref, sneak, false, still);

    /* THE ORDERING THAT MAKES A CATCH POSSIBLE AT ALL, asserted per species.

       This replaces a pair of checks written against the roster MEAN, and the mean is
       precisely what was broken: reach came from typicalSpookRadius() while whether a
       given animal bolts comes from its own radius. On the default meadow roster that gap
       made the window empty -- a rabbit ran at 4.05 m and could not be grabbed until
       3.73 m -- so nothing on the map could be caught and the old assertions passed
       throughout, because they only ever compared averages to averages.

       The contract now, for every catchable species: reach sits ABOVE the moving-sneak
       bolt radius (so you can close in while sneaking) and BELOW the moving-walk one (so
       walking still fails). Both sides scale with the same R, so this holds at any
       bravery on any roster -- which is the property the mean could not give. */
    check('every catchable animal can actually be reached by sneaking', (() => {
      const keys = ['rabbit', 'squirrel', 'chipmunk', 'fox', 'bobcat', 'raccoon', 'possum', 'cat'];
      const bad = [];
      for (const k of keys) {
        const R = spookRadiusFor(k);
        const r = catchRadiusFor(k);
        const boltSneak = R * playerNoise(3, ref, true, false, 0);
        const boltWalk = R * playerNoise(3, ref, false, false, 0);
        if (!(r > boltSneak)) bad.push(`${k} unreachable (reach ${r.toFixed(1)} <= sneak bolt ${boltSneak.toFixed(1)})`);
        if (!(r < boltWalk)) bad.push(`${k} catchable at a walk`);
      }
      __reachNote = bad.length ? bad.join('; ')
        : `${keys.length} species, reach between the sneak and walk bolt radii for each`;
      return bad.length === 0;
    })(), () => __reachNote);
    check('a settled sneak pulls the noise ring inside the reach ring',
      ringAt(0, true, 1) < reach,
      `settled sneak ${ringAt(0, true, 1).toFixed(2)}m vs ${reach.toFixed(2)}m reach`);
    check('walking normally still scares everything off before you arrive', (() => {
      const R = spookRadiusFor('rabbit');
      return R * playerNoise(3, ref, false, false, 0) > catchRadiusFor('rabbit');
    })());
    check('holding still is what shrinks the ring, not just being slow',
      ringAt(0, true, 1) < ringAt(0, true, 0) * 0.9,
      `${ringAt(0, true, 0).toFixed(2)}m unsettled -> ${ringAt(0, true, 1).toFixed(2)}m settled`);
    /* The trim is the "let me get closer" ask, and it must NOT have moved the watch
       window -- that is the whole reason it lives on the multiplier and not on
       spookRadiusFor. Asserted as an inequality against the notice radius so a future
       tuning pass cannot quietly buy closeness by shortening the sighting window. */
    check('getting closer did not shrink the window a sighting is banked in',
      spookRadiusFor('rabbit') * 2.4 > ringAt(3, false, 0),
      `notice ${(spookRadiusFor('rabbit') * 2.4).toFixed(1)}m still wider than a walking ring`);

    /* THE WHOLE MECHANIC, END TO END, because the arithmetic checks above were all
       passing on the day nothing on the map could be caught. Sneak a pup at a rabbit the
       way a player would -- creep, stop, let the noise settle, jump -- and assert a catch
       comes out. If this fails the feature does not work, whatever the radii say. */
    check('a player can sneak up on a rabbit and catch it', (() => {
      resetCritters();
      spawnCritters(2024);
      const pl = getTrailPlayer();
      const held = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy, sneaking: pl.sneaking, speed: pl.speed, stillT: pl.stillT };
      const target = getCritters().find(c => isCatchable(c.key));
      if (!target) { Object.assign(pl, held); return false; }

      // start outside its notice radius, on the far side, and creep straight in
      const R = spookRadiusFor(target.key);
      const ang = Math.atan2(pl.z - target.z, pl.x - target.x);
      pl.x = target.x + Math.cos(ang) * R * 2.6;
      pl.z = target.z + Math.sin(ang) * R * 2.6;
      pl.y = 0; pl.vy = 0; pl.sneaking = true;

      let caught = null, frames = 0;
      const dt = 1 / 60;
      while (!caught && frames < 1500) {
        frames++;
        const d = Math.hypot(target.x - pl.x, target.z - pl.z);
        const reach = catchRadiusFor(target.key);
        /* Creep only until the ring would light up, then STOP. Deliberately reach*0.95
           and not something comfortably inside it: while you are moving, the band between
           "in reach" (R*0.36) and "it bolts" (R*0.289) is only about a metre wide, so
           creeping on past the moment the ring turns solid walks straight through the far
           side of it. That is the actual skill the mechanic asks for, and the first
           version of this test failed precisely by not doing it -- which is a fair
           description of what a player who ignores the ring will experience. */
        const closing = d > reach * 0.95;
        if (closing) {
          const a = Math.atan2(target.z - pl.z, target.x - pl.x);
          const step = 1.6 * dt;                       // a sneaking pace
          pl.x += Math.cos(a) * step; pl.z += Math.sin(a) * step;
          pl.speed = 1.6;
          pl.stillT = Math.max(0, pl.stillT - dt * (1.4 / 1.1));
        } else {
          pl.speed = 0;
          pl.stillT += dt;
        }
        updateCritters(dt, frames * 16, pl.x, pl.z, pl.speed, ref, true, false,
                       Math.min(1, pl.stillT / 1.4));
        if (target.state === 'flee') break;            // blew it
        if (!closing) caught = catchNear(pl.x, pl.z);  // jump, once settled and in reach
      }
      if (caught) releaseCarried(pl.x, pl.z, pl.yaw);
      resetCritters();
      Object.assign(pl, held);
      __sneakNote = caught ? `caught a ${caught.S.nm} after ${(frames / 60).toFixed(1)}s`
                           : `no catch in ${(frames / 60).toFixed(1)}s (it fled)`;
      return !!caught;
    })(), () => __sneakNote);

    check('only small animals can be caught', (() => {
      const small = ['rabbit', 'squirrel', 'chipmunk', 'fox', 'bobcat'];
      const big = ['deer', 'bear', 'moose', 'bighorn', 'goat'];
      return small.every(k => isCatchable(k)) && big.every(k => !isCatchable(k));
    })());

    /* Reported: a static blue-grey ring sitting on the ground for the whole walk with
       nothing nearby to explain it. The ring's RADIUS never moved (that is deliberate --
       see the header comment on updateCatchRing), which is exactly what makes an
       always-visible one read as a leftover rather than a readout. Asserted as two states
       of the same scene rather than by reading a colour, since a colour check would pass
       on the very bug being fixed: dim-but-visible still renders. */
    /* Reported twice, and the second report is the one this now defends. First the ring
       was always visible around the pup ("a static blue ring that seems unnecessary");
       gating it on having a target fixed the clutter but left it centred on the player,
       which asks the player to judge whether a moving animal has entered a circle attached
       to themselves. It is now drawn around the ANIMAL, so the assertion is about WHERE it
       is as much as whether it is up. A colour check would not do -- the old bug rendered
       perfectly, just in the wrong place. */
    check('the reach ring is hidden with nothing near, and drawn on the animal when there is', (() => {
      const pl = getTrailPlayer();
      const held = { x: pl.x, z: pl.z };
      resetCritters();
      // nothing on the map at all -- resetCritters just cleared it
      let near = nearestCatchable(pl.x, pl.z, catchRadius() * 2.6);
      updateCatchRing(0.016, pl.x, pl.z, catchRadius(), standingY, !!near, false);
      const hiddenIdle = !getCatchRing().visible;

      spawnCritters(777);
      const target = getCritters().find(c => isCatchable(c.key));
      if (!target) { Object.assign(pl, held); return false; }
      // stand a stride outside arm's length: the ring should be up, and centred on IT
      pl.x = target.x + catchRadius() * 1.4; pl.z = target.z;
      near = nearestCatchable(pl.x, pl.z, catchRadius() * 2.6);
      updateCatchRing(0.016, near ? near.critter.x : pl.x, near ? near.critter.z : pl.z,
                      catchRadius(), standingY, !!near, !!(near && near.inReach));
      const shown = getCatchRing().visible;
      // the band's own vertices say where it was actually drawn, not where we asked
      const pos = getCatchRing().geometry.attributes.position.array;
      let cx = 0, cz = 0;
      const n = pos.length / 3;
      for (let i = 0; i < n; i++) { cx += pos[i * 3]; cz += pos[i * 3 + 2]; }
      cx /= n; cz /= n;
      const onAnimal = Math.hypot(cx - target.x, cz - target.z) < 0.5;
      const notOnPlayer = Math.hypot(cx - pl.x, cz - pl.z) > catchRadius() * 0.5;
      const approaching = near && !near.inReach;   // outside arm's length, so dim not armed

      resetCritters();
      Object.assign(pl, held);
      __ringNote = `idle=${hiddenIdle ? 'hidden' : 'VISIBLE'}, ` +
                   `centre ${Math.hypot(cx - target.x, cz - target.z).toFixed(2)}m from the animal`;
      return hiddenIdle && shown && onAnimal && notOnPlayer && approaching;
    })(), () => __ringNote);

    check('jumping beside a small animal picks it up, and jumping again puts it down', (() => {
      resetCritters();
      spawnCritters(4242);
      const pl = getTrailPlayer();
      /* Put the pup back afterwards. These tests teleport it next to a randomly placed
         critter, and everything downstream -- the trailhead summary, the bark, the
         mid-walk rebuild -- reads where the player is standing. Leaving it parked beside
         a random animal made three later assertions pass or fail depending on the spawn
         seed, which is worse than a failing test because it looks like a flake. */
      const held = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy };
      const target = getCritters().find(c => isCatchable(c.key));
      if (!target) { Object.assign(pl, held); return false; }
      // stand within reach, facing it
      pl.x = target.x + 1.2; pl.z = target.z;
      const free = currentTopSpeed() * carrySlow();
      const got = catchNear(pl.x, pl.z);
      if (!got || getCarried() !== got) return false;
      const laden = currentTopSpeed() * carrySlow();
      if (!(laden < free)) return false;
      if (!(getCritterStats().caught === 1)) return false;
      // and it rides: the anchor is pushed from syncAvatar, so drive one
      syncAvatar(0.016, 0, 0, 0, false, false, false);
      updateCritters(0.016, 0, pl.x, pl.z, 0, 6, false, false, 1);
      const onBack = Math.hypot(got.g.position.x - pl.x, got.g.position.z - pl.z) < 2 &&
                     got.g.position.y > standingY(pl.x, pl.z);
      releaseCarried(pl.x, pl.z, pl.yaw);
      Object.assign(pl, held);
      __carryNote = `carried at ${(laden / free).toFixed(2)}x speed, rode ${onBack ? 'on the back' : 'OFF the back'}`;
      return onBack && getCarried() === null && got.state === 'flee';
    })(), () => __carryNote);

    /* Letting one go is not the same as blundering into one. If these ever share a
       counter the scorecard can no longer tell a careful walk from a clumsy one, which is
       the entire reason sightings and spooks are two numbers instead of one. */
    check('releasing a caught animal is not counted as spooking it', (() => {
      resetCritters();
      spawnCritters(99);
      const pl = getTrailPlayer();
      const held = { x: pl.x, z: pl.z, y: pl.y, vy: pl.vy };
      const target = getCritters().find(c => isCatchable(c.key));
      if (!target) { Object.assign(pl, held); return false; }
      pl.x = target.x + 1.2; pl.z = target.z;
      if (!catchNear(pl.x, pl.z)) { Object.assign(pl, held); return false; }
      const before = getCritterStats().spooked;
      releaseCarried(pl.x, pl.z, pl.yaw);
      Object.assign(pl, held);
      return getCritterStats().spooked === before;
    })());
    resetCritters();
  }

  /* ---- crossings built as infrastructure -------------------------------------- */
  {
    let __stuckNote = '', __postNote = '', __overlapNote = '', __uncutNote = '';
    const xs = getCrossings();

  /* A crosswalk is not "a road and a trail touch here". It is "a trail continues on the
      far side of a road". The old rule could not tell the two apart and built 43 crossings
      on the default map of which 11 were real -- the rest were trails ending on the verge,
      trails whose endpoint splitT welded to a road they merely passed within 16 m of, and
      paths running ALONG the carriageway. Re-derived here from the geometry rather than
      read back off the record, so a regression in roadContact cannot pass by agreeing
      with itself. */
    check('a crosswalk is only built where a path continues on the far side', (() => {
      const G = getGraph();
      if (!xs.length) return false;
      for (const rec of xs) {
        const arms = (G.edges.filter(e => e.a === rec.node || e.b === rec.node));
        if (arms.filter(e => e.kind === 'road').length < 2) return false;   // road stops here
        const nxv = -rec.dir[1], nzv = rec.dir[0];
        let pos = 0, neg = 0;
        for (const e of arms) {
          if (e.kind === 'road' || e.buried) continue;
          const pts = e.a === rec.node ? e.pts : [...e.pts].reverse();
          let dx = 0, dz = 0;
          for (let i = 1; i < pts.length; i++) {
            dx = pts[i][0] - pts[0][0]; dz = pts[i][1] - pts[0][1];
            if (Math.hypot(dx, dz) > 1e-6) break;
          }
          const L = Math.hypot(dx, dz) || 1;
          if (Math.abs((dx / L) * rec.dir[0] + (dz / L) * rec.dir[1]) > 0.8) continue;  // runs along
          if ((dx / L) * nxv + (dz / L) * nzv >= 0) pos++; else neg++;
        }
        if (!pos || !neg) return false;
      }
      return true;
    })(), `${xs.length} crossings, all with arms on both sides`);

    /* Tightening the crossing rule would have been a regression on its own: the ribbon trim
      that keeps a dirt surface off the tarmac used to ride along on the crossing decision,
      so 32 nodes that stopped being crossings would have had 32 trail ribbons painted back
      onto the carriageway. planCrossings now trims at EVERY road contact and only builds
      furniture at the crossings, which is what this asserts. */
    check('every path meeting a road has its ribbon trimmed, crossing or not', (() => {
      const G = getGraph();
      let contacts = 0, trimmed = 0;
      for (let ni = 0; ni < G.nodes.length; ni++) {
        const arms = G.edges.filter(e => e.a === ni || e.b === ni);
        if (!arms.some(e => e.kind === 'road')) continue;
        for (const e of arms) {
          if (e.kind === 'road' || e.buried) continue;
          contacts++;
          const t = (e.a === ni) ? e.trimA : e.trimB;
          if (t > 0) trimmed++;
        }
      }
      return contacts > 0 && contacts === trimmed;
    })());

    /* THE displacement invariant. Not "how far did it move" -- that is a consequence and it
      changes with the world scale -- but "did it stay on the side it was surveyed on",
      which is the promise the pass makes and the only thing that would make a displaced
      map lie about the network. Measured against the anchors themselves: no drawable path
      may sit on the far side of a wider path from where its own recorded geometry put it.
      A path that genuinely CROSSES an anchor is allowed a different sign either side of
      the crossing, so this is asserted per vertex, not per edge. */
    check('displacement never moves a path to the wrong side of a wider one', (() => {
      const G = getGraph();
      let checked = 0, flipped = 0;
      for (const e of G.edges) {
        if (!e.displaced || !e.recorded) continue;
        const anchors = G.edges.filter(o => o !== e && pathRank(o.kind) < pathRank(e.kind));
        for (const p of e.pts) {
          // the recorded point this vertex came from
          let bq = null, bd = Infinity;
          for (let k = 0; k < e.recorded.length - 1; k++) {
            const r = ptSegSmoke(p, e.recorded[k], e.recorded[k + 1]);
            if (r.d < bd) { bd = r.d; bq = r.q; }
          }
          if (!bq) continue;
          let near = null, nd = Infinity;
          for (const o of anchors) {
            const pr = projOnLine(o.pts, bq[0], bq[1]);
            if (pr.d < nd) { nd = pr.d; near = { pr, o }; }
          }
          if (!near || nd > 12) continue;
          const sB = (bq[0] - near.pr.px) * (-near.pr.dir[1]) + (bq[1] - near.pr.pz) * near.pr.dir[0];
          if (Math.abs(sB) < 0.3) continue;            // no opinion of its own
          const pa = projOnLine(near.o.pts, p[0], p[1]);
          const sA = (p[0] - pa.px) * (-pa.dir[1]) + (p[1] - pa.pz) * pa.dir[0];
          checked++;
          if (Math.sign(sB) !== Math.sign(sA)) flipped++;
        }
      }
      return checked > 100 && flipped === 0;
    })());

    /* What the whole pass is for, stated as a number. Sampled every real metre so the
      answer means the same thing at any world scale, and with the stations near a shared
      node exempted -- edges meeting at a junction are SUPPOSED to converge there, and the
      junction pad is what covers that seam.

      Held at 1:5 (the default) rather than 1:1, because compaction is what makes this
      bite: before the pass the default map painted 929 real metres of path over another
      path's surface at 1:5, and 331 even at 1:1. */
    check('painted surfaces do not overlap each other', (() => {
      const back = getMapScale();
      setMapScale(0.2);
      const G = getGraph();
      const half = k => pathOutlineWidth(k) / 2;
      const drawn = G.edges.filter(e => !e.buried);
      const shares = (e, f) => e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b;
      let bad = 0;
      for (let i = 0; i < drawn.length; i++) {
        const e = drawn[i], need0 = half(e.kind);
        for (let j = i + 1; j < drawn.length; j++) {
          const f = drawn[j], need = need0 + half(f.kind);
          const ex = shares(e, f) ? Math.max(need * 1.6, 4) : 0;
          for (let k = 0; k < e.pts.length - 1; k++) {
            const a = e.pts[k], b = e.pts[k + 1];
            const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const n = Math.max(1, Math.ceil(L / 0.2));      // one real metre at 1:5
            for (let m = 0; m < n; m++) {
              const p = [a[0] + (b[0] - a[0]) * m / n, a[1] + (b[1] - a[1]) * m / n];
              if (ex) {
                let nearNode = false;
                for (const id of [e.a, e.b, f.a, f.b]) {
                  const nd = G.nodes[id];
                  if (Math.hypot(p[0] - nd.p[0], p[1] - nd.p[1]) < ex) { nearNode = true; break; }
                }
                if (nearNode) continue;
              }
              let best = Infinity;
              for (let q = 0; q < f.pts.length - 1; q++) {
                const r = ptSegSmoke(p, f.pts[q], f.pts[q + 1]);
                if (r.d < best) best = r.d;
              }
              if (best < need) bad++;
            }
          }
        }
      }
      __overlapNote = `${bad} real metres of path on another path's surface at 1:5`;
      setMapScale(back);
      return bad < 200;
    })(), () => __overlapNote);

    /* splitT drops any cut within `tol` of a line's end (applyCuts), which is usually
      harmless -- buildGraph's endpoint snap fuses those anyway -- but on the default map it
      left three real X crossings with no node at all: a road and a trail that geometrically
      intersect and, topologically, have never met. Those cannot be displaced apart (they
      genuinely cross) and cannot be crosswalked (there is no node to hang one on), so they
      paint straight over each other. Asserted separately from the displacement work because
      it is a topology bug, not a rendering one. */
    check('no two paths cross without a node where they meet', (() => {
      const G = getGraph();
      const shares = (e, f) => e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b;
      let uncut = 0;
      for (let i = 0; i < G.edges.length; i++) {
        for (let j = i + 1; j < G.edges.length; j++) {
          const e = G.edges[i], f = G.edges[j];
          if (shares(e, f)) continue;
          let hit = false;
          for (let a = 0; a < e.pts.length - 1 && !hit; a++)
            for (let b = 0; b < f.pts.length - 1 && !hit; b++)
              if (segCross(e.pts[a], e.pts[a + 1], f.pts[b], f.pts[b + 1])) hit = true;
          if (hit) uncut++;
        }
      }
      __uncutNote = `${uncut} pairs cross with no shared node`;
      return uncut === 0;
    })(), () => __uncutNote);



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
  for (const r of results) {
    // detail is sometimes a thunk, because a note is filled in by the assertion itself
    // and reading it eagerly at the call site captures the empty string it started as
    const d = typeof r.detail === 'function' ? r.detail() : r.detail;
    console.log(` ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${d ? '   (' + d + ')' : ''}`);
  }
  if (errors.length) console.log('\n runtime errors:\n  ' + errors.join('\n  '));
  console.log('-------------------------------------------');
  console.log(failed.length || errors.length
    ? `\n${failed.length} failed, ${errors.length} runtime error(s)`
    : `\nall ${results.length} checks passed`);
  process.exit(failed.length || errors.length ? 1 : 0);
}

/* Geometry helpers used by the displacement / overlap assertions above. They live here
   rather than inside assertAll because two separate blocks need them, and a function
   declaration at module scope hoists over both. Named ptSegSmoke, not ptSeg, because the
   bundle already puts a ptSeg in global scope and shadowing it here would make it
   ambiguous which one an assertion is measuring with. */
function ptSegSmoke(p, a, b){
  const dx = b[0]-a[0], dz = b[1]-a[1], L2 = dx*dx + dz*dz;
  let t = L2 === 0 ? 0 : ((p[0]-a[0])*dx + (p[1]-a[1])*dz)/L2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const q = [a[0] + t*dx, a[1] + t*dz];
  return {t, q, d: Math.hypot(p[0]-q[0], p[1]-q[1])};
}
function projOnLine(pts, x, z){
  let best = {d: Infinity, px: x, pz: z, dir: [1, 0]};
  for(let i = 0; i < pts.length-1; i++){
    const r = ptSegSmoke([x, z], pts[i], pts[i+1]);
    if(r.d < best.d){
      let dx = pts[i+1][0]-pts[i][0], dz = pts[i+1][1]-pts[i][1];
      const L = Math.hypot(dx, dz) || 1;
      best = {d: r.d, px: r.q[0], pz: r.q[1], dir: [dx/L, dz/L]};
    }
  }
  return best;
}
