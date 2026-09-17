/* One board's physics, in track space. Pure. The player and every rival run the SAME
   integrator, so a rival that overcooks a bend pays for it at the bumper exactly the
   way you do -- nobody is on rails. */
import { NEON } from './tuning.js';
import { trackFrame, bendAhead } from './track.js';

const angNorm = a => { while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; };

function makeRacer(o){
  return Object.assign({
    s: 0, d: 0, yaw: 0, v: 0, lap: 0, prog: 0, battery: 1, boosting: false,
    bumpT: 0, bumpSide: 0, bumps: 0, lean: 0, time: 0, done: false, finishT: null,
    place: 0, isPlayer: false, name: '?', skill: null, lane: 0, seed: 1, wob: 0,
    steerIn: 0, slope: 0,
  }, o || {});
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
  let boosting = !!input.boost && r.battery > 0.02 && !r.done;
  let a = NEON.thrust*(r.done ? 0 : input.throttle) + (boosting ? NEON.boostThrust : 0);
  a -= NEON.dragK*r.v*r.v + NEON.rollK*r.v;
  a -= NEON.brake*(r.done ? 0.6 : input.brake);
  if(env.gravity) a -= NEON.gravity*NEON.gravityGain*slopeAlong/Math.sqrt(1+slopeAlong*slopeAlong);
  r.v = Math.max(0, r.v + a*dt);
  r.boosting = boosting;
  r.battery = Math.max(0, Math.min(1, r.battery
    + (boosting ? -NEON.boostDrain : NEON.boostCharge)*dt
    + (env.gravity && slopeAlong < 0 ? -slopeAlong*NEON.regenGain*dt : 0)));

  // --- heading ---
  r.bumpT = Math.max(0, r.bumpT - dt);
  const grip = r.bumpT > 0 ? 0.35 : 1;
  const rate = NEON.steerRate/(1 + r.v*NEON.steerFade);
  const dsdt = r.v*Math.cos(theta)/Math.max(0.35, 1 - r.d*f.k);
  r.yaw += input.steer*rate*grip*dt + NEON.railAssist*f.k*dsdt*dt;
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
  const lim = g.halfW - NEON.bodyWide*0.5;
  if(Math.abs(r.d) > lim){
    const side = r.d > 0 ? 1 : -1;
    r.d = side*lim;
    if(theta*side > 0 || r.bumpT <= 0){
      const into = Math.max(0, Math.sin(theta*side));          // 0 grazing .. 1 square on
      theta = -side*Math.max(NEON.bumpKick, Math.abs(theta)*NEON.bumpRestitution);
      const keep = NEON.bumpKeep - 0.12*into;                   // square hits cost more
      r.v *= keep;
      r.bumpT = NEON.bumpLock; r.bumpSide = side; r.bumps++;
      ev = {bump: side, hard: Math.min(1, 0.35 + into)};
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
  const vTop = Math.sqrt(NEON.thrust/NEON.dragK)*sk.pace*r.paceMul;
  let vWant = Math.min(vTop, vCorner);
  // lane: own lane on the straights, inside of the bend when one is coming
  // the narrower of here and where we are about to be: a road necks down into a trail
  const lim = Math.min(f.halfW, trackFrame(T, r.s + look, {}).halfW) - NEON.bodyWide*0.5 - 0.6;
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
    if(gap > 0 && gap < 5 + r.v*0.6 && Math.abs(q.d - r.d) < NEON.bodyWide*1.3 && q.v < r.v + 1){
      dWant = q.d + (q.d > 0 ? -1 : 1)*NEON.bodyWide*1.8;
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
  const dv = vWant - r.v;
  return {
    steer,
    throttle: dv > -0.5 ? 1 : 0,
    brake: dv < -2.5 ? Math.min(1, (-dv-2.5)/6) : 0,
    boost: dv > 3 && r.battery > 0.5 && bend.k < 0.01,
  };
}

/* Boards shouldering each other. Track space again: overlap in s and in d. */
function resolveContacts(racers, T){
  const hits = [];
  for(let i = 0; i < racers.length; i++) for(let j = i+1; j < racers.length; j++){
    const a = racers[i], b = racers[j];
    if(a.done && b.done) continue;
    let ds = b.s - a.s;
    if(T.closed){ ds = ((ds % T.L) + T.L) % T.L; if(ds > T.L/2) ds -= T.L; }
    const dd = b.d - a.d;
    if(Math.abs(ds) >= NEON.bodyLen || Math.abs(dd) >= NEON.bodyWide) continue;
    const push = (NEON.bodyWide - Math.abs(dd))*0.5 + 0.01;
    const sgn = dd >= 0 ? 1 : -1;
    a.d -= sgn*push; b.d += sgn*push;
    a.yaw += -sgn*0.04; b.yaw += sgn*0.04;
    // the one behind loses a little, the one in front gains a little
    const front = ds >= 0 ? b : a, rear = ds >= 0 ? a : b;
    if(rear.v > front.v){ const m = (rear.v - front.v)*0.5; rear.v -= m*0.8; front.v += m*0.5; }
    hits.push([a, b]);
  }
  return hits;
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

export { angNorm, makeRacer, stepRacer, raceDistance, rivalInput, resolveContacts, rankRacers };
