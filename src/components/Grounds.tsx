// Parks, campuses and the airport up close (data from scripts/08_grounds.py):
// footpaths through the green spaces and campuses, pedestrian squares in
// calçada, hedges (the box parterre of Parque Eduardo VII), flagpoles, planes
// parked at the airport's stands and the jet bridges that reach them.
import { useLayoutEffect, useMemo, useRef } from "react";
import earcut from "earcut";
import { BoxGeometry, BufferAttribute, BufferGeometry, InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createCalcadaMaterial, createPathMaterial } from "../city/groundMaterials";
import { buildRibbons, loadLines, type Polyline } from "../city/lines";
import { randomFrom } from "./Extras";
import { createPlaneGeometry } from "./Life";

const noRaycast = () => null;

// Line classes in grounds.bin.
const PATH = 0;
const WIDE = 1;
const STEPS = 2;
const HEDGE = 3;
const JET_BRIDGE = 4;

/** Half widths of a footpath, a wide path or track, and steps. */
const PATH_HALF_WIDTH = [1.3, 2.4, 1.7];
const HEDGE_HEIGHT_M = 1.4;
const HEDGE_WIDTH_M = 1.3;
const JET_BRIDGE_Y_M = 4.5;
/** Planes at their stands: a little smaller than the one that lands, most stands taken. */
const STAND_PLANE_SCALE = 1.15;
const STAND_TAKEN = 0.7;
/** The plane's nose is this far ahead of its middle (the model is 38 m long, nose along +x). */
const NOSE_M = 19;

export interface GroundsData {
  paths: Polyline[];
  hedges: Polyline[];
  jetBridges: Polyline[];
  /** Pedestrian squares: the outline, then any holes. */
  squares: number[][][][];
  /** [x, y, height, Portuguese flag 1/0] */
  flagpoles: number[][];
  /** [x, y, heading]: where the nose stops, and the way it points. */
  stands: number[][];
}

export async function loadGrounds(): Promise<GroundsData> {
  const index = await (await fetch("/data/grounds.json")).json();
  const lines = await loadLines(index.file, index.unitsPerMetre);
  return {
    paths: lines.filter((l) => l.cls === PATH || l.cls === WIDE || l.cls === STEPS),
    hedges: lines.filter((l) => l.cls === HEDGE),
    jetBridges: lines.filter((l) => l.cls === JET_BRIDGE),
    squares: index.squares,
    flagpoles: index.flagpoles,
    stands: index.stands,
  };
}

/** A box along each segment of each line, all merged: hedges, jet bridges. */
function boxesAlong(lines: Polyline[], width: number, height: number, y: number): BufferGeometry | null {
  const boxes: BufferGeometry[] = [];
  for (const { points } of lines) {
    for (let i = 1; i < points.length / 2; i++) {
      const ax = points[i * 2 - 2];
      const ay = points[i * 2 - 1];
      const bx = points[i * 2];
      const by = points[i * 2 + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.3) continue;
      // A little longer than the segment, so corners close.
      boxes.push(
        new BoxGeometry(len + width * 0.9, height, width)
          .rotateY(Math.atan2(by - ay, bx - ax))
          .translate((ax + bx) / 2, y + height / 2, -(ay + by) / 2)
          .toNonIndexed(),
      );
    }
  }
  if (!boxes.length) return null;
  const merged = mergeGeometries(boxes.map((b) => (b.deleteAttribute("uv"), b)));
  return merged;
}

export function Grounds({ data }: { data: GroundsData }) {
  const pathMaterial = useMemo(createPathMaterial, []);
  const paths = useMemo(() => (data.paths.length ? buildRibbons(data.paths, PATH_HALF_WIDTH, 0.3) : null), [data]);
  const hedges = useMemo(() => boxesAlong(data.hedges, HEDGE_WIDTH_M, HEDGE_HEIGHT_M, 0), [data]);

  return (
    <>
      {/* Under the streets (renderOrder 1), over the grass. */}
      {paths && <mesh geometry={paths} material={pathMaterial} renderOrder={0.5} raycast={noRaycast} frustumCulled={false} />}
      {data.squares.length > 0 && <Squares squares={data.squares} />}
      {hedges && (
        <mesh geometry={hedges} raycast={noRaycast} frustumCulled={false}>
          <meshLambertMaterial color="#4a6e36" />
        </mesh>
      )}
      <Flagpoles items={data.flagpoles} />
      <Stands stands={data.stands} jetBridges={data.jetBridges} />
    </>
  );
}

