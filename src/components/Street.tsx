// Street detail from OpenStreetMap: crossings, traffic lights, the calçada of
// the big squares, buses on real bus lines and the end of the Vasco da Gama
// bridge. Data from scripts/07_street.py.
import { useFrame, useThree } from "@react-three/fiber";
import earcut from "earcut";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  MeshBasicMaterial,
  Object3D,
  type InstancedMesh,
  type OrthographicCamera,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { shared } from "../city/environment";
import { createCalcadaMaterial, createTrafficMaterial } from "../city/groundMaterials";
import { buildRibbons, loadLines, type Polyline } from "../city/lines";

const noRaycast = () => null;

export interface StreetData {
  crossings: { x: Float32Array; y: Float32Array; angle: Float32Array; kind: Uint8Array };
  lights: { x: Float32Array; y: Float32Array; angle: Float32Array; junction: Uint16Array };
  squares: number[][][];
  bridge: { deck: number; lines: number[][][] };
  bus: Polyline[];
}

interface StreetIndex {
  file: string;
  unitsPerMetre: number;
  bus: { file: string; unitsPerMetre: number };
  squares: number[][][];
  vascoDaGama: { deck: number; lines: number[][][] };
}

/** Reads street.json, street.bin and bus.bin (layouts in scripts/07_street.py). */
export async function loadStreet(): Promise<StreetData> {
  const index: StreetIndex = await (await fetch("/data/street.json")).json();
  const [buffer, bus] = await Promise.all([
    fetch(`/data/${index.file}`).then((r) => r.arrayBuffer()),
    loadLines(index.bus.file, index.bus.unitsPerMetre),
  ]);
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x3153584c) throw new Error("street.bin: not an LXS1 file");
  const nc = view.getUint32(4, true);
  const nl = view.getUint32(8, true);
  const u = index.unitsPerMetre;
  let at = 16;
  const i16 = (n: number) => {
    const a = new Int16Array(buffer, at, n);
    at += n * 2;
    return Float32Array.from(a, (v) => v / u);
  };
  const cx = i16(nc);
  const cy = i16(nc);
  const lx = i16(nl);
  const ly = i16(nl);
  const junction = new Uint16Array(buffer, at, nl).slice();
  at += nl * 2;
  const u8 = (n: number) => {
    const a = new Uint8Array(buffer, at, n).slice();
    at += n;
    return a;
  };
  const toAngle = (a: Uint8Array) => Float32Array.from(a, (v) => (v / 256) * Math.PI);
  const cAngle = toAngle(u8(nc));
  const kind = u8(nc);
  const lAngle = toAngle(u8(nl));
  return {
    crossings: { x: cx, y: cy, angle: cAngle, kind },
    lights: { x: lx, y: ly, angle: lAngle, junction },
    squares: index.squares,
    bridge: index.vascoDaGama,
    bus,
  };
}

// ---------------------------------------------------------------- rules of the road

/** Seconds for a full cycle of the traffic lights at a junction. */
const CYCLE_S = 40;
const GREEN_S = 16;
const AMBER_S = 3;

export const GREEN = 0;
export const AMBER = 1;
export const RED = 2;

/** Which of the two directions through a junction a street is on: 0 east-west-ish, 1 north-south-ish. */
export function axisOf(angle: number): number {
  const a = ((angle % Math.PI) + Math.PI) % Math.PI;
  return a > Math.PI / 4 && a < (3 * Math.PI) / 4 ? 1 : 0;
}

/**
 * The colour of the lights at a junction for one direction. The two directions
 * take turns, with a moment of red both ways in between; junctions are out of step.
 */
export function lightState(junction: number, axis: number, time: number): number {
  const t = (time + ((junction * 7.31) % CYCLE_S) + axis * (CYCLE_S / 2)) % CYCLE_S;
  return t < GREEN_S ? GREEN : t < GREEN_S + AMBER_S ? AMBER : RED;
}

function hash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Seconds a crossing stays busy or free at a time. */
export const CROSSING_SLOT_S = 9;

