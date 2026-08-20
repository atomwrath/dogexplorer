/* dog parameter defaults + the random pup generator */
import { pick } from '../core/math.js';

const DEFAULTS = {
  name:'Biscuit',
  size:1.0,
  bodyLength:1.0, girth:1.0,
  legLength:1.0, legThick:1.0,
  headSize:1.0, snoutLength:1.0, snoutWidth:1.0, eyeSize:1.0,
  earStyle:'floppy', earSize:1.0,
  tailStyle:'straight', tailLength:1.0,
  furColor:'#c98d4f', bellyColor:'#f2e2c3', accentColor:'#96652f',
  noseColor:'#3b2b26',
  spots:false, spotColor:'#5c4126', spotCount:8, spotSize:1.0, spotSeed:3,
  eyePatch:'none',
  socks:false, sockColor:'#f2e2c3',
  muzzlePatch:true,
  collar:true, collarColor:'#e2453f',
  tongue:false,
  eyeColor:'#54412e',
  brows:false, browColor:'#2e2018',
  blush:false, freckles:false,
  faceMask:'none',
  tailThick:1.0,
  build:1.0,
};

/* ---------- random pup generator ---------- */
const FURS = ['#c98d4f','#e0973f','#b07a3e','#f4efe6','#4a3a30','#8a5a35','#d9d9d9','#e8b45f','#a63d2e','#5b6570','#efe0c8','#7d5a3c'];
const PUP_NAMES = ['Biscuit','Waffles','Ziggy','Maple','Pepper','Scout','Nova','Tater','Mochi','Banjo','Clover','Pickles','Juniper','Bruno','Poppy','Gus'];
function randomPupParams(){
  const rnd = Math.random;
  const fur = pick(FURS);
  return Object.assign({}, DEFAULTS, {
    name: pick(PUP_NAMES),
    size: 0.6+rnd()*0.95,
    bodyLength: 0.75+rnd()*0.8, girth: 0.75+rnd()*0.7,
    legLength: 0.5+rnd()*1.0, legThick: 0.65+rnd()*0.95,
    headSize: 0.75+rnd()*0.7, snoutLength: 0.45+rnd()*1.2, snoutWidth: 0.65+rnd()*0.8,
    eyeSize: 0.7+rnd()*0.9,
    earStyle: pick(['pointy','floppy','long','round']),
    earSize: 0.7+rnd()*0.9,
    tailStyle: pick(['straight','curly','plume','stub']),
    tailLength: 0.6+rnd()*1.0,
    furColor: fur,
    bellyColor: pick(['#f2e2c3','#ffffff','#f8e6bd','#e8cfa1','#d9c1a3']),
    accentColor: pick([fur,'#43332a','#2b2b2b','#96652f','#d29a3f','#8a705c']),
    spots: rnd()<0.45,
    spotColor: pick(['#5c4126','#2b2b2b','#43332a','#a63d2e','#7d5a3c']),
    spotCount: 4+Math.floor(rnd()*18),
    spotSize: 0.6+rnd()*1.2,
    spotSeed: Math.floor(rnd()*9999),
    eyePatch: pick(['none','none','none','left','right']),
    socks: rnd()<0.4,
    sockColor: pick(['#f2e2c3','#ffffff','#e8cfa1']),
    muzzlePatch: rnd()<0.6,
    collar: rnd()<0.8,
    collarColor: pick(['#e2453f','#4d8fd1','#2e6f4e','#f0b429','#7a4fd1','#ff6fa5']),
    tongue: rnd()<0.4,
    build: 0.5+rnd()*1.3,
    tailThick: 0.6+rnd()*1.1,
    eyeColor: pick(['#5a4632','#4d6a8f','#3c2e24','#2e5d3a','#6a4a26','#7a5a8f']),
    brows: rnd()<0.3,
    browColor: pick(['#2e2018','#171310','#4a3325']),
    blush: rnd()<0.2,
    freckles: rnd()<0.3,
    faceMask: pick(['none','none','none','blaze','mask']),
  });
}

export { DEFAULTS, FURS, PUP_NAMES, randomPupParams };
