/* A board, and somebody standing on it.

   Riders are the shared art: buildDog() for pups (so anything saved in Backyard Pups can
   race) and makeAnimalModel() for the wildlife. Both rigs face local +X and stand with
   their feet at y = 0, which is all this file relies on. Neither rig is metric (see the
   README's note on TRAIL_DOG_SCALE); the scales below are chosen for how a rider reads
   from a chase camera 8 m back on a 9 m wide ribbon, which is a bit bigger than life. */
import { scene, camera, disposeGroup } from '../core/render.js';
import { clamp, mulberry32 } from '../core/math.js';
import { buildDog } from '../dog/build.js';
import { DEFAULTS } from '../dog/params.js';
import { makeAnimalModel } from '../city/animal-models.js';
import { SPECIES } from '../data/species.js';
import { glowTexture, addMat, puffSmoke } from './neon-scene.js';

const NEON_DOG_SCALE  = 0.42;
const NEON_WILD_SCALE = 0.9;
const HOVER_M = 0.42;                 // daylight between board and deck

function makeBoard(len, wide, color){
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 0.09, wide),
    new THREE.MeshBasicMaterial({color: 0x10131f}));
  g.add(deck);
  const trim = new THREE.Mesh(new THREE.BoxGeometry(len*1.02, 0.035, wide*1.06),
    new THREE.MeshBasicMaterial({color}));
  trim.position.y = -0.05;
  g.add(trim);
  // upturned nose and tail, so it reads as a skateboard and not a plank
  for(const sx of [-1, 1]){
    const kick = new THREE.Mesh(new THREE.BoxGeometry(len*0.16, 0.09, wide*0.92),
      new THREE.MeshBasicMaterial({color: 0x10131f}));
    kick.position.set(sx*len*0.56, 0.05, 0);
    kick.rotation.z = sx*0.38;
    g.add(kick);
  }
  // hover pads where the trucks would be
  const pads = [];
  for(const sx of [-1, 1]){
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(wide*0.42, wide*0.30, 0.10, 14),
      new THREE.MeshBasicMaterial({color}));
    pad.position.set(sx*len*0.30, -0.12, 0);
    g.add(pad);
    pads.push(pad);
  }
  /* the light it throws on the deck below. side: DoubleSide, and that is not a stylistic
     default -- it is required. This plane rides inside `tilt`, which the game constantly
     rotates (lean, bumps, tricks, the pitch a hill puts under the board), and a
     MeshBasicMaterial without an explicit `side` renders FrontSide only. The instant a
     tilt swings the plane's normal away from the camera -- exactly what a lean or a bump
     does -- the back face is culled and the glow vanishes or is sliced through the
     middle, which is what the hard straight edge through the glow was: not smoke or a
     flame artifact, a single-sided plane caught edge-on. The exhaust cones (addMat(),
     used a few lines down) already set DoubleSide for the same reason; this plane and
     the scorch plane below it were the two things in the rig that didn't. */
  const glowMat = new THREE.MeshBasicMaterial({map: glowTexture(), color, transparent:true, opacity:0.75,
    blending: THREE.AdditiveBlending, depthWrite:false, side: THREE.DoubleSide});
  /* Lifted clear of the deck's own paint, not resting on it. The dashes, edge lines and
     finish-line box all sit within 2-6 cm of the deck surface (see neon-scene.js), and
     this glow used to sit at 5 cm -- squarely inside that band. Two nearly-coplanar
     surfaces that close together z-fight: which one wins a given pixel flickers frame to
     frame, especially on real GPU hardware with tighter depth precision than a software
     rasterizer shows in a still screenshot. Lifted to 18 cm, comfortably clear of
     everything painted on the deck, it still reads as light falling ON the deck rather
     than floating above it. */
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(len*1.9, wide*3.2), glowMat);
  glow.rotation.x = -Math.PI/2;
  glow.position.y = -HOVER_M + 0.18;
  glow.renderOrder = 5;
  g.add(glow);
  /* The scorch the burn leaves on the deck. A plume fired straight astern is pointed at
     the chase camera and reads as a dot however bright it is; the light it throws on the
     track behind is side-on to the lens, and that is what actually says "rocket" from
     where the player is sitting. */
  // same single-sided gap as glowMat above, and the same fix
  const scorchMat = new THREE.MeshBasicMaterial({map: glowTexture(), color: 0xff9a3c, transparent:true,
    opacity: 0, blending: THREE.AdditiveBlending, depthWrite:false, side: THREE.DoubleSide});
  const scorch = new THREE.Mesh(new THREE.PlaneGeometry(len*5.5, wide*2.4), scorchMat);
  scorch.rotation.x = -Math.PI/2;
  scorch.position.set(-len*2.6, -HOVER_M + 0.20, 0);   // same z-fight fix as glow, just above it
  scorch.renderOrder = 6;
  g.add(scorch);
  /* The rocket: a nozzle bolted under the tail, a hot white core, a longer amber flame
     around it and a shock diamond in the middle. Three nested cones cost nothing and read
     as a rocket rather than a traffic cone, which one cone on its own does not. */
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(wide*0.22, wide*0.28, len*0.18, 10),
    new THREE.MeshBasicMaterial({color: 0x20242f}));
  nozzle.rotation.z = Math.PI/2;
  nozzle.position.set(-len*0.58, -0.02, 0);
  g.add(nozzle);
  const jet = new THREE.Group();
  const flame = new THREE.Mesh(new THREE.ConeGeometry(wide*0.26, len*1.5, 12), addMat(0xff9a3c, 0));
  flame.rotation.z = Math.PI/2;
  flame.position.x = -len*0.75;
  const core = new THREE.Mesh(new THREE.ConeGeometry(wide*0.13, len*0.85, 10), addMat(0xffffff, 0));
  core.rotation.z = Math.PI/2;
  core.position.x = -len*0.45;
  const shock = new THREE.Mesh(new THREE.OctahedronGeometry(wide*0.11), addMat(0xbfe8ff, 0));
  shock.position.x = -len*0.62;
  /* THE PILOT FLAME: a little blue-cored flicker at the nozzle whenever the GAS is down.
     Much smaller than the burn and gone the moment the burn lights (the big flame takes
     over), so it says "motor on" without ever being mistaken for nitro. Animated from
     zero like the rest of the jet, which is what keeps a ghost's fade from touching it. */
  /* Base at the nozzle, not the middle: the cones are shifted so they scale OUT from the
     nozzle, and a flame that shrinks as the gas eases stays attached instead of floating
     off behind the board. */
  const pilotGeo = new THREE.ConeGeometry(wide*0.16, len*0.55, 10); pilotGeo.translate(0, len*0.275, 0);
  const pilotCoreGeo = new THREE.ConeGeometry(wide*0.085, len*0.30, 8); pilotCoreGeo.translate(0, len*0.15, 0);
  const pilot = new THREE.Mesh(pilotGeo, addMat(0xff7a2a, 0));
  pilot.rotation.z = Math.PI/2;
  pilot.position.x = -len*0.05;
  const pilotCore = new THREE.Mesh(pilotCoreGeo, addMat(0x6fd4ff, 0));
  pilotCore.rotation.z = Math.PI/2;
  pilotCore.position.x = -len*0.05;
  jet.add(flame, core, shock, pilot, pilotCore);
  jet.position.set(-len*0.62, -0.02, 0);
  /* ANGLED DOWN, and that is not decoration. The chase camera looks straight along the
     board's own axis, so a plume fired dead astern is pointed at the lens: it renders as a
     white blob under the rider and reads as nothing at all. Tipped ~20 degrees towards the
     deck, the flame and its smoke stream back along the track where the camera sees them
     side-on, which is the shot this game is always framing. */
  jet.rotation.z = -0.35;
  nozzle.rotation.z = Math.PI/2 - 0.35;
  g.add(jet);
  return {g, glowMat, jet, flame, core, shock, pilot, pilotCore, nozzle, scorch, scorchMat, pads};
}

