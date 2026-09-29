/* AUTO-WALK: the pup follows the trail it is on by itself, and stops where the trail does.

   This module knows about the trail GRAPH and nothing about the player, the touch layer or
   the frame loop. main.js hands it a position and a heading and gets back a direction to
   walk; everything about WHEN it is on, and what cancels it, lives there. Keeping the two
   apart is what makes the follower testable as plain geometry.

   HOW IT FOLLOWS. The state is (edge, direction of travel along it). Each frame the pup is
   projected onto that edge's own centreline and steered at a point a little way AHEAD of
   the projection (pure pursuit). Pursuing a point ahead rather than the nearest point is
   what makes it round a bend smoothly and pull back to the tread when it has been knocked
   off; the lookahead grows with speed so a sprint takes a wide line and a stroll hugs it.

   WHERE IT STOPS. An edge ends at a graph node. What happens there depends on how many
   OTHER ways leave the node:
     one   -> the trail simply carries on under another edge's name (a survey cut, a change
              of label): hop across and keep walking.
     none  -> the trail ends. Stop.
     two+  -> an intersection. Stop, and let the player choose.
   Stopping means the follower reports it and main.js switches auto-walk off; the pup then
   coasts to a halt on the same speed easing every other stop uses.

   TWO EDGES ON ONE CORRIDOR. A trail waymarked along a road is a separate edge lying on top
   of the road's (world.js `buried`). Counting both would make every such stretch look like
   a fork, so buried edges do not count as ways out of a node, and an edge and the host it
   is buried in are the same way, not two. */
import { nearestTrail } from './spatial.js';

/* Same floor refreshOnTrail() in main.js uses for "the trail is underfoot", so the answer to
   "am I on a trail" is the same to the HUD chip and to this. World units throughout. */
const AW_ON_TRAIL_MIN = 2.5;
const AW_LOST_D = 8;            // further than this from the centreline: it has lost the trail
const AW_LOOK_BASE = 1.4;       // lookahead at a standstill...
const AW_LOOK_PER_SPEED = 0.35; // ...plus this much per unit of speed...
const AW_LOOK_MAX = 5;          // ...capped, so a sprint does not cut whole switchbacks
const AW_HOP_MIN = 0.6;         // within this of a pass-through node, hop onto the next edge
const AW_STOP_BASE = 0.25;      // stop this near the end of the trail, plus coasting distance:
const AW_STOP_COAST = 0.14;     //   speed eases off as 0.0009^t, so it drifts about speed/7
const AW_SEARCH_WIN = 12;       // segments either side of last position searched each frame
const AW_STUCK_S = 1.4;         // this long without getting anywhere...
const AW_STUCK_MOVE = 0.35;     // ...i.e. moving less than this: something is in the way
const AW_SAMPLE = 0.5;          // spacing of the points sampled along the path ahead
const AW_CHORD_TOL = 0.3;       // the straight line to the target may miss the path by this much
const AW_MIN_SAMPLES = 2;       // ...but the target is never nearer than this many samples ahead
const AW_PACE_LOOK = 6;         // how far ahead a bend is felt, for easing off into it
const AW_PACE_MIN = 0.4;        // the slowest pace a hairpin asks for, as a fraction of full
const AW_BEND_FREE = 0.5;       // a bend of less than this (radians, ~29 deg) costs no speed...
const AW_BEND_FULL = 2.3;       // ...and this (~132 deg) costs all of it
const AW_ALIGN_FREE = 0.3;      // the pup facing within this of where it is going (~17 deg) costs no speed...
const AW_ALIGN_FULL = 1.4;      // ...and facing this far off (~80 deg) costs all of it

const AW_LEN = new WeakMap();   // polyline -> {cum, total}
const AW_ARMS = new WeakMap();  // graph -> Map(node id -> [{edge, end}])

/* The centreline the tread is drawn and hashed from -- what the pup actually stands on --
   and not the raw survey line, which the grading pass simplifies. Both start and end on the
   edge's own nodes (measured on every edge of the default map). */
function awPts(e){ return (e.prof && e.prof.pts && e.prof.pts.length > 1) ? e.prof.pts : e.pts; }

function awLen(pts){
  let info = AW_LEN.get(pts);
  if(info) return info;
  const cum = [0];
  for(let i = 1; i < pts.length; i++)
    cum.push(cum[i-1] + Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]));
  info = {cum, total: cum[cum.length - 1]};
  AW_LEN.set(pts, info);
  return info;
}

/* Every way leaving each node, as {edge, end}: `end` 0 means the edge starts here, 1 that it
   ends here, so an edge that loops back onto one node is listed twice, once per end.
   Built once per graph. node.deg is not used because it counts a loop once. */
