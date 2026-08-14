import * as Y from 'yjs';

/**
 * The `Y.XmlFragment` key BlockNote's collaborative editor reads/writes its
 * document content under. MUST match `apps/web/src/views/doc/DocEditor.tsx`'s
 * own `FRAGMENT_KEY` constant exactly -- a mismatch here silently decodes an
 * empty fragment (no error), permanently hiding all doc content from export.
 * If that file's constant ever changes, this one must change with it. Same
 * constant/value as `./yjs-plain-text.ts`'s own `FRAGMENT_KEY`.
 */
const FRAGMENT_KEY = 'document-store';

type ContainerNode = Y.XmlFragment | Y.XmlElement;

interface StackEntry {
  node: ContainerNode;
  depth: number;
}

/**
 * Applies inline marks to a single delta run's text, innermost to outermost:
 * `code` (backtick), then `bold` (double-asterisk), then `italic`
 * (single-asterisk), then `strike` (double-tilde). Unrecognized attribute
 * keys (e.g. `underline`) have no effect.
 */
function applyMarks(text: string, attributes: Record<string, unknown> | undefined): string {
  let result = text;
  if (!attributes) {
    return result;
  }
  if (attributes['code']) {
    result = `\`${result}\``;
  }
  if (attributes['bold']) {
    result = `**${result}**`;
  }
  if (attributes['italic']) {
    result = `*${result}*`;
  }
  if (attributes['strike']) {
    result = `~~${result}~~`;
  }
  return result;
}

/**
 * Renders the inline (Markdown-marked-up) text of a single content element
 * (e.g. `paragraph`/`heading`/...) by walking its direct `Y.XmlText`
 * children's deltas. Non-`Y.XmlText` children are ignored (shouldn't
 * normally occur for these block types).
 */
function renderInline(element: Y.XmlElement): string {
  let out = '';
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      const delta = child.toDelta() as { insert: string; attributes?: Record<string, unknown> }[];
      for (const op of delta) {
        out += applyMarks(op.insert, op.attributes);
      }
    }
  }
  return out;
}

/**
 * Renders a single content element's block-level Markdown syntax, dispatching
 * on `element.nodeName`. Unrecognized/forward-compatible tag names degrade to
 * plain inline text rather than throwing.
 */
function renderContent(element: Y.XmlElement, depth: number): string {
  const inlineText = renderInline(element);
  const indent = '  '.repeat(depth);

  switch (element.nodeName) {
    case 'paragraph':
      return inlineText;
    case 'heading': {
      const rawLevel = element.getAttribute('level');
      const level = typeof rawLevel === 'number' ? Math.min(6, Math.max(1, rawLevel)) : 1;
      return `${'#'.repeat(level)} ${inlineText}`;
    }
    case 'bulletListItem':
      return `${indent}- ${inlineText}`;
    case 'numberedListItem':
      return `${indent}1. ${inlineText}`;
    case 'checkListItem': {
      const checked = (element.getAttribute('checked') as unknown) === true;
      return `${indent}${checked ? '- [x] ' : '- [ ] '}${inlineText}`;
    }
    case 'toggleListItem':
      return `${indent}- ${inlineText}`;
    case 'quote':
      return `> ${inlineText}`;
    case 'codeBlock':
      return `\`\`\`\n${inlineText}\n\`\`\``;
    case 'divider':
      return '---';
    default:
      return inlineText;
  }
}

/**
 * Iteratively (explicit stack, NOT recursive) walks BlockNote's real Yjs tree
 * shape -- mirrors `yjs-plain-text.ts`'s exact DoS-safety rationale (an
 * unbounded recursive walk over a document's own, attacker-reachable-via-
 * sustained-nesting content could stack-overflow). The stack only ever holds
 * `blockGroup` or `blockContainer` entries besides the initial fragment
 * entry. Children are pushed in reverse order so the stack (LIFO) still
 * pops/visits them in original document order.
 */
function collectLines(fragment: Y.XmlFragment): string[] {
  const lines: string[] = [];
  const stack: StackEntry[] = [{ node: fragment, depth: 0 }];

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) {
      continue;
    }
    const { node, depth } = entry;

    const isBlockContainer = node instanceof Y.XmlElement && node.nodeName === 'blockContainer';

    if (!isBlockContainer) {
      // `node` is either the initial fragment or a `blockGroup` element --
      // both only ever directly contain `blockContainer`/`blockGroup`
      // children (the fragment's own single child is the top-level
      // `blockGroup` wrapper; every `blockGroup` after that contains only
      // `blockContainer`s per the schema's `blockGroupChild+`).
      const children = node.toArray();
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (
          child instanceof Y.XmlElement &&
          (child.nodeName === 'blockContainer' || child.nodeName === 'blockGroup')
        ) {
          stack.push({ node: child, depth });
        }
      }
      continue;
    }

    // node is a `blockContainer` (narrowed to `Y.XmlElement` by `isBlockContainer`).
    const children = node.toArray();
    const contentElement = children.find(
      (child): child is Y.XmlElement =>
        child instanceof Y.XmlElement && child.nodeName !== 'blockGroup',
    );
    const nestedGroup = children.find(
      (child): child is Y.XmlElement =>
        child instanceof Y.XmlElement && child.nodeName === 'blockGroup',
    );

    if (contentElement) {
      const rendered = renderContent(contentElement, depth);
      const inlineEmpty = renderInline(contentElement) === '';
      if (contentElement.nodeName === 'divider' || !inlineEmpty) {
        lines.push(rendered);
      }
    }

    if (nestedGroup) {
      stack.push({ node: nestedGroup, depth: depth + 1 });
    }
  }

  return lines;
}

/**
 * Decodes a Yjs full-state update (as produced by `Y.encodeStateAsUpdate`,
 * e.g. `doc-collab.gateway.ts`'s own snapshot encode side) and renders
 * BlockNote's `'document-store'` `Y.XmlFragment` tree back out to Markdown
 * syntax. Markdown sibling of `./yjs-plain-text.ts`'s
 * `extractPlainTextFromYjsUpdate` -- ADR-0016 §(d) (`docs/adr/
 * ADR-0016-veri-disa-aktarma-rbac-kapsam.md`) explicitly picks this
 * tree-walking approach over a `Block[]`/`blocksToMarkdown` pipeline that
 * does not actually exist in the installed BlockNote version.
 */
export function extractMarkdownFromYjsUpdate(update: Buffer): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);

  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  const lines = collectLines(fragment);

  return lines.join('\n\n');
}
