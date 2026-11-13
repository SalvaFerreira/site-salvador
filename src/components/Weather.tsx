// The weather in Lisbon right now, from Open-Meteo (no key, no cookies; the
// request carries only Lisbon's coordinates): cloud shadows drifting over the
// city, rain, fog, and a word about it on the clock.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AdditiveBlending,
  InstancedBufferAttribute,
  InstancedMesh,
  MultiplyBlending,
  PlaneGeometry,
  ShaderMaterial,
  type Mesh,
  type OrthographicCamera,
} from "three";
import { quality, shared } from "../city/environment";

export interface Weather {
  /** 0 clear to 1 overcast. */
  clouds: number;
  /** 0 dry to 1 heavy rain. */
  rain: number;
  /** 0 clear air to 1 thick fog. */
  fog: number;
  /** Where the wind blows towards, radians from east towards north, and its speed in m/s. */
  windAngle: number;
  windSpeed: number;
  temperature: number | null;
  /** A few words: "light rain", "fog", "partly cloudy"… */
  label: string;
}

const CLEAR: Weather = { clouds: 0.1, rain: 0, fog: 0, windAngle: 0.3, windSpeed: 4, temperature: null, label: "" };

/** What each WMO weather code means here: words, rain, fog. */
function fromCode(code: number): { label: string; rain: number; fog: number; clouds?: number } {
  if (code === 0) return { label: "clear", rain: 0, fog: 0 };
  if (code === 1) return { label: "mainly clear", rain: 0, fog: 0 };
  if (code === 2) return { label: "partly cloudy", rain: 0, fog: 0 };
  if (code === 3) return { label: "overcast", rain: 0, fog: 0 };
  if (code === 45 || code === 48) return { label: "fog", rain: 0, fog: 1, clouds: 0.9 };
  if (code >= 51 && code <= 57) return { label: "drizzle", rain: 0.35, fog: 0.2, clouds: 0.9 };
  if (code === 61 || code === 80) return { label: "light rain", rain: 0.5, fog: 0, clouds: 0.95 };
  if (code === 63 || code === 81 || code === 66) return { label: "rain", rain: 0.75, fog: 0, clouds: 1 };
  if (code === 65 || code === 82 || code === 67) return { label: "heavy rain", rain: 1, fog: 0.1, clouds: 1 };
  if (code >= 71 && code <= 86) return { label: "snow", rain: 0.6, fog: 0.2, clouds: 1 };
  if (code >= 95) return { label: "thunderstorm", rain: 1, fog: 0, clouds: 1 };
  return { label: "", rain: 0, fog: 0 };
}

/** ?weather=clear|cloudy|rain|storm|fog shows that weather instead of the real one. */
const PRESETS: Record<string, Weather> = {
  clear: { ...CLEAR, clouds: 0, label: "clear", temperature: 21 },
  cloudy: { ...CLEAR, clouds: 0.6, label: "partly cloudy", temperature: 18 },
  rain: { ...CLEAR, clouds: 1, rain: 0.75, label: "rain", temperature: 14, windSpeed: 7 },
  storm: { ...CLEAR, clouds: 1, rain: 1, label: "thunderstorm", temperature: 13, windSpeed: 11 },
  fog: { ...CLEAR, clouds: 0.9, fog: 1, label: "fog", temperature: 12, windSpeed: 1.5 },
};

const URL_OPEN_METEO =
  "https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14" +
  "&current=temperature_2m,weather_code,cloud_cover,visibility,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms";

/** The weather in Lisbon now, refreshed every 20 minutes. Falls back to fair weather if the service cannot be reached. */
export function useWeather(): Weather {
  const preset = useMemo(() => PRESETS[new URLSearchParams(window.location.search).get("weather") ?? ""], []);
  const [weather, setWeather] = useState<Weather>(preset ?? CLEAR);
  useEffect(() => {
    if (preset) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(URL_OPEN_METEO);
        if (!res.ok) return;
        const c = (await res.json()).current;
        const code = fromCode(c.weather_code);
        // Low visibility is fog even when the code does not say so.
        const fog = Math.max(code.fog, c.visibility < 1500 ? 1 - c.visibility / 1500 : 0);
        if (cancelled) return;
        setWeather({
          clouds: code.clouds ?? Math.min(1, c.cloud_cover / 100),
          rain: code.rain,
          fog,
          // The meteorological direction is where the wind comes from, clockwise from north.
          windAngle: ((90 - c.wind_direction_10m + 180) * Math.PI) / 180,
          windSpeed: c.wind_speed_10m,
          temperature: c.temperature_2m,
          label: code.label,
        });
      } catch {
        // Offline or blocked: keep fair weather.
      }
    };
    load();
    const timer = window.setInterval(load, 20 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [preset]);
  return weather;
}

