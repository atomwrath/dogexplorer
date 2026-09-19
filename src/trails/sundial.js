/* WHERE THE SUN AND THE MOON ARE, for a place and a moment. Pure maths -- no THREE, no
   DOM, no scene, no module state -- which is the whole point: sky.js turns these answers
   into light and colour, and this file can be checked against an almanac on its own.

   Everything here is Paul Schlyter's "Computing planetary positions", which is the right
   tool for this job rather than a compromise: it is about a hundred lines, it needs no
   ephemeris tables, and it is good to roughly an arcminute for the sun and a few
   arcminutes for the moon after the perturbation terms below. The error that matters to a
   player is the one in RISE TIME, and at these accuracies that is under a minute -- far
   inside the couple of minutes that refraction, the horizon profile and the terrain
   itself already move it by.

   ONE EPOCH, used everywhere: Schlyter's day number `dS` counts days from 2000 Jan 0.0 UT
   (JD 2451543.5), NOT from J2000.0 (JD 2451545.0). The two differ by a day and a half,
   and every orbital constant below is stated against the first one. Mixing them is a 1.5
   day error in the moon's position -- about 19 degrees -- which is exactly the kind of
   bug that still looks plausible on screen, so the conversion happens once, in dayNumber,
   and nothing else in this file touches a Julian date.

   ANGLES ARE DEGREES at every boundary of this module and radians nowhere outside a
   single expression. Trigonometry in degrees is what the source formulae are written in,
   and converting at the call site is how the signs get lost. */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const sinD = a => Math.sin(a * D2R);
const cosD = a => Math.cos(a * D2R);
const tanD = a => Math.tan(a * D2R);
const asinD = v => Math.asin(v < -1 ? -1 : v > 1 ? 1 : v) * R2D;
const atan2D = (y, x) => Math.atan2(y, x) * R2D;
/* 0..360. Needed on every mean element: they are linear in time and run to hundreds of
   thousands of degrees after a couple of decades, and sin/cos of a number that large
   loses real precision in double arithmetic. */
const rev = a => ((a % 360) + 360) % 360;

/* Days since 2000 Jan 0.0 UT, fractional. The 2440587.5 is the Unix epoch as a Julian
   date; 2451543.5 is Schlyter's epoch. */
function dayNumber(ms){ return ms / 86400000 + 2440587.5 - 2451543.5; }

/* UT in hours for the same instant. Taken from the epoch milliseconds directly rather
   than from a Date, because a Date's getUTCHours is the same number arrived at more
   expensively and with a timezone-shaped trap next to it. */
function utHours(ms){
  const day = ms / 86400000;
  return (day - Math.floor(day)) * 24;
}

/* Kepler's equation, iterated. The sun's eccentricity (0.0167) is small enough that
   Schlyter's single closed-form step is exact to well under an arcsecond; the moon's
   (0.0549) is not, and the first version of this file used one step for both and put the
   moon up to a quarter of a degree out. Three Newton steps costs nothing and removes the
   question. */
function eccentricAnomaly(M, e){
  let E = M + R2D * e * sinD(M) * (1 + e * cosD(M));
  for(let i = 0; i < 3; i++){
    const dE = (E - R2D * e * sinD(E) - M) / (1 - e * cosD(E));
    E -= dE;
    if(Math.abs(dE) < 1e-8) break;
  }
  return E;
}

/* Equatorial -> horizontal. `ha` is the local hour angle in degrees, positive west of the
   meridian; azimuth comes back measured from NORTH, increasing to the EAST, which is the
   compass convention and the one sky.js converts into world x/z. */
function horizontal(ha, dec, lat){
  const sinAlt = sinD(lat) * sinD(dec) + cosD(lat) * cosD(dec) * cosD(ha);
  const alt = asinD(sinAlt);
  const az = rev(atan2D(-cosD(dec) * sinD(ha),
                        cosD(lat) * sinD(dec) - sinD(lat) * cosD(dec) * cosD(ha)));
  return {alt, az};
}

/* THE SUN, in ecliptic and equatorial coordinates. Returned as a bag rather than just
   alt/az because the moon's phase needs the sun's ecliptic longitude and its own rise
   calculation needs nothing else -- computing it twice would be the same work and one
   more place for the epoch to drift. */
