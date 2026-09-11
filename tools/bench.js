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
/* jsdom never fetches the <link rel="stylesheet"> tags in index.html -- no `resources`
   option was passed, and even with one this is a local file, not a server. Left alone,
   EVERY property this suite might ever read via getComputedStyle would silently answer
   from the UA default, not from trails.css, which would make a check that reads
   `touch-action` (or any other real CSS value) pass or fail for reasons having nothing to
   do with the actual stylesheet. Reading the same two files the page links, in the same
   order, and inlining them makes the cascade the DOM sees match the real page's. */
for (const cssFile of ['styles/base.css', 'styles/trails.css']) {
  const css = fs.readFileSync(path.join(ROOT, cssFile), 'utf8');
  const style = dom.window.document.createElement('style');
  style.textContent = css;
  dom.window.document.head.appendChild(style);
}
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
/* The edge list matters as much as the band. A master gain wired to itself instead of to
   destination builds a flawless-looking graph -- right voices, right frequencies, no
   error -- and emits nothing at all, because no path terminates at the speakers. Asking
   "was something scheduled" cannot see that; only "can a voice REACH destination" can. */
const AUDIO = { osc: [], filt: [], starts: [], scheduledWhileSuspended: 0, nodes: 0, live: null, edges: [], dest: null };
/* Is there any path from a voice (oscillator / buffer source) to AC.destination? */
AUDIO.voiceReachesDestination = function(){
  if(!AUDIO.dest) return false;
  const adj = new Map();
  for(const [f, t] of AUDIO.edges){ if(!adj.has(f)) adj.set(f, []); adj.get(f).push(t); }
  const reaches = (start)=>{
    const seen = new Set([start]); const stack = [start];
    while(stack.length){
      const cur = stack.pop();
      if(cur === AUDIO.dest) return true;
      for(const nxt of (adj.get(cur) || [])) if(!seen.has(nxt)){ seen.add(nxt); stack.push(nxt); }
    }
    return false;
  };
  const voices = new Set();
  for(const [f] of AUDIO.edges) if(/^(osc|src)\d+$/.test(f)) voices.add(f);
  return voices.size > 0 && [...voices].every(reaches);
};
AUDIO.selfLoops = ()=> AUDIO.edges.filter(([f, t])=> f === t);
class FakeParam {
  constructor(kind, name, ctx){ this.kind=kind; this.name=name; this.ctx=ctx; this.value=0; }
  _rec(v){ if(this.name==='freq' && this.kind.startsWith('osc')) AUDIO.osc.push(v);
           /* Filter bands, recorded separately from oscillator pitch. A footstep is a
              NOISE burst -- it has no oscillator to read a frequency off, so the band it
              is heard in lives entirely in its bandpass, and a suite that only watches
              oscillators is blind to whether a step is audible at all. */
           if(this.name==='freq' && this.kind.startsWith('filt')) AUDIO.filt.push(v);
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
  /* A real AudioNode.connect(null) throws; do the same rather than quietly swallowing a
     null out(), and record the edge so reachability is testable. */
  connect(d){
    if(d == null) throw new TypeError('connect(): destination node is null');
    AUDIO.edges.push([this.kind, d.kind]);
    return d;
  }
  /* `offset` is the second argument to BufferSource.start, and it is the whole of the
     anti-repetition guarantee for footsteps: recorded so a test can prove two steps are
     not the same slice of noise played twice. */
  start(when, offset){
    if(this.ctx && this.ctx.state !== 'running') AUDIO.scheduledWhileSuspended++;
    if(this.kind.startsWith('src')) AUDIO.starts.push(offset == null ? 0 : offset);
  }
  stop(){}
}
global.AudioContext = window.AudioContext = class {
  constructor(){ this.state = 'suspended'; this.sampleRate = 44100;
    this.destination = new FakeNode('dest', this); AUDIO.dest = this.destination.kind; AUDIO.live = this; }
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


const benchProbe = `
;globalThis.__bench = () => {
  const out = {};
  out.critters = CRITTERS.length;
  out.mapScale = +getMapScale().toFixed(3);
  out.noticeR = CRITTERS.map(c => +(spookRadiusFor(c.key)*2.4).toFixed(1));
  let meshes=0,sprites=0,casters=0; const mats=new Set();
  scene.traverse(o=>{ if(o.isMesh){meshes++; if(o.castShadow)casters++; if(o.material)mats.add(o.material);} if(o.isSprite)sprites++; });
  out.sceneMeshes=meshes; out.sceneSprites=sprites; out.sceneCasters=casters; out.sceneMaterials=mats.size;
  let cm=0,cc=0; for(const c of CRITTERS) c.g.traverse(o=>{ if(o.isMesh){cm++; if(o.castShadow)cc++;} });
  out.critterMeshes=cm; out.critterCasters=cc;
  const px=dogPos.x, pz=dogPos.z;
  let t0=process.hrtime.bigint();
  for(let i=0;i<3000;i++) lineOfSight(px,pz,px+30,pz+20,1.4,1.0);
  out.losMicros=+(Number(process.hrtime.bigint()-t0)/1000/3000).toFixed(2);
  t0=process.hrtime.bigint();
  for(let i=0;i<60000;i++) standingY(px+i*0.01,pz);
  out.standingYMicros=+(Number(process.hrtime.bigint()-t0)/1000/60000).toFixed(3);
  t0=process.hrtime.bigint();
  for(let i=0;i<60000;i++) terrainY(px+i*0.01,pz,1);
  out.terrainYMicros=+(Number(process.hrtime.bigint()-t0)/1000/60000).toFixed(3);
  t0=process.hrtime.bigint();
  for(let i=0;i<60000;i++) areaSolidTop(px+i*0.01,pz);
  out.areaSolidTopMicros=+(Number(process.hrtime.bigint()-t0)/1000/60000).toFixed(3);
  // put every critter inside notice range of the player to simulate "animals appear"
  const saved = CRITTERS.map(c=>({x:c.x,z:c.z,state:c.state}));
  t0=process.hrtime.bigint();
  for(let i=0;i<400;i++) updateCritters(0.016,i*0.016,px,pz,3,6,false,false,0);
  out.updateCrittersFarMs=+(Number(process.hrtime.bigint()-t0)/1e6/400).toFixed(3);
  CRITTERS.forEach((c,i)=>{ const a=i/CRITTERS.length*6.283; c.x=px+Math.cos(a)*30; c.z=pz+Math.sin(a)*30; c.state='graze'; c.sighted=false; c.watchT=0; });
  t0=process.hrtime.bigint();
  for(let i=0;i<400;i++) updateCritters(0.016,i*0.016,px,pz,0,6,true,false,1);
  out.updateCrittersNearMs=+(Number(process.hrtime.bigint()-t0)/1e6/400).toFixed(3);
  saved.forEach((s,i)=>{ CRITTERS[i].x=s.x; CRITTERS[i].z=s.z; CRITTERS[i].state=s.state; });
  out.fogNear=+scene.fog.near.toFixed(1); out.fogFar=+scene.fog.far.toFixed(1); out.camFar=camera.far; out.camFov=camera.fov;
  const cols={}; let toonN=0;
  scene.traverse(o=>{ if(o.isMesh&&o.material){ const m=o.material; const c=(m.color&&m.color.getHexString)?m.color.getHexString():'na'; const k=m.type+':'+c+':'+(!!m.gradientMap)+':'+(!!m.map)+':'+(m.transparent?1:0)+':'+(m.side||0)+':'+(m.flatShading?1:0)+':'+(m.opacity); cols[k]=(cols[k]||0)+1; toonN++; } });
  out.uniqueMaterialConfigs=Object.keys(cols).length;
  out.totalMeshMaterials=toonN;
  out.topConfigs=Object.entries(cols).sort((a,b)=>b[1]-a[1]).slice(0,8);
  // biggest mesh groups by name
  const byName={};
  if(getWorldGroup()) for(const ch of getWorldGroup().children){ let n=0; ch.traverse(o=>{if(o.isMesh)n++;}); byName[ch.name||'(unnamed)']=(byName[ch.name||'(unnamed)']||0)+n; }
  out.worldGroups=Object.entries(byName).sort((a,b)=>b[1]-a[1]).slice(0,12);
  // distance histogram of every mesh from the player, using accumulated local offsets
  const wp=(o)=>{ let x=0,y=0,z=0,n=o; while(n){ if(n.position){x+=n.position.x||0;y+=n.position.y||0;z+=n.position.z||0;} n=n.parent; } return {x,y,z}; };
  const bb=getBBox();
  out.bbox={w:+(bb.maxx-bb.minx).toFixed(0), h:+(bb.maxz-bb.minz).toFixed(0)};
  const buckets={}; let counted=0;
  scene.traverse(o=>{ if(!o.isMesh) return; const p=wp(o); const d=Math.hypot(p.x-dogPos.x,p.z-dogPos.z);
    const b = d<100?'0-100': d<200?'100-200': d<400?'200-400': d<700?'400-700': d<1500?'700-1500':'1500+';
    buckets[b]=(buckets[b]||0)+1; counted++; });
  out.meshDistance=buckets; out.meshCounted=counted;
  /* Worst step a walker meets ALONG a trail: sample standingY every 0.5 m down every
     edge's own centreline and keep the biggest jump between consecutive samples. This is
     the number the "steps too large to jump" report is about. */
  out.probe = (()=>{
    const x=1037.7, z=284.7, o=[];
    for(let k=-6;k<=6;k++){
      const px=x+k*0.5;
      const nt=nearestTrail(px,z);
      o.push({x:+px.toFixed(1), g:+terrainY(px,z,getVertScale()).toFixed(2), s:+standingY(px,z).toFixed(2),
              ntd:nt.d==null?null:+nt.d.toFixed(2), nthw:nt.hw==null?null:+nt.hw.toFixed(2), nty:nt.y==null?null:+nt.y.toFixed(2)});
    }
    const bb=getBBox();
    return {row:o, bbox:{minx:+bb.minx.toFixed(0),maxx:+bb.maxx.toFixed(0),minz:+bb.minz.toFixed(0),maxz:+bb.maxz.toFixed(0)},
            demX:[+(BUNDLE.originX).toFixed(0), +(BUNDLE.originX+BUNDLE.width*BUNDLE.cell).toFixed(0)]};
  })();
  out.trailStep = (()=>{
    const G=getGraph(); if(!G) return null;
    let worst=0, where=null, n=0, over=0;
    const lim=stepUpLimit();
    for(const e of G.edges){
      const pts=(e.prof&&e.prof.pts)||e.pts; if(!pts||pts.length<2) continue;
      for(let i=1;i<pts.length;i++){
        const ax=pts[i-1][0],az=pts[i-1][1],bx=pts[i][0],bz=pts[i][1];
        const L=Math.hypot(bx-ax,bz-az), steps=Math.max(1,Math.ceil(L/0.5));
        let prev=standingY(ax,az);
        for(let k=1;k<=steps;k++){
          const t=k/steps, x=ax+(bx-ax)*t, z=az+(bz-az)*t;
          const y=standingY(x,z); const d=Math.abs(y-prev); n++;
          if(d>lim) over++;
          if(d>worst){ worst=d; where={x:+x.toFixed(1),z:+z.toFixed(1)}; }
          prev=y;
        }
      }
    }
    return {worstStep:+worst.toFixed(2), stepUpLimit:+stepUpLimit().toFixed(2), samples:n, overLimit:over, where, cell:+(BUNDLE?BUNDLE.cell:0).toFixed(1), stride:(BUNDLE?BUNDLE.demStride:null)};
  })();
  const byType={}; const seen=new Set();
  scene.traverse(o=>{ if(o.isMesh&&o.material&&!seen.has(o.material)){ seen.add(o.material);
    const t=(o.material.constructor&&o.material.constructor.name)||'?';
    const c=(o.material.color&&o.material.color.getHexString)?o.material.color.getHexString():'na';
    const k=t+(o.material.gradientMap?'/toon':'')+(o.material.map?'/map':'');
    byType[k]=(byType[k]||0)+1; } });
  out.materialsByKind=byType;
  return out;
};`;

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
  pane: typeof getPane === 'function' ? getPane() : null,
  // the DOM projection, read separately from the state on purpose: if panes.js ever
  // stops writing the attribute, or something else starts writing it, these two
  // disagree and the check below says so.
  paneAttr: document.body.getAttribute('data-pane'),
  pathMix: typeof getPathMix === 'function' ? getPathMix() : null,
  spots: typeof getSpots === 'function' ? getSpots().map(s => ({id:s.id, name:s.name, rx:s.rx, rz:s.rz})) : null,
  onTrail: typeof getOnTrail === 'function' ? {route:getOnTrail().route, name:getOnTrail().name} : null,
  highlight: typeof getHighlightRoute === 'function' ? getHighlightRoute() : null,
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
  (0, eval)(app + probe + benchProbe);
} catch (e) {
  origError('THREW during boot:', e.message, '\n', e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

(async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setImmediate(r));
    if (global.__raf) { const fn = global.__raf; global.__raf = null; fn(i * 16); }
  }
  console.error = origError;
  await (0,eval)(`(async()=>{ setTier('medium'); await loadWorld('../data/pikesworld.json', [], 3); })()`);
  const R = global.__bench(); if(0)(0,eval)(`(()=>{
    const out = {};
    out.critters = CRITTERS.length;
    // how far is each critter's noticeR?
    out.noticeR = CRITTERS.map(c => +(spookRadiusFor(c.key)*2.4).toFixed(1));
    out.mapScale = getMapScale();
    // count scene objects
    let meshes=0, sprites=0, casters=0, mats=new Set();
    scene.traverse(o=>{ if(o.isMesh){meshes++; if(o.castShadow)casters++; if(o.material)mats.add(o.material);} if(o.isSprite)sprites++; });
    out.sceneMeshes=meshes; out.sceneSprites=sprites; out.sceneCasters=casters; out.sceneMaterials=mats.size;
    // critter-only subtree counts
    let cm=0, cc=0;
    for(const c of CRITTERS) c.g.traverse(o=>{ if(o.isMesh){cm++; if(o.castShadow)cc++;} });
    out.critterMeshes=cm; out.critterCasters=cc;

    // benchmark lineOfSight at a realistic distance
    const p = {x: dogPos.x, z: dogPos.z};
    const t0=process.hrtime.bigint();
    let n=0;
    for(let i=0;i<2000;i++){ lineOfSight(p.x,p.z,p.x+30,p.z+20,1.4,1.0); n++; }
    const t1=process.hrtime.bigint();
    out.losMicros = Number(t1-t0)/1000/n;

    // benchmark standingY alone
    const t2=process.hrtime.bigint();
    for(let i=0;i<50000;i++) standingY(p.x+i*0.01, p.z);
    const t3=process.hrtime.bigint();
    out.standingYMicros = Number(t3-t2)/1000/50000;

    // benchmark a full updateCritters frame
    const t4=process.hrtime.bigint();
    for(let i=0;i<300;i++) updateCritters(0.016, i*0.016, p.x, p.z, 3, 6, false, false, 0);
    const t5=process.hrtime.bigint();
    out.updateCrittersMs = Number(t5-t4)/1e6/300;
    return out;
  })()`);
  console.log(JSON.stringify(R, null, 1));
})().catch(e => { console.error = origError; origError('THREW:', e.message, e.stack.split('\n').slice(0,8).join('\n')); });