const NOISE = /* glsl */ `
float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

float clouds(vec2 p) {
  return noise(p) * 0.65 + noise(p * 2.3 + 7.3) * 0.35;
}
`;

/**
 * A sheet over the whole view that darkens where clouds pass between the sun
 * and the city (multiplied over everything, so roofs and streets alike), and
 * whitens it in fog. Cloud shadows are large and soft, so the sheet can lie
 * flat: being slightly off over tall buildings does not show.
 */
function createSkyMaterial(mode: "shadow" | "fog"): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
varying vec2 vGround;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vGround = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`,
    fragmentShader:
      /* glsl */ `
uniform float uTime;
uniform float uNight;
uniform float uCover;
uniform float uFog;
uniform vec2 uWind;
varying vec2 vGround;
` +
      NOISE +
      (mode === "shadow"
        ? /* glsl */ `
void main() {
  // Clouds drift with the wind; more of the sky covered means more and larger shadows.
  float c = clouds((vGround - uWind * uTime) / 900.0);
  float shade = smoothstep(1.0 - uCover * 0.95, 1.12 - uCover * 0.95, c);
  // Overcast: all of it a little dimmer. No sun at night, so no shadows.
  float dark = (0.3 * shade + 0.12 * uCover) * (1.0 - uNight);
  gl_FragColor = vec4(vec3(1.0 - dark), 1.0);
}
`
        : /* glsl */ `
void main() {
  float c = clouds((vGround - uWind * uTime * 0.6) / 500.0);
  float a = uFog * (0.16 + 0.34 * c);
  vec3 tint = mix(vec3(0.92, 0.93, 0.94), vec3(0.3, 0.33, 0.42), uNight);
  gl_FragColor = vec4(tint, a);
  #include <colorspace_fragment>
}
`),
    uniforms: {
      uTime: shared.uTime,
      uNight: shared.uNight,
      uCover: { value: 0 },
      uFog: { value: 0 },
      uWind: { value: [0, 0] },
    },
    depthTest: false,
    depthWrite: false,
    transparent: true,
    ...(mode === "shadow" ? { blending: MultiplyBlending, premultipliedAlpha: true } : {}),
  });
}

const DROPS = 2200;
const RAIN_TOP = 140;

/** Rain: thin streaks falling through the view, slanted by the wind. Moves with the camera. */
function createRain(): InstancedMesh {
  // One streak: a thin vertical quad from y=0 to y=1; the shader stretches and places it.
  const geometry = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const seeds = new Float32Array(DROPS * 3);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  geometry.setAttribute("seed", new InstancedBufferAttribute(seeds, 3));
  const material = new ShaderMaterial({
    vertexShader: /* glsl */ `
attribute vec3 seed;
uniform float uTime;
uniform float uSpan;
uniform float uPixel;
uniform vec2 uWind;
varying float vFade;

