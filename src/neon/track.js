/* A course -> a raceable centreline. Pure: no THREE, no DOM.

   Everything downstream (physics, AI, ribbon mesh, minimap) works in TRACK SPACE:
       s  metres along the centreline          d  metres left (+) / right (-) of it
   That is what "restricted to the path" means here. A board is never tested against
   walls in world space -- it simply cannot hold a |d| beyond the half-width, so there is
   no corner, junction or overlapping switchback where it could leak off the trail.

   The price is that the centreline has to be well behaved: if its radius of curvature is
   ever tighter than the half-width, the inside edge of the ribbon folds through itself
   and ds/dt = v/(1 - d*k) blows up. Real trails have switchbacks far tighter than that,
   so the line is relaxed until it is drivable (see relaxCurvature). The trail you race
   is the real trail with its hairpins rounded off, which is also what makes it fun at
   80 km/h rather than 5. */
import { NEON } from './tuning.js';

/* Bilinear DEM read. world_bundle's heightAt is deliberately nearest-cell (terraces);
   a race deck wants the opposite: no steps at all. */
function demSmooth(W, x, z){
  const fx = (x - W.originX)/W.cell - 0.5, fz = (z - W.originZ)/W.cell - 0.5;
  let i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const ci = k => k < 0 ? 0 : k >= W.width ? W.width-1 : k;
  const cj = k => k < 0 ? 0 : k >= W.height ? W.height-1 : k;
  const H = W.heights, w = W.width;
  const h00 = H[cj(j)*w + ci(i)],   h10 = H[cj(j)*w + ci(i+1)];
  const h01 = H[cj(j+1)*w + ci(i)], h11 = H[cj(j+1)*w + ci(i+1)];
  return (h00*(1-u) + h10*u)*(1-v) + (h01*(1-u) + h11*u)*v;
}

function assembleLine(graph, course){
  const pts = [], kinds = [];          // kinds[i] = kind of the segment ENDING at pts[i]
  for(const st of course.steps){
    const e = graph.edges[st.ei];
    const src = st.fwd ? e.pts : e.pts.slice().reverse();
    for(let i = 0; i < src.length; i++){
      if(pts.length && i === 0) continue;               // shared junction vertex
      pts.push([src[i][0], src[i][1]]); kinds.push(e.kind || 'trail');
    }
  }
  if(course.clip){
    const [m0, m1] = course.clip;
    const out = [], ok = [];
    let acc = 0;
    for(let i = 1; i < pts.length; i++){
      const a = pts[i-1], b = pts[i], L = Math.hypot(b[0]-a[0], b[1]-a[1]);
      const s0 = acc, s1 = acc + L; acc = s1;
      if(s1 <= m0 || s0 >= m1 || L === 0) continue;
      const t0 = Math.max(0, (m0-s0)/L), t1 = Math.min(1, (m1-s0)/L);
      if(!out.length){ out.push([a[0]+(b[0]-a[0])*t0, a[1]+(b[1]-a[1])*t0]); ok.push(kinds[i]); }
      out.push([a[0]+(b[0]-a[0])*t1, a[1]+(b[1]-a[1])*t1]); ok.push(kinds[i]);
    }
    return {pts: out, kinds: ok};
  }
  return {pts, kinds};
}

/* Uniform resample. For a closed line the returned points do NOT repeat the first. */
function resampleLine(pts, vals, step, closed){
  const P = closed ? pts.concat([pts[0]]) : pts;
  const V = closed ? vals.concat([vals[0]]) : vals;
  let total = 0;
  for(let i = 1; i < P.length; i++) total += Math.hypot(P[i][0]-P[i-1][0], P[i][1]-P[i-1][1]);
  const n = Math.max(closed ? 8 : 2, Math.round(total/step) + (closed ? 0 : 1));
  const ds = total/(closed ? n : n-1);
  const out = [], ov = [];
  let seg = 1, acc = 0, segL = Math.hypot(P[1][0]-P[0][0], P[1][1]-P[0][1]);
  for(let k = 0; k < n; k++){
    const want = k*ds;
    while(seg < P.length-1 && acc + segL < want){
      acc += segL; seg++;
      segL = Math.hypot(P[seg][0]-P[seg-1][0], P[seg][1]-P[seg-1][1]);
    }
    const t = segL > 0 ? Math.min(1, Math.max(0, (want-acc)/segL)) : 0;
    out.push([P[seg-1][0] + (P[seg][0]-P[seg-1][0])*t, P[seg-1][1] + (P[seg][1]-P[seg-1][1])*t]);
    ov.push(V[seg]);
  }
  return {pts: out, vals: ov, ds, total};
}

