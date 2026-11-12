// The parts of the scene that are not buildings: parks and trees, cars,
// the bridge, the tram and the Plan layer.
import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Color, Matrix4, Object3D, type BufferGeometry, type InstancedMesh, type Mesh } from "three";
import { shared } from "../city/environment";
import { createPlanLineMaterial, createTrafficMaterial } from "../city/groundMaterials";
import { buildRibbons, loadLines, type Polyline } from "../city/lines";
import { loadShapes, type Manifest } from "../city/loadCity";

const noRaycast = () => null;
type Point3 = [number, number, number];

/** Small repeatable random generator, so the city looks the same on every visit. */
function randomFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface PlanData {
  attribution: string;
  green: { file: string; unitsPerMetre: number };
  rail: { file: string; unitsPerMetre: number };
  tramRoute: [number, number][];
}

export async function loadPlan(): Promise<PlanData> {
  const res = await fetch("/data/plan.json");
  if (!res.ok) throw new Error(`plan.json: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- parks

const TREE_COUNT = 18000;
const TREE_COLORS = ["#5f9a4a", "#4f8a43", "#6fa653", "#467a3f"].map((c) => new Color(c));

/** Green spaces with trees scattered over them. */
export function Parks({ plan }: { plan: PlanData }) {
  const [green, setGreen] = useState<BufferGeometry | null>(null);
  const trees = useRef<InstancedMesh>(null);

  useEffect(() => {
    let cancelled = false;
    loadShapes(plan.green.file, plan.green.unitsPerMetre).then((g) => !cancelled && setGreen(g));
    return () => {
      cancelled = true;
    };
  }, [plan]);

  useLayoutEffect(() => {
    const mesh = trees.current;
    if (!green || !mesh) return;
    // Pick random points inside the green polygons, more of them in larger triangles.
    const pos = green.getAttribute("position");
    const index = green.getIndex()!;
    const nTris = index.count / 3;
    const cumulative = new Float64Array(nTris);
    let total = 0;
    for (let t = 0; t < nTris; t++) {
      const [a, b, c] = [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)];
      const area =
        Math.abs(
          (pos.getX(b) - pos.getX(a)) * (pos.getZ(c) - pos.getZ(a)) -
            (pos.getX(c) - pos.getX(a)) * (pos.getZ(b) - pos.getZ(a)),
        ) / 2;
      total += area;
      cumulative[t] = total;
    }
    const random = randomFrom(2024);
    const dummy = new Object3D();
    for (let i = 0; i < TREE_COUNT; i++) {
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
      const x = pos.getX(a) + u * (pos.getX(b) - pos.getX(a)) + v * (pos.getX(c) - pos.getX(a));
      const z = pos.getZ(a) + u * (pos.getZ(b) - pos.getZ(a)) + v * (pos.getZ(c) - pos.getZ(a));
      const r = 4 + random() * 4;
      dummy.position.set(x, r * 0.95, z);
      dummy.scale.set(r, r * (1 + random() * 0.4), r);
      dummy.rotation.y = random() * Math.PI;
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, TREE_COLORS[Math.floor(random() * TREE_COLORS.length)]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [green]);

  if (!green) return null;
  return (
    <>
      <mesh geometry={green} position-y={0.15} renderOrder={-1} raycast={noRaycast}>
        <meshBasicMaterial color="#a9c98a" />
      </mesh>
      <instancedMesh ref={trees} args={[undefined, undefined, TREE_COUNT]} raycast={noRaycast}>
        <icosahedronGeometry args={[1, 0]} />
        <meshLambertMaterial flatShading />
      </instancedMesh>
    </>
  );
}

// ---------------------------------------------------------------- cars

const CAR_COUNT = 900;
const CAR_COLORS = ["#f1f1ee", "#f1f1ee", "#b9bcc0", "#74787d", "#1f2124", "#a8261c", "#27477d", "#e8c02c"].map(
  (c) => new Color(c),
);

interface Car {
  line: Float32Array | ArrayLike<number>;
  lengths: Float32Array;
  start: number;
  speed: number;
}

/** A few cars driving along the main roads. */
export function Cars({ roads }: { roads: Polyline[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const cars = useMemo(() => {
    // Only main and secondary roads long enough for a car to be seen driving.
    const ways = roads
      .filter((r) => r.cls <= 1)
      .map((r) => {
        const n = r.points.length / 2;
        const lengths = new Float32Array(n);
        for (let i = 1; i < n; i++) {
          lengths[i] =
            lengths[i - 1] + Math.hypot(r.points[i * 2] - r.points[i * 2 - 2], r.points[i * 2 + 1] - r.points[i * 2 - 1]);
        }
        return { line: r.points, lengths, total: lengths[n - 1], cls: r.cls };
      })
      .filter((w) => w.total > 160);
    if (!ways.length) return [];
    const random = randomFrom(7);
    const sum = ways.reduce((s, w) => s + w.total, 0);
    const out: Car[] = [];
    for (let i = 0; i < CAR_COUNT; i++) {
      let target = random() * sum;
      let way = ways[0];
      for (const w of ways) {
        way = w;
        target -= w.total;
        if (target <= 0) break;
      }
      out.push({
        line: way.line,
        lengths: way.lengths,
        start: random() * way.total,
        speed: way.cls === 0 ? 11 + random() * 5 : 7 + random() * 4,
      });
    }
    return out;
  }, [roads]);

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const random = randomFrom(99);
    for (let i = 0; i < cars.length; i++) m.setColorAt(i, CAR_COLORS[Math.floor(random() * CAR_COLORS.length)]);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [cars]);

  const dummy = useMemo(() => new Object3D(), []);
  const hidden = useMemo(() => new Matrix4().makeScale(0, 0, 0), []);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    // With reduced motion uTime stays 0 and the cars stand still.
    const time = shared.uTime.value;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const n = car.lengths.length;
      const total = car.lengths[n - 1];
      const d = (car.start + car.speed * time) % total;
      let k = 1;
      while (k < n - 1 && car.lengths[k] < d) k++;
      const t = (d - car.lengths[k - 1]) / (car.lengths[k] - car.lengths[k - 1] || 1);
      const ax = car.line[k * 2 - 2];
      const ay = car.line[k * 2 - 1];
      const bx = car.line[k * 2];
      const by = car.line[k * 2 + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      // Keep to the right-hand side of the road.
      const sx = ((by - ay) / len) * 2.4;
      const sy = (-(bx - ax) / len) * 2.4;
      dummy.position.set(ax + (bx - ax) * t + sx, 1.3, -(ay + (by - ay) * t + sy));
      dummy.rotation.y = Math.atan2(by - ay, bx - ax);
      dummy.updateMatrix();
      // A car fades in and out at the ends of its road instead of popping.
      const edge = Math.min(d, total - d);
      m.setMatrixAt(i, edge < 6 ? hidden : dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });

  if (!cars.length) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, cars.length]} raycast={noRaycast} frustumCulled={false}>
      <boxGeometry args={[5.4, 2, 2.5]} />
      <meshLambertMaterial />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- bridge

export const BRIDGE_DECK_M = 70;
const CABLE_SIDE_SPAN_M = 480;
const BRIDGE_RED = "#c4472f";

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

// ---------------------------------------------------------------- tram

const TRAM_SPEED = 7; // m/s
const TRAM_PAUSE_S = 45;

/** A yellow tram that crosses the centre every now and then. */
export function Tram({ route }: { route: [number, number][] }) {
  const mesh = useRef<Mesh>(null);
  const lengths = useMemo(() => {
    const out = [0];
    for (let i = 1; i < route.length; i++) {
      out.push(out[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]));
    }
    return out;
  }, [route]);

  useFrame(() => {
    const m = mesh.current;
    if (!m || route.length < 2) return;
    const total = lengths[lengths.length - 1];
    const travel = total / TRAM_SPEED;
    const cycle = travel + TRAM_PAUSE_S;
    // With reduced motion uTime stays 0: the tram waits a third of the way along.
    const time = shared.uTime.value === 0 ? travel / 3 : shared.uTime.value;
    const phase = time % cycle;
    m.visible = phase < travel;
    if (!m.visible) return;
    const backwards = Math.floor(time / cycle) % 2 === 1;
    const d = (backwards ? travel - phase : phase) * TRAM_SPEED;
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < d) i++;
    const t = (d - lengths[i - 1]) / (lengths[i] - lengths[i - 1] || 1);
    const [ax, ay] = route[i - 1];
    const [bx, by] = route[i];
    m.position.set(ax + (bx - ax) * t, 2.2, -(ay + (by - ay) * t));
    m.rotation.y = Math.atan2(by - ay, bx - ax);
  });

  return (
    <mesh ref={mesh} raycast={noRaycast}>
      <boxGeometry args={[14, 3.6, 2.8]} />
      <meshLambertMaterial color="#f0c419" />
    </mesh>
  );
}

// ---------------------------------------------------------------- plan

/** Infrastructure of the Plan layer: railway, metro and tram lines drawn over the city. */
export function PlanLayer({ plan, visible }: { plan: PlanData; visible: boolean }) {
  const [rail, setRail] = useState<BufferGeometry | null>(null);
  const material = useMemo(createPlanLineMaterial, []);
  const wanted = useRef(false);

  useEffect(() => {
    // Downloaded the first time the layer is switched on.
    if (!visible || wanted.current) return;
    wanted.current = true;
    loadLines(plan.rail.file, plan.rail.unitsPerMetre).then((lines) => setRail(buildRibbons(lines, [9, 9, 8, 5], 1.2)));
  }, [visible, plan]);

  if (!rail) return null;
  return <mesh geometry={rail} material={material} visible={visible} renderOrder={5} raycast={noRaycast} frustumCulled={false} />;
}
