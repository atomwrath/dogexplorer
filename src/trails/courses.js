/* Recorded courses: a path the walker traced on the trail network, and the times set on
   it.

   WHY THIS IS A SIBLING OF spots.js AND NOT A FIELD ON IT. A pin is one place; a course is
   an ordered line plus a scoreboard, and three modules need it at once -- main.js writes
   it while you walk and reads it while you race, minimap.js draws it on both canvases,
   course-line.js drapes it over the terrain. Same arrangement as spots.js: this module
   owns the array, everybody else goes through the named functions, and COURSES is cleared
   IN PLACE (see resetCourses) because those other modules hold the reference.

   COORDINATES ARE STORED IN REAL METRES, for exactly the reason spots.js documents at
   length: world scale compacts positions, so a course recorded at 1:5 and raced at 1:32
   would run six kilometres away from the trail it was traced on. coursePoints() converts
   back to world units on every read rather than caching, so a course is correct the
   instant the slider moves and there is no invalidation step to forget.

   THE RACE MEASURES PROGRESS AS A FRACTION, NOT AS AN ARC LENGTH, and that is the same
   decision one level up. A fraction is scale-invariant, so dragging the world-scale slider
   mid-race cannot teleport a runner backwards along their own course. courseProgress()
   below is the whole of the anti-shortcut rule: it will only look FORWARD from where you
   already are and only within a window, so cutting a switchback banks nothing -- you have
   to come back and collect the part you skipped.

   Times are filed per avatar (`times[whoKey]`), because "best time" means two different
   things: the record for this course by anyone, and your own record with the animal you
   are currently playing. The overall best is DERIVED (courseBestOverall) rather than
   stored alongside, so the two can never drift out of agreement.

   Persistence is best-effort and keyed by map, both for the same reasons spots.js is: a
   course traced at Garden of the Gods means nothing on another map, and a private window,
   a disabled store or a full quota are all reasons for a course not to survive a reload
   and none of them is a reason for the walk to stop. */
import { getMapScale } from './world.js';

const COURSES_KEY = 'pup-trails/courses/v1';
const MAX_COURSES = 16;         // the sheet has to stay readable, same argument as MAX_SPOTS

/* Real metres, every one of them -- these are facts about the ground, not about the
   world-scale slider, so none of them is ever multiplied by it.

   COURSE_STEP_M is how far you walk before another point is recorded. Five metres is
   fine enough that a switchback keeps its shape and coarse enough that a two-kilometre
   loop is 400 points rather than tens of thousands.

   COURSE_ON_M is how far you may stray from the line and still be making progress. It is
   deliberately much wider than a trail: the recorded line is a centreline and you are not
   a point, so a runner cutting the inside of a bend is racing, not cheating.

   COURSE_LOOK_M is the anti-shortcut window (see courseProgress). Big enough that a fast
   animal covering ground between two frames cannot stall on its own course, small enough
   that skipping a whole switchback is not survivable. */
const COURSE_STEP_M   = 5;
const COURSE_MIN_M    = 30;     // shorter than this is a stumble, not a course
const COURSE_ON_M     = 14;
const COURSE_FINISH_M = 6;      // close enough to the last point to have finished
const COURSE_LOOK_M   = 45;
/* A JUMP, as opposed to a step. The recorder takes whatever trail is nearest, and near a
   pair of parallel trails "nearest" can flip from one to the other and back between two
   samples -- which writes a zig-zag course that crosses open ground repeatedly and is
   longer than the trail it was traced on. Measured on the default map, a walker holding a
   line 10 m off the centreline recorded 1368 m over a 979 m trail with 36 m gaps in it.

   A real step is at most a stride past the last one. Anything much bigger is the snap
   having changed its mind about which trail you are on, so it is refused -- UNLESS you
   have genuinely been away from any trail for a moment, which is the one case where
   rejoining somewhere else is exactly right. COURSE_REJOIN_S is how long the recorder
   waits before it believes a jump. */
const COURSE_JUMP_M   = 18;
const COURSE_REJOIN_S = 1.2;
/* How far off the centreline still counts as walking the trail. A REAL distance, not a
   world-unit one, which is the whole point: "am I on this path" is a question about the
   ground and its answer must not change when the world-scale slider moves. Six metres is
   a wide trail plus a verge; beyond that you are walking beside the trail, and the honest
   record of that is a gap in the trace rather than a guess at which trail you meant. */
