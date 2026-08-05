import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { validateBlock } from './block.js';

import type { Block, BlockType, InlineMark, InlineRichText } from './block.js';

/**
 * Designed block schema + validator signatures (F1-T11 PR1, per ADR-0011
 * "Blok şeması" — must be matched exactly by implementer):
 *
 *   type InlineMark = 'bold' | 'italic' | 'code' | 'strikethrough';
 *
 *   interface InlineRichText {
 *     text: string;
 *     marks?: InlineMark[];
 *   }
 *
 *   type BlockType =
 *     | 'paragraph' | 'heading1' | 'heading2' | 'heading3'
 *     | 'bulletList' | 'numberedList' | 'todo' | 'code' | 'quote' | 'divider';
 *
 *   interface Block {
 *     id: string;               // ULID
 *     type: BlockType;
 *     content: InlineRichText[];
 *     children: Block[];
 *   }
 *
 *   validateBlock(block: Block): void
 *     -> Pure recursive validator. Returns void on success; throws
 *        ValidationError from @luminaos/shared on any invariant violation.
 *        Recurses into `children`.
 *     -> throws ValidationError when `id` is not a non-empty string.
 *     -> throws ValidationError when `type` is not one of the 10 known
 *        BlockType values.
 *     -> throws ValidationError when `content` is not an array.
 *     -> throws ValidationError when `children` is not an array.
 *     -> divider invariant: a 'divider' block MUST have empty content ([])
 *        AND empty children ([]). Any content or any children on a divider
 *        throws ValidationError with { blockId } context.
 *     -> non-divider blocks MAY be empty (empty content + empty children is
 *        valid for e.g. an empty 'paragraph').
 */

// Realistic ULID-shaped ids (see id.ts — object/block ids are ULIDs).
const ROOT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CHILD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const GRANDCHILD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB1';

function buildBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: ROOT_ID,
    type: 'paragraph',
    content: [{ text: 'Hello world' }],
    children: [],
    ...overrides,
  };
}

describe('validateBlock — divider invariant', () => {
  it('accepts a divider with empty content and empty children', () => {
    const divider = buildBlock({ id: ROOT_ID, type: 'divider', content: [], children: [] });

    expect(() => {
      validateBlock(divider);
    }).not.toThrow();
  });

  it('throws ValidationError when a divider has non-empty content', () => {
    const divider = buildBlock({
      id: ROOT_ID,
      type: 'divider',
      content: [{ text: 'not allowed' }],
      children: [],
    });

    expect(() => {
      validateBlock(divider);
    }).toThrow(ValidationError);

    try {
      validateBlock(divider);
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ blockId: ROOT_ID });
    }
  });

  it('throws ValidationError when a divider has children', () => {
    const divider = buildBlock({
      id: ROOT_ID,
      type: 'divider',
      content: [],
      children: [buildBlock({ id: CHILD_ID })],
    });

    expect(() => {
      validateBlock(divider);
    }).toThrow(ValidationError);

    try {
      validateBlock(divider);
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ blockId: ROOT_ID });
    }
  });
});

describe('validateBlock — structural defensive guards', () => {
  it('throws ValidationError when id is not a non-empty string', () => {
    const block = buildBlock({ id: '' });

    expect(() => {
      validateBlock(block);
    }).toThrow(ValidationError);
  });

  it('throws ValidationError when id is not a string', () => {
    const block = buildBlock({ id: 42 as unknown as string });

    expect(() => {
      validateBlock(block);
    }).toThrow(ValidationError);
  });

  it('throws ValidationError when type is not one of the 10 known BlockType values', () => {
    const block = buildBlock({ type: 'marquee' as unknown as BlockType });

    expect(() => {
      validateBlock(block);
    }).toThrow(ValidationError);
  });

  it('throws ValidationError when content is not an array', () => {
    const block = buildBlock({ content: 'oops' as unknown as InlineRichText[] });

    expect(() => {
      validateBlock(block);
    }).toThrow(ValidationError);
  });

  it('throws ValidationError when children is not an array', () => {
    const block = buildBlock({ children: {} as unknown as Block[] });

    expect(() => {
      validateBlock(block);
    }).toThrow(ValidationError);
  });
});

describe('validateBlock — recursion', () => {
  it('throws on the ROOT when a nested descendant (depth >= 2) violates the divider invariant', () => {
    const badDivider = buildBlock({
      id: GRANDCHILD_ID,
      type: 'divider',
      content: [{ text: 'illegal content on a nested divider' }],
      children: [],
    });

    const child = buildBlock({
      id: CHILD_ID,
      type: 'bulletList',
      content: [{ text: 'list item' }],
      children: [badDivider],
    });

    const root = buildBlock({
      id: ROOT_ID,
      type: 'heading1',
      content: [{ text: 'Title' }],
      children: [child],
    });

    expect(() => {
      validateBlock(root);
    }).toThrow(ValidationError);

    try {
      validateBlock(root);
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ blockId: GRANDCHILD_ID });
    }
  });
});

describe('validateBlock — happy paths', () => {
  it('accepts a valid nested tree with inline text (with and without marks), a todo, and a valid divider', () => {
    const marks: InlineMark[] = ['bold', 'italic'];

    const tree = buildBlock({
      id: ROOT_ID,
      type: 'heading1',
      content: [{ text: 'Chapter one', marks }],
      children: [
        buildBlock({
          id: CHILD_ID,
          type: 'paragraph',
          content: [{ text: 'plain' }, { text: 'emphasised', marks: ['code'] }],
          children: [],
        }),
        buildBlock({
          id: '01ARZ3NDEKTSV4RRFFQ69G5FB2',
          type: 'bulletList',
          content: [{ text: 'first bullet' }],
          children: [],
        }),
        buildBlock({
          id: '01ARZ3NDEKTSV4RRFFQ69G5FB3',
          type: 'todo',
          content: [{ text: 'do the thing' }],
          children: [],
        }),
        buildBlock({
          id: '01ARZ3NDEKTSV4RRFFQ69G5FB4',
          type: 'divider',
          content: [],
          children: [],
        }),
      ],
    });

    expect(() => {
      validateBlock(tree);
    }).not.toThrow();
  });

  it('accepts a non-divider block with empty content and empty children (e.g. an empty paragraph)', () => {
    const emptyParagraph = buildBlock({
      id: ROOT_ID,
      type: 'paragraph',
      content: [],
      children: [],
    });

    expect(() => {
      validateBlock(emptyParagraph);
    }).not.toThrow();
  });
});