/** Pedestrian squares paved in calçada, with their holes (lawns, fountains) left open. */
function Squares({ squares }: { squares: number[][][][] }) {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const rings of squares) {
      const flat: number[] = [];
      const holes: number[] = [];
      for (const [k, ring] of rings.entries()) {
        if (k > 0) holes.push(flat.length / 2);
        for (const [x, y] of ring) flat.push(x, y);
      }
      const base = positions.length / 3;
      for (let i = 0; i < flat.length; i += 2) positions.push(flat[i], 0.3, -flat[i + 1]);
      for (const i of earcut(flat, holes.length ? holes : undefined)) indices.push(base + i);
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

/** A pole and its flag: Portugal's green and red where it is the national flag, white otherwise. */
function Flagpoles({ items }: { items: number[][] }) {
  const model = useMemo(() => {
    const poles: BufferGeometry[] = [];
    const green: BufferGeometry[] = [];
    const red: BufferGeometry[] = [];
    const white: BufferGeometry[] = [];
    for (const [x, y, height, portugal] of items) {
      const thick = Math.max(0.25, height * 0.012);
      poles.push(new BoxGeometry(thick, height, thick).translate(x, height / 2, -y).toNonIndexed());
      // The flag hangs from the top, 3:2, about a quarter of the pole long; it points
      // south-west, the way the wind mostly blows it over Lisbon (from the north).
      const w = height * 0.26;
      const h = (w * 2) / 3;
      const top = height - 0.3 - h / 2;
      const at = (from: number, to: number) =>
        new BoxGeometry(w * (to - from), h, 0.15)
          .translate(w * ((from + to) / 2), 0, 0)
          .rotateY(Math.PI * 0.75)
          .translate(x, top, -y)
          .toNonIndexed();
      if (portugal) {
        green.push(at(0, 0.4));
        red.push(at(0.4, 1));
      } else {
        white.push(at(0, 1));
      }
    }
    const merge = (list: BufferGeometry[]) => (list.length ? mergeGeometries(list) : null);
    return { poles: merge(poles), green: merge(green), red: merge(red), white: merge(white) };
  }, [items]);

  return (
    <>
      {(
        [
          [model.poles, "#d8d8d4"],
          [model.green, "#1f6b3a"],
          [model.red, "#c8322b"],
          [model.white, "#f2f0ea"],
        ] as const
      ).map(
        ([geometry, color], i) =>
          geometry && (
            <mesh key={i} geometry={geometry} raycast={noRaycast} frustumCulled={false}>
              <meshLambertMaterial color={color} />
            </mesh>
          ),
      )}
    </>
  );
}

/** Planes parked at most of the airport's stands, nose in, and the jet bridges. */
function Stands({ stands, jetBridges }: { stands: number[][]; jetBridges: Polyline[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const planeGeometry = useMemo(createPlaneGeometry, []);
  const taken = useMemo(() => {
    const random = randomFrom(11);
    return stands.filter(() => random() < STAND_TAKEN);
  }, [stands]);
  const bridges = useMemo(() => {
    const corridors = boxesAlong(jetBridges, 3.2, 3, JET_BRIDGE_Y_M);
    // A leg under the end of each bridge, where it meets the plane.
    const legs: BufferGeometry[] = [];
    for (const { points } of jetBridges) {
      const n = points.length / 2;
      legs.push(new BoxGeometry(1.2, JET_BRIDGE_Y_M, 1.2).translate(points[n * 2 - 2], JET_BRIDGE_Y_M / 2, -points[n * 2 - 1]).toNonIndexed());
    }
    const parts = [corridors, ...legs].filter((g): g is BufferGeometry => g !== null);
    return parts.length ? mergeGeometries(parts.map((g) => (g.deleteAttribute("uv"), g))) : null;
  }, [jetBridges]);

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const matrix = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scale = new Vector3(STAND_PLANE_SCALE, STAND_PLANE_SCALE, STAND_PLANE_SCALE);
    taken.forEach(([x, y, heading], i) => {
      const cx = x - Math.cos(heading) * NOSE_M * STAND_PLANE_SCALE;
      const cy = y - Math.sin(heading) * NOSE_M * STAND_PLANE_SCALE;
      q.setFromAxisAngle(up, heading);
      matrix.compose(new Vector3(cx, 2.4 * STAND_PLANE_SCALE, -cy), q, scale);
      m.setMatrixAt(i, matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [taken]);

  return (
    <>
      {taken.length > 0 && (
        <instancedMesh ref={mesh} args={[planeGeometry, undefined, taken.length]} raycast={noRaycast} frustumCulled={false}>
          <meshLambertMaterial vertexColors />
        </instancedMesh>
      )}
      {bridges && (
        <mesh geometry={bridges} raycast={noRaycast} frustumCulled={false}>
          <meshLambertMaterial color="#d6d3cc" />
        </mesh>
      )}
    </>
  );
}