const COURSE_SNAP_M   = 6;

/* --- relief ---------------------------------------------------------------------------

   RELIEF_TH is the hysteresis a climb has to beat before it counts. Elevation comes from
   a DEM sampled every few metres, and a DEM has noise in it; summing every rise between
   consecutive samples turns that noise into hundreds of metres of imaginary climbing on a
   flat kilometre. Every device that reports "total ascent" applies a threshold like this
   for the same reason, and the number here (2 m) is in the usual range. It costs at most
   RELIEF_TH of real climb at the end of a leg, which is the right trade: undercounting a
   hill by two metres is invisible, overcounting a flat by two hundred is not. */
const RELIEF_TH = 2;
const COURSE_MAX_PTS  = 4000;   // 20 km at COURSE_STEP_M; a cap on what one record can cost

/* --- ghosts ---------------------------------------------------------------------------

   A ghost is where the record-holder WAS, at a fixed cadence. Stored as bare positions at
   GHOST_DT apart with no timestamps, because the cadence is the timestamp: sample n is the
   position at n*GHOST_DT seconds into the run. That halves the record and removes the one
   thing that could ever be inconsistent with itself.

   Real metres again, for the third time in this file and for the third identical reason: a
   ghost recorded at 1:5 and chased at 1:32 would otherwise run off the edge of the map.

   GHOST_KEEP bounds what all this costs. Ghost tracks are much larger than the times they
   belong to, and a course with a dozen animals' records on it would carry a dozen of them;
   only the fastest few are ever raced against, so only the fastest few keep their track.
   The TIMES all survive -- it is the tracks that are pruned, so the scoreboard is never
   quietly shortened to save space. */
const GHOST_DT   = 0.25;
const GHOST_MAX  = 1200;        // five minutes at GHOST_DT; longer runs stop recording
const GHOST_KEEP = 3;

/* Cleared in place, never reassigned -- see the module header. */
const COURSES = [];
let courseMapId = 'default';
let nextCourseId = 1;

function setCourseMap(id){
  const next = String(id || 'default');
  if(next === courseMapId) return;
  courseMapId = next;
  readCourses();
}
function getCourseMap(){ return courseMapId; }

function courseStore(){
  try{ return window.localStorage || null; }catch(err){ return null; }
}

/* Length of a real-metre polyline. Named apart from geo.js's polyLen because that one
   works in world units on graph geometry and these two must never be swapped by accident:
   they differ by exactly the factor this whole module exists to keep straight. */
function polyLenM(pts){
  let L = 0;
  for(let i=1;i<pts.length;i++) L += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  return L;
}

/* A stored scoreboard is the one part of a course record that came from an older build,
   so it is validated rather than trusted: a time of zero, a NaN or a non-object would each
   quietly win every comparison below and pin an unbeatable record on the course forever. */
function cleanTimes(raw){
  const out = {};
  if(!raw || typeof raw !== 'object') return out;
  for(const k of Object.keys(raw)){
    const v = raw[k];
    if(!v || !isFinite(v.t) || +v.t <= 0) continue;
    const e = {t:+v.t, name:String(v.name || k), at:+v.at || 0};
    // a ghost is optional: an entry from before ghosts existed, or one whose track was
    // pruned, is a perfectly good time and must not be discarded along with its track
    if(Array.isArray(v.g) && v.g.length > 1){
      const g = v.g.filter(q => Array.isArray(q) && q.length >= 2 && isFinite(q[0]) && isFinite(q[1]))
                   .map(q => [+q[0], +q[1]]);
      if(g.length > 1){
        e.g = g;
        // gt defaults to the entry's time for records written before tracks carried their
        // own, which is right: back then the two could not differ
        e.gt = isFinite(v.gt) && +v.gt > 0 ? +v.gt : e.t;
      }
    }
    out[String(k)] = e;
  }
  return out;
}

function readCourses(){
  COURSES.length = 0;
  nextCourseId = 1;
  const st = courseStore();
  if(!st) return COURSES;
  let all = null;
  try{ all = JSON.parse(st.getItem(COURSES_KEY) || '{}'); }
  catch(err){ all = null; }
  const mine = (all && all[courseMapId]) || [];
  for(const c of mine){
    if(!c || !Array.isArray(c.pts)) continue;
    const pts = c.pts
      .filter(p => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]))
      .map(p => [+p[0], +p[1]]);
    if(pts.length < 2) continue;
    COURSES.push({id:nextCourseId++, name:String(c.name || 'Course'), pts,
                  lenM: isFinite(c.lenM) ? +c.lenM : polyLenM(pts),
                  at:+c.at || 0, times: cleanTimes(c.times)});
  }
  return COURSES;
}

