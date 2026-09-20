import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import { AppError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { dataRightsRequests, type DataRightsRequest } from '../db/schema/data-rights-requests.js';

import type { Database } from '../db/client.js';

class UnexpectedDataRightsResultError extends AppError {
  constructor() {
    super('Veri hakkı talebi kaydedilemedi.', 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

@Injectable()
export class DataRightsRequestsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async getLatestForUser(userId: string): Promise<DataRightsRequest | null> {
    const [request] = await this.db
      .select()
      .from(dataRightsRequests)
      .where(eq(dataRightsRequests.userId, userId))
      .orderBy(desc(dataRightsRequests.requestedAt))
      .limit(1);

    return request ?? null;
  }

  async createDeletionRequest(userId: string): Promise<DataRightsRequest> {
    const [existing] = await this.db
      .select()
      .from(dataRightsRequests)
      .where(and(eq(dataRightsRequests.userId, userId), eq(dataRightsRequests.status, 'pending')))
      .limit(1);

    if (existing) return existing;

    const [created] = await this.db
      .insert(dataRightsRequests)
      .values({ userId, type: 'deletion' })
      .onConflictDoNothing()
      .returning();

    if (created) return created;

    // A simultaneous request may have won the partial-unique-index race.
    const [concurrent] = await this.db
      .select()
      .from(dataRightsRequests)
      .where(and(eq(dataRightsRequests.userId, userId), eq(dataRightsRequests.status, 'pending')))
      .limit(1);

    if (!concurrent) throw new UnexpectedDataRightsResultError();
    return concurrent;
  }
}
