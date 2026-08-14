import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res, UseGuards } from '@nestjs/common';

import type { Role } from '@luminaos/core-objects';
import { ForbiddenError, ValidationError } from '@luminaos/shared';

import { exportQuerySchema } from './dto/export-query.schema.js';
import { ExportService } from './export.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { ExportQuery } from './dto/export-query.schema.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request, Response } from 'express';

/**
 * `GET /workspaces/:workspaceId/export` (F1-T18 PR1/PR2). This class
 * deliberately carries NO role-escalation check beyond the guard stack
 * below (`SessionAuthGuard` + `WorkspaceMembershipGuard`, the SAME stack as
 * every other read endpoint, e.g. `ObjectsController`) — this IS the
 * concrete proof of ADR-0016 §(a)'s central RBAC decision: export is a
 * READ of data the caller already has access to, so plain workspace
 * membership is the sole and sufficient gate. Unlike `FieldsController`'s
 * `requireAdmin` (an admin-gated schema-MUTATION check), do not add an
 * analogous check here, and future export/read endpoints must follow this
 * same pattern — role-gates are for administrative mutations, never for
 * reads.
 */
@Controller('workspaces/:workspaceId/export')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  /**
   * `format=json`, `format=markdown`, and `format=ical` (F1-T18 PR3,
   * ADR-0016 §e) have DIFFERENT response content-types (a JSON body vs. raw
   * `text/markdown`/`text/calendar` bodies), so every branch uses
   * `@Res() res: Response` WITHOUT `passthrough` and calls
   * `res.status(...).json(...)`/`res.status(...).type(...).send(...)`
   * explicitly, rather than mixing `{ passthrough: true }` manual sends
   * with plain `return`s (a known footgun -- double-send / "headers already
   * sent" errors). Throwing inside this handler still correctly reaches the
   * app's global exception filter even with a manual `@Res()` (Nest's
   * exception pipeline wraps the whole request, not just return-value
   * serialization) -- proven empirically by this endpoint's own 400/404/
   * 401/403 integration tests all passing.
   */
  @Get()
  async export(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query(new ZodValidationPipe(exportQuerySchema)) query: ExportQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const callerRole = this.requireRole(req);

    if (query.format === 'markdown') {
      if (query.objectId === undefined) {
        // Unreachable in practice (the zod schema's `.refine()` already
        // rejects this), but narrows the type without a non-null assertion.
        throw new ValidationError('objectId is required when format is "markdown"');
      }
      const markdown = await this.exportService.exportMarkdown(
        workspaceId,
        query.objectId,
        callerRole,
      );
      res.status(200).type('text/markdown; charset=utf-8').send(markdown);
      return;
    }

    if (query.format === 'ical') {
      const ical = await this.exportService.exportIcal(workspaceId, callerRole, query.objectId);
      res.status(200).type('text/calendar; charset=utf-8').send(ical);
      return;
    }

    const result = await this.exportService.exportJson(workspaceId, callerRole, query.objectId);
    res.status(200).json(result);
  }

  /**
   * Returns the caller's membership role, needed for
   * `ExportService.exportJson`'s role-based `fieldValues`/field-definition
   * filtering. Mirrors `ObjectsController.requireRole`'s exact reasoning
   * and cast (`MembershipRole`/`Role` are structurally identical 4-value
   * string unions). Fails closed (403) if `WorkspaceMembershipGuard`
   * somehow didn't run.
   */
  private requireRole(req: Request): Role {
    const role = req.membership?.role as MembershipRole | undefined;
    if (!role) {
      throw new ForbiddenError();
    }
    return role;
  }
}
