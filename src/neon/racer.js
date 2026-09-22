/* One board's physics, in track space. Pure. The player and every rival run the SAME
   integrator, so a rival that overcooks a bend pays for it at the bumper exactly the
   way you do -- nobody is on rails. */
import { NEON } from './tuning.js';
import { trackFrame, bendAhead } from './track.js';

/* Board dimensions come from the TRACK, not the tuning table: a scaled-down map narrows
   the ribbon and everything on it together (see track.js widthFactor). */
const bodyWideOf = T => T.bodyWide || NEON.bodyWide;
const bodyLenOf  = T => T.bodyLen  || NEON.bodyLen;

const angNorm = a => { while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; };

function makeRacer(o){
  return Object.assign({
    s: 0, d: 0, yaw: 0, v: 0, lap: 0, prog: 0, fuel: NEON.fuelStart, boosting: false,
    bumpT: 0, bumpSide: 0, bumps: 0, lean: 0, time: 0, done: false, finishT: null,
    place: 0, isPlayer: false, name: '?', skill: null, lane: 0, seed: 1, wob: 0,
    steerIn: 0, slope: 0, speedK: 1, burnT: 0, lockT: 0, boostWasDown: false, cells: 0,
    bumpStreak: 0, lastBumpT: -1e9, spinT: 0, spinYaw: 0, spins: 0, riderId: null,
  }, o || {});
}

/* Top speed on the flat for this board: sqrt(thrust/drag), with the class multiplier.  */
function topSpeed(r){ return Math.sqrt(NEON.thrust/NEON.dragK)*(r.speedK || 1); }

/* Top speed ON A GRADE, which is a different number and the one a rider actually needs.
   Terminal speed is where thrust and gravity balance drag, so a 10% descent does not just
   accelerate you -- it RAISES the ceiling you accelerate towards, and a climb lowers it.
   The physics in stepRacer has always worked this way; this is the same sum solved for v,
   so that a rival aims at the speed the hill allows instead of holding its flat-ground
   number and braking down every descent. */
function gradeTopSpeed(r, slope, gravity){
  const k2 = (r.speedK || 1)*(r.speedK || 1);
  let a = NEON.thrust*k2;
  if(gravity){
    const g = Math.max(-NEON.slopeClamp, Math.min(NEON.slopeClamp, slope || 0));
    a -= NEON.gravity*NEON.gravityGain*g/Math.sqrt(1 + g*g);
  }
  if(a <= 0) return 0;                       // steeper than the board can climb
  // a = dragK v^2 + rollK v, solved for v
  const disc = NEON.rollK*NEON.rollK + 4*NEON.dragK*a;
  return (-NEON.rollK + Math.sqrt(disc))/(2*NEON.dragK);
}

/* The grade a rider is about to be on, averaged over the next few seconds of travel. */
function slopeAhead(T, s, ahead){
  let sum = 0, n = 0;
  const steps = Math.max(1, Math.ceil(ahead/T.ds));
  for(let q = 0; q <= steps; q++){
    let i = Math.floor(s/T.ds) + q;
    if(T.closed) i = ((i % T.n) + T.n) % T.n; else if(i >= T.n) break;
    sum += T.slope[i]; n++;
  }
  return n ? sum/n : 0;
}

/* input: {steer -1..1 (left +), throttle 0..1, brake 0..1, boost bool}
   env:   {gravity bool}
   returns null, or {bump: side, hard: 0..1} for the frame a wall was hit. */
