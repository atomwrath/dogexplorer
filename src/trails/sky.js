/* TIME OF DAY: what sundial.js's answers do to the scene.

   Two modes, and the split is the whole design. `default` is the lighting Pup Trails has
   always had -- a fixed key light over the shoulder, the theme's own sky, no shadows on
   the ground -- and this file guarantees it by RESTORING those values rather than by
   leaving them alone, so switching back out of day/night lands on exactly what you left.
   `daynight` puts the sun and the moon where they really are for the map's own latitude
   and longitude at the date and time you set, and lights the world from there.

   ONE KEY LIGHT, not two. core/render.js's `sun` DirectionalLight is repointed at
   whichever body is doing the lighting; at twilight, when both contribute, its direction
   is the intensity-weighted blend of the two. That is not physics -- there is no single
   direction light coming from two places -- but a second shadow-casting directional light
   doubles the shadow pass for a few minutes of crossover a player will spend seconds in,
   and a hard snap from sun-shadows to moon-shadows as the slider passes sunset is far
   more noticeable than a direction that slides. Both bodies are dim exactly when the
   blend is doing the most work, which is what makes it get away with it.

   WHY THE THEME STILL WINS AT MIDDAY. Every colour here is expressed as a MIX from the
   theme's own palette toward a time-of-day target, never as an absolute. At a high sun
   the mix is zero, so meadow at noon in day/night mode is pixel-for-pixel meadow in
   default mode; the warmth comes in as the sun drops and the landscape keeps its
   identity through it. That also means a new theme needs no entry here.

   SHADOWS ARE A DAY/NIGHT FEATURE, and turning them on is the reason the key light has to
   move. Before this, `sun` sat at a fixed (12,22,8) aimed at the world ORIGIN with a 48
   unit shadow box around it -- on a 2.8 km map that box is somewhere out in the scrub,
   nowhere near the player, so the shadow pass was rendering an empty frustum every frame
   and nothing in the game had receiveShadow set to catch the result anyway. Both halves
   are fixed together: world.js now marks the landscape as receiving, and the box follows
   the walker. In default mode castShadow goes OFF, which is not a downgrade -- with no
   receivers it was drawing a shadow map nothing ever sampled. */
import { clamp } from '../core/math.js';
import { QUALITY } from '../core/quality.js';
import { scene, camera, sun, sunTarget, hemi } from '../core/render.js';
import { THEME } from './themes.js';
import { sunAltAz, moonAltAz, moonBrightSide, phaseName, phaseEmoji,
         zoneOffsetHours, clockToMs, dayEvents, fmtClock, fmtOffset } from './sundial.js';

/* ---------- colour helpers ----------
   Deliberately hex-in, hex-out, doing the arithmetic on plain numbers. THREE.Color has
   lerp/copy/setRGB that would say this more neatly, and none of them exist on the smoke
   harness's duck-typed Color -- which has set(), r/g/b and little else. Eight bits per
   channel is more precision than a light colour needs, and this way every line in this
   file behaves identically under the harness and in the browser. */
function hexNum(c){
  if(typeof c === 'number') return c;
  const s = String(c).replace('#', '');
  return parseInt(s.length === 3 ? s.replace(/./g, m => m + m) : s, 16) || 0;
}
function mixHexes(a, b, t){
  const A = hexNum(a), B = hexNum(b), k = clamp(t, 0, 1);
  const r = Math.round(((A >> 16) & 255) + (((B >> 16) & 255) - ((A >> 16) & 255)) * k);
  const g = Math.round(((A >> 8) & 255) + (((B >> 8) & 255) - ((A >> 8) & 255)) * k);
  const bl = Math.round((A & 255) + ((B & 255) - (A & 255)) * k);
  return (r << 16) | (g << 8) | bl;
}
function scaleHex(c, k){ return mixHexes(0x000000, c, k); }
function col(hex){ return new THREE.Color(hexNum(hex)); }

