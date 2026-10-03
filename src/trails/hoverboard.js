/* THE HOVERBOARD -- one board, lying on the first trail of a walk, that a pup can jump onto.

   This file owns the board: its mesh, its state, the rules of its speed and the little
   geometry of getting on and off it. It does NOT own the player. main.js owns `player`, and
   while somebody is riding, the rider's x/z/yaw ARE the board's (main.js copies them across
   every frame, the same way it pushes the player's position into whichever avatar driver is
   live) -- so there is only ever one place a pup can be standing.

   ---- WHAT MAKES IT FEEL LIKE A BOARD AND NOT A FASTER PUP ----------------------------

   PROPULSION IS A KICK. No rocket, no nitro (that is Neon Pups' board). While the sprint
   button is held the pup pushes off the ground in strokes -- a short shove, then a glide --
   and a stroke only pushes as hard as the pup is faster than the board. The push tapers to
   nothing at KICK_TOP, which is the animal's own sprint speed: you cannot kick a board
   faster than you can run. On flat ground that is the whole ceiling, and it is a fraction of
   what Neon's engine does (26.8 m/s flat; a fox here is ~7).

   GRAVITY DOES THE REST. The board is a frictionless slab on a hill: a real grade, at a real
   g, accelerates it -- and drag (v^2) is what stops that being infinite, so each grade has a
   terminal speed (see the table in hbTerminalSpeed). A 10% descent coasts to ~14 m/s, a 20%
   one to ~22. THE GRADE IS THE TRUE ONE: main.js hands in rise/run corrected for the map's
   horizontal compaction and vertical exaggeration (a world unit is a metre for dynamics, but
   the hill it climbs is the real hill), so shrinking the map to 1:10 does not make the board
   crawl or race.

   NO ROCKS, NO STEERING IN THE AIR. A hop keeps the board's speed and heading (it is a
   projectile as far as the rider is concerned) while the board floats along beneath, over
   whatever is down there, so the pup can come down on it. Floating over terrain is NOT being
   off the trail: the off-trail penalties are suspended for as long as the hop lasts.

   OFF THE TREAD the board is a poor tool: strong rolling drag (it slows to a crawl), any
   step UP stops it dead, and a drop bigger than a terrace step throws the rider (the board
   carries on without them). See main.js's rideMove for those rules -- they need the world.

   THE NAMES here all start hb, HB or are hbs, because build.py flattens every module into one
   scope. */
import { scene } from '../core/render.js';
import { toon } from '../core/materials.js';
import { clamp } from '../core/math.js';

