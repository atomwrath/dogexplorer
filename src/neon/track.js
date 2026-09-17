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
   repeated until nothing is. Sprint endpoints are pinned. Returns worst |k| remaining.

   THE SHRINK GUARD IS NOT OPTIONAL. Laplacian smoothing pulls a closed curve towards its
   own centre, so a loop whose every corner is too tight for the ribbon does not get
   rounded -- it converges on a point, and the "track" that comes out is a few metres of
   vertical curvature spikes. That never happened at 1:1, where only the odd switchback is
   over the limit; it happens readily at 1:6, where the whole course is. Below 65% of the
   length we started with, stop and hand back what we have: a course with one corner too
   tight for the ribbon is a rendering blemish, a course collapsed to a dot is not a
   course at all, and buildTrack rejects what comes back anyway. */
function relaxCurvature(pts, halfW, closed, ds, pad){
  const n = pts.length;
  /* Flat typed arrays, and ONE scratch buffer reused across iterations. The obvious
     version -- an array of [x,z] pairs, copied with pts.map(p => p.slice()) every pass --
     allocates a few thousand little arrays per iteration and hundreds of thousands per
     track, which is most of what a build used to cost. */
  const X = new Float64Array(n), Z = new Float64Array(n);
  for(let i = 0; i < n; i++){ X[i] = pts[i][0]; Z[i] = pts[i][1]; }
  const NX = new Float64Array(n), NZ = new Float64Array(n);
  const hot = new Uint8Array(n);
  const span = () => {
    let L = 0;
    for(let i = closed ? 0 : 1; i < n; i++){ const j = (i-1+n)%n; L += Math.hypot(X[i]-X[j], Z[i]-Z[j]); }
    return L;
  };
  const kAt = i => {
    const a = closed ? (i-1+n)%n : Math.max(0, i-1);
    const b = i;
    const c = closed ? (i+1)%n : Math.min(n-1, i+1);
    const ux = X[b]-X[a], uz = Z[b]-Z[a], vx = X[c]-X[b], vz = Z[c]-Z[b];
    const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz), lw = Math.hypot(X[c]-X[a], Z[c]-Z[a]);
    if(lu < 1e-6 || lv < 1e-6 || lw < 1e-6) return 0;
    return -2*(ux*vz - uz*vx)/(lu*lv*lw);
  };
  const L0 = span();
  let worst = 0;
  for(let iter = 0; iter < 2500; iter++){
    hot.fill(0);
    worst = 0;
    let any = false;
    for(let i = 0; i < n; i++){
      const k = Math.abs(kAt(i));
      const lim = 1/(halfW[i] + (pad == null ? NEON.minRadiusPad : pad));
      if(k > worst) worst = k;
      if(k > lim){
        any = true;
        /* The window is a DISTANCE, not a sample count. A corner that needs an 8 m radius
           cannot be opened out by nudging 6 samples either side when the samples are 1.2 m
           apart -- it converges, eventually, after thousands of passes. Sized in metres it
           takes tens, which is the difference between a menu that appears and one you wait
           for. */
        const w = Math.max(3, Math.min(60, Math.round((1/lim)/(ds || 4))));
        for(let o = -w; o <= w; o++){
          const j = closed ? (i+o+n)%n : i+o;
          if(j >= 0 && j < n) hot[j] = 1;
        }
      }
    }
    if(!any) break;
    if((iter & 15) === 15 && span() < L0*0.65) break;
    NX.set(X); NZ.set(Z);
    for(let i = 0; i < n; i++){
      if(!hot[i]) continue;
      if(!closed && (i === 0 || i === n-1)) continue;
      const a = (i-1+n)%n, c = (i+1)%n;
      NX[i] = X[i]*0.5 + (X[a]+X[c])*0.25;
      NZ[i] = Z[i]*0.5 + (Z[a]+Z[c])*0.25;
    }
    X.set(NX); Z.set(NZ);
  }
  for(let i = 0; i < n; i++){ pts[i][0] = X[i]; pts[i][1] = Z[i]; }
  return worst;
}