/* ---------- the ramp ----------

   THE TUNING TABLE. Everything about how the day looks is these eight rows, interpolated
   on the sun's altitude in degrees, and nothing else in this file holds a colour opinion.
   Want a longer golden hour? Move the 4-degree row. Want brighter nights? `hemiAdd` on
   the bottom two rows.

     key / keyMul   the sun's own light: colour, and a multiplier on THEME.sunInt
     tint / mix     what the sky, the fog and the horizon ring lean toward, and how far
     hemiMul        multiplier on THEME.hemiInt -- the ambient fill
     hemiAdd        ambient added AFTER the multiply, so a moonless night still has a
                    floor under it. This is a playability number, not a physical one: a
                    real overcast new-moon night is unplayably black, and a pup you cannot
                    see is not a feature.

   The altitudes are chosen off real twilight boundaries rather than by eye: -6 is civil
   twilight (the sky is genuinely dark below it), 0 is geometric sunset, and the warm rows
   at 4 and 10 are the golden hour photographers actually shoot in. */
const SUN_RAMP = [
  {alt: -90, key: '#3c4a72', keyMul: 0.00, tint: '#0a1330', mix: 1.00, hemiMul: 0.16, hemiAdd: 0.07},
  {alt:  -6, key: '#4b4f82', keyMul: 0.03, tint: '#141d40', mix: 0.94, hemiMul: 0.20, hemiAdd: 0.06},
  {alt:  -2, key: '#c0673f', keyMul: 0.10, tint: '#4a3660', mix: 0.84, hemiMul: 0.34, hemiAdd: 0.04},
  {alt:   0, key: '#ff6f33', keyMul: 0.24, tint: '#dd7040', mix: 0.70, hemiMul: 0.48, hemiAdd: 0.03},
  {alt:   4, key: '#ff9a51', keyMul: 0.52, tint: '#efa06b', mix: 0.48, hemiMul: 0.66, hemiAdd: 0.02},
  {alt:  10, key: '#ffc684', keyMul: 0.78, tint: '#f4cba4', mix: 0.24, hemiMul: 0.84, hemiAdd: 0.01},
  {alt:  20, key: '#ffe7c2', keyMul: 0.94, tint: '#fdf6ea', mix: 0.07, hemiMul: 0.96, hemiAdd: 0.00},
  {alt:  45, key: '#fff4de', keyMul: 1.00, tint: '#ffffff', mix: 0.00, hemiMul: 1.00, hemiAdd: 0.00},
];
/* Moonlight. Cool rather than white because that is how a lit landscape under a full moon
   reads to the eye, and because it has to be unmistakably NOT the sun at the crossover. */
const MOON_COL = '#9fb4e0';
const MOON_MAX = 0.30;          // full moon, high in the sky, against THEME.sunInt

function rampAt(alt){
  const R = SUN_RAMP;
  if(alt <= R[0].alt) return R[0];
  if(alt >= R[R.length - 1].alt) return R[R.length - 1];
  let i = 0;
  while(i < R.length - 2 && alt > R[i + 1].alt) i++;
  const a = R[i], b = R[i + 1];
  const t = (alt - a.alt) / (b.alt - a.alt);
  return {
    alt,
    key: mixHexes(a.key, b.key, t),
    keyMul: a.keyMul + (b.keyMul - a.keyMul) * t,
    tint: mixHexes(a.tint, b.tint, t),
    mix: a.mix + (b.mix - a.mix) * t,
    hemiMul: a.hemiMul + (b.hemiMul - a.hemiMul) * t,
    hemiAdd: a.hemiAdd + (b.hemiAdd - a.hemiAdd) * t,
  };
}

/* ---------- state ----------
   The clock is a civil calendar date plus minutes past midnight AT THE MAP, not an epoch
   timestamp, because that is what the player set and what the UI shows. Turning it into an
   instant needs the zone offset, which depends on the map -- so it is derived on every
   refresh rather than stored, and a map swap moves the sun without the clock changing. */
let MODE = 'default';                 // 'default' | 'daynight'
let CLOCK = null;                     // {y, m, day, minutes}
let PLACE = null;                     // {lat, lon, zSouth}
let skyBackdropG = null;
let SKY = null;                       // last computed state, for the UI and the harness

/* The map's own coordinates, handed over by world.js on every rebuild. zSouth says which
   way the world's +z axis points, which is the one thing that can silently mirror the
   whole sky: every shipped bundle is +z south, but the bundle format allows +z north and
   a sun rising in the west is a bug nobody would think to look for in a projection flag. */
