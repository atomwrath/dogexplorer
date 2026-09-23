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
  r.throttleIn = input.throttle || 0; r.brakeIn = input.brake || 0;   // for the engine and brake sounds

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
/* THE REAL CORNER LIMIT. A board follows a bend of curvature k at speed v when the steering
   can supply the yaw rate the rail assist does not: (1 - railAssist)*k*v, against a lock
   that fades with speed, steerRate/(1 + v*steerFade). Solving that for v gives the fastest
   a bend can be taken at all. The old sum (sqrt(15/k)) was a guess that came out far below
   this -- a flat-out rider with no brake at all beat every rival by 20-30%. */
function cornerLimit(k){
  const kk = Math.max(k, 1e-5);
  const C = NEON.steerRate/((1 - NEON.railAssist)*kk);
  const f = NEON.steerFade;
  return (-1 + Math.sqrt(1 + 4*f*C))/(2*f);
}
function rivalInput(r, T, others, env, t){
  const sk = r.skill;
  // a rival with no style (the tests build bare ones) drives the old neutral algorithm
  const st = r.style || NEUTRAL_STYLE;
  const f = trackFrame(T, r.s, {});
  const look = 10 + r.v*1.1;
  const bend = bendAhead(T, r.s, look*1.8*(st.sight || 1));
  // corner speed from lateral grip; straights are flat out
  /* Judgement drifts a little from corner to corner, more for a Chill rider: now and then
     one arrives too hot and meets the bumper, which is the whole reason bumpers exist. */
  const wob = sk.wobble*st.wobble;
  const nerve = 1 + wob*0.45*Math.sin(t*0.23 + r.seed*2.1);
  const vCorner = cornerLimit(bend.k)*sk.grip*st.corner*nerve;
  /* The ceiling the hill allows, not the flat-ground one -- otherwise a rival brakes all
     the way down a descent to hold a number that gravity has already made meaningless. */
  /* The rival's own board already carries its pace (main.js gives it speedK x pace), so
     the grade ceiling for THAT board is the target -- multiplying pace in again here
     asked for a speed physics could never deliver, which just meant "flat out". */
  const vTop = gradeTopSpeed(r, slopeAhead(T, r.s, look*1.5), env.gravity);
  let vWant = Math.min(vTop, vCorner);
  // lane: own lane on the straights, inside of the bend when one is coming
  // the narrower of here and where we are about to be: a road necks down into a trail
  const edge = st.edge == null ? 1 : st.edge;
  const lim = Math.min(f.halfW, trackFrame(T, r.s + look, {}).halfW) - bodyWideOf(T)*0.5 - 0.6*edge/(T.widthK || 1);
  const apex = Math.min(1, bend.k*28);
  let dWant = r.lane*lim*(1-apex) + bend.sign*lim*(st.apex == null ? 0.55 : st.apex)*apex;
  // a slow wobble so they do not all trace one perfect line
  r.wob += (Math.sin(t*0.6 + r.seed*1.7) + Math.sin(t*1.31 + r.seed))*0.5*wob*0.02;
  r.wob *= 0.98;
  dWant += r.wob*lim;

  /* NITRO TANKS, before anything else decides the line -- this used to run AFTER the
     steering sum below, so the lane it chose was thrown away and rivals only ever took a
     tank that happened to sit on their line. A hunter changes lane from further out and
     tops up a rack that is nearly full; a bruiser only takes one that is in its way. */
  /* How far ahead the steering aims. Normally the look distance; going for a tank it aims
     at a point well short of the tank, or the long look arrives beside it too late. */
  let aim = look;
  const wantsTank = r.fuel < NEON.fuelMax - (st.hunt < 1 ? 1 : 0);   // an indifferent one leaves a spare slot
  if(env.cells && st.hunt > 0 && wantsTank){
    const reach = 45*st.hunt;
    let best = null, bestGap = Infinity;
    for(const c of env.cells){
      if(!c.live) continue;
      let gap = c.s - r.s;
      if(T.closed){ gap = ((gap % T.L) + T.L) % T.L; if(gap > T.L/2) gap -= T.L; }
      if(gap <= 2 || gap >= reach || gap >= bestGap) continue;
      // the lane change has to be makeable in the distance there is
      const shift = Math.abs(c.d - r.d);
      if(shift > Math.max(1.2, gap*0.28*st.hunt)) continue;
      // and it is never worth a corner, except to the reckless
      if(st.burn !== 'any' && bendAhead(T, r.s, gap).k >= 0.02) continue;
      best = c; bestGap = gap;
    }
    if(best){ dWant = best.d; r.hunting = best; aim = Math.max(6, Math.min(look, bestGap*0.5)); }
    else r.hunting = null;
  }

  /* TRAFFIC. Everyone solid in front of or beside us, by style: the timid see people
     from further off and give them a wide berth, a bruiser leans into them instead. */
  const W = bodyWideOf(T);
  let blockedV = Infinity;
  for(const q of others){
    if(q === r || q.done) continue;
    if(q.isGhost && !env.ghostContact) continue;          // a ghost you cannot touch is not traffic
    if(q.isGhost && q.riderId && q.riderId === r.riderId) continue;
    let gap = q.prog - r.prog;
    if(T.closed){ gap = ((q.s - r.s) % T.L + T.L) % T.L; if(gap > T.L/2) gap -= T.L; }
    const side = Math.abs(q.d - r.d);
    // an aggressive rider shoulders whoever is alongside or just ahead
    if(st.aggro > 0 && gap > -bodyLenOf(T) && gap < 6 && side < W*2.6 && !q.isGhost){
      const lean = st.aggro*(1 - 0.5*side/(W*2.6));
      dWant += (q.d - dWant)*lean;
      continue;
    }
    const range = (5 + r.v*0.6)*st.avoid;
    if(gap > 0 && gap < range && side < W*(1.1 + 0.4*st.avoid) && q.v < r.v + 1){
      // go round on whichever side has more room, and by more if skittish
      const roomL = lim - q.d, roomR = q.d + lim;
      const dir = roomL >= roomR ? 1 : -1;
      dWant = q.d + dir*W*(1.4 + 0.5*st.avoid);
      if(gap < 4*st.avoid) blockedV = Math.min(blockedV, q.v + (st.avoid > 1.4 ? -0.5 : 0.5));
    }
  }
  if(blockedV < Infinity) vWant = Math.min(vWant, blockedV);
  dWant = Math.max(-lim, Math.min(lim, dWant));
  /* Steer in TRACK space, not world space. The wanted slip angle is the one that carries
     the board from d to dWant over the look distance; the bend itself is fed forward as
     the yaw rate the rail assist does not already supply. (An earlier version aimed at
     the tangent 20 m ahead instead, which turns in long before the corner arrives and
     drives straight into the inside wall.) */
  const theta = angNorm(r.yaw - f.yaw);
  const thetaWant = Math.atan2(dWant - r.d, aim);
  const rate = NEON.steerRate/(1 + r.v*NEON.steerFade);
  const need = (thetaWant - theta)*4.0 + (1 - NEON.railAssist)*f.k*r.v;
  const steer = Math.max(-1, Math.min(1, need/rate));
  const dv = vWant - r.v;
  const room = st.burn === 'any' ? bend.k < 0.03 : bend.k < 0.012;
  return {
    steer,
    throttle: dv > -0.5 ? 1 : 0,
    brake: dv < -2.5 ? Math.min(1, (-dv-2.5)/6) : 0,
    // one press, and only where it pays: out of a corner onto something straight
    boost: r.burnT <= 0 && r.lockT <= 0 && r.fuel >= 1 && dv > 2 && room,
  };
}
const NEUTRAL_STYLE = {pace: 1, corner: 1, wobble: 1, avoid: 1, aggro: 0, mass: 1, hunt: 1, burn: 'straight', sight: 1, edge: 1, apex: 0.55};

