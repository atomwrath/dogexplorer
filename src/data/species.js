/* Every animal's stats in one place — tune behavior without touching AI code. */

const SPECIES = {
  squirrel:{nm:'Squirrel', scale:1.0, speed:2.3, brav:1.0, skit:1.0, hopper:true},
  chipmunk:{nm:'Chipmunk', scale:0.72, speed:2.5, brav:0.6, skit:1.1, hopper:true},
  rabbit:  {nm:'Rabbit',   scale:1.0, speed:2.0, brav:1.0, skit:1.15, hopper:true},
  cat:     {nm:'Cat',      scale:0.95, speed:1.9, brav:3.2, skit:0.8},
  raccoon: {nm:'Raccoon',  scale:0.95, speed:1.7, brav:2.6, skit:0.85},
  possum:  {nm:'Possum',   scale:0.9,  speed:1.3, brav:1.6, skit:0.9, playsDead:true},
  deer:    {nm:'Deer',     scale:1.55, speed:3.6, brav:1.3, skit:1.7, graze:true, bound:true},
  goat:    {nm:'Mountain goat', scale:1.3, speed:2.3, brav:4.6, skit:0.9, graze:true},
  bighorn: {nm:'Bighorn sheep', scale:1.5, speed:2.3, brav:5.6, skit:0.85, graze:true},
  bear:    {nm:'Bear',     scale:1.85, speed:2.5, brav:8.6, skit:0.72, graze:true, huffs:true},
  moose:   {nm:'Moose',    scale:2.2,  speed:2.7, brav:9.6, skit:0.72, graze:true, huffs:true},
};

export { SPECIES };