function curvatureAt(pts, i, closed){
  const n = pts.length;
  const a = pts[closed ? (i-1+n)%n : Math.max(0, i-1)];
  const b = pts[i];
  const c = pts[closed ? (i+1)%n : Math.min(n-1, i+1)];
  const ux = b[0]-a[0], uz = b[1]-a[1], vx = c[0]-b[0], vz = c[1]-b[1];
  const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz), lw = Math.hypot(c[0]-a[0], c[1]-a[1]);
  if(lu < 1e-6 || lv < 1e-6 || lw < 1e-6) return 0;
  // Menger curvature; sign matches yaw = atan2(-dz, dx): left turns positive
  return -2*(ux*vz - uz*vx)/(lu*lv*lw);
}

/* Laplacian relaxation, applied only where (and around where) the line is too tight, and
   repeated until nothing is. Sprint endpoints are pinned. Returns worst |k| remaining. */
function relaxCurvature(pts, halfW, closed){
  const n = pts.length;
  let worst = 0;
  for(let iter = 0; iter < 2500; iter++){
    const hot = new Uint8Array(n);
    worst = 0;
    let any = false;
    for(let i = 0; i < n; i++){
      const k = Math.abs(curvatureAt(pts, i, closed));
      const lim = 1/(halfW[i] + NEON.minRadiusPad);
      if(k > worst) worst = k;
      if(k > lim){
        any = true;
        for(let o = -6; o <= 6; o++){
          const j = closed ? (i+o+n)%n : i+o;
          if(j >= 0 && j < n) hot[j] = 1;
        }
      }
    }
    if(!any) break;
    const nx = pts.map(p => p.slice());
    for(let i = 0; i < n; i++){
      if(!hot[i]) continue;
      if(!closed && (i === 0 || i === n-1)) continue;
      const a = pts[(i-1+n)%n], c = pts[(i+1)%n];
      nx[i][0] = pts[i][0]*0.5 + (a[0]+c[0])*0.25;
      nx[i][1] = pts[i][1]*0.5 + (a[1]+c[1])*0.25;
    }
    for(let i = 0; i < n; i++){ pts[i][0] = nx[i][0]; pts[i][1] = nx[i][1]; }
  }
  return worst;
}

function blur1(arr, passes, closed){
  const n = arr.length;
  let a = arr;
  for(let p = 0; p < passes; p++){
    const b = new Float64Array(n);
    for(let i = 0; i < n; i++){
      const l = closed ? a[(i-1+n)%n] : a[Math.max(0, i-1)];
      const r = closed ? a[(i+1)%n]   : a[Math.min(n-1, i+1)];
      b[i] = a[i]*0.5 + (l+r)*0.25;
    }
    a = b;
  }
  return a;
}

/* -> track. `closed` tracks have n samples over length L with sample n wrapping to 0;
   open tracks have samples at 0..L inclusive. */
function buildTrack(graph, course, W){
  const closed = course.kind === 'circuit';
  const raw = assembleLine(graph, course);
  if(closed && raw.pts.length > 2){
    const f = raw.pts[0], l = raw.pts[raw.pts.length-1];
    if(Math.hypot(f[0]-l[0], f[1]-l[1]) < 1e-6){ raw.pts.pop(); raw.kinds.pop(); }
  }
  const hwOf = k => NEON.halfWidth[k] || NEON.halfWidth.trail;
  let r = resampleLine(raw.pts, raw.kinds.map(hwOf), NEON.sampleM, closed);
  let pts = r.pts;
  let halfW = Array.from(blur1(Float64Array.from(r.vals), 6, closed));
  // take the Douglas-Peucker corners off everywhere, then fix what is still too tight
  for(let pass = 0; pass < 2; pass++){
    const nx = pts.map(p => p.slice());
    for(let i = 0; i < pts.length; i++){
      if(!closed && (i === 0 || i === pts.length-1)) continue;
      const n = pts.length, a = pts[(i-1+n)%n], c = pts[(i+1)%n];
      nx[i] = [pts[i][0]*0.5 + (a[0]+c[0])*0.25, pts[i][1]*0.5 + (a[1]+c[1])*0.25];
    }
    pts = nx;
  }
  relaxCurvature(pts, halfW, closed);
  // relaxing shortens and bunches the samples; make them uniform again
  r = resampleLine(pts, halfW, NEON.sampleM, closed);
  pts = r.pts; halfW = r.vals;
  const worstK = relaxCurvature(pts, halfW, closed);
  const n = pts.length, ds = r.ds;
  const L = closed ? n*ds : (n-1)*ds;

  const x = new Float64Array(n), z = new Float64Array(n);
  for(let i = 0; i < n; i++){ x[i] = pts[i][0]; z[i] = pts[i][1]; }
  /* True elevation, smoothed along the line. sigma ~ 22 m: a [1,2,1]/4 pass has variance
     0.5 samples^2, so p passes give sigma = ds*sqrt(p/2). That is much more than terrace
     removal needs, and deliberately so -- the DEM sees the rock fins a trail runs BESIDE,
     and an 8 m cell next to a 40 m wall reads as a 35% grade the real tread never has. */
  let elev = new Float64Array(n);
  for(let i = 0; i < n; i++) elev[i] = W ? demSmooth(W, x[i], z[i]) : 0;
  elev = blur1(elev, Math.round(2*(22/ds)*(22/ds)), closed);
  const yaw = new Float64Array(n), k = new Float64Array(n), slope = new Float64Array(n);
  for(let i = 0; i < n; i++){
    const a = closed ? (i-1+n)%n : Math.max(0, i-1);
    const c = closed ? (i+1)%n   : Math.min(n-1, i+1);
    const span = (c === a) ? 1 : (closed ? 2*ds : (c-a)*ds);
    yaw[i] = Math.atan2(-(z[c]-z[a]), x[c]-x[a]);
    k[i] = curvatureAt(pts, i, closed);
    slope[i] = (elev[c]-elev[a])/span;
  }
  let minE = Infinity, maxE = -Infinity, climb = 0;
  for(let i = 0; i < n; i++){
    if(elev[i] < minE) minE = elev[i];
    if(elev[i] > maxE) maxE = elev[i];
    if(i && elev[i] > elev[i-1]) climb += elev[i]-elev[i-1];
  }
  if(closed && elev[0] > elev[n-1]) climb += elev[0]-elev[n-1];
  let twist = 0;
  for(let i = 0; i < n; i++) twist += Math.abs(k[i])*ds;
  return {closed, n, ds, L, x, z, elev, yaw, k, slope, halfW: Float64Array.from(halfW),
          worstK, minE, maxE, climb, twistPerKm: twist/(L/1000),
          laps: course.laps || 1, course};
}

