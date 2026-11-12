// What moves in the city: cars, trams, trains, boats on the Tejo and a plane
// coming in to land. All of it keeps moving for every visitor; reduced motion
// only changes how the camera travels (see City.tsx).
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Matrix4,
  Object3D,
  PlaneGeometry,
  type Group,
  type InstancedMesh,
  type Mesh,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { shared } from "../city/environment";
import { createRunwayMaterial, createShadowMaterial, createTrackMaterial, createTrussMaterial } from "../city/groundMaterials";
import { buildRibbons, loadLines, type Polyline } from "../city/lines";
import { SHADOW_PER_M } from "../city/loadCity";
import { COVER, randomFrom, scatterOver, type CoverData } from "./Extras";
import { AMBER, axisOf, crossingBusy, lightState, RED, useViewBox, type StreetData } from "./Street";

const noRaycast = () => null;
const WATER_Y = -2;

// ---------------------------------------------------------------- paths

/**
 * A line to travel along: points in map metres (x east, y north), optionally
 * followed by a height and by a flag that is 1 where the line is out of sight (a tunnel).
 */
interface Path {
  points: ArrayLike<number>;
  stride: number;
  lengths: Float32Array;
  total: number;
}

function toPath(points: ArrayLike<number>, stride: number): Path {
  const n = points.length / stride;
  const lengths = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    lengths[i] =
      lengths[i - 1] +
      Math.hypot(points[i * stride] - points[(i - 1) * stride], points[i * stride + 1] - points[(i - 1) * stride + 1]);
  }
  return { points, stride, lengths, total: lengths[n - 1] };
}

const flatPath = (points: number[][]) => toPath(points.flat(), points[0]?.length ?? 2);

interface Spot {
  x: number;
  y: number;
  height: number;
  /** Direction of travel, as a rotation about the vertical axis. */
  heading: number;
  /** True in a tunnel. */
  hidden?: boolean;
}

/** Where a path is after `distance` metres. Writes into `out`. */
function along(path: Path, distance: number, out: Spot): Spot {
  const { points, stride, lengths } = path;
  const n = lengths.length;
  const d = Math.min(path.total, Math.max(0, distance));
  let k = 1;
  while (k < n - 1 && lengths[k] < d) k++;
  const t = (d - lengths[k - 1]) / (lengths[k] - lengths[k - 1] || 1);
  const ax = points[(k - 1) * stride];
  const ay = points[(k - 1) * stride + 1];
  const bx = points[k * stride];
  const by = points[k * stride + 1];
  out.x = ax + (bx - ax) * t;
  out.y = ay + (by - ay) * t;
  out.height = stride >= 3 ? points[(k - 1) * stride + 2] + (points[k * stride + 2] - points[(k - 1) * stride + 2]) * t : 0;
  out.hidden = stride >= 4 && points[(t < 0.5 ? k - 1 : k) * stride + 3] > 0.5;
  out.heading = Math.atan2(by - ay, bx - ax);
  return out;
}

/**
 * Back and forth along a path: distance from the start after `time` seconds,
 * and whether it is on the way back. `dwell` seconds are spent at each end.
 */
function shuttle(total: number, speed: number, time: number, dwell = 0): { distance: number; returning: boolean } {
  const leg = total / speed + dwell;
  const phase = time % (2 * leg);
  const returning = phase >= leg;
  const moving = Math.min(total / speed, returning ? phase - leg : phase);
  return { distance: returning ? total - moving * speed : moving * speed, returning };
}

/** One colour for a whole geometry, so differently coloured parts can be merged into one mesh. */
function tinted(geometry: BufferGeometry, color: string): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const c = new Color(color);
  const colors = new Float32Array(g.getAttribute("position").count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute("color", new BufferAttribute(colors, 3));
  g.deleteAttribute("uv");
  return g;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string) =>
  tinted(new BoxGeometry(w, h, d).translate(x, y, z), color);

// ---------------------------------------------------------------- cars

const CAR_COUNT = 4000;
/** Local streets carry cars only this close to the centre (metres from the Baixa). */
const LOCAL_STREETS_WITHIN_M = 2200;
const CAR_COLORS = ["#f1f1ee", "#f1f1ee", "#b9bcc0", "#74787d", "#1f2124", "#a4776e", "#76869b", "#d8c98f"].map(
  (c) => new Color(c),
);

