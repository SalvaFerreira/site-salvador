import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MOUSE, TOUCH, Vector3, type BufferGeometry, type OrthographicCamera } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { createBuildingMaterial } from "../city/buildingMaterial";
import { BACKDROP, shared } from "../city/environment";
import { createRiverMaterial, createStreetMaterial, STREET_HALF_WIDTH } from "../city/groundMaterials";
import { buildRibbons, loadLines, type Polyline } from "../city/lines";
import { loadChunk, loadManifest, loadShapes, project, type Featured, type Manifest } from "../city/loadCity";
import { Bridge, BRIDGE_DECK_M, Cars, loadPlan, Parks, PlanLayer, Tram, type PlanData } from "./Extras";
import Panel from "./Panel";

export interface Project {
  slug: string;
  /** Address of this place on the site, e.g. /work/<slug> or /now. */
  path: string;
  kind: "work" | "now" | "contact";
  /** "plan" places only show while the Plan layer is on. */
  layer: "city" | "plan";
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
  /** Height of the label above the ground. */
  labelY: number;
  /** Pixels per metre when the camera has flown here. */
  zoom: number;
}

function buildingPlace(f: Featured): Place {
  return { index: f.index, x: f.x, z: f.z, height: f.height, radius: f.radius, labelY: f.height + 4, zoom: 2.4 };
}

declare global {
  interface Window {
    __city?: Stats;
  }
}

// The camera always looks at the city from the same side and the same height,
// like a model on a table: it can slide and zoom, never tilt up to the sky.
const VIEW_FROM = new Vector3(1, 1.05, 1).normalize(); // from the south-east, looking north-west
const CAMERA_DISTANCE = 9000;
// Scene origin is Praça do Comércio; the Baixa grid starts just north of it.
const BAIXA = new Vector3(0, 0, -350);
const START_ZOOM = 0.42; // pixels per metre
const MIN_ZOOM = 0.09;
const MAX_ZOOM = 5;
const FLIGHT_SECONDS = 2.4;
const PANEL_WIDTH_PX = 620;

const noRaycast = () => null;
/** ?shot: no interface, for taking the preview images. */
const SHOT = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

