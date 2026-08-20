/* The backyard: ground, stream, garden beds, the kibble bowl and the ball.
   Shares the renderer with the rest of the suite but keeps its own lighting. */
import { scene, camera, setHemi } from '../core/render.js';
import { toon, M } from '../core/materials.js';
import { clamp, mulberry32 } from '../core/math.js';

setHemi(0x7fbf66);

/* ---------- yard bounds ---------- */
const YARD = {x: 12.5, z: 9.5};   // half-extents inside the fence
const STREAM = {x: -5.2, w: 2.4};  // a little brook crossing the yard
const GARDEN = {cx: 8.2, cz: 4.4, w: 6.0, d: 4.8};  // flower bed the rabbits raid
const BOWL_POS = {x: -7.6, z: -2.4};                // dinner bowl the squirrels raid
const BOWL_MAX = 8;

/* ---------- world ---------- */
(function buildWorld(){
  // ground
  const ground = M(new THREE.CircleGeometry(70, 48), toon('#6db554'), false, true);
  ground.rotation.x = -Math.PI/2;
  scene.add(ground);
  const lawn = M(new THREE.PlaneGeometry(YARD.x*2+2.5, YARD.z*2+2.5), toon('#7ecb61'), false, true);
  lawn.rotation.x = -Math.PI/2; lawn.position.y = 0.01;
  scene.add(lawn);
  // mowing stripes
  for(let i=-2;i<=2;i++){
    const s = M(new THREE.PlaneGeometry(2.1, YARD.z*2+2.5), toon(i%2? '#84d167':'#79c65d'), false, true);
    s.rotation.x = -Math.PI/2; s.position.set(i*4.6, 0.015, 0);
    scene.add(s);
  }

  // picket fence
  const fenceMat = toon('#f5ede0');
  function fenceRun(x0,z0,x1,z1){
    const dx=x1-x0, dz=z1-z0, len=Math.hypot(dx,dz), n=Math.round(len/0.85);
    for(let i=0;i<=n;i++){
      const t=i/n;
      const p = M(new THREE.BoxGeometry(0.16,1.25,0.05), fenceMat);
      p.position.set(x0+dx*t, 0.62, z0+dz*t);
      p.rotation.y = Math.atan2(dx,dz)+Math.PI/2;
      const tip = M(new THREE.ConeGeometry(0.11,0.2,4), fenceMat);
      tip.position.set(p.position.x, 1.33, p.position.z);
      tip.rotation.y = p.rotation.y + Math.PI/4;
      scene.add(p, tip);
    }
    for(const h of [0.45, 0.95]){
      const rail = M(new THREE.BoxGeometry(len,0.12,0.06), fenceMat);
      rail.position.set((x0+x1)/2, h, (z0+z1)/2);
      rail.rotation.y = Math.atan2(dz,dx)? -Math.atan2(dz,dx):0;
      if(Math.abs(dz)>Math.abs(dx)) rail.rotation.y = Math.PI/2;
      scene.add(rail);
    }
  }
  const fx=YARD.x+1, fz=YARD.z+1;
  fenceRun(-fx,-fz, fx,-fz);
  fenceRun(-fx, fz, fx, fz);
  fenceRun(-fx,-fz,-fx, fz);
  fenceRun( fx,-fz, fx, fz);

  // tree
  const tree = new THREE.Group();
  const trunk = M(new THREE.CylinderGeometry(0.32,0.45,2.6,10), toon('#8a5a35'));
  trunk.position.y = 1.3; tree.add(trunk);
  const leafMat = toon('#4ea94a');
  [[0,3.4,0,1.7],[ -1.1,2.8,0.3,1.15],[1.05,2.9,-0.35,1.2],[0.1,2.6,0.95,1.0]].forEach(([x,y,z,r])=>{
    tree.add(M(new THREE.SphereGeometry(r,14,12), leafMat));
    tree.children[tree.children.length-1].position.set(x,y,z);
  });
  tree.position.set(9.2,0,-6.4);
  scene.add(tree);

  // dog house
  const house = new THREE.Group();
  const hb = M(new THREE.BoxGeometry(3,2.1,2.6), toon('#e2564a')); hb.position.y=1.05; house.add(hb);
  const roofL = M(new THREE.BoxGeometry(3.4,0.18,1.75), toon('#9c4a3e'));
  roofL.position.set(0,2.55,-0.72); roofL.rotation.x = 0.62; house.add(roofL);
  const roofR = roofL.clone(); roofR.position.z = 0.72; roofR.rotation.x = -0.62; house.add(roofR);
  const door = M(new THREE.CircleGeometry(0.62,20), new THREE.MeshBasicMaterial({color:'#33241d'}));
  door.position.set(0,0.85,1.31); house.add(door);
  const doorB = M(new THREE.PlaneGeometry(1.24,0.85), new THREE.MeshBasicMaterial({color:'#33241d'}));
  doorB.position.set(0,0.43,1.31); house.add(doorB);
  house.position.set(-9.3,0,-6.2); house.rotation.y = 0.35;
  scene.add(house);

  // bone chew toy
  const bone = new THREE.Group();
  const boneMat = toon('#fdf6ea');
  const bar = M(new THREE.CylinderGeometry(0.09,0.09,0.7,8), boneMat);
  bar.rotation.z = Math.PI/2; bone.add(bar);
  [[-0.35,0.08],[-0.35,-0.08],[0.35,0.08],[0.35,-0.08]].forEach(([x,z])=>{
    const s = M(new THREE.SphereGeometry(0.13,10,8), boneMat); s.position.set(x,0,z); bone.add(s);
  });
  bone.position.set(-6.8,0.12,-3.6); bone.rotation.y = 0.7;
  scene.add(bone);

  // ----- stream -----
  const wcv = document.createElement('canvas');
  wcv.width = 96; wcv.height = 96;
  const wx = wcv.getContext('2d');
  wx.fillStyle = '#59b4e6'; wx.fillRect(0,0,96,96);
  wx.lineWidth = 5; wx.lineCap = 'round';
  for(let r=0; r<5; r++){
    wx.strokeStyle = r%2? '#8fd4f5' : '#cfeeff';
    wx.beginPath();
    for(let y=0; y<=96; y+=6){
      const px = 12 + r*19 + Math.sin((y/96)*Math.PI*2 + r)*7;
      y===0 ? wx.moveTo(px, y) : wx.lineTo(px, y);
    }
    wx.stroke();
  }
  const waterTex = new THREE.CanvasTexture(wcv);
  waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
  waterTex.repeat.set(1, 4);
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(STREAM.w, YARD.z*2 + 2.6),
    new THREE.MeshBasicMaterial({map:waterTex, transparent:true, opacity:0.92})
  );
  water.rotation.x = -Math.PI/2;
  water.position.set(STREAM.x, 0.025, 0);
  water.receiveShadow = false;
  scene.add(water);
  window.WATER = {tex: waterTex};
  // sandy banks
  [-1,1].forEach(sd=>{
    const bank = M(new THREE.PlaneGeometry(0.5, YARD.z*2 + 2.6), toon('#dcc48f'), false, true);
    bank.rotation.x = -Math.PI/2;
    bank.position.set(STREAM.x + sd*(STREAM.w/2 + 0.22), 0.02, 0);
    scene.add(bank);
  });
  // stepping stones
  [-3.1, 0.2, 3.4].forEach((sz,i)=>{
    const st = M(new THREE.SphereGeometry(0.5, 12, 8), toon(i%2? '#9aa0a6':'#b7bdc2'));
    st.scale.set(1.1, 0.32, 0.9);
    st.position.set(STREAM.x + (i-1)*0.18, 0.06, sz);
    st.rotation.y = i*0.8;
    scene.add(st);
  });

  // ----- the garden: a tilled bed of flowers in rows -----
  const soil = M(new THREE.BoxGeometry(GARDEN.w, 0.14, GARDEN.d), toon('#6b4a32'), false, true);
  soil.position.set(GARDEN.cx, 0.07, GARDEN.cz);
  scene.add(soil);
  // tilled furrows
  for(let r=0;r<4;r++){
    const fu = M(new THREE.BoxGeometry(GARDEN.w-0.5, 0.05, 0.3), toon('#5b3d29'), false);
    fu.position.set(GARDEN.cx, 0.15, GARDEN.cz - GARDEN.d/2 + 0.9 + r*1.05);
    scene.add(fu);
  }
  // stone border
  const stoneMat = [toon('#bfc4c8'), toon('#a9b0b5'), toon('#cdd2d6')];
  (function border(){
    const hw = GARDEN.w/2 + 0.16, hd = GARDEN.d/2 + 0.16;
    const step = 0.62;
    const put = (x,z,i)=>{
      const s = M(new THREE.SphereGeometry(0.24, 10, 8), stoneMat[i%3]);
      s.scale.set(1.2, 0.7, 1);
      s.position.set(x, 0.12, z);
      s.rotation.y = i*0.9;
      scene.add(s);
    };
    let i = 0;
    for(let x=-hw; x<=hw; x+=step){ put(GARDEN.cx+x, GARDEN.cz-hd, i++); put(GARDEN.cx+x, GARDEN.cz+hd, i++); }
    for(let z=-hd+step; z<hd; z+=step){ put(GARDEN.cx-hw, GARDEN.cz+z, i++); put(GARDEN.cx+hw, GARDEN.cz+z, i++); }
  })();
  // little garden sign
  (function sign(){
    const post = M(new THREE.CylinderGeometry(0.05,0.05,0.7,6), toon('#8a5a35'));
    post.position.set(GARDEN.cx - GARDEN.w/2 - 0.5, 0.35, GARDEN.cz - GARDEN.d/2 - 0.5);
    const board = M(new THREE.BoxGeometry(0.9, 0.42, 0.07), toon('#f0e2c6'));
    board.position.set(post.position.x, 0.78, post.position.z);
    board.rotation.y = -0.5;
    const tulip = M(new THREE.SphereGeometry(0.1, 10, 8), toon('#ff8bb0'), false);
    tulip.position.set(board.position.x + 0.06, 0.82, post.position.z + 0.06);
    scene.add(post, board, tulip);
  })();

  // ----- destructible flowers, planted in rows -----
  window.FLOWERS = [];
  const rngF = mulberry32(7);
  const petalColors = ['#ffd44f','#ff8bb0','#ffffff','#b48bff','#ff9a5c'];
  const COLS = 7, ROWS = 4;
  for(let r=0;r<ROWS;r++){
    for(let cI=0;cI<COLS;cI++){
      const fx2 = GARDEN.cx - GARDEN.w/2 + 0.62 + cI*((GARDEN.w-1.24)/(COLS-1)) + (rngF()-0.5)*0.16;
      const fz2 = GARDEN.cz - GARDEN.d/2 + 0.9 + r*1.05 + (rngF()-0.5)*0.16;
      const color = petalColors[(r+cI) % petalColors.length];
      const f = new THREE.Group();
      const stem = M(new THREE.CylinderGeometry(0.032,0.032,0.4,5), toon('#3f8f3c'), false);
      stem.position.y=0.2; f.add(stem);
      const leaf = M(new THREE.SphereGeometry(0.09,8,6), toon('#4ea94a'), false);
      leaf.scale.set(1.5,0.3,0.7); leaf.position.set(0.07,0.2,0); leaf.rotation.z = 0.4; f.add(leaf);
      const head = M(new THREE.SphereGeometry(0.12,10,8), toon(color), false);
      head.position.y=0.46; f.add(head);
      const core = M(new THREE.SphereGeometry(0.05,8,6), toon('#ffd44f'), false);
      core.position.y=0.53; f.add(core);
      f.position.set(fx2, 0.13, fz2);
      scene.add(f);
      FLOWERS.push({g:f, head, core, pos:{x:fx2, z:fz2}, color, alive:true, timer:0, claimed:null});
    }
  }

  // ----- food bowl -----
  window.BOWL = {pos: BOWL_POS, count: BOWL_MAX, kibbles: []};
  (function bowl(){
    const g = new THREE.Group();
    const outer = M(new THREE.CylinderGeometry(0.62, 0.44, 0.34, 20), toon('#4d8fd1'));
    outer.position.y = 0.17; g.add(outer);
    const rim = M(new THREE.TorusGeometry(0.6, 0.07, 8, 22), toon('#3a76b0'));
    rim.position.y = 0.33; rim.rotation.x = Math.PI/2; g.add(rim);
    const inner = M(new THREE.CylinderGeometry(0.5, 0.36, 0.06, 20), toon('#2f5c88'), false);
    inner.position.y = 0.29; g.add(inner);
    const band = M(new THREE.TorusGeometry(0.56, 0.035, 8, 22), toon('#f5c542'));
    band.position.y = 0.14; band.rotation.x = Math.PI/2; g.add(band);
    // kibble pieces
    const kMat = toon('#a9722f');
    const rngK = mulberry32(21);
    for(let i=0;i<BOWL_MAX;i++){
      const a = (i/BOWL_MAX)*Math.PI*2 + rngK()*0.5;
      const rr = 0.1 + rngK()*0.26;
      const k = M(new THREE.SphereGeometry(0.105, 8, 6), kMat);
      k.scale.set(1, 0.7, 1.15);
      k.position.set(Math.cos(a)*rr, 0.33 + rngK()*0.05, Math.sin(a)*rr);
      k.rotation.set(rngK()*3, rngK()*3, rngK()*3);
      g.add(k);
      BOWL.kibbles.push(k);
    }
    g.position.set(BOWL_POS.x, 0, BOWL_POS.z);
    scene.add(g);
    BOWL.group = g;
  })();

  // clouds
  window.CLOUDS = [];
  const cloudMat = new THREE.MeshBasicMaterial({color:'#ffffff'});
  for(let i=0;i<5;i++){
    const c = new THREE.Group();
    for(let j=0;j<3;j++){
      const s = new THREE.Mesh(new THREE.SphereGeometry(1.1-j*0.22,10,8), cloudMat);
      s.position.set(j*1.2-1.2, (j%2)*0.3, 0);
      s.scale.y = 0.62;
      c.add(s);
    }
    c.position.set(-30+i*14, 13+ (i%3)*2.2, -22 - (i%2)*8);
    scene.add(c); CLOUDS.push(c);
  }
})();

/* ---------- ball (simple physics toy) ---------- */
const ball = (()=>{
  const g = new THREE.Group();
  const b = M(new THREE.SphereGeometry(0.48, 18, 14), toon('#ef4d4d'));
  const stripe = M(new THREE.SphereGeometry(0.485, 18, 14), toon('#ffffff'));
  stripe.scale.set(1,0.32,1);
  g.add(b, stripe);
  g.position.set(3.4, 0.48, 3.1);
  scene.add(g);
  return {mesh:g, vel:new THREE.Vector3(), r:0.48, spinAxis:new THREE.Vector3(0,0,1)};
})();

export { YARD, STREAM, GARDEN, BOWL_POS, BOWL_MAX, ball };
