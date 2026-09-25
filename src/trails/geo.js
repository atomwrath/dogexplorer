/* Trail/point/area classification + graph topology. Pure — no THREE, no DOM.
   Elevation lives entirely in terrain.js now, sourced from a real DEM (data/world_bundle.js)
   rather than Z draped onto these vertices in QGIS, so nothing here touches elevation
   at all. Projection is likewise NOT this module's job — see world.js, which projects
   through the loaded World bundle so vectors and terrain share one coordinate system. */
import { clamp } from '../core/math.js';

/* ---------- what a line IS: path class, surface, or water ----------

   Three separate questions, answered separately, because the source data answers them
   separately. OSM (and every QGIS export of it) says what KIND of way something is in
   `highway`, what it is MADE of in `surface`, and whether it is water at all in
   `waterway`. The first version folded all of that into one guess from `highway`, which
   got the seven-bridges map wrong three ways at once:

     - Gold Camp Road is highway=unclassified, surface=dirt. `unclassified` alone said
       "road", and road meant tarmac, so a dirt road drew grey with a centre line.
     - North Cheyenne Canyon Road is highway=tertiary. `tertiary` was not in the road
       list at all, so an asphalt road fell through to the default and drew as a footpath.
       (So were `secondary` and `primary` -- three roads on the default map were trails.)
     - North Cheyenne Creek is waterway=stream with no highway tag, and the default was
       "trail", so the creek was a walkable dirt path with signposts on it.

   So: pathKind decides the CLASS (how wide, what it yields to, whether it gets
   crosswalks), pathPaved decides the SURFACE, and waterKind catches water before either
   is asked. `dirtroad` is its own class rather than "road with a flag" because nearly
   everything world.js does with a road -- kerbs, crosswalks, trimming paths back to the
   carriageway, sidewalks -- is a statement about tarmac. A dirt road is a wide track. */
const ROAD_HW = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link',
  'secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','service',
  'living_street','road','busway','raceway','escape']);
const TRACK_HW = new Set(['track']);
// ways that are for feet/bikes/horses, however they are surfaced
const PATH_HW = new Set(['path','footway','bridleway','steps','cycleway','pedestrian','corridor','via_ferrata']);
// what a way is made of when the source does not say, by class. Tarmac for anything
// built for cars; dirt for tracks and footpaths; cycleways and plazas are nearly always
// sealed.
const PAVED_BY_DEFAULT = new Set([...ROAD_HW, 'cycleway', 'pedestrian', 'corridor']);
const PAVED_SURF = new Set(['paved','asphalt','concrete','concrete:plates','concrete:lanes',
  'paving_stones','paving_stones:lanes','sett','cobblestone','unhewn_cobblestone','bricks','brick',
  'metal','metal_grid','chipseal','tartan','rubber','acrylic','wood','boardwalk','tiles']);
const UNPAVED_SURF = new Set(['unpaved','gravel','fine_gravel','compacted','dirt','earth','ground',
  'grass','sand','mud','pebblestone','rock','rocks','stone','woodchips','grass_paver','soil',
  'clay','snow','ice','salt','shells','scree']);

const tag = (p, k) => String(p[k] == null ? '' : p[k]).trim().toLowerCase();
const rawKindOf = p => String(p.kind||p.pathType||p.trailType||'').toLowerCase();

/* Word tests on a free-text name, for sources that carry no tags at all (the Pikes Peak
   export is names and ids only). Whole words, so "Roadrunner Trail" is not a road and
   "Brookside Loop" is not a brook. Only ever a FALLBACK: a highway or waterway tag always
   outranks what a way happens to be called. */
const wordIn = (s, words) => new RegExp('\\b(' + words + ')\\b', 'i').test(s);
const TRAIL_WORDS = 'trail|path|trl|loop|singletrack|walk|incline|steps|stairs|footpath|boardwalk';
const ROAD_WORDS = 'road|rd|highway|hwy|street|avenue|ave|boulevard|blvd|drive|lane|parkway|pkwy';
const PAVED_ROAD_WORDS = 'highway|hwy|street|avenue|ave|boulevard|blvd|parkway|pkwy';
/* Deliberately short. "Run", "Fork" and "Wash" name water in the real world but name
   trails at least as often ("Deer Run"), and a trail misread as a creek disappears from
   the walking network -- a far worse failure than a creek drawn as a path. */
const WATER_WORDS = 'creek|river|brook|stream|canal|ditch';
/* RAIL. railway=* says what the line carries; a disused or abandoned bed is usually a
   rail-trail by now and is left as the trail it is walked as. The name fallback is for
   exports that dropped the railway column (BarrTrailWorld.json kept only name/id, so
   "Manitou and Pike's Peak Railway" arrived with no tag at all). A name with a trail
   word in it -- "Midland Rail Trail" -- is a trail first. */
const RAIL_TAGS = new Set(['rail','narrow_gauge','light_rail','funicular','preserved','tram','monorail','miniature']);
const RAIL_WORDS = 'railway|railroad|rail|cog|funicular|tramway';

