// What moves in the city: cars, trams, trains, boats on the Tejo and a plane
// coming in to land. With prefers-reduced-motion the scene clock stays at 0
// and all of it stands still.
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
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
import { createShadowMaterial } from "../city/groundMaterials";
import type { Polyline } from "../city/lines";
import { project, SHADOW_PER_M, type Manifest } from "../city/loadCity";
import { randomFrom } from "./Extras";

const noRaycast = () => null;
const WATER_Y = -2;

// ---------------------------------------------------------------- paths

/** A line to travel along: points in map metres (x east, y north), optionally with a height. */
interface Path {
  points: ArrayLike<number>;
  stride: 2 | 3;
  lengths: Float32Array;
  total: number;
}

function toPath(points: ArrayLike<number>, stride: 2 | 3): Path {
  const n = points.length / stride;
  const lengths = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    lengths[i] =
      lengths[i - 1] +
      Math.hypot(points[i * stride] - points[(i - 1) * stride], points[i * stride + 1] - points[(i - 1) * stride + 1]);
  }
  return { points, stride, lengths, total: lengths[n - 1] };
}

const flatPath = (points: number[][]) => toPath(points.flat(), (points[0]?.length === 3 ? 3 : 2) as 2 | 3);

interface Spot {
  x: number;
  y: number;
  height: number;
  /** Direction of travel, as a rotation about the vertical axis. */
  heading: number;
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
  out.height = stride === 3 ? points[(k - 1) * 3 + 2] + (points[k * 3 + 2] - points[(k - 1) * 3 + 2]) * t : 0;
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
const CAR_COLORS = ["#f1f1ee", "#f1f1ee", "#b9bcc0", "#74787d", "#1f2124", "#a8261c", "#27477d", "#e8c02c"].map(
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

/** Cars driving through the city, from street to street. */
export function Cars({ roads }: { roads: Polyline[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const state = useMemo(() => {
    const ways = buildWays(roads);
    const random = randomFrom(7);
    const total = ways.reduce((sum, w) => sum + w.total, 0);
    const count = ways.length ? CAR_COUNT : 0;
    const way = new Int32Array(count);
    const distance = new Float32Array(count);
    const speed = new Float32Array(count);
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
    return { ways, way, distance, speed, count, random };
  }, [roads]);

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const random = randomFrom(99);
    for (let i = 0; i < state.count; i++) m.setColorAt(i, CAR_COLORS[Math.floor(random() * CAR_COLORS.length)]);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [state]);

  const dummy = useMemo(() => new Object3D(), []);
  const spot = useMemo<Spot>(() => ({ x: 0, y: 0, height: 0, heading: 0 }), []);
  const placed = useRef(false);

  useFrame((_, delta) => {
    const m = mesh.current;
    if (!m || !state.count) return;
    // The scene clock stays at 0 with reduced motion: place the cars once and leave them.
    const moving = shared.uTime.value > 0;
    if (!moving && placed.current) return;
    placed.current = true;
    const dt = moving ? Math.min(delta, 0.1) : 0;
    const { ways, way, distance, speed, random } = state;
    for (let i = 0; i < state.count; i++) {
      let w = ways[way[i]];
      const base = w.cls === 0 ? 14 : w.cls === 1 ? 9 : 6; // m/s
      distance[i] += base * speed[i] * dt;
      while (distance[i] > w.total) {
        distance[i] -= w.total;
        // Turn into a street that continues from here; at a dead end, start again somewhere else.
        if (w.next.length) way[i] = w.next[Math.floor(random() * w.next.length)];
        else {
          way[i] = Math.floor(random() * ways.length);
          distance[i] = 0;
        }
        w = ways[way[i]];
      }
      along(w, distance[i], spot);
      // Keep to the right-hand side of the road.
      const side = w.cls === 2 ? 1.6 : 2.4;
      dummy.position.set(spot.x + Math.sin(spot.heading) * side, 1.6, -(spot.y - Math.cos(spot.heading) * side));
      dummy.rotation.y = spot.heading;
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });

  if (!state.count) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, state.count]} raycast={noRaycast} frustumCulled={false}>
      {/* Larger than life, like everything that moves here: at city scale a real car is a speck. */}
      <boxGeometry args={[7.5, 2.6, 3.4]} />
      <meshLambertMaterial />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- trams

const TRAM_SPEED = 7; // m/s

/** Yellow trams going back and forth on real track around the centre. */
export function Trams({ routes }: { routes: number[][][] }) {
  const group = useRef<Group>(null);
  const paths = useMemo(() => routes.map(flatPath), [routes]);
  const spot = useMemo<Spot>(() => ({ x: 0, y: 0, height: 0, heading: 0 }), []);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    paths.forEach((path, i) => {
      const tram = g.children[i];
      // Each tram starts at a different point of its line, also when nothing moves.
      const { distance } = shuttle(path.total, TRAM_SPEED, shared.uTime.value + i * 97 + 60, 8);
      along(path, distance, spot);
      tram.position.set(spot.x, 2.5, -spot.y);
      tram.rotation.y = spot.heading;
    });
  });

  return (
    <group ref={group}>
      {paths.map((_, i) => (
        <mesh key={i} raycast={noRaycast}>
          <boxGeometry args={[17, 4.2, 3.4]} />
          <meshLambertMaterial color="#f0c419" />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- trains

const TRAIN_SPEED = 21; // m/s
const CARRIAGES = 4;
const CARRIAGE_GAP_M = 25;
const TRAIN_COLORS: Record<string, string> = {
  "Linha de Cascais": "#f1c330",
  "Linha do Sul": "#3a6db5",
};

export interface TrainRoute {
  name: string;
  /** [x, y, height] in map metres. */
  points: number[][];
}

/** Trains on the real railway lines, two per line, including the one that crosses the bridge. */
export function Trains({ routes }: { routes: TrainRoute[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const paths = useMemo(() => routes.map((r) => flatPath(r.points)), [routes]);
  const count = routes.length * 2 * CARRIAGES;
  const dummy = useMemo(() => new Object3D(), []);
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
          dummy.position.set(spot.x, spot.height + 2, -spot.y);
          dummy.rotation.y = spot.heading;
          dummy.updateMatrix();
          m.setMatrixAt((r * 2 + train) * CARRIAGES + c, dummy.matrix);
        }
      }
    });
    m.instanceMatrix.needsUpdate = true;
  });

  if (!count) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} raycast={noRaycast} frustumCulled={false}>
      <boxGeometry args={[23, 3.8, 3.1]} />
      <meshLambertMaterial />
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
    box(20, 2.6, 7, -1, 4.3, 0, "#e9772b"),
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

/** South end of the runway of Lisbon airport, [lon, lat] (approximate). */
const RUNWAY_END: [number, number] = [-9.1436, 38.7662];
/** Planes land heading north-north-east, over the city. */
const APPROACH_HEADING_DEG = 25;
const APPROACH_M = 7000;
const ROLL_OUT_M = 700;
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
    box(5, 6, 0.6, -16.5, 3.6, 0, "#c8473a"),
  ]);
}

/** Every few minutes a plane comes in low over the city and lands, as they do in Lisbon. */
export function Plane({ manifest }: { manifest: Manifest }) {
  const plane = useRef<Mesh>(null);
  const shadow = useRef<Mesh>(null);
  const geometry = useMemo(createPlaneGeometry, []);
  const shadowMaterial = useMemo(createShadowMaterial, []);
  const route = useMemo(() => {
    const [tx, ty] = project(manifest, RUNWAY_END[0], RUNWAY_END[1]);
    const a = (APPROACH_HEADING_DEG * Math.PI) / 180;
    // Compass heading to map direction: north is +y, east is +x.
    return { tx, ty, dx: Math.sin(a), dy: Math.cos(a) };
  }, [manifest]);

  useFrame(() => {
    const p = plane.current;
    const s = shadow.current;
    if (!p || !s) return;
    const time = shared.uTime.value;
    const travelled = ((time + 20) % PLANE_EVERY_S) * PLANE_SPEED;
    // Hidden between flights, and always with reduced motion (the clock stays at 0).
    const flying = time > 0 && travelled < APPROACH_M + ROLL_OUT_M;
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
