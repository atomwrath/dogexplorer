/* A blob shadow under the player.

   Not a real shadow map: core/quality.js turns renderer shadows down or off on weaker
   devices, and a cast shadow from a single directional light over kilometres of terrain
   would need a cascade to look like anything. A painted blob costs one transparent quad,
   never varies with device tier, and in a flat-shaded cartoon world reads better than a
   correct shadow would.

   It earns its place by doing the one job the avatar cannot do for itself: saying where
   the ground is. Mid-jump the pup and the terrain behind it are both just shapes, and
   without a contact patch there is no way to tell a low hop from a high one, or to judge
   whether you are going to clear the ledge you aimed at. So the blob shrinks and fades
   with height rather than staying constant -- the gap between pup and blob IS the
   altitude readout, which matters now that clearing a step is a thing you deliberately
   jump for.

   Lives in the scene, NOT in worldG: worldG is emptied and rebuilt on every scale,
   exaggeration or contour change (world.js's resetWorld), and the shadow belongs to the
   avatar, which survives all of those. */
import { clamp } from '../core/math.js';
import { scene } from '../core/render.js';

let mesh = null, tex = null, baseOpacity = 0.34;

/* How far above the surface the blob floats. This is NOT an arbitrary nudge: world.js
   stacks the trail's six ribbon layers at fixed offsets above the graded profile --
   outline 0.012, shoulder 0.02, tread 0.05, junction pad 0.06, inner 0.08, dashes 0.09 --
   and standingY() returns the profile itself, so a shadow lifted by less than 0.09 is
   embedded IN that stack and z-fights whichever layer it lands on. (0.06, the old value,
   was exactly the junction-pad offset, which is why the flicker was worst at junctions.)
   Clearing the tallest layer with a little margin puts it unambiguously on top. These
   offsets are in world units and do not scale, so neither does this. */
const SHADOW_LIFT = 0.115;

/* Soft-edged radial blob. Wrapped because the 2D canvas is the one browser API this
   file needs and headless harnesses stub it loosely -- a hard-edged fallback disc is a
   perfectly acceptable degradation, an exception during world build is not. */
function blobTexture(){
  try{
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    if(!g || typeof g.createRadialGradient !== 'function') return null;
    const grd = g.createRadialGradient(32,32,0,32,32,32);
    grd.addColorStop(0,   'rgba(0,0,0,0.60)');
    grd.addColorStop(0.45,'rgba(0,0,0,0.40)');
    grd.addColorStop(1,   'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0,0,64,64);
    return new THREE.CanvasTexture(cv);
  }catch(err){
    return null;
  }
}

function ensureShadow(){
  if(mesh) return mesh;
  try{
    tex = blobTexture();
    const mat = new THREE.MeshBasicMaterial({
      color: tex ? 0xffffff : 0x000000,
      transparent: true,
      opacity: baseOpacity,
      /* depthWrite off so the blob never occludes the terrain it lies on, and a firm
         polygonOffset so it wins the depth comparison outright. -2 was not enough: the
         far plane on a kilometres-wide map spreads the depth buffer thin, and at that
         precision a quad a few centimetres above the ground is the SAME depth value as
         the ground. Hence the strobing. See SHADOW_LIFT for the other half of the fix. */
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -8,
    });
    if(tex) mat.map = tex;
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(1,1), mat);
    mesh.rotation.x = -Math.PI/2;      // scale.x -> world x, scale.y -> world z
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;        // it is always near the camera; culling it is a bug source
    mesh.name = 'playerShadow';        // tools/smoke.js looks it up by name
    scene.add(mesh);
  }catch(err){
    mesh = null;
  }
  return mesh;
}

/* radius: roughly the avatar's own half-width in world units.
   jumpY:  height above the ground, the same value the drivers get. */
function updateShadow(x, z, groundY, jumpY, radius, visible){
  const m = ensureShadow();
  if(!m) return;
  m.visible = !!visible;
  if(!visible) return;
  const h = Math.max(0, jumpY || 0);
  const r = Math.max(0.05, radius || 0.4);
  // fade and grow with altitude; both bottom out so a high jump still leaves a mark to
  // aim at rather than vanishing exactly when it is most useful
  const fade = clamp(1 - h/(r*7), 0.18, 1);
  const grow = clamp(1 + h/(r*9), 1, 1.5);
  m.position.set(x, groundY + SHADOW_LIFT, z);
  m.scale.set(r*2*grow, r*2*grow, 1);
  m.material.opacity = baseOpacity*fade;
}

// test seam: `const` does not survive the smoke harness's eval boundary (see main.js's
// climbSlowFactor for the same pattern)
function shadowLift(){ return SHADOW_LIFT; }
function setShadowVisible(v){ const m = ensureShadow(); if(m) m.visible = !!v; }
function getShadow(){ return mesh; }

export { updateShadow, setShadowVisible, getShadow, shadowLift };