function pathKind(p, name){
  const raw=rawKindOf(p);
  const hw=tag(p,'highway');
  if(RAIL_TAGS.has(tag(p,'railway'))) return 'rail';
  if(raw && wordIn(raw, 'rail|railway|railroad')) return 'rail';
  /* order matters: "single track trail" contains both "track" and "trail" — check the
     unambiguous road tokens first, then trail/singletrack phrasing, THEN bare "track" —
     otherwise a hiking singletrack gets misread as a vehicle track. "unpaved" contains
     "paved", so a road token is only a PAVED road once the surface says so. */
  if(raw){
    if(raw.includes('road')||raw.includes('paved')||raw.includes('service')||raw.includes('street'))
      return pathPaved(p, 'road', name) ? 'road' : 'dirtroad';
    if(raw.includes('trail')||raw.includes('single')||raw.includes('path'))return'trail';
    if(raw.includes('track')||raw.includes('jeep')||raw.includes('double'))return'track';
  }
  if(ROAD_HW.has(hw)) return pathPaved(p, 'road', name) ? 'road' : 'dirtroad';
  if(TRACK_HW.has(hw)) return'track';
  if(PATH_HW.has(hw)) return'trail';
  /* No usable tag: fall back to the name. "Longs Ranch Road" is a road whether or not
     anyone tagged it; "Pikes Peak Highway" is a paved one. */
  if(!hw && name && !wordIn(name, TRAIL_WORDS) && wordIn(name, RAIL_WORDS)) return 'rail';
  if(!hw && name && !wordIn(name, TRAIL_WORDS) && wordIn(name, ROAD_WORDS))
    return pathPaved(p, 'road', name) ? 'road' : 'dirtroad';
  return'trail';
}
/* true = sealed surface (asphalt, concrete, pavers), false = dirt/gravel/ground.
   `kind` is the class pathKind settled on, used only when nothing says what the surface is. */
function pathPaved(p, kind, name){
  const surf=tag(p,'surface').split(';')[0].trim();
  if(surf.startsWith('unpaved')) return false;
  if(PAVED_SURF.has(surf)) return true;
  if(UNPAVED_SURF.has(surf)) return false;
  const raw=rawKindOf(p);
  if(raw){
    if(/unpaved|dirt|gravel|ground|jeep|4wd|primitive/.test(raw)) return false;
    if(/paved|asphalt|concrete|tarmac/.test(raw)) return true;
  }
  const tt=tag(p,'tracktype');
  if(tt==='grade1') return true;
  if(/^grade[2-5]$/.test(tt)) return false;
  const hw=tag(p,'highway');
  if(hw) return PAVED_BY_DEFAULT.has(hw);
  // untagged: a named Highway/Street/Avenue is sealed; any other "Road" is assumed dirt,
  // which is what an untagged road in a trail export almost always is
  if(kind==='road' && name) return wordIn(name, PAVED_ROAD_WORDS);
  return false;
}
/* Water, or null. Waterway tags first; then, only for a way nobody tagged as a highway,
   the name. `width` is the channel in true metres -- like a tread it does not compact with
   world scale, because it is an object the pup has to be the right size next to. */
const WATER_W = {river:4.5, canal:3.2, stream:1.6, tidal_channel:2.5, brook:1.1, drain:0.9, ditch:0.8};
const FLOWING = new Set(Object.keys(WATER_W));
function waterKind(p, name){
  const ww=tag(p,'waterway');
  let kind=null;
  if(ww){
    if(!FLOWING.has(ww)) return null;          // dams, weirs, fuel points: not a channel
    kind=ww;
  }else{
    const raw=rawKindOf(p);
    if(raw && /creek|stream|river|brook|canal|ditch|waterway/.test(raw))
      kind=/river|canal/.test(raw)?'river':'stream';
    else if(!raw && !tag(p,'highway') && name && wordIn(name, WATER_WORDS) &&
            !wordIn(name, TRAIL_WORDS) && !wordIn(name, ROAD_WORDS))
      kind=/\briver\b/i.test(name)?'river':'stream';
  }
  if(!kind) return null;
  /* A culvert carries the stream under whatever is on top: nothing to draw or bridge.
     Returned as a marker rather than null, because null means "not water" and the
     caller would then classify the culvert as a trail. */
  if(tag(p,'tunnel')==='culvert' || tag(p,'tunnel')==='yes' || tag(p,'location')==='underground')
    return {kind, culvert:true};
  let width=WATER_W[kind]||WATER_W.stream;
  const wt=parseFloat(tag(p,'width'));
  if(wt>0) width=clamp(wt, 0.6, 14);
  const intermittent = tag(p,'intermittent')==='yes' || tag(p,'seasonal')==='yes';
  if(intermittent) width*=0.75;
  return {kind, width, intermittent};
}
function isBridge(p){
  const b=tag(p,'bridge');
  if(b && b!=='no') return true;
  return /bridge/.test(rawKindOf(p));
}
function isFord(p){ const f=tag(p,'ford'); return !!f && f!=='no'; }
const GATE_BARRIERS = new Set(['gate','lift_gate','swing_gate','kissing_gate','hampshire_gate','wicket_gate']);
const MEMORIAL_HISTORIC = new Set(['memorial','monument','wayside_cross','wayside_shrine','plaque']);
const NOISE_RAILWAY = new Set(['switch','railway_crossing','signal','derail','milestone','crossing_box','turntable']);
const NOISE_HIGHWAY = new Set(['crossing','elevator','street_lamp','traffic_signals','stop','give_way',
  'turning_circle','turning_loop','speed_camera','bus_stop','motorway_junction','mini_roundabout','passing_place']);
