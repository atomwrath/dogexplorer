/* Trail/point/area classification + graph topology. Pure — no THREE, no DOM.
   Elevation lives entirely in terrain.js now, sourced from a real DEM (data/world_bundle.js)
   rather than Z draped onto these vertices in QGIS, so nothing here touches elevation
   at all. Projection is likewise NOT this module's job — see world.js, which projects
   through the loaded World bundle so vectors and terrain share one coordinate system. */
import { clamp } from '../core/math.js';

function pathKind(p){
  const raw=String(p.kind||p.pathType||p.trailType||'').toLowerCase();
  // order matters: "single track trail" contains both "track" and "trail" — check the
  // unambiguous road tokens first, then trail/singletrack phrasing, THEN bare "track" —
  // otherwise a hiking singletrack gets misread as a vehicle track.
  if(raw.includes('road')||raw.includes('paved')||raw.includes('service'))return'road';
  if(raw.includes('trail')||raw.includes('single')||raw.includes('path'))return'trail';
  if(raw.includes('track')||raw.includes('jeep')||raw.includes('double'))return'track';
  const hw=String(p.highway||'').toLowerCase();
  if(hw==='service'||hw==='road'||hw==='residential'||hw==='unclassified')return'road';
  if(hw==='track')return'track';
  return'trail';
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
function areaKind(p){
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
  if(p.building&&p.building!=='no')return'building';
  if(p.natural==='water'||p.water||p.waterway)return'water';
  if(p.natural==='wood'||p.landuse==='forest')return'forest';
  if(p.natural==='scrub'||p.natural==='grassland'||p.landuse==='meadow'||p.landuse==='grass')return'meadow';
  if(p.natural==='bare_rock'||p.natural==='scree'||p.natural==='cliff')return'rock';
  if(p.amenity==='parking')return'parking';
  return'meadow';
}
/* One parser for every layer type. Drop a points file, a polygons file and a lines file
   and they all land in the right bucket — file naming and drop order don't matter. */
function parseFeatures(obj){
  const lines=[],points=[],areas=[];
  const feats=obj&&obj.type==='FeatureCollection'?(obj.features||[])
    :(obj&&obj.type==='Feature'?[obj]:[]);
  for(const f of feats){
    const g=f&&f.geometry;if(!g)continue;
    const p=f.properties||{};
    const name=String(p.name||p.NAME||p.Name||p.title||p.trail||p.Trail||p.label||'').trim();
    if(g.type==='LineString'||g.type==='MultiLineString'){
      const parts=g.type==='LineString'?[g.coordinates]:g.coordinates;
      for(const part of parts)if(part&&part.length>=2)
        lines.push({name,kind:pathKind(p),pts:part.map(c=>[+c[0],+c[1]])});
    }else if(g.type==='Point'||g.type==='MultiPoint'){
      const parts=g.type==='Point'?[g.coordinates]:g.coordinates;
      for(const c of parts)if(c&&c.length>=2)
        points.push({name,kind:poiKind(p),props:p,ll:[+c[0],+c[1]]});
    }else if(g.type==='Polygon'||g.type==='MultiPolygon'){
      const parts=g.type==='Polygon'?[g.coordinates]:g.coordinates;
      for(const poly of parts){
        if(!poly||!poly.length||poly[0].length<4)continue;
        areas.push({name,kind:areaKind(p),props:p,rings:poly.map(r=>r.map(c=>[+c[0],+c[1]]))});
      }
    }
  }
  return{lines,points,areas};
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
function splitT(lines,tol){
  let guard=0,changed=true;
  while(changed&&guard++<60){
    changed=false;
    const eps=[];
    lines.forEach((L,i)=>{eps.push({p:L.pts[0],i});eps.push({p:L.pts[L.pts.length-1],i});});
    outer:
    for(const ep of eps){
      for(let j=0;j<lines.length;j++){
        if(j===ep.i)continue;
        const pts=lines[j].pts;
        if(d2(ep.p,pts[0])<tol*tol||d2(ep.p,pts[pts.length-1])<tol*tol)continue;
        for(let k=0;k<pts.length-1;k++){
          const r=ptSeg(ep.p,pts[k],pts[k+1]);
          if(r.d<tol){
            const A=pts.slice(0,k+1);A.push(r.q);
            const B=[r.q].concat(pts.slice(k+1));
            if(polyLen(A)>tol&&polyLen(B)>tol){
              const nm=lines[j].name,nk=lines[j].kind;
              lines.splice(j,1,{name:nm,kind:nk,pts:A},{name:nm,kind:nk,pts:B});
              changed=true;break outer;
            }
          }
        }
      }
    }
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
  let lines=rawLines.map(L=>({name:L.name,kind:L.kind||'trail',pts:L.pts.map(p=>p.slice())}));
  lines.forEach(L=>{L.pts=L.pts.filter((p,i)=>i===0||d2(p,L.pts[i-1])>1e-6);});
  lines=lines.filter(L=>L.pts.length>=2&&polyLen(L.pts)>snapTol*0.5);
  let spur=0;lines.forEach(L=>{if(!L.name)L.name=SPUR_NAMES[spur++%SPUR_NAMES.length];});
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
  const nameColor=new Map();
  lines.forEach((L,i)=>{
    const a=epNode.get(i+'_0'),b=epNode.get(i+'_1');
    const pts=L.pts.map(p=>p.slice());
    pts[0]=nodes[a].p.slice();pts[pts.length-1]=nodes[b].p.slice();
    const lenM=polyLen(pts);
    if(a===b&&lenM<snapTol*2)return;
    const name=L.name;
    if(!nameColor.has(name))nameColor.set(name,palette[nameColor.size%palette.length]);
    nodes[a].deg++;if(b!==a)nodes[b].deg++;
    edges.push({a,b,pts,name,lenM,color:nameColor.get(name),kind:L.kind||'trail'});
  });
  return{nodes,edges,nameColor};
}

export { pathKind, poiKind, areaKind, parseFeatures, d2, ptSeg, polyLen,
         splitT, simplifyDP, SPUR_NAMES, buildGraph };