function solarState(ms){
  const d = dayNumber(ms);
  const w = 282.9404 + 4.70935e-5 * d;        // longitude of perihelion
  const e = 0.016709 - 1.151e-9 * d;          // eccentricity
  const M = rev(356.0470 + 0.9856002585 * d); // mean anomaly
  const obl = 23.4393 - 3.563e-7 * d;         // obliquity of the ecliptic
  const E = eccentricAnomaly(M, e);
  const xv = cosD(E) - e, yv = Math.sqrt(1 - e * e) * sinD(E);
  const r = Math.hypot(xv, yv);
  const lon = rev(atan2D(yv, xv) + w);        // true ecliptic longitude
  const xs = r * cosD(lon), ys = r * sinD(lon);
  const xe = xs, ye = ys * cosD(obl), ze = ys * sinD(obl);
  return {
    d, obl, M, meanLon: rev(w + M), lon, r,
    ra: rev(atan2D(ye, xe)),
    dec: atan2D(ze, Math.hypot(xe, ye)),
  };
}

/* Local sidereal time in degrees. GMST0 comes straight out of the sun's own mean
   longitude, which is why solarState hands it back. */
function siderealDeg(S, ms, lon){
  const gmst0 = S.meanLon / 15 + 12;                 // hours
  return rev((gmst0 + utHours(ms) + lon / 15) * 15);
}

/* Sun altitude/azimuth at (lat, lon) for an instant. */
function sunAltAz(ms, lat, lon){
  const S = solarState(ms);
  const ha = rev(siderealDeg(S, ms, lon) - S.ra);
  const h = horizontal(ha, S.dec, lat);
  return {alt: h.alt, az: h.az, dec: S.dec, lon: S.lon};
}

/* THE MOON. Same machinery plus the five biggest perturbation terms in longitude and
   latitude, which is where the difference between "roughly right" and "the phase matches
   the calendar" lives: evection and the variation alone are more than two degrees between
   them, and two degrees of ecliptic longitude is four hours of the wrong phase. */
function moonAltAz(ms, lat, lon){
  const S = solarState(ms);
  const d = S.d;
  const N = rev(125.1228 - 0.0529538083 * d);   // longitude of the ascending node
  const i = 5.1454;                             // inclination
  const w = rev(318.0634 + 0.1643573223 * d);   // argument of perigee
  const a = 60.2666;                            // semi-major axis, earth radii
  const e = 0.054900;
  const M = rev(115.3654 + 13.0649929509 * d);  // mean anomaly

  const E = eccentricAnomaly(M, e);
  const xv = a * (cosD(E) - e), yv = a * Math.sqrt(1 - e * e) * sinD(E);
  const r0 = Math.hypot(xv, yv), v = atan2D(yv, xv);

  const xh = r0 * (cosD(N) * cosD(v + w) - sinD(N) * sinD(v + w) * cosD(i));
  const yh = r0 * (sinD(N) * cosD(v + w) + cosD(N) * sinD(v + w) * cosD(i));
  const zh = r0 * sinD(v + w) * sinD(i);
  let lonEcl = rev(atan2D(yh, xh));
  let latEcl = atan2D(zh, Math.hypot(xh, yh));
  let r = Math.hypot(xh, yh, zh);

  // the four arguments every perturbation term is built from
  const Ls = S.meanLon;                 // sun's mean longitude
  const Lm = rev(N + w + M);            // moon's mean longitude
  const Ms = S.M;                       // sun's mean anomaly
  const Mm = M;                         // moon's mean anomaly
  const Dm = rev(Lm - Ls);              // mean elongation
  const F = rev(Lm - N);                // argument of latitude

  lonEcl += -1.274 * sinD(Mm - 2 * Dm)        // evection
          +  0.658 * sinD(2 * Dm)             // variation
          -  0.186 * sinD(Ms)                 // yearly equation
          -  0.059 * sinD(2 * Mm - 2 * Dm)
          -  0.057 * sinD(Mm - 2 * Dm + Ms)
          +  0.053 * sinD(Mm + 2 * Dm)
          +  0.046 * sinD(2 * Dm - Ms)
          +  0.041 * sinD(Mm - Ms)
          -  0.035 * sinD(Dm)                 // parallactic equation
          -  0.031 * sinD(Mm + Ms)
          -  0.015 * sinD(2 * F - 2 * Dm)
          +  0.011 * sinD(Mm - 4 * Dm);
  latEcl += -0.173 * sinD(F - 2 * Dm)
          -  0.055 * sinD(Mm - F - 2 * Dm)
          -  0.046 * sinD(Mm + F - 2 * Dm)
          +  0.033 * sinD(F + 2 * Dm)
          +  0.017 * sinD(2 * Mm + F);
  r += -0.58 * cosD(Mm - 2 * Dm) - 0.46 * cosD(2 * Dm);
  lonEcl = rev(lonEcl);

  // ecliptic -> equatorial
  const xg = r * cosD(lonEcl) * cosD(latEcl);
  const yg = r * sinD(lonEcl) * cosD(latEcl);
  const zg = r * sinD(latEcl);
  const xq = xg;
  const yq = yg * cosD(S.obl) - zg * sinD(S.obl);
  const zq = yg * sinD(S.obl) + zg * cosD(S.obl);
  const ra = rev(atan2D(yq, xq));
  const dec = atan2D(zq, Math.hypot(xq, yq));

  const ha = rev(siderealDeg(S, ms, lon) - ra);
  const h = horizontal(ha, dec, lat);
  /* PARALLAX, and unlike most refinements in this file it is visible: the moon is close
     enough that an observer on the surface sees it up to about a degree lower than a
     geocentric calculation says, which is a couple of minutes of rise time and, right at
     moonrise, the difference between a moon on the horizon and a moon that has not come
     up yet. */
  const par = asinD(1 / r);
  const alt = h.alt - par * cosD(h.alt);

  /* PHASE from the elongation between the two ecliptic longitudes -- the geometry itself,
     not a count of days since some new moon. That matters because a day-count drifts, and
     because this way the lit fraction and the moon's position in the sky can never
     disagree with each other. */
  const elong = Math.acos(cosD(S.lon - lonEcl) * cosD(latEcl)) * R2D;
  const illum = (1 - cosD(elong)) / 2;
  const waxing = rev(lonEcl - S.lon) < 180;
  return {alt, az: h.az, illum, waxing, elong, lonEcl};
}

