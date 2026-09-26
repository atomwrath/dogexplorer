/* A little passenger train on the railway.

   Two red-and-cream railcars, cab at each end, shuttling end to end along the longest run
   of track on the map: out, a pause at the terminus, and back. On the Barr map that is the
   Manitou and Pike's Peak line -- the cog railway -- all 14 km of it.

   TRAIN_ROUTE. The rail edges of the graph form a network (a line split at every junction and
   crossing, plus any sidings). The train runs its DIAMETER: the pair of rail endpoints
   farthest apart along the track, found by the usual double sweep (from any end, go to
   the farthest; from there, go to the farthest again). Each edge is walked in whichever
   direction the path needs, on exactly the polyline and heights the track itself was
   drawn from (world.js keeps them on the edge as `railDraw`), so the wheels sit on the
   rails the player can see, bridge decks and all.

   MOTION. A top speed, gentle acceleration, and braking computed from the distance left
   (v = sqrt(2*a*d)), so it eases into each terminus rather than stopping dead. Every car
   is placed by its two bogies -- each at its own point on the track -- and turned and
   pitched to the line between them, so a car on a 25% grade tilts up the hill and a car
   on a bend follows it.

   THE PUP. A train that runs a dog down is not a thing this game does. The track ahead of
   the leading end is watched; a pup standing on it brings the train to a halt a few
   metres short, and it waits until the pup steps off. A pup that walks into the side of
   a car is nudged back out of it (trainPush), never passed through. */
import { toon, M } from '../core/materials.js';

const TRAIN = {
  cars: 2, carLen: 11.5, gap: 0.9, width: 2.7,
  speed: 6.5,          // world units per second at full line speed
  accel: 0.8,          // units/s^2 -- a heavy train, not a car
  dwell: 12,           // seconds at each terminus
  bogie: 0.36,         // bogie centres, as a fraction of the car length either side
  look: 40,            // how far ahead of the leading end it watches for the pup
  stopShort: 6,        // and how far short of the pup it stops
  pupR: 1.3,           // how close to the track centreline counts as ON the track
  minRoute: 40,        // no train on a stub shorter than this plus the train itself
};
const RAIL_TOP = 0.28;  // rail top above the tread profile: ballast 0.05 + sleeper 0.10 + rail 0.13

let TRAIN_ROUTE = null, TRAIN_CARS = [], TRAIN_STATE = null;

/* ---------- route ---------- */
function polyLen2(pts){ let L=0; for(let i=1;i<pts.length;i++) L+=Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]); return L; }
/* edges: rail edges with {a, b, railDraw:{pts, ys, lift}}. Returns {pts:[[x,y,z]], cum, len}
   for the longest route, or null. */
function planTrainRoute(edges){
  const E = edges.filter(e => e.railDraw && e.railDraw.pts.length >= 2);
  if(!E.length) return null;
  const adj = new Map();
  const add = (n, e, other) => { if(!adj.has(n)) adj.set(n, []); adj.get(n).push({e, other}); };
  for(const e of E){ e._rlen = polyLen2(e.railDraw.pts); add(e.a, e, e.b); add(e.b, e, e.a); }
  const sweep = start => {
    const dist = new Map([[start, 0]]), via = new Map(), todo = [start];
    // Dijkstra on a graph of a handful of nodes: a linear scan for the minimum is plenty
    const done = new Set();
    while(todo.length){
      let bi = 0; for(let i=1;i<todo.length;i++) if(dist.get(todo[i]) < dist.get(todo[bi])) bi = i;
      const u = todo.splice(bi, 1)[0];
      if(done.has(u)) continue; done.add(u);
      for(const {e, other} of adj.get(u) || []){
        const d = dist.get(u) + e._rlen;
        if(!dist.has(other) || d < dist.get(other)){ dist.set(other, d); via.set(other, {e, from:u}); todo.push(other); }
      }
    }
    let far = start; for(const [n, d] of dist) if(d > dist.get(far)) far = n;
    return {far, dist, via};
  };
  // the diameter of each connected piece; keep the longest
  let best = null;
  const seen = new Set();
  for(const n of adj.keys()){
    if(seen.has(n)) continue;
    const a = sweep(n); for(const k of a.dist.keys()) seen.add(k);
    const b = sweep(a.far);
    const L = b.dist.get(b.far);
    if(!best || L > best.L) best = {L, from:a.far, to:b.far, via:b.via};
  }
  if(!best || best.L <= 0) return null;
  // walk back from `to` to `from`, then lay the edges out in travel order
  const chain = [];
  for(let n = best.to; n !== best.from; ){ const v = best.via.get(n); chain.push({e:v.e, fwd: v.e.a === v.from}); n = v.from; }
  chain.reverse();
  const pts = [];
  for(const {e, fwd} of chain){
    const P = e.railDraw.pts, Y = e.railDraw.ys, top = (e.railDraw.lift || 0) + RAIL_TOP;
    const idx = [...P.keys()]; if(!fwd) idx.reverse();
    for(const i of idx){
      const q = [P[i][0], (Y ? Y[i] : 0) + top, P[i][1]];
      const last = pts[pts.length-1];
      if(last && Math.hypot(last[0]-q[0], last[2]-q[2]) < 1e-6) continue;
      pts.push(q);
    }
  }
  const cum = [0];
  for(let i=1;i<pts.length;i++) cum.push(cum[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][2]-pts[i-1][2]));
  return {pts, cum, len: cum[cum.length-1], edges: chain.length};
}
/* the point `s` along the route, clamped to it */
function routeAt(R, s){
  s = Math.max(0, Math.min(R.len, s));
  let lo = 0, hi = R.cum.length-1;
  while(hi - lo > 1){ const m = (lo+hi) >> 1; if(R.cum[m] <= s) lo = m; else hi = m; }
  const a = R.pts[lo], b = R.pts[hi], seg = R.cum[hi]-R.cum[lo], t = seg > 0 ? (s-R.cum[lo])/seg : 0;
  return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
}

