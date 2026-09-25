/* Neon Rush balance, in one place. No logic. Everything is real metres and seconds:
   the map is raced at 1:1, so a number here means what it says. */

const NEON = {
  // --- the ribbon ---
  sampleM:    4,        // centreline sample spacing
  halfWidth:  {trail: 5.2, track: 6.0, road: 6.5},
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
  dragK:      0.008125,   // v^2 drag -- LOWER THIS to make the game faster (same effect, opposite knob)
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
  /* Repeat offenders. A wall hit inside bumpWindow of the last one is the SAME mistake
     compounding, not a fresh one: the first costs bumpKeep as always, the second keeps
     only bumpKeep2 of what is left, and the third spins you out to a standstill. Leave the
     window and the count starts again at one. */
  bumpWindow: 1.5,      // s between hits for them to count as a streak
  bumpKeep2:  0.55,     // speed kept on the 2nd hit of a streak (1st hit uses bumpKeep)
  spinS:      1.1,      // s spent spinning after the 3rd hit: no thrust, no steering
  spinTurns:  2,        // full turns the rider makes in that time (visual only)
  /* --- ghosts are solid --- a record you can lean on. A shove pushes one off its line
     and knocks its playback clock back; it then eases back onto the recorded line, and
     the time it lost is added to its finish. Never solid to its own rider. */
  ghostKnock:   0.30,   // playback rate drops by at least this on contact
  ghostRecoverS:1.2,    // s time constant for the rate to come back to 1
  ghostRightW:  2.4,    // rad/s, critically damped spring pulling it back onto its line
  /* A ghost is a record, and a record cannot wait in traffic: it looks ahead along its
     own line and moves its offset round whoever is there, and if it is still wedged
     against the same body after ghostStuckS it slips through them rather than hanging up
     (non-solid until it has come clear, the same phase-in it starts the race with). */
  ghostLookM:   9,      // m ahead along its recorded line it checks for a body in the way
  ghostStuckS:  0.9,    // s of unbroken contact before it slips through
  ghostKnockGap:0.6,    // s a contact has to be broken for before it can knock the clock again
  /* --- boost: a rack of nitro tanks, one burn each ---
     Nothing recharges. You start with a couple and everything after that is picked up off
     the track, which is what makes the cells worth going out of your way for and a burn
     worth saving for the straight that matters. */
  burnS:      1.6,      // how long a burn lasts
  burnLock:   0.45,     // dead time after a burn, so it reads as a discrete shove
  fuelStart:  2,        // nitro tanks on the rack at the lights
  fuelMax:    5,
  // --- nitro pickups sitting on the course ---
  /* IN SETS, side by side across the track: two on a narrow ribbon or every third set,
     otherwise three. A rider can take ONE tank from a set per pass (see stepCells), so the
     leader grabbing the first one leaves the rest for whoever is behind -- a single tank
     used to go to whoever arrived first and nobody else. */
  cellEveryM: 240,      // one SET every so many metres of track
  cellSetMin: 2,        // tanks in the smallest set
  cellSetMax: 3,        // tanks in the largest set
  cellGrab:   1.5,      // how close across the track you have to pass
  cellBackS:  9,        // seconds before a taken tank comes back
  /* --- boost pads painted on the deck ---
     Drive over one and it lights a burn exactly like a nitro tank does, without spending
     a tank. Same trigger area as a pickup (cells.js inGrab). Only laid where a burn is
     worth having and safe to take: a straight, or a climb that is not also a hard bend. */
  padEveryM:  420,      // at most one pad per this much track
  padRunM:    55,       // the track ahead of a pad has to qualify for this far (about one burn)
  padStraightK: 0.006,  // 1/m: bendier than this over the run is not a straight
  padClimbK:  0.016,    // 1/m: a climb may bend a little more than a straight may
  padClimbMin:0.03,     // average grade over the run that counts as uphill
  padClearM:  40,       // keep this far from any nitro set
  padAgainS:  2.5,      // s before the same pad can fire for the same rider again
  // --- racers bumping each other ---
  bodyLen:    2.6,
  bodyWide:   1.5,
};

