import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// One Markdown file per place in the city. The scene and the List both read from here.
const projects = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/projects" }),
  schema: z.object({
    title: z.string(),
    /** Short name shown on the map label. Defaults to the title. */
    label: z.string().optional(),
    /** Places with the same group share one label and one panel. */
    group: z.string().optional(),
    /** Colour code on the map. */
    category: z.enum(["job", "education", "personal"]).optional(),
    place: z.string(),
    /** Position held or degree, and when: shown under the title. */
    role: z.string().optional(),
    period: z.string().optional(),
    /** [longitude, latitude] of the building (or spot) to mark. */
    coordinates: z.tuple([z.number(), z.number()]),
    /** Reading order in the List and the Tour. */
    order: z.number(),
    date: z.coerce.date().optional(),
    stack: z.array(z.string()).default([]),
    /** Company or school website, email, profiles. */
    links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
    /**
     * "work" marks the building at the coordinates and lives at /work/<file name>.
     * "now" is a spot without a building, at /now.
     * "contact" is not on the map; it opens from the top bar, at /contact.
     */
    kind: z.enum(["work", "now", "contact"]).default("work"),
    /** "off" keeps the building dark. */
    lights: z.enum(["on", "off"]).default("on"),
  }),
});

export const collections = { projects };
