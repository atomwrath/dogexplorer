/* Side-profile icons, rendered from the game's own rigs.

   ONE RENDERER FOR TWO JOBS. The icons that ship with the game are drawn ahead of time by
   tools/make-profile-icons.mjs, and anything the game meets that has no shipped icon (a pup
   made in Backyard Pups, one imported from a file, a preset whose look has since changed) is
   drawn on the spot by the player's own browser. Both go through renderProfile() below, with
   the same lights, framing and downsample, so a drawn-ahead icon and an on-the-spot one are
   the same picture and a card never looks out of place beside its neighbours.

   WHAT IT NEEDS. Only a rig that faces +x (buildDog and makeAnimalModel both build that
   way -- see gait.js), a THREE renderer, and the THREE global. It never touches the game's
   scene: the rig is put in a scene of its own, drawn into an off-screen target, and the
   renderer's own state is put back exactly as it was found.

   WHAT COMES OUT. Plain pixels ({w, h, data}: top row first, straight RGBA), not an image.
   Turning them into a PNG is the caller's business -- a canvas in the browser, pngjs in the
   generator -- which keeps this module free of any DOM. */

const ICON_W = 120;
const ICON_H = 90;
const SUPER = 3;               // drawn at 3x and averaged down, in place of antialiasing
const MARGIN = 0.1;            // breathing room round the animal, as a fraction of its size
const OUTLINE_PX = 2;          // the ink edge, in icon pixels
const ICON_INK = [61, 42, 32];      // the UI's own ink (--ink in base.css), so a profile sits on a card like the card's border

/* The camera frame for a side view: centred on the bounds, as small as it can be while
   still holding them with a margin, and widened or heightened to the icon's aspect. Pure,
   so it can be checked without a renderer. `b` is {minX, maxX, minY, maxY}. */
function fitFrame(b, aspect, margin){
  const w = Math.max(1e-6, b.maxX - b.minX), h = Math.max(1e-6, b.maxY - b.minY);
  let hw = (w / 2) * (1 + margin), hh = (h / 2) * (1 + margin);
  if(hw / hh < aspect) hw = hh * aspect; else hh = hw / aspect;
  return {cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, hw, hh};
}

/* Bounds of what would actually be SEEN. Box3.setFromObject would do, except that it counts
   hidden objects too, and buildDog parks its (invisible) "WOOF!" bubble above the head --
   so the dog would be framed with a bubble's worth of empty sky over it. */
function sideBounds(rig){
  rig.updateMatrixWorld(true);
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  rig.traverseVisible(o => {
    if(!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    if(!g.boundingBox) g.computeBoundingBox();
    tmp.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
    box.union(tmp);
  });
  if(box.isEmpty()) return null;
  return {minX: box.min.x, maxX: box.max.x, minY: box.min.y, maxY: box.max.y,
          minZ: box.min.z, maxZ: box.max.z};
}

/* Average k-by-k blocks of straight-RGBA pixels into one, weighting colour by alpha so the
   dark fringe of an antialiased edge does not bleed into the animal's colours, and flip
   from GL's bottom-up rows to the top-down rows an image wants. */
function downsample(src, sw, sh, k){
  const w = Math.floor(sw / k), h = Math.floor(sh / k);
  const out = new Uint8ClampedArray(w * h * 4);
  const n = k * k;
  for(let y = 0; y < h; y++){
    const oy = (h - 1 - y);                      // flip
    for(let x = 0; x < w; x++){
      let r = 0, g = 0, b = 0, a = 0;
      for(let j = 0; j < k; j++){
        for(let i = 0; i < k; i++){
          const p = ((oy * k + j) * sw + (x * k + i)) * 4;
          const pa = src[p + 3];
          r += src[p] * pa; g += src[p + 1] * pa; b += src[p + 2] * pa; a += pa;
        }
      }
      const o = (y * w + x) * 4;
      if(a > 0){ out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
      out[o + 3] = a / n;
    }
  }
  return {w, h, data: out};
}

/* A thin ink edge round the animal. Without it a white rabbit or a pale goat has nothing
   to hold its shape on a cream card. Grown from the final pixels by a max-filter of the
   alpha, then the animal is laid over it, so it follows the silhouette exactly. */
function addOutline(img, rad, rgb){
  const {w, h, data} = img;
  const out = new Uint8ClampedArray(data.length);
  const R = Math.ceil(rad), lim = rad * rad + 0.25;
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      let m = 0;
      for(let dy = -R; dy <= R; dy++){
        const yy = y + dy; if(yy < 0 || yy >= h) continue;
        for(let dx = -R; dx <= R; dx++){
          const xx = x + dx; if(xx < 0 || xx >= w || dx * dx + dy * dy > lim) continue;
          const a = data[(yy * w + xx) * 4 + 3]; if(a > m) m = a;
        }
      }
      const i = (y * w + x) * 4;
      const a0 = data[i + 3] / 255, ao = m / 255, ra = a0 + ao * (1 - a0);
      if(ra > 0){
        out[i]     = (data[i]     * a0 + rgb[0] * ao * (1 - a0)) / ra;
        out[i + 1] = (data[i + 1] * a0 + rgb[1] * ao * (1 - a0)) / ra;
        out[i + 2] = (data[i + 2] * a0 + rgb[2] * ao * (1 - a0)) / ra;
        out[i + 3] = ra * 255;
      }
    }
  }
  return {w, h, data: out};
}

