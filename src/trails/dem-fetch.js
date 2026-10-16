/* Elevation for a map that has none: tools/fetch_dem.py, run inside the page.

   Give it the GeoJSON layers a player dropped in and it works out the rectangle they cover,
   downloads the Terrarium elevation tiles over it, resamples them onto a metric cell grid and
   returns a `pup-world/1` bundle -- the same object fetch_dem.py writes to disk, so
   world_bundle.js loads it unchanged and "Save" is just JSON.stringify.

   WHY IT IS A STRAIGHT PORT. The projection, the tile choice, the bilinear resample and the
   int16 packing are all fetch_dem.py's, line for line, because the one thing that must never
   differ between a map built here and a map built there is the alignment of the vectors to the
   heightfield. The constants below are the script's, and so are the clamps (the margin, the
   int16 relief limit). If fetch_dem.py changes, change this file with it.

   No DOM and no world in here except demLoadTile, which is the one function that touches the
   network and a canvas; everything else can be handed a fake `loadTile` and asked a question
   with nothing running (see tools/smoke.js).

   Every name here is unique across the project: build.py flattens the modules into one scope. */

const DEM_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_TILE_PX = 256;
const DEM_MAX_ZOOM = 15;               // elevation-tiles-prod tops out here
const DEM_MARGIN_M = 100;              // terrain kept beyond the vector bbox, as the script's --margin
const DEM_HEIGHT_SCALE = 10;           // decimetre precision, int16 on disk
const DEM_OFFSET = 32768;              // Terrarium: metres = (R*256 + G + B/256) - 32768
const DEM_PARALLEL = 6;                // tiles in flight at once

/* The resolution range the panel offers, in metres per cell. */
const DEM_CELL_MIN = 6;
const DEM_CELL_MAX = 20;
const DEM_CELL_DEFAULT = 8;            // fetch_dem.py's default too

/* LIMITS. A tile is a PNG of about 94 KB (measured on the Garden of the Gods tiles in
   .cache/dem-tiles: 8 tiles, 72-100 KB each, 94 KB mean); a flatter place will be a little
   less, so the estimate is an honest "about" rather than a promise. The warning is on what the
   player would be asked to download, the refusals are on what a phone could survive: the
   script's own 400-tile cap, and a cell cap because the grid is held three ways at once
   (Float32 heights, int16 packed, base64 text) on the way to a bundle. */
const DEM_TILE_BYTES = 95000;
const DEM_WARN_BYTES = 5e6;            // ask before downloading this much
const DEM_WARN_FILE_BYTES = 25e6;      // ... or before building a map file this big
const DEM_MAX_TILES = 400;
const DEM_MAX_CELLS = 9e6;

const DEM_ATTRIBUTION = [
  'Elevation: AWS Terrain Tiles (Mapzen), derived from USGS 3DEP, SRTM and other public sources.',
  'Vector data: (c) OpenStreetMap contributors, ODbL.',
];

/* ---------- geodesy and tile maths (fetch_dem.py's, same series, same constants) ---------- */

function demMetresPerDegree(latDeg){
  const phi = latDeg*Math.PI/180;
  const lat = 111132.92 - 559.82*Math.cos(2*phi) + 1.175*Math.cos(4*phi) - 0.0023*Math.cos(6*phi);
  const lon = 111412.84*Math.cos(phi) - 93.5*Math.cos(3*phi) + 0.118*Math.cos(5*phi);
  return {lon, lat};
}

function demTileXY(lon, lat, z){
  const la = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  const n = Math.pow(2, z);
  const s = Math.sin(la*Math.PI/180);
  return {x: (lon + 180)/360*n, y: (0.5 - Math.log((1 + s)/(1 - s))/(4*Math.PI))*n};
}

function demGroundRes(lat, z){
  return 156543.03392*Math.cos(lat*Math.PI/180)/Math.pow(2, z);
}

/* The smallest zoom whose pixels are at least `oversample` times finer than a cell. */
function demChooseZoom(lat, cell, oversample){
  const target = cell/(oversample || 2);
  const z = Math.ceil(Math.log2(156543.03392*Math.cos(lat*Math.PI/180)/target));
  return Math.max(0, Math.min(DEM_MAX_ZOOM, z));
}

