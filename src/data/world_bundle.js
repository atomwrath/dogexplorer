// src/data/world_bundle.js
//
// Loads a `pup-world/1` bundle produced by tools/fetch_dem.py: QGIS vector
// layers plus a terrarium-derived heightfield, in one file.
//
// The bundle carries its own projection constants. Project GeoJSON with
// `world.project()` rather than a hardcoded formula, so vectors and terrain
// are guaranteed to share a coordinate system.

const FORMAT = 'pup-world/1';

/**
 * fetch_dem.py writes `layers` as an OBJECT keyed by source filename
 * ({"pup-trails-map": {...FeatureCollection}}), because that is the natural
 * shape coming out of `load_layers()`. Consumers iterate layers as an ARRAY.
 * Spreading an object into an array literal throws "is not iterable", which
 * meant every real bundle blew up inside rebuildWorld() the moment it loaded --
 * no map, and therefore no trailheads, no start point and no avatar.
 *
 * Normalising here rather than at the call site means there is exactly one
 * place that knows about the two shapes, and `World.layers` is an array for
 * everyone: the game, the map editor and anything written later. Both shapes
 * stay valid on disk, so old bundles keep working.
 */
function normaliseLayers(layers) {
  if (!layers) return [];
  if (Array.isArray(layers)) return layers.filter(Boolean);
  return Object.entries(layers)
    .map(([name, doc]) => (doc && !doc.name ? { ...doc, name } : doc))
    .filter(Boolean);
}

