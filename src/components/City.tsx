import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BufferGeometry } from "three";
import { createBuildingMaterial, FOG_COLOR, FOG_DENSITY } from "../city/buildingMaterial";
import { loadChunk, loadLand, loadManifest, type Manifest } from "../city/loadCity";

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

declare global {
  interface Window {
    __city?: Stats;
  }
}

// Scene origin is Praça do Comércio; the Baixa grid starts just north of it.
const BAIXA: [number, number, number] = [0, 0, -350];
const START_CAMERA: [number, number, number] = [500, 1150, 1150];
const BRIDGE_DECK_M = 70;

function useCity(onStats: (patch: Partial<Stats>) => void) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [land, setLand] = useState<BufferGeometry | null>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);

  useEffect(() => {
    let cancelled = false;
    const start = performance.now();

    (async () => {
      const m = await loadManifest();
      if (cancelled) return;
      setManifest(m);
      loadLand(m).then((g) => !cancelled && setLand(g));

      // Nearest neighbourhoods first, so the Baixa appears before the suburbs.
      const order = [...m.chunks].sort(
        (a, b) => Math.hypot(a.origin[0], a.origin[1] + BAIXA[2]) - Math.hypot(b.origin[0], b.origin[1] + BAIXA[2]),
      );
      const pending = order.map((c, i) => loadChunk(c, m.unitsPerMetre, i * 7919));
      let triangles = 0;
      let buildings = 0;
      for (let i = 0; i < order.length; i++) {
        const built = await pending[i];
        if (cancelled) return;
        const c = order[i];
        triangles += built.triangles;
        buildings += c.buildings;
        setChunks((prev) => [...prev, { id: c.id, geometry: built.geometry, position: [c.origin[0], 0, -c.origin[1]] }]);
        if (i === 0) onStats({ firstChunkMs: Math.round(performance.now() - start) });
        // Let the browser draw a frame between neighbourhoods.
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      onStats({ buildings, triangles, loadMs: Math.round(performance.now() - start) });
    })().catch((error) => console.error("City failed to load", error));

    return () => {
      cancelled = true;
    };
  }, [onStats]);

  return { manifest, land, chunks };
}

function FrameRate({ onStats }: { onStats: (patch: Partial<Stats>) => void }) {
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

function Scene({ onStats }: { onStats: (patch: Partial<Stats>) => void }) {
  const { manifest, land, chunks } = useCity(onStats);
  const material = useMemo(createBuildingMaterial, []);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    scene.background = FOG_COLOR;
  }, [scene]);

  return (
    <>
      <fogExp2 attach="fog" args={[FOG_COLOR, FOG_DENSITY]} />

      {/* Tejo */}
      <mesh rotation-x={-Math.PI / 2} position-y={-2}>
        <planeGeometry args={[60000, 60000]} />
        <meshBasicMaterial color="#020304" />
      </mesh>

      {land && (
        <mesh geometry={land}>
          <meshBasicMaterial color="#21160c" />
        </mesh>
      )}

      {chunks.map((c) => (
        <mesh key={c.id} geometry={c.geometry} material={material} position={c.position} />
      ))}

      {manifest?.bridge.map((way, i) => (
        <Line
          key={i}
          points={way.points.map(([x, y]) => [x, BRIDGE_DECK_M, -y] as [number, number, number])}
          color="#ffb15c"
          lineWidth={1.5}
        />
      ))}

      <OrbitControls
        target={BAIXA}
        enableDamping
        dampingFactor={0.08}
        minDistance={250}
        maxDistance={9000}
        maxPolarAngle={Math.PI * 0.46}
      />

      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur luminanceThreshold={0.6} luminanceSmoothing={0.3} intensity={1.3} radius={0.7} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>

      <FrameRate onStats={onStats} />
    </>
  );
}

export default function City() {
  const showStats = useMemo(() => new URLSearchParams(window.location.search).has("stats"), []);
  const [stats, setStats] = useState<Stats>({ buildings: 0, triangles: 0, firstChunkMs: 0, loadMs: 0, fps: 0 });
  const onStats = useMemo(
    () => (patch: Partial<Stats>) =>
      setStats((prev) => {
        const next = { ...prev, ...patch };
        window.__city = next;
        return next;
      }),
    [],
  );

  return (
    <div className="city">
      <Canvas
        flat
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ position: START_CAMERA, fov: 40, near: 20, far: 40000 }}
      >
        <Scene onStats={onStats} />
      </Canvas>
      {showStats && (
        <p className="stats">
          {`${stats.fps} fps\n${stats.buildings} buildings, ${stats.triangles} triangles\nfirst neighbourhood ${stats.firstChunkMs} ms, all ${stats.loadMs} ms`}
        </p>
      )}
    </div>
  );
}
