/* Every animal's stats in one place — tune behavior without touching AI code.
   `emo` is the icon Pup Trails' sightings log shows; harmless elsewhere. */

const SPECIES = {
  squirrel:{nm:'Squirrel', scale:1.0, speed:2.3, brav:1.0, skit:1.0, hopper:true, emo:'🐿️'},
  chipmunk:{nm:'Chipmunk', scale:0.72, speed:2.5, brav:0.6, skit:1.1, hopper:true, emo:'🐿️'},
  rabbit:  {nm:'Rabbit',   scale:1.0, speed:2.0, brav:1.0, skit:1.15, hopper:true, emo:'🐇'},
  cat:     {nm:'Cat',      scale:0.95, speed:1.9, brav:3.2, skit:0.8, emo:'🐈'},
  raccoon: {nm:'Raccoon',  scale:0.95, speed:1.7, brav:2.6, skit:0.85, emo:'🦝'},
  possum:  {nm:'Possum',   scale:0.9,  speed:1.3, brav:1.6, skit:0.9, playsDead:true, emo:'🐀'},
  deer:    {nm:'Deer',     scale:1.55, speed:3.6, brav:1.3, skit:1.7, graze:true, bound:true, emo:'🦌'},
  goat:    {nm:'Mountain goat', scale:1.3, speed:2.3, brav:4.6, skit:0.9, graze:true, emo:'🐐'},
  bighorn: {nm:'Bighorn sheep', scale:1.5, speed:2.3, brav:5.6, skit:0.85, graze:true, emo:'🐏'},
  bear:    {nm:'Bear',     scale:1.85, speed:2.5, brav:8.6, skit:0.72, graze:true, huffs:true, emo:'🐻'},
  moose:   {nm:'Moose',    scale:2.2,  speed:2.7, brav:9.6, skit:0.72, graze:true, huffs:true, emo:'🫎'},
  // added for Pup Trails: front-country predators/scavengers that don't appear downtown
  fox:     {nm:'Red fox',  scale:0.85, speed:2.6, brav:1.4, skit:1.2, emo:'🦊'},
  coyote:  {nm:'Coyote',   scale:1.05, speed:2.9, brav:2.2, skit:1.05, emo:'🐺'},
  bobcat:  {nm:'Bobcat',   scale:0.9,  speed:2.7, brav:1.9, skit:1.3, emo:'🐈‍⬛'},
};

export { SPECIES };
