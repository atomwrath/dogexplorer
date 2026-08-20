/* Procedural animal meshes: one generic quadruped plus the hopper variants. */
import { M, toon } from '../core/materials.js';
import { pickR } from '../core/math.js';
import { SPECIES } from '../data/species.js';

function quadruped(o){
  const g = new THREE.Group();
  const refs = {legs:[], headG:null, tailG:null};
  const bodyMat = toon(o.body);
  const L = o.len, Rr = o.r, legL = o.legL;
  const bodyY = legL + Rr*0.55;
  const bodyG = new THREE.Group(); bodyG.position.y = bodyY; g.add(bodyG);
  refs.bodyG = bodyG;

  const body = M(new THREE.SphereGeometry(1, 20, 16), bodyMat);
  body.scale.set(L, Rr, Rr*0.88);
  bodyG.add(body);
  if(o.hump){
    const h = M(new THREE.SphereGeometry(1, 16, 12), bodyMat);
    h.scale.set(L*0.55, Rr*1.05, Rr*0.85);
    h.position.set(L*0.4, Rr*0.28, 0);
    bodyG.add(h);
  }
  if(o.belly){
    const b = M(new THREE.SphereGeometry(1, 16, 12), toon(o.belly), false);
    b.scale.set(L*0.8, Rr*0.7, Rr*0.86);
    b.position.set(L*0.05, -Rr*0.3, 0);
    bodyG.add(b);
  }
  const lx = L*0.6, lz = Rr*0.55, lr = o.legR;
  const legMat = o.legs ? toon(o.legs) : bodyMat;
  [[lx,lz],[lx,-lz],[-lx,lz],[-lx,-lz]].forEach(([x,z])=>{
    const hip = new THREE.Group();
    hip.position.set(x, -Rr*0.3, z);
    const footY = -(bodyY - Rr*0.3);
    const len = -footY - 0.06;
    const cyl = M(new THREE.CylinderGeometry(lr*0.85, lr, len, 8), legMat);
    cyl.position.y = footY + 0.06 + len/2;
    hip.add(cyl);
    if(o.hooves){
      const hoof = M(new THREE.CylinderGeometry(lr*1.05, lr*1.15, 0.1, 8), toon('#3a2e26'));
      hoof.position.y = footY + 0.05;
      hip.add(hoof);
    }
    bodyG.add(hip);
    refs.legs.push(hip);
  });
  const na = o.neckUp !== undefined ? o.neckUp : 0.6;
  const nl = o.neckLen !== undefined ? o.neckLen : Rr*0.5;
  const hr = o.headR;
  const headG = new THREE.Group();
  headG.position.set(L*0.82 + nl*Math.cos(na), Rr*0.32 + nl*Math.sin(na), 0);
  bodyG.add(headG);
  refs.headG = headG;
  if(nl > 0.05){
    const neck = M(new THREE.CylinderGeometry(hr*0.55, hr*0.72, nl+hr*0.5, 9), bodyMat);
    neck.position.set(L*0.82 + (nl/2)*Math.cos(na), Rr*0.32 + (nl/2)*Math.sin(na), 0);
    neck.rotation.z = na - Math.PI/2;
    bodyG.add(neck);
  }
  const skull = M(new THREE.SphereGeometry(hr, 18, 14), o.head? toon(o.head) : bodyMat);
  headG.add(skull);
  const snMat = o.snoutCol ? toon(o.snoutCol) : (o.head? toon(o.head) : bodyMat);
  const sn = M(new THREE.SphereGeometry(hr, 14, 10), snMat);
  sn.scale.set(o.snoutL, o.snoutW*0.8, o.snoutW);
  sn.position.set(hr*0.75, -hr*0.1, 0);
  headG.add(sn);
  const nose = M(new THREE.SphereGeometry(hr*0.16, 8, 6), toon(o.nose || '#2b211c'), false);
  nose.position.set(hr*0.75 + hr*o.snoutL*0.9, -hr*0.02, 0);
  headG.add(nose);
  [-1,1].forEach(sd=>{
    const dir = new THREE.Vector3(0.6, 0.35, sd*0.6).normalize();
    const e = M(new THREE.SphereGeometry(hr*0.13, 8, 6), new THREE.MeshBasicMaterial({color:'#1c1310'}), false);
    e.position.copy(dir).multiplyScalar(hr*0.95);
    headG.add(e);
  });
  [-1,1].forEach(sd=>{
    let ear;
    if(o.ears === 'point'){
      ear = M(new THREE.ConeGeometry(hr*0.28, hr*0.6, 4), o.head? toon(o.head) : bodyMat);
      ear.rotation.y = Math.PI/4;
      ear.position.set(-hr*0.15, hr*0.9, sd*hr*0.45);
      ear.rotation.x = -sd*0.25;
    } else if(o.ears === 'big'){
      ear = M(new THREE.SphereGeometry(hr*0.42, 12, 10), o.head? toon(o.head) : bodyMat);
      ear.scale.set(0.35, 1, 0.6);
      ear.position.set(-hr*0.2, hr*0.75, sd*hr*0.72);
      ear.rotation.x = -sd*0.9;
    } else {
      ear = M(new THREE.SphereGeometry(hr*0.28, 10, 8), o.head? toon(o.head) : bodyMat);
      ear.scale.set(0.7, 1, 0.5);
      ear.position.set(-hr*0.12, hr*0.85, sd*hr*0.5);
    }
    headG.add(ear);
  });
  const tailG = new THREE.Group();
  tailG.position.set(-L*0.92, Rr*0.35, 0);
  bodyG.add(tailG);
  refs.tailG = tailG;
  const tMat = o.tailCol ? toon(o.tailCol) : bodyMat;
  if(o.tail === 'nub'){
    const s = M(new THREE.SphereGeometry(Rr*0.28, 8, 6), tMat); tailG.add(s);
  } else if(o.tail === 'down'){
    const c = M(new THREE.CylinderGeometry(Rr*0.08, Rr*0.14, Rr*1.1, 7), tMat);
    c.position.y = -Rr*0.5; tailG.add(c);
  } else if(o.tail === 'cat'){
    for(let i=0;i<5;i++){
      const t = i/4;
      const s = M(new THREE.SphereGeometry(Rr*0.16*(1-t*0.3), 8, 6), tMat);
      s.position.set(-Math.sin(t*1.4)*Rr*0.5, t*Rr*1.5, 0);
      tailG.add(s);
    }
  } else if(o.tail === 'rings'){
    for(let i=0;i<6;i++){
      const s = M(new THREE.SphereGeometry(Rr*0.3*(1-i*0.08), 9, 7), i%2? toon('#2e2924') : tMat);
      s.position.set(-i*Rr*0.32, i*Rr*0.16, 0);
      tailG.add(s);
    }
  } else if(o.tail === 'bare'){
    const c = M(new THREE.CylinderGeometry(Rr*0.05, Rr*0.1, Rr*1.6, 6), toon('#d8a0a8'));
    c.position.set(-Rr*0.5, -Rr*0.15, 0);
    c.rotation.z = 1.2;
    tailG.add(c);
  }
  o.extra && o.extra({g, bodyG, headG, tailG, L, Rr, hr, bodyY, bodyMat});
  return {g, refs};
}

