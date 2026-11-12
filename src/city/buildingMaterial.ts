// Buildings in daylight: pale Lisbon facades with rows of windows and
// terracotta roofs, all drawn procedurally (no textures).
import { Color, ShaderMaterial } from "three";
import { shared } from "./environment";

const vertexShader = /* glsl */ `
attribute vec4 wall;
attribute float seed;

varying vec4 vWall;
varying float vSeed;
varying float vRoof;
varying float vSun;

// Afternoon sun from the south-west.
const vec3 SUN = vec3(-0.55, 0.62, 0.56);

void main() {
  vWall = wall;
  vSeed = seed;
  vRoof = step(0.5, normal.y);
  vSun = dot(normalize(normal), SUN);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uWalls[5];
uniform vec3 uRoofA;
uniform vec3 uRoofB;
uniform vec3 uRoofFlat;
uniform vec3 uGlass;
uniform vec3 uAccent;
uniform vec3 uAccentRoof;
uniform vec3 uOff;
uniform float uHover;
uniform float uPlan;

varying vec4 vWall;
varying float vSeed;
varying float vRoof;
varying float vSun;

const float FLOOR_H = 3.0;
const float WINDOW_W = 2.6;

float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  // Featured buildings carry 1 + their index in the integer part of the seed,
  // plus 100 when their lights are off.
  float tag = floor(vSeed);
  float off = step(99.5, tag);
  tag -= 100.0 * off;
  float featured = step(0.5, tag);
  float hovered = featured * (1.0 - step(0.5, abs(tag - uHover)));
  float seed = fract(vSeed);
  float height = vWall.w;

  vec3 color;

  if (vRoof > 0.5) {
    // Terracotta tiles; tall or modern buildings get a flat grey roof.
    float pick = hash(vec3(seed * 71.3, 1.7, 4.1));
    vec3 tiles = mix(uRoofA, uRoofB, pick);
    float flatRoof = max(step(34.0, height), step(pick, 0.14));
    color = mix(tiles, uRoofFlat, flatRoof);
    color = mix(color, uAccentRoof, featured * (1.0 - off));
    color = mix(color, uOff * 1.25, off);
  } else {
    float along = vWall.x;
    float up = vWall.y;
    float len = vWall.z;

    // Each building takes one of five facade colours, white and cream most often.
    float pick = hash(vec3(seed * 53.9, 9.2, 2.3));
    int which = pick < 0.36 ? 0 : pick < 0.62 ? 1 : pick < 0.78 ? 2 : pick < 0.9 ? 3 : 4;
    vec3 facade = uWalls[which];
    facade = mix(facade, uAccent, featured * (1.0 - off));
    facade = mix(facade, uOff, off);

    // Sunlit and shaded sides, a darker band where the wall meets the street.
    float light = mix(0.7, 1.0, smoothstep(-0.2, 0.6, vSun));
    light *= mix(0.86, 1.0, smoothstep(0.0, 5.0, up));
    color = facade * light;

    float floors = floor(height / FLOOR_H);
    float columns = floor(len / WINDOW_W);
    if (floors >= 1.0 && columns >= 1.0) {
      vec2 cell = vec2(along / len * columns, up / FLOOR_H);
      vec2 id = floor(cell);
      vec2 f = fract(cell);

      vec2 fw = fwidth(cell);
      vec2 edge = smoothstep(vec2(0.26, 0.26) - fw, vec2(0.26, 0.26) + fw, f)
                * (1.0 - smoothstep(vec2(0.74, 0.80) - fw, vec2(0.74, 0.80) + fw, f));
      float mask = edge.x * edge.y * step(id.y, floors - 0.5);

      // Far away a window is smaller than a pixel: fade to the average tone
      // of the wall instead of shimmering.
      float size = max(fw.x, fw.y);
      float coverage = 0.48 * 0.54;
      float window = mix(mask, coverage * step(up, floors * FLOOR_H), smoothstep(0.25, 0.9, size));
      color = mix(color, uGlass * light, window * mix(0.78, 0.3, off));
    }
  }

  color *= 1.0 + 0.12 * hovered;
  // The Plan layer washes the city out so the drawing on top can be read.
  float grey = dot(color, vec3(0.3, 0.6, 0.1));
  color = mix(color, mix(vec3(grey), vec3(0.93), 0.45), uPlan * 0.75 * (1.0 - featured));

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

export function createBuildingMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      ...shared,
      uWalls: {
        value: [
          new Color("#f3eee4"), // white
          new Color("#ecdfc4"), // cream
          new Color("#efd491"), // yellow
          new Color("#e9c3b2"), // pink
          new Color("#d3dbe2"), // blue-grey
        ],
      },
      uRoofA: { value: new Color("#c4603f") },
      uRoofB: { value: new Color("#d97f5a") },
      uRoofFlat: { value: new Color("#c6c4be") },
      uGlass: { value: new Color("#56626e") },
      // Featured buildings: the yellow of Praça do Comércio.
      uAccent: { value: new Color("#f2b632") },
      uAccentRoof: { value: new Color("#a8452c") },
      // "Lights off" building.
      uOff: { value: new Color("#34363b") },
      uHover: { value: -1 },
    },
  });
}
