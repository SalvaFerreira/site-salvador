// Ponte 25 de Abril: two-legged red towers with their cross beams, main
// cables over the tops, hangers down to the deck every few metres, the road
// deck with traffic between the legs, and at night the red lights on the
// towers and the lamps along the deck.
import { useMemo } from "react";
import { BoxGeometry, BufferAttribute, BufferGeometry, CatmullRomCurve3, TubeGeometry, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createFlatMaterial, createLightMaterial } from "../city/environment";
import { createTrafficMaterial } from "../city/groundMaterials";
import { buildRibbons } from "../city/lines";
import type { Manifest } from "../city/loadCity";

const noRaycast = () => null;

export const BRIDGE_DECK_M = 70;
const RED = "#b4705f";
/** How far the cables reach back from each tower to the anchorages. */
const SIDE_SPAN_M = 480;
/** Distance of each tower leg (and main cable) from the middle of the bridge. */
const LEG_OFFSET_M = 14;
const LEG_WIDTH_M = 6;
/** Heights of the cross beams between the two legs. */
const BEAMS_M = [62, 112, 150, 186];
const HANGER_EVERY_M = 15;
const DECK_LAMP_EVERY_M = 36;
/** The ramp over Alcântara is resampled this often, so it can bend down to the ground. */
const RAMP_STEP_M = 12;
const PIER_EVERY_M = 48;
const CONCRETE = "#b9b4aa";

const smoothstep = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/**
 * Height of the deck over a point of the map. Over the river and the anchorage it is
 * the deck of the bridge; north of the last tall pier the viaduct over Alcântara comes
 * down to the ground, where the road it joins is drawn (the map is flat, the real
 * viaduct lands on a hill).
 */
function createDeckHeight(manifest: Manifest) {
  const towers = manifest.bridgeTowers.filter((t) => t.height >= 150).sort((a, b) => b.y - a.y);
  const roads = manifest.bridge.filter((way) => way.kind === "road" && way.points.length > 1);
  if (towers.length < 2 || !roads.length) return () => BRIDGE_DECK_M;
  const [a, b] = [towers[0], towers[towers.length - 1]];
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / span;
  const uy = (b.y - a.y) / span;
  const along = (x: number, y: number) => (x - a.x) * ux + (y - a.y) * uy;
  // Where the deck meets the ground: the end of the bridge furthest north.
  let end = 0;
  for (const way of roads) for (const [x, y] of way.points) end = Math.min(end, along(x, y));
  // Where it is still at full height: the northernmost tall pier on land, or the anchorage.
  let top = -SIDE_SPAN_M;
  for (const t of manifest.bridgeTowers) if (t.height >= 60 && t.height < 150) top = Math.min(top, along(t.x, t.y));
  if (top <= end + 100) top = end + Math.min(600, -end * 0.6);
  return (x: number, y: number) => BRIDGE_DECK_M * smoothstep((along(x, y) - end) / (top - end));
}

/** A line resampled every `step` metres, with the deck height at each point. */
function resample(points: [number, number][], step: number, heightAt: (x: number, y: number) => number) {
  const out: number[] = [];
  const heights: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n;
      const y = y0 + ((y1 - y0) * k) / n;
      out.push(x, y);
      heights.push(heightAt(x, y));
    }
  }
  return { points: out, heights };
}

/** One tower in its own frame: x along the bridge, z across it, y up from the water. */
function createTowerGeometry(height: number, depth: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // Each leg a little narrower towards the top.
    parts.push(new BoxGeometry(depth, height * 0.55, LEG_WIDTH_M + 1).translate(0, (height * 0.55) / 2, side * LEG_OFFSET_M));
    parts.push(new BoxGeometry(depth * 0.85, height * 0.45, LEG_WIDTH_M).translate(0, height * 0.55 + (height * 0.45) / 2, side * LEG_OFFSET_M));
    // The saddle the cable rests on.
    parts.push(new BoxGeometry(depth * 0.9, 3, LEG_WIDTH_M + 2).translate(0, height + 1.5, side * LEG_OFFSET_M));
  }
  for (const y of BEAMS_M) {
    const h = y === BEAMS_M[BEAMS_M.length - 1] ? 7 : 5;
    parts.push(new BoxGeometry(depth * 0.7, h, LEG_OFFSET_M * 2).translate(0, Math.min(y, height - h / 2), 0));
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()));
}

