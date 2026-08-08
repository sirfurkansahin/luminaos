import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { extractPlainTextFromYjsUpdate } from './yjs-plain-text.js';

/**
 * F1-T13 PR3b (RED step) -- ADR-0013 SS(d) follow-up. Unit tests (no DB, no
 * testcontainers) for `extractPlainTextFromYjsUpdate(update: Buffer): string`,
 * the pure function that decodes a Yjs full-state update, reads BlockNote's
 * collaborative content out of the `'document-store'` `Y.XmlFragment` (the
 * EXACT key confirmed in `apps/web/src/views/doc/DocEditor.tsx` line 23 --
 * getting this key wrong silently reads an empty fragment, no error), and
 * recursively walks it to a flat plain-text string.
 *
 * CRITICAL requirement (explicit user request): BlockNote's toggleable/
 * collapsible headings (and nested list items) store their children as
 * NESTED `Y.XmlElement` nodes inside the parent element's own child array.
 * The traversal MUST descend into every level of nesting -- otherwise
 * folded/collapsed content becomes permanently unsearchable. Several tests
 * below pin this behavior directly with hand-built multi-level trees.
 *
 * `../docs/yjs-plain-text.ts` does not exist yet, so every test in this file
 * fails at IMPORT time (module not found) -- the correct RED state. Once
 * implemented, `extractPlainTextFromYjsUpdate` must: `new Y.Doc()`,
 * `Y.applyUpdate(doc, update)`, `doc.getXmlFragment('document-store')`, then
 * recursively walk `.toArray()` children -- collecting `.toString()` from
 * every `Y.XmlText` leaf at ANY depth, recursing into any child that is
 * itself a `Y.XmlElement`/`Y.XmlFragment`.
 */

const FRAGMENT_KEY = 'document-store';

/** Builds a `Y.Doc`, lets `populate` mutate its `'document-store'` fragment, and returns the resulting full-state update bytes (mirrors `doc-collab.gateway.ts`'s own `Y.encodeStateAsUpdate(room.doc)` encode side). */
function buildUpdate(populate: (fragment: Y.XmlFragment) => void): Buffer {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  populate(fragment);
  const update = Y.encodeStateAsUpdate(doc);
  return Buffer.from(update);
}

describe('extractPlainTextFromYjsUpdate', () => {
  it('returns "" for a freshly created Y.Doc with an empty fragment', () => {
    const update = buildUpdate(() => {
      // no-op: nothing inserted, fragment stays empty.
    });

    expect(extractPlainTextFromYjsUpdate(update)).toBe('');
  });

  it('does not throw on an update that decodes to an empty/valid-but-content-free Y.Doc', () => {
    const doc = new Y.Doc();
    // Touch the fragment (creates it) without inserting any content.
    doc.getXmlFragment(FRAGMENT_KEY);
    const update = Buffer.from(Y.encodeStateAsUpdate(doc));

    expect(() => extractPlainTextFromYjsUpdate(update)).not.toThrow();
    expect(extractPlainTextFromYjsUpdate(update)).toBe('');
  });

  it('extracts a single flat Y.XmlText directly under the fragment', () => {
    const update = buildUpdate((fragment) => {
      fragment.insert(0, [new Y.XmlText('hello world')]);
    });

    expect(extractPlainTextFromYjsUpdate(update)).toContain('hello world');
  });

  it('extracts text from multiple top-level elements/text nodes, in document order', () => {
    const update = buildUpdate((fragment) => {
      const firstParagraph = new Y.XmlElement('paragraph');
      firstParagraph.insert(0, [new Y.XmlText('first paragraph')]);

      const secondParagraph = new Y.XmlElement('paragraph');
      secondParagraph.insert(0, [new Y.XmlText('second paragraph')]);

      fragment.insert(0, [firstParagraph, secondParagraph]);
    });

    const text = extractPlainTextFromYjsUpdate(update);
    expect(text).toContain('first paragraph');
    expect(text).toContain('second paragraph');
    expect(text.indexOf('first paragraph')).toBeLessThan(text.indexOf('second paragraph'));
  });

  it('descends into a nested Y.XmlElement (2 levels deep) -- toggle-heading child block content is included', () => {
    // Simulates a BlockNote toggle/collapsible heading: a top-level
    // `heading` element holding its own text, PLUS a nested `paragraph`
    // child element (the collapsed/toggled child block) with its OWN text.
    const update = buildUpdate((fragment) => {
      const nestedChild = new Y.XmlElement('paragraph');
      nestedChild.insert(0, [new Y.XmlText('nested toggle child text')]);

      const heading = new Y.XmlElement('heading');
      heading.insert(0, [new Y.XmlText('heading own text'), nestedChild]);

      fragment.insert(0, [heading]);
    });

    const text = extractPlainTextFromYjsUpdate(update);
    expect(text).toContain('heading own text');
    expect(text).toContain('nested toggle child text');
  });

  it('descends 3+ levels deep -- all text at every depth is included', () => {
    const update = buildUpdate((fragment) => {
      const level3 = new Y.XmlElement('paragraph');
      level3.insert(0, [new Y.XmlText('level three text')]);

      const level2 = new Y.XmlElement('paragraph');
      level2.insert(0, [new Y.XmlText('level two text'), level3]);

      const level1 = new Y.XmlElement('heading');
      level1.insert(0, [new Y.XmlText('level one text'), level2]);

      fragment.insert(0, [level1]);
    });

    const text = extractPlainTextFromYjsUpdate(update);
    expect(text).toContain('level one text');
    expect(text).toContain('level two text');
    expect(text).toContain('level three text');
  });
});