const _rf = {};
function stepRacer(r, T, input, env, dt){
  const f = trackFrame(T, r.s, _rf);
  let theta = angNorm(r.yaw - f.yaw);

  // --- along-heading acceleration ---
  const slopeAlong = Math.max(-NEON.slopeClamp, Math.min(NEON.slopeClamp, f.slope))*Math.cos(theta);
  r.slope = env.gravity ? slopeAlong : 0;
  /* BOOST IS ONE BURN PER PRESS. Holding the button down does nothing after the first
     frame: the press starts a fixed burn, the burn spends a fixed slice of the pack, and
     nothing can start another until it has run out and the short lock after it has
     passed. So a boost is a decision about WHERE, made a few times a lap, rather than a
     button to lean on down every straight. */
  const k2 = (r.speedK || 1)*(r.speedK || 1);
  r.burnT = Math.max(0, r.burnT - dt);
  r.lockT = Math.max(0, r.lockT - dt);
  const wants = !!input.boost;
  if(wants && !r.boostWasDown && !r.done && r.burnT <= 0 && r.lockT <= 0 && r.fuel >= 1){
    r.burnT = NEON.burnS;
    r.lockT = NEON.burnS + NEON.burnLock;
    r.fuel--;
    r.burns = (r.burns || 0) + 1;
    r.burnFired = true;                     // one frame's flag, for the sound and the flame
  }else r.burnFired = false;
  r.boostWasDown = wants;
  const boosting = r.burnT > 0;
  /* SPUN OUT: no drive and no hands until it stops. The yaw offset is visual only (the
     rider turns on the deck); physics heading is untouched so the board comes out of it
     pointing down the track rather than wherever the spin happened to leave it. */
  const spinning = r.spinT > 0;
  if(spinning){
    r.spinT = Math.max(0, r.spinT - dt);
    const u = 1 - r.spinT/NEON.spinS;                 // 0 .. 1, fast then settling
    r.spinYaw = 2*Math.PI*NEON.spinTurns*(1 - (1-u)*(1-u));
    if(r.spinT <= 0) r.spinYaw = 0;
  }
  let a = NEON.thrust*k2*(r.done || spinning ? 0 : input.throttle) + (boosting && !spinning ? NEON.boostThrust*k2 : 0);
  a -= NEON.dragK*r.v*r.v + NEON.rollK*r.v;
  a -= NEON.brake*(r.done ? 0.6 : input.brake);
  if(env.gravity) a -= NEON.gravity*NEON.gravityGain*slopeAlong/Math.sqrt(1+slopeAlong*slopeAlong);
  r.v = Math.max(0, r.v + a*dt);
  r.boosting = boosting;

  // --- heading ---
  r.bumpT = Math.max(0, r.bumpT - dt);
  const grip = r.bumpT > 0 ? 0.35 : 1;
  const rate = NEON.steerRate/(1 + r.v*NEON.steerFade);
  const dsdt = r.v*Math.cos(theta)/Math.max(0.35, 1 - r.d*f.k);
  r.yaw += (spinning ? 0 : input.steer)*rate*grip*dt + NEON.railAssist*f.k*dsdt*dt;
  r.steerIn = input.steer;

  // --- position ---
  theta = angNorm(r.yaw - f.yaw);
  r.s += dsdt*dt;
  r.d += r.v*Math.sin(theta)*dt;

  // re-read the frame where we ended up: the tangent has turned under us
  const g = trackFrame(T, r.s, _rf);
  theta = angNorm(r.yaw - g.yaw);
  if(theta >  NEON.maxSlip){ theta =  NEON.maxSlip; }
  if(theta < -NEON.maxSlip){ theta = -NEON.maxSlip; }

  // --- bumpers ---
  let ev = null;
  const lim = g.halfW - bodyWideOf(T)*0.5;
  if(Math.abs(r.d) > lim){
    const side = r.d > 0 ? 1 : -1;
    r.d = side*lim;
    if(theta*side > 0 || r.bumpT <= 0){
      const into = Math.max(0, Math.sin(theta*side));          // 0 grazing .. 1 square on
      theta = -side*Math.max(NEON.bumpKick, Math.abs(theta)*NEON.bumpRestitution);
      // a streak is hits close together in RACE time; out of the window it starts over
      r.bumpStreak = (r.time - r.lastBumpT <= NEON.bumpWindow) ? r.bumpStreak + 1 : 1;
      r.lastBumpT = r.time;
      let keep = NEON.bumpKeep - 0.12*into;                     // square hits cost more
      if(r.bumpStreak === 2) keep *= NEON.bumpKeep2;
      let spin = false;
      if(r.bumpStreak >= 3 && r.spinT <= 0){
        keep = 0; spin = true;
        r.spinT = NEON.spinS; r.spins++; r.bumpStreak = 0;
        r.burnT = 0;                                            // a spin puts the burn out
      }
      r.v *= keep;
      r.bumpT = NEON.bumpLock; r.bumpSide = side; r.bumps++;
      ev = {bump: side, hard: spin ? 1 : Math.min(1, 0.35 + into), streak: spin ? 3 : r.bumpStreak, spin};
    }
  }
  r.yaw = g.yaw + theta;

  // --- laps / finish ---
  if(T.closed){
    while(r.s >= T.L){ r.s -= T.L; r.lap++; }
    r.prog = r.lap*T.L + r.s;
  }else{
    if(r.s > T.L){ r.s = T.L; r.v = Math.min(r.v, 2); }
    r.prog = r.s;
  }
  r.lean += ((-input.steer*0.35 - theta*0.25)*Math.min(1, r.v/12) - r.lean)*Math.min(1, dt*7);
  if(!r.done){
    r.time += dt;
    if(r.prog >= raceDistance(T) - 1e-6){ r.done = true; r.finishT = r.time; }
  }
  return ev;
}
function raceDistance(T){ return T.closed ? T.L*T.laps : T.L; }

