/* Renderer, scene, camera, lights, resize, disposal. */
import { QUALITY } from './quality.js';
import { toonTex, isShared } from './materials.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.dpr));
renderer.shadowMap.enabled = QUALITY.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
camera.position.set(5.2, 3.6, 8.2);

function resize(){
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.dpr));
  renderer.shadowMap.enabled = QUALITY.shadows;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);



let hemi = new THREE.HemisphereLight(0xcfeeff, 0x9a9a7a, 0.85);
scene.add(hemi);
function setHemi(groundColor){ hemi.groundColor = new THREE.Color(groundColor); }
const sun = new THREE.DirectionalLight(0xfff1cf, 0.95);
sun.position.set(12, 22, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(QUALITY.shadowSize, QUALITY.shadowSize);
sun.shadow.camera.left = -24; sun.shadow.camera.right = 24;
sun.shadow.camera.top = 24; sun.shadow.camera.bottom = -24;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0004;
scene.add(sun);
const sunTarget = new THREE.Object3D();
scene.add(sunTarget);
sun.target = sunTarget;

/* Geometry is always private to the mesh that holds it, so it always goes. Materials are
   not: materials.js hands out one shared MeshToonMaterial per colour, and disposing one
   of those here would pull it out from under every other mesh on the map still drawing
   with it -- a black world one rebuildWorld later, with nothing in the stack trace to say
   why. isShared() is the opt-out, owned by the module that does the sharing.

   The toonTex check below is the same rule one level down and predates it: the gradient
   ramp has always been a single shared texture. */
/* PAY THE FIRST-SIGHT COST WHILE THE LOADER IS STILL UP.

   three.js builds a mesh's GPU resources lazily, on its first RENDER: the material's
   shader program and uniform blocks, then gl.createBuffer/bufferData for position,
   normal, uv and index. Anything frustum-culled has never been rendered, so it has never
   paid. Walk over a ridge and a few hundred meshes pay all at once, inside one frame, as
   synchronous driver calls -- which is a visible hitch on a tablet and the reported "it
   almost freezes when animals appear".

   Two halves, because renderer.compile only does one of them. compile() walks the scene
   and initialises MATERIALS, which is the expensive half and the half that shares (one
   toon material per colour now, so ~85 programs rather than 6,360 initialisations). It
   does not touch geometry. Buffers only get created when something actually reaches
   renderBufferDirect, so the second half is one real render with culling switched off --
   every mesh enters the render list, every buffer gets uploaded, and the frame is thrown
   away. Vertices beyond the far plane are clipped downstream of the upload, so pulling
   the far plane in (see world.js applyFarPlane) does not rob this of anything.

   One expensive frame at boot, behind the loader, in exchange for no expensive frames
   during play. Wrapped in try/catch and feature-tested because the smoke harness runs a
   duck-typed renderer with neither method. */
function warmUp(){
  const flipped = [];
  try{
    if(typeof renderer.compile === 'function') renderer.compile(scene, camera);
    scene.traverse(o=>{
      if((o.isMesh || o.isSprite) && o.frustumCulled){ o.frustumCulled = false; flipped.push(o); }
    });
    renderer.render(scene, camera);
  }catch(e){
    /* a warm-up that fails is a slow first minute, not a broken game */
  }finally{
    for(const o of flipped) o.frustumCulled = true;
  }
}

function disposeMat(m){
  if(isShared(m)) return;
  if(m.map && m.map!==toonTex) m.map.dispose();
  m.dispose();
}
function disposeGroup(g){
  g.traverse(o=>{
    if(o.geometry) o.geometry.dispose();
    if(o.material){
      if(Array.isArray(o.material)) o.material.forEach(disposeMat);
      else disposeMat(o.material);
    }
  });
}

export { canvas, renderer, scene, camera, resize, sun, sunTarget, hemi, setHemi, disposeGroup, warmUp };
