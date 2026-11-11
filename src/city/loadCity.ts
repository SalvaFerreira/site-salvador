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
  bbox: [number, number, number, number];
  unitsPerMetre: number;
  chunks: ChunkInfo[];
  land: { file: string; unitsPerMetre: number; origin: [number, number] };
  bridge: { kind: string; points: [number, number][] }[];
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

export interface BuiltChunk {
  geometry: BufferGeometry;
  triangles: number;
}

/**
 * One merged mesh per neighbourhood. Vertex attributes:
 *   position  relative to the chunk origin
 *   normal    roofs point up; the shader uses that to skip windows
 *   wall      x: metres along this wall, y: metres above ground,
 *             z: wall length, w: building height
 *   seed      random 0..1 per building
 */
export async function loadChunk(chunk: ChunkInfo, unitsPerMetre: number, salt: number): Promise<BuiltChunk> {
  const f = await loadFootprints(chunk.file, unitsPerMetre);
  const nVerts = f.coords.length / 2;
  const nRings = f.vertCounts.length;

  const maxVerts = nVerts * 5; // 4 per wall + 1 per roof vertex
  const position = new Float32Array(maxVerts * 3);
  const normal = new Int8Array(maxVerts * 3);
  const wall = new Float32Array(maxVerts * 4);
  const seed = new Float32Array(maxVerts);
  const index = new Uint32Array(nVerts * 6 + (nVerts + nRings * 2) * 3);

  let p = 0; // vertices written
  let ix = 0; // indices written
  let ring = 0;
  let vert = 0;

  for (let b = 0; b < f.nBuildings; b++) {
    const h = f.heights[b];
    const s = seedOf(b * 131 + salt);
    const roofStart = vert;
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
    }
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
  return { geometry, triangles: ix / 3 };
}

/** Flat land outline; everything outside it is river. */
export async function loadLand(manifest: Manifest): Promise<BufferGeometry> {
  const f = await loadFootprints(manifest.land.file, manifest.land.unitsPerMetre);
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