function setSkyPlace(lat, lon, zSouth){
  const ok = Number.isFinite(lat) && Number.isFinite(lon);
  PLACE = ok ? {lat: +lat, lon: +lon, zSouth: zSouth !== false} : null;
  refreshSky();
}
function getSkyPlace(){ return PLACE; }
/* No map, or a map with no georeference: Garden of the Gods. The alternative is refusing
   to light the scene at all, which would make "day/night does nothing on this map" a
   thing a player has to diagnose. */
const FALLBACK_PLACE = {lat: 38.8739, lon: -104.8834, zSouth: true};
function place(){ return PLACE || FALLBACK_PLACE; }

function nowClock(){
  const t = new Date();
  return {y: t.getFullYear(), m: t.getMonth() + 1, day: t.getDate(),
          minutes: t.getHours() * 60 + t.getMinutes()};
}
function getSkyClock(){ return CLOCK ? Object.assign({}, CLOCK) : nowClock(); }
function setSkyClock(c){
  if(!c) return;
  const base = getSkyClock();
  CLOCK = {
    y: Number.isFinite(+c.y) ? +c.y : base.y,
    m: Number.isFinite(+c.m) ? +c.m : base.m,
    day: Number.isFinite(+c.day) ? +c.day : base.day,
    minutes: clamp(Number.isFinite(+c.minutes) ? +c.minutes : base.minutes, 0, 1439),
  };
  refreshSky();
}
function getSkyMode(){ return MODE; }
/* Returns whether it changed, so the caller can skip the world-lighting reapply that a
   no-op mode set would otherwise trigger. */
function setSkyMode(m){
  const next = m === 'daynight' ? 'daynight' : 'default';
  if(next === MODE) return false;
  MODE = next;
  if(MODE === 'daynight' && !CLOCK) CLOCK = nowClock();
  return true;
}
function skyState(){ return SKY; }

/* ---------- the celestial bodies ----------
   Sprites rather than meshes: a disc in the sky has to face the camera, and a Sprite is
   the one thing in three.js that does that for free. They live in `scene` and NOT in
   worldG for the same reason shadow.js's blob does -- worldG is emptied and rebuilt on
   every scale, exaggeration and theme change, and the sky is not part of the map. */
let sunSprite = null, moonSprite = null, moonTexKey = '';

/* Soft-edged disc with a halo. The gradient is what makes it read as a light source
   rather than a sticker; wrapped in try/catch because headless harnesses stub canvas
   loosely and a missing sky disc is a cosmetic loss, not a broken boot. */
function discTexture(inner, outer){
  try{
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    if(!g || typeof g.createRadialGradient !== 'function') return null;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, inner);
    grd.addColorStop(0.42, inner);
    grd.addColorStop(0.52, outer);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }catch(err){ return null; }
}

/* The moon, with its phase cut out of it.

   Drawn rather than shaded: the disc is painted, then the dark part is REMOVED with a
   destination-out pass, so the unlit limb is genuinely transparent and the night sky shows
   through it the way it does in life. The terminator is an ellipse whose width is the
   cosine of the phase angle -- that is the actual geometry of a sphere lit from the side,
   and it gives a correct crescent, a straight edge at the quarters and a correct gibbous
   from the same two shapes.

   Rebuilt only when the phase moves by 4% or flips sides, because this is a canvas draw
   and the clock slider fires on every pixel of travel. */
function moonTexture(illum, side){
  try{
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    if(!g || typeof g.createRadialGradient !== 'function') return null;
    const R = 26, cx = 32, cy = 32;
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, 32);
    grd.addColorStop(0, '#fffdf2');
    grd.addColorStop(R / 32 - 0.02, '#f2edda');
    grd.addColorStop(R / 32, 'rgba(226,222,205,0.35)');
    grd.addColorStop(1, 'rgba(226,222,205,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, 32, 0, 6.2832); g.fill();

    // cut away the unlit part
    const k = Math.abs(1 - 2 * clamp(illum, 0, 1));    // 1 at new, 0 at full
    if(illum < 0.995 && typeof g.ellipse === 'function'){
      g.globalCompositeOperation = 'destination-out';
      g.beginPath();
      // the dark half, then the terminator ellipse either added to it or carved out of it
      g.arc(cx, cy, R + 0.5, -Math.PI / 2, Math.PI / 2, side > 0);
      /* WHICH WAY ROUND the terminator runs decides crescent from gibbous, and this had it
       backwards: the dark half is swept top -> bottom on the side away from the sun, and
       the ellipse closes the shape bottom -> top. For a CRESCENT the dark region is MORE
       than half, so the ellipse has to bulge into the lit half (sweep through the sun's
       side); for a GIBBOUS it is less than half, so it bulges back into the dark half.
       The flags were swapped, which is why a 97% moon drew as a hairline ring and a new
       moon as a full disc -- at k=1 the ellipse exactly cancels the dark half. */
    g.ellipse(cx, cy, R * k, R, 0, Math.PI / 2, -Math.PI / 2, illum > 0.5 ? side < 0 : side > 0);
      g.closePath();
      g.fill();
      g.globalCompositeOperation = 'source-over';
    }
    return new THREE.CanvasTexture(cv);
  }catch(err){ return null; }
}

