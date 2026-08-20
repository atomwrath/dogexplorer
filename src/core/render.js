/* Renderer, scene, camera, lights, resize, disposal. */
import { QUALITY } from './quality.js';
import { toonTex } from './materials.js';

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

function disposeGroup(g){
  g.traverse(o=>{
    if(o.geometry) o.geometry.dispose();
    if(o.material){
      if(Array.isArray(o.material)) o.material.forEach(m=>{ if(m.map && m.map!==toonTex) m.map.dispose(); m.dispose(); });
      else { if(o.material.map && o.material.map!==toonTex) o.material.map.dispose(); o.material.dispose(); }
    }
  });
}

export { canvas, renderer, scene, camera, resize, sun, sunTarget, setHemi, disposeGroup };
