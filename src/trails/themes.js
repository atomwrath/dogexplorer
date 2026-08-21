/* Landscape presets for Pup Trails -- meadow / forest / red rock. There's no equivalent
   concept in Pup City or Backyard Pups (each has exactly one environment), so this is
   entirely trail-owned; nothing to reconcile with the shared modules here. */

const THEMES={
  meadow:{
    id:'meadow', mountain:['#6f8496','#5d7183','#8296a6'], mountainStyle:'peaks', em:'🌾', label:'Meadow',
    sky:'#a9d8e8', fogNear:70, fogFar:320,
    hemiSky:0xfff1d6, hemiGround:0x63804a, hemiInt:0.62, sunInt:0.82,
    grass:['#5c7f42','#6a8e4c','#527238','#77985c'], dust:'rgba(178,150,102,.11)',
    tread:'#9c6a35', shoulder:'#6e4a24', inner:'#c99a55', blaze:'#f0e2c4',
    trees:[['pine',0.4],['blob',0.4],['juniper',0.2]], treeDensity:1, treeScale:1,
    rocks:['#a8836a','#b28f76'], rockDensity:1, rockStyle:'boulder',
    tuft:'#5d8440', tuftCount:170,
    wildlife:['rabbit','squirrel','deer']
  },
  forest:{
    id:'forest', mountain:['#4a6470','#3d545f','#587483'], mountainStyle:'peaks', em:'🌲', label:'Deep forest',
    sky:'#9fbfae', fogNear:34, fogFar:190,
    hemiSky:0xdaf0e0, hemiGround:0x2f4a2c, hemiInt:0.55, sunInt:0.62,
    grass:['#3f5a35','#48663c','#37502f','#52713f'], dust:'rgba(90,70,40,.22)',
    tread:'#7a5735', shoulder:'#54391f', inner:'#8d6741', blaze:'#e8dcbf',
    trees:[['pine',0.72],['blob',0.18],['juniper',0.1]], treeDensity:2.4, treeScale:1.5,
    rocks:['#6f7361','#7d8270'], rockDensity:1.4, rockStyle:'mossy',
    tuft:'#4a6b39', tuftCount:260,
    wildlife:['rabbit','squirrel','deer','bear']
  },
  redrock:{
    id:'redrock', mountain:['#773c2b','#693326','#854834'], mountainStyle:'mesas', em:'🏜️', label:'Red rock',
    sky:'#8fd0e6', fogNear:110, fogFar:460,
    // toned down: the old palette + high light intensity blew out to neon orange
    hemiSky:0xf7e6c8, hemiGround:0x8a5c40, hemiInt:0.58, sunInt:0.78,
    grass:['#915d3e','#854f34','#996847','#7c4a30'], dust:'rgba(90,50,32,.13)',
    tread:'#c9a071', shoulder:'#5c3a20', inner:'#d8bd8c', blaze:'#f6e6c8',
    trees:[['juniper',0.62],['pine',0.14],['blob',0.24]], treeDensity:0.5, treeScale:0.85,
    rocks:['#853828','#8f4730','#773226','#945439'], rockDensity:2.2, rockStyle:'fin',
    tuft:'#7c8c4e', tuftCount:90,
    wildlife:['rabbit','bighorn','goat']
  }
};
let THEME=THEMES.meadow;

export { THEMES, THEME, setTheme };
function setTheme(t){ THEME = t; }
