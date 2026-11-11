// Street lighting: every street is a flat ribbon of sodium light on the
// ground, with pools of light where the lamps would be.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  MaxEquation,
  OneFactor,
  ShaderMaterial,
} from "three";
import { FOG_DENSITY } from "./buildingMaterial";
import type { Manifest } from "./loadCity";

/** Half width of the lit ribbon per road class, in metres (wider than the carriageway: light spills). */
const HALF_WIDTH = [11, 8, 6];
const GROUND_Y = 0.5;

export async function loadRoads(manifest: Manifest): Promise<BufferGeometry> {
  const res = await fetch(`/data/${manifest.roads.file}`);
  if (!res.ok) throw new Error(`${manifest.roads.file}: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x3152584c) throw new Error("roads: not an LXR1 file");
  const nLines = view.getUint32(4, true);
  const nVerts = view.getUint32(8, true);
  const vertCounts = new Uint16Array(buffer, 12, nLines);
  const deltas = new Int16Array(buffer, 12 + nLines * 2, nVerts * 2);
  const classes = new Uint8Array(buffer, 12 + nLines * 2 + nVerts * 4, nLines);
  const units = manifest.roads.unitsPerMetre;

  const nSegments = nVerts - nLines;
  const position = new Float32Array(nSegments * 4 * 3);
  // x: metres along the street, y: -1..1 across it, z: class
  const road = new Float32Array(nSegments * 4 * 3);
  const index = new Uint32Array(nSegments * 6);

  let v = 0;
  let q = 0;
  let ix = 0;
  for (let l = 0; l < nLines; l++) {
    const cls = classes[l];
    const half = HALF_WIDTH[cls];
    let x = 0;
    let y = 0;
    let px = 0;
    let py = 0;
    let along = 0;
    for (let i = 0; i < vertCounts[l]; i++, v++) {
      x += deltas[v * 2] / units;
      y += deltas[v * 2 + 1] / units;
      if (i > 0) {
        const dx = x - px;
        const dy = y - py;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        // Overlap neighbouring segments a little so bends have no gaps;
        // the material blends with "max", so overlaps do not get brighter.
        const ext = half * 0.5;
        for (let k = 0; k < 4; k++) {
          const end = k === 1 || k === 2;
          const side = k >= 2 ? 1 : -1;
          const bx = (end ? x + ux * ext : px - ux * ext) - uy * half * side;
          const by = (end ? y + uy * ext : py - uy * ext) + ux * half * side;
          position[q * 3] = bx;
          position[q * 3 + 1] = GROUND_Y;
          position[q * 3 + 2] = -by;
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
      px = x;
      py = y;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("road", new BufferAttribute(road, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

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

const fragmentShader = /* glsl */ `
uniform vec3 uSodium;
uniform float uFogDensity;
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
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  gl_FragColor = vec4(uSodium * level * across * pools * (1.0 - fog), 1.0);
}
`;

export function createRoadMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uSodium: { value: new Color("#ffb15c") },
      uFogDensity: { value: FOG_DENSITY },
    },
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: MaxEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
  });
}
