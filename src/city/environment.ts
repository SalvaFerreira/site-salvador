// Values shared by every material in the scene.
import { AdditiveBlending, Color, ShaderMaterial, type MeshBasicMaterial } from "three";

/** Uniforms shared by reference: updating one value updates every material. */
export const shared = {
  /** Seconds since the scene started. */
  uTime: { value: 0 },
  /** 0 in daylight, 1 at night (from the sun over Lisbon; see daylight.ts). */
  uNight: { value: 0 },
  /** The warm light around sunrise and sunset, 0 to 1. */
  uDusk: { value: 0 },
};

/** Colour behind the map, outside the area that was modelled. */
export const BACKDROP = "#22252b";

const NIGHT_GLSL = /* glsl */ `
uniform float uNight;
uniform float uDusk;

// Dusk warms everything a little; night turns it dark blue.
vec3 atNight(vec3 c) {
  c = mix(c, c * vec3(1.1, 0.9, 0.76), uDusk * 0.55);
  return mix(c, c * vec3(0.19, 0.23, 0.36), uNight);
}
`;

/**
 * How a material changes after dark:
 * "dark"   darker and bluer, like the rest of the city;
 * "street" the same, with the warm light of the sodium street lamps;
 * "glow"   not darker: a glow that shows more at night.
 */
type NightMode = "dark" | "street" | "glow";

/** Makes one of the scene's shader materials follow the light of the day. */
export function withNight<T extends ShaderMaterial>(material: T, mode: NightMode = "dark"): T {
  const after =
    mode === "glow"
      ? "gl_FragColor.a *= 1.0 + 1.3 * uNight;"
      : mode === "street"
        ? "gl_FragColor.rgb = atNight(gl_FragColor.rgb) + vec3(0.5, 0.3, 0.1) * 0.13 * uNight;"
        : "gl_FragColor.rgb = atNight(gl_FragColor.rgb);";
  material.fragmentShader =
    NIGHT_GLSL + material.fragmentShader.replace("#include <colorspace_fragment>", `${after}\n  #include <colorspace_fragment>`);
  material.uniforms.uNight = shared.uNight;
  material.uniforms.uDusk = shared.uDusk;
  return material;
}

/** A plain colour that follows the light of the day (instead of MeshBasicMaterial). */
export function createFlatMaterial(color: string, options: { opacity?: number; depthWrite?: boolean } = {}): ShaderMaterial {
  const transparent = options.opacity !== undefined && options.opacity < 1;
  const material = new ShaderMaterial({
    vertexShader: /* glsl */ `
void main() {
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}
`,
    fragmentShader: /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;

void main() {
  gl_FragColor = vec4(uColor, uOpacity);
  #include <colorspace_fragment>
}
`,
    uniforms: { uColor: { value: new Color(color) }, uOpacity: { value: options.opacity ?? 1 } },
    transparent,
    depthWrite: options.depthWrite ?? !transparent,
  });
  return withNight(material);
}

/** Shadow materials in the scene: at night there is no sun to cast them, so they fade. */
export const shadowMaterials = new Set<MeshBasicMaterial>();

/**
 * A light that is only seen after dark: boat and ship lights, a plane's
 * navigation lights. `blink` > 0 makes it flash that many times a second.
 */
export function createLightMaterial(color: string, blink = 0): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
void main() {
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}
`,
    fragmentShader: /* glsl */ `
uniform vec3 uColor;
uniform float uNight;
uniform float uTime;
uniform float uBlink;

void main() {
  float on = uBlink > 0.0 ? step(fract(uTime * uBlink), 0.18) : 1.0;
  float a = smoothstep(0.3, 0.8, uNight) * on;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * 1.2, a);
  #include <colorspace_fragment>
}
`,
    uniforms: { uColor: { value: new Color(color) }, uNight: shared.uNight, uTime: shared.uTime, uBlink: { value: blink } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}
