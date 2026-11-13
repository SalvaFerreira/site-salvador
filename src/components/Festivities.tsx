// Lisbon's calendar: Christmas lights in the Baixa and Chiado and a tree of
// lights in Praça do Comércio in December, bunting over the streets of Alfama
// and Mouraria for the Santos Populares in June, and fireworks over the river
// at midnight on New Year's Eve. ?date=YYYY-MM-DD shows another day.
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, InstancedBufferAttribute, Object3D, ShaderMaterial, type InstancedMesh } from "three";
import { lisbonMinutes } from "../city/daylight";
import { createLightMaterial, shared, withNight } from "../city/environment";
import type { Polyline } from "../city/lines";
import { randomFrom } from "./Extras";

const noRaycast = () => null;

/** Month (1-12) and day in Lisbon, today or from ?date=YYYY-MM-DD. */
function lisbonDate(): { month: number; day: number } {
  const forced = new URLSearchParams(window.location.search).get("date")?.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (forced) return { month: Number(forced[1]), day: Number(forced[2]) };
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", month: "numeric", day: "numeric" }).formatToParts(new Date());
  return { month: Number(parts.find((p) => p.type === "month")!.value), day: Number(parts.find((p) => p.type === "day")!.value) };
}

/** Areas in map metres [minX, minY, maxX, maxY]: where the decorations go. */
const BAIXA_CHIADO = [-620, 60, 120, 1450];
const ALFAMA_MOURARIA = [-260, 250, 760, 1000];

/** Streets inside an area, split into straight stretches with a string of lights or flags every `every` metres. */
function stringsOver(roads: Polyline[], area: number[], every: number, maxClass: number): { x: number; y: number; angle: number; half: number }[] {
  const [x0, y0, x1, y1] = area;
  const out: { x: number; y: number; angle: number; half: number }[] = [];
  for (const road of roads) {
    if (road.cls > maxClass) continue;
    const n = road.points.length / 2;
    let carry = every / 2;
    for (let k = 1; k < n; k++) {
      const ax = road.points[(k - 1) * 2];
      const ay = road.points[(k - 1) * 2 + 1];
      const bx = road.points[k * 2];
      const by = road.points[k * 2 + 1];
      const len = Math.hypot(bx - ax, by - ay);
      let d = carry;
      for (; d < len; d += every) {
        const x = ax + ((bx - ax) * d) / len;
        const y = ay + ((by - ay) * d) / len;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        out.push({ x, y, angle: Math.atan2(by - ay, bx - ax), half: road.cls === 0 ? 9 : road.cls === 1 ? 7 : 5.5 });
      }
      carry = d - len;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Christmas

/** Strings of small lights across the streets of the Baixa and Chiado, and a tree of lights in Praça do Comércio. */
function ChristmasLights({ roads }: { roads: Polyline[] }) {
  const bulbs = useRef<InstancedMesh>(null);
  const strings = useMemo(() => stringsOver(roads, BAIXA_CHIADO, 18, 2), [roads]);
  const geometry = useMemo(() => new BoxGeometry(0.7, 0.7, 0.7), []);
  // Warm white by day too (small and pale), bright gold at night.
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`,
        fragmentShader: /* glsl */ `
uniform float uNight;
void main() {
  gl_FragColor = vec4(mix(vec3(0.93, 0.9, 0.82), vec3(1.0, 0.86, 0.55) * 1.3, uNight), 1.0);
  #include <colorspace_fragment>
}
`,
        uniforms: { uNight: shared.uNight },
      }),
    [],
  );
  const PER_STRING = 11;
  const TREE_BULBS = 420;
  const count = strings.length * PER_STRING + TREE_BULBS;

  useLayoutEffect(() => {
    const m = bulbs.current;
    if (!m) return;
    const o = new Object3D();
    let i = 0;
    for (const s of strings) {
      // Across the street, sagging a little in the middle.
      const ax = -Math.sin(s.angle);
      const ay = Math.cos(s.angle);
      for (let k = 0; k < PER_STRING; k++) {
        const t = k / (PER_STRING - 1) - 0.5;
        o.position.set(s.x + ax * t * 2 * s.half, 9 - 1.6 * (1 - 4 * t * t), -(s.y + ay * t * 2 * s.half));
        o.updateMatrix();
        m.setMatrixAt(i++, o.matrix);
      }
    }
    // The tree: a spiral of lights up a cone, in the middle of Praça do Comércio.
    for (let k = 0; k < TREE_BULBS; k++) {
      const t = k / TREE_BULBS;
      const a = t * Math.PI * 2 * 14;
      const r = 11 * (1 - t);
      o.position.set(Math.cos(a) * r, 1 + t * 32, -(40 + Math.sin(a) * r));
      o.updateMatrix();
      m.setMatrixAt(i++, o.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  }, [strings]);

  return <instancedMesh ref={bulbs} args={[geometry, material, count]} raycast={noRaycast} />;
}

// ---------------------------------------------------------------- Santos Populares

const FLAG_COLORS = ["#e04a3a", "#f2c230", "#3a8fd9", "#44a35a", "#e8833a", "#d65fa0", "#f4efe6"].map((c) => new Color(c));

/** A small triangular flag hanging down, its top edge along x. */
function createFlagGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array([-0.6, 0, 0, 0.6, 0, 0, 0, -1.3, 0]), 3));
  return g;
}

/** Bunting in many colours over the streets of Alfama and Mouraria, moving a little in the breeze. */
function Bunting({ roads }: { roads: Polyline[] }) {
  const flags = useRef<InstancedMesh>(null);
  const strings = useMemo(() => stringsOver(roads, ALFAMA_MOURARIA, 12, 2), [roads]);
  const geometry = useMemo(createFlagGeometry, []);
  const material = useMemo(
    () =>
      withNight(
        new ShaderMaterial({
          vertexShader: /* glsl */ `
attribute vec3 flagColor;
uniform float uTime;
varying vec3 vColor;
void main() {
  vColor = flagColor;
  vec3 p = position;
  // The tip swings in the breeze.
  p.z += sin(uTime * 2.3 + instanceMatrix[3].x * 0.7) * 0.35 * (-position.y);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}
`,
          fragmentShader: /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
  #include <colorspace_fragment>
}
`,
          uniforms: { uTime: shared.uTime },
          side: 2,
        }),
      ),
    [],
  );
  const PER_STRING = 9;
  const count = strings.length * PER_STRING;

  useLayoutEffect(() => {
    const m = flags.current;
    if (!m) return;
    const o = new Object3D();
    const colors = new Float32Array(count * 3);
    const random = randomFrom(613);
    let i = 0;
    for (const s of strings) {
      const ax = -Math.sin(s.angle);
      const ay = Math.cos(s.angle);
      for (let k = 0; k < PER_STRING; k++) {
        const t = k / (PER_STRING - 1) - 0.5;
        o.position.set(s.x + ax * t * 2 * s.half, 7.5 - 1.2 * (1 - 4 * t * t), -(s.y + ay * t * 2 * s.half));
        // Flags face along the street, strung across it.
        o.rotation.set(0, s.angle, 0);
        o.scale.setScalar(1.3);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
        FLAG_COLORS[Math.floor(random() * FLAG_COLORS.length)].toArray(colors, i * 3);
        i++;
      }
    }
    m.geometry.setAttribute("flagColor", new InstancedBufferAttribute(colors, 3));
    m.instanceMatrix.needsUpdate = true;
  }, [strings, count]);

  return <instancedMesh ref={flags} args={[geometry, material, count]} raycast={noRaycast} />;
}

