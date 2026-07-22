import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { AppController } from './app.controller.js';
import { HealthService as HealthServiceModuleExport } from './health/health.service.js';

/**
 * Contract note for `implementer` (F0-T8 PR-C, per the approved plan
 * `giggly-brewing-moore.md`): `AppController.getHealth()` becomes `async`
 * and delegates entirely to an injected `HealthService`
 * (`./health/health.service.js`, not yet written -- see
 * `./health/health.service.test.ts` for its full contract), injected the
 * same way every other controller in this codebase injects its service (a
 * plain class-token constructor param, e.g. `workspaces.controller.ts`'s
 * `WorkspacesService` -- NOT the bare string-token pattern
 * `db/database-connection.token.ts` uses, which only exists there for a
 * DB-module-specific circular-import reason that does not apply here).
 *
 * `AppController` itself must add no health-check logic of its own -- these
 * tests prove it is a thin pass-through: whatever `HealthService.check()`
 * resolves to (mocked here) is returned completely unchanged, `ok` or
 * `degraded` alike. This deliberately REPLACES the previous version of this
 * test file (which asserted the old, synchronous, static `{status: 'ok'}`
 * contract from `buildHealthCheckPayload()` -- removed per the plan, since
 * health-check logic now requires IO and can no longer live in
 * `packages/shared`).
 *
 * This file is expected to fail for the same reason
 * `./health/health.service.test.ts` does: `./health/health.service.ts` does
 * not exist yet ("Cannot find module"), not because of any assertion logic
 * here.
 *
 * LINT NOTE (mirrors `./health/health.service.test.ts`'s own note): the
 * local `HealthServiceMock`/cast below exist only so this file has a
 * concretely-typed DI token to hand `Test.createTestingModule` while
 * `HealthService`'s real class doesn't exist yet -- once it does, this cast
 * becomes unnecessary and the plain import can be used directly as the
 * `provide` token.
 */

interface HealthServiceMock {
  check: () => Promise<unknown>;
}

const HealthService = HealthServiceModuleExport as unknown as new () => HealthServiceMock;

describe('AppController', () => {
  it('GET /health awaits HealthService.check() and returns its payload unchanged (ok case)', async () => {
    const payload = {
      status: 'ok' as const,
      checks: { db: 'ok' as const, redis: 'ok' as const },
      version: '0.0.0-test',
    };
    const check = vi.fn().mockResolvedValue(payload);

    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: HealthService, useValue: { check } }],
    }).compile();

    const controller = moduleRef.get(AppController);
    // `Promise.resolve(...)` (rather than a bare `await`) deliberately:
    // `AppController.getHealth()` is still synchronous in today's
    // not-yet-updated `app.controller.ts` (this test's whole point is to
    // pin the contract for the *async* version implementer is about to
    // build), and a bare `await` on a call whose current return type is
    // non-Promise is a real lint error (`@typescript-eslint/
    // await-thenable`) against that still-synchronous signature.
    // `Promise.resolve` is always thenable regardless of the wrapped
    // value's type, so this line type-checks against BOTH the old sync
    // signature and the new async one implementer is about to add.
    const result: unknown = await Promise.resolve(controller.getHealth());

    expect(result).toEqual(payload);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('GET /health returns a degraded payload from HealthService.check() unchanged, still resolving (not throwing / not mapped to an HTTP error)', async () => {
    const payload = {
      status: 'degraded' as const,
      checks: { db: 'error' as const, redis: 'ok' as const },
      version: '0.0.0-test',
    };
    const check = vi.fn().mockResolvedValue(payload);

    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: HealthService, useValue: { check } }],
    }).compile();

    const controller = moduleRef.get(AppController);
    // `Promise.resolve(...)` (rather than a bare `await`) deliberately:
    // `AppController.getHealth()` is still synchronous in today's
    // not-yet-updated `app.controller.ts` (this test's whole point is to
    // pin the contract for the *async* version implementer is about to
    // build), and a bare `await` on a call whose current return type is
    // non-Promise is a real lint error (`@typescript-eslint/
    // await-thenable`) against that still-synchronous signature.
    // `Promise.resolve` is always thenable regardless of the wrapped
    // value's type, so this line type-checks against BOTH the old sync
    // signature and the new async one implementer is about to add.
    const result: unknown = await Promise.resolve(controller.getHealth());

    expect(result).toEqual(payload);
  });
});