function awArms(g){
  let m = AW_ARMS.get(g);
  if(m) return m;
  m = new Map();
  const add = (n, edge, end) => { let a = m.get(n); if(!a){ a = []; m.set(n, a); } a.push({edge, end}); };
  for(const e of g.edges){ add(e.a, e, 0); add(e.b, e, 1); }
  AW_ARMS.set(g, m);
  return m;
}

/* The ways out of a node OTHER than the one we came in by (`edge`, at its `end`). */
function awOthers(g, edge, end){
  const node = end ? edge.b : edge.a;
  const all = awArms(g).get(node) || [];
  const out = [];
  for(const a of all){
    if(a.edge === edge && a.end === end) continue;         // the way we came in
    if(a.edge.buried && a.edge !== edge) continue;         // a marker laid on a road, not a way
    if(edge.buried && a.edge === edge.buried) continue;    // the road this trail is laid on
    out.push(a);
  }
  return out;
}

/* Nearest point on a polyline, searched around segment `hint` so that on a switchback the
   pup is never mistaken for being on the leg beside the one it is walking. The window is
   abandoned for a full search only when it finds nothing close, which is what recovers a
   pup that was knocked or teleported along the trail. */
function awProject(pts, info, x, z, hint){
  const n = pts.length - 1;
  const scan = (lo, hi) => {
    let best = Infinity, bi = lo, bt = 0;
    for(let i = lo; i <= hi; i++){
      const ax = pts[i][0], az = pts[i][1], dx = pts[i+1][0] - ax, dz = pts[i+1][1] - az;
      const L2 = dx*dx + dz*dz;
      let t = L2 === 0 ? 0 : ((x - ax)*dx + (z - az)*dz) / L2; t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const d2 = (x - ax - t*dx)**2 + (z - az - t*dz)**2;
      if(d2 < best){ best = d2; bi = i; bt = t; }
    }
    return {best, bi, bt};
  };
  let r = null;
  if(hint != null) r = scan(Math.max(0, hint - AW_SEARCH_WIN), Math.min(n - 1, hint + AW_SEARCH_WIN));
  if(!r || r.best > 16) r = scan(0, n - 1);
  const seg = info.cum[r.bi + 1] - info.cum[r.bi];
  return {i: r.bi, s: info.cum[r.bi] + r.bt*seg, d: Math.sqrt(r.best)};
}

function awPointAt(pts, info, s){
  s = s < 0 ? 0 : (s > info.total ? info.total : s);
  let i = 0;
  while(i < pts.length - 2 && info.cum[i+1] < s) i++;
  const seg = info.cum[i+1] - info.cum[i], t = seg > 0 ? (s - info.cum[i]) / seg : 0;
  return [pts[i][0] + (pts[i+1][0] - pts[i][0])*t, pts[i][1] + (pts[i+1][1] - pts[i][1])*t];
}

/* Point `L` further along the way we are walking, carrying on across pass-through nodes.
   `terminal` is true when the way runs out (a dead end or an intersection) before L does,
   and the point returned is then that node. */
function awAhead(g, st, s, L){
  let edge = st.edge, dir = st.dir, pos = s, left = L, pts = st.pts;
  for(let hops = 0; ; hops++){
    const info = awLen(pts);
    const room = dir > 0 ? info.total - pos : pos;
    if(left <= room) return {p: awPointAt(pts, info, pos + dir*left), terminal: false};
    const end = dir > 0 ? 1 : 0, others = awOthers(g, edge, end);
    if(others.length !== 1 || hops >= 3)
      return {p: awPointAt(pts, info, end ? info.total : 0), terminal: others.length !== 1};
    left -= room;
    const nx = others[0];
    edge = nx.edge; pts = awPts(edge); dir = nx.end === 0 ? 1 : -1;
    pos = nx.end === 0 ? 0 : awLen(pts).total;
  }
}

/* Points along the path ahead, every AW_SAMPLE units out to `L`, the first being where the
   pup is projected on it. Crosses pass-through nodes like everything else here. */
