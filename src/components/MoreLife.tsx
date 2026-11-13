// More of Lisbon's everyday life: the funiculars and the Santa Justa lift,
// gulls over the river, a cruise ship at the terminal on some days, bicycles
// on the cycle paths, people at the miradouros and café terraces.
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Object3D, ShaderMaterial, type Group, type InstancedMesh } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createLightMaterial, quality, shared, withNight } from "../city/environment";
import { createTrackMaterial } from "../city/groundMaterials";
import { buildRibbons, type Polyline } from "../city/lines";
import { project, type Manifest } from "../city/loadCity";
import { randomFrom } from "./Extras";
import { createPersonGeometry, PEOPLE_COLORS, toLine, useViewBox, type BusLine } from "./Street";

const noRaycast = () => null;
const WATER_Y = -2;

/** A box in one colour, ready to be merged with others into one mesh. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, color: string): BufferGeometry {
  const g = new BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
  const c = new Color(color);
  const colors = new Float32Array(g.getAttribute("position").count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute("color", new BufferAttribute(colors, 3));
  g.deleteAttribute("uv");
  return g;
}

/** Where a line is after `d` metres, and which way it runs there. */
function pointAlong(line: BusLine, d: number): { x: number; y: number; heading: number } {
  const { points, lengths, total } = line;
  const at = Math.min(total, Math.max(0, d));
  let k = 1;
  while (k < lengths.length - 1 && lengths[k] < at) k++;
  const t = (at - lengths[k - 1]) / (lengths[k] - lengths[k - 1] || 1);
  const ax = points[(k - 1) * 2];
  const ay = points[(k - 1) * 2 + 1];
  const bx = points[k * 2];
  const by = points[k * 2 + 1];
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, heading: Math.atan2(by - ay, bx - ax) };
}

/** Back and forth along a line, waiting `dwell` seconds at each end. */
function shuttle(total: number, speed: number, time: number, dwell: number): { d: number; back: boolean } {
  const leg = total / speed + dwell;
  const phase = ((time % (2 * leg)) + 2 * leg) % (2 * leg);
  const back = phase >= leg;
  const moving = Math.min(total / speed, back ? phase - leg : phase);
  return { d: back ? total - moving * speed : moving * speed, back };
}

// ---------------------------------------------------------------- funiculars

/** A funicular car: yellow below, white above, windows between. Along +x. */
function createFunicularGeometry(): BufferGeometry {
  return mergeGeometries([
    box(10, 2.2, 3.2, 0, 1.4, 0, "#e7c45a"),
    box(9.6, 1.2, 3.1, 0, 3.1, 0, "#3b4651"),
    box(10, 0.6, 3.2, 0, 4.0, 0, "#f4f1e8"),
  ]);
}

/** The Glória, Bica, Lavra and Graça funiculars: two cars on each, passing halfway. */
export function Funiculars({ lines }: { lines: { name: string; points: number[][] }[] }) {
  const group = useRef<Group>(null);
  const paths = useMemo(() => lines.map((l) => toLine(l.points.flat())), [lines]);
  const track = useMemo(() => buildRibbons(lines.map((l) => ({ points: l.points.flat(), cls: 0 })), [2.4], 0.5), [lines]);
  const trackMaterial = useMemo(createTrackMaterial, []);
  const geometry = useMemo(createFunicularGeometry, []);
  const scale = 1.3;

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    paths.forEach((path, i) => {
      // One car goes up while the other comes down; they pass at the middle.
      const { d } = shuttle(path.total, 3.2, shared.uTime.value + i * 37, 20);
      for (const [k, at] of [d, path.total - d].entries()) {
        const p = pointAlong(path, at);
        const car = g.children[i * 2 + k];
        car.position.set(p.x, 0.45, -p.y);
        car.rotation.y = p.heading;
        car.scale.setScalar(scale);
      }
    });
  });

  return (
    <>
      <mesh geometry={track} material={trackMaterial} renderOrder={1} raycast={noRaycast} />
      <group ref={group}>
        {paths.flatMap((_, i) =>
          [0, 1].map((k) => (
            <mesh key={`${i}-${k}`} geometry={geometry} raycast={noRaycast}>
              <meshLambertMaterial vertexColors />
            </mesh>
          )),
        )}
      </group>
    </>
  );
}