const NOISE_AMENITY = new Set(['bicycle_parking','waste_basket','vending_machine','parking','parking_entrance',
  'recycling','post_box','telephone']);
const NOISE_BARRIER = new Set(['bollard','kerb','block','cycle_barrier','chain','entrance','height_restrictor']);
/* A platform POINT is dropped: the station point beside it is the landmark, and the
   platform itself, when mapped, is an area (see areaKind). */
function isPoiNoise(p){
  return NOISE_RAILWAY.has(tag(p,'railway')) || NOISE_HIGHWAY.has(tag(p,'highway'))
      || NOISE_AMENITY.has(tag(p,'amenity')) || NOISE_BARRIER.has(tag(p,'barrier'))
      || !!p.place || !!p.entrance
      || tag(p,'public_transport')==='stop_position' || tag(p,'public_transport')==='platform'
      || tag(p,'power')==='pole' || tag(p,'power')==='portal';
}
function poiKind(p){
  const raw=String(p.kind||p.type||p.poi||p.category||p.class||'').toLowerCase();
  const hit=(...k)=>k.some(s=>raw.includes(s));
  if(hit('build','cabin','house','hut','shelter','barn','lodge'))return'building';
  if(hit('tower','lookout','fire'))return'tower';
  if(hit('rock','boulder','formation','spire','hoodoo','stone','arch'))return'rock';
  if(hit('view','overlook','vista','scenic'))return'viewpoint';
  if(hit('picnic','table','bench','rest'))return'picnic';
  if(hit('ruin','historic','homestead'))return'ruin';
  if(hit('camp','tent'))return'camp';
  if(hit('spring','well','water','pond'))return'water';
  if(hit('peak','summit','cairn','marker'))return'cairn';
  if(hit('tree','grove'))return'tree';
  // OSM tags
  /* Parts of something already drawn, or points that name a place rather than a thing:
     a railway switch is a point ON the track, a pedestrian crossing is a point on the
     road, a hamlet is a label. A raw OSM export is full of them -- BarrTrailWorld.json
     carries 13 switches and 8 crossings -- and each one used to fall through to the
     default below and stand in the woods as a cairn called "Marker". */
  if(isPoiNoise(p)) return null;
  const rw=tag(p,'railway'), pt=tag(p,'public_transport'), am=tag(p,'amenity'), ts=tag(p,'tourism');
  if(rw==='station'||rw==='halt'||pt==='station'||tag(p,'building')==='train_station')return'station';
  if(rw==='level_crossing'||rw==='crossing')return'crossbuck';
  if(rw==='buffer_stop')return'buffer';
  if(tag(p,'power')==='tower')return'pylon';
  if(GATE_BARRIERS.has(tag(p,'barrier')))return'gate';
  if(am==='toilets')return'toilet';
  if(ts==='information'||tag(p,'highway')==='trailhead')
    return tag(p,'information')==='guidepost'?'guidepost':'infoboard';
  if(MEMORIAL_HISTORIC.has(tag(p,'historic')))return'memorial';
  if(p.shop||am==='cafe'||am==='restaurant'||ts==='museum'||tag(p,'power')==='generator')return'building';
  if(p.building&&p.building!=='no')return'building';
  if(p.man_made==='tower'||p.man_made==='water_tower')return'tower';
  if(p.tourism==='viewpoint')return'viewpoint';
  if(p.tourism==='camp_site'||p.tourism==='camp_pitch')return'camp';
  if(p.tourism==='picnic_site'||p.amenity==='picnic_table'||p.amenity==='bench')return'picnic';
  if(p.historic)return'ruin';
  if(p.natural==='rock'||p.natural==='stone'||p.natural==='cliff'||p.natural==='peak')
    return p.natural==='peak'?'cairn':'rock';
  if(p.natural==='spring'||p.amenity==='drinking_water')return'water';
  if(p.natural==='tree')return'tree';
  return'cairn';
}
/* OSM tags that describe WHO OWNS or ZONES the land, not what is on it. A raw OSM export
   carries them as polygons, and every unrecognised polygon falls through to 'meadow' below
   -- so a residential zone covering a whole hillside town became a meadow, and then a
   graded slab. None of them is a surface anyone could see on the ground, so they are not
   areas at all: areaKind answers null and parseFeatures drops them. Measured on
   BarrTrailWorld.json: five residential and one industrial polygon, the largest the 81 ha
   "Crystal Park" zone with 484 m of relief under it. No shipped map carries any. */
