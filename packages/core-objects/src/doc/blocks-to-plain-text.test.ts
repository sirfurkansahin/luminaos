import { describe, expect, it } from 'vitest';

import { blocksToPlainText } from './blocks-to-plain-text.js';

import type { Block, InlineMark } from './block.js';

/**
 * Designed contract for `blocksToPlainText` (F1-T13 PR2, per ADR-0013 §(d)
 * "Global arama" — must be matched exactly by implementer):
 *
 *   blocksToPlainText(blocks: Block[]): string
 *     -> Pure function. Derives flat, indexable plain text from a document's
 *        block tree, for the search-index projection (F1-T13 PR3) to feed
 *        into Postgres `to_tsvector`. Does not mutate its input.
 *     -> A single block's own text is the concatenation (with '', no
 *        separator — inline runs are contiguous substrings of the same
 *        logical sentence) of `content[].text`, ignoring `marks` entirely.
 *     -> Traversal is pre-order / depth-first: for each top-level block, its
 *        own text is emitted first, then it recurses into `children` (in
 *        array order) before moving on to the block's next sibling.
 *     -> Only *non-empty* own-text segments are collected; a block whose own
 *        text is '' (empty `content`, e.g. an empty paragraph or a
 *        `divider`) contributes nothing at all to the output — not even an
 *        empty segment — so it never produces a stray/doubled separator.
 *     -> Collected non-empty segments are joined with '\n'.
 *     -> `blocksToPlainText([])` returns ''.
 */

// Realistic ULID-shaped ids (see id.ts — object/block ids are ULIDs).
const ROOT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CHILD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const SIBLING_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const EMPTY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const DIVIDER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB3';

function buildBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: ROOT_ID,
    type: 'paragraph',
    content: [{ text: 'Hello world' }],
    children: [],
    ...overrides,
  };
}

describe('blocksToPlainText — flat single block', () => {
  it('returns the text of a single paragraph block', () => {
    const block = buildBlock({
      id: ROOT_ID,
      type: 'paragraph',
      content: [{ text: 'hello world' }],
      children: [],
    });

    const result = blocksToPlainText([block]);

    expect(result).toContain('hello world');
    expect(result).toBe('hello world');
  });
});

describe('blocksToPlainText — multiple sibling blocks', () => {
  it('joins top-level sibling blocks in document order, separated by \\n', () => {
    const first = buildBlock({
      id: ROOT_ID,
      type: 'heading1',
      content: [{ text: 'first block' }],
      children: [],
    });
    const second = buildBlock({
      id: SIBLING_ID,
      type: 'paragraph',
      content: [{ text: 'second block' }],
      children: [],
    });

    const result = blocksToPlainText([first, second]);

    expect(result).toBe('first block\nsecond block');
  });
});

describe('blocksToPlainText — nested children', () => {
  it('recurses into children, placing nested text after the parent own text and before the next sibling', () => {
    const nestedChild = buildBlock({
      id: CHILD_ID,
      type: 'paragraph',
      content: [{ text: 'nested child text' }],
      children: [],
    });
    const parent = buildBlock({
      id: ROOT_ID,
      type: 'bulletList',
      content: [{ text: 'parent text' }],
      children: [nestedChild],
    });
    const followingSibling = buildBlock({
      id: SIBLING_ID,
      type: 'paragraph',
      content: [{ text: 'following sibling text' }],
      children: [],
    });

    const result = blocksToPlainText([parent, followingSibling]);

    expect(result).toBe('parent text\nnested child text\nfollowing sibling text');
  });
});

describe('blocksToPlainText — multiple inline runs in one block', () => {
  it('concatenates all inline runs of a block without separator and drops marks metadata', () => {
    const marks: InlineMark[] = ['bold'];
    const block = buildBlock({
      id: ROOT_ID,
      type: 'paragraph',
      content: [{ text: 'foo' }, { text: 'bar', marks }],
      children: [],
    });

    const result = blocksToPlainText([block]);

    expect(result).toBe('foobar');
    expect(result).toContain('foo');
    expect(result).toContain('bar');
    expect(result).not.toContain('bold');
  });
});

describe('blocksToPlainText — empty content block', () => {
  it('contributes no text and no stray separator for a block with empty content and no children', () => {
    const emptyBlock = buildBlock({
      id: EMPTY_ID,
      type: 'paragraph',
      content: [],
      children: [],
    });

    const result = blocksToPlainText([emptyBlock]);

    expect(result).toBe('');
  });

  it('does not insert a doubled separator when an empty block sits between two non-empty siblings', () => {
    const first = buildBlock({
      id: ROOT_ID,
      type: 'paragraph',
      content: [{ text: 'first' }],
      children: [],
    });
    const empty = buildBlock({
      id: EMPTY_ID,
      type: 'paragraph',
      content: [],
      children: [],
    });
    const second = buildBlock({
      id: SIBLING_ID,
      type: 'paragraph',
      content: [{ text: 'second' }],
      children: [],
    });

    const result = blocksToPlainText([first, empty, second]);

    expect(result).toBe('first\nsecond');
  });
});

describe('blocksToPlainText — divider block', () => {
  it('contributes nothing for a divider block (always-empty content and children per validateBlock)', () => {
    const divider = buildBlock({
      id: DIVIDER_ID,
      type: 'divider',
      content: [],
      children: [],
    });

    const result = blocksToPlainText([divider]);

    expect(result).toBe('');
  });
});

describe('blocksToPlainText — empty top-level array', () => {
  it("returns '' for an empty blocks array", () => {
    const result = blocksToPlainText([]);

    expect(result).toBe('');
  });
});

describe('blocksToPlainText — purity', () => {
  it('does not mutate the input blocks array or its nested block objects', () => {
    const nestedChild = buildBlock({
      id: CHILD_ID,
      type: 'paragraph',
      content: [{ text: 'nested child text' }],
      children: [],
    });
    const parent = buildBlock({
      id: ROOT_ID,
      type: 'bulletList',
      content: [{ text: 'parent text', marks: ['bold'] }],
      children: [nestedChild],
    });
    const blocks = [parent];
    const snapshot = structuredClone(blocks);

    blocksToPlainText(blocks);

    expect(blocks).toStrictEqual(snapshot);
  });
});
