/* AUTOMATIC RACE COURSES. Pure -- no THREE, no DOM, no randomness.

   Input is the same {nodes, edges} graph trails/geo.js builds for Pup Trails. Output is a
   list of courses that between them cover the map: every raceable edge ends up on at
   least one course, and each course is something you would actually want to race --
   about the target length, no doubling back over itself, no hairpin turns at junctions
   when a straighter way through exists, and following one named trail for as long as
   it goes somewhere.

   Two shapes, tried in this order for every stretch of trail still uncovered:

     CIRCUIT  a closed loop, raced as laps. Built as two edge-disjoint paths between the
              seed edge and a far node, choosing the far node so the whole loop lands
              near the target length. A loop that comes out short is simply given laps.
     SPRINT   point to point. Grown outwards from the seed in both directions, always
              preferring uncovered trail, then the same named route, then the
              straightest way on. This is what mops up the dead-end arms and the parts
              of the network that are trees rather than meshes.

   DETERMINISTIC ON PURPOSE. Best times are stored against a course's signature (its
   edge sequence), so the same map must produce the same courses on every load. Every
   tie below is broken by index, never by Math.random. */

const ROUTE_STUB_M     = 70;     // a dead-end shorter than this is scenery, not a race
const ROUTE_MIN_M      = 450;    // nothing shorter than this is offered as a course
const ROUTE_TURN_M     = 140;    // what a full U-turn at a junction costs, in metres of path
const ROUTE_COVERED_X  = 2.6;    // cost multiplier for re-using already covered trail
const ROUTE_MAX_LAPS   = 5;
const ROUTE_MAX        = 40;     // hard stop; a map needing more than this is mis-scaled

function routeTargetM(totalM){
  return Math.max(1500, Math.min(5000, totalM/12));
}

/* Direction a traveller is facing as they LEAVE edge e going `fwd`, and as they ENTER it.
   Measured over ~12 m rather than the last vertex pair, because Douglas-Peucker leaves
   the final segment of an edge any length at all and a 40 cm stub says nothing about
   which way the trail is heading. */
function edgeHeading(e, fwd, atExit){
  const pts = e.pts, n = pts.length;
  const fromEnd = (atExit === fwd);       // looking at the b-end of the stored polyline
  let i = fromEnd ? n-1 : 0;
  const step = fromEnd ? -1 : 1;
  const p0 = pts[i];
  let acc = 0, q = pts[i+step];
  while(i+step >= 0 && i+step < n){
    q = pts[i+step];
    acc = Math.hypot(q[0]-p0[0], q[1]-p0[1]);
    if(acc >= 12) break;
    i += step;
  }
  // vector pointing INTO the edge from that end
  let dx = q[0]-p0[0], dz = q[1]-p0[1];
  const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  // entering: travel direction is into the edge. exiting: travel direction is out of it.
  return atExit ? [-dx, -dz] : [dx, dz];
}

function turnCost(eIn, fIn, eOut, fOut){
  const a = edgeHeading(eIn, fIn, true), b = edgeHeading(eOut, fOut, false);
  const dot = Math.max(-1, Math.min(1, a[0]*b[0] + a[1]*b[1]));
  const ang = Math.acos(dot) / Math.PI;          // 0 straight on .. 1 full reversal
  return ang*ang*ROUTE_TURN_M;
}

/* A binary heap is overkill for 600 states, and an O(n) scan per pop is not: Pikes Peak
   runs a few thousand of these searches at load. */
function heapPush(h, item){
  h.push(item);
  let i = h.length-1;
  while(i > 0){
    const p = (i-1)>>1;
    if(h[p][0] <= h[i][0]) break;
    const t = h[p]; h[p] = h[i]; h[i] = t; i = p;
  }
}
function heapPop(h){
  const top = h[0], last = h.pop();
  if(h.length){
    h[0] = last;
    let i = 0;
    for(;;){
      const l = i*2+1, r = l+1;
      let m = i;
      if(l < h.length && h[l][0] < h[m][0]) m = l;
      if(r < h.length && h[r][0] < h[m][0]) m = r;
      if(m === i) break;
      const t = h[m]; h[m] = h[i]; h[i] = t; i = m;
    }
  }
  return top;
}

/* Dijkstra over DIRECTED EDGES, not nodes, because the turn penalty depends on which
   edge you arrived by. State s = edgeIndex*2 + (fwd?0:1). Starts having just traversed
   `startState`; returns per-state cost and predecessor. `banned` is a Uint8Array over
   edges; `softNodes` makes passing through those nodes expensive (keeps the two halves
   of a circuit from touching in the middle, which would make a figure-of-eight). */
