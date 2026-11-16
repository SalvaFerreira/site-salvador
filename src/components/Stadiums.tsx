// Football grounds (data from scripts/stadiums.py, via 02_process.py): the
// stands of the stadiums, seats raked down towards the pitch in rows, in the
// club colour at the Luz, Alvalade and the Restelo; a roof over the outer seats
// where the whole ground is roofed; and the white lines on every football pitch,
// with the grass mown in stripes inside the stadiums.
import { useEffect, useMemo, useState } from "react";
import earcut from "earcut";
import { BufferAttribute, BufferGeometry, Color, DoubleSide, MeshLambertMaterial, ShaderMaterial } from "three";
import { createShadowMaterial } from "../city/groundMaterials";
import { shared, withNight } from "../city/environment";
import { SHADOW_PER_M } from "../city/loadCity";

const noRaycast = () => null;

type Ring = [number, number][];

interface Stand {
  /** The outline, then its holes; metres east and north of the scene origin. */
  rings: Ring[];
  height: number;
  /** Goes all the way round the pitch: the hole is the pitch side. */
  ring: boolean;
  seats: "red" | "green" | "blue" | null;
  /** The roof over the outer seats: polygons, each an outline and its holes. */
  roof?: Ring[][];
  /** For a stand on one side of the pitch: the pitch it looks at. */
  pitch?: Ring;
}

interface StadiumsData {
  stands: Stand[];
  /** [x, y, length, width, angle of the long side, 1 inside a stadium] */
  pitches: number[][];
}

const SEATS: Record<string, string> = { red: "#d65a4b", green: "#4e9f68", blue: "#5079b8" };
/** Terraces of the smaller grounds: plain concrete steps. */
const TERRACE = "#cbc4b5";
const WALL = "#e3ddd0";
const ROOF = "#f2f0ea";
/** Depth of one row of seats, in metres along the rake. */
const ROW_M = 0.9;
/** The roof sits this far above the top row, on the outer wall. */
const ROOF_CLEARANCE_M = 5;
const ROOF_THICKNESS_M = 1.2;

export async function loadStadiums(): Promise<StadiumsData> {
  const res = await fetch("/data/stadiums.json");
  if (!res.ok) throw new Error(`stadiums.json: HTTP ${res.status}`);
  return res.json();
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distanceToRing(ring: Ring, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, distanceToSegment(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]));
  }
  return best;
}

/** Collects triangles with a colour and a row number (-1 off the seats) per vertex. */
class Builder {
  position: number[] = [];
  color: number[] = [];
  row: number[] = [];

  vertex(x: number, y: number, mapY: number, c: Color, row = -1) {
    this.position.push(x, y, -mapY);
    this.color.push(c.r, c.g, c.b);
    this.row.push(row);
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute("color", new BufferAttribute(new Float32Array(this.color), 3));
    g.setAttribute("aRow", new BufferAttribute(new Float32Array(this.row), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Upright quads under each edge of the rings, from the ground to the given heights. */
function walls(out: Builder, rings: Ring[], tops: number[][], color: Color) {
  rings.forEach((ring, r) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j];
      const [bx, by] = ring[i];
      const ha = tops[r][j];
      const hb = tops[r][i];
      out.vertex(ax, 0, ay, color);
      out.vertex(bx, 0, by, color);
      out.vertex(bx, hb, by, color);
      out.vertex(ax, 0, ay, color);
      out.vertex(bx, hb, by, color);
      out.vertex(ax, ha, ay, color);
    }
  });
}

/** A polygon with holes, triangulated, at per-vertex heights. */
function cap(out: Builder, rings: Ring[], heights: number[][], color: Color, rows?: number[][]) {
  const flat: number[] = [];
  const holes: number[] = [];
  const ys: number[] = [];
  const rs: number[] = [];
  rings.forEach((ring, r) => {
    if (r > 0) holes.push(flat.length / 2);
    ring.forEach(([x, y], i) => {
      flat.push(x, y);
      ys.push(heights[r][i]);
      rs.push(rows ? rows[r][i] : -1);
    });
  });
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  for (const k of tris) out.vertex(flat[k * 2], ys[k], flat[k * 2 + 1], color, rs[k]);
}

/** Flat shadow: the outline slid away from the sun by each vertex's height, and the strip each wall sweeps. */
function shadow(out: number[], rings: Ring[], heights: number[][]) {
  const slide = (x: number, y: number, h: number) => [x + SHADOW_PER_M[0] * h, y + SHADOW_PER_M[1] * h];
  const flat: number[] = [];
  const holes: number[] = [];
  const hs: number[] = [];
  rings.forEach((ring, r) => {
    if (r > 0) holes.push(flat.length / 2);
    ring.forEach(([x, y], i) => {
      flat.push(x, y);
      hs.push(heights[r][i]);
    });
  });
  for (const k of earcut(flat, holes.length ? holes : undefined, 2)) {
    const [x, y] = slide(flat[k * 2], flat[k * 2 + 1], hs[k]);
    out.push(x, 0, -y);
  }
  rings.forEach((ring, r) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      const as = slide(a[0], a[1], heights[r][j]);
      const bs = slide(b[0], b[1], heights[r][i]);
      for (const [x, y] of [a, b, bs, a, bs, as]) out.push(x, 0, -y);
    }
  });
}

