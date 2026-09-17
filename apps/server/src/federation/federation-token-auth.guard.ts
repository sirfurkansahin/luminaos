import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { UnauthorizedError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { federationLinkCredentials } from '../db/schema/federation-link-credentials.js';
import { federationLinks } from '../db/schema/federation-links.js';

import type { Database } from '../db/client.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * F3-T14 PR2 (ADR-0048 §f): `McpTokenAuthGuard`'ın PARALEL bir kopyası,
 * GENİŞLETMESİ DEĞİL. Karşı tarafta bir insan/kullanıcı satırı yok -- karşı
 * workspace'in KENDİSİ çağırıyor, bu yüzden `request.user`/`request.membership`
 * yerine `request.federationGrant` doldurulur.
 */
@Injectable()
export class FederationTokenAuthGuard implements CanActivate {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedError();

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [credential] = await this.db
      .select()
      .from(federationLinkCredentials)
      .where(eq(federationLinkCredentials.tokenHash, tokenHash))
      .limit(1);

    const now = new Date();
    if (
      !credential ||
      credential.revokedAt !== null ||
      (credential.expiresAt !== null && credential.expiresAt <= now)
    ) {
      throw new UnauthorizedError(); // ADR-0028 §i'nin AYNI 401-collapse disiplini
    }

    const [link] = await this.db
      .select()
      .from(federationLinks)
      .where(eq(federationLinks.id, credential.federationLinkId))
      .limit(1);

    // CANLI durum kontrolü -- token oluşturulduğu andaki DEĞİL. `pending`
    // veya `revoked` bir link için de AYNI 401 (link durumu dışarı sızmaz).
    if (!link || link.status !== 'active') {
      throw new UnauthorizedError();
    }

    const hostWorkspaceId =
      link.initiatorWorkspaceId === credential.granteeWorkspaceId
        ? link.counterpartWorkspaceId
        : link.initiatorWorkspaceId;

    request.federationGrant = {
      linkId: link.id,
      credentialId: credential.id,
      granteeWorkspaceId: credential.granteeWorkspaceId,
      hostWorkspaceId,
    };

    return true;
  }

  private extractBearerToken(header: string | undefined): string | undefined {
    if (!header || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : undefined;
  }
}
