# ADR-0014: `AIUsageService` Çıkarımı — Kota/Kilit/Kullanım-Kaydı Mantığının `ObjectsService`'ten Paylaşılan Bir Servise Taşınması

**Durum:** Kabul edildi
**Tarih:** 2026-08-09
**İlgili görev:** [F1-T15 — Soru-Cevap: Workspace Bağlamıyla RAG + Kaynak Gösterimi](../specs/F1-E4/F1-T15-soru-cevap-rag.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E4" (F1-T15 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesi — ikinci fıkra: "Karar birden fazla pakete veya gelecekteki görevlere dayatılan bir sözleşim tanımlıyorsa." F1-T15'in onaylı planı (kullanıcı onayı alınmış plan dosyası, "Netleşen Kararlar" §2), bu çıkarımı zaten kararlaştırdı; bu ADR o kararı koddan önce biçimsel olarak belgeliyor ve CLAUDE.md'nin ADR ritüelinin gerektirdiği AYRI insan onayını topluyor — plan onayının kapsadığı genel "proceed?" onayından bağımsız bir adım.

> Bu karar, CLAUDE.md'nin birinci ADR kriterine (Mimari Değişmezler'den birine dokunma — event-sourcing, ajan-aksiyon sözleşmesi, veri dışa aktarma, hibrit-AI gerilimi) DOKUNMUYOR; sınırda olduğu yer ikinci kriter. `AIUsageService`'in taşınan dört metodu bugün yalnızca `ai-field-refresh` akışının private uygulama detayı, ama F1-T16 (konuşma komutları — `docs/PLAN.md` satır 229, çok-adımlı ajan aksiyonları) F1-T15'le birebir aynı ihtiyaca sahip olacak: field-refresh'e bağlı olmayan bir tamamlama çağrısını kota kontrolünden geçirmek, eşzamanlılık kilidiyle korumak, kullanımını kaydetmek. Bu, `AIUsageService`'in sözleşimini tek-seferlik bir iç refactor'den çıkarıp en az üç görev arası (F1-T5/T14'ün orijinal ai-field-refresh akışı, F1-T15'in QA akışı, F1-T16'nın konuşma-komutu akışı) paylaşılan, dayanıklı bir kontrata dönüştürüyor — bu nedenle koddan önce insan onayı gerektiriyor.

## Bağlam

F1-T14 (`ai-gateway`: model yönlendirme + maliyet/kota ölçümü), kota kontrolü/eşzamanlılık kilidi/kullanım-kaydı mantığının tamamını `ObjectsService`'in (`apps/server/src/objects/objects.service.ts`) PRIVATE metotları olarak inşa etti:

1. **`withWorkspaceAILock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>`** (satır 1113-1127) — `pg_advisory_lock(hashtext(workspaceId))` ile, aynı workspace için eşzamanlı iki refresh operasyonunun aynı kota-öncesi toplamı okuyup ikisinin de geçmesini (TOCTOU) engelleyen, ayrı bir pool bağlantısı üzerinde tutulan session-seviyeli kilit.
2. **`assertAITokenQuotaNotExceeded(workspaceId: string): Promise<void>`** (satır 1180-1193) — `ai_usage_records` üzerinde `SUM(inputTokens + outputTokens)` ile `env.aiTokenQuotaPerWorkspace`'i aşan workspace'ler için `QuotaExceededError` fırlatır.
3. **`assertAICostBudgetNotExceeded(workspaceId: string): Promise<void>`** (satır 1204-1217) — aynı desende, `SUM(costUsd)` ile `env.aiCostBudgetUsdPerWorkspace`.
4. **`recordAIUsage(workspaceId: string, fieldDefinitionId: string, objectId: string, usage: AITokenUsage, model: string): Promise<void>`** (satır 1232-1268) — `AIUsageRecorded` olayını kendi ayrı stream'inde (`AI_USAGE_STREAM_TYPE`) append eder, `AIUsageProjection`'ı (`ai-usage.projection.ts`) `catchUp` ile ileri sürer; best-effort'tur (asla fırlatmaz — zaten üretilmiş bir AI alan değerini geri almaz).

