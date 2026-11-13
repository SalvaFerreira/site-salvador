// Street detail from OpenStreetMap: crossings, traffic lights, the calçada of
// the big squares, buses on real bus lines and the end of the Vasco da Gama
// bridge. Data from scripts/07_street.py.
import { useFrame, useThree } from "@react-three/fiber";
import earcut from "earcut";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BoxGeometry,
  PlaneGeometry,
  ShaderMaterial,
  BufferAttribute,
  BufferGeometry,
  Color,
  MeshBasicMaterial,
  Object3D,
  type InstancedMesh,
  type OrthographicCamera,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createFlatMaterial, shared } from "../city/environment";
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
  const material = useMemo(() => createFlatMaterial("#f7f5f0", { depthWrite: false }), []);
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

// ---------------------------------------------------------------- people

/** Pixels per metre below which people are not drawn: they would be a dot of a pixel. */
const PEOPLE_ZOOM = 1.8;
/** Size of the cells streets are filed in, and how far apart walkers are on a street. */
const GRID_M = 250;
const WALKER_EVERY_M = 32;
const MAX_PEOPLE = 4000;
const WALK_SPEED = 1.3; // m/s
const PEOPLE_COLORS = ["#3d4450", "#6b6e75", "#efece4", "#8a6f5c", "#4f5f74", "#a9a39a", "#2b2d31", "#b38a7a"].map((c) => new Color(c));

/** A person, a little larger than life (like the cars): body, legs, head. */
function createPersonGeometry(): BufferGeometry {
  const tint = (g: BufferGeometry, color: string | null) => {
    const n = g.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    // White parts take the colour of each person's clothes.
    const c = new Color(color ?? "#ffffff");
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new BufferAttribute(colors, 3));
    return g;
  };
  return mergeGeometries([
    tint(new BoxGeometry(0.75, 1.1, 0.55).translate(0, 1.45, 0).toNonIndexed(), null),
    tint(new BoxGeometry(0.6, 0.95, 0.45).translate(0, 0.48, 0).toNonIndexed(), "#2f3238"),
    tint(new BoxGeometry(0.5, 0.5, 0.5).translate(0, 2.3, 0).toNonIndexed(), "#d8b8a0"),
  ]).scale(1.4, 1.4, 1.4);
}

/**
 * People walking along the pavements, and crossing at zebra crossings while
 * the crossing is busy (the moments cars stop for, see crossingBusy). Only
 * close up, and only the ones on screen.
 */
