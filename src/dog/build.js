/* buildDog — SHARED between Pup City and Backyard Pups.
   Change it here and both games get it. */
import { M, toon } from '../core/materials.js';
import { DEFAULTS } from './params.js';
import { mulberry32, lerp } from '../core/math.js';

function buildDog(p){
  const g = new THREE.Group();
  const refs = {legs:[], ears:[], pupils:[], earStyle:p.earStyle, tailStyle:p.tailStyle};

  const fur   = toon(p.furColor);
  const belly = toon(p.bellyColor);
  const acc   = toon(p.accentColor);
  const spotM = toon(p.spotColor);
  const sockM = toon(p.sockColor);

  const legL   = 0.55 + 0.72*p.legLength;
  const bodyRx = 1.12*p.bodyLength;
  const bodyRy = 0.82*p.girth;
  const bodyRz = 0.76*p.girth;
  const bodyY  = legL + bodyRy*0.5;

  /* --- body group (bobs while walking) --- */
  const bodyG = new THREE.Group();
  bodyG.position.y = bodyY;
  g.add(bodyG);
  refs.bodyG = bodyG; refs.bodyBaseY = bodyY;

  // build: <1 lean waist, >1 broad chest & shoulders
  const bld  = p.build;
  const waist = bld < 1 ? 0.72 + 0.28*bld : 1;
  const chB   = bld > 1 ? 1 + 0.42*(bld-1) : 0.78 + 0.22*bld;
  const hipB  = bld > 1 ? 1 + 0.15*(bld-1) : 0.82 + 0.18*bld;
  const wRy = bodyRy*waist, wRz = bodyRz*waist;

  const body = M(new THREE.SphereGeometry(1, 26, 20), fur);
  body.scale.set(bodyRx, wRy, wRz);
  bodyG.add(body);

  const shoulders = M(new THREE.SphereGeometry(1, 20, 16), fur);
  shoulders.scale.set(bodyRx*0.6, bodyRy*0.92*chB, bodyRz*0.95*chB);
  shoulders.position.set(bodyRx*0.42, bodyRy*0.1*Math.max(0, bld-1), 0);
  bodyG.add(shoulders);

  const hips = M(new THREE.SphereGeometry(1, 20, 16), fur);
  hips.scale.set(bodyRx*0.52, bodyRy*0.88*hipB, bodyRz*0.9*hipB);
  hips.position.set(-bodyRx*0.42, 0, 0);
  bodyG.add(hips);

  const chest = M(new THREE.SphereGeometry(1, 22, 16), belly);
  chest.scale.set(bodyRx*0.78, wRy*0.72, wRz*0.92);
  chest.position.set(bodyRx*0.12, -wRy*0.3, 0);
  bodyG.add(chest);

  /* --- spots on body --- */
  if(p.spots && p.spotCount>0){
    const rng = mulberry32(p.spotSeed*97+13);
    for(let i=0;i<p.spotCount;i++){
      const th = rng()*Math.PI*2;
      const ph = Math.acos(lerp(0.95, -0.25, rng()));           // keep off the belly
      const d = new THREE.Vector3(Math.sin(ph)*Math.cos(th), Math.cos(ph), Math.sin(ph)*Math.sin(th));
      const pos = new THREE.Vector3(d.x*bodyRx, d.y*wRy, d.z*wRz);
      const nrm = new THREE.Vector3(d.x/bodyRx, d.y/wRy, d.z/wRz).normalize();
      const r = (0.16 + rng()*0.14) * p.spotSize * Math.min(bodyRx,bodyRy);
      const s = M(new THREE.SphereGeometry(r, 12, 10), spotM, false);
      s.scale.set(1,1,0.32);
      s.position.copy(pos).addScaledVector(nrm, 0.015);
      s.lookAt(pos.clone().add(nrm));
      bodyG.add(s);
    }
  }

  /* --- legs --- */
  const pivotY = -bodyRy*0.35;              // relative to bodyG
  const lx = bodyRx*0.58, lz = bodyRz*0.6;
  const legR = 0.145*p.legThick*(0.8+0.25*p.girth)*(0.82+0.18*p.build);
  [[lx,lz],[lx,-lz],[-lx,lz],[-lx,-lz]].forEach(([x,z],i)=>{
    const hip = new THREE.Group();
    hip.position.set(x, pivotY, z);
    const footY = -(bodyY + pivotY);        // world y=0 in hip space
    const len = -footY - 0.14;
    const upper = M(new THREE.CylinderGeometry(legR*0.85, legR, len, 10), fur);
    upper.position.y = footY + 0.14 + len/2;
    const paw = M(new THREE.SphereGeometry(legR*1.5, 12, 10), p.socks? sockM : fur);
    paw.position.set(legR*0.5, footY + 0.14, 0);
    paw.scale.set(1.35, 0.85, 1.1);
    hip.add(upper, paw);
    bodyG.add(hip);
    refs.legs.push(hip);
  });

  /* --- tail --- */
  const tailG = new THREE.Group();
  tailG.position.set(-bodyRx*0.9, bodyRy*0.42, 0);
  tailG.rotation.z = 0.95;
  bodyG.add(tailG);
  refs.tail = tailG;
  const tl = p.tailLength, tt = p.tailThick;
  if(p.tailStyle==='stub'){
    const s = M(new THREE.SphereGeometry(0.17*tt,10,8), acc); s.position.y = 0.08; tailG.add(s);
  } else if(p.tailStyle==='straight'){
    const len = 0.85*tl;
    const t = M(new THREE.CylinderGeometry(0.055*tt, 0.09*tt, len, 8), fur);
    t.position.y = len/2; tailG.add(t);
    const tip = M(new THREE.SphereGeometry(0.1*tt,10,8), acc); tip.position.y = len; tailG.add(tip);
  } else if(p.tailStyle==='curly'){
    const N = 9;
    for(let i=0;i<N;i++){
      const t = i/(N-1);
      const a = t*4.6;
      const s = M(new THREE.SphereGeometry(0.115*tt*(1-t*0.35), 10, 8), i>N-3? acc : fur);
      s.position.set(Math.sin(a)*0.17, t*0.62*tl + 0.05, Math.cos(a)*0.17 - 0.17);
      tailG.add(s);
    }
  } else { // plume
    const N = 6, len = 0.95*tl;
    for(let i=0;i<N;i++){
      const t = i/(N-1);
      const r = (0.12 + 0.13*Math.sin(t*Math.PI)) * (0.8+0.3*tl) * tt;
      const s = M(new THREE.SphereGeometry(r, 12, 10), t>0.55? acc : fur);
      s.position.y = t*len + 0.05;
      tailG.add(s);
    }
  }

  /* --- head --- */
  const hr = 0.6*p.headSize;
  const headG = new THREE.Group();
  headG.position.set(bodyRx*0.92 + hr*0.3, bodyRy*0.62 + hr*0.35, 0);
  bodyG.add(headG);
  refs.head = headG;

  const skull = M(new THREE.SphereGeometry(hr, 24, 18), fur);
  headG.add(skull);

  // snout (upper)
  const snMat = p.muzzlePatch? belly : fur;
  const snL = 0.52*p.snoutLength, snW = 0.34*p.snoutWidth;
  const snout = M(new THREE.SphereGeometry(hr, 18, 14), snMat);
  snout.scale.set(snL, snW*0.82, snW);
  snout.position.set(hr*0.72, -hr*0.12, 0);
  headG.add(snout);
  // nose
  const nose = M(new THREE.SphereGeometry(hr*0.16, 12, 10), toon(p.noseColor));
  nose.scale.set(0.8, 0.72, 1.05);
  nose.position.set(hr*0.72 + hr*snL*0.92, hr*0.02, 0);
  headG.add(nose);

  // jaw (rotates for bark)
  const jaw = new THREE.Group();
  jaw.position.set(hr*0.42, -hr*0.3, 0);
  headG.add(jaw);
  refs.jaw = jaw;
  const jawM = M(new THREE.SphereGeometry(hr, 16, 12), snMat);
  jawM.scale.set(snL*0.8, snW*0.5, snW*0.85);
  jawM.position.set(hr*snL*0.45, 0, 0);
  jaw.add(jawM);
  // tongue: a little drooping group with a rounded, slightly darker tip
  const tongueG = new THREE.Group();
  tongueG.position.set(hr*snL*0.68, -hr*0.02, 0);
  tongueG.rotation.z = -0.55;
  jaw.add(tongueG);
  const tMat = toon('#ff7d9c'), tTip = toon('#f26b8d');
  const t1 = M(new THREE.SphereGeometry(hr*0.19, 12, 10), tMat, false);
  t1.scale.set(1.6, 0.42, 0.85);
  t1.position.x = hr*0.16;
  const t2 = M(new THREE.SphereGeometry(hr*0.155, 12, 10), tTip, false);
  t2.scale.set(1.25, 0.4, 0.78);
  t2.position.set(hr*0.4, -hr*0.035, 0);
  t2.rotation.z = -0.18;
  tongueG.add(t1, t2);
  tongueG.visible = !!p.tongue;
  refs.tongue = tongueG;
  refs.tongueBaseRot = -0.55;
  refs.tongueDefault = !!p.tongue;

  // eyes — sit ON the skull surface (previously they were buried inside it)
  const eyeR = hr*0.17*p.eyeSize;
  [-1,1].forEach(sd=>{
    const dir = new THREE.Vector3(0.72, 0.34, sd*0.54).normalize();
    const base = dir.clone().multiplyScalar(hr*0.92);
    const white = M(new THREE.SphereGeometry(eyeR, 14, 12), new THREE.MeshBasicMaterial({color:'#ffffff'}), false);
    white.position.copy(base);
    headG.add(white);
    const iris = M(new THREE.SphereGeometry(eyeR*0.62, 12, 10), new THREE.MeshBasicMaterial({color:p.eyeColor}), false);
    iris.position.copy(base).addScaledVector(dir, eyeR*0.5);
    headG.add(iris);
    const pupil = M(new THREE.SphereGeometry(eyeR*0.34, 10, 8), new THREE.MeshBasicMaterial({color:'#1c1310'}), false);
    pupil.position.copy(base).addScaledVector(dir, eyeR*0.74);
    headG.add(pupil);
    const glint = M(new THREE.SphereGeometry(eyeR*0.13, 8, 6), new THREE.MeshBasicMaterial({color:'#ffffff'}), false);
    glint.position.copy(base).addScaledVector(dir, eyeR*0.82)
      .add(new THREE.Vector3(0, eyeR*0.3, sd*eyeR*0.14));
    headG.add(glint);
    refs.pupils.push(white, iris, pupil, glint);

    // eyebrows
    if(p.brows){
      const brow = M(new THREE.BoxGeometry(eyeR*1.5, eyeR*0.34, eyeR*0.55), toon(p.browColor), false);
      brow.position.set(base.x*0.98, base.y + eyeR*1.45, base.z*1.04);
      brow.rotation.z = 0.22;
      brow.rotation.y = -sd*0.35;
      headG.add(brow);
    }
    // blushy cheeks
    if(p.blush){
      const bd = new THREE.Vector3(0.5, -0.08, sd*0.84).normalize();
      const bp = bd.clone().multiplyScalar(hr*0.97);
      const blush = M(new THREE.SphereGeometry(hr*0.2, 12, 10),
        new THREE.MeshBasicMaterial({color:'#ff9fb4', transparent:true, opacity:0.85}), false);
      blush.scale.set(1.2, 0.8, 0.28);
      blush.position.copy(bp);
      blush.lookAt(bp.clone().add(bd));
      headG.add(blush);
    }
  });

  // face mask / blaze
  if(p.faceMask==='mask'){
    const cap = M(new THREE.SphereGeometry(hr*1.03, 22, 14, 0, Math.PI*2, 0, 1.12), acc, false);
    cap.rotation.z = 0.22;
    headG.add(cap);
  } else if(p.faceMask==='blaze'){
    const blaze = M(new THREE.SphereGeometry(1, 16, 12), belly, false);
    blaze.scale.set(hr*0.95, hr*0.45, hr*0.2);
    blaze.position.set(hr*0.48, hr*0.42, 0);
    blaze.rotation.z = -0.38;
    headG.add(blaze);
  }

  // muzzle freckles
  if(p.freckles){
    [-1,1].forEach(sd=>{
      for(let i=0;i<3;i++){
        const dot = M(new THREE.SphereGeometry(hr*0.034, 6, 5), toon(p.noseColor), false);
        dot.position.set(
          hr*0.72 + hr*snL*(0.15 + 0.26*i),
          -hr*0.12 + hr*snW*0.6,
          sd*hr*snW*(0.32 + 0.08*i)
        );
        headG.add(dot);
      }
    });
  }

  // eye patch
  if(p.eyePatch!=='none'){
    const sd = p.eyePatch==='left'? 1 : -1;   // left = dog's left (+z)
    const d = new THREE.Vector3(0.62, 0.34, sd*0.62).normalize();
    const pos = d.clone().multiplyScalar(hr);
    const patch = M(new THREE.SphereGeometry(hr*0.42, 14, 12), spotM, false);
    patch.scale.set(1,1,0.3);
    patch.position.copy(pos).addScaledVector(d, 0.012);
    patch.lookAt(pos.clone().add(d));
    headG.add(patch);
  }

  /* --- ears ---
     Ears hang OUTSIDE the skull: each pivot tilts away from the centerline
     (negative sd) and the flap carries a lateral offset so it never sinks
     into the head, at any ear size or head size. */
  const es = p.earSize;
  [-1,1].forEach(sd=>{
    const pivot = new THREE.Group();
    headG.add(pivot);
    refs.ears.push(pivot);
    let ear, baseX = 0;

    if(p.earStyle==='pointy'){
      pivot.position.set(-hr*0.1, hr*0.7, sd*hr*0.42);
      baseX = -sd*0.22;
      pivot.rotation.z = -0.16;
      ear = M(new THREE.ConeGeometry(hr*0.34*es, hr*0.95*es, 4), acc);
      ear.rotation.y = Math.PI/4;
      ear.position.set(0, hr*0.42*es, sd*hr*0.06);
    } else if(p.earStyle==='round'){
      pivot.position.set(-hr*0.08, hr*0.58, sd*hr*0.6);
      baseX = -sd*0.5;
      ear = M(new THREE.SphereGeometry(hr*0.34*es, 14, 12), acc);
      ear.scale.set(0.72, 1, 0.5);
      ear.position.set(0, hr*0.3*es, sd*hr*0.12);
    } else if(p.earStyle==='floppy'){
      pivot.position.set(-hr*0.02, hr*0.5, sd*hr*0.66);
      baseX = -sd*0.42;
      pivot.rotation.z = 0.12;
      ear = M(new THREE.SphereGeometry(hr*0.5*es, 16, 12), acc);
      ear.scale.set(0.6, 1.05, 0.3);
      ear.position.set(0, -hr*0.48*es, sd*hr*0.3);
    } else { // long
      pivot.position.set(-hr*0.02, hr*0.5, sd*hr*0.66);
      baseX = -sd*0.34;
      pivot.rotation.z = 0.1;
      ear = M(new THREE.SphereGeometry(hr*0.5*es, 16, 12), acc);
      ear.scale.set(0.55, 1.6, 0.26);
      ear.position.set(0, -hr*0.72*es, sd*hr*0.3);
    }
    pivot.rotation.x = baseX;
    pivot.userData = {sd, baseX};
    // base nub hides any seam where the ear meets the skull
    const nub = M(new THREE.SphereGeometry(hr*0.17*Math.min(1.2,es), 10, 8), acc);
    nub.scale.set(0.9, 0.7, 0.7);
    pivot.add(nub, ear);
  });

  /* --- collar --- */
  if(p.collar){
    const neck = new THREE.Vector3().copy(headG.position).multiplyScalar(0.62).add(new THREE.Vector3(bodyRx*0.28, bodyRy*0.22, 0).multiplyScalar(0.38));
    const col = M(new THREE.TorusGeometry(hr*0.82, hr*0.11, 10, 22), toon(p.collarColor));
    col.position.copy(neck);
    col.rotation.y = Math.PI/2;
    col.rotation.x = Math.PI/2;
    col.rotation.z = -0.35;
    bodyG.add(col);
    const tag = M(new THREE.SphereGeometry(hr*0.14, 10, 8), toon('#f5c542'));
    tag.position.copy(neck).add(new THREE.Vector3(hr*0.55, -hr*0.62, 0));
    bodyG.add(tag);
  }

  /* --- bark bubble sprite --- */
  const bubble = makeBubbleSprite();
  bubble.position.set(hr*0.4, bodyY + bodyRy + hr*2.1, 0);
  bubble.visible = false;
  g.add(bubble);
  refs.bubble = bubble;

  g.scale.setScalar(p.size);
  g.traverse(o=>{ if(o.isMesh) o.castShadow = o.castShadow; });
  refs.hipHeight = bodyY*p.size;
  return {group:g, refs};
}

function makeBubbleSprite(){
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 160;
  const x = cv.getContext('2d');
  x.fillStyle = '#ffffff';
  x.strokeStyle = '#3d2a20';
  x.lineWidth = 8;
  roundRect(x, 14, 12, 228, 100, 26);
  x.fill(); x.stroke();
  x.beginPath();
  x.moveTo(96, 108); x.lineTo(70, 150); x.lineTo(134, 110);
  x.closePath(); x.fill();
  x.strokeStyle = '#3d2a20';
  x.beginPath(); x.moveTo(96,110); x.lineTo(70,150); x.lineTo(132,112); x.stroke();
  x.fillStyle = '#3d2a20';
  x.font = 'bold 52px "Comic Sans MS", sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('WOOF!', 128, 62);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false}));
  sp.scale.set(2.0, 1.25, 1);
  return sp;
}
function roundRect(x, a,b,w,h,r){
  x.beginPath();
  x.moveTo(a+r,b);
  x.arcTo(a+w,b,a+w,b+h,r);
  x.arcTo(a+w,b+h,a,b+h,r);
  x.arcTo(a,b+h,a,b,r);
  x.arcTo(a,b,a+w,b,r);
  x.closePath();
}

export { buildDog };