function writeCourses(){
  const st = courseStore();
  if(!st) return false;
  try{
    let all = {};
    try{ all = JSON.parse(st.getItem(COURSES_KEY) || '{}') || {}; }catch(err){ all = {}; }
    // a decimetre is finer than anything the race can tell apart and roughly halves the
    // record; a long course is the only thing here big enough to matter to a quota
    all[courseMapId] = COURSES.map(c => ({
      name:c.name, lenM:+c.lenM.toFixed(1), at:c.at, times:trimTimes(c.times),
      pts:c.pts.map(p => [+p[0].toFixed(1), +p[1].toFixed(1)]),
    }));
    st.setItem(COURSES_KEY, JSON.stringify(all));
    return true;
  }catch(err){
    // quota, private mode, storage disabled -- the session keeps its courses regardless
    return false;
  }
}

/* REAL METRES IN. The recorder works in real metres from the first sample (see main.js's
   `rec`) rather than converting a world-unit trace at save time, so a course recorded
   across a mid-walk change of world scale is still one continuous line. */
/* What actually goes to storage: the whole scoreboard, but only the fastest GHOST_KEEP
   tracks, rounded to a decimetre. Done here rather than at record time so the pruning rule
   lives in one place and a course loaded from an older build is tidied on its next write
   rather than carrying an unbounded pile of tracks forever. */
function trimTimes(times){
  const out = {};
  const keys = Object.keys(times || {}).sort((a, b) => times[a].t - times[b].t);
  keys.forEach((k, i) => {
    const v = times[k];
    out[k] = {t:v.t, name:v.name, at:v.at};
    if(v.g && i < GHOST_KEEP){
      out[k].g = v.g.map(q => [+q[0].toFixed(1), +q[1].toFixed(1)]);
      out[k].gt = v.gt;
    }
  });
  return out;
}

function addCourse(name, pts){
  const clean = (pts || [])
    .filter(p => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]))
    .map(p => [+p[0], +p[1]]);
  if(clean.length < 2) return null;
  const lenM = polyLenM(clean);
  if(lenM < COURSE_MIN_M) return null;
  const c = {id:nextCourseId++,
             name:String(name || '').trim() || ('Course ' + (COURSES.length + 1)),
             pts:clean, lenM, at:Date.now(), times:{}};
  COURSES.push(c);
  // oldest out first, same argument as spots.js: the cap exists to keep the list legible
  while(COURSES.length > MAX_COURSES) COURSES.shift();
  writeCourses();
  return c;
}

function removeCourse(id){
  const i = COURSES.findIndex(c => c.id === id);
  if(i < 0) return false;
  COURSES.splice(i, 1);
  writeCourses();
  return true;
}

function renameCourse(id, name){
  const c = COURSES.find(c => c.id === id);
  if(!c) return false;
  c.name = String(name || '').trim() || c.name;
  writeCourses();
  return true;
}

function resetCourses(){
  COURSES.length = 0;
  writeCourses();
}

function getCourses(){ return COURSES; }
function getCourse(id){ return COURSES.find(c => c.id === id) || null; }

/* Real metres back to the world units everything in src/trails draws in. Derived on every
   read for the same reason spotWorld is -- there is no cache to invalidate, so a course is
   never briefly drawn at the wrong scale. */
function coursePoints(c){
  const k = getMapScale() || 1;
  return c && c.pts ? c.pts.map(p => [p[0]*k, p[1]*k]) : [];
}
function courseLengthM(c){ return c ? (c.lenM || polyLenM(c.pts || [])) : 0; }

/* Which way to face at the start line: along the first leg long enough to have a
   direction. Consecutive points can be a decimetre apart after rounding, and atan2 of two
   nearly-identical points is noise -- which would have the countdown end with the runner
   pointed at a rock for no reason a player could see. */