function buildStands(stands: Stand[]): { body: BufferGeometry; shade: BufferGeometry } {
  const out = new Builder();
  const shade: number[] = [];
  const wall = new Color(WALL);
  const roofColor = new Color(ROOF);
  for (const s of stands) {
    const roofed = !!s.roof?.length;
    const low = Math.min(2.5, s.height * 0.4);
    const high = roofed ? s.height - ROOF_CLEARANCE_M : s.height;
    // How far up the rake each vertex is, 0 at the pitch side and 1 at the back.
    let rake: number[][];
    if (s.ring) {
      rake = s.rings.map((ring, r) => ring.map(() => (r === 0 ? 1 : 0)));
    } else {
      const d = s.rings.map((ring) => ring.map(([x, y]) => (s.pitch ? distanceToRing(s.pitch, x, y) : 0)));
      const all = d.flat();
      const min = Math.min(...all);
      const span = Math.max(...all) - min || 1;
      rake = d.map((ring) => ring.map((v) => (v - min) / span));
    }
    const heights = rake.map((ring) => ring.map((t) => low + (high - low) * t));
    // Rows: the length of the rake divided into rows of seats, counted from the pitch.
    const run = Math.hypot(high - low, (high - low) / Math.tan(Math.PI / 6));
    const rowsAcross = Math.max(2, Math.round(run / ROW_M));
    const rows = rake.map((ring) => ring.map((t) => t * rowsAcross));
    cap(out, s.rings, heights, new Color(s.seats ? SEATS[s.seats] : TERRACE), rows);
    // Where the ground is roofed, the outer wall goes up to the roof.
    const tops = heights.map((ring, r) => ring.map((h) => (roofed && r === 0 ? s.height : h)));
    walls(out, s.rings, tops, wall);
    shadow(shade, s.rings, tops);
    for (const roof of s.roof ?? []) {
      const top = roof.map((ring) => ring.map(() => s.height));
      const under = roof.map((ring) => ring.map(() => s.height - ROOF_THICKNESS_M));
      cap(out, roof, top, roofColor);
      // The roof's edges, as a band ROOF_THICKNESS_M deep.
      roof.forEach((ring, r) => {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [ax, ay] = ring[j];
          const [bx, by] = ring[i];
          out.vertex(ax, under[r][j], ay, roofColor);
          out.vertex(bx, under[r][i], by, roofColor);
          out.vertex(bx, s.height, by, roofColor);
          out.vertex(ax, under[r][j], ay, roofColor);
          out.vertex(bx, s.height, by, roofColor);
          out.vertex(ax, s.height, ay, roofColor);
        }
      });
    }
  }
  const shadeGeometry = new BufferGeometry();
  shadeGeometry.setAttribute("position", new BufferAttribute(new Float32Array(shade), 3));
  shadeGeometry.computeBoundingSphere();
  return { body: out.geometry(), shade: shadeGeometry };
}

/** Lambert with the seats drawn in rows: a darker line where each row steps up. */
function createStandMaterial(): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aRow;\nvarying float vRow;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRow = aRow;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vRow;")
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
  if (vRow >= 0.0) {
    float f = fract(vRow);
    float aa = fwidth(vRow);
    // The step at the back of each row; fades out when rows get thinner than a pixel.
    float step = 1.0 - smoothstep(0.16, 0.16 + aa, f);
    diffuseColor.rgb *= 1.0 - 0.28 * step * (1.0 - smoothstep(0.25, 0.5, aa));
  }`,
      );
  };
  return material;
}

/**
 * The lines of a football pitch, drawn over the grass: touchlines and goal lines,
 * halfway line, centre circle, penalty and goal areas, spots and arcs, at full
 * size on a full-size pitch and scaled down on smaller ones. vPitch: metres from
 * the centre, x along the pitch; vSize: length, width, and 1 inside a stadium,
 * where the grass is mown in stripes.
 */
function createPitchMaterial(): ShaderMaterial {
  return withNight(
    new ShaderMaterial({
      vertexShader: /* glsl */ `
