# ADR-0048: Federatif Bağlam Paylaşımı v0 — Bilateral `FederationLink`, Opt-in Nesne Allowlist'i, Çift-Taraflı Denetim Günlüğü

**Durum:** Kabul edildi
**Tarih:** 2026-09-13
**İlgili görev:** [F3-T14 — Kurumlar Arası Paylaşılan Proje Alanı](../specs/F3-E6/F3-T14-federatif-baglam-paylasimi.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F3-E6: Federatif Beyin v0 (Kapsam Q)" (F3-T14 satırı, satır 303) ve §7 madde 8'in teknik özeti (satır 316): _"Federatif Beyin (Q): LuminaOS'in kendi MCP sunucusu, kapsam-sınırlı belirteçlerle karşı kuruma bağlam servis eder; veri kopyalanmaz, yerinde sorgulanır."_ CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin **her iki** fıkrası da tetikleniyor: (1) karar birden fazla pakete/gelecekteki göreve dayatılan bir sözleşim tanımlıyor — kurumlar-arası ilk güven sınırı, `packages/memory`'nin olası bir sonraki federasyon genişlemesine doğrudan emsal olacak; (2) karar `docs/adr/ADR-0028-mcp-sunucusu-v0.md`'nin BİLEREK açık bıraktığı bir uzatma noktasını (Karar l'nin "süresiz federasyon token'ı" ihtimali) kapatıyor.

> Bu ADR, `docs/adr/ADR-0028-mcp-sunucusu-v0.md`'nin Bilinen Sınırlamalar (a) maddesinin AÇIKÇA F3-T14'e erteldiği üç şeyi (kurumlar-arası federasyon, çift-taraflı denetim günlüğü, paylaşılan proje alanı) kapatıyor. Bu oturumda insan tarafından ALINMIŞ, tartışılmayacak 3 bağlayıcı karar var — bu ADR onları İCAT ETMİYOR, kayda geçiriyor: (1) federasyon birimi = yeni bir `Organization` varlığı DEĞİL, **bilateral workspace eşleşmesi** (`FederationLink`); (2) içerik görünürlüğü = **tam içerik, opt-in allowlist ile** (Google Docs "harici paylaş" modeli — güvenlik sınırı KAPSAMDADIR, kapsam İÇİNDEKİ içerik redakte edilmez); (3) v0 kapsamı = **yalnızca bağlam (`ContextService`)**, `packages/memory` paylaşımı bu ADR'nin KAPSAMI DIŞI, sonraki görev önerisi olarak not düşülür. Bu ADR'nin KENDİ katkısı, insanın `architect`'e bıraktığı tek karar: **federasyon credential'larının `expiresAt` politikası** (Karar d) — bu da insan onayıyla SONLU 30/90/365 gün (varsayılan 90) olarak kapatıldı, aşağıda Karar (d) bunu aynen kayda geçiriyor.

## Bağlam