function demClampCell(c){
  const n = Math.round(Number(c));
  if(!Number.isFinite(n)) return DEM_CELL_DEFAULT;
  return Math.max(DEM_CELL_MIN, Math.min(DEM_CELL_MAX, n));
}

/* 950 KB, 3.4 MB, 120 MB -- a size for a person. */
function demFormatBytes(n){
  if(!(n >= 0)) return '';
  if(n < 1e6) return Math.max(10, Math.round(n/1e4)*10) + ' KB';
  if(n < 1e8) return (n/1e6).toFixed(1) + ' MB';
  return Math.round(n/1e6) + ' MB';
}

/* ---------- reading the layers ---------- */

function demWalkGeometry(geom, fn){
  if(!geom) return;
  if(geom.type === 'GeometryCollection'){
    (geom.geometries || []).forEach(g => demWalkGeometry(g, fn));
    return;
  }
  const walk = c => {
    if(!Array.isArray(c) || !c.length) return;
    if(typeof c[0] === 'number'){ fn(c[0], c[1]); return; }
    for(const k of c) walk(k);
  };
  walk(geom.coordinates);
}

/* The lon/lat box around every position in every layer, or null when there are none. Points,
   lines and areas all count: the script's default is --bbox-layers vpa. */
function demLayerBounds(layers){
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity, count = 0;
  for(const L of layers || []){
    for(const f of ((L && L.features) || [])){
      demWalkGeometry(f && f.geometry, (lon, lat) => {
        if(!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        if(lon < minLon) minLon = lon;
        if(lon > maxLon) maxLon = lon;
        if(lat < minLat) minLat = lat;
        if(lat > maxLat) maxLat = lat;
        count++;
      });
    }
  }
  return count ? {minLon, minLat, maxLon, maxLat, count} : null;
}

/* QGIS sometimes writes a legacy `crs` member. Anything that is not WGS84 lon/lat would give a
   garbage box and a download of the wrong place, so refuse it, as the script does. */
function demCrsError(layers){
  for(const L of layers || []){
    if(!L || !L.crs) continue;
    const name = JSON.stringify(L.crs.properties || {});
    if(!(/CRS84|4326/.test(name))) return 'A layer is not in WGS84 lon/lat (EPSG:4326), so its elevation cannot be placed. Re-export it from QGIS as EPSG:4326.';
  }
  return null;
}

/* ---------- the plan: everything worth telling a person BEFORE they download ----------

   Pure arithmetic on the layers' box -- no arrays the size of the grid, no network -- so the
   panel can call it on every move of the slider. `layerBytes` is the size of the layers as
   JSON, which the caller measures once, because the saved file is the layers plus the grid. */
function demPlan(layers, cellIn, layerBytes){
  const cell = demClampCell(cellIn);
  const crsErr = demCrsError(layers);
  if(crsErr) return {error: crsErr};
  const b = demLayerBounds(layers);
  if(!b) return {error: 'There is nothing in the imported files to put elevation under.'};
  if(b.minLat < -85 || b.maxLat > 85) return {error: 'Elevation tiles stop at 85° latitude.'};

  const lon0 = (b.minLon + b.maxLon)/2, lat0 = (b.minLat + b.maxLat)/2;
  const m = demMetresPerDegree(lat0);
  // world metres about the origin, +x east, +z SOUTH (the game's convention), padded
  const x0 = (b.minLon - lon0)*m.lon - DEM_MARGIN_M, x1 = (b.maxLon - lon0)*m.lon + DEM_MARGIN_M;
  const z0 = (lat0 - b.maxLat)*m.lat - DEM_MARGIN_M, z1 = (lat0 - b.minLat)*m.lat + DEM_MARGIN_M;
  // the grid origin snaps to a multiple of the cell, so it sits on a lattice anchored at (0, 0)
  const minX = Math.floor(x0/cell)*cell, minZ = Math.floor(z0/cell)*cell;
  const nx = Math.ceil((x1 - minX)/cell), nz = Math.ceil((z1 - minZ)/cell);

  const zoom = demChooseZoom(lat0, cell);
  const mPerPx = demGroundRes(lat0, zoom);
  // x depends only on lon and y only on lat, and both run one way, so the first and last cell
  // centres bound the tiles the whole grid will read
  const tx = [demTileXY(lon0 + (minX + 0.5*cell)/m.lon, lat0, zoom).x,
              demTileXY(lon0 + (minX + (nx - 0.5)*cell)/m.lon, lat0, zoom).x];
  const ty = [demTileXY(lon0, lat0 - (minZ + 0.5*cell)/m.lat, zoom).y,
              demTileXY(lon0, lat0 - (minZ + (nz - 0.5)*cell)/m.lat, zoom).y];
  const tx0 = Math.floor(Math.min(tx[0], tx[1])), tx1 = Math.floor(Math.max(tx[0], tx[1]));
  const ty0 = Math.floor(Math.min(ty[0], ty[1])), ty1 = Math.floor(Math.max(ty[0], ty[1]));
  const nTx = tx1 - tx0 + 1, nTy = ty1 - ty0 + 1;
  const tileCount = nTx*nTy;
  const cells = nx*nz;

  const estDownloadBytes = tileCount*DEM_TILE_BYTES;
  const estFileBytes = Math.ceil(cells*2/3)*4 + (layerBytes || 0);   // int16 as base64, plus the layers
  const plan = {
    cell, bounds: b, lon0, lat0, mLon: m.lon, mLat: m.lat,
    minX, minZ, nx, nz, cells, widthM: nx*cell, heightM: nz*cell,
    zoom, mPerPx, tx0, ty0, nTx, nTy, tileCount,
    estDownloadBytes, estFileBytes,
    large: estDownloadBytes >= DEM_WARN_BYTES || estFileBytes >= DEM_WARN_FILE_BYTES,
    tooBig: null,
  };
  if(tileCount > DEM_MAX_TILES){
    plan.tooBig = `Too large: ${tileCount} tiles at ${cell} m (the limit is ${DEM_MAX_TILES}). Pick a bigger cell size or fewer files.`;
  }else if(cells > DEM_MAX_CELLS){
    plan.tooBig = `Too large: ${(cells/1e6).toFixed(1)} million cells at ${cell} m (the limit is ${DEM_MAX_CELLS/1e6} million). Pick a bigger cell size.`;
  }
  return plan;
}

/* ---------- reading a tile ---------- */

/* RGBA (or RGB-in-RGBA) bytes of one tile -> metres, a Float32Array of 256*256. R*256 + G +
   B/256 is exact in a float32, so this is the script's own numbers, bit for bit. */
function demDecodeTerrarium(rgba){
  const out = new Float32Array(DEM_TILE_PX*DEM_TILE_PX);
  for(let i = 0, p = 0; i < out.length; i++, p += 4){
    out[i] = (rgba[p]*256 + rgba[p + 1] + rgba[p + 2]/256) - DEM_OFFSET;
  }
  return out;
}

function demError(code, message){
  const e = new Error(message);
  e.demCode = code;
  return e;
}
function demAborted(){
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}
function demSleep(ms, signal){
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if(signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(demAborted()); }, {once: true});
  });
}

