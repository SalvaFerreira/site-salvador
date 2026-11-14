// schema.org data about Salvador as JSON-LD, for AI agents (the same data as in every page's head).
import type { APIRoute } from "astro";
import { getPerson } from "../lib/places";

export const GET: APIRoute = async ({ site }) =>
  new Response(JSON.stringify(await getPerson(site), null, 2), {
    headers: { "Content-Type": "application/ld+json; charset=utf-8" },
  });