function routeSearch(ctx, startState, banned, softNodes){
  const {edges, adj, cover, skip} = ctx;
  const N = edges.length*2;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const h = [];
  dist[startState] = 0;
  heapPush(h, [0, startState]);
  while(h.length){
    const [d, s] = heapPop(h);
    if(d > dist[s]) continue;
    const ei = s>>1, fwd = !(s&1), e = edges[ei];
    const at = fwd ? e.b : e.a;
    for(const nb of adj[at]){
      if(nb.ei === ei || banned[nb.ei] || skip[nb.ei]) continue;
      const f = edges[nb.ei];
      if(f.a === f.b) continue;                       // self-loops are their own circuits
      const nf = (f.a === at);
      const ns = nb.ei*2 + (nf ? 0 : 1);
      let w = f.lenM * (cover[nb.ei] ? ROUTE_COVERED_X : 1);
      if(f.route === e.route) w *= 0.88;
      const tc = turnCost(e, fwd, f, nf);
      if(tc > ROUTE_TURN_M*0.72) continue;            // ~150 deg or sharper is not a way on
      w += tc;
      if(softNodes && softNodes[at]) w += 400;
      const nd = d + w;
      if(nd < dist[ns]){ dist[ns] = nd; prev[ns] = s; heapPush(h, [nd, ns]); }
    }
  }
  return {dist, prev};
}
function unwind(prev, s, stopAt){
  const out = [];
  while(s !== -1 && s !== stopAt){ out.push(s); s = prev[s]; }
  return out.reverse();
}
const stateLen = (ctx, states) => states.reduce((a, s) => a + ctx.edges[s>>1].lenM, 0);

/* Circuit through seed edge `si`: out along one path to a far node, home along another. */
function findCircuit(ctx, si, target){
  const {edges, nodes, cover} = ctx;
  const seed = edges[si];
  if(seed.a === seed.b){
    return seed.lenM >= ROUTE_MIN_M*0.6 ? [si*2] : null;
  }
  const s0 = si*2;                                    // traverse the seed a -> b
  const banned = new Uint8Array(edges.length);
  banned[si] = 1;                                     // never come back along the seed itself
  const A = routeSearch(ctx, s0, banned, null);
  // candidate turnaround states, by how far out they are in real metres
  const cands = [];
  for(let s = 0; s < edges.length*2; s++){
    if(!isFinite(A.dist[s]) || s === s0) continue;
    const out = unwind(A.prev, s, s0);
    const m = stateLen(ctx, out);
    if(m < target*0.18 || m > target*0.75) continue;
    cands.push({s, out, m});
  }
  // spread the (bounded) effort across the distance range rather than the first N found
  cands.sort((p, q) => p.m - q.m || p.s - q.s);
  const stride = Math.max(1, Math.floor(cands.length/28));
  let best = null;
  for(let k = 0; k < cands.length; k += stride){
    const c = cands[k];
    const ban2 = new Uint8Array(edges.length);
    const soft = new Uint8Array(nodes.length);
    ban2[si] = 1;
    for(const s of c.out){
      ban2[s>>1] = 1;
      const e = edges[s>>1];
      soft[e.a] = 1; soft[e.b] = 1;
    }
    // the two ends of the horseshoe are where the halves are SUPPOSED to meet
    const last = c.s, le = edges[last>>1];
    const farNode = (last&1) ? le.a : le.b;
    soft[farNode] = 0; soft[seed.a] = 0;
    const B = routeSearch(ctx, last, ban2, soft);
    // home = any state that ARRIVES at seed.a
    let home = -1, hd = Infinity;
    for(let s = 0; s < edges.length*2; s++){
      if(!isFinite(B.dist[s]) || s === last) continue;
      const e = edges[s>>1];
      const arrives = (s&1) ? e.a : e.b;
      if(arrives !== seed.a) continue;
      const close = turnCost(e, !(s&1), seed, true);
      if(close > ROUTE_TURN_M*0.72) continue;         // the lap must not END on a hairpin
      const total = B.dist[s] + close;
      if(total < hd){ hd = total; home = s; }
    }
    if(home < 0) continue;
    const back = unwind(B.prev, home, last);
    const loop = [s0].concat(c.out, back);
    const len = stateLen(ctx, loop);
    if(len < ROUTE_MIN_M || len > target*1.7) continue;
    let fresh = 0, touch = 0, twice = false;
    const seen = new Uint8Array(nodes.length);
    const seenE = new Uint8Array(edges.length);
    for(const s of loop){
      const e = edges[s>>1];
      /* Turn penalties make it occasionally cheaper to run past a junction, loop round
         and come back along the same edge the other way. Legal for the search (different
         directed state), useless as a race: the ribbon would lie on top of itself. */
      if(seenE[s>>1]) twice = true;
      seenE[s>>1] = 1;
      if(!cover[s>>1]) fresh += e.lenM;
      const arr = (s&1) ? e.a : e.b;
      if(seen[arr]) touch++;
      seen[arr] = 1;
    }
    if(twice) continue;
    const freshFrac = fresh/len;
    if(freshFrac < 0.45) continue;
    const score = Math.abs(len-target)/target + (1-freshFrac)*1.4 + touch*0.5
                + (hd + A.dist[last] - len)/target*0.6;       // turn + reuse penalties paid
    if(!best || score < best.score - 1e-9) best = {score, loop};
  }
  return best ? best.loop : null;
}

