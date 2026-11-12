// Materials for everything that lies flat: streets, the bridge deck, the
// lines of the Plan layer and the river. All use the `road` attribute made
// by buildRibbons (x = metres along, y = -1..1 across, z = class), except the river.
import { Color, DoubleSide, KeepStencilOp, MeshBasicMaterial, NotEqualStencilFunc, ReplaceStencilOp, ShaderMaterial } from "three";
import { shared } from "./environment";

/** Half width of the carriageway per road class, in metres. */
export const STREET_HALF_WIDTH = [6.5, 5, 3.5];

const ribbonVertex = /* glsl */ `
attribute vec3 road;
varying vec3 vRoad;

void main() {
  vRoad = road;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Grey asphalt, with a dashed centre line on the main roads. */
export function createStreetMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: ribbonVertex,
    fragmentShader: /* glsl */ `
uniform vec3 uAsphalt;
uniform vec3 uPaint;
uniform float uPlan;
varying vec3 vRoad;

void main() {
  vec3 color = uAsphalt;
  float dashes = step(0.5, fract(vRoad.x / 14.0)) * (1.0 - smoothstep(0.03, 0.07, abs(vRoad.y)));
  float fine = smoothstep(0.5, 0.15, fwidth(vRoad.x) / 14.0);
  color = mix(color, uPaint, dashes * fine * step(vRoad.z, 0.5) * 0.8);
  color = mix(color, vec3(0.86), uPlan * 0.5);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`,
    uniforms: { ...shared, uAsphalt: { value: new Color("#bcbcbb") }, uPaint: { value: new Color("#f2efe8") } },
    // Streets overlap at every junction; not writing depth keeps them from fighting.
    depthWrite: false,
  });
}

/** Bridge deck with cars moving along it. `direction` is +1 or -1 along the line. */
export function createTrafficMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: ribbonVertex,
    fragmentShader: /* glsl */ `
uniform float uTime;
varying vec3 vRoad;

const float SPACING = 34.0;
const float SPEED = 19.0; // m/s, about 70 km/h
const float CAR_LENGTH = 5.5;

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

void main() {
  // Three lanes; in each, cars at random gaps.
  float lanes = (vRoad.y * 0.5 + 0.5) * 3.0;
  float lane = floor(lanes);
  float inLane = abs(fract(lanes) - 0.5);
  float speed = SPEED * (1.0 + 0.12 * (lane - 1.0));
  float s = (vRoad.x - uTime * speed) / SPACING + lane * 0.37;
  float id = floor(s);
  float present = step(hash(vec2(id, lane)), 0.5);
  float body = step(1.0 - CAR_LENGTH / SPACING, fract(s)) * step(inLane, 0.3);

  // Car colours: mostly white, grey and black, now and then red or blue.
  float pick = hash(vec2(id * 3.7, lane + 9.0));
  vec3 paint = pick < 0.35 ? vec3(0.93) : pick < 0.6 ? vec3(0.45, 0.47, 0.5) : pick < 0.8 ? vec3(0.1, 0.1, 0.12)
             : pick < 0.9 ? vec3(0.62, 0.1, 0.08) : vec3(0.13, 0.25, 0.5);

  vec3 deck = vec3(0.3, 0.31, 0.33);
  float marking = step(0.47, inLane) * step(0.5, fract(vRoad.x / 12.0)) * step(lanes, 2.6) * step(0.4, lanes);
  vec3 color = mix(deck, vec3(0.85), marking * 0.7);
  color = mix(color, paint, present * body);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`,
    uniforms: { ...shared },
  });
}

/** Lines of the Plan layer: 0 rail, 1 underground rail, 2 metro, 3 tram. */
export function createPlanLineMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: ribbonVertex,
    fragmentShader: /* glsl */ `
varying vec3 vRoad;

void main() {
  // Underground lines are dashed.
  float underground = step(0.5, vRoad.z) * step(vRoad.z, 2.5);
  if (underground > 0.5 && fract(vRoad.x / 60.0) < 0.42) discard;
  vec3 color = vRoad.z > 2.5 ? vec3(0.86, 0.5, 0.02) : vRoad.z > 1.5 ? vec3(0.1, 0.22, 0.55) : vec3(0.26, 0.28, 0.31);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`,
    depthWrite: false,
    depthTest: false,
  });
}

/** The Tejo: flat blue with slow, faint ripples. */
export function createRiverMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`,
    fragmentShader: /* glsl */ `
uniform vec3 uWater;
uniform float uTime;
uniform float uPlan;
varying vec3 vWorld;

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec2 p = vWorld.xz * vec2(0.012, 0.04);
  float ripples = noise(p + vec2(uTime * 0.06, uTime * 0.02)) * noise(p * 2.1 - vec2(uTime * 0.04, 0.0));
  vec3 color = uWater * (0.96 + 0.16 * smoothstep(0.3, 0.75, ripples));
  color = mix(color, vec3(0.8, 0.86, 0.9), uPlan * 0.5);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`,
    uniforms: { ...shared, uWater: { value: new Color("#4f86c4") } },
  });
}

/**
 * Shadows on the ground. They overlap a lot (every building casts one), so the
 * stencil buffer lets each pixel be darkened only once.
 */
export function createShadowMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: "#232c47",
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: DoubleSide,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: NotEqualStencilFunc,
    stencilFail: KeepStencilOp,
    stencilZFail: KeepStencilOp,
    stencilZPass: ReplaceStencilOp,
  });
}
