// A short index of the site for AI agents (llmstxt.org), pointing to the full profile.
import type { APIRoute } from "astro";
import { buildLlmsTxt } from "../lib/profileText";

export const GET: APIRoute = async ({ site }) =>
  new Response(await buildLlmsTxt(site ?? new URL("http://localhost:4321")), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
