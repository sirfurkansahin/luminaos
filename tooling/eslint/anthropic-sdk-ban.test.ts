import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * F1-T5 PR-A, red step — repo-wide ESLint ban on importing `@anthropic-ai/sdk`
 * outside `packages/ai-gateway`.
 *
 * INVESTIGATION NOTE (documenting the "where should this test live" choice
 * per the test-writer brief): `tooling/eslint/` currently has NO
 * `package.json`, no `vitest.config.ts`, and is not listed as a target with
 * its own `test` script anywhere — it's consumed only as plain `.js` source
 * files, imported by relative path from each consuming package's own
 * `eslint.config.js` (see `packages/core-objects/eslint.config.js`,
 * `apps/server/eslint.config.js`, etc.). `turbo run test` only runs a
 * package's `test` script, so as things stand THIS FILE WILL NOT BE PICKED
 * UP by `pnpm test`/`pnpm test:changed` until `implementer` adds a
 * `tooling/eslint/package.json` (with a `test` script, e.g. `vitest run`)
 * and a minimal `vitest.config.ts` there (`vitest`/`eslint` are already
 * resolvable from here via Node's upward `node_modules` resolution to the
 * repo root, since both are root `devDependencies` — the same mechanism
 * every package's own `eslint.config.js` already relies on to import
 * `@eslint/js`, `eslint-config-prettier`, etc. without listing them as its
 * own package dependencies). This is a normal implementation-file change
 * (`package.json`/config, not a test file), so it is intentionally left for
 * `implementer` rather than done here — a test-writer subagent may only
 * write/edit `*.test.ts`/`*.spec.ts` files.
 *
 * This test uses ESLint's Node API (flat config) directly, pointing separate
 * `ESLint` instances at each target package's OWN `eslint.config.js` (the
 * same file `pnpm --filter <pkg> lint` uses). It lints a REAL, uniquely-named
 * temporary fixture file written under the target package's `src/` (cleaned
 * up in a `finally` block) rather than an in-memory-only `lintText` virtual
 * path: `base.js`'s TS-file block uses `parserOptions.projectService`
 * (typescript-eslint's typed-linting project service), which requires the
 * linted file to actually exist on disk and be covered by that package's
 * `tsconfig.json` `include` — a purely virtual `lintText` path fails with a
 * FATAL parse error ("was not found by the project service") before any
 * rule, including the new ban, ever runs. Confirmed by direct reproduction
 * during implementation.
 *
 * Per the technical note this test is designed to protect against: ESLint
 * flat config merges rules by full replacement per rule NAME across the
 * whole config array — if the Anthropic-SDK ban were implemented as another
 * `no-restricted-imports` block inside `baseConfig` itself, any package that
 * layers its OWN `no-restricted-imports` block AFTER `baseConfig(...)` (e.g.
 * `packages/core-objects/eslint.config.js`, which bans React/NestJS imports)
 * would SILENTLY lose the Anthropic ban entirely. The safe implementation
 * uses a rule name no package currently uses for anything else —
 * `no-restricted-syntax` (targeting `ImportDeclaration`/`ImportExpression`
 * nodes whose `source.value` is `'@anthropic-ai/sdk'`) — so it can never
 * collide with any package's own `no-restricted-imports` block. We assert on
 * `ruleId === 'no-restricted-syntax'` rather than a message string, since (a)
 * we don't control implementer's exact message wording, and (b) a repo-wide
 * search confirms `no-restricted-syntax` is not used anywhere else in this
 * repo today, so any occurrence of it firing here is unambiguously the new
 * ban rule.
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const ANTHROPIC_IMPORT_SNIPPET =
  'import Anthropic from "@anthropic-ai/sdk";\n\nexport const client = new Anthropic({ apiKey: "test-key" });\n';

async function lintAnthropicImportIn(packageRelativeDir: string): Promise<ESLint.LintResult[]> {
  const packageDir = path.join(repoRoot, ...packageRelativeDir.split('/'));
  const fixturePath = path.join(
    packageDir,
    'src',
    `__anthropic_sdk_ban_fixture_${randomUUID()}__.ts`,
  );

  await writeFile(fixturePath, ANTHROPIC_IMPORT_SNIPPET, 'utf-8');

  try {
    const eslint = new ESLint({
      cwd: packageDir,
      overrideConfigFile: path.join(packageDir, 'eslint.config.js'),
    });

    return await eslint.lintFiles([fixturePath]);
  } finally {
    await rm(fixturePath, { force: true });
  }
}

function banRuleMessages(results: ESLint.LintResult[]): ESLint.LintMessage[] {
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === 'no-restricted-syntax');
}

describe('repo-wide ESLint ban on importing @anthropic-ai/sdk outside packages/ai-gateway', () => {
  it('reports a no-restricted-syntax error for a package OUTSIDE packages/ai-gateway (apps/server) that imports @anthropic-ai/sdk directly', async () => {
    const results = await lintAnthropicImportIn('apps/server');
    const banMessages = banRuleMessages(results);

    expect(banMessages.length).toBeGreaterThan(0);
    const totalErrorCount = results.reduce((sum, result) => sum + result.errorCount, 0);
    expect(totalErrorCount).toBeGreaterThan(0);
  }, 30_000);

  it('does NOT report a no-restricted-syntax error inside packages/ai-gateway itself for the same import (it is the one package allowed to use the real SDK)', async () => {
    const results = await lintAnthropicImportIn('packages/ai-gateway');
    const banMessages = banRuleMessages(results);

    expect(banMessages).toHaveLength(0);
  }, 30_000);

  it('still bans the import inside packages/core-objects, whose OWN no-restricted-imports block would silently override a same-named rule (proving the ban survives that footgun)', async () => {
    const results = await lintAnthropicImportIn('packages/core-objects');
    const banMessages = banRuleMessages(results);

    expect(banMessages.length).toBeGreaterThan(0);
  }, 30_000);
});