export function People({ roads, crossings }: { roads: Polyline[]; crossings: StreetData["crossings"] }) {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(createPersonGeometry, []);
  // Streets with pavements, filed by area so the ones on screen are found quickly.
  const streets = useMemo(() => {
    const list = roads.filter((r) => r.cls >= 1).map((r) => ({ line: toLine(r.points), cls: r.cls }));
    const grid = new Map<number, number[]>();
    list.forEach((s, i) => {
      const n = s.line.lengths.length;
      const x = (s.line.points[0] + s.line.points[(n - 1) * 2]) / 2;
      const y = (s.line.points[1] + s.line.points[(n - 1) * 2 + 1]) / 2;
      const k = Math.floor(x / GRID_M) * 100003 + Math.floor(y / GRID_M);
      const cell = grid.get(k);
      if (cell) cell.push(i);
      else grid.set(k, [i]);
    });
    return { list, grid };
  }, [roads]);
  const dummy = useMemo(() => new Object3D(), []);
  const view = useViewBox();

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const { box, zoom } = view();
    if (zoom < PEOPLE_ZOOM) {
      m.count = 0;
      return;
    }
    const time = shared.uTime.value;
    let shown = 0;
    const place = (x: number, y: number, heading: number, color: Color) => {
      if (shown >= MAX_PEOPLE || x < box[0] || x > box[2] || y < box[1] || y > box[3]) return;
      dummy.position.set(x, 0.45, -y);
      dummy.rotation.y = heading;
      dummy.updateMatrix();
      m.setMatrixAt(shown, dummy.matrix);
      m.setColorAt(shown, color);
      shown++;
    };

    // On the pavements: each street on screen has a walker every WALKER_EVERY_M or
    // so, each going up and down it at its own pace, on either side.
    for (let gx = Math.floor((box[0] - 200) / GRID_M); gx <= Math.floor((box[2] + 200) / GRID_M); gx++) {
      for (let gy = Math.floor((box[1] - 200) / GRID_M); gy <= Math.floor((box[3] + 200) / GRID_M); gy++) {
        for (const index of streets.grid.get(gx * 100003 + gy) ?? []) {
          const { line, cls } = streets.list[index];
          const { points, lengths, total } = line;
          const count = Math.max(1, Math.round(total / WALKER_EVERY_M));
          for (let j = 0; j < count; j++) {
            const r1 = hash(index, j);
            const r2 = hash(j + 0.5, index);
            const speed = WALK_SPEED * (0.75 + 0.5 * r2);
            const run = (r1 * 2 * total + time * speed) % (2 * total);
            const back = run >= total;
            const at = back ? 2 * total - run : run;
            let k = 1;
            while (k < lengths.length - 1 && lengths[k] < at) k++;
            const t = (at - lengths[k - 1]) / (lengths[k] - lengths[k - 1] || 1);
            const ax = points[(k - 1) * 2];
            const ay = points[(k - 1) * 2 + 1];
            const bx = points[k * 2];
            const by = points[k * 2 + 1];
            const len = Math.hypot(bx - ax, by - ay) || 1;
            // Right-hand side of the way they are going, on the pavement.
            const side = (back ? -1 : 1) * (cls === 1 ? 4.4 : 3.1) * (r2 < 0.5 ? 1 : -1);
            const nx = (by - ay) / len;
            const ny = -(bx - ax) / len;
            const heading = Math.atan2(by - ay, bx - ax) + (back ? Math.PI : 0);
            place(ax + (bx - ax) * t + nx * side, ay + (by - ay) * t + ny * side, heading, PEOPLE_COLORS[Math.floor(r1 * 97) % PEOPLE_COLORS.length]);
          }
        }
      }
    }

    // On the zebra crossings, while they are busy: one or two people going over.
    for (let i = 0; i < crossings.x.length; i++) {
      const x = crossings.x[i];
      const y = crossings.y[i];
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3] || !crossingBusy(i, time)) continue;
      const f = ((time + i * 3.7) % CROSSING_SLOT_S) / CROSSING_SLOT_S;
      const a = crossings.angle[i];
      // Across the street is a quarter turn from along it.
      const cx = -Math.sin(a);
      const cy = Math.cos(a);
      const s = -5.5 + 11 * f;
      place(x + cx * s + Math.cos(a) * 0.8, y + cy * s + Math.sin(a) * 0.8, a + Math.PI / 2, PEOPLE_COLORS[i % PEOPLE_COLORS.length]);
      if (i % 2) place(x - cx * s - Math.cos(a) * 0.8, y - cy * s - Math.sin(a) * 0.8, a - Math.PI / 2, PEOPLE_COLORS[(i + 3) % PEOPLE_COLORS.length]);
    }

    m.count = shown;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, MAX_PEOPLE]} raycast={noRaycast} frustumCulled={false}>
      <meshLambertMaterial vertexColors />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- street lamps

/** Pixels per metre below which street lamps are not drawn. */
const LAMP_ZOOM = 1.0;
const LAMP_EVERY_M = 30;
const MAX_LAMPS = 6000;
const LAMP_HEIGHT = 6.5;
/** Distance of a lamp from the middle of the street, per road class (on the pavement). */
const LAMP_SIDE_M = [7.2, 5.6, 4.0];

/** Post and arm, the arm along +x (over the street). */
function createLampPostGeometry(): BufferGeometry {
  return mergeGeometries([
    new BoxGeometry(0.28, LAMP_HEIGHT, 0.28).translate(0, LAMP_HEIGHT / 2, 0),
    new BoxGeometry(1.5, 0.18, 0.18).translate(0.7, LAMP_HEIGHT - 0.1, 0),
  ]);
}

/** The lamp head: grey by day, lit sodium orange at night. */
function createLampHeadMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
void main() {
  vec4 p = instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * p;
}
`,
    fragmentShader: /* glsl */ `
uniform float uNight;

void main() {
  vec3 off = vec3(0.42, 0.43, 0.45);
  vec3 lit = vec3(1.0, 0.72, 0.38) * 1.15;
  gl_FragColor = vec4(mix(off * mix(1.0, 0.3, uNight), lit, smoothstep(0.35, 0.8, uNight)), 1.0);
  #include <colorspace_fragment>
}
`,
    uniforms: { uNight: shared.uNight },
  });
}

/** The pool of light a lamp throws on the pavement at night. */
function createLampPoolMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`,
    fragmentShader: /* glsl */ `
uniform float uNight;
varying vec2 vUv;

void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(clamp(1.0 - d, 0.0, 1.0), 1.6) * 0.6 * smoothstep(0.35, 0.85, uNight);
  if (a < 0.003) discard;
  gl_FragColor = vec4(1.0, 0.55, 0.18, a);
  #include <colorspace_fragment>
}
`,
    uniforms: { uNight: shared.uNight },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

/**
 * Street lamps along the streets, every LAMP_EVERY_M metres, on alternate
 * sides. Off by day, lit at night. Only the ones close to the camera exist:
 * the set is rebuilt when the view moves.
 */