/* ---------- the railcar ----------
   Built along +z, rail top at y=0, a cab at each end so it can lead either way. Real
   metres, like every other object the pup stands beside. */
function buildCar(){
  const g = new THREE.Group(), L = TRAIN.carLen, W = TRAIN.width;
  const red = toon('#c23b22'), cream = toon('#f1e3c1'), glass = toon('#2d3a46'), roofM = toon('#b9b8b0'),
        dark = toon('#2b2b2b'), door = toon('#8e2a18'), lamp = toon('#ffe7a0');
  const box = (w, h, d, mat, x, y, z) => { const m = M(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); return m; };
  for(const bz of [-L*TRAIN.bogie, L*TRAIN.bogie]){
    box(2.0, 0.55, 2.6, dark, 0, 0.42, bz);
    for(const wz of [-0.75, 0.75]) for(const sx of [-1, 1]){
      const w = M(new THREE.CylinderGeometry(0.42, 0.42, 0.14, 10), dark);
      w.rotation.z = Math.PI/2; w.position.set(sx*0.78, 0.42, bz+wz); g.add(w);
    }
  }
  box(W-0.2, 0.4, L-0.4, dark, 0, 0.95, 0);                 // underframe
  box(W, 2.3, L-0.8, red, 0, 2.3, 0);                      // body
  box(W+0.04, 0.18, L-0.7, cream, 0, 1.55, 0);             // waist stripe
  box(W+0.03, 0.85, L-2.6, glass, 0, 2.6, 0);              // side windows
  box(W-0.2, 0.3, L-0.9, roofM, 0, 3.6, 0);                // roof
  for(const sz of [-1, 1]){
    box(W-0.5, 0.9, 0.06, glass, 0, 2.6, sz*(L/2-0.37));   // cab windscreen
    box(W-0.1, 0.5, 0.05, cream, 0, 1.6, sz*(L/2-0.38));   // cream end band
    for(const sx of [-1, 1]){
      const hl = M(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10), lamp);
      hl.rotation.x = Math.PI/2; hl.position.set(sx*0.85, 1.6, sz*(L/2-0.33)); g.add(hl);
      box(0.05, 2.0, 1.0, door, sx*(W/2+0.02), 2.1, sz*L*0.2);      // doors
    }
  }
  g.name = 'train-car';
  return g;
}

/* ---------- lifecycle ---------- */
/* Called by world.js once the track is drawn. Replaces any previous train. */
function buildTrain(edges, parent){
  TRAIN_ROUTE = null; TRAIN_CARS = []; TRAIN_STATE = null;
  const R = planTrainRoute(edges);
  const Lt = TRAIN.cars*TRAIN.carLen + (TRAIN.cars-1)*TRAIN.gap;
  if(!R || R.len < Lt + TRAIN.minRoute) return null;
  TRAIN_ROUTE = R;
  for(let i=0;i<TRAIN.cars;i++){ const c = buildCar(); parent.add(c); TRAIN_CARS.push(c); }
  // start at the beginning of the route, about to set off
  TRAIN_STATE = {r: 0, dir: 1, v: 0, dwellT: 3, blocked: false, trips: 0, Lt};
  placeCars();
  return TRAIN_STATE;
}
function placeCars(){
  if(!TRAIN_STATE) return;
  // car i counted from the r end; each car's two bogies at their own track points
  for(let i=0;i<TRAIN_CARS.length;i++){
    const c0 = TRAIN_STATE.r + i*(TRAIN.carLen + TRAIN.gap), mid = c0 + TRAIN.carLen/2;
    const f = routeAt(TRAIN_ROUTE, mid + TRAIN.carLen*TRAIN.bogie), b = routeAt(TRAIN_ROUTE, mid - TRAIN.carLen*TRAIN.bogie);
    const dx = f[0]-b[0], dy = f[1]-b[1], dz = f[2]-b[2], h = Math.hypot(dx, dz) || 1e-9;
    const car = TRAIN_CARS[i];
    car.position.set((f[0]+b[0])/2, (f[1]+b[1])/2, (f[2]+b[2])/2);
    car.rotation.order = 'YXZ';
    car.rotation.y = Math.atan2(dx, dz);          // local +z along the track
    car.rotation.x = -Math.atan2(dy, h);          // and pitched up or down its grade
  }
}
/* Distance along the track from the leading end to the pup, if the pup is ON the track
   ahead within TRAIN.look; otherwise Infinity. Sampled every metre and a half. */