/* TEST SEAM: how much of the disc the drawn texture actually leaves lit, measured on the
   texture's own pixels, so a check can compare it with the phase it was drawn for rather
   than trusting the path arithmetic above. null where there is no canvas to draw on. */
function moonTextureLitFrac(illum, side){
  const tex = moonTexture(illum, side);
  const cv = tex && tex.image;
  if(!cv || typeof cv.getContext !== 'function') return null;
  const d = cv.getContext('2d').getImageData(0, 0, 64, 64).data;
  let lit = 0, disc = 0;
  for(let y=0; y<64; y++) for(let x=0; x<64; x++){
    if(Math.hypot(x + 0.5 - 32, y + 0.5 - 32) > 24) continue;
    disc++; if(d[(y*64 + x)*4 + 3] > 128) lit++;
  }
  return disc ? lit / disc : null;
}

function ensureBodies(){
  if(sunSprite) return;
  try{
    const mk = tex => {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex || null, color: 0xffffff, transparent: true,
        /* depthTest ON. This is the same fix pieces.js's buildFloatingLabel already made
           for area names, and for the same reason: with it off, the disc paints through
           everything in front of it -- a ridge, a rock mass, a tree -- because a
           depth-disabled draw wins on order alone, not on which surface is actually
           nearer the camera. A sun that is always visible can never set. depthWrite
           stays off: the disc is a translucent gradient, and writing depth from it would
           let its own faint edge wrongly occlude whatever's directly behind it. */
        fog: false, depthTest: true, depthWrite: false,
      }));
      /* renderOrder no longer does the occlusion work -- depthTest above does, against
         whatever the depth buffer already holds. This just keeps the disc from being
         submitted ahead of opaque geometry that shares its exact depth (the far edge of
         the horizon ring), which is a submission-order nicety, not a correctness one. */
      m.renderOrder = -11;
      m.frustumCulled = false;
      m.visible = false;
      scene.add(m);
      return m;
    };
    sunSprite = mk(discTexture('rgba(255,250,230,1)', 'rgba(255,214,150,0.55)'));
    sunSprite.name = 'skySun';
    moonSprite = mk(null);
    moonSprite.name = 'skyMoon';
  }catch(err){ sunSprite = moonSprite = null; }
}

/* Azimuth/altitude -> a unit vector in world space. Compass azimuth runs from north
   clockwise through east; the world is +x east, and +z is south on every bundle the game
   ships (see setSkyPlace for why that is not assumed). */
function skyVector(alt, az, zSouth){
  const ca = Math.cos(alt * Math.PI / 180);
  const east = ca * Math.sin(az * Math.PI / 180);
  const north = ca * Math.cos(az * Math.PI / 180);
  return {x: east, y: Math.sin(alt * Math.PI / 180), z: zSouth ? -north : north};
}

/* ---------- applying it ----------

   Called from world.js's applyThemeLighting, which has just written the theme's own sky,
   fog colour, hemisphere light and sun intensity. In default mode that is the finished
   answer and this does nothing but park the light where it has always been. In day/night
   mode this is the second half: the theme values are the BASE the ramp mixes away from,
   which is why the order matters and why there is no path that applies one without the
   other. Fog DISTANCES are never touched here -- those belong to the map scale and the
   fog slider, both of which are world.js's business. */