/**
 * Whether someone is crossing at a zebra crossing right now. There are no
 * pedestrian simulations behind it: each crossing is busy now and then, and
 * cars (and the people drawn on it) follow this.
 */
export function crossingBusy(index: number, time: number): boolean {
  const t = time + index * 3.7;
  return hash(index, Math.floor(t / CROSSING_SLOT_S)) < 0.28;
}

// ---------------------------------------------------------------- what is shown when

/** Pixels per metre below which small street things are not drawn. */
export const DETAIL_ZOOM = 0.9;

/** The part of the map on screen, with a margin, in map metres: [minX, minY, maxX, maxY]. */
export function useViewBox() {
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const controls = useThree((s) => s.controls) as { target: { x: number; z: number } } | null;
  const size = useThree((s) => s.size);
  const box = useMemo(() => new Float32Array(4), []);
  return () => {
    const zoom = camera.zoom;
    // The ground on screen reaches this far from its centre, every way (the view is
    // turned 45 degrees and looks down at about 37 degrees; see reach() in City.tsx).
    const r = ((size.width / 2 + size.height / (2 * 0.596)) * Math.SQRT1_2) / zoom + 60;
    const x = controls?.target.x ?? 0;
    const y = -(controls?.target.z ?? 0);
    box[0] = x - r;
    box[1] = y - r;
    box[2] = x + r;
    box[3] = y + r;
    return { box, zoom };
  };
}

// ---------------------------------------------------------------- calçada

/** The calçada of Praça do Comércio and the Rossio. */
export function Calcada({ squares }: { squares: number[][][] }) {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const ring of squares) {
      const flat = ring.flat();
      const base = positions.length / 3;
      for (const [x, y] of ring) positions.push(x, 0.3, -y);
      for (const i of earcut(flat)) indices.push(base + i);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    g.setIndex(indices);
    return g;
  }, [squares]);
  const material = useMemo(() => {
    const m = createCalcadaMaterial();
    m.depthWrite = false;
    return m;
  }, []);
  return <mesh geometry={geometry} material={material} renderOrder={1.5} raycast={noRaycast} frustumCulled={false} />;
}

// ---------------------------------------------------------------- crossings

/** White stripes across the street, one set per crossing, laid along +x = the street. */
function createCrossingGeometry(): BufferGeometry {
  const stripes: BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    stripes.push(new BoxGeometry(3.4, 0.05, 0.6).translate(0, 0, -3.6 + i * 1.2));
  }
  return mergeGeometries(stripes);
}

export function Crossings({ data }: { data: StreetData["crossings"] }) {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(createCrossingGeometry, []);
  const material = useMemo(() => new MeshBasicMaterial({ color: "#f7f5f0", depthWrite: false }), []);
  const count = data.x.length;

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const o = new Object3D();
    for (let i = 0; i < count; i++) {
      o.position.set(data.x[i], 0.5, -data.y[i]);
      o.rotation.y = data.angle[i];
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  }, [data, count]);

  const camera = useThree((s) => s.camera);
  useFrame(() => {
    if (mesh.current) mesh.current.visible = camera.zoom >= DETAIL_ZOOM;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, count]} renderOrder={1.6} raycast={noRaycast} frustumCulled={false} />;
}

// ---------------------------------------------------------------- traffic lights

const LAMP_COLORS = [new Color("#5cbf73"), new Color("#f0b43c"), new Color("#e0473a")];

/** A post with the box of lights on top; the lamp is a separate mesh so its colour can change. */
function createPostGeometry(): BufferGeometry {
  return mergeGeometries([
    new BoxGeometry(0.35, 4.2, 0.35).translate(0, 2.1, 0),
    new BoxGeometry(0.8, 2.2, 0.8).translate(0, 5.1, 0),
  ]);
}