const HB = {
  // ---- the object, in world units (== metres, like the pup) ----
  len: 1.7, wide: 0.62,        // the REFERENCE footprint the mesh is built at; hbSetLook scales it to the animal
  hover: 0.14, deckT: 0.08,    // reference daylight under the deck, and the deck's own thickness
  // ---- speed ----
  gravity: 9.81, gravityGain: 1.0,   // REALISTIC on purpose: Neon boosts this 1.8x, this does not
  slopeClamp: 0.35,            // true grades past this are scree, not a ramp; stop the maths there
  dragK: 0.0035,               // v^2 drag. Terminal speed on a grade g is sqrt((9.81*g - roll)/dragK)
  roll: 0.35,                  // m/s^2 of rolling loss, always. Also the "parking brake": below
                               // ~3.5% a board at rest stays put rather than creeping downhill
  brake: 6.0,                  // m/s^2 -- a foot dragged on the ground. Pull the stick BACK.
  // ---- the kick ----
  kickDv: 1.75,                // m/s gained per kickPeriod from standing, pushing flat out (a running pup is strong)
  kickPeriod: 0.5,
  dismountS: 0.26, mountS: 0.32,   // s for the pup to hop down behind the board / back onto it
  pushReady: 0.97,             // the push only counts once the pup is this far into running behind it
  crashV: 4.0,                 // m/s: a stop against terrain at or above this throws the rider
  kickTopMul: 1.0,             // x the animal's sprint speed: the board can be pushed exactly as fast as the pup can run
  kickTaper: 0.15,             // the push holds full strength until within this share of that speed, then fades
  bankMax: 0.5,                // rad: how far the board and rider lean into a full carve at speed
  // ---- off the tread ----
  offRoll: 1.8,                // extra m/s^2 of drag when off the trail
  offDragMul: 6,               // and v^2 drag is this many times worse
  offEase: 6,                  // 1/s: how fast "off the trail" fades in and out (no jerk at the edge)
  stepTol: 0.25,               // x stepUpLimit: a rise above this stops the board ("any step up")
  // ---- steering ----
  crouchDrag: 0.6,             // crouching tucks in: v^2 drag is this share of standing's
  crouchTurn: 1.25,            // ...and the board carves this much tighter
  turnMax: 3.2,                // rad/s pivoting on the spot
  turnFade: 0.10,              // turn rate / (1 + v*this): a fast board carves, it does not pivot
  // ---- hopping, exiting, boarding ----
  stopV: 0.7,                  // below this the board counts as STOPPED: jump gets you OFF it
  hopVy: 9.5,                  // the same launch as the pup's own jump
  exitVy: 5.5, exitDrift: 2.6, exitS: 0.45,   // hop off to the side: how high, how fast, how long
  mountMargin: 0.18,           // how far past the deck's edge a landing still counts as ON it
  mountBlockS: 0.6,            // after getting off, you cannot land back on it for this long
  freeDecel: 3.0,              // m/s^2: a riderless board coasting to a stop
  followRate: 10,              // 1/s: how fast a hopping board's altitude chases the ground below
};
HB.deckY = HB.hover + HB.deckT;          // deck TOP above the ground it hovers over
HB.pushAccel = HB.kickDv/HB.kickPeriod;      // the running pup's steady shove, before the taper

/* The board's state. One of them: there is one board. */
const hbs = {
  built: false, group: null, tilt: null, shadow: null, pads: [], padMats: [], trim: null,
  placed: false,
  x: 0, z: 0, yaw: 0,         // yaw is the pup's convention: forward = (cos yaw, -sin yaw)
  alt: 0,                      // ABSOLUTE altitude of the deck top
  vy: 0,                       // only a riderless board falls on its own
  v: 0,                        // speed along its heading, never negative
  riding: false, hop: false, carried: false,   // carried: slung on the pup's back, nowhere in the world
  len: 1.7, wide: 0.62, hz: 1, deckY: 0.22,    // THIS animal's board: footprint, height scale, deck height
  look: null, deckMesh: null, edgeMeshes: [],
  kicking: false, kickPhase: 0, restT: 0, blend: 0, turn: 0, afloat: false, torso: 0.7, legLen: 0.4,
  // blend: 0 = standing on the deck .. 1 = running behind it with the front paws on the tail; turn: -1..1 this frame's steer   // restT: seconds spent (nearly) stopped, so a hold is not mistaken for a brake in progress
  off: 0,                      // 0 on the tread .. 1 well off it, eased
  braking: false,
  mountBlockT: 0,
  exitT: 0, exitVx: 0, exitVz: 0,
  pitch: 0, bank: 0, bob: 0, glow: 0,
  seen: false, told: false,    // has the rider been shown the board / how to kick, this walk
};

/* ---------------------------- pure rules (no world, no player) ---------------------------- */

/* Acceleration ALONG the heading from gravity, for a TRUE grade (rise/run, + is uphill). */
function hbGradeAccel(grade){
  const g = clamp(grade, -HB.slopeClamp, HB.slopeClamp);
  return -HB.gravity*HB.gravityGain*g/Math.sqrt(1 + g*g);
}

/* How fast the pup's own legs can push the board: its sprint speed, less a little. */
function hbKickTop(runSpeed){ return Math.max(0.5, runSpeed*HB.kickTopMul); }

/* The speed update. o = {grade, kicking, kickPhase, kickTop, off 0..1, brake}.
   v never goes negative: a board that has stalled climbing a hill holds, it does not roll
   back with its nose uphill (the rider can turn it round; see main.js). At rest it only
   moves if the push beats the rolling loss -- which is the parking brake. */
