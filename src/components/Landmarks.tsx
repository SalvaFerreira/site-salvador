// Landmarks modelled by hand, where a block raised from the outline would not
// do: the Arco da Rua Augusta and the Padrão dos Descobrimentos. Simple
// shapes in the style of the rest of the city, placed and turned to their
// outlines in OpenStreetMap (07_street.py).
import { useMemo } from "react";
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const noRaycast = () => null;
const STONE = "#ebe2cb";
const STONE_DARK = "#d6cbb0";
const LIMESTONE = "#f2eee4";

function colored(g: BufferGeometry, color: string): BufferGeometry {
  const geometry = g.index ? g.toNonIndexed() : g;
  if (geometry.getAttribute("uv")) geometry.deleteAttribute("uv");
  const c = new Color(color);
  const colors = new Float32Array(geometry.getAttribute("position").count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number, color = STONE) =>
  colored(new BoxGeometry(w, h, d).translate(x, y + h / 2, z), color);

/**
 * Arco da Rua Augusta, in its own frame: x along the long side, z through the
 * arch (the street passes along z), y up. `length` and `depth` from the outline.
 */
function createArco(length: number, depth: number): BufferGeometry {
  const opening = length * 0.38;
  const pier = (length - opening) / 2;
  const archTop = 16;
  const parts: BufferGeometry[] = [
    // The two piers and the lintel over the opening.
    box(pier, 22, depth, -(opening + pier) / 2, 0, 0),
    box(pier, 22, depth, (opening + pier) / 2, 0, 0),
    box(opening, 22 - archTop, depth, 0, archTop, 0),
    // Cornice, attic and the group of statues on top.
    box(length + 1, 1.2, depth + 1, 0, 22, 0, STONE_DARK),
    box(length * 0.92, 5.5, depth * 0.85, 0, 23.2, 0),
    box(length * 0.5, 1, depth * 0.6, 0, 28.7, 0, STONE_DARK),
    box(length * 0.36, 3.2, depth * 0.35, 0, 29.7, 0, STONE_DARK),
    box(2.2, 4.5, 2.2, 0, 29.7, 0, STONE_DARK),
  ];
  // Paired columns on both faces of each pier.
  for (const face of [-1, 1]) {
    for (const side of [-1, 1]) {
      for (const k of [0.25, 0.75]) {
        const x = side * (opening / 2 + pier * k);
        parts.push(colored(new CylinderGeometry(0.75, 0.85, 18, 8).translate(x, 11.5, face * (depth / 2 + 0.6)), STONE_DARK));
      }
    }
  }
  return mergeGeometries(parts);
}

/**
 * Padrão dos Descobrimentos, in its own frame: x along its length with the
 * prow at -x (towards the river), z across, y up.
 */
function createPadrao(length: number, width: number): BufferGeometry {
  const parts: BufferGeometry[] = [
    // The platform, and the hull narrowing to the prow.
    box(length, 2, width, 0, 0, 0, LIMESTONE),
    box(length * 0.8, 6, width * 0.32, -length * 0.08, 2, 0, LIMESTONE),
    // The tall slab at the landward end, with the sword of the cross carved on it.
    box(5, 52, width * 0.62, length / 2 - 6, 0, 0, LIMESTONE),
    box(5.4, 30, 1.6, length / 2 - 6, 16, 0, "#e3ddcf"),
    box(5.4, 1.6, 9, length / 2 - 6, 38, 0, "#e3ddcf"),
  ];
  // Figures climbing both sides of the prow, the tallest next to the slab.
  const steps = 9;
  for (const side of [-1, 1]) {
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const x = length / 2 - 11 - t * (length - 16);
      const base = 2 + (1 - t) * 20;
      parts.push(box(3.6, 3, width * 0.22, x, base - 3, side * width * 0.24, LIMESTONE));
      parts.push(box(1.6, 4.2, 1.6, x, base, side * width * 0.24, "#e6e0d3"));
    }
  }
  return mergeGeometries(parts);
}

export function Landmarks({ places }: { places: Record<string, number[]> }) {
  const models = useMemo(() => {
    const out: { key: string; geometry: BufferGeometry; x: number; y: number; angle: number }[] = [];
    const arco = places["Arco do Triunfo da Rua Augusta"];
    if (arco) out.push({ key: "arco", geometry: createArco(arco[3], arco[4]), x: arco[0], y: arco[1], angle: arco[2] });
    const padrao = places["Padrão dos Descobrimentos"];
    if (padrao) {
      // Its long side points north from the river: turn it so the prow (-x) faces the water.
      const towardsLand = Math.sin(padrao[2]) > 0 ? padrao[2] : padrao[2] + Math.PI;
      out.push({ key: "padrao", geometry: createPadrao(padrao[3], padrao[4]), x: padrao[0], y: padrao[1], angle: towardsLand });
    }
    return out;
  }, [places]);

  return (
    <>
      {models.map((m) => (
        <mesh key={m.key} geometry={m.geometry} position={[m.x, 0.4, -m.y]} rotation-y={m.angle} raycast={noRaycast}>
          <meshLambertMaterial vertexColors />
        </mesh>
      ))}
    </>
  );
}
