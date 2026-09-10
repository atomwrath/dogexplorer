/* The course, painted on the ground you are about to run over.

   WHY THIS EXISTS AT ALL, given the course is already drawn on both map canvases: a race
   is the one thing in this game you cannot do while reading a map. Every other navigation
   question here ("which trail is this", "where is that pin") is asked standing still, with
   time to look at the disc in the corner. A countdown ending and a clock running is
   exactly the opposite situation, and a route you can only see by looking away from where
   you are running is not a route you can follow.

   NOT A THREE.Line, and noise-ring.js already paid for that lesson in full: WebGL ignores
   `linewidth`, so a LineBasicMaterial is one pixel wide at any distance -- a hairline over
   busy toon terrain -- and a line strung between widely spaced points tunnels straight
   through every terrace riser it spans. So this is a painted STRIP, two vertices per
   course point, and every one of them is dropped onto the ground with the same standingY
   the pup walks on. It drapes over risers instead of cutting through them.

   `groundAt` is passed in rather than imported, same arrangement as the rings: this module
   has no business knowing about world.js, and handing it the caller's own height function
   is what guarantees the ribbon is drawn on the surface the runner is actually standing on
   rather than a second guess at it.

   REBUILT ON DEMAND, NOT PER FRAME. The rings are rebuilt every frame because they move
   with the player and are a few hundred vertices; a course is static and can be thousands,
   so it is built once when a race starts and re-draped only when the ground underneath it
   changes -- which is what refreshCourseLine is for, and why afterWorldChange calls it. */
import { scene } from '../core/render.js';
import { coursePoints } from './courses.js';

const CL_LIFT = 0.24;    // above the trail ribbon AND above both rings, so nothing strobes
const CL_HALF = 0.65;    // half-width in world units: wide enough to read at running speed

let courseLine = null, courseLineGeom = null, courseLineMat = null;
let courseLineRef = null;      // {course, groundAt} -- what to re-drape when asked
let courseLineCount = 0;       // points the current buffer was sized for

/* Bright magenta, which is the point: it is the one colour on this map that no trail, no
   terrain band, no signpost and no animal uses, so there is never a moment where following
   the course means deciding which of two similar lines is the course. */
const COURSE_INK = 0xd94fa0;

function disposeCourseLine(){
  if(courseLine && scene) scene.remove(courseLine);
  if(courseLineGeom && courseLineGeom.dispose) courseLineGeom.dispose();
  if(courseLineMat && courseLineMat.dispose) courseLineMat.dispose();
  courseLine = null; courseLineGeom = null; courseLineMat = null; courseLineCount = 0;
}

function clearCourseLine(){
  courseLineRef = null;
  if(courseLine) courseLine.visible = false;
}

/* Allocate a strip for `n` course points: 2n vertices, 2 triangles per leg. Reallocated
   only when the point COUNT changes -- moving the world-scale slider moves every vertex
   but adds none, so the common case re-drapes into the buffer that is already there. */
function buildCourseStrip(n){
  disposeCourseLine();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n*2*3), 3));
  const idx = [];
  for(let i=0;i<n-1;i++){
    const a = i*2, b = a+1, c = a+2, d = a+3;
    idx.push(a, b, d, a, d, c);
  }
  g.setIndex(idx);
  const m = new THREE.MeshBasicMaterial({
    color:COURSE_INK, transparent:true, opacity:0.62,
    depthWrite:false, side:THREE.DoubleSide,
    // same reasoning as shadow.js and the rings: a surface lying on the ground needs a
    // firm depth bias or it strobes against the ground it is lying on
    polygonOffset:true, polygonOffsetFactor:-10, polygonOffsetUnits:-10,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;     // it spans the whole map; a bounding sphere test would
                                  // cull the far end of a long course out of view
  mesh.renderOrder = 5;
  mesh.name = 'courseLine';
  scene.add(mesh);
  courseLine = mesh; courseLineGeom = g; courseLineMat = m; courseLineCount = n;
  return mesh;
}

/* Write the ribbon's vertices. The offset direction at each point is the average of the
   legs meeting there, so an outside corner widens slightly rather than pinching to a
   point -- the alternative (offsetting by one leg's normal) leaves a visible notch at
   every switchback, and a course made of switchbacks is most of what a trail network is. */
function drapeCourseLine(pts, groundAt){
  if(!courseLineGeom) return;
  const arr = courseLineGeom.attributes.position.array;
  const n = pts.length;
  for(let i=0;i<n;i++){
    const p = pts[i];
    const prev = pts[i>0 ? i-1 : 0], next = pts[i<n-1 ? i+1 : n-1];
    let dx = next[0]-prev[0], dz = next[1]-prev[1];
    const L = Math.hypot(dx, dz);
    if(L > 1e-6){ dx /= L; dz /= L; } else { dx = 1; dz = 0; }
    const nx = -dz, nz = dx;
    for(let e=0;e<2;e++){
      const s = e ? CL_HALF : -CL_HALF;
      const x = p[0] + nx*s, z = p[1] + nz*s;
      const o = (i*2+e)*3;
      arr[o]   = x;
      arr[o+1] = groundAt(x, z) + CL_LIFT;
      arr[o+2] = z;
    }
  }
  courseLineGeom.attributes.position.needsUpdate = true;
  if(courseLineGeom.computeBoundingSphere) courseLineGeom.computeBoundingSphere();
}

/* Show `course` on the ground. Pass null (or a course with nothing in it) to hide it.
   Wrapped, like the rings' ensure functions, because a build with no working WebGL context
   must lose the ribbon and nothing else -- a race with no painted line is still a race. */
function setCourseLine(course, groundAt){
  if(!course || !groundAt){ clearCourseLine(); return null; }
  const pts = coursePoints(course);
  if(pts.length < 2){ clearCourseLine(); return null; }
  courseLineRef = {course, groundAt};
  try{
    if(!courseLine || courseLineCount !== pts.length) buildCourseStrip(pts.length);
    drapeCourseLine(pts, groundAt);
    courseLine.visible = true;
  }catch(err){
    disposeCourseLine();
    return null;
  }
  return courseLine;
}

/* Re-drape whatever is shown, at whatever the world is now. Called after any rebuild --
   contour step, hill exaggeration, landscape, world scale -- because every one of those
   moves the ground out from under a ribbon that was draped onto the old one, and world
   scale moves the course points themselves as well. */
function refreshCourseLine(){
  if(!courseLineRef) return null;
  return setCourseLine(courseLineRef.course, courseLineRef.groundAt);
}

function getCourseLine(){ return courseLine; }
function setCourseLineVisible(v){ if(courseLine) courseLine.visible = !!v; }

export { setCourseLine, refreshCourseLine, clearCourseLine, disposeCourseLine,
         getCourseLine, setCourseLineVisible, COURSE_INK, CL_LIFT, CL_HALF };
