import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { decryptSecret, encryptSecret, InvalidObjectStateError } from '@luminaos/shared';

import { env } from '../config/env.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { connectorCredentials } from '../db/schema/connector-credentials.js';

import type { Database } from '../db/client.js';

/**
 * F2-T9 PR2 (ADR-0025 §k): the combined credential-encryption + storage
 * service for MCP connectors -- generalizes
 * `CalendarTokenEncryptionService`+`CalendarAccountsService`'s shapes into a
 * single service, since (unlike calendar) nothing else in this task needs
 * the encryption logic split out on its own. Reuses `env.encryptionKey`
 * (same lazy-fatal `InvalidObjectStateError` pattern) -- no new env var.
 */
@Injectable()
export class ConnectorCredentialsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  private encrypt(plaintext: string): string {
    if (env.encryptionKey === undefined) {
      throw new InvalidObjectStateError(
        'ENCRYPTION_KEY is not configured; connector credential storage is unavailable',
      );
    }

    return encryptSecret(plaintext, env.encryptionKey);
  }

  private decrypt(ciphertext: string): string {
    if (env.encryptionKey === undefined) {
      throw new InvalidObjectStateError(
        'ENCRYPTION_KEY is not configured; connector credential storage is unavailable',
      );
    }

    return decryptSecret(ciphertext, env.encryptionKey);
  }

  /**
   * Upserts the credentials blob for this (workspaceId, userId,
   * connectorType) triple -- `connector_credentials`'s own unique index
   * (ADR-0025 §i) is the natural `ON CONFLICT` target.
   */
  async store(
    workspaceId: string,
    userId: string,
    connectorType: string,
    credentials: Record<string, unknown>,
  ): Promise<{ id: string; connectorType: string }> {
    const encryptedCredentials = this.encrypt(JSON.stringify(credentials));

    const [row] = await this.db
      .insert(connectorCredentials)
      .values({
        workspaceId,
        userId,
        connectorType,
        encryptedCredentials,
      })
      .onConflictDoUpdate({
        target: [
          connectorCredentials.workspaceId,
          connectorCredentials.userId,
          connectorCredentials.connectorType,
        ],
        set: {
          encryptedCredentials,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: connectorCredentials.id,
        connectorType: connectorCredentials.connectorType,
      });

    if (!row) {
      throw new InvalidObjectStateError(
        `Failed to store connector credentials for connectorType "${connectorType}": upsert returned no row.`,
      );
    }

    return row;
  }

  /**
   * Never returns the encrypted/ciphertext form -- only the decrypted plain
   * credentials object, or `undefined` if nothing is stored for this triple
   * (ADR-0025 §k).
   */
  async retrieve(
    workspaceId: string,
    userId: string,
    connectorType: string,
  ): Promise<Record<string, unknown> | undefined> {
    const [row] = await this.db
      .select({ encryptedCredentials: connectorCredentials.encryptedCredentials })
      .from(connectorCredentials)
      .where(
        and(
          eq(connectorCredentials.workspaceId, workspaceId),
          eq(connectorCredentials.userId, userId),
          eq(connectorCredentials.connectorType, connectorType),
        ),
      );

    if (!row) {
      return undefined;
    }

    const decrypted = this.decrypt(row.encryptedCredentials);
    return JSON.parse(decrypted) as Record<string, unknown>;
  }

  /** Idempotent -- a no-op (does not throw) if nothing matched. */
  async remove(workspaceId: string, userId: string, connectorType: string): Promise<void> {
    await this.db
      .delete(connectorCredentials)
      .where(
        and(
          eq(connectorCredentials.workspaceId, workspaceId),
          eq(connectorCredentials.userId, userId),
          eq(connectorCredentials.connectorType, connectorType),
        ),
      );
  }
}
