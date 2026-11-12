// Buildings as an architect's model: cream and white facades, soft terracotta
// roofs, quiet windows, all drawn procedurally (no textures). Only Salvador's
// buildings are in colour, all in the same accent, with a darker outline.
import { Color, ShaderMaterial } from "three";
import { shared } from "./environment";

/** How many featured buildings can have a colour of their own. */
export const ACCENT_SLOTS = 16;

const vertexShader = /* glsl */ `
attribute vec4 wall;
attribute float seed;

varying vec4 vWall;
varying float vSeed;
varying float vRoof;
varying float vSun;

// Afternoon sun from the west-south-west: from the camera it lights the walls
// facing south and leaves the ones facing east, and the streets beside them, in shade.
const vec3 SUN = vec3(-0.72, 0.6, 0.34);

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
uniform vec3 uRoofC;
uniform vec3 uRoofFlat;
uniform vec3 uGlass;
uniform vec3 uAccents[16];
uniform vec3 uOff;
uniform float uHover;

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
  vec3 accent = uAccents[int(clamp(tag - 1.0, 0.0, 15.0))];
  float lit = featured * (1.0 - off);

  vec3 color;

  if (vRoof > 0.5) {
    // Terracotta tiles; tall or modern buildings get a flat grey roof.
    float pick = hash(vec3(seed * 71.3, 1.7, 4.1));
    // No two neighbours share a tone: a blend of two terracottas, some roofs
    // older and browner, each a little lighter or darker.
    vec3 tiles = mix(uRoofA, uRoofB, pick);
    tiles = mix(tiles, uRoofC, step(hash(vec3(seed * 19.7, 6.3, 8.9)), 0.22));
    tiles *= mix(0.84, 1.12, hash(vec3(seed * 37.1, 2.9, 5.3)));
    // The geometry says which roofs are flat and grey (tall or modern buildings).
    float flatRoof = step(0.5, vWall.x);
    color = mix(tiles, uRoofFlat, flatRoof);
    // Roofs are the brightest surfaces; each face of a pitched roof catches the sun differently.
    color *= 0.84 + 0.34 * clamp(vSun, 0.0, 1.0);
    color = mix(color, accent * 0.82, lit);
    color = mix(color, uOff * 1.25, off);
  } else {
    float along = vWall.x;
    float up = vWall.y;
    float len = vWall.z;

    // Each building takes one of five facade colours, white and cream most often.
    float pick = hash(vec3(seed * 53.9, 9.2, 2.3));
    int which = pick < 0.44 ? 0 : pick < 0.76 ? 1 : pick < 0.86 ? 2 : pick < 0.94 ? 3 : 4;
    vec3 facade = uWalls[which];
    // No two buildings quite the same: a little lighter or darker, a little warmer or cooler.
    float shade = hash(vec3(seed * 17.3, 3.1, 7.7)) - 0.5;
    float warmth = hash(vec3(seed * 41.9, 5.3, 1.1)) - 0.5;
    facade *= (1.0 + 0.07 * shade) * (vec3(1.0) + warmth * vec3(0.035, 0.0, -0.045));
    facade = mix(facade, accent, lit);
    facade = mix(facade, uOff, off);

    // Sunlit and shaded sides, a darker band where the wall meets the street.
    // Walls in the sun are warm, walls in the shade cooler and darker; the foot of
    // every wall is darker still, where the street blocks the light from the sky.
    float sunny = smoothstep(-0.25, 0.45, vSun);
    float light = mix(0.6, 1.0, sunny);
    light *= mix(0.66, 1.0, smoothstep(0.0, 7.0, up));
    color = facade * light * mix(vec3(0.94, 0.97, 1.04), vec3(1.03, 1.0, 0.95), sunny);

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
      color = mix(color, uGlass * light, window * mix(mix(0.5, 0.42, lit), 0.3, off));

      // Close up: shop fronts and doors on the ground floor, balconies on some
      // buildings, and a cornice under the roof. All fade out with distance.
      float detail = 1.0 - smoothstep(0.12, 0.45, size);
      float ground = 1.0 - step(0.5, id.y);
      float shop = step(0.12, f.x) * step(f.x, 0.88) * step(f.y, 0.8) * ground;
      color = mix(color, uGlass * light * 0.8, shop * detail * (1.0 - off) * 0.85);
      float railing = step(hash(vec3(seed * 29.3, 4.4, 1.9)), 0.4) * (1.0 - ground) * step(id.y, floors - 0.5);
      float balcony = step(0.12, f.x) * step(f.x, 0.88) * step(0.17, f.y) * step(f.y, 0.25);
      color = mix(color, vec3(0.2, 0.22, 0.25) * light, balcony * railing * detail * 0.8);
    }
    // Outline of a featured building: its corners and the top of its walls,
    // at least a pixel and a half wide at any zoom.
    {
      float w = max(0.8, 1.5 * max(fwidth(along), fwidth(up)));
      float rim = max(max(1.0 - step(w, along), step(len - w, along)), step(height - w, up));
      color = mix(color, accent * 0.5, rim * lit);
    }
    {
      float fine = 1.0 - smoothstep(0.03, 0.12, fwidth(up));
      float cornice = step(height - 0.55, up);
      float underline = step(height - 0.85, up) * (1.0 - cornice);
      color *= 1.0 + 0.1 * cornice * fine - 0.18 * underline * fine;
    }
  }

  color *= 1.0 + 0.12 * hovered;

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
          new Color("#f5f2ec"), // white
          new Color("#efe9dd"), // cream
          new Color("#ebe3d2"), // warm cream
          new Color("#ede5df"), // pale pink
          new Color("#e6e6e2"), // pale grey
        ],
      },
      uRoofA: { value: new Color("#c99c86") },
      uRoofB: { value: new Color("#d6b19c") },
      uRoofC: { value: new Color("#b08e7e") },
      uRoofFlat: { value: new Color("#d6d3cc") },
      uGlass: { value: new Color("#8d949a") },
      // Colour of each featured building, by its index (all the same accent, see City.tsx).
      uAccents: { value: Array.from({ length: ACCENT_SLOTS }, () => new Color("#e8833a")) },
      // "Lights off" building.
      uOff: { value: new Color("#3d3f44") },
      uHover: { value: -1 },
    },
  });
}