function courseStartYaw(c){
  const pts = coursePoints(c);
  if(pts.length < 2) return 0;
  const a = pts[0];
  for(let i=1;i<pts.length;i++){
    const dx = pts[i][0]-a[0], dz = pts[i][1]-a[1];
    if(Math.hypot(dx, dz) > 0.5) return Math.atan2(-dz, dx);
  }
  return 0;
}

/* HOW FAR ROUND ARE YOU, and the only rule stopping a runner cutting the course.

   Given the course in WORLD units and a position, this finds the nearest point on the
   line -- but only within [fromFrac, fromFrac + lookFrac] of the course. Two consequences,
   both deliberate:

     you cannot go backwards.  A loop that crosses itself would otherwise hand back the
                               wrong crossing and either freeze the clock or finish the
                               race the moment you set off.
     you cannot skip forward.  Leaving the line and rejoining it past the window banks no
                               progress at all: the runner has to return to where they
                               left and collect the missing stretch.

   Returns {frac, d, total} in world units, or null when there is no course to be on.
   The caller decides what `d` is close enough -- this function has no opinion about how
   far off the line is too far, because that is a gameplay tuning question and this is
   geometry. */
function courseProgress(pts, x, z, fromFrac, lookFrac){
  if(!pts || pts.length < 2) return null;
  const arc = [0];
  for(let i=1;i<pts.length;i++)
    arc[i] = arc[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  const total = arc[arc.length-1];
  if(!(total > 0)) return null;
  const lo = Math.max(0, Math.min(1, fromFrac || 0))*total;
  const hi = Math.min(total, lo + Math.max(0, lookFrac == null ? 1 : lookFrac)*total);
  let best = Infinity, bestS = lo;
  for(let i=0;i<pts.length-1;i++){
    if(arc[i+1] < lo || arc[i] > hi) continue;
    const ax = pts[i][0], az = pts[i][1];
    const dx = pts[i+1][0]-ax, dz = pts[i+1][1]-az;
    const segLen = arc[i+1]-arc[i];
    const L2 = dx*dx + dz*dz;
    let t = L2 === 0 ? 0 : ((x-ax)*dx + (z-az)*dz)/L2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    /* Clamp the SAMPLE to the window, not just the segment to it. A single long leg (an
       off-trail gap in the recording) can straddle the whole window, and projecting freely
       onto it would hand back a point past `hi` -- which is the shortcut this function
       exists to refuse. */
    let s = arc[i] + t*segLen;
    if(segLen > 0){
      if(s < lo){ s = lo; t = (lo-arc[i])/segLen; }
      else if(s > hi){ s = hi; t = (hi-arc[i])/segLen; }
    }
    const d = Math.hypot(x-(ax+t*dx), z-(az+t*dz));
    if(d < best){ best = d; bestS = s; }
  }
  if(!isFinite(best)) return null;
  return {frac: bestS/total, d: best, total};
}

/* The window, as a fraction, for a course of this length. Expressed in metres up top and
   converted here so a 60 m sprint and a 3 km loop get the same PHYSICAL tolerance rather
   than the same proportional one -- 5% of a sprint is three metres, which no runner could
   hold, and 5% of the loop is 150 metres of free shortcut. */
function courseLookFrac(c){
  const lenM = courseLengthM(c);
  if(!(lenM > 0)) return 1;
  return Math.max(0.02, Math.min(1, COURSE_LOOK_M/lenM));
}
/* Is this fraction of the way round close enough to the end to have finished? Measured in
   metres from the finish for the same reason the window is. */
function courseFinished(c, frac){
  const lenM = courseLengthM(c);
  if(!(lenM > 0)) return false;
  return (1-frac)*lenM <= COURSE_FINISH_M;
}

/* GAIN, LOSS AND NET for a polyline, in real metres of elevation.

   Unit-agnostic on purpose. `pts` can be in real metres (a course) or in world units (a
   trail route straight off the graph) -- this function never measures a horizontal
   distance, so it does not care. What it does require is that `elevAt` takes points in
   whatever units `pts` uses and hands back REAL metres of height, which is what keeps the
   answer stable when the world-scale and hill-exaggeration sliders move. Sampling the
   drawn terrain instead would report a different climb for the same hill at every setting
   of a slider that exists purely to make the hills easier to look at.

   `net` is the plain end-to-end difference and `gain`/`loss` are the cumulative sums, so a
   loop that comes back to its start reads as 0 m net over however much real climbing it
   actually took -- which is exactly the distinction between the two numbers. */
function polyRelief(pts, elevAt, thresh){
  const TH = thresh == null ? RELIEF_TH : thresh;
  let gain = 0, loss = 0, hi = -Infinity, lo = Infinity;
  let first = null, last = null, anchor = null;
  for(const p of (pts || [])){
    const e = elevAt(p[0], p[1]);
    if(!isFinite(e)) continue;
    if(first == null){ first = e; anchor = e; }
    last = e;
    if(e > hi) hi = e;
    if(e < lo) lo = e;
    // committed in TH-sized bites: a steady climb accumulates all of itself, noise
    // smaller than TH never accumulates at all
    if(e - anchor >= TH){ gain += e - anchor; anchor = e; }
    else if(anchor - e >= TH){ loss += anchor - e; anchor = e; }
  }
  if(first == null) return {gain:0, loss:0, net:0, hi:0, lo:0, range:0, ok:false};
  return {gain, loss, net:last - first, hi, lo, range:hi - lo, ok:true};
}

/* Cached per course, because the list on the map sheet would otherwise re-sample the DEM
   for every course every time it redrew. Keyed on an epoch rather than on a timestamp:
   the answer only changes when the ground does, and afterWorldChange is the one place that
   knows that happened. */
let reliefEpoch = 1;
function bumpRelief(){ reliefEpoch++; }
function courseRelief(c, elevAt){
  if(!c) return {gain:0, loss:0, net:0, hi:0, lo:0, range:0, ok:false};
  if(c._relief && c._reliefAt === reliefEpoch) return c._relief;
  const r = polyRelief(c.pts, elevAt);
  // non-enumerable so the cache never lands in the JSON written to storage
  Object.defineProperty(c, '_relief', {value:r, writable:true, configurable:true});
  Object.defineProperty(c, '_reliefAt', {value:reliefEpoch, writable:true, configurable:true});
  return r;
}

function courseBestFor(c, whoKey){
  return (c && c.times && c.times[String(whoKey)]) || null;
}
/* DERIVED, never stored -- see the module header. */
function courseBestOverall(c){
  if(!c || !c.times) return null;
  let best = null;
  for(const k of Object.keys(c.times)){
    const v = c.times[k];
    if(!best || v.t < best.t) best = {key:k, t:v.t, name:v.name, at:v.at};
  }
  return best;
}
/* The whole scoreboard, fastest first -- what the finish card shows. */
/* The track to chase, and the entry it belongs to, so the HUD can name who you are racing.
   `which` is 'best' (the course record) or 'mine' (your own best with this animal); asking
   for a ghost that does not exist, or one whose track was pruned, returns null and the
   race simply runs without one. */
function courseGhost(c, which, whoKey){
  if(!c || !c.times) return null;
  /* RESOLVE THE KEY FIRST, THEN READ THE STORED ENTRY. courseBestOverall builds a fresh
     summary object ({key, t, name, at}) and deliberately does not carry the track, so
     asking it for `.g` gets undefined and every ghost silently comes back null. The key it
     returns is the useful part; the entry it names is where the track lives. */
  let key;
  if(which === 'mine'){ key = String(whoKey); }
  else {
    /* The fastest entry that HAS a track, not simply the fastest entry. The record holder
       may predate ghosts or have had its track pruned, and falling through to "no ghost"
       there would hide a perfectly good one belonging to the second-fastest run. */
    let best = null;
    for(const k of Object.keys(c.times)){
      const v = c.times[k];
      if(!v.g || v.g.length < 2) continue;
      const gt = v.gt || v.t;
      if(!best || gt < best.gt) best = {k, gt};
    }
    if(!best) return null;
    key = best.k;
  }
  const src = c.times[key];
  if(!src || !src.g || src.g.length < 2) return null;
  // the TRACK's own time, which is not always the entry's time -- see recordCourseTime
  return {t:src.gt || src.t, name:src.name, key, g:src.g, recordT:src.t};
}

/* Where the ghost was at T seconds into its run, in real metres. Interpolated between the
   two samples either side, because at GHOST_DT the ghost would otherwise visibly hop.
   Returns null once the ghost has finished, which is the signal to stop drawing it -- a
   ghost parked on the finish line while you are still running is a ghost that looks like
   it is waiting for you, and it makes the gap unreadable. */
function ghostAt(g, T){
  if(!g || !g.g || g.g.length < 2) return null;
  const pts = g.g;
  const f = T/GHOST_DT;
  if(f < 0) return pts[0].slice();
  const i = Math.floor(f);
  if(i >= pts.length-1) return null;
  const t = f - i;
  const a = pts[i], b = pts[i+1];
  return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t];
}

