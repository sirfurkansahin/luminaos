# F3-T11 — Sapma Anında Ajan Destekli Kök Neden Analizi Kartı

**Epik:** F3-E4 (Plan-Gerçek Motoru [Kapsam N]) · **Durum:** Planlandı — Epiğin İKİNCİ ve SON görevi, F3-T10 (ADR-0044, `main`'e merge edildi) sonrası. Bu görev tamamlandığında Epik F3-E4 KAPANIR. Mimari karar `docs/adr/ADR-0045-sapma-aciklama-karti.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** F3-T10 (ADR-0044) — `computeQueryAggregate`/`computeDeviation`, `BaselinesService`/`BaselinesController`, `BaselineViewer.tsx`, `artifact`'ın `capturedValue`/`aggregateFn`/`targetFieldKey`/`querySpec` alanları (bu görev bunları OKUR, DEĞİŞTİRMEZ). F3-T8 (ADR-0042) — `compileWidgetQuery`'nin JSON+zod+1-retry deseni, `WidgetsService`'in dar-Pick+`useFactory` deseni. F1-T15 (`answerQuestion`/`QAService`, ADR-0014) — `AIUsageService`'in kota/kilit/kayıt disiplini, "boş girdiden hallüsinasyon üretme" maliyet-koruması deseni. ADR-0029 — dört-kademeli hassas-veri sınıflandırması (bu görev Kademe 3'e resmi bir ek getirir, ADR-0045 Karar i).

## Amaç

`docs/PLAN.md` satır 294'ün vaadi: kullanıcı `BaselineViewer`'da ZATEN gördüğü bir sapmayı (yakalanan vs güncel değer, ADR-0044) AÇIKÇA "açıklama iste" diyerek AI'dan bir kök-neden kartı (kısa özet + olası nedenler listesi) talep edebilir. ADR-0045 Karar (a)-(i)'de tam sabitlendi.

## Kapsam

