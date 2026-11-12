// Light of the city according to the real time in Lisbon, shared by every material.
import { Color } from "three";

export const FOG_COLOR = new Color("#07080b");
export const FOG_DENSITY = 0.00011;

/** Uniforms shared by reference: updating one value updates every material. */
export const shared = {
  /** 1 at night, 0 in daylight. */
  uNight: { value: 1 },
  /** Seconds since the scene started; stays 0 with prefers-reduced-motion. */
  uTime: { value: 0 },
  /** 1 while the Plan layer is shown. */
  uPlan: { value: 0 },
  /** How many windows are lit: 1 in the evening, less in the small hours. */
  uActivity: { value: 1 },
  uFogColor: { value: FOG_COLOR },
  uFogDensity: { value: FOG_DENSITY },
};

const LAT = 38.72;
const LON = -9.14;
const RAD = Math.PI / 180;

const FOG_NIGHT = new Color("#07080b");
const FOG_DAY = new Color("#a9b3ba");

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Height of the sun over Lisbon in degrees (good to about a degree, enough for lighting). */
function sunElevation(date: Date, solarHour?: number): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((date.getTime() - start) / 86400000);
  const declination = -23.44 * Math.cos(((2 * Math.PI) / 365) * (day + 10));
  const hour = solarHour ?? date.getUTCHours() + date.getUTCMinutes() / 60 + LON / 15;
  const hourAngle = 15 * (hour - 12);
  const sin =
    Math.sin(LAT * RAD) * Math.sin(declination * RAD) +
    Math.cos(LAT * RAD) * Math.cos(declination * RAD) * Math.cos(hourAngle * RAD);
  return Math.asin(sin) / RAD;
}

function lisbonHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") + get("minute") / 60;
}

/** Share of windows lit by hour of the day: evenings are busy, 4 am is not. */
function activity(hour: number): number {
  if (hour >= 18 && hour < 23) return 1;
  if (hour >= 23) return 1 - 0.5 * (hour - 23);
  if (hour < 2) return 0.5 - 0.1 * hour;
  if (hour < 5.5) return 0.3;
  if (hour < 8) return 0.3 + 0.2 * (hour - 5.5);
  return 0.8;
}

/**
 * Sets the shared uniforms from the current time in Lisbon.
 * `overrideHour` (0-24, from ?hour=) pretends it is that time, for testing.
 */
export function updateEnvironment(overrideHour?: number): void {
  const now = new Date();
  const hour = overrideHour ?? lisbonHour(now);
  const elevation = sunElevation(now, overrideHour);
  const night = 1 - smoothstep(-6, 5, elevation);
  shared.uNight.value = night;
  shared.uActivity.value = activity(hour);
  FOG_COLOR.copy(FOG_DAY).lerp(FOG_NIGHT, night);
}
