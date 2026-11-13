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
  Points,
  ShaderMaterial,
  BufferAttribute,
  BufferGeometry,
  Color,
  MeshBasicMaterial,
  Object3D,
  Vector3,
  type InstancedMesh,
  type OrthographicCamera,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createFlatMaterial, createLightMaterial, quality, shared } from "../city/environment";
import { createCalcadaMaterial, createTrafficMaterial } from "../city/groundMaterials";
import { buildRibbons, loadLines, type Polyline } from "../city/lines";

const noRaycast = () => null;

export interface StreetData {
  crossings: { x: Float32Array; y: Float32Array; angle: Float32Array; kind: Uint8Array };
  lights: { x: Float32Array; y: Float32Array; angle: Float32Array; junction: Uint16Array };
  squares: number[][][];
  bridge: { deck: number; lines: number[][][]; span?: number[][][] };
  bus: Polyline[];
  funiculars: { name: string; points: number[][] }[];
  /** The Santa Justa lift, [x, y] in map metres. */
  santaJusta: [number, number] | null;
  /** Miradouros, [x, y]. */
  viewpoints: number[][];
  /** Cafés, restaurants and bars with tables outside, [x, y]. */
  terraces: number[][];
  cycle: Polyline[];
  /** Statues, columns, obelisks, busts and sculptures: [x, y, kind, height] (kinds in 07_street.py). */
  monuments: number[][];
  /** Hand-made landmarks: {name: [x, y, angle, length, width]} (07_street.py). */
  landmarks: Record<string, number[]>;
}

interface StreetIndex {
  file: string;
  unitsPerMetre: number;
  bus: { file: string; unitsPerMetre: number };
  squares: number[][][];
  vascoDaGama: { deck: number; lines: number[][][]; span?: number[][][] };
  funiculars?: { name: string; points: number[][] }[];
  santaJusta?: [number, number] | null;
  viewpoints?: number[][];
  terraces?: number[][];
  cycle?: { file: string; unitsPerMetre: number };
  monuments?: number[][];
  landmarks?: Record<string, number[]>;
}

