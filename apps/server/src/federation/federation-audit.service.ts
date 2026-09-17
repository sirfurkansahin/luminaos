import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { NotFoundError } from '@luminaos/shared';
import type { NewDomainEvent } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { federationLinks } from '../db/schema/federation-links.js';
import { EventStoreService } from '../event-store/event-store.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';

const FEDERATION_AUDIT_STREAM_TYPE = 'federation-audit';

interface RecordAccessedParams {
  linkId: string;
  hostWorkspaceId: string;
  credentialId: string;
  granteeWorkspaceId: string;
  objectId: string;
}

interface RecordRequestedParams {
  linkId: string;
  granteeWorkspaceId: string;
  hostWorkspaceId: string;
  credentialId: string;
  objectId: string;
}

/**
 * F3-T14 PR2 (ADR-0048 §h): çift-taraflı federasyon denetim günlüğü. Her
 * workspace KENDİ audit stream'ine yazar
 * (`federationLinks.initiatorAuditStreamId`/`counterpartAuditStreamId`) --
 * `linkId` ASLA bir tarafın `streamId`'si olarak paylaşılmaz (Bağlam madde
 * 5'in cross-workspace `events_stream_id_version_key` çakışma bulgusu).
 *
 * `recordAccessedFailClosed` (HOST tarafı) hatayı PROPAGATE eder -- çağıran
 * (`FederationMcpController`) bunu yakalayıp okumayı tamamen durdurmalı.
 * `recordRequestedBestEffort` (GRANTEE tarafı) hatayı YUTAR, yalnızca
 * loglar -- ikincil kayıt, isteğin başarısını asla etkilemez.
 */
@Injectable()
export class FederationAuditService {
  private readonly logger = new Logger(FederationAuditService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
  ) {}

  async recordAccessedFailClosed(params: RecordAccessedParams): Promise<void> {
    const streamId = await this.resolveAuditStreamId(params.linkId, params.hostWorkspaceId);

    await this.append(streamId, params.hostWorkspaceId, 'FederatedContextAccessed', {
      linkId: params.linkId,
      credentialId: params.credentialId,
      granteeWorkspaceId: params.granteeWorkspaceId,
      objectId: params.objectId,
      occurredAt: new Date().toISOString(),
    });
  }

  async recordRequestedBestEffort(params: RecordRequestedParams): Promise<void> {
    try {
      const streamId = await this.resolveAuditStreamId(params.linkId, params.granteeWorkspaceId);

      await this.append(streamId, params.granteeWorkspaceId, 'FederatedContextRequested', {
        linkId: params.linkId,
        credentialId: params.credentialId,
        hostWorkspaceId: params.hostWorkspaceId,
        objectId: params.objectId,
        occurredAt: new Date().toISOString(),
      });
    } catch (error) {
      // Best-effort (ADR-0048 §h): yalnızca sunucu loguna düşer, istek yine
      // de başarılı döner -- güvenlik-kritik kayıt (host tarafı) zaten bu
      // çağrıdan ÖNCE garanti altına alındı. Loglanan alanlar yalnızca
      // uuid'ler (linkId/credentialId/objectId) -- kullanıcı verisi/API
      // anahtarı YOK (redact.ts disiplini, Bağlam madde 12).
      this.logger.error(
        `Grantee-side federation audit write failed for link "${params.linkId}"; the read itself already succeeded and is unaffected.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * F3-T14 PR2 (REST surface, ADR-0016 §a): the caller-workspace's own
   * federation audit trail for one link -- `member+` gated by the
   * controller's `WorkspaceMembershipGuard`, no further role check needed
   * (read paths are never role-gated beyond membership).
   */
  async readOwnAuditLog(linkId: string, workspaceId: string): Promise<StoredEvent[]> {
    const streamId = await this.resolveAuditStreamId(linkId, workspaceId);
    return this.eventStore.readStream(streamId);
  }

  private async resolveAuditStreamId(linkId: string, sideWorkspaceId: string): Promise<string> {
    const [link] = await this.db
      .select()
      .from(federationLinks)
      .where(eq(federationLinks.id, linkId))
      .limit(1);

    if (!link) {
      throw new NotFoundError('Federation link not found.');
    }

    if (
      sideWorkspaceId !== link.initiatorWorkspaceId &&
      sideWorkspaceId !== link.counterpartWorkspaceId
    ) {
      // `sideWorkspaceId` isn't actually one of this link's two ends --
      // never silently default to a side, that would leak the WRONG
      // workspace's audit stream to an unrelated caller.
      throw new NotFoundError('Federation link not found.');
    }

    return sideWorkspaceId === link.initiatorWorkspaceId
      ? link.initiatorAuditStreamId
      : link.counterpartAuditStreamId;
  }

  private async append(
    streamId: string,
    workspaceId: string,
    type: 'FederatedContextAccessed' | 'FederatedContextRequested',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: FEDERATION_AUDIT_STREAM_TYPE,
      workspaceId,
      type,
      payload,
      actor: { type: 'system', id: 'federation-audit-service' },
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
  }
}