1. **`McpTokenAuthGuard`/`mcp_client_grants` (ADR-0028) doğrulandı** (`apps/server/src/mcp-server/mcp-token-auth.guard.ts`, `apps/server/src/db/schema/mcp-client-grants.ts`): Bearer token → `sha256` hash tam-eşleşme → `revokedAt`/`expiresAt`'in üçü de TEK bir 401'e collapse edilmesi → **canlı** yetki kontrolü (token oluşturulduğu andaki değil). Bu ADR'nin `FederationTokenAuthGuard`'ı bu deseni BİREBİR taklit ediyor, ama `request.user`/`request.membership` (bir İNSAN oturumunu temsil eden şekil) yerine YENİ bir `request.federationGrant` şekli dolduruyor — çünkü federasyon çağrısının arkasında bir insan değil, karşı workspace'in KENDİSİ var.
2. **ADR-0028 Karar (l), `expiresAt`'i nullable bırakırken AÇIKÇA bu görevi işaret ediyor**: _"şemanın gelecekte (ör. F3-T14'ün kurumlar-arası federasyonunda bir admin'in KASITLI olarak süresiz bir federasyon-token'ı tanımlaması gerekirse) bu genişlemeye açık kalmasını sağlayan bir gelecek-uzantı noktası."_ Bu ADR bu noktayı **kullanmamayı** seçiyor (Karar d) — nullable kolon şema seviyesinde KALIYOR (gelecekte başka bir ihtiyaç doğarsa), ama v0'ın hiçbir kod yolu `NULL` yazmıyor; ADR-0028 Karar (l)'nin AYNI gerekçesi (unutma riski, kod tabanının "her şey sona erer" tutarlı pratiği) burada DAHA GÜÇLÜ uygulanıyor çünkü federasyon credential'ı kişisel bir PAT'ten DAHA YÜKSEK riskli (İnsan kararı 2'nin tam-içerik görünürlüğü).
3. **`ContextService.getContext(workspaceId, objectId, callerRole, options?)` doğrulandı** (`apps/server/src/context/context.service.ts:83-189`): dönüş şekli `ContextResponse = {asOf, entity:{entityId,objectType,title,fieldValues}, edges: ContextEdgeSummary[]}`. `edges[].node` (`ContextNodeSummary`) zaten komşu bir `entity` düğümü için yalnızca `type`/`title` taşıyor, `fieldValues`'unu ASLA (ADR-0018 Karar b, `NeighborObjectSummary` — satır 63-67) — ama komşunun `objectId`(`entityId`)/`title`'ının VARLIĞI kendisi, federasyon sınırında BAŞKA bir sızıntı sınıfı: host'un BİLİNÇLİ OLARAK paylaşmadığı bir komşu nesnenin var olduğunu ve başlığını ifşa eder. Bu ADR'nin Karar (g)'si bu YENİ sızıntı sınıfını kapatıyor.
4. **`RelationsService.assertObjectExists`** (`apps/server/src/relations/relations.service.ts:268-278`) — "nesne var mı + doğru workspace'te mi" ikili kontrolünün kurulu emsali; `federation_scope_objects`'e bir nesne eklenirken AYNI kontrol (host workspace'e karşı) kullanılır.
5. **KRİTİK bulgu — `events` tablosunun UNIQUE kısıtı `workspace_id`'yi İÇERMİYOR** (`apps/server/src/db/schema/events.ts:31-53`, doğrulandı): `events_stream_id_version_key` YALNIZCA `(stream_id, version)` üzerinde. Yani iki FARKLI workspace'in event'i AYNI `streamId`'yi paylaşırsa, `EventStoreService.append`'in `MAX(version) WHERE streamId=X` sorgusu (satır 89-92) iki workspace'in versiyon sayaçlarını YANLIŞLIKLA TEK bir sekansta karıştırır — sahte `VersionConflictError`/idempotency bozulması riski. Bu, çift-taraflı denetim event'lerinin (Karar h) bir `linkId`'yi doğrudan `streamId` olarak İKİ TARAFTA paylaşmasını YAPISAL OLARAK YASAKLIYOR — her tarafın kendi, ayrı bir stream'i olmalı.
6. **`EventStoreService.append(streamId, expectedVersion, newEvents): Promise<StoredEvent[]>`** (`apps/server/src/event-store/event-store.service.ts:74-`) kendi `db.transaction`'ını AÇIYOR — dışarıdan bir transaction enjekte etme parametresi YOK. İki bağımsız `append` çağrısını (host + grantee stream'i) TEK bir dış transaction'da atomik yapmak, bu metodun imzasını değiştirmeyi (tüm mevcut çağıranları etkileyen bir kırılma) gerektirirdi.
7. **`mcp-client-grants.service.ts`'in `grant(workspaceId, userId, name, expiresAtDays: 30|90|365)`** — PAT üretim/hash/prefix/revoke deseninin BİREBİR kopyalanacağı emsal; `federation-link-credentials.service.ts` bu metodun `userId` yerine `federationLinkId`+`granteeWorkspaceId` alan imzasıyla aynısı olacak.
8. **F3-T11 spec'inin (`docs/specs/F3-E4/F3-T11-sapma-aciklama-karti.md`, ADR-0045 Karar e) "iç `setFieldValues` yazımı sabit `'owner'` rolüyle çalışır" emsali** — bir SİSTEM-başlatmalı işlemin, normal insan RBAC'ını değil, sentetik/sabit bir rolü kullanmasının kurulu örneği. Bu ADR'nin Karar (g)'si `ContextService.getContext`'i sentetik `'owner'` rolüyle çağırırken AYNI emsali kullanıyor.
9. **`docs/adr/ADR-0016-veri-disa-aktarma-rbac-kapsam.md` §(a) doğrulandı**: export/okuma yollarına rol-gate EKLENEMEZ, yalnızca üyelik yeterli — bu kural "F1-T18'in ötesine geçen, Context Fabric/Memory Passport export'ları dahil tüm gelecekteki export/okuma uç noktalarını bağlayan" bir kural olarak AÇIKÇA ilan edilmişti. Bu ADR'nin Karar (i)'si bu bağlayıcılığı somutlaştırıyor.
10. **`docs/adr/ADR-0029-hibrit-ai-veri-siniflandirmasi.md` doğrulandı**: dört kademeli hassasiyet sınıflandırması BULUT-SAĞLAYICI güvenine göre yazılmış (LuminaOS sunucusu ↔ üçüncü-parti AI vendörü ekseni). Kurumlar-arası (workspace ↔ workspace) eksenine hiç değinmiyor. Bu ADR'nin Karar (j)'si bu ayrımı netleştiriyor.
11. **`apps/server/src/db/migrations/`+`.../down/` taranarak sıradaki migration numarası 0047 olarak doğrulandı** (son dosya `0046_agent_notification_governor.sql`/`.down.sql`); **`docs/adr/` taranarak sıradaki ADR numarası 0048 olarak doğrulandı** (son dosya `ADR-0047-bildirim-butcesi-sessiz-saatler.md`).
12. **`apps/server/src/observability/redact.ts`'in `maskSensitiveFields` konvansiyonu** — federasyon audit event payload'ları loglanırsa (hata durumunda) izlenmesi gereken desen; event payload'unun KENDİSİ (event store'a yazılan) bu redaksiyona tabi DEĞİL (event store zaten workspace-scoped, gizli değil).