function refreshSky(){
  ensureBodies();
  if(MODE !== 'daynight'){
    SKY = null;
    restoreDefaultKey();
    tintBackdrop(null, 0);
    if(sunSprite) sunSprite.visible = false;
    if(moonSprite) moonSprite.visible = false;
    return;
  }
  const P = place();
  const C = getSkyClock();
  const zone = zoneOffsetHours(P.lon, C.y, C.m, C.day);
  const ms = clockToMs(C.y, C.m, C.day, C.minutes, zone.hours);
  const S = sunAltAz(ms, P.lat, P.lon);
  const M = moonAltAz(ms, P.lat, P.lon);
  const R = rampAt(S.alt);

  /* Moonlight fades in as the moon clears the horizon AND as the sun leaves the sky:
     a daylight moon is a lovely thing to look at and contributes no visible light, so
     the second factor is what keeps it from washing out a sunset. */
  const moonUp = clamp(M.alt / 10, 0, 1);
  const sunGone = clamp(-S.alt / 6, 0, 1);
  const moonI = MOON_MAX * THEME.sunInt * (0.15 + 0.85 * M.illum) * moonUp * sunGone;
  const sunI = THEME.sunInt * R.keyMul;

  /* One light, blended. See the module header: physically wrong, visually right, and only
     ever doing real work in the few minutes where both bodies are dim. */
  const total = sunI + moonI;
  const w = total > 1e-6 ? moonI / total : 0;
  const sv = skyVector(S.alt, S.az, P.zSouth);
  const mv = skyVector(M.alt, M.az, P.zSouth);
  const dir = {x: sv.x + (mv.x - sv.x) * w, y: sv.y + (mv.y - sv.y) * w, z: sv.z + (mv.z - sv.z) * w};
  const L = Math.hypot(dir.x, dir.y, dir.z) || 1;
  dir.x /= L; dir.y /= L; dir.z /= L;
  /* A key light at or below the horizon rakes the terrain at a grazing angle, which on a
     stepped toon heightfield is all shadow acne and nothing else. Floor the elevation so
     the last of the light still comes from slightly above. */
  if(dir.y < 0.08){ dir.y = 0.08; const l2 = Math.hypot(dir.x, dir.y, dir.z) || 1; dir.x /= l2; dir.y /= l2; dir.z /= l2; }

  const keyCol = mixHexes(R.key, MOON_COL, w);
  const skyHex = mixHexes(THEME.sky, R.tint, R.mix);

  sun.color = col(keyCol);
  sun.intensity = total;
  hemi.color = col(mixHexes(THEME.hemiSky, R.tint, R.mix * 0.85));
  hemi.groundColor = col(scaleHex(mixHexes(THEME.hemiGround, R.tint, R.mix * 0.5), 1 - R.mix * 0.55));
  hemi.intensity = THEME.hemiInt * R.hemiMul + R.hemiAdd + moonI * 0.35;

  scene.background = col(skyHex);
  if(scene.fog) scene.fog.color = col(skyHex);
  tintBackdrop(skyHex, R.mix);

  /* The shadow pass is skipped outright whenever the key light is too weak to cast
     anything you would notice -- deep night with the moon down is the common case, and it
     is also the case where a shadow map would be pure cost. */
  const wantShadow = QUALITY.shadows && total > 0.08;
  sun.castShadow = wantShadow;
  /* Sized whether or not it is switched on, because the box belongs to the MODE and the
     switch belongs to the device: core/quality.js's watchdog drops a tier mid-walk on a
     struggling tablet and can raise nothing back, so a frustum sized only on the path
     where shadows happened to be enabled is a frustum that can be left stale by a tier
     change. It is half a dozen field writes behind an already-sized early return. */
  sizeShadowCamera();

  placeBody(sunSprite, sv, S.alt > -2.5, mixHexes('#ffffff', R.key, 0.55));
  const mside = moonBrightSide(M.az, S.az);
  const mkey = Math.round(M.illum * 25) + (mside > 0 ? 'R' : 'L');
  if(moonSprite && mkey !== moonTexKey){
    const tex = moonTexture(M.illum, mside);
    if(tex){
      if(moonSprite.material.map && moonSprite.material.map.dispose) moonSprite.material.map.dispose();
      moonSprite.material.map = tex;
      moonSprite.material.needsUpdate = true;
    }
    moonTexKey = mkey;
  }
  // a daylight moon is pale against a bright sky, not a glowing disc
  placeBody(moonSprite, mv, M.alt > -1.5 && M.illum > 0.02,
            mixHexes('#ffffff', skyHex, clamp(R.keyMul * 0.55, 0, 0.5)));

  const ev = dayEvents(C.y, C.m, C.day, P.lat, P.lon, zone.hours);
  SKY = {
    sunAlt: S.alt, sunAz: S.az, moonAlt: M.alt, moonAz: M.az,
    illum: M.illum, waxing: M.waxing,
    phase: phaseName(M.illum, M.waxing), emoji: phaseEmoji(M.illum, M.waxing),
    keyIntensity: total, sunIntensity: sunI, moonIntensity: moonI,
    keyColor: keyCol, skyColor: skyHex, hemiIntensity: hemi.intensity,
    dir, night: S.alt < -6, golden: S.alt > -6 && S.alt < 10,
    zoneHours: zone.hours, zoneLocal: zone.local, zoneLabel: fmtOffset(zone.hours),
    lat: P.lat, lon: P.lon, ms,
    rise: ev.rise, set: ev.set, noonAlt: ev.noonAlt,
    polarDay: ev.polarDay, polarNight: ev.polarNight,
    shadows: wantShadow,
  };
}

