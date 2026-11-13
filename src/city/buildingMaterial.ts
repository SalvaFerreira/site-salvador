// Buildings as an architect's model, drawn procedurally (no textures): soft
// terracotta roofs and facades that change with the part of the city. In the
// old centre, Lisbon colours, tall narrow windows, a stone base, light stone
// corners and some tiled (azulejo) fronts; towers with bands of windows or
// glass; long low sheds in ribbed metal; elsewhere whites, creams and pastels.
// Salvador's buildings are in colour, all in the same accent, with a darker outline.
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
varying vec2 vMap;

// Afternoon sun from the west-south-west: from the camera it lights the walls
// facing south and leaves the ones facing east, and the streets beside them, in shade.
const vec3 SUN = vec3(-0.72, 0.6, 0.34);

void main() {
  vWall = wall;
  vSeed = seed;
  // Roofs face up; the steep faces of a dome or a spire are marked as roof by wall.z < 0.
  vRoof = max(step(0.5, normal.y), step(wall.z, -0.5));
  vSun = dot(normalize(normal), SUN);
  // Where in the city (metres east and north of Praça do Comércio).
  vec4 world = modelMatrix * vec4(position, 1.0);
  vMap = vec2(world.x, -world.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uWalls[7];
uniform vec3 uOldWalls[6];
uniform vec3 uTile;
uniform vec3 uStone;
uniform vec3 uRoofA;
uniform vec3 uRoofB;
uniform vec3 uRoofC;
uniform vec3 uRoofFlat;
uniform vec3 uGlass;
uniform vec3 uAccents[16];
uniform vec3 uOff;
uniform float uHover;
uniform float uNight;
uniform float uDusk;
uniform float uLit;
uniform float uTime;

varying vec4 vWall;
varying float vSeed;
varying float vRoof;
varying float vSun;
varying vec2 vMap;

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
  // Windows and shop fronts lit at night (0 to 1).
  float glow = 0.0;
  // ...of which the blue light of a television.
  float tv = 0.0;

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

    // What kind of building this is, from where it stands and its height.
    // The old centre (Baixa, Alfama, Mouraria, Bairro Alto, Madragoa) is within about 2 km.
    float historic = 1.0 - smoothstep(1700.0, 2600.0, length(vMap - vec2(-300.0, 250.0)));
    float tower = step(30.0, height);
    float style = hash(vec3(seed * 13.7, 8.1, 3.3));
    float old = step(style, historic * 0.92) * (1.0 - tower);
    float shed = step(45.0, len) * step(height, 10.5) * (1.0 - old);
    float azulejo = old * step(hash(vec3(seed * 61.1, 2.2, 7.4)), 0.17);
    float glassy = tower * step(hash(vec3(seed * 23.9, 1.4, 6.6)), 0.4);

    // Facade colour: Lisbon colours in the old centre, whites, creams and pastels elsewhere.
    float pick = hash(vec3(seed * 53.9, 9.2, 2.3));
    int which = pick < 0.34 ? 0 : pick < 0.6 ? 1 : pick < 0.7 ? 2 : pick < 0.78 ? 3 : pick < 0.85 ? 4 : pick < 0.93 ? 5 : 6;
    vec3 facade = uWalls[which];
    int oldWhich = int(min(5.0, floor(hash(vec3(seed * 7.9, 4.7, 9.1)) * 6.0)));
    facade = mix(facade, uOldWalls[oldWhich], old);
    facade = mix(facade, vec3(0.86, 0.87, 0.86), shed);
    facade = mix(facade, vec3(0.66, 0.74, 0.8), glassy);
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

    // Close-up texture of the wall, faded out with distance like the windows.
    float wallSize = max(fwidth(along), fwidth(up));
    float near = 1.0 - smoothstep(0.08, 0.3, wallSize);
    // Azulejo: small white and blue tiles with a dotted pattern; from afar, a blue-tinted wall.
    {
      vec2 t = vec2(along, up) / 0.5;
      float motif = step(0.35, abs(sin(t.x * 3.1416) * sin(t.y * 3.1416)));
      vec3 tiles = mix(vec3(0.93, 0.94, 0.95), uTile, mix(0.35, motif, near));
      color = mix(color, tiles * light, azulejo * (1.0 - lit) * (1.0 - off));
    }
    // Old buildings: a stone base on the ground floor and light stone corners.
    {
      float base = 1.0 - step(FLOOR_H * 0.85, up);
      float corner = max(1.0 - step(0.7, along), step(len - 0.7, along));
      color = mix(color, uStone * light, max(base, corner) * old * (1.0 - lit) * (1.0 - off) * 0.85);
    }
    // Sheds: ribbed metal.
    color *= 1.0 - shed * near * 0.08 * step(0.5, fract(along / 0.9));

    float floors = floor(height / FLOOR_H);
    float columns = floor(len / WINDOW_W);
    if (floors >= 1.0 && columns >= 1.0) {
      vec2 cell = vec2(along / len * columns, up / FLOOR_H);
      vec2 id = floor(cell);
      vec2 f = fract(cell);

      vec2 fw = fwidth(cell);
      // Window shape: tall and narrow in old buildings, a continuous band in towers,
      // only a strip under the roof in sheds, square-ish elsewhere.
      vec2 lo = mix(vec2(0.26, 0.26), vec2(0.33, 0.14), old);
      vec2 hi = mix(vec2(0.74, 0.80), vec2(0.67, 0.86), old);
      lo = mix(lo, vec2(0.04, 0.3), tower);
      hi = mix(hi, vec2(0.96, 0.86), tower);
      lo = mix(lo, vec2(0.1, 0.55), shed);
      hi = mix(hi, vec2(0.9, 0.8), shed);
      vec2 edge = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f));
      float onlyTop = 1.0 - shed * (1.0 - step(floors - 1.5, id.y));
      float mask = edge.x * edge.y * step(id.y, floors - 0.5) * onlyTop;

      // Far away a window is smaller than a pixel: fade to the average tone
      // of the wall instead of shimmering.
      float size = max(fw.x, fw.y);
      float coverage = 0.48 * 0.54;
      float window = mix(mask, coverage * step(up, floors * FLOOR_H), smoothstep(0.25, 0.9, size));
      color = mix(color, uGlass * light, window * mix(mix(0.5, 0.42, lit), 0.3, off));
      // At night some windows are lit, more in the evening and fewer as the night goes on:
      // each window has its own hour, so they come on and go off one by one.
      // From far away each window is less than a pixel, so the share of lit ones is used instead.
      float lamp = step(hash(vec3(id * vec2(1.7, 3.1), seed * 91.0)), uLit);
      float far = smoothstep(0.25, 0.9, size);
      glow += window * mix(lamp, uLit, far) * (1.0 - off);
      float set = step(hash(vec3(id * vec2(2.3, 1.1), seed * 37.0)), 0.16);
      float flicker = 0.7 + 0.3 * sin(uTime * (2.0 + 6.0 * hash(vec3(id, seed))) + seed * 40.0) * sin(uTime * 0.9 + id.x);
      tv += window * lamp * set * flicker * (1.0 - far) * (1.0 - off);

      // Close up: shop fronts and doors on the ground floor, balconies on some
      // buildings, and a cornice under the roof. All fade out with distance.
      float detail = 1.0 - smoothstep(0.12, 0.45, size);
      float ground = 1.0 - step(0.5, id.y);
      float shop = step(0.12, f.x) * step(f.x, 0.88) * step(f.y, 0.8) * ground;
      color = mix(color, uGlass * light * 0.8, shop * detail * (1.0 - off) * 0.85);
      // Shop fronts are lit in the evening and dark in the small hours, like the shops.
      glow += shop * detail * (1.0 - off) * 0.8 * smoothstep(0.15, 0.4, uLit);
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

  // Dusk warms the city; night turns it dark blue, except Salvador's buildings,
  // which keep their colour, and the lit windows.
  color = mix(color, color * vec3(1.1, 0.9, 0.76), uDusk * 0.55);
  vec3 dark = mix(color * vec3(0.19, 0.23, 0.36), color * 0.8, lit * 0.85);
  color = mix(color, dark, uNight);
  vec3 warm = vec3(1.0, 0.7, 0.36);
  vec3 screen = vec3(0.5, 0.66, 1.0);
  color += mix(warm, screen, clamp(tv / max(glow, 0.001), 0.0, 1.0)) * min(glow, 1.0) * uNight * 0.9;

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
          new Color("#f5f2ea"), // white
          new Color("#f0e3c6"), // cream
          new Color("#efd49a"), // Lisbon yellow, softened
          new Color("#ecc8b9"), // pink
          new Color("#d3dee6"), // pale blue
          new Color("#e6e2da"), // light grey
          new Color("#e2d6c2"), // beige
        ],
      },
      // The old centre: ochre, rose, terracotta, pale green, blue and a warm white.
      uOldWalls: {
        value: [
          new Color("#ecc77e"),
          new Color("#e7b4a2"),
          new Color("#d99a7c"),
          new Color("#cfdcc8"),
          new Color("#c6d4e2"),
          new Color("#f2e8d4"),
        ],
      },
      uTile: { value: new Color("#4a73a8") },
      uStone: { value: new Color("#dcd5c6") },
      uRoofA: { value: new Color("#c98466") },
      uRoofB: { value: new Color("#d79e80") },
      uRoofC: { value: new Color("#ad7a66") },
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
