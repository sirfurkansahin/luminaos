# F3-T8 — Sorgu → Canlı Widget: Doğal Dil Sorgusunu Sabitlenebilir, Kendini Yenileyen Panele Derleme

**Epik:** F3-E3 (Artifact + Canlı Widget [Kapsam L] ve Intent-first UI [Kapsam M]) · **Durum:** PLANLANDI — Epik F3-E3'ün İKİNCİ görevi, F3-T7 (Artifact boru hattı, ADR-0041, `main`'e tam birleşti)'nin DOĞRUDAN devamı. Mimari karar `docs/adr/ADR-0042-sorgu-canli-widget.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** F3-T7 (ADR-0041) — `packages/artifacts`'ın `ArtifactContent`/`renderArtifactHtml`/`THEME_PRESETS`'i, `artifact` `ObjectType`'ı, `ArtifactsService`'in `AIUsageService` kilit deseni, `ArtifactViewer.tsx` DEĞİŞTİRİLMEDEN yeniden kullanılır. Ayrıca F1-T6 (`QuerySpec`, `POST /objects/query`, ADR-0009) — sorgu katmanının kendisi DEĞİŞTİRİLMEZ.

## Amaç

Bugün `artifact`'ın `dashboard` `artifactType`'ı KESİNLİKLE STATİK bir tek-seferlik AI-üretimi (ADR-0041 Karar f, bu görevi AÇIKÇA erteledi). Bu görev, bir kullanıcının doğal-dil sorgusunu (ör. "gecikmiş görevleri sorumluya göre göster") sabitlenebilir, MEVCUT sorgu katmanına karşı kendini periyodik olarak yenileyen bir panel'e derler — ADR-0042 Karar (a)-(j)'de tam sabitlendi.

## Kapsam

1. `packages/artifacts` genişlemesi — `deriveWidgetColumns(querySpec): string[]` (kod-only sütun türetme), `buildQueryResultTableSection(rows, columns): ArtifactSection` (sorgu satırlarından `table`-kind `ArtifactSection` inşası, hücre-uzunluk/satır-sayısı sınırlarıyla), `MAX_WIDGET_TABLE_ROWS`/`MAX_WIDGET_TABLE_COLUMNS`/`MAX_WIDGET_CELL_LENGTH` sabitleri (Karar a/g/h). Mevcut `ArtifactContent`/`artifactContentSchema`/`renderArtifactHtml` DEĞİŞTİRİLMEZ.
2. `apps/server/src/artifacts/` genişlemesi — `compile-widget-query.ts` (NL→`QuerySpec` orkestratörü, `parseCommand`'ın deseni + iş-kuralı allowlist katmanı), `widgets.service.ts` (`WidgetsService`: derleme → sorgu → içerik-inşası → render → persist, `ArtifactsService.generate()`'den PARALEL, onu ÇAĞIRMAZ), `widgets.controller.ts` (`POST /workspaces/:workspaceId/artifacts/widgets`) — `artifacts.module.ts`'e kayıtlı (Karar a/c/d/i).
3. `packages/core-objects`'e/`workspaces.service.ts`'e — `seedArtifactFields`'a YENİ `querySpec` alanı (`longText`) eklenmesi — DÖRT mevcut alan (`htmlContent`/`themePreset`/`generationPrompt`/`artifactType`) DEĞİŞMEZ, HİÇBİR migration gerektirmez (Karar b).
4. `select-ai-model.ts`'e yeni `outputType:'widgetQuery'` eklenmesi (`CLAUDE_SONNET_5`'e yönlendirilir) (Karar c).
5. `apps/web`'e YENİ `@luminaos/artifacts` runtime bağımlılığı + `useLiveWidgetQuery.ts` hook'u (react-query `refetchInterval`, `postObjectsQuery`'yi DOĞRUDAN sarmalıyor, sunucuda YENİ hiçbir uç-nokta gerekmiyor) (Karar a/e).
6. `apps/web`'e YENİ `LiveWidgetViewer.tsx` bileşeni — saklı `querySpec`'i okur, `useLiveWidgetQuery` ile poll'lar, HER tick'te istemci-taraflı `renderArtifactHtml`+`buildQueryResultTableSection` çağırıp sonucu DEĞİŞTİRİLMEMİŞ `ArtifactViewer`'a besler (Karar f).
7. Frontend: widget-oluşturma için basit bir istek formu (prompt + hedef `objectType` + `themePreset` seçimi) + `apiClient.ts`'e `postGenerateWidget` eklentisi + `useGenerateWidgetMutation` hook'u — spesifik UI konumu implementer'ın kararı (F3-T7 PR3'ün AYNI serbestliği).

