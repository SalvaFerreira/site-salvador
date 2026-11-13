import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Color, MOUSE, TOUCH, Vector3, type BufferGeometry, type OrthographicCamera } from "three";
import type { Line2, OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { ACCENT_SLOTS, createBuildingMaterial } from "../city/buildingMaterial";
import { BACKDROP, shared } from "../city/environment";
import { createHaloMaterial, createRiverMaterial, createShadowMaterial, createStreetMaterial, STREET_HALF_WIDTH } from "../city/groundMaterials";
import { buildRibbons, loadLines, type Polyline } from "../city/lines";
import { loadChunk, loadManifest, loadShapes, loadShapesByClass, project, type Featured, type Manifest } from "../city/loadCity";
import { Bridge, loadCover, loadPlan, Parks, type CoverData, type PlanData } from "./Extras";
import { Airport, Boats, Cars, Plane, Tracks, Trains, Trams } from "./Life";
import Panel from "./Panel";
import { Buses, Calcada, Crossings, loadStreet, People, TrafficLights, VascoDaGama, type StreetData } from "./Street";

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
  /** Short role for the map label. */
  tagline?: string;
  period?: string;
  coordinates: [number, number];
  /** When it started (ISO), if known. */
  date?: string;
  order: number;
  images: { src: string; alt: string }[];
  stack: string[];
  links: { label: string; url: string }[];
  html: string;
}

/** One label on the map and one panel: a place, or several that share a group. */
export interface Stop {
  key: string;
  /** Name on the map label: the company, school or project. */
  label: string;
  /** What it is for Salvador, after the name on the label: role and year. */
  line: string;
  /** Start of the earliest member, if known: orders the journey and the Tour. */
  date?: string;
  category?: Category;
  off: boolean;
  /** Indices into the projects list, in reading order. */
  members: number[];
  /** False for the contact panel, which has no spot on the map. */
  onMap: boolean;
}

/**
 * Colour code of Salvador's places: their buildings, the glow around them and
 * the label dots (the key is in CityPage.astro). Work is also the colour of the
 * journey line and of the interface (--accent in global.css).
 */
export const CATEGORY_COLOR: Record<Category | "none", string> = {
  job: "#e8833a",
  education: "#4f86d9",
  personal: "#4fa86a",
  none: "#d9d2c5",
};
export const ACCENT = CATEGORY_COLOR.job;

const colourOf = (stop: Stop) => CATEGORY_COLOR[stop.category ?? "none"];

interface Chunk {
  id: string;
  geometry: BufferGeometry;
  shadow: BufferGeometry;
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
// Only used before the places are known.
const BAIXA = new Vector3(0, 0, -350);
/** The opening view shows about this many metres of city across the screen. */
const START_WIDTH_M = 1200;
const MAX_ZOOM = 5;
/** Height of the label of the spot on the Vasco da Gama bridge (its deck is about 14 m up). */
const NOW_LABEL_Y = 26;
const FLIGHT_SECONDS = 2.4;
const PANEL_WIDTH_PX = 620;
/** Screens this wide or narrower get the phone layout (see global.css). */
const NARROW_PX = 700;
/** On a phone the panel starts this far down the screen (top: 45% in global.css). */
const PHONE_PANEL_TOP = 0.45;
/** Phones: fewer pixels to fill, so the city stays smooth. */
const PHONE = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

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
  const [cover, setCover] = useState<{ data: CoverData; shapes: Map<number, BufferGeometry> } | null>(null);
  const [street, setStreet] = useState<StreetData | null>(null);

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
      loadStreet()
        .then((d) => !cancelled && setStreet(d))
        .catch((error) => console.error("Street detail failed to load", error));
      loadCover()
        .then(async (data) => ({ data, shapes: await loadShapesByClass(data.file, data.unitsPerMetre) }))
        .then((c) => !cancelled && setCover(c));

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
          .map((t) => ({ index: t.index, x: t.x, z: -t.y, height: 0, radius: 0, labelY: NOW_LABEL_Y, zoom: 1.4 })),
      );
      const best = new Map<number, number>();

      // Neighbourhoods nearest the middle of Salvador's places first, so the opening view fills in first.
      const cx = located.reduce((sum, t) => sum + t.x, 0) / Math.max(1, located.length);
      const cy = located.reduce((sum, t) => sum + t.y, 0) / Math.max(1, located.length);
      const order = [...m.chunks].sort(
        (a, b) => Math.hypot(a.origin[0] - cx, a.origin[1] - cy) - Math.hypot(b.origin[0] - cx, b.origin[1] - cy),
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
        setChunks((prev) => [...prev, { id: c.id, geometry: built.geometry, shadow: built.shadow, position: [c.origin[0], 0, -c.origin[1]] }]);
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

  return { manifest, land, roads, chunks, places, plan, cover, street };
}