function decodeInt16LE(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Terrarium PNGs are little-endian by construction here; DataView keeps
  // this correct on big-endian hosts too.
  const view = new DataView(bytes.buffer);
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export class World {
  constructor(bundle, opts = {}) {
    if (bundle.format !== FORMAT) {
      throw new Error(`Unsupported bundle format: ${bundle.format}`);
    }
    const hf = bundle.heightfield;
    const pr = bundle.projection;

    this.bundle = bundle;
    this.layers = normaliseLayers(bundle.layers);
    this.bounds = bundle.bounds;
    this.attribution = bundle.attribution;

    this.originLon = pr.originLon;
    this.originLat = pr.originLat;
    this.mPerDegLon = pr.metresPerDegreeLon;
    this.mPerDegLat = pr.metresPerDegreeLat;
    this.zSign = pr.zAxis === 'north' ? -1 : 1;

    this.originX = hf.originX;
    this.originZ = hf.originZ;
    this.minM = hf.minM;
    this.maxM = hf.maxM;
    this.mapScale = 1;

    const raw = decodeInt16LE(hf.data);
    if (raw.length !== hf.width * hf.height) {
      throw new Error(`Heightfield size mismatch: ${raw.length} vs ${hf.width * hf.height}`);
    }

    /* GRID BUDGET, and it has to be applied HERE rather than at mesh-build time.
     *
     * A DEM cell is not free: buildTerrainMesh emits a quad per cell plus a riser quad
     * per band change, so pikesworld.json's 1132x938 grid becomes 2.63M quads and 10.5M
     * vertices. That is a single draw call no tablet GPU wants, and the build allocates
     * hundreds of megabytes getting there. On an iPad the tab is killed outright and
     * Safari reloads it on the default map.
     *
     * The tempting fix is to decimate only the visible mesh and leave the height lookups
     * at full resolution. That is wrong, and expensively so: heightAt/cellI/cellJ are
     * what standingY and every collision query read, so a mesh built at stride 3 over
     * heights sampled at stride 1 puts the ground the player stands on several metres
     * away from the ground they can see. Decimating the grid itself keeps the terrain
     * mesh, the collision surface, the minimap relief and the trail grading all derived
     * from one array, which is the invariant this whole module exists to hold.
     *
     * Integer stride, nearest sample, no averaging: averaging would round off exactly the
     * terrace edges the band grid is there to find, and a half-cell offset would shift
     * the whole map against its own projection. `cell` grows by the same factor so world
     * coordinates are untouched -- the map covers the same ground, in bigger steps.
     *
     * BUDGETED ON QUADS, NOT ON CELLS, because cells are a bad proxy. A flat map emits
     * one quad per cell; a mountainous one emits a riser quad at every terrace band
     * change too. pikesworld.json has 2.8x the cells of rrworld.json but 5.4x the quads,
     * so any cell budget that leaves rrworld alone also lets pikesworld through at a size
     * that still kills the tab. Counting quads for each candidate stride costs a few
     * passes over the grid -- milliseconds, once, at load -- and is exact.
     *
     * Requires terraceStep, since the band grid is what riser count depends on. Without
     * it there is nothing to count and the budget is skipped; the caller knows the step
     * because it is the same one it passes to loadWorld. */
    let W = hf.width, H = hf.height, cell = hf.cell;
    const maxQuads = Number(opts.maxQuads) || 0;
    const step = Number(opts.terraceStep) || 0;
    const sampleAt = (st, i, j) => hf.baseM + raw[(j*st)*hf.width + i*st] / hf.scale;
    const quadsAt = (st) => {
      const w = Math.floor(hf.width/st), h = Math.floor(hf.height/st);
      if(w < 2 || h < 2) return null;
      let n = w*h;
      let prevRow = new Int32Array(w);
      for(let i = 0; i < w; i++) prevRow[i] = Math.floor(sampleAt(st, i, 0)/step);
      for(let j = 0; j < h; j++){
        const row = new Int32Array(w);
        for(let i = 0; i < w; i++) row[i] = Math.floor(sampleAt(st, i, j)/step);
        for(let i = 0; i < w-1; i++) if(row[i+1] !== row[i]) n++;
        if(j > 0) for(let i = 0; i < w; i++) if(row[i] !== prevRow[i]) n++;
        prevRow = row;
      }
      return {w, h, quads: n};
    };

    let stride = 1;
    if (maxQuads > 0 && step > 0) {
      for(;;){
        const m = quadsAt(stride);
        if(!m) { stride = Math.max(1, stride-1); break; }
        if(m.quads <= maxQuads) break;
        const next = quadsAt(stride+1);
        if(!next) break;          // already as coarse as this grid can usefully go
        stride++;
      }
    }

    const w = Math.floor(hf.width/stride), h = Math.floor(hf.height/stride);
    const heights = new Float32Array(w*h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      heights[j*w+i] = sampleAt(stride, i, j);
    }
    W = w; H = h; cell = hf.cell * stride;

    this.width = W;
    this.height = H;
    this.baseCell = cell;
    this.cell = cell;
    this.heights = heights;
    /* Read by world.js for the map note and by tools/smoke.js. 1 means the bundle was
     * used at its native resolution. */
    this.demStride = stride;
  }

  // --- horizontal scale -------------------------------------------------

  /**
   * Shrink or stretch the whole map horizontally.
   *
   * Scale MUST be applied here rather than in the game layer, because the
   * projection and the heightfield grid have to move together: `project()`
   * turns lon/lat into metres, and `cellI/cellJ` turn those same metres back
   * into DEM cells. Scaling one without the other silently decouples the
   * vectors from the terrain -- trails would drape over the wrong ground.
   * Deriving both from the untouched bundle constants keeps them consistent
   * for any scale, and makes repeat calls idempotent rather than cumulative.
   *
   * Elevations stay in true metres; vertical scale is the game's business
   * (see trails/world.js), so a scaled map is not automatically flattened.
   */
  setMapScale(scale) {
    // Lower bound loosened from 0.05 to 0.0005 to support "1:N" compaction up to
    // N=1000 (trails/main.js). Upper bound unchanged -- the UI only ever asks to shrink,
    // never enlarge past true scale, since "1:N" notation has no way to express that.
    const s = Math.max(0.0005, Math.min(8, Number(scale) || 1));
    const hf = this.bundle.heightfield;
    const pr = this.bundle.projection;
    this.mapScale = s;
    this.mPerDegLon = pr.metresPerDegreeLon * s;
    this.mPerDegLat = pr.metresPerDegreeLat * s;
    /* baseCell, not hf.cell: the bundle's own cell size is the PRE-decimation one, and
     * rereading it here would quietly undo the grid budget applied in the constructor
     * the first time anyone touched the world-scale slider. */
    this.cell = this.baseCell * s;
    this.originX = hf.originX * s;
    this.originZ = hf.originZ * s;
    return this;
  }

  // --- projection -------------------------------------------------------

  project(lon, lat, out = { x: 0, z: 0 }) {
    out.x = (lon - this.originLon) * this.mPerDegLon;
    out.z = (this.originLat - lat) * this.mPerDegLat * this.zSign;
    return out;
  }

  unproject(x, z, out = { lon: 0, lat: 0 }) {
    out.lon = this.originLon + x / this.mPerDegLon;
    out.lat = this.originLat - (z * this.zSign) / this.mPerDegLat;
    return out;
  }

  /** Project a GeoJSON coordinate array of any nesting depth, in place-safe fashion. */
  projectCoords(coords) {
    if (typeof coords[0] === 'number') {
      const p = this.project(coords[0], coords[1]);
      return [p.x, p.z];
    }
    return coords.map((c) => this.projectCoords(c));
  }

  // --- heightfield ------------------------------------------------------

  cellI(x) {
    const i = Math.floor((x - this.originX) / this.cell);
    return i < 0 ? 0 : i >= this.width ? this.width - 1 : i;
  }

  cellJ(z) {
    const j = Math.floor((z - this.originZ) / this.cell);
    return j < 0 ? 0 : j >= this.height ? this.height - 1 : j;
  }

  contains(x, z) {
    return x >= this.originX && x < this.originX + this.width * this.cell
        && z >= this.originZ && z < this.originZ + this.height * this.cell;
  }

  /**
   * Raw DEM elevation in metres for the cell containing (x, z).
   *
   * Deliberately nearest-cell, not bilinear: the terrain is piecewise
   * constant per cell, so a flat-bottomed object anywhere inside a cell
   * must read exactly one height. Interpolating here would reintroduce the
   * floating/buried-edge class of bugs the terracing exists to prevent.
   */
  heightAt(x, z) {
    return this.heights[this.cellJ(z) * this.width + this.cellI(x)];
  }

  /** Snapped ground height for a terrace step, in metres. */
  groundAt(x, z, step) {
    return Math.floor(this.heightAt(x, z) / step) * step;
  }

  /** Terrace band index (integer) for a cell. */
  bandAt(x, z, step) {
    return Math.floor(this.heightAt(x, z) / step);
  }

  /** World-space centre of cell (i, j). */
  cellCentre(i, j, out = { x: 0, z: 0 }) {
    out.x = this.originX + (i + 0.5) * this.cell;
    out.z = this.originZ + (j + 0.5) * this.cell;
    return out;
  }

  /**
   * Quantise the whole field to terrace band indices.
   * Returns an Int32Array in the same row-major order as `heights`.
   */
  terraceGrid(step) {
    const out = new Int32Array(this.heights.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.floor(this.heights[i] / step);
    }
    return out;
  }

  /** Distinct band count at a given step -- useful for sanity-checking a step size. */
  bandCount(step) {
    return Math.floor(this.maxM / step) - Math.floor(this.minM / step) + 1;
  }
}

export function loadWorldBundle(bundle, opts) {
  return new World(bundle, opts);
}

export async function fetchWorldBundle(url, opts) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return new World(await res.json(), opts);
}
