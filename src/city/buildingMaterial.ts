// Buildings at night: dark facades washed with sodium light near the street,
// and warm windows drawn procedurally (no textures).
import { Color, ShaderMaterial } from "three";

export const FOG_COLOR = new Color("#07080b");
export const FOG_DENSITY = 0.00011;

const vertexShader = /* glsl */ `
attribute vec4 wall;
attribute float seed;

varying vec4 vWall;
varying float vSeed;
varying float vRoof;
varying float vDepth;

void main() {
  vWall = wall;
  vSeed = seed;
  vRoof = step(0.5, normal.y);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uFacade;
uniform vec3 uRoof;
uniform vec3 uSodium;
uniform vec3 uWindowA;
uniform vec3 uWindowB;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uHover;

varying vec4 vWall;
varying float vSeed;
varying float vRoof;
varying float vDepth;

const float FLOOR_H = 3.0;
const float WINDOW_W = 2.6;

float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 color;
  // Featured buildings carry 1 + their index in the integer part of the seed.
  float tag = floor(vSeed);
  float featured = step(0.5, tag);
  float hovered = featured * (1.0 - step(0.5, abs(tag - uHover)));
  float seed = fract(vSeed);

  if (vRoof > 0.5) {
    color = uRoof + uSodium * 0.05 * hovered;
  } else {
    float along = vWall.x;
    float up = vWall.y;
    float len = vWall.z;
    float height = vWall.w;

    // Street lamps light the lowest floors.
    color = uFacade + uSodium * 0.16 * exp(-up / 7.0);

    float floors = floor(height / FLOOR_H);
    float columns = floor(len / WINDOW_W);
    if (floors >= 1.0 && columns >= 1.0) {
      vec2 cell = vec2(along / len * columns, up / FLOOR_H);
      vec2 id = floor(cell);
      vec2 f = fract(cell);

      // Each building has its own share of lit windows.
      float share = mix(0.06, 0.42, hash(vec3(seed * 91.7, 3.1, 7.7)));
      share = mix(share, 0.92, featured);
      float wallId = floor(len * 37.0);
      float r = hash(vec3(id.x + wallId, id.y, seed * 517.3));
      float lit = step(r, share) * step(id.y, floors - 0.5);

      vec2 fw = fwidth(cell);
      vec2 edge = smoothstep(vec2(0.22, 0.28) - fw, vec2(0.22, 0.28) + fw, f)
                * (1.0 - smoothstep(vec2(0.78, 0.80) - fw, vec2(0.78, 0.80) + fw, f));
      float mask = edge.x * edge.y;

      float tone = hash(vec3(id.y, id.x + wallId, seed * 211.9));
      vec3 glow = mix(uWindowA, uWindowB, tone) * mix(1.2, 3.2, tone * tone);
      glow *= 1.0 + 0.5 * featured + 0.6 * hovered;

      // Far away a window is smaller than a pixel. First drop the window
      // outline and light the whole cell at the window's share of its area,
      // then, further still, fade to the average of the wall. Both keep the
      // total light constant, so nothing flickers as the camera moves.
      float size = max(fw.x, fw.y);
      float coverage = 0.56 * 0.52;
      float shape = mix(mask, coverage, smoothstep(0.2, 0.6, size));
      vec3 near = glow * lit * shape;
      vec3 average = mix(uWindowA, uWindowB, 0.5) * 1.9 * share * coverage * step(up, floors * FLOOR_H);
      color += mix(near, average, smoothstep(0.7, 1.6, size));
    }
  }

  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  gl_FragColor = vec4(mix(color, uFogColor, fog), 1.0);
}
`;

export function createBuildingMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uFacade: { value: new Color("#08080a") },
      uRoof: { value: new Color("#0e0d0e") },
      uSodium: { value: new Color("#ffb15c") },
      uWindowA: { value: new Color("#ffc46b") },
      uWindowB: { value: new Color("#ffe2a6") },
      uFogColor: { value: FOG_COLOR },
      uFogDensity: { value: FOG_DENSITY },
      uHover: { value: -1 },
    },
  });
}