/** Runs the clock that moves everything in the city, and measures the frame rate. */
function Clock({ onStats }: { onStats: OnStats }) {
  const frames = useRef(0);
  const elapsed = useRef(0);
  useFrame((state, delta) => {
    shared.uTime.value = state.clock.elapsedTime;
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
  /** Every place on the map, in scene coordinates: the opening view shows them all. */
  overview: Vector3[];
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
function CameraRig({ place, overview, reducedMotion, view, panelOpen, api }: RigProps) {
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

  // The opening view (and the home button): all of Salvador's places on screen
  // at once, clear of the top bar and the controls, so nobody has to move the map.
  const home = useMemo(() => {
    if (overview.length < 2) return { target: BAIXA.clone(), zoom: Math.max(minZoom, startZoom()) };
    let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
    for (const p of overview) {
      const r = p.dot(SCREEN_RIGHT);
      const u = p.dot(SCREEN_UP);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    }
    const sides = Math.min(170, size.width * 0.12); // labels are centred on their place
    const top = (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 100) + 56;
    const bottom = 70;
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(
        minZoom,
        Math.min((size.width - 2 * sides) / Math.max(1, maxR - minR), (size.height - top - bottom) / Math.max(1, (maxU - minU) * SIN_ELEVATION)),
      ),
    );
    // Centre of the places, then moved so they sit in the middle of the free part of the screen.
    const target = new Vector3()
      .addScaledVector(SCREEN_RIGHT, (minR + maxR) / 2)
      .addScaledVector(SCREEN_UP, (minU + maxU) / 2 + (top - bottom) / 2 / (zoom * SIN_ELEVATION));
    return { target, zoom };
  }, [overview, size, minZoom]);

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
      } else if (panelOpen && !SHOT) {
        // Narrow screens: the panel takes the bottom 55%; put the place in the middle of the top part.
        target.addScaledVector(SCREEN_UP, -(size.height * (0.5 - PHONE_PANEL_TOP / 2)) / (place.zoom * SIN_ELEVATION));
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
      // ?at=x,y,zoom opens somewhere else (map metres east and north of Praça do Comércio), for checking things.
      const at = new URLSearchParams(window.location.search).get("at")?.split(",").map(Number) ?? [];
      const custom = at.length === 3 && at.every(Number.isFinite);
      const z = Math.max(minZoom, custom ? at[2] : home.zoom);
      apply(confine(custom ? new Vector3(at[0], 0, -at[1]) : home.target.clone(), z), z);
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
      home: () => flyTo(home.target, home.zoom, 1.6),
    };
    return () => {
      api.current = null;
    };
  }, [api, controls, camera, flyTo, home]);

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
  const topEdge = useRef(0);

  useFrame(() => {
    const remeasure = frame.current++ % 90 === 0;
    const left = 12;
    const right = size.width - 12 - (panelOpen && size.width > 800 ? Math.min(PANEL_WIDTH_PX, size.width) : 0);
    if (remeasure || topEdge.current === 0) {
      topEdge.current = (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 54) + 12;
    }
    const top = topEdge.current;
    const narrow = size.width <= NARROW_PX;
    const bottom = narrow
      ? (panelOpen ? size.height * PHONE_PANEL_TOP : size.height - 118) - 8 // clear of the panel, or of the strip of places
      : size.height - 104; // clear of the controls and the colour key
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
      // Step down past each label in the way (up, when there is no room below),
      // until the spot is free.
      let down = true;
      for (let tries = 0; tries < boxes.length * 2 + 2; tries++) {
        const hit = boxes.find((b) => x < b.x + b.w + 6 && x + w + 6 > b.x && y < b.y + b.h + 4 && y + h + 4 > b.y);
        if (!hit) break;
        if (down && hit.y + hit.h + 4 <= bottom - h) y = hit.y + hit.h + 4;
        else {
          down = false;
          y = hit.y - h - 4;
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
      // Near the top of the screen the details open downwards instead of up.
      el.classList.toggle("opens-down", y < size.height * 0.42);
      if (away) el.style.setProperty("--toward", `${angle}rad`);
    }
  });
  return null;
}