export function TrafficLights({ data }: { data: StreetData["lights"] }) {
  const posts = useRef<InstancedMesh>(null);
  const lamps = useRef<InstancedMesh>(null);
  const postGeometry = useMemo(createPostGeometry, []);
  // Bigger than a real lamp: at this scale a real one would not be seen.
  const lampGeometry = useMemo(() => new BoxGeometry(1.1, 1.1, 1.1), []);
  const count = data.x.length;
  const axis = useMemo(() => Uint8Array.from(data.angle, axisOf), [data]);
  const shown = useMemo(() => new Int8Array(count).fill(-1), [count]);

  useLayoutEffect(() => {
    const o = new Object3D();
    for (let i = 0; i < count; i++) {
      o.position.set(data.x[i], 0, -data.y[i]);
      o.updateMatrix();
      posts.current?.setMatrixAt(i, o.matrix);
      o.position.y = 5.6;
      o.updateMatrix();
      lamps.current?.setMatrixAt(i, o.matrix);
    }
    if (posts.current) posts.current.instanceMatrix.needsUpdate = true;
    if (lamps.current) lamps.current.instanceMatrix.needsUpdate = true;
    shown.fill(-1);
  }, [data, count, shown]);

  const camera = useThree((s) => s.camera);
  useFrame(() => {
    const p = posts.current;
    const l = lamps.current;
    if (!p || !l) return;
    const visible = camera.zoom >= DETAIL_ZOOM;
    p.visible = visible;
    l.visible = visible;
    if (!visible) return;
    const time = shared.uTime.value;
    let changed = false;
    for (let i = 0; i < count; i++) {
      const state = lightState(data.junction[i], axis[i], time);
      if (state !== shown[i]) {
        shown[i] = state;
        l.setColorAt(i, LAMP_COLORS[state]);
        changed = true;
      }
    }
    if (changed && l.instanceColor) l.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={posts} args={[postGeometry, undefined, count]} raycast={noRaycast} frustumCulled={false}>
        <meshLambertMaterial color="#5d6066" />
      </instancedMesh>
      <instancedMesh ref={lamps} args={[lampGeometry, undefined, count]} raycast={noRaycast} frustumCulled={false}>
        <meshBasicMaterial />
      </instancedMesh>
    </>
  );
}

// ---------------------------------------------------------------- Vasco da Gama bridge

const PILLAR_EVERY_M = 80;

/** The stretch of the Vasco da Gama bridge inside the map: two decks with traffic, on pillars. */
export function VascoDaGama({ bridge }: { bridge: StreetData["bridge"] }) {
  const { decks, pillars, material } = useMemo(() => {
    const material = createTrafficMaterial();
    const decks = buildRibbons(
      bridge.lines.map((line) => ({ points: line.flat(), cls: 0 })),
      [7.5],
      bridge.deck,
    );
    // Pillars under each deck at even steps along it.
    const parts: BufferGeometry[] = [];
    for (const line of bridge.lines) {
      let carry = PILLAR_EVERY_M / 2;
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1];
        const [bx, by] = line[i];
        const len = Math.hypot(bx - ax, by - ay);
        const heading = Math.atan2(by - ay, bx - ax);
        for (let d = carry; d < len; d += PILLAR_EVERY_M) {
          const t = d / len;
          const pillar = new BoxGeometry(3, bridge.deck + 2, 9);
          pillar.rotateY(heading);
          pillar.translate(ax + (bx - ax) * t, (bridge.deck - 2) / 2 - 0.6, -(ay + (by - ay) * t));
          parts.push(pillar);
        }
        carry = (carry - len) % PILLAR_EVERY_M;
        if (carry < 0) carry += PILLAR_EVERY_M;
      }
    }
    return { decks, pillars: parts.length ? mergeGeometries(parts) : null, material };
  }, [bridge]);

  return (
    <>
      <mesh geometry={decks} material={material} raycast={noRaycast} />
      {pillars && (
        <mesh geometry={pillars} raycast={noRaycast}>
          <meshLambertMaterial color="#d9d5cc" />
        </mesh>
      )}
    </>
  );
}

// ---------------------------------------------------------------- buses

const BUSES_PER_KM = 0.09;
const BUS_SPEED = 8; // m/s
const STOP_EVERY_M = 420;
const STOP_S = 10;