/* Gaussian-ish smoothing in O(n) per pass regardless of width: three box blurs make a
   good enough bell. The [1,2,1] version this replaces needed passes proportional to
   sigma SQUARED -- at 1:6, where samples are 1.2 m apart, that was ~670 passes over a few
   thousand samples per track, and it was most of the cost of opening the menu. */
function smoothSigma(arr, sigma, closed){
  const n = arr.length;
  if(!(sigma > 0) || n < 3) return arr;
  const r = Math.max(1, Math.round(sigma*1.2));      // 3 boxes of half-width r ~ sigma
  let a = Float64Array.from(arr), b = new Float64Array(n);
  const at = i => closed ? a[((i % n) + n) % n] : a[i < 0 ? 0 : i >= n ? n-1 : i];
  for(let pass = 0; pass < 3; pass++){
    let acc = 0;
    for(let i = -r; i <= r; i++) acc += at(i);
    const inv = 1/(2*r+1);
    for(let i = 0; i < n; i++){
      b[i] = acc*inv;
      acc += at(i+r+1) - at(i-r);
    }
    const t = a; a = b; b = t;
  }
  return a;
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
   open tracks have samples at 0..L inclusive.

   MAP SCALE. The graph is always real metres; a track is SCENE metres, real/scale. The
   division happens here, on the assembled line, and once it has happened every number
   downstream -- sample spacing, curvature limits, ribbon width, speed, the clock -- is
   already in the units the race is run in. Elevation is divided by the same factor, so a
   grade is a grade at any scale: 1:4 is the same trail as a model of itself, not a
   flatter one. What does NOT scale is the ribbon's width or the board on it, which is
   the whole point -- at 1:4 a park that took twelve minutes to cross is a circuit you can
   see the far side of, with corners four times tighter for a board that stayed the same
   size. relaxCurvature then rounds what is left untakeable. */
/* How much narrower everything across the track gets at 1:`sc` -- the ribbon, the board,
   the rider and the contact box, all by the same factor, so the field looks and behaves
   the same however small the map is. Distances ALONG the track scale by the full `sc`;
   that asymmetry is the setting's whole effect. */
function widthFactor(sc){ return Math.pow(sc > 0 ? sc : 1, 0.45); }

function buildTrack(graph, course, W, scale){
  const sc = scale > 0 ? scale : 1;
  const closed = course.kind === 'circuit';
  const raw = assembleLine(graph, course);
  if(sc !== 1) raw.pts = raw.pts.map(p => [p[0]/sc, p[1]/sc]);
  if(closed && raw.pts.length > 2){
    const f = raw.pts[0], l = raw.pts[raw.pts.length-1];
    if(Math.hypot(f[0]-l[0], f[1]-l[1]) < 1e-6){ raw.pts.pop(); raw.kinds.pop(); }
  }
  /* WIDTH FOLLOWS THE SCALE, part of the way. A scaled-down map brings its corners down
     with it, and a ribbon that stayed 8.4 m wide could not be laid through a switchback
     that is now 3 m across without folding through itself -- relaxCurvature would round
     the whole course away trying. Narrowing by s^0.45 keeps most of the real trail shape
     at 1:4 and 1:6, and the floor keeps the ribbon comfortably wider than the board that
     has to fit on it (NEON.bodyWide). The board and the riders do NOT scale: that is the
     point of the setting -- the same board on a smaller map. */
  const widthK = widthFactor(sc);
  const minHalf = NEON.bodyWide/widthK + 1.3/Math.sqrt(widthK);
  const pad = Math.max(1.2, NEON.minRadiusPad/widthK);
  const hwOf = k => Math.max(minHalf, (NEON.halfWidth[k] || NEON.halfWidth.trail)/widthK);
  /* Sample spacing follows the scale: a scaled-down map has the same trail detail packed
     into fewer scene metres, and 4 m samples would step straight over it. Floored, because
     curvature from near-touching samples is noise, not shape. */
  const sampleM = Math.max(1.2, Math.min(NEON.sampleM, NEON.sampleM/sc));
  let r = resampleLine(raw.pts, raw.kinds.map(hwOf), sampleM, closed);
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
  relaxCurvature(pts, halfW, closed, sampleM, pad);
  // relaxing shortens and bunches the samples; make them uniform again
  r = resampleLine(pts, halfW, sampleM, closed);
  pts = r.pts; halfW = r.vals;
  const worstK = relaxCurvature(pts, halfW, closed, sampleM, pad);
  const n = pts.length, ds = r.ds;
  const L = closed ? n*ds : (n-1)*ds;

  const x = new Float64Array(n), z = new Float64Array(n);
  for(let i = 0; i < n; i++){ x[i] = pts[i][0]; z[i] = pts[i][1]; }
  /* True elevation, smoothed along the line over about 22 REAL metres. Deliberately much
     more than terrace removal needs: the DEM sees the rock fins a trail runs BESIDE, and
     an 8 m cell next to a 40 m wall reads as a 35% grade the real tread never has. The
     window is real metres at every map scale, so 1:6 is the same hill in miniature rather
     than a smoothed-out ramp. */
  let elev = new Float64Array(n);
  for(let i = 0; i < n; i++) elev[i] = W ? demSmooth(W, x[i]*sc, z[i]*sc)/sc : 0;
  elev = smoothSigma(elev, (22/sc)/ds, closed);
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
  /* Raceable at this scale? The ribbon has to fit its own corners and enough of the course
     has to survive the rounding. A real trail scaled to 1:6 can have a switchback that no
     amount of smoothing opens out without eating the course, and the menu's background
     scan (main.js) quietly drops whatever comes back with ok false rather than offering a
     race that folds through itself. */
  let minHW = Infinity;
  for(let i = 0; i < n; i++) minHW = Math.min(minHW, halfW[i]);
  const ok = worstK*(minHW + pad) <= 1.05 && L >= 300
    && L >= (course.lenM/sc)*0.6 && isFinite(L);
  return {ok, pad, widthK, bodyLen: NEON.bodyLen/widthK, bodyWide: NEON.bodyWide/widthK,
          closed, n, ds, L, x, z, elev, yaw, k, slope, halfW: Float64Array.from(halfW),
          worstK, minE, maxE, climb, twistPerKm: twist/(L/1000), scale: sc, reversed: false,
          laps: course.laps || 1, course};
}

/* The same ribbon, raced the other way. Everything a track holds is either a value along
   the line (reversed in order) or a direction along it (reversed in order AND turned
   round): heading by half a turn, curvature and slope by sign. Sample 0 stays where it
   was, so a circuit keeps its start line and a sprint swaps its two gates.

   Done as an array transform rather than by re-running buildTrack on a flipped course,
   because relaxCurvature is not symmetric -- smoothing a line backwards gives a slightly
   different line, and then the two directions would not be the same racetrack. */
function reverseTrack(T){
  const n = T.n;
  const src = i => T.closed ? (n - i) % n : n-1-i;
  const map = (a, f) => { const b = new Float64Array(n); for(let i = 0; i < n; i++) b[i] = f(a[src(i)]); return b; };
  const R = Object.assign({}, T);
  R.x = map(T.x, v => v); R.z = map(T.z, v => v);
  R.elev = map(T.elev, v => v); R.halfW = map(T.halfW, v => v);
  R.yaw = map(T.yaw, v => { let a = v + Math.PI; while(a > Math.PI) a -= 2*Math.PI; return a; });
  R.k = map(T.k, v => -v);
  R.slope = map(T.slope, v => -v);
  let climb = 0;
  for(let i = 1; i < n; i++) if(R.elev[i] > R.elev[i-1]) climb += R.elev[i]-R.elev[i-1];
  if(T.closed && R.elev[0] > R.elev[n-1]) climb += R.elev[0]-R.elev[n-1];
  R.climb = climb;
  R.reversed = !T.reversed;
  return R;
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

export { widthFactor, demSmooth, smoothSigma, assembleLine, resampleLine, curvatureAt, relaxCurvature, buildTrack, reverseTrack,
         trackFrame, trackToWorld, deckY, bendAhead, calmestStart, rotateTrack };
