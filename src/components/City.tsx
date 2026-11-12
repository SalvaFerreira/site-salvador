import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Vector3, type BufferGeometry } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { createBuildingMaterial, FOG_COLOR, FOG_DENSITY } from "../city/buildingMaterial";
import { loadChunk, loadLand, loadManifest, project, type Featured, type Manifest } from "../city/loadCity";
import { createRoadMaterial, loadRoads } from "../city/roads";
import Panel from "./Panel";

export interface Project {
  slug: string;
  /** Address of this place on the site, e.g. /work/<slug> or /now. */
  path: string;
  kind: "work" | "now" | "contact";
  lights: "on" | "off";
  title: string;
  place: string;
  coordinates: [number, number];
  stack: string[];
  html: string;
}

interface Chunk {
  id: string;
  geometry: BufferGeometry;
  position: [number, number, number];
}

interface Stats {
  buildings: number;
  triangles: number;
  firstChunkMs: number;
  loadMs: number;
  fps: number;
}

type OnStats = (patch: Partial<Stats>) => void;

/** A marked place in the scene: a featured building, or a bare spot (bridge, south bank). */
interface Place {
  index: number;
  x: number;
  z: number;
  /** Height of the building; 0 for a bare spot. */
  height: number;
  radius: number;
  /** Height the camera looks at, and height of the label. */
  lookY: number;
  labelY: number;
  /** How far back the camera stays, as a multiple of the usual close-up. */
  zoom: number;
}

function buildingPlace(f: Featured): Place {
  return { index: f.index, x: f.x, z: f.z, height: f.height, radius: f.radius, lookY: f.height / 2, labelY: f.height + 6, zoom: 1 };
}

declare global {
  interface Window {
    __city?: Stats;
  }
}

// Scene origin is Praça do Comércio; the Baixa grid starts just north of it.
const BAIXA = new Vector3(0, 0, -350);
const START_CAMERA = new Vector3(500, 1150, 1150);
/** Where the camera sits relative to a building it has flown to. */
const CLOSE_UP = new Vector3(150, 190, 260);
const FLIGHT_SECONDS = 2.6;
const BRIDGE_DECK_M = 70;

const noRaycast = () => null;
/** ?shot: no interface, for taking the preview images. */
const SHOT = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

function useCity(projects: Project[], onStats: OnStats) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [land, setLand] = useState<BufferGeometry | null>(null);
  const [roads, setRoads] = useState<BufferGeometry | null>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);

  useEffect(() => {
    let cancelled = false;
    const start = performance.now();

    (async () => {
      const m = await loadManifest();
      if (cancelled) return;
      setManifest(m);
      loadLand(m).then((g) => !cancelled && setLand(g));
      loadRoads(m).then((g) => !cancelled && setRoads(g));

      const located = projects.map((p, index) => {
        const [x, y] = project(m, p.coordinates[0], p.coordinates[1]);
        return { index, x, y, dark: p.lights === "off", kind: p.kind };
      });
      const targets = located.filter((t) => t.kind === "work");
      // The bridge and the south bank are spots, not buildings.
      setPlaces(
        located
          .filter((t) => t.kind !== "work")
          .map((t) => {
            const onBridge = t.kind === "now";
            const y = onBridge ? BRIDGE_DECK_M : 0;
            return { index: t.index, x: t.x, z: -t.y, height: 0, radius: 0, lookY: y, labelY: y + 12, zoom: onBridge ? 4 : 2.2 };
          }),
      );
      const best = new Map<number, number>();

      // Nearest neighbourhoods first, so the Baixa appears before the suburbs.
      const order = [...m.chunks].sort(
        (a, b) => Math.hypot(a.origin[0], a.origin[1] + BAIXA.z) - Math.hypot(b.origin[0], b.origin[1] + BAIXA.z),
      );
      const pending = order.map((c, i) => loadChunk(c, m.unitsPerMetre, i * 7919, targets));
      let triangles = 0;
      let buildings = 0;
      for (let i = 0; i < order.length; i++) {
        const built = await pending[i];
        if (cancelled) return;
        const c = order[i];
        triangles += built.triangles;
        buildings += c.buildings;
        setChunks((prev) => [...prev, { id: c.id, geometry: built.geometry, position: [c.origin[0], 0, -c.origin[1]] }]);
        for (const f of built.featured) {
          // A target near a neighbourhood border can match in two chunks: keep the closest.
          if ((best.get(f.index) ?? Infinity) <= f.distance) continue;
          best.set(f.index, f.distance);
          setPlaces((prev) => [...prev.filter((q) => q.index !== f.index), buildingPlace(f)]);
        }
        if (i === 0) onStats({ firstChunkMs: Math.round(performance.now() - start) });
        // Let the browser draw a frame between neighbourhoods.
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      onStats({ buildings, triangles, loadMs: Math.round(performance.now() - start) });
      for (const t of targets) {
        if (!best.has(t.index)) console.warn(`No building found near the coordinates of "${projects[t.index].title}"`);
      }
    })().catch((error) => console.error("City failed to load", error));

    return () => {
      cancelled = true;
    };
  }, [projects, onStats]);

  return { manifest, land, roads, chunks, places };
}

