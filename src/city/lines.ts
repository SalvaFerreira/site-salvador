// Lines on the ground: decoding them, and turning them into flat ribbons.
import { BufferAttribute, BufferGeometry } from "three";

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
