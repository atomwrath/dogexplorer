/* The record-holder, running beside you.

   WHY A REAL RIG AND NOT A MARKER. A floating arrow would have been a tenth of this code,
   and it would have answered the wrong question. What a ghost is for is the thing you
   cannot get from a clock: not "am I up by 1.4 s" but "I am losing this on the climbs and
   taking it back on the descents". That only reads if the ghost is a body moving over the
   same ground at the same time, close enough to compare stride for stride.

   BUILT FROM THE SAME BUILDERS AS THE PLAYER, which is the whole reason this is cheap.
   buildDog() and makeAnimalModel() are pure -- they construct and return a rig rather than
   installing one -- so a second instance costs nothing but the call. dog-driver.js and
   wild-driver.js each own the ONE live instance of their rig and drive it from module
   state; this file deliberately does not touch either of them, because a ghost that shared
   the player's rig would move the player.

   ANIMATED, BUT NOT SIMULATED. The legs swing from gait.js's legSwingValue (a pure
   function of phase, which is why it can be borrowed) at a cadence taken from how fast the
   ghost is actually travelling between samples. There is no physics here and there should
   not be: the ghost's route is already known exactly, so anything simulated could only
   disagree with the recording.

   A dog ghost is built from the CURRENT dog's parameters rather than the record-holder's.
   Only the animal's key is stored with a time, and a key cannot reconstruct a pup -- so
   the choice is between a translucent silhouette with the wrong ear shape and no ghost at
   all. Wild animals do reconstruct exactly, since the species key is the whole model. */
import { scene, disposeGroup } from '../core/render.js';
import { buildDog } from '../dog/build.js';
import { makeAnimalModel } from '../city/animal-models.js';
import { mulberry32 } from '../core/math.js';
import { legSwingValue } from './gait.js';
import { TRAIL_DOG_SCALE } from './dog-driver.js';

const GHOST_TINT = 0xbfe4ff;   // pale ice blue: not the course magenta, not any animal
const GHOST_ALPHA = 0.42;

let ghostGroup = null, ghostRefs = null, ghostKey = null;
let ghostPhase = 0, ghostBaseY = 0, ghostLegLen = 0.4;

/* Every material replaced, not tinted in place. The builders share material instances
   between parts and, in the dog's case, with the LIVE pup -- editing them would turn the
   player translucent too, which is the sort of thing that looks like a rendering bug
   rather than a mistake in this file. */
function ghostify(root){
  root.traverse(o => {
    if(!o.isMesh) return;
    o.material = new THREE.MeshBasicMaterial({
      color:GHOST_TINT, transparent:true, opacity:GHOST_ALPHA,
      depthWrite:false,          // so the ghost's own far side does not punch holes in it
    });
    o.castShadow = false;
    o.receiveShadow = false;
    o.renderOrder = 6;           // over the course ribbon, under the HUD
  });
}

function disposeGhost(){
  if(ghostGroup){ scene.remove(ghostGroup); disposeGroup(ghostGroup); }
  ghostGroup = null; ghostRefs = null; ghostKey = null;
}

/* Build (or rebuild) the ghost for a roster key -- 'wild:fox', 'dog:Beagle'. `dogParams`
   is passed in rather than imported so this module stays out of main.js's avatar state;
   it is only consulted for a dog key. Returns the group, or null if the rig could not be
   built, in which case the race simply runs without a ghost. */
function setGhostAvatar(key, dogParams){
  const want = String(key || '');
  if(want === ghostKey && ghostGroup) return ghostGroup;
  disposeGhost();
  if(!want) return null;
  try{
    let built = null;
    if(want.startsWith('wild:')){
      const species = want.slice(5);
      // stable seed per species, the same rule ensureAvatar uses, so the ghost fox and a
      // played fox are the same fox
      let h = 0; for(let i=0;i<species.length;i++) h = (h*31 + species.charCodeAt(i))|0;
      const b = makeAnimalModel(species, mulberry32(Math.abs(h) || 1));
      built = {group:b.g, refs:b.refs};
    }else{
      const b = buildDog(dogParams);
      b.group.scale.multiplyScalar(TRAIL_DOG_SCALE);   // dog-driver.js's correction, and
                                                        // for the same reason: the shared
                                                        // rig is not metric
      built = {group:b.group, refs:b.refs};
    }
    ghostGroup = built.group; ghostRefs = built.refs;
    ghostify(ghostGroup);
    ghostGroup.name = 'raceGhost';
    ghostGroup.visible = false;
    ghostBaseY = (ghostRefs && ghostRefs.bodyG) ? ghostRefs.bodyG.position.y
               : (ghostRefs && ghostRefs.bodyBaseY) || 0;
    const legs = ghostRefs && ghostRefs.legs;
    ghostLegLen = (legs && legs.length)
      ? Math.max(0.05, (ghostBaseY + (legs[0].position.y || 0))*(ghostGroup.scale.x || 1))
      : 0.4;
    scene.add(ghostGroup);
    ghostKey = want;
  }catch(err){
    // a build with no working WebGL context loses the ghost and nothing else
    disposeGhost();
    return null;
  }
  return ghostGroup;
}

/* Place the ghost for this frame. x/z/groundY in WORLD units, speed in world units per
   second (used only to set the leg cadence). Pass null for `x` to hide it. */
function placeGhost(x, z, groundY, yaw, speed, dt){
  if(!ghostGroup) return;
  if(x == null){ ghostGroup.visible = false; return; }
  ghostGroup.visible = true;
  ghostGroup.position.set(x, groundY + ghostLegLen, z);
  ghostGroup.rotation.y = yaw;
  /* Cadence from distance covered, not from a fixed rate: a ghost whose legs turn over at
     a constant speed while its body accelerates is the classic skating-feet artifact, and
     it is more distracting on a translucent body than on a solid one. */
  ghostPhase += (speed/Math.max(0.05, ghostLegLen))*dt;
  const legs = ghostRefs && ghostRefs.legs;
  if(legs) for(let i=0;i<legs.length;i++){
    legs[i].rotation.x = legSwingValue(i, ghostPhase, 0)*Math.min(0.6, speed*0.06);
  }
  if(ghostRefs && ghostRefs.bodyG)
    ghostRefs.bodyG.position.y = ghostBaseY + Math.abs(Math.sin(ghostPhase))*0.04;
}

function hideGhost(){ if(ghostGroup) ghostGroup.visible = false; }
function getGhostGroup(){ return ghostGroup; }
function getGhostKey(){ return ghostKey; }

export { setGhostAvatar, placeGhost, hideGhost, disposeGhost, getGhostGroup, getGhostKey,
         GHOST_TINT, GHOST_ALPHA };