function FrameRate({ onStats }: { onStats: OnStats }) {
  const frames = useRef(0);
  const elapsed = useRef(0);
  useFrame((_, delta) => {
    frames.current += 1;
    elapsed.current += delta;
    if (elapsed.current >= 1) {
      onStats({ fps: Math.round(frames.current / elapsed.current) });
      frames.current = 0;
      elapsed.current = 0;
    }
  });
  return null;
}

/** Camera position and look-at point for a building, leaving room for the panel. */
function closeUp(place: Place): { position: Vector3; target: Vector3 } {
  const target = new Vector3(place.x, place.lookY, place.z);
  if (window.innerWidth > 800 && !SHOT) {
    // Look a little to the right of the building so it sits left of the panel.
    const right = new Vector3(CLOSE_UP.z, 0, -CLOSE_UP.x).normalize();
    target.addScaledVector(right, 75 * place.zoom);
  }
  return { position: target.clone().addScaledVector(CLOSE_UP, place.zoom), target };
}

/** Flies the camera to the selected place, or back to the overview. */
function CameraRig({ place, reducedMotion }: { place: Place | null; reducedMotion: boolean }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const flight = useRef<{ t: number; fromPos: Vector3; fromTarget: Vector3; toPos: Vector3; toTarget: Vector3 } | null>(null);
  const first = useRef(true);

  useEffect(() => {
    if (!controls) return;
    const to = place ? closeUp(place) : { position: START_CAMERA, target: BAIXA };
    // No flight on first paint (a shared link opens already at its place)
    // or when the visitor asked for reduced motion.
    if (first.current || reducedMotion) {
      first.current = false;
      camera.position.copy(to.position);
      controls.target.copy(to.target);
      controls.update();
      return;
    }
    flight.current = {
      t: 0,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos: to.position.clone(),
      toTarget: to.target.clone(),
    };
    controls.enabled = false;
  }, [place, controls, camera, reducedMotion]);

  useFrame((_, delta) => {
    const f = flight.current;
    if (!f || !controls) return;
    f.t = Math.min(1, f.t + delta / FLIGHT_SECONDS);
    const k = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2; // ease in-out
    camera.position.lerpVectors(f.fromPos, f.toPos, k);
    controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
    camera.lookAt(controls.target);
    if (f.t === 1) {
      flight.current = null;
      controls.enabled = true;
      controls.update();
    }
  });

  return null;
}

interface SceneProps {
  projects: Project[];
  selected: number;
  onSelect: (index: number) => void;
  reducedMotion: boolean;
  onStats: OnStats;
}

