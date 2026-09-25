/* Ground cover: what the ground itself is made of, where a map says so.

   A cover polygon (terrain.js flattenAreaCells: too much hill under it to be a slab) is
   left as the hillside the DEM describes, dressed with what stands on it -- trees for a
   forest, boulders for scree. That is right for a forest, whose floor looks like any
   other ground. It is not enough for scree: a scree field IS its ground, a slope of
   broken stone above the tree line, and a scatter of boulders on grass reads as a meadow
   with rocks in it. On BarrTrailWorld.json that is the 8 km^2 natural=scree field that
   wraps the summit cone.

   So the terrain is painted, the way the noise ring is (noise-ring.js): PROJECTED in the
   fragment shader, not draped geometry. A mask texture at the DEM's own resolution says
   how much of each cell is scree; the terrain material samples it at the fragment's world
   x/z and, where it is set, replaces the grass texel with broken stone. Consequences:

     - it lies on exactly whatever terrain is there -- terraces, risers, cut banks --
       with nothing to z-fight and no geometry to rebuild;
     - it is on the TERRAIN material only. Trail treads, lots and bridge decks keep their
       own surfaces, so a path across the scree still reads as a path;
     - the edge is soft (the mask is linearly filtered between cell centres) and then
       broken up with noise, so it is a ragged boundary, not a staircase of cells.

   The stone pattern is procedural: offset rows of cobbles with dark joints between them,
   each stone its own shade, the whole modulated at a larger scale so a hillside of it
   does not tile visibly. Sized in world units, like the tread widths, because it is
   read against the pup standing on it. */

/* Shared uniforms, referenced (never copied) by every patched material, so rebuilding a
   world is writing these once. uCoverRect = originX, originZ, width, depth of the mask in
   world units; uCoverOn 0 disables the whole branch on a map with no scree. */
const COVER_UNIFORMS = {
  uCoverMask: {value: null},
  uCoverRect: {value: [0, 0, 1, 1]},
  uCoverOn:   {value: 0},
  uCoverCell: {value: 1},        // one mask cell in world units: how far the edge may wander
};
let STATE = {on:false, width:0, height:0, cells:0, rect:[0,0,1,1]};

const COVER_VERT_DECL = 'varying vec3 vCoverW;\n';
const COVER_VERT_BODY = '\n  vCoverW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n';
/* THE STONE PATTERN. Scree is broken rock sorted by nothing but gravity: angular stones
   of every size, packed with smaller rubble, no rows and no grid. So, three sizes:

     - BOULDERS: a coarse jittered Voronoi layer (each fragment finds its nearest of the
       scattered centres), of which only about a quarter of the cells are kept, so big
       blocks lie scattered through the field rather than tiling it;
     - STONES: the same at the main scale, filling everything the boulders do not;
     - RUBBLE: a finer layer again, which is what shows in the joints between stones --
       broken stone in the gaps, not a black grout line.
   F2-F1 (how much nearer the nearest centre is than the next) is the distance to a joint.
   Every stone takes its own grey and a slight warm or cool cast from its id, is lighter
   at its middle than its rim, and carries a fine grain, which is what turns a flat cell
   into a rounded block. All three layers are sampled through a gentle noise WARP so no
   stone edge runs dead straight, and smooth noise at two larger scales mottles the field
   and lays a faint lichen tint over it so a whole hillside does not repeat.

   THE EDGE. The mask is one value per DEM cell, so on its own it outlines the field in
   cell-sized steps. Two things undo that, and both are careful never to create cover
   AWAY from the field (the first version of this added noise to the mask outright, which
   lifted the empty mask everywhere and would have sprinkled stones across every meadow
   on the map):
     - the mask is looked up at a point displaced by ~1.5 cells of smooth noise, which
       bends the whole boundary organically but only moves where it is;
     - fine noise is added only in the transition, scaled by 4m(1-m), which is 0 where
       the mask is fully off or fully on.
   Across that margin the rubble bed fades in, and each stone appears only once the
   cover passes its own random threshold -- boulders only well inside -- so the field
   frays into scattered rocks rather than stopping at a line.

   Linear-space colours (diffuseColor is linear at <map_fragment>): stones run about
   sRGB #736d64..#aca597, rubble #625d56..#89847b. Developed against a numpy port and then
   rendered for real in headless WebGL (Mesa), which matched it to ~1/255 on average. */