/* A rival's hands on the controls. Looks down the track, picks a corner speed and a
   lane, and steers for it. `others` is every racer (itself included). */
function rivalInput(r, T, others, env, t){
  const sk = r.skill;
  const f = trackFrame(T, r.s, {});
  const look = 10 + r.v*1.1;
  const bend = bendAhead(T, r.s, look*1.8);
  // corner speed from lateral grip; straights are flat out
  /* Judgement drifts a little from corner to corner, more for a Chill rider: now and then
     one arrives too hot and meets the bumper, which is the whole reason bumpers exist. */
  const nerve = 1 + sk.wobble*0.45*Math.sin(t*0.23 + r.seed*2.1);
  const vCorner = Math.sqrt((15*sk.corner*nerve)/Math.max(bend.k, 1e-4));
  /* The ceiling the hill allows, not the flat-ground one -- otherwise a rival brakes all
     the way down a descent to hold a number that gravity has already made meaningless. */
  const vTop = gradeTopSpeed(r, slopeAhead(T, r.s, look*1.5), env.gravity)*sk.pace*r.paceMul;
  let vWant = Math.min(vTop, vCorner);
  // lane: own lane on the straights, inside of the bend when one is coming
  // the narrower of here and where we are about to be: a road necks down into a trail
  const lim = Math.min(f.halfW, trackFrame(T, r.s + look, {}).halfW) - bodyWideOf(T)*0.5 - 0.6/(T.widthK || 1);
  const apex = Math.min(1, bend.k*28);
  let dWant = r.lane*lim*(1-apex) + bend.sign*lim*0.55*apex;
  // a slow wobble so they do not all trace one perfect line
  r.wob += (Math.sin(t*0.6 + r.seed*1.7) + Math.sin(t*1.31 + r.seed))*0.5*sk.wobble*0.02;
  r.wob *= 0.98;
  dWant += r.wob*lim;
  // go round whoever is right in front
  for(const q of others){
    if(q === r || q.done) continue;
    let gap = q.prog - r.prog;
    if(T.closed){ gap = ((q.s - r.s) % T.L + T.L) % T.L; if(gap > T.L/2) gap -= T.L; }
    if(gap > 0 && gap < 5 + r.v*0.6 && Math.abs(q.d - r.d) < bodyWideOf(T)*1.3 && q.v < r.v + 1){
      dWant = q.d + (q.d > 0 ? -1 : 1)*bodyWideOf(T)*1.8;
      if(gap < 4) vWant = Math.min(vWant, q.v + 0.5);
    }
  }
  dWant = Math.max(-lim, Math.min(lim, dWant));
  /* Steer in TRACK space, not world space. The wanted slip angle is the one that carries
     the board from d to dWant over the look distance; the bend itself is fed forward as
     the yaw rate the rail assist does not already supply. (An earlier version aimed at
     the tangent 20 m ahead instead, which turns in long before the corner arrives and
     drives straight into the inside wall.) */
  const theta = angNorm(r.yaw - f.yaw);
  const thetaWant = Math.atan2(dWant - r.d, look);
  const rate = NEON.steerRate/(1 + r.v*NEON.steerFade);
  const need = (thetaWant - theta)*4.0 + (1 - NEON.railAssist)*f.k*r.v;
  const steer = Math.max(-1, Math.min(1, need/rate));
  /* Boost cells: worth a metre or two of lane, never worth a corner. A rival with a full
     pack drives its line and leaves the cells for whoever needs them. */
  if(env.cells && r.fuel < NEON.fuelMax){
    for(const c of env.cells){
      if(!c.live) continue;
      let gap = c.s - r.s;
      if(T.closed){ gap = ((gap % T.L) + T.L) % T.L; if(gap > T.L/2) gap -= T.L; }
      if(gap > 4 && gap < 45 && Math.abs(c.d - dWant) < lim*1.2 && bendAhead(T, r.s, gap).k < 0.02){
        dWant = Math.max(-lim, Math.min(lim, c.d));
        break;
      }
    }
  }
  const dv = vWant - r.v;
  return {
    steer,
    throttle: dv > -0.5 ? 1 : 0,
    brake: dv < -2.5 ? Math.min(1, (-dv-2.5)/6) : 0,
    // one press, and only where it pays: out of a corner onto something straight
    boost: r.burnT <= 0 && r.lockT <= 0 && r.fuel >= 1 && dv > 2 && bend.k < 0.012,
  };
}

