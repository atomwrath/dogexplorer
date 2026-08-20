/* Teardown shared by the moving-actor systems. */
import { scene, disposeGroup } from '../core/render.js';
import { CARS, PEEPS, PICKUPS } from './world.js';
import { setCarried } from './pickups.js';

function clearActors(){
  for(const c of CARS){ scene.remove(c.g); disposeGroup(c.g); }
  for(const p of PEEPS){ scene.remove(p.g); disposeGroup(p.g); scene.remove(p.leash); }
  for(const it of PICKUPS){ scene.remove(it.g); disposeGroup(it.g); }
  CARS.length = 0; PEEPS.length = 0; PICKUPS.length = 0;
  setCarried(null);
}

export { clearActors };