function courseTimes(c){
  if(!c || !c.times) return [];
  return Object.keys(c.times)
    .map(k => ({key:k, t:c.times[k].t, name:c.times[k].name, at:c.times[k].at}))
    .sort((a, b) => a.t - b.t);
}

/* Bank a run. Only an improvement is written, so a slow lap can never overwrite a record,
   and the return says which of the two records moved -- the finish card wants to say
   "your best" and "course record" separately, and they are separately true. */
function recordCourseTime(c, whoKey, whoName, secs, ghost){
  if(!c || !isFinite(secs) || secs <= 0) return null;
  const key = String(whoKey || 'unknown');
  const prevMine = courseBestFor(c, key);
  const prevOverall = courseBestOverall(c);
  const improved = !prevMine || secs < prevMine.t;
  const overallImproved = !prevOverall || secs < prevOverall.t;
  if(!c.times) c.times = {};
  const track = (Array.isArray(ghost) && ghost.length > 1) ? ghost.map(q => [+q[0], +q[1]]) : null;

  /* THE TRACK AND THE TIME ARE BANKED SEPARATELY, and this is the whole reason `gt` exists.

     They used to move together: no improvement, no track. That is defensible right up until
     you meet a course carrying times set before ghosts existed -- and every course anybody
     had already recorded is one. Such an entry has a fast time and no track, so the only
     way to get a ghost onto it was to BEAT it, and the only way to practise beating it was
     to race the ghost you could not have. A player could run the same course twenty times
     and never once see a ghost, with nothing on screen explaining why.

     So a track is kept when it is the fastest run we have a RECORDING of, which is a
     different question from the fastest run. `gt` is that track's own time, and it is what
     the HUD labels the ghost with -- so a ghost can honestly be slower than the record
     beside it and say so, rather than silently finishing after a time it claims to be. */
  const prevGT = prevMine && prevMine.g ? (prevMine.gt || prevMine.t) : null;
  const keepTrack = track && (prevGT == null || secs < prevGT);

  const e = improved ? {t:secs, name:String(whoName || key), at:Date.now()}
                     : Object.assign({}, prevMine);
  if(keepTrack){ e.g = track; e.gt = secs; }
  else if(prevMine && prevMine.g){ e.g = prevMine.g; e.gt = prevGT; }
  if(improved || keepTrack){
    c.times[key] = e;
    writeCourses();
  }
  return {improved, overallImproved,
          prevMine: prevMine ? prevMine.t : null,
          prevOverall: prevOverall ? prevOverall.t : null,
          mine: courseBestFor(c, key), overall: courseBestOverall(c)};
}