## Karar

### (a) Federasyon birimi — bilateral `FederationLink`, yeni `Organization` varlığı YOK (insan kararı, aynen kayıt)

Bir "kurum", bu ADR'de yeni bir varlık DEĞİL — zaten kiracı sınırı olan `workspace` ile BİREBİR eşleniyor. `FederationLink`, iki `workspace`'i (`initiatorWorkspaceId`, `counterpartWorkspaceId`) her iki tarafın da AÇIK onayıyla eşleştiren, hafif, YENİ bir varlık. Kod tabanında bugün `organizations` tablosu YOK (Bağlam), `memberships.role` enum'unda kurumlar-arası/harici bir rol YOK — bu ADR bunların HİÇBİRİNİ eklemiyor.

### (b) `federation_links` tablosu — durum makinesi (`pending → active → revoked`, terminal)

```ts
// apps/server/src/db/schema/federation-links.ts
import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

export const federationLinkStatusEnum = pgEnum('federation_link_status', [
  'pending',
  'active',
  'revoked',
]);

export const federationLinks = pgTable(
  'federation_links',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    initiatorWorkspaceId: uuid('initiator_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    counterpartWorkspaceId: uuid('counterpart_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Yön-bağımsız benzersizlik için: `[min(a,b), max(a,b)].join(':')`,
    // servis katmanında hesaplanır (uygulama-seviyesi, DB generated column
    // DEĞİL -- Drizzle'ın bu sürümde stored-generated-column desteği yok).
    pairKey: varchar('pair_key', { length: 73 }).notNull(),
    status: federationLinkStatusEnum('status').notNull().default('pending'),
    initiatedByUserId: uuid('initiated_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Karar (h)'nin çift-taraflı denetimi -- HER TARAFIN KENDİ stream'i,
    // linkId'yi iki tarafta streamId olarak paylaşmanın Bağlam madde 5'in
    // events_stream_id_version_key çakışmasını (workspace-kör UNIQUE)
    // tetiklemesini YAPISAL OLARAK önler.
    initiatorAuditStreamId: uuid('initiator_audit_stream_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    counterpartAuditStreamId: uuid('counterpart_audit_stream_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // Aynı iki workspace arasında AYNI ANDA birden fazla pending/active link
    // olamaz -- revoked linkler bu kısıttan MUAF (yeniden link kurulabilir).
    uniqueIndex('federation_links_pair_key_active_key')
      .on(table.pairKey)
      .where(sql`${table.status} <> 'revoked'`),
  ],
);
```

Durum geçişleri, saf/DB'siz bir modülde (`apps/server/src/federation/federation-link-state.ts`) sabitlenir:

```ts
export type FederationLinkStatus = 'pending' | 'active' | 'revoked';

/** Geçersiz bir geçiş `false` döner -- çağıran `InvalidObjectStateError` fırlatır. */
export function canTransition(from: FederationLinkStatus, to: FederationLinkStatus): boolean {
  if (from === 'pending' && to === 'active') return true;
  if ((from === 'pending' || from === 'active') && to === 'revoked') return true;
  return false;
}

export function computePairKey(workspaceIdA: string, workspaceIdB: string): string {
  return [workspaceIdA, workspaceIdB].sort().join(':');
}
```

`FederationLinksService` (`apps/server/src/federation/federation-links.service.ts`) bu saf fonksiyonları sarar: `initiate`/`accept`/`revoke` — geçersiz geçişte `InvalidObjectStateError`, `pairKey` çakışmasında (aktif bir link zaten varken yeni link denemesi) `ConflictError`.

### (c) Kim başlatabilir/kabul edebilir/iptal edebilir — yalnızca `admin+` (insan kararı, aynen kayıt)

