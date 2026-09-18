/* The look: dark void, one glowing ribbon, the rest of the map as a wireframe memory.

   Nothing here is lit. Every surface is MeshBasicMaterial or a line, most of it additive,
   so the scene costs almost nothing to draw and looks the same on a tablet as on a
   desktop. There is no post-processing (the vendored three.js is the bare r128 build);
   "glow" is a second, wider, fainter strip laid under each bright one. The only lit
   things in the scene are the riders, which keep their toon materials so a pup you built
   in the creator still looks like your pup. */
import { scene, camera, disposeGroup } from '../core/render.js';
import { QUALITY } from '../core/quality.js';
import { NEON } from './tuning.js';
import { demSmooth, deckY, trackFrame } from './track.js';

const NEON_COL = {
  bg:     0x04050d,
  deck:   0x080c1a,
  left:   0x19f0ff,
  right:  0xff2bd6,
  dash:   0x4458b8,
  pylon:  0x1a2a6a,
  grid:   0x0e1436,
  ghost:  0x2f6ec8,
  gate:   0xb6ff3c,
};
/* The map's own furniture, by the kinds geo.js already sorts features into. */
const NEON_PATH_COL = {road: 0x6a5cff, track: 0x2f6ec8, trail: 0x1f7fa8};
const NEON_PATH_W   = {road: 2.6, track: 1.9, trail: 1.3};
/* Deliberately NOT cyan or magenta: those two belong to the left and right bumpers, and
   a lake the colour of a wall is a lake you try to steer away from. */
