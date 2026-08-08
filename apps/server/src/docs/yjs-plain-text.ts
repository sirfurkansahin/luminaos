import * as Y from 'yjs';

/**
 * The `Y.XmlFragment` key BlockNote's collaborative editor reads/writes its
 * document content under. MUST match `apps/web/src/views/doc/DocEditor.tsx`'s
 * own `FRAGMENT_KEY` constant exactly -- a mismatch here silently decodes an
 * empty fragment (no error), permanently hiding all doc content from search.
 * If that file's constant ever changes, this one must change with it.
 */
const FRAGMENT_KEY = 'document-store';

/**
 * Collects the plain text of every `Y.XmlText` leaf under `root`, descending
 * into nested `Y.XmlElement`/`Y.XmlFragment` children at any depth (BlockNote
 * represents toggle-heading/nested-list child blocks as nested `Y.XmlElement`s
 * inside their parent's own child array, so a single-level walk would
 * silently drop collapsed/nested content from the search index).
 *
 * Iterative (explicit stack), not recursive: this walks a document's OWN
 * collaboratively-edited content, reachable by any ordinary editor of that
 * doc (not just a direct event-store bypass) via sustained/scripted nesting
 * of toggle-headings, and this projection's checkpoint is shared/global
 * across every workspace (`ProjectionRunner.catchUp`) — an unbounded
 * recursive walk hitting a stack-overflow on one adversarial document would
 * permanently stall search indexing everywhere, not just for that document.
 * A stack-based walk removes that failure class entirely (bounded only by
 * heap, not call-stack depth). Children are pushed in reverse order so the
 * stack (LIFO) still pops/visits them in original document order.
 */
function collectText(root: Y.XmlFragment, out: string[]): void {
  const stack: (Y.XmlFragment | Y.XmlElement | Y.XmlText)[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();

    if (node instanceof Y.XmlText) {
      out.push(String(node.toString()));
      continue;
    }

    if (node === undefined) {
      continue;
    }

    const children = node.toArray();
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      // `Y.XmlHook` (an opaque embed placeholder) carries no text of its
      // own and isn't a container to descend into — silently skipped, same
      // as the original recursive walk's `else if` did.
      if (
        child instanceof Y.XmlText ||
        child instanceof Y.XmlElement ||
        child instanceof Y.XmlFragment
      ) {
        stack.push(child);
      }
    }
  }
}

/**
 * Decodes a Yjs full-state update (as produced by `Y.encodeStateAsUpdate`,
 * e.g. `doc-collab.gateway.ts`'s own snapshot encode side) and extracts the
 * flat plain-text content of BlockNote's `'document-store'` `Y.XmlFragment`,
 * descending into nested elements at any depth.
 */
export function extractPlainTextFromYjsUpdate(update: Buffer): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);

  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  const out: string[] = [];
  collectText(fragment, out);

  // Joined with a space, not concatenated bare: two sibling/nested text
  // nodes can each end/start mid-word with no whitespace of their own (e.g.
  // a heading's own text immediately followed by a nested child block's
  // text) -- joining with '' would fuse them into a single bogus lexeme for
  // `to_tsvector`, silently breaking word-boundary search for both halves.
  return out.join(' ');
}
