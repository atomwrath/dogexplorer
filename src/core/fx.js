/* Particles, comic-book word bursts, and the stun star ring. */
import { scene } from './render.js';
import { clamp } from './math.js';
import { QUALITY } from './quality.js';
import { play } from '../city/player-state.js';
import { R, dogPos } from '../dog/runtime.js';

/* ========================================================= PARTICLES */
const particles = [];
const partGeo = new THREE.SphereGeometry(1, 6, 5);
const partMats = {};
function pmat(c){ return partMats[c] || (partMats[c] = new THREE.MeshBasicMaterial({color:c})); }
function spawnParticle(x,y,z, vx,vy,vz, r, color, life){
  const m = new THREE.Mesh(partGeo, pmat(color));
  m.scale.setScalar(r);
  m.position.set(x,y,z);
  scene.add(m);
  particles.push({m, v:new THREE.Vector3(vx,vy,vz), r, life, total:life});
}
function updateParticles(dt){
  for(let i=particles.length-1;i>=0;i--){
    const p = particles[i];
    p.life -= dt;
    if(p.life <= 0){ scene.remove(p.m); particles.splice(i,1); continue; }
    p.v.y -= 9*dt;
    p.m.position.addScaledVector(p.v, dt);
    if(p.m.position.y < 0.02){ p.m.position.y = 0.02; p.v.set(0,0,0); }
    p.m.scale.setScalar(p.r * Math.max(0.15, p.life/p.total));
  }
}

/* ========================================================= COMIC FX */
const comicCache = {};
function comicTex(word, fill, ink){
  const key = word + fill;
  if(comicCache[key]) return comicCache[key];
  const cv = document.createElement('canvas');
  cv.width = 320; cv.height = 200;
  const x = cv.getContext('2d');
  const cx = 160, cy = 100;
  // starburst backing
  const spikes = 11;
  x.beginPath();
  for(let i=0;i<spikes*2;i++){
    const a = (i/(spikes*2))*Math.PI*2 - Math.PI/2;
    const r = (i%2 ? 62 : 96) * (i%3===0 ? 1.06 : 1);
    x.lineTo(cx + Math.cos(a)*r*1.45, cy + Math.sin(a)*r);
  }
  x.closePath();
  x.fillStyle = fill;
  x.strokeStyle = ink; x.lineWidth = 9; x.lineJoin = 'round';
  x.fill(); x.stroke();
  // word
  x.font = 'bold 62px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.save();
  x.translate(cx, cy); x.rotate(-0.09);
  x.lineWidth = 11; x.strokeStyle = ink;
  x.strokeText(word, 0, 4);
  x.fillStyle = '#fff9e8';
  x.fillText(word, 0, 4);
  x.restore();
  const t = new THREE.CanvasTexture(cv);
  comicCache[key] = t;
  return t;
}
const fx = [];
function comicBurst(word, x, y, z, fill='#ff8f2d', ink='#3d2a20'){
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map:comicTex(word, fill, ink), transparent:true, depthTest:false,
  }));
  sp.position.set(x, y, z);
  sp.scale.set(0.1, 0.06, 1);
  scene.add(sp);
  fx.push({sp, life:0.95, total:0.95, spin:(Math.random()-0.5)*0.5});
}
/* spinning stars around a dazed pup */
const STAR_TEX = (()=>{
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const x = cv.getContext('2d');
  x.beginPath();
  for(let i=0;i<10;i++){
    const a = (i/10)*Math.PI*2 - Math.PI/2;
    const r = i%2 ? 12 : 28;
    x.lineTo(32 + Math.cos(a)*r, 32 + Math.sin(a)*r);
  }
  x.closePath();
  x.fillStyle = '#ffd94a'; x.strokeStyle = '#3d2a20'; x.lineWidth = 5; x.lineJoin = 'round';
  x.fill(); x.stroke();
  return new THREE.CanvasTexture(cv);
})();
let starRing = null;
function makeStars(){
  starRing = new THREE.Group();
  for(let i=0;i<3;i++){
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map:STAR_TEX, transparent:true, depthTest:false}));
    s.scale.set(0.4, 0.4, 1);
    starRing.add(s);
  }
  starRing.visible = false;
  scene.add(starRing);
}
function updateFX(dt, t){
  for(let i=fx.length-1;i>=0;i--){
    const f = fx[i];
    f.life -= dt;
    if(f.life <= 0){ scene.remove(f.sp); fx.splice(i,1); continue; }
    const p = 1 - f.life/f.total;
    const pop = p < 0.25 ? p/0.25 : 1;
    const s = (1.15 + p*0.55) * pop;
    f.sp.scale.set(2.1*s, 1.3*s, 1);
    f.sp.position.y += dt*1.5;
    f.sp.material.rotation = f.spin * p;
    f.sp.material.opacity = p > 0.7 ? 1 - (p-0.7)/0.3 : 1;
  }
  if(starRing){
    const on = play.stunT > 0;
    starRing.visible = on;
    if(on){
      const hy = (R ? R.hipHeight : 1) + 0.75 + play.jumpY;
      starRing.position.set(dogPos.x, hy, dogPos.z);
      starRing.children.forEach((s, i)=>{
        const a = t*7 + i*(Math.PI*2/3);
        s.position.set(Math.cos(a)*0.55, Math.sin(a*2)*0.1, Math.sin(a)*0.55);
      });
    }
  }
}

export { spawnParticle, updateParticles, comicTex, comicBurst, STAR_TEX,
         starRing, makeStars, updateFX };
