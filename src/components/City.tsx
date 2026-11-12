import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Color, MOUSE, TOUCH, Vector3, type BufferGeometry, type OrthographicCamera } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { ACCENT_SLOTS, createBuildingMaterial } from "../city/buildingMaterial";
import { BACKDROP, shared } from "../city/environment";
import { createRiverMaterial, createStreetMaterial, STREET_HALF_WIDTH } from "../city/groundMaterials";
import { buildRibbons, loadLines, type Polyline } from "../city/lines";
import { loadChunk, loadManifest, loadShapes, project, type Featured, type Manifest } from "../city/loadCity";
import { Bridge, BRIDGE_DECK_M, Cars, loadPlan, Parks, PlanLayer, Tram, type PlanData } from "./Extras";
import Panel from "./Panel";

export type Category = "job" | "education" | "personal";

export interface Project {
  slug: string;
  /** Address of this place on the site, e.g. /work/<slug> or /now. */
  path: string;
  kind: "work" | "now" | "contact";
  lights: "on" | "off";
  title: string;
  /** Short name for the map label. */
  label: string;
  /** Places with the same group share one label and one panel. */
  group?: string;
  category?: Category;
  place: string;
  role?: string;
  period?: string;
  coordinates: [number, number];
  stack: string[];
  links: { label: string; url: string }[];
  html: string;
}

/** One label on the map and one panel: a place, or several that share a group. */
export interface Stop {
  key: string;
  label: string;
  category?: Category;
  off: boolean;
  /** Indices into the projects list, in reading order. */
  members: number[];
  /** False for the contact panel, which has no spot on the map. */
  onMap: boolean;
}

/** Colour code, also used by the label dots (see global.css). */
export const CATEGORY_COLOR: Record<Category | "none", string> = {
  job: "#f2b632",
  education: "#4f86d9",
  personal: "#55a868",
  none: "#e9e4da",
};

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