function hbStepSpeed(v, dt, o){
  const top = Math.max(0.1, o.kickTop || 6);
  const taper = clamp((top - v)/(HB.kickTaper*top), 0, 1);
  const push = o.kicking ? HB.pushAccel*taper : 0;
  const net = hbGradeAccel(o.grade || 0) + push;
  const off = clamp(o.off || 0, 0, 1);
  const roll = HB.roll + HB.offRoll*off + (o.brake ? HB.brake : 0);
  const drag = HB.dragK*(o.crouch ? HB.crouchDrag : 1)*(1 + (HB.offDragMul - 1)*off)*v*v;
  let a;
  if(v > 0) a = net - roll - drag;
  else a = net > roll ? net - roll : 0;
  return Math.max(0, v + a*dt);
}

/* Where a coasting board settles on a steady true grade (+ is UPHILL, so a descent is
   negative): a = 0 -> roll + dragK v^2 = g sin(theta). For tuning and for the tests; nothing
   in the game calls it. 0 means it never gets going (or, uphill, never keeps going). */
function hbTerminalSpeed(grade, off){
  const a = hbGradeAccel(grade) - HB.roll - HB.offRoll*(off || 0);
  if(a <= 0) return 0;
  return Math.sqrt(a/(HB.dragK*(1 + (HB.offDragMul - 1)*(off || 0))));
}

/* Fastest the heading can swing this frame. A slow board pivots, a fast one carves. */
function hbTurnRate(v, crouch){ return (crouch ? HB.crouchTurn : 1)*HB.turnMax/(1 + Math.max(0, v)*HB.turnFade); }

/* ---------------------------- the board in the world ---------------------------- */

/* Position relative to the deck: {along, side}, along the heading and across it. */
function hbLocal(px, pz){
  const dx = px - hbs.x, dz = pz - hbs.z;
  const fx = Math.cos(hbs.yaw), fz = -Math.sin(hbs.yaw);
  return { along: dx*fx + dz*fz, side: dx*Math.sin(hbs.yaw) + dz*Math.cos(hbs.yaw) };
}
/* Is (px,pz) over the deck, give or take `margin`? */
function hbOverBoard(px, pz, margin){
  const m = margin == null ? HB.mountMargin : margin;
  const l = hbLocal(px, pz);
  return Math.abs(l.along) <= hbs.len/2 + m && Math.abs(l.side) <= hbs.wide/2 + m;
}

/* Which side to hop off on, and how to drift. `ok(x, z)` says whether the pup could stand
   at that spot (main.js: a step it could walk). Prefers the right, then the left; null if
   neither works, in which case the pup just hops straight up and lands on the deck again
   (the caller handles that: nothing sensible to do on a ledge only one board wide). */
function hbExitPlan(ok){
  const sx = Math.sin(hbs.yaw), sz = Math.cos(hbs.yaw);      // the board's right-hand side
  const reach = hbs.wide/2 + 0.3 + 0.6*hbs.hz;
  for(const side of [1, -1]){
    if(ok(hbs.x + sx*side*reach, hbs.z + sz*side*reach)){
      return { vx: sx*side*HB.exitDrift, vz: sz*side*HB.exitDrift };
    }
  }
  return null;
}

/* THE PUSH. Holding sprint, the pup hops down behind the board and runs, front paws on its
   tail, shoving it along; letting go, it hops back up and rides. `blend` is that journey,
   0 on the deck to 1 running behind, moved here at the hop's own pace -- down in dismountS,
   up in mountS -- and reversible mid-way, so a tap on sprint is a little hop and not a
   committed dance. Returns the new blend. */
function hbStepBlend(b, dt, wantPush){
  return wantPush ? Math.min(1, b + dt/HB.dismountS) : Math.max(0, b - dt/HB.mountS);
}
/* How far behind the board's CENTRE the pup's body sits while pushing: the front paws land a
   little inside the tail, so it is half the board, less that inset, plus the paw's own reach
   ahead of the body (hip ahead of centre, and the leg swung forward -- reach, from gait.js's
   pushPose). */
