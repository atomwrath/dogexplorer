/* Reading and writing coordinates a person can type: the pure half of "start where I am".

   No DOM, no world, no geolocation in here, so every function can be asked a question with
   nothing running. locate.js is the half that touches the page.

   WHAT parseLatLon ACCEPTS. A latitude and a longitude, in either order of ceremony:
       38°51′17″ N  104°52′8″ W        degrees, minutes, seconds, hemisphere after
       N 38°51′17″  W 104°52′8″        hemisphere before
       38°51.283′ N, 104°52.133′ W     decimal minutes
       38.85472, -104.86889            decimal degrees, comma, space or semicolon between
       38.85472 N 104.86889 W          decimal degrees with hemispheres
       38 51 17 N 104 52 8 W           plain spaces -- an iPhone keyboard has no ° ′ ″ on it
   Straight quotes stand in for the primes, and the usual lookalikes (º ˚ ’ ” ‘ “ ′ ″) are
   folded first. With hemisphere letters the two halves can come in either order; without
   them the first is the latitude. Anything it is not sure of is null, never a guess: a
   coordinate that quietly lands somewhere else is worse than one that is refused.

   Every name here is unique across the project: build.py flattens the modules into one scope. */

const GI_DEG = /[º˚°]/g;                 // º ˚ °
const GI_MIN = /[′’‘´`ʹ]/g;    // ′ ’ ‘ ´ ` ʹ
const GI_SEC = /[″”“ʺ]/g;           // ″ ” “ ʺ
const GI_NUM = /[-+]?\d+(?:\.\d+)?/g;

/* One coordinate's worth of text -> {value, axis}. `axis` is 'lat' or 'lon' when a hemisphere
   letter says so, null when it does not. */
function giChunk(c){
  const letters = c.match(/[NSEW]/g) || [];
  if(letters.length > 1) return null;
  const hemi = letters[0] || '';
  const nums = c.match(GI_NUM);
  if(!nums || nums.length > 3) return null;
  /* a decimal belongs on the LAST part only: 38.5°51′ is not a coordinate */
  for(let i = 0; i < nums.length - 1; i++) if(nums[i].indexOf('.') >= 0) return null;
  const neg = nums[0].charAt(0) === '-';
  if(neg && hemi) return null;                            // "-104 W" says it twice
  for(let i = 1; i < nums.length; i++) if(/^[-+]/.test(nums[i])) return null;
  const deg = Math.abs(parseFloat(nums[0]));
  const min = nums.length > 1 ? parseFloat(nums[1]) : 0;
  const sec = nums.length > 2 ? parseFloat(nums[2]) : 0;
  if(!(min >= 0 && min < 60 && sec >= 0 && sec < 60)) return null;
  let v = deg + min/60 + sec/3600;
  if(neg || hemi === 'S' || hemi === 'W') v = -v;
  return { value:v, axis: hemi ? ((hemi === 'N' || hemi === 'S') ? 'lat' : 'lon') : null };
}

function parseLatLon(text){
  if(typeof text !== 'string') return null;
  let s = text.toUpperCase().replace(/−/g, '-')
    .replace(GI_DEG, '°').replace(GI_MIN, "'").replace(GI_SEC, '"').replace(/''/g, '"')
    .replace(/\bDEG(?:REES?)?\b/g, '°').replace(/\bMIN(?:UTES?)?\b/g, "'").replace(/\bSEC(?:ONDS?)?\b/g, '"')
    .replace(/\b(?:LATITUDE|LONGITUDE|LAT|LONG|LON|LNG)\b\s*[:=]?/g, ' ')
    .replace(/\bNORTH\b/g, 'N').replace(/\bSOUTH\b/g, 'S').replace(/\bEAST\b/g, 'E').replace(/\bWEST\b/g, 'W');
  if(/[^0-9NSEW\s.,;+\-°'"]/.test(s)) return null;   // anything else is not a coordinate
  const at = [];
  s.replace(/[NSEW]/g, (m, i) => { at.push(i); return m; });
  let chunks = null;
  if(at.length === 2){
    if(s.slice(0, at[0]).trim() === '') chunks = [s.slice(at[0], at[1]), s.slice(at[1])];   // N 38 51 17 W 104 52 8
    else chunks = [s.slice(0, at[0] + 1), s.slice(at[0] + 1)];                               // 38 51 17 N 104 52 8 W
  }else if(at.length === 0){
    const halves = s.split(/[,;]/);
    if(halves.length === 2) chunks = halves;
    else if(halves.length === 1){
      const n = s.match(GI_NUM) || [];
      const k = n.length / 2;
      if(n.length === 2 || n.length === 4 || n.length === 6) chunks = [n.slice(0, k).join(' '), n.slice(k).join(' ')];
    }
  }
  if(!chunks) return null;
  const a = giChunk(chunks[0]), b = giChunk(chunks[1]);
  if(!a || !b) return null;
  let lat, lon;
  if(a.axis && b.axis){
    if(a.axis === b.axis) return null;
    lat = a.axis === 'lat' ? a : b; lon = a.axis === 'lat' ? b : a;
  }else if(!a.axis && !b.axis){ lat = a; lon = b; }
  else return null;                                        // one hemisphere letter between two numbers
  if(!(Math.abs(lat.value) <= 90 && Math.abs(lon.value) <= 180)) return null;
  return { lat: lat.value, lon: lon.value };
}

/* 38.854722 -> 38°51′17″ N. Seconds are whole, rounded, and the carry is handled so 59.6″ does
   not print as 60″. */
function fmtDMS(v, isLat){
  const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
  const a = Math.abs(v);
  let d = Math.floor(a), mf = (a - d)*60, m = Math.floor(mf), s = Math.round((mf - m)*60);
  if(s === 60){ s = 0; m++; }
  if(m === 60){ m = 0; d++; }
  return d + '°' + m + '′' + s + '″ ' + hemi;
}
function fmtLatLonDMS(lat, lon){ return fmtDMS(lat, true) + '  ' + fmtDMS(lon, false); }
function fmtLatLonDec(lat, lon){ return lat.toFixed(5) + ', ' + lon.toFixed(5); }

/* Which way a world-space offset points, as the eight winds. World x is east and z is SOUTH,
   so north is -z. */
const GI_WINDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function geoCompass8(dx, dz){
  const deg = (Math.atan2(dx, -dz)*180/Math.PI + 360) % 360;
  return GI_WINDS[Math.round(deg/45) % 8];
}

/* A real-world distance in metres, for a person: 850 m, 12.4 km, 1,234 km. */
function fmtFarDist(m){
  if(!(m >= 0)) return '';
  if(m < 995) return Math.max(10, Math.round(m/10)*10) + ' m';     // 995 and up rounds to a whole kilometre
  const km = m/1000;
  if(km < 100) return km.toFixed(1) + ' km';
  return Math.round(km).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' km';
}

export { parseLatLon, fmtDMS, fmtLatLonDMS, fmtLatLonDec, geoCompass8, fmtFarDist };
