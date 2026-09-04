# F3-T2 — Skill SDK v1: İmzalı Beceri Paketleri, Sürümleme, Yetenek Bildirimi; 20 Birinci Parti Beceri

**Epik:** F3-E1 (Agent Runtime + Skill SDK, Kapsam J) · **Durum:** Planlandı — insan onayı Plan Mode'da alındı, ADR-0036 yazıldı (`docs/adr/ADR-0036-skill-sdk-v1.md`). Bu görev F3-E1'in ikinci görevidir; F3-E1 bu görevden sonra HENÜZ KAPANMAZ (kardeş görev F3-T3 — ajan-insan etkileşimi — beklemede kalır).
**Bağımlılık:** F3-T1/ADR-0035 (`packages/agent-runtime`, `AgentPermissionManifestsService.checkPermission`, `AgentResourceLimitsService.executeAgentAction` — bu görevin TEK entegrasyon noktası, tamamen merge edilmiş: PR1 #191, PR2 #192, PR3 #193).

> ⚠️ MİMARİ-KARAR GEREKTİREN GÖREV — CLAUDE.md'nin ADR kriterine giriyor: yeni bir imzalama şeması (Ed25519 asimetrik imza — bu kod tabanındaki İLK asimetrik imzalama primitifi; mevcut emsaller HMAC-SHA256/AES-256-GCM gibi tamamen simetrik) ve yeni bağımsız bir paket (`packages/skill-sdk/`) birden fazla gelecek göreve (F3-T3, F3-E2) dayatılan bir sözleşim (`SkillManifest`, `Skill<TInput,TOutput>`, `SkillRegistry`) tanımlıyor. `architect`'in bu kararları netleştiren bir ADR taslağı (**ADR-0036**, henüz yazılmadı) + insan onayı koddan önce gerekli.

## Amaç

F3-T1 izin manifestosu + sandbox + kaynak sınırları altyapısını kurdu ama henüz hiçbir tüketicisi yok (kabul edilen v0 riski). Bu görev o altyapının İLK gerçek tüketicisini kurar: ajanların çağırabileceği, imzalı, sürümlenmiş, yetenek bildirimi taşıyan sabit bir "beceri" (skill) kataloğu. Beceriler, mevcut ve zaten test edilmiş servis metotlarının ince (thin) sarmalayıcılarıdır — yeni iş mantığı icat edilmez. Bu görev F3-T3'ün (ajan-insan etkileşimi: @mention, görev atama) üzerine kuracağı çağrılabilir yüzeyi (surface) hazırlar.

## Kapsam

1. **Yeni bağımsız paket `packages/skill-sdk/`** — framework-free (yalnızca `@luminaos/shared` + `zod`'a bağımlı, `packages/agent-runtime`'ın şeklini yansıtır):
   - `SkillManifest` tipi + zod şeması: `id`, `version` (semver-doğrulamalı), `capability` (insan-okunur yetenek dizgisi), `signature` (hex-kodlu Ed25519 imza).
   - `assertValidSemver`.
   - `Skill<TInput, TOutput>` arayüzü: `{ manifest: SkillManifest; execute(input: TInput): Promise<TOutput> }`.
   - `canonicalizeManifestForSigning` — imzalayan VE doğrulayan tarafından ORTAK kullanılır (F2-T16'nın webhook-imzalama dersiyle aynı: kanonikleştirme sapması imza uyuşmazlığına yol açar).
   - `signSkillManifest` / `verifySkillManifestSignature` (Ed25519, Node'un yerleşik `crypto.sign`/`crypto.verify`'ı — yeni bağımlılık yok). `verify*` HİÇBİR girdi için throw etmez — bozuk/eksik alanlarda `false` döner.
   - `SkillRegistry` (`McpConnectorRegistry`'nin şeklini yansıtır): `register()` imza geçersizse veya `id` zaten kayıtlıysa throw eder; `get(id)`, `list()`.
2. **`apps/server/src/skills/` — beceri icra bağlaması:**
   - Checked-in Ed25519 genel anahtar sabiti (özel anahtar asla repoya girmez; imzalayan build/release-zamanı script'i özel anahtarı tutar).
   - `sign-skills.ts` — imzalama script'i (build/release-zamanı).
   - `definitions/` — 20 beceri, alan bazlı 4 dosyaya bölünmüş.
   - `SkillExecutionService.executeSkill(workspaceId, agentIdentifier, skillId, input)` — F3-T1 ile TEK entegrasyon noktası: (1) registry'de beceriyi ara (yoksa 404), (2) `AgentPermissionManifestsService.checkPermission(...)` — beceri kodu çalışmadan ÖNCE geçmeli, fail-closed, (3) `AgentResourceLimitsService.executeAgentAction(...)` gerçek `skill.execute(input)` çağrısını sarar (hız sınırı, eşzamanlılık tavanı, sandbox timeout, en-iyi-çaba denetim kaydı — F3-T1'den değiştirilmeden miras alınır).
   - `SkillsModule`.
   - HTTP controller/route YOK — F3-T3'ün gelecekteki @mention/görev-atama akışının ilk gerçek çağıran olması beklenir.
3. **`.claude/skills/agent-skill-sdk/SKILL.md`** doldurulur (şu an "Faz 3'te doldurulacak" taslağı) — gerçek prosedür + tüm 20 becerinin kayıtlı olduğunu doğrulayan bir uçtan-uca duman testi (smoke test).

## 4 Bağlayıcı İnsan Kararı (bu görevin Plan Mode oturumunda alındı)

1. **Çalışma-zamanı modeli:** beceriler in-process, birinci-parti, derleme-zamanında bağlanmış TypeScript fonksiyonlarıdır. Dinamik kod yükleme YOK (diskten/ağdan üçüncü-parti modül indirip çalıştırma yok). Bu, ADR-0035 Karar (a)'nın ertelenen gerçek OS/VM sandbox kararını KASITLI OLARAK yeniden AÇMAZ — hâlâ gerçekten güvenilmez/üçüncü-parti kod yok, `executeAgentAction`'ın mevcut hafif sandbox'ı (timeout + eşzamanlılık + yapılandırılmış hata izolasyonu) yeterli kalır.
2. **İmzalama şeması:** Ed25519 asimetrik imza (Node'un yerleşik `crypto.sign`/`crypto.verify`'ı, yeni bağımlılık yok) — bu kod tabanındaki İLK asimetrik imzalama primitifi (mevcut emsaller tamamen simetrik: webhook imzalama HMAC-SHA256, secret şifreleme AES-256-GCM). İmzalayan (build/release-zamanı script'i) özel anahtarı tutar; çalışma-zamanı sunucusu YALNIZCA genel anahtara karşı doğrulama yapar. Genel anahtar GİZLİ DEĞİLDİR — sunucu kodunda checked-in bir sabit olarak gömülür; özel anahtar asla repoya girmez.
3. **20-beceri kataloğu kaynağı:** PLAN.md/dokümanlar somut bir liste tanımlamadığı için, 20 beceri MEVCUT, zaten uygulanmış, zaten test edilmiş servis metotlarının ince sarmalayıcılarıdır — yeni iş mantığı icat edilmez.
4. **Kapsam boyutu:** tam kapsam (SDK çekirdeği + 20 becerinin tamamı) bu tek görevde, tek plan onayı altında 6 alt-PR'a bölünmüş olarak.

## Kritik Güvenlik-Sınırı Bulgusu (koddan doğrulandı, tasarım kısıtı/kapsam-dışı olarak korunur)

`commands.service.ts` okunarak doğrulandı: bugünkü `executeCreateTask`/`executeCreateTaskFromMeeting`/`executeCreateTaskFromTrigger`/`executeAssignPeople` HER ZAMAN gerçek insan onaylayanın `actor`/`callerRole`'ünü `ObjectsService`'e taşır — yani mevcut "propose→approve" akışının EXECUTE adımı her zaman bir insan kimliği taşır, AI/tetikleyiciler asla doğrudan icra etmez. Beceri kataloğu bu sınırı GENİŞLETMEK yerine KORUR:

- **Kataloğun DIŞINDA bırakılır:** `CommandsService.decide`, `TriggerSuggestionsService.decide` (insan onay kontrol noktaları); iş yeri-yönetişimi yazma uçları — `AutomationTriggersService.create/update/delete`, `WebhookSubscriptionsService.create/update/remove`, `McpClientGrantsService.grant/revoke` (tek bir çağrının ötesinde kalıcı, sistemik etkileri var: tetikleyici/webhook/kimlik bilgisi oluşturma).
- **Kataloğa DAHİL edilir:** `ObjectsService`'in ajanın kendi izin-manifestosu kapsamındaki doğrudan okuma/yazmaları, ve yalnızca bir `*Proposed`/`*Suggested` olayı üreten AI akışları (gerçek nesne mutasyonundan önce hâlâ insan `decide()`'ı gerektirir).

## Mimari Özet (ADR-0036'da tam resmileşecek)

- **`packages/skill-sdk/`** — framework-free, yalnızca `zod` + `@luminaos/shared`'a bağımlı, `packages/agent-runtime`'ın şeklini yansıtır: `SkillManifest` tipi+şeması (`id`, semver-doğrulamalı `version`, insan-okunur `capability`, hex Ed25519 `signature`), `assertValidSemver`, `Skill<TInput,TOutput>` arayüzü (`{manifest, execute(input): Promise<TOutput>}`), `canonicalizeManifestForSigning` (imzalayan VE doğrulayan tarafından ortak kullanılır — F2-T16'nın webhook-imzalama dersiyle aynı imza-uyuşmazlığı-sapması önlemi), `signSkillManifest`/`verifySkillManifestSignature` (Ed25519, `verify` hiçbir zaman throw etmez — bozuk girdide `false` döner), `SkillRegistry` (`McpConnectorRegistry`'yi yansıtır: `register()` imza geçersiz veya `id` zaten kayıtlıysa throw eder, `get`, `list`).
- **`apps/server/src/skills/`**: checked-in Ed25519 genel anahtar sabiti; `definitions/` (alan bazlı 4 dosyaya bölünmüş 20 beceri); `SkillExecutionService.executeSkill(workspaceId, agentIdentifier, skillId, input)` — F3-T1 ile TEK entegrasyon noktası: (1) registry'de beceriyi ara (yoksa 404), (2) `AgentPermissionManifestsService.checkPermission(...)` — beceri kodu çalışmadan ÖNCE geçmeli, fail-closed, (3) `AgentResourceLimitsService.executeAgentAction(...)` gerçek `skill.execute(input)` çağrısını sarar (hız sınırı, eşzamanlılık tavanı, sandbox timeout, en-iyi-çaba denetim kaydı — F3-T1'den değiştirilmeden miras alınır). HTTP controller/route YOK (F3-T3'ün gelecekteki @mention/görev-atama akışının ilk gerçek çağıran olması beklenir).
- ADR-0036 bunların tamamını resmileştirecek — yazıldığında burada referans verilecek (henüz architect'ten beklemede).

## 20-Beceri Kataloğu (kesin)

| #   | Beceri id / actionType            | Sarmaladığı Metot                              | Tür                                                              |
| --- | --------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `create-object`                   | `ObjectsService.create`                        | Yazma (ajanın `dataScope`'u içinde)                              |
| 2   | `get-object`                      | `ObjectsService.get`                           | Okuma                                                            |
| 3   | `query-objects`                   | `ObjectsService.query`                         | Okuma                                                            |
| 4   | `set-field-values`                | `ObjectsService.setFieldValues`                | Yazma                                                            |
| 5   | `add-checklist-item`              | `ObjectsService.addChecklistItem`              | Yazma                                                            |
| 6   | `toggle-checklist-item`           | `ObjectsService.toggleChecklistItem`           | Yazma                                                            |
| 7   | `schedule-time-block`             | `ObjectsService.scheduleTimeBlock`             | Yazma                                                            |
| 8   | `refresh-ai-field`                | `ObjectsService.refreshAIField`                | Yazma (kendi AI kotası/kilit kontrolleri zaten var)              |
| 9   | `set-recurrence-rule`             | `ObjectsService.setRecurrenceRule`             | Yazma                                                            |
| 10  | `generate-next-recurrence`        | `TaskRecurrenceService.generateNextOccurrence` | Yazma (idempotent)                                               |
| 11  | `invite-meeting-bot`              | `MeetingsService.inviteBot`                    | Yazma                                                            |
| 12  | `get-meeting-details`             | `MeetingsService.getMeetingDetails`            | Okuma (zaten rol-filtrelenmiş alanlar)                           |
| 13  | `get-object-context`              | `ContextService.getContext`                    | Okuma                                                            |
| 14  | `search-connected-sources`        | `ConnectedSearchService.searchExternal`        | Okuma                                                            |
| 15  | `list-cached-calendar-events`     | `CalendarEventsService.listCachedEvents`       | Okuma                                                            |
| 16  | `answer-question`                 | `ai/answer-question.ts` (`answerQuestion`)     | Okuma (saf AI, DB yan etkisi yok)                                |
| 17  | `parse-command`                   | `CommandsService.parse`                        | Yalnızca-öneri (insan onayı gerektiren `ActionsProposed` üretir) |
| 18  | `propose-actions-from-meeting`    | `CommandsService.proposeFromMeeting`           | Yalnızca-öneri                                                   |
| 19  | `run-trigger-suggestion-analysis` | `TriggerSuggestionsService.runAnalysis`        | Yalnızca-öneri (`TriggerTemplateSuggested` üretir)               |
| 20  | `list-command-proposals`          | `CommandsService.listProposals`                | Okuma                                                            |

## PR Bölünmesi (6 PR, tek plan onayı hepsini kapsar)

1. **PR1:** `packages/skill-sdk` çekirdeği + tam birim test paketi.
2. **PR2:** `apps/server/src/skills/` bağlama iskeleti (`SkillExecutionService`, `SkillsModule`, genel anahtar, `sign-skills.ts` script'i) — henüz gerçek beceri yok, test-çifti (test-double) becerilerle test edilir.
3. **PR3:** `object-skills.ts` — 1-9 numaralı beceriler.
4. **PR4:** `meeting-recurrence-skills.ts` (10-12) + `context-search-calendar-skills.ts` (13-15) — toplam 6 beceri.
5. **PR5:** `ai-command-skills.ts` — 16-20 numaralı beceriler.
6. **PR6:** `.claude/skills/agent-skill-sdk/SKILL.md`'nin doldurulması (gerçek prosedür) + 20 becerinin tamamının kayıtlı olduğunu doğrulayan uçtan-uca duman testi.

## Kapsam DIŞI

- **`CommandsService.decide` / `TriggerSuggestionsService.decide`:** insan onay kontrol noktaları — bu görevde beceri sarmalayıcısı YOK (yukarıdaki "Kritik Güvenlik-Sınırı Bulgusu"na bakın).
- **İş yeri-yönetişimi yazma uçları:** `AutomationTriggersService.create/update/delete`, `WebhookSubscriptionsService.create/update/remove`, `McpClientGrantsService.grant/revoke` — kalıcı/sistemik etkili, bu görevde beceri sarmalayıcısı YOK.
- **Dinamik kod yükleme:** diskten/ağdan üçüncü-parti modül indirip çalıştırma — yukarıdaki İnsan Kararı 1'e bakın, kasıtlı olarak bu görevde YOK.
- **Gerçek OS/VM sandbox'ı:** ADR-0035 Karar (a)'nın ertelediği karar bu görevde yeniden AÇILMAZ — yukarıdaki İnsan Kararı 1'e bakın.
- **HTTP controller/route:** beceriler bu görevde dışarıdan HTTP ile tetiklenemez — F3-T3'ün gelecekteki @mention/görev-atama akışı ilk gerçek çağıran olacak.
- **F3-T3 (Ajan-insan etkileşimi):** @mention, görev atama, DM ile ajan yeniden yapılandırma — F3-E1'in kardeş görevi, bu görevde YOK.

## Kabul Kriterleri

- [ ] İmza doğrulama: geçerli imza kabul edilir; kurcalanmış/yanlış-anahtarla imzalanmış manifesto reddedilir; `SkillRegistry` imzasız/geçersiz-imzalı hiçbir beceriyi ASLA kabul etmez (`register()` throw eder).
- [ ] Her beceri çağrısı `skill.execute` ÇALIŞMADAN ÖNCE `checkPermission`'dan geçer — izin reddedildiğinde altta yatan servis metodu HİÇ ÇAĞRILMAZ (testte bir spy ile kanıtlanabilir).
- [ ] F3-T1'in hız sınırı / eşzamanlılık tavanı / sandbox timeout'u her beceri çağrısına tekdüze uygulanır.
- [ ] Cross-workspace izolasyon her beceri için geçerlidir (bir workspace'in ajanı başka bir workspace'in verisine/becerisine erişemez).
- [ ] Hariç-tutulan uçlar listesinin (decide/yönetişim-yazmaları) sıfır beceri sarmalayıcısı vardır — bu açık, test edilebilir/gözden geçirilebilir bir kapsam-dışı olarak doğrulanır.
- [ ] `assertValidSemver` geçersiz sürüm dizgilerini reddeder; `canonicalizeManifestForSigning` imzalayan ve doğrulayan tarafında birebir aynı çıktıyı üretir (kanonikleştirme sapması yok).
- [ ] `verifySkillManifestSignature` bozuk/eksik/yanlış-tipte girdide throw ETMEZ, `false` döner.
- [ ] 20 becerinin TAMAMI registry'de kayıtlıdır ve `.claude/skills/agent-skill-sdk/SKILL.md`'nin uçtan-uca duman testiyle doğrulanır.
- [ ] `security-reviewer` denetiminde bulgu yok (özellikle: imza doğrulamanın bypass edilemediği, `checkPermission`'ın atlanamadığı, yalnızca-öneri becerilerinin gerçek mutasyon üretmediği, cross-workspace sızıntısı olmadığı).
- [ ] `pnpm --filter @luminaos/skill-sdk build/typecheck/test` yeşil.
- [ ] `pnpm --filter @luminaos/server typecheck/lint/test` yeşil.

## Açık Sorular

- ADR-0036 taslağında Ed25519 anahtar rotasyonu (genel anahtar sabiti değiştiğinde eski imzalı beceri paketlerinin ne olacağı) ele alınmalı mı, yoksa v0 riski olarak ertelenebilir mi? (F3-T1'in consumerless-v0 emsaliyle paralel bir karar olabilir.)
- `sign-skills.ts` script'inin özel anahtarı nereden okuyacağı (env değişkeni mi, yerel dosya mı) — CI'da bu script'in çalışıp çalışmayacağı, yoksa yalnızca yerel/release-zamanı elle mi çalıştırılacağı ADR-0036'da netleştirilmeli.

---

**Sıradaki adım:** Spec + ADR-0036 ikisi de tamamlandı. Sıradaki adım PR1 için `test-writer`'ı çağırmak (`packages/skill-sdk` çekirdeği — `SkillManifest` tipi/şeması, `assertValidSemver`, `canonicalizeManifestForSigning`, `signSkillManifest`/`verifySkillManifestSignature`, `Skill<TInput,TOutput>`, `SkillRegistry`):

```
docs/adr/ADR-0036-skill-sdk-v1.md'deki Karar (a)-(g)'yi ve bu spec dosyasının
Kabul Kriterleri'ni temel alarak, F3-T2 PR1 (packages/skill-sdk çekirdeği:
SkillManifest tipleri, assertValidSemver, canonicalizeManifestForSigning,
signSkillManifest/verifySkillManifestSignature, Skill<TInput,TOutput>, SkillRegistry)
için test-writer ile başarısız testleri yaz.
```
