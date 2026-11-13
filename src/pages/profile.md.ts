// The profile as Markdown, for AI agents and tools that read text (see lib/profileText.ts).
import type { APIRoute } from "astro";
import { buildProfileMarkdown } from "../lib/profileText";

export const GET: APIRoute = async ({ site }) =>
  new Response(await buildProfileMarkdown(site ?? new URL("http://localhost:4321")), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
