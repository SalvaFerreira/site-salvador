// Lisbon's hills, shaded: a sheet over the ground that lightens the slopes
// facing the sun and darkens the others (data from scripts/09_terrain.py). The
// map stays flat; the shading is what makes the hills read from above.
import { useEffect, useMemo, useState } from "react";
import { AddEquation, CustomBlending, DstColorFactor, LinearFilter, PlaneGeometry, ShaderMaterial, SrcColorFactor, type Texture, TextureLoader } from "three";
import { shared } from "../city/environment";

interface ReliefIndex {
  file: string;
  /** South-west corner and size on the map, in metres from the scene origin. */
  box: [number, number, number, number];
}

/** How strong the shading is: 1 as computed, less to keep it subtle. */
const STRENGTH = 1;

export function Relief() {
  const [data, setData] = useState<{ index: ReliefIndex; texture: Texture } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const index: ReliefIndex = await (await fetch("/data/relief.json")).json();
      const texture = await new TextureLoader().loadAsync(`/data/${index.file}`);
      texture.magFilter = LinearFilter;
      texture.minFilter = LinearFilter;
      texture.generateMipmaps = false;
      if (!cancelled) setData({ index, texture });
    })().catch((error) => console.error("Relief failed to load", error));
    return () => {
      cancelled = true;
    };
  }, []);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
        // Blended as src * dst * 2: 0.5 leaves the ground as it is, more lightens it, less darkens it.
        fragmentShader: /* glsl */ `
uniform sampler2D uRelief;
uniform float uStrength;
uniform float uNight;
varying vec2 vUv;
void main() {
  float shade = texture2D(uRelief, vUv).r - 128.0 / 255.0;
  // Most slopes facing away from the sun are up to about 10% darker, those facing it about 5% lighter.
  float k = (shade < 0.0 ? 0.8 : 0.7) * uStrength;
  // Fainter at night, when there is no sun to cast it.
  float m = max(0.72, 1.0 + shade * k * mix(1.0, 0.4, uNight));
  gl_FragColor = vec4(vec3(0.5 * m), 1.0);
}
`,
        uniforms: { uRelief: { value: null }, uStrength: { value: STRENGTH }, uNight: shared.uNight },
        transparent: true,
        depthWrite: false,
        blending: CustomBlending,
        blendEquation: AddEquation,
        blendSrc: DstColorFactor,
        blendDst: SrcColorFactor,
      }),
    [],
  );

  const geometry = useMemo(() => {
    if (!data) return null;
    const [x0, y0, w, h] = data.index.box;
    // Lies flat just above the streets and parks; buildings, trees and cars stand in front of it.
    return new PlaneGeometry(w, h).rotateX(-Math.PI / 2).translate(x0 + w / 2, 0.9, -(y0 + h / 2));
  }, [data]);

  useEffect(() => {
    if (data) material.uniforms.uRelief.value = data.texture;
  }, [data, material]);

  if (!geometry) return null;
  return <mesh geometry={geometry} material={material} renderOrder={1.9} raycast={() => null} frustumCulled={false} />;
}
