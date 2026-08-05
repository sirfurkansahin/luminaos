import { ValidationError } from '@luminaos/shared';

/**
 * Per ADR-0011 "Blok şeması". The doc editor stores content as a recursive
 * tree of blocks; each block carries inline rich text and may nest children.
 * This module is the pure domain schema + validator — no framework, no zod
 * (zod validation lives at the API boundary).
 */
export type InlineMark = 'bold' | 'italic' | 'code' | 'strikethrough';

export interface InlineRichText {
  text: string;
  marks?: InlineMark[];
}

export type BlockType =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'numberedList'
  | 'todo'
  | 'code'
  | 'quote'
  | 'divider';

export interface Block {
  id: string;
  type: BlockType;
  content: InlineRichText[];
  children: Block[];
}

const KNOWN_BLOCK_TYPES: readonly BlockType[] = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'numberedList',
  'todo',
  'code',
  'quote',
  'divider',
];

/**
 * Pure recursive validator (per ADR-0011). Returns void on success; throws
 * `ValidationError` on any invariant violation, recursing into `children` so a
 * deep violation surfaces from the root.
 *
 * Divider invariant: a `divider` block MUST have empty content AND empty
 * children. Non-divider blocks MAY be empty.
 */
export function validateBlock(block: Block): void {
  if (typeof block.id !== 'string' || block.id.trim() === '') {
    throw new ValidationError('block id must be a non-empty string', {
      blockId: block.id,
    });
  }

  if (!KNOWN_BLOCK_TYPES.includes(block.type)) {
    throw new ValidationError('block type must be one of the known BlockType values', {
      blockId: block.id,
      type: block.type,
    });
  }

  if (!Array.isArray(block.content)) {
    throw new ValidationError('block content must be an array', {
      blockId: block.id,
    });
  }

  if (!Array.isArray(block.children)) {
    throw new ValidationError('block children must be an array', {
      blockId: block.id,
    });
  }

  if (block.type === 'divider' && (block.content.length > 0 || block.children.length > 0)) {
    throw new ValidationError('a divider block must have empty content and empty children', {
      blockId: block.id,
    });
  }

  for (const child of block.children) {
    validateBlock(child);
  }
}