function makeAnimalModel(key, rnd){
  const S = SPECIES[key];
  let built, hopper = false;
  if(key === 'squirrel' || key === 'chipmunk'){
    hopper = true;
    built = makeHopperSquirrel(key === 'chipmunk', rnd);
  } else if(key === 'rabbit'){
    hopper = true;
    built = makeHopperRabbit(rnd);
  } else if(key === 'cat'){
    const c = pickR(['#3a3a3a','#d98f4a','#b7b7b7','#f0e6d8','#5b4a3a'], rnd);
    built = quadruped({body:c, belly:'#efe6da', len:0.62, r:0.3, legL:0.42, legR:0.06,
      headR:0.26, snoutL:0.4, snoutW:0.85, neckLen:0.1, neckUp:0.8,
      ears:'point', tail:'cat', nose:'#e58a9a'});
  } else if(key === 'raccoon'){
    built = quadruped({body:'#8b8b90', belly:'#c9c9cc', len:0.66, r:0.34, legL:0.34, legR:0.07, legs:'#3a3632',
      headR:0.28, snoutL:0.55, snoutW:0.8, snoutCol:'#d9d9dc', neckLen:0.06, neckUp:0.55,
      ears:'round', tail:'rings', tailCol:'#8b8b90',
      extra:({headG, hr})=>{
        const mask = M(new THREE.SphereGeometry(hr*0.72, 14, 10), toon('#2e2924'), false);
        mask.scale.set(0.62, 0.4, 1.15);
        mask.position.set(hr*0.42, hr*0.18, 0);
        headG.add(mask);
      }});
  } else if(key === 'possum'){
    built = quadruped({body:'#9a9494', belly:'#cfc8c8', len:0.7, r:0.3, legL:0.3, legR:0.06, legs:'#4a4442',
      headR:0.26, snoutL:0.75, snoutW:0.7, head:'#e3dcd8', snoutCol:'#e3dcd8', nose:'#e58a9a',
      neckLen:0.05, neckUp:0.35, ears:'round', tail:'bare'});
  } else if(key === 'deer'){
    const buck = rnd() < 0.5;
    built = quadruped({body:'#b98a5a', belly:'#e8d7bd', len:0.85, r:0.42, legL:0.95, legR:0.055, hooves:true,
      headR:0.28, snoutL:0.65, snoutW:0.75, neckLen:0.55, neckUp:0.95,
      ears:'big', tail:'nub', tailCol:'#f5efe4', nose:'#2b211c',
      extra:({headG, hr})=>{
        if(!buck) return;
        const am = toon('#8a6a44');
        [-1,1].forEach(sd=>{
          const main = M(new THREE.CylinderGeometry(0.03, 0.045, hr*1.5, 6), am);
          main.position.set(-hr*0.25, hr*1.35, sd*hr*0.32);
          main.rotation.x = -sd*0.35; main.rotation.z = 0.3;
          headG.add(main);
          for(const [dy, rz] of [[0.35, 1.1],[0.75, 0.9]]){
            const tine = M(new THREE.CylinderGeometry(0.02, 0.032, hr*0.7, 5), am);
            tine.position.set(-hr*0.35, hr*(0.9+dy), sd*hr*(0.32+dy*0.25));
            tine.rotation.x = -sd*0.5; tine.rotation.z = rz;
            headG.add(tine);
          }
        });
      }});
  } else if(key === 'goat'){
    built = quadruped({body:'#efe8da', belly:'#f8f4ea', len:0.72, r:0.4, legL:0.62, legR:0.07, hooves:true,
      headR:0.27, snoutL:0.6, snoutW:0.75, neckLen:0.3, neckUp:0.85,
      ears:'round', tail:'nub',
      extra:({headG, hr})=>{
        const hm = toon('#8a7a62');
        [-1,1].forEach(sd=>{
          const h1 = M(new THREE.ConeGeometry(hr*0.14, hr*0.65, 6), hm);
          h1.position.set(-hr*0.28, hr*0.98, sd*hr*0.3);
          h1.rotation.z = 2.5;
          headG.add(h1);
        });
        const beard = M(new THREE.ConeGeometry(hr*0.15, hr*0.5, 6), toon('#e3dccb'));
        beard.position.set(hr*0.85, -hr*0.6, 0);
        beard.rotation.z = Math.PI;
        headG.add(beard);
      }});
  } else if(key === 'bighorn'){
    built = quadruped({body:'#9a7a58', belly:'#e0d2ba', len:0.82, r:0.46, legL:0.6, legR:0.08, hooves:true,
      headR:0.3, snoutL:0.6, snoutW:0.8, neckLen:0.28, neckUp:0.7,
      ears:'round', tail:'nub', tailCol:'#e8dfcc',
      extra:({headG, hr})=>{
        const hm = toon('#c2a878');
        [-1,1].forEach(sd=>{
          const horn = M(new THREE.TorusGeometry(hr*0.5, hr*0.16, 8, 14, Math.PI*1.55), hm);
          horn.position.set(-hr*0.15, hr*0.45, sd*hr*0.62);
          horn.rotation.y = sd*0.35;
          horn.rotation.z = 2.4;
          headG.add(horn);
        });
      }});
  } else if(key === 'bear'){
    const c = pickR(['#6b4a32','#3a3230','#8a6a4a'], rnd);
    built = quadruped({body:c, len:0.95, r:0.62, legL:0.55, legR:0.15, hump:true,
      headR:0.4, snoutL:0.5, snoutW:0.8, snoutCol:'#c9a878', neckLen:0.05, neckUp:0.35,
      ears:'round', tail:'nub'});
  } else if(key === 'moose'){
    const paddles = rnd() < 0.65;
    built = quadruped({body:'#4e3b2c', belly:'#6a5340', len:1.0, r:0.55, legL:1.15, legR:0.075, hooves:true, hump:true,
      headR:0.34, snoutL:0.95, snoutW:0.95, snoutCol:'#5e4834', neckLen:0.35, neckUp:0.55,
      ears:'big', tail:'nub',
      extra:({headG, hr})=>{
        if(!paddles) return;
        const am = toon('#c2a878');
        [-1,1].forEach(sd=>{
          const stalk = M(new THREE.CylinderGeometry(0.04, 0.055, hr*0.5, 6), am);
          stalk.position.set(-hr*0.2, hr*1.0, sd*hr*0.45);
          stalk.rotation.x = -sd*0.8;
          headG.add(stalk);
          const pad = M(new THREE.SphereGeometry(hr*0.62, 12, 8), am);
          pad.scale.set(0.9, 0.5, 0.22);
          pad.position.set(-hr*0.25, hr*1.25, sd*hr*0.85);
          pad.rotation.x = -sd*0.9;
          headG.add(pad);
        });
      }});
  }
  built.hopper = hopper;
  return built;
}