## 4 Bağlayıcı İnsan Kararı

- **Depolama modeli: MEVCUT `artifact` Lumina Object tipi genişletilir — YENİ bir `widget` `ObjectType` YARATILMAZ.** `seedArtifactFields`'ın AYNI 4-alan seed setine bir `querySpec` alanı eklenir. Gerçek gerekçe: sıfır migration, F3-T7'nin TÜM RBAC/seed/render/viewer altyapısının ÜZERİNE inşa (ADR-0042 insan kararı 1).
- **NL→QuerySpec derlemesi: AI-gateway-güdümlü, TEK SEFERLİK, yalnızca widget-oluşturma ANINDA.** Saklanan şey derlenen `QuerySpec`'in KENDİSİ; her yenileme YALNIZCA bu saklı `QuerySpec`'i yeniden çalıştırır — LLM ASLA yenilemede tekrar çağrılmaz. `AIUsageService` kota/kilit disiplini YALNIZCA oluşturma anında geçerli (ADR-0042 insan kararı 2).
- **Yenileme dağıtımı: istemci-taraflı `react-query` polling, MEVCUT ucuz `POST /objects/query`'ye DOĞRUDAN karşı — YENİ bir sunucu-push altyapısı (WebSocket/SSE) YOK.** Kod tabanında genel bir pub-sub emsali yok, v0 için inşa etmek orantısız (ADR-0042 insan kararı 3).
- **Yenileme sıklığı: sabit aralık (45s), widget monte/görünürken VE sekme ön plandayken aktif.** `refetchInterval`+`refetchIntervalInBackground:false` — standart react-query davranışı, sıfır yeni sunucu kodu (ADR-0042 insan kararı 4).

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0042-sorgu-canli-widget.md` Karar (a)-(j) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Yerleşim:** `packages/artifacts` genişler (saf: `deriveWidgetColumns`/`buildQueryResultTableSection`/sabitler) + `apps/server/src/artifacts/`'a kardeş dosyalar (`compile-widget-query.ts`/`widgets.service.ts`/`widgets.controller.ts`) — YENİ paket YOK. `apps/web`'e `@luminaos/artifacts` YENİ runtime bağımlılık olarak eklenir (`calendarQuery.ts`'in `@luminaos/shared`'dan çalışma-zamanı kod tüketme emsaliyle TUTARLI).
- **(b) `artifact` nesne modeli genişlemesi:** TEK yeni alan (`querySpec`, `longText`, JSON-serialize edilmiş `QuerySpec`, okunduğunda `querySpecSchema` ile yeniden doğrulanır) — migration YOK; diğer 4 alan DEĞİŞMEZ.
- **(c) NL→QuerySpec derleme:** `compileWidgetQuery` — `parseCommand`'ın JSON-prompt+zod+1-retry deseni, ARTI `validateCompiledQuerySpec` iş-kuralı allowlist katmanı (`objectType` tam eşleşmeli, `group` YASAK v0'da, her filter/sort alanı çağıranın rolüne GÖRÜNÜR gerçek bir alan anahtarı OLMALI, `limit` `MAX_WIDGET_TABLE_ROWS`'a clamp'lenir) — `parseCommand`'ın `ALLOWED_PARSE_COMMAND_TYPES` desenine DAYANIR.
- **(d) Üretim akışı ayrışması — EN YÜK TAŞIYAN karar:** widget içeriği AI'dan DEĞİL gerçek sorgu satırlarından gelir; `WidgetsService.generate()` `ArtifactsService.generate()`'i ÇAĞIRMAZ, PARALEL bir akış izler: derle (AI, kilit içinde) → sorgula (kilit dışında, ucuz) → `buildQueryResultTableSection` (saf, kod) → `renderArtifactHtml` (DEĞİŞTİRİLMEDEN) → persist (`ArtifactsService`'in `'owner'`-bypass deseniyle AYNI).
- **(e) Canlı yenileme:** istemci-taraflı `react-query` `refetchInterval` (45s), MEVCUT `postObjectsQuery`'ye DOĞRUDAN karşı — sunucuda SIFIR yeni kod, YENİ bir `/refresh` uç-noktası YOK.
- **(f) Render tekilliği:** hem sunucunun ilk anlık-görüntüsü hem istemcinin her yenileme tick'i AYNI saf `renderArtifactHtml`/`buildQueryResultTableSection` fonksiyonlarını çağırır — escaping garantisi (ADR-0041 Karar c/d) bir kez yazılır, iki yerde TÜKETİLİR.
- **(g) Sütun türetme:** `deriveWidgetColumns` — kod-only, AI'dan BAĞIMSIZ: `title` + `querySpec.filters`/`sort`'ta referans verilen alan anahtarları, dedup, `MAX_WIDGET_TABLE_COLUMNS=8` ile sınırlı.
- **(h) Boyut/satır sınırları:** `MAX_WIDGET_TABLE_ROWS=25`, `MAX_WIDGET_CELL_LENGTH=500` — YENİ tehdit yüzeyine (herhangi bir workspace üyesinin kendi nesne alanına yazdığı, artık `htmlContent`'e akan GERÇEK veri) karşı savunma.
- **(i) HTTP yüzeyi:** YENİ `POST /workspaces/:workspaceId/artifacts/widgets` (`WidgetsController`, `ArtifactsController`'dan AYRI sınıf, AYNI modül) — RBAC `member+`, ADR-0041 Karar (g)'nin AYNI tabanı. Yenileme için YENİ uç-nokta YOK.
- **(j) Düzenleme/regenerasyon:** v0'da YOK — yalnızca sil+yeniden-oluştur, ADR-0041'in artifact'lar için "regenerate" sunmamasıyla TUTARLI.

**RBAC özeti:** Widget oluşturma tetikleme (`POST .../artifacts/widgets` → `WidgetsService.generate`) = `member`+ (ADR-0041 Karar g'nin AYNI gate'i, daha katı bir taban EKLENMEZ); canlı yenileme okuması (`POST /objects/query`) `ObjectsController`'dan ZATEN mevcut, hiçbir kod değişikliği gerektirmeden çalışır — field-visibility filtrelemesi (Bağlam #2) her poll'da ZATEN uygulanıyor.

## PR Bölünmesi (3 PR, tek plan onayı hepsini kapsar)

1. **PR1 — `packages/artifacts` genişlemesi (saf domain, backend).** `deriveWidgetColumns`, `buildQueryResultTableSection`, `MAX_WIDGET_TABLE_ROWS`/`MAX_WIDGET_TABLE_COLUMNS`/`MAX_WIDGET_CELL_LENGTH` — SIFIR I/O, mevcut `ArtifactContent`/`artifactContentSchema`/`renderArtifactHtml`'i DEĞİŞTİRMEDEN yeniden kullanır. Testler: `deriveWidgetColumns`'ın `title`'ı HER ZAMAN ilk sütun yaptığı + filters/sort alanlarını dedup'layıp `MAX_WIDGET_TABLE_COLUMNS`'a kırptığı; `buildQueryResultTableSection`'ın `MAX_WIDGET_TABLE_ROWS`'u aştığında satırları kırptığı, her hücreyi `MAX_WIDGET_CELL_LENGTH`'e kırptığı, `null`/`undefined`/dizi (people/multiSelect) değerlerini doğru string'e çevirdiği VE ürettiği `ArtifactSection`'ın `renderArtifactHtml`'e verildiğinde `escapeHtml`'den GEÇTİĞİNİ (adversarial bir `<script>` içeren fieldValue'nun kaçış-karakterleriyle zararsızlaştığını) kanıtlayan güvenlik-kritik bir test seti.
2. **PR2 — `apps/server/src/artifacts/` genişlemesi + `querySpec` alanı entegrasyonu.** `compile-widget-query.ts` (`AIUsageService` disiplinini kullanan `WidgetsService` üzerinden), `workspaces.service.ts`'in `seedArtifactFields`'ına `querySpec` alanı, `select-ai-model.ts`'e `'widgetQuery'` outputType'ı, `POST /workspaces/:workspaceId/artifacts/widgets` rotası. Integration testler: gerçek bir `artifact` nesnesi oluşturuluyor (`fieldValues.querySpec`/`htmlContent` doldurulmuş, `artifactType==='dashboard'`), `compileWidgetQuery`'nin bilinmeyen/görünmez bir alana referans veren VEYA `group` içeren bir AI yanıtını REDDEDİP retry ettiği (ikinci deneme de başarısızsa `ValidationError`), `limit`'in `MAX_WIDGET_TABLE_ROWS`'a clamp'lendiği, RBAC (`member`+ yeterli, `guest` reddedilir — F3-T7 PR2'nin `guest`+`'owner'`-bypass regresyonunu AYNI şekilde doğrulayan bir test), `AIUsageService` kota/bütçe/kilit disiplinine gerçekten uyulduğu, mevcut `POST /objects/query`'nin YENİ widget `artifact` nesnelerini hiçbir kod değişikliği olmadan zaten doğru sorguladığı (regresyon-doğrulama).
3. **PR3 — Frontend.** `useLiveWidgetQuery.ts` (react-query `refetchInterval=45_000`, `refetchIntervalInBackground:false`), `LiveWidgetViewer.tsx` (saklı `querySpec`'i okur/doğrular, istemci-taraflı `renderArtifactHtml` çağırır, `ArtifactViewer`'a besler), `apiClient.ts`'e `postGenerateWidget` eklentisi, `useGenerateWidgetMutation.ts`, basit bir widget-oluşturma formu (prompt/objectType/themePreset). Testler: `useLiveWidgetQuery`'nin doğru `refetchInterval`/`refetchIntervalInBackground` seçenekleriyle `postObjectsQuery`'yi çağırdığı; `LiveWidgetViewer`'ın geçersiz/bozuk bir saklı `querySpec` karşısında (parse/schema hatası) çökmeden statik `htmlContent`'e GERİ DÜŞTÜĞÜ (fallback); yenileme tick'i sonrası `ArtifactViewer`'a beslenen `htmlContent`'in GÜNCEL satırları yansıttığı; form gönderiminin doğru `{prompt, objectType, themePreset}` gövdesiyle isteği tetiklediği; mutasyon hatasının görünür bir mesaj olarak yüzeye çıktığı.

## Kapsam Dışı

- **Gerçek sunucu-push (WebSocket/SSE).** Ayrı, gelecekteki bir karar/ADR gerektirir (ADR-0042 insan kararı 3).
- **Grup-bazlı (`QuerySpec.group`) canlı widget'lar.** v0'da `compileWidgetQuery` bunu AÇIKÇA reddediyor (parse-başarısız sayıyor) — yalnızca düz (flat) tablo widget'ları destekleniyor (ADR-0042 Karar c/d).
- **Pinned bir widget'ın `querySpec`'ini oluşturmadan SONRA düzenlemek** (görsel sorgu oluşturucu VEYA yeni bir NL prompt'uyla regenerasyon). v0: yalnızca sil+yeniden-oluştur (ADR-0042 Karar j).
- **`QuerySpec`/`SavedView` şemalarının kendisine herhangi bir değişiklik.** Saklanan şey saf, DEĞİŞTİRİLMEMİŞ `QuerySpec` — sütunlar KOD tarafından türetiliyor, AI'a ek bir çıktı şekli DAYATILMIYOR (ADR-0042 Karar g).
- **Grafikler/kart-görünümü gibi `table`-dışı canlı görselleştirmeler.** v0 yalnızca `table`-kind `ArtifactSection`'ı kullanıyor — gelecekte `packages/artifacts`'a YENİ section-kind'lar eklenerek genişletilebilir.
- **`SavedView`'ın paylaşılan-`querySpec`-görünmeyen-alan 404 riskinin çözülmesi.** Bu ADR'nin İCAT ETMEDİĞİ, ZATEN var olan bir sınır — v0'da AYRICA çözülmüyor (ADR-0042 Sonuçlar/Ödünler).

## Kabul Kriterleri

- [ ] **PR1:** `deriveWidgetColumns`, `title`'ı HER ZAMAN ilk sütun yapar; `filters`/`sort`'ta referans verilen alan anahtarlarını dedup'layarak ekler; toplam sütun sayısını `MAX_WIDGET_TABLE_COLUMNS=8`'e kırpar.
- [ ] **PR1:** `buildQueryResultTableSection`, satır sayısını `MAX_WIDGET_TABLE_ROWS=25`'e kırpar; her hücreyi `MAX_WIDGET_CELL_LENGTH=500`'e kırpar; `null`/`undefined` değerleri boş string'e, dizi değerleri (`people`/`multiSelect`) virgülle-ayrılmış string'e çevirir.
- [ ] **PR1 (güvenlik-kritik):** `buildQueryResultTableSection`'ın ürettiği `ArtifactSection`, `renderArtifactHtml`'e verildiğinde, bir fieldValue içine gömülü `<script>alert(1)</script>` gibi adversarial bir string'in render edilen HTML çıktısında kaçış-karakterleriyle YAPISAL OLARAK zararsız hale geldiğini kanıtlayan özel bir test seti içerir.
- [ ] **PR1:** `pnpm --filter @luminaos/artifacts typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.
- [ ] **PR2:** `workspaces.service.ts`'in `seedArtifactFields`'ı `artifact` için `querySpec`(`longText`) alanını doğru seed ediyor — **HİÇBİR migration dosyası yazılmadı** (regresyon: `apps/server/src/db/migrations/` altında `querySpec`/`widget` adını taşıyan hiçbir dosya yok, doğrulandı).
- [ ] **PR2:** `select-ai-model.ts`'e eklenen `outputType:'widgetQuery'`, `CLAUDE_SONNET_5`'e doğru yönlendiriyor.
- [ ] **PR2:** `compileWidgetQuery`, LLM yanıtını `querySpecSchema` ile parse edip `validateCompiledQuerySpec` iş-kuralı katmanından geçirir; `objectType` uyuşmazlığında, `group` içerdiğinde, VEYA bilinmeyen/görünmez bir alana referans verdiğinde reddedip BİR kez retry eder, ikinci deneme de başarısız olursa `parseError:true` sentinel'i döner (`WidgetsService` bunu `ValidationError`'a çevirir).
- [ ] **PR2:** `compileWidgetQuery`'nin clamp'i — AI-üretimi `limit`, `MAX_WIDGET_TABLE_ROWS`'u aşarsa REDDETMEDEN (bu bir hallüsinasyon işareti DEĞİL) `MAX_WIDGET_TABLE_ROWS`'a küçültülür.
- [ ] **PR2:** `POST /workspaces/:workspaceId/artifacts/widgets` üzerinden gerçek bir `artifact` Lumina Object'i oluşturuluyor — `fieldValues.querySpec`/`htmlContent`/`themePreset`/`generationPrompt`/`artifactType`(`'dashboard'`) doğru doldurulmuş; `AIUsageService`'in `withWorkspaceAILock`/kota/bütçe/`recordAIUsage` disiplinine gerçekten uyulduğu doğrulanır.
- [ ] **PR2:** RBAC — `member`+ yeterli, `guest` reddedilmez ama iç `setFieldValues` yazımı sabit `'owner'` rolüyle çalışır (F3-T7 PR2'nin AYNI `'owner'`-bypass regresyon deseni, `guest`'in başarıyla widget üretebildiği ayrı bir testle kanıtlanmış).
- [ ] **PR2 (regresyon):** Mevcut `POST /workspaces/:workspaceId/objects/query` rotası, YENİ oluşturulan widget `artifact` nesnelerini HİÇBİR kod değişikliği olmadan zaten doğru sorguluyor.
- [ ] **PR2:** `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.
- [ ] **PR3:** `useLiveWidgetQuery`, `postObjectsQuery`'yi `refetchInterval=45_000`+`refetchIntervalInBackground:false` seçenekleriyle çağırdığının VE `querySpec === undefined` iken sorgunun `enabled:false` olduğunun ayrı testlerle doğrulanması.
- [ ] **PR3:** `LiveWidgetViewer`, geçersiz/bozuk bir saklı `querySpec` (parse hatası VEYA `querySpecSchema` doğrulama hatası) karşısında ÇÖKMEDEN, nesnenin statik `htmlContent`'ine GERİ DÜŞER (fallback davranışı ayrı bir testle kanıtlanmış).
- [ ] **PR3:** `LiveWidgetViewer`, bir yenileme tick'i sonrası `ArtifactViewer`'a beslenen `htmlContent`'in GÜNCEL sorgu satırlarını yansıttığını (mock edilmiş bir `postObjectsQuery` yanıtı değiştiğinde render'ın da değiştiğini) kanıtlayan bir testle doğrulanmış.
- [ ] **PR3:** Widget-oluşturma formu (prompt + `objectType` + `themePreset` seçimi) gönderildiğinde doğru `{prompt, objectType, themePreset}` gövdesiyle isteği tetikler.
- [ ] **PR3:** Mutasyon hatası (ör. sunucudan `ValidationError`) kullanıcıya görünür bir hata olarak yüzeye çıkar.
- [ ] **PR3:** `pnpm --filter @luminaos/web typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.