function awSamples(g, st, s, L){
  const out = [];
  for(let d = 0; d <= L + 1e-6; d += AW_SAMPLE) out.push(awAhead(g, st, s, d).p);
  return out;
}
/* How far the path between pts[0] and pts[n] strays from the straight line joining them. */
function awChordMiss(pts, n){
  const ax = pts[0][0], az = pts[0][1], dx = pts[n][0] - ax, dz = pts[n][1] - az, L2 = dx*dx + dz*dz;
  let worst = 0;
  for(let k = 1; k < n; k++){
    let t = L2 === 0 ? 0 : ((pts[k][0] - ax)*dx + (pts[k][1] - az)*dz) / L2; t = t < 0 ? 0 : (t > 1 ? 1 : t);
    worst = Math.max(worst, Math.hypot(pts[k][0] - ax - t*dx, pts[k][1] - az - t*dz));
  }
  return worst;
}
/* Easing into a bend: how much the heading changes over the next AW_PACE_LOOK units, as a
   fraction of full speed. Measured from the samples, so it sees a bend that is a run of small
   turns as well as one sharp vertex. A person slows for a hairpin; the pup's turn rate is
   capped, so at full pace it cannot make one inside the tread width. */
function awPace(pts){
  let h0 = null, worst = 0;
  for(let i = 0; i + 1 < pts.length && i * AW_SAMPLE < AW_PACE_LOOK; i++){
    const dx = pts[i+1][0] - pts[i][0], dz = pts[i+1][1] - pts[i][1];
    if(dx*dx + dz*dz < 1e-8) continue;                 // a repeated point at a dead end
    const h = Math.atan2(dz, dx);
    if(h0 === null){ h0 = h; continue; }
    let d = Math.abs(h - h0); if(d > Math.PI) d = Math.PI*2 - d;
    if(d > worst) worst = d;
  }
  const t = Math.min(1, Math.max(0, (worst - AW_BEND_FREE) / (AW_BEND_FULL - AW_BEND_FREE)));
  return 1 - (1 - AW_PACE_MIN) * t;
}

/* Start following, from (x,z) facing (hx,hz) -- or null when there is nothing ahead to follow.
   Direction comes from the FACING: along the trail this pup is on, whichever way it points;
   or, standing at a junction, along whichever branch it is pointing down. That second case
   is the one that matters, because it is where auto-walk has just stopped and where the
   player turns to a new trail and starts again.

   Two candidates compete. The trail underfoot always has a direction to offer (the way the
   pup points), PROVIDED there is some of it left ahead -- at the very end of an edge, the
   edge underfoot only leads into the node already stood on. And when the pup is at a node,
   each way leaving it competes on how nearly it lines up with the facing; the arms win a
   tie, being exact where the underfoot edge is whichever one the ground lookup happened to
   land on. An arm has to point roughly where the pup does (AW_MIN_ALIGN): facing a dead end
   or back down the trail you came in by is not a request to walk somewhere else. */
const AW_AT_NODE = 2.0;         // "at a junction": a sprint stop lands up to ~1.5 short of it
const AW_MIN_ALIGN = 0.2;       // cosine of the widest angle off the facing an arm may be
const AW_MIN_AHEAD = 1.0;       // trail left ahead, below which the edge underfoot is "at its end"
function autoWalkBegin(g, x, z, hx, hz){
  if(!g || !g.edges) return null;
  let best = null;
  const nt = nearestTrail(x, z);
  if(nt.edge && nt.d <= Math.max(nt.hw, AW_ON_TRAIL_MIN)){
    const pts = awPts(nt.edge), info = awLen(pts), pr = awProject(pts, info, x, z, null);
    const dot = hx*nt.tx + hz*nt.tz, dir = dot >= 0 ? 1 : -1;
    if((dir > 0 ? info.total - pr.s : pr.s) >= AW_MIN_AHEAD) best = {edge: nt.edge, dir, score: Math.abs(dot)};
  }
  for(let n = 0; n < g.nodes.length; n++){
    const np = g.nodes[n].p;
    if(Math.hypot(np[0] - x, np[1] - z) > AW_AT_NODE) continue;
    for(const a of (awArms(g).get(n) || [])){
      if(a.edge.buried && nt.edge !== a.edge) continue;
      const pts = awPts(a.edge), info = awLen(pts), dir = a.end === 0 ? 1 : -1;
      // the way this arm LEAVES the node, read 1.5 units along it rather than off the first
      // segment, which can be a fraction of a unit long and point anywhere
      const p = awPointAt(pts, info, a.end === 0 ? Math.min(1.5, info.total) : Math.max(info.total - 1.5, 0));
      const vx = p[0] - np[0], vz = p[1] - np[1], L = Math.hypot(vx, vz);
      if(L < 1e-6) continue;
      const score = (hx*vx + hz*vz) / L;
      if(score < AW_MIN_ALIGN) continue;
      // an arm beats the underfoot edge on a tie, but one arm only beats another outright
      if(!best || score > best.score + (best.arm ? 0 : -0.01)) best = {edge: a.edge, dir, score, arm: true};
    }
  }
  if(!best) return null;
  return {graph: g, edge: best.edge, pts: awPts(best.edge), dir: best.dir, hint: null,
          clock: 0, cx: x, cz: z};
}

