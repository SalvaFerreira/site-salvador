// The parts of the scene that are not buildings: parks and trees, cars,
// and the bridge.
import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BufferAttribute,
  CircleGeometry,
  Color,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  type BufferGeometry,
  type Mesh,
  type OrthographicCamera,
} from "three";
import { shared } from "../city/environment";
import { createGrassMaterial, createShadowMaterial, createTrafficMaterial } from "../city/groundMaterials";
import { buildRibbons } from "../city/lines";
import { loadShapes, SHADOW_PER_M, type Manifest } from "../city/loadCity";

const noRaycast = () => null;
type Point3 = [number, number, number];

/** Small repeatable random generator, so the city looks the same on every visit. */
export function randomFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface PlanData {
  attribution: string;
  green: { file: string; unitsPerMetre: number };
  trees: { file: string; unitsPerMetre: number };
  /** Routes of what moves in the scene, as lists of [x, y] points in map metres. */
  tramRoutes: number[][][];
  /** Railway tracks above ground, drawn in the city. */
  tracks: { file: string; unitsPerMetre: number };
  trainRoutes: { name: string; points: number[][] }[];
  ferryRoutes: number[][][];
  sailingLanes: number[][][];
}

/** Ground cover for the emptier parts of the map, and the airport's runways. */
export interface CoverData {
  file: string;
  unitsPerMetre: number;
  runways: { width: number; points: number[][] }[];
  taxiways: number[][][];
}

export async function loadCover(): Promise<CoverData> {
  const res = await fetch("/data/cover.json");
  if (!res.ok) throw new Error(`cover.json: HTTP ${res.status}`);
  return res.json();
}

/** Classes of ground cover (scripts/06_cover.py) and the colour each is drawn in. */
export const COVER = { wood: 0, grass: 1, pitch: 2, cemetery: 3, sand: 4, grey: 5, parking: 6, apron: 7 } as const;
const COVER_COLORS: Record<number, string> = {
  0: "#a3c28e",
  1: "#c4dbab",
  2: "#acd29a",
  3: "#d7dacf",
  4: "#ece4cd",
  5: "#e0ddd5",
  6: "#d9d7d2",
  7: "#d6d6d6",
};

export async function loadPlan(): Promise<PlanData> {
  const res = await fetch("/data/plan.json");
  if (!res.ok) throw new Error(`plan.json: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- parks and trees

/** Extra trees scattered over the large green areas, which the council inventory does not cover. */
const SCATTERED_TREES = 9000;
/** Woodland (Monsanto above all) is planted densely: one tree for this many square metres. */
const WOODLAND_M2_PER_TREE = 230;
const WOODLAND_TREES_MAX = 45000;
/** Trees are drawn in square tiles this wide, so that only the ones near the view are drawn. */
const TREE_TILE_M = 1200;
/** Ground cover classes drawn as grass: woodland, grass and scrub, pitches. */
const GREEN_COVER = new Set([0, 1, 2]);
const grassMaterials = new Map<string, ReturnType<typeof createGrassMaterial>>();
function grassMaterial(color: string) {
  if (!grassMaterials.has(color)) grassMaterials.set(color, createGrassMaterial(color));
  return grassMaterials.get(color)!;
}

const TREE_COLORS = ["#73a35f", "#669656", "#82b06a", "#5c8a4f", "#8db574"].map((c) => new Color(c));

/** A low-poly canopy: lighter on top, darker underneath. */
function createCanopyGeometry(): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, 0);
  const position = geometry.getAttribute("position");
  const color = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const tone = 0.7 + 0.3 * (position.getY(i) * 0.5 + 0.5);
    color.set([tone, tone, tone], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(color, 3));
  return geometry;
}

/** The council's tree inventory: x, y pairs in map metres. */
async function loadTrees(file: string, unitsPerMetre: number): Promise<Float32Array> {
  const res = await fetch(`/data/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x3154584c) throw new Error(`${file}: not an LXT1 file`);
  const raw = new Int16Array(buffer, 8, view.getUint32(4, true) * 2);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / unitsPerMetre;
  return out;
}

/** Total area of a flat geometry, in square metres. */
function areaOf(geometry: BufferGeometry): number {
  const pos = geometry.getAttribute("position");
  const index = geometry.getIndex()!;
  let total = 0;
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    total +=
      Math.abs(
        (pos.getX(b) - pos.getX(a)) * (pos.getZ(c) - pos.getZ(a)) - (pos.getX(c) - pos.getX(a)) * (pos.getZ(b) - pos.getZ(a)),
      ) / 2;
  }
  return total;
}

