import { enforceScope } from './lib/scope-check.mjs';

await enforceScope({
  isAllowed: (rel) => rel.startsWith('docs/'),
  denyMessage: (rel) =>
    `Bu subagent yalnizca docs/ altina yazabilir; reddedilen yol: ${rel}`,
});
