import assert from 'node:assert/strict';
import fs from 'node:fs';

// Run from /app in the production image, with network access disabled.
await import('./dist/db/migrate.js');
const argon = await import('argon2');
const hash = await argon.hash('container-smoke-test');
assert(await argon.verify(hash, 'container-smoke-test'));
assert(fs.existsSync('dist/db/migrations/meta/_journal.json'));
assert(process.getuid() !== 0);
console.log('PASS: migration module, SQL journal, argon2 and non-root runtime');
