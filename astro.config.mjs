import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// Absolute address of the site, needed for link previews (LinkedIn).
// Vercel provides VERCEL_PROJECT_PRODUCTION_URL at build time; set SITE_URL to override.
const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const site = process.env.SITE_URL ?? (host ? `https://${host}` : undefined);

export default defineConfig({
  site,
  integrations: [react()],
  // The dev toolbar sits bottom-centre, over the map.
  devToolbar: { enabled: false },
});
