/* Point-in-polygon and polygon-shape helpers. Pure — no THREE dependency except
   areaShape's use of THREE.Shape/Path for triangulation, which mirrors how
   ExtrudeGeometry/ShapeGeometry are used everywhere else in this game. */
function pointInRing(x,z,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0],zi=ring[i][1],xj=ring[j][0],zj=ring[j][1];
    if(((zi>z)!==(zj>z))&&(x<(xj-xi)*(z-zi)/(zj-zi)+xi))inside=!inside;
  }
  return inside;
}
function pointInArea(x,z,a){
  if(!pointInRing(x,z,a.rings[0]))return false;
  for(let i=1;i<a.rings.length;i++)if(pointInRing(x,z,a.rings[i]))return false;
  return true;
}
function areaBBox(a){
  let mnx=1e9,mxx=-1e9,mnz=1e9,mxz=-1e9;
  for(const c of a.rings[0]){mnx=Math.min(mnx,c[0]);mxx=Math.max(mxx,c[0]);
    mnz=Math.min(mnz,c[1]);mxz=Math.max(mxz,c[1]);}
  return{mnx,mxx,mnz,mxz,cx:(mnx+mxx)/2,cz:(mnz+mxz)/2,w:mxx-mnx,h:mxz-mnz};
}
/* Polygon -> shape. THREE.Shape triangulates (holes included) in XY, so points go in as
   (x,-z) and the mesh is rotated back flat; buildings extrude instead of lying flat. */
function areaShape(a){
  const toShape=r=>{
    const s=new THREE.Shape();
    r.forEach((c,i)=>i?s.lineTo(c[0],-c[1]):s.moveTo(c[0],-c[1]));
    s.closePath();return s;
  };
  const shape=toShape(a.rings[0]);
  for(let i=1;i<a.rings.length;i++){
    const hole=new THREE.Path();
    a.rings[i].forEach((c,j)=>j?hole.lineTo(c[0],-c[1]):hole.moveTo(c[0],-c[1]));
    hole.closePath();shape.holes.push(hole);
  }
  return shape;
}

export { pointInRing, pointInArea, areaBBox, areaShape };