function placeBody(sprite, v, visible, tint){
  if(!sprite) return;
  sprite.visible = !!visible;
  if(!visible) return;
  sprite.material.color = col(tint);
  /* Distance is a fraction of the far plane rather than a constant: world.js pulls the far
     plane in to meet the fog, so a fixed 900 would be outside the frustum on a compacted
     map and the sun would vanish. Apparent size is what actually matters and that is held
     constant by scaling with the same number. */
  const D = Math.max(60, camera.far * 0.78);
  sprite.position.set(camera.position.x + v.x * D, camera.position.y + v.y * D, camera.position.z + v.z * D);
  sprite.scale.set(D * 0.075, D * 0.075, 1);
}

/* The horizon ring is MeshBasicMaterial and deliberately exempt from fog and from
   lighting (pieces.js), so it is the one thing in the scene that will happily stay
   noon-bright at midnight. Tinting it toward the sky colour is what keeps the mountains
   as a silhouette rather than a glowing cutout.

   THE MIX HAS TO HAPPEN IN DISPLAY SPACE. render.js sets outputEncoding = sRGB, so a
   material colour is read as LINEAR and brightened on the way out -- but scene.background
   is not, it goes to the screen as written. Mixing a band 90% toward the sky hex in the
   material's own terms therefore produced #222e4d, which the encoder then lifted to about
   #6b7aa0: a lavender ridge glowing against a #141e3f sky, three times lighter than the
   sky it was meant to disappear into. So each band's base is first ENCODED to what it
   actually looks like, mixed with the sky as it actually looks, and the result DECODED
   back to linear for the material. At mix 0 that round trip returns the base unchanged,
   so the daytime look is exactly what it was.

   Two more things a real skyline does:
   - at night a ridge is darker than the sky behind it -- it is the sky that carries the
     glow -- so the night target is the sky pulled toward black, not the sky itself;
   - farther bands sit closer to the sky colour than nearer ones (aerial perspective),
     so the tint is scaled by band, outermost most.

   Base colours are captured lazily on first touch, per mesh, so a rebuilt backdrop starts
   from its own theme colours rather than from whatever tint the last one ended on. */
