// Flat ribbons along lines: the street lighting, the bridge deck with its
// traffic, and the railway lines of the Plan layer.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  MaxEquation,
  OneFactor,
  ShaderMaterial,
} from "three";
import { shared } from "./environment";

/** A polyline in map metres (x east, y north) with a class number. */
export interface Polyline {
  points: ArrayLike<number>; // x0, y0, x1, y1, ...
  cls: number;
}

/** Decodes an LXR1 file (layout in scripts/02_process.py). */
export async function loadLines(file: string, unitsPerMetre: number): Promise<Polyline[]> {
  const res = await fetch(`/data/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x3152584c) throw new Error(`${file}: not an LXR1 file`);
  const nLines = view.getUint32(4, true);
  const nVerts = view.getUint32(8, true);
  const vertCounts = new Uint16Array(buffer, 12, nLines);
  const deltas = new Int16Array(buffer, 12 + nLines * 2, nVerts * 2);
  const classes = new Uint8Array(buffer, 12 + nLines * 2 + nVerts * 4, nLines);

  const lines: Polyline[] = [];
  let v = 0;
  for (let l = 0; l < nLines; l++) {
    const points = new Float32Array(vertCounts[l] * 2);
    let x = 0;
    let y = 0;
    for (let i = 0; i < vertCounts[l]; i++, v++) {
      x += deltas[v * 2] / unitsPerMetre;
      y += deltas[v * 2 + 1] / unitsPerMetre;
      points[i * 2] = x;
      points[i * 2 + 1] = y;
    }
    lines.push({ points, cls: classes[l] });
  }
  return lines;
}

/**
 * One quad per segment, lying flat at `height`. Vertex attribute `road`:
 * x = metres along the line, y = -1..1 across it, z = class.
 */
export function buildRibbons(lines: Polyline[], halfWidths: number[], height: number): BufferGeometry {
  let nSegments = 0;
  for (const line of lines) nSegments += line.points.length / 2 - 1;
  const position = new Float32Array(nSegments * 4 * 3);
  const road = new Float32Array(nSegments * 4 * 3);
  const index = new Uint32Array(nSegments * 6);

  let q = 0;
  let ix = 0;
  for (const { points, cls } of lines) {
    const half = halfWidths[cls] ?? halfWidths[halfWidths.length - 1];
    let along = 0;
    for (let i = 1; i < points.length / 2; i++) {
      const px = points[i * 2 - 2];
      const py = points[i * 2 - 1];
      const x = points[i * 2];
      const y = points[i * 2 + 1];
      const len = Math.hypot(x - px, y - py) || 1;
      const ux = (x - px) / len;
      const uy = (y - py) / len;
      // Overlap neighbouring segments a little so bends have no gaps.
      const ext = half * 0.5;
      for (let k = 0; k < 4; k++) {
        const end = k === 1 || k === 2;
        const side = k >= 2 ? 1 : -1;
        position[q * 3] = (end ? x + ux * ext : px - ux * ext) - uy * half * side;
        position[q * 3 + 1] = height;
        position[q * 3 + 2] = -((end ? y + uy * ext : py - uy * ext) + ux * half * side);
        road[q * 3] = end ? along + len + ext : along - ext;
        road[q * 3 + 1] = side;
        road[q * 3 + 2] = cls;
        q++;
      }
      index[ix++] = q - 4;
      index[ix++] = q - 3;
      index[ix++] = q - 2;
      index[ix++] = q - 4;
      index[ix++] = q - 2;
      index[ix++] = q - 1;
      along += len;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("road", new BufferAttribute(road, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Half width of the lit ribbon per road class, in metres (wider than the carriageway: light spills). */
export const STREET_HALF_WIDTH = [11, 8, 6];

const vertexShader = /* glsl */ `
attribute vec3 road;
varying vec3 vRoad;
varying float vDepth;

void main() {
  vRoad = road;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FOG = /* glsl */ `
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
`;

// Overlapping ribbons must not add up; "max" blending keeps the brighter one.
const MAX_BLENDING = {
  transparent: true,
  depthWrite: false,
  blending: CustomBlending,
  blendEquation: MaxEquation,
  blendSrc: OneFactor,
  blendDst: OneFactor,
} as const;

/** Sodium street lighting, with pools of light where the lamps would be. */
export function createStreetMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader: /* glsl */ `
uniform vec3 uSodium;
uniform float uFogDensity;
uniform float uNight;
uniform float uPlan;
varying vec3 vRoad;
varying float vDepth;

const float LAMP_SPACING = 32.0;

void main() {
  float across = 1.0 - vRoad.y * vRoad.y;
  across *= sqrt(across);

  // Pools of light under each lamp; averaged out when too small to see.
  float lamp = 0.5 + 0.5 * cos(6.2832 * vRoad.x / LAMP_SPACING);
  float pools = mix(0.3, 1.0, lamp * lamp);
  float blur = smoothstep(0.04, 0.2, fwidth(vRoad.x) / LAMP_SPACING);
  pools = mix(pools, 0.56, blur);

  float level = vRoad.z < 0.5 ? 0.6 : (vRoad.z < 1.5 ? 0.44 : 0.3);
  // In the Plan layer only the main roads stay bright.
  level *= mix(1.0, vRoad.z < 0.5 ? 1.0 : 0.35, uPlan);
  ${FOG}
  gl_FragColor = vec4(uSodium * level * across * pools * (1.0 - fog) * uNight, 1.0);
}
`,
    uniforms: { ...shared, uSodium: { value: new Color("#ffb15c") } },
    ...MAX_BLENDING,
  });
}