/* The lit side faces the sun, so the crescent's tips point away from it. `az` values are
   compass degrees; the answer is which way the bright limb leans, -1 for one side and +1
   for the other, and it is all sky.js needs to draw the terminator on the right edge. */
function moonBrightSide(moonAz, sunAz){ return rev(sunAz - moonAz) < 180 ? 1 : -1; }

const PHASE_NAMES = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous',
                     'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
const PHASE_EMOJI = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
/* Named from the lit fraction and the direction, not from the elongation, so the name
   always agrees with the picture on screen. The quarters get a band around them rather
   than a single value, because "first quarter" is what a player calls a moon that is
   half lit for about a day either side. */
function phaseIndex(illum, waxing){
  if(illum < 0.04) return 0;
  if(illum > 0.96) return 4;
  if(Math.abs(illum - 0.5) < 0.06) return waxing ? 2 : 6;
  if(illum < 0.5) return waxing ? 1 : 7;
  return waxing ? 3 : 5;
}
function phaseName(illum, waxing){ return PHASE_NAMES[phaseIndex(illum, waxing)]; }
function phaseEmoji(illum, waxing){ return PHASE_EMOJI[phaseIndex(illum, waxing)]; }

/* ---------- clock, calendar and time zone ----------

   THE ZONE IS ESTIMATED, and that is a deliberate limit rather than an unfinished bit.
   Turning a longitude into an IANA zone needs the boundary shapes of every country on
   earth, which is megabytes of polygon nobody wants to download to walk a dog around
   Garden of the Gods. Fifteen degrees of longitude is one hour, so the standard-time
   offset falls straight out of the map's own position.

   What that misses is daylight saving, which is political rather than astronomical and
   cannot be derived from a longitude at all. So there is one exception, and it is the
   case that actually gets played: if the map sits in the SAME zone the device is in, the
   device's own clock rules are used instead, daylight saving and all. A player walking a
   local trail on an August evening gets the sunset they would see out of the window; a
   player exploring a map on the other side of the world gets standard time there, which
   is right in the winter and an hour out in that country's summer. The offset is shown in
   the panel either way, so what you are getting is never a mystery.

   `dst` in the result says which of the two answers came back, purely so the UI can say
   so. */
