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
const SHADOW_PER_M: [number, number] = [0.72, 0.34];

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
 *             z: wall length, w: building height
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

  const maxVerts = nVerts * 5; // 4 per wall + 1 per roof vertex
  const position = new Float32Array(maxVerts * 3);
  const normal = new Int8Array(maxVerts * 3);
  const wall = new Float32Array(maxVerts * 4);
  const seed = new Float32Array(maxVerts);
  const index = new Uint32Array(nVerts * 6 + (nVerts + nRings * 2) * 3);

  // The shadow of a block on flat ground is its footprint slid along the
  // ground, plus the strip each wall sweeps on the way.
  const shadowPos = new Float32Array(maxVerts * 3);
  const shadowIndex = new Uint32Array(index.length);
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

    // Roof.
    const flat = f.coords.subarray(roofStart * 2, (roofStart + buildingVerts) * 2);
    const tris = earcut(flat, holes.length ? holes : undefined, 2);
    for (let i = 0; i < buildingVerts; i++) {
      const q = p + i;
      position[q * 3] = flat[i * 2];
      position[q * 3 + 1] = h;
      position[q * 3 + 2] = -flat[i * 2 + 1];
      normal[q * 3 + 1] = 127;
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
    for (let i = 0; i < buildingVerts; i++) {
      shadowPos[(sp + i) * 3] = flat[i * 2] + shadowX;
      shadowPos[(sp + i) * 3 + 2] = -(flat[i * 2 + 1] + shadowY);
    }
    sp += buildingVerts;
    p += buildingVerts;
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
  const f = await loadFootprints(file, unitsPerMetre);
  const shapes: Shape[] = [];
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
    if (shape) shapes.push(shape);
  }
  const geometry = new ShapeGeometry(shapes);
  geometry.rotateX(-Math.PI / 2); // map (x, north) -> scene (x, 0, -north)
  return geometry;
}