/** Random points inside the green polygons, more of them in larger triangles. Returns x, y pairs. */
export function scatterOver(green: BufferGeometry, count: number, random: () => number): Float32Array {
  const pos = green.getAttribute("position");
  const index = green.getIndex()!;
  const nTris = index.count / 3;
  const cumulative = new Float64Array(nTris);
  let total = 0;
  for (let t = 0; t < nTris; t++) {
    const [a, b, c] = [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)];
    total +=
      Math.abs(
        (pos.getX(b) - pos.getX(a)) * (pos.getZ(c) - pos.getZ(a)) - (pos.getX(c) - pos.getX(a)) * (pos.getZ(b) - pos.getZ(a)),
      ) / 2;
    cumulative[t] = total;
  }
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const target = random() * total;
    let lo = 0;
    let hi = nTris - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const [a, b, c] = [index.getX(lo * 3), index.getX(lo * 3 + 1), index.getX(lo * 3 + 2)];
    let u = random();
    let v = random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    out[i * 2] = pos.getX(a) + u * (pos.getX(b) - pos.getX(a)) + v * (pos.getX(c) - pos.getX(a));
    // The green geometry is already in scene coordinates: map north is -z.
    out[i * 2 + 1] = -(pos.getZ(a) + u * (pos.getZ(b) - pos.getZ(a)) + v * (pos.getZ(c) - pos.getZ(a)));
  }
  return out;
}

interface TreeTile {
  canopies: InstancedMesh;
  shadows: InstancedMesh;
  total: number;
}

/**
 * Share of the trees drawn at a given zoom (pixels per metre). Seen from far
 * away a tree is a pixel or two, so most of them can be left out unnoticed.
 */
function treeShare(zoom: number): number {
  return zoom >= 0.55 ? 1 : zoom >= 0.28 ? 0.5 : 0.25;
}

interface ParksProps {
  plan: PlanData;
  /** Ground cover by class; null until it has loaded. */
  cover: Map<number, BufferGeometry> | null;
}

/**
 * Green spaces and the rest of the ground cover (woodland, pitches, cemeteries,
 * industrial land...), and the city's trees as small 3D canopies with a shadow each.
 */
