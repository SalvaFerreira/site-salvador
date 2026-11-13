import { getCollection, getEntry, type CollectionEntry } from "astro:content";
import { existsSync } from "node:fs";

export const SITE_NAME = "Salvador Ferreira";
export const CV_PATH = "/cv-salvador-ferreira.pdf";
/** The CV as an image, shown in the CV window (made from the PDF with PyMuPDF). */
export const CV_IMAGE = "/cv-salvador-ferreira.png";
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

/** Email address and LinkedIn profile, from the links of the contact entry. */
export async function getContact(): Promise<{ email?: string; linkedin?: string }> {
  const contact = (await getCollection("projects")).find((e) => e.data.kind === "contact");
  const links = contact?.data.links ?? [];
  return {
    email: links.find((l) => l.url.startsWith("mailto:"))?.url,
    linkedin: links.find((l) => l.url.includes("linkedin.com"))?.url,
  };
}

/**
 * Structured data about Salvador (schema.org Person) for search engines and
 * link previews, built from the content files only.
 */
export async function getPerson(site: URL | undefined): Promise<Record<string, unknown>> {
  const [about, places, contact] = await Promise.all([getAbout(), getPlaces(), getContact()]);
  const current = places.find((e) => e.data.category === "job" && e.data.period?.includes("Present") && e.data.title === "Deloitte");
  const schools = places.filter((e) => e.data.category === "education");
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: SITE_NAME,
    description: about.masthead,
    ...(site ? { url: site.href } : {}),
    ...(contact.email ? { email: contact.email.replace(/^mailto:/, "") } : {}),
    ...(current ? { jobTitle: current.data.role?.split(" · ")[0], worksFor: { "@type": "Organization", name: current.data.title } } : {}),
    alumniOf: schools.map((e) => ({ "@type": "CollegeOrUniversity", name: e.data.title })),
    address: { "@type": "PostalAddress", addressLocality: "Lisbon", addressCountry: "PT" },
    ...(contact.linkedin ? { sameAs: [contact.linkedin] } : {}),
  };
}

export async function getPlaces(): Promise<Entry[]> {
  return (await getCollection("projects")).sort((a, b) => a.data.order - b.data.order);
}