function makeHopperRabbit(rnd){
  const g = new THREE.Group();
  const c = pickR(['#e8e2d8','#b9aa97','#cdbfa8','#8a7a6a'], rnd);
  const fur = toon(c);
  const body = M(new THREE.SphereGeometry(0.3, 14, 12), fur);
  body.scale.set(1.15, 0.92, 0.85); body.position.y = 0.3; g.add(body);
  const head = M(new THREE.SphereGeometry(0.2, 12, 10), fur);
  head.position.set(0.3, 0.52, 0); g.add(head);
  [-1,1].forEach(sd=>{
    const ear = M(new THREE.SphereGeometry(0.11, 10, 8), fur);
    ear.scale.set(0.5, 2.3, 0.35);
    ear.position.set(0.22, 0.86, sd*0.09);
    ear.rotation.x = sd*0.18; ear.rotation.z = 0.28;
    g.add(ear);
    const eye = M(new THREE.SphereGeometry(0.032, 6, 5), new THREE.MeshBasicMaterial({color:'#1c1310'}), false);
    eye.position.set(0.46, 0.56, sd*0.11); g.add(eye);
  });
  const tail = M(new THREE.SphereGeometry(0.1, 8, 8), toon('#ffffff'));
  tail.position.set(-0.32, 0.36, 0); g.add(tail);
  const nose = M(new THREE.SphereGeometry(0.035, 6, 5), toon('#e58a9a'), false);
  nose.position.set(0.5, 0.5, 0); g.add(nose);
  return {g, refs:{}};
}
function makeHopperSquirrel(chip, rnd){
  const g = new THREE.Group();
  const c = chip ? pickR(['#b3764a','#c98a58'], rnd) : pickR(['#a4653a','#8a5230','#b3764a','#7a7a7a'], rnd);
  const fur = toon(c);
  const body = M(new THREE.SphereGeometry(0.22, 12, 10), fur);
  body.scale.set(1.2, 0.9, 0.8); body.position.y = 0.22; g.add(body);
  const head = M(new THREE.SphereGeometry(0.15, 12, 10), fur);
  head.position.set(0.26, 0.4, 0); g.add(head);
  [-1,1].forEach(sd=>{
    const ear = M(new THREE.ConeGeometry(0.05, 0.1, 6), fur);
    ear.position.set(0.22, 0.55, sd*0.08); g.add(ear);
    const eye = M(new THREE.SphereGeometry(0.028, 6, 5), new THREE.MeshBasicMaterial({color:'#1c1310'}), false);
    eye.position.set(0.38, 0.43, sd*0.09); g.add(eye);
  });
  const belly = M(new THREE.SphereGeometry(0.15, 10, 8), toon('#e8d3b8'), false);
  belly.scale.set(0.9, 0.75, 0.7); belly.position.set(0.08, 0.17, 0); g.add(belly);
  if(chip){
    for(const off of [-0.07, 0, 0.07]){
      const stripe = M(new THREE.BoxGeometry(0.34, 0.02, 0.028), toon(off===0? '#4a3325':'#e8d3b8'), false);
      stripe.position.set(-0.02, 0.4, off);
      stripe.rotation.z = -0.15;
      g.add(stripe);
    }
    g.scale.setScalar(0.9);
  } else {
    const tailG = new THREE.Group();
    tailG.position.set(-0.24, 0.2, 0);
    const pts = [[0,0.05],[-0.1,0.25],[-0.12,0.48],[-0.04,0.66],[0.1,0.74]];
    pts.forEach(([tx,ty],i)=>{
      const s = M(new THREE.SphereGeometry(0.085 + 0.035*Math.sin(i/4*Math.PI), 10, 8),
        i===pts.length-1? toon('#c99569') : fur);
      s.position.set(tx, ty, 0);
      tailG.add(s);
    });
    g.add(tailG);
    return {g, refs:{tailG}};
  }
  return {g, refs:{}};
}