Bu dört metot, `performAIFieldRefresh` (satır 1039-1093) tarafından `withWorkspaceAILock`'un içinde sırayla çağrılıyor. `ai_usage_records` şeması (`apps/server/src/db/schema/ai-usage.ts:24-25`) `fieldDefinitionId`/`objectId`'yi **NOT NULL** tutuyor — bu iki alan, `AIUsageRecorded` olayının bir alan-yenileme (field-refresh) çağrısından geldiği varsayımını şemaya sabitliyor. `AIUsageProjection.apply()` (`apps/server/src/ai/ai-usage.projection.ts:106-107`) de aynı varsayımı `requireStringPayloadField(event, 'fieldDefinitionId')`/`requireStringPayloadField(event, 'objectId')` ile zorluyor — payload'da bu alanlar eksikse projeksiyon fırlatır.

F1-T15'in soru-cevap (QA) akışı, hiçbir alana veya nesneye bağlı olmayan, workspace-seviyeli bağımsız bir tamamlama (completion) çağrısıdır: kullanıcı bir soru sorar, retrieval pasajları döner, `ai-gateway` üzerinden bir cevap üretilir. Bu çağrının da aynı kota/kilit/denetim disiplinine tabi olması gerekir (aksi halde QA akışı, field-refresh akışının zaten kapattığı bir aşımı bypass eden ikinci, tutarsız bir kota yolu olurdu) — ama bugünkü dört metot hem `ObjectsService`'in private'ı olduğu için hem de `recordAIUsage`'ın zorunlu `fieldDefinitionId`/`objectId` parametreleri yüzünden QA akışından doğrudan çağrılamaz.

## Karar

### (a) `AIUsageService` çıkarımı — dört metot, DI ile enjekte edilen ayrı bir servis, davranış-koruma testle kanıtlanır

Yeni **`apps/server/src/ai/ai-usage.service.ts`** dosyasında, `@Injectable()` bir `AIUsageService` sınıfı tanımlanır. Taşınan dört metot PUBLIC olur, imzaları aynı kalır — tek istisna, `recordAIUsage`'ın `fieldDefinitionId`/`objectId` parametrelerinin **opsiyonel** hale gelmesi (§b'nin nullable-kolon kararının doğal sonucu):

```ts
class AIUsageService {
  async withWorkspaceAILock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>;
  async assertAITokenQuotaNotExceeded(workspaceId: string): Promise<void>;
  async assertAICostBudgetNotExceeded(workspaceId: string): Promise<void>;
  async recordAIUsage(
    workspaceId: string,
    fieldDefinitionId: string | undefined,
    objectId: string | undefined,
    usage: AITokenUsage,
    model: string,
  ): Promise<void>;
}
```

Servisin kendi `AIUsageProjection` örneği (bugünkü `ObjectsService.aiUsageProjection` alanının — satır 171 — "tek, kararlı örnek" mirası) ve constructor bağımlılıkları (`DATABASE_CONNECTION`, `EventStoreService`, `ProjectionRunner`) `ObjectsService`'in bugünkü constructor'ından (satır 178-188) birebir taşınır — yeni bir bağımlılık icat edilmez.

`ObjectsService`, `AIUsageService`'i constructor injection ile alır (`ai-provider.module.ts`'nin `AI_PROVIDER` deseni gibi bir DI token'a gerek yok — sıradan bir sınıf sağlayıcısı yeterli, `TaskRecurrenceService`/`WorkspaceMembershipService`'in bugün `objects.module.ts:29-31`'de sağlandığı şekilde) ve dört private metodunu (satır 1113-1268) silip çağrı noktalarını (`performAIFieldRefresh`, satır 1051-1052 ve 1068) `this.aiUsageService.<metot>(...)`'a delege eder. `AIUsageService`, yeni bir **`apps/server/src/ai/ai-usage.module.ts`**'te `providers`+`exports` edilir; `ObjectsModule` bu modülü `imports`'a ekler. Bu, gelecekteki bir `QAModule`'ün (F1-T15 PR4) ve olası bir gelecekteki konuşma-komutu modülünün (F1-T16) aynı `AIUsageModule`'ü bağımsız olarak import edebilmesini sağlar — `AIProviderModule`'ün bugünkü paylaşılabilir modül deseniyle birebir aynı.

