import { getCollection, type CollectionEntry } from "astro:content";
import { existsSync } from "node:fs";

export const SITE_NAME = "Salvador Ferreira";
export const CV_PATH = "/cv-salvador-ferreira.pdf";
/** The CV link only appears once the file is in public/. */
export const hasCv = existsSync(`./public${CV_PATH}`);

export type Entry = CollectionEntry<"projects">;

export function pathOf(entry: Entry): string {
  return entry.data.kind === "work" ? `/work/${entry.id}` : `/${entry.data.kind}`;
}

export async function getPlaces(): Promise<Entry[]> {
  return (await getCollection("projects")).sort((a, b) => a.data.order - b.data.order);
}