/* Interpolated frame at arc position s. `out` is reused by hot callers. */
function trackFrame(T, s, out){
  const o = out || {};
  let u = s/T.ds;
  if(T.closed){ u = ((u % T.n) + T.n) % T.n; }
  else u = Math.max(0, Math.min(T.n-1, u));
  const i = Math.floor(u), t = u - i;
  const j = T.closed ? (i+1)%T.n : Math.min(T.n-1, i+1);
  o.x = T.x[i] + (T.x[j]-T.x[i])*t;
  o.z = T.z[i] + (T.z[j]-T.z[i])*t;
  o.elev = T.elev[i] + (T.elev[j]-T.elev[i])*t;
  let dy = T.yaw[j]-T.yaw[i];
  if(dy > Math.PI) dy -= 2*Math.PI; else if(dy < -Math.PI) dy += 2*Math.PI;
  o.yaw = T.yaw[i] + dy*t;
  o.k = T.k[i] + (T.k[j]-T.k[i])*t;
  o.slope = T.slope[i] + (T.slope[j]-T.slope[i])*t;
  o.halfW = T.halfW[i] + (T.halfW[j]-T.halfW[i])*t;
  return o;
}
/* Track space -> world. Left normal of heading (cos yaw, -sin yaw) is (-sin yaw, -cos yaw). */
function trackToWorld(T, s, d, out){
  const f = trackFrame(T, s, out);
  f.wx = f.x - Math.sin(f.yaw)*d;
  f.wz = f.z - Math.cos(f.yaw)*d;
  return f;
}
/* Deck height in SCENE units (exaggerated, relative to the map's low point). */
function deckY(T, elev, baseM){ return (elev - baseM)*NEON.vertScale + NEON.lift; }

/* Strongest bend in the next `ahead` metres -- what a rider sets corner speed by. */
function bendAhead(T, s, ahead){
  let worst = 0, sign = 0;
  const steps = Math.max(1, Math.ceil(ahead/T.ds));
  for(let q = 0; q <= steps; q++){
    let i = Math.floor(s/T.ds) + q;
    if(T.closed) i = ((i % T.n) + T.n) % T.n; else if(i >= T.n) break;
    const a = Math.abs(T.k[i]) * (1 - 0.5*q/steps);      // nearer bends matter more
    if(a > worst){ worst = a; sign = T.k[i] < 0 ? -1 : 1; }
  }
  return {k: worst, sign};
}

/* The straightest place on a circuit to put the grid. Returns an arc offset. */
function calmestStart(T, span){
  if(!T.closed) return 0;
  const w = Math.max(2, Math.round(span/T.ds));
  let best = 0, bestV = Infinity;
  for(let i = 0; i < T.n; i++){
    let v = 0;
    for(let q = -Math.round(w*0.25); q < w; q++) v += Math.abs(T.k[(i+q+T.n)%T.n]);
    if(v < bestV - 1e-12){ bestV = v; best = i; }
  }
  return best*T.ds;
}
function rotateTrack(T, s0){
  if(!T.closed || !s0) return T;
  const sh = Math.round(s0/T.ds) % T.n;
  const rot = a => { const b = new Float64Array(T.n); for(let i = 0; i < T.n; i++) b[i] = a[(i+sh)%T.n]; return b; };
  for(const key of ['x','z','elev','yaw','k','slope','halfW']) T[key] = rot(T[key]);
  return T;
}

export { demSmooth, assembleLine, resampleLine, curvatureAt, relaxCurvature, buildTrack,
         trackFrame, trackToWorld, deckY, bendAhead, calmestStart, rotateTrack };