/** Where a stop is in the scene: a featured building, or a bare spot (the bridge). */
interface Place {
  /** Index of the stop's first project. */
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

/** What the buttons and keys outside the canvas can ask of the camera. */
interface CameraApi {
  zoomBy: (factor: number) => void;
  panBy: (rightPx: number, downPx: number) => void;
  home: () => void;
}

declare global {
  interface Window {
    __city?: Stats;
  }
}

// The camera always looks at the city from the same side and the same height,
// like a model on a table: it can slide and zoom, never tilt up to the sky.
const VIEW_FROM = new Vector3(1, 1.05, 1).normalize(); // from the south-east, looking north-west
const SIN_ELEVATION = VIEW_FROM.y;
const SCREEN_RIGHT = new Vector3(VIEW_FROM.z, 0, -VIEW_FROM.x).normalize();
const SCREEN_UP = new Vector3(-VIEW_FROM.x, 0, -VIEW_FROM.z).normalize();
const CAMERA_DISTANCE = 9000;
// Scene origin is Praça do Comércio; the Baixa grid starts just north of it.
const BAIXA = new Vector3(0, 0, -350);
/** The opening view shows about this many metres of city across the screen. */
const START_WIDTH_M = 1200;
const MAX_ZOOM = 5;
const FLIGHT_SECONDS = 2.4;
const PANEL_WIDTH_PX = 620;

const noRaycast = () => null;
/** ?shot: no interface, for taking the preview images. */
const SHOT = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

function startZoom(): number {
  return Math.min(1.6, Math.max(0.75, window.innerWidth / START_WIDTH_M));
}

/**
 * How far the ground seen on screen reaches from its centre, east-west and
 * north-south alike (the view is turned 45 degrees to both).
 */
function reach(width: number, height: number, zoom: number): number {
  return ((width / 2 + height / (2 * SIN_ELEVATION)) * Math.SQRT1_2) / zoom;
}

function useCity(stops: Stop[], projects: Project[], onStats: OnStats) {
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

      // One spot per stop, at the address of its first project.
      const located = stops
        .filter((s) => s.onMap)
        .map((s) => {
          const index = s.members[0];
          const p = projects[index];
          const [x, y] = project(m, p.coordinates[0], p.coordinates[1]);
          return { index, x, y, dark: s.off, kind: p.kind };
        });
      const targets = located.filter((t) => t.kind === "work");
      // The bridge is a spot, not a building.
      setPlaces(
        located
          .filter((t) => t.kind !== "work")
          .map((t) => ({ index: t.index, x: t.x, z: -t.y, height: 0, radius: 0, labelY: BRIDGE_DECK_M + 6, zoom: 0.9 })),
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
          const place: Place = { index: f.index, x: f.x, z: f.z, height: f.height, radius: f.radius, labelY: f.height + 4, zoom: 2 };
          setPlaces((prev) => [...prev.filter((q) => q.index !== f.index), place]);
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
  }, [stops, projects, onStats]);

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

interface RigProps {
  place: Place | null;
  reducedMotion: boolean;
  /** The part of the map the camera may show: [minX, minY, maxX, maxY] in map metres. */
  view: [number, number, number, number];
  panelOpen: boolean;
  api: RefObject<CameraApi | null>;
}

/**
 * Keeps the fixed viewing angle and the edges of the map out of sight, flies
 * to the selected place, and answers the zoom and home buttons.
 */
function CameraRig({ place, reducedMotion, view, panelOpen, api }: RigProps) {
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const size = useThree((s) => s.size);
  const flight = useRef<{ t: number; seconds: number; fromTarget: Vector3; toTarget: Vector3; fromZoom: number; toZoom: number } | null>(null);
  const first = useRef(true);

  // Zooming out stops when the screen would reach past the map on its short side.
  const minZoom = useMemo(() => {
    const [minX, minY, maxX, maxY] = view;
    return (reach(size.width, size.height, 1) / (Math.min(maxX - minX, maxY - minY) / 2)) * 1.01;
  }, [view, size]);

  /** Moves a look-at point so that nothing outside the map is on screen at this zoom. */
  const confine = useCallback(
    (target: Vector3, zoom: number) => {
      const [minX, minY, maxX, maxY] = view;
      const r = reach(size.width, size.height, zoom);
      target.x = minX + r > maxX - r ? (minX + maxX) / 2 : Math.min(maxX - r, Math.max(minX + r, target.x));
      // Map north is -z in the scene.
      target.z = -maxY + r > -minY - r ? -(minY + maxY) / 2 : Math.min(-minY - r, Math.max(-maxY + r, target.z));
      target.y = 0;
      return target;
    },
    [view, size],
  );

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

  const flyTo = useCallback(
    (target: Vector3, zoom: number, seconds = FLIGHT_SECONDS) => {
      if (!controls) return;
      const z = Math.min(MAX_ZOOM, Math.max(minZoom, zoom));
      const to = confine(target.clone(), z);
      // prefers-reduced-motion: cut straight to the new view.
      if (reducedMotion) {
        apply(to, z);
        controls.update();
        return;
      }
      flight.current = { t: 0, seconds, fromTarget: controls.target.clone(), toTarget: to, fromZoom: camera.zoom, toZoom: z };
      controls.enabled = false;
    },
    [controls, camera, minZoom, confine, apply, reducedMotion],
  );

  useEffect(() => {
    if (!controls) return;
    if (place) {
      const target = new Vector3(place.x, 0, place.z);
      if (panelOpen && size.width > 800 && !SHOT) {
        // Look to the right of the place so it sits in the part of the screen the panel leaves free.
        target.addScaledVector(SCREEN_RIGHT, Math.min(PANEL_WIDTH_PX, size.width / 2) / 2 / place.zoom);
      }
      if (first.current) {
        // A shared link opens already at its place: no flight on first paint.
        const z = Math.max(minZoom, place.zoom);
        apply(confine(target, z), z);
        controls.update();
      } else {
        flyTo(target, place.zoom);
      }
    } else if (first.current) {
      const z = Math.max(minZoom, startZoom());
      apply(confine(BAIXA.clone(), z), z);
      controls.update();
    }
    first.current = false;
    // Only a change of place moves the camera; resizing the window does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, controls]);

  useEffect(() => {
    api.current = {
      zoomBy: (factor) => controls && flyTo(controls.target, camera.zoom * factor, 0.35),
      panBy: (rightPx, downPx) => {
        if (!controls) return;
        const target = controls.target
          .clone()
          .addScaledVector(SCREEN_RIGHT, rightPx / camera.zoom)
          .addScaledVector(SCREEN_UP, -downPx / (camera.zoom * SIN_ELEVATION));
        flyTo(target, camera.zoom, 0.3);
      },
      home: () => flyTo(BAIXA, startZoom(), 1.6),
    };
    return () => {
      api.current = null;
    };
  }, [api, controls, camera, flyTo]);

  // Dragging and wheel zoom stop at the edge of the map.
  useEffect(() => {
    if (!controls) return;
    controls.minZoom = minZoom;
    const before = new Vector3();
    const keepInside = () => {
      if (camera.zoom < minZoom) {
        camera.zoom = minZoom;
        camera.updateProjectionMatrix();
      }
      before.copy(controls.target);
      confine(controls.target, camera.zoom);
      if (!before.equals(controls.target)) camera.position.copy(controls.target).addScaledVector(VIEW_FROM, CAMERA_DISTANCE);
    };
    keepInside();
    controls.addEventListener("change", keepInside);
    return () => controls.removeEventListener("change", keepInside);
  }, [controls, camera, minZoom, confine]);

  const target = useMemo(() => new Vector3(), []);
  useFrame((_, delta) => {
    const f = flight.current;
    if (!f || !controls) return;
    f.t = Math.min(1, f.t + delta / f.seconds);
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

interface LabelSpot {
  /** Project index of the stop's first member, to find its place. */
  index: number;
  element: HTMLButtonElement | null;
}

/**
 * Puts each label above its place. A place that is off screen keeps its label
 * at the nearest edge with an arrow, so every stop can always be seen and clicked.
 */
function LabelPositioner({ spots, places, panelOpen }: { spots: RefObject<LabelSpot[]>; places: Place[]; panelOpen: boolean }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const v = useMemo(() => new Vector3(), []);
  // Measuring an element forces the browser to lay the page out, so sizes are
  // measured now and then instead of on every frame.
  const sizes = useMemo(() => new WeakMap<HTMLElement, { w: number; h: number }>(), []);
  const frame = useRef(0);

  useFrame(() => {
    const remeasure = frame.current++ % 90 === 0;
    const left = 12;
    const right = size.width - 12 - (panelOpen && size.width > 800 ? Math.min(PANEL_WIDTH_PX, size.width) : 0);
    const top = 66;
    const bottom = size.height - 104; // clear of the controls and the colour key
    const boxes: { x: number; y: number; w: number; h: number }[] = [];

    for (const spot of spots.current ?? []) {
      const el = spot.element;
      const place = places.find((p) => p.index === spot.index);
      if (!el || el.hidden) continue;
      if (!place) {
        if (el.dataset.at) {
          el.dataset.at = "";
          el.style.visibility = "hidden";
        }
        continue;
      }
      v.set(place.x, place.labelY, place.z).project(camera);
      const px = (v.x * 0.5 + 0.5) * size.width;
      const py = (-v.y * 0.5 + 0.5) * size.height - 10; // the pointer sits just above the spot
      let box = sizes.get(el);
      if (!box || remeasure || box.w === 0) {
        box = { w: el.offsetWidth, h: el.offsetHeight };
        sizes.set(el, box);
      }
      const { w, h } = box;

      // Top-left corner of the label, kept inside the free part of the screen.
      let x = Math.min(right - w, Math.max(left, px - w / 2));
      let y = Math.min(bottom - h, Math.max(top, py - h));
      const away = Math.abs(x - (px - w / 2)) > 1 || Math.abs(y - (py - h)) > 1;

      // Labels waiting at an edge must not pile up on each other.
      for (const b of boxes) {
        if (x < b.x + b.w + 6 && x + w + 6 > b.x && y < b.y + b.h + 4 && y + h + 4 > b.y) {
          y = b.y + b.h + 4 <= bottom - h ? b.y + b.h + 4 : b.y - h - 4;
        }
      }
      boxes.push({ x, y, w, h });

      // Touch the page only when something actually changed.
      const angle = away ? Math.round(Math.atan2(py - (y + h / 2), px - (x + w / 2)) * 20) / 20 : 0;
      const state = `${Math.round(x)},${Math.round(y)},${away ? angle : "here"}`;
      if (el.dataset.at === state) continue;
      el.dataset.at = state;
      el.style.visibility = "visible";
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.classList.toggle("is-away", away);
      if (away) el.style.setProperty("--toward", `${angle}rad`);
    }
  });
  return null;
}

interface SceneProps {
  projects: Project[];
  stops: Stop[];
  selected: number;
  onSelect: (index: number) => void;
  hovered: number;
  onHover: (index: number) => void;
  reducedMotion: boolean;
  onStats: OnStats;
  planOn: boolean;
  panelOpen: boolean;
  api: RefObject<CameraApi | null>;
  spots: RefObject<LabelSpot[]>;
}

function Scene({ projects, stops, selected, onSelect, hovered, onHover, reducedMotion, onStats, planOn, panelOpen, api, spots }: SceneProps) {
  const { manifest, land, roads, chunks, places, plan } = useCity(stops, projects, onStats);
  const buildingMaterial = useMemo(() => {
    const material = createBuildingMaterial();
    // Each featured building takes the colour of its category.
    stops.forEach((s) => {
      const slot = s.members[0];
      if (slot < ACCENT_SLOTS) (material.uniforms.uAccents.value as Color[])[slot].set(CATEGORY_COLOR[s.category ?? "none"]);
    });
    return material;
  }, [stops]);
  const streetMaterial = useMemo(createStreetMaterial, []);
  const riverMaterial = useMemo(createRiverMaterial, []);

  useEffect(() => {
    shared.uPlan.value = planOn ? 1 : 0;
  }, [planOn]);

  // The stop the selected project belongs to, by the index of its first member.
  const stopIndex = (index: number) => stops.find((s) => s.members.includes(index))?.members[0] ?? -1;
  const selectedSpot = stopIndex(selected);

  useEffect(() => {
    // The shader tags featured buildings with 1 + their index.
    const lit = hovered >= 0 ? hovered : selectedSpot;
    buildingMaterial.uniforms.uHover.value = lit >= 0 ? lit + 1 : -1;
    document.body.style.cursor = hovered >= 0 ? "pointer" : "";
  }, [hovered, selectedSpot, buildingMaterial]);

  const place = places.find((f) => f.index === selectedSpot) ?? null;
  const onMap = stops.some((s) => s.onMap && s.members[0] === selectedSpot);
  // Wait for the building before moving, so a shared link does not start at the overview.
  const waiting = onMap && !place;
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
          building gets an invisible box to click. Its label is a real button, outside the canvas. */}
      {places
        .filter((f) => f.radius > 0)
        .map((f) => (
          <mesh
            key={f.index}
            position={[f.x, f.height / 2, f.z]}
            onPointerOver={() => onHover(f.index)}
            onPointerOut={() => onHover(-1)}
            onClick={() => onSelect(f.index)}
          >
            <boxGeometry args={[f.radius * 1.6, f.height, f.radius * 1.6]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        ))}

      {/* Slide and zoom only: the viewing angle is fixed. */}
      <OrbitControls
        makeDefault
        enableRotate={false}
        enableDamping={!reducedMotion}
        dampingFactor={0.12}
        screenSpacePanning={false}
        zoomToCursor
        zoomSpeed={2.2}
        maxZoom={MAX_ZOOM}
        mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
        touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN }}
      />
      {manifest && !waiting && (
        <CameraRig place={place} reducedMotion={reducedMotion} view={manifest.view} panelOpen={panelOpen} api={api} />
      )}
      <LabelPositioner spots={spots} places={places} panelOpen={panelOpen} />

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

/** Groups the projects into stops, in reading order. */
function toStops(projects: Project[]): Stop[] {
  const stops: Stop[] = [];
  projects.forEach((p, index) => {
    const key = p.group ?? p.slug;
    const existing = stops.find((s) => s.key === key);
    if (existing) existing.members.push(index);
    else {
      stops.push({
        key,
        label: p.group ?? p.label,
        category: p.category,
        off: p.lights === "off",
        members: [index],
        onMap: p.kind !== "contact",
      });
    }
  });
  return stops;
}

/** Wires a button that lives in the page's own HTML (it only works once the city is running). */
function usePageButton(id: string, enabled: boolean, onPress: (event: Event) => void) {
  const handler = useRef(onPress);
  handler.current = onPress;
  useEffect(() => {
    const element = document.getElementById(id);
    if (!element || !enabled) return;
    element.hidden = false;
    const listener = (event: Event) => handler.current(event);
    element.addEventListener("click", listener);
    return () => element.removeEventListener("click", listener);
  }, [id, enabled]);
}

export default function City({ projects, initialPath }: { projects: Project[]; initialPath?: string }) {
  const live = useMemo(canRunCity, []);
  const stops = useMemo(() => toStops(projects), [projects]);
  const [planOn, setPlanOn] = useState(false);
  const [touring, setTouring] = useState(false);
  const [hovered, setHovered] = useState(-1);
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
  const api = useRef<CameraApi | null>(null);
  const spots = useRef<LabelSpot[]>([]);

  const [selected, setSelected] = useState(() => projects.findIndex((p) => p.path === initialPath));
  const current = selected >= 0 ? projects[selected] : null;
  const stopAt = stops.findIndex((s) => s.members.includes(selected));
  const stop = stopAt >= 0 ? stops[stopAt] : null;

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
  const close = useCallback(() => {
    setTouring(false);
    select(-1);
  }, [select]);

  // Tour: the stops one after the other, in the order given by the content files.
  const goToStop = useCallback(
    (at: number) => {
      if (at >= 0 && at < stops.length) select(stops[at].members[0]);
    },
    [stops, select],
  );
  const startTour = useCallback(() => {
    setTouring(true);
    goToStop(0);
  }, [goToStop]);

  useEffect(() => {
    const onPop = () => setSelected(projects.findIndex((p) => p.path === trim(window.location.pathname)));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [projects]);

  useEffect(() => {
    document.title = current ? `${current.title} — Salvador Ferreira` : "Salvador Ferreira";
  }, [current]);

  usePageButton("plan-toggle", live, () => setPlanOn((on) => !on));
  usePageButton("zoom-in", live, () => api.current?.zoomBy(1.6));
  usePageButton("zoom-out", live, () => api.current?.zoomBy(1 / 1.6));
  usePageButton("go-home", live, () => api.current?.home());
  usePageButton("tour-start", true, startTour);
  // Contact has its own page; inside the city it opens as a panel instead.
  usePageButton("contact-link", true, (event) => {
    const index = projects.findIndex((p) => p.kind === "contact");
    if (index < 0) return;
    event.preventDefault();
    select(index);
  });

  useEffect(() => {
    document.getElementById("plan-toggle")?.setAttribute("aria-pressed", String(planOn));
    document.documentElement.classList.toggle("plan-on", planOn);
  }, [planOn]);

  // Keyboard: + and - zoom, Home returns to the Baixa, arrows slide the map
  // (or step through the tour while it is running).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
      const step = 160;
      switch (event.key) {
        case "+":
        case "=":
          api.current?.zoomBy(1.6);
          break;
        case "-":
          api.current?.zoomBy(1 / 1.6);
          break;
        case "Home":
          api.current?.home();
          break;
        case "ArrowLeft":
          if (touring) goToStop(stopAt - 1);
          else api.current?.panBy(-step, 0);
          break;
        case "ArrowRight":
          if (touring) goToStop(stopAt + 1);
          else api.current?.panBy(step, 0);
          break;
        case "ArrowUp":
          if (stop) return; // leave the arrows to the panel's own scrolling
          api.current?.panBy(0, -step);
          break;
        case "ArrowDown":
          if (stop) return;
          api.current?.panBy(0, step);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [touring, stopAt, stop, goToStop]);

  const labelled = stops.filter((s) => s.onMap);
  spots.current.length = labelled.length;

  return (
    <div className="city">
      {live ? (
        <Canvas
          orthographic
          flat
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          camera={{ position: VIEW_FROM.clone().multiplyScalar(CAMERA_DISTANCE).add(BAIXA), zoom: startZoom(), near: 100, far: 30000 }}
        >
          <Scene
            projects={projects}
            stops={stops}
            selected={selected}
            onSelect={select}
            hovered={hovered}
            onHover={setHovered}
            reducedMotion={reducedMotion}
            onStats={onStats}
            planOn={planOn}
            panelOpen={stop !== null}
            api={api}
            spots={spots}
          />
        </Canvas>
      ) : (
        // No 3D: a still of the city. Everything stays reachable through the List.
        <div className="fallback">
          <img src="/city.jpg" alt="Lisbon seen from above" />
        </div>
      )}

      {live && (
        <div className="labels">
          {labelled.map((s, i) => (
            <button
              key={s.key}
              type="button"
              ref={(element) => {
                spots.current[i] = { index: s.members[0], element };
              }}
              className={`place-label${s.off ? " is-off" : ""}`}
              style={{ "--dot": CATEGORY_COLOR[s.category ?? "none"] } as React.CSSProperties}
              hidden={stop === s}
              onClick={() => select(s.members[0])}
              onPointerOver={() => setHovered(s.members[0])}
              onPointerOut={() => setHovered(-1)}
              onFocus={() => setHovered(s.members[0])}
              onBlur={() => setHovered(-1)}
            >
              <span className="place-dot" aria-hidden="true" />
              {s.label}
              <span className="place-arrow" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      {stop && current && !SHOT && (
        <Panel
          stop={stop}
          projects={stop.members.map((m) => projects[m])}
          active={current.slug}
          onClose={close}
          tour={
            touring
              ? {
                  position: stopAt + 1,
                  total: stops.length,
                  onPrevious: stopAt > 0 ? () => goToStop(stopAt - 1) : undefined,
                  onNext: stopAt < stops.length - 1 ? () => goToStop(stopAt + 1) : undefined,
                }
              : undefined
          }
        />
      )}
      {showStats && live && (
        <p className="stats">
          {`${stats.fps} fps\n${stats.buildings} buildings, ${stats.triangles} triangles\nfirst neighbourhood ${stats.firstChunkMs} ms, all ${stats.loadMs} ms`}
        </p>
      )}
    </div>
  );
}
