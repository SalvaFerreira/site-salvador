// Reads the files written by scripts/02_process.py (layout documented there)
// and turns building footprints into extruded geometry.
//
// Scene axes: x = east, y = up, z = south. One unit is one metre.
import earcut from "earcut";
import { BufferAttribute, BufferGeometry, Shape, ShapeGeometry } from "three";

export interface ChunkInfo {
  id: string;
  name: string;
  file: string;
  origin: [number, number];
  bbox: [number, number, number, number];
  maxHeight: number;
  buildings: number;
  vertices: number;
  bytes: number;
}

export interface Manifest {
  attribution: string;
  origin: { lon: number; lat: number };
  bbox: [number, number, number, number];
  /** The part of the map the camera may show (the south bank is left out). */
  view: [number, number, number, number];
  unitsPerMetre: number;
  chunks: ChunkInfo[];
  land: { file: string; unitsPerMetre: number; origin: [number, number] };
  roads: { file: string; unitsPerMetre: number };
  projection: { x: number[]; y: number[] };
  bridge: { kind: string; points: [number, number][] }[];
  bridgeTowers: { x: number; y: number; width: number; depth: number; height: number }[];
  stats: { buildings: number };
}

interface Footprints {
  nBuildings: number;
  vertCounts: Uint16Array;
  /** x,y pairs in metres relative to the chunk origin (north is +y). */
  coords: Float32Array;
  heights: Uint8Array;
  ringCounts: Uint8Array;
}

const DATA = "/data/";