const NOT_A_SURFACE_LANDUSE=new Set(['residential','commercial','industrial','retail','military']);
function areaKind(p){
  if(p.boundary) return null;
  if(NOT_A_SURFACE_LANDUSE.has(String(p.landuse||'').toLowerCase())) return null;
  const raw=String(p.kind||p.type||p.area||p.category||p.class||'').toLowerCase();
  const hit=(...k)=>k.some(s=>raw.includes(s));
  if(hit('water','pond','lake','reservoir','pool'))return'water';
  if(hit('forest','wood','tree','grove'))return'forest';
  if(hit('meadow','grass','field','lawn','prairie'))return'meadow';
  if(hit('red rock','redrock','red sandstone'))return'redrock';
  if(hit('light rock','lightrock','tan rock','white rock','light sandstone'))return'lightrock';
  if(hit('rock','scree','boulder','talus','formation','outcrop'))return'rock';
  if(hit('build','structure','house','cabin'))return'building';
  if(hit('park','lot','gravel'))return'parking';
  /* Rail areas before the generic building test: a station building is a building, but
     it should read as the station, and a platform is a raised concrete slab beside the
     track, not the meadow it used to fall through to. */
  if(tag(p,'railway')==='platform'||tag(p,'public_transport')==='platform')return'platform';
  if(tag(p,'building')==='train_station'||tag(p,'railway')==='station')return'depot';
  if(tag(p,'amenity')==='shelter')return'building';
  if(p.building&&p.building!=='no')return'building';
  /* A dam or weir is tagged waterway=* but it is the WALL, not the water -- Lake Moraine
     Dam is an 8 ha polygon of embankment. Graded as water it became a basin at its own
     25th percentile beside the real lake. Left to the default instead. */
  const dam=/^(dam|weir|lock_gate)$/.test(String(p.waterway||''));
  if(p.natural==='water'||p.water||(p.waterway&&!dam))return'water';
  if(p.natural==='wood'||p.landuse==='forest')return'forest';
  if(p.natural==='scrub'||p.natural==='grassland'||p.landuse==='meadow'||p.landuse==='grass')return'meadow';
  if(p.natural==='bare_rock'||p.natural==='scree'||p.natural==='cliff')return'rock';
  if(p.amenity==='parking')return'parking';
  return'meadow';
}
/* One parser for every layer type. Drop a points file, a polygons file and a lines file
   and they all land in the right bucket — file naming and drop order don't matter. */
function parseFeatures(obj){
  const lines=[],points=[],areas=[],waters=[];
  const feats=obj&&obj.type==='FeatureCollection'?(obj.features||[])
    :(obj&&obj.type==='Feature'?[obj]:[]);
  for(const f of feats){
    const g=f&&f.geometry;if(!g)continue;
    const p=f.properties||{};
    const name=String(p.name||p.NAME||p.Name||p.title||p.trail||p.Trail||p.label||'').trim();
    if(g.type==='LineString'||g.type==='MultiLineString'){
      const parts=g.type==='LineString'?[g.coordinates]:g.coordinates;
      /* Water is a separate bucket, never a line: a creek is not part of the walking
         network, and putting it in the graph gave it trailheads, signposts and a place
         in the route list. */
      const wk=waterKind(p, name);
      if(wk){
        if(wk.culvert) continue;
        for(const part of parts)if(part&&part.length>=2)
          waters.push({name,kind:wk.kind,width:wk.width,intermittent:wk.intermittent,
                       pts:part.map(c=>[+c[0],+c[1]])});
        continue;
      }
      const kind=pathKind(p, name);
      const paved=kind==='road' ? true : (kind==='dirtroad'||kind==='rail') ? false : pathPaved(p, kind, name);
      const bridge=isBridge(p), ford=isFord(p);
      // an explicit rack says cog railway outright; world.js infers it from grade otherwise
      const rackTag=kind==='rail' && !!tag(p,'railway:rack') && tag(p,'railway:rack')!=='no';
      for(const part of parts)if(part&&part.length>=2)
        lines.push({name,kind,paved,bridge,ford,rackTag,pts:part.map(c=>[+c[0],+c[1]])});
    }else if(g.type==='Point'||g.type==='MultiPoint'){
      const parts=g.type==='Point'?[g.coordinates]:g.coordinates;
      for(const c of parts)if(c&&c.length>=2)
        { const kind=poiKind(p); if(kind!==null) points.push({name,kind,props:p,ll:[+c[0],+c[1]]}); }
    }else if(g.type==='Polygon'||g.type==='MultiPolygon'){
      const parts=g.type==='Polygon'?[g.coordinates]:g.coordinates;
      const kind=areaKind(p);
      if(kind===null) continue;
      for(const poly of parts){
        if(!poly||!poly.length||poly[0].length<4)continue;
        areas.push({name,kind,props:p,rings:poly.map(r=>r.map(c=>[+c[0],+c[1]]))});
      }
    }
  }
  return{lines,points,areas,waters};
}
/* projectAll() is intentionally gone. Projection now goes through the loaded World
   (see world.js: worldBundle.project / projectCoords), which shares the DEM's exact
   origin -- world_bundle.js is explicit that using anything else lets vectors drift
   out of alignment with the terrain. */