const COVER_FRAG_DECL = `
uniform sampler2D uCoverMask; uniform vec4 uCoverRect; uniform float uCoverOn; uniform float uCoverCell;
varying vec3 vCoverW;
/* Sine-free hashes (Dave Hoskins' hash12 / hash22). The usual fract(sin(x)*43758) is
   taken here at arguments near 1e6 -- the far side of a big map, times the stone scale --
   and many mobile GPUs evaluate sin() poorly out there, which shows as stripes. These use
   only fract/dot/multiply, so they behave the same on every GPU at map-sized inputs. */
float coverHash(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 coverHash2(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float coverNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(coverHash(i), coverHash(i + vec2(1.0, 0.0)), u.x),
             mix(coverHash(i + vec2(0.0, 1.0)), coverHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
/* x = distance to the nearest centre, y = distance to the joint (F2 - F1), z = id 0..1 */
vec3 coverStones(vec2 p){
  vec2 n = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for(int j = -1; j <= 1; j++){
    for(int i = -1; i <= 1; i++){
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + coverHash2(n + g) * 0.9 + 0.05 - f;
      float d = dot(r, r);
      if(d < d1){ d2 = d1; d1 = d; id = coverHash(n + g + 3.1); }
      else if(d < d2){ d2 = d; }
    }
  }
  float s1 = sqrt(d1);
  return vec3(s1, sqrt(d2) - s1, id);
}
vec3 coverStoneCol(vec3 s, float k){
  vec3 c = mix(vec3(0.17, 0.16, 0.145), vec3(0.42, 0.40, 0.36), k);
  c *= mix(vec3(1.0, 0.98, 0.94), vec3(0.95, 0.98, 1.02), fract(k * 7.3));
  return c * (1.1 - 0.34 * s.x);
}
float coverAmount(vec2 w){
  vec2 wob = (vec2(coverNoise(w * 0.09), coverNoise(w * 0.09 + 9.1)) - 0.5) * 3.0 * uCoverCell;
  vec2 uv = (w + wob - uCoverRect.xy) / uCoverRect.zw;
  if(uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return 0.0;
  float m = texture2D(uCoverMask, uv).r;
  float n = (coverNoise(w * 0.35) - 0.5) * 0.5 + (coverNoise(w * 1.3 + 7.7) - 0.5) * 0.22;
  return clamp(m + n * 4.0 * m * (1.0 - m) * 1.4, 0.0, 1.0);
}
/* The scree colour and, in .a, how much of it shows here. */
vec4 screeColor(vec2 w, float k){
  vec2 q = w * 1.5 + (vec2(coverNoise(w * 0.8), coverNoise(w * 0.8 + 17.3)) - 0.5) * 0.7;
  vec3 B = coverStones(q * 0.45 + 11.0);
  vec3 S = coverStones(q);
  vec3 R = coverStones(q * 3.1 + 5.0);
  vec3 rub = mix(vec3(0.12, 0.11, 0.10), vec3(0.24, 0.23, 0.21), R.z) * mix(0.5, 1.0, smoothstep(0.0, 0.14, R.y));
  float grain = 0.9 + 0.2 * coverNoise(w * 7.0);
  vec3 sc = coverStoneCol(S, S.z) * grain * (1.0 - 0.25 * (1.0 - smoothstep(0.07, 0.30, S.y)));
  vec3 bc = coverStoneCol(B, B.z * 3.4) * grain * (1.0 - 0.35 * (1.0 - smoothstep(0.04, 0.28, B.y)));
  float onB = smoothstep(0.04, 0.12, B.y) * (1.0 - step(0.28, B.z));
  float onS = smoothstep(0.07, 0.17, S.y);
  float showB = onB * smoothstep(B.z - 0.04, B.z + 0.04, k * 0.4 - 0.12);
  float showS = onS * smoothstep(S.z - 0.08, S.z + 0.08, k * 1.25 - 0.1);
  vec3 col = mix(rub, sc, showS);
  col = mix(col, bc, showB);
  col *= 0.82 + 0.36 * coverNoise(w * 0.12);
  col = mix(col, col * vec3(0.93, 1.0, 0.82), smoothstep(0.55, 0.9, coverNoise(w * 0.3 + 41.0)) * 0.5);
  return vec4(col, max(smoothstep(0.30, 0.75, k), max(showS, showB)));
}
`;
const COVER_FRAG_BODY = `
  if(uCoverOn > 0.5){
    float coverK = coverAmount(vCoverW.xz);
    if(coverK > 0.0){
      vec4 scree = screeColor(vCoverW.xz, coverK);
      diffuseColor.rgb = mix(diffuseColor.rgb, scree.rgb, scree.a);
    }
  }
`;

