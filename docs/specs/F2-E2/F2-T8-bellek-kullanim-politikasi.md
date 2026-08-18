# F2-T8 — Bellek Kullanım Politikası: Ajan Erişim Manifestoları

**Epik:** F2-E2 (Memory Passport) · **Durum:** Taslak — insan onayına sunuluyor.
**Bağımlılık:** F2-T5 (Memory Passport CRUD backend'i — `apps/server/src/memory/`, `packages/memory`, ADR-0022; merged), F2-T7 (JSON-LD export/import, ADR-0023; merged), ADR-0015 (`konusma-komutlari-ajan-aksiyon-sozlesmesi` — repodaki tek gerçek "ajan aksiyonu" sözleşmesi emsali), `packages/ai-gateway` (tüm AI çağrılarının tek geçidi).

> ⚠️ MİMARİ-KRİTİK GÖREV: CLAUDE.md'nin ADR kriterinin (b) fıkrasına giriyor — bu görevin tanımlayacağı "ajan kimliği" (`agentIdentifier`) ve politika manifestosu şeması, gelecekteki F3-T1 (Agent Runtime, Faz 3) ile UZLAŞMASI gereken bir sözleşim kuruyor; F3-T1 henüz yok, dolayısıyla bu görev bir kimlik şemasını kör noktada tasarlıyor ve F3-T1'in bununla nasıl uzlaşacağı önceden bilinmiyor. Ayrıca görevin adı ("hangi bellek SEGMENTİNE") `MemoryRecord`'da (ADR-0022) hiç var olmayan bir kategorileştirme kavramını varsayıyor — bu ya yeni bir şema alanı eklemeyi (ADR-0022'nin sabitlediği, üç görev tarafından zaten tüketilen bir sözleşmeyi değiştirmek) ya da segment granülerliğinin bilinçli olarak ertelenmesini gerektiriyor. `architect` taslağı + insan onayı koddan önce zorunlu.

## Amaç

Kullanıcının bellek kayıtlarına hangi "ajan"ın (bugün: adlandırılmış bir AI özelliği/çağrı-noktası; gelecekte: gerçek bir Agent Runtime ajanı) erişebileceğini tanımlayan, kullanıcı tarafından denetlenebilir bir politika manifestosu kurmak — Memory Passport'un "kimin bilgime erişebildiğini ben kontrol ederim" vaadinin son parçası (F2-T5 Amaç: "o kullanıcının kendisi tarafından denetlenebilir"). Bu görev F2-E2'yi (Memory Passport) kapatır.

## Mevcut Durum