/* One frame. `free` is false while the pup is being knocked about or climbing, when not
   getting anywhere is expected and must not count as being stuck.
   Returns {dx, dz, pace} (a unit world direction, and 0..1 of full speed to walk it at), or {end} naming why it is over:
   'end' (the trail ran out), 'junction' (an intersection), 'lost' (off the trail),
   'stuck' (walking into something for a while). */
function autoWalkSteer(st, g, x, z, speed, dt, free, heading){
  if(!st || st.graph !== g) return {end: 'lost'};
  let info = awLen(st.pts), pr = awProject(st.pts, info, x, z, st.hint);
  if(pr.d > AW_LOST_D) return {end: 'lost'};
  st.hint = pr.i;

  let remain = st.dir > 0 ? info.total - pr.s : pr.s;
  const hop = Math.max(AW_HOP_MIN, speed*0.1);
  for(let guard = 0; guard < 4 && remain <= hop; guard++){
    const end = st.dir > 0 ? 1 : 0, others = awOthers(g, st.edge, end);
    if(others.length !== 1) break;
    const nx = others[0];
    st.edge = nx.edge; st.pts = awPts(nx.edge); st.dir = nx.end === 0 ? 1 : -1; st.hint = null;
    info = awLen(st.pts); pr = awProject(st.pts, info, x, z, null); st.hint = pr.i;
    remain = st.dir > 0 ? info.total - pr.s : pr.s;
  }

  const endNow = st.dir > 0 ? 1 : 0, others = awOthers(g, st.edge, endNow);
  if(others.length !== 1 && remain <= AW_STOP_BASE + speed*AW_STOP_COAST)
    return {end: others.length ? 'junction' : 'end'};

  if(free){
    st.clock += dt;
    if(st.clock >= AW_STUCK_S){
      const moved = Math.hypot(x - st.cx, z - st.cz);
      st.clock = 0; st.cx = x; st.cz = z;
      if(moved < AW_STUCK_MOVE) return {end: 'stuck'};
    }
  }else{ st.clock = 0; st.cx = x; st.cz = z; }

  /* WHERE TO AIM, and it is not simply "a point L ahead on the path". A straight line to a
     point beyond a bend cuts the inside of it: on a gentle curve that is harmless, at a
     hairpin -- the next stretch leaving nearly straight back along the one just walked -- the
     line runs across the ground BETWEEN the two legs, off the tread and, on a terraced
     slope, down a step the pup cannot climb back (measured: 2.2 units below the tread
     against a 0.63 step-up limit, on a 159-degree turn). So the target is pulled back along
     the path until the straight line to it stays within AW_CHORD_TOL of the path itself,
     which puts it at the corner instead of past it. The chord is measured from the point on
     the centreline, not from the pup, so a pup that is merely off to one side is not
     mistaken for a bend. */
  const look = Math.min(AW_LOOK_MAX, AW_LOOK_BASE + speed*AW_LOOK_PER_SPEED);
  const pts = awSamples(g, st, pr.s, Math.max(look, AW_PACE_LOOK));
  let n = Math.min(pts.length - 1, Math.max(AW_MIN_SAMPLES, Math.round(look / AW_SAMPLE)));
  while(n > AW_MIN_SAMPLES && awChordMiss(pts, n) > AW_CHORD_TOL) n--;
  const tx = pts[n][0] - x, tz = pts[n][1] - z, L = Math.hypot(tx, tz);
  /* Pace has two halves. Easing into a bend is what is COMING; but the pup's turn rate is
     capped, so after the corner it is still swinging round for a moment with a straight path
     ahead, and at the pace the straight would allow it drifts to the corridor edge and off
     it. So it also waits, at a crawl, until it faces the way it is going. `heading` is the
     world heading being walked (main.js steerHeading), null when standing still. */
  let pace = awPace(pts);
  if(heading != null && L >= 0.05){
    let err = Math.abs(Math.atan2(tz, tx) - heading); if(err > Math.PI) err = Math.PI*2 - err;
    const a = Math.min(1, Math.max(0, (err - AW_ALIGN_FREE) / (AW_ALIGN_FULL - AW_ALIGN_FREE)));
    pace = Math.min(pace, 1 - (1 - AW_PACE_MIN) * a);
  }
  if(L < 0.05){
    const q = awPointAt(st.pts, info, pr.s + st.dir*0.5), p = awPointAt(st.pts, info, pr.s), M = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return {dx: (q[0] - p[0])/M, dz: (q[1] - p[1])/M, pace};
  }
  return {dx: tx/L, dz: tz/L, pace};
}

export { autoWalkBegin, autoWalkSteer };