const ALERT_TEX = (()=>{
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const x = cv.getContext('2d');
  x.fillStyle = '#e2453f';
  x.strokeStyle = '#3d2a20'; x.lineWidth = 5;
  x.font = 'bold 56px "Comic Sans MS", sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.strokeText('!', 32, 34);
  x.fillText('!', 32, 34);
  return new THREE.CanvasTexture(cv);
})();
function makeAlert(){
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:ALERT_TEX, transparent:true, depthTest:false}));
  sp.scale.set(0.55, 0.55, 1);
  sp.visible = false;
  return sp;
}
const WANT_TEX = (()=>{
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const x = cv.getContext('2d');
  x.beginPath();
  for(let i=0;i<10;i++){
    const a = (i/10)*Math.PI*2 - Math.PI/2;
    const r = i%2 ? 13 : 29;
    x.lineTo(32 + Math.cos(a)*r, 32 + Math.sin(a)*r);
  }
  x.closePath();
  x.fillStyle = '#ffd94a'; x.strokeStyle = '#3d2a20'; x.lineWidth = 5; x.lineJoin='round';
  x.fill(); x.stroke();
  return new THREE.CanvasTexture(cv);
})();
function attachWantedStar(a){
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:WANT_TEX, transparent:true, depthTest:false}));
  sp.scale.set(0.6, 0.6, 1);
  sp.position.y = a.S.scale*1.6 + 0.9;
  a.g.add(sp);
  a.star = sp;
}

export { quadruped, makeAnimalModel, makeHopperRabbit, makeHopperSquirrel,
         ALERT_TEX, makeAlert, WANT_TEX, attachWantedStar };