const d2=(a,b)=>{const dx=a[0]-b[0],dz=a[1]-b[1];return dx*dx+dz*dz;};
function ptSeg(p,a,b){
  const dx=b[0]-a[0],dz=b[1]-a[1],L2=dx*dx+dz*dz;
  let t=L2===0?0:((p[0]-a[0])*dx+(p[1]-a[1])*dz)/L2;t=clamp(t,0,1);
  const q=[a[0]+t*dx,a[1]+t*dz];
  return{t,q,d:Math.sqrt(d2(p,q))};
}
function polyLen(pts){let s=0;for(let i=1;i<pts.length;i++)s+=Math.sqrt(d2(pts[i-1],pts[i]));return s;}
// split lines where another line's endpoint lands mid-segment (T junction)
// split lines where another line's endpoint lands mid-segment (T junction)
/* Cut `lines` wherever they meet, so the graph actually knows they are connected.

   WHY THIS IS NOT COSMETIC. buildGraph only ever joins lines at their ENDPOINTS, so a
   spur whose tip lands in the middle of another trail is, topologically, two strangers
   that happen to touch. world.js then grades every edge independently and pins its ends
   to a consensus taken across the edges meeting AT A NODE -- and if there is no node,
   there is no consensus, so the two treads arrive at whatever height their own smoothing
   produced. That is the visible "two trails connect at different levels" step: on the
   default map 93 trail ends sat within 4 m of a trail they were not joined to, 48 of
   them more than half a terrace step out, the worst by three full steps.

   WHY IT USED TO GIVE UP. The previous implementation restarted its entire scan after
   every single split (`break outer`) and capped the restarts at 60. A real network needs
   hundreds, so it silently stopped after 60 cuts and left the rest disconnected -- the
   cap was reached exactly, on the default map, every load. Nothing logged, nothing threw;
   the network was simply wrong past that point.

   THE FIX IS A DIFFERENT SHAPE, not a bigger number. One pass collects every cut each
   line needs, then applies them all at once, so the cost is one scan per round instead of
   one scan per cut. A handful of rounds converges, because a cut point introduced this
   round can itself land on a third line next round. Bounded either way.

   Two kinds of meeting are handled, and they are genuinely different:
     - a T: one line's ENDPOINT lands on another's interior. Cut the through-line.
     - an X: two lines CROSS in the middle, neither ending there. Cut BOTH.
   The X case was never handled at all, which is why crossings stayed at independent
   heights even when everything else lined up. */
function segCross(p,q,r,s){
  // proper segment intersection, returning parameters along each; null when parallel or
  // when the crossing falls outside either segment
  const dx1=q[0]-p[0], dz1=q[1]-p[1], dx2=s[0]-r[0], dz2=s[1]-r[1];
  const den=dx1*dz2-dz1*dx2;
  if(Math.abs(den)<1e-12) return null;
  const t=((r[0]-p[0])*dz2-(r[1]-p[1])*dx2)/den;
  const u=((r[0]-p[0])*dz1-(r[1]-p[1])*dx1)/den;
  if(t<=0||t>=1||u<=0||u>=1) return null;
  return {t,u,q:[p[0]+dx1*t, p[1]+dz1*t]};
}

function lineBBox(pts){
  let x0=1e15,x1=-1e15,z0=1e15,z1=-1e15;
  for(const p of pts){ if(p[0]<x0)x0=p[0]; if(p[0]>x1)x1=p[0]; if(p[1]<z0)z0=p[1]; if(p[1]>z1)z1=p[1]; }
  return {x0,x1,z0,z1};
}

/* Apply a set of {k, q} cuts to one line, in arc order, dropping any that would leave a
   stub shorter than `tol` (including two cuts landing on top of each other, which is what
   several spurs converging on the same spot produces). Mirrors what the old one-at-a-time
   splice did, just for all cuts at once. */
function applyCuts(L, cuts, tol){
  const pts=L.pts;
  const arc=[0];
  for(let k=1;k<pts.length;k++) arc[k]=arc[k-1]+Math.hypot(pts[k][0]-pts[k-1][0],pts[k][1]-pts[k-1][1]);
  const total=arc[pts.length-1];
  const cs=cuts.map(c=>({k:c.k, q:c.q, x:!!c.x,
                         s:arc[c.k]+Math.hypot(c.q[0]-pts[c.k][0], c.q[1]-pts[c.k][1])}))
               .sort((a,b)=>a.s-b.s);
  /* An X crossing that lands within `tol` of this line's end cannot be a cut (the stub
     would be shorter than the snap distance), but DROPPING it -- the old behaviour -- is
     only safe when the other line's node ends up within snap range of this end. When
     BOTH lines drop their half of the same crossing, the two ends can sit up to twice
     the snap distance apart and nothing ever joins them: two paths that cross on the map
     and have never met in the graph. On the default map one such pair was held together
     only by an unrelated creek that happened to cross at the same spot, and classifying
     the creek as water (which it is) exposed it.

     So the line is SHORTENED to end on the crossing instead. The stub past it is under
     the snap distance, which buildGraph would have spent anyway; and an endpoint lying on
     the other line is a T junction, which the next splitT round cuts properly. */
  let head=null, tail=null;
  for(const c of cs){
    if(!c.x) continue;
    if(c.s>1e-9 && c.s<tol) head=c;                         // last one near the start
    if(!tail && total-c.s>1e-9 && total-c.s<tol) tail=c;    // first one near the end
  }
  if(head && tail && tail.s-head.s<tol){ head=null; tail=null; }
  const s0=head?head.s:0, s1=tail?tail.s:total;

  const keep=[];
  let last=s0;
  for(const c of cs){
    if(c.s-last<tol) continue;        // too close to the start, or to the cut before it
    if(s1-c.s<tol) continue;          // too close to the far end
    keep.push(c); last=c.s;
  }
  if(!keep.length && !head && !tail) return null;

  const piece=(from, to)=>{
    // from/to: {k, q} cut records, or null for the (possibly shortened) line ends
    const a0 = from ? from.q.slice() : pts[0];
    const k0 = from ? from.k+1 : 1;
    const k1 = to ? to.k+1 : pts.length-1;
    const end = to ? to.q.slice() : pts[pts.length-1];
    // a cut AT a vertex (a shared survey node) would otherwise repeat that vertex
    const body = pts.slice(k0, k1).filter(p => d2(p, a0) > 1e-12 && d2(p, end) > 1e-12);
    return {name:L.name, kind:L.kind, paved:L.paved, ford:L.ford, rackTag:L.rackTag, named:L.named, route:L.route,
            pts:[a0].concat(body, [end])};
  };
  const out=[];
  let prev=head;
  for(const c of keep){ out.push(piece(prev, c)); prev=c; }
  out.push(piece(prev, tail));
  return out;
}

