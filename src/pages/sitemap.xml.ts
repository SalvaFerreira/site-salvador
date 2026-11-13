// Every page of the site, for search engines. Needs the site's address
// (SITE_URL, or Vercel's production URL at build time; see astro.config.mjs).
import type { APIRoute } from "astro";
import { getPlaces, pathOf } from "../lib/places";

export const GET: APIRoute = async ({ site }) => {
  const paths = ["/", "/profile", ...(await getPlaces()).map(pathOf)];
  const base = site ?? new URL("http://localhost:4321");
  const urls = paths.map((path) => `  <url><loc>${new URL(path, base).href}</loc></url>`).join("\n");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { "Content-Type": "application/xml" },
  });
};
