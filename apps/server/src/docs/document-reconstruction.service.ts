import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { documentSnapshots } from '../db/schema/document-snapshots.js';

import type { Database } from '../db/client.js';

/**
 * Read path for a `doc` object's persisted content (ADR-0011 §(f)): fetches
 * the latest snapshot row for a doc by `object_id` + `MAX(version)`. The
 * reconstruction rule is simply "apply only the most recent snapshot"
 * (ADR-0011 §(c): full state, no diff chain), so a single top-1 query is all
 * the read side needs — it never touches `objects_view`'s list queries.
 */
@Injectable()
export class DocumentReconstructionService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Returns the highest-`version` snapshot for `objectId` with its bytes
   * decoded back to a `Buffer` (byte-equal to the original Yjs update), or
   * `null` if the doc has no snapshot yet.
   */
  async getLatestSnapshot(objectId: string): Promise<{ version: number; snapshot: Buffer } | null> {
    const [row] = await this.db
      .select({ version: documentSnapshots.version, snapshot: documentSnapshots.snapshot })
      .from(documentSnapshots)
      .where(eq(documentSnapshots.objectId, objectId))
      .orderBy(desc(documentSnapshots.version))
      .limit(1);

    if (!row) {
      return null;
    }

    return { version: row.version, snapshot: row.snapshot };
  }
}