/**
 * A thin dashed line from place to place in the order they happened, arcing
 * over the roofs. Drawn over everything, so it can be followed across the city.
 */
function Journey({ stops, places }: { stops: Stop[]; places: Place[] }) {
  const points = useMemo(() => {
    const along = stops
      .filter((s) => s.date && s.onMap)
      .map((s) => places.find((p) => p.index === s.members[0]))
      .filter((p): p is Place => !!p);
    if (along.length < 2) return null;
    const out: Vector3[] = [];
    for (let i = 0; i < along.length - 1; i++) {
      const a = new Vector3(along[i].x, along[i].height, along[i].z);
      const b = new Vector3(along[i + 1].x, along[i + 1].height, along[i + 1].z);
      const lift = Math.min(260, a.distanceTo(b) * 0.18);
      const mid = a.clone().lerp(b, 0.5);
      mid.y = Math.max(a.y, b.y) + lift;
      for (let k = i === 0 ? 0 : 1; k <= 32; k++) {
        const t = k / 32;
        // Quadratic curve through the two places, highest halfway.
        out.push(
          new Vector3()
            .addScaledVector(a, (1 - t) ** 2)
            .addScaledVector(mid, 2 * (1 - t) * t)
            .addScaledVector(b, t * t),
        );
      }
    }
    return out;
  }, [stops, places]);

  // Dashes keep the same length on screen at every zoom (zoom is pixels per metre).
  const line = useRef<Line2 | null>(null);
  useFrame(({ camera }) => {
    if (line.current) line.current.material.dashScale = (camera as OrthographicCamera).zoom;
  });

  if (!points) return null;
  return (
    <Line
      ref={line}
      points={points}
      color={ACCENT}
      lineWidth={2.6}
      dashed
      dashSize={9}
      gapSize={6}
      transparent
      opacity={0.9}
      depthTest={false}
      depthWrite={false}
      renderOrder={10}
      raycast={noRaycast}
    />
  );
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
  panelOpen: boolean;
  api: RefObject<CameraApi | null>;
  spots: RefObject<LabelSpot[]>;
}

