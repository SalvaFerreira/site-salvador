import { getCollection, getEntry, type CollectionEntry } from "astro:content";
import { existsSync } from "node:fs";

export const SITE_NAME = "Salvador Ferreira";
export const CV_PATH = "/cv-salvador-ferreira.pdf";
/** The CV as an image, shown in the CV window (made from the PDF with PyMuPDF). */
export const CV_IMAGE = "/cv-salvador-ferreira.png";
/** Salvador's photo (cropped from eu.png in the repository root, 240 px square). */
export const PORTRAIT = "/images/salvador.jpg";
/** The CV link only appears once the file is in public/. */
export const hasCv = existsSync(`./public${CV_PATH}`);

export type Entry = CollectionEntry<"projects">;

/** HTML of a content file without its comments: they are notes for editing, not for visitors. */
export function htmlOf(rendered: { html?: string } | undefined): string {
  return (rendered?.html ?? "").replace(/<!--[\s\S]*?-->\s*/g, "");
}

/** Title of the home page (the browser tab, search results and link previews). */
export async function getHomeTitle(): Promise<string> {
  return `Profile - ${SITE_NAME}`;
}

export function pathOf(entry: Entry): string {
  return entry.data.kind === "work" ? `/work/${entry.id}` : `/${entry.data.kind}`;
}

/** The presentation text from src/content/site/about.md, as HTML. */
export async function getAbout(): Promise<{ html: string }> {
  const entry = await getEntry("site", "about");
  if (!entry) throw new Error("src/content/site/about.md is missing");
  return { html: htmlOf(entry.rendered) };
}

/** Email address and LinkedIn profile, from the links of the contact entry. */
export async function getContact(): Promise<{ email?: string; linkedin?: string }> {
  const contact = (await getCollection("projects")).find((e) => e.data.kind === "contact");
  const links = contact?.data.links ?? [];
  return {
    email: links.find((l) => l.url.startsWith("mailto:"))?.url,
    linkedin: links.find((l) => l.url.includes("linkedin.com"))?.url,
  };
}

export type Profile = CollectionEntry<"site">["data"];

/** Role, headline, strengths, skills and languages, from src/content/site/about.md. */
export async function getProfile(): Promise<Profile> {
  const entry = await getEntry("site", "about");
  if (!entry) throw new Error("src/content/site/about.md is missing");
  return entry.data;
}

/** The organisation a job or school entry belongs to (entries of one employer share a group). */
export function orgOf(entry: Entry): string {
  return entry.data.group ?? entry.data.title;
}

/** Places of one category, newest first, grouped by organisation. */
export function byOrganisation(places: Entry[], category: "job" | "education" | "personal"): { org: string; entries: Entry[] }[] {
  const time = (e: Entry) => e.data.date?.getTime() ?? 0;
  const list = places.filter((e) => e.data.category === category && e.data.kind === "work").sort((a, b) => time(b) - time(a));
  const groups: { org: string; entries: Entry[] }[] = [];
  for (const e of list) {
    const org = orgOf(e);
    const group = groups.find((g) => g.org === org);
    if (group) group.entries.push(e);
    else groups.push({ org, entries: [e] });
  }
  return groups;
}

/**
 * Structured data about Salvador (schema.org ProfilePage about a Person, as Google
 * recommends for profile pages) for search engines and AI agents, from the content files only.
 */
export async function getPerson(site: URL | undefined): Promise<Record<string, unknown>> {
  const [profile, places, contact] = await Promise.all([getProfile(), getPlaces(), getContact()]);
  const current = places.filter((e) => e.data.category === "job" && e.data.period?.includes("Present"));
  const schools = places.filter((e) => e.data.category === "education");
  const skills = profile.skills.flatMap((g) => g.items);
  const person = {
    "@type": "Person",
    name: SITE_NAME,
    jobTitle: profile.role,
    description: profile.headline,
    ...(site ? { url: site.href, image: new URL(PORTRAIT, site).href } : {}),
    worksFor: [...new Set(current.map(orgOf))].map((name) => ({ "@type": "Organization", name })),
    hasOccupation: {
      "@type": "Occupation",
      name: profile.role,
      skills: skills.join(", "),
      occupationLocation: { "@type": "City", name: "Lisbon" },
    },
    alumniOf: schools.map((e) => ({ "@type": "CollegeOrUniversity", name: e.data.title })),
    knowsAbout: skills,
    knowsLanguage: profile.languages.map((l) => ({ "@type": "Language", name: l.name })),
    address: { "@type": "PostalAddress", addressLocality: "Lisbon", addressCountry: "PT" },
    sameAs: [contact.linkedin, profile.github].filter(Boolean),
  };
  return { "@context": "https://schema.org", "@type": "ProfilePage", mainEntity: person };
}

export async function getPlaces(): Promise<Entry[]> {
  return (await getCollection("projects")).sort((a, b) => a.data.order - b.data.order);
}
