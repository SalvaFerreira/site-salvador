// The sun over Lisbon: how high it is at a given moment, when it rises and
// sets, and what that means for the light in the city (day, dusk, night).

const LAT = 38.72;
const LON = -9.14;
const RAD = Math.PI / 180;

/** Height of the sun above the horizon over Lisbon, in degrees (low-precision formula, good to a fraction of a degree). */
export function sunElevation(date: Date): number {
  // Days since 1 January 2000, 12:00 UTC.
  const d = date.getTime() / 86400000 - 10957.5;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l));
  const dec = Math.asin(Math.sin(e) * Math.sin(l));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const hourAngle = (gmst * 15 + LON) * RAD - ra;
  return Math.asin(Math.sin(LAT * RAD) * Math.sin(dec) + Math.cos(LAT * RAD) * Math.cos(dec) * Math.cos(hourAngle)) / RAD;
}

const lisbonClock = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit", hour12: false });

/** Minutes since midnight on the clocks in Lisbon. */
export function lisbonMinutes(date: Date): number {
  const [h, m] = lisbonClock.format(date).split(":").map(Number);
  return (h % 24) * 60 + m;
}

/** The moment today (in Lisbon) when Lisbon's clocks show `minutes` past midnight. */
export function atLisbonMinutes(minutes: number, today = new Date()): Date {
  return new Date(today.getTime() + (minutes - lisbonMinutes(today)) * 60000 - today.getSeconds() * 1000);
}

export function formatMinutes(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The sun through today in Lisbon: its height every few minutes, and sunrise and sunset (in Lisbon minutes). */
export function sunDay(today = new Date(), stepMinutes = 10) {
  const heights: number[] = [];
  for (let m = 0; m <= 1440; m += stepMinutes) heights.push(sunElevation(atLisbonMinutes(m, today)));
  // The sun's upper edge on the horizon, with refraction.
  const HORIZON = -0.833;
  let sunrise: number | null = null;
  let sunset: number | null = null;
  for (let i = 1; i < heights.length; i++) {
    const a = heights[i - 1] - HORIZON;
    const b = heights[i] - HORIZON;
    if (a < 0 && b >= 0) sunrise = (i - 1 + a / (a - b)) * stepMinutes;
    if (a >= 0 && b < 0) sunset = (i - 1 + a / (a - b)) * stepMinutes;
  }
  return { heights, stepMinutes, sunrise, sunset };
}

/**
 * Share of windows lit at a time of night (Lisbon minutes): lights come on
 * through the evening, most around nine, then go off one by one until the
 * small hours; a few come on again before dawn.
 */
export function litShare(minutes: number): number {
  const table: [number, number][] = [
    [0, 0.2], [120, 0.09], [300, 0.05], [390, 0.12], [480, 0.1],
    [1020, 0.18], [1170, 0.42], [1290, 0.5], [1380, 0.36], [1440, 0.2],
  ];
  for (let i = 1; i < table.length; i++) {
    const [m1, v1] = table[i];
    const [m0, v0] = table[i - 1];
    if (minutes <= m1) return v0 + ((v1 - v0) * (minutes - m0)) / (m1 - m0);
  }
  return table[table.length - 1][1];
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * The light in the city for a height of the sun: `night` 0 in daylight to 1
 * after dusk, `dusk` the warm light around sunrise and sunset.
 */
export function lightFor(elevation: number): { night: number; dusk: number } {
  const night = 1 - smoothstep(-7, 3, elevation);
  const dusk = smoothstep(-6, 0, elevation) * (1 - smoothstep(4, 14, elevation));
  return { night, dusk };
}