export function Bridge({ manifest }: { manifest: Manifest }) {
  const deckMaterial = useMemo(createTrafficMaterial, []);
  const redLights = useMemo(() => createLightMaterial("#ff3a2a", 0.6), []);
  const lampLights = useMemo(() => createLightMaterial("#ffb15c"), []);
  // Hangers darken at night like the rest of the bridge.
  const hangerMaterial = useMemo(() => createFlatMaterial(RED, { opacity: 0.75, depthWrite: false }), []);

  const ramp = useMemo(() => {
    const heightAt = createDeckHeight(manifest);
    const lines = manifest.bridge
      .filter((way) => way.kind === "road" && way.points.length > 1)
      .map((way) => resample(way.points, RAMP_STEP_M, heightAt));
    // Under the part of the viaduct that comes down, concrete piers; along it, lamps
    // on the outer edge (the right of each carriageway).
    const piers: BufferGeometry[] = [];
    const lamps: BufferGeometry[] = [];
    for (const { points, heights } of lines) {
      let run = 0;
      let lampRun = 0;
      for (let i = 1; i < points.length / 2; i++) {
        const dx = points[i * 2] - points[i * 2 - 2];
        const dy = points[i * 2 + 1] - points[i * 2 - 1];
        const len = Math.hypot(dx, dy) || 1;
        run += len;
        lampRun += len;
        const h = heights[i];
        if (h > BRIDGE_DECK_M - 1) continue;
        const x = points[i * 2];
        const y = points[i * 2 + 1];
        if (run >= PIER_EVERY_M && h > 5) {
          run = 0;
          piers.push(new BoxGeometry(3.2, h, 7).rotateY(Math.atan2(dy, dx)).translate(x, h / 2 - 1, -y));
        }
        if (lampRun >= DECK_LAMP_EVERY_M && h > 1) {
          lampRun = 0;
          const ox = (dy / len) * 5.5;
          const oy = (-dx / len) * 5.5;
          lamps.push(new BoxGeometry(1.6, 1.6, 1.6).translate(x + ox, h + 6, -(y + oy)));
        }
      }
    }
    return {
      deck: buildRibbons(
        lines.map((l) => ({ points: l.points, heights: l.heights, cls: 0 })),
        [6],
        0,
      ),
      piers: piers.length ? mergeGeometries(piers.map((g) => g.toNonIndexed())) : null,
      lamps: lamps.length ? mergeGeometries(lamps.map((g) => g.toNonIndexed())) : null,
    };
  }, [manifest]);

  const model = useMemo(() => {
    const towers = manifest.bridgeTowers.filter((t) => t.height >= 150).sort((a, b) => b.y - a.y);
    if (towers.length < 2) return null;
    const [a, b] = [towers[0], towers[towers.length - 1]];
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    // Along the bridge (from the north tower to the south one) and across it, in map metres.
    const ux = (b.x - a.x) / span;
    const uy = (b.y - a.y) / span;
    const nx = -uy;
    const ny = ux;
    const heading = Math.atan2(uy, ux);
    const top = Math.min(a.height, b.height);
    const low = BRIDGE_DECK_M + 6;
    const at = (d: number, side: number, h: number) =>
      new Vector3(a.x + ux * d + nx * side * LEG_OFFSET_M, h, -(a.y + uy * d + ny * side * LEG_OFFSET_M));

    /** Height of a main cable `d` metres from the north tower (negative: towards the north anchorage). */
    const cableHeight = (d: number) => {
      if (d < 0) return BRIDGE_DECK_M + (top - BRIDGE_DECK_M) * (1 + d / SIDE_SPAN_M) ** 2;
      if (d > span) return BRIDGE_DECK_M + (top - BRIDGE_DECK_M) * (1 - (d - span) / SIDE_SPAN_M) ** 2;
      return low + (top - low) * (2 * (d / span) - 1) ** 2;
    };

    // Main cables as thin tubes.
    const cables: BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const points: Vector3[] = [];
      for (let d = -SIDE_SPAN_M; d <= span + SIDE_SPAN_M; d += 12) points.push(at(d, side, cableHeight(d) + 1.5));
      cables.push(new TubeGeometry(new CatmullRomCurve3(points), points.length * 2, 0.9, 5, false));
    }

    // Hangers: a thin line from each cable down to the deck.
    const hangers: number[] = [];
    for (let d = -SIDE_SPAN_M + HANGER_EVERY_M; d < span + SIDE_SPAN_M; d += HANGER_EVERY_M) {
      if (Math.abs(d) < 12 || Math.abs(d - span) < 12) continue;
      const h = cableHeight(d);
      if (h - BRIDGE_DECK_M < 2) continue;
      for (const side of [-1, 1]) {
        const p = at(d, side, h);
        const q = at(d, side, BRIDGE_DECK_M + 1);
        hangers.push(p.x, p.y, p.z, q.x, q.y, q.z);
      }
    }
    const hangerGeometry = new BufferGeometry();
    hangerGeometry.setAttribute("position", new BufferAttribute(new Float32Array(hangers), 3));

    // Lamps along both edges of the deck, and the red lights on top of the towers.
    const lamps: BufferGeometry[] = [];
    for (let d = -SIDE_SPAN_M; d < span + SIDE_SPAN_M; d += DECK_LAMP_EVERY_M) {
      for (const side of [-1, 1]) {
        const p = at(d, side * 0.9, BRIDGE_DECK_M + 6);
        lamps.push(new BoxGeometry(1.6, 1.6, 1.6).translate(p.x, p.y, p.z));
      }
    }
    const beacons: BufferGeometry[] = [];
    for (const t of [a, b]) {
      for (const side of [-1, 1]) {
        beacons.push(
          new BoxGeometry(2.6, 2.6, 2.6).translate(
            t.x + nx * side * LEG_OFFSET_M,
            t.height + 5,
            -(t.y + ny * side * LEG_OFFSET_M),
          ),
        );
      }
    }

    return {
      towers: towers.map((t) => ({ x: t.x, y: t.y, geometry: createTowerGeometry(t.height, t.depth) })),
      heading,
      cables: mergeGeometries(cables),
      hangers: hangerGeometry,
      lamps: mergeGeometries(lamps.map((g) => g.toNonIndexed())),
      beacons: mergeGeometries(beacons.map((g) => g.toNonIndexed())),
    };
  }, [manifest]);

  const others = manifest.bridgeTowers.filter((t) => t.height < 150);

  return (
    <>
      <mesh geometry={ramp.deck} material={deckMaterial} raycast={noRaycast} frustumCulled={false} />
      {ramp.piers && (
        <mesh geometry={ramp.piers} raycast={noRaycast} frustumCulled={false}>
          <meshLambertMaterial color={CONCRETE} />
        </mesh>
      )}
      {ramp.lamps && <mesh geometry={ramp.lamps} material={lampLights} renderOrder={4} raycast={noRaycast} frustumCulled={false} />}
      {model && (
        <>
          {model.towers.map((t, i) => (
            <group key={i} position={[t.x, 0, -t.y]} rotation-y={model.heading}>
              <mesh geometry={t.geometry} raycast={noRaycast}>
                <meshLambertMaterial color={RED} />
              </mesh>
              {/* The concrete pier the tower stands on, in the water. */}
              <mesh position={[0, 2, 0]} raycast={noRaycast}>
                <boxGeometry args={[22, 9, LEG_OFFSET_M * 2 + 16]} />
                <meshLambertMaterial color="#c9c4ba" />
              </mesh>
            </group>
          ))}
          <mesh geometry={model.cables} raycast={noRaycast} frustumCulled={false}>
            <meshLambertMaterial color={RED} />
          </mesh>
          <lineSegments geometry={model.hangers} material={hangerMaterial} raycast={noRaycast} frustumCulled={false} />
          <mesh geometry={model.lamps} material={lampLights} renderOrder={4} raycast={noRaycast} frustumCulled={false} />
          <mesh geometry={model.beacons} material={redLights} renderOrder={4} raycast={noRaycast} frustumCulled={false} />
        </>
      )}
      {/* Piers and anchorages on land, as they are mapped. */}
      {others.map((t, i) => (
        <mesh key={i} position={[t.x, t.height / 2, -t.y]} raycast={noRaycast}>
          <boxGeometry args={[t.width, t.height, t.depth]} />
          <meshLambertMaterial color={CONCRETE} />
        </mesh>
      ))}
    </>
  );
}