/* who: {kind:'dog', params} | {kind:'wild', key} */
function makeRider(who, color, seed, sizeK){
  const root = new THREE.Group(); root.name = 'neonRider';
  const K = sizeK > 0 ? sizeK : 1;      // 1 at 1:1, smaller on a scaled-down map
  const tilt = new THREE.Group(); root.add(tilt);
  let model, refs, tail = null, head = null;
  if(who.kind === 'wild' && SPECIES[who.key]){
    const built = makeAnimalModel(who.key, mulberry32((seed|0) || 1));
    model = built.g; refs = built.refs;
    model.scale.multiplyScalar(Math.pow(SPECIES[who.key].scale || 1, 0.5)*NEON_WILD_SCALE*K);
    tail = refs.tailG || null; head = refs.headG || null;
  }else{
    const built = buildDog(Object.assign({}, DEFAULTS, who.params || {}));
    model = built.group; refs = built.refs;
    model.scale.multiplyScalar(NEON_DOG_SCALE*K);
    tail = refs.tail || null; head = refs.head || null;
    if(refs.bubble) refs.bubble.visible = false;
  }
  // size the board to the stance: a little longer than paw to paw
  const sc = model.scale ? model.scale.x : 1;
  let xMin = 0, xMax = 0, zMax = 0;
  for(const leg of (refs.legs || [])){
    xMin = Math.min(xMin, leg.position.x); xMax = Math.max(xMax, leg.position.x);
    zMax = Math.max(zMax, Math.abs(leg.position.z));
  }
  const span = (xMax - xMin)*sc;
  const len = clamp(span*1.55 + 0.5*K, 1.0*K, 3.4*K);
  const wide = clamp(zMax*sc*2 + 0.45*K, 0.5*K, 1.5*K);
  const board = makeBoard(len, wide, color);
  board.g.position.y = HOVER_M*K;
  tilt.add(board.g);
  model.position.set((xMax + xMin)*-0.5*sc, HOVER_M*K + 0.05*K, 0);
  tilt.add(model);
  // a marker overhead, so a rival 150 m up the road is still a dot you can chase
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({map: glowTexture(), color, transparent:true,
    blending: THREE.AdditiveBlending, depthWrite:false, fog:false}));
  tag.scale.set(0.9, 0.9, 1);
  tag.position.y = (HOVER_M + 3.2*Math.max(0.7, sc/(NEON_DOG_SCALE*K)*0.5 + 0.4))*K;
  root.add(tag);
  scene.add(root);
  const legBase = (refs.legs || []).map(l => l.rotation.z || 0);
  const bodyBaseY = refs.bodyG ? refs.bodyG.position.y : 0;
  return {root, tilt, model, refs, tail, head, board, tag, legBase, bodyBaseY, color, K, seed: seed || 1};
}

