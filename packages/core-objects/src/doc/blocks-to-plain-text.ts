import type { Block } from './block.js';

function ownText(block: Block): string {
  return block.content.map((run) => run.text).join('');
}

function collect(blocks: readonly Block[], segments: string[]): void {
  for (const block of blocks) {
    const text = ownText(block);
    if (text !== '') {
      segments.push(text);
    }
    collect(block.children, segments);
  }
}

export function blocksToPlainText(blocks: Block[]): string {
  const segments: string[] = [];
  collect(blocks, segments);
  return segments.join('\n');
}
