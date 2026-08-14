import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { extractMarkdownFromYjsUpdate } from './yjs-to-markdown.js';

/**
 * F1-T18 PR2 (RED step) -- ADR-0016 §(d). Unit tests (no DB, no
 * testcontainers) for `extractMarkdownFromYjsUpdate(update: Buffer): string`,
 * the pure function that decodes a Yjs full-state update and walks
 * BlockNote's REAL `Y.XmlFragment` tree (same `'document-store'` fragment key
 * as `./yjs-plain-text.ts`'s `extractPlainTextFromYjsUpdate`, verified in
 * `apps/web/src/views/doc/DocEditor.tsx`) to produce Markdown syntax, instead
 * of the unused `Block[]`/`blocksToMarkdown` pipeline the original spec
 * wrongly assumed existed (ADR-0016 §d explicitly rejects that path).
 *
 * `./yjs-to-markdown.ts` does not exist yet, so every test in this file fails
 * at IMPORT time (module not found) -- the correct RED state.
 *
 * The REAL BlockNote Yjs tree shape this file's fixtures reconstruct
 * (confirmed against `@blocknote/core@0.52.1`'s own ProseMirror schema --
 * `doc` node has `content: "blockGroup"`, `blockContainer`'s content
 * expression is `"blockContent blockGroup?"`, `blockGroup`'s content is
 * `"blockGroupChild+"`):
 *
 * ```
 * fragment (document-store)
 *   blockGroup                      <- ALWAYS exactly one top-level wrapper
 *     blockContainer                <- one per actual block
 *       <content-element>           <- block type tag, holds inline Y.XmlText
 *       blockGroup?                 <- OPTIONAL, only if this block has
 *         blockContainer                nested/indented children
 *           <content-element>
 *           blockGroup?
 *             ...
 *     blockContainer
 *       ...
 * ```
 *
 * Traversal must be iterative (explicit stack), NOT recursive -- mirrors
 * `yjs-plain-text.ts`'s exact DoS-safety rationale (an unbounded recursive
 * walk over a document's own, attacker-reachable-via-sustained-nesting
 * content could stack-overflow). Stack entries carry `{ node, depth }` pairs.
 */

const FRAGMENT_KEY = 'document-store';

/**
 * Builds a `Y.Doc`, lets `populate` mutate its `'document-store'` fragment,
 * and returns the resulting full-state update bytes (mirrors
 * `yjs-plain-text.test.ts`'s own `buildUpdate` helper and
 * `doc-collab.gateway.ts`'s `Y.encodeStateAsUpdate(room.doc)` encode side).
 */
function buildUpdate(populate: (fragment: Y.XmlFragment) => void): Buffer {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  populate(fragment);
  const update = Y.encodeStateAsUpdate(doc);
  return Buffer.from(update);
}

/**
 * Builds a single content-element (e.g. `paragraph`/`heading`/
 * `bulletListItem`/...) carrying one `Y.XmlText` child with the given plain
 * text and optional block-level attributes (e.g. `{ level: 2 }` for a
 * heading, `{ checked: true }` for a checklist item). `Y.XmlElement`'s
 * default type parameter constrains attribute values to `string`; BlockNote
 * itself stores numeric/boolean attribute values at runtime (Yjs's actual
 * `ValueTypes` union permits this via its `Object` member), so the narrow
 * `as unknown as string` cast below is a type-level accommodation only, not a
 * runtime lie.
 */
function textElement(tag: string, text: string, attrs: Record<string, unknown> = {}): Y.XmlElement {
  const element = new Y.XmlElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, value as string);
  }
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  element.insert(0, [xmlText]);
  return element;
}

/** Wraps a content-element (and optional nested `blockGroup` of children) in a `blockContainer`. */
function blockContainer(content: Y.XmlElement, nestedGroup?: Y.XmlElement): Y.XmlElement {
  const container = new Y.XmlElement('blockContainer');
  container.insert(0, nestedGroup ? [content, nestedGroup] : [content]);
  return container;
}