const SPLIT_ROUNDS = 12;
function splitT(lines,tol){
  const t2=tol*tol;
  for(let round=0; round<SPLIT_ROUNDS; round++){
    const boxes=lines.map(L=>lineBBox(L.pts));
    const cuts=lines.map(()=>[]);

    // --- T junctions: an endpoint landing on another line's interior ---
    const eps=[];
    lines.forEach((L,i)=>{ eps.push({p:L.pts[0],i}); eps.push({p:L.pts[L.pts.length-1],i}); });
    for(const ep of eps){
      for(let j=0;j<lines.length;j++){
        if(j===ep.i) continue;
        const bb=boxes[j];
        if(ep.p[0]<bb.x0-tol||ep.p[0]>bb.x1+tol||ep.p[1]<bb.z0-tol||ep.p[1]>bb.z1+tol) continue;
        const pts=lines[j].pts;
        // already meets this line at one of ITS ends -- buildGraph's endpoint snap has it
        if(d2(ep.p,pts[0])<t2||d2(ep.p,pts[pts.length-1])<t2) continue;
        let best=null;
        for(let k=0;k<pts.length-1;k++){
          const r=ptSeg(ep.p,pts[k],pts[k+1]);
          if(r.d<tol&&(!best||r.d<best.d)) best={k, q:r.q, d:r.d};
        }
        if(best) cuts[j].push(best);
      }
    }

    // --- X crossings: two lines crossing mid-span, neither ending there. Both get cut,
    //     at the SAME point, so buildGraph's endpoint snap then fuses them into one node.
    for(let i=0;i<lines.length;i++){
      for(let j=i+1;j<lines.length;j++){
        const A=boxes[i], B=boxes[j];
        if(A.x1<B.x0-tol||A.x0>B.x1+tol||A.z1<B.z0-tol||A.z0>B.z1+tol) continue;
        const pa=lines[i].pts, pb=lines[j].pts;
        for(let k=0;k<pa.length-1;k++){
          for(let m=0;m<pb.length-1;m++){
            const c=segCross(pa[k],pa[k+1],pb[m],pb[m+1]);
            if(!c) continue;
            cuts[i].push({k, q:c.q.slice(), d:0, x:true});
            cuts[j].push({k:m, q:c.q.slice(), d:0, x:true});
          }
        }
        /* --- and meetings AT a vertex. Two OSM ways that share a node mid-way (a trail
           crossing a road at a surveyed point) touch exactly at a vertex, where
           segCross's open intervals see nothing and the T test, which only looks at
           endpoints, sees nothing either. On the default map a trail crossed Garden Drive
           this way and was joined to it only because a creek happened to share the same
           node; take the creek out of the network and the crossing had no node at all. */
        const eps2=(tol*0.02)*(tol*0.02);
        const touch=(P, Q, into, from, QB)=>{
          for(let k=1;k<P.length-1;k++){
            const v=P[k];
            if(v[0]<QB.x0-tol||v[0]>QB.x1+tol||v[1]<QB.z0-tol||v[1]>QB.z1+tol) continue;
            for(let m=0;m<Q.length-1;m++){
              const r=ptSeg(P[k], Q[m], Q[m+1]);
              if(r.d*r.d>eps2 || r.t<=0 && m===0 || r.t>=1 && m===Q.length-2) continue;
              // the vertex's own cut sits at the end of the segment arriving at it
              cuts[from].push({k:k-1, q:P[k].slice(), d:0, x:true});
              cuts[into].push({k:m, q:P[k].slice(), d:0, x:true});
              break;
            }
          }
        };
        touch(pa, pb, j, i, B);
        touch(pb, pa, i, j, A);
      }
    }

    let changed=false;
    const next=[];
    for(let j=0;j<lines.length;j++){
      if(!cuts[j].length){ next.push(lines[j]); continue; }
      const pieces=applyCuts(lines[j], cuts[j], tol);
      if(pieces){ changed=true; next.push(...pieces); }
      else next.push(lines[j]);
    }
    lines=next;
    if(!changed) break;
  }
  return lines;
}
// Douglas-Peucker, endpoints preserved
function simplifyDP(pts,tol){
  if(tol<=0||pts.length<3)return pts;
  const keep=new Uint8Array(pts.length);keep[0]=keep[pts.length-1]=1;
  const stack=[[0,pts.length-1]];
  while(stack.length){
    const[a,b]=stack.pop();
    let mx=-1,mi=-1;
    for(let i=a+1;i<b;i++){const r=ptSeg(pts[i],pts[a],pts[b]);if(r.d>mx){mx=r.d;mi=i;}}
    if(mx>tol){keep[mi]=1;stack.push([a,mi],[mi,b]);}
  }
  return pts.filter((_,i)=>keep[i]);
}
const SPUR_NAMES=["Coyote Cutoff","Lizard Spur","Juniper Link","Sandy Wash","Magpie Loop","Yucca Way","Raven Ridge","Prairie Dog Run","Cactus Corner","Mule Deer Path","Kestrel Climb","Bobcat Bend"];
// full pipeline → {nodes:[{p,deg,ele}], edges:[{a,b,pts,ele,name,lenM,color,kind}]}
// ele values are metres or null; null propagates through rather than defaulting to 0 so
// "no elevation data" never silently renders as sea level.
// full pipeline -> {nodes:[{p,deg}], edges:[{a,b,pts,name,lenM,color,kind}]}
function buildGraph(rawLines,snapTol,simpTol){
  let lines=rawLines.map(L=>({name:L.name,kind:L.kind||'trail',
                             paved:L.paved==null ? (L.kind==='road') : !!L.paved, ford:!!L.ford, rackTag:!!L.rackTag,
                             pts:L.pts.map(p=>p.slice())}));
  lines.forEach(L=>{L.pts=L.pts.filter((p,i)=>i===0||d2(p,L.pts[i-1])>1e-6);});
  lines=lines.filter(L=>L.pts.length>=2&&polyLen(L.pts)>snapTol*0.5);
  /* Two identities per line, and they are NOT the same thing.

     `name` is what a signpost prints. Unnamed ways still get one, from SPUR_NAMES, so the
     world reads as a signed trail network rather than a diagram -- but that list is short
     and the default map has 91 unnamed ways, so a dozen different footpaths end up
     sharing a dozen labels. Two of them meeting at a fork produced the screenshot's
     "Juniper Link 19 m / Juniper Link 49 m": one label, two genuinely different paths.
     `named` records whether the source file actually gave a name, so signage can prefer
     real ones and the panel can stop listing invented ones as if they were trails.
     `route` is the identity everything downstream groups BY -- the real name when there
     is one, otherwise a per-line key. Deduplicating sign arms, colouring the map and
     highlighting "the trail you are on" all key off route, so two paths that happen to
     share an invented label are never mistaken for one. Assigned BEFORE splitT so every
     piece a line is cut into inherits the same route. */
  let spur=0;
  lines.forEach((L,i)=>{
    L.named=!!L.name;
    L.route=L.name||('spur:'+i);
    if(!L.name)L.name=SPUR_NAMES[spur++%SPUR_NAMES.length];
  });
  lines=splitT(lines,snapTol);
  lines.forEach(L=>{L.pts=simplifyDP(L.pts,simpTol);});
  const eps=[];lines.forEach((L,i)=>{eps.push({p:L.pts[0],i,end:0});eps.push({p:L.pts[L.pts.length-1],i,end:1});});
  const par=eps.map((_,i)=>i);
  const find=i=>{while(par[i]!==i){par[i]=par[par[i]];i=par[i];}return i;};
  for(let i=0;i<eps.length;i++)for(let j=i+1;j<eps.length;j++)
    if(d2(eps[i].p,eps[j].p)<snapTol*snapTol){const a=find(i),b=find(j);if(a!==b)par[a]=b;}
  const clusters=new Map();
  eps.forEach((e,i)=>{const r=find(i);if(!clusters.has(r))clusters.set(r,[]);clusters.get(r).push(e);});
  const nodes=[];const epNode=new Map();
  for(const[,group]of clusters){
    let x=0,z=0;group.forEach(e=>{x+=e.p[0];z+=e.p[1];});
    const id=nodes.length;nodes.push({p:[x/group.length,z/group.length],deg:0});
    group.forEach(e=>epNode.set(e.i+'_'+e.end,id));
  }
  const edges=[];
  const palette=['#e8743d','#5aa7de','#67b26f','#c65fa3','#d9a02c','#7a6ed6','#3fb6a8','#b5651d'];
  // keyed by ROUTE, not by name: two unnamed paths that drew the same label out of
  // SPUR_NAMES are different paths and must not share a blaze colour
  const nameColor=new Map();
  lines.forEach((L,i)=>{
    const a=epNode.get(i+'_0'),b=epNode.get(i+'_1');
    const pts=L.pts.map(p=>p.slice());
    pts[0]=nodes[a].p.slice();pts[pts.length-1]=nodes[b].p.slice();
    const lenM=polyLen(pts);
    if(a===b&&lenM<snapTol*2)return;
    const name=L.name, route=L.route||name;
    if(!nameColor.has(route))nameColor.set(route,palette[nameColor.size%palette.length]);
    nodes[a].deg++;if(b!==a)nodes[b].deg++;
    edges.push({a,b,pts,name,route,named:!!L.named,lenM,
                color:nameColor.get(route),kind:L.kind||'trail',paved:!!L.paved,ford:!!L.ford,rackTag:!!L.rackTag});
  });
  /* Per-node census of what actually meets here. Computed once, in the module that owns
     the topology, because every consumer downstream needs the same answer: world.js has
     to tell a trail FORK (two dirt paths, sign it) from a trail/road CROSSING (a path
     over tarmac, don't sign it, and pave the pad grey), and doing that by re-walking the
     edge array at each of 162 junctions is both slower and easier to get subtly
     different in two places. `routes` counts distinct paths, not arms: a trail running
     straight through a node contributes two arms but one route, which is precisely the
     distinction that stops a plain continuation being signed as a junction. */
  nodes.forEach(n=>{ n.kinds=[]; n.routes=[]; n.named=0; });
  edges.forEach(e=>{
    const ends = e.a===e.b ? [e.a] : [e.a, e.b];
    for(const id of ends){
      const n=nodes[id];
      if(!n.kinds.includes(e.kind)) n.kinds.push(e.kind);
      if(!n.routes.includes(e.route)){ n.routes.push(e.route); if(e.named) n.named++; }
    }
  });
  return{nodes,edges,nameColor};
}

