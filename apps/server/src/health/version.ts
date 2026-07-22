import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The server's own `package.json` `version` field, read once at module load
 * (build-time-ish: this module only ever gets imported once per process,
 * and the value never changes for the lifetime of that process).
 *
 * Read via `fs.readFileSync` + `fileURLToPath`, NOT an `import ... with {
 * type: 'json' }` import-attribute JSON import — per the approved plan
 * (`giggly-brewing-moore.md`, PR-C), the import-attribute form is not
 * reliably supported across this repo's `tsc` (type-checking) AND
 * `unplugin-swc` (the actual test/dev transform, per `vitest.config.ts`)
 * pairing, so a plain file read avoids depending on either toolchain's JSON
 * import support.
 *
 * `new URL('../../package.json', import.meta.url)` resolves relative to this
 * file's own location (`src/health/version.ts`), two directories up to
 * `apps/server/package.json` — NOT the built output's location, since this
 * file's compiled counterpart (`dist/health/version.js`) sits at the same
 * relative depth under `apps/server/dist/`, so the same `../../` climbs back
 * out to `apps/server/package.json` either way.
 */
const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const packageJsonContents = readFileSync(packageJsonPath, 'utf-8');

interface PackageJsonShape {
  version?: unknown;
}

function readVersion(): string {
  const parsed: unknown = JSON.parse(packageJsonContents);
  const version = (parsed as PackageJsonShape).version;

  if (typeof version !== 'string' || version.length === 0) {
    // Misconfigured package.json (missing/empty "version") is a boot-time
    // concern, same fail-fast philosophy as `config/env.ts`'s missing
    // DATABASE_URL/REDIS_URL checks -- not a request-lifecycle AppError.
    process.stderr.write('FATAL: apps/server/package.json is missing a valid "version" field.\n');
    process.exit(1);
  }

  return version;
}

export const SERVER_VERSION: string = readVersion();
