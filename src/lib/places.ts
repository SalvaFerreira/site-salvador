import { getCollection, getEntry, type CollectionEntry } from "astro:content";
import { existsSync } from "node:fs";

export const SITE_NAME = "Salvador Ferreira";
export const CV_PATH = "/cv-salvador-ferreira.pdf";
/** The CV link only appears once the file is in public/. */
export const hasCv = existsSync(`./public${CV_PATH}`);

export type Entry = CollectionEntry<"projects">;

export function pathOf(entry: Entry): string {
  return entry.data.kind === "work" ? `/work/${entry.id}` : `/${entry.data.kind}`;
}

/** The presentation text from src/content/site/about.md: one line, and the full text as HTML. */
export async function getAbout(): Promise<{ masthead: string; html: string }> {
  const entry = await getEntry("site", "about");
  if (!entry) throw new Error("src/content/site/about.md is missing");
  return { masthead: entry.data.masthead, html: entry.rendered?.html ?? "" };
}

export async function getPlaces(): Promise<Entry[]> {
  return (await getCollection("projects")).sort((a, b) => a.data.order - b.data.order);
}