function useCity(projects: Project[], onStats: OnStats) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [land, setLand] = useState<BufferGeometry | null>(null);
  const [roads, setRoads] = useState<{ lines: Polyline[]; geometry: BufferGeometry } | null>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [plan, setPlan] = useState<PlanData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const start = performance.now();

    (async () => {
      const m = await loadManifest();
      if (cancelled) return;
      setManifest(m);
      loadShapes(m.land.file, m.land.unitsPerMetre).then((g) => !cancelled && setLand(g));
      loadLines(m.roads.file, m.roads.unitsPerMetre).then(
        (lines) => !cancelled && setRoads({ lines, geometry: buildRibbons(lines, STREET_HALF_WIDTH, 0.4) }),
      );
      loadPlan().then((p) => !cancelled && setPlan(p));

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
            return {
              index: t.index,
              x: t.x,
              z: -t.y,
              height: 0,
              radius: 0,
              labelY: onBridge ? BRIDGE_DECK_M + 6 : 6,
              zoom: onBridge ? 0.55 : 1.1,
            };
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

  return { manifest, land, roads, chunks, places, plan };
}

/** Runs the clock that moves cars, tram and water, and measures the frame rate. */
function Clock({ reducedMotion, onStats }: { reducedMotion: boolean; onStats: OnStats }) {
  const frames = useRef(0);
  const elapsed = useRef(0);
  useFrame((state, delta) => {
    // prefers-reduced-motion: the clock stays at 0 and nothing in the city moves.
    shared.uTime.value = reducedMotion ? 0 : state.clock.elapsedTime;
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

/** Where the camera looks, and how close, for a place — leaving room for the panel. */
function closeUp(place: Place): { target: Vector3; zoom: number } {
  const target = new Vector3(place.x, 0, place.z);
  if (window.innerWidth > 800 && !SHOT) {
    // Look to the right of the place so it sits in the part of the screen the panel leaves free.
    const right = new Vector3(VIEW_FROM.z, 0, -VIEW_FROM.x).normalize();
    target.addScaledVector(right, Math.min(PANEL_WIDTH_PX, window.innerWidth / 2) / 2 / place.zoom);
  }
  return { target, zoom: place.zoom };
}

interface RigProps {
  place: Place | null;
  reducedMotion: boolean;
  bounds: [number, number, number, number] | null;
}

/** Keeps the fixed viewing angle, and flies to the selected place or back to the overview. */
function CameraRig({ place, reducedMotion, bounds }: RigProps) {
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const flight = useRef<{ t: number; fromTarget: Vector3; toTarget: Vector3; fromZoom: number; toZoom: number } | null>(null);
  const first = useRef(true);

  const apply = useCallback(
    (target: Vector3, zoom: number) => {
      if (!controls) return;
      controls.target.copy(target);
      camera.position.copy(target).addScaledVector(VIEW_FROM, CAMERA_DISTANCE);
      camera.zoom = zoom;
      camera.lookAt(target);
      camera.updateProjectionMatrix();
    },
    [camera, controls],
  );

  useEffect(() => {
    if (!controls) return;
    const to = place ? closeUp(place) : { target: BAIXA, zoom: START_ZOOM };
    // No flight on first paint (a shared link opens already at its place)
    // or when the visitor asked for reduced motion.
    if (first.current || reducedMotion) {
      first.current = false;
      apply(to.target, to.zoom);
      controls.update();
      return;
    }
    flight.current = { t: 0, fromTarget: controls.target.clone(), toTarget: to.target.clone(), fromZoom: camera.zoom, toZoom: to.zoom };
    controls.enabled = false;
  }, [place, controls, camera, reducedMotion, apply]);

  // Dragging stops at the edge of the modelled city.
  useEffect(() => {
    if (!controls || !bounds) return;
    const [minX, minY, maxX, maxY] = bounds;
    const clamp = () => {
      const t = controls.target;
      const x = Math.min(maxX, Math.max(minX, t.x));
      const z = Math.min(-minY, Math.max(-maxY, t.z));
      if (x !== t.x || z !== t.z || t.y !== 0) {
        t.set(x, 0, z);
        camera.position.copy(t).addScaledVector(VIEW_FROM, CAMERA_DISTANCE);
      }
    };
    controls.addEventListener("change", clamp);
    return () => controls.removeEventListener("change", clamp);
  }, [controls, bounds, camera]);

  const target = useMemo(() => new Vector3(), []);
  useFrame((_, delta) => {
    const f = flight.current;
    if (!f || !controls) return;
    f.t = Math.min(1, f.t + delta / FLIGHT_SECONDS);
    const k = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2; // ease in-out
    // Zoom is interpolated as a ratio, so the flight feels even from far to near.
    apply(target.lerpVectors(f.fromTarget, f.toTarget, k), f.fromZoom * (f.toZoom / f.fromZoom) ** k);
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
  planOn: boolean;
}

function Scene({ projects, selected, onSelect, reducedMotion, onStats, planOn }: SceneProps) {
  const { manifest, land, roads, chunks, places, plan } = useCity(projects, onStats);
  const buildingMaterial = useMemo(createBuildingMaterial, []);
  const streetMaterial = useMemo(createStreetMaterial, []);
  const riverMaterial = useMemo(createRiverMaterial, []);
  const [hovered, setHovered] = useState(-1);

  useEffect(() => {
    shared.uPlan.value = planOn ? 1 : 0;
  }, [planOn]);

  useEffect(() => {
    // The shader tags featured buildings with 1 + their index.
    const lit = hovered >= 0 ? hovered : selected;
    buildingMaterial.uniforms.uHover.value = lit >= 0 ? lit + 1 : -1;
    document.body.style.cursor = hovered >= 0 ? "pointer" : "";
  }, [hovered, selected, buildingMaterial]);

  const place = places.find((f) => f.index === selected) ?? null;
  // Wait for the building before moving, so a shared link does not start at the overview.
  const waiting = selected >= 0 && !place;
  const bbox = manifest?.bbox ?? null;

  return (
    <>
      <color attach="background" args={[BACKDROP]} />
      {/* Light for the few shaded objects: trees, cars, tram, bridge towers. */}
      <ambientLight intensity={2.1} />
      <directionalLight position={[-0.55, 0.62, 0.56]} intensity={1.6} />

      {/* Tejo: the modelled rectangle; land is drawn on top of it. */}
      {bbox && (
        <mesh
          rotation-x={-Math.PI / 2}
          position={[(bbox[0] + bbox[2]) / 2, -2, -(bbox[1] + bbox[3]) / 2]}
          material={riverMaterial}
          renderOrder={-3}
          raycast={noRaycast}
        >
          <planeGeometry args={[bbox[2] - bbox[0], bbox[3] - bbox[1]]} />
        </mesh>
      )}

      {land && (
        <mesh geometry={land} renderOrder={-2} raycast={noRaycast}>
          <meshBasicMaterial color="#e6dfd2" />
        </mesh>
      )}

      {plan && <Parks plan={plan} />}
      {/* Streets do not write depth, so they are drawn after everything solid (see createStreetMaterial). */}
      {roads && (
        <mesh geometry={roads.geometry} material={streetMaterial} renderOrder={1} raycast={noRaycast} frustumCulled={false} />
      )}
      {roads && <Cars roads={roads.lines} />}
      {plan && <PlanLayer plan={plan} visible={planOn} />}
      {plan && <Tram route={plan.tramRoute} />}
      {manifest && <Bridge manifest={manifest} />}

      {chunks.map((c) => (
        <mesh key={c.id} geometry={c.geometry} material={buildingMaterial} position={c.position} raycast={noRaycast} />
      ))}

      {/* The merged city is not raycast (a million triangles); each featured
          building gets an invisible box to click and a label that is a real button. */}
      {places
        .filter((f) => planOn || projects[f.index].layer === "city" || f.index === selected)
        .map((f) => {
          const p = projects[f.index];
          return (
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
                <Html position={[0, f.labelY, 0]} zIndexRange={[5, 0]}>
                  <button
                    type="button"
                    className={`place-label${p.lights === "off" ? " is-off" : ""}${p.layer === "plan" ? " is-plan" : ""}`}
                    onClick={() => onSelect(f.index)}
                    onPointerOver={() => setHovered(f.index)}
                    onPointerOut={() => setHovered(-1)}
                    onFocus={() => setHovered(f.index)}
                    onBlur={() => setHovered(-1)}
                  >
                    <span className="place-dot" aria-hidden="true" />
                    <span className="place-text">
                      <span className="place-title">{p.title}</span>
                      <span className="place-where">{p.place}</span>
                    </span>
                  </button>
                </Html>
              )}
            </group>
          );
        })}

      {/* Slide and zoom only: the viewing angle is fixed. */}
      <OrbitControls
        makeDefault
        enableRotate={false}
        enableDamping={!reducedMotion}
        dampingFactor={0.12}
        screenSpacePanning={false}
        zoomToCursor
        zoomSpeed={2.2}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
        touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN }}
      />
      {!waiting && <CameraRig place={place} reducedMotion={reducedMotion} bounds={bbox} />}

      <Clock reducedMotion={reducedMotion} onStats={onStats} />
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
  const [planOn, setPlanOn] = useState(false);
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
    // A place that belongs to the Plan layer brings the layer with it.
    if (current?.layer === "plan") setPlanOn(true);
  }, [current]);

  // The Plan button is in the page's own HTML; it only works once the city is running.
  useEffect(() => {
    const button = document.getElementById("plan-toggle");
    if (!button || !live) return;
    button.hidden = false;
    const toggle = () => setPlanOn((on) => !on);
    button.addEventListener("click", toggle);
    return () => button.removeEventListener("click", toggle);
  }, [live]);

  useEffect(() => {
    document.getElementById("plan-toggle")?.setAttribute("aria-pressed", String(planOn));
    document.documentElement.classList.toggle("plan-on", planOn);
  }, [planOn]);

  return (
    <div className="city">
      {live ? (
        <Canvas
          orthographic
          flat
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          camera={{ position: VIEW_FROM.clone().multiplyScalar(CAMERA_DISTANCE).add(BAIXA), zoom: START_ZOOM, near: 100, far: 30000 }}
        >
          <Scene
            projects={projects}
            selected={selected}
            onSelect={select}
            reducedMotion={reducedMotion}
            onStats={onStats}
            planOn={planOn}
          />
        </Canvas>
      ) : (
        // No 3D: a still of the city. Everything stays reachable through the List.
        <div className="fallback">
          <img src="/city.jpg" alt="Lisbon seen from above" />
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
