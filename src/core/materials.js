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
function toon(color){
  return new THREE.MeshToonMaterial({color:new THREE.Color(color), gradientMap:toonTex});
}
function M(geo, mat, cast=true, recv=false){
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast; m.receiveShadow = recv;
  return m;
}

export { toonTex, toon, M };