## Açık Sorular

- **`SavedView`'ın paylaşılan-`querySpec`-görünmeyen-alan 404 riskinin genel çözümü** (ADR-0042 Bağlam #2/Sonuçlar) — bu görev İÇİNDE ÇÖZÜLMÜYOR, `SavedView`'la BİRLİKTE ele alınabilecek AYRI bir gelecekteki iyileştirme olarak işaretlendi. Bloke edici DEĞİL: v0'da bir widget'ı yalnızca kendi rolüyle ERİŞEBİLDİĞİ alanlara referans verecek şekilde derleyen kullanıcı için sorunsuz çalışır; yalnızca widget SONRADAN daha düşük yetkili bir role paylaşıldığında ortaya çıkabilir.
- **Grup-bazlı canlı widget'lar (durum-bazlı sayaç panoları vb.)** — v0 KASITLI OLARAK reddediyor (ADR-0042 Karar c/d); gerçek talep doğarsa `packages/artifacts`'a `table`'ın yanına yeni bir section-kind (ör. `groupedCounts`) eklenerek AYRI bir gelecekteki genişleme olabilir.

## Sıradaki adım

ADR-0042'nin onayı üzerine, PR1'e (`packages/artifacts` genişlemesi: `deriveWidgetColumns`, `buildQueryResultTableSection`, ilgili sabitler) `test-writer` ile başlanır:

```
docs/adr/ADR-0042-sorgu-canli-widget.md'deki Karar (a)-(j)'yi ve
docs/specs/F3-E3/F3-T8-sorgu-canli-widget.md'nin Kabul Kriterleri'ni temel alarak, F3-T8
PR1 (packages/artifacts genişlemesi: deriveWidgetColumns, buildQueryResultTableSection,
MAX_WIDGET_TABLE_ROWS/MAX_WIDGET_TABLE_COLUMNS/MAX_WIDGET_CELL_LENGTH sabitleri -- sıfır I/O,
mevcut renderArtifactHtml/artifactContentSchema'yı DEĞİŞTİRMEDEN yeniden kullanır) için
test-writer ile başarısız testleri yaz.
```
