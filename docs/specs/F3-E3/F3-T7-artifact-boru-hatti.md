# F3-T7 — Artifact Boru Hattı: Sunum/Dashboard/Sayfa Üretimi, Marka Temaları, Tek Prompt Akışı

**Epik:** F3-E3 (Artifact + Canlı Widget [Kapsam L] ve Intent-first UI [Kapsam M]) · **Durum:** PLANLANDI — Epik F3-E3'ün İLK görevi, F3-E2'den (Cam Kutu Otonomi, ADR-0037/38/39/40) TAMAMEN bağımsız, yeni bir Kapsam'ın ilk görevi. Mimari karar `docs/adr/ADR-0041-artifact-boru-hatti.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** Hiçbir önceki F3-T görevine bağımlı değil (kendi başına, temiz bir başlangıç) — ama `parseCommand`/`AIUsageService`'in ZATEN kurulu AI-üretim disiplinini (kota/kilit/`selectAIModel`) üçüncü bir çağıran olarak kullanır, DEĞİŞTİRMEDEN.

## Amaç

Bugün kod tabanında hiçbir uzun-form/çok-bölümlü AI üretim emsali, hiçbir HTML/PDF render kütüphanesi, hiçbir per-workspace markalama, hiçbir blob depolama YOK (`packages/artifacts`/`packages/view-engine` ikisi de `docs/PLAN.md`'de vaat edilmiş ama hiç oluşturulmamış). Bu görev, tek bir doğal-dil promptundan (sunum/dashboard/sayfa/rapor) öz-yeterli bir HTML artifact üreten YENİ bir boru hattı kurar — ADR-0041 Karar (a)-(h)'de tam sabitlendi.

## Kapsam

1. `packages/artifacts` YENİ paketi — `ArtifactType`, `ThemePreset`/`THEME_PRESETS` (3 preset), `ArtifactContent`/`artifactContentSchema` (yapılandırılmış içerik şeması), `renderArtifactHtml` (SAF, I/O'suz HTML şablon render fonksiyonu, `escapeHtml` dahil) (Karar a/c/d/e).
2. `apps/server/src/artifacts/` — `generate-artifact.ts` (orkestratör: LLM'den yapılandırılmış içerik ister, `renderArtifactHtml`'e sarmalatır), `artifacts.service.ts` (`AIUsageService`+`ObjectsService` enjekte eder, gerçek `artifact` Lumina Object'i yaratır), `artifacts.controller.ts` (`POST /workspaces/:workspaceId/artifacts`), `artifacts.module.ts` (Karar a/c/g/h).
3. `packages/core-objects`'e `ObjectType` union'ına `'artifact'` eklenmesi (`object-type-registry.ts`'e `titleRequired:true` girdisi) — HİÇBİR migration gerektirmez, yalnızca kod (Karar b).
4. Workspace-kurulum-anındaki default-field-seeding mekanizmasına `artifact` için 4 alan eklenmesi: `htmlContent`(`longText`), `themePreset`(`select`, 3 preset), `generationPrompt`(`longText`), `artifactType`(`select`, 4 tip) (Karar b).
5. `select-ai-model.ts`'e yeni `outputType:'artifact'` eklenmesi (`CLAUDE_SONNET_5`'e yönlendirilir) (Karar c).
6. `apps/web`'e YENİ `ArtifactViewer.tsx` bileşeni — sandboxed `<iframe srcDoc={htmlContent} sandbox="">` render mekanizması (Karar d).
7. Yazma-anı boyut sınırı: `MAX_ARTIFACT_HTML_LENGTH=200_000` karakter, `generateArtifact`'ın kendisinde uygulanır (Karar b).
8. Frontend: artifact üretimi için basit bir istek formu (prompt + artifactType + themePreset seçimi) + üretilen artifact'ı `ArtifactViewer` ile gösteren bir görünüm — spesifik UI konumu implementer'ın kararı (yeni bir sayfa mı, mevcut bir panel mi — spec bunu zorunlu kılmaz, ADR de bunu detaylandırmadı, PR3'ün kendi kapsamında netleşir).

## 4 Bağlayıcı İnsan Kararı

- **v0 çıktı biçimi: yalnızca öz-yeterli HTML.** PDF/PowerPoint export YOK — yeni, ağır bir render bağımlılığı (puppeteer vb.) gerektireceği için AÇIKÇA reddedildi (ADR-0041 insan kararı 1).
- **v0 depolama: yeni `artifact` Lumina Object tipi, Postgres'te.** Gerçek S3/blob depolama YOK — MEVCUT event-kaynaklı nesne altyapısı kullanılır, ayrı bir gelecekteki karara ertelenir (ADR-0041 insan kararı 2).
- **v0 marka temaları: küçük, sabit 3 preset.** Gerçek per-workspace özel markalama (logo yükleme, özel renk seçici) YOK — dosya-depolama gerektirir, karar 2 tarafından bloklanır (ADR-0041 insan kararı 3).
- **(İkinci doğrulama turu) LLM ham HTML/CSS/JS ÜRETMEZ — yalnızca yapılandırılmış içerik üretir, HTML'i kod-yazılı deterministik bir şablon üretir.** Nihai sonuç yine öz-yeterli TEK bir HTML sayfasıdır (karar 1 karşılanır) — yalnızca LLM'in kontrol ettiği yüzey (ham markup) kaldırılarak XSS riski yapısal olarak ortadan kaldırılıyor. Mimar bu daraltmayı kendi başına kararlaştırmadı, insana AÇIKÇA sordu ve onay ALDI (ADR-0041 insan kararı 4, Karar c).

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0041-artifact-boru-hatti.md` Karar (a)-(h) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Yerleşim:** `packages/artifacts` (saf tipler: `ArtifactType`/`ThemePreset`/`ArtifactContent`/`renderArtifactHtml`) + `apps/server/src/artifacts/` (servis/controller) — `generateArtifact` orkestratörü de (I/O yapan taraf) app katmanında yaşar, `parseCommand`'ın kendi `apps/server/src/ai/`'de yaşamasıyla AYNI konumlandırma mantığı.
- **(b) `artifact` Lumina Object modeli:** genel özel-alanlar (4 alan, 2 mevcut `FieldType` yeniden kullanılır) — YENİ ayrılmış DB kolonu/migration YOK; yazma-anı boyut sınırı `MAX_ARTIFACT_HTML_LENGTH=200_000` `generateArtifact`'ın kendisinde uygulanır.
- **(c) Üretim akışı — EN YÜK TAŞIYAN karar:** yapılandırılmış içerik (başlık + tipli bölümler) + deterministik şablon; LLM ham HTML/CSS/JS ÜRETMEZ — her LLM-etkili string interpolasyondan ÖNCE `escapeHtml` ile kaçırılır.
- **(d) Güvenli render:** sandboxed `<iframe>`, `srcdoc`, BOŞ `sandbox` özniteliği — asla `allow-scripts`+`allow-same-origin` birlikte eklenmez; savunma-derinliği katmanı, Karar (c)'nin yapısal garantisinin ÜZERİNE.
- **(e) Tema presetleri:** 3 sabit preset (`kurumsal`/`canli`/`minimal`), her biri CSS-değişken haritası — gerçek per-workspace markalama DEĞİL.
- **(f) `artifactType` kapsamı:** 4 tip dahil (`presentation`/`dashboard`/`page`/`report`), hepsi AYNI üretim/render yolunu paylaşır — ama `dashboard` v0'da KESİNLİKLE STATİK bir tek-seferlik snapshot, canlı/kendini-yenileyen DEĞİL (o F3-T8'in vaadi).
- **(g) RBAC:** `member`+, `CommandsService.parse()`'ın AYNI gate'i — admin-gate YOK; gerçek maliyet-kontrolü RBAC'ta değil `AIUsageService`'in kota/bütçe kontrolünde yaşar.
- **(h) HTTP yüzeyi:** yeni `POST /workspaces/:workspaceId/artifacts` — `GET`'ler (`GET /objects?type=artifact` vb.) `ObjectsController`'dan MİRAS alınır, yeniden tasarlanmaz.

**RBAC özeti:** Artifact üretimi tetikleme (`POST .../artifacts` → `ArtifactsService.generate`) = `member`+ (`CommandsService.parse()`'ın AYNI gate'i, daha katı bir taban EKLENMEZ); okuma rotaları (`GET /objects?type=artifact`, `GET /objects/:objectId`, `POST /objects/query`) `ObjectsController`'dan ZATEN mevcut, hiçbir kod değişikliği gerektirmeden `artifact` nesnelerini de kapsar.

## PR Bölünmesi (3 PR, tek plan onayı hepsini kapsar)

1. **PR1 — `packages/artifacts` saf domain (backend).** `ArtifactType`, `ThemePreset`/`THEME_PRESETS` (3 preset), `ArtifactContent`/`artifactContentSchema`, `renderArtifactHtml` (+ `escapeHtml`) — SIFIR I/O, tamamen birim-test edilebilir. Testler: her 3 preset'in doğru CSS değişkenlerini ürettiği, `artifactContentSchema`'nın geçerli/geçersiz içerikleri doğru ayırt ettiği, `renderArtifactHtml`'in HER section kind'ı (heading/paragraph/list/table/imagePlaceholder) için doğru HTML ürettiği VE kritik olarak — `escapeHtml`'in `<`/`>`/`&`/`"`/`'` içeren adversarial girdi metnini (ör. `<script>alert(1)</script>` içeren bir `text`/`items`/`headers`/`rows`/`caption` değeri) render edilen HTML'de YAPISAL OLARAK ZARARSIZ hale getirdiğini (kaçış karakterleriyle) kanıtlayan özel güvenlik testleri.
2. **PR2 — `apps/server/src/artifacts/` + `artifact` Lumina Object entegrasyonu.** `generate-artifact.ts` orkestratörü (`AIUsageService` disiplinini kullanan `ArtifactsService` üzerinden), `object-type-registry.ts`'e `'artifact'` eklenmesi + default-field-seeding, `select-ai-model.ts`'e `'artifact'` outputType'ı, `POST /workspaces/:workspaceId/artifacts` rotası. Integration testler: gerçek bir `artifact` nesnesi oluşturuluyor (`fieldValues.htmlContent` doldurulmuş), `MAX_ARTIFACT_HTML_LENGTH` aşıldığında `ValidationError`, LLM içerik-parse'ı başarısız olduğunda (2 deneme sonrası) `ValidationError`, RBAC (`member`+ yeterli, `guest` reddedilir), `AIUsageService` kota/bütçe/kilit disiplinine gerçekten uyulduğu, mevcut `GET /objects?type=artifact` rotasının YENİ `artifact` nesnelerini hiçbir kod değişikliği olmadan zaten döndürdüğü (regresyon-doğrulama).
3. **PR3 — Frontend.** `ArtifactViewer.tsx` (sandboxed iframe) + basit bir üretim formu (prompt/artifactType/themePreset seçimi) + `apiClient.ts` eklentisi + hook. Testler: form gönderiminin doğru `{prompt, artifactType, themePreset}` gövdesiyle isteği tetiklediği, `ArtifactViewer`'ın `iframe`'i `srcDoc`+BOŞ `sandbox=""` ile render ettiğinin (KESİNLİKLE `allow-scripts` YOK) doğrulanması, mutasyon hatasının görünür bir mesaj olarak yüzeye çıkması.

## Kapsam Dışı

- **PDF/PowerPoint export** — ayrı, gelecekteki bir karar/ADR gerektirir (ADR-0041 insan kararı 1).
- **Gerçek S3/blob depolama** — `docs/specs/F2-E4/F2-T13` ZATEN bu boşluğu ayrı bir altyapı kararı olarak işaretlemiş (ADR-0041 insan kararı 2).
- **Gerçek per-workspace markalama/logo yükleme** — dosya-depolamaya bağımlı, AYRI, gelecekteki bir karar (ADR-0041 insan kararı 3).
- **LLM'in ham HTML/CSS/JS üretmesi** — mimarın önerdiği, insan tarafından açıkça onaylanan daraltma sonucu KASITLI OLARAK reddedildi (ADR-0041 insan kararı 4, Karar c).
- **Canlı/kendini-yenileyen dashboard** — F3-T8'in KENDİ mimari kararı (ADR-0041 Karar f).
- **`sandbox` özniteliğine `allow-scripts` eklenmesi** — Karar (c)'nin "LLM asla script üretmez" garantisiyle DOĞRUDAN çelişir; gerçek bir ihtiyaç doğarsa AYRI bir karar/ADR gerektirir (ADR-0041 Alternatifler).
- **Genel bir HTML-sanitizer kütüphanesi eklenmesi** — Karar (c) zaten LLM'i ham HTML üretme konumundan çıkardığı için çözülmüş bir problem için gereksiz bir bağımlılık+saldırı-yüzeyi olurdu (ADR-0041 Karar d).

## Kabul Kriterleri

- [ ] **PR1:** `packages/artifacts` paketi doğru iskeletle oluşturuldu (`package.json`/`tsconfig.json`/`vitest.config.ts`/`eslint.config.js`, `packages/agent-runtime`'ın AYNI şablonunu izleyerek), sıfır I/O bağımlılığı, tek runtime bağımlılığı `@luminaos/shared`+`zod`.
- [ ] **PR1:** `THEME_PRESETS`'in 3 preset'inin (`kurumsal`/`canli`/`minimal`) her biri doğru CSS değişken haritasını (`--artifact-bg`/`--artifact-fg`/`--artifact-accent`/`--artifact-font`) ürettiği doğrulanır.
- [ ] **PR1:** `artifactContentSchema`, geçerli bir `ArtifactContent`'i (title + 1+ section) kabul eder; geçersiz girdileri (boş `sections`, tanınmayan `kind`, sınır-aşan `text`/`items`/`rows` uzunlukları, `.strict()` ihlali eden fazladan alan) reddeder.
- [ ] **PR1:** `renderArtifactHtml`, HER 5 section `kind`'ı (`heading`/`paragraph`/`list`/`table`/`imagePlaceholder`) için doğru HTML yapısını üretir; seçilen tema preset'inin CSS değişkenlerinin `<style>` bloğuna doğru aktarıldığı VE `artifactType === 'presentation'` için `page-break-after` kuralının eklendiği doğrulanır.
- [ ] **PR1 (güvenlik-kritik):** `escapeHtml`, `<`/`>`/`&`/`"`/`'` içeren adversarial bir girdi metnini (ör. `<script>alert(1)</script>` içeren bir `text`/`items`/`headers`/`rows`/`caption` değeri) render edilen HTML çıktısında kaçış-karakterleriyle YAPISAL OLARAK zararsız hale getirir — özel bir güvenlik testi seti bunu her interpolasyon noktasında (heading text, paragraph text, list items, table headers/rows/cells, imagePlaceholder caption, title) kanıtlar.
- [ ] **PR1:** `pnpm --filter @luminaos/artifacts typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.
- [ ] **PR2:** `object-type-registry.ts`'e `artifact: { titleRequired: true }` eklendi, `ObjectType` union'ına `'artifact'` eklendi — **HİÇBİR migration dosyası yazılmadı** (regresyon: mevcut migration/lint akışı yeni bir DDL değişikliği olmadığını doğrular).
- [ ] **PR2:** Workspace-kurulum-anındaki default-field-seeding, `artifact` için 4 alanı (`htmlContent`:`longText`, `themePreset`:`select` 3 preset, `generationPrompt`:`longText`, `artifactType`:`select` 4 tip) doğru seed ediyor.
- [ ] **PR2:** `select-ai-model.ts`'e eklenen `outputType:'artifact'`, `CLAUDE_SONNET_5`'e doğru yönlendiriyor.
- [ ] **PR2:** `generateArtifact`, LLM yanıtını `artifactContentSchema` ile parse edip `renderArtifactHtml`'e sararak geçerli bir `htmlContent` üretir; ilk parse başarısız olursa BİR kez retry eder, ikinci deneme de başarısız olursa `parseError:true` sentinel'i döner (`ArtifactsService` bunu `ValidationError`'a çevirir).
- [ ] **PR2:** `MAX_ARTIFACT_HTML_LENGTH=200_000` aşıldığında `generateArtifact` başarısızlık sinyali döner, `ArtifactsService` bunu görünür bir `ValidationError` olarak yüzeye çıkarır.
- [ ] **PR2:** `POST /workspaces/:workspaceId/artifacts` üzerinden gerçek bir `artifact` Lumina Object'i oluşturuluyor — `fieldValues.htmlContent`/`themePreset`/`generationPrompt`/`artifactType` doğru doldurulmuş; `AIUsageService`'in `withWorkspaceAILock`/kota/bütçe/`recordAIUsage` disiplinine gerçekten uyulduğu doğrulanır.
- [ ] **PR2:** RBAC — `member`+ yeterli, `guest` reddedilir (ledger/`parse` ile AYNI taban, daha katı bir kapı EKLENMEZ).
- [ ] **PR2 (regresyon):** Mevcut `GET /workspaces/:workspaceId/objects?type=artifact` rotası, YENİ oluşturulan `artifact` nesnelerini HİÇBİR kod değişikliği olmadan zaten doğru döndürüyor.
- [ ] **PR2:** `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.
- [ ] **PR3:** `ArtifactViewer.tsx`, `htmlContent`'i `<iframe srcDoc={htmlContent} sandbox="">` ile render eder — `sandbox` özniteliğinin KESİNLİKLE BOŞ olduğu (`allow-scripts` YOK, `allow-same-origin` YOK) ayrı, isimlendirilmiş bir testle doğrulanır.
- [ ] **PR3:** Üretim formu (prompt + `artifactType` + `themePreset` seçimi) gönderildiğinde doğru `{prompt, artifactType, themePreset}` gövdesiyle isteği tetikler.
- [ ] **PR3:** Mutasyon hatası (ör. sunucudan `ValidationError`) kullanıcıya görünür bir hata olarak yüzeye çıkar.
- [ ] **PR3:** `pnpm --filter @luminaos/web typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.

## Açık Sorular

Bu görev için mimari olarak açık bir soru yok — ADR-0041 Bağlam/Karar/Alternatifler bölümleri tüm tasarım kararlarını (yerleşim, nesne modeli, üretim akışı, güvenli render, tema presetleri, `artifactType` kapsamı, RBAC, HTTP yüzeyi) çözdü. ADR'nin kendi "Sonuçlar/Ödünler" bölümünün açıkça gelecekteki genişletme noktası olarak işaretlediği, bu görevi BLOKE ETMEYEN kalemler ayrı bir gelecekteki karara ERTELENMİŞTİR:

- PDF/PowerPoint export (insan kararı 1) — gerçek bir ihtiyaç doğarsa AYRI bir karar/ADR (yeni render bağımlılığı) gerektirir.
- Gerçek S3/blob depolama (insan kararı 2) — `docs/specs/F2-E4/F2-T13` ZATEN bu boşluğu ayrı bir altyapı kararı olarak işaretlemiş.
- Gerçek per-workspace markalama/logo yükleme (insan kararı 3) — dosya-depolamaya bağımlı, AYRI, gelecekteki bir karar.
- Canlı/kendini-yenileyen dashboard (Karar f) — F3-T8'in KENDİ mimari kararı, bu görev onu ÖNDEN almaz.
- Daha zengin section-tipleri/şablon genişlemesi (ör. yan-yana sütunlar, gömülü grafik) — gelecekte şablona YENİ bir bölüm tipi eklenerek genişletilebilir (koddan, LLM'den DEĞİL), bugünkü 5 tiple SINIRLI.

## Sıradaki adım

Bu ADR'nin onayı üzerine PR1'e (`packages/artifacts` saf domain: `ArtifactType`, `ThemePreset`/`THEME_PRESETS`, `ArtifactContent`/`artifactContentSchema`, `renderArtifactHtml` pure template renderer) `test-writer` ile başlanır:

```
docs/adr/ADR-0041-artifact-boru-hatti.md'deki Karar (a)-(h)'yi ve
docs/specs/F3-E3/F3-T7-artifact-boru-hatti.md'nin Kabul Kriterleri'ni temel alarak, F3-T7
PR1 (packages/artifacts saf domain: ArtifactType, ThemePreset/THEME_PRESETS üç preset,
ArtifactContent/artifactContentSchema yapılandırılmış içerik şeması, renderArtifactHtml
pure HTML şablon render fonksiyonu -- escapeHtml dahil) için test-writer ile başarısız
testleri yaz.
```
