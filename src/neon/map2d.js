/* The flat map: course preview in the menu, minimap in the race. One painter, two
   canvases. The static layer (network + course line) is drawn once to an offscreen
   canvas per (canvas, course); a frame is one blit plus a dot per racer. */
const MAP_PAD = 10;
const layers = new Map();          // canvas -> {key, off, fit}

function fitFor(cv, bbox){
  const w = cv.width, h = cv.height;
  const sx = (w-2*MAP_PAD)/Math.max(1, bbox.x1-bbox.x0), sz = (h-2*MAP_PAD)/Math.max(1, bbox.z1-bbox.z0);
  const k = Math.min(sx, sz);
  const ox = (w - (bbox.x1-bbox.x0)*k)/2, oz = (h - (bbox.z1-bbox.z0)*k)/2;
  return {k, X: x => ox + (x-bbox.x0)*k, Y: z => oz + (z-bbox.z0)*k};
}
function sizeCanvas(cv){
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round((cv.clientWidth || 240)*dpr), h = Math.round((cv.clientHeight || 240)*dpr);
  if(cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; return true; }
  return false;
}
function lineBox(line, pad){
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for(const p of line){ if(p[0]<x0)x0=p[0]; if(p[0]>x1)x1=p[0]; if(p[1]<z0)z0=p[1]; if(p[1]>z1)z1=p[1]; }
  return {x0:x0-pad, x1:x1+pad, z0:z0-pad, z1:z1+pad};
}

/* line: [[x,z],...] of the course (closed -> drawn closed). zoomToCourse frames the
   course rather than the whole map, which is what the in-race minimap wants. */
function paintMap(cv, graph, bbox, line, closed, key, zoomToCourse){
  if(!cv) return null;
  const resized = sizeCanvas(cv);
  let L = layers.get(cv);
  if(!L || L.key !== key || resized){
    const off = document.createElement('canvas');
    off.width = cv.width; off.height = cv.height;
    const box = (zoomToCourse && line && line.length) ? lineBox(line, 120) : bbox;
    const fit = fitFor(cv, box);
    const g = off.getContext('2d');
    if(g){
      g.clearRect(0, 0, off.width, off.height);
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = 'rgba(70,110,200,0.55)'; g.lineWidth = Math.max(1, cv.width/260);
      g.beginPath();
      for(const e of (graph ? graph.edges : [])){
        e.pts.forEach((p, i) => { if(i) g.lineTo(fit.X(p[0]), fit.Y(p[1])); else g.moveTo(fit.X(p[0]), fit.Y(p[1])); });
      }
      g.stroke();
      if(line && line.length > 1){
        for(const [color, width] of [['rgba(25,240,255,0.28)', 7], ['#19f0ff', 2.4]]){
          g.strokeStyle = color; g.lineWidth = width*cv.width/260;
          g.beginPath();
          line.forEach((p, i) => { if(i) g.lineTo(fit.X(p[0]), fit.Y(p[1])); else g.moveTo(fit.X(p[0]), fit.Y(p[1])); });
          if(closed) g.closePath();
          g.stroke();
        }
        const s = line[0], f = closed ? line[0] : line[line.length-1];
        g.fillStyle = '#b6ff3c';
        g.beginPath(); g.arc(fit.X(s[0]), fit.Y(s[1]), 4.5*cv.width/260, 0, 7); g.fill();
        if(!closed){
          g.fillStyle = '#ff2bd6';
          g.beginPath(); g.arc(fit.X(f[0]), fit.Y(f[1]), 4.5*cv.width/260, 0, 7); g.fill();
        }
      }
    }
    L = {key, off, fit};
    layers.set(cv, L);
  }
  const g = cv.getContext('2d');
  if(g){ g.clearRect(0, 0, cv.width, cv.height); g.drawImage(L.off, 0, 0); }
  return L.fit;
}
/* dots: [{x, z, color, big}] */
function paintDots(cv, fit, dots){
  const g = cv && cv.getContext('2d');
  if(!g || !fit) return;
  for(const d of dots){
    g.fillStyle = d.color;
    g.beginPath(); g.arc(fit.X(d.x), fit.Y(d.z), (d.big ? 5 : d.small ? 2 : 3.2)*cv.width/260, 0, 7); g.fill();
    if(d.big){ g.strokeStyle = '#fff'; g.lineWidth = 1.5*cv.width/260; g.stroke(); }
  }
}

export { paintMap, paintDots };
