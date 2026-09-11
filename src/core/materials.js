/* Toon material factory + mesh helper. Pure — no scene, no renderer,
   so both games (and buildDog) share exactly these. */

const toonTex = (()=>{
  const shades = new Uint8Array([90, 150, 210, 255]);
  const t = new THREE.DataTexture(shades, shades.length, 1, THREE.LuminanceFormat);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();
/* CACHED BY COLOUR, and the cache is the point rather than a micro-optimisation.

   Measured on the default Garden of the Gods map before this existed: 6,360 meshes in
   the scene holding 6,360 SEPARATE material instances -- but only 85 distinct material
   configurations between them. Every tree trunk on the map carried its own private copy
   of the same brown.

   That costs twice. Once at first sight of each mesh, because three.js initialises a
   material lazily on its first render (program cache key, uniform blocks, the lot) and
   a fresh instance cannot reuse the one next to it; and again every frame, because the
   renderer cannot skip a uniform upload between two draws it has no way to know are
   identical. The first of those is what made walking over a ridge stutter: a few
   thousand first-time initialisations landing inside one frame.

   Keyed on the colour string exactly as passed. Colours here are literals from the theme
   and species tables, so equal colours arrive as equal strings and the key is honest.

   SHARED MATERIALS MUST NOT BE DISPOSED, which is what isShared() below is for -- see
   disposeGroup in core/render.js. resetCritters and rebuildWorld both dispose
   whole subtrees, and before the flag existed that would have torn down a material the
   rest of the map was still drawing with. Nothing in this codebase mutates a material
   returned from here (the four in-place opacity writes -- world.js, critters.js,
   shadow.js, fx.js -- are all on sprite or ring materials built elsewhere), so sharing
   is safe; if that ever changes, the fix is a private material at that call site, not
   an exception here. */
/* Membership lives in a WeakSet rather than as a flag ON the material, so nothing here
   depends on three.js's userData existing -- the smoke harness's duck-typed Material has
   no such field, and a shared-ness marker that a test double can silently drop is a
   marker that fails exactly where it matters. */
const SHARED = new WeakSet();
const CACHE = new Map();

/* The memo behind toon(), exported because toon() is not the only material factory that
   was handing out thousands of identical instances -- pieces.js's trailMat is the other
   big one. `key` must capture every constructor argument that can differ, or two
   different-looking things will end up sharing one material; `make` is only called on a
   miss.

   THE CONTRACT IS THAT THE RESULT IS IMMUTABLE. Anything that mutates a material in
   place -- opacity, colour, map.repeat -- must build its own and not come through here.
   The four in-place writes in this codebase (world.js:609, critters.js:594,
   shadow.js:102, fx.js:115) are all on sprite and ring materials constructed elsewhere,
   and the one map.repeat write (pieces.js, paved areas) is on a material deliberately
   left uncached for exactly this reason. */
function sharedMat(key, make){
  let m = CACHE.get(key);
  if(!m){ m = make(); SHARED.add(m); CACHE.set(key, m); }
  return m;
}
function toon(color){
  return sharedMat('toon|'+color, () =>
    new THREE.MeshToonMaterial({color:new THREE.Color(color), gradientMap:toonTex}));
}
/* True for any material handed out through sharedMat, i.e. any material more than one
   mesh in the scene may be pointing at. Disposal sites must ask before disposing. */
function isShared(m){ return SHARED.has(m); }
function M(geo, mat, cast=true, recv=false){
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast; m.receiveShadow = recv;
  return m;
}

export { toonTex, toon, sharedMat, isShared, M };
