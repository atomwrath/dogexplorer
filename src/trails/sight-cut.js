/* See-through terrain: when a terrace block stands between the camera and the pup, the
   part of it in the way fades out so the pup stays visible. The camera itself never
   moves for this -- a camera that lifted or pulled in to keep its sightline was tried and
   read as jarring on steep descents, so the chase camera is the plain one and the
   terrain gets out of the way instead.

   Done in the terrain's own fragment shader, like the noise ring (noise-ring.js): every
   pixel of the terrain works out how far it is from the camera->pup sightline and, inside
   a tube round that line, is dropped by an ordered-dither pattern whose density follows
   the fade. Dither ("screen-door") rather than real transparency, because the terrain is
   one big opaque mesh drawn in one pass: alpha blending would need it sorted against
   itself, and a dither needs nothing -- no sorting, no second pass, and the depth buffer
   stays right for everything drawn after it.

   Only what is ABOVE the sightline's lower edge is cut. The ground the pup is standing
   on, and the ground under the line between camera and pup, is below the line, so the
   hole never opens in the floor -- it only opens in walls and block tops that actually
   stand in the way. The fade amount itself comes from main.js, which tests the same
   sightline against the terrain on the CPU each frame (sightBlocked) and eases the
   amount up while it is blocked and back down once it is clear, so nothing is cut at all
   while the view is open, and a cut appears and disappears as a fade, not a pop.

   Uniforms (shared by reference with every patched material, like the ring's):
     uSightC   camera x, y, z, fade amount (0 = off)
     uSightT   target x, y, z, tube radius */
const SIGHT_UNIFORMS = {
  uSightC: {value: [0, 0, 0, 0]},
  uSightT: {value: [0, 0, 0, 1]},
};

const SIGHT_VERT_DECL = 'varying vec3 vSightW;\n';
const SIGHT_VERT_BODY = '\n  vSightW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n';
const SIGHT_FRAG_DECL = `
uniform vec4 uSightC; uniform vec4 uSightT;
varying vec3 vSightW;
float sightBayer(vec2 p){
  // 4x4 ordered dither, 0..1
  vec2 q = mod(floor(p), 4.0);
  int i = int(q.y*4.0 + q.x);
  float v = 0.0;
  if(i==0) v=0.0; else if(i==1) v=8.0; else if(i==2) v=2.0; else if(i==3) v=10.0;
  else if(i==4) v=12.0; else if(i==5) v=4.0; else if(i==6) v=14.0; else if(i==7) v=6.0;
  else if(i==8) v=3.0; else if(i==9) v=11.0; else if(i==10) v=1.0; else if(i==11) v=9.0;
  else if(i==12) v=15.0; else if(i==13) v=7.0; else if(i==14) v=13.0; else v=5.0;
  return (v + 0.5)/16.0;
}
`;
/* Near the camera end the tube narrows (half radius at the lens): a block right beside
   the camera needs only a small hole to see past, and a wide one there would blank out
   half the screen. Not cut in the last 5% next to the pup, which is its own bench. */
const SIGHT_FRAG_BODY = `
  if(uSightC.w > 0.001){
    vec3 sa = uSightC.xyz, sab = uSightT.xyz - sa;
    float sL2 = max(dot(sab, sab), 1e-4);
    float st = clamp(dot(vSightW - sa, sab)/sL2, 0.0, 1.0);
    if(st > 0.0 && st < 0.95){
      vec3 sq = sa + sab*st;
      float sr = uSightT.w*mix(0.5, 1.0, st);
      float sd = length(vSightW - sq);
      if(sd < sr && vSightW.y > sq.y - sr*0.35){
        float sk = (1.0 - smoothstep(sr*0.45, sr, sd))*uSightC.w;
        if(sk > sightBayer(gl_FragCoord.xy)) discard;
      }
    }
  }
`;

/* Teach one material to be seen through. Same shape as patchGroundRing: idempotent,
   chains any onBeforeCompile already there, keys the program cache. The discard goes in
   at <clipping_planes_fragment>, the first thing the fragment shader does, so a cut pixel
   costs nothing further. */
function patchSightCut(mat){
  if(!mat || (mat.userData && mat.userData.sightCut)) return mat;
  mat.userData = mat.userData || {};
  mat.userData.sightCut = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function(sh, renderer){
    if(typeof prev === 'function') prev.call(this, sh, renderer);
    Object.assign(sh.uniforms, SIGHT_UNIFORMS);
    sh.vertexShader = SIGHT_VERT_DECL + sh.vertexShader.replace(
      '#include <project_vertex>', '#include <project_vertex>' + SIGHT_VERT_BODY);
    sh.fragmentShader = SIGHT_FRAG_DECL + sh.fragmentShader.replace(
      '#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + SIGHT_FRAG_BODY);
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function(){
    return 'sightCut|' + (typeof prevKey === 'function' ? prevKey.call(this) : '');
  };
  mat.needsUpdate = true;
  return mat;
}

/* Is the straight line from (cx,cy,cz) to (tx,ty,tz) blocked by ground? `groundAt(x,z)`
   is the drawn terrain height. Sampled finely enough for a coarse map's 9-unit blocks;
   the last 7% next to the target is its own footing and never counts. */
const SIGHT_SAMPLES = 24;
function sightBlocked(cx, cy, cz, tx, ty, tz, groundAt){
  for(let i=1;i<SIGHT_SAMPLES;i++){
    const s = i/SIGHT_SAMPLES;
    if(s > 0.93) break;
    const x = cx + (tx-cx)*s, z = cz + (tz-cz)*s, y = cy + (ty-cy)*s;
    if(groundAt(x, z) > y) return true;
  }
  return false;
}

/* The per-frame update. FADE_IN / FADE_OUT: seconds to go fully see-through once blocked,
   and back to solid once clear -- quick enough that the pup never disappears for long,
   slow enough to read as a fade. */
const SIGHT_RADIUS = 1.7, SIGHT_FADE_IN = 0.2, SIGHT_FADE_OUT = 0.45;
let sightAmount = 0;
function updateSightCut(dt, cam, tx, ty, tz, groundAt){
  const blocked = sightBlocked(cam.x, cam.y, cam.z, tx, ty, tz, groundAt);
  const step = dt/(blocked ? SIGHT_FADE_IN : SIGHT_FADE_OUT);
  sightAmount = Math.max(0, Math.min(1, sightAmount + (blocked ? step : -step)));
  const C = SIGHT_UNIFORMS.uSightC.value, T = SIGHT_UNIFORMS.uSightT.value;
  C[0] = cam.x; C[1] = cam.y; C[2] = cam.z; C[3] = sightAmount;
  T[0] = tx; T[1] = ty; T[2] = tz; T[3] = SIGHT_RADIUS;
  return blocked;
}
function sightCutAmount(){ return sightAmount; }   // test seam
function sightUniforms(){ return SIGHT_UNIFORMS; }  // test seam (a const is not reachable from the harness)
function resetSightCut(){ sightAmount = 0; SIGHT_UNIFORMS.uSightC.value[3] = 0; }

export { patchSightCut, updateSightCut, sightBlocked, sightCutAmount, sightUniforms, resetSightCut, SIGHT_UNIFORMS };