attribute vec2 aPitch;
attribute vec3 aSize;
varying vec2 vPitch;
varying vec3 vSize;
void main() {
  vPitch = aPitch;
  vSize = aSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
      fragmentShader: /* glsl */ `
varying vec2 vPitch;
varying vec3 vSize;

float box(vec2 p, vec2 halfSize) {
  vec2 d = abs(p) - halfSize;
  return abs(length(max(d, 0.0)) + min(max(d.x, d.y), 0.0));
}

void main() {
  // Lines stay 1.5 m in from the edge of the mapped pitch.
  vec2 edge = vSize.xy * 0.5 - 1.5;
  float s = clamp(vSize.x / 105.0, 0.3, 1.0);
  vec2 p = vPitch;
  vec2 q = vec2(abs(p.x), p.y);
  float d = box(p, edge);
  d = min(d, abs(p.x));
  d = min(d, abs(length(p) - 9.15 * s));
  vec2 penalty = vec2(16.5 * s, min(20.15 * s, edge.y - 1.0));
  vec2 goal = vec2(5.5 * s, min(9.16 * s, edge.y - 1.5));
  d = min(d, box(q - vec2(edge.x - penalty.x * 0.5, 0.0), vec2(penalty.x * 0.5, penalty.y)));
  d = min(d, box(q - vec2(edge.x - goal.x * 0.5, 0.0), vec2(goal.x * 0.5, goal.y)));
  vec2 spot = q - vec2(edge.x - 11.0 * s, 0.0);
  // The arc outside the penalty area.
  float arc = abs(length(spot) - 9.15 * s);
  d = min(d, q.x < edge.x - penalty.x ? arc : 1e3);
  float w = 0.16;
  float aa = fwidth(p.x);
  float line = 1.0 - smoothstep(w, w + aa, d);
  line = max(line, 1.0 - smoothstep(0.35, 0.35 + aa, min(length(spot), length(p))));
  // Lines thinner than a pixel from far away: fainter rather than flickering.
  line *= 0.85 * clamp(0.4 / aa, 0.0, 1.0);
  // Mown stripes across the pitch, in the stadiums.
  float band = step(0.5, fract(p.x / 10.0 + 0.5));
  float mown = vSize.z * (0.07 * band) * clamp(3.0 / aa, 0.0, 1.0);
  // White chalk, and the lighter bands of mown grass.
  float alpha = max(line, mown);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vec3(1.0), alpha);
  #include <colorspace_fragment>
}
`,
      uniforms: { ...shared },
      transparent: true,
      depthWrite: false,
    }),
    "dark",
  );
}

function buildPitches(pitches: number[][]): BufferGeometry {
  const position = new Float32Array(pitches.length * 6 * 3);
  const local = new Float32Array(pitches.length * 6 * 2);
  const size = new Float32Array(pitches.length * 6 * 3);
  pitches.forEach(([x, y, length, width, angle, stadium], i) => {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, -1],
      [1, 1],
      [-1, 1],
    ];
    corners.forEach(([a, b], k) => {
      const lx = (a * length) / 2;
      const ly = (b * width) / 2;
      const v = i * 6 + k;
      position.set([x + lx * ux - ly * uy, 0, -(y + lx * uy + ly * ux)], v * 3);
      local.set([lx, ly], v * 2);
      size.set([length, width, stadium], v * 3);
    });
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(position, 3));
  g.setAttribute("aPitch", new BufferAttribute(local, 2));
  g.setAttribute("aSize", new BufferAttribute(size, 3));
  g.computeBoundingSphere();
  return g;
}

export function Stadiums() {
  const [data, setData] = useState<StadiumsData | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadStadiums()
      .then((d) => !cancelled && setData(d))
      .catch((error) => console.error("Stadiums failed to load", error));
    return () => {
      cancelled = true;
    };
  }, []);

  const built = useMemo(() => data && { ...buildStands(data.stands), pitches: buildPitches(data.pitches) }, [data]);
  const standMaterial = useMemo(createStandMaterial, []);
  const pitchMaterial = useMemo(createPitchMaterial, []);
  const shadowMaterial = useMemo(createShadowMaterial, []);
  if (!built) return null;
  return (
    <>
      {/* Over the grass and the council's green spaces, under the shadows. */}
      <mesh geometry={built.pitches} material={pitchMaterial} position-y={0.3} renderOrder={-0.5} raycast={noRaycast} />
      <mesh geometry={built.body} material={standMaterial} raycast={noRaycast} />
      <mesh geometry={built.shade} material={shadowMaterial} position-y={0.7} renderOrder={2} raycast={noRaycast} />
    </>
  );
}
