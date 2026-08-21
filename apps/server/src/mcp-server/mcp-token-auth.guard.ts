import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { UnauthorizedError } from '@luminaos/shared';

import { SessionService } from '../auth/session.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { mcpClientGrants } from '../db/schema/mcp-client-grants.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

import type { Database } from '../db/client.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * F2-T12 PR1 (ADR-0028 §i/§m): the INBOUND-only mirror of
 * `SessionAuthGuard`+`WorkspaceMembershipGuard` combined into a single
 * class -- neither existing guard applies here (no cookie, no `:workspaceId`
 * URL param). Resolves the caller's `(user, membership, mcpGrant)` entirely
 * from the Bearer token itself (ADR-0028 §d).
 */
@Injectable()
export class McpTokenAuthGuard implements CanActivate {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly sessionService: SessionService,
    private readonly membershipService: WorkspaceMembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;
    const token = this.extractBearerToken(authHeader);
    if (!token) throw new UnauthorizedError();

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [grant] = await this.db
      .select()
      .from(mcpClientGrants)
      .where(eq(mcpClientGrants.tokenHash, tokenHash))
      .limit(1);

    const now = new Date();
    if (
      !grant ||
      grant.revokedAt !== null ||
      (grant.expiresAt !== null && grant.expiresAt <= now)
    ) {
      throw new UnauthorizedError(); // "yok"/"iptal"/"süresi dolmuş" hep aynı 401
    }

    const user = await this.sessionService.findUserById(grant.userId);
    if (!user) throw new UnauthorizedError();

    // CANLI üyelik kontrolü -- token oluşturulduğu andaki değil (Karar i).
    // Üye değilse ForbiddenError (403) fırlatır, guard'ı burada durdurur.
    const { role } = await this.membershipService.assertMembership(user.id, grant.workspaceId);

    request.user = { id: user.id, email: user.email };
    request.membership = { workspaceId: grant.workspaceId, role };
    request.mcpGrant = { id: grant.id }; // rate-limit anahtarı için (Karar h)

    return true;
  }

  private extractBearerToken(header: string | undefined): string | undefined {
    if (!header || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : undefined;
  }
}