function Scene({ projects, stops, selected, onSelect, hovered, onHover, reducedMotion, onStats, panelOpen, api, spots }: SceneProps) {
  const { manifest, land, roads, chunks, places, plan, cover, street } = useCity(stops, projects, onStats);
  const buildingMaterial = useMemo(() => {
    const material = createBuildingMaterial();
    stops.forEach((s) => {
      const slot = s.members[0];
      if (slot < ACCENT_SLOTS) (material.uniforms.uAccents.value as Color[])[slot].set(colourOf(s));
    });
    return material;
  }, [stops]);
  // One glow per place, in its category's colour.
  const haloMaterials = useMemo(() => {
    const byColour = new Map<string, ReturnType<typeof createHaloMaterial>>();
    const out = new Map<number, ReturnType<typeof createHaloMaterial>>();
    for (const s of stops) {
      const colour = colourOf(s);
      if (!byColour.has(colour)) byColour.set(colour, createHaloMaterial(colour));
      out.set(s.members[0], byColour.get(colour)!);
    }
    return out;
  }, [stops]);
  // Buildings with the lights off get no glow.
  const dark = useMemo(() => new Set(stops.filter((s) => s.off).map((s) => s.members[0])), [stops]);
  const streetMaterial = useMemo(createStreetMaterial, []);
  const riverMaterial = useMemo(createRiverMaterial, []);
  const shadowMaterial = useMemo(createShadowMaterial, []);

  // The stop the selected project belongs to, by the index of its first member.
  const stopIndex = (index: number) => stops.find((s) => s.members.includes(index))?.members[0] ?? -1;
  const selectedSpot = stopIndex(selected);

  useEffect(() => {
    // The shader tags featured buildings with 1 + their index.
    const lit = hovered >= 0 ? hovered : selectedSpot;
    buildingMaterial.uniforms.uHover.value = lit >= 0 ? lit + 1 : -1;
    document.body.style.cursor = hovered >= 0 ? "pointer" : "";
  }, [hovered, selectedSpot, buildingMaterial]);

  const overview = useMemo(() => {
    if (!manifest) return [];
    return stops
      .filter((s) => s.onMap)
      .map((s) => {
        const p = projects[s.members[0]];
        const [x, y] = project(manifest, p.coordinates[0], p.coordinates[1]);
        return new Vector3(x, 0, -y);
      });
  }, [manifest, stops, projects]);

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
      <directionalLight position={[-0.72, 0.6, 0.34]} intensity={1.6} />

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
          <meshBasicMaterial color="#ece8e0" />
        </mesh>
      )}

      {plan && <Parks plan={plan} cover={cover?.shapes ?? null} />}
      {cover && <Airport cover={cover.data} shapes={cover.shapes} />}
      {/* Streets do not write depth, so they are drawn after everything solid (see createStreetMaterial). */}
      {roads && (
        <mesh geometry={roads.geometry} material={streetMaterial} renderOrder={1} raycast={noRaycast} frustumCulled={false} />
      )}
      {roads && <Cars roads={roads.lines} street={street} />}
      {street && <Calcada squares={street.squares} />}
      {street && <Crossings data={street.crossings} />}
      {street && <TrafficLights data={street.lights} />}
      {street && <Buses lines={street.bus} />}
      {street && roads && <People roads={roads.lines} crossings={street.crossings} />}
      {street && <VascoDaGama bridge={street.bridge} />}
      {plan && <Trams routes={plan.tramRoutes} />}
      {plan && <Tracks file={plan.tracks.file} unitsPerMetre={plan.tracks.unitsPerMetre} routes={plan.trainRoutes} />}
      {plan && <Trains routes={plan.trainRoutes} />}
      {plan && <Boats ferries={plan.ferryRoutes} sails={plan.sailingLanes} />}
      {manifest && <Bridge manifest={manifest} />}
      {cover && <Plane runways={cover.data.runways} />}

      {chunks.map((c) => (
        <mesh key={c.id} geometry={c.geometry} material={buildingMaterial} position={c.position} raycast={noRaycast} />
      ))}
      {/* Shadows lie just above streets and grass, and are drawn after them. */}
      {chunks.map((c) => (
        <mesh
          key={c.id}
          geometry={c.shadow}
          material={shadowMaterial}
          position={[c.position[0], 0.7, c.position[2]]}
          renderOrder={2}
          raycast={noRaycast}
        />
      ))}

      {/* A soft glow on the ground around each of Salvador's lit buildings. */}
      {places
        .filter((f) => f.radius > 0 && !dark.has(f.index))
        .map((f) => (
          <mesh key={f.index} position={[f.x, 0.9, f.z]} rotation-x={-Math.PI / 2} material={haloMaterials.get(f.index)} renderOrder={3} raycast={noRaycast}>
            <planeGeometry args={[f.radius * 3 + 50, f.radius * 3 + 50]} />
          </mesh>
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
        <CameraRig place={place} overview={overview} reducedMotion={reducedMotion} view={manifest.view} panelOpen={panelOpen} api={api} />
      )}
      <Journey stops={stops} places={places} />
      <LabelPositioner spots={spots} places={places} panelOpen={panelOpen} />

      <Clock onStats={onStats} />
    </>
  );
}

const trim = (path: string) => path.replace(/\/+$/, "");

/** Plain text of a project's Markdown body, without HTML comments or tags. */
function plainText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "\u2019")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What a label shows when the pointer rests on it (or it has keyboard focus):
 * where and when, the start of the text from the content file, the stack.
 * Nothing here is written for the label; it all comes from the frontmatter and body.
 */
function LabelMore({ stop, projects }: { stop: Stop; projects: Project[] }) {
  const members = stop.members.map((m) => projects[m]);
  const first = members[0];
  const when = [...new Set(members.map((p) => p.period).filter(Boolean))].join(" / ");
  const text = plainText(first.html);
  const stack = [...new Set(members.flatMap((p) => p.stack))];
  return (
    <span className="place-more">
      <span className="place-more-meta">{[first.place, when].filter(Boolean).join(" \u00b7 ")}</span>
      {members.length > 1 && <span className="place-more-list">{members.map((p) => p.title).join(" \u00b7 ")}</span>}
      {text && <span className="place-more-text">{text}</span>}
      {stack.length > 0 && <span className="place-more-meta">{stack.join(" \u00b7 ")}</span>}
      <span className="place-more-open">Click to open</span>
    </span>
  );
}

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

export const TODO = "TODO: texto do Salvador";

/** "AI & Data Analyst · 2026", from the role and the start date in the content files. */
function labelLine(p: Project): string {
  if (!p.role && !p.tagline) return TODO;
  const role = p.tagline ?? p.role!.split(" · ")[0];
  return p.date ? `${role} · ${new Date(p.date).getUTCFullYear()}` : role;
}

