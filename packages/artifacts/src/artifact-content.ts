import { z } from 'zod';

export interface ArtifactSection {
  kind: 'heading' | 'paragraph' | 'list' | 'table' | 'imagePlaceholder';
  text?: string; // heading/paragraph
  level?: 1 | 2 | 3; // heading only
  items?: string[]; // list
  headers?: string[]; // table
  rows?: string[][]; // table
  caption?: string; // imagePlaceholder -- v0 never embeds a real image (no
  // blob storage, insan kararı 2); this kind renders a labeled placeholder box.
}

export interface ArtifactContent {
  title: string;
  sections: ArtifactSection[];
}

export const artifactSectionSchema = z
  .object({
    kind: z.enum(['heading', 'paragraph', 'list', 'table', 'imagePlaceholder']),
    text: z.string().max(2000).optional(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    items: z.array(z.string().max(500)).max(50).optional(),
    headers: z.array(z.string().max(200)).max(20).optional(),
    rows: z
      .array(z.array(z.string().max(500)).max(20))
      .max(100)
      .optional(),
    caption: z.string().max(300).optional(),
  })
  .strict();

export const artifactContentSchema = z
  .object({
    title: z.string().min(1).max(300),
    sections: z.array(artifactSectionSchema).min(1).max(100),
  })
  .strict();