/* Rival boards. `pace` multiplies the rival's own top speed (and thrust, as the square,
   the same way a speed class does), so above 1 a rival genuinely out-runs your unboosted
   board on the straights. `grip` is the fraction of the true corner limit (racer.js
   cornerLimit) it dares to use: 1 is on the edge, below it lifts off early.

   Calibrated against a rider who holds full throttle and never touches the brake (the
   simplest way a person drives this game): on the test circuits Chill finishes a little
   behind that rider, Fair a touch ahead, Fierce clearly ahead -- so a clean run with no
   nitro beats Chill, and Fair and Fierce need the nitro spent well. */
const NEON_SKILL = {
  chill:  {pace: 0.90, grip: 0.86, wobble: 0.14, label: 'Chill'},
  fair:   {pace: 1.0, grip: 0.93, wobble: 0.08, label: 'Fair'},
  fierce: {pace: 1.07, grip: .99, wobble: 0.04, label: 'Fierce'},
};

/* DRIVING STYLES. The field is animals, and they should not all drive one algorithm
   with different paint. Each species maps to a style; the style bends rivalInput and
   the contact physics:
     pace     its board's top speed, on top of the Pace setting's
     corner   share of the Pace setting's grip it uses (above 1 goes past the real limit
              and WILL find the bumper)
     wobble   how much its line wanders (multiplies the Pace setting's wobble)
     avoid    how early and how wide it goes round someone (0.5 barely bothers, 1.6 gives
              a wide berth and eases off rather than squeeze by)
     aggro    0..1, how much it steers AT someone beside or just ahead instead of round
     mass     share of a shove it keeps (heavier gets pushed less and pushes more)
     hunt     how far out it will change lane for a nitro tank, and how full a rack it
              will still go for one (0 never, 1 normal, 1.6 goes out of its way)
     burn     'straight' burns only out of a corner onto something straight; 'any'
              burns whenever it has a tank and room to gain
     sight    how far ahead it reads the bend (below 1 brakes late and runs wide)
     edge     margin it keeps from the bumpers (1 normal; below 0 it rides them)
     apex     how hard it cuts to the inside of a bend (0.55 was everyone's)
   Bruisers are the big grazers; the skilled are the predators; the timid are the small
   prey animals; the reckless are the ones that climb cliffs and raid bins. */
const NEON_STYLE = {
  bruiser:  {pace: 0.99, corner: 1.00, wobble: 0.8, avoid: 0.45, aggro: 0.75, mass: 1.7, hunt: 0.6, burn: 'straight', sight: 1.0, edge: 1, apex: 0.45, label: 'Bruiser'},
  skilled:  {pace: 1.03, corner: 1.03, wobble: 0.45, avoid: 1.15, aggro: 0.10, mass: 1.0, hunt: 1.0, burn: 'straight', sight: 0.6, edge: 1, apex: 0.6, label: 'Racer'},
  timid:    {pace: 0.98, corner: 0.95, wobble: 0.9, avoid: 1.65, aggro: 0.00, mass: 0.7, hunt: 1.2, burn: 'straight', sight: 1.2, edge: 1.4, apex: 0.4, label: 'Skittish'},
  reckless: {pace: 0.99, corner: 1.08, wobble: 2.2, avoid: 0.75, aggro: 0.35, mass: 1.1, hunt: 1.0, burn: 'any', sight: 0.9, edge: -0.6, apex: 1.0, label: 'Reckless'},
  steady:   {pace: 0.98, corner: 0.97, wobble: 0.5, avoid: 1.25, aggro: 0.00, mass: 1.0, hunt: 1.0, burn: 'straight', sight: 1.1, edge: 1.2, apex: 0.5, label: 'Steady'},
  hunter:   {pace: 1.00, corner: 1.00, wobble: 0.7, avoid: 1.0, aggro: 0.20, mass: 0.9, hunt: 1.7, burn: 'any', sight: 0.9, edge: 1, apex: 0.55, label: 'Scavenger'},
};
const SPECIES_STYLE = {
  bear: 'bruiser', moose: 'bruiser', bighorn: 'bruiser',
  deer: 'skilled', fox: 'skilled', coyote: 'skilled', bobcat: 'skilled',
  rabbit: 'timid', chipmunk: 'timid', squirrel: 'timid',
  goat: 'reckless', raccoon: 'reckless',
  possum: 'steady',
  cat: 'hunter',
};
const styleFor = key => NEON_STYLE[SPECIES_STYLE[key] || 'steady'];

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

export { NEON, NEON_SKILL, NEON_STYLE, SPECIES_STYLE, styleFor, NEON_CLASS, NEON_CAM, miles, feet, mph, M_PER_MILE, FT_PER_M };