/** lon/lat (degrees) -> map metres relative to the scene origin (x east, y north). */
export function project(manifest: Manifest, lon: number, lat: number): [number, number] {
  const dl = lon - manifest.origin.lon;
  const dp = lat - manifest.origin.lat;
  const terms = [1, dl, dp, dl * dp, dl * dl, dp * dp];
  const dot = (c: number[]) => c.reduce((sum, v, i) => sum + v * terms[i], 0);
  return [dot(manifest.projection.x), dot(manifest.projection.y)];
}

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${DATA}manifest.json`);
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  return res.json();
}

async function loadFootprints(file: string, unitsPerMetre: number): Promise<Footprints> {
  const res = await fetch(DATA + file);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x3142584c) throw new Error(`${file}: not an LXB1 file`);
  const nBuildings = view.getUint32(4, true);
  const nRings = view.getUint32(8, true);
  const nVerts = view.getUint32(12, true);

  let offset = 16;
  const vertCounts = new Uint16Array(buffer, offset, nRings);
  offset += nRings * 2;
  const deltas = new Int16Array(buffer, offset, nVerts * 2);
  offset += nVerts * 4;
  const heights = new Uint8Array(buffer, offset, nBuildings);
  offset += nBuildings;
  const ringCounts = new Uint8Array(buffer, offset, nBuildings);

  // Undo the delta encoding: the first vertex of each ring is absolute.
  const coords = new Float32Array(nVerts * 2);
  let v = 0;
  for (let r = 0; r < nRings; r++) {
    let x = 0;
    let y = 0;
    for (let i = 0; i < vertCounts[r]; i++, v++) {
      x += deltas[v * 2];
      y += deltas[v * 2 + 1];
      coords[v * 2] = x / unitsPerMetre;
      coords[v * 2 + 1] = y / unitsPerMetre;
    }
  }
  return { nBuildings, vertCounts, coords, heights, ringCounts };
}

/**
 * The top of a pitched roof: the footprint moved inwards by `inset` metres.
 * Returns null when the shape is too narrow or too crooked for that to work,
 * in which case the building keeps a flat roof.
 */
function insetRing(coords: Float32Array, start: number, n: number, inset: number): Float32Array | null {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = start + ((i + n - 1) % n);
    const c = start + i;
    const q = start + ((i + 1) % n);
    // Inward normals of the two edges that meet here (the ring runs counter-clockwise).
    let ax = coords[c * 2] - coords[p * 2];
    let ay = coords[c * 2 + 1] - coords[p * 2 + 1];
    let bx = coords[q * 2] - coords[c * 2];
    let by = coords[q * 2 + 1] - coords[c * 2 + 1];
    const al = Math.hypot(ax, ay) || 1;
    const bl = Math.hypot(bx, by) || 1;
    ax /= al;
    ay /= al;
    bx /= bl;
    by /= bl;
    const k = 1 + ax * bx + ay * by; // 2 on a straight wall, towards 0 on a hairpin corner
    if (k < 0.35) return null;
    out[i * 2] = coords[c * 2] + ((-ay - by) / k) * inset;
    out[i * 2 + 1] = coords[c * 2 + 1] + ((ax + bx) / k) * inset;
  }
  // Every edge must still run the same way, and enough of the roof must be left on top.
  let area = 0;
  let original = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = out[j * 2] - out[i * 2];
    const ey = out[j * 2 + 1] - out[i * 2 + 1];
    const ox = coords[(start + j) * 2] - coords[(start + i) * 2];
    const oy = coords[(start + j) * 2 + 1] - coords[(start + i) * 2 + 1];
    if (ex * ox + ey * oy <= 0) return null;
    area += out[i * 2] * out[j * 2 + 1] - out[j * 2] * out[i * 2 + 1];
    original += coords[(start + i) * 2] * coords[(start + j) * 2 + 1] - coords[(start + j) * 2] * coords[(start + i) * 2 + 1];
  }
  return area > 0.2 * original ? out : null;
}

/** Cheap deterministic 0..1 value per building. */
function seedOf(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A place to light up, in map metres relative to the scene origin. */
export interface Target {
  index: number;
  x: number;
  y: number;
  /** Keep this building's lights off. */
  dark: boolean;
}

/** The building found for a target, in scene coordinates. */
export interface Featured {
  index: number;
  x: number;
  z: number;
  height: number;
  radius: number;
  /** 0 when the target is inside the footprint, else metres to the building centre. */
  distance: number;
  dark: boolean;
}

export interface BuiltChunk {
  geometry: BufferGeometry;
  /** Flat shadows the buildings cast on the ground. */
  shadow: BufferGeometry;
  triangles: number;
  featured: Featured[];
}

const SNAP_M = 60;

/**
 * How far a shadow reaches on the ground per metre of building height, in map
 * metres (east, north). The sun is in the west-south-west, as in the building shader.
 */
export const SHADOW_PER_M: [number, number] = [0.72, 0.34];

function insideRing(coords: Float32Array, start: number, n: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = coords[(start + i) * 2];
    const yi = coords[(start + i) * 2 + 1];
    const xj = coords[(start + j) * 2];
    const yj = coords[(start + j) * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** For each target, the building it falls in, or the nearest one within SNAP_M. */
function findFeatured(f: Footprints, chunk: ChunkInfo, targets: Target[]): Map<number, Featured> {
  const found = new Map<number, Featured>();
  const [minX, minY, maxX, maxY] = chunk.bbox;
  for (const t of targets) {
    if (t.x < minX - SNAP_M || t.x > maxX + SNAP_M || t.y < minY - SNAP_M || t.y > maxY + SNAP_M) continue;
    const x = t.x - chunk.origin[0];
    const y = t.y - chunk.origin[1];
    let best = -1;
    let bestInfo: Featured | null = null;
    let ring = 0;
    let vert = 0;
    for (let b = 0; b < f.nBuildings; b++) {
      const n = f.vertCounts[ring];
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        cx += f.coords[(vert + i) * 2];
        cy += f.coords[(vert + i) * 2 + 1];
      }
      cx /= n;
      cy /= n;
      const distance = insideRing(f.coords, vert, n, x, y) ? 0 : Math.hypot(cx - x, cy - y);
      if (distance <= SNAP_M && (!bestInfo || distance < bestInfo.distance)) {
        let radius = 0;
        for (let i = 0; i < n; i++) {
          radius = Math.max(radius, Math.hypot(f.coords[(vert + i) * 2] - cx, f.coords[(vert + i) * 2 + 1] - cy));
        }
        best = b;
        bestInfo = {
          index: t.index,
          x: cx + chunk.origin[0],
          z: -(cy + chunk.origin[1]),
          height: f.heights[b],
          radius,
          distance,
          dark: t.dark,
        };
      }
      for (let r = 0; r < f.ringCounts[b]; r++) vert += f.vertCounts[ring++];
    }
    if (bestInfo) found.set(best, bestInfo);
  }
  return found;
}

/**
 * One merged mesh per neighbourhood. Vertex attributes:
 *   position  relative to the chunk origin
 *   normal    roofs point up; the shader uses that to skip windows
 *   wall      x: metres along this wall, y: metres above ground,
 *             z: wall length, w: building height.
 *             On roofs, x is 1 for a flat grey roof and 0 for tiles.
 *   seed      random 0..1 per building; featured buildings add 1 + their
 *             target index (and 100 more when their lights are off), so
 *             the shader can tell them apart
 */
export async function loadChunk(
  chunk: ChunkInfo,
  unitsPerMetre: number,
  salt: number,
  targets: Target[],
): Promise<BuiltChunk> {
  const f = await loadFootprints(chunk.file, unitsPerMetre);
  const featured = findFeatured(f, chunk, targets);
  const nVerts = f.coords.length / 2;
  const nRings = f.vertCounts.length;

  // Per footprint vertex: 4 for the wall, 4 for the roof slope above it, 1 for the roof top;
  // plus up to 20 for a chimney on each building.
  const maxVerts = nVerts * 9 + f.nBuildings * 20;
  const position = new Float32Array(maxVerts * 3);
  const normal = new Int8Array(maxVerts * 3);
  const wall = new Float32Array(maxVerts * 4);
  const seed = new Float32Array(maxVerts);
  const index = new Uint32Array(nVerts * 12 + (nVerts + nRings * 2) * 3 + f.nBuildings * 30);

  // The shadow of a block on flat ground is its footprint slid along the
  // ground, plus the strip each wall sweeps on the way.
  const shadowPos = new Float32Array(nVerts * 5 * 3);
  const shadowIndex = new Uint32Array(nVerts * 6 + (nVerts + nRings * 2) * 3);
  let sp = 0;
  let six = 0;

  let p = 0; // vertices written
  let ix = 0; // indices written
  let ring = 0;
  let vert = 0;

  for (let b = 0; b < f.nBuildings; b++) {
    const h = f.heights[b];
    const tag = featured.get(b);
    const s = seedOf(b * 131 + salt) * 0.999 + (tag ? 1 + tag.index + (tag.dark ? 100 : 0) : 0);
    const roofStart = vert;
    const shadowX = SHADOW_PER_M[0] * h;
    const shadowY = SHADOW_PER_M[1] * h;
    const holes: number[] = [];
    let buildingVerts = 0;

    for (let r = 0; r < f.ringCounts[b]; r++, ring++) {
      const n = f.vertCounts[ring];
      if (r > 0) holes.push(buildingVerts);
      for (let i = 0; i < n; i++) {
        const a = vert + i;
        const c = vert + ((i + 1) % n);
        const ax = f.coords[a * 2];
        const ay = f.coords[a * 2 + 1];
        const cx = f.coords[c * 2];
        const cy = f.coords[c * 2 + 1];
        const dx = cx - ax;
        const dy = cy - ay;
        const len = Math.hypot(dx, dy) || 1;
        // Outer rings run counter-clockwise on the map, so the outside is to the right.
        const nx = Math.round((dy / len) * 127);
        const nz = Math.round((dx / len) * 127);

        for (let k = 0; k < 4; k++) {
          const atEnd = k === 1 || k === 2;
          const top = k >= 2;
          const q = p + k;
          position[q * 3] = atEnd ? cx : ax;
          position[q * 3 + 1] = top ? h : 0;
          position[q * 3 + 2] = -(atEnd ? cy : ay);
          normal[q * 3] = nx;
          normal[q * 3 + 2] = nz;
          wall[q * 4] = atEnd ? len : 0;
          wall[q * 4 + 1] = top ? h : 0;
          wall[q * 4 + 2] = len;
          wall[q * 4 + 3] = h;
          seed[q] = s;
        }
        index[ix++] = p;
        index[ix++] = p + 1;
        index[ix++] = p + 2;
        index[ix++] = p;
        index[ix++] = p + 2;
        index[ix++] = p + 3;
        p += 4;

        // Only walls on the far side from the sun sweep shadow beyond the footprint.
        if (dy * shadowX - dx * shadowY > 0) {
          const corners = [ax, ay, cx, cy, cx + shadowX, cy + shadowY, ax + shadowX, ay + shadowY];
          for (let k = 0; k < 4; k++) {
            shadowPos[(sp + k) * 3] = corners[k * 2];
            shadowPos[(sp + k) * 3 + 2] = -corners[k * 2 + 1];
          }
          shadowIndex[six++] = sp;
          shadowIndex[six++] = sp + 1;
          shadowIndex[six++] = sp + 2;
          shadowIndex[six++] = sp;
          shadowIndex[six++] = sp + 2;
          shadowIndex[six++] = sp + 3;
          sp += 4;
        }
      }
      vert += n;
      buildingVerts += n;
    }

    // Roof. Most buildings get tiles on a pitched roof: the eaves stay at the
    // top of the walls and the roof rises to a smaller flat top. Tall and
    // modern buildings, and shapes that cannot be pitched, keep a flat roof.
    const flat = f.coords.subarray(roofStart * 2, (roofStart + buildingVerts) * 2);
    const pick = seedOf(b * 977 + salt);
    const modern = h >= 34 || pick < 0.14;
    let footprintArea = 0;
    for (let i = 0; i < buildingVerts; i++) {
      const j = (i + 1) % buildingVerts;
      footprintArea += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
    }
    footprintArea = Math.abs(footprintArea) / 2;
    const inset = Math.min(3, Math.max(1.2, 0.2 * Math.sqrt(footprintArea)));
    const top =
      modern || holes.length || h < 4 || footprintArea < 30
        ? null
        : (insetRing(f.coords, roofStart, buildingVerts, inset) ?? insetRing(f.coords, roofStart, buildingVerts, inset / 2));
    const rise = top ? inset * 0.6 : 0;
    const flatFlag = modern ? 1 : 0;

    if (top) {
      // One sloping face above each wall.
      const slope = Math.hypot(inset, rise);
      for (let i = 0; i < buildingVerts; i++) {
        const j = (i + 1) % buildingVerts;
        const dx = flat[j * 2] - flat[i * 2];
        const dy = flat[j * 2 + 1] - flat[i * 2 + 1];
        const len = Math.hypot(dx, dy) || 1;
        const nx = Math.round(((dy / len) * rise * 127) / slope);
        const ny = Math.round((inset * 127) / slope);
        const nz = Math.round(((dx / len) * rise * 127) / slope);
        const corners = [flat[i * 2], flat[i * 2 + 1], flat[j * 2], flat[j * 2 + 1], top[j * 2], top[j * 2 + 1], top[i * 2], top[i * 2 + 1]];
        for (let k = 0; k < 4; k++) {
          const q = p + k;
          position[q * 3] = corners[k * 2];
          position[q * 3 + 1] = k >= 2 ? h + rise : h;
          position[q * 3 + 2] = -corners[k * 2 + 1];
          normal[q * 3] = nx;
          normal[q * 3 + 1] = ny;
          normal[q * 3 + 2] = nz;
          wall[q * 4 + 1] = h;
          wall[q * 4 + 3] = h;
          seed[q] = s;
        }
        index[ix++] = p;
        index[ix++] = p + 1;
        index[ix++] = p + 2;
        index[ix++] = p;
        index[ix++] = p + 2;
        index[ix++] = p + 3;
        p += 4;
      }
    }

    // The flat part: the whole roof, or the top of a pitched one.
    const cap = top ?? flat;
    const tris = earcut(flat, holes.length ? holes : undefined, 2);
    for (let i = 0; i < buildingVerts; i++) {
      const q = p + i;
      position[q * 3] = cap[i * 2];
      position[q * 3 + 1] = h + rise;
      position[q * 3 + 2] = -cap[i * 2 + 1];
      normal[q * 3 + 1] = 127;
      wall[q * 4] = flatFlag;
      wall[q * 4 + 1] = h;
      wall[q * 4 + 3] = h;
      seed[q] = s;
    }
    for (let t = 0; t < tris.length; t += 3) {
      const i0 = tris[t];
      let i1 = tris[t + 1];
      let i2 = tris[t + 2];
      // Make every roof triangle face up.
      const ux = flat[i1 * 2] - flat[i0 * 2];
      const uy = flat[i1 * 2 + 1] - flat[i0 * 2 + 1];
      const vx = flat[i2 * 2] - flat[i0 * 2];
      const vy = flat[i2 * 2 + 1] - flat[i0 * 2 + 1];
      if (ux * vy - uy * vx < 0) [i1, i2] = [i2, i1];
      index[ix++] = p + i0;
      index[ix++] = p + i1;
      index[ix++] = p + i2;
      shadowIndex[six++] = sp + i0;
      shadowIndex[six++] = sp + i1;
      shadowIndex[six++] = sp + i2;
    }
    p += buildingVerts;

    // A chimney on some tiled roofs: a small white block standing on the top.
    if (top && footprintArea > 70 && seedOf(b * 331 + salt) < 0.4) {
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < buildingVerts; i++) {
        cx += top[i * 2];
        cy += top[i * 2 + 1];
      }
      cx /= buildingVerts;
      cy /= buildingVerts;
      const towards = Math.floor(seedOf(b * 53 + salt) * buildingVerts);
      const mx = cx + (top[towards * 2] - cx) * 0.45;
      const my = cy + (top[towards * 2 + 1] - cy) * 0.45;
      if (insideRing(top, 0, buildingVerts, mx, my)) {
        const half = 0.8;
        const base = h + rise;
        const tall = 1.9;
        // Corners counter-clockwise on the map, then the four sides and the lid.
        const xs = [mx - half, mx + half, mx + half, mx - half];
        const ys = [my - half, my - half, my + half, my + half];
        const sides = [0, -1, 1, 0, 0, 1, -1, 0];
        for (let side = 0; side < 4; side++) {
          const i0 = side;
          const i1 = (side + 1) % 4;
          for (let k = 0; k < 4; k++) {
            const end = k === 1 || k === 2;
            const q = p + k;
            position[q * 3] = xs[end ? i1 : i0];
            position[q * 3 + 1] = base + (k >= 2 ? tall : 0);
            position[q * 3 + 2] = -ys[end ? i1 : i0];
            normal[q * 3] = sides[side * 2] * 127;
            normal[q * 3 + 2] = -sides[side * 2 + 1] * 127;
            // Too short for windows, and lit like the upper part of a wall.
            wall[q * 4 + 1] = h;
            wall[q * 4 + 2] = half * 2;
            wall[q * 4 + 3] = h;
            seed[q] = s;
          }
          index[ix++] = p;
          index[ix++] = p + 1;
          index[ix++] = p + 2;
          index[ix++] = p;
          index[ix++] = p + 2;
          index[ix++] = p + 3;
          p += 4;
        }
        for (let k = 0; k < 4; k++) {
          const q = p + k;
          position[q * 3] = xs[k];
          position[q * 3 + 1] = base + tall;
          position[q * 3 + 2] = -ys[k];
          normal[q * 3 + 1] = 127;
          wall[q * 4] = 1;
          wall[q * 4 + 1] = h;
          wall[q * 4 + 3] = h;
          seed[q] = s;
        }
        index[ix++] = p;
        index[ix++] = p + 1;
        index[ix++] = p + 2;
        index[ix++] = p;
        index[ix++] = p + 2;
        index[ix++] = p + 3;
        p += 4;
      }
    }

    for (let i = 0; i < buildingVerts; i++) {
      shadowPos[(sp + i) * 3] = flat[i * 2] + shadowX;
      shadowPos[(sp + i) * 3 + 2] = -(flat[i * 2 + 1] + shadowY);
    }
    sp += buildingVerts;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position.subarray(0, p * 3), 3));
  geometry.setAttribute("normal", new BufferAttribute(normal.subarray(0, p * 3), 3, true));
  geometry.setAttribute("wall", new BufferAttribute(wall.subarray(0, p * 4), 4));
  geometry.setAttribute("seed", new BufferAttribute(seed.subarray(0, p), 1));
  geometry.setIndex(new BufferAttribute(index.slice(0, ix), 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const shadow = new BufferGeometry();
  shadow.setAttribute("position", new BufferAttribute(shadowPos.slice(0, sp * 3), 3));
  shadow.setIndex(new BufferAttribute(shadowIndex.slice(0, six), 1));
  shadow.computeBoundingSphere();
  return { geometry, shadow, triangles: (ix + six) / 3, featured: [...featured.values()] };
}

/** Flat polygons on the ground from an LXB1 file: the land outline, the green spaces. */
export async function loadShapes(file: string, unitsPerMetre: number): Promise<BufferGeometry> {
  return (await loadShapesByClass(file, unitsPerMetre, false)).get(0) ?? new BufferGeometry();
}

/**
 * Flat polygons grouped by the class stored in each one's "height" byte (the
 * ground cover file), or all together under class 0.
 */
export async function loadShapesByClass(file: string, unitsPerMetre: number, byClass = true): Promise<Map<number, BufferGeometry>> {
  const f = await loadFootprints(file, unitsPerMetre);
  const groups = new Map<number, Shape[]>();
  let ring = 0;
  let vert = 0;
  for (let b = 0; b < f.nBuildings; b++) {
    let shape: Shape | null = null;
    for (let r = 0; r < f.ringCounts[b]; r++, ring++) {
      const n = f.vertCounts[ring];
      const path = new Shape();
      for (let i = 0; i < n; i++) {
        const x = f.coords[(vert + i) * 2];
        const y = f.coords[(vert + i) * 2 + 1];
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
      if (shape) shape.holes.push(path);
      else shape = path;
      vert += n;
    }
    if (shape) {
      const cls = byClass ? f.heights[b] : 0;
      const list = groups.get(cls);
      if (list) list.push(shape);
      else groups.set(cls, [shape]);
    }
  }
  const out = new Map<number, BufferGeometry>();
  for (const [cls, shapes] of groups) {
    const geometry = new ShapeGeometry(shapes);
    geometry.rotateX(-Math.PI / 2); // map (x, north) -> scene (x, 0, -north)
    out.set(cls, geometry);
  }
  return out;
}
