import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';

import type { Role } from '@luminaos/core-objects';
import { ForbiddenError } from '@luminaos/shared';

import { exportQuerySchema } from './dto/export-query.schema.js';
import { ExportService } from './export.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { ExportQuery } from './dto/export-query.schema.js';
import type { WorkspaceJsonExport } from './export.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `GET /workspaces/:workspaceId/export` (F1-T18 PR1). This class
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

  @Get()
  async export(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query(new ZodValidationPipe(exportQuerySchema)) query: ExportQuery,
    @Req() req: Request,
  ): Promise<WorkspaceJsonExport> {
    const callerRole = this.requireRole(req);
    return this.exportService.exportJson(workspaceId, callerRole, query.objectId);
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