/* Everything renderProfile needs from three.js and the renderer. Checked up front so a
   build without a working WebGL context (or the test harness's stand-in) gets a clean
   `false` -- and the caller keeps its emoji -- rather than an exception mid-frame. */
function canRender(renderer){
  return !!(renderer && typeof renderer.readRenderTargetPixels === 'function'
    && typeof renderer.getRenderTarget === 'function'
    && typeof THREE !== 'undefined' && THREE.WebGLRenderTarget && THREE.OrthographicCamera && THREE.Box3);
}

let iconTarget = null;
function targetFor(w, h){
  if(!iconTarget || iconTarget.width !== w || iconTarget.height !== h){
    if(iconTarget) iconTarget.dispose();
    iconTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, depthBuffer: true,
    });
    // the game's own renderer writes sRGB to the screen; a target has to be told to do the
    // same or every colour comes out dark and flat
    iconTarget.texture.encoding = THREE.sRGBEncoding;
  }
  return iconTarget;
}

/* Draw `rig` from the side, facing right. Returns {w, h, data}, or null when it cannot.
   The rig is NOT disposed here: it is the caller's, and may be one it wants to keep. */
function renderProfile(renderer, rig, opts){
  if(!rig || !canRender(renderer)) return null;
  const w = (opts && opts.w) || ICON_W, h = (opts && opts.h) || ICON_H;
  const k = (opts && opts.k) || SUPER;
  const b = sideBounds(rig);
  if(!b) return null;
  const f = fitFrame(b, w / h, MARGIN);

  const scene = new THREE.Scene();
  /* The game's own two lights, at the game's own sun direction (core/render.js puts the sun at
     12, 22, 8), so an animal is shaded the way it is on the trail. The game's lighting is
     bright enough to wash a colour toward pastel, and this icon is meant to look like the
     animal you will be playing -- so it does too, rather than being "corrected". */
  scene.add(new THREE.HemisphereLight(0xcfeeff, 0x9a9a7a, 0.85));
  const sun = new THREE.DirectionalLight(0xfff1cf, 0.95);
  sun.position.set(12, 22, 8);
  scene.add(sun);
  scene.add(rig);

  const depth = (b.maxZ - b.minZ) + 40;
  const cam = new THREE.OrthographicCamera(-f.hw, f.hw, f.hh, -f.hh, 0.1, depth + 20);
  cam.position.set(f.cx, f.cy, b.maxZ + 20);
  cam.lookAt(f.cx, f.cy, 0);
  cam.updateMatrixWorld(true);

  const sw = w * k, sh = h * k;
  const rt = targetFor(sw, sh);
  const prevTarget = renderer.getRenderTarget();
  const prevAlpha = renderer.getClearAlpha();
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAuto = renderer.autoClear;
  const buf = new Uint8Array(sw * sh * 4);
  try{
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, sw, sh, buf);
  }finally{
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.autoClear = prevAuto;
    scene.remove(rig);
  }
  const img = downsample(buf, sw, sh, k);
  const rad = opts && opts.outline != null ? opts.outline : OUTLINE_PX;
  return rad > 0 ? addOutline(img, rad, ICON_INK) : img;
}

/* ---------- naming an icon, and knowing when it has gone stale ----------
   A shipped icon is filed under the roster key ('dog:Puppy', 'wild:fox') AND the hash of
   exactly what it was drawn from. When a preset is retuned, or a species' look changes, the
   hash no longer matches and the game quietly draws a fresh one instead of showing a picture
   of the old animal. ICON_VERSION is the same idea for this file: bump it when the lights,
   framing or size change, and every shipped icon is treated as stale. */
const ICON_VERSION = 1;

function stableStringify(v){
  if(v === null || typeof v !== 'object') return JSON.stringify(v);
  if(Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
/* 32-bit FNV-1a, as 8 hex digits. Not for security: for noticing that something changed. */
function hashString(str){
  let h = 0x811c9dc5;
  for(let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function specHash(spec){ return hashString(ICON_VERSION + '|' + stableStringify(spec)); }

/* The seed a wild animal is built with, so the icon shows the animal you would actually play
   (the cat's coat, buck or doe): a hash of the species key, the same one the avatar uses. */
function wildSeed(key){
  let h = 0;
  for(let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

/* Browser side: pixels to a PNG data URL. A 2D canvas is the whole of it. */
function pixelsToDataURL(img){
  const cv = document.createElement('canvas');
  cv.width = img.w; cv.height = img.h;
  const cx = cv.getContext('2d');
  cx.putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  return cv.toDataURL('image/png');
}

export { ICON_W, ICON_H, SUPER, MARGIN, OUTLINE_PX, ICON_INK, ICON_VERSION, fitFrame, sideBounds, downsample, addOutline, canRender, renderProfile,
         pixelsToDataURL, stableStringify, hashString, specHash, wildSeed };
