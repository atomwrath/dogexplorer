/* The noise ring: how far away wildlife can hear you, drawn on the ground around you.

   Sneaking already worked -- critters.js scales each animal's spook radius by a noise
   factor (barking 2.4x, sneaking 0.34x, walking 0.55x rising to ~1.7x at a sprint) -- but
   none of that was visible. You pressed sneak, something felt different, and the only
   feedback was whether an animal bolted, which arrives exactly too late to act on. The
   button was a guess with a delayed, binary answer.

   Drawing the radius turns it into a decision you can make in advance: you can SEE the
   ring pull in when you crouch and swell when you break into a run, and you can see
   whether the deer ahead is inside it before you take another step.

   It is deliberately the PLAYER's ring, not a particular animal's. Each species has its
   own spook radius and drawing all of them would be a mess of overlapping circles; what
   the player controls is the multiplier, so the ring shows that multiplier against a
   representative radius. The number on the ground is honest for a typical animal and the
   right shape for every one of them.

   Drawn as a painted BAND -- a thin annulus of triangles, both edges sampled onto the
   terrain -- and not as a line loop, which is what the first version did and why it read
   as broken or absent. Two things were wrong with the line. WebGL ignores `linewidth`, so
   a LineBasicMaterial is always exactly one pixel no matter what you ask for: at a 27 m
   radius that is a hairline drawn over busy toon-shaded terrain. And with only 64 samples
   the segments were 2.7 m long, long enough to tunnel straight through the terrace risers
   they spanned -- measured on the default map, 17% of the loop was underground at any
   moment. A one-pixel line that is also 17% missing is not an indicator.

   The draped band fixed both, and then showed its own limit: it was still GEOMETRY laid
   on a terraced heightfield. Wherever the circle crossed a riser, the inner edge sampled
   one terrace and the outer edge the next, and the two triangles between them twisted
   into a spike -- the jagged saw-teeth round every hillside. Finer sampling cannot fix
   that; a vertical step is a step at any resolution.

   So the ring is no longer geometry at all. It is PROJECTED, like a decal: every ground
   material (terrain, path ribbons, junction fills, lots, crossings, decks) is patched by
   patchGroundRing() to work out its own horizontal distance from the ring's centre in the
   fragment shader and paint the band where that distance matches the radius. The band
   lies on exactly whatever surface is there -- tread, riser, kerb, lot -- with no draping,
   no lift, no depth bias to fight, and an edge antialiased to the pixel at any radius.
   Things that are not ground (the pup, critters, trees, signs) are never patched, so the
   ring passes under them instead of being painted up their sides.

   Updating it is four uniforms per ring per frame. */
import { clamp, lerp } from '../core/math.js';

/* Colour by how loud you are, because that is the thing being communicated. Green when
   you are quiet enough to approach, amber at a walk, red when you are broadcasting. */
const QUIET = 0x4f9d4f, WALK = 0xd8922e, LOUD = 0xc4442e;
/* The catch ring has exactly one colour now that it only exists while armed -- see
   updateCatchRing. */
const REACH_ARMED = 0x7bc47f;

/* One shared uniform set, referenced (not copied) by every patched material's shader, so
   a single write here moves the ring on every surface at once. vec4s as plain arrays:
   three's uniform setter takes either, and arrays need nothing from THREE, which keeps
   this module loadable before the renderer exists and inside the smoke harness.
     uRingN     centre x, centre z, radius, half-width   (radius 0 = not drawn)
     uRingNCol  r, g, b (linear, like every material colour), opacity */
const RING_UNIFORMS = {
  uRing0: {value: [0, 0, 0, 0]}, uRing0Col: {value: [0, 0, 0, 0]},
  uRing1: {value: [0, 0, 0, 0]}, uRing1Col: {value: [0, 0, 0, 0]},
};

/* The whole technique, in two snippets. The band's coverage is 1 inside |d - R| < half
   and falls to 0 over one pixel's worth of d either side, measured with fwidth so the
   edge is exactly one pixel soft whether the ring is at your feet or across the valley.
   fwidth needs derivatives: native in WebGL2, an extension in WebGL1 -- where it is
   missing, a fixed 5 cm soft edge stands in. */
const RING_VERT_DECL = 'varying vec3 vRingW;\n';
const RING_VERT_BODY = '\n  vRingW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n';
const RING_FRAG_DECL = `
uniform vec4 uRing0; uniform vec4 uRing0Col;
uniform vec4 uRing1; uniform vec4 uRing1Col;
varying vec3 vRingW;
float groundRingBand(vec4 R){
  if(R.z <= 0.0) return 0.0;
  float d = abs(length(vRingW.xz - R.xy) - R.z);
#if __VERSION__ >= 300 || defined(GL_OES_standard_derivatives)
  float aa = max(fwidth(d), 1e-4);
#else
  float aa = 0.05;
#endif
  return 1.0 - smoothstep(R.w - aa, R.w + aa, d);
}
`;
const RING_FRAG_BODY = `
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uRing0Col.rgb, uRing0Col.a * groundRingBand(uRing0));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uRing1Col.rgb, uRing1Col.a * groundRingBand(uRing1));
`;

/* Teach one material to show the rings. Idempotent (shared materials are handed to this
   from every ribbon that uses them), chains any onBeforeCompile already there, and keys
   the program cache so a patched material never reuses an unpatched program. Injected
   after <project_vertex> -- `transformed` is the final local position by then -- and
   before <tonemapping_fragment>, so the ring is mixed in the same linear space as the
   lit colour and then encoded with it. Returns the material, for inline use. */
