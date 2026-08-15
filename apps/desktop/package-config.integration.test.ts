import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Regression tests for ADR-0019-desktop-app-iskeleti.md Karar (c) — package
 * naming/dirlayout must follow the `apps/web`/`apps/server` (F0-T1) template.
 * Pure Node `fs` + `JSON.parse`, no build/compile step required — safe to run
 * in this environment even without a working Rust/MSVC toolchain.
 *
 * `apps/desktop/package.json` and `apps/desktop/tsconfig.json` do not exist
 * yet — every test below is expected to fail RED (file-not-found) until
 * `implementer` creates them.
 */

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));

function readJson(fileName: string): unknown {
  return JSON.parse(readFileSync(path.join(desktopRoot, fileName), 'utf-8'));
}

describe('apps/desktop/package.json', () => {
  it('is named "@luminaos/desktop" — F0-T1 @luminaos/<paket> convention', () => {
    const pkg = readJson('package.json') as { name?: unknown };
    expect(pkg.name).toBe('@luminaos/desktop');
  });

  it('declares @luminaos/ui as a workspace:* runtime dependency (workspace-linking proof)', () => {
    const pkg = readJson('package.json') as { dependencies?: Record<string, unknown> };
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies?.['@luminaos/ui']).toBe('workspace:*');
  });

  it('declares dev/build/typecheck/test/lint scripts — apps/web script-pattern parity', () => {
    const pkg = readJson('package.json') as { scripts?: Record<string, unknown> };
    expect(pkg.scripts).toBeDefined();

    for (const scriptName of ['dev', 'build', 'typecheck', 'test', 'lint']) {
      expect(pkg.scripts).toHaveProperty(scriptName);
      expect(typeof pkg.scripts?.[scriptName]).toBe('string');
      expect((pkg.scripts?.[scriptName] as string).length).toBeGreaterThan(0);
    }
  });
});

describe('apps/desktop/tsconfig.json', () => {
  it('is valid JSON and extends the shared react tsconfig, apps/web pattern', () => {
    const tsconfig = readJson('tsconfig.json') as { extends?: unknown };
    expect(tsconfig.extends).toBe('../../tooling/tsconfig/react.json');
  });
});
