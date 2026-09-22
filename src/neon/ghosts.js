/* GHOSTS. A best time, kept as the line that set it, so the next run has something to
   chase rather than a number to beat.

   One ghost per RIDER per course setting: your fastest lap as the corgi and your fastest
   as the elk are different records, and at Fierce they all line up together. A ghost is a
   replay, not a driver -- it never steers -- but it is SOLID to everyone except its own
   rider: shoulder one and it is pushed off its line and knocked back on its clock, then
   eases back onto the recording. The time a shove costs it is added to its finish, so
   blocking a ghost is a real way to beat it. It still replays the exact line that set the
   time; it just replays it a little late.

   STORED SMALL, because localStorage is a few megabytes for everything the three games
   keep. Position along and across the track, four times a second, rounded to a decimetre
   and a centimetre; heading is not stored at all but recovered from where the line went,
   which is what heading means anyway. That is about 1.2 kB of JSON per minute of racing. */
import { NEON } from './tuning.js';
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
                       skill: null, lane: 0, seed: 1, riderId: g.rider,
                       // playback clock, its rate, and how far it has been shoved off its line
                       gt: 0, rate: 1, offD: 0, offV: 0, solid: false});
  applyGhost(r, T, 0);
  return r;
}
function stepGhost(r, T, dt){
  r.time += dt;
  /* The clock runs at `rate`, which a shove knocks down and which comes back to 1 on its
     own. Every second it spends below 1 is time it arrives late. */
  if(r.rate == null) r.rate = 1;
  r.rate += (1 - r.rate)*Math.min(1, dt/NEON.ghostRecoverS);
  if(r.rate > 0.9995) r.rate = 1;
  r.gt = (r.gt || 0) + dt*r.rate;
  /* Back onto the line on a critically damped spring: no snap, no overshoot. */
  const w = NEON.ghostRightW;
  r.offV = (r.offV || 0) + (-w*w*(r.offD || 0) - 2*w*(r.offV || 0))*dt;
  r.offD = (r.offD || 0) + r.offV*dt;
  if(Math.abs(r.offD) < 1e-3 && Math.abs(r.offV) < 1e-3){ r.offD = 0; r.offV = 0; }
  applyGhost(r, T, r.gt);
  if(!r.done && r.gt >= r.ghost.time){ r.done = true; r.finishT = r.time; }
}
function applyGhost(r, T, t){
  const g = r.ghost, n = g.s.length;
  const u = Math.max(0, Math.min(n-1, t/g.dt));
  const i = Math.floor(u), j = Math.min(n-1, i+1), f = u - i;
  const prog = g.s[i] + (g.s[j]-g.s[i])*f;
  const d = g.d[i] + (g.d[j]-g.d[i])*f;
  const prev = r.prog;
  r.prog = prog;
  r.lap = T.closed ? Math.floor(prog/T.L) : 0;
  r.s = T.closed ? prog - r.lap*T.L : Math.min(prog, T.L);
  // recorded line plus however far it has been shoved, never through a bumper
  const lim = trackFrame(T, r.s, {}).halfW - (T.bodyWide || NEON.bodyWide)*0.5;
  r.d = Math.max(-lim, Math.min(lim, d + (r.offD || 0)));
  if(Math.abs(d + (r.offD || 0)) > lim){ r.offD = r.d - d; r.offV = 0; }
  r.v = Math.max(0, (prog - prev)/Math.max(1e-4, r.lastDt || 0.016));
  // heading from the direction the recorded line is going, not from a stored angle
  const ahead = Math.min(n-1, u + 1.2);
  const ai = Math.floor(ahead), aj = Math.min(n-1, ai+1), af = ahead - ai;
  const pa = g.s[ai] + (g.s[aj]-g.s[ai])*af, da = g.d[ai] + (g.d[aj]-g.d[ai])*af;
  const ds = Math.max(0.05, pa - prog), dd = da - d;
  const fr = trackFrame(T, r.s, {});
  // the drift back onto the line shows in the heading too
  r.yaw = fr.yaw + Math.atan2(dd, ds) + Math.atan2(r.offV || 0, Math.max(2, r.v));
  r.slope = 0;
  r.boosting = false;
  r.lean += ((-Math.atan2(dd, ds)*0.5) - r.lean)*0.1;
}

export { GHOST_DT, GHOST_KEEP, makeRecorder, recordFrame, finishRecording,
         bestGhosts, keepGhost, makeGhostRacer, stepGhost };