function hbPushBack(reach){
  const inset = Math.min(0.2*hbs.len, 0.18);
  return Math.max(0.2, hbs.len/2 - inset + reach + 0.29*hbs.torso);
}

function hbRiding(){ return hbs.riding; }
function hbState(){ return hbs; }
// test seam: top-level consts are not reachable from the smoke harness's eval, functions are
function hbTuning(){ return HB; }
/* deck-top height above the ground at the board: what a rider's feet rest on */
function hbLift(ground){ return hbs.alt - ground; }

/* Put the board down at (x,z) facing `yaw`, resting on `ground`. A fresh placement: it is
   not moving and nobody is on it. */
function hbPlace(x, z, yaw, ground){
  hbs.x = x; hbs.z = z; hbs.yaw = yaw;
  hbs.alt = ground + hbs.deckY; hbs.vy = 0; hbs.v = 0;
  hbs.riding = false; hbs.hop = false; hbs.carried = false; hbs.kicking = false; hbs.kickPhase = 0;
  hbs.off = 0; hbs.braking = false; hbs.mountBlockT = 0; hbs.exitT = 0;
  hbs.pitch = 0; hbs.bank = 0; hbs.seen = false; hbs.told = false; hbs.placed = true;
  hbBuild();
  hbs.group.visible = true; hbs.shadow.visible = true;
}

/* The map changed scale under us: positions compact together, so does the board's. */
function hbRescale(k){ hbs.x *= k; hbs.z *= k; }

/* Get on. The board turns to the pup's heading (it is a hover board; it can), and the pup
   brings a little of the run up with it. */
function hbMount(px, pz, yaw, speed, runSpeed){
  hbs.riding = true; hbs.hop = false;
  hbs.x = px; hbs.z = pz; hbs.yaw = yaw;
  hbs.v = Math.min(Math.max(0, speed)*0.4, hbKickTop(runSpeed));
  hbs.kicking = false; hbs.kickPhase = 0; hbs.off = 0; hbs.braking = false; hbs.blend = 0; hbs.turn = 0;
}
/* Get off, however: the board stays where it is, with whatever speed it has left. */
function hbDismount(){
  hbs.riding = false; hbs.hop = false; hbs.kicking = false; hbs.braking = false; hbs.blend = 0; hbs.turn = 0;
  hbs.mountBlockT = HB.mountBlockS;
}

/* A riderless board: coasts to a stop, is stopped by any step up, and falls if the ground
   goes out from under it. env = {groundY(x,z), stepTol}. Rider-carried boards do not come
   through here; main.js moves them with the player. */
function hbFreeStep(dt, env){
  if(hbs.riding || hbs.carried || !hbs.placed) return;
  if(hbs.mountBlockT > 0) hbs.mountBlockT = Math.max(0, hbs.mountBlockT - dt);
  /* THE BOARD FLOATS. Its floor is the water's surface wherever there is water above the
     bed, and the ground everywhere else: a hover board rides on the water like a lilo, where
     a pup (standing at wading depth, on the bed) goes in. env.waterY(x,z) is the drawn
     surface or null. */
  const floor = (x, z) => { const g = env.groundY(x, z), w = env.waterY ? env.waterY(x, z) : null; return w != null && w > g ? w : g; };
  if(hbs.v > 0.01){
    const step = hbs.v*dt, n = Math.max(1, Math.ceil(step/0.08));
    const dx = Math.cos(hbs.yaw)*step/n, dz = -Math.sin(hbs.yaw)*step/n;
    for(let k = 0; k < n; k++){
      const gHere = floor(hbs.x, hbs.z), gThere = floor(hbs.x + dx, hbs.z + dz);
      if(gThere - gHere > env.stepTol){ hbs.v = 0; break; }
      hbs.x += dx; hbs.z += dz;
    }
    hbs.v = Math.max(0, hbs.v - HB.freeDecel*dt);
  }else hbs.v = 0;
  const g = env.groundY(hbs.x, hbs.z), base = floor(hbs.x, hbs.z);
  hbs.afloat = base > g + 1e-6;
  const target = base + hbs.deckY;
  if(hbs.alt > target + 0.005){
    hbs.vy -= 26*dt;
    hbs.alt = Math.max(target, hbs.alt + hbs.vy*dt);
    if(hbs.alt === target) hbs.vy = 0;
  }else{
    hbs.vy = 0;
    hbs.alt += (target - hbs.alt)*(1 - Math.exp(-14*dt));
  }
}

