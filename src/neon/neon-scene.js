/* The look: dark void, one glowing ribbon, the rest of the map as a wireframe memory.

   Nothing here is lit. Every surface is MeshBasicMaterial or a line, most of it additive,
   so the scene costs almost nothing to draw and looks the same on a tablet as on a
   desktop. There is no post-processing (the vendored three.js is the bare r128 build);
   "glow" is a second, wider, fainter strip laid under each bright one. The only lit
   things in the scene are the riders, which keep their toon materials so a pup you built
   in the creator still looks like your pup. */
import { scene, camera, disposeGroup } from '../core/render.js';
import { NEON } from './tuning.js';
import { demSmooth, deckY, trackFrame } from './track.js';

const NEON_COL = {
  bg:     0x04050d,
  deck:   0x080c1a,
  left:   0x19f0ff,
  right:  0xff2bd6,
  dash:   0x4458b8,
  pylon:  0x1a2a6a,
  grid:   0x121840,
  ghost:  0x1c3f7a,
  gate:   0xb6ff3c,
};

let envGroup = null, trackGroup = null, starField = null;
let glowTex = null;
const PULSES = [];

function glowTexture(){
  if(glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  if(g && g.createRadialGradient){
    const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  }
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

function addMat(color, opacity){
  return new THREE.MeshBasicMaterial({color, transparent:true, opacity: opacity == null ? 1 : opacity,
    blending: THREE.AdditiveBlending, depthWrite:false, side: THREE.DoubleSide});
}
function lineMat(color, opacity, vertexColors){
  return new THREE.LineBasicMaterial({color, transparent:true, opacity: opacity == null ? 1 : opacity,
    vertexColors: !!vertexColors, depthWrite:false});
}

/* ---------- environment: built once per MAP ---------- */
function buildEnvironment(W, graph, bbox){
  if(envGroup){ scene.remove(envGroup); disposeGroup(envGroup); }
  envGroup = new THREE.Group(); envGroup.name = 'neonEnv';
  scene.background = new THREE.Color(NEON_COL.bg);
  scene.fog = new THREE.Fog(NEON_COL.bg, 120, 1500);
  camera.near = 0.3; camera.far = 7000; camera.updateProjectionMatrix();

  const baseM = W ? W.minM : 0;
  const pad = 400;
  const x0 = bbox.x0-pad, x1 = bbox.x1+pad, z0 = bbox.z0-pad, z1 = bbox.z1+pad;

  // floor grid, well under the lowest ground so nothing ever dips through it
  {
    const span = Math.max(x1-x0, z1-z0);
    const nice = [25, 50, 100, 200, 250, 500];
    let cell = nice[nice.length-1];
    for(const c of nice){ if(span/c <= 90){ cell = c; break; } }
    const pos = [];
    const gx0 = Math.floor(x0/cell)*cell, gz0 = Math.floor(z0/cell)*cell;
    for(let x = gx0; x <= x1; x += cell) pos.push(x, -18, z0, x, -18, z1);
    for(let z = gz0; z <= z1; z += cell) pos.push(x0, -18, z, x1, -18, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const grid = new THREE.LineSegments(geo, lineMat(NEON_COL.grid, 0.9));
    grid.name = 'neonGrid';
    envGroup.add(grid);
  }

  // the land itself, as a coarse wire sheet coloured by height
  if(W){
    const stride = Math.max(1, Math.ceil(Math.max(W.width, W.height)/110));
    const w = Math.floor(W.width/stride), h = Math.floor(W.height/stride);
    const pos = [], col = [];
    const lo = new THREE.Color(0x0e1440), hi = new THREE.Color(0x6a2aa8), tmp = new THREE.Color();
    const range = Math.max(1, W.maxM - W.minM);
    const vert = (i, j) => {
      const hh = W.heights[(j*stride)*W.width + i*stride];
      pos.push(W.originX + (i*stride+0.5)*W.cell, (hh-baseM)*NEON.vertScale, W.originZ + (j*stride+0.5)*W.cell);
      tmp.copy(lo).lerp(hi, (hh-W.minM)/range);
      col.push(tmp.r, tmp.g, tmp.b);
    };
    for(let j = 0; j < h; j++) for(let i = 0; i < w; i++){
      if(i+1 < w){ vert(i, j); vert(i+1, j); }
      if(j+1 < h){ vert(i, j); vert(i, j+1); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const land = new THREE.LineSegments(geo, lineMat(0xffffff, 0.55, true));
    land.name = 'neonLand';
    envGroup.add(land);
  }

  // every trail on the map, faintly: the courses you are NOT racing right now
  if(graph){
    const pos = [];
    for(const e of graph.edges){
      for(let i = 1; i < e.pts.length; i++){
        const a = e.pts[i-1], b = e.pts[i];
        const ya = W ? deckY(null, demSmooth(W, a[0], a[1]), baseM) - 0.6 : NEON.lift-0.6;
        const yb = W ? deckY(null, demSmooth(W, b[0], b[1]), baseM) - 0.6 : NEON.lift-0.6;
        pos.push(a[0], ya, a[1], b[0], yb, b[1]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const ghost = new THREE.LineSegments(geo, lineMat(NEON_COL.ghost, 0.8));
    ghost.name = 'neonGhost';
    envGroup.add(ghost);
  }

  // a few stars, on a shell that rides along with the camera (see updateScene)
  {
    const pos = [];
    let seed = 7;
    const rnd = () => { seed = (seed*16807) % 2147483647; return seed/2147483647; };
    for(let i = 0; i < 420; i++){
      const th = rnd()*Math.PI*2, ph = Math.acos(rnd()*0.92 + 0.04), R = 5200;
      pos.push(Math.cos(th)*Math.sin(ph)*R, Math.cos(ph)*R, Math.sin(th)*Math.sin(ph)*R);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    starField = new THREE.Points(geo, new THREE.PointsMaterial({color:0x9fb4ff, size:2.2,
      sizeAttenuation:false, fog:false, transparent:true, opacity:0.8, depthWrite:false}));
    starField.name = 'neonStars';
    starField.frustumCulled = false;
    envGroup.add(starField);
  }
  scene.add(envGroup);
  return envGroup;
}

/* ---------- the ribbon: built once per COURSE ---------- */
function stripGeometry(A, B, closed, colA, colB){
  // A, B: flat [x,y,z,...] arrays of equal length, one vertex per sample on each side
  const n = A.length/3;
  const pos = new Float32Array(n*6);
  for(let i = 0; i < n; i++){
    pos.set([A[i*3], A[i*3+1], A[i*3+2], B[i*3], B[i*3+1], B[i*3+2]], i*6);
  }
  const idx = [];
  const segs = closed ? n : n-1;
  for(let i = 0; i < segs; i++){
    const a = i*2, b = i*2+1, c = ((i+1)%n)*2, d = ((i+1)%n)*2+1;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if(colA){
    const col = new Float32Array(n*6);
    for(let i = 0; i < n; i++){
      col.set([colA[i*3], colA[i*3+1], colA[i*3+2], colB[i*3], colB[i*3+1], colB[i*3+2]], i*6);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  geo.setIndex(idx);
  return geo;
}

/* Offset line: every sample pushed d metres left (+) of the centreline and dy up. */
function offsetLine(T, baseM, dOf, dy){
  const out = new Float32Array(T.n*3);
  for(let i = 0; i < T.n; i++){
    const d = dOf(i);
    out[i*3]   = T.x[i] - Math.sin(T.yaw[i])*d;
    out[i*3+1] = deckY(T, T.elev[i], baseM) + dy;
    out[i*3+2] = T.z[i] - Math.cos(T.yaw[i])*d;
  }
  return out;
}

function gateAt(T, baseM, s, color){
  const f = trackFrame(T, s, {});
  const g = new THREE.Group();
  const hw = f.halfW + 0.6, tall = 6.5;
  const mat = new THREE.MeshBasicMaterial({color});
  const glow = addMat(color, 0.25);
  for(const side of [-1, 1]){
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, tall, 0.35), mat);
    post.position.set(0, tall/2, side*hw);
    g.add(post);
    const halo = new THREE.Mesh(new THREE.BoxGeometry(1.1, tall, 1.1), glow);
    halo.position.copy(post.position);
    g.add(halo);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, hw*2+0.35), mat);
  beam.position.set(0, tall, 0);
  g.add(beam);
  const line = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, hw*2), addMat(color, 0.7));
  line.position.set(0, 0.06, 0);
  g.add(line);
  // local +X is "down the track", the same convention every rider model uses
  g.position.set(f.x, deckY(T, f.elev, baseM), f.z);
  g.rotation.y = f.yaw;
  g.name = 'neonGate';
  return g;
}

function buildTrackMesh(T, baseM){
  clearTrackMesh();
  trackGroup = new THREE.Group(); trackGroup.name = 'neonTrack';
  const hw = i => T.halfW[i];
  const L0 = offsetLine(T, baseM, i =>  hw(i), 0),  R0 = offsetLine(T, baseM, i => -hw(i), 0);

  // deck
  const deck = new THREE.Mesh(stripGeometry(L0, R0, T.closed),
    new THREE.MeshBasicMaterial({color: NEON_COL.deck, side: THREE.DoubleSide, transparent:true, opacity:0.94}));
  deck.name = 'neonDeck'; deck.renderOrder = 1;
  trackGroup.add(deck);

  // edge lines: a crisp one and a wide faint one under it
  const edge = (sign, color) => {
    const o = offsetLine(T, baseM, i => sign*hw(i), 0.03);
    const i1 = offsetLine(T, baseM, i => sign*(hw(i)-0.30), 0.03);
    const i2 = offsetLine(T, baseM, i => sign*(hw(i)-1.1), 0.02);
    const crisp = new THREE.Mesh(stripGeometry(o, i1, T.closed), addMat(color, 1));
    const soft  = new THREE.Mesh(stripGeometry(o, i2, T.closed), addMat(color, 0.09));
    crisp.renderOrder = 3; soft.renderOrder = 2;
    trackGroup.add(soft, crisp);
  };
  edge(1, NEON_COL.left); edge(-1, NEON_COL.right);

  /* BUMPERS. A translucent wall that is bright at the deck and fades to nothing at the
     top (additive + vertex colours: black adds nothing), banded along its length so it
     reads as a row of pads rather than a fence, with a solid rail on top. The physics
     wall is at halfW minus half a board; the visual one is at halfW, so a board's flank
     touches the glow at exactly the moment it bounces. */
  const wall = (sign, color) => {
    const c = new THREE.Color(color);
    const bot = offsetLine(T, baseM, i => sign*hw(i), 0.0);
    const top = offsetLine(T, baseM, i => sign*(hw(i)+0.25), 1.15);
    const cb = new Float32Array(T.n*3), ct = new Float32Array(T.n*3);
    for(let i = 0; i < T.n; i++){
      const band = (Math.floor(i*T.ds/6) % 2) ? 0.85 : 0.4;
      cb[i*3] = c.r*band; cb[i*3+1] = c.g*band; cb[i*3+2] = c.b*band;
    }
    const m = new THREE.Mesh(stripGeometry(bot, top, T.closed, cb, ct),
      new THREE.MeshBasicMaterial({vertexColors:true, transparent:true, blending:THREE.AdditiveBlending,
        depthWrite:false, side:THREE.DoubleSide}));
    m.name = sign > 0 ? 'neonBumperL' : 'neonBumperR'; m.renderOrder = 4;
    const r0 = offsetLine(T, baseM, i => sign*(hw(i)+0.12), 1.15);
    const r1 = offsetLine(T, baseM, i => sign*(hw(i)+0.38), 1.15);
    const rail = new THREE.Mesh(stripGeometry(r0, r1, T.closed), addMat(color, 0.9));
    rail.renderOrder = 4;
    trackGroup.add(m, rail);
  };
  wall(1, NEON_COL.left); wall(-1, NEON_COL.right);

  // centre dashes + pylons down to the floor grid
  {
    const dash = [], py = [];
    const every = Math.max(1, Math.round(12/T.ds));
    for(let i = 0; i+1 < T.n; i += every){
      const j = Math.min(T.n-1, i + Math.max(1, Math.round(4/T.ds)));
      dash.push(T.x[i], deckY(T, T.elev[i], baseM)+0.04, T.z[i], T.x[j], deckY(T, T.elev[j], baseM)+0.04, T.z[j]);
    }
    const pEvery = Math.max(1, Math.round(48/T.ds));
    for(let i = 0; i < T.n; i += pEvery){
      for(const sign of [-1, 1]){
        const x = T.x[i] - Math.sin(T.yaw[i])*sign*T.halfW[i], z = T.z[i] - Math.cos(T.yaw[i])*sign*T.halfW[i];
        py.push(x, deckY(T, T.elev[i], baseM), z, x, -18, z);
      }
    }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(dash, 3));
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(py, 3));
    const dashes = new THREE.LineSegments(dg, lineMat(NEON_COL.dash, 0.9)); dashes.renderOrder = 3;
    trackGroup.add(dashes, new THREE.LineSegments(pg, lineMat(NEON_COL.pylon, 0.8)));
  }

  trackGroup.add(gateAt(T, baseM, 0, NEON_COL.gate));
  if(!T.closed) trackGroup.add(gateAt(T, baseM, T.L, NEON_COL.gate));

  // bumper flash pool
  PULSES.length = 0;
  for(let i = 0; i < 8; i++){
    const m = new THREE.Mesh(new THREE.PlaneGeometry(7, 2.6), addMat(0xffffff, 0));
    m.visible = false; m.renderOrder = 6;
    trackGroup.add(m);
    PULSES.push({m, t: 0});
  }
  // long ribbons wander far from their own bounding-sphere centre; never cull them
  trackGroup.traverse(o => { o.frustumCulled = false; });
  scene.add(trackGroup);
  return trackGroup;
}
function clearTrackMesh(){
  if(trackGroup){ scene.remove(trackGroup); disposeGroup(trackGroup); trackGroup = null; }
  PULSES.length = 0;
}

/* A wall lighting up where it was hit. side: +1 left, -1 right. */
function bumperPulse(x, y, z, yaw, side, hard){
  let p = PULSES[0];
  for(const q of PULSES){ if(q.t <= 0){ p = q; break; } if(q.t < p.t) p = q; }
  if(!p) return;
  p.t = 1;
  p.m.visible = true;
  p.m.position.set(x, y + 1.0, z);
  p.m.rotation.y = yaw;                       // plane's face normal is local +Z = across the track
  p.m.material.color.setHex(side > 0 ? NEON_COL.left : NEON_COL.right);
  p.m.material.opacity = 0.5 + 0.5*hard;
  p.m.scale.set(0.6, 0.6, 1);
}
function updateScene(dt){
  for(const p of PULSES){
    if(p.t <= 0) continue;
    p.t -= dt/0.38;
    if(p.t <= 0){ p.m.visible = false; p.m.material.opacity = 0; continue; }
    const k = 1 - p.t;
    p.m.scale.set(0.6 + k*1.4, 0.6 + k*0.9, 1);
    p.m.material.opacity = p.t*p.t;
  }
  if(starField) starField.position.copy(camera.position);
}

export { NEON_COL, glowTexture, addMat, buildEnvironment, buildTrackMesh, clearTrackMesh,
         bumperPulse, updateScene, stripGeometry, offsetLine };