/* x,y,z: deck point under the board. pitch: track pitch along heading (rad, nose up +). */
function poseRider(R, racer, x, y, z, pitch, t, dt){
  const hover = (Math.sin(t*3.1 + R.seed)*0.035 + Math.sin(t*7.7 + R.seed*2)*0.012)*R.K;
  R.root.position.set(x, y + hover, z);
  R.root.rotation.y = racer.yaw + (racer.spinYaw || 0);     // a spin-out turns the rider, not the physics heading
  R.tilt.rotation.z = pitch;
  R.tilt.rotation.x = racer.lean*1.4 + (racer.bumpT > 0 ? -racer.bumpSide*racer.bumpT*1.6 : 0);
  // stance: paws planted wide, knees taking up the bumps, tucked low under boost
  const v01 = clamp(racer.v/24, 0, 1);
  const tuck = racer.boosting ? 1 : 0;
  R.tuckAmt = (R.tuckAmt || 0) + (tuck - (R.tuckAmt || 0))*Math.min(1, dt*6);
  const legs = R.refs.legs || [];
  legs.forEach((leg, i) => {
    const front = i < 2 ? 1 : -1;
    leg.rotation.z = R.legBase[i] + front*(0.18 + 0.16*R.tuckAmt)
      + Math.sin(t*9 + i*1.9 + R.seed)*0.03*v01;
  });
  if(R.refs.bodyG){
    R.refs.bodyG.position.y = R.bodyBaseY*(1 - 0.10*R.tuckAmt - 0.03*v01)
      + Math.sin(t*6.3 + R.seed)*0.012*v01;
    R.refs.bodyG.rotation.z = -0.05*v01 - 0.10*R.tuckAmt;
    R.refs.bodyG.rotation.x = -racer.lean*0.5;
  }
  if(R.tail) R.tail.rotation.y = Math.sin(t*(4 + 9*v01) + R.seed)*(0.25 + 0.35*v01);
  if(R.head) R.head.rotation.z = 0.06*v01;
  /* The overhead marker is there to find a rival 150 m up the road. Close up it is a
     dinner-plate-sized blob of additive light sitting over the rider, so it fades out
     well before it can get in the way. */
  if(R.tag.visible !== false){
    const dx = camera.position.x - x, dy = camera.position.y - y, dz = camera.position.z - z;
    const far = Math.sqrt(dx*dx + dy*dy + dz*dz);
    R.tag.material.opacity = Math.max(0, Math.min(1, (far - 18)/22));
  }
  /* THE BURN. Held at full while the burn runs and then snuffed, rather than tracking the
     button: the whole point of one-press boost is that the flame is an event you can see
     start and end. The flicker is fast and shallow -- a rocket roars, it does not strobe. */
  const burn = racer.burnT > 0 ? Math.min(1, racer.burnT/0.25) : 0;
  R.burnAmt = (R.burnAmt || 0) + (burn - (R.burnAmt || 0))*Math.min(1, dt*14);
  /* TONED DOWN. Five additive layers -- flame, core, shock, scorch, and the deck glow
     below -- all peak at once on a burn, and their old opacities (0.85 / 0.95 / 0.7 /
     0.75 / up to 0.9) summed to something closer to a small sun than a rocket: the
     screenshots that prompted this showed one white blob with no visible flame shape,
     which is what over-saturated additive layers do -- they stop reading as separate
     things and become one flat overexposed patch. Scaled down so the hottest pixel in
     the stack lands well short of 1, the individual cones stay visible as a flame rather
     than merging into a glare. */
  const flick = 0.88 + 0.12*Math.sin(t*47 + R.seed*3);
  R.board.flame.material.opacity = R.burnAmt*0.5*flick;
  R.board.core.material.opacity = R.burnAmt*0.55;
  R.board.shock.material.opacity = R.burnAmt*0.4*flick;
  R.board.flame.scale.set(1, 0.5 + R.burnAmt*(0.6 + 0.18*Math.sin(t*31)), 1);
  R.board.core.scale.set(1, 0.5 + R.burnAmt*0.55, 1);
  R.board.shock.scale.setScalar(0.5 + 0.35*R.burnAmt);
  R.board.scorchMat.opacity = R.burnAmt*0.4*flick;
  /* The pilot flame follows the GAS: quick to light, a touch slower to die so a feathered
     throttle reads as a flicker rather than a strobe, and smothered by the burn. */
  const gas = racer.done || racer.spinT > 0 ? 0 : Math.max(0, Math.min(1, racer.throttleIn || 0));
  R.gasAmt = (R.gasAmt || 0) + (gas - (R.gasAmt || 0))*Math.min(1, dt*(gas > (R.gasAmt || 0) ? 18 : 8));
  const pilotOn = R.gasAmt*(1 - R.burnAmt);
  const pf = 0.8 + 0.2*Math.sin(t*53 + R.seed*5);
  R.board.pilot.material.opacity = pilotOn*0.7*pf;
  R.board.pilotCore.material.opacity = pilotOn*0.8;
  R.board.pilot.scale.set(1, 0.4 + pilotOn*(0.6 + 0.2*Math.sin(t*41 + R.seed)), 1);
  R.board.pilotCore.scale.set(1, 0.5 + pilotOn*0.5, 1);
  R.board.scorch.scale.set(0.6 + 0.6*R.burnAmt, 1, 0.7 + 0.5*R.burnAmt);
  if(racer.burnT > 0 && !R.isGhost){
    // two puffs a frame at 60 Hz is a continuous trail without emptying the pool in a second
    R.smokeT = (R.smokeT || 0) + dt;
    while(R.smokeT > 0.03){
      R.smokeT -= 0.03;
      /* THE HEIGHT WAS THE BUG. This runs against `y`, the deck elevation passed into
         poseRider -- but the board itself floats HOVER_M*K above that (board.g.position.y
         a few lines up), and the nozzle sits close to the board. Emitting at y+0.18*R.K put
         every puff nearly half a board-height BELOW the rocket, low enough to read as
         nothing against the dark deck instead of a trail coming off the board. Emit level
         with the nozzle instead, and further back (the nozzle itself is well behind the
         board's centre, not at it). */
      puffSmoke(x - Math.cos(racer.yaw)*2.3*R.K, y + HOVER_M*R.K*0.82, z + Math.sin(racer.yaw)*2.3*R.K,
                racer.yaw, racer.v, R.K);
    }
  }
  // the always-on speed glow is unchanged; only the burn's OWN contribution is cut back
  R.board.glowMat.opacity = 0.55 + 0.25*v01 + 0.15*R.burnAmt;
}
function disposeRider(R){
  if(!R) return;
  scene.remove(R.root);
  disposeGroup(R.root);
}

export { makeRider, poseRider, disposeRider, makeBoard, NEON_DOG_SCALE, NEON_WILD_SCALE };