/** The Santa Justa lift: its cabin going up and down beside the tower. */
export function SantaJusta({ at }: { at: [number, number] }) {
  const cabin = useRef<Group>(null);
  const geometry = useMemo(
    () =>
      mergeGeometries([
        box(4.2, 4.6, 4.2, 0, 2.3, 0, "#6e4b33"),
        box(4.4, 1.2, 4.4, 0, 3.3, 0, "#3b4651"),
      ]),
    [],
  );
  const light = useMemo(() => createLightMaterial("#ffd9a0"), []);
  useFrame(() => {
    if (!cabin.current) return;
    // 32 m up in about 30 s, a minute's wait at each end.
    const { d } = shuttle(32, 1.1, shared.uTime.value, 25);
    cabin.current.position.set(at[0] + 3.2, d, -(at[1] - 3.2));
  });
  return (
    <group ref={cabin}>
      <mesh geometry={geometry} raycast={noRaycast}>
        <meshLambertMaterial vertexColors />
      </mesh>
      <mesh position={[0, 3.3, 0]} material={light} renderOrder={4} raycast={noRaycast}>
        <boxGeometry args={[4.5, 1.0, 4.5]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- gulls

const GULLS = 70;

/** A gull: two wings along z, a small body along x. The wings flap in the shader. */
function createGullGeometry(): BufferGeometry {
  const wing = new BufferGeometry();
  // Each wing a thin triangle from the body to the tip, both sides.
  wing.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([0.4, 0, 0, -0.4, 0, 0, -0.1, 0, 1.6, 0.4, 0, 0, -0.1, 0, -1.6, -0.4, 0, 0]),
      3,
    ),
  );
  const body = new BoxGeometry(1.0, 0.25, 0.25).toNonIndexed();
  body.deleteAttribute("uv");
  body.deleteAttribute("normal");
  return mergeGeometries([wing, body]);
}

function createGullMaterial(): ShaderMaterial {
  return withNight(
    new ShaderMaterial({
      vertexShader: /* glsl */ `
uniform float uTime;

void main() {
  vec3 p = position;
  // Each gull flaps at its own time; gliding most of the time.
  float phase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.11;
  float flap = sin(uTime * 7.0 + phase) * step(0.55, fract(uTime * 0.12 + phase * 0.05));
  p.y += abs(p.z) * flap * 0.45;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}
`,
      fragmentShader: /* glsl */ `
void main() {
  gl_FragColor = vec4(0.95, 0.95, 0.93, 1.0);
  #include <colorspace_fragment>
}
`,
      uniforms: { uTime: shared.uTime },
      side: 2,
    }),
  );
}

/** Gulls circling over the river and the waterfront, larger than life like everything that moves here. */
export function Gulls({ centres }: { centres: number[][] }) {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(createGullGeometry, []);
  const material = useMemo(createGullMaterial, []);
  const flock = useMemo(() => {
    const random = randomFrom(57);
    return Array.from({ length: centres.length ? GULLS : 0 }, () => {
      const c = centres[Math.floor(random() * centres.length)];
      return {
        cx: c[0] + (random() - 0.5) * 300,
        cy: c[1] + (random() - 0.5) * 300,
        radius: 40 + random() * 110,
        height: 25 + random() * 45,
        speed: (9 + random() * 5) * (random() < 0.5 ? 1 : -1),
        start: random() * Math.PI * 2,
      };
    });
  }, [centres]);
  const dummy = useMemo(() => new Object3D(), []);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const time = shared.uTime.value;
    flock.forEach((g, i) => {
      const a = g.start + (time * g.speed) / g.radius;
      const x = g.cx + Math.cos(a) * g.radius;
      const y = g.cy + Math.sin(a) * g.radius;
      dummy.position.set(x, g.height + Math.sin(time * 0.3 + i) * 4, -y);
      // Flying along the circle, banked a little into the turn.
      dummy.rotation.set(Math.sign(g.speed) * 0.25, a + (g.speed > 0 ? Math.PI / 2 : -Math.PI / 2), 0, "YXZ");
      dummy.scale.setScalar(5.5);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  if (!flock.length) return null;
  return <instancedMesh ref={mesh} args={[geometry, material, flock.length]} raycast={noRaycast} frustumCulled={false} />;
}

// ---------------------------------------------------------------- cruise ship

/** Where a ship lies along the quay of the Lisbon Cruise Terminal, at Santa Apolónia, [lon, lat]. */
const CRUISE_BERTH: [number, number] = [-9.12508, 38.70957];
/** Direction of the quay there, degrees north of east. */
const CRUISE_QUAY_DEG = 42;

/** A cruise ship, its bow along +x: hull, decks stepping back, a funnel. */
function createShipGeometry(): BufferGeometry {
  return mergeGeometries([
    box(290, 4, 34.4, 0, 0, 0, "#2c3a52"),
    box(290, 12, 34, 0, 8, 0, "#f5f4ef"),
    box(240, 8, 30, -10, 18, 0, "#f7f6f2"),
    box(200, 7, 27, -15, 25.5, 0, "#f2f1ec"),
    box(150, 6, 24, -20, 32, 0, "#efeee9"),
    box(30, 6, 34, 105, 25, 0, "#f7f6f2"),
    box(16, 12, 10, -60, 41, 0, "#f2f2ee"),
    box(16.4, 3, 10.4, -60, 46, 0, "#c25b3c"),
  ]);
}

/** Rows of cabin windows, lit at night. */
function createShipLights(): BufferGeometry {
  return mergeGeometries([
    new BoxGeometry(270, 1.2, 34.6).translate(0, 9, 0),
    new BoxGeometry(236, 1.2, 30.6).translate(-10, 18.5, 0),
    new BoxGeometry(196, 1.2, 27.6).translate(-15, 26, 0),
    new BoxGeometry(146, 1.2, 24.6).translate(-20, 32.5, 0),
  ]);
}

/** On most days a cruise ship lies at the terminal at Santa Apolónia (which days is fixed by the date). */
export function CruiseShip({ manifest }: { manifest: Manifest }) {
  const geometry = useMemo(createShipGeometry, []);
  const lights = useMemo(createShipLights, []);
  const lightMaterial = useMemo(() => createLightMaterial("#ffe2b0"), []);
  const day = Math.floor(Date.now() / 86400000);
  const inPort = (day * 7919) % 10 < 6;
  const place = useMemo(() => {
    const [x, y] = project(manifest, CRUISE_BERTH[0], CRUISE_BERTH[1]);
    return { x, y, heading: (CRUISE_QUAY_DEG * Math.PI) / 180 };
  }, [manifest]);
  if (!inPort) return null;
  return (
    <group position={[place.x, WATER_Y, -place.y]} rotation-y={place.heading}>
      <mesh geometry={geometry} raycast={noRaycast}>
        <meshLambertMaterial vertexColors />
      </mesh>
      <mesh geometry={lights} material={lightMaterial} renderOrder={4} raycast={noRaycast} />
    </group>
  );
}

// ---------------------------------------------------------------- bicycles

const BIKE_EVERY_M = 320;
const BIKE_SPEED = 4.5;
const BIKE_ZOOM = 1.2;

/** A bicycle and its rider, along +x. */
function createBikeGeometry(): BufferGeometry {
  return mergeGeometries([
    box(1.8, 0.9, 0.2, 0, 0.5, 0, "#2f3238"),
    box(0.55, 0.9, 0.5, -0.1, 1.4, 0, "#ffffff"),
    box(0.4, 0.4, 0.4, 0.05, 2.05, 0, "#d8b8a0"),
  ]);
}

/** People cycling along the cycle paths, close to the camera only. */
export function Bikes({ lines }: { lines: Polyline[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(createBikeGeometry, []);
  const riders = useMemo(() => {
    const paths = lines.map((l) => toLine(l.points)).filter((p) => p.total > 100);
    const random = randomFrom(83);
    const out: { path: number; offset: number; speed: number; color: Color }[] = [];
    paths.forEach((p, i) => {
      for (let k = 0; k < Math.max(1, Math.round(p.total / BIKE_EVERY_M)); k++) {
        out.push({ path: i, offset: random() * 1000, speed: BIKE_SPEED * (0.8 + random() * 0.4), color: PEOPLE_COLORS[Math.floor(random() * PEOPLE_COLORS.length)] });
      }
    });
    return { paths, out };
  }, [lines]);
  const dummy = useMemo(() => new Object3D(), []);
  const view = useViewBox();

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const { box: b, zoom } = view();
    if (zoom < BIKE_ZOOM || quality.level === 0) {
      m.count = 0;
      return;
    }
    let shown = 0;
    for (const r of riders.out) {
      const path = riders.paths[r.path];
      const { d, back } = shuttle(path.total, r.speed, shared.uTime.value + r.offset, 0);
      const p = pointAlong(path, d);
      if (p.x < b[0] || p.x > b[2] || p.y < b[1] || p.y > b[3]) continue;
      const heading = p.heading + (back ? Math.PI : 0);
      dummy.position.set(p.x + Math.sin(heading) * 0.9, 0.45, -(p.y - Math.cos(heading) * 0.9));
      dummy.rotation.set(0, heading, 0);
      dummy.scale.setScalar(1.4);
      dummy.updateMatrix();
      m.setMatrixAt(shown, dummy.matrix);
      m.setColorAt(shown, r.color);
      shown++;
    }
    m.count = shown;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, Math.max(1, riders.out.length)]} raycast={noRaycast} frustumCulled={false}>
      <meshLambertMaterial vertexColors />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- miradouros

const PEOPLE_PER_VIEWPOINT = 14;
const CROWD_ZOOM = 1.2;

/** People standing at the miradouros, looking out over the city. */
export function Viewpoints({ points }: { points: number[][] }) {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(createPersonGeometry, []);
  const count = points.length * PEOPLE_PER_VIEWPOINT;

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const random = randomFrom(19);
    const o = new Object3D();
    points.forEach(([x, y], v) => {
      for (let k = 0; k < PEOPLE_PER_VIEWPOINT; k++) {
        const i = v * PEOPLE_PER_VIEWPOINT + k;
        const a = random() * Math.PI * 2;
        const r = 2 + random() * 14;
        o.position.set(x + Math.cos(a) * r, 0.45, -(y + Math.sin(a) * r));
        o.rotation.set(0, random() * Math.PI * 2, 0);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
        m.setColorAt(i, PEOPLE_COLORS[Math.floor(random() * PEOPLE_COLORS.length)]);
      }
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [points]);

  const view = useViewBox();
  useFrame(() => {
    if (mesh.current) mesh.current.visible = view().zoom >= CROWD_ZOOM && quality.level > 0;
  });

  if (!count) return null;
  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, count]} raycast={noRaycast}>
      <meshLambertMaterial vertexColors />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- terraces

const TABLES_PER_TERRACE = 3;
const PARASOL_COLORS = ["#efe6d2", "#c98466", "#9fb08e", "#5d6b80", "#e2c27a"].map((c) => new Color(c));

/** Café terraces: tables under parasols outside the cafés, restaurants and bars that have them. */
export function Terraces({ points }: { points: number[][] }) {
  const tops = useRef<InstancedMesh>(null);
  const stands = useRef<InstancedMesh>(null);
  const topGeometry = useMemo(() => new BoxGeometry(3.4, 0.3, 3.4).translate(0, 3.0, 0), []);
  const standGeometry = useMemo(
    () => mergeGeometries([new BoxGeometry(0.14, 3.0, 0.14).translate(0, 1.5, 0), new BoxGeometry(1.2, 0.12, 1.2).translate(0, 1.0, 0)]),
    [],
  );
  const count = points.length * TABLES_PER_TERRACE;

  useLayoutEffect(() => {
    const t = tops.current;
    const s = stands.current;
    if (!t || !s) return;
    const random = randomFrom(29);
    const o = new Object3D();
    points.forEach(([x, y], p) => {
      // A short row of tables, the same parasol colour for one café.
      const along = random() * Math.PI;
      const color = PARASOL_COLORS[Math.floor(random() * PARASOL_COLORS.length)];
      for (let k = 0; k < TABLES_PER_TERRACE; k++) {
        const i = p * TABLES_PER_TERRACE + k;
        const d = (k - 1) * 4.2;
        o.position.set(x + Math.cos(along) * d, 0.45, -(y + Math.sin(along) * d));
        o.rotation.set(0, along, 0);
        o.updateMatrix();
        t.setMatrixAt(i, o.matrix);
        s.setMatrixAt(i, o.matrix);
        t.setColorAt(i, color);
      }
    });
    t.instanceMatrix.needsUpdate = true;
    s.instanceMatrix.needsUpdate = true;
    if (t.instanceColor) t.instanceColor.needsUpdate = true;
  }, [points]);

  const view = useViewBox();
  useFrame(() => {
    const visible = view().zoom >= CROWD_ZOOM && quality.level > 0;
    if (tops.current) tops.current.visible = visible;
    if (stands.current) stands.current.visible = visible;
  });

  if (!count) return null;
  return (
    <>
      <instancedMesh ref={tops} args={[topGeometry, undefined, count]} raycast={noRaycast}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={stands} args={[standGeometry, undefined, count]} raycast={noRaycast}>
        <meshLambertMaterial color="#4a4d53" />
      </instancedMesh>
    </>
  );
}

// ---------------------------------------------------------------- monuments

const STONE = "#ddd6c6";
const BRONZE = "#6f7d74";
const MONUMENT_ZOOM = 0.8;

/** Any geometry in one colour, ready to merge. */
function colored(g: BufferGeometry, color: string): BufferGeometry {
  const geometry = g.index ? g.toNonIndexed() : g;
  if (geometry.getAttribute("uv")) geometry.deleteAttribute("uv");
  const c = new Color(color);
  const colors = new Float32Array(geometry.getAttribute("position").count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

/** A standing figure in bronze, `h` metres tall, its feet at y. */
function figure(y: number, h: number): BufferGeometry[] {
  return [
    colored(new BoxGeometry(h * 0.28, h * 0.42, h * 0.2).translate(0, y + h * 0.21, 0), BRONZE), // legs and robe
    colored(new BoxGeometry(h * 0.34, h * 0.36, h * 0.24).translate(0, y + h * 0.6, 0), BRONZE), // body
    colored(new BoxGeometry(h * 0.14, h * 0.14, h * 0.14).translate(0, y + h * 0.86, 0), BRONZE), // head
  ];
}

/** The five kinds, each `height` metres tall at scale 1 (kinds and heights as in 07_street.py). */
const MONUMENT_MODELS: { height: number; build: () => BufferGeometry }[] = [
  // Statue on a pedestal.
  {
    height: 7,
    build: () =>
      mergeGeometries([
        colored(new BoxGeometry(3.2, 0.6, 3.2).translate(0, 0.3, 0), STONE),
        colored(new BoxGeometry(2.4, 2.6, 2.4).translate(0, 1.9, 0), STONE),
        ...figure(3.2, 3.8),
      ]),
  },
  // Commemorative column with a statue on top.
  {
    height: 27,
    build: () =>
      mergeGeometries([
        colored(new BoxGeometry(9, 1.2, 9).translate(0, 0.6, 0), STONE),
        colored(new BoxGeometry(5, 4, 5).translate(0, 3.2, 0), STONE),
        colored(new CylinderGeometry(1.1, 1.3, 15, 10).translate(0, 12.7, 0), STONE),
        colored(new BoxGeometry(2.8, 1, 2.8).translate(0, 20.7, 0), STONE),
        ...figure(21.2, 5.8),
      ]),
  },
  // Obelisk: four faces narrowing to a point.
  {
    height: 18,
    build: () =>
      mergeGeometries([
        colored(new BoxGeometry(4, 1.6, 4).translate(0, 0.8, 0), STONE),
        colored(new CylinderGeometry(0.9, 1.5, 15, 4).rotateY(Math.PI / 4).translate(0, 9.1, 0), STONE),
        colored(new ConeGeometry(1.27, 1.6, 4).rotateY(Math.PI / 4).translate(0, 17.4, 0), STONE),
      ]),
  },
  // Bust on a short pillar.
  {
    height: 3,
    build: () =>
      mergeGeometries([
        colored(new BoxGeometry(0.9, 2, 0.9).translate(0, 1, 0), STONE),
        colored(new BoxGeometry(0.8, 0.5, 0.5).translate(0, 2.25, 0), BRONZE),
        colored(new BoxGeometry(0.45, 0.55, 0.45).translate(0, 2.75, 0), BRONZE),
      ]),
  },
  // Sculpture: a low base and a turned bronze form.
  {
    height: 4,
    build: () =>
      mergeGeometries([
        colored(new BoxGeometry(2.4, 0.5, 2.4).translate(0, 0.25, 0), STONE),
        colored(new BoxGeometry(1.2, 2.6, 1.2).rotateY(Math.PI / 4).rotateZ(0.25).translate(0, 1.9, 0), BRONZE),
        colored(new BoxGeometry(0.9, 0.9, 0.9).rotateX(0.6).rotateY(0.4).translate(0.2, 3.4, 0), BRONZE),
      ]),
  },
];

/**
 * Statues, busts, sculptures, obelisks and commemorative columns where they
 * are mapped in OpenStreetMap: one instanced mesh per kind, close up only.
 * Drawn a little larger than life, like everything small here.
 */
export function Monuments({ items }: { items: number[][] }) {
  const meshes = useRef<(InstancedMesh | null)[]>([]);
  const geometries = useMemo(() => MONUMENT_MODELS.map((m) => m.build()), []);
  const byKind = useMemo(() => MONUMENT_MODELS.map((_, k) => items.filter((m) => m[2] === k)), [items]);

  useLayoutEffect(() => {
    const o = new Object3D();
    const random = randomFrom(71);
    byKind.forEach((list, k) => {
      const m = meshes.current[k];
      if (!m) return;
      list.forEach(([x, y, , height], i) => {
        const s = Math.max(1.3, height / MONUMENT_MODELS[k].height);
        o.position.set(x, 0.45, -y);
        o.rotation.set(0, random() * Math.PI * 2, 0);
        o.scale.setScalar(s);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
      });
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    });
  }, [byKind]);

  const view = useViewBox();
  useFrame(() => {
    const visible = view().zoom >= MONUMENT_ZOOM;
    for (const m of meshes.current) if (m) m.visible = visible;
  });

  return (
    <>
      {byKind.map((list, k) =>
        list.length ? (
          <instancedMesh
            key={k}
            ref={(m) => {
              meshes.current[k] = m;
            }}
            args={[geometries[k], undefined, list.length]}
            raycast={noRaycast}
          >
            <meshLambertMaterial vertexColors />
          </instancedMesh>
        ) : null,
      )}
    </>
  );
}