/* Point-to-point, grown from the seed outwards. */
function growSprint(ctx, si, target){
  const {edges, adj, cover, skip} = ctx;
  const used = new Uint8Array(edges.length);
  used[si] = 1;
  let len = edges[si].lenM;
  const path = [si*2];
  const extend = (front) => {
    for(;;){
      if(len >= target) return;
      const s = front ? path[path.length-1] : path[0];
      const ei = s>>1, fwd = !(s&1), e = edges[ei];
      // growing the tail means walking the first edge BACKWARDS out of its start
      const at = front ? (fwd ? e.b : e.a) : (fwd ? e.a : e.b);
      let pick = null;
      for(const nb of adj[at]){
        if(used[nb.ei] || skip[nb.ei]) continue;
        const f = edges[nb.ei];
        if(f.a === f.b) continue;
        const nf = (f.a === at);
        const tc = front ? turnCost(e, fwd, f, nf) : turnCost(f, !nf, e, fwd);
        if(tc > ROUTE_TURN_M*0.72) continue;           // sharper than ~150 deg: not a way on
        if(cover[nb.ei] && len >= target*0.55) continue;
        const score = (cover[nb.ei] ? 1000 : 0) + (f.route === e.route ? 0 : 60) + tc
                    - Math.min(f.lenM, 300)*0.05;
        if(!pick || score < pick.score - 1e-9) pick = {score, ei:nb.ei, nf};
      }
      if(!pick) return;
      used[pick.ei] = 1; len += edges[pick.ei].lenM;
      if(front) path.push(pick.ei*2 + (pick.nf ? 0 : 1));
      else      path.unshift(pick.ei*2 + (pick.nf ? 1 : 0));   // reversed: we LEAVE via `at`
    }
  };
  extend(true); extend(false); extend(true);
  return path;
}

function courseName(ctx, states, circuit, taken){
  const by = new Map();
  for(const s of states){
    const e = ctx.edges[s>>1];
    const k = e.name || 'Trail';
    const w = e.lenM * (e.named ? 1 : 0.35);           // a real name beats an invented one
    by.set(k, (by.get(k)||0) + w);
  }
  const top = [...by.entries()].sort((p, q) => q[1]-p[1] || (p[0] < q[0] ? -1 : 1));
  const total = top.reduce((a, t) => a + t[1], 0) || 1;
  const strip = n => n.replace(/\s+(trail|road|loop|path|way|drive|dr|rd)\.?$/i, '').trim() || n;
  let base = strip(top[0][0]);
  if(top[1] && top[1][1]/total > 0.28) base += ' \u2013 ' + strip(top[1][0]);
  let name = base + (circuit ? ' Circuit' : ' Sprint');
  const NUM = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];
  let k = 0;
  while(taken.has(name + (NUM[k] ?? ' '+(k+1)))) k++;
  name += (NUM[k] ?? ' '+(k+1));
  taken.add(name);
  return name;
}

/* heightAt(x,z) is optional; with it, sprints are pointed downhill-ish start to finish
   only when neither end is a trailhead -- a dead-end is the natural place to line up. */