/* PNG blob -> metres. Read through a canvas with colour conversion and premultiplication
   asked off, because a Terrarium pixel is a number and any "correction" is a wrong elevation.
   The canvas is shrunk to nothing afterwards: iOS Safari does not give canvas memory back
   until it is, and a few hundred tiles would be enough to kill the tab. */
async function demDecodeBlob(blob){
  let bmp;
  try{ bmp = await createImageBitmap(blob, {premultiplyAlpha: 'none', colorSpaceConversion: 'none'}); }
  catch(err){ bmp = await createImageBitmap(blob); }
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  try{
    if(c.width !== DEM_TILE_PX || c.height !== DEM_TILE_PX) throw demError('bad-tile', 'An elevation tile came back the wrong size.');
    const g = c.getContext('2d', {willReadFrequently: true});
    g.drawImage(bmp, 0, 0);
    return demDecodeTerrarium(g.getImageData(0, 0, DEM_TILE_PX, DEM_TILE_PX).data);
  }finally{
    if(bmp.close) bmp.close();
    c.width = c.height = 0;
  }
}

/* One tile from the network, with the script's three tries. A 404 is not retried: it means
   that zoom has no tile there, and asking again will not make one. */
async function demLoadTile(z, x, y, signal){
  const url = DEM_TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  let last = null;
  for(let attempt = 0; attempt < 3; attempt++){
    if(signal && signal.aborted) throw demAborted();
    try{
      const res = await fetch(url, {signal, mode: 'cors'});
      if(res.status === 404) throw demError('not-found', `Elevation tile ${z}/${x}/${y} does not exist.`);
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return await demDecodeBlob(await res.blob());
    }catch(err){
      if(err && (err.name === 'AbortError' || err.demCode)) throw err;
      last = err;
      if(attempt < 2) await demSleep(1500*(attempt + 1), signal);
    }
  }
  console.error('elevation tile failed:', url, last);
  throw demError('network', 'Could not reach the elevation server. Check the connection and try again.');
}

