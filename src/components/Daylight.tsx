// Light by the real hour in Lisbon: the sun's height sets day, dusk and night
// for the whole scene, and the clock shows the sun's path through today.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Color, type AmbientLight, type DirectionalLight } from "three";
import { atLisbonMinutes, formatMinutes, lightFor, lisbonMinutes, litShare, sunDay, sunElevation } from "../city/daylight";
import { shadowMaterials, shared } from "../city/environment";
import { HOLIDAYS, type Holiday } from "./Festivities";

/** The moment to light the city for: now, or a time of day chosen on the clock (Lisbon minutes). */
function momentFor(override: number | null): Date {
  return override === null ? new Date() : atLisbonMinutes(override);
}

const DAY_AMBIENT = new Color("#ffffff");
const NIGHT_AMBIENT = new Color("#8796c8");
const NOON_SUN = new Color("#ffffff");
const LOW_SUN = new Color("#ffc48a");

/**
 * The lights of the scene, following the sun. Changes are eased, so moving the
 * clock fades the city between day and night instead of jumping (unless the
 * visitor asks for reduced motion).
 */
export function Daylight({ override, reducedMotion }: { override: number | null; reducedMotion: boolean }) {
  const ambient = useRef<AmbientLight>(null);
  const sun = useRef<DirectionalLight>(null);
  const target = useRef({ night: 0, dusk: 0 });
  const since = useRef(Infinity);

  useFrame((_, delta) => {
    // The sun moves slowly: work out where it is twice a second, or at once when the clock is moved.
    since.current += delta;
    if (since.current > 0.5) {
      since.current = 0;
      const moment = momentFor(override);
      target.current = lightFor(sunElevation(moment));
      shared.uLit.value = litShare(override ?? lisbonMinutes(moment));
    }
    const k = reducedMotion ? 1 : Math.min(1, delta * 2.5);
    const night = (shared.uNight.value += (target.current.night - shared.uNight.value) * k);
    const dusk = (shared.uDusk.value += (target.current.dusk - shared.uDusk.value) * k);
    if (ambient.current) {
      ambient.current.intensity = 2.1 - 1.35 * night;
      ambient.current.color.copy(DAY_AMBIENT).lerp(NIGHT_AMBIENT, night);
    }
    const clouds = shared.uClouds.value;
    if (sun.current) {
      // Clouds take most of the sun away (the cloud shadows themselves are drawn in Weather.tsx).
      sun.current.intensity = 1.6 * (1 - night) * (1 - 0.5 * clouds);
      sun.current.color.copy(NOON_SUN).lerp(LOW_SUN, dusk);
    }
    for (const m of shadowMaterials) m.opacity = 0.42 * (1 - 0.85 * night) * (1 - 0.6 * clouds);
  });

  // A new value for the clock is seen at once.
  useEffect(() => {
    since.current = Infinity;
  }, [override]);

  return (
    <>
      {/* Light for the few shaded objects: trees, cars, trams, the bridge towers. */}
      <ambientLight ref={ambient} intensity={2.1} />
      <directionalLight ref={sun} position={[-0.72, 0.6, 0.34]} intensity={1.6} />
    </>
  );
}

const W = 132;
const H = 40;
const HORIZON = 24;
const toY = (elevation: number) => HORIZON - elevation * (18 / 75);

/**
 * The clock in the map controls: today's path of the sun over Lisbon, the
 * horizon, and where the sun is now (a moon while it is below the horizon).
 * Dragging along it, or the arrow keys, shows the city at another time of day.
 */
