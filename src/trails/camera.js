/* The chase camera, lifted out of main.js so the vertical behaviour can be reasoned
   about on its own -- it was the whole problem.

   WHY THE OLD ONE FELT WRONG going up and down. Three separate causes stacked:

   1. The look target read the avatar's TRUE ground height, which on a terraced mesh
      jumps a full contour step the instant you cross a cell boundary. The rig's own
      altitude was smoothed (cameraGroundY) but the target was not, so every step
      snapped the camera's PITCH -- and a pitch snap is far more noticeable than a
      position snap, because it moves the whole horizon.
   2. Position used a plain exponential lerp with the same rate on all three axes. That
      is fine for the horizontal chase, where the target moves continuously, but on the
      vertical it turns a step input into a visible exponential lurch: fastest at the
      moment of the step, which is exactly when you notice it.
   3. Nothing checked the ground under the CAMERA. Walking uphill, the rig sat at a
      height derived from the avatar's position and promptly buried itself in the slope
      behind, so the view clipped into terrain on every climb.

   The fixes, in order: spring the look target instead of tracking it rigidly; use a
   critically damped spring (not a lerp) on the rig's height, so a step produces an
   ease-in AND an ease-out with no overshoot; and lift the rig whenever the ground
   beneath it demands clearance.

   Yaw/pitch/zoom live here too, since they're camera state -- main.js's pointer handlers
   drive them through this module's accessor functions rather than owning the variables. */
import { clamp, lerp } from '../core/math.js';
import { camera } from '../core/render.js';
import { cameraGroundY } from './terrain.js';

const PITCH_MIN = 0.05, PITCH_MAX = 1.35;  // never flips under the ground or goes top-down

let camYawV = 0, pitch = 0.32, zoom = 1;
let rigY = 0, rigVY = 0;                    // spring state for the rig's own altitude
let lookY = 0, lookVY = 0;                  // spring state for the look target's height
const camLook = new THREE.Vector3();
let primed = false;                         // false until the first snap(), so the very
                                            // first frame doesn't spring in from origin

function getCamYaw(){ return camYawV; }
function setCamYaw(v){ camYawV = v; }
function addCamYaw(d){ camYawV += d; }
function getCamPitch(){ return pitch; }
function addCamPitch(d){ pitch = clamp(pitch + d, PITCH_MIN, PITCH_MAX); }
function getCamZoom(){ return zoom; }
function addCamZoom(d){ zoom = clamp(zoom + d, 0.5, 2.2); }

/* Critically damped implicit spring. Implicit rather than the usual explicit form
   because a browser tab that loses focus hands back a huge first dt, and the explicit
   version diverges spectacularly on one -- the camera launches into orbit and never
   comes back. This one is unconditionally stable at any dt. Returns [position, velocity]. */
function spring(x, v, target, dt, omega){
  const f = 1 + 2*dt*omega;
  const oo = omega*omega, hoo = dt*oo, hhoo = dt*hoo;
  const detInv = 1/(f + hhoo);
  return [(f*x + dt*v + hhoo*target)*detInv, (v + hoo*(target - x))*detInv];
}

/* Where the rig wants to be for a given focus point and boom length. */
function orbitPoint(x, y, z, dist){
  return [x - Math.sin(camYawV)*dist*Math.cos(pitch),
          y + dist*Math.sin(pitch),
          z - Math.cos(camYawV)*dist*Math.cos(pitch)];
}

/* Teleport the camera into position with no easing: trailhead placement, mode switches,
   and the lobby preview, where springing in from wherever the camera happened to be
   reads as a swoop nobody asked for. */
function snapChaseCam(px, pz, groundY, vertScale, dist = 10){
  const d = dist*zoom;
  rigY = groundY; rigVY = 0;
  lookY = groundY + 1.4; lookVY = 0;
  const [cx, cy, cz] = orbitPoint(px, rigY + 2, pz, d);
  camera.position.set(cx, cy, cz);
  camLook.set(px, lookY, pz);
  camera.lookAt(camLook);
  primed = true;
  void vertScale;
}

/* One frame of follow.
     px,pz      avatar position
     groundY    the surface the avatar is standing on (world.js standingY)
     jumpY      hop offset, already included in the avatar's rendered height
     speed      current ground speed, m/s -- used only for the framing nudge below
     vertScale  world.js's exaggeration, needed to sample terrain under the rig itself */