export function Parks({ plan, cover }: ParksProps) {
  const [green, setGreen] = useState<BufferGeometry | null>(null);
  const [inventory, setInventory] = useState<Float32Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadShapes(plan.green.file, plan.green.unitsPerMetre).then((g) => !cancelled && setGreen(g));
    loadTrees(plan.trees.file, plan.trees.unitsPerMetre).then((t) => !cancelled && setInventory(t));
    return () => {
      cancelled = true;
    };
  }, [plan]);

  const tiles = useMemo<TreeTile[]>(() => {
    if (!green || !inventory || !cover) return [];
    const random = randomFrom(2024);
    const scattered = scatterOver(green, SCATTERED_TREES, random);
    const wood = cover.get(COVER.wood);
    const woodland = wood
      ? scatterOver(wood, Math.min(WOODLAND_TREES_MAX, Math.round(areaOf(wood) / WOODLAND_M2_PER_TREE)), random)
      : new Float32Array(0);

    // Sort every tree into its tile. Street trees are small, park trees larger.
    const byTile = new Map<string, { x: number; y: number; r: number }[]>();
    const add = (x: number, y: number, r: number) => {
      const key = `${Math.floor(x / TREE_TILE_M)},${Math.floor(y / TREE_TILE_M)}`;
      let list = byTile.get(key);
      if (!list) byTile.set(key, (list = []));
      list.push({ x, y, r });
    };
    for (let i = 0; i < inventory.length; i += 2) add(inventory[i], inventory[i + 1], 3 + random() * 2.6);
    for (let i = 0; i < scattered.length; i += 2) add(scattered[i], scattered[i + 1], 4.5 + random() * 3.5);
    for (let i = 0; i < woodland.length; i += 2) add(woodland[i], woodland[i + 1], 5 + random() * 4);

    const canopy = createCanopyGeometry();
    const canopyMaterial = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const disc = new CircleGeometry(1, 7).rotateX(-Math.PI / 2);
    const shadowMaterial = createShadowMaterial();
    const dummy = new Object3D();
    const out: TreeTile[] = [];
    for (const list of byTile.values()) {
      // Shuffled, so that drawing only the first part of a tile thins it evenly.
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      const canopies = new InstancedMesh(canopy, canopyMaterial, list.length);
      const shadows = new InstancedMesh(disc, shadowMaterial, list.length);
      list.forEach((tree, i) => {
        const { x, y, r } = tree;
        dummy.position.set(x, r * 1.05, -y);
        dummy.scale.set(r, r * (1 + random() * 0.35), r);
        dummy.rotation.set(0, random() * Math.PI, 0);
        dummy.updateMatrix();
        canopies.setMatrixAt(i, dummy.matrix);
        canopies.setColorAt(i, TREE_COLORS[Math.floor(random() * TREE_COLORS.length)]);
        // The shadow lies on the ground, away from the sun.
        dummy.position.set(x + SHADOW_PER_M[0] * r, 0.72, -(y + SHADOW_PER_M[1] * r));
        dummy.scale.set(r * 0.95, 1, r * 0.95);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        shadows.setMatrixAt(i, dummy.matrix);
      });
      for (const mesh of [canopies, shadows]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.raycast = noRaycast;
      }
      shadows.renderOrder = 2;
      out.push({ canopies, shadows, total: list.length });
    }
    return out;
  }, [green, inventory, cover]);

  // Starts at 0 so the first frame always sets the counts.
  const share = useRef(0);
  useFrame(({ camera }) => {
    const zoom = (camera as OrthographicCamera).zoom;
    const next = treeShare(zoom);
    if (next === share.current) return;
    share.current = next;
    for (const tile of tiles) {
      tile.canopies.count = Math.ceil(tile.total * next);
      tile.shadows.count = tile.canopies.count;
      // Tree shadows are too small to see once the view is wide.
      tile.shadows.visible = zoom >= 0.45;
    }
  });

  if (!green) return null;
  return (
    <>
      {/* Ground cover lies under the council's green spaces, which are more detailed. */}
      {cover &&
        [...cover].map(([cls, geometry]) =>
          GREEN_COVER.has(cls) ? (
            <mesh
              key={cls}
              geometry={geometry}
              material={grassMaterial(COVER_COLORS[cls])}
              position-y={0.05 + cls * 0.01}
              renderOrder={-1.5}
              raycast={noRaycast}
            />
          ) : (
            <mesh key={cls} geometry={geometry} position-y={0.05 + cls * 0.01} renderOrder={-1.5} raycast={noRaycast}>
              <meshBasicMaterial color={COVER_COLORS[cls] ?? "#dad4c8"} />
            </mesh>
          ),
        )}
      <mesh geometry={green} material={grassMaterial("#bcd6a2")} position-y={0.15} renderOrder={-1} raycast={noRaycast} />
      {tiles.map((tile, i) => (
        <group key={i}>
          <primitive object={tile.canopies} />
          <primitive object={tile.shadows} />
        </group>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- bridge

export const BRIDGE_DECK_M = 70;
const CABLE_SIDE_SPAN_M = 480;
const BRIDGE_RED = "#b4705f";

/** Ponte 25 de Abril: deck with traffic, red towers and main cables. */
export function Bridge({ manifest }: { manifest: Manifest }) {
  const decks = useMemo(() => {
    const material = createTrafficMaterial();
    return manifest.bridge
      .filter((way) => way.kind === "road" && way.points.length > 1)
      .map((way) => ({
        geometry: buildRibbons([{ points: way.points.flat(), cls: 0 }], [6], BRIDGE_DECK_M),
        material,
      }));
  }, [manifest]);

  const cables = useMemo(() => {
    const towers = manifest.bridgeTowers.filter((t) => t.height >= 150).sort((a, b) => b.y - a.y);
    if (towers.length < 2) return [];
    const [a, b] = [towers[0], towers[towers.length - 1]];
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / span;
    const uy = (b.y - a.y) / span;
    const top = Math.min(a.height, b.height);
    const low = BRIDGE_DECK_M + 8;
    const lines: Point3[][] = [];
    for (const offset of [-10, 10]) {
      const ox = -uy * offset;
      const oy = ux * offset;
      const at = (d: number, h: number): Point3 => [a.x + ux * d + ox, h, -(a.y + uy * d + oy)];
      const line: Point3[] = [];
      // Anchor span, main span between the towers, anchor span.
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        line.push(at(-CABLE_SIDE_SPAN_M * (1 - t), BRIDGE_DECK_M + (top - BRIDGE_DECK_M) * t * t));
      }
      for (let i = 1; i <= 32; i++) {
        const t = i / 32;
        line.push(at(span * t, low + (top - low) * (2 * t - 1) ** 2));
      }
      for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        line.push(at(span + CABLE_SIDE_SPAN_M * t, BRIDGE_DECK_M + (top - BRIDGE_DECK_M) * (1 - t) ** 2));
      }
      lines.push(line);
    }
    return lines;
  }, [manifest]);

  return (
    <>
      {decks.map((deck, i) => (
        <mesh key={i} geometry={deck.geometry} material={deck.material} raycast={noRaycast} frustumCulled={false} />
      ))}
      {cables.map((points, i) => (
        <Line key={i} points={points} color={BRIDGE_RED} lineWidth={2} />
      ))}
      {manifest.bridgeTowers.map((t, i) => (
        <mesh key={i} position={[t.x, t.height / 2, -t.y]} raycast={noRaycast}>
          <boxGeometry args={[t.width, t.height, t.depth]} />
          <meshLambertMaterial color={t.height >= 150 ? BRIDGE_RED : "#b9b4aa"} />
        </mesh>
      ))}
    </>
  );
}
