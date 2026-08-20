/* The mutable player state every system pokes at (speed, crouch, stun...).
   Kept in its own tiny module so nothing has to import the whole player. */

const keys = {};
const play = {
  vy:0, jumpY:0, grounded:true,
  barkT:0, barkPulse:0, squash:0,
  phase:0, speedNow:0, runToggle:false, sneakToggle:false,
  crouchAmt:0, hurtCd:0, mudSlow:false,
  stunT:0, tumble:0, groundY:0, waterSlow:0, splashCd:0,
  kb:new THREE.Vector3(),
};

export { play, keys };
