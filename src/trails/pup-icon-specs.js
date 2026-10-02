/* What an icon is drawn FROM, and the hash that names it -- defined once, here, and used by
   both the game (pup-icons.js) and the generator (tools/make-profile-icons.mjs). If the two
   disagreed even slightly about which params a dog is built from, every shipped icon would
   look stale to the game and be redrawn on every player's device for nothing.

   A spec is {hash, build}: `build()` makes a fresh rig facing +x (the caller disposes it),
   and `hash` is taken over everything that decides how that rig looks. */
import { buildDog } from '../dog/build.js';
import { DEFAULTS } from '../dog/params.js';
import { makeAnimalModel } from '../city/animal-models.js';
import { mulberry32 } from '../core/math.js';
import { specHash, wildSeed } from '../core/profile-icon.js';

/* A dog from whatever params it has: a preset's partial set, or a saved or imported pup's
   full one. Merged over DEFAULTS exactly as the game does (main.js dogParams), so the icon
   shows the dog you would actually play. */
function dogIconSpec(params){
  const p = Object.assign({}, DEFAULTS, params);
  /* `name` is in DEFAULTS but buildDog never reads it, so it is left out of the hash: a pup
     renamed in the kennel keeps its picture, and two pups built alike share one. If buildDog
     ever does start to draw the name, bump ICON_VERSION (core/profile-icon.js). */
  const look = Object.assign({}, p); delete look.name;
  return {hash: specHash({dog: look}), build: () => buildDog(p).group};
}

/* A wild animal, seeded the way the avatar is (the cat's coat, buck or doe). */
function wildIconSpec(key){
  const seed = wildSeed(key);
  return {hash: specHash({wild: key, seed}), build: () => makeAnimalModel(key, mulberry32(seed)).g};
}

export { dogIconSpec, wildIconSpec };
