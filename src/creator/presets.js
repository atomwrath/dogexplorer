/* The six starter pups on the creator's preset row. */

const PRESETS = [
  {label:'Puppy',    sub:'small & round', o:{size:0.7, bodyLength:0.82, girth:1.2, legLength:0.62, legThick:1.25, headSize:1.35, snoutLength:0.55, snoutWidth:1.1, eyeSize:1.45, earStyle:'floppy', earSize:1.1, tailStyle:'stub', tailLength:1, furColor:'#d9a05e', bellyColor:'#f7ead1', accentColor:'#b5804a', spots:false, muzzlePatch:true, socks:false, eyePatch:'none', collar:false, tongue:true}},
  {label:'Low Rider',sub:'long & low',    o:{size:0.95, bodyLength:1.5, girth:1.05, legLength:0.52, legThick:1.1, headSize:1.05, snoutLength:1.0, snoutWidth:1.0, eyeSize:1.1, earStyle:'pointy', earSize:1.35, tailStyle:'plume', tailLength:1.15, furColor:'#e0973f', bellyColor:'#fdf3dd', accentColor:'#c77f2e', spots:false, muzzlePatch:true, socks:true, sockColor:'#fdf3dd', eyePatch:'none', collar:true, collarColor:'#4d8fd1', tongue:true}},
  {label:'Scout',    sub:'pointy & proud',o:{size:1.15, bodyLength:1.12, girth:0.95, legLength:1.25, legThick:1.0, headSize:0.98, snoutLength:1.3, snoutWidth:0.9, eyeSize:0.9, earStyle:'pointy', earSize:1.2, tailStyle:'plume', tailLength:1.3, furColor:'#b07a3e', bellyColor:'#e8cfa1', accentColor:'#43332a', spots:true, spotColor:'#43332a', spotCount:10, spotSize:1.5, spotSeed:9, muzzlePatch:false, socks:false, eyePatch:'none', collar:true, collarColor:'#2e6f4e', tongue:false}},
  {label:'Domino',   sub:'spotty pal',    o:{size:1.05, bodyLength:1.15, girth:0.9, legLength:1.2, legThick:0.85, headSize:0.95, snoutLength:1.2, snoutWidth:0.95, eyeSize:1.0, earStyle:'floppy', earSize:0.95, tailStyle:'straight', tailLength:1.25, furColor:'#f4efe6', bellyColor:'#ffffff', accentColor:'#2b2b2b', spots:true, spotColor:'#2b2b2b', spotCount:18, spotSize:0.8, spotSeed:12, muzzlePatch:false, socks:false, eyePatch:'right', collar:true, collarColor:'#e2453f', tongue:false}},
  {label:'Scrappy',  sub:'tiny terrier',  o:{size:0.78, bodyLength:1.0, girth:0.92, legLength:0.85, legThick:0.8, headSize:1.15, snoutLength:0.85, snoutWidth:1.05, eyeSize:1.2, earStyle:'round', earSize:0.9, tailStyle:'curly', tailLength:1.0, furColor:'#4a3a30', bellyColor:'#8a705c', accentColor:'#302620', spots:false, muzzlePatch:true, socks:true, sockColor:'#8a705c', eyePatch:'none', collar:true, collarColor:'#f0b429', tongue:true}},
  {label:'Sunny',    sub:'floofy friend', o:{size:1.2, bodyLength:1.18, girth:1.1, legLength:1.1, legThick:1.15, headSize:1.05, snoutLength:1.05, snoutWidth:1.1, eyeSize:1.0, earStyle:'long', earSize:1.15, tailStyle:'plume', tailLength:1.45, furColor:'#e8b45f', bellyColor:'#f8e6bd', accentColor:'#d29a3f', spots:false, muzzlePatch:false, socks:false, eyePatch:'none', collar:true, collarColor:'#7a4fd1', tongue:true}},
];

Object.assign(PRESETS[0].o,{blush:true,  eyeColor:'#5a4632', build:1.05, tailThick:1.25});
Object.assign(PRESETS[1].o,{eyeColor:'#4a3a2a', build:0.95, tailThick:1.1});
Object.assign(PRESETS[2].o,{brows:true, browColor:'#2e2018', eyeColor:'#6a4a26', build:1.4, faceMask:'mask', tailThick:1.15});
Object.assign(PRESETS[3].o,{eyeColor:'#4d6a8f', build:1.0, tailThick:0.9});
Object.assign(PRESETS[4].o,{brows:true, browColor:'#171310', eyeColor:'#3c2e24', build:0.8});
Object.assign(PRESETS[5].o,{eyeColor:'#54401f', build:1.15, tailThick:1.7, faceMask:'blaze'});

export { PRESETS };