export function SunClock({
  override,
  onChange,
  weather,
  holiday,
  onHoliday,
}: {
  override: number | null;
  onChange: (minutes: number | null) => void;
  /** "17 °C · light rain" */
  weather: string;
  holiday: Holiday | null;
  /** Switch a holiday on (with the hour it is best seen at), or off (null, back to now). */
  onHoliday: (holiday: Holiday | null, time: number | null) => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [holidaysOpen, setHolidaysOpen] = useState(false);
  const holidaysRef = useRef<HTMLSpanElement>(null);

  // The holidays menu closes with Esc or a click elsewhere.
  useEffect(() => {
    if (!holidaysOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setHolidaysOpen(false);
    const onClick = (e: MouseEvent) => {
      if (!holidaysRef.current?.contains(e.target as Node)) setHolidaysOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [holidaysOpen]);

  useEffect(() => {
    const element = document.getElementById("clock");
    if (!element) return;
    // The page's own clock (for visitors without the 3D city) makes way for this one.
    element.textContent = "";
    element.classList.add("sun-clock-host");
    setHost(element);
    const timer = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const day = useMemo(() => sunDay(now), [now.toDateString()]); // eslint-disable-line react-hooks/exhaustive-deps
  const minutes = override ?? lisbonMinutes(now);
  const elevation = sunElevation(momentFor(override));

  const path = useMemo(
    () =>
      day.heights
        .map((h, i) => `${i ? "L" : "M"}${((i * day.stepMinutes) / 1440) * W},${toY(h).toFixed(2)}`)
        .join(" "),
    [day],
  );
  const x = (minutes / 1440) * W;
  const y = toY(elevation);
  const up = elevation > -0.833;

  if (!host) return null;
  return createPortal(
    <span className="sun-clock">
      <span
        className="sun-dial"
        title={
          day.sunrise !== null && day.sunset !== null
            ? `Drag to change the time of day · sunrise ${formatMinutes(day.sunrise)}, sunset ${formatMinutes(day.sunset)}`
            : "Drag to change the time of day"
        }
      >
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
          <defs>
            <clipPath id="sun-day">
              <rect x="0" y="0" width={W} height={HORIZON} />
            </clipPath>
            <clipPath id="sun-night">
              <rect x="0" y={HORIZON} width={W} height={H - HORIZON} />
            </clipPath>
          </defs>
          <line x1="0" x2={W} y1={HORIZON} y2={HORIZON} className="sun-horizon" />
          <path d={path} className="sun-path-day" clipPath="url(#sun-day)" />
          <path d={path} className="sun-path-night" clipPath="url(#sun-night)" />
          {up ? (
            <circle cx={x} cy={y} r="5.5" className="sun-now" />
          ) : (
            <g transform={`translate(${x} ${Math.min(H - 5, y)})`}>
              <circle r="5.5" className="moon-now" />
              <circle r="4.4" cx="2.4" cy="-1.4" className="moon-shade" />
            </g>
          )}
        </svg>
        <input
          type="range"
          min={0}
          max={1435}
          step={5}
          value={Math.round(minutes / 5) * 5}
          aria-label="Time of day in the city"
          aria-valuetext={formatMinutes(minutes)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </span>
      <span className="sun-text">
        <span className="sun-time">
          {override === null ? "Lisbon" : "Showing"} <time>{formatMinutes(minutes)}</time>
          {weather && <span className="sun-weather"> · {weather}</span>}
        </span>
        {/* One click to see the city at another time of day. */}
        <span className="sun-presets" role="group" aria-label="Show the city at">
          {[
            ["Day", 13 * 60],
            ["Sunset", day.sunset !== null ? Math.round(day.sunset / 5) * 5 : 18 * 60],
            ["Night", 22 * 60 + 30],
          ].map(([label, at]) => (
            <button
              key={label}
              type="button"
              aria-pressed={override === at}
              onClick={() => onChange(at as number)}
            >
              {label}
            </button>
          ))}
          <span className="holidays" ref={holidaysRef}>
            <button
              type="button"
              aria-expanded={holidaysOpen}
              aria-pressed={holiday !== null}
              onClick={() => setHolidaysOpen((open) => !open)}
            >
              {holiday ? HOLIDAYS.find((h) => h.id === holiday)!.label : "Holidays"}
            </button>
            {holidaysOpen && (
              <span className="holidays-menu" role="menu">
                {HOLIDAYS.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={holiday === h.id}
                    onClick={() => {
                      onHoliday(h.id, h.time);
                      setHolidaysOpen(false);
                    }}
                  >
                    {h.label}
                  </button>
                ))}
                {holiday && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onHoliday(null, null);
                      setHolidaysOpen(false);
                    }}
                  >
                    Off: today's date
                  </button>
                )}
              </span>
            )}
          </span>
          {override !== null && (
            <button
              type="button"
              className="sun-reset"
              onClick={() => {
                onChange(null);
                if (holiday) onHoliday(null, null);
              }}
            >
              Now
            </button>
          )}
        </span>
      </span>
    </span>,
    host,
  );
}