void main() {
  // Each drop falls from the top of its column to the ground, again and again.
  float fall = fract(seed.z + uTime * (0.9 + 0.3 * seed.x) * 0.55);
  float y = ${RAIN_TOP.toFixed(1)} * (1.0 - fall);
  vec3 base = vec3((seed.x - 0.5) * uSpan, y, (seed.y - 0.5) * uSpan);
  // Long and thin: about a pixel wide whatever the zoom, slanted with the wind.
  vec3 p = base + vec3(position.x * uPixel * 1.2, position.y * 9.0, 0.0);
  p.xz += uWind * position.y * 0.6;
  vFade = 1.0 - fall * fall;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`,
    fragmentShader: /* glsl */ `
uniform float uNight;
uniform float uRain;
varying float vFade;

void main() {
  vec3 c = mix(vec3(0.85, 0.9, 0.97), vec3(0.6, 0.66, 0.8), uNight);
  gl_FragColor = vec4(c, 0.5 * vFade * uRain);
}
`,
    uniforms: {
      uTime: shared.uTime,
      uNight: shared.uNight,
      uRain: { value: 0 },
      uSpan: { value: 1000 },
      uPixel: { value: 1 },
      uWind: { value: [0, 0] },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const mesh = new InstancedMesh(geometry, material, DROPS);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  mesh.raycast = () => null;
  return mesh;
}

/** Cloud shadows, rain and fog over the part of the city on screen. */
export function WeatherEffects({ weather, reducedMotion }: { weather: Weather; reducedMotion: boolean }) {
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const controls = useThree((s) => s.controls) as { target: { x: number; z: number } } | null;
  const size = useThree((s) => s.size);
  const shadowSheet = useRef<Mesh>(null);
  const fogSheet = useRef<Mesh>(null);
  const shadowMaterial = useMemo(() => createSkyMaterial("shadow"), []);
  const fogMaterial = useMemo(() => createSkyMaterial("fog"), []);
  const rain = useMemo(createRain, []);
  const sheet = useMemo(() => new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  const eased = useRef({ clouds: weather.clouds, rain: weather.rain, fog: weather.fog });

  useEffect(() => {
    shared.uClouds.value = weather.clouds;
  }, [weather.clouds]);

  useFrame((_, delta) => {
    const e = eased.current;
    const k = reducedMotion ? 1 : Math.min(1, delta * 0.5);
    e.clouds += (weather.clouds - e.clouds) * k;
    e.rain += (weather.rain - e.rain) * k;
    e.fog += (weather.fog - e.fog) * k;
    shared.uClouds.value = e.clouds;
    shared.uWet.value = Math.min(1, e.rain * 1.5);

    // Everything follows the middle of the view and covers all of it.
    const x = controls?.target.x ?? 0;
    const z = controls?.target.z ?? 0;
    const span = ((size.width + size.height * 2) / camera.zoom) * 1.2;
    const wind: [number, number] = [Math.cos(weather.windAngle) * weather.windSpeed, -Math.sin(weather.windAngle) * weather.windSpeed];
    for (const [mesh, material] of [
      [shadowSheet.current, shadowMaterial],
      [fogSheet.current, fogMaterial],
    ] as const) {
      if (!mesh) continue;
      mesh.position.set(x, 1, z);
      mesh.scale.set(span, 1, span);
      material.uniforms.uCover.value = e.clouds;
      material.uniforms.uFog.value = e.fog;
      material.uniforms.uWind.value = wind;
    }
    // No sun at night, so no cloud shadows to draw.
    if (shadowSheet.current) shadowSheet.current.visible = e.clouds > 0.05 && shared.uNight.value < 0.97 && quality.level > 0;
    if (fogSheet.current) fogSheet.current.visible = e.fog > 0.02;

    const r = rain.material as ShaderMaterial;
    rain.visible = e.rain > 0.02;
    rain.position.set(x, 0, z);
    r.uniforms.uRain.value = e.rain;
    r.uniforms.uSpan.value = Math.min(span, 2400);
    r.uniforms.uPixel.value = 1 / camera.zoom;
    r.uniforms.uWind.value = [wind[0] * 0.25, wind[1] * 0.25];
    // Fewer, but still visible, streaks when the view is wide.
    rain.count = Math.round(DROPS * Math.min(1, 0.35 + camera.zoom * 0.5) * e.rain * (quality.level === 0 ? 0.3 : 1));
  });

  return (
    <>
      <mesh ref={shadowSheet} geometry={sheet} material={shadowMaterial} renderOrder={6} raycast={() => null} frustumCulled={false} />
      <mesh ref={fogSheet} geometry={sheet} material={fogMaterial} renderOrder={8} raycast={() => null} frustumCulled={false} />
      <primitive object={rain} />
    </>
  );
}

/** "17 °C · light rain", for the clock. */
export function describe(weather: Weather): string {
  const parts = [weather.temperature !== null ? `${Math.round(weather.temperature)} °C` : "", weather.label];
  return parts.filter(Boolean).join(" · ");
}