export function StreetLamps({ roads }: { roads: Polyline[] }) {
  const posts = useRef<InstancedMesh>(null);
  const heads = useRef<InstancedMesh>(null);
  const pools = useRef<InstancedMesh>(null);
  const postGeometry = useMemo(createLampPostGeometry, []);
  const headGeometry = useMemo(() => new BoxGeometry(1.0, 0.35, 0.55), []);
  const poolGeometry = useMemo(() => new PlaneGeometry(18, 18).rotateX(-Math.PI / 2), []);
  const headMaterial = useMemo(createLampHeadMaterial, []);
  const poolMaterial = useMemo(createLampPoolMaterial, []);

  // Every lamp in the city, filed by area: x, y and the direction of its arm.
  const lamps = useMemo(() => {
    const grid = new Map<number, number[]>();
    const all: number[] = [];
    roads.forEach((road, r) => {
      const n = road.points.length / 2;
      let carry = (r * 7.3) % LAMP_EVERY_M;
      let side = r % 2 ? 1 : -1;
      for (let k = 1; k < n; k++) {
        const ax = road.points[(k - 1) * 2];
        const ay = road.points[(k - 1) * 2 + 1];
        const bx = road.points[k * 2];
        const by = road.points[k * 2 + 1];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.01) continue;
        const ux = (bx - ax) / len;
        const uy = (by - ay) / len;
        let d = carry;
        for (; d < len; d += LAMP_EVERY_M) {
          const off = LAMP_SIDE_M[Math.min(2, road.cls)] * side;
          const x = ax + ux * d - uy * off;
          const y = ay + uy * d + ux * off;
          // The arm reaches back over the street, towards its middle.
          const i = all.length / 3;
          all.push(x, y, Math.atan2(-ux * side, uy * side));
          const key = Math.floor(x / 250) * 100003 + Math.floor(y / 250);
          const cell = grid.get(key);
          if (cell) cell.push(i);
          else grid.set(key, [i]);
          side = -side;
        }
        carry = d - len;
      }
    });
    return { all: Float32Array.from(all), grid };
  }, [roads]);

  const view = useViewBox();
  const last = useRef({ x: NaN, y: NaN, zoom: NaN });
  const dummy = useMemo(() => new Object3D(), []);

  useFrame(() => {
    const p = posts.current;
    const h = heads.current;
    const l = pools.current;
    if (!p || !h || !l) return;
    const { box, zoom } = view();
    const visible = zoom >= LAMP_ZOOM;
    p.visible = h.visible = l.visible = visible;
    if (!visible) {
      last.current.zoom = NaN;
      return;
    }
    // Rebuild only when the view has moved or zoomed noticeably.
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    const step = (box[2] - box[0]) * 0.08;
    const prev = last.current;
    if (Math.abs(cx - prev.x) < step && Math.abs(cy - prev.y) < step && Math.abs(zoom / prev.zoom - 1) < 0.08) return;
    last.current = { x: cx, y: cy, zoom };

    let count = 0;
    const margin = 120;
    for (let gx = Math.floor((box[0] - margin) / 250); gx <= Math.floor((box[2] + margin) / 250); gx++) {
      for (let gy = Math.floor((box[1] - margin) / 250); gy <= Math.floor((box[3] + margin) / 250); gy++) {
        for (const i of lamps.grid.get(gx * 100003 + gy) ?? []) {
          if (count >= MAX_LAMPS) break;
          const x = lamps.all[i * 3];
          const y = lamps.all[i * 3 + 1];
          const heading = lamps.all[i * 3 + 2];
          dummy.position.set(x, 0.4, -y);
          dummy.rotation.set(0, heading, 0);
          dummy.updateMatrix();
          p.setMatrixAt(count, dummy.matrix);
          // The head at the end of the arm, and the pool of light under it.
          const hx = x + Math.cos(heading) * 1.4;
          const hy = y + Math.sin(heading) * 1.4;
          dummy.position.set(hx, 0.4 + LAMP_HEIGHT - 0.3, -hy);
          dummy.updateMatrix();
          h.setMatrixAt(count, dummy.matrix);
          dummy.position.set(hx, 0.75, -hy);
          dummy.updateMatrix();
          l.setMatrixAt(count, dummy.matrix);
          count++;
        }
      }
    }
    p.count = h.count = l.count = count;
    p.instanceMatrix.needsUpdate = h.instanceMatrix.needsUpdate = l.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={posts} args={[postGeometry, undefined, MAX_LAMPS]} raycast={noRaycast} frustumCulled={false}>
        <meshLambertMaterial color="#6b6f76" />
      </instancedMesh>
      <instancedMesh ref={heads} args={[headGeometry, headMaterial, MAX_LAMPS]} raycast={noRaycast} frustumCulled={false} />
      <instancedMesh ref={pools} args={[poolGeometry, poolMaterial, MAX_LAMPS]} renderOrder={2.5} raycast={noRaycast} frustumCulled={false} />
    </>
  );
}