/* ---------------------------- fitting the board to the animal ---------------------------- */

/* A hex number (0xrrggbb) or '#rrggbb' string -> hue/sat/light, hue in degrees. */
function hbToHsl(c){
  const n = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : (c|0);
  const r = ((n >> 16) & 255)/255, g = ((n >> 8) & 255)/255, b = (n & 255)/255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn)/2, d = mx - mn;
  let h = 0, sat = 0;
  if(d > 1e-6){
    sat = d/(1 - Math.abs(2*l - 1));
    if(mx === r) h = ((g - b)/d) % 6; else if(mx === g) h = (b - r)/d + 2; else h = (r - g)/d + 4;
    h *= 60; if(h < 0) h += 360;
  }
  return { h, s: sat, l };
}
function hbFromHsl(h, sat, l){
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2*l - 1))*sat, x = c*(1 - Math.abs((h/60) % 2 - 1)), m = l - c/2;
  let r = 0, g = 0, b = 0;
  if(h < 60){ r = c; g = x; } else if(h < 120){ r = x; g = c; } else if(h < 180){ g = c; b = x; }
  else if(h < 240){ g = x; b = c; } else if(h < 300){ r = x; b = c; } else { r = c; b = x; }
  const q = v => Math.max(0, Math.min(255, Math.round((v + m)*255)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
}
/* THE COMPLEMENT of the animal. The board is the opposite side of the colour wheel from the
   fur, so it reads against the animal rather than melting into it: a tan pup rides a deep teal
   deck, a red fox a blue-green one, a grey animal (which has no hue to oppose) a warm-grey
   one's complement, which is the original teal. The deck is dark and muted, the stripe and
   hover pads bright and saturated -- the same recipe as the original board, turned. */
function hbPalette(furColor){
  let { h, s, l } = hbToHsl(furColor == null ? 0xc98d4f : furColor);
  if(s < 0.14) h = 30;                         // a grey or white or black animal: oppose a warm brown
  const c = (h + 180) % 360;
  return {
    comp: c,
    deck: hbFromHsl(c, 0.42, l > 0.62 ? 0.22 : 0.30),   // a pale animal gets the darker deck
    edge: hbFromHsl(c, 0.48, 0.16),
    trim: hbFromHsl(c, 0.85, 0.58),
    pad:  hbFromHsl(c, 0.92, 0.72),
  };
}

/* The board for THIS animal. look = {torso, width, leg, radius, color}, all from the live rig
   (main.js hands them over whenever the avatar is built):

     torso / width   the body ellipsoid, world units. The board is a little longer than the
                     torso and wider than the paws stand, so the animal fits on it and its head
                     and tail hang off the ends the way they would off a real board.
     leg             hip height. Sets the board's own HEIGHT (hover and deck thickness), and so
                     how far the pushing paw has to reach to the ground -- a constant 1.5x leg
                     whatever the animal, which is what the kick pose's stretch is built for.
     radius          the shadow radius, the fallback size for a rig with no body to measure (a
                     hopper), at the ratio a dog's torso has to it.

   Safe to call before the mesh exists (it is stored and applied when built) and again whenever
   the animal changes. */
function hbSetLook(look){
  hbs.look = look || hbs.look || {};
  const k = hbs.look;
  const torso = k.torso || (k.radius ? k.radius*2.2 : 0.7);
  const width = k.width || torso*0.65;
  const wide = clamp(width*1.3, 0.3, 4);
  const len = clamp(Math.max(torso*1.7, wide*1.6), 0.7, 7);
  hbs.len = len; hbs.wide = wide;
  hbs.hz = clamp((k.leg || 0.4)/0.4, 0.6, 3);
  hbs.torso = torso; hbs.legLen = k.leg || 0.4;
  hbs.deckY = (HB.hover + HB.deckT)*hbs.hz;
  hbs.pal = hbPalette(k.color);
  hbApplyLook();
}
function hbApplyLook(){
  if(!hbs.built) return;
  hbs.tilt.scale.set(hbs.len/HB.len, hbs.hz, hbs.wide/HB.wide);
  hbs.shadow.scale.set(hbs.len*0.62, hbs.wide*0.78, 1);
  const P = hbs.pal; if(!P) return;
  hbs.deckMesh.material = toon('#' + P.deck.toString(16).padStart(6, '0'));
  for(const m of hbs.edgeMeshes) m.material = toon('#' + P.edge.toString(16).padStart(6, '0'));
  hbs.trim.material.color.setHex(P.trim);
  for(const m of hbs.padMats) m.color.setHex(P.pad);
}

/* ---------------------------- the mesh ---------------------------- */

/* Built ONCE, at the reference footprint, and fitted by scaling the tilt group (hbApplyLook), so
   a change of animal is three numbers and some colours, never a new mesh. */
function hbBuild(){
  if(hbs.built) return;
  const g = new THREE.Group(), tilt = new THREE.Group();
  const L = HB.len, W = HB.wide, T = HB.deckT, Y = HB.hover + HB.deckT;
  const deckMat = toon('#2c3d63'), edgeMat = toon('#1c2744');
  const glow = c => new THREE.MeshBasicMaterial({color: c, transparent: true, opacity: 0.9});

  const deck = new THREE.Mesh(new THREE.BoxGeometry(L, T, W), deckMat);
  deck.position.y = Y - T/2; tilt.add(deck);
  hbs.deckMesh = deck; hbs.edgeMeshes = [];
  // upturned nose and tail: a skateboard, not a plank
  for(const sx of [-1, 1]){
    const kick = new THREE.Mesh(new THREE.BoxGeometry(L*0.15, T, W*0.94), edgeMat);
    kick.position.set(sx*L*0.55, Y - T/2 + 0.045, 0);
    kick.rotation.z = sx*0.42;
    tilt.add(kick); hbs.edgeMeshes.push(kick);
  }
  // a bright racing stripe down the middle, so it reads from the chase camera
  hbs.trim = new THREE.Mesh(new THREE.BoxGeometry(L*0.9, 0.012, W*0.16), glow('#35e0c8'));
  hbs.trim.position.y = Y + 0.004; tilt.add(hbs.trim);
  // the hover pads, where the trucks would be
  hbs.pads = []; hbs.padMats = [];
  for(const sx of [-1, 1]){
    const m = glow('#7af7ff');
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(W*0.40, W*0.30, 0.07, 14), m);
    pad.position.set(sx*L*0.28, Y - T - 0.035, 0);
    tilt.add(pad); hbs.pads.push(pad); hbs.padMats.push(m);
  }
  g.add(tilt);
  scene.add(g);

  // a blob under it on the ground, which is what makes the hover legible
  const sh = new THREE.Mesh(new THREE.CircleGeometry(1, 20),
    new THREE.MeshBasicMaterial({color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false}));
  sh.rotation.x = -Math.PI/2;
  scene.add(sh);

  hbs.group = g; hbs.tilt = tilt; hbs.shadow = sh; hbs.built = true;
  g.visible = false; sh.visible = false;
  hbApplyLook();
}