function srgbToLinearHex(h){
  const f = c => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c + 0.055)/1.055, 2.4); };
  const n = hexNum(h);
  return (Math.round(f((n >> 16) & 255)*255) << 16) | (Math.round(f((n >> 8) & 255)*255) << 8) | Math.round(f(n & 255)*255);
}
function linearToSrgbHex(h){
  const f = c => { c /= 255; return c <= 0.0031308 ? c*12.92 : 1.055*Math.pow(c, 1/2.4) - 0.055; };
  const n = hexNum(h);
  const g = c => clamp(Math.round(f(c)*255), 0, 255);
  return (g((n >> 16) & 255) << 16) | (g((n >> 8) & 255) << 8) | g(n & 255);
}
const NIGHT_RIDGE_DARK = 0.28;   // how far below the sky a ridge sits at full night
/* The colour a band should LOOK on screen, as a hex, for a given sky and ramp mix. */
function backdropShown(baseLinear, skyHex, mix, band, bands){
  const shown = linearToSrgbHex(baseLinear);
  if(skyHex == null) return shown;
  const target = scaleHex(skyHex, 1 - NIGHT_RIDGE_DARK*clamp(mix, 0, 1));
  const depth = bands > 1 ? band/(bands - 1) : 0;          // 0 nearest .. 1 farthest
  return mixHexes(shown, target, clamp(mix*(0.86 + 0.12*depth), 0, 1));
}
function tintBackdrop(skyHex, mix){
  if(!skyBackdropG || typeof skyBackdropG.traverse !== 'function') return;
  skyBackdropG.traverse(o => {
    if(!o.material || !o.material.color) return;
    if(o.userData.skyBase == null) o.userData.skyBase = o.material.color.getHex();
    const band = o.userData.band || 0, bands = o.userData.bands || 1;
    o.material.color = col(skyHex == null ? o.userData.skyBase
      : srgbToLinearHex(backdropShown(o.userData.skyBase, skyHex, mix, band, bands)));
  });
}
function setSkyBackdrop(g){
  skyBackdropG = g || null;
  if(SKY) tintBackdrop(SKY.skyColor, rampAt(SKY.sunAlt).mix);
}

/* ---------- the key light's position ----------

   Direction is set by refreshSky; this is the other half, and it runs every frame because
   a directional light's shadow frustum is finite and has to be wherever the player is.
   The light itself is placed KEY_DIST up the light vector from the focus, which has to
   clear local relief or a hill between the light and the player falls outside the shadow
   camera's near plane and stops casting. */
const KEY_DIST = 110;
/* Half-width of the shadow box in world units. Bigger looks better and blurs: the same
   1024 or 2048 map spread over more ground. 30 covers roughly the near field the fog
   leaves visible at the default scale, which is the ground a walker actually reads
   shadows on. */
const SHADOW_R = 30;
function sizeShadowCamera(){
  const c = sun.shadow && sun.shadow.camera;
  if(!c) return;
  if(c.left === -SHADOW_R && c.far === KEY_DIST * 2.2) return;   // already sized
  c.left = -SHADOW_R; c.right = SHADOW_R; c.top = SHADOW_R; c.bottom = -SHADOW_R;
  c.near = 1; c.far = KEY_DIST * 2.2;
  if(typeof c.updateProjectionMatrix === 'function') c.updateProjectionMatrix();
  /* normalBias, not just bias: terraced terrain meets the light at every angle including
     nearly edge-on risers, and a constant depth bias that clears acne on a flat meadow
     leaves it on a slope. Offsetting along the surface normal scales with the geometry
     instead of fighting it.

     0.025, not the 0.06 this started at. A gate post is a 0.2-radius cylinder and a
     signpost cap is smaller still, and normalBias pushes the SAMPLE POINT that distance
     off the surface before testing it against the shadow map -- on geometry that thin,
     0.06 is 30% of the post's own radius, enough to walk the sample past the far side of
     the post and lose its shadow entirely rather than clean the acne it was meant to
     fix. 0.025 stays comfortably under the radius of the thinnest caster in the scene
     (tuft cones aside, which are too small to shadow anything worth reading regardless)
     while still clearing acne on the terraces, which is a shallower-angle problem than a
     0.06 fix implies. The constant bias below moves a little further negative to make up
     the difference on broad flat ground, where normalBias alone under-corrects. */
  sun.shadow.bias = -0.0007;
  sun.shadow.normalBias = 0.025;
}
function restoreDefaultKey(){
  sun.castShadow = false;
  sun.color = col('#fff1cf');                 // core/render.js's own constructor colour
  sunTarget.position.set(0, 0, 0);
  sun.position.set(12, 22, 8);
}

/* Per frame, from main.js's loop. `focus` is the player, not the camera: the shadow box
   should be centred on what the player is looking AT rather than on a camera rig that
   swings around behind them, or half the box is spent on ground behind the pup. */
