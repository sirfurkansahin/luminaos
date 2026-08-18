import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';

import type { MemoryAccessPolicy } from '@luminaos/memory';
import { UnauthorizedError } from '@luminaos/shared';

import {
  memoryAccessPolicyAgentIdentifierSchema,
  type MemoryAccessPolicyAgentIdentifierInput,
} from './dto/memory-access-policy-agent-identifier.schema.js';
import { MemoryAccessPolicyService } from './memory-access-policies.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { Request } from 'express';

/**
 * F2-T8 (ADR-0024 §k): `workspaces/:workspaceId/memory/access-policies` —
 * all three routes are self-service by construction. `req.user.id` (the
 * SESSION user, set by `SessionAuthGuard`) is the ONLY source of user
 * identity; a `userId` key in the POST body, if present, is validated away
 * by `memoryAccessPolicyAgentIdentifierSchema` (not `.strict()`, so it's
 * silently stripped rather than rejected) and never consulted here —
 * mirrors `desktop-signal-consents.controller.ts`'s exact guard/pipe wiring.
 */
@Controller('workspaces/:workspaceId/memory/access-policies')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class MemoryAccessPolicyController {
  constructor(private readonly memoryAccessPolicyService: MemoryAccessPolicyService) {}

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ policies: MemoryAccessPolicy[] }> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const policies = await this.memoryAccessPolicyService.list(workspaceId, req.user.id);

    return { policies };
  }

  @Post()
  async grant(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(memoryAccessPolicyAgentIdentifierSchema))
    body: MemoryAccessPolicyAgentIdentifierInput,
    @Req() req: Request,
  ): Promise<{ policy: MemoryAccessPolicy }> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const policy = await this.memoryAccessPolicyService.grant(
      workspaceId,
      req.user.id,
      body.agentIdentifier,
    );

    return { policy };
  }

  @Delete(':agentIdentifier')
  async revoke(
    @Param('workspaceId') workspaceId: string,
    @Param('agentIdentifier') agentIdentifier: string,
    @Req() req: Request,
  ): Promise<{ policy: MemoryAccessPolicy }> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const policy = await this.memoryAccessPolicyService.revoke(
      workspaceId,
      req.user.id,
      agentIdentifier,
    );

    return { policy };
  }
}