/** Wraps one or more `blockContainer`s in a `blockGroup`. */
function blockGroup(...containers: Y.XmlElement[]): Y.XmlElement {
  const group = new Y.XmlElement('blockGroup');
  group.insert(0, containers);
  return group;
}

/** Populates the fragment with the single always-present top-level `blockGroup` wrapper around the given containers -- the shape every real BlockNote doc has. */
function topLevel(...containers: Y.XmlElement[]): (fragment: Y.XmlFragment) => void {
  return (fragment) => {
    fragment.insert(0, [blockGroup(...containers)]);
  };
}

describe('extractMarkdownFromYjsUpdate', () => {
  // 1. Single paragraph.
  it('renders a single paragraph as plain text', () => {
    const update = buildUpdate(topLevel(blockContainer(textElement('paragraph', 'Hello world'))));

    expect(extractMarkdownFromYjsUpdate(update)).toBe('Hello world');
  });

  // 2. Heading + paragraph, joined with a blank line.
  it('renders a level-2 heading followed by a paragraph, joined with a blank line', () => {
    const update = buildUpdate(
      topLevel(
        blockContainer(textElement('heading', 'Section Title', { level: 2 })),
        blockContainer(textElement('paragraph', 'Body text.')),
      ),
    );

    expect(extractMarkdownFromYjsUpdate(update)).toBe('## Section Title\n\nBody text.');
  });

  it('defaults a heading with no level attribute to level 1', () => {
    const update = buildUpdate(topLevel(blockContainer(textElement('heading', 'Untitled Level'))));

    expect(extractMarkdownFromYjsUpdate(update)).toBe('# Untitled Level');
  });

  it('clamps a heading level above 6 down to 6 "#"s', () => {
    const update = buildUpdate(
      topLevel(blockContainer(textElement('heading', 'Too Deep', { level: 9 }))),
    );

    expect(extractMarkdownFromYjsUpdate(update)).toBe('###### Too Deep');
  });

  // 3. Two bullet list items.
  it('renders two top-level bullet list items, each on their own "- " line, joined with a blank line', () => {
    const update = buildUpdate(
      topLevel(
        blockContainer(textElement('bulletListItem', 'First')),
        blockContainer(textElement('bulletListItem', 'Second')),
      ),
    );

    expect(extractMarkdownFromYjsUpdate(update)).toBe('- First\n\n- Second');
  });

  // 4. Two numbered list items -- both render the literal "1." marker.
  it('renders two numbered list items, both with the literal "1." marker', () => {
    const update = buildUpdate(
      topLevel(
        blockContainer(textElement('numberedListItem', 'First')),
        blockContainer(textElement('numberedListItem', 'Second')),
      ),
    );

    expect(extractMarkdownFromYjsUpdate(update)).toBe('1. First\n\n1. Second');
  });

  // 5. Checklist -- checked vs. unchecked, including default-when-omitted.
  it('renders a checked and an unchecked checklist item with "[x]"/"[ ]"', () => {
    const update = buildUpdate(
      topLevel(
        blockContainer(textElement('checkListItem', 'Done thing', { checked: true })),
        blockContainer(textElement('checkListItem', 'Todo thing', { checked: false })),
      ),
    );

    expect(extractMarkdownFromYjsUpdate(update)).toBe('- [x] Done thing\n\n- [ ] Todo thing');
  });

  it('defaults a checklist item with no "checked" attribute at all to unchecked', () => {
    const update = buildUpdate(
      topLevel(blockContainer(textElement('checkListItem', 'No attribute at all'))),
    );

    expect(extractMarkdownFromYjsUpdate(update)).toBe('- [ ] No attribute at all');
  });

  // 6. Nested bullet list -- 2-space indent per depth level.
  it("indents a nested bulletListItem (inside a blockContainer's own nested blockGroup) by 2 spaces per depth level", () => {
    const child = blockContainer(textElement('bulletListItem', 'Child item'));
    const nestedGroup = blockGroup(child);
    const parentContainer = blockContainer(
      textElement('bulletListItem', 'Parent item'),
      nestedGroup,
    );

    const update = buildUpdate(topLevel(parentContainer));

    expect(extractMarkdownFromYjsUpdate(update)).toBe('- Parent item\n\n  - Child item');
  });

  it('indents a doubly-nested bulletListItem by 4 spaces (2 levels deep)', () => {
    const grandchild = blockContainer(textElement('bulletListItem', 'Grandchild item'));
    const childNestedGroup = blockGroup(grandchild);
    const child = blockContainer(textElement('bulletListItem', 'Child item'), childNestedGroup);
    const parentNestedGroup = blockGroup(child);
    const parentContainer = blockContainer(
      textElement('bulletListItem', 'Parent item'),
      parentNestedGroup,
    );

    const update = buildUpdate(topLevel(parentContainer));

    expect(extractMarkdownFromYjsUpdate(update)).toBe(
      '- Parent item\n\n  - Child item\n\n    - Grandchild item',
    );
  });

  // 7. Quote block.
  it('renders a quote block prefixed with "> "', () => {
    const update = buildUpdate(topLevel(blockContainer(textElement('quote', 'A wise saying.'))));

    expect(extractMarkdownFromYjsUpdate(update)).toBe('> A wise saying.');
  });

  // 8. Code block, fenced with triple backticks.
  it('renders a codeBlock fenced with triple backticks', () => {
    const update = buildUpdate(topLevel(blockContainer(textElement('codeBlock', 'const x = 1;'))));

    expect(extractMarkdownFromYjsUpdate(update)).toBe('```\nconst x = 1;\n```');
  });

  // 9. Divider between two paragraphs -- always "---", has no text child at all.
  it('renders a divider between two paragraphs as "---", even though the divider element has no text child', () => {
    const divider = new Y.XmlElement('divider');

    const update = buildUpdate(
      topLevel(
        blockContainer(textElement('paragraph', 'Before')),
        blockContainer(divider),
        blockContainer(textElement('paragraph', 'After')),
      ),
    );

    expect(extractMarkdownFromYjsUpdate(update)).toBe('Before\n\n---\n\nAfter');
  });

  // 10. Inline marks.
  describe('inline marks', () => {
    it('renders a bold run in the middle of plain text as "**bold**"', () => {
      const element = new Y.XmlElement('paragraph');
      const xmlText = new Y.XmlText();
      xmlText.insert(0, 'plain ');
      xmlText.insert(6, 'bold', { bold: true });
      // Explicit empty attrs: Yjs's `YText.insert` otherwise inherits the
      // "current attributes" at the cursor position (CRDT formatting
      // continuation) when no attrs argument is given, which would silently
      // merge this run into the preceding bold run in `.toDelta()`'s output.
      xmlText.insert(10, ' normal', {});
      element.insert(0, [xmlText]);

      const update = buildUpdate(topLevel(blockContainer(element)));

      expect(extractMarkdownFromYjsUpdate(update)).toBe('plain **bold** normal');
    });

    it('applies code innermost, then bold, when both marks are present on the same run', () => {
      const element = new Y.XmlElement('paragraph');
      const xmlText = new Y.XmlText();
      xmlText.insert(0, 'x', { bold: true, code: true });
      element.insert(0, [xmlText]);

      const update = buildUpdate(topLevel(blockContainer(element)));

      expect(extractMarkdownFromYjsUpdate(update)).toBe('**`x`**');
    });

    it('renders an italic-only run as "*text*"', () => {
      const element = new Y.XmlElement('paragraph');
      const xmlText = new Y.XmlText();
      xmlText.insert(0, 'slanted', { italic: true });
      element.insert(0, [xmlText]);

      const update = buildUpdate(topLevel(blockContainer(element)));

      expect(extractMarkdownFromYjsUpdate(update)).toBe('*slanted*');
    });

    it('renders a strikethrough-only run as "~~text~~"', () => {
      const element = new Y.XmlElement('paragraph');
      const xmlText = new Y.XmlText();
      xmlText.insert(0, 'gone', { strike: true });
      element.insert(0, [xmlText]);

      const update = buildUpdate(topLevel(blockContainer(element)));

      expect(extractMarkdownFromYjsUpdate(update)).toBe('~~gone~~');
    });

    it('applies bold before italic (bold innermost) when both are present on the same run', () => {
      const element = new Y.XmlElement('paragraph');
      const xmlText = new Y.XmlText();
      xmlText.insert(0, 'y', { bold: true, italic: true });
      element.insert(0, [xmlText]);

      const update = buildUpdate(topLevel(blockContainer(element)));

      expect(extractMarkdownFromYjsUpdate(update)).toBe('***y***');
    });

    it('ignores unrecognized mark attribute keys (e.g. "underline"), rendering plain text with no special syntax', () => {
      const element = new Y.XmlElement('paragraph');
      const xmlText = new Y.XmlText();
      xmlText.insert(0, 'underlined but unsupported', { underline: true });
      element.insert(0, [xmlText]);

      const update = buildUpdate(topLevel(blockContainer(element)));

      expect(extractMarkdownFromYjsUpdate(update)).toBe('underlined but unsupported');
    });
  });

  // 11. Empty document -- a single empty paragraph is skipped entirely.
  it('returns "" for a document containing only a single empty paragraph', () => {
    const update = buildUpdate(topLevel(blockContainer(textElement('paragraph', ''))));

    expect(extractMarkdownFromYjsUpdate(update)).toBe('');
  });

  it('returns "" for a freshly created Y.Doc with an empty fragment (no blockGroup at all)', () => {
    const update = buildUpdate(() => {
      // no-op: nothing inserted, fragment stays empty.
    });

    expect(extractMarkdownFromYjsUpdate(update)).toBe('');
  });

  // 12. Forward compatibility -- unrecognized tag falls back to plain-line rendering, does not throw.
  it('falls back to plain-line rendering for an unrecognized block type, without throwing', () => {
    const update = buildUpdate(
      topLevel(blockContainer(textElement('futureBlockType', 'some caption'))),
    );

    expect(() => extractMarkdownFromYjsUpdate(update)).not.toThrow();
    expect(extractMarkdownFromYjsUpdate(update)).toBe('some caption');
  });

  // 13. Toggle list item -- same rendering as bulletListItem.
  it('renders a toggleListItem identically to a bulletListItem (no native Markdown toggle syntax)', () => {
    const update = buildUpdate(
      topLevel(blockContainer(textElement('toggleListItem', 'Toggle me'))),
    );

    expect(extractMarkdownFromYjsUpdate(update)).toBe('- Toggle me');
  });

  // A block whose rendered text is empty is skipped, but does not break the joining of its siblings.
  it('skips an empty paragraph sitting between two non-empty blocks, without a stray blank line', () => {
    const update = buildUpdate(
      topLevel(
        blockContainer(textElement('paragraph', 'First')),
        blockContainer(textElement('paragraph', '')),
        blockContainer(textElement('paragraph', 'Second')),
      ),
    );

    expect(extractMarkdownFromYjsUpdate(update)).toBe('First\n\nSecond');
  });

  describe('purity', () => {
    it('does not mutate the input update Buffer', () => {
      const update = buildUpdate(
        topLevel(blockContainer(textElement('paragraph', 'Immutable check'))),
      );
      const snapshot = Buffer.from(update);

      extractMarkdownFromYjsUpdate(update);

      expect(Buffer.compare(update, snapshot)).toBe(0);
    });
  });
});
