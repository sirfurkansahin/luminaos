import { enforceScope } from './lib/scope-check.mjs';

await enforceScope({
  isAllowed: (rel) => /\.(test|spec)\.[jt]sx?$/.test(rel),
  denyMessage: (rel) =>
    `Bu subagent yalnizca test dosyalarina (*.test.ts / *.spec.ts) yazabilir; reddedilen yol: ${rel}`,
});