1. `packages/artifacts` genişlemesi — `deviationExplanationSchema`/`DeviationExplanationContent` (`{summary: string, possibleCauses: string[]}`, zod `.strict()`) (ADR-0045 Karar b).
2. `apps/server/src/artifacts/explain-deviation.ts` (YENİ) — saf, DB'siz orkestratör `explainDeviation()`: `renderExplainDeviationPrompt` (agregat-yalnızca girdi) → `provider.complete()` → JSON+zod+1-retry → `{content, parseError, message}` (ADR-0045 Karar b/c).
3. `apps/server/src/ai/select-ai-model.ts` genişlemesi — `SelectAIModelInput.outputType` union'ına `'deviationExplanation'` eklenmesi, `CLAUDE_SONNET_5`'e yönlendirilmesi (ADR-0045 Karar b).
4. `apps/server/src/artifacts/baseline-explanation.service.ts` (YENİ) — `BaselineExplanationService`: baseline'ı oku (`ObjectsService.get`) → `querySpec`'i parse et → güncel değeri hesapla (`computeQueryAggregate`) → hesaplanamazsa (`null`) AI'ı HİÇ ÇAĞIRMADAN reddet → `AIUsageService.withWorkspaceAILock` içinde `explainDeviation` çağır → sonucu `setFieldValues` ile persist et (ADR-0045 Karar e/h).
5. `apps/server/src/workspaces/workspaces.service.ts`'in `seedArtifactFields`'ına — 3 YENİ alan (`explanationSummary`:`longText`, `explanationCauses`:`longText` JSON-stringified dizi, `explanationGeneratedAt`:`datetime`) — HİÇBİR migration gerektirmez (ADR-0045 Karar d).
6. `apps/server/src/artifacts/baselines.controller.ts` genişlemesi — YENİ `POST /workspaces/:workspaceId/artifacts/baselines/:id/explain` rotası (`BaselinesController`'ın İKİNCİ rotası, `BaselineExplanationService` ikinci collaborator olarak enjekte edilir), `apps/server/src/artifacts/artifacts.module.ts`'e `BaselineExplanationService`'in `useFactory` kaydı (ADR-0045 Karar e).
7. `apps/web`'e YENİ `explainDeviation` (`apiClient.ts`) + `useExplainDeviationMutation.ts` hook'u + `BaselineViewer.tsx` genişlemesi — "Açıklama iste"/"Yeniden oluştur" butonu (`explanationSummary`'nin var/yok olmasına göre etiket değişir), üretilen kartın (`summary` + `possibleCauses` listesi) render'ı, mutasyon pending/error UI'ı (ADR-0045 Karar f/g).

## Bağlayıcı İnsan Kararları (ADR-0045'ten, AYNEN kayıtlı — tekrar tartışılmaz)

1. **Tetikleme modeli REAKTİF, kullanıcı-başlatmalı** — sıfır yeni sunucu-tarafı sapma-tespit/scheduler altyapısı.
2. **AI'ya YALNIZCA agregat değerler + sorgu metadata'sı** (sayısal değerler, delta/yüzde, `aggregateFn`, alan anahtarı) gönderilir — HİÇBİR ham satır/nesne verisi (görev başlığı/açıklaması vb.) gönderilmez.
3. **Üretilen açıklama SAKLANIR** (baseline `artifact` nesnesine yeni alanlar) — yalnızca kullanıcı açıkça "yeniden oluştur" derse yeniden üretilir, her görüntülemede DEĞİL.

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0045-sapma-aciklama-karti.md` Karar (a)-(i) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Yerleşim:** `apps/server/src/artifacts/` (YENİ `explain-deviation.ts` + `baseline-explanation.service.ts`) — `apps/server/src/ai/` DEĞİL: `compileWidgetQuery`/`generateArtifact`'ın "özelliğe-özel AI orkestratörü, o özelliğin sahibi olan klasörde yaşar" ilkesi, `answerQuestion`'ın jenerik/özellik-agnostik yerleşiminin AKSİNE.
- **(b) AI çıktı şekli:** hafif yapılandırılmış JSON + zod + 1-retry (`compileWidgetQuery`/`generateArtifact`'ın AYNI deseni) — `{summary, possibleCauses}`, ne `answerQuestion`'ın serbest-metni (kart iki-bölgeli render gerektirir) ne `generateArtifact`'ın tam `ArtifactContent`'i (aşırı-mühendislik, `renderArtifactHtml` HİÇBİR ZAMAN çağrılmaz). Model yönlendirmesi: YENİ `'deviationExplanation'` outputType, `CLAUDE_SONNET_5`.
- **(c) Prompt girdisi:** YALNIZCA `objectType`, `aggregateFn`, `targetFieldKey`(ham anahtar, ETİKET YOK — bilinçli minimalizm), `capturedValue`/`currentValue`/`delta`/`percentChange`/`direction`. Hiçbir nesne başlığı/açıklaması/`fieldValues` içeriği.
- **(d) `artifact` model genişlemesi:** `explanationSummary`(`longText`), `explanationCauses`(`longText`, JSON-stringified string dizisi — `querySpec`'in AYNI deseni, `multiSelect` UYGUN DEĞİL çünkü kapalı seçenek kümesi varsayar), `explanationGeneratedAt`(`datetime`). Migration YOK.
- **(e) HTTP yüzeyi:** YENİ `POST .../artifacts/baselines/:id/explain` — `BaselinesController`'ın İKİNCİ rotası (YENİ bir controller sınıfı DEĞİL), request body YOK. `BaselinesService`'e AI-bağımlılığı EKLENMEZ (ADR-0044 Karar c'nin "SIFIR AI" yatırımı korunur) — YENİ, AYRI `BaselineExplanationService` bu bağımlılığı izole eder. RBAC: `SessionAuthGuard`+`WorkspaceMembershipGuard` (member+), daha katı bir taban YOK.
- **(f) "Yeniden oluştur":** AYNI uç-noktaya tekrar POST, mevcut 3 alanın ÜZERİNE YAZILIR — geçmiş/versiyonlama YOK (v0).
- **(g) Frontend:** `BaselineViewer`'a buton + kart render'ı, `WidgetGenerationForm`'un AYNI mutation+pending+error deseni.
- **(h) Maliyet-koruması:** `computeQueryAggregate` `null` dönerse (güncel değer hesaplanamıyorsa) `AIUsageService.withWorkspaceAILock`'a GİRMEDEN, sağlayıcı HİÇ ÇAĞRILMADAN `ValidationError` fırlatılır — `answerQuestion`'ın `passages.length===0` kısayolunun AYNI disiplini.
- **(i) ADR-0029'a resmi ek:** ham sayısal agregat değerler + sorgu alan anahtarları Kademe 3'e (metadata) EN YAKIN sınıflandırılır — bu görevin gönderdiği veri Kademe 3'ün ÜZERİNE ÇIKMAZ, dolayısıyla Kademe 1/2'nin gerektirdiği ek-onay-yüzeyi TETİKLENMEZ.

**RBAC özeti:** Açıklama talebi (`POST .../baselines/:id/explain` → `BaselineExplanationService.explain`) = `member`+ (ADR-0041/0042/0044'ün AYNI gate'i, daha katı bir taban EKLENMEZ).

## PR Bölünmesi (3 PR, tek plan onayı hepsini kapsar)

1. **PR1 — `packages/artifacts` + saf AI orkestratörü (backend, DB'siz).** `deviationExplanationSchema`/`DeviationExplanationContent` (`packages/artifacts`), `apps/server/src/artifacts/explain-deviation.ts` (`explainDeviation()`, `renderExplainDeviationPrompt`, JSON+zod+1-retry — `provider.complete` mock'lanarak birim test edilebilir), `select-ai-model.ts`'e `'deviationExplanation'` outputType eklenmesi. Testler: `explainDeviation`'ın geçerli bir JSON yanıtını doğru `DeviationExplanationContent`'e parse ettiği; ilk yanıt geçersizse (bozuk JSON, şema-dışı, `possibleCauses` boş/6+ eleman) TAM OLARAK 1 retry denediği; iki deneme de başarısızsa `parseError:true`+mesaj döndüğü; `renderExplainDeviationPrompt`'un ÇIKTISININ hiçbir nesne başlığı/fieldValues-benzeri anahtar İÇERMEDİĞİ (yalnızca `objectType`/`aggregateFn`/`targetFieldKey`/sayısal alanlar) — bu, İnsan kararı 2'yi doğrudan kanıtlayan bir regresyon testi; `percentChange:null` durumunda prompt'un "not computable" metnini ürettiği (asla `Infinity`/`NaN` yazmadığı); `selectAIModel({outputType:'deviationExplanation'})`'ın `CLAUDE_SONNET_5` döndürdüğü.
2. **PR2 — `BaselineExplanationService`/rota + alan seed'leri (backend, entegrasyon).** `baseline-explanation.service.ts`, `baselines.controller.ts`'e `POST :id/explain` rotası + ikinci constructor param, `workspaces.service.ts`'in `seedArtifactFields`'ına 3 yeni alan, `artifacts.module.ts`'e `BaselineExplanationService`'in `useFactory` kaydı. Integration testler: gerçek bir baseline `artifact`'i üzerinde `explain()` çağrısı `explanationSummary`/`explanationCauses`/`explanationGeneratedAt`'i doğru dolduruyor; `artifactType !== 'baseline'` olan bir nesne için `ValidationError`; bozuk/parse-edilemeyen saklı `querySpec` için `ValidationError`; `computeQueryAggregate` `null` dönerse (ör. `targetFieldKey` artık geçersiz) `ValidationError` fırlatılıp **AI sağlayıcının HİÇ ÇAĞRILMADIĞI** (mock provider'ın `complete` metodunun 0 kez çağrıldığı, ADR-0045 Karar h'nin doğrudan kanıtı); ikinci bir `explain()` çağrısının ÖNCEKİ açıklamanın ÜZERİNE YAZDIĞI (geçmiş tutulmadığı); RBAC (`member`+ yeterli, iç `setFieldValues` yazımı sabit `'owner'` rolüyle çalışır); `BaselinesService`'in KENDİSİNİN hâlâ hiçbir `AIProvider`/`AIUsageService` bağımlılığı OLMADIĞININ (import-graph) regresyon-doğrulaması; **HİÇBİR migration dosyası yazılmadığı**.
3. **PR3 — Frontend.** `apiClient.ts`'e `explainDeviation` eklentisi, `useExplainDeviationMutation.ts`, `BaselineViewer.tsx` genişlemesi (buton, kart render'ı, `explanationCauses`'ın güvenli JSON-parse'ı). Testler: `explanationSummary` YOKSA butonun "Açıklama iste" etiketiyle, VARSA "Yeniden oluştur" etiketiyle göründüğü; buton tıklamasının doğru `POST .../baselines/:id/explain` (body YOK) isteğini tetiklediği; mutasyon `isPending` iken yükleniyor göstergesi; mutasyon başarılı olduğunda `object` sorgusunun geçersiz kılınıp güncel `explanationSummary`/`explanationCauses`'ın render edildiği; bozuk/parse-edilemeyen `explanationCauses` karşısında ÇÖKMEDEN boş bir liste render edildiği; mutasyon hatasının görünür bir hata mesajı olarak yüzeye çıktığı.

## Kapsam Dışı

- **Proaktif/zamanlanmış sapma-tespiti veya bildirim** (İnsan kararı 1'in reddettiği alternatif).
- **AI'ya ham satır/nesne verisi (görev başlıkları vb.) gösterilmesi** (İnsan kararı 2'nin reddettiği alternatif).
- **Açıklama geçmişi/versiyonlama** — v0'da tek-slot üzerine-yazma (ADR-0045 Karar f).
- **Yeni bir eşik-yapılandırma UI'ı** ("sapma X%'i geçerse uyar" gibi) — proaktif modelin bir parçası olurdu, reddedildi.
- **Alan etiketi (`FieldDefinition.label`) çözümlemesi** — prompt yalnızca ham `targetFieldKey`'i kullanır, `FieldDefinitionsService` bağımlılığı EKLENMEZ (ADR-0045 Karar c).
- **`answerQuestion`/`ai` alan tipi/`AIUsageService`'in mevcut metot imzalarına herhangi bir değişiklik** — yalnızca `select-ai-model.ts`'in kapalı `outputType` union'ına katkısal bir değer eklenir.
- **`BaselinesService`'e (ADR-0044) herhangi bir değişiklik** — AI-bağımlılığı TAMAMEN yeni, ayrı `BaselineExplanationService`'e izole edilir.

## Kabul Kriterleri

- [ ] **PR1:** `explainDeviation`, geçerli bir JSON yanıtını doğru `DeviationExplanationContent`'e (`{summary, possibleCauses}`) parse ediyor; geçersiz ilk yanıtta TAM OLARAK 1 retry deniyor; iki deneme de başarısızsa `{content: undefined, parseError: true, message}` dönüyor.
- [ ] **PR1:** `renderExplainDeviationPrompt`'un ürettiği metin hiçbir nesne başlığı/`fieldValues` anahtarı İÇERMİYOR — yalnızca `objectType`/`aggregateFn`/`targetFieldKey`/sayısal agregat alanları (İnsan kararı 2'nin regresyon kanıtı).
- [ ] **PR1:** `percentChange: null` girdisinde prompt "hesaplanamaz" metnini üretiyor, asla `Infinity`/`NaN` yazmıyor.
- [ ] **PR1:** `selectAIModel({outputType:'deviationExplanation'})` `CLAUDE_SONNET_5` döndürüyor.
- [ ] **PR1:** `pnpm --filter @luminaos/artifacts typecheck && lint && test:changed` VE `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.
- [ ] **PR2:** `POST .../baselines/:id/explain`, gerçek bir baseline `artifact`'inde `explanationSummary`/`explanationCauses`/`explanationGeneratedAt` alanlarını doğru dolduruyor.
- [ ] **PR2:** `artifactType !== 'baseline'` olan bir nesne için `ValidationError`; bozuk/parse-edilemeyen saklı `querySpec` için `ValidationError`.
- [ ] **PR2:** `computeQueryAggregate` `null` dönerse `ValidationError` fırlatılıyor VE mock AI sağlayıcının `complete` metodu SIFIR kez çağrılıyor (Karar h'nin doğrudan kanıtı).
- [ ] **PR2:** İkinci bir `explain()` çağrısı önceki açıklamanın ÜZERİNE YAZIYOR (geçmiş tutulmuyor).
- [ ] **PR2:** RBAC — `member`+ yeterli; iç `setFieldValues` yazımı sabit `'owner'` rolüyle çalışıyor.
- [ ] **PR2 (regresyon):** `BaselinesService`'in import-graph'ı hâlâ hiçbir `AIProvider`/`AIUsageService` bağımlılığı içermiyor; **hiçbir migration dosyası yazılmadı**.
- [ ] **PR2:** `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.
- [ ] **PR3:** `explanationSummary` YOKSA "Açıklama iste", VARSA "Yeniden oluştur" etiketi doğru render ediliyor.
- [ ] **PR3:** Buton tıklaması doğru `POST .../baselines/:id/explain` isteğini (body YOK) tetikliyor; mutasyon başarılı olduğunda `object` sorgusu geçersiz kılınıp güncel açıklama render ediliyor.
- [ ] **PR3:** Bozuk/parse-edilemeyen `explanationCauses` karşısında ÇÖKMEDEN boş bir liste render ediliyor.
- [ ] **PR3:** Mutasyon hatası kullanıcıya görünür bir hata olarak yüzeye çıkıyor.
- [ ] **PR3:** `pnpm --filter @luminaos/web typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.

## Açık Sorular

- **Alan etiketi (label) çözümlemesinin gelecekte eklenmesi** — bugün BİLİNÇLİ OLARAK atlanan (`FieldDefinitionsService` bağımlılığı yok) bir okunabilirlik iyileştirmesi; gerçek kullanıcı geri bildirimi ("AI hangi alandan bahsettiğimi anlamıyor" gibi) doğarsa ayrı bir küçük PR ile eklenebilir.
- **Açıklama geçmişi/versiyonlama talebi doğarsa** — v0'ın tek-slot üzerine-yazma modelinin AYRI bir gelecekteki genişlemeye ihtiyacı olabilir (ör. `artifact`'a bağlı ayrı bir `explanation` alt-nesnesi/stream'i).
- **Bu görev tamamlandığında Epik F3-E4 (Plan-Gerçek Motoru, Kapsam N) KAPANIR** — `docs/PLAN.md`'ye göre sıradaki Epik F3-E5 (Hibrit AI [Kapsam O] + Refah Katmanı [Kapsam P]), ilk görevi F3-T12: "Cihaz üstü model köprüsü; hassas veri sınıflandırıcısı → yerel/bulut yönlendirme politikası" — bu ADR'nin Karar (i)'sinin ADR-0029'a getirdiği ek, F3-T12'nin kendi sınıflandırıcı tasarımına doğrudan girdi sağlayabilir.

## Sıradaki adım

ADR-0045 ve bu spec insan onayına sunulur. Onaylanırsa PR1'e (`packages/artifacts`'a `deviationExplanationSchema`/`DeviationExplanationContent` eklenmesi + `apps/server/src/artifacts/explain-deviation.ts`'in saf JSON+zod+1-retry orkestratörü + `select-ai-model.ts`'e `'deviationExplanation'` eklenmesi — sıfır DB/Nest bağımlılığı) `test-writer` ile başlanır:

```
docs/adr/ADR-0045-sapma-aciklama-karti.md'deki Karar (a)-(i)'yi ve
docs/specs/F3-E4/F3-T11-sapma-aciklama-karti.md'nin Kabul Kriterleri'ni temel alarak, F3-T11
PR1 (packages/artifacts'a deviationExplanationSchema/DeviationExplanationContent eklenmesi +
apps/server/src/artifacts/explain-deviation.ts'in saf JSON+zod+1-retry orkestratörü +
select-ai-model.ts'e 'deviationExplanation' outputType eklenmesi -- sıfır DB/Nest bağımlılığı,
provider mock'lanarak birim test edilebilir) için test-writer ile başarısız testleri yaz.
```