function zoneOffsetHours(lon, y, m, day){
  const solar = Math.round((Number(lon) || 0) / 15);
  let device = null;
  try{
    // noon local, so the offset is read in the middle of the day rather than on top of
    // the changeover hour, where a 23- or 25-hour day makes it ambiguous
    device = -new Date(y, m - 1, day, 12, 0, 0).getTimezoneOffset() / 60;
  }catch(err){ device = null; }
  if(device != null && Math.abs(device - solar) <= 1) return {hours: device, local: true};
  return {hours: solar, local: false};
}

/* Local civil clock -> epoch ms. `minutes` is minutes past midnight and may sit outside
   0..1440 (the rise/set scanner walks past both ends), which Date.UTC handles by rolling
   the date, exactly as wanted. */
function clockToMs(y, m, day, minutes, offsetHours){
  return Date.UTC(y, m - 1, day, 0, 0, 0) + (minutes - offsetHours * 60) * 60000;
}
function msToClock(ms, offsetHours){
  const t = new Date(ms + offsetHours * 3600000);
  return {y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, day: t.getUTCDate(),
          minutes: t.getUTCHours() * 60 + t.getUTCMinutes()};
}
function fmtClock(minutes){
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function fmtOffset(hours){
  const s = hours < 0 ? '\u2212' : '+';                 // real minus sign, not a hyphen
  const a = Math.abs(hours);
  const w = Math.floor(a), f = Math.round((a - w) * 60);
  return 'UTC' + s + w + (f ? ':' + String(f).padStart(2, '0') : '');
}

/* SUNRISE AND SUNSET BY SCANNING, not by inverting the hour-angle formula.

   The closed form is four lines and is wrong in all the interesting places: it needs the
   equation of time to find solar noon, it divides by cos(lat)cos(dec) and so blows up
   near the poles, and it has no way to express "the sun does not rise today" other than
   an out-of-range acos the caller has to remember to check. Walking the day in ten-minute
   steps and bisecting each crossing is a dozen lines, costs about 150 evaluations of a
   function that is already cheap, handles polar day and polar night by simply finding no
   crossing, and gives the same answer to the second. It runs when the clock or the map
   changes -- never per frame -- so the cost is not worth optimising away.

   -0.833 degrees is the standard rise/set altitude: half a degree of solar radius plus
   about a third of a degree of atmospheric refraction at the horizon. */
const HORIZON_ALT = -0.833;
function dayEvents(y, m, day, lat, lon, offsetHours){
  const altAt = minutes => sunAltAz(clockToMs(y, m, day, minutes, offsetHours), lat, lon).alt;
  const STEP = 10;
  let rise = null, set = null, high = -90, highAt = 0;
  let prev = altAt(0), prevT = 0;
  for(let t = STEP; t <= 1440; t += STEP){
    const cur = altAt(t);
    if(cur > high){ high = cur; highAt = t; }
    const crossed = (prev - HORIZON_ALT) * (cur - HORIZON_ALT) < 0;
    if(crossed){
      // bisect to a quarter of a minute, which is finer than the input can express
      let lo = prevT, hi = t, loV = prev;
      for(let k = 0; k < 12; k++){
        const mid = (lo + hi) / 2, v = altAt(mid);
        if((loV - HORIZON_ALT) * (v - HORIZON_ALT) < 0){ hi = mid; } else { lo = mid; loV = v; }
      }
      const at = (lo + hi) / 2;
      if(cur > prev){ if(rise == null) rise = at; } else if(set == null || rise != null) set = at;
    }
    prev = cur; prevT = t;
  }
  return {rise, set, noon: highAt, noonAlt: high,
          /* No crossing at all means one of two very different days, and the caller has
             to be able to tell them apart to say anything useful. */
          polarDay: rise == null && set == null && high > HORIZON_ALT,
          polarNight: rise == null && set == null && high <= HORIZON_ALT};
}

export { sunAltAz, moonAltAz, moonBrightSide, phaseName, phaseEmoji, phaseIndex,
         zoneOffsetHours, clockToMs, msToClock, fmtClock, fmtOffset, dayEvents,
         solarState, dayNumber, HORIZON_ALT };