interface Way extends Path {
  cls: number;
  /** Ways that start where this one ends. */
  next: number[];
}

/**
 * Streets as one-way stretches a car can follow, each linked to the ones that
 * continue from its end, so cars keep driving from street to street.
 */
function buildWays(roads: Polyline[]): Way[] {
  const ways: Way[] = [];
  const twin: number[] = [];
  for (const road of roads) {
    const n = road.points.length / 2;
    if (road.cls === 2) {
      const mx = road.points[0];
      const my = road.points[1] - 350;
      if (Math.hypot(mx, my) > LOCAL_STREETS_WITHIN_M) continue;
    }
    const forward = toPath(road.points, 2);
    if (forward.total < 30) continue;
    ways.push({ ...forward, cls: road.cls, next: [] });
    twin.push(-1);
    // Main roads are mapped one carriageway at a time; smaller streets are two-way.
    if (road.cls >= 1) {
      const reversed = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        reversed[i * 2] = road.points[(n - 1 - i) * 2];
        reversed[i * 2 + 1] = road.points[(n - 1 - i) * 2 + 1];
      }
      ways.push({ ...toPath(reversed, 2), cls: road.cls, next: [] });
      twin[twin.length - 1] = ways.length - 1;
      twin.push(ways.length - 2);
    }
  }
  const key = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
  const starts = new Map<string, number[]>();
  ways.forEach((w, i) => {
    const k = key(w.points[0], w.points[1]);
    const list = starts.get(k);
    if (list) list.push(i);
    else starts.set(k, [i]);
  });
  ways.forEach((w, i) => {
    const end = w.points.length - 2;
    // Carry on along any street that starts here, except straight back the way it came.
    w.next = (starts.get(key(w.points[end], w.points[end + 1])) ?? []).filter((j) => j !== twin[i]);
  });
  return ways;
}

/**
 * A small car, nose along +x, standing on the ground. White parts take the
 * colour of each car; the cabin and wheels stay dark.
 */
function createCarGeometry(): BufferGeometry {
  return mergeGeometries([
    box(7.6, 1.5, 3.3, 0, 1.25, 0, "#ffffff"), // body
    box(1.6, 0.5, 3.1, 3.2, 0.95, 0, "#ffffff"), // lower nose
    box(3.9, 1.25, 2.9, -0.5, 2.6, 0, "#39424d"), // cabin and windows
    box(3.5, 0.2, 2.6, -0.5, 3.3, 0, "#ffffff"), // roof
    box(1.5, 1.1, 3.5, 2.3, 0.55, 0, "#1b1c1f"), // front wheels
    box(1.5, 1.1, 3.5, -2.4, 0.55, 0, "#1b1c1f"), // rear wheels
  ]);
}

/** Where a car may have to stop on a way: distance along it, and what is there. */
interface Stops {
  at: Float32Array;
  /** A light: 1 + (junction * 2 + direction). A zebra crossing: -(1 + its index). */
  code: Int32Array;
}

/** How close to a way a traffic light or a crossing must be to count for it, in metres. */
const LIGHT_NEAR_M = 9;
const CROSSING_NEAR_M = 4;

