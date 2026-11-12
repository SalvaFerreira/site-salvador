// The parts of the scene that are not buildings: bridge, tram, Plan layer.
import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { Color, type BufferGeometry, type Mesh, type MeshBasicMaterial } from "three";
import { shared } from "../city/environment";
import { loadShapes, type Manifest } from "../city/loadCity";
import { buildRibbons, createPlanLineMaterial, createTrafficMaterial, loadLines } from "../city/roads";

const noRaycast = () => null;
type Point3 = [number, number, number];

export const BRIDGE_DECK_M = 70;
const CABLE_SIDE_SPAN_M = 480;

/** Ponte 25 de Abril: deck with traffic, towers with red lights, main cables. */
export function Bridge({ manifest }: { manifest: Manifest }) {
  const decks = useMemo(() => {
    const northbound = createTrafficMaterial("#fff0cf"); // headlights
    const southbound = createTrafficMaterial("#ff3a26"); // tail lights
    return manifest.bridge
      .filter((way) => way.kind === "road" && way.points.length > 1)
      .map((way) => {
        const goesNorth = way.points[way.points.length - 1][1] > way.points[0][1];
        return {
          geometry: buildRibbons([{ points: way.points.flat(), cls: 0 }], [6], BRIDGE_DECK_M),
          material: goesNorth ? northbound : southbound,
        };
      });
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
        <Line key={i} points={points} color="#5a4630" lineWidth={1} />
      ))}
      {manifest.bridgeTowers.map((t, i) => (
        <group key={i} position={[t.x, 0, -t.y]}>
          <mesh position-y={t.height / 2} raycast={noRaycast}>
            <boxGeometry args={[t.width, t.height, t.depth]} />
            <meshBasicMaterial color="#17120e" />
          </mesh>
          {/* Red aviation lights on the two tall towers */}
          {t.height >= 150 && (
            <mesh position-y={t.height + 3} raycast={noRaycast}>
              <sphereGeometry args={[3, 12, 8]} />
              <meshBasicMaterial color={[6, 0.35, 0.2]} toneMapped={false} />
            </mesh>
          )}
        </group>
      ))}
    </>
  );
}

const TRAM_SPEED = 7; // m/s
const TRAM_PAUSE_S = 45;
const TRAM_NIGHT = new Color(2.4, 1.7, 0.55);
const TRAM_DAY = new Color("#e2b21f");

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
    m.position.set(ax + (bx - ax) * t, 1.7, -(ay + (by - ay) * t));
    m.rotation.y = Math.atan2(by - ay, bx - ax);
    (m.material as MeshBasicMaterial).color.copy(TRAM_DAY).lerp(TRAM_NIGHT, shared.uNight.value);
  });

  return (
    <mesh ref={mesh} raycast={noRaycast}>
      <boxGeometry args={[13, 3, 2.4]} />
      <meshBasicMaterial toneMapped={false} />
    </mesh>
  );
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

/** Ecology (green spaces) and infrastructure (rail, metro, tram) drawn over the city. */
export function PlanLayer({ plan, visible }: { plan: PlanData; visible: boolean }) {
  const [green, setGreen] = useState<BufferGeometry | null>(null);
  const [rail, setRail] = useState<BufferGeometry | null>(null);
  const lineMaterial = useMemo(createPlanLineMaterial, []);
  const wanted = useRef(false);

  useEffect(() => {
    // Downloaded the first time the layer is switched on.
    if (!visible || wanted.current) return;
    wanted.current = true;
    loadShapes(plan.green.file, plan.green.unitsPerMetre).then(setGreen);
    loadLines(plan.rail.file, plan.rail.unitsPerMetre).then((lines) => setRail(buildRibbons(lines, [9, 9, 8, 5], 1.2)));
  }, [visible, plan]);

  return (
    <group visible={visible}>
      {green && (
        <mesh geometry={green} position-y={0.3} raycast={noRaycast}>
          <meshBasicMaterial color="#4f7242" transparent opacity={0.38} depthWrite={false} />
        </mesh>
      )}
      {rail && <mesh geometry={rail} material={lineMaterial} raycast={noRaycast} frustumCulled={false} />}
    </group>
  );
}