/* ---------- cropping to the DEM ----------
   A bundle's heightfield is a rectangle, and outside it terrain.js clamps to the edge
   cell -- so anything drawn past the edge stands on a copy of the rim, stretched out
   over ground that does not exist. fetch_dem.py sizes that rectangle from whichever
   layers --bbox-layers names, and a raw OSM points/areas export routinely reaches well
   past the trails (BarrTrailWorld.json: 8 POIs and 16 polygons, the forest out to 3 km
   beyond the edge). world.js crops every layer to the rectangle with these. `r` is
   {x0,z0,x1,z1} in projected world units. */
function inRect(x,z,r){ return x>=r.x0 && x<=r.x1 && z>=r.z0 && z<=r.z1; }
/* Liang-Barsky on one segment: the [t0,t1] part of a->b inside r, or null. */
function clipSegT(a,b,r){
  const dx=b[0]-a[0], dz=b[1]-a[1];
  let t0=0, t1=1;
  const P=[-dx,dx,-dz,dz], Q=[a[0]-r.x0, r.x1-a[0], a[1]-r.z0, r.z1-a[1]];
  for(let k=0;k<4;k++){
    if(P[k]===0){ if(Q[k]<0) return null; continue; }
    const t=Q[k]/P[k];
    if(P[k]<0){ if(t>t1) return null; if(t>t0) t0=t; }
    else      { if(t<t0) return null; if(t<t1) t1=t; }
  }
  return [t0,t1];
}
/* A polyline cut to the rectangle: every inside run as its own polyline, with the
   crossing points added so a trail ends exactly on the edge rather than one vertex
   short of it. Runs shorter than two points are dropped. */
