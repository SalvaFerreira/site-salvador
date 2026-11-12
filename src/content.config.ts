import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// One Markdown file per place in the city. The scene and the List both read from here.
const projects = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/projects" }),
  schema: z.object({
    title: z.string(),
    place: z.string(),
    /** [longitude, latitude] of the building (or spot) to mark. */
    coordinates: z.tuple([z.number(), z.number()]),
    order: z.number(),
    date: z.coerce.date().optional(),
    stack: z.array(z.string()).default([]),
    /**
     * "work" lights up the building at the coordinates and lives at /work/<file name>.
     * "now" and "contact" are spots without a building, at /now and /contact.
     */
    kind: z.enum(["work", "now", "contact"]).default("work"),
    /** "plan" places are only marked while the Plan layer is on (personal projects). */
    layer: z.enum(["city", "plan"]).default("city"),
    /** "off" keeps the building dark. */
    lights: z.enum(["on", "off"]).default("on"),
  }),
});

export const collections = { projects };