/** The lights and zebra crossings along each way, in order. */
function findStops(ways: Way[], street: StreetData): Stops[] {
  const CELL = 40;
  const grid = new Map<number, number[]>();
  const add = (x: number, y: number, item: number) => {
    const k = Math.floor(x / CELL) * 100003 + Math.floor(y / CELL);
    const list = grid.get(k);
    if (list) list.push(item);
    else grid.set(k, [item]);
  };
  const { lights, crossings } = street;
  const nLights = lights.x.length;
  // Items: lights as 0..L-1, zebra crossings after them (crossings at traffic lights follow the lights).
  for (let i = 0; i < nLights; i++) add(lights.x[i], lights.y[i], i);
  for (let i = 0; i < crossings.x.length; i++) if (crossings.kind[i] === 0) add(crossings.x[i], crossings.y[i], nLights + i);

  return ways.map((w) => {
    const found = new Map<number, { at: number; code: number }>();
    const n = w.lengths.length;
    for (let k = 1; k < n; k++) {
      const ax = w.points[(k - 1) * 2];
      const ay = w.points[(k - 1) * 2 + 1];
      const bx = w.points[k * 2];
      const by = w.points[k * 2 + 1];
      const len = w.lengths[k] - w.lengths[k - 1] || 1;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const heading = Math.atan2(uy, ux);
      const x0 = Math.floor((Math.min(ax, bx) - LIGHT_NEAR_M) / CELL);
      const x1 = Math.floor((Math.max(ax, bx) + LIGHT_NEAR_M) / CELL);
      const y0 = Math.floor((Math.min(ay, by) - LIGHT_NEAR_M) / CELL);
      const y1 = Math.floor((Math.max(ay, by) + LIGHT_NEAR_M) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          for (const item of grid.get(cx * 100003 + cy) ?? []) {
            const light = item < nLights;
            const x = light ? lights.x[item] : crossings.x[item - nLights];
            const y = light ? lights.y[item] : crossings.y[item - nLights];
            const t = (x - ax) * ux + (y - ay) * uy;
            if (t < 0 || t > len) continue;
            const off = Math.abs((x - ax) * uy - (y - ay) * ux);
            if (off > (light ? LIGHT_NEAR_M : CROSSING_NEAR_M)) continue;
            // One stop per junction: the first of its lights the car comes to.
            const key = light ? -1 - lights.junction[item] : item;
            if (found.has(key)) continue;
            const code = light ? 1 + lights.junction[item] * 2 + axisOf(heading) : -(1 + item - nLights);
            found.set(key, { at: w.lengths[k - 1] + t, code });
          }
        }
      }
    }
    const list = [...found.values()].sort((p, q) => p.at - q.at);
    return { at: Float32Array.from(list, (f) => f.at), code: Int32Array.from(list, (f) => f.code) };
  });
}

/**
 * Cars driving through the city, from street to street. They stop at red
 * lights and at zebra crossings while someone is crossing, one to three car
 * lengths back so that a few waiting cars look like a queue (cars do not
 * otherwise see each other). Only the cars on screen are drawn.
 */