/* Boards shouldering each other. Track space again: overlap in s and in d. */
function resolveContacts(racers, T){
  const hits = [];
  for(let i = 0; i < racers.length; i++) for(let j = i+1; j < racers.length; j++){
    const a = racers[i], b = racers[j];
    if(a.done && b.done) continue;
    if(!contactPair(a, b)) continue;
    if(!overlapping(a, b, T)) continue;
    // a ghost that spawned inside somebody is not solid until it has come clear of everyone
    if((a.isGhost && !a.solid) || (b.isGhost && !b.solid)){ ghostsBlocked.add(a.isGhost && !a.solid ? a : b); continue; }
    let ds = b.s - a.s;
    if(T.closed){ ds = ((ds % T.L) + T.L) % T.L; if(ds > T.L/2) ds -= T.L; }
    const dd = b.d - a.d;
    const push = (bodyWideOf(T) - Math.abs(dd))*0.5 + 0.01;
    const sgn = dd >= 0 ? 1 : -1;
    shove(a, -sgn*push); shove(b, sgn*push);
    if(!a.isGhost) a.yaw += -sgn*0.04;
    if(!b.isGhost) b.yaw += sgn*0.04;
    // the one behind loses a little, the one in front gains a little
    const front = ds >= 0 ? b : a, rear = ds >= 0 ? a : b;
    let vr = rear.v, vf = front.v;
    if(vr > vf){ const m = (vr - vf)*0.5; vr -= m*0.8; vf += m*0.5; }
    setSpeed(rear, vr); setSpeed(front, vf);
    hits.push([a, b]);
  }
  /* Any ghost that was not caught inside someone this step is clear, and solid from now on. */
  for(const r of racers) if(r.isGhost && !r.solid && !r.done){
    if(ghostsBlocked.has(r)) continue;
    let inside = false;
    for(const q of racers) if(q !== r && !q.isGhost && contactPair(r, q) && overlapping(r, q, T)){ inside = true; break; }
    if(!inside) r.solid = true;
  }
  ghostsBlocked.clear();
  return hits;
}
const ghostsBlocked = new Set();
/* Who can touch whom. Ghosts do not touch each other (two records cannot argue), a
   finished ghost is parked on the line and out of the way, and a ghost is never solid to
   the same animal -- you cannot bump your own record. */
function contactPair(a, b){
  if(a.isGhost && b.isGhost) return false;
  if((a.isGhost && a.done) || (b.isGhost && b.done)) return false;
  if((a.isGhost || b.isGhost) && a.riderId && a.riderId === b.riderId) return false;
  return true;
}
function overlapping(a, b, T){
  let ds = b.s - a.s;
  if(T.closed){ ds = ((ds % T.L) + T.L) % T.L; if(ds > T.L/2) ds -= T.L; }
  return Math.abs(ds) < bodyLenOf(T) && Math.abs(b.d - a.d) < bodyWideOf(T);
}
/* A rider is pushed sideways; a ghost is pushed OFF ITS LINE, which it then eases back
   onto (ghosts.js). Either way it stays between the bumpers. */
function shove(r, dd){
  if(r.isGhost){ r.offD = (r.offD || 0) + dd; r.d += dd; }
  else r.d += dd;
}
/* A rider's speed is just its speed. A ghost's is its playback rate: it never gains from
   a shove, and any contact at all knocks it back by at least ghostKnock. */
function setSpeed(r, v){
  if(!r.isGhost){ r.v = v; return; }
  const k = r.v > 0.5 ? Math.max(0.2, Math.min(1, v/r.v)) : 1;
  r.rate = Math.min(r.rate == null ? 1 : r.rate, k, 1 - NEON.ghostKnock);
}

function rankRacers(racers){
  const order = racers.slice().sort((p, q) => {
    if(p.done !== q.done) return p.done ? -1 : 1;
    if(p.done) return p.finishT - q.finishT;
    return q.prog - p.prog;
  });
  order.forEach((r, i) => { r.place = i+1; });
  return order;
}

export { angNorm, makeRacer, stepRacer, topSpeed, gradeTopSpeed, slopeAhead, raceDistance, rivalInput, resolveContacts, rankRacers };
