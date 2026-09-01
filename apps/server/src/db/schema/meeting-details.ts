import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * Per ADR-0030 §d ("[ARCHITECT KARARI] `meeting_details` tablosunun tam
 * şeması") — copied verbatim, adjusted only for real import paths.
 */
export const meetingProviderEnum = pgEnum('meeting_provider', [
  'google-meet',
  'zoom',
  'microsoft-teams',
]);

export const meetingStatusEnum = pgEnum('meeting_status', [
  'sunuldu',
  'beklemede',
  'kaydedildi',
  'basarisiz',
]);

export const meetingDetails = pgTable(
  'meeting_details',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // `meeting` LuminaObject'in ULID'i (packages/core-objects'in `newObjectId()`'i,
    // ADR-0030 Bağlam madde 1) -- objects_view bir projeksiyon olduğundan (FK'lanabilir
    // bir tablo değil), timeblock_external_pushes'ın object_id kolonu (ADR-0030 Bağlam
    // madde 2) gibi FK'siz düz bir varchar(26).
    objectId: varchar('object_id', { length: 26 }).notNull(),
    // ADR-0031 §c: denormalize edilmiş gerçek FK -- `objectId`'nin FK'siz
    // `objects_view` referansından farklı olarak, `workspaces` fiziksel bir
    // tablo olduğundan gerçek bir FK taşıyabilir (calendar_events_cache.workspaceId/
    // command_proposals.workspaceId ile BİREBİR aynı desen). Bir sweeper'ın
    // "bu satır hangi workspace'e ait?" sorusunu `objects_view`'a JOIN
    // yapmadan yanıtlayabilmesi için gerekli.
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    meetingUrl: text('meeting_url').notNull(),
    provider: meetingProviderEnum('provider').notNull(),
    status: meetingStatusEnum('status').notNull().default('sunuldu'),
    // Bot vendörünün (ADR-0030 Karar a/e) bu toplantı-daveti için verdiği kendi kimliği --
    // webhook'un (ADR-0030 Karar g) EŞLEŞTİRME anahtarı.
    providerMeetingRef: text('provider_meeting_ref').notNull(),
    providerRecordingUrl: text('provider_recording_url'),
    transcriptText: text('transcript_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Webhook'un `providerMeetingRef` ile TAM eşleşme araması O(1) index-lookup
    // olsun VE (istatistiksel olarak imkansız olsa da) bir vendör kimliğinin
    // sessizce iki farklı `meeting` nesnesine bağlanmasını DB seviyesinde
    // engellensin diye -- ADR-0028 §b'nin `tokenHash` unique index'inin AYNI
    // gerekçesi.
    uniqueIndex('meeting_details_provider_meeting_ref_idx').on(table.providerMeetingRef),
    // v0'da bir `meeting` nesnesi tam olarak BİR bot-daveti/detay satırı taşır
    // (yeniden davet = yeni bir `meeting` nesnesi, ADR-0030 Karar a/g'nin sıkı
    // opt-in'i ve F2-T14'e ertelenen "aynı toplantıya tekrar davet" senaryosu
    // gereği) -- bu invariant'ı DB seviyesinde de garanti eder.
    uniqueIndex('meeting_details_object_id_idx').on(table.objectId),
  ],
);
