import { enforceScope } from './lib/scope-check.mjs';

const DENIED_EXACT = new Set(['package.json', 'pnpm-workspace.yaml', 'turbo.json', 'pnpm-lock.yaml']);
const DENIED_PREFIXES = ['.github/', 'tooling/', '.claude/', 'docs/specs/'];

await enforceScope({
  isAllowed: (rel) => !DENIED_EXACT.has(rel) && !DENIED_PREFIXES.some((prefix) => rel.startsWith(prefix)),
  denyMessage: (rel) =>
    `implementer paylasilan altyapiya veya spec dosyalarina dokunamaz; reddedilen yol: ${rel}`,
});