- **Başlatma (`initiate`):** yalnızca `initiatorWorkspaceId`'nin `admin+`'ı. Kendi kendine link (`initiatorWorkspaceId === counterpartWorkspaceId`) `ValidationError`.
- **Kabul (`accept`):** yalnızca `counterpartWorkspaceId`'nin `admin+`'ı. Initiator kendi teklifini kabul EDEMEZ — bir initiator-taraflı admin `accept` çağırırsa `ForbiddenError` (kendi workspace'i `counterpartWorkspaceId` DEĞİL).
- **İptal (`revoke`):** HER İKİ tarafın `admin+`'ı, HER DURUMDA (`pending` veya `active`) — link `revoked` olduktan sonra TERMİNAL, yeniden aktifleştirilemez (yeni bir link kurulmalı, Karar b'nin partial-unique-index'i bunu izin verir çünkü `revoked` satırlar kısıttan muaf).

Bu, ADR-0028 Karar (i)'nin "kim olduğun (401) ile neye erişebildiğin (403)" ayrımının burada rol-seviyesinde tekrarı: kimliği doğrulanmış AMA `admin` OLMAYAN bir üye bu üç aksiyondan hiçbirini çağıramaz — bir kullanıcının kendi kişisel `mcp_client_grants` PAT'inden (üyelik yeterli, ADR-0028 Karar g) KATLANARAK daha yüksek riskli bir eylem olduğu için (workspace'in TAMAMININ dışarıya bağlanma yüzeyini açıyor).

### (d) [İNSAN ONAYLI — bu oturumda kapatıldı] `federation_link_credentials` — sonlu 30/90/365 gün, varsayılan 90, süresiz seçenek YOK

```ts
// apps/server/src/db/schema/federation-link-credentials.ts
export const federationLinkCredentials = pgTable(
  'federation_link_credentials',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    federationLinkId: uuid('federation_link_id')
      .notNull()
      .references(() => federationLinks.id, { onDelete: 'cascade' }),
    // Token'ı KULLANAN (elinde tutan) taraf. Host taraf (verinin sahibi),
    // linkin granteeWorkspaceId OLMAYAN ucu olarak GUARD'da türetilir --
    // ayrı bir "hostWorkspaceId" kolonu İCAT EDİLMİYOR (redundant, linkten
    // her zaman türetilebilir).
    granteeWorkspaceId: uuid('grantee_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(), // ör. "Acme Corp -- paylaşılan proje X"
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    tokenPrefix: varchar('token_prefix', { length: 12 }).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }), // host tarafın admin'i
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }), // nullable KALIYOR (şema-seviyesi gelecek-uzantısı), v0 HİÇBİR kod yolu NULL yazmıyor
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('federation_link_credentials_token_hash_key').on(table.tokenHash)],
);
```

**Karar:** Credential oluşturma panelinde/API'sinde `expiresAtDays` alanı, `mcp_client_grants`'ın (ADR-0028 Karar l) BİREBİR AYNI zod doğrulamasına tabi: `z.union([z.literal(30), z.literal(90), z.literal(365)])`, varsayılan **90**. "Süresiz" seçeneği hiç sunulmaz — ADR-0028 Karar (l)'nin `expiresAt`'i nullable bırakırken açıkça F3-T14 için ayırdığı uzatma noktası, **bilinçli olarak kullanılmıyor**.

**Gerekçe:** Federasyon credential'ı, kişisel bir MCP PAT'inden (ADR-0028) DAHA YÜKSEK riskli — sızması durumunda saldırganın eline geçen şey "host workspace'in KASITLI OLARAK paylaştığı her nesnenin TAM içeriği" (İnsan kararı 2, redaksiyon YOK). ADR-0028 Karar (l)'nin gerekçesi ("unutma riski", "kod tabanının her şey sona erer tutarlı pratiği") BURADA DAHA GÜÇLÜ uygulanıyor: bir MCP PAT sahibi kullanıcı kendi bireysel erişimini kaybeder, ama sızan bir federasyon credential'ı TÜM bir kurumun paylaştığı veriyi açığa çıkarır — blast radius kategorik olarak daha büyük. `expiresAt` kolonu yine de nullable BIRAKILIYOR (şema esnekliği için), ama bu ADR'nin KENDİSİ bu genişlemeyi KULLANMAMAYI seçiyor; gelecekte GERÇEK bir "süresiz federasyon" ihtiyacı doğarsa (ör. çok-yıllı, kurumsal-sözleşmeli bir federasyon), bu AYRI bir insan kararı + ayrı bir ADR gerektirir.

### (e) `federation_scope_objects` — tek-tek, kasıtlı opt-in; toplu paylaşım YOK (insan kararı, aynen kayıt)

```ts
// apps/server/src/db/schema/federation-scope-objects.ts
export const federationScopeObjects = pgTable(
  'federation_scope_objects',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    federationLinkId: uuid('federation_link_id')
      .notNull()
      .references(() => federationLinks.id, { onDelete: 'cascade' }),
    // objectsView bir VIEW olduğu için gerçek bir FK burada kurulamaz
    // (ADR-0028 Bağlam madde 6'nın "gerçek satır zaten FK'lı" mantığı
    // burada uygulanamaz) -- servis katmanı `assertObjectExists` (Bağlam
    // madde 4) ile ekleme anında doğrular.
    objectId: uuid('object_id').notNull(),
    // Nesnenin GERÇEKTEN yaşadığı workspace -- linkin iki ucundan biri
    // olmak ZORUNDA, servis katmanında doğrulanır.
    ownerWorkspaceId: uuid('owner_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    addedByUserId: uuid('added_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }), // tombstone -- mcp_client_grants/MemoryAccessPolicy emsali, hard-delete YOK
  },
  (table) => [
    uniqueIndex('federation_scope_objects_active_key')
      .on(table.federationLinkId, table.objectId)
      .where(sql`${table.removedAt} IS NULL`),
  ],
);
```

Ekleme yalnızca `ownerWorkspaceId`'nin `admin+`'ı tarafından yapılabilir, `objectId`'nin GERÇEKTEN o workspace'te var olduğu doğrulanarak. Bir nesnenin kaldırılması (`removedAt` doldurma) da AYNI yetki gerektirir. **Toplu "tüm workspace'i paylaş" YOK** — her ekleme tek bir `objectId` için, tek bir bilinçli kullanıcı eylemi.

### (f) `FederationTokenAuthGuard` — `McpTokenAuthGuard`'ın PARALEL bir kopyası, genişletilmesi DEĞİL

```ts
// apps/server/src/federation/federation-token-auth.guard.ts
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { UnauthorizedError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { federationLinkCredentials } from '../db/schema/federation-link-credentials.js';
import { federationLinks } from '../db/schema/federation-links.js';

import type { Database } from '../db/client.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

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
      throw new UnauthorizedError(); // ADR-0028 Karar i'nin AYNI 401-collapse disiplini
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
```

`request-context.ts`'e YENİ bir opsiyonel alan: `federationGrant?: { linkId: string; credentialId: string; granteeWorkspaceId: string; hostWorkspaceId: string }` — `FederationTokenAuthGuard`'a özel, `McpTokenAuthGuard`/`SessionAuthGuard` yollarında hiç dolmaz. **Neden `McpTokenAuthGuard`'ı GENİŞLETMİYORUZ:** o guard'ın doldurduğu `request.user`/`request.membership` bir İNSAN kimliğini temsil eder (`SessionService.findUserById`, `WorkspaceMembershipService.assertMembership`); federasyon çağrısının arkasında hiçbir insan/kullanıcı satırı YOK — karşı workspace'in kendisi çağırıyor. İki farklı kimlik şeklini tek bir guard'da birleştirmek, `get_context` tool handler'ının `req.membership.role` okuma varsayımını (ADR-0028 Bağlam madde 1) kırılgan hale getirirdi.

### (g) Yeni uç nokta + tool — `POST /federation-mcp`, `FederationMcpController`, tek tool `get_federated_context(objectId)`

`POST /mcp`'den (ADR-0028) AYRI bir controller/guard/tool kaydı — mevcut `McpController`'a ikinci bir guard tipi EKLENMEZ.

```ts
// apps/server/src/federation/federation-mcp.controller.ts
@Controller('federation-mcp') // workspace-bağımsız -- ADR-0028 Karar d'nin AYNI gerekçesi: yetki token'ın KENDİSİNDEN çözülür
@UseGuards(FederationTokenAuthGuard)
export class FederationMcpController {
  constructor(
    private readonly contextService: ContextService,
    private readonly scopeService: FederationScopeService,
    private readonly auditService: FederationAuditService,
    private readonly rateLimit: FederationRateLimitService,
  ) {}

  @Post()
  async handleFederationMcp(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { linkId, credentialId, granteeWorkspaceId, hostWorkspaceId } = req.federationGrant!;
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

        // 2) Fail-closed host-taraf audit -- BAŞARISIZ olursa okuma HİÇ olmaz (Karar h).
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

        // 4) Best-effort grantee-taraf audit -- BAŞARISIZ olsa bile yanıt döner (Karar h).
        await this.auditService.recordRequestedBestEffort({
          linkId,
          granteeWorkspaceId,
          hostWorkspaceId,
          credentialId,
          objectId,
        });

        return { content: [{ type: 'text', text: JSON.stringify(filtered) }] };
      },
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
```

**Sentetik `'owner'` rolü (İnsan kararı 2'nin doğrudan kod-seviyesi karşılığı):** `ContextService.getContext`'in `canViewField`/ADR-0018 alan-bazlı gizleme süzgeci burada BİLİNÇLİ OLARAK bypass edilir — F3-T11 spec'inin (ADR-0045 Karar e) "iç `setFieldValues` yazımı sabit `'owner'` rolüyle çalışır" emsalinin AYNI deseni: host taraf bir nesneyi kapsama eklerken TAM içeriği paylaştığını ZATEN kabul etmiş (Google Docs "harici paylaş" modeli), bu yüzden alan-bazlı bir ikinci süzgece gerek YOK — v0'ın TEK güvenlik sınırı, KAPSAMIN KENDİSİ (adım 1).

### `filterFederatedContextGraph` — komşu-nesne sızıntısı önlemi (bu ADR'nin YENİ, mimari-inceleme kaynaklı bulgusu)

```ts
// apps/server/src/federation/filter-federated-context-graph.ts
import type { ContextResponse } from '../context/context.service.js';

/**
 * `ContextResponse.edges`'teki HER `entity` tipi komşu düğüm, `allowedObjectIds`
 * kümesinde (AYNI linkin aktif kapsam nesneleri) YOKSA TAMAMEN ELENİR --
 * yalnızca `title`/`fieldValues` gizlenmez, KENDİSİ hiç dönmez. `person`/
 * `time`/`topic` düğümleri filtrelenmez (bunlar paylaşılan kök nesnenin
 * KENDİ alanlarından türetilir, İnsan kararı 2'nin "tam içerik" kapsamında
 * ZATEN granted).
 *
 * Neden gerekli: `ContextService`'in mevcut `NeighborObjectSummary` (ADR-0018
 * Karar b) ZATEN komşunun `fieldValues`'unu gizliyor, ama `title`/`objectType`
 * VARLIĞININ KENDİSİ host'un BİLİNÇLİ OLARAK paylaşmadığı bir nesnenin
 * var olduğunu ifşa eder -- İnsan kararı 2'nin "paylaşılmayan her şey
 * tamamen görünmez" ilkesini ihlal eder. Bu fonksiyon olmadan 1-hop bağlam
 * grafiği, opt-in allowlist sınırını (Karar e) fiilen delerdi.
 */
export function filterFederatedContextGraph(
  response: ContextResponse,
  allowedObjectIds: ReadonlySet<string>,
): ContextResponse {
  return {
    ...response,
    edges: response.edges.filter((edge) => {
      if (edge.node.nodeType !== 'entity') return true;
      return edge.node.entityId !== undefined && allowedObjectIds.has(edge.node.entityId);
    }),
  };
}
```

Saf, DB'siz, birim test edilebilir — `apps/server/src/federation/` altında, `FederationMcpController` tarafından çağrılır.

### (h) Çift-taraflı denetim günlüğü — fail-closed/best-effort asimetrisi, TEK cross-workspace transaction DEĞİL

Her iki workspace'in KENDİ event log'una (ayrı bir global/paylaşılan audit tablosu DEĞİL — "tek doğruluk kaynağı olay günlüğü" mimari değişmezinin ihlali olmaz, çünkü her workspace hâlâ TEK bir kendi log'una sahip) iki farklı event tipi eklenir:

- **`FederatedContextAccessed`** — HOST workspace'in event log'una, `federationLinks.initiatorAuditStreamId`/`counterpartAuditStreamId`'den HOST'a karşılık gelene yazılır (Bağlam madde 5'in çakışma riskini önlemek için `linkId` DEĞİL, bu ayrı stream id kullanılır). Payload: `{ linkId, credentialId, granteeWorkspaceId, objectId, occurredAt }`. **Fail-closed:** bu `EventStoreService.append` çağrısı BAŞARISIZ olursa istek 500 ile durur, `ContextService.getContext` HİÇ ÇAĞRILMAZ — host'un "kim benim verimi okudu" kaydı olmadan hiçbir okuma gerçekleşemez.
- **`FederatedContextRequested`** — GRANTEE workspace'in KENDİ event log'una, kendi audit stream'ine yazılır. Payload: `{ linkId, credentialId, hostWorkspaceId, objectId, occurredAt }`. **Best-effort:** yazım BAŞARISIZ olursa yalnızca sunucu loguna (mevcut logger, `redact.ts` disiplini) düşer, istek YİNE DE `200` ile döner — çünkü güvenlik-kritik kayıt (host tarafı) zaten adım (2)'de garanti altına alındı; bu ikinci kayıt yalnızca çağıran tarafın KENDİ rahatlığı/şeffaflığı için.

**Sıra ÖNEMLİ:** host-tarafı yazım DAİMA `ContextService.getContext`'ten ÖNCE, grantee-tarafı yazım DAİMA SONRA. Böylece "audit kaydı olmadan hiçbir veri LuminaOS'in bir workspace'inden dışarı sızmaz" garantisi, en pahalı/kritik yarısı için (host'un bilgilendirilmesi) HİÇBİR ZAMAN bozulmaz; ikincil yarısı (grantee'nin kendi kaydı) ise iyi-niyetli/best-effort kalır.

**Reddedilen alternatif — tek DB transaction'ında iki append.** Teknik olarak MÜMKÜN (Bağlam madde 5/6: aynı Postgres instance, aynı `events` tablosu, iki farklı `streamId`). Reddedildi çünkü: (1) `EventStoreService.append`'in bugünkü public API'si dışarıdan bir transaction enjeksiyonu DESTEKLEMİYOR — bunu eklemek imza değişikliği gerektirir, TÜM mevcut çağıranları (her domain servisinin event-append yolu) etkileyen bir kırılma riski taşır; (2) iki BAĞIMSIZ stream'in optimistic-concurrency kontrolünü (`MAX(version) WHERE streamId=X`) TEK bir transaction'da açık tutmak, ikincil bir denetim-kaydı (audit) için orantısız bir kilit-çekişme penceresi açar — asıl işlem (bağlamı OKUMAK) bu pencerenin İÇİNDE değil. Fail-closed/best-effort ayrımı, host'un HER ZAMAN bilgilendirilmesi garantisini DAHA UCUZA, daha az riskli bir şekilde veriyor.

### (i) ADR-0016 ile ilişki — federasyon kapsamı yalnızca EKLENEN dış görünürlük, mevcut üye haklarını ASLA kısıtlamaz

**Açık karar maddesi:** Bir `FederationLink`'in var/aktif OLMASI, `hostWorkspaceId`'nin kendi üyelerinin `GET .../export`/`ContextService`/`ObjectsService` üzerinden ZATEN sahip olduğu tam okuma/export hakkını HİÇBİR ŞEKİLDE kısıtlamaz/geçitlemez. Federasyon yalnızca YENİ bir dış kapı (karşı workspace, `FederationTokenAuthGuard` üzerinden) açar — var olan HİÇBİR kapıyı kapatmaz, daraltmaz veya ek bir onay adımına tabi kılmaz. Bu, ADR-0016 §(a)'nın "gelecekteki her export/okuma-şekilli uç nokta bu kuralla bağlıdır" ilanının bu ADR'deki somut uygulaması: `federation_scope_objects`'e bir nesne EKLEMEK, o nesnenin `hostWorkspaceId` İÇİNDEKİ görünürlüğünü hiçbir şekilde DEĞİŞTİRMEZ (yalnızca YENİ bir dış tarafa görünürlük ekler).

### (j) ADR-0029 ile ilişki — üçüncü, ele alınmamış eksen; ADR-0029 DEĞİŞMEDEN kalır

ADR-0029'un dört kademeli (Kademe 0-3) hassasiyet sınıflandırması BULUT-SAĞLAYICI güvenine göre yazıldı — "LuminaOS'in kendi sunucusu ↔ üçüncü-parti AI vendörü" ekseni (Bağlam madde 10). Bu ADR'nin ele aldığı eksen TAMAMEN FARKLI: kurumlar-arası (workspace ↔ workspace), insan-hedefli okuma, hiçbir AI/vendör işlemesi YOK. **İnsan kararı 2 gereği, Kademe-bazlı redaksiyon BU ADR'DE UYGULANMAZ:** paylaşılan kapsamdaki bir nesnenin Kademe 1 (ham kişisel-tanımlayıcı metin — ör. bir `task`'ın açıklaması, bir `doc`'un gövdesi) alanları bile TAM görünür, çünkü bu ADR'nin güvenlik sınırı KADEME değil, KAPSAMIN KENDİSİ (Karar e/g). Bu, ADR-0029'u İHLAL ETMİYOR — ADR-0029 hiçbir yerde "kurumlar-arası paylaşım da bu kademelere tabidir" DEMİYOR, kapsamı açıkça bulut-vendör ekseniyle sınırlı (Bağlam madde 10). Gelecekteki okuyucular için açıkça kayda geçirilir: **ADR-0029'un kademeleri ile bu ADR'nin opt-in-allowlist'i iki AYRI, ÇAKIŞMAYAN eksen** — biri "bu veri bir AI vendörüne gidebilir mi", öteki "bu nesne başka bir kurumla paylaşılsın mı".

### (k) Migration + down script

`apps/server/src/db/migrations/0047_federation_links_and_scope.sql` — üç tabloyu (`federation_links`, `federation_link_credentials`, `federation_scope_objects`) TEK migration'da bündler (ADR-0027/ADR-0046'nın "tek görevin tabloları, tek migration" emsali), bağımlılık sırasıyla (`federation_links` önce, sonra ona FK'li ikisi). `apps/server/src/db/migrations/down/0047_federation_links_and_scope.down.sql` — üç `DROP TABLE IF EXISTS`, TERS bağımlılık sırasıyla: `federation_scope_objects` → `federation_link_credentials` → `federation_links` (CLAUDE.md: "Migration'ı down script'i olmadan yazma"). Bu oturumda `apps/server/src/db/migrations/` + `.../down/` taranarak **0047**'nin gerçekten boş olduğu doğrulandı (son mevcut çift: `0046_agent_notification_governor.sql`/`.down.sql`).

### RBAC özeti

| Aksiyon                                                                                                                | Gerekli rol                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Link başlatma/kabul/iptal                                                                                              | `admin+`                                                        |
| Kapsam nesnesi ekleme/çıkarma                                                                                          | `admin+` (nesnenin `ownerWorkspaceId`'sinde)                    |
| Federasyon credential'ı oluşturma/iptal                                                                                | `admin+` (host tarafta)                                         |
| Kendi workspace'inin federasyon denetim günlüğünü (`FederatedContextAccessed`/`FederatedContextRequested`) görüntüleme | `member+` (ADR-0016 §a: okuma rol-gate'lenmez, yalnızca üyelik) |

## Değerlendirilip reddedilen alternatifler

- **Yeni bir `Organization` varlığı eklemek.** Reddedildi (Karar a, İnsan kararı 1) — workspace zaten tek kiracı sınırı; yeni bir üst-varlık, v0'ın ihtiyaç duymadığı bir soyutlama katmanı ekler.
- **Kapsam-içi içerik redaksiyonu (Kademe-bazlı veya alan-bazlı).** Reddedildi (Karar g, İnsan kararı 2) — güvenlik sınırı KAPSAMDA (hangi nesneler eklendi), kapsam İÇİNDE değil; bu v0'ın en basit, en denetlenebilir modeli (Google Docs "harici paylaş").
- **`linkId`'yi doğrudan iki tarafın audit `streamId`'si olarak paylaşmak.** Reddedildi (Bağlam madde 5) — `events_stream_id_version_key`'in workspace-kör UNIQUE kısıtı iki workspace'in versiyon sayaçlarını karıştırırdı.
- **Çift audit yazımını TEK bir DB transaction'ında atomikleştirmek.** Reddedildi (Karar h) — `EventStoreService.append`'in API'si dışarıdan tx enjeksiyonu desteklemiyor; ikincil bir audit kaydı için orantısız kilit-çekişme riski.
- **`McpTokenAuthGuard`/`McpController`'ı federasyon için genişletmek.** Reddedildi (Karar f) — iki farklı kimlik şekli (insan kullanıcı vs. karşı workspace) tek guard/controller'da karışmamalı.
- **Federasyon credential'ları için süresiz (`expiresAt: null`) seçeneği sunmak.** Reddedildi (Karar d, bu oturumda insan onayıyla kapatıldı) — ADR-0028'in bıraktığı uzatma noktası BİLİNÇLİ OLARAK kullanılmadı; blast radius kişisel bir PAT'ten daha büyük.
- **Toplu/otomatik "tüm workspace'i paylaş" kapsam modeli.** Reddedildi (Karar e, İnsan kararı 2'nin bir parçası) — her paylaşım tek-tek, bilinçli bir kullanıcı eylemi olmalı.
- **Tek-taraflı (karşı onayı olmadan) federasyon.** Reddedildi (Karar c) — her iki tarafın `admin+`'ının AÇIK onayı zorunlu.

## Sonuçlar / Etkiler

**Şimdi ne kazanıyoruz:**

- ADR-0028'in Bilinen Sınırlamalar (a) maddesinin F3-T14'e erteldiği üç şey (kurumlar-arası federasyon, çift-taraflı denetim günlüğü, paylaşılan proje alanı) somut, test edilebilir bir tasarıma kavuşuyor.
- `mcp_client_grants`/`McpTokenAuthGuard`'ın PAT/guard deseni, insan-kimliği DIŞINDA bir grantee türü (workspace) için de genellenebilir olduğu KANITLANMIŞ oluyor.
- Kod incelemesi sırasında bulunan iki gerçek risk (workspace-kör `events` UNIQUE kısıtının cross-workspace streamId çakışması; 1-hop bağlam grafiğinin komşu-nesne varlığını sızdırma riski) koddan ÖNCE, ayrı stream-id'ler ve `filterFederatedContextGraph` ile kapatılıyor.
- ADR-0016/ADR-0029 ile net sınırlar çizildi — gelecekteki okuyucular "federasyon kapsamı" ile "export kısıtlaması"nı veya "bulut-vendör hassasiyeti" ile "kurumlar-arası paylaşım"ı karıştırmayacak.

**Neyi erteliyoruz/kabul ediyoruz (Bilinen Sınırlamalar):**

- **(a) `packages/memory`'nin (Memory Passport) federasyon kapsamına dahil edilmesi YOK** — v0 yalnızca `ContextService`'i kapsıyor (İnsan kararı 3). Doğal bir sonraki görev.
- **(b) Federasyon credential rotasyon/yenileme UI'ı YOK** — ADR-0028 Bilinen Sınırlama (b)'nin AYNI erteleme kararı, federasyon credential'ları için de geçerli.
- **(c) Nesne-tipi bazlı kapsam daraltma YOK** — kapsam yalnızca tek-tek `objectId` granülerliğinde.
- **(d) Rate-limit dışında ek bir kötüye-kullanım/anomali tespiti YOK** — `checkRateLimit`'in AYNI varsayılan sabitleri (60/dakika) yeniden kullanılıyor, federasyon trafik desenleri için ayrıca ayarlanmadı.
- **(e) Link kurma öncesi bir "karşı workspace'i keşfetme/arama" UI'ı YOK** — v0'da initiator, `counterpartWorkspaceId`'yi ZATEN biliyor olmalı (kurum-dışı bir kanaldan, ör. e-posta ile paylaşılmış workspace ID/slug).

---

**Sıradaki adım:** Bu ADR insan onayıyla kapatıldı (Karar d dahil, bu oturumda). `docs/specs/F3-E6/F3-T14-federatif-baglam-paylasimi.md` ile birlikte `test-writer` → `implementer` → `security-reviewer` ritüeline PR1'den başlanır. F3-T14, `docs/PLAN.md`'nin Faz 3'ünün SON epiğinin (F3-E6) TEK görevi — PR3 merge olduğunda Faz 3 TAMAMEN kapanır.