function pupAhead(px, pz){
  const lead = TRAIN_STATE.dir > 0 ? TRAIN_STATE.r + TRAIN_STATE.Lt : TRAIN_STATE.r;
  for(let d = 0; d <= TRAIN.look; d += 1.5){
    const q = routeAt(TRAIN_ROUTE, lead + TRAIN_STATE.dir*d);
    if(Math.hypot(q[0]-px, q[2]-pz) < TRAIN.pupR) return d;
  }
  return Infinity;
}
function updateTrain(dt, px, pz){
  if(!TRAIN_STATE) return;
  const end = TRAIN_STATE.dir > 0 ? TRAIN_ROUTE.len - TRAIN_STATE.Lt : 0;
  const left = Math.abs(end - TRAIN_STATE.r);
  if(TRAIN_STATE.dwellT > 0){
    TRAIN_STATE.dwellT -= dt; TRAIN_STATE.v = 0;
    if(TRAIN_STATE.dwellT <= 0 && left < 0.05){ TRAIN_STATE.dir = -TRAIN_STATE.dir; TRAIN_STATE.trips++; }
    placeCars(); return;
  }
  const ahead = (px == null) ? Infinity : pupAhead(px, pz);
  TRAIN_STATE.blocked = ahead < Infinity;
  const room = Math.min(left, TRAIN_STATE.blocked ? Math.max(0, ahead - TRAIN.stopShort) : Infinity);
  const vCap = Math.min(TRAIN.speed, Math.sqrt(2*TRAIN.accel*room));
  TRAIN_STATE.v = TRAIN_STATE.v < vCap ? Math.min(vCap, TRAIN_STATE.v + TRAIN.accel*dt) : vCap;
  TRAIN_STATE.r += TRAIN_STATE.dir*Math.min(TRAIN_STATE.v*dt, left);
  if(Math.abs(end - TRAIN_STATE.r) < 0.05 && TRAIN_STATE.v < 0.5){ TRAIN_STATE.r = end; TRAIN_STATE.v = 0; TRAIN_STATE.dwellT = TRAIN.dwell; }
  placeCars();
}
/* How far to move the pup so it is not inside a car, or null. Each car is a box
   TRAIN.width wide (plus a little) along its own bogie line. */
function trainPush(px, pz){
  if(!TRAIN_STATE) return null;
  const half = TRAIN.width/2 + 0.45;
  for(const car of TRAIN_CARS){
    const yaw = car.rotation.y, ax = Math.sin(yaw), az = Math.cos(yaw);
    const rx = px - car.position.x, rz = pz - car.position.z;
    const along = rx*ax + rz*az, side = rx*az - rz*ax;
    if(Math.abs(along) > TRAIN.carLen/2 || Math.abs(side) >= half) continue;
    const out = (side >= 0 ? half : -half) - side;          // straight out the nearer side
    return [out*az, -out*ax];
  }
  return null;
}
function getTrainState(){
  if(!TRAIN_STATE) return {on:false};
  return {on:true, top:TRAIN.speed, r:TRAIN_STATE.r, dir:TRAIN_STATE.dir, v:TRAIN_STATE.v, blocked:TRAIN_STATE.blocked, trips:TRAIN_STATE.trips,
          dwell:TRAIN_STATE.dwellT > 0, len:TRAIN_ROUTE.len, routeEdges:TRAIN_ROUTE.edges, trainLen:TRAIN_STATE.Lt,
          cars:TRAIN_CARS.map(c => ({x:c.position.x, y:c.position.y, z:c.position.z, yaw:c.rotation.y, pitch:c.rotation.x}))};
}
/* test seam: put the train somewhere and let the next update run from there */
function setTrainForTest(r, dir, v){ if(!TRAIN_STATE) return; TRAIN_STATE.r = r; TRAIN_STATE.dir = dir; TRAIN_STATE.v = v; TRAIN_STATE.dwellT = 0; placeCars(); }
function trainRouteAt(s){ return TRAIN_ROUTE ? routeAt(TRAIN_ROUTE, s) : null; }

export { TRAIN, planTrainRoute, buildTrain, updateTrain, trainPush, getTrainState, setTrainForTest, trainRouteAt };
