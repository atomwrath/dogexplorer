/* A board, and somebody standing on it.

   Riders are the shared art: buildDog() for pups (so anything saved in Backyard Pups can
   race) and makeAnimalModel() for the wildlife. Both rigs face local +X and stand with
   their feet at y = 0, which is all this file relies on. Neither rig is metric (see the
   README's note on TRAIL_DOG_SCALE); the scales below are chosen for how a rider reads
   from a chase camera 8 m back on a 9 m wide ribbon, which is a bit bigger than life. */
import { scene, disposeGroup } from '../core/render.js';
import { clamp, mulberry32 } from '../core/math.js';
import { buildDog } from '../dog/build.js';
import { DEFAULTS } from '../dog/params.js';
import { makeAnimalModel } from '../city/animal-models.js';
import { SPECIES } from '../data/species.js';
import { glowTexture, addMat } from './neon-scene.js';

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
  // the light it throws on the deck below
  const glowMat = new THREE.MeshBasicMaterial({map: glowTexture(), color, transparent:true, opacity:0.75,
    blending: THREE.AdditiveBlending, depthWrite:false});
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(len*1.9, wide*3.2), glowMat);
  glow.rotation.x = -Math.PI/2;
  glow.position.y = -HOVER_M + 0.05;
  glow.renderOrder = 5;
  g.add(glow);
  // boost flame
  const jet = new THREE.Mesh(new THREE.ConeGeometry(wide*0.30, len*0.9, 10), addMat(color, 0.0));
  jet.rotation.z = Math.PI/2;                         // point back along -X
  jet.position.set(-len*0.95, -0.02, 0);
  g.add(jet);
  return {g, glowMat, jet, pads};
}

/* who: {kind:'dog', params} | {kind:'wild', key} */
function makeRider(who, color, seed){
  const root = new THREE.Group(); root.name = 'neonRider';
  const tilt = new THREE.Group(); root.add(tilt);
  let model, refs, tail = null, head = null;
  if(who.kind === 'wild' && SPECIES[who.key]){
    const built = makeAnimalModel(who.key, mulberry32((seed|0) || 1));
    model = built.g; refs = built.refs;
    model.scale.multiplyScalar(Math.pow(SPECIES[who.key].scale || 1, 0.5)*NEON_WILD_SCALE);
    tail = refs.tailG || null; head = refs.headG || null;
  }else{
    const built = buildDog(Object.assign({}, DEFAULTS, who.params || {}));
    model = built.group; refs = built.refs;
    model.scale.multiplyScalar(NEON_DOG_SCALE);
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
  const len = clamp(span*1.55 + 0.5, 1.0, 3.4);
  const wide = clamp(zMax*sc*2 + 0.45, 0.5, 1.5);
  const board = makeBoard(len, wide, color);
  board.g.position.y = HOVER_M;
  tilt.add(board.g);
  model.position.set((xMax + xMin)*-0.5*sc, HOVER_M + 0.05, 0);
  tilt.add(model);
  // a marker overhead, so a rival 150 m up the road is still a dot you can chase
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({map: glowTexture(), color, transparent:true,
    blending: THREE.AdditiveBlending, depthWrite:false, fog:false}));
  tag.scale.set(0.9, 0.9, 1);
  tag.position.y = HOVER_M + 3.2*Math.max(0.7, sc/NEON_DOG_SCALE*0.5 + 0.4);
  root.add(tag);
  scene.add(root);
  const legBase = (refs.legs || []).map(l => l.rotation.z || 0);
  const bodyBaseY = refs.bodyG ? refs.bodyG.position.y : 0;
  return {root, tilt, model, refs, tail, head, board, tag, legBase, bodyBaseY, color, seed: seed || 1};
}

/* x,y,z: deck point under the board. pitch: track pitch along heading (rad, nose up +). */
function poseRider(R, racer, x, y, z, pitch, t, dt){
  const hover = Math.sin(t*3.1 + R.seed)*0.035 + Math.sin(t*7.7 + R.seed*2)*0.012;
  R.root.position.set(x, y + hover, z);
  R.root.rotation.y = racer.yaw;
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
  R.board.jet.material.opacity = R.tuckAmt*(0.55 + 0.25*Math.sin(t*40));
  R.board.jet.scale.set(1, 0.6 + R.tuckAmt*0.8, 1);
  R.board.glowMat.opacity = 0.55 + 0.25*v01 + 0.2*R.tuckAmt;
}
function disposeRider(R){
  if(!R) return;
  scene.remove(R.root);
  disposeGroup(R.root);
}

export { makeRider, poseRider, disposeRider, makeBoard, NEON_DOG_SCALE, NEON_WILD_SCALE };