function buildCourses(graph, heightAt, opts){
  const o = opts || {};
  const edges = graph.edges, nodes = graph.nodes;
  const adj = nodes.map(() => []);
  edges.forEach((e, ei) => { adj[e.a].push({ei}); if(e.b !== e.a) adj[e.b].push({ei}); });
  const deg = nodes.map((_, i) => adj[i].length);
  const skip = new Uint8Array(edges.length);
  // prune short dead-end twigs, repeatedly: removing one can expose the next
  for(let round = 0; round < 6; round++){
    let any = false;
    edges.forEach((e, ei) => {
      if(skip[ei] || e.a === e.b) return;
      if((deg[e.a] === 1 || deg[e.b] === 1) && e.lenM < ROUTE_STUB_M){
        skip[ei] = 1; deg[e.a]--; deg[e.b]--; any = true;
      }
    });
    if(!any) break;
  }
  const cover = new Uint16Array(edges.length);
  const ctx = {edges, nodes, adj, cover, skip};
  const totalM = edges.reduce((a, e, i) => a + (skip[i] ? 0 : e.lenM), 0);
  const target = o.targetM || routeTargetM(totalM);
  const courses = [], taken = new Set();
  const order = edges.map((_, i) => i).filter(i => !skip[i])
    .sort((p, q) => edges[q].lenM - edges[p].lenM || p - q);

  const commit = (states, circuit) => {
    const lenM = stateLen(ctx, states);
    for(const s of states) cover[s>>1]++;
    let st = states;
    if(!circuit){
      const first = edges[st[0]>>1], last = edges[st[st.length-1]>>1];
      const n0 = (st[0]&1) ? first.b : first.a;
      const n1 = (st[st.length-1]&1) ? last.a : last.b;
      const head0 = adj[n0].length === 1, head1 = adj[n1].length === 1;
      let flip = false;
      if(head1 && !head0) flip = true;
      else if(head0 === head1 && heightAt){
        flip = heightAt(nodes[n1].p[0], nodes[n1].p[1]) > heightAt(nodes[n0].p[0], nodes[n0].p[1]);
      }
      if(flip) st = st.slice().reverse().map(s => s ^ 1);
    }
    const laps = circuit ? Math.max(1, Math.min(ROUTE_MAX_LAPS, Math.round(target/lenM))) : 1;
    const steps = st.map(s => ({ei: s>>1, fwd: !(s&1)}));
    const name = courseName(ctx, st, circuit, taken);
    const sig = (circuit ? 'c' : 's') + ':' + st.join('.');
    /* A mountain road can be one 15 km edge. Nobody wants a 12-minute sprint, so anything
       well over target is raced in STAGES: same steps, clipped to a metre range along the
       assembled line (track.js does the clipping). */
    const stages = circuit ? 1 : Math.max(1, Math.round(lenM/(target*1.15)));
    for(let k = 0; k < stages; k++){
      const m0 = lenM*k/stages, m1 = lenM*(k+1)/stages;
      courses.push({
        kind: circuit ? 'circuit' : 'sprint', steps, laps,
        lenM: m1-m0,
        clip: stages > 1 ? [m0, m1] : null,
        name: stages > 1 ? name + ' \u00b7 Stage ' + (k+1) : name,
        sig: stages > 1 ? sig + '#' + k + '/' + stages : sig,
      });
    }
  };

  for(const si of order){
    if(courses.length >= ROUTE_MAX) break;
    if(cover[si]) continue;
    const loop = findCircuit(ctx, si, target);
    if(loop) commit(loop, true);
  }
  for(const si of order){
    if(courses.length >= ROUTE_MAX) break;
    if(cover[si]) continue;
    const path = growSprint(ctx, si, target);
    const len = stateLen(ctx, path);
    let fresh = 0;
    for(const s of path) if(!cover[s>>1]) fresh += edges[s>>1].lenM;
    /* The last few seeds are scraps between courses already laid. A "new" sprint that is
       mostly old ground is list clutter, not coverage -- leave the scrap uncovered and
       say so in `coverage` instead. */
    if(len >= ROUTE_MIN_M && fresh >= Math.max(300, len*0.4)) commit(path, false);
  }
  let covered = 0;
  edges.forEach((e, i) => { if(!skip[i] && cover[i]) covered += e.lenM; });
  courses.sort((p, q) => (p.kind === q.kind ? 0 : p.kind === 'circuit' ? -1 : 1)
                       || p.lenM*p.laps - q.lenM*q.laps || (p.sig < q.sig ? -1 : 1));
  courses.forEach((c, i) => { c.id = i; });
  return {courses, targetM: target, totalM, coveredM: covered,
          coverage: totalM ? covered/totalM : 0};
}

export { buildCourses, routeTargetM, edgeHeading, turnCost, ROUTE_MIN_M, ROUTE_STUB_M };