// ---------------------------------------------------------------- New Year's Eve

const BURSTS = 6;
const SPARKS = 60;
const BURST_COLORS = ["#ffd27a", "#ff6a5a", "#7adf9a", "#ffffff", "#8fb6ff", "#ff9a3c"];

/** Fireworks over the river in front of Praça do Comércio. */
function Fireworks() {
  const meshes = useRef<(InstancedMesh | null)[]>([]);
  const geometry = useMemo(() => new BoxGeometry(4, 4, 4), []);
  const materials = useMemo(() => BURST_COLORS.map((c) => createLightMaterial(c)), []);
  const directions = useMemo(() => {
    const random = randomFrom(2024);
    return Array.from({ length: SPARKS }, () => {
      const u = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      return [r * Math.cos(a), u, r * Math.sin(a)];
    });
  }, []);
  const dummy = useMemo(() => new Object3D(), []);

  useFrame(() => {
    const time = shared.uTime.value;
    meshes.current.forEach((m, b) => {
      if (!m) return;
      // Each launcher fires every few seconds, out of step with the others.
      const period = 3.2 + b * 0.45;
      const t = (time + b * 1.37) % period;
      const shot = Math.floor((time + b * 1.37) / period);
      const random = randomFrom(shot * 7919 + b * 104729);
      // The first values of nearby seeds are close together: skip them.
      random();
      random();
      random();
      const cx = -600 + random() * 1200;
      const cz = 300 + random() * 300; // over the water, south of the square
      const cy = 130 + random() * 90;
      const spread = Math.min(1, t / 0.9) * (38 + random() * 18);
      const fall = t * t * 4;
      const fade = t < 2.2 ? 1 : 0;
      directions.forEach(([dx, dy, dz], i) => {
        dummy.position.set(cx + dx * spread, cy + dy * spread - fall, cz + dz * spread);
        dummy.scale.setScalar(fade * (1 - t / 2.4));
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
      });
      m.instanceMatrix.needsUpdate = true;
    });
  });

  return (
    <>
      {Array.from({ length: BURSTS }, (_, b) => (
        <instancedMesh
          key={b}
          ref={(m) => {
            meshes.current[b] = m;
          }}
          args={[geometry, materials[b % materials.length], SPARKS]}
          renderOrder={9}
          raycast={noRaycast}
          frustumCulled={false}
        />
      ))}
    </>
  );
}

/** Whatever the date calls for. */
export function Festivities({ roads }: { roads: Polyline[] }) {
  const { month, day } = useMemo(lisbonDate, []);
  const christmas = month === 12 || (month === 1 && day <= 6);
  const santos = month === 6;
  // Midnight on New Year's Eve, by Lisbon's clocks (or ?date=…-12-31 or -01-01 with ?time=).
  const minutes = useMemo(() => {
    const forced = new URLSearchParams(window.location.search).get("time")?.match(/^(\d{1,2}):(\d{2})$/);
    return forced ? Number(forced[1]) * 60 + Number(forced[2]) : lisbonMinutes(new Date());
  }, []);
  const newYear = (month === 12 && day === 31 && minutes >= 23 * 60 + 30) || (month === 1 && day === 1 && minutes <= 45);
  return (
    <>
      {christmas && <ChristmasLights roads={roads} />}
      {santos && <Bunting roads={roads} />}
      {newYear && <Fireworks />}
    </>
  );
}
