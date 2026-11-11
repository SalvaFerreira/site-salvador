import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// One Markdown file per place in the city. The scene and the List both read from here.
const projects = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/projects" }),
  schema: z.object({
    title: z.string(),
    place: z.string(),
    /** [longitude, latitude] of the building to light up. */
    coordinates: z.tuple([z.number(), z.number()]),
    order: z.number(),
    date: z.coerce.date().optional(),
    stack: z.array(z.string()).default([]),
  }),
});

export const collections = { projects };