/**
 * Groups the projects into stops, in the order they happened: by start date,
 * then reading order. Places without a date come after the dated ones.
 */
function toStops(projects: Project[]): Stop[] {
  const stops: Stop[] = [];
  projects.forEach((p, index) => {
    const key = p.group ?? p.slug;
    const existing = stops.find((s) => s.key === key);
    if (existing) {
      existing.members.push(index);
      if (p.date && (!existing.date || p.date < existing.date)) existing.date = p.date;
    } else {
      stops.push({
        key,
        label: p.group ?? p.label,
        line: labelLine(p),
        date: p.date,
        category: p.category,
        off: p.lights === "off",
        members: [index],
        onMap: p.kind !== "contact",
      });
    }
  });
  const first = (s: Stop) => Math.min(...s.members.map((m) => projects[m].order));
  return stops.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (!!a.date !== !!b.date) return a.date ? -1 : 1;
    return first(a) - first(b);
  });
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

export default function City({
  projects,
  initialPath,
  email,
  linkedin,
}: {
  projects: Project[];
  initialPath?: string;
  email?: string;
  linkedin?: string;
}) {
  const live = useMemo(canRunCity, []);
  const stops = useMemo(() => toStops(projects), [projects]);
  const [touring, setTouring] = useState(false);
  const [hovered, setHovered] = useState(-1);
  const showStats = useMemo(() => new URLSearchParams(window.location.search).has("stats"), []);
  // For visitors whose system asks for reduced motion the camera cuts instead of
  // flying. The small things that move in the city (cars, boats, the plane) keep moving.
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

  // Tour: the stops one after the other, in the order they happened (see toStops).
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

  usePageButton("zoom-in", live, () => api.current?.zoomBy(1.6));
  usePageButton("zoom-out", live, () => api.current?.zoomBy(1 / 1.6));
  usePageButton("go-home", live, () => api.current?.home());
  usePageButton("tour-start", true, startTour);
  usePageButton("intro-tour", true, startTour);

  // On phones the map controls step aside while a panel is open (global.css).
  useEffect(() => {
    document.documentElement.classList.toggle("panel-open", stop !== null);
  }, [stop]);

  // The welcome card (CityPage.astro) gives way to any place that opens.
  useEffect(() => {
    if (selected >= 0) document.getElementById("intro")?.setAttribute("hidden", "");
  }, [selected]);
  // Contact has its own page; inside the city it opens as a panel instead.
  usePageButton("contact-link", true, (event) => {
    const index = projects.findIndex((p) => p.kind === "contact");
    if (index < 0) return;
    event.preventDefault();
    select(index);
  });

  // Keyboard: + and - zoom, Home shows all the places, arrows slide the map
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
          dpr={PHONE ? [1, 1.5] : [1, 2]}
          gl={{ antialias: true, stencil: true, powerPreference: "high-performance" }}
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
            panelOpen={stop !== null}
            api={api}
            spots={spots}
          />
        </Canvas>
      ) : (
        // No 3D: a still of the city. Everything stays reachable through the List.
        <div className="fallback">
          <img src="/city.jpg" alt="Lisbon seen from above" />
          <a className="fallback-text" href="/list">
            Everything on this site as text
          </a>
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
              style={{ "--dot": colourOf(s) } as React.CSSProperties}
              hidden={stop === s}
              onClick={() => select(s.members[0])}
              onPointerOver={() => setHovered(s.members[0])}
              onPointerOut={() => setHovered(-1)}
              onFocus={() => setHovered(s.members[0])}
              onBlur={() => setHovered(-1)}
            >
              <span className="place-dot" aria-hidden="true" />
              <span className="place-name">{s.label}</span>
              <span className="place-what">{s.line}</span>
              <span className="place-arrow" aria-hidden="true" />
              <LabelMore stop={s} projects={projects} />
            </button>
          ))}
        </div>
      )}

      {!stop && !SHOT && (
        <nav className="place-strip" aria-label="Places">
          {labelled.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`place-chip${s.off ? " is-off" : ""}`}
              style={{ "--dot": colourOf(s) } as React.CSSProperties}
              onClick={() => select(s.members[0])}
            >
              <span className="place-dot" aria-hidden="true" />
              {s.label}
            </button>
          ))}
        </nav>
      )}

      {stop && current && !SHOT && (
        <Panel
          stop={stop}
          projects={stop.members.map((m) => projects[m])}
          active={current.slug}
          onClose={close}
          email={email}
          linkedin={linkedin}
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