function hbSetVisible(v){
  if(!hbs.built) return;
  hbs.group.visible = !!v && hbs.placed; hbs.shadow.visible = !!v && hbs.placed;
}

const HB_CARRY_SCALE = 0.7;     // slung on a back, the board rides smaller than it is
/* Every frame, riding or not. `ground` is the ground height under the board, `pitch` the
   slope along the heading (nose up +), `t` the clock in ms. A riderless board bobs at its
   hover height; a ridden one holds a steady line and its pads brighten with speed.

   `back` is {x,y,z,yaw}, the top of the carrier's back, while the board is being CARRIED: it
   then lies along the spine, nose a little up, with no shadow of its own on the ground. */
function hbUpdateVisual(dt, t, ground, pitch, back){
  if(!hbs.built || !hbs.placed) return;
  const sx = hbs.len/HB.len, sz = hbs.wide/HB.wide;
  if(hbs.carried && back){
    const k = HB_CARRY_SCALE;
    hbs.tilt.scale.set(sx*k, hbs.hz*k, sz*k);
    hbs.bank = 0; hbs.tilt.rotation.x = 0;
    // pad bottoms rest on the fur
    hbs.group.position.set(back.x, back.y - HB.hover*0.5*hbs.hz*k, back.z);
    hbs.group.rotation.y = back.yaw;
    hbs.tilt.rotation.z = 0.14;
    hbs.shadow.visible = false;
    for(const m of hbs.padMats) m.opacity = 0.55;
    return;
  }
  hbs.tilt.scale.set(sx, hbs.hz, sz);
  hbs.group.visible = true; hbs.shadow.visible = true;
  hbs.pitch += (pitch - hbs.pitch)*(1 - Math.exp(-12*dt));
  const idle = !hbs.riding && hbs.v < 0.2;
  const bob = idle ? Math.sin(t*(hbs.afloat ? 0.0032 : 0.0021))*(hbs.afloat ? 0.05 : 0.025)*hbs.hz : 0;
  hbs.group.position.set(hbs.x, hbs.alt - hbs.deckY + bob, hbs.z);
  hbs.group.rotation.y = hbs.yaw;
  hbs.tilt.rotation.z = hbs.pitch;
  /* LEAN INTO THE TURN. The bank follows how hard the board is being carved (hbs.turn, -1..1,
     + left) and how fast it is going: a slow board pivots almost upright, a fast one lays right
     over. Right-hand rule about the forward axis, so a left turn (turn > 0) is a negative roll
     -- the top of the board going to the left. Order ZXY, so the roll is about the board's OWN
     (already pitched) forward axis, and the rider is handed the same angle (main.js). */
  const bankT = (hbs.riding && !hbs.hop) ? -hbs.turn*clamp(0.35 + hbs.v/12, 0, 1)*HB.bankMax : 0;
  hbs.bank += (bankT - hbs.bank)*(1 - Math.exp(-8*dt));
  hbs.tilt.rotation.order = 'ZXY';
  hbs.tilt.rotation.x = hbs.bank;
  hbs.shadow.position.set(hbs.x, (hbs.afloat ? hbs.alt - hbs.deckY : ground) + 0.04, hbs.z);
  hbs.shadow.rotation.z = hbs.yaw;
  // the shadow thins and spreads the higher the board is off the ground
  const up = hbs.afloat ? 0.6 : clamp((hbs.alt - hbs.deckY - ground)/(2*hbs.hz), 0, 1);   // afloat: the blob would sit on the bed, under the water
  hbs.shadow.material.opacity = 0.28*(1 - 0.7*up);
  // pads: breathe at rest, burn with speed, flare on a kick
  const speedGlow = clamp(hbs.v/14, 0, 1);
  hbs.glow += ((hbs.kicking ? 1 : 0) - hbs.glow)*(1 - Math.exp(-10*dt));
  const base = 0.62 + 0.18*Math.sin(t*0.004) + 0.3*speedGlow + 0.2*hbs.glow;
  for(const m of hbs.padMats) m.opacity = clamp(base, 0.3, 1);
  for(const p of hbs.pads){ const sc = 1 + 0.25*speedGlow + 0.15*hbs.glow; p.scale.set(sc, 1, sc); }
}

export { HB, hbs, hbGradeAccel, hbKickTop, hbStepBlend, hbPushBack, hbStepSpeed, hbTerminalSpeed, hbTurnRate,
         hbLocal, hbOverBoard, hbExitPlan, hbRiding, hbState, hbTuning, hbLift, hbPlace, hbRescale, hbMount,
         hbDismount, hbFreeStep, hbBuild, hbSetVisible, hbUpdateVisual, hbSetLook, hbPalette, hbToHsl };