export function Cars({ roads, street }: { roads: Polyline[]; street: StreetData | null }) {
  const mesh = useRef<InstancedMesh>(null);
  const state = useMemo(() => {
    const ways = buildWays(roads);
    const random = randomFrom(7);
    const total = ways.reduce((sum, w) => sum + w.total, 0);
    const count = ways.length ? CAR_COUNT : 0;
    const way = new Int32Array(count);
    const distance = new Float32Array(count);
    const speed = new Float32Array(count);
    const next = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      // More cars on longer streets.
      let target = random() * total;
      let pick = 0;
      for (let w = 0; w < ways.length; w++) {
        pick = w;
        target -= ways[w].total;
        if (target <= 0) break;
      }
      way[i] = pick;
      distance[i] = random() * ways[pick].total;
      speed[i] = 0.8 + random() * 0.4;
    }
    const colorRandom = randomFrom(99);
    const colors = Array.from({ length: count }, () => CAR_COLORS[Math.floor(colorRandom() * CAR_COLORS.length)]);
    return { ways, way, distance, speed, next, count, random, colors };
  }, [roads]);
  const stops = useMemo(() => (street ? findStops(state.ways, street) : null), [state, street]);

  const dummy = useMemo(() => new Object3D(), []);
  const spot = useMemo<Spot>(() => ({ x: 0, y: 0, height: 0, heading: 0 }), []);
  const geometry = useMemo(createCarGeometry, []);
  const view = useViewBox();

  useFrame((_, delta) => {
    const m = mesh.current;
    if (!m || !state.count) return;
    // A long pause (a hidden tab) must not send every car flying down the road.
    const dt = Math.min(delta, 0.1);
    const time = shared.uTime.value;
    const { ways, way, distance, speed, next, random, colors } = state;
    const { box, zoom } = view();
    // In the widest view a car would be a pixel or two: they keep driving but are not drawn.
    const draw = zoom >= 0.3;
    let shown = 0;
    for (let i = 0; i < state.count; i++) {
      let w = ways[way[i]];
      const base = w.cls === 0 ? 14 : w.cls === 1 ? 9 : 6; // m/s
      let step = base * speed[i] * dt;

      const s = stops?.[way[i]];
      if (s) {
        while (next[i] < s.at.length && s.at[next[i]] < distance[i] + 0.5) next[i]++;
        if (next[i] < s.at.length) {
          const code = s.code[next[i]];
          const gap = s.at[next[i]] - distance[i] - (3 + (i % 3) * 8.5);
          let closed: boolean;
          if (code > 0) {
            const light = lightState(Math.floor((code - 1) / 2), (code - 1) % 2, time);
            // On amber, a car too close to stop carries on.
            closed = light === RED || (light === AMBER && gap > 8);
          } else closed = crossingBusy(-code - 1, time);
          if (closed && gap < 40) step = Math.min(step, Math.max(0, gap) * 2.5 * dt);
        }
      }

      distance[i] += step;
      while (distance[i] > w.total) {
        distance[i] -= w.total;
        // Turn into a street that continues from here; at a dead end, start again somewhere else.
        if (w.next.length) way[i] = w.next[Math.floor(random() * w.next.length)];
        else {
          way[i] = Math.floor(random() * ways.length);
          distance[i] = 0;
        }
        next[i] = 0;
        w = ways[way[i]];
      }
      if (!draw) continue;
      along(w, distance[i], spot);
      if (spot.x < box[0] || spot.x > box[2] || spot.y < box[1] || spot.y > box[3]) continue;
      // Keep to the right-hand side of the road.
      const side = w.cls === 2 ? 1.6 : 2.4;
      dummy.position.set(spot.x + Math.sin(spot.heading) * side, 0.45, -(spot.y - Math.cos(spot.heading) * side));
      dummy.rotation.y = spot.heading;
      dummy.updateMatrix();
      m.setMatrixAt(shown, dummy.matrix);
      m.setColorAt(shown, colors[i]);
      shown++;
    }
    m.count = shown;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  if (!state.count) return null;
  return (
    // Larger than life, like everything that moves here: at city scale a real car is a speck.
    <instancedMesh ref={mesh} args={[geometry, undefined, state.count]} raycast={noRaycast} frustumCulled={false}>
      <meshLambertMaterial vertexColors />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- trams

const TRAM_SPEED = 7; // m/s

/** A Lisbon tram: yellow below, white above, a band of windows between. */
function createTramGeometry(): BufferGeometry {
  return mergeGeometries([
    box(17, 2.2, 3.4, 0, 1.6, 0, "#dcc684"),
    box(16.4, 1.3, 3.2, 0, 3.35, 0, "#3b4651"),
    box(17, 0.7, 3.4, 0, 4.35, 0, "#f4f1e8"),
    box(9, 0.5, 1.4, 0, 4.95, 0, "#d9d5ca"),
  ]);
}

/** Yellow trams going back and forth on real track around the centre. */
export function Trams({ routes }: { routes: number[][][] }) {
  const group = useRef<Group>(null);
  const paths = useMemo(() => routes.map(flatPath), [routes]);
  const spot = useMemo<Spot>(() => ({ x: 0, y: 0, height: 0, heading: 0 }), []);
  const geometry = useMemo(createTramGeometry, []);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    paths.forEach((path, i) => {
      const tram = g.children[i];
      // Each tram starts at a different point of its line.
      const { distance } = shuttle(path.total, TRAM_SPEED, shared.uTime.value + i * 97 + 60, 8);
      along(path, distance, spot);
      tram.position.set(spot.x, 0, -spot.y);
      tram.rotation.y = spot.heading;
    });
  });

  return (
    <group ref={group}>
      {paths.map((_, i) => (
        <mesh key={i} geometry={geometry} raycast={noRaycast}>
          <meshLambertMaterial vertexColors />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- trains

const TRAIN_SPEED = 21; // m/s
const CARRIAGES = 5;
/** Distance between the centres of two carriages: they are coupled, almost touching. */
const CARRIAGE_GAP_M = 30;
/** Livery of the lower body, by line. */
const TRAIN_COLORS: Record<string, string> = {
  "Linha de Cascais": "#d9c88f",
  "Linha de Sintra": "#d9c88f",
  "Linha de Cintura": "#d9c88f",
  "Linha do Sul": "#8a9db8",
  "Linha do Norte": "#93a68a",
};

/** The truss of the bridge: where it starts (track height), how far from the track, how tall. */
const TRUSS_FROM_M = 55;
const TRUSS_HALF_WIDTH = 11;
const TRUSS_HEIGHT = 8.5;

/** Half width of the ballast bed of one track, in metres. */
const TRACK_HALF_WIDTH = [2.7, 2.4];
/** Top of the ballast above the ground. */
const TRACK_Y = 0.45;

/**
 * The railway itself: every track above ground, with ballast, sleepers and
 * rails, plus the stretch that climbs onto the bridge's rail deck.
 */
export function Tracks({ file, unitsPerMetre, routes }: { file: string; unitsPerMetre: number; routes: TrainRoute[] }) {
  const material = useMemo(createTrackMaterial, []);
  const [ground, setGround] = useState<BufferGeometry | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLines(file, unitsPerMetre).then((lines) => !cancelled && setGround(buildRibbons(lines, TRACK_HALF_WIDTH, TRACK_Y)));
    return () => {
      cancelled = true;
    };
  }, [file, unitsPerMetre]);

  // On the bridge the track is taken from the train's own route, which carries the heights.
  const raised = useMemo(() => {
    const lines: Polyline[] = [];
    for (const route of routes) {
      let run: number[][] = [];
      const flush = () => {
        if (run.length > 1) lines.push({ points: run.flatMap((p) => [p[0], p[1]]), heights: run.map((p) => p[2]), cls: 0 });
        run = [];
      };
      for (const point of route.points) {
        if (point[2] > 0.3) run.push(point);
        else flush();
      }
      flush();
    }
    return lines.length ? buildRibbons(lines, [3.4], TRACK_Y) : null;
  }, [routes]);

  // The bridge carries the railway inside a steel truss under the road: two
  // upright lattices, one on each side of the raised track.
  const truss = useMemo(() => {
    const position: number[] = [];
    const uv: number[] = [];
    for (const route of routes) {
      let along = 0;
      for (let i = 1; i < route.points.length; i++) {
        const [ax, ay, ah] = route.points[i - 1];
        const [bx, by, bh] = route.points[i];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        // Only where the track is at full deck height, not on the ramps.
        if (ah > TRUSS_FROM_M && bh > TRUSS_FROM_M) {
          const nx = (-(by - ay) / len) * TRUSS_HALF_WIDTH;
          const ny = ((bx - ax) / len) * TRUSS_HALF_WIDTH;
          for (const side of [-1, 1]) {
            const corners = [
              [ax + nx * side, ah, ay + ny * side, along, 0],
              [bx + nx * side, bh, by + ny * side, along + len, 0],
              [bx + nx * side, bh + TRUSS_HEIGHT, by + ny * side, along + len, 1],
              [ax + nx * side, ah + TRUSS_HEIGHT, ay + ny * side, along, 1],
            ];
            for (const k of [0, 1, 2, 0, 2, 3]) {
              position.push(corners[k][0], corners[k][1], -corners[k][2]);
              uv.push(corners[k][3], corners[k][4]);
            }
          }
        }
        along += len;
      }
    }
    if (!position.length) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(position), 3));
    geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
    return geometry;
  }, [routes]);
  const trussMaterial = useMemo(createTrussMaterial, []);

  return (
    <>
      {/* Drawn after the streets, so the track crosses over them. */}
      {ground && <mesh geometry={ground} material={material} renderOrder={1.5} raycast={noRaycast} frustumCulled={false} />}
      {raised && <mesh geometry={raised} material={material} renderOrder={1.5} raycast={noRaycast} frustumCulled={false} />}
      {truss && <mesh geometry={truss} material={trussMaterial} raycast={noRaycast} frustumCulled={false} />}
    </>
  );
}

const TRAIN_SCALE = 1.25;

/**
 * A railway carriage, nose along +x, wheels on the rail. White parts take the
 * colour of the line; underframe, windows and roof gear stay dark.
 */
function createCarriageGeometry(): BufferGeometry {
  return mergeGeometries([
    box(4.5, 0.9, 2.2, 7, 0.55, 0, "#26282c"), // bogies
    box(4.5, 0.9, 2.2, -7, 0.55, 0, "#26282c"),
    box(23.4, 0.5, 2.9, 0, 1.2, 0, "#3a3d42"), // underframe
    box(23.4, 1.1, 3.0, 0, 2.0, 0, "#ffffff"), // lower body, in the line's colour
    box(22.6, 1.0, 3.02, 0, 3.05, 0, "#2f3740"), // windows
    box(23.4, 0.45, 3.0, 0, 3.78, 0, "#f3f1ea"), // band over the windows
    box(22.8, 0.4, 2.5, 0, 4.2, 0, "#9a9ea5"), // roof
    box(3.2, 0.35, 1.4, -4.5, 4.55, 0, "#7b7f86"), // roof equipment
    box(2.2, 0.35, 1.4, 5.5, 4.55, 0, "#7b7f86"),
  ]);
}

export interface TrainRoute {
  name: string;
  /** [x, y, height, hidden] in map metres; hidden is 1 in tunnels. */
  points: number[][];
}

/**
 * Trains on the real tracks, two per line. They climb onto the bridge's rail
 * deck, and are out of sight while in a tunnel.
 */
export function Trains({ routes }: { routes: TrainRoute[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const paths = useMemo(() => routes.map((r) => flatPath(r.points)), [routes]);
  const count = routes.length * 2 * CARRIAGES;
  const geometry = useMemo(createCarriageGeometry, []);
  const dummy = useMemo(() => new Object3D(), []);
  const hidden = useMemo(() => new Matrix4().makeScale(0, 0, 0), []);
  const spot = useMemo<Spot>(() => ({ x: 0, y: 0, height: 0, heading: 0 }), []);

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const color = new Color();
    routes.forEach((route, r) => {
      for (let i = 0; i < 2 * CARRIAGES; i++) m.setColorAt(r * 2 * CARRIAGES + i, color.set(TRAIN_COLORS[route.name] ?? "#ece9e1"));
    });
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [routes]);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    paths.forEach((path, r) => {
      for (let train = 0; train < 2; train++) {
        // The second train of each line runs half a round trip behind the first.
        const offset = r * 53 + train * (path.total / TRAIN_SPEED + 15);
        const { distance, returning } = shuttle(path.total, TRAIN_SPEED, shared.uTime.value + offset + 30, 15);
        for (let c = 0; c < CARRIAGES; c++) {
          along(path, distance + (returning ? c : -c) * CARRIAGE_GAP_M, spot);
          dummy.position.set(spot.x, spot.height + TRACK_Y, -spot.y);
          dummy.rotation.y = spot.heading;
          dummy.scale.setScalar(TRAIN_SCALE);
          dummy.updateMatrix();
          m.setMatrixAt((r * 2 + train) * CARRIAGES + c, spot.hidden ? hidden : dummy.matrix);
        }
      }
    });
    m.instanceMatrix.needsUpdate = true;
  });

  if (!count) return null;
  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, count]} raycast={noRaycast} frustumCulled={false}>
      <meshLambertMaterial vertexColors />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- boats

