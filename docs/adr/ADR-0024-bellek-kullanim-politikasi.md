# ADR-0024: Bellek Kullanım Politikası — Ajan Erişim Manifestoları (Grant/Revoke Modeli, `agentIdentifier` Şeması, Fail-Closed Değerlendirme)

**Durum:** Kabul edildi
**Tarih:** 2026-08-18
**İlgili görev:** [F2-T8 — Bellek Kullanım Politikası: Ajan Erişim Manifestoları](../specs/F2-E2/F2-T8-bellek-kullanim-politikasi.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E2: Memory Passport" (F2-T8 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin fıkra **(b)**'si tetikliyor — bu görevin tanımladığı `agentIdentifier` şeması, henüz kurulmamış F3-T1'e (Agent Runtime, Faz 3) uzlaşması gereken bir sözleşim dayatıyor; ayrıca "bellek segmenti" kavramı ADR-0022'nin sabitlediği `MemoryRecord` şemasına dokunup dokunmayacağı konusunda öncül bir karar gerektiriyordu.

> Bu karar setinin beş maddesi ((a) ajan kimliği, (b) segment granülerliği YOK, (c) gerçek bir AI özelliğine bağlanmama, (d) UI YOK, (e) varsayılan erişim DENY) tamamen insan onaylı geldi — spec'in (`F2-T8-bellek-kullanim-politikasi.md`) "Açık Sorular" bölümündeki 1-5 numaralı sorulara `AskUserQuestion` ile plan onayında verilen yanıtlardır; bu ADR onları icat etmiyor, aynen kayıt altına alıyor. Bu ADR'nin kendi sorumluluğu, insan tarafından henüz çözülmemiş TEK teknik tasarım sorusunu kapatmak — **Karar (f): politika modeli grant/revoke mi, yoksa iki-değerli `access: 'allow' | 'deny'` enum'u mu?** — ve geri kalan yedi maddeyi (event şekilleri, `MemoryAccessPolicy` tipi/paket konumu, Drizzle şeması, projeksiyon/upsert tasarımı, REST sözleşmesi, saf değerlendirme fonksiyonu, alt-PR ayrıştırması) kod-seviyesi bir tasarıma dökmek.
>
> Karar (f)'nin plan-onayı sırasında spec'in kendisi `access: 'allow' | 'deny'` çiftini ÖNERİ olarak taşıyordu (Kapsam madde 1) — ama bu bir insan kararı olarak kilitlenmedi, yalnızca ilk taslak çerçevelemesiydi. CLAUDE.md'nin "Çalışma Ritüeli" maddesi mimari-kritik görevlerde bu düzeydeki teknik-tasarım detaylarının insana tekrar sorulmadan `architect` tarafından ADR adımında sonuçlandırılmasına izin veriyor — bu ADR bunu yapıyor, (a)-(e)'de kilitlenen kararları DEĞİŞTİRMEDEN.

## Bağlam

Keşif üç tam emsali doğruladı:

1. **`DesktopSignalConsentsService`/`DesktopSignalConsentProjection`/`desktop-signal-consents.controller.ts`** (`apps/server/src/context/`, F2-T3/ADR-0020) — bu görevin mimarisinin doğrudan kopyalayacağı emsal: deterministik `streamId` (`deriveDeterministicUuid(NAMESPACE, `${workspaceId}:${userId}:${signalType}`)`), `Granted`/`Revoked` olay çifti, projeksiyonda `onConflictDoUpdate` upsert (grant, `revokedAt` sıfırlanır) + `update...set({revokedAt})` (revoke, fiziksel `DELETE` YOK), `SessionAuthGuard`+`WorkspaceMembershipGuard` guard stack'i, kimliğin HER ZAMAN `req.user.id`'den türetildiği self-service-by-construction API şekli. Bu görevin `agentIdentifier` üçlüsü, `signalType` üçlüsünün BİREBİR yapısal eşleniği: her iki durumda da doğal anahtar `(workspaceId, userId, X)` bir tekillik kısıtı taşıyor (bir kullanıcının bir workspace'te bir sinyal tipi/ajan tanımlayıcısı için TEK bir satırı olmalı) — bu yüzden `MemoryRecordsService`'in per-record `randomUUID()` `streamId`'si DEĞİL, `DesktopSignalConsentsService`'in deterministik türetimi doğru eşleşme.
2. **`packages/memory`'nin mevcut konvansiyonları** (`memory-record.ts`, `memory-record-events.ts`, ADR-0022) — saf TypeScript, framework import yok, `MemoryRecord` düz arayüz (satır-şekli, wire payload'ı değil), üç olayın `.strict()` zod payload şemaları, `id`/`workspaceId`/`userId`/`occurredAt`'ın `DomainEvent` zarfından geldiği, payload'da tekrarlanmadığı desen. Yeni `MemoryAccessPolicy` tipi ve iki olayın payload şemaları bu konvansiyonu BİREBİR izler.
3. **`apps/server/src/memory/`'nin mevcut modülü** (`memory-records.service.ts`, `.controller.ts`, `memory.module.ts`, F2-T5/PR2, ADR-0022) — bu görevin servis/controller çifti AYNI modüle (`MemoryModule`) yeni provider/controller olarak eklenir, ayrı bir modül AÇILMAZ (aynı bounded context, aynı guard/DB/event-store bağımlılıkları).

Çözülmesi gereken merkezi soru (insan onayıyla kapatılan (a)-(e) hariç, bu ADR'nin görevi): (f) politika modeli — grant/revoke mi, allow/deny enum mu; ve bunun kod-seviyesi sonuçları (g)-(l).

## Karar

### (a) Ajan kimliği — `agentIdentifier: string`, kısıtlanmamış (insan kararı, aynen kayıt)

Gerçek bir Agent Runtime YOK (F3-T1, Faz 3, henüz kurulmadı). v1'de bir "ajan", `apps/server/src/ai/`'deki üç adlandırılmış AI çağrı-noktasından (`resolveAIFieldValue`, QA/`answerQuestion` akışı, `parseCommand`) birine karşılık gelen düz bir `agentIdentifier: string` (ör. `"answer-question"`). Sunucu tarafında hiçbir enum/union tip ZORLANMAZ — herhangi bir boş-olmayan string kabul edilir, çünkü gerçek bir çoklu-ajan kimlik şeması henüz yok ve F3-T1'in nihai şeklini tahmin ederek bir enum kilitlemek şemayı geriye dönük uyumsuz kılma riski taşırdı. Bu, ADR-0022 Karar (b)'nin `kaynakOlayId` için kurduğu "alan kalır, semantik genişler" desenine benzer bir açık uçluluk: `agentIdentifier` kolonu değişmeden kalır, F3-T1 geldiğinde onun ne ifade ettiği yeniden yorumlanabilir.

### (b) Segment granülerliği YOK (insan kararı, aynen kayıt)

`MemoryRecord`'un şeması (ADR-0022) DEĞİŞTİRİLMEZ. Bir politika yalnızca `(user, agentIdentifier)` düzeyinde değerlendirilir — "bu ajan bu kullanıcının belleğine hiç erişebilir mi", "hangi KAYITLARA erişebilir" değil. Segment-bazlı granülerlik, `MemoryRecord`'a yeni bir kategori/etiket alanı eklemeyi (ayrı bir şema migration'ı, kendi ADR'si) gerektiren gelecekteki bir göreve ERTELENDİ.

### (c) Gerçek bir AI özelliğine bağlanmama (insan kararı, aynen kayıt)

`apps/server/src/ai/`'deki üç çağrı-noktasından HİÇBİRİ bu görevde değiştirilmez — hiçbiri bu politikayı denetlemez, hiçbiri `MemoryRecord` içeriğini bir prompt'a katmaya BAŞLAMAZ. Bu görev yalnızca şema + self-service CRUD API + saf değerlendirme fonksiyonunu kurar. ADR-0022'nin `MemoryRecordDeleted` tombstone olayını tüketicisiz yayınlama emsaliyle (F2-T5, "olayı yayınla, gerçek tüketici sonra") aynı YAGNI kabulü — altyapı şimdi, tüketici sonra.

### (d) UI YOK (insan kararı, aynen kayıt)

`agentIdentifier` bugün geliştirici/sistem kavramı, son-kullanıcıya bugün anlamlı bir arayüz sunacak kadar somut değil. Bu görev backend-only; gerçek Agent Runtime geldiğinde ayrı bir görev.

### (e) Varsayılan erişim: DENY, fail-closed (insan kararı, aynen kayıt)

Hiç politika kaydı bulunmayan bir `agentIdentifier`, DENY olarak değerlendirilir — kullanıcı açıkça izin vermediği sürece hiçbir ajan-tanımlayıcı bellek okuyamaz. Güvenlik-öncelikli varsayılan, gözden kaçırma değil.

### (f) Politika modeli — GRANT/REVOKE, `allow`/`deny` enum'u DEĞİL (architect kararı, KRİTİK)

**Karar:** spec'in ilk çerçevelemesindeki iki-değerli `access: 'allow' | 'deny'` enum'u REDDEDİLDİ; bunun yerine `DesktopSignalConsentsService`'i BİREBİR yansıtan bir **grant/revoke** modeli benimsendi — bir politika satırının VAR OLMASI (ve `revokedAt IS NULL` olması) = allow; "revoke" satırı fiziksel olarak silmek değil, `revokedAt`'ı doldurmak anlamına gelir. Explicit bir `'deny'` durumu YOK.

**Gerekçe:** Karar (e) (fail-closed varsayılan) zaten "politika yok" = "erişim yok" anlamına geldiğinden, iki-değerli bir enum üç FİİLİ durum üretirdi — `allow`, açıkça-`deny`, ve satır-hiç-yok — ama bunlardan İKİSİ (`deny` satırı ve satırın hiç var olmaması) DAVRANIŞSAL olarak birebir aynı sonucu (false) üretir. Bu, davranışsal bir fark taşımayan bir ayrım: `isAgentAllowedToAccessMemory`'nin dönüş değeri açısından "kullanıcı X ajanını hiç görmedi" ile "kullanıcı X ajanını görüp bilinçli olarak reddetti" arasında hiçbir tüketici (henüz YOK, Karar c) bunu ayırt etmiyor. v1'in dar kapsamında (segment yok, gerçek tüketici yok — Karar b/c) bu ayrımı taşımak yalnızca şemaya (`access` sütunu + onu set/unset eden CRUD dalları) ve implementer'ın kapatması gereken ek bir durum-geçiş yüzeyine karşılık gelir, karşılığında hiçbir gerçek davranış kazandırmaz. Grant/revoke modeli tam tersine: (i) `DesktopSignalConsentsService`'in ZATEN kanıtlanmış, testli deseninin doğrudan kopyası (yeni bir mekanizma icat edilmiyor — CLAUDE.md'nin "mevcut kod yollarını yeniden kullan" ilkesi); (ii) "grant" ve "revoke" kelimeleri kullanıcıya sunulacak self-service CRUD API'sinin (POST/DELETE) fiilleriyle DOĞRUDAN eşleşiyor — bir kullanıcı "bu ajana ERİŞİM VER" ya da "bu ajanın erişimini GERİ AL" der, "bu ajanı DENY olarak İŞARETLE" demez; (iii) gelecekte gerçekten farklı bir üçüncü durum gerekiyorsa (ör. "bu ajanı organizasyon seviyesinde YASAKLA, kullanıcı grant etse bile") bu YENİ bir kavram olur (organizasyon-seviyesi override), bugünün kullanıcı-seviyesi grant/revoke modeliyle karıştırılmamalı — o zaman ayrı bir ADR.

Bu karar, plan onayının ilk `allow`/`deny` çerçevelemesinin BİLİNÇLİ bir rafine edilmesidir — (a)-(e)'de kilitlenen hiçbir kararı DEĞİŞTİRMEZ (varsayılan hâlâ fail-closed/deny, segment granülerliği hâlâ yok, gerçek entegrasyon hâlâ yok); yalnızca o varsayılanın nasıl temsil edileceğine dair bir uygulama detayını sonuçlandırır.

### (g) Event tipleri — `MemoryAccessGranted`/`MemoryAccessRevoked`

Karar (f)'nin doğal sonucu: spec'in önerdiği `MemoryAccessPolicySet`/`MemoryAccessPolicyRevoked` isimleri yerine `DesktopSignalConsentGranted`/`Revoked` deseniyle TUTARLI, geçmiş-zaman isimler: **`MemoryAccessGranted`** / **`MemoryAccessRevoked`**. `packages/memory/src/memory-access-policy-events.ts` (yeni dosya), `memory-record-events.ts`'in AYNI `.strict()` zod konvansiyonu:

```ts
export const memoryAccessGrantedPayloadSchema = z
  .object({
    agentIdentifier: z.string().min(1),
  })
  .strict();

export const memoryAccessRevokedPayloadSchema = z
  .object({
    agentIdentifier: z.string().min(1),
  })
  .strict();

export type MemoryAccessGrantedPayload = z.infer<typeof memoryAccessGrantedPayloadSchema>;
export type MemoryAccessRevokedPayload = z.infer<typeof memoryAccessRevokedPayloadSchema>;
```

`workspaceId`/`occurredAt` zarftan, `userId` = `actor.id`'den (`DesktopSignalConsentGranted`'ın AYNI deseni — `signalType` yerine `agentIdentifier`). `DomainEvent` zarfına uyar: `{id, streamId, streamType: 'memory-access-policy', workspaceId, type, version, payload, actor: {type:'user', id: userId}, occurredAt}`.

### (h) `MemoryAccessPolicy` tipi ve paket konumu

`packages/memory/src/memory-access-policy.ts` (yeni dosya) — `memory-record.ts`'in AYNI "satır-şekli düz arayüz, framework yok" konvansiyonu:

```ts
/**
 * `MemoryAccessPolicy` — a per-(workspace, user, agentIdentifier) grant/revoke
 * row, per ADR-0024 Karar (f)/(h). The record's mere EXISTENCE with
 * `revokedAt === null` means "allowed"; there is no separate `access`
 * enum — mirrors `desktop-signal-consents`'s grant/revoke shape exactly
 * (ADR-0020 Karar a), NOT a two-value allow/deny model.
 */
export interface MemoryAccessPolicy {
  id: string;
  workspaceId: string;
  userId: string;
  agentIdentifier: string;
  grantedAt: Date;
  revokedAt: Date | null;
}
```

Ayrı bir paket/dizin AÇILMAZ — `packages/memory`'nin mevcut iskeleti (F2-T5, ADR-0022 Karar a) genişletilir; bu görev yeni bir paket kurmuyor, var olanı büyütüyor.

### (i) Drizzle şeması — `memory_access_policies`

`apps/server/src/db/schema/memory-access-policies.ts` (yeni dosya, migration + down script'iyle) — `desktop-signal-consents.ts`'in AYNI kolon/FK/unique-index deseni, `signalType` yerine `agentIdentifier`:

```ts
export const memoryAccessPolicies = pgTable(
  'memory_access_policies',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentIdentifier: varchar('agent_identifier', { length: 100 }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('memory_access_policies_workspace_user_agent_key').on(
      table.workspaceId,
      table.userId,
      table.agentIdentifier,
    ),
  ],
);
```

`varchar(100)` (`signalType`'ın `varchar(30)`'undan daha geniş) — Karar (a) `agentIdentifier`'ı sabit bir enum'a kısıtlamadığından, gelecekteki (F3-T1) ajan tanımlayıcıları `"answer-question"` gibi kısa string'lerden daha uzun olabilir (ör. isimlendirilmiş bir ajan/persona kimliği).

### (j) Projeksiyon — upsert/revoke tasarımı, `DesktopSignalConsentProjection`'ın BİREBİR eşleniği

`apps/server/src/memory/memory-access-policy.projection.ts` (yeni dosya), `handles: ['MemoryAccessGranted', 'MemoryAccessRevoked']`:

- `MemoryAccessGranted` → `insert(memoryAccessPolicies).values({...}).onConflictDoUpdate({ target: [workspaceId, userId, agentIdentifier], set: { grantedAt: event.occurredAt, revokedAt: null } })` — yeniden-grant (revoke sonrası tekrar grant) `revokedAt`'ı sıfırlar, `desktop-signal-consent.projection.ts`'in AYNI davranışı.
- `MemoryAccessRevoked` → `update(memoryAccessPolicies).set({ revokedAt: event.occurredAt }).where(workspaceId+userId+agentIdentifier eşleşmesi)` — **fiziksel `DELETE` YOK**; satır DB'de kalır, yalnızca `revokedAt` doldurulur (ADR-0022 Karar d'nin tombstone deseniyle ve ADR-0020 Karar a'nın revoke deseniyle aynı ilke: geçmişin denetlenebilir izi korunur).

`streamId`, `DesktopSignalConsentsService.streamIdFor`'un AYNI mekaniği: yeni bir sabit namespace UUID'si (`MEMORY_ACCESS_POLICY_UUID_NAMESPACE`, implementer tarafından üretilip BİR KEZ sabitlenir, gerçek veri var olduktan sonra ASLA değişmez) ile `deriveDeterministicUuid(NAMESPACE, `${workspaceId}:${userId}:${agentIdentifier}`)` — ajan-tanımlayıcısı bazında AYRI bir stream, spec'in "ajan-düzeyinde" granülerliğiyle 1:1. `MemoryAccessPolicyService` (`apps/server/src/memory/memory-access-policies.service.ts`): `grant`/`revoke`, her ikisi de `append` sonrası SENKRON `projectionRunner.catchUp(this.projection)` çağırır — `DesktopSignalConsentsService`'in AYNI read-your-writes gerekçesi (kullanıcı grant edip HEMEN ardından bir kontrol akışının bunu görmesi gerekebilir).

### (k) REST sözleşmesi

`apps/server/src/memory/memory-access-policies.controller.ts` (yeni dosya), `@Controller('workspaces/:workspaceId/memory/access-policies')`, sınıf-seviyesi `@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)` (`memory-records.controller.ts`'in AYNI guard yerleşimi — YENİ bir guard İCAT EDİLMEZ):

- **`GET /`** → `list(workspaceId, req.user.id)` → `{ policies: MemoryAccessPolicy[] }` — hem aktif (`revokedAt === null`) hem geri alınmış (`revokedAt !== null`) satırları döndürür (filtrelenmez); bu, kullanıcının kendi grant/revoke geçmişini denetleyebilmesi için bilinçli bir tercih — `MemoryRecordsService.list`'in `deletedAt IS NULL` filtresinden BİLİNÇLİ olarak FARKLI: orada filtre gizli/silinmiş İÇERİĞİ göstermemek için var, burada politika satırının kendisi (revoke edilmiş olsa bile) denetim-değerli bilgi.
- **`POST /`** → body `{agentIdentifier: string}` (`memoryAccessPolicyAgentIdentifierSchema`, `.strict()` DEĞİL — `desktop-signal-consents`'in `grantDesktopSignalConsentSchema`'sının AYNI deseni, fazladan alanlar sessizce elenir) → `grant(workspaceId, req.user.id, body.agentIdentifier)` → `{ policy: MemoryAccessPolicy }`.
- **`DELETE /:agentIdentifier`** → `revoke(workspaceId, req.user.id, agentIdentifier)` → `{ policy: MemoryAccessPolicy }`.

Kimlik HER ZAMAN `req.user.id`'den (`!req.user` → `UnauthorizedError`, `desktop-signal-consents.controller.ts`'in AYNI fail-closed deseni) — gövdeden/parametreden ASLA; self-service by construction, admin-gate YOK. `memory.module.ts`'e `MemoryAccessPolicyController`/`MemoryAccessPolicyService` provider olarak eklenir — YENİ bir Nest modülü AÇILMAZ.

### (l) Saf değerlendirme fonksiyonu — `isAgentAllowedToAccessMemory`

`packages/memory/src/is-agent-allowed-to-access-memory.ts` (yeni dosya). **Parametre şekli: tek bir `policy: MemoryAccessPolicy | undefined`, bir liste + tanımlayıcı DEĞİL.** Gerekçe: Karar (i)'nin `(workspaceId, userId, agentIdentifier)` üzerindeki unique-index'i, servis katmanının bu üçlü için EN FAZLA tek bir satır okuyabileceği anlamına geliyor (`DesktopSignalConsentsService.get`'in AYNI tekil-satır dönüşü) — çağıran taraf (gelecekteki bir servis metodu) zaten `WHERE workspaceId=... AND userId=... AND agentIdentifier=...` ile TEK bir satır ya da `null`/`undefined` okuyacak; fonksiyona bir liste geçirip onun içeride agentIdentifier'a göre ARAMASINI istemek gereksiz bir sorumluluk taşınması olurdu (arama mantığı SQL sorgusunda zaten yapılmış). Saf fonksiyon yalnızca ÖNÜNE KONAN tek satırın anlamını yorumlar:

```ts
/**
 * Fail-closed evaluation, per ADR-0024 Karar (e)/(f)/(l): a `policy` of
 * `undefined` (no grant row exists for this (user, agentIdentifier) pair)
 * or a policy with a non-null `revokedAt` (grant was withdrawn) both
 * evaluate to `false`. Only an EXISTING, non-revoked policy is `true`.
 */
export function isAgentAllowedToAccessMemory(policy: MemoryAccessPolicy | undefined): boolean {
  if (!policy) {
    return false;
  }

  return policy.revokedAt === null;
}
```

Doğruluk tablosu (Kabul Kriteri 4'ün karşılığı): tanımlı, geri alınmamış politika → `true`; tanımlı, geri alınmış politika (`revokedAt !== null`) → `false`; hiç politika yok (`undefined`) → `false` (fail-closed).

## Alt-PR ayrıştırması

**TEK PR.** Spec'in planı bu görevi F2-T5/F2-T7'nin (birden fazla alt-PR'a bölünen, ADR-0022/ADR-0023) aksine BÖLMÜYOR — kapsam bilinçli olarak dar tutuldu (Karar b/c/d): tek bir yeni `packages/memory` çifti (tip + event şeması + saf fonksiyon), tek bir yeni Drizzle şeması, tek bir yeni projeksiyon, tek bir yeni servis/controller çifti, hepsi MEVCUT `MemoryModule`'e ekleniyor (yeni modül/paket iskeleti YOK). Bu, `DesktopSignalConsentsService` ailesinin (ADR-0020) TEK BİR PR1'inin (rıza mekanizması: şema+projeksiyon+servis+controller+testler) kapsamıyla büyüklük olarak eşdeğer — ADR-0020'nin KENDİSİ dört PR'a bölündü çünkü Rust/Tauri komutu ve frontend entegrasyonu gibi BAŞKA, bu görevde HİÇ olmayan yüzeyler taşıyordu (Karar c/d: bu görevde ne bir masaüstü/Rust bileşeni ne de bir UI var). CLAUDE.md'nin mimari-kritik görevler için ±400 satır rehberliği bu tek-PR'a UYGUNDUR: iki yeni `packages/memory` dosyası (tip + event şeması, ~60 satır), bir saf fonksiyon dosyası (~20 satır), bir Drizzle şeması + migration/down script (~50 satır), bir projeksiyon (~60 satır), bir servis (~110 satır, `memory-records.service.ts`'in `create`/`edit`/`delete` üçlüsünün `grant`/`revoke`/`list` eşleniği), bir controller + DTO (~90 satır), `memory.module.ts` güncellemesi (~5 satır) — toplam tahmini ~400 satır (test dosyaları hariç, CLAUDE.md'nin PR-boyutu rehberliği testleri saymıyor).

F3-T1 (gerçek Agent Runtime), segment-bazlı granülerlik, gerçek bir AI özelliğinin bu politikayı denetlemesi, politika yönetimi UI'ı — spec'in kendi "Kapsam DIŞI"sı korunuyor, bu ADR'nin kapsamında DEĞİL.

## Alternatifler ve Reddedilme Gerekçeleri

- **İki-değerli `access: 'allow' | 'deny'` enum'u (spec'in ilk çerçevelemesi).** Reddedildi — Karar (f)'ye göre; fail-closed varsayılan (Karar e) zaten "politika yok" = "erişim yok" anlamına geldiğinden, açık bir `'deny'` durumu davranışsal olarak "satır hiç yok" durumuyla AYNI sonucu üretir (hiçbir tüketici, henüz yok, bu ikisini ayırt etmiyor) — ekstra bir durum-geçiş yüzeyi karşılığında sıfır gerçek davranış kazanılır.
- **Yeni bir olay-tipi ismi seti (spec'in önerdiği `MemoryAccessPolicySet`/`MemoryAccessPolicyRevoked`).** Reddedildi — Karar (f)'nin grant/revoke modeline geçilince `Set` fiili (bir enum-değeri "AYARLAMA"yı çağrıştırır) artık anlam taşımıyor; `DesktopSignalConsentGranted`/`Revoked`'ın BİREBİR eşleniği (`Granted`/`Revoked`) daha tutarlı ve kod tabanındaki tek emsalle örtüşüyor.
- **`isAgentAllowedToAccessMemory`'nin bir `MemoryAccessPolicy[]` listesi + `agentIdentifier` alıp içeride araması.** Reddedildi — Karar (l)'ye göre; `(workspaceId, userId, agentIdentifier)` üzerindeki unique-index zaten servis katmanının TEK bir satır okumasını garanti ediyor, fonksiyona arama sorumluluğu yüklemek gereksiz karmaşıklık, `DesktopSignalConsentsService.get`'in tekil-satır dönüş şekliyle tutarsız kalırdı.
- **`agentIdentifier` için sunucu-taraflı bir enum/union tipi (üç bilinen AI çağrı-noktasıyla sınırlamak).** Reddedildi — Karar (a)'ya göre; F3-T1 henüz kurulmadığından onun nihai kimlik şemasını tahmin ederek bir enum kilitlemek şemayı geriye dönük uyumsuz kılma riski taşırdı; boş-olmayan herhangi bir string kabul edilerek ileri-uyumluluk korundu.
- **`MemoryRecordsService`'in per-record `randomUUID()` `streamId` desenini kopyalamak.** Reddedildi — Karar (j)'ye göre; `MemoryRecord`'un aksine, bir politika satırının doğal anahtarı (`workspaceId`+`userId`+`agentIdentifier`) üzerinde GERÇEK bir tekillik kısıtı var (bir kullanıcının bir workspace'te bir ajan-tanımlayıcısı için TEK satırı olmalı) — bu, `DesktopSignalConsentsService`'in deterministik türetiminin doğru eşleşme olduğu tam senaryo.
- **Politika listesinin (`GET /`) yalnızca aktif (`revokedAt IS NULL`) satırları döndürmesi (`MemoryRecordsService.list`'in `deletedAt IS NULL` filtresini kopyalamak).** Reddedildi — Karar (k)'ye göre; bellek KAYDI (içerik) ile politika SATIRI (denetim kaydı) farklı amaçlara hizmet ediyor — kullanıcının "hangi ajanların erişimini ne zaman geri aldım" geçmişini görebilmesi self-service denetlenebilirlik vaadinin bir parçası, filtrelemek bu bilgiyi gizlerdi.
- **Yeni bir `MemoryAccessPolicyModule` açmak.** Reddedildi — mevcut `MemoryModule` (F2-T5, ADR-0022) aynı bounded context'i (bellek), aynı guard/DB/event-store bağımlılıklarını zaten taşıyor; ayrı bir modül gereksiz bölünme, `memory-records`/`memory-access-policy` arasında paylaşılan hiçbir bağımlılık farklılığı yok.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- `DesktopSignalConsentsService` ailesinin (ADR-0020) grant/revoke deseni ikinci kez, farklı bir bounded context'te (bellek) kanıtlanıyor — bu, deterministik-`streamId`+upsert-on-grant+`revokedAt`-ile-revoke desenini kod tabanında TEK-SEFERLİK bir çözüm olmaktan çıkarıp gerçek, tekrarlanabilir bir emsale dönüştürüyor.
- `MemoryAccessPolicy` şemasının grant/revoke-mi-yoksa-allow/deny-mi sorusu koddan önce, tek bir tutarlı gerekçeyle kapatıldı — implementer'ın iki modeli karıştırması ya da gereksiz bir üçüncü durum icat etmesi riski ortadan kalktı.
- `agentIdentifier`'ın v1 semantiği (kısıtlanmamış string, kendine-referans değil ama açık-uçlu) F3-T1'in henüz var olmayan kimlik şemasıyla ÖNCEDEN çakışmadan bırakıldı — ADR-0022'nin `kaynakOlayId` için kurduğu "alan kalır, semantik genişler" deseninin ikinci uygulaması.
- Tek-PR kapsamı (Alt-PR ayrıştırması) F2-T5/F2-T7'nin çok-PR hacmini gerektirmeyecek kadar dar tutuldu — implementer'ın kapsamı gereksiz yere büyütme riski koddan önce sınırlandı.

**Neyi erteliyoruz / kabul ediyoruz:**

- `isAgentAllowedToAccessMemory` şu an için tüketicisiz — hiçbir gerçek AI çağrı-noktası bu fonksiyonu çağırmıyor (Karar c). Bu, ADR-0022'nin `MemoryRecordDeleted`'ı tüketicisiz yayınlama emsaliyle AYNI, bilinçli kabul edilmiş bir YAGNI riski.
- Segment-bazlı granülerlik yok (Karar b) — `MemoryRecord`'un şeması değişmedi, bir politika yalnızca "bu ajan bu kullanıcının belleğine hiç erişebilir mi" sorusuna cevap veriyor; daha ince-taneli bir "hangi kayıtlara" sorusu gelecekteki, kendi şema migration'ını gerektirecek bir göreve bırakıldı.
- Politika yönetimi için UI yok (Karar d) — `agentIdentifier` bugün yalnızca geliştirici/sistem düzeyinde erişilebilir bir kavram; gerçek Agent Runtime gelene kadar son kullanıcı bu politikaları göremiyor/yönetemiyor.
- Organizasyon/workspace-seviyesi bir "override" (kullanıcı grant etse bile bir ajanı engelleme) kavramı bu ADR'nin kapsamında değil — Karar (f)'nin Alternatifler bölümünde not edildiği gibi, ileride gerekirse ayrı bir kavram/ADR olarak ele alınacak, bugünün kullanıcı-seviyesi grant/revoke modeliyle karıştırılmayacak.
