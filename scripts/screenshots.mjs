// Takes the still images of the city from the running site:
//   public/city.jpg        shown when the 3D city cannot run
//   public/og/home.jpg     link preview for the home page
//   public/og/<place>.jpg  link preview for each place
//
// Usage: npm run build && npm run preview   (in one terminal)
//        npm run screenshots                (in another), then build again.
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL ?? "http://localhost:4321";
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && fs.existsSync(p));
if (!CHROME) throw new Error("Chrome not found: set CHROME_PATH.");

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();

async function shoot(path, file, width, height) {
  await page.setViewport({ width, height });
  // In daylight, whatever the hour in Lisbon when the images are taken.
  await page.goto(`${BASE}${path}?shot&time=13:00`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => window.__city?.loadMs > 0, { timeout: 90000 });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await page.screenshot({ path: file, type: "jpeg", quality: 82 });
  console.log(file);
}

fs.mkdirSync("public/og", { recursive: true });
await shoot("/", "public/city.jpg", 1600, 1000);
await shoot("/", "public/og/home.jpg", 1200, 630);

// The List knows every place and its address.
await page.goto(`${BASE}/list`, { waitUntil: "domcontentloaded" });
const places = await page.$$eval("section[id]", (sections) =>
  sections.map((s) => ({ id: s.id, path: s.querySelector("h2 a").getAttribute("href") })),
);
for (const place of places) {
  await shoot(place.path, `public/og/${place.id}.jpg`, 1200, 630);
}

await browser.close();
