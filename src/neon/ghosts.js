/* GHOSTS. A best time, kept as the line that set it, so the next run has something to
   chase rather than a number to beat.

   One ghost per RIDER per course setting: your fastest lap as the corgi and your fastest
   as the elk are different records, and at Fierce they all line up together. A ghost is a
   replay, not a driver -- it never steers, never collides and cannot be blocked -- so it
   is honest about what it is: the exact run that set the time.

   STORED SMALL, because localStorage is a few megabytes for everything the three games
   keep. Position along and across the track, four times a second, rounded to a decimetre
   and a centimetre; heading is not stored at all but recovered from where the line went,
   which is what heading means anyway. That is about 1.2 kB of JSON per minute of racing. */
import { trackFrame } from './track.js';
import { makeRacer } from './racer.js';

const GHOST_DT = 0.25;
const GHOST_KEEP = 6;          // per course setting, fastest first

function makeRecorder(){ return {t: 0, next: 0, s: [], d: []}; }
function recordFrame(rec, r, dt){
  rec.t += dt;
  if(rec.t < rec.next) return;
  rec.next += GHOST_DT;
  rec.s.push(Math.round(r.prog*10)/10);
  rec.d.push(Math.round(r.d*100)/100);
}
function finishRecording(rec, r, who){
  if(rec.s.length < 3) return null;
  return {dt: GHOST_DT, time: +r.finishT.toFixed(2), rider: who.id, label: who.label,
          s: rec.s, d: rec.d};
}

/* The stored table is {key: {riderId: ghost}}: one per rider, the fastest that rider has
   gone. Beating your own time replaces it; beating someone else's does not touch theirs. */
function bestGhosts(store, key){
  const byRider = (store && store[key]) || {};
  return Object.keys(byRider).map(k => byRider[k])
    .sort((a, b) => a.time - b.time || (a.rider < b.rider ? -1 : 1))
    .slice(0, GHOST_KEEP);
}
function keepGhost(store, key, ghost){
  if(!ghost) return false;
  const table = store[key] || (store[key] = {});
  const old = table[ghost.rider];
  if(old && old.time <= ghost.time) return false;
  table[ghost.rider] = ghost;
  return true;
}

/* A ghost racer: same shape as any other racer so ranking, the HUD and the minimap need
   to know nothing about it, but driven by the recording instead of by physics. */
function makeGhostRacer(g, T, color){
  const r = makeRacer({name: g.label + ' ghost', isGhost: true, color, ghost: g,
                       skill: null, lane: 0, seed: 1});
  applyGhost(r, T, 0);
  return r;
}
function stepGhost(r, T, dt){
  r.time += dt;
  applyGhost(r, T, r.time);
  if(!r.done && r.time >= r.ghost.time){ r.done = true; r.finishT = r.ghost.time; }
}
function applyGhost(r, T, t){
  const g = r.ghost, n = g.s.length;
  const u = Math.max(0, Math.min(n-1, t/g.dt));
  const i = Math.floor(u), j = Math.min(n-1, i+1), f = u - i;
  const prog = g.s[i] + (g.s[j]-g.s[i])*f;
  const d = g.d[i] + (g.d[j]-g.d[i])*f;
  const prev = r.prog;
  r.prog = prog;
  r.d = d;
  r.lap = T.closed ? Math.floor(prog/T.L) : 0;
  r.s = T.closed ? prog - r.lap*T.L : Math.min(prog, T.L);
  r.v = Math.max(0, (prog - prev)/Math.max(1e-4, r.lastDt || 0.016));
  // heading from the direction the recorded line is going, not from a stored angle
  const ahead = Math.min(n-1, u + 1.2);
  const ai = Math.floor(ahead), aj = Math.min(n-1, ai+1), af = ahead - ai;
  const pa = g.s[ai] + (g.s[aj]-g.s[ai])*af, da = g.d[ai] + (g.d[aj]-g.d[ai])*af;
  const ds = Math.max(0.05, pa - prog), dd = da - d;
  const fr = trackFrame(T, r.s, {});
  r.yaw = fr.yaw + Math.atan2(dd, ds);
  r.slope = 0;
  r.boosting = false;
  r.lean += ((-Math.atan2(dd, ds)*0.5) - r.lean)*0.1;
}

export { GHOST_DT, GHOST_KEEP, makeRecorder, recordFrame, finishRecording,
         bestGhosts, keepGhost, makeGhostRacer, stepGhost };