- **Gerçek bir Agent Runtime YOK.** `packages/ai-gateway`'in tek genel arayüzü `AIProvider.complete(request)` — `{prompt, maxTokens?, model?}` alır, hiçbir çağıran-kimliği/aktör parametresi taşımaz. `apps/server/src/ai/`'deki üç adlandırılmış AI çağrı-noktası (`resolveAIFieldValue` — AI özel alan çözümleme, F1-T5; `answerQuestion`/QA akışı — `apps/server/src/qa/qa.service.ts` üzerinden `SearchService`'in nesne sonuçlarını bağlam olarak kullanır; `parseCommand` — doğal-dil komut ayrıştırma, ADR-0015) bugün birer "ajan" değil, adlandırılmış fonksiyon çağrıları. F3-T1 (Agent Runtime, PLAN.md Faz 3) henüz kurulmadı.
- **Hiçbir mevcut AI özelliği bugün Memory Passport içeriğini prompt'a KATMIYOR.** `resolveAIFieldValue` yalnızca nesnenin kendi `sourceFieldValues`'ını kullanır; QA akışı yalnızca `SearchService`'in workspace nesnesi sonuçlarını kullanır; `parseCommand` yalnızca komut metnini + opsiyonel `sourceObjectId`'yi kullanır. Üçü de `MemoryRecord`'a hiç dokunmuyor — bu, bugün gerçek bir "ajan bellek okuyor" akışının VAR OLMADIĞI, dolayısıyla bir erişim politikasının denetleyeceği gerçek bir uygulama noktasının henüz bulunmadığı anlamına gelir.
- **`MemoryRecord`'da (`packages/memory/src/memory-record.ts`, ADR-0022) hiçbir "segment"/kategori/etiket alanı yok:** `{id, workspaceId, userId, content, kaynakOlayId, createdAt, updatedAt, deletedAt}`. Repo genelinde "segment" grep'i (URL path segmentleri, RRULE/takvim, secret-chunking hariç) sıfır ilgili sonuç veriyor.
- **CLAUDE.md'nin "Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar" değişmezi kısmen somutlaşmış durumda:** `apps/server/src/ai/parse-command.ts`'in `ProposedAction`/`proposedActionSchema`'sı (ADR-0015 §e) tam bu şekli taşıyor (`intent`/`rationale`/`resources`/`rollbackNote`, İngilizce alan adlarıyla) — ama bu, komut-ayrıştırma akışının AKSİYON ÖNERİSİ sözleşmesi, genel bir erişim-politikası/yetkilendirme katmanı değil. Bu görevin manifestosu bu sözleşmeyle karıştırılmamalı, ayrı bir kavram.
- **F2-T5/F2-T6/F2-T7'nin izolasyon deseni zaten var ve bu görevde miras alınacak:** her bellek okuma/yazma işlemi `workspaceId`+`userId` ikilisiyle sınırlı, kimlik her zaman `req.user.id`'den. Bu görevin politika manifestoları da aynı deseni izler — bir kullanıcının politikaları yalnızca kendi bellek kayıtlarını kapsar.

## Kapsam

1. **Politika manifestosu şeması (ADR'de sabitlenir, bkz. Açık Soru 1-2):** kullanıcı başına, `agentIdentifier` (bugün: sabit bir string — adlandırılmış AI çağrı-noktalarından birine karşılık gelir, ör. `"answer-question"`, `"resolve-ai-field-value"`, `"parse-command"`) + `access` (`'allow' | 'deny'`) çiftlerinden oluşan kayıtlar. Segment granülerliği YOK (bkz. Açık Soru 2) — v1'de bir politika kaydı "bu ajan-tanımlayıcı bu kullanıcının TÜM bellek kayıtlarına erişebilir mi" sorusuna cevap verir.
2. **Event tipleri:** `MemoryAccessPolicySet`/`MemoryAccessPolicyRevoked` (geçmiş zaman, CLAUDE.md sözleşmesi), F2-T5'in event-sourced desenini izler — politika değişiklikleri de bir olay günlüğü üzerinden.
3. **Self-service CRUD API'si:** kullanıcının kendi politikalarını listeleme/ayarlama/kaldırma, `DesktopSignalConsentsService`/`MemoryRecordsService` deseniyle tutarlı — kimlik her zaman `req.user.id`'den.
4. **Saf değerlendirme fonksiyonu:** `isAgentAllowedToAccessMemory(policies, agentIdentifier): boolean` — `packages/memory`'de saf TypeScript, framework import yok. Varsayılan davranış (hiç politika tanımlanmamışsa) fail-closed/deny (bkz. Açık Soru 5).
5. **ADR:** `architect` subagent'ı ile ajan kimliği tanımı, segment kararı, varsayılan-deny kararı, gerçek bir AI özelliğine bağlanıp bağlanmayacağı insan onayından önce yazılır.

## Kapsam DIŞI

- **Segment-bazlı granülerlik** — `MemoryRecord`'a yeni bir kategori/etiket alanı eklemek (ADR-0022'nin sabitlediği, üç görev tarafından tüketilen şemayı değiştirmek) bu görevin kapsamı dışı; v1 yalnızca ajan-düzeyinde allow/deny çalışır.
- **Gerçek bir AI özelliğinin (`answerQuestion` vb.) bu politikayı denetleyip bellek içeriğini gerçekten prompt'a katması** — bugün hiçbir AI özelliği bellek içeriğini hiç kullanmıyor; böyle bir bağlantı kurmak "AI özelliklerine bellek bağlamı ekleme" adında ayrı, daha büyük bir görev olurdu. F2-T8 yalnızca politika ŞEMASINI ve saf değerlendirme fonksiyonunu kurar — F2-T5'in "olayı yayınla, gerçek tüketici sonra" deseniyle tutarlı (Memory Passport spec'inin "ajan önbellekleri" notuyla aynı erteleme).
- **Gerçek Agent Runtime (F3-T1)** — henüz yok, Faz 3'e ait.
- **Politika yönetimi UI'ı** — `agentIdentifier` bugün geliştirici/sistem kavramı; son-kullanıcıya anlamlı bir arayüz sunacak kadar somut değil. Gerçek Agent Runtime geldiğinde ayrı bir görev.
- **`parse-command`'ın `ProposedAction` sözleşmesiyle birleştirme** — bu görev ayrı bir kavram (erişim politikası, aksiyon önerisi değil), iki sözleşim birleştirilmez.

## Açık Sorular

1. **[KRİTİK]** "Ajan" kimliği bugün ne anlama gelir? Gerçek bir Agent Runtime yok.
   - **Öneri:** v1'de "ajan", `apps/server/src/ai/`'deki adlandırılmış AI çağrı-noktalarından biri için sabit bir string tanımlayıcı (`agentIdentifier: string`, ör. `"answer-question"`) olarak temsil edilir. Gerçek çoklu-ajan kimlik sistemi F3-T1'e ertelenir; o geldiğinde şema (muhtemelen `agentIdentifier`'ın anlamının genişletilmesiyle, ADR-0022'nin `kaynakOlayId` için yaptığı "alan kalır, semantik genişler" desenine benzer şekilde) yeniden yorumlanabilir.
2. **[KRİTİK]** "Bellek segmenti" bugün ne anlama gelir? `MemoryRecord`'da hiçbir segment alanı yok.
   - **Öneri:** v1'de segment granülerliği YOK. Politika yalnızca "bu ajan-tanımlayıcı kullanıcının TÜM bellek kayıtlarına erişebilir mi" düzeyinde. Segment-bazlı ayrım `MemoryRecord`'a yeni bir alan eklemeyi (ayrı bir şema değişikliği, muhtemelen kendi ADR'si) gerektirir — gelecekteki bir görev.
3. **[KRİTİK]** F2-T8 gerçek bir AI özelliğini bu politikayı denetleyecek şekilde mi bağlar, yoksa yalnızca şema+API+saf değerlendirme fonksiyonunu mu kurar?
   - **Öneri:** Yalnızca şema+API+saf fonksiyon. Hiçbir mevcut AI özelliği bugün bellek içeriğini prompt'a katmıyor; böyle bir bağlantı kurmak F2-T8'in kapsamının çok ötesine geçer.
4. Politika yönetimi için bir UI kurulacak mı?
   - **Öneri:** Hayır — `agentIdentifier` bugün son-kullanıcıya anlamlı olmayan bir sistem kavramı; gerçek Agent Runtime'la birlikte ayrı bir görev.
5. Hiç politika tanımlanmamış bir `agentIdentifier` için varsayılan erişim ne olur?
   - **Öneri:** DENY (fail-closed) — kullanıcı açıkça izin vermediği sürece hiçbir ajan-tanımlayıcı bellek okuyamaz, güvenlik-öncelikli varsayılan.

## Kabul Kriterleri

- [ ] Açık Soru 1-5'in insan kararları ADR'de (numara yazım sırasında teyit edilir) kayıt altına alındı ve `architect` tarafından insan onayından önce taslak olarak sunuldu.
- [ ] `MemoryAccessPolicySet`/`MemoryAccessPolicyRevoked` olayları `DomainEvent` zarfına uyuyor, testli.
- [ ] Politika CRUD API'si yalnızca kaydın SAHİBİ tarafından erişilebilir — başka bir kullanıcının/workspace'in politikasına erişim/düzenleme denendiğinde reddedildiği testli.
- [ ] `isAgentAllowedToAccessMemory` saf fonksiyonu: tanımlı `allow` politikası → true, tanımlı `deny` politikası → false, hiç politika yok → false (fail-closed), testli.
- [ ] Cross-workspace ve cross-user izolasyon security-reviewer tarafından denetlendi (bulgu yok).
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

---

**Sıradaki adım:** Bu spec taslağı insan onayına sunulur. Onaylanırsa Plan Mode'a geçilip keşif `explorer` subagent'ına devredilir, ardından Açık Sorular 1-5'in insan kararları `architect` subagent'ı ile bir ADR taslağına dökülür (numaralandırma yazım sırasında teyit edilir); ADR onaylandıktan sonra `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir. Bu görev tamamlandığında F2-E2 (Memory Passport) epiği kapanmış olur; sıradaki epik F2-E3 (MCP-native Entegrasyon, F2-T9'dan başlar).