**Davranış-koruma kanıtı:** Bu bir refactor'dür, davranış değişikliği DEĞİL — kanıtı, `object-ai-refresh.integration.test.ts`'in TEK BİR satırı bile değişmeden yeşil kalmasıdır. Bu paket zaten kilit-yarışı (concurrent refresh), kota-aşımı ve kullanım-kaydı senaryolarını uçtan uca (gerçek Postgres) doğruluyor; taşıma sonrası aynı testlerin aynı assertion'larla geçmesi, dört metodun semantiğinin (SQL sorguları, kilit sırası, hata tipi, best-effort kayıt) DEĞİŞMEDEN aktarıldığının doğrudan kanıtıdır. Ek olarak `AIUsageService`'in kendi birim testleri (kota sınırının tam eşiğinde davranış, kilit içinde `fn` fırlatırsa unlock'un yine de çalışması) eklenir.

Ayrıca `AIUsageProjection.apply()` (`ai-usage.projection.ts:106-107`), `fieldDefinitionId`/`objectId` için `requireStringPayloadField` yerine bir `optionalStringPayloadField` çağırısına geçirilir (dosyada zaten `model`/`costUsd` için kullanılan yardımcı — satır 110-111) — aksi halde QA kaynaklı, bu iki alanı taşımayan bir `AIUsageRecorded` olayı projeksiyonda fırlatır. Bu, §b'nin şema kararının PR2 kapsamında zorunlu kıldığı bir eşlik değişikliğidir.

### (b) `ai_usage_records.fieldDefinitionId`/`objectId` nullable — F1-T14 PR2 migration konvansiyonuyla birebir aynı desen

`apps/server/src/db/schema/ai-usage.ts:24-25`'teki iki sütun, `.notNull()` kısıtından çıkarılır. Migration, F1-T14 PR2'nin `apps/server/src/db/migrations/0019_thick_the_liberteens.sql` + `apps/server/src/db/migrations/down/0019_thick_the_liberteens.down.sql` çiftiyle **birebir aynı konvansiyonu** izler: geriye dönük uyumlu, tek-yönlü bir `ALTER COLUMN ... DROP NOT NULL` (0019'un `ADD COLUMN` ile nullable bir sütun eklemesinin ayna-görüntüsü — burada var olan bir NOT NULL kısıtı kaldırılıyor), down-script'i kısıtı geri NOT NULL yapmaya ÇALIŞMAZ (0019'un down'ının yalnızca `DROP COLUMN IF EXISTS` yapıp veri kaybı riskini üstlenmemesiyle aynı disiplin — burada da mevcut satırların hiçbiri NULL olmayacağından bir "geri NOT NULL yap" adımı güvenle atlanabilir, ama üretim ortamında migration sonrası eklenmiş QA-kaynaklı NULL satırlar varsa down script'in çalışması NOT NULL kısıtını asla zorla geri getirmemelidir — implementer bunu migration dosyasının kendi yorumunda teyit eder).

QA kullanım kayıtları (`AIUsageService.recordAIUsage` QA çağrı sitesinden `fieldDefinitionId`/`objectId` olmadan çağrıldığında) bu iki alanı `NULL` bırakır. `assertAITokenQuotaNotExceeded`/`assertAICostBudgetNotExceeded`'ın `SUM(...)` sorguları workspace-seviyeli agregasyon yaptığından (satır 1183, 1207 — `WHERE workspace_id = :id`, alan/nesne bazında değil) bu iki sorgu NULL `fieldDefinitionId`/`objectId`'den ETKİLENMEZ; kota, alan-refresh ve QA kaynaklı kullanımı aynı workspace-seviyeli havuzda doğru şekilde birleştirir.

### (c) Pasaj-seviyeli retrieval — `search_index.docText`'in SELECT'e eklenmesi (şema değişikliği yok, ayrı ADR yok)

F1-T15 planının "Netleşen Kararlar" §1'inde ayrıntılandırıldığı gibi: keşif, `search_index.docText`'in (`apps/server/src/db/schema/search-index.ts`) ADR-0013'ün varsaydığının aksine KALICI olarak saklandığını doğruladı. `SearchService.search()`'ün iki private candidate-fetch metodu `.select()` projeksiyonlarına `docText`'i ekler; birleştirme sonrası `buildSnippet(docText, maxLength)` (yeni, saf yardımcı) ile `SearchResult.snippet: string` üretilir — mevcut çağıranlar için geriye dönük uyumlu, EKLENEN bir alan. Bu, kendi başına bir ADR-tetikleyici karar DEĞİLDİR (ne şema değişiyor ne yeni bir kontrat dayatılıyor); yalnızca bu ADR'nin doğal olarak (b)'nin yanında kayıt altına alınacağı yer olduğu için burada belgeleniyor.

### (d) pgvector — ADR-0013'ün kararı AYNEN miras alınır, yeniden açılmıyor

ADR-0013 §a'nın kararı (`embedding` sütunu native `real[]`, kosinüs benzerliği Node uygulama katmanında; pgvector extension'ı YOK) F1-T15 tarafından yeniden değerlendirilmiyor. Veri hacmi varsayımı (workspace başına küçük korpus, tam-tarama kosinüs hesaplamasını pahalı kılmayan ölçek) değişmedi; F1-T15 de F1-T13 gibi yalnızca `MockEmbeddingProvider`'a karşı bağlanıyor, gerçek bir bulut embedding sağlayıcısı hâlâ yok. Bu ADR, ADR-0013'ün kararının bu görev için de geçerli olduğunu formel olarak teyit eder — yeni bir analiz veya alternatif değerlendirmesi gerektirmez.

## Alt-PR ayrıştırması (kayıt amaçlı)

Bu ADR, F1-T15'in onaylı planındaki dört alt-PR'dan yalnızca **PR2**'yi doğrudan kapsıyor (diğerleri bu ADR'nin kararlarına bağımlı değil, ADR onayı beklemeden ilerleyebilir):

- **PR1** — `apps/server/src/search`: pasaj/snippet genişletmesi (§c) — bu ADR'nin onayına bağımlı DEĞİL.
- **PR2** — `apps/server/src/ai`: `AIUsageService` çıkarımı (§a) + `ai_usage_records` nullable migration (§b). **Bu ADR onaylanmadan test-writer/implementer turu başlamaz** (CLAUDE.md ADR ritüeli).
- **PR3** — `apps/server/src/ai`: QA tamamlama fonksiyonu (`answerQuestion`) + `selectAIModel`'in `outputType` union'ına `'qa'` eklenmesi — PR2'nin çıkardığı `AIUsageService`'i tüketir ama kendi başına yeni bir mimari karar taşımaz.
- **PR4** — `apps/server/src/qa`: `QAService`/`QAController`/DTO — PR1+PR2+PR3'ü birleştiren uç nokta.

## Alternatifler ve Reddedilme Gerekçeleri

- **Kota/kilit/kayıt mantığını QA'ya özgü ayrı bir serviste yinelemek (duplicate).** Reddedildi — `withWorkspaceAILock`/iki `assert*`/`recordAIUsage` toplam ~80 satırlık, ince ayarları (advisory-lock hash'i, `COALESCE(..., 0)` ile NULL-güvenli agregasyon, best-effort hata yutma) olan bir mantığı iki yerde bit-bit aynı tutmak gerektirirdi; ilk sapma (ör. yalnızca birinde bir kota sınırı düzeltmesi yapılması) iki akış arasında sessizce tutarsız bir kota davranışına yol açardı. Üstelik F1-T16 (konuşma komutları) aynı ihtiyaca üçüncü kez sahip olacak — iki kopya bugün, üç kopya yarın demek. Çıkarım, tek doğruluk kaynağını korur ve F1-T16'nın sıfır ek maliyetle aynı servisi tüketmesini sağlar.
- **`ObjectsService`'i olduğu gibi bırakıp `QAService`'in `ObjectsService`'e (private metotlara erişmek için) bağımlı olması.** Reddedildi — private metotlara erişim zaten mümkün değil (TypeScript görünürlüğü) ve mümkün olsaydı bile `QAService`'i nesne/alan alan-adına özgü bir servise bağımlı kılmak, kavramsal olarak yanlış bir bağımlılık yönü kurardı (QA, nesnelerle değil workspace-seviyeli AI kotasıyla ilgilidir). `AIUsageService`'in kendi modülü, bu bağımlılığı doğru yöne çevirir: hem `ObjectsService` hem `QAService` (hem gelecekte F1-T16'nın servisi) `AIUsageService`'e bağımlı olur, birbirlerine değil.
- **pgvector'ı şimdi yeniden değerlendirmek.** Reddedildi — ADR-0013'ün veri-hacmi/karmaşıklık ödünleşimini değiştiren hiçbir yeni kanıt yok; F1-T15 hâlâ yalnızca `MockEmbeddingProvider`'a karşı doğrulanıyor. Yeniden açmak, ADR-0013'ün kendi "gelecek-ölçek notu"nun öngördüğü zamandan önce gereksiz bir mimari maliyet üstlenmek olurdu.
- **`recordAIUsage`'ın `fieldDefinitionId`/`objectId` parametrelerini zorunlu bırakıp QA çağrı sitesine sahte/placeholder bir ULID geçirmek.** Reddedildi — bu, `ai_usage_records`'ta anlamsız, hiçbir gerçek nesneye/alana karşılık gelmeyen bir yabancı-anahtar benzeri değer üretir; ileride bu tabloyu nesne/alan bazında raporlayan herhangi bir sorgu (bugün yok, ama makul bir gelecek ihtiyaç) sessizce yanlış sonuç verir. Parametreleri gerçekten opsiyonel yapıp sütunu nullable'a çevirmek, "bu kullanım bir alana/nesneye bağlı değildi" gerçeğini şemada dürüstçe temsil eder.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- Kota kontrolü, eşzamanlılık kilidi ve kullanım-kaydı için TEK bir doğruluk kaynağı (`AIUsageService`) — F1-T15'in QA akışı ve F1-T5/T14'ün ai-field-refresh akışı aynı kod yolunu, aynı garantilerle paylaşır.
- F1-T16 (konuşma komutları) bu servisi sıfır ek mimari maliyetle tüketebilir — `AIUsageModule`'ü import etmek yeterli, kota/kilit mantığını yeniden icat etmesi gerekmez.
- `object-ai-refresh.integration.test.ts`'in değişmeden geçmesi, refactor'un davranış-koruyucu olduğunu, spekülatif bir iddia değil, çalıştırılabilir bir kanıt olarak bırakıyor.
- Pasaj-retrieval (§c) ve pgvector (§d) kararları, F1-T13/ADR-0013'ün üzerine hiçbir yeni karmaşıklık eklemeden, mevcut altyapının aynen mirası olarak kayıt altına alınıyor.

**Neyi kabul ediyoruz / erteliyoruz:**

- `ai_usage_records`'ta `fieldDefinitionId`/`objectId`'nin nullable olması, bu tabloyu sorgulayan gelecekteki herhangi bir kodun (bugün yok) bu iki alanın NULL olabileceğini hesaba katması gerektiği anlamına gelir — bu, F1-T14 PR2'nin `model`/`cost_usd` için zaten kurduğu "nullable sütun + `COALESCE`" konvansiyonunun doğal bir devamı, yeni bir risk sınıfı değil.
- `AIUsageProjection`'ın `requireStringPayloadField`'dan `optionalStringPayloadField`'a geçen iki alanı, projeksiyonun hata-yüzeyini küçük ölçüde genişletiyor (artık bu iki alanın eksikliği bir hata değil) — kabul edilebilir, çünkü QA kaynaklı kayıtlar için eksiklik beklenen ve doğru davranış.
- Gerçek bir bulut embedding sağlayıcısı ve pgvector migration'ı, ADR-0013'te olduğu gibi ayrı gelecek görevlere ertelenmeye devam ediyor; bu ADR o ertelemeyi yeniden onaylıyor, kapatmıyor.
