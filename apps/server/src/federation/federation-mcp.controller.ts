import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Controller, ForbiddenException, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { NotFoundError } from '@luminaos/shared';

import { FederationAuditService } from './federation-audit.service.js';
import { FederationRateLimitService } from './federation-rate-limit.service.js';
import { FederationScopeService } from './federation-scope.service.js';
import { FederationTokenAuthGuard } from './federation-token-auth.guard.js';
import { filterFederatedContextGraph } from './filter-federated-context-graph.js';
import { ContextService } from '../context/context.service.js';

import type { Request, Response } from 'express';

/**
 * F3-T14 PR2 (ADR-0048 §g/§h): `POST /federation-mcp`, `POST /mcp`'den
 * (ADR-0028) AYRI bir controller/guard/tool kaydı -- mevcut `McpController`'a
 * ikinci bir guard tipi EKLENMEZ. Tek tool: `get_federated_context(objectId)`.
 */
@Controller('federation-mcp')
@UseGuards(FederationTokenAuthGuard)
export class FederationMcpController {
  private readonly logger = new Logger(FederationMcpController.name);

  constructor(
    private readonly contextService: ContextService,
    private readonly scopeService: FederationScopeService,
    private readonly auditService: FederationAuditService,
    private readonly rateLimit: FederationRateLimitService,
  ) {}

  @Post()
  async handleFederationMcp(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { linkId, credentialId, granteeWorkspaceId, hostWorkspaceId } =
      this.requireFederationGrant(req);

    await this.rateLimit.assertNotRateLimited(hostWorkspaceId, credentialId, 1);

    const server = new McpServer({ name: 'luminaos-federation', version: '1.0.0' });
    server.registerTool(
      'get_federated_context',
      {
        description:
          'Federasyon kapsamına eklenmiş bir nesnenin filtrelenmiş bağlam grafiğini getirir.',
        inputSchema: { objectId: z.string() },
      },
      async ({ objectId }) => {
        // 1) Fail-closed kapsam kontrolü -- ContextService HİÇ ÇAĞRILMADAN.
        const inScope = await this.scopeService.isActiveScopeObject(
          linkId,
          hostWorkspaceId,
          objectId,
        );
        if (!inScope) {
          throw new NotFoundError('Object not in federation scope');
        }

        // 2) Fail-closed host-taraf audit -- BAŞARISIZ olursa okuma HİÇ olmaz.
        await this.auditService.recordAccessedFailClosed({
          linkId,
          hostWorkspaceId,
          credentialId,
          granteeWorkspaceId,
          objectId,
        });

        // 3) Sentetik 'owner' rolü -- İnsan kararı 2: kapsam içinde redaksiyon YOK.
        const raw = await this.contextService.getContext(hostWorkspaceId, objectId, 'owner');
        const filtered = filterFederatedContextGraph(
          raw,
          await this.scopeService.listActiveObjectIds(linkId, hostWorkspaceId),
        );

        // 4) Best-effort grantee-taraf audit -- BAŞARISIZ olsa bile yanıt döner.
        // Servisin kendi iç try/catch'i normalde bunu zaten yutuyor, ama bu
        // çağrı noktası da aynı "ikincil kayıt asla yanıtı etkilemez"
        // sözleşmesini savunma-katmanı olarak tekrarlar (ADR-0048 Karar h) --
        // ör. bir mock/beklenmedik hata servisin kendi swallow'unu atlarsa.
        try {
          await this.auditService.recordRequestedBestEffort({
            linkId,
            granteeWorkspaceId,
            hostWorkspaceId,
            credentialId,
            objectId,
          });
        } catch (error) {
          this.logger.error(
            `Grantee-side federation audit write failed for link "${linkId}"; the read itself already succeeded and is unaffected.`,
            error instanceof Error ? error.stack : String(error),
          );
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(filtered) }] };
      },
    );

    // @ts-expect-error upstream @modelcontextprotocol/sdk <-> exactOptionalPropertyTypes
    // incompatibility, same documented class of issue as `McpController.handleMcp`.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // @ts-expect-error upstream @modelcontextprotocol/sdk <-> exactOptionalPropertyTypes
    // incompatibility, same documented class of issue as `McpController.handleMcp`.
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /**
   * `FederationTokenAuthGuard` always populates `req.federationGrant` before
   * `canActivate` returns `true` -- this only fails closed (403) if that
   * guard somehow didn't run, mirroring `McpController.requireMcpContext`'s
   * exact reasoning.
   */
  private requireFederationGrant(req: Request): {
    linkId: string;
    credentialId: string;
    granteeWorkspaceId: string;
    hostWorkspaceId: string;
  } {
    const grant = req.federationGrant;
    if (!grant) {
      throw new ForbiddenException();
    }

    return grant;
  }
}