function clipLineToRect(pts,r){
  const runs=[]; let cur=null;
  const at=(a,b,t)=>[a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
  const same=(p,q)=>p && Math.abs(p[0]-q[0])<1e-9 && Math.abs(p[1]-q[1])<1e-9;
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1], b=pts[i];
    const T=clipSegT(a,b,r);
    if(!T){ if(cur){ runs.push(cur); cur=null; } continue; }
    const p=T[0]===0?a:at(a,b,T[0]), q=T[1]===1?b:at(a,b,T[1]);
    if(!cur) cur=[p];
    else if(!same(cur[cur.length-1],p)){ runs.push(cur); cur=[p]; }
    if(!same(cur[cur.length-1],q)) cur.push(q);
    if(T[1]<1){ runs.push(cur); cur=null; }
  }
  if(cur) runs.push(cur);
  return runs.filter(run=>run.length>=2);
}
/* Sutherland-Hodgman against the four edges. Returns a closed ring (first point repeated
   last, the GeoJSON form every area consumer expects) or null when too little is left. */
function clipRingToRect(ring,r){
  let pts=ring.slice();
  if(pts.length>1 && pts[0][0]===pts[pts.length-1][0] && pts[0][1]===pts[pts.length-1][1]) pts.pop();
  const edges=[
    [p=>p[0]>=r.x0, (a,b)=>{ const t=(r.x0-a[0])/(b[0]-a[0]); return [r.x0, a[1]+(b[1]-a[1])*t]; }],
    [p=>p[0]<=r.x1, (a,b)=>{ const t=(r.x1-a[0])/(b[0]-a[0]); return [r.x1, a[1]+(b[1]-a[1])*t]; }],
    [p=>p[1]>=r.z0, (a,b)=>{ const t=(r.z0-a[1])/(b[1]-a[1]); return [a[0]+(b[0]-a[0])*t, r.z0]; }],
    [p=>p[1]<=r.z1, (a,b)=>{ const t=(r.z1-a[1])/(b[1]-a[1]); return [a[0]+(b[0]-a[0])*t, r.z1]; }]];
  for(const [inside,cut] of edges){
    if(!pts.length) break;
    const out=[];
    for(let i=0;i<pts.length;i++){
      const cur=pts[i], prev=pts[(i+pts.length-1)%pts.length];
      const ci=inside(cur), pi=inside(prev);
      if(ci){ if(!pi) out.push(cut(prev,cur)); out.push(cur); }
      else if(pi) out.push(cut(prev,cur));
    }
    pts=out;
  }
  if(pts.length<3) return null;
  let A=0; for(let i=0;i<pts.length;i++){ const p=pts[i], q=pts[(i+1)%pts.length]; A+=p[0]*q[1]-q[0]*p[1]; }
  if(Math.abs(A)<1e-6) return null;
  pts.push(pts[0].slice());
  return pts;
}

export { inRect, clipLineToRect, clipRingToRect, pathKind, pathPaved, waterKind, isBridge, isFord, poiKind, areaKind, parseFeatures, d2, ptSeg, polyLen, segCross, lineBBox, applyCuts,
         splitT, simplifyDP, SPUR_NAMES, buildGraph };
