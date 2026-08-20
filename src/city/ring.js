/* The intimidation ring: a live readout of your current scare radius. */
import { scene } from '../core/render.js';
import { lerp } from '../core/math.js';
import { dogPos, STATS } from '../dog/runtime.js';
import { play } from './player-state.js';
import { mode } from './modes.js';

/* ---------- intimidation ring ---------- */
const ringG = new THREE.Group();
const ringMat = new THREE.MeshBasicMaterial({color:'#ff8f2d', transparent:true, opacity:0.4, side:THREE.DoubleSide, depthWrite:false});
const ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.94, 1.0, 48), ringMat);
ringMesh.rotation.x = -Math.PI/2;
const ringFillMat = new THREE.MeshBasicMaterial({color:'#ff8f2d', transparent:true, opacity:0.055, side:THREE.DoubleSide, depthWrite:false});
const ringFill = new THREE.Mesh(new THREE.CircleGeometry(0.94, 48), ringFillMat);
ringFill.rotation.x = -Math.PI/2;
ringG.add(ringMesh); ringG.add(ringFill);
ringG.position.y = 0.035;
ringG.visible = false;
scene.add(ringG);
const RING_COLS = {sneak:new THREE.Color('#67c6f2'), walk:new THREE.Color('#ff8f2d'), run:new THREE.Color('#e2453f')};
let ringR = 3;
function updateRing(dt){
  if(mode !== 'play'){ ringG.visible = false; return; }
  ringG.visible = true;
  const pulse = play.barkPulse > 0;
  const pace = pulse ? 1 : (play.crouchAmt > 0.5 ? 0.32 : play.speedNow < 0.4 ? 0.5 : play.speedNow < STATS.walk + 0.4 ? 0.72 : 1);
  const target = STATS.scareRadius * (pulse ? 1.55 : 1) * pace;
  ringR = lerp(ringR, target, 1 - Math.pow(pulse ? 0.0001 : 0.004, dt));
  ringG.scale.setScalar(ringR);
  ringG.position.x = dogPos.x;
  ringG.position.z = dogPos.z;
  const col = play.crouchAmt > 0.5 ? RING_COLS.sneak
            : (pulse || play.speedNow > STATS.walk + 0.4) ? RING_COLS.run
            : RING_COLS.walk;
  ringMat.color.lerp(col, 1 - Math.pow(0.002, dt));
  ringFillMat.color.copy(ringMat.color);
  ringMat.opacity = pulse ? 0.62 : 0.34;
  ringFillMat.opacity = pulse ? 0.11 : 0.05;
}

export { ringG, updateRing };