/* Boards shouldering each other. Track space again: overlap in s and in d. */
/* opts.ghostContact (default on): with it off, ghosts are pure replays that nothing
   touches and that touch nothing -- the menu's "Ghost bumps" toggle. */
function resolveContacts(racers, T, opts){
  const ghostsOn = !opts || opts.ghostContact !== false;
  const hits = [];
  for(const r of racers) if(r.isGhost) r._touched = false;
  for(let i = 0; i < racers.length; i++) for(let j = i+1; j < racers.length; j++){
    const a = racers[i], b = racers[j];
    if(a.done && b.done) continue;
    if(!ghostsOn && (a.isGhost || b.isGhost)) continue;
    if(!contactPair(a, b)) continue;
    if(!overlapping(a, b, T)) continue;
    // a ghost that spawned inside somebody is not solid until it has come clear of everyone
    if((a.isGhost && !a.solid) || (b.isGhost && !b.solid)){ ghostsBlocked.add(a.isGhost && !a.solid ? a : b); continue; }
    let ds = b.s - a.s;
    if(T.closed){ ds = ((ds % T.L) + T.L) % T.L; if(ds > T.L/2) ds -= T.L; }
    const dd = b.d - a.d;
    const push = (bodyWideOf(T) - Math.abs(dd))*0.5 + 0.01;
    const sgn = dd >= 0 ? 1 : -1;
    /* Mass: a moose shoulders a chipmunk aside and barely moves; two equals split it.
       The total separation is unchanged, only who does the moving. */
    const ma = massOf(a), mb = massOf(b);
    shove(a, -sgn*push*2*mb/(ma + mb)); shove(b, sgn*push*2*ma/(ma + mb));
    if(!a.isGhost) a.yaw += -sgn*0.04*mb/ma;
    if(!b.isGhost) b.yaw += sgn*0.04*ma/mb;
    // the one behind loses a little, the one in front gains a little
    const front = ds >= 0 ? b : a, rear = ds >= 0 ? a : b;
    let vr = rear.v, vf = front.v;
    if(vr > vf){
      const m = (vr - vf)*0.5, mr = massOf(rear), mf = massOf(front);
      vr -= m*0.8*(2*mf/(mr + mf)); vf += m*0.5*(2*mr/(mr + mf));
    }
    setSpeed(rear, vr, front); setSpeed(front, vf, rear);
    hits.push([a, b]);
  }
  /* STUCK GHOSTS. A ghost in unbroken contact for ghostStuckS slips through whoever it
     is wedged against: it goes non-solid, and the phase-in below makes it solid again
     only once it has come clear of everyone. A record can be slowed; it cannot be parked. */
  for(const r of racers) if(r.isGhost){
    if(r._touched) r.stuckT = (r.stuckT || 0) + (r.lastDt || 1/60);
    else r.stuckT = 0;
    if(r.stuckT > NEON.ghostStuckS){ r.solid = false; r.stuckT = 0; r.slips = (r.slips || 0) + 1; }
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
const massOf = r => r.isGhost ? 1 : (r.style && r.style.mass) || 1;
/* A rider's speed is just its speed. A ghost's is its playback rate: it never gains from
   a shove, and a NEW contact knocks it back by at least ghostKnock. Staying in contact
   does not knock it again every frame -- that is what used to wedge a ghost against a
   rival, its clock held at 70% for as long as the two stayed touching. */
function setSpeed(r, v, other){
  if(!r.isGhost){ r.v = v; return; }
  r._touched = true;
  const k = r.v > 0.5 ? Math.max(0.2, Math.min(1, v/r.v)) : 1;
  let rate = Math.min(r.rate == null ? 1 : r.rate, k);
  if(!r.lastTouch) r.lastTouch = new Map();
  const last = r.lastTouch.get(other);
  const now = r.time || 0;
  if(last == null || now - last > NEON.ghostKnockGap) rate = Math.min(rate, 1 - NEON.ghostKnock);
  r.lastTouch.set(other, now);
  r.rate = rate;
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

export { cornerLimit, angNorm, makeRacer, stepRacer, topSpeed, gradeTopSpeed, slopeAhead, raceDistance, rivalInput, resolveContacts, rankRacers };