/* Teach the terrain material about cover. Same contract as patchGroundRing: idempotent,
   chains any onBeforeCompile already there, keys the program cache. Injected after
   <map_fragment>, so the stone replaces the grass TEXEL and is then lit, toon-banded and
   shadowed exactly as the grass would have been. */
function patchGroundCover(mat){
  if(!mat || (mat.userData && mat.userData.groundCover)) return mat;
  mat.userData = mat.userData || {};
  mat.userData.groundCover = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function(sh, renderer){
    if(typeof prev === 'function') prev.call(this, sh, renderer);
    Object.assign(sh.uniforms, COVER_UNIFORMS);
    sh.vertexShader = COVER_VERT_DECL + sh.vertexShader.replace(
      '#include <project_vertex>', '#include <project_vertex>' + COVER_VERT_BODY);
    sh.fragmentShader = COVER_FRAG_DECL + sh.fragmentShader.replace(
      '#include <map_fragment>', '#include <map_fragment>' + COVER_FRAG_BODY);
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function(){
    return 'groundCover|' + (typeof prevKey === 'function' ? prevKey.call(this) : '');
  };
  mat.needsUpdate = true;
  return mat;
}

/* Build the mask for a world. `W` is the loaded World (cell grid), `isCover(x,z)` says
   whether a cell centre is scree. One byte per DEM cell, 255 = scree. Replaces any
   previous mask; with nothing to paint, the branch is switched off entirely. */
function setGroundCover(W, isCover){
  const old = COVER_UNIFORMS.uCoverMask.value;
  if(old && typeof old.dispose === 'function') old.dispose();
  COVER_UNIFORMS.uCoverMask.value = null;
  COVER_UNIFORMS.uCoverOn.value = 0;
  STATE = {on:false, width:0, height:0, cells:0, rect:[0,0,1,1]};
  if(!W || !isCover) return STATE;
  const w = W.width, h = W.height, data = new Uint8Array(w*h);
  let cells = 0;
  for(let j=0;j<h;j++) for(let i=0;i<w;i++){
    const c = W.cellCentre(i, j);
    if(isCover(c.x, c.z)){ data[j*w+i] = 255; cells++; }
  }
  if(!cells) return STATE;
  const tex = new THREE.DataTexture(data, w, h, THREE.LuminanceFormat);
  // one byte per texel: rows are not 4-byte aligned unless the width happens to be
  tex.unpackAlignment = 1;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.__data = data;                      // test seam: what was uploaded
  const rect = [W.originX, W.originZ, w*W.cell, h*W.cell];
  COVER_UNIFORMS.uCoverMask.value = tex;
  COVER_UNIFORMS.uCoverRect.value = rect;
  COVER_UNIFORMS.uCoverOn.value = 1;
  COVER_UNIFORMS.uCoverCell.value = W.cell;
  STATE = {on:true, width:w, height:h, cells, rect};
  return STATE;
}
/* Mask value at a world point, straight from the uploaded bytes: 0..255. For the harness
   and for anything (scenery placement) that needs the same answer the shader gives. */
function groundCoverAt(x, z){
  const tex = COVER_UNIFORMS.uCoverMask.value;
  if(!STATE.on || !tex) return 0;
  const [ox, oz, rw, rh] = STATE.rect;
  const i = Math.floor((x-ox)/rw*STATE.width), j = Math.floor((z-oz)/rh*STATE.height);
  if(i < 0 || j < 0 || i >= STATE.width || j >= STATE.height) return 0;
  return tex.__data[j*STATE.width+i];
}
function groundCoverState(){ return Object.assign({}, STATE); }
function groundCoverSource(){ return {vertDecl:COVER_VERT_DECL, vertBody:COVER_VERT_BODY, fragDecl:COVER_FRAG_DECL, fragBody:COVER_FRAG_BODY}; }
function groundCoverUniforms(){ return COVER_UNIFORMS; }

export { patchGroundCover, setGroundCover, groundCoverAt, groundCoverState, groundCoverSource, groundCoverUniforms };
