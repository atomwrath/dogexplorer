/* Neon Rush balance, in one place. No logic. Everything is real metres and seconds:
   the map is raced at 1:1, so a number here means what it says. */

const NEON = {
  // --- the ribbon ---
  sampleM:    4,        // centreline sample spacing
  halfWidth:  {trail: 4.2, track: 5.0, road: 6.2},
  minRadiusPad: 3.5,    // centreline radius is never tighter than halfWidth + this
  vertScale:  1.5,      // how much taller the hills LOOK. Physics uses true slope.
  lift:       2.2,      // deck height above the wireframe ground

  // --- the board ---
  thrust:     7.2,      // m/s^2 at full throttle
  boostThrust:6.5,      // extra, while boosting
  dragK:      0.0145,   // v^2 drag: flat-ground top speed = sqrt(thrust/dragK) ~ 22 m/s
  rollK:      0.05,     // linear rolling loss
  brake:      14,
  steerRate:  2.1,      // rad/s at full lock, low speed
  steerFade:  0.022,    // lock shrinks with speed: rate / (1 + v*steerFade)
  railAssist: 0.55,     // share of the track's own bend the board follows unprompted
  maxSlip:    1.15,     // rad; you can carve, you cannot turn round
  // --- gravity ---
  gravity:    9.81,
  gravityGain:1.8,      // real trail grades are gentle; this makes 8% feel like a hill
  slopeClamp: 0.22,
  // --- bumpers ---
  bumpKeep:   0.80,     // speed kept after a wall hit ("slow them down a bit")
  bumpRestitution: 0.65,// how much of the into-wall angle comes back out
  bumpKick:   0.16,     // rad, minimum angle you leave the wall at
  bumpLock:   0.18,     // s of reduced steering after a hit, so it reads as a bounce
  // --- battery ---
  boostDrain: 0.30,     // per second
  boostCharge:0.07,     // per second, always
  regenGain:  0.9,      // extra charge per second per unit of downhill slope, gravity on
  // --- racers bumping each other ---
  bodyLen:    2.6,
  bodyWide:   1.5,
};

/* Rival pace as a fraction of what the player's board can do on the flat, and how much
   of the grip the corner-speed sum thinks it has.

   The whole ladder moved up one rung: what used to be the hardest setting is now the
   easiest, because rivals that lose ground on every straight are not opponents, they are
   scenery. `pace` above 1 means a rival out-runs the player's unboosted top speed, so on
   Fair and Fierce the boost battery is not a treat -- it is how you stay in touch, and
   picking where to spend it is the race. */
const NEON_SKILL = {
  chill:  {pace: 1.00, corner: 1.04, wobble: 0.18, label: 'Chill'},
  fair:   {pace: 1.07, corner: 1.16, wobble: 0.10, label: 'Fair'},
  fierce: {pace: 1.14, corner: 1.28, wobble: 0.05, label: 'Fierce'},
};

/* Imperial display. Everything inside the game is metres and seconds; these are used at
   the last moment, on the way to the screen. */
const M_PER_MILE = 1609.344, FT_PER_M = 3.280839895;
const miles = m => m/M_PER_MILE;
const feet  = m => m*FT_PER_M;
const mph   = ms => ms*3600/M_PER_MILE;

export { NEON, NEON_SKILL, miles, feet, mph, M_PER_MILE, FT_PER_M };