function patchGroundRing(mat){
  if(!mat || (mat.userData && mat.userData.groundRing)) return mat;
  mat.userData = mat.userData || {};
  mat.userData.groundRing = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function(sh, renderer){
    if(typeof prev === 'function') prev.call(this, sh, renderer);
    Object.assign(sh.uniforms, RING_UNIFORMS);
    sh.vertexShader = RING_VERT_DECL + sh.vertexShader.replace(
      '#include <project_vertex>', '#include <project_vertex>' + RING_VERT_BODY);
    sh.fragmentShader = RING_FRAG_DECL + sh.fragmentShader.replace(
      '#include <tonemapping_fragment>', RING_FRAG_BODY + '#include <tonemapping_fragment>');
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function(){
    return 'groundRing|' + (typeof prevKey === 'function' ? prevKey.call(this) : '');
  };
  mat.needsUpdate = true;
  return mat;
}

/* The ring's state as the player sees it, kept for the HUD code and the harness: where
   it is centred, how big, and whether it is up. The uniforms are the rendering; these
   are the record of what was asked for. */
function ringState(){ return {visible:false, x:0, z:0, radius:0, half:0, color:0, opacity:0}; }
const noise = ringState(), reach = ringState();
let shownR = 0;             // eased radius, so state changes glide rather than snap

function hexToLinear(hex){
  const f = c => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c + 0.055)/1.055, 2.4); };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}
function pushRing(st, U, UC){
  if(!st.visible){ U.value[2] = 0; UC.value[3] = 0; return; }
  U.value[0] = st.x; U.value[1] = st.z; U.value[2] = st.radius; U.value[3] = st.half;
  const c = hexToLinear(st.color);
  UC.value[0] = c[0]; UC.value[1] = c[1]; UC.value[2] = c[2]; UC.value[3] = st.opacity;
}

/* noise:  critters.js's own multiplier for the current state (see updateCritters)
   baseR:  a representative spook radius for this map's wildlife
   groundAt is still accepted, for the callers, and no longer needed: a projected ring
   takes its height from whatever surface it lands on. */
function updateNoiseRing(dt, px, pz, noiseMul, baseR, groundAt, visible){
  noise.visible = !!visible;
  if(visible){
    const target = clamp(baseR*noiseMul, 1.5, 400);
    // ease, but converge fast enough that crouching feels like a response, not a delay
    shownR = shownR > 0 ? lerp(shownR, target, 1-Math.pow(0.004, dt)) : target;
    // band width grows with the circle so it stays readable at any radius, with a floor so
    // a tight sneaking ring does not thin away to nothing
    noise.half = clamp(shownR*0.045, 0.30, 1.6)*0.5;
    noise.x = px; noise.z = pz; noise.radius = shownR;
    // colour tracks the multiplier, not the absolute radius, so it means the same thing
    // on a map full of jumpy deer as on one full of bold bears
    noise.color = noiseMul <= 0.4 ? QUIET : (noiseMul >= 1.2 ? LOUD : WALK);
    noise.opacity = noiseMul <= 0.4 ? 0.7 : 0.55;
  }
  pushRing(noise, RING_UNIFORMS.uRing0, RING_UNIFORMS.uRing0Col);
}

/* The catch ring: how far you can reach, drawn the same way the noise ring is so the two
   can be read against each other at a glance.

   CENTRED ON THE ANIMAL, NOT THE PLAYER, and shown only when there is one worth showing.
   Drawn continuously round the pup it read as clutter ("a static blue ring that seems
   unnecessary"); stapled to the player it asked whether a moving animal had entered a
   circle attached to yourself. Round the animal it asks the real question: get inside
   this and it is yours. The centre is passed in; main.js decides whose ring it is, from
   critters.js's own search, so the ring and the catching rule cannot drift apart.

   `armed` means the player is inside it right now: dim while closing in, solid once the
   jump would work. Visibility is the caller's `visible` -- is there a target at all. */
function updateCatchRing(dt, px, pz, radius, groundAt, visible, armed){
  reach.visible = !!visible;
  if(visible){
    reach.x = px; reach.z = pz;
    reach.radius = clamp(radius, 0.5, 60);
    // a hair thinner than the noise band, so where they cross it is obvious which is which
    reach.half = 0.16;
    reach.color = REACH_ARMED;
    reach.opacity = armed ? 0.85 : 0.35;
  }
  pushRing(reach, RING_UNIFORMS.uRing1, RING_UNIFORMS.uRing1Col);
}

function setNoiseRingVisible(v){ noise.visible = !!v; pushRing(noise, RING_UNIFORMS.uRing0, RING_UNIFORMS.uRing0Col); }
function setCatchRingVisible(v){ reach.visible = !!v; pushRing(reach, RING_UNIFORMS.uRing1, RING_UNIFORMS.uRing1Col); }
function getNoiseRing(){ return noise; }
function getCatchRing(){ return reach; }
function noiseRingRadius(){ return shownR; }
/* TEST SEAM: the live uniform set, and the snippets, so the harness can check that what a
   patched shader reads is what the update functions wrote. */
function groundRingUniforms(){ return RING_UNIFORMS; }
function groundRingSource(){ return {vertDecl:RING_VERT_DECL, vertBody:RING_VERT_BODY, fragDecl:RING_FRAG_DECL, fragBody:RING_FRAG_BODY}; }

export { updateNoiseRing, setNoiseRingVisible, getNoiseRing, noiseRingRadius,
         updateCatchRing, setCatchRingVisible, getCatchRing,
         patchGroundRing, groundRingUniforms, groundRingSource };