const FERRY_SPEED = 6; // m/s
const SAIL_SPEED = 2.2;

/** Orange and white river ferry. Its bow points along +x. */
function createFerryGeometry(): BufferGeometry {
  return mergeGeometries([
    box(30, 3, 9, 0, 1.5, 0, "#f3f1ea"),
    box(20, 2.6, 7, -1, 4.3, 0, "#c9ab95"),
    box(6, 2, 5, 4, 6.6, 0, "#f3f1ea"),
  ]);
}

/** Small sailing boat: hull and one triangular sail. */
function createSailGeometry(): BufferGeometry {
  const sail = new BufferGeometry();
  sail.setAttribute("position", new BufferAttribute(new Float32Array([1.5, 1.4, 0, 1.5, 12, 0, -4, 1.4, 0]), 3));
  sail.computeVertexNormals();
  return mergeGeometries([box(10, 1.4, 3, 0, 0.7, 0, "#f6f4ee"), tinted(sail, "#ffffff")]);
}

interface Boat {
  path: Path;
  /** Drawn this many times its real size, so it can be seen on a river two kilometres wide. */
  scale: number;
  speed: number;
  dwell: number;
  offset: number;
  wake: number;
}

function Fleet({ boats, geometry, wakeWidth }: { boats: Boat[]; geometry: BufferGeometry; wakeWidth: number }) {
  const hulls = useRef<InstancedMesh>(null);
  const wakes = useRef<InstancedMesh>(null);
  const wake = useMemo(() => new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(-0.5, 0, 0), []);
  const dummy = useMemo(() => new Object3D(), []);
  const spot = useMemo<Spot>(() => ({ x: 0, y: 0, height: 0, heading: 0 }), []);
  const hidden = useMemo(() => new Matrix4().makeScale(0, 0, 0), []);

  useFrame(() => {
    const h = hulls.current;
    const w = wakes.current;
    if (!h || !w) return;
    boats.forEach((boat, i) => {
      const { distance, returning } = shuttle(boat.path.total, boat.speed, shared.uTime.value + boat.offset, boat.dwell);
      along(boat.path, distance, spot);
      const heading = spot.heading + (returning ? Math.PI : 0);
      dummy.position.set(spot.x, WATER_Y, -spot.y);
      dummy.rotation.y = heading;
      dummy.scale.setScalar(boat.scale);
      dummy.updateMatrix();
      h.setMatrixAt(i, dummy.matrix);
      // No wake while waiting at a pier.
      const waiting = distance <= 0.5 || distance >= boat.path.total - 0.5;
      dummy.position.y = WATER_Y + 0.3;
      dummy.scale.set(boat.wake * boat.scale, 1, wakeWidth * boat.scale);
      dummy.updateMatrix();
      w.setMatrixAt(i, waiting ? hidden : dummy.matrix);
    });
    h.instanceMatrix.needsUpdate = true;
    w.instanceMatrix.needsUpdate = true;
  });

  if (!boats.length) return null;
  return (
    <>
      <instancedMesh ref={hulls} args={[geometry, undefined, boats.length]} raycast={noRaycast} frustumCulled={false}>
        <meshLambertMaterial vertexColors side={DoubleSide} />
      </instancedMesh>
      <instancedMesh ref={wakes} args={[wake, undefined, boats.length]} raycast={noRaycast} frustumCulled={false}>
        <meshBasicMaterial color="#dfeaf6" transparent opacity={0.4} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

/** Ferries leaving the north bank and coming back, and sailing boats drifting on the Tejo. */
export function Boats({ ferries, sails }: { ferries: number[][][]; sails: number[][][] }) {
  const ferryGeometry = useMemo(createFerryGeometry, []);
  const sailGeometry = useMemo(createSailGeometry, []);
  const ferryBoats = useMemo<Boat[]>(
    () => ferries.map((route, i) => ({ path: flatPath(route), speed: FERRY_SPEED, dwell: 25, offset: 40 + i * 140, wake: 70, scale: 2 })),
    [ferries],
  );
  const sailBoats = useMemo<Boat[]>(() => {
    const random = randomFrom(31);
    return sails.map((lane) => ({ path: flatPath(lane), speed: SAIL_SPEED * (0.7 + random() * 0.6), dwell: 0, offset: random() * 900, wake: 22, scale: 2.6 }));
  }, [sails]);

  return (
    <>
      <Fleet boats={ferryBoats} geometry={ferryGeometry} wakeWidth={7} />
      <Fleet boats={sailBoats} geometry={sailGeometry} wakeWidth={2.4} />
    </>
  );
}

// ---------------------------------------------------------------- plane

/** How far out the plane appears, and how far it rolls along the runway after touching down. */
const APPROACH_M = 7000;
const TOUCH_DOWN_M = 300;
const ROLL_OUT_M = 1300;
const GLIDE_SLOPE = Math.tan((3 * Math.PI) / 180);
const PLANE_SPEED = 72; // m/s
const PLANE_EVERY_S = 150;
const PLANE_SCALE = 1.6;

/** A small airliner. Its nose points along +x. */
function createPlaneGeometry(): BufferGeometry {
  return mergeGeometries([
    box(38, 4, 4, 0, 0, 0, "#f4f4f1"),
    box(6, 0.6, 36, -1, -0.6, 0, "#e3e5e8"),
    box(3.4, 0.5, 13, -17, 0.6, 0, "#e3e5e8"),
    box(5, 6, 0.6, -16.5, 3.6, 0, "#b7877c"),
  ]);
}

const PARKED_PLANES = 9;

/** The airport: runways and taxiways drawn on the ground, and a few planes parked on the apron. */
export function Airport({ cover, shapes }: { cover: CoverData; shapes: Map<number, BufferGeometry> }) {
  const material = useMemo(createRunwayMaterial, []);
  const planeGeometry = useMemo(createPlaneGeometry, []);
  const tarmac = useMemo(() => {
    const lines: Polyline[] = [
      ...cover.taxiways.map((points) => ({ points: points.flat(), cls: 1 })),
      ...cover.runways.map((r) => ({ points: r.points.flat(), cls: 0 })),
    ];
    return buildRibbons(lines, [22.5, 11], 0.35);
  }, [cover]);
  const parked = useMemo(() => {
    const apron = shapes.get(COVER.apron);
    if (!apron) return [];
    const random = randomFrom(4);
    const candidates = scatterOver(apron, 80, random);
    const out: { x: number; y: number; heading: number }[] = [];
    for (let i = 0; i < candidates.length && out.length < PARKED_PLANES; i += 2) {
      const [x, y] = [candidates[i], candidates[i + 1]];
      // Keep them apart, as on a real apron.
      if (out.every((p) => Math.hypot(p.x - x, p.y - y) > 95)) out.push({ x, y, heading: random() * Math.PI * 2 });
    }
    return out;
  }, [shapes]);

  return (
    <>
      <mesh geometry={tarmac} material={material} renderOrder={1} raycast={noRaycast} frustumCulled={false} />
      {parked.map((p, i) => (
        <mesh key={i} geometry={planeGeometry} position={[p.x, 3, -p.y]} rotation-y={p.heading} scale={PLANE_SCALE} raycast={noRaycast}>
          <meshLambertMaterial vertexColors />
        </mesh>
      ))}
    </>
  );
}

/** Every few minutes a plane comes in low over the city and lands on the main runway, as they do in Lisbon. */
export function Plane({ runways }: { runways: CoverData["runways"] }) {
  const plane = useRef<Mesh>(null);
  const shadow = useRef<Mesh>(null);
  const geometry = useMemo(createPlaneGeometry, []);
  const shadowMaterial = useMemo(createShadowMaterial, []);
  const route = useMemo(() => {
    // The longest runway, flown from its southern end: planes come in over the city.
    const length = (r: CoverData["runways"][number]) => {
      const [a, b] = [r.points[0], r.points[r.points.length - 1]];
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
    const main = [...runways].sort((a, b) => length(b) - length(a))[0];
    if (!main) return null;
    let [from, to] = [main.points[0], main.points[main.points.length - 1]];
    if (from[1] > to[1]) [from, to] = [to, from];
    const d = length(main);
    const dx = (to[0] - from[0]) / d;
    const dy = (to[1] - from[1]) / d;
    return { tx: from[0] + dx * TOUCH_DOWN_M, ty: from[1] + dy * TOUCH_DOWN_M, dx, dy };
  }, [runways]);

  useFrame(() => {
    const p = plane.current;
    const s = shadow.current;
    if (!p || !s || !route) return;
    const time = shared.uTime.value;
    const travelled = ((time + 20) % PLANE_EVERY_S) * PLANE_SPEED;
    // Hidden between flights.
    const flying = travelled < APPROACH_M + ROLL_OUT_M;
    p.visible = flying;
    s.visible = flying;
    if (!flying) return;
    const d = travelled - APPROACH_M; // metres past the runway end; negative while still in the air
    const x = route.tx + route.dx * d;
    const y = route.ty + route.dy * d;
    const altitude = Math.max(0, -d) * GLIDE_SLOPE + 3;
    const heading = Math.atan2(route.dy, route.dx);
    p.position.set(x, altitude, -y);
    p.rotation.y = heading;
    p.scale.setScalar(PLANE_SCALE);
    s.scale.set(PLANE_SCALE, 0.001, PLANE_SCALE);
    s.position.set(x + SHADOW_PER_M[0] * altitude, 0.75, -(y + SHADOW_PER_M[1] * altitude));
    s.rotation.y = heading;
  });

  return (
    <>
      <mesh ref={plane} geometry={geometry} raycast={noRaycast} visible={false} frustumCulled={false}>
        <meshLambertMaterial vertexColors />
      </mesh>
      {/* The same shape pressed flat on the ground is its shadow. */}
      <mesh ref={shadow} geometry={geometry} material={shadowMaterial} scale={[1, 0.001, 1]} renderOrder={2} raycast={noRaycast} visible={false} frustumCulled={false} />
    </>
  );
}