function updateChaseCam(dt, px, pz, groundY, jumpY, speed, vertScale, dist = 8.5){
  if(!primed){ snapChaseCam(px, pz, groundY, vertScale, dist); return; }

  /* Rig altitude. cameraGroundY is already the terrain smoothed over a few cells, so
     this spring is smoothing a smooth signal -- deliberately. The first pass removes the
     step's spatial abruptness, this one removes its temporal abruptness, and it takes
     both to stop a contour crossing registering as a bump. */
  /* Never below the surface the avatar is actually standing on. cameraGroundY samples
     TERRAIN, which is the right answer everywhere except on top of a rock formation or a
     roof -- there the avatar is metres above the terrain the rig is being aimed at, so the
     boom sat down at the base of the formation and framed the rock rather than the pup on
     it. `groundY` is world.js's answer including solid tops, so taking the higher of the
     two keeps the terrain smoothing everywhere it applies and lifts the rig onto the
     formation when there is one underfoot. */
  const targetRigY = Math.max(cameraGroundY(px, pz, vertScale), groundY) + 2;
  [rigY, rigVY] = spring(rigY, rigVY, targetRigY, dt, 3.1);

  /* Look target height. Springs toward the avatar's real head height -- the avatar stays
     precisely framed in the steady state, but a terrace step no longer whips the pitch.
     Faster than the rig (omega 5.2 vs 3.1) so the subject settles before the viewpoint
     does, which is the order that reads as a camera operator following someone rather
     than the world lurching. */
  const targetLookY = groundY + jumpY + 1.4;
  [lookY, lookVY] = spring(lookY, lookVY, targetLookY, dt, 5.2);

  /* Ease the boom out a little at speed. Small on purpose: enough to widen the frame
     when the pup breaks into a run, not enough to read as a zoom. */
  const d = dist*zoom*(1 + clamp(speed, 0, 8)*0.022);

  const [gx, gy, gz] = orbitPoint(px, rigY, pz, d);

  /* Horizontal chase stays an exponential lerp -- the target moves continuously there,
     so there's nothing to smooth out and a spring would only add lag. */
  const k = 1 - Math.pow(0.0016, dt);
  camera.position.x = lerp(camera.position.x, gx, k);
  camera.position.z = lerp(camera.position.z, gz, k);
  camera.position.y = lerp(camera.position.y, gy, k);

  /* Ground clearance under the RIG, not under the avatar. Climbing a slope, the point
     behind and below the pup can be inside the hillside; without this the view clips
     through terrain on exactly the ascents this game is made of. Pushing up (rather than
     pulling the boom in) keeps the framing distance stable, so it reads as the camera
     rising over a crest instead of snapping closer. Asymmetric response -- rise quickly
     to avoid the clip, sink back slowly -- so cresting a ridge doesn't drop the camera
     back down faster than the ground does. */
  const clearance = cameraGroundY(camera.position.x, camera.position.z, vertScale) + 1.6;
  if(camera.position.y < clearance){
    camera.position.y = lerp(camera.position.y, clearance, 1 - Math.pow(0.0005, dt));
  }

  /* LINE OF SIGHT to the avatar, which is a different problem from clearance above.

     Clearance only asks whether the camera itself is buried. Walking DOWN a steep slope
     the camera is perfectly clear -- it is standing on the hillside above, in open air --
     and yet the brow of that same hill sits squarely between it and the pup, so you
     descend the whole slope watching the back of a ridge. The rig was never told to care
     about the ground BETWEEN the two points.

     So sample the segment camera->look target and ask, at each step, how high the camera
     would have to be for the sightline to pass over the ground there. Take the worst
     answer. The algebra is just similar triangles: the line reaches y_cam + (y_look -
     y_cam)*s at fraction s, and requiring that to clear g gives
     y_cam >= (g - y_look*s)/(1 - s). Samples very near the target are skipped -- there
     1-s tends to zero and the requirement explodes, and ground that close to the avatar
     is the avatar's own bench, not an occluder.

     Rises fast, settles slowly, same reasoning as clearance: popping up to see is
     worth it, dropping back down the instant a bump passes is just jitter. */
  {
    const N = 6;
    let needY = camera.position.y;
    for(let i=1;i<N;i++){
      const s = i/N;
      if(s > 0.75) break;
      const sx = lerp(camera.position.x, px, s);
      const sz = lerp(camera.position.z, pz, s);
      const gy = cameraGroundY(sx, sz, vertScale) + 0.8;   // a little headroom over the brow
      const req = (gy - lookY*s)/(1 - s);
      if(req > needY) needY = req;
    }
    if(needY > camera.position.y){
      camera.position.y = lerp(camera.position.y, needY, 1 - Math.pow(0.0008, dt));
    }
  }

  camLook.x = lerp(camLook.x, px, 1 - Math.pow(0.0005, dt));
  camLook.z = lerp(camLook.z, pz, 1 - Math.pow(0.0005, dt));
  camLook.y = lookY;
  camera.lookAt(camLook);
}

export { updateChaseCam, snapChaseCam, getCamYaw, setCamYaw, addCamYaw,
         getCamPitch, addCamPitch, getCamZoom, addCamZoom, PITCH_MIN, PITCH_MAX };