/* m:ss.d -- tenths, because on a 40-second sprint whole seconds is a coarse enough clock
   that two genuinely different runs routinely tie. */
function fmtRaceTime(secs){
  if(secs == null || !isFinite(secs)) return '—';
  const s = Math.max(0, secs);
  const m = Math.floor(s/60);
  const r = s - m*60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
}
/* Distance, in the same words the walk HUD uses. */
function fmtCourseLen(m){
  return m >= 1000 ? (m/1000).toFixed(2) + ' km' : Math.round(m) + ' m';
}

export { COURSES, MAX_COURSES, COURSE_STEP_M, COURSE_MIN_M, COURSE_ON_M, COURSE_FINISH_M,
         COURSE_LOOK_M, COURSE_MAX_PTS, COURSE_JUMP_M, COURSE_REJOIN_S, COURSE_SNAP_M,
         setCourseMap, getCourseMap, readCourses, writeCourses, addCourse, removeCourse,
         renameCourse, resetCourses, getCourses, getCourse, coursePoints, courseLengthM,
         courseStartYaw, courseProgress, courseLookFrac, courseFinished, courseBestFor,
         courseBestOverall, courseTimes, recordCourseTime, fmtRaceTime, fmtCourseLen,
         polyLenM, polyRelief, courseRelief, bumpRelief, RELIEF_TH,
         courseGhost, ghostAt, trimTimes, GHOST_DT, GHOST_MAX, GHOST_KEEP };