/** A city bus: yellow, no logos; windows in a dark band, a light roof. */
function createBusGeometry(): BufferGeometry {
  const tint = (g: BufferGeometry, color: string) => {
    const c = new Color(color);
    const n = g.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new BufferAttribute(colors, 3));
    return g;
  };
  return mergeGeometries([
    tint(new BoxGeometry(14, 2.0, 3.4).translate(0, 1.6, 0).toNonIndexed(), "#e3c35a"),
    tint(new BoxGeometry(13.6, 1.3, 3.3).translate(0, 3.25, 0).toNonIndexed(), "#3b4651"),
    tint(new BoxGeometry(14, 0.5, 3.4).translate(0, 4.15, 0).toNonIndexed(), "#ece8de"),
    tint(new BoxGeometry(1.6, 1.4, 3.5).translate(3.6, 0.7, 0).toNonIndexed(), "#1b1c1f"),
    tint(new BoxGeometry(1.6, 1.4, 3.5).translate(-4, 0.7, 0).toNonIndexed(), "#1b1c1f"),
  ]);
}

interface BusLine {
  points: ArrayLike<number>;
  lengths: Float32Array;
  total: number;
}

function toLine(points: ArrayLike<number>): BusLine {
  const n = points.length / 2;
  const lengths = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    lengths[i] = lengths[i - 1] + Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
  }
  return { points, lengths, total: lengths[n - 1] };
}

/**
 * Distance travelled along a line after `time` seconds by a bus that stops for
 * STOP_S seconds every STOP_EVERY_M metres, going to the end and back.
 */
function busDistance(total: number, time: number): { distance: number; back: boolean } {
  const legTime = STOP_EVERY_M / BUS_SPEED + STOP_S;
  const oneWay = (total / STOP_EVERY_M) * legTime;
  const t = time % (2 * oneWay);
  const back = t >= oneWay;
  const u = back ? t - oneWay : t;
  const legs = Math.floor(u / legTime);
  const d = Math.min(total, legs * STOP_EVERY_M + Math.min(STOP_EVERY_M, (u - legs * legTime) * BUS_SPEED));
  return { distance: back ? total - d : d, back };
}

/** Yellow buses on the real bus lines, stopping every few hundred metres. */
export function Buses({ lines }: { lines: Polyline[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(createBusGeometry, []);
  const fleet = useMemo(() => {
    const paths = lines.map((l) => toLine(l.points)).filter((l) => l.total > 1000);
    const buses: { line: number; offset: number }[] = [];
    paths.forEach((path, line) => {
      const n = Math.max(1, Math.round((path.total / 1000) * BUSES_PER_KM));
      for (let k = 0; k < n; k++) buses.push({ line, offset: (k / n) * 3000 + line * 53 });
    });
    return { paths, buses };
  }, [lines]);

  const dummy = useMemo(() => new Object3D(), []);
  const view = useViewBox();

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const { box, zoom } = view();
    if (zoom < 0.35) {
      m.count = 0;
      return;
    }
    const time = shared.uTime.value;
    let shown = 0;
    for (const bus of fleet.buses) {
      const path = fleet.paths[bus.line];
      const { distance, back } = busDistance(path.total, time + bus.offset);
      const { points, lengths } = path;
      let k = 1;
      while (k < lengths.length - 1 && lengths[k] < distance) k++;
      const t = (distance - lengths[k - 1]) / (lengths[k] - lengths[k - 1] || 1);
      const ax = points[(k - 1) * 2];
      const ay = points[(k - 1) * 2 + 1];
      const bx = points[k * 2];
      const by = points[k * 2 + 1];
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
      let heading = Math.atan2(by - ay, bx - ax);
      if (back) heading += Math.PI;
      // Keep to the right-hand side.
      dummy.position.set(x + Math.sin(heading) * 2.6, 0.45, -(y - Math.cos(heading) * 2.6));
      dummy.rotation.y = heading;
      dummy.updateMatrix();
      m.setMatrixAt(shown++, dummy.matrix);
    }
    m.count = shown;
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, fleet.buses.length]} raycast={noRaycast} frustumCulled={false}>
      <meshLambertMaterial vertexColors />
    </instancedMesh>
  );
}