function skyFrame(focusX, focusY, focusZ){
  if(MODE !== 'daynight' || !SKY) return;
  const d = SKY.dir;
  sunTarget.position.set(focusX, focusY, focusZ);
  sun.position.set(focusX + d.x * KEY_DIST, focusY + d.y * KEY_DIST, focusZ + d.z * KEY_DIST);
  if(sunSprite && sunSprite.visible) placeBody(sunSprite, skyVector(SKY.sunAlt, SKY.sunAz, place().zSouth), true, sunSprite.material.color.getHex());
  if(moonSprite && moonSprite.visible) placeBody(moonSprite, skyVector(SKY.moonAlt, SKY.moonAz, place().zSouth), true, moonSprite.material.color.getHex());
}

/* One line for the panel: when the sun comes up and goes down at this map on this date,
   what the moon is doing, and which time zone the clock is being read in. The zone note
   is not decoration -- it is the only place the longitude estimate and its daylight-saving
   limit are visible (see sundial.js's zoneOffsetHours). */
function skyReadout(){
  if(MODE !== 'daynight') return 'Default lighting — fixed midday sun, no time of day.';
  if(!SKY) return 'Day & night lighting.';
  const parts = [];
  if(SKY.polarDay) parts.push('☀️ sun never sets today');
  else if(SKY.polarNight) parts.push('🌑 sun never rises today');
  else parts.push('🌅 ' + (SKY.rise == null ? '—' : fmtClock(SKY.rise)) +
                  '  🌇 ' + (SKY.set == null ? '—' : fmtClock(SKY.set)));
  parts.push('☀ ' + SKY.sunAlt.toFixed(0) + '°');
  parts.push(SKY.emoji + ' ' + SKY.phase + ' ' + Math.round(SKY.illum * 100) + '%' +
             (SKY.moonAlt > 0 ? ' · up' : ' · down'));
  parts.push(SKY.zoneLabel + (SKY.zoneLocal ? ' (your device)' : ' (from longitude, no DST)'));
  return parts.join('  ·  ');
}

/* TEST SEAM, and deliberately a READ-BACK rather than a copy of what refreshSky decided:
   it asks the renderer's own scene, hemisphere light and key light what they are currently
   set to. An assertion against skyState() would only prove this file agrees with itself,
   which is exactly the class of test that passes while the screen stays noon-bright.
   `const` bindings do not survive the smoke harness's eval boundary (see shadow.js's
   shadowLift for the same pattern), so scene, sun and hemi are unreachable from an
   assertion without a function to hand them over. */
function skyLights(){
  const hex = c => (c && typeof c.getHex === 'function') ? c.getHex() : c;
  const cam = sun.shadow && sun.shadow.camera;
  return {
    mode: MODE,
    bg: hex(scene.background),
    fog: hex(scene.fog && scene.fog.color),
    hemiI: hemi.intensity, hemiC: hex(hemi.color), hemiG: hex(hemi.groundColor),
    sunI: sun.intensity, sunC: hex(sun.color), cast: !!sun.castShadow,
    tx: sunTarget.position.x, ty: sunTarget.position.y, tz: sunTarget.position.z,
    lx: sun.position.x, ly: sun.position.y, lz: sun.position.z,
    boxL: cam ? cam.left : null, boxFar: cam ? cam.far : null,
    bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
    shadowsWanted: !!QUALITY.shadows,
    sunUp: !!(sunSprite && sunSprite.visible), moonUp: !!(moonSprite && moonSprite.visible),
  };
}

/* TEST SEAM: sunSprite/moonSprite are module-private consts, unreachable from the smoke
   harness's eval boundary on their own (see shadowLift in shadow.js for the same
   pattern). What matters for the "sets behind the landscape" behaviour is entirely in
   these three fields -- if depthTest ever regresses to false here, the disc goes back to
   painting through everything in front of it regardless of what the scene actually looks
   like, so this is what a test should read rather than reconstructing the material from
   scratch. */
function skyOcclusion(){
  const flags = s => s && s.material ? {depthTest: s.material.depthTest, depthWrite: s.material.depthWrite,
                                         fog: s.material.fog, transparent: s.material.transparent} : null;
  return {sun: flags(sunSprite), moon: flags(moonSprite)};
}

export { setSkyMode, getSkyMode, setSkyClock, getSkyClock, setSkyPlace, getSkyPlace,
         skyLights, skyOcclusion,
         setSkyBackdrop, refreshSky, moonTextureLitFrac, backdropShown, linearToSrgbHex, skyFrame, skyReadout, skyState, nowClock,
         SUN_RAMP, rampAt, skyVector, mixHexes };