function Scene({ projects, selected, onSelect, reducedMotion, onStats }: SceneProps) {
  const { manifest, land, roads, chunks, places } = useCity(projects, onStats);
  const buildingMaterial = useMemo(createBuildingMaterial, []);
  const roadMaterial = useMemo(createRoadMaterial, []);
  const scene = useThree((s) => s.scene);
  const [hovered, setHovered] = useState(-1);

  useEffect(() => {
    scene.background = FOG_COLOR;
  }, [scene]);

  useEffect(() => {
    // The shader tags featured buildings with 1 + their index.
    const lit = hovered >= 0 ? hovered : selected;
    buildingMaterial.uniforms.uHover.value = lit >= 0 ? lit + 1 : -1;
    document.body.style.cursor = hovered >= 0 ? "pointer" : "";
  }, [hovered, selected, buildingMaterial]);

  const place = places.find((f) => f.index === selected) ?? null;
  // Wait for the building before moving, so a shared link does not start at the overview.
  const waiting = selected >= 0 && !place;

  return (
    <>
      <fogExp2 attach="fog" args={[FOG_COLOR, FOG_DENSITY]} />

      {/* Tejo */}
      <mesh rotation-x={-Math.PI / 2} position-y={-2} raycast={noRaycast}>
        <planeGeometry args={[60000, 60000]} />
        <meshBasicMaterial color="#020304" />
      </mesh>

      {land && (
        <mesh geometry={land} raycast={noRaycast}>
          <meshBasicMaterial color="#120d09" />
        </mesh>
      )}

      {roads && <mesh geometry={roads} material={roadMaterial} raycast={noRaycast} frustumCulled={false} />}

      {chunks.map((c) => (
        <mesh key={c.id} geometry={c.geometry} material={buildingMaterial} position={c.position} raycast={noRaycast} />
      ))}

      {/* The merged city is not raycast (a million triangles); each featured
          building gets an invisible box to click and a label that is a real button. */}
      {places.map((f) => (
        <group key={f.index} position={[f.x, 0, f.z]}>
          {f.radius > 0 && (
            <mesh
              position-y={f.height / 2}
              onPointerOver={() => setHovered(f.index)}
              onPointerOut={() => setHovered(-1)}
              onClick={() => onSelect(f.index)}
            >
              <boxGeometry args={[f.radius * 1.6, f.height, f.radius * 1.6]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          )}
          {selected !== f.index && (
            <Html position={[0, f.labelY, 0]} center zIndexRange={[5, 0]}>
              <button
                type="button"
                className="place-label"
                onClick={() => onSelect(f.index)}
                onPointerOver={() => setHovered(f.index)}
                onPointerOut={() => setHovered(-1)}
                onFocus={() => setHovered(f.index)}
                onBlur={() => setHovered(-1)}
              >
                {projects[f.index].title}
              </button>
            </Html>
          )}
        </group>
      ))}

      {manifest?.bridge.map((way, i) => (
        <Line
          key={i}
          points={way.points.map(([x, y]) => [x, BRIDGE_DECK_M, -y] as [number, number, number])}
          color="#ffb15c"
          lineWidth={1.5}
        />
      ))}

      {/* Bridge towers, with the red aviation lights on top */}
      {manifest?.bridgeTowers.map((t, i) => (
        <group key={i} position={[t.x, 0, -t.y]}>
          <mesh position-y={t.height / 2} raycast={noRaycast}>
            <boxGeometry args={[t.width, t.height, t.depth]} />
            <meshBasicMaterial color="#0a0908" />
          </mesh>
          <mesh position-y={t.height + 3} raycast={noRaycast}>
            <sphereGeometry args={[3, 12, 8]} />
            <meshBasicMaterial color={[6, 0.35, 0.2]} toneMapped={false} />
          </mesh>
        </group>
      ))}

      <OrbitControls
        makeDefault
        target={BAIXA}
        enableDamping={!reducedMotion}
        dampingFactor={0.08}
        minDistance={150}
        maxDistance={9000}
        maxPolarAngle={Math.PI * 0.46}
      />
      {!waiting && <CameraRig place={place} reducedMotion={reducedMotion} />}

      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur luminanceThreshold={0.6} luminanceSmoothing={0.3} intensity={1.3} radius={0.7} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>

      <FrameRate onStats={onStats} />
    </>
  );
}

const trim = (path: string) => path.replace(/\/+$/, "");

/** The 3D city needs WebGL 2 on a real GPU, and is too heavy for low-memory phones. */
function canRunCity(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has("fallback")) return false;
  const gl = document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true });
  if (!gl) return false;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  const phone = window.matchMedia("(pointer: coarse)").matches;
  return !(phone && memory !== undefined && memory <= 2);
}

export default function City({ projects, initialPath }: { projects: Project[]; initialPath?: string }) {
  const live = useMemo(canRunCity, []);
  const showStats = useMemo(() => new URLSearchParams(window.location.search).has("stats"), []);
  const reducedMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [stats, setStats] = useState<Stats>({ buildings: 0, triangles: 0, firstChunkMs: 0, loadMs: 0, fps: 0 });
  const onStats = useCallback<OnStats>((patch) => {
    setStats((prev) => {
      const next = { ...prev, ...patch };
      window.__city = next;
      return next;
    });
  }, []);

  const [selected, setSelected] = useState(() => projects.findIndex((p) => p.path === initialPath));
  const current = selected >= 0 ? projects[selected] : null;

  // Every project has its own address; moving around the city never reloads the page.
  const select = useCallback(
    (index: number) => {
      setSelected(index);
      const path = index >= 0 ? projects[index].path : "/";
      if (trim(window.location.pathname) !== trim(path)) {
        window.history.pushState(null, "", path + window.location.search);
      }
    },
    [projects],
  );
  const close = useCallback(() => select(-1), [select]);

  useEffect(() => {
    const onPop = () => setSelected(projects.findIndex((p) => p.path === trim(window.location.pathname)));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [projects]);

  useEffect(() => {
    document.title = current ? `${current.title} — Salvador Ferreira` : "Salvador Ferreira";
  }, [current]);

  return (
    <div className="city">
      {live ? (
        <Canvas
          flat
          dpr={[1, 1.5]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          camera={{ position: START_CAMERA, fov: 40, near: 20, far: 40000 }}
        >
          <Scene projects={projects} selected={selected} onSelect={select} reducedMotion={reducedMotion} onStats={onStats} />
        </Canvas>
      ) : (
        // No 3D: a still of the city. Everything stays reachable through the List.
        <div className="fallback">
          <img src="/city.jpg" alt="Lisbon at night, seen from above" />
        </div>
      )}
      {current && !SHOT && <Panel project={current} onClose={close} />}
      {showStats && live && (
        <p className="stats">
          {`${stats.fps} fps\n${stats.buildings} buildings, ${stats.triangles} triangles\nfirst neighbourhood ${stats.firstChunkMs} ms, all ${stats.loadMs} ms`}
        </p>
      )}
    </div>
  );
}