const NEON_AREA = {
  water:     {line: 0x2f7bff, fill: 0x123a78, a: 0.30},
  forest:    {line: 0x1fd07a, fill: 0x0a3a24, a: 0.18},
  meadow:    {line: 0x3f9e5e, fill: 0x0a2a18, a: 0.13},
  redrock:   {line: 0xff7a3c, fill: 0x3a1608, a: 0.16},
  lightrock: {line: 0xffc14a, fill: 0x33260c, a: 0.14},
  rock:      {line: 0x9a86e0, fill: 0x1c1640, a: 0.14},
  building:  {line: 0xffe14a, fill: 0x2a2408, a: 0.22},
  parking:   {line: 0x5f7ab8, fill: 0x101838, a: 0.14},
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
/* Everything here is static, unlit and merged: the whole world is about half a dozen
   draw calls, which is what buys the draw distance. Nothing is per-frame except the star
   shell riding along with the camera.

   `scale` is the map scale divisor -- the graph and the DEM arrive in real metres and are
   divided by it here, exactly as track.js does for the ribbon, so the scenery lands on
   the racing line at every setting. */
function demDetail(){
  return QUALITY.tier === 'low' ? 170 : QUALITY.tier === 'medium' ? 240 : 300;
}

/* A polyline drawn as a flat ribbon draped on the terrain. Lines cannot be made thicker
   than a pixel in WebGL (linewidth is ignored on every desktop driver), and a network of
   hairlines vanishes at distance -- a 1.5 m quad strip is both visible from a kilometre
   up and, at a few thousand triangles for an entire map, cheaper than caring about. */
const RIBBON_STEP_M = 9;
function ribbonInto(pos, col, pts, width, yOf, c, fade){
  const n = pts.length;
  if(n < 2) return;
  for(let i = 1; i < n; i++){
    const a = pts[i-1], b = pts[i];
    let dx = b[0]-a[0], dz = b[1]-a[1];
    const L = Math.hypot(dx, dz);
    if(L < 1e-6) continue;
    dx /= L; dz /= L;
    const nx = -dz*width*0.5, nz = dx*width*0.5;
    /* SUBDIVIDED, because the height comes from the terrain at each end. A simplified
       trail leaves segments a couple of hundred metres long, and Garden of the Gods has
       fins a hundred metres tall in between: a single quad from one end to the other does
       not drape over the fin, it SPANS it, and a 1.3 m wide ribbon standing 100 m proud of
       the ground reads on screen as a great triangular sheet hanging in the air. Stepping
       along the segment puts the ribbon back on the ground it is describing. */
    const steps = Math.max(1, Math.ceil(L/RIBBON_STEP_M));
    for(let k = 0; k < steps; k++){
      const t0 = k/steps, t1 = (k+1)/steps;
      const ax = a[0] + (b[0]-a[0])*t0, az = a[1] + (b[1]-a[1])*t0;
      const bx = a[0] + (b[0]-a[0])*t1, bz = a[1] + (b[1]-a[1])*t1;
      const ya = yOf(ax, az), yb = yOf(bx, bz);
      const quad = [
        ax+nx, ya, az+nz,  ax-nx, ya, az-nz,  bx+nx, yb, bz+nz,
        ax-nx, ya, az-nz,  bx-nx, yb, bz-nz,  bx+nx, yb, bz+nz,
      ];
      for(let q = 0; q < 18; q++) pos.push(quad[q]);
      for(let q = 0; q < 6; q++) col.push(c.r*fade, c.g*fade, c.b*fade);
    }
  }
}

function buildEnvironment(W, graph, areas, bbox, scale){
  if(envGroup){ scene.remove(envGroup); disposeGroup(envGroup); }
  envGroup = new THREE.Group(); envGroup.name = 'neonEnv';
  scene.background = new THREE.Color(NEON_COL.bg);
  const sc = scale > 0 ? scale : 1;
  const baseM = W ? W.minM/sc : 0;
  const span = Math.max(bbox.x1-bbox.x0, bbox.z1-bbox.z0);
  /* Draw distance is the point of all the merging above: fog reaches most of the way
     across the map, and the far plane past the far rim, so a ridge two kilometres off is
     still a shape on the horizon rather than a hard edge in mid-air. */
  const far = Math.max(900, span*0.85);
  scene.fog = new THREE.Fog(NEON_COL.bg, far*0.10, far);
  camera.near = 0.3; camera.far = Math.max(8000, far*2.2); camera.updateProjectionMatrix();
  const floorY = -18/Math.sqrt(sc);
  const yAt = W ? (x, z) => (demSmooth(W, x*sc, z*sc)/sc - baseM)*NEON.vertScale : () => 0;

  // floor grid, well under the lowest ground so nothing ever dips through it
  {
    const nice = [25, 50, 100, 200, 250, 500, 1000];
    let cell = nice[nice.length-1];
    for(const c of nice){ if(span/c <= 90){ cell = c; break; } }
    const pad = span*0.35;
    const x0 = bbox.x0-pad, x1 = bbox.x1+pad, z0 = bbox.z0-pad, z1 = bbox.z1+pad;
    const pos = [];
    for(let x = Math.floor(x0/cell)*cell; x <= x1; x += cell) pos.push(x, floorY, z0, x, floorY, z1);
    for(let z = Math.floor(z0/cell)*cell; z <= z1; z += cell) pos.push(x0, floorY, z, x1, floorY, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const grid = new THREE.LineSegments(geo, lineMat(NEON_COL.grid, 0.8));
    grid.name = 'neonGrid';
    envGroup.add(grid);
  }

  /* The land, as a wire sheet. INDEXED, so each sample is one vertex shared by up to four
     segments instead of four copies of itself -- that is what makes a 260-across grid
     affordable where the old 110-across unindexed one was not.

     Colour carries the terrain reading: a height ramp, plus a brighter band every
     contour interval. The bands are what make relief legible at a distance; computing
     them per vertex costs nothing at run time because they are baked into the colours. */
  if(W){
    const target = demDetail();
    const stride = Math.max(1, Math.ceil(Math.max(W.width, W.height)/target));
    const w = Math.floor(W.width/stride), h = Math.floor(W.height/stride);
    const cellS = W.cell/sc;
    const pos = new Float32Array(w*h*3), col = new Float32Array(w*h*3);
    const lo = new THREE.Color(0x0c2a5e), mid = new THREE.Color(0x4a2ea0), hi = new THREE.Color(0xe04aff);
    const tmp = new THREE.Color();
    const range = Math.max(1, (W.maxM - W.minM)/sc);
    const interval = range/14;
    for(let j = 0; j < h; j++) for(let i = 0; i < w; i++){
      const k = j*w + i;
      const hm = W.heights[(j*stride)*W.width + i*stride]/sc;
      pos[k*3]   = W.originX/sc + (i*stride+0.5)*cellS;
      pos[k*3+1] = (hm-baseM)*NEON.vertScale;
      pos[k*3+2] = W.originZ/sc + (j*stride+0.5)*cellS;
      const t = (hm - W.minM/sc)/range;
      tmp.copy(t < 0.5 ? lo : mid).lerp(t < 0.5 ? mid : hi, t < 0.5 ? t*2 : (t-0.5)*2);
      // distance to the nearest contour line, 0 (on it) .. 1 (half an interval away)
      const band = Math.abs(((hm/interval) % 1) - 0.5)*2;
      /* Dim between contours, bright on them: the bands are what make relief readable at
         a kilometre, while the fill between them stays quiet enough not to fight the
         racing line for attention. */
      const lift = 0.22 + 1.25*Math.pow(1-band, 8);
      col[k*3] = tmp.r*lift; col[k*3+1] = tmp.g*lift; col[k*3+2] = tmp.b*lift;
    }
    const idx = [];
    for(let j = 0; j < h; j++) for(let i = 0; i < w; i++){
      const k = j*w + i;
      if(i+1 < w){ idx.push(k, k+1); }
      if(j+1 < h){ idx.push(k, k+w); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    const land = new THREE.LineSegments(geo, lineMat(0xffffff, 0.62, true));
    land.name = 'neonLand';
    land.userData.samples = w*h;
    envGroup.add(land);
  }

  /* Ground cover: water, rock formations, meadows, buildings, car parks. Each polygon is
     triangulated by THREE.Shape (ring vertices only, no interior points), so every vertex
     it produces can be dropped straight onto the terrain and the fill drapes instead of
     hovering. Outlines and fills are each merged into one mesh per kind. */
  if(areas && areas.length){
    const byKind = new Map();
    for(const a of areas){
      const spec = NEON_AREA[a.kind];
      if(!spec || !a.rings || !a.rings.length) continue;
      if(!byKind.has(a.kind)) byKind.set(a.kind, []);
      byKind.get(a.kind).push(a);
    }
    for(const [kind, list] of byKind){
      const spec = NEON_AREA[kind];
      const fillPos = [], linePos = [], lineCol = [];
      const c = new THREE.Color(spec.line);
      for(const a of list){
        const rings = a.rings.map(r => r.map(p => [p[0]/sc, p[1]/sc]));
        // outline every ring, including the holes
        for(const r of rings) ribbonInto(linePos, lineCol, r.concat([r[0]]), Math.max(1.2, 2.2/Math.sqrt(sc)),
          (x, z) => yAt(x, z) + 0.5, c, 1);
        const outer = rings[0];
        if(outer.length < 4 || typeof THREE.Shape !== 'function') continue;
        const shape = new THREE.Shape(outer.map(p => new THREE.Vector2(p[0], p[1])));
        for(let i = 1; i < rings.length; i++)
          shape.holes.push(new THREE.Path(rings[i].map(p => new THREE.Vector2(p[0], p[1]))));
        let geo;
        try{ geo = new THREE.ShapeGeometry(shape); }catch(e){ continue; }
        const pa = geo.getAttribute && geo.getAttribute('position');
        const index = geo.index;
        if(!pa || !index) continue;
        /* ShapeGeometry lays the shape out in XY; here XY was (x, z), so lift it into Y.
           A FILL IS GROUND COVER, AND A CLIFF IS NOT GROUND. Draping a 300 m rock polygon
           over Garden of the Gods' fins gives triangles that climb 150 exaggerated metres
           from base to top, and up close one of those fills half the sky as a flat sheet.
           Triangles that steep are dropped -- the outline still traces the formation, and
           the flat areas (meadows, car parks, water) fill as intended. */
        const tri = [];
        for(let q = 0; q < index.count; q++){
          const v = index.array[q];
          const px = pa.array[v*3], pz = pa.array[v*3+1];
          tri.push(px, yAt(px, pz) + 0.25, pz);
          if(tri.length < 9) continue;
          const ys = [tri[1], tri[4], tri[7]];
          const drop = Math.max.apply(null, ys) - Math.min.apply(null, ys);
          if(drop <= 14) for(let w = 0; w < 9; w++) fillPos.push(tri[w]);
          tri.length = 0;
        }
        geo.dispose();
      }
      if(fillPos.length){
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(fillPos, 3));
        /* Fills are NORMAL blending, not additive. A rock formation is a couple of hundred
           metres across, so the moment the course runs through one an additive fill is
           most of the screen glowing -- the polygon reads as a light source instead of
           ground. Blended normally it tints the wireframe underneath and stays where it
           belongs; the outline is what identifies it anyway. */
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({color: spec.fill, transparent:true,
          opacity: spec.a, depthWrite:false, side: THREE.DoubleSide}));
        m.name = 'neonArea_' + kind;
        envGroup.add(m);
      }
      if(linePos.length){
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(lineCol, 3));
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({vertexColors:true, transparent:true,
          opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite:false, side: THREE.DoubleSide}));
        m.name = 'neonAreaEdge_' + kind;
        envGroup.add(m);
      }
    }
  }

  // every path on the map, as a faint ribbon: roads widest, singletrack thinnest
  if(graph){
    const pos = [], col = [];
    const cols = {}; for(const k in NEON_PATH_COL) cols[k] = new THREE.Color(NEON_PATH_COL[k]);
    for(const e of graph.edges){
      const kind = NEON_PATH_COL[e.kind] ? e.kind : 'trail';
      const pts = e.pts.map(p => [p[0]/sc, p[1]/sc]);
      ribbonInto(pos, col, pts, Math.max(0.9, NEON_PATH_W[kind]/Math.sqrt(sc)),
        (x, z) => yAt(x, z) + 0.35, cols[kind], 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const ghost = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({vertexColors:true, transparent:true,
      opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite:false, side: THREE.DoubleSide}));
    ghost.name = 'neonGhost';
    envGroup.add(ghost);
  }

  // a few stars, on a shell that rides along with the camera (see updateScene)
  {
    const pos = [];
    let seed = 7;
    const rnd = () => { seed = (seed*16807) % 2147483647; return seed/2147483647; };
    for(let i = 0; i < 420; i++){
      const th = rnd()*Math.PI*2, ph = Math.acos(rnd()*0.92 + 0.04), R = camera.far*0.8;
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

function gateAt(T, baseM, s, color, K){
  const k = K > 0 ? K : 1;
  const f = trackFrame(T, s, {});
  const g = new THREE.Group();
  const hw = f.halfW + 0.6*k, tall = 6.5*k;
  const mat = new THREE.MeshBasicMaterial({color});
  const glow = addMat(color, 0.25);
  for(const side of [-1, 1]){
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35*k, tall, 0.35*k), mat);
    post.position.set(0, tall/2, side*hw);
    g.add(post);
    const halo = new THREE.Mesh(new THREE.BoxGeometry(1.1*k, tall, 1.1*k), glow);
    halo.position.copy(post.position);
    g.add(halo);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.35*k, 0.35*k, hw*2+0.35*k), mat);
  beam.position.set(0, tall, 0);
  g.add(beam);
  const line = new THREE.Mesh(new THREE.BoxGeometry(1.2*k, 0.04, hw*2), addMat(color, 0.7));
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
  /* Everything measured ACROSS or ABOVE the ribbon shrinks with it on a scaled-down map --
     the edge lines, the height of the bumper walls, the gates. A 1.15 m wall beside a
     0.8 m board reads as a canyon; the same wall beside a 1.5 m board reads as a kerb. */
  const K = 1/(T.widthK || 1);
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
    const i1 = offsetLine(T, baseM, i => sign*(hw(i)-0.30*K), 0.03);
    const i2 = offsetLine(T, baseM, i => sign*(hw(i)-1.1*K), 0.02);
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
    const top = offsetLine(T, baseM, i => sign*(hw(i)+0.25*K), 1.15*K);
    const cb = new Float32Array(T.n*3), ct = new Float32Array(T.n*3);
    for(let i = 0; i < T.n; i++){
      const band = (Math.floor(i*T.ds/6) % 2) ? 0.85 : 0.4;
      cb[i*3] = c.r*band; cb[i*3+1] = c.g*band; cb[i*3+2] = c.b*band;
    }
    const m = new THREE.Mesh(stripGeometry(bot, top, T.closed, cb, ct),
      new THREE.MeshBasicMaterial({vertexColors:true, transparent:true, blending:THREE.AdditiveBlending,
        depthWrite:false, side:THREE.DoubleSide}));
    m.name = sign > 0 ? 'neonBumperL' : 'neonBumperR'; m.renderOrder = 4;
    const r0 = offsetLine(T, baseM, i => sign*(hw(i)+0.12*K), 1.15*K);
    const r1 = offsetLine(T, baseM, i => sign*(hw(i)+0.38*K), 1.15*K);
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

  trackGroup.add(gateAt(T, baseM, 0, NEON_COL.gate, K));
  if(!T.closed) trackGroup.add(gateAt(T, baseM, T.L, NEON_COL.gate, K));

  // bumper flash pool
  PULSES.length = 0;
  for(let i = 0; i < 8; i++){
    const m = new THREE.Mesh(new THREE.PlaneGeometry(7*K, 2.6*K), addMat(0xffffff, 0));
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