/* ---------- building the bundle ---------- */

/* Every tile in the plan, DEM_PARALLEL at a time, row-major to match the mosaic. The first
   failure stops the rest from starting, so a dead connection costs one wait, not N. */
async function demFetchTiles(plan, loadTile, onProgress, signal){
  const total = plan.tileCount;
  const tiles = new Array(total);
  let next = 0, done = 0, failure = null;
  const worker = async () => {
    for(;;){
      if(failure) return;
      if(signal && signal.aborted) throw demAborted();
      const k = next++;
      if(k >= total) return;
      const tx = plan.tx0 + (k % plan.nTx), ty = plan.ty0 + Math.floor(k/plan.nTx);
      try{ tiles[k] = await loadTile(plan.zoom, tx, ty, signal); }
      catch(err){ failure = err; throw err; }
      done++;
      onProgress({phase: 'tiles', done, total});
    }
  };
  const workers = [];
  for(let w = 0; w < Math.min(DEM_PARALLEL, total); w++) workers.push(worker());
  await Promise.all(workers);
  return tiles;
}

/* numpy's rint: halves go to the even neighbour. Inputs here are never negative. */
function demRint(v){
  const r = Math.round(v);
  return (v - Math.floor(v) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

function demToBase64(bytes){
  let s = '';
  for(let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/* "trails.geojson" -> "trails"; a second "trails" becomes "trails-2". Layers in a bundle are
   an object keyed by name, as fetch_dem.py writes them. `used` is a Set the caller owns. */
function demLayerKey(name, used){
  const stem = String(name || '').replace(/\.(geojson|json|txt)$/i, '').trim() || 'layer';
  let key = stem, n = 2;
  while(used.has(key)) key = stem + '-' + (n++);
  used.add(key);
  return key;
}

/* Layers + plan -> {bundle, stats}. `opts`: signal (AbortSignal), onProgress ({phase, done,
   total}), loadTile (a seam for tests; defaults to the network). Throws an AbortError when
   cancelled, a demCode error for the failures a person can act on. */
async function demBuild(layers, names, plan, opts){
  const o = opts || {};
  const loadTile = o.loadTile || demLoadTile;
  const onProgress = o.onProgress || function(){};
  const signal = o.signal || null;
  if(!plan || plan.error || plan.tooBig) throw demError('plan', (plan && (plan.error || plan.tooBig)) || 'No plan.');

  const tiles = await demFetchTiles(plan, loadTile, onProgress, signal);

  const nx = plan.nx, nz = plan.nz, cell = plan.cell, nTx = plan.nTx;
  const W = nTx*DEM_TILE_PX, H = plan.nTy*DEM_TILE_PX;
  // each column and row of cells reads two source pixels at a fraction between them; the
  // coordinates are clamped inside the mosaic exactly as the script's bilinear() does
  const colX0 = new Int32Array(nx), colX1 = new Int32Array(nx), colF = new Float64Array(nx);
  for(let i = 0; i < nx; i++){
    const lon = plan.lon0 + (plan.minX + (i + 0.5)*cell)/plan.mLon;
    const px = Math.min(Math.max((demTileXY(lon, plan.lat0, plan.zoom).x - plan.tx0)*DEM_TILE_PX, 0), W - 1.001);
    colX0[i] = Math.floor(px); colX1[i] = Math.min(colX0[i] + 1, W - 1); colF[i] = px - colX0[i];
  }
  const rowY0 = new Int32Array(nz), rowY1 = new Int32Array(nz), rowF = new Float64Array(nz);
  for(let j = 0; j < nz; j++){
    const lat = plan.lat0 - (plan.minZ + (j + 0.5)*cell)/plan.mLat;
    const py = Math.min(Math.max((demTileXY(plan.lon0, lat, plan.zoom).y - plan.ty0)*DEM_TILE_PX, 0), H - 1.001);
    rowY0[j] = Math.floor(py); rowY1[j] = Math.min(rowY0[j] + 1, H - 1); rowF[j] = py - rowY0[j];
  }
  const at = (X, Y) => tiles[(Y >> 8)*nTx + (X >> 8)][((Y & 255) << 8) + (X & 255)];

  const heights = new Float32Array(nx*nz);
  let lo = Infinity, hi = -Infinity, since = Date.now();
  for(let j = 0; j < nz; j++){
    const y0 = rowY0[j], y1 = rowY1[j], fy = rowF[j];
    for(let i = 0; i < nx; i++){
      const x0 = colX0[i], x1 = colX1[i], fx = colF[i];
      const top = at(x0, y0)*(1 - fx) + at(x1, y0)*fx;
      const bot = at(x0, y1)*(1 - fx) + at(x1, y1)*fx;
      const v = Math.fround(top*(1 - fy) + bot*fy);
      heights[j*nx + i] = v;
      if(v < lo) lo = v;
      if(v > hi) hi = v;
    }
    // hand the thread back now and then, so the page can paint progress and take a Cancel
    if(Date.now() - since > 40){
      onProgress({phase: 'grid', done: j + 1, total: nz});
      await new Promise(resolve => setTimeout(resolve, 0));
      if(signal && signal.aborted) throw demAborted();
      since = Date.now();
    }
  }

  // int16 decimetres above a whole-metre base. float32 arithmetic throughout, as numpy does it
  const base = Math.floor(lo);
  const packed = new DataView(new ArrayBuffer(nx*nz*2));
  for(let k = 0; k < heights.length; k++){
    const q = demRint(Math.fround(Math.fround(heights[k] - base)*DEM_HEIGHT_SCALE));
    if(q > 32767) throw demError('relief', 'The relief in this area is too large to store. Use fewer or smaller files.');
    packed.setInt16(k*2, q, true);
  }

  const used = new Set();
  const layerObj = {};
  layers.forEach((L, i) => { layerObj[demLayerKey(names[i], used)] = L; });
  const bundle = {
    format: 'pup-world/1',
    generated: new Date().toISOString().slice(0, 19) + '+00:00',
    attribution: DEM_ATTRIBUTION.slice(),
    projection: {
      kind: 'equirectangular-local',
      originLon: plan.lon0,
      originLat: plan.lat0,
      metresPerDegreeLon: plan.mLon,
      metresPerDegreeLat: plan.mLat,
      zAxis: 'south',
      geodesy: 'wgs84',
      forward: 'x = (lon - originLon) * metresPerDegreeLon; z = (originLat - lat) * metresPerDegreeLat',
    },
    bounds: {
      minLon: plan.bounds.minLon, minLat: plan.bounds.minLat,
      maxLon: plan.bounds.maxLon, maxLat: plan.bounds.maxLat,
      minX: plan.minX, minZ: plan.minZ,
      maxX: plan.minX + nx*cell, maxZ: plan.minZ + nz*cell,
    },
    heightfield: {
      cell, width: nx, height: nz,
      originX: plan.minX, originZ: plan.minZ,
      sampleAt: 'cell centre: x = originX + (i + 0.5) * cell, z = originZ + (j + 0.5) * cell',
      order: 'row-major, index = j * width + i',
      encoding: 'int16le-base64',
      baseM: base,
      scale: DEM_HEIGHT_SCALE,
      decode: 'elevationM = baseM + int16Value / scale',
      minM: lo, maxM: hi,
      source: {zoom: plan.zoom, metresPerPixel: plan.mPerPx, tiles: DEM_TILE_URL, encoding: 'terrarium'},
      data: demToBase64(new Uint8Array(packed.buffer)),
    },
    layers: layerObj,
  };
  return {bundle, stats: {tiles: plan.tileCount, cells: nx*nz, minM: lo, maxM: hi}};
}

export { demPlan, demBuild, demLoadTile, demLayerBounds, demLayerKey, demFormatBytes, demClampCell, demDecodeTerrarium,
         DEM_CELL_MIN, DEM_CELL_MAX, DEM_CELL_DEFAULT, DEM_TILE_BYTES, DEM_WARN_BYTES, DEM_MAX_TILES };
