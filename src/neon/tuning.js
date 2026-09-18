/* Neon Rush balance, in one place. No logic. Everything is real metres and seconds:
   the map is raced at 1:1, so a number here means what it says. */

const NEON = {
  // --- the ribbon ---
  sampleM:    4,        // centreline sample spacing
  halfWidth:  {trail: 4.2, track: 5.0, road: 6.2},
  minRadiusPad: 3.5,    // centreline radius is never tighter than halfWidth + this
  vertScale:  1.5,      // how much taller the hills LOOK. Physics uses true slope.
  lift:       2.2,      // deck height above the wireframe ground

  /* --- the board ---
     TOP SPEED, THE ONE NUMBER PEOPLE ASK ABOUT: flat ground, no boost, Standard class, is
         sqrt(thrust / dragK)
     because that is where thrust stops winning and drag catches up (drag grows with v^2,
     thrust does not). Raise thrust or lower dragK to make the whole game faster -- every
     other speed in the file rides on this one: Cruiser/Turbo are multiples of it
     (NEON_CLASS below), a burn adds boostThrust on top of it, and gradeTopSpeed() in
     racer.js solves the same equation with gravity added in for a hill. At the numbers
     below, flat-ground Standard tops out at 60 mph (26.8 m/s); Turbo, at 1.26x, reaches
     75.6 mph. The steering and bumper numbers were tuned against this range -- push it
     much further and a full-lock turn at top speed starts to feel unrecoverable, which is
     the next thing to retune if you do. */
  thrust:     9.0,      // m/s^2 at full throttle -- RAISE THIS to make the game faster
  boostThrust:8.2,      // extra, while a burn is running
  dragK:      0.0125,   // v^2 drag -- LOWER THIS to make the game faster (same effect, opposite knob)
  rollK:      0.05,     // linear rolling loss
  brake:      15,
  steerRate:  2.1,      // rad/s at full lock, low speed
  steerFade:  0.026,    // lock shrinks with speed: rate / (1 + v*steerFade) -- raised alongside
                         // the speed increase, so full lock at 75 mph is still a turn and not a spin
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
  /* --- boost: a rack of rockets, one burn each ---
     Nothing recharges. You start with a couple and everything after that is picked up off
     the track, which is what makes the cells worth going out of your way for and a burn
     worth saving for the straight that matters. */
  burnS:      1.6,      // how long a burn lasts
  burnLock:   0.45,     // dead time after a burn, so it reads as a discrete shove
  fuelStart:  2,        // rockets on the rack at the lights
  fuelMax:    5,
  // --- rocket pickups sitting on the course ---
  cellEveryM: 240,      // one every so many metres of track
  cellGrab:   1.5,      // how close across the track you have to pass
  cellBackS:  9,        // seconds before a taken rocket comes back
  // --- racers bumping each other ---
  bodyLen:    2.6,
  bodyWide:   1.5,
};

/* Rival pace as a fraction of what the player's board can do on the flat, and how much
   of the grip the corner-speed sum thinks it has.

   The whole ladder moved up one rung: what used to be the hardest setting is now the
   easiest, because rivals that lose ground on every straight are not opponents, they are
   scenery. `pace` above 1 means a rival out-runs the player's unboosted top speed, so on
   Fair and Fierce a rocket is not a treat -- it is how you stay in touch, and picking
   where to spend it is the race. */
const NEON_SKILL = {
  chill:  {pace: 1.06, corner: 1.10, wobble: 0.16, label: 'Chill'},
  fair:   {pace: 1.14, corner: 1.22, wobble: 0.09, label: 'Fair'},
  fierce: {pace: 1.22, corner: 1.34, wobble: 0.04, label: 'Fierce'},
};

/* Speed classes. The multiplier is on TOP SPEED; thrust goes as its square so the class
   keeps the same shape of acceleration curve rather than just a different ceiling. Rivals
   race the class you picked, since their pace is a fraction of what your board can do. */
const NEON_CLASS = {
  cruiser:  {top: 0.78, label: 'Cruiser'},
  standard: {top: 1.00, label: 'Standard'},
  turbo:    {top: 1.26, label: 'Turbo'},
};
/* How far back the chase camera sits. */
const NEON_CAM = {
  close:  {dist: 0.62, high: 0.70, label: 'Close'},
  normal: {dist: 1.00, high: 1.00, label: 'Normal'},
  far:    {dist: 1.75, high: 1.55, label: 'Far'},
};

/* Imperial display. Everything inside the game is metres and seconds; these are used at
   the last moment, on the way to the screen. */
const M_PER_MILE = 1609.344, FT_PER_M = 3.280839895;
const miles = m => m/M_PER_MILE;
const feet  = m => m*FT_PER_M;
const mph   = ms => ms*3600/M_PER_MILE;

export { NEON, NEON_SKILL, NEON_CLASS, NEON_CAM, miles, feet, mph, M_PER_MILE, FT_PER_M };