/** Bridge deck: a dark road with light trails moving along it. */
export function createTrafficMaterial(color: string): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader: /* glsl */ `
uniform vec3 uLights;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uNight;
uniform float uTime;
varying vec3 vRoad;
varying float vDepth;

const float SPACING = 46.0;
const float SPEED = 19.0; // m/s, about 70 km/h

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

void main() {
  // Three lanes; in each, cars at random gaps, each one a short trail of light.
  float lane = floor((vRoad.y * 0.5 + 0.5) * 3.0);
  float inLane = abs(fract((vRoad.y * 0.5 + 0.5) * 3.0) - 0.5);
  float speed = SPEED * (1.0 + 0.12 * (lane - 1.0));
  float s = (vRoad.x - uTime * speed) / SPACING + lane * 0.37;
  float car = step(hash(vec2(floor(s), lane)), 0.55);
  float trail = pow(fract(s), 6.0);
  float light = car * trail * smoothstep(0.42, 0.12, inLane);

  vec3 deck = mix(vec3(0.20, 0.20, 0.21), vec3(0.015, 0.013, 0.012), uNight);
  vec3 color = deck + uLights * light * mix(0.5, 2.6, uNight);
  ${FOG}
  gl_FragColor = vec4(mix(color, uFogColor, fog), 1.0);
}
`,
    uniforms: { ...shared, uLights: { value: new Color(color) } },
  });
}

/** Railway lines of the Plan layer: 0 rail, 1 underground rail, 2 metro, 3 tram. */
export function createPlanLineMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader: /* glsl */ `
uniform float uFogDensity;
varying vec3 vRoad;
varying float vDepth;

void main() {
  float across = smoothstep(1.0, 0.55, abs(vRoad.y));
  // Underground lines are dashed.
  float underground = step(0.5, vRoad.z) * step(vRoad.z, 2.5);
  float dash = mix(1.0, step(0.5, fract(vRoad.x / 60.0)), underground);
  vec3 tint = vRoad.z > 2.5 ? vec3(0.95, 0.72, 0.26) : vec3(0.91, 0.87, 0.80);
  float level = vRoad.z > 2.5 ? 0.5 : 0.75;
  ${FOG}
  gl_FragColor = vec4(tint * level * across * dash * (1.0 - fog), 1.0);
}
`,
    uniforms: { ...shared },
    ...MAX_BLENDING,
  });
}

/** The Tejo: almost black, faint warm glints, a light mist with distance. */
export function createRiverMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
varying vec3 vWorld;
varying float vDepth;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`,
    fragmentShader: /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uNight;
uniform float uTime;
varying vec3 vWorld;
varying float vDepth;

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
  // Slow ripples, stretched east-west like a river surface seen from above.
  vec2 p = vWorld.xz * vec2(0.02, 0.07);
  float ripples = noise(p + vec2(uTime * 0.05, uTime * 0.02)) * noise(p * 2.3 - vec2(uTime * 0.03, 0.0));
  float glint = smoothstep(0.45, 0.8, ripples);

  vec3 night = vec3(0.004, 0.006, 0.009) + vec3(1.0, 0.69, 0.36) * 0.014 * glint;
  vec3 day = vec3(0.16, 0.24, 0.28) + 0.02 * glint;
  vec3 color = mix(day, night, uNight);

  // Mist: the river fades sooner than the land, to a slightly lifted grey.
  float d = uFogDensity * 1.9;
  float fog = 1.0 - exp(-d * d * vDepth * vDepth);
  vec3 mist = uFogColor + vec3(0.018, 0.019, 0.022) * uNight;
  gl_FragColor = vec4(mix(color, mist, fog), 1.0);
}
`,
    uniforms: { ...shared },
  });
}