/** Reads street.json, street.bin and bus.bin (layouts in scripts/07_street.py). */
export async function loadStreet(): Promise<StreetData> {
  const index: StreetIndex = await (await fetch("/data/street.json")).json();
  const [buffer, bus, cycle] = await Promise.all([
    fetch(`/data/${index.file}`).then((r) => r.arrayBuffer()),
    loadLines(index.bus.file, index.bus.unitsPerMetre),
    index.cycle ? loadLines(index.cycle.file, index.cycle.unitsPerMetre) : Promise.resolve([]),
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
    funiculars: index.funiculars ?? [],
    santaJusta: index.santaJusta ?? null,
    viewpoints: index.viewpoints ?? [],
    terraces: index.terraces ?? [],
    cycle,
    monuments: index.monuments ?? [],
    landmarks: index.landmarks ?? {},
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

/** The cable-stayed main bridge: two side spans and the main span between the towers (metres). */
const VDG_SIDE_SPAN_M = 203;
const VDG_MAIN_SPAN_M = 420;
const VDG_TOWER_M = 150;
/** The deck over the main span, high enough for ships; the viaducts are lower. */
const VDG_HIGH_DECK_M = 47;
const VDG_LOW_DECK_M = 14;
const VDG_HALF_WIDTH_M = 17;
const VDG_PIER_EVERY_M = 70;
const VDG_LAMP_EVERY_M = 40;
/** Where the viaduct on land ends the deck comes down to the road on the ground at this slope. */
const VDG_RAMP_SLOPE = 0.07;
const CONCRETE = "#d9d5cc";

/**
 * The Vasco da Gama bridge where it is inside the map: the cable-stayed main
 * bridge off the north shore (two H-shaped towers, fans of stays) and the
 * start of the long viaduct, the deck rising over the shipping channel.
 */
export function VascoDaGama({ bridge }: { bridge: StreetData["bridge"] & { span?: number[][][] } }) {
  const deckMaterial = useMemo(createTrafficMaterial, []);
  const concrete = useMemo(() => createFlatMaterial(CONCRETE), []);
  const stayMaterial = useMemo(() => createFlatMaterial("#e4e6e8", { opacity: 0.9, depthWrite: false }), []);
  const lampLights = useMemo(() => createLightMaterial("#ffb15c"), []);
  const redLights = useMemo(() => createLightMaterial("#ff3a2a", 0.6), []);

  const model = useMemo(() => {
    const spans = bridge.span ?? [];
    // The axis of the main bridge, from its north end to its south end, between the two carriageways.
    const a = spans.length ? [(spans[0][0][0] + (spans[1]?.[1][0] ?? spans[0][0][0])) / 2, (spans[0][0][1] + (spans[1]?.[1][1] ?? spans[0][0][1])) / 2] : null;
    const b = spans.length ? [(spans[0][1][0] + (spans[1]?.[0][0] ?? spans[0][1][0])) / 2, (spans[0][1][1] + (spans[1]?.[0][1] ?? spans[0][1][1])) / 2] : null;
    const length = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
    const ux = a && b ? (b[0] - a[0]) / length : 1;
    const uy = a && b ? (b[1] - a[1]) / length : 0;
    const nx = -uy;
    const ny = ux;
    const mid = VDG_SIDE_SPAN_M + VDG_MAIN_SPAN_M / 2;

    /** Distance along the main bridge from its north end (negative before it). */
    const along = (x: number, y: number) => (a ? (x - a[0]) * ux + (y - a[1]) * uy : 0);
    // The end of the viaduct on land, where the motorway reaches the ground.
    let landEnd = 0;
    for (const line of bridge.lines) for (const [x, y] of line) landEnd = Math.min(landEnd, along(x, y));
    /** Height of the deck at a point: high over the channel, sloping down along the viaducts to the ground. */
    const deckAt = (x: number, y: number) => {
      if (!a) return bridge.deck;
      const s = along(x, y);
      const t = Math.abs(s - mid);
      const half = mid + 10;
      const deck = t <= half ? VDG_HIGH_DECK_M - 3 * (t / half) ** 2 : Math.max(VDG_LOW_DECK_M, VDG_HIGH_DECK_M - 3 - (t - half) * 0.036);
      const rise = (s - landEnd) * VDG_RAMP_SLOPE;
      // Eased at the bottom, so the deck meets the road without a kink.
      return Math.min(deck, rise < 4 ? (rise * rise) / 8 + 0.3 : rise - 2 + 0.3);
    };
    const point = (s: number, side: number, h: number) =>
      a ? new Vector3(a[0] + ux * s + nx * side, h, -(a[1] + uy * s + ny * side)) : new Vector3();

    // Carriageways, resampled every 15 m so the deck can rise and fall.
    const ribbons: Polyline[] = [];
    const edges: number[] = [];
    const piers: BufferGeometry[] = [];
    const lamps: BufferGeometry[] = [];
    for (const line of bridge.lines) {
      const pts: number[] = [];
      const heights: number[] = [];
      for (let i = 1; i < line.length; i++) {
        const [x0, y0] = line[i - 1];
        const [x1, y1] = line[i];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.ceil(len / 15));
        for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
          const x = x0 + ((x1 - x0) * k) / steps;
          const y = y0 + ((y1 - y0) * k) / steps;
          pts.push(x, y);
          heights.push(deckAt(x, y));
        }
      }
      ribbons.push({ points: pts, cls: 0, heights });
      // The concrete edge of the deck, and piers and lamps along the way.
      let run = 0;
      for (let i = 1; i < pts.length / 2; i++) {
        const x0 = pts[i * 2 - 2];
        const y0 = pts[i * 2 - 1];
        const x1 = pts[i * 2];
        const y1 = pts[i * 2 + 1];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        const ox = (-(y1 - y0) / len) * 7.8;
        const oy = ((x1 - x0) / len) * 7.8;
        for (const side of [-1, 1]) {
          edges.push(x0 + ox * side, y0 + oy * side, heights[i - 1], x1 + ox * side, y1 + oy * side, heights[i]);
        }
        run += len;
        const s = along(x1, y1);
        const onMainBridge = s > 15 && s < length - 15;
        if (run >= VDG_PIER_EVERY_M && !onMainBridge && heights[i] > 4) {
          run = 0;
          const h = heights[i];
          piers.push(new BoxGeometry(5, h, 9).rotateY(Math.atan2(y1 - y0, x1 - x0)).translate(x1, h / 2 - 2, -y1));
        }
        if (i % Math.round(VDG_LAMP_EVERY_M / 15) === 0 && heights[i] > 1) {
          lamps.push(new BoxGeometry(1.4, 1.4, 1.4).translate(x1 + ox, heights[i] + 5, -(y1 + oy)));
        }
      }
    }

    // Deck edges: a band of concrete under each side of the road.
    const band: number[] = [];
    for (let i = 0; i < edges.length; i += 6) {
      const [x0, y0, h0, x1, y1, h1] = edges.slice(i, i + 6);
      band.push(x0, h0, -y0, x1, h1, -y1, x1, h1 - 2.4, -y1, x0, h0, -y0, x1, h1 - 2.4, -y1, x0, h0 - 2.4, -y0);
    }
    const bandGeometry = new BufferGeometry();
    bandGeometry.setAttribute("position", new BufferAttribute(new Float32Array(band), 3));

    // Towers and stays of the main bridge.
    const towers: BufferGeometry[] = [];
    const stays: number[] = [];
    const beacons: BufferGeometry[] = [];
    if (a) {
      const heading = Math.atan2(uy, ux);
      for (const s of [VDG_SIDE_SPAN_M, VDG_SIDE_SPAN_M + VDG_MAIN_SPAN_M]) {
        const c = point(s, 0, 0);
        const deck = deckAt(c.x, -c.z);
        const parts: BufferGeometry[] = [];
        for (const side of [-1, 1]) {
          // Each leg narrower towards the top.
          parts.push(new BoxGeometry(8, deck + 4, 6).translate(0, (deck + 4) / 2 - 2, side * VDG_HALF_WIDTH_M));
          parts.push(new BoxGeometry(6, VDG_TOWER_M - deck - 4, 4.5).translate(0, deck + 2 + (VDG_TOWER_M - deck - 4) / 2, side * VDG_HALF_WIDTH_M));
        }
        // Cross beams under the deck and near the top.
        parts.push(new BoxGeometry(5, 4, VDG_HALF_WIDTH_M * 2).translate(0, deck - 4, 0));
        parts.push(new BoxGeometry(4, 5, VDG_HALF_WIDTH_M * 2).translate(0, VDG_TOWER_M - 12, 0));
        // A pier in the water under it.
        parts.push(new BoxGeometry(16, 6, VDG_HALF_WIDTH_M * 2 + 14).translate(0, 1, 0));
        const tower = mergeGeometries(parts.map((p) => p.toNonIndexed()));
        tower.rotateY(heading);
        tower.translate(c.x, 0, c.z);
        towers.push(tower);
        for (const side of [-1, 1]) {
          beacons.push(new BoxGeometry(2.4, 2.4, 2.4).translate(point(s, side * VDG_HALF_WIDTH_M, VDG_TOWER_M + 3).x, VDG_TOWER_M + 3, point(s, side * VDG_HALF_WIDTH_M, 0).z));
          // A fan of stays each way, from high on the tower down to the deck edge.
          for (const dir of [-1, 1]) {
            for (let k = 1; k <= 13; k++) {
              const top = point(s, side * VDG_HALF_WIDTH_M, VDG_TOWER_M - 16 - k * 3.6);
              const ds = s + dir * k * 15;
              const foot = point(ds, side * (VDG_HALF_WIDTH_M - 1.5), 0);
              foot.y = deckAt(foot.x, -foot.z) + 0.5;
              stays.push(top.x, top.y, top.z, foot.x, foot.y, foot.z);
            }
          }
        }
      }
    }
    const stayGeometry = new BufferGeometry();
    stayGeometry.setAttribute("position", new BufferAttribute(new Float32Array(stays), 3));

    return {
      deck: buildRibbons(ribbons, [7.5], 0),
      band: bandGeometry,
      piers: piers.length ? mergeGeometries(piers.map((p) => p.toNonIndexed())) : null,
      towers: towers.length ? mergeGeometries(towers) : null,
      stays: stayGeometry,
      lamps: lamps.length ? mergeGeometries(lamps.map((p) => p.toNonIndexed())) : null,
      beacons: beacons.length ? mergeGeometries(beacons.map((p) => p.toNonIndexed())) : null,
    };
  }, [bridge]);

  return (
    <>
      <mesh geometry={model.deck} material={deckMaterial} raycast={noRaycast} frustumCulled={false} />
      <mesh geometry={model.band} material={concrete} raycast={noRaycast} frustumCulled={false} />
      {model.piers && <mesh geometry={model.piers} material={concrete} raycast={noRaycast} frustumCulled={false} />}
      {model.towers && (
        <mesh geometry={model.towers} raycast={noRaycast} frustumCulled={false}>
          <meshLambertMaterial color={CONCRETE} />
        </mesh>
      )}
      <lineSegments geometry={model.stays} material={stayMaterial} raycast={noRaycast} frustumCulled={false} />
      {model.lamps && <mesh geometry={model.lamps} material={lampLights} renderOrder={4} raycast={noRaycast} frustumCulled={false} />}
      {model.beacons && <mesh geometry={model.beacons} material={redLights} renderOrder={4} raycast={noRaycast} frustumCulled={false} />}
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

export interface BusLine {
  points: ArrayLike<number>;
  lengths: Float32Array;
  total: number;
}

export function toLine(points: ArrayLike<number>): BusLine {
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
export const PEOPLE_COLORS = ["#3d4450", "#6b6e75", "#efece4", "#8a6f5c", "#4f5f74", "#a9a39a", "#2b2d31", "#b38a7a"].map((c) => new Color(c));

/** A person, a little larger than life (like the cars): body, legs, head. */
export function createPersonGeometry(): BufferGeometry {
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
    if (zoom < PEOPLE_ZOOM || quality.level < 2) {
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

  // From further away: every lamp in the city as a point of light, a few pixels wide.
  const far = useMemo(() => {
    const n = lamps.all.length / 3;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const heading = lamps.all[i * 3 + 2];
      positions[i * 3] = lamps.all[i * 3] + Math.cos(heading) * 1.4;
      positions[i * 3 + 1] = LAMP_HEIGHT;
      positions[i * 3 + 2] = -(lamps.all[i * 3 + 1] + Math.sin(heading) * 1.4);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    const material = new ShaderMaterial({
      vertexShader: /* glsl */ `
uniform float uSize;
void main() {
  gl_PointSize = uSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
      fragmentShader: /* glsl */ `
uniform float uNight;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = pow(clamp(1.0 - d, 0.0, 1.0), 1.5) * smoothstep(0.35, 0.8, uNight) * 0.5;
  if (a < 0.01) discard;
  gl_FragColor = vec4(1.0, 0.52, 0.18, a);
  #include <colorspace_fragment>
}
`,
      uniforms: { uNight: shared.uNight, uSize: { value: 4 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    return new Points(geometry, material);
  }, [lamps]);

  const view = useViewBox();
  const gl = useThree((s) => s.gl);
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
    // At night the lights of the whole city stay on when the view is wide; close up, the lamps themselves take over.
    far.visible = !visible && shared.uNight.value > 0.05;
    (far.material as ShaderMaterial).uniforms.uSize.value = Math.min(9, Math.max(3, zoom * 14)) * gl.getPixelRatio();
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
      <primitive object={far} renderOrder={4} raycast={noRaycast} frustumCulled={false} />
    </>
  );
}
