# ADR-0041: Artifact Boru Hattı — Sunum/Dashboard/Sayfa Üretimi, Marka Temaları, Tek Prompt Akışı (Epik F3-E3'ün İlk Görevi)

**Durum:** Kabul edildi (v0 çıktı biçiminin öz-yeterli tek bir HTML sayfası olması [insan kararı 1], depolamanın YENİ bir blob/S3 alt sistemi yerine MEVCUT Lumina Object altyapısı olması [insan kararı 2], marka temalarının sabit/küçük bir preset seti olması, gerçek kişiye-özel markalama olmaması [insan kararı 3], VE mimarın insan kararı 1'i "LLM ham HTML/CSS/JS üretir" yerine "LLM yalnızca yapılandırılmış içerik üretir, deterministik bir şablon bunu HTML'e sarar" şeklinde daraltan okumasının [Karar c] insan tarafından AYRICA, açıkça onaylandığı — Plan Mode oturumunda ikinci bir doğrulama turuyla — insan tarafından açıkça onaylandı; sandboxed-iframe render mekanizması [Karar d], paket/servis yerleşimi [Karar a], `artifact`'ın nesne modeline entegrasyonu [Karar b], somut preset tanımları [Karar e], `artifactType` kapsamının netleştirilmesi [Karar f], RBAC [Karar g] ve HTTP yüzeyi [Karar h] mimarinin KENDİ çıkarımı — aşağıda ayrıca işaretlendi, insan tarafından dikte edilmedi.)
**Tarih:** 2026-09-11
**İlgili görev:** F3-T7 — Artifact boru hattı: sunum/dashboard/sayfa üretimi, marka temaları, tek prompt akışı. `docs/PLAN.md` satır 287, FAZ 3, **Epik F3-E3'ün İLK görevi** (Kapsam L: "Artifact üretimi [sunum, dashboard, sayfa, rapor] + 'Sorgu → canlı widget'", satır 33/285-289) — F3-E2 (Cam Kutu Otonomi, ADR-0037/0038/0039/0040)'den TAMAMEN bağımsız, YENİ bir Kapsam'ın ilk mimari kararı.
**İlgili plan referansı:** CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin İKİNCİ fıkrasını tetikliyor: bu karar birden fazla pakete ve gelecekteki göreve (bilhassa F3-T8'in "canlı widget"i, F3-T7'nin STATİK artifact'ının doğrudan devamı) dayatılan yeni bir veri şekli/kontrat tanımlıyor (`ArtifactContent`, `artifact` Lumina Object'in alan şekli, tema-preset kontratı). Ayrıca dolaylı olarak ilk fıkrayı da tetikliyor: LLM-üretimi HTML'in kullanıcı tarayıcısında NASIL render edileceği kararı, "hassas veri sınıfları buluta ham gönderilmez" ve genel güvenlik duruşuyla doğrudan gerilim yaratan bir XSS/stored-script yüzeyi açıyor — bu ADR bunu ele alıyor.

> Bu ADR, F3-E2'nin (ADR-0037/38/39/40) mimari devamı DEĞİL — Epik F3-E3'ün (Kapsam L) SIFIRDAN ilk görevi. Bir `explorer` alt-ajanı, `packages/artifacts/` (PLAN.md satır 86'da vaat edilmiş ama hiç oluşturulmamış), `packages/view-engine/` (aynı şekilde vaat edilmiş, hiç oluşturulmamış), herhangi bir blob/nesne depolama, workspace-başına markalama, herhangi bir HTML/PDF render kütüphanesi, ve uzun-form/çok-bölümlü AI üretim emsalinin (yalnızca kısa yapılandırılmış-JSON üretimi var) kod tabanında HİÇ OLMADIĞINI doğrudan koddan doğruladı. Bu ADR bu boşluğun TAMAMINI aynı anda kapatmaya ÇALIŞMIYOR — yalnızca F3-T7'nin dar v0 kapsamını (aşağıdaki 3 insan kararı) somutlaştırıyor, geri kalanı (gerçek blob depolama, gerçek kişiye-özel markalama, PDF/PPTX export, canlı dashboard) AÇIKÇA erteliyor.

## Bağlam

Doğrudan koddan doğrulandı (bir `explorer` alt-ajanı tarafından):

1. **`packages/artifacts/` YOK** — `docs/PLAN.md`'nin kendi monorepo haritası (satır 86: `artifacts/ # L: Artifact üretim boru hattı`) bu paketi ÖNCEDEN vaat etmiş ama hiç oluşturulmamış. `packages/view-engine/` (satır 79) de aynı şekilde yok — görünüm bileşenleri `apps/web/src/views/` altında ad-hoc yaşıyor.
2. **Paket önyükleme şablonu**: `packages/agent-runtime`/`packages/automation` "yeni domain paketi" şablonu — `package.json` (`private:true, type:"module"`, `main`/`types` → `./dist`, `exports` haritası, `scripts:{build:"tsc -p tsconfig.build.json", typecheck, test:"vitest run --coverage", lint:"eslint ."}`, devDeps `@vitest/coverage-v8`/`fast-check`/`typescript`/`vitest`, tek runtime bağımlılığı `@luminaos/shared`+`zod`), `tsconfig.json` `tooling/tsconfig/base.json`'u extend eder, `vitest.config.ts` `coverageConfig(95)` kullanır, `eslint.config.js` `baseConfig` + `react`/`react-dom`/`@nestjs/*` üzerine `no-restricted-imports` yasağı (CLAUDE.md'nin "domain paketleri framework-free" kuralını uygular).
3. **AI üretim deseni**: `parseCommand` (`apps/server/src/ai/parse-command.ts:141-168`) kanonik şekil — SADECE JSON isteyen bir prompt kurar (markdown fence yok), `provider.complete({prompt, model})` çağırır, `JSON.parse` + zod `safeParse`, bir kez retry, yoksa `{parseError:true, message}` sentinel'i döner. `AIProvider.complete(request:{prompt, maxTokens?, model?}): Promise<{text, usage, model?}>` (`packages/ai-gateway/src/provider.ts`) vendor-agnostik — `MockProvider`/`AnthropicProvider` tek implementasyonlar. `selectAIModel` (`apps/server/src/ai/select-ai-model.ts`) `outputType:'text'|'select'|'qa'|'command'|'triggerSuggestion'`'i bir model sabitine eşliyor — YENİ bir `'artifact'` `outputType` eklenmesi gerekiyor. **Uzun-form/çok-bölümlü üretim için SIFIR mevcut emsal var** — her mevcut akış ya kısa yapılandırılmış JSON ya tek düz bir cevap metni üretiyor; hiçbiri markdown/HTML/çok-bölümlü doküman üretmiyor.
4. **Doküman altyapısı**: `packages/core-objects`'in `doc` nesne tipi KENDİ `Block[]` şemasına (`doc/block.ts`) sahip ama bu şema ÖLÜ/kullanılmıyor (ADR-0016 §d bunu reddetti) — gerçek depolama bir Yjs CRDT (`document-reconstruction.service.ts` tam-durum snapshot'ları `documentSnapshots` tablosundan okuyor, `yjs-to-markdown.ts` BlockNote'un XML fragment'ini Markdown'a ağaç-dolaşımıyla çeviriyor). **Kod tabanında HİÇBİR YERDE HTML/PDF render YOK** (repo-çapında puppeteer/playwright/pdfkit/jsPDF/html-pdf için sıfır sonuç).
5. **View-engine/dashboard**: `packages/view-engine` YOK; görünüm bileşenleri `apps/web/src/views/` altında ad-hoc. `SavedView` (`packages/core-objects/src/saved-views/saved-view.ts:13-28`) yalnızca `{objectType, viewType, querySpec, dateField?, ownerId, lifecycle}` saklıyor — bir SORGU YAPILANDIRMASI, asla dondurulmuş bir veri snapshot'ı değil. "Bu görünümün şu anki verisini dondur" yeteneği HİÇ YOK.
6. **Markalama**: Salt sabit global açık/koyu tema anahtarı (`packages/ui/src/theme/ThemeProvider.tsx`, `tokens.css` — iki sabit-kodlanmış `:root` bloğu). Workspace-başına gerçek marka/logo/renk özelleştirmesi şemada veya UI'da HİÇ YOK.
7. **Depolama/sunum**: `apps/server`'da hiçbir yerde nesne depolama bağlanmamış (`S3Client`/`presigned`/`@aws-sdk`/`multer` sıfır sonuç). `docs/specs/F2-E4/F2-T13-notetaker-botu.md:33` bu tam boşluğu ZATEN belgeliyor. Tek "başka formata export" emsali, `apps/server/src/export/export.controller.ts` + `ical-generator.ts`, TAMAMEN senkron/bellek-içi: bir string kurar, doğrudan HTTP yanıt gövdesi olarak gönderir — hiçbir şey kalıcılaştırılmıyor, hiçbir kalıcı link yok, statik-dosya sunumu yok.
8. **`ObjectType` union'ı** (`packages/core-objects/src/lumina-object.ts:6`): `'task'|'doc'|'note'|'timeblock'|'meeting'` — `object-type-registry.ts` bunu `Record<ObjectType,{titleRequired:boolean}>` olarak tutuyor, yeni bir tip eklemek = bu registry'ye bir satır eklemek (+ kendi field-definition seed'i).
9. **Alan-değeri depolama**: `field_values` (`objects_view` tablosu) düz bir `{[fieldKey]:value}` JSONB haritası — YENİ bir sütun/tablo GEREKMİYOR, herhangi bir `FieldType` için değer bu jsonb sütununda yaşıyor. `objects_view.type`, `field_definitions.object_type` — İKİSİ de düz `varchar`, hiçbir DB-seviyesi CHECK/enum kısıtlaması YOK; yeni bir `ObjectType` eklemek HİÇBİR migration GEREKTİRMİYOR. `field-type-registry.ts`'in `buildValueSchema`'sı `text`/`longText` için `z.string()` döner — **sınırsız** (bkz. `intent`/`rationale` gibi AI-etkili alanların `.max()` sınırlarıyla TEZAT — onlar görüntüleme-amaçlı ÖZETLER, `longText` ise ham bir metin blob'u için tasarlandı).
10. **`AgentActionRecordsService`/ledger, `CommandsService.decide()`, autonomy-tier** — bunların HİÇBİRİ artifact üretimiyle doğrudan ilgili DEĞİL: `resolveAIFieldValue`/`answerQuestion`'ın (`apps/server/src/ai/`) mevcut kategorisi — kullanıcının DOĞRUDAN, senkron olarak istediği bir AI-üretimi, `parseCommand`'ın "AI kullanıcı adına aksiyonlar ÖNERİYOR, onay/otonomi-kademesi/geri-alma gerekiyor" kategorisi DEĞİL. Bu ayrım aşağıda "Mimari Değişmezlerle İlişki"de tekrar ele alınıyor.
11. **AI kullanım disiplini (zorunlu tekrar kullanım)**: `AIUsageService` (`apps/server/src/ai/ai-usage.service.ts`) — HERHANGİ bir yeni AI-üretim akışı, `withWorkspaceAILock(workspaceId, fn)` İÇİNDE, sırasıyla `assertAITokenQuotaNotExceeded`, `assertAICostBudgetNotExceeded`, sonra provider çağrısı + `recordUsage` geri çağırımıyla `recordAIUsage(workspaceId, fieldDefinitionId, objectId, usage, model)` çağırmalı — `CommandsService.parse`'ın (`commands.service.ts:364-399`) BİREBİR aynısı, `fieldDefinitionId`/`objectId` ikisi de `undefined` (bağlam-özgür üretim için ADR-0014 §a/§b'nin ZATEN opsiyonel kıldığı şekil).
12. **RBAC emsali**: `CommandsController`'ın `POST parse` rotası yalnızca `SessionAuthGuard, WorkspaceMembershipGuard` altında — EK bir admin-gate YOK (herhangi bir member+ tetikleyebilir). `AutonomyTierSettingsService.set` ise (ADR-0039 §i) `admin`+ — ama bu bir POLİTİKA-AYARI yazma kapısı, "AI'ı tetikleme" kapısı DEĞİL. `ObjectsController`'ın generic `POST /objects`, `GET /objects`, `GET /objects/:objectId`, `POST /objects/query` rotaları AYNI guard yığınıyla ZATEN var — RBAC gerçek kontrolü `ObjectsService` içinde `callerRole` ile yapılıyor.

**İnsan kararları (bu Plan Mode oturumunda alındı):**

1. **v0 çıktı biçimi: yalnızca öz-yeterli (self-contained) HTML.** Üretilen bir artifact, tek, öz-yeterli bir HTML sayfasıdır — Claude'un kendi "Artifacts" özelliğini yansıtır. v0'da PDF/PowerPoint export YOK — yeni, ağır bir render bağımlılığı (puppeteer vb.) gerektireceği için AÇIKÇA reddedildi. Gerekçe: sıfır yeni runtime bağımlılığı, sunucu-taraflı render altyapısı gerekmiyor, ekibin ZATEN bildiği bir deseni (Claude'un kendi Artifacts UX'i) yansıtıyor.
2. **v0 depolama: yeni bir `artifact` Lumina Object tipi, içerik Postgres'te.** Gerçek S3-uyumlu blob depolama standa alınmasına BAĞLI DEĞİL (`docs/specs/F2-E4/F2-T13` ZATEN bu boşluğu işaretliyor) — üretilen HTML içeriği, MEVCUT event-kaynaklı Lumina Object altyapısı (`packages/core-objects`'in ZATEN kurulu nesne-tipi/alan-değeri/event-sourcing deseni) kullanılarak saklanır, YENİ bir depolama alt sistemi DEĞİL. Gerçek blob depolama AYRI, gelecekteki bir altyapı kararına ertelenir.
3. **v0 "marka temaları" kapsamı: küçük, sabit bir dahili tema-preset seti** (3-4 isimli preset — mimari son isimleri/sayıyı seçer, küçük tutar), üretim ANINDA seçilir, salt bir CSS değişken/tasarım-token seti olarak prompt/şablona akıtılır — gerçek workspace-başına özel markalama (logo yükleme, özel renk seçici) DEĞİL. Gerçek workspace-başına markalama dosya-depolama gerektirir (karar 2 tarafından bloklanır) ve AÇIKÇA ertelenir.
4. **(İkinci doğrulama turu) Karar 1'in "LLM ham HTML/CSS/JS üretir" ifadesi, mimarın önerdiği şekilde daraltılarak onaylandı: LLM yalnızca yapılandırılmış içerik (başlık + tipli bölümler) üretir, HTML'i kod-yazılı bir şablon üretir (Karar c).** Nihai artifact yine öz-yeterli TEK bir HTML sayfasıdır (karar 1'in kendisi DEĞİŞMEDİ) — yalnızca LLM'in KONTROL ETTİĞİ yüzey (ham markup) kaldırılarak XSS/stored-script riski yapısal olarak ortadan kaldırılıyor. Mimar bu daraltmayı kendi başına kararlaştırmadı, insana AÇIKÇA sordu ve onay ALDI.

**Çözülmesi gereken merkezi sorular:** paket/servis yerleşimi (a), `artifact`'ın Lumina Object modeline entegrasyonu — yeni ayrılmış alan mı, genel özel-alan mı, Postgres şekli (b), LLM ham HTML mi yoksa yapılandırılmış içerik mi üretmeli — üretim akışının kendisi (c), LLM-üretimi HTML tarayıcıda GÜVENLE nasıl render edilir (d), somut tema-preset tanımları (e), `artifactType` kapsamı — sunum/dashboard/sayfa/rapor'un TAMAMI mı, dashboard STATİK mi (f), RBAC (g), HTTP yüzeyi (h).

## Karar

### (a) Yerleşim — YENİ `packages/artifacts` (saf tipler) + `apps/server/src/artifacts/` (servis/controller), ADR-0038/0039'un AYNI ikili bölünmesi

`docs/PLAN.md`'nin kendi monorepo haritası `packages/artifacts/`'ı ZATEN bu Kapsam'ın evi olarak işaretlemiş (satır 86) — bunu oluşturmamak için somut bir gerekçe YOK, tam tersine: `ArtifactType`, `ThemePreset` tanımları (CSS-değişken haritaları, PURE veri), `ArtifactContent` yapılandırılmış-içerik şeması (Karar c), ve `renderArtifactHtml` (içerik+tema → HTML string, SIFIR I/O, saf bir dönüşüm) — bunların HEPSİ hiçbir DB/HTTP/provider bağımlılığı olmayan, tamamen birim-test edilebilir saf domain mantığı, `packages/agent-runtime`'ın `AgentActionRecord`/`RollbackPlan` tipleriyle AYNI kategoride. `packages/artifacts` bu dördünü barındırır.

**`generateArtifact` orkestratörü (provider çağıran, I/O yapan taraf) `packages/artifacts`'a DEĞİL, `apps/server/src/artifacts/generate-artifact.ts`'e konur** — `parseCommand`/`answerQuestion`/`resolveAIFieldValue`'ın (`apps/server/src/ai/`) hepsinin "provider enjekte edilen ama DB'siz orkestratör" olmasına RAĞMEN `apps/server/src/ai/`'de yaşamasıyla AYNI konumlandırma mantığı — TEK fark, `parseCommand` genel `CommandsService`'in TEK bir çağıranı tarafından kullanılıyor (birden fazla `ai/` yardımcısı arasında paylaşılan bir konvansiyon), `generateArtifact` ise YALNIZCA bu ADR'nin YENİ `ArtifactsService`'i tarafından kullanılacak — kendi özellik-dizini (`apps/server/src/artifacts/`) zaten açılıyor olduğundan, artifact'a özgü tüm sunucu kodunu (orkestratör dahil) ORADA birlikte tutmak, `src/ai/`'e üçüncü bir domain-özgü dosya daha eklemekten daha tutarlı.

`packages/artifacts` iskeleti: `package.json` (`private:true,type:"module"`, `main`/`types`→`./dist`, `scripts` şablonu birebir `packages/agent-runtime`'ınki), `tsconfig.json` → `tooling/tsconfig/base.json`, `vitest.config.ts` → `coverageConfig(95)`, `eslint.config.js` → `baseConfig` + `react`/`@nestjs/*` yasağı. Tek runtime bağımlılığı `@luminaos/shared` + `zod`.

`apps/server/src/artifacts/`: `generate-artifact.ts` (orkestratör), `artifacts.service.ts` (NestJS — `AIUsageService`+`ObjectsService` enjekte eder, gerçek `artifact` nesnesini yaratır), `artifacts.controller.ts` (tek `POST` rotası, Karar h), `artifacts.module.ts`.

### (b) `artifact` Lumina Object modeli — genel özel-alanlar, YENİ ayrılmış DB kolonu YOK, migration YOK

`ObjectType` union'ına `'artifact'` eklenir (`titleRequired:true` — `task`/`meeting` ile aynı kategori, üretilen bir artifact'ın insan/AI tarafından verilmiş anlamlı bir başlığı olmalı). Bağlam #9'un doğruladığı gibi `objects_view.type`/`field_definitions.object_type` düz `varchar`, hiçbir DB-seviyesi CHECK/enum kısıtlaması yok — **bu tek başına hiçbir migration gerektirmez**, yalnızca `object-type-registry.ts`'e bir kod satırı.

4 alan, workspace-kurulum-anındaki MEVCUT default-field-seeding mekanizmasıyla (`workspaces.service.ts`, diğer nesne tiplerinin default alanlarını seed ettiği AYNI yol) seed edilir — HİÇBİRİ yeni bir `FieldType` gerektirmez, `field-type-registry.ts`'in 14 mevcut tipinden 2'si yeniden kullanılır:

| Alan               | `FieldType`                                      | Gerekçe                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `htmlContent`      | `longText`                                       | `buildValueSchema`'nın `longText` için döndüğü `z.string()` ZATEN sınırsız (Bağlam #9) — tam bir HTML dokümanı (onlarca KB) için doğru şekil; `intent`/`rationale` gibi görüntüleme-amaçlı özetlerin `.max()` sınırlarıyla KARIŞTIRILMAMALI.                 |
| `themePreset`      | `select`, `options` = Karar (e)'nin 3 preset adı | Sabit preset setini (insan kararı 3) FIELD-DEFİNİTİON seviyesinde uygulanabilir kılar — uygulama koduna değil, `select` alanının kendi `options` kısıtına güvenir; ayrıca preset'e göre filtrelemeyi ZATEN var olan sorgu DSL'i üzerinden bedava kazandırır. |
| `generationPrompt` | `longText`                                       | Kullanıcının orijinal doğal-dil isteğini denetim/yeniden-üretim bağlamı için saklar.                                                                                                                                                                         |
| `artifactType`     | `select`, `options` = Karar (f)'nin 4 tipi       | Aynı `select`-kısıtlama mantığı.                                                                                                                                                                                                                             |

**Yeni ayrılmış DB kolonu (timeblock'un `timeBlockStart`/`timeBlockEnd`'i gibi) GEREKMİYOR** — o desen SADECE tipli/aralık-sorgulanabilir alanlar (takvim senkronu) için var; `artifact`'ın 4 alanının hiçbiri tipli aralık sorgusu gerektirmiyor, opak blob'lar/etiketler olarak genel özel-alan altyapısı yeterli.

**Yazma-anı boyut sınırı (`htmlContent` için) — GEREKLİ, uygulanır.** `longText`'in `buildValueSchema`'sı sınırsız olsa da, bir adversarial/kötü-davranan prompt modeli aşırı büyük bir çıktı üretmeye kışkırtabilir; bu hem `objects_view.field_values`'in GIN-indeksli jsonb sütununu şişirebilir hem depolama-suistimali riski taşır. `MAX_ARTIFACT_HTML_LENGTH = 200_000` (karakter) sınırı `generateArtifact`'ın KENDİSİNDE (Karar c) uygulanır — genel `field-type-registry.ts`'e ÖZEL bir `artifact`-durumu EKLENMEZ (paylaşılan altyapı bir tek nesne tipi için özelleştirilmemeli); sınır aşılırsa `parseCommand`'ın "retry sonra sentinel" desenine benzer şekilde başarısızlık sinyali döner (sessizce kesmek yerine — kesilmiş bir HTML, bozuk markup'tan daha kötü olurdu).

### (c) Üretim akışı — YAPILANDIRILMIŞ İÇERİK + deterministik şablon, LLM HAM HTML/CSS/JS ÜRETMEZ

**En yük taşıyan Karar.** LLM'e TAM bir HTML dokümanı ürettirmek YERİNE, `generateArtifact` LLM'den yalnızca yapılandırılmış İÇERİK ister — bir başlık + tipli bölüm listesi (`heading`/`paragraph`/`list`/`table`/`imagePlaceholder`) — bu JSON, `packages/artifacts`'ın hand-written, versiyonlanmış bir HTML şablonu (+ seçilen tema preset'inin CSS'i) tarafından sarmalanır. Nihai `htmlContent` (insan kararı 1'in "öz-yeterli tek HTML sayfası" biçimini KARŞILAR, onu İHLAL ETMEZ — şablon bir kez, generation anında çalışan SAF bir string-dönüşümü, kalıcı bir sunucu-taraflı render pipeline'ı DEĞİL) bu sarmalamanın ürünüdür.

**Neden bu, ham-HTML-üretiminden ÜSTÜN (Karar d'nin güvenlik gerekçesiyle doğrudan bağlantılı):** şablon KOD tarafından yazılıyor, LLM tarafından DEĞİL — LLM'in kontrol ettiği HER string (`title`, bölüm metinleri, tablo hücreleri) şablona interpolasyondan ÖNCE HTML-escape edilir (`escapeHtml` her interpolasyon noktasında). Sonuç: nihai `htmlContent` YAPISAL OLARAK `<script>` etiketi, satır-içi olay-işleyici özniteliği (`onerror=`, `onclick=`), veya `javascript:` URL'si İÇEREMEZ — LLM bunları asla ÜRETME KONUMUNDA değil, çünkü çıktısı hiçbir zaman ham markup olarak ele alınmıyor. Bu, "her üretimde adversarial-HTML'e karşı savunmak" problemini "bir kez yazılmış, bir kez gözden geçirilmiş şablon fonksiyonunun metni güvenle render ettiğini doğrulamak" problemine indirger.

```ts
// packages/artifacts/src/artifact-content.ts
export interface ArtifactSection {
  kind: 'heading' | 'paragraph' | 'list' | 'table' | 'imagePlaceholder';
  text?: string; // heading/paragraph
  level?: 1 | 2 | 3; // heading only
  items?: string[]; // list
  headers?: string[]; // table
  rows?: string[][]; // table
  caption?: string; // imagePlaceholder -- v0 never embeds a real image (no
  // blob storage, insan kararı 2); this kind renders a labeled placeholder box.
}

export interface ArtifactContent {
  title: string;
  sections: ArtifactSection[];
}

const artifactSectionSchema = z
  .object({
    kind: z.enum(['heading', 'paragraph', 'list', 'table', 'imagePlaceholder']),
    text: z.string().max(2000).optional(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    items: z.array(z.string().max(500)).max(50).optional(),
    headers: z.array(z.string().max(200)).max(20).optional(),
    rows: z
      .array(z.array(z.string().max(500)).max(20))
      .max(100)
      .optional(),
    caption: z.string().max(300).optional(),
  })
  .strict();

export const artifactContentSchema = z
  .object({
    title: z.string().min(1).max(300),
    sections: z.array(artifactSectionSchema).min(1).max(100),
  })
  .strict();
```

```ts
// packages/artifacts/src/render-artifact-html.ts
// PURE -- no I/O, no provider call. Every user/LLM-supplied string is escaped
// BEFORE interpolation (Karar c/d's central security guarantee).
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSection(section: ArtifactSection): string {
  switch (section.kind) {
    case 'heading':
      return `<h${section.level ?? 2}>${escapeHtml(section.text ?? '')}</h${section.level ?? 2}>`;
    case 'paragraph':
      return `<p>${escapeHtml(section.text ?? '')}</p>`;
    case 'list':
      return `<ul>${(section.items ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    case 'table': {
      const headerRow = `<tr>${(section.headers ?? []).map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
      const bodyRows = (section.rows ?? [])
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
        .join('');
      return `<table>${headerRow}${bodyRows}</table>`;
    }
    case 'imagePlaceholder':
      return `<div class="artifact-image-placeholder">${escapeHtml(section.caption ?? 'Görsel')}</div>`;
  }
}

/** v0 emits ZERO <script> tags -- every artifactType renders a fully static
 * document (consistent with Karar (f)'s "dashboard is a static snapshot"). */
export function renderArtifactHtml(
  content: ArtifactContent,
  theme: ThemePresetName,
  artifactType: ArtifactType,
): string {
  const preset = THEME_PRESETS[theme];
  const cssVariables = Object.entries(preset.cssVariables)
    .map(([key, value]) => `${key}: ${value};`)
    .join(' ');
  const body = content.sections.map(renderSection).join('\n');

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<title>${escapeHtml(content.title)}</title>`,
    `<style>:root { ${cssVariables} } body { background: var(--artifact-bg); color: var(--artifact-fg); font-family: var(--artifact-font); } h1,h2,h3 { color: var(--artifact-accent); } table { border-collapse: collapse; } th,td { border: 1px solid var(--artifact-fg); padding: 4px 8px; } .artifact-image-placeholder { border: 1px dashed var(--artifact-fg); padding: 24px; text-align: center; }${artifactType === 'presentation' ? ' section.artifact-section { min-height: 90vh; page-break-after: always; }' : ''}</style>`,
    '</head><body>',
    `<h1>${escapeHtml(content.title)}</h1>`,
    body,
    '</body></html>',
  ].join('');
}
```

```ts
// apps/server/src/artifacts/generate-artifact.ts
export interface GenerateArtifactInput {
  provider: AIProvider;
  prompt: string;
  artifactType: ArtifactType;
  themePreset: ThemePresetName;
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface GenerateArtifactResult {
  htmlContent: string;
  parseError: boolean;
  message?: string;
}

const MAX_ARTIFACT_HTML_LENGTH = 200_000;
const GENERATE_EXHAUSTED_MESSAGE =
  'AI response could not be parsed into valid artifact content after retry';

function renderContentPrompt(prompt: string, artifactType: ArtifactType): string {
  return [
    `Generate the CONTENT for a "${artifactType}" based on the request below.`,
    'Respond with ONLY a JSON object (no surrounding text, no markdown fences) with exactly these fields:',
    "- title: a short string, the artifact's title",
    '- sections: an array of section objects, each with a "kind" field ("heading"|"paragraph"|"list"|"table"|"imagePlaceholder") plus kind-specific fields',
    'Do NOT include any HTML, CSS, or JavaScript -- structured content only, the presentation layer is applied separately.',
    '',
    `Request: ${prompt}`,
  ].join('\n');
}

function tryParseContent(text: string): ArtifactContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = artifactContentSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export async function generateArtifact(
  input: GenerateArtifactInput,
): Promise<GenerateArtifactResult> {
  const prompt = renderContentPrompt(input.prompt, input.artifactType);

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({
      prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const content = tryParseContent(await complete()) ?? tryParseContent(await complete());

  if (content === undefined) {
    return { htmlContent: '', parseError: true, message: GENERATE_EXHAUSTED_MESSAGE };
  }

  const htmlContent = renderArtifactHtml(content, input.themePreset, input.artifactType);

  if (htmlContent.length > MAX_ARTIFACT_HTML_LENGTH) {
    return {
      htmlContent: '',
      parseError: true,
      message: 'Generated artifact exceeded the maximum allowed size',
    };
  }

  return { htmlContent, parseError: false };
}
```

`select-ai-model.ts`'e YENİ `outputType:'artifact'` eklenir, `'text'`/`'qa'`/`'command'`/`'triggerSuggestion'`'la AYNI mantıkla (`CLAUDE_SONNET_5`'e yönlendirilir — açık-uçlu üretim, kısıtlı-seçim görevi DEĞİL).

### (d) Güvenli render — sandboxed `<iframe>`, `srcdoc`, BOŞ `sandbox` özniteliği

Karar (c) SAYESİNDE, `htmlContent` YAPISAL OLARAK sıfır `<script>`/olay-işleyici/`javascript:` URL'si içerir — ama savunma-derinliği ilkesi gereği, render mekanizmasının KENDİSİ de bunu VARSAYMAMALI, kanıtlamalı. `apps/web`'in YENİ `ArtifactViewer` bileşeni, LLM-etkili/üretilmiş HER içeriği (bu tam olarak o durum) render etmenin YERLEŞİK, iyi anlaşılmış deseni olan sandboxed `<iframe>` + `srcdoc` kullanır (CodeSandbox/CodePen/Claude'un kendi Artifacts'inin AYNI deseni):

```tsx
// apps/web/src/views/shared/ArtifactViewer.tsx
export function ArtifactViewer({ htmlContent }: { htmlContent: string }): JSX.Element {
  return (
    <iframe
      title="artifact-preview"
      srcDoc={htmlContent}
      // Intentionally EMPTY: v0's `htmlContent` is produced ENTIRELY by
      // `renderArtifactHtml()` (packages/artifacts) from LLM-supplied
      // STRUCTURED CONTENT (title + typed sections) -- never raw
      // LLM-authored markup -- every string is HTML-escaped before
      // interpolation (ADR-0041 Karar c/d). The rendered document therefore
      // contains NO <script> tags, NO inline event-handler attributes, NO
      // `javascript:` URLs, BY CONSTRUCTION. An empty `sandbox` attribute is
      // the MOST restrictive setting available (no scripts, no
      // same-origin, no forms, no top-navigation, no popups, no pointer
      // lock) -- appropriate because nothing here NEEDS any of those
      // capabilities.
      //
      // NEVER add `allow-scripts` to this attribute without ALSO revisiting
      // ADR-0041 Karar (c) (i.e. without re-permitting LLM-authored raw
      // markup). And if that ever happens: `allow-same-origin` must NEVER
      // be combined with `allow-scripts` on the SAME sandbox value -- that
      // combination lets the framed document reach back into the PARENT
      // origin (read `document.cookie`, issue same-session `fetch()`
      // calls against internal APIs, manipulate the parent DOM), which
      // defeats the sandbox entirely.
      sandbox=""
      style={{ width: '100%', height: '100%', border: 'none' }}
    />
  );
}
```

`srcdoc` (bir `src="/artifacts/<id>"` URL'si DEĞİL) tercih edilir çünkü `srcdoc` içeriği tarayıcı tarafından benzersiz opak bir origin'den geliyormuş gibi işlem görür — ayrı bir static-file sunumu/farklı-alt-alan-adı altyapısı GEREKMEDEN aynı izolasyon garantisini verir; bu, insan kararı 2'nin "içerik Postgres'te, YENİ bir depolama alt sistemi yok" seçimiyle DE tutarlı (içerik doğrudan API yanıtından `srcDoc`'a akar, ayrı bir statik sunucudan DEĞİL).

**Yazma-anı sanitizasyon gerekli mi?** Evet ama İKİ farklı KATMANDA, hiçbiri "HTML sanitize et" biçiminde DEĞİL: (1) Karar (c)'nin `artifactContentSchema`'sı GİRDİYİ (LLM'in içerik olarak üretebileceği metin uzunluğu/bölüm sayısı) sınırlar, (2) Karar (b)'nin `MAX_ARTIFACT_HTML_LENGTH` sınırı ÇIKTIYI (nihai render edilmiş string) sınırlar. Genel bir HTML-sanitizer kütüphanesi (`DOMPurify` vb.) KASITLI OLARAK EKLENMEDİ — Karar (c) zaten LLM'i ham HTML üretme KONUMUNDAN çıkardığı için, "güvenilmeyen HTML'i temizle" problemi bu tasarımda hiç ORTAYA ÇIKMIYOR; bir sanitizer eklemek, çözülmüş bir problem için gereksiz bir bağımlılık+saldırı-yüzeyi olurdu.

### (e) Tema presetleri — sabit 3 preset (insan kararı 3'ün somutlaştırılması)

```ts
// packages/artifacts/src/theme-preset.ts
export type ThemePresetName = 'kurumsal' | 'canli' | 'minimal';

export interface ThemePreset {
  name: ThemePresetName;
  cssVariables: Record<string, string>;
}

export const THEME_PRESETS: Record<ThemePresetName, ThemePreset> = {
  kurumsal: {
    name: 'kurumsal',
    cssVariables: {
      '--artifact-bg': '#ffffff',
      '--artifact-fg': '#1f2937',
      '--artifact-accent': '#1d4ed8',
      '--artifact-font': 'Georgia, serif',
    },
  },
  canli: {
    name: 'canli',
    cssVariables: {
      '--artifact-bg': '#0f172a',
      '--artifact-fg': '#f8fafc',
      '--artifact-accent': '#f97316',
      '--artifact-font': '"Segoe UI", sans-serif',
    },
  },
  minimal: {
    name: 'minimal',
    cssVariables: {
      '--artifact-bg': '#ffffff',
      '--artifact-fg': '#111827',
      '--artifact-accent': '#111827',
      '--artifact-font': 'ui-sans-serif, system-ui',
    },
  },
};
```

3 preset seçildi (4 değil) — v0 için "küçük" tutma talimatını en dar şekilde karşılar; gelecekte gerçek bir ihtiyaç doğarsa bu kayda EKLEME yapmak (kod tabanının başka hiçbir yerini değiştirmeden) triviyaldir.

### (f) `artifactType` kapsamı — 4 tip DAHİL, `dashboard` v0'da STATİK bir snapshot

```ts
// packages/artifacts/src/artifact-type.ts
export type ArtifactType = 'presentation' | 'dashboard' | 'page' | 'report';
```

Kapsam L'nin PLAN.md ifadesi ("sunum, dashboard, sayfa, rapor") 4 tipin de v0'da GEÇERLİ `artifactType` etiketleri olmasını haklı çıkarır — ama HEPSİ AYNI üretim/render yolunu (Karar c/d) paylaşır, hiçbir tip için ayrı bir kod dalı YOK; TEK fark `artifactType`'ın prompt'a ve (isteğe bağlı, `page-break-after` gibi) şablon-CSS'ine geçirilmesi. **`dashboard` bu görevde KESİNLİKLE STATİK, tek-seferlik bir üretimdir** — AI'a doğal-dil bir istek verilir, sonucu STATİK HTML'e gömülür; kendini-yenileyen, yeniden-sorgulanabilir bir panel DEĞİLDİR. Bu okuma Bağlam #5'in (`SavedView`'ın hiçbir veri-snapshot yeteneği olmadığı) ve `docs/PLAN.md`'nin kendi F3-T8 tanımının ("Sorgu → canlı widget": doğal dil sorgusunu sabitlenebilir, KENDİNİ YENİLEYEN panel bileşenine derleme) DOĞRUDAN sonucudur — "canlı, kendini yenileyen" F3-T7'nin DEĞİL, F3-T8'in vaadi.

**Kapsam Dışı (F3-T8'e işaret eder, ADR-0040'ın `assignPeople`/`reconfigureAgentPermissions` gerçek-geri-almasını ertelemesiyle AYNI desen):** canlı, yeniden-sorgulanan, kendini-yenileyen bir dashboard bu ADR'nin kapsamı dışıdır — F3-T8'in KENDİ mimari kararı.

### (g) RBAC — `member`+, `CommandsService.parse()`'ın AYNI gate'i

Artifact üretimi bir AI-maliyeti-oluşturan, workspace-kotası-tüketen bir işlem — ama `AutonomyTierSettingsService.set`'in `admin`+ gate'i (ADR-0039 §i) YANLIŞ emsal: o bir POLİTİKA-AYARI yazma kapısı ("hangi aksiyon tipi hangi otonomi kademesinde OLSUN" kararı), "AI'ı TETİKLEME" kapısı DEĞİL. Doğru emsal `CommandsService.parse()`'ın KENDİ gate'i (Bağlam #12): yalnızca `SessionAuthGuard`+`WorkspaceMembershipGuard`, EK bir admin-gate YOK — "herhangi bir member AI'dan kendisi için bir şey üretmesini isteyebilir" işlemi, "bu gerçek maliyete mal olduğu için kısıtlanmalı" gerilimi bu kod tabanında ZATEN `parse()` için ÇÖZÜLMÜŞ; gerçek maliyet-kontrolü RBAC katmanında DEĞİL, `AIUsageService`'in workspace-başına kota/bütçe kontrolünde yaşıyor (Bağlam #11) — bu ayrım artifact üretimi için de AYNEN korunur.

### (h) HTTP yüzeyi — YENİ `POST .../artifacts`, `GET`'ler `ObjectsController`'dan MİRAS

`POST /workspaces/:workspaceId/artifacts` — gövde `{prompt: string (max 4000), artifactType: ArtifactType, themePreset: ThemePresetName}` (zod ile doğrulanır), `SessionAuthGuard`+`WorkspaceMembershipGuard` altında, `ObjectsController`'ın AYNI `requireActor`/`requireRole` desenini izler. `ArtifactsService.generate` `AIUsageService.withWorkspaceAILock` içinde `generateArtifact`'ı çağırır, sonra `ObjectsService.create(workspaceId, {type:'artifact', title: content.title, fieldValues:{htmlContent, themePreset, generationPrompt: prompt, artifactType}}, actor)`'u çağırarak GERÇEK `artifact` Lumina Object'ini yaratır (Karar b) — döndürülen değer, herhangi bir `POST /objects` çağrısının döndürdüğü AYNI `LuminaObject` şekli.

**Okuma rotaları YENİDEN TASARLANMAZ** — `artifact` gerçek bir Lumina Object tipi olduğundan (Karar b), `GET /workspaces/:workspaceId/objects?type=artifact`, `GET /workspaces/:workspaceId/objects/:objectId`, `POST /workspaces/:workspaceId/objects/query` (Bağlam #12) ZATEN mevcut, hiçbir kod değişikliği gerektirmeden `artifact` nesnelerini de kapsıyor — bu ADR bunları SADECE NOT EDER, yeniden icat ETMEZ.

## Somut Şekiller

```ts
// packages/core-objects/src/lumina-object.ts (diff)
export type ObjectType = 'task' | 'doc' | 'note' | 'timeblock' | 'meeting' | 'artifact';
```

```ts
// packages/core-objects/src/object-type-registry.ts (diff)
const objectTypeRegistry: Record<ObjectType, { titleRequired: boolean }> = {
  task: { titleRequired: true },
  doc: { titleRequired: false },
  note: { titleRequired: false },
  timeblock: { titleRequired: false },
  meeting: { titleRequired: true },
  artifact: { titleRequired: true },
};
```

(Karar c/d/e/f'nin tam kod sketch'leri yukarıda Karar bölümünde — burada tekrarlanmıyor.)

```ts
// apps/server/src/artifacts/artifacts.service.ts
@Injectable()
export class ArtifactsService {
  constructor(
    private readonly aiUsageService: AIUsageService,
    private readonly objectsService: ObjectsService,
    @Inject(AI_PROVIDER) private readonly provider: AIProvider,
  ) {}

  async generate(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: { prompt: string; artifactType: ArtifactType; themePreset: ThemePresetName },
  ): Promise<LuminaObject> {
    return this.aiUsageService.withWorkspaceAILock(workspaceId, async () => {
      await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
      await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);

      const model = selectAIModel({ outputType: 'artifact' });
      const result = await generateArtifact({
        provider: this.provider,
        prompt: input.prompt,
        artifactType: input.artifactType,
        themePreset: input.themePreset,
        model,
        recordUsage: (usage) =>
          this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
      });

      if (result.parseError) {
        throw new ValidationError(result.message ?? 'Artifact generation failed.');
      }

      return this.objectsService.create(
        workspaceId,
        {
          type: 'artifact',
          title: input.prompt.slice(0, 200), // provisional -- content.title isn't
          // threaded back out of generateArtifact today; a follow-up PR may
          // return `{htmlContent, title}` instead if a more faithful title is needed.
          fieldValues: {
            htmlContent: result.htmlContent,
            themePreset: input.themePreset,
            generationPrompt: input.prompt,
            artifactType: input.artifactType,
          },
        },
        actor,
        callerRole,
      );
    });
  }
}
```

```ts
// apps/server/src/artifacts/artifacts.controller.ts
@Controller('workspaces/:workspaceId/artifacts')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class ArtifactsController {
  constructor(private readonly artifactsService: ArtifactsService) {}

  @Post()
  async generate(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<LuminaObject> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);
    const input = generateArtifactRequestSchema.parse(body);

    return this.artifactsService.generate(workspaceId, actor, callerRole, input);
  }

  // requireActor/requireRole: ObjectsController'ınkiyle birebir aynı desen.
}

const generateArtifactRequestSchema = z
  .object({
    prompt: z.string().min(1).max(4000),
    artifactType: z.enum(['presentation', 'dashboard', 'page', 'report']),
    themePreset: z.enum(['kurumsal', 'canli', 'minimal']),
  })
  .strict();
```

Migration: **YOK gerekli** (Karar b) — yalnızca kod değişiklikleri (`object-type-registry.ts` + workspace-kurulum-seed listesi); `field_definitions`/`objects_view` şeması hiçbir DDL değişikliği gerektirmez (Bağlam #9).

## Alternatifler ve Reddedilme Gerekçeleri

- **v0'da PDF/PowerPoint export'u da kapsamak.** Reddedildi (insan kararı 1) — puppeteer vb. yeni, ağır bir render bağımlılığı gerektirir; kapsamı önemli ölçüde büyütür.
- **Gerçek S3-uyumlu blob depolamayı ÖNCE standa almak, artifact içeriğini oraya yazmak.** Reddedildi (insan kararı 2) — `docs/specs/F2-E4/F2-T13` ZATEN bu boşluğu AYRI bir altyapı kararı olarak işaretlemiş; F3-T7'yi ona bağımlı kılmak, bu görevi bloke ederdi. Mevcut Lumina Object altyapısı (jsonb `field_values`) v0'ın boyut sınırları (Karar b) içinde yeterli.
- **Gerçek workspace-başına markalama (logo yükleme, özel renk seçici).** Reddedildi (insan kararı 3) — dosya depolama gerektirir (karar 2 tarafından bloklanır); sabit preset seti v0 için yeterli.
- **LLM'e TAM HTML dokümanını ürettirmek (ham-HTML-üretimi), yapılandırılmış-içerik+şablon yerine.** Reddedildi — önce mimar tarafından önerildi, sonra bir İKİNCİ Plan Mode doğrulama turunda insana AÇIKÇA soruldu ve insan kararı 4 olarak onaylandı (mimarinin tek başına kararlaştırdığı bir şey DEĞİL). Gerekçe: LLM her üretimde tema CSS'ini/yapıyı yeniden uygulamak zorunda kalır (daha fazla drift/bozuk-markup riski), tema-preset zorunluluğu (insan kararı 3) prompt talimatına GÜVENMEK zorunda kalırdı (kod tarafından ZORLANAMAZ), ve EN ÖNEMLİSİ: LLM'in serbestçe `<script>`/olay-işleyici üretebilmesi, Karar (d)'nin güvenlik yüzeyini KATLANARAK büyütürdü. Yapılandırılmış-içerik+deterministik-şablon YAKLAŞIMI bunların HEPSİNİ ayrı ayrı çözer.
- **Genel bir HTML-sanitizer kütüphanesi (`DOMPurify` vb.) eklemek, yazma anında `htmlContent`'i temizlemek için.** Reddedildi (Karar d) — Karar (c) LLM'i ham HTML üretme konumundan ZATEN çıkardığı için "güvenilmeyen HTML'i temizle" problemi bu tasarımda hiç ortaya çıkmıyor; sanitizer eklemek çözülmüş bir problem için gereksiz bağımlılık+saldırı-yüzeyi olurdu.
- **`sandbox` özniteliğine `allow-scripts` eklemek (bir "artifact içinde interaktif grafik" gelecekteki ihtiyacını ÖNDEN karşılamak için).** Reddedildi — Karar (c)'nin "LLM asla script üretmez" garantisiyle DOĞRUDAN çelişirdi; bugün hiçbir tüketici bu yeteneği istemiyor (CLAUDE.md: "hazır olmuşken kapsamı ekleme"). Gerçek bir ihtiyaç doğarsa AYRI bir karar/ADR gerektirir, bu ADR bunu şimdiden AÇMAZ.
- **`artifact`'ın 4 alanı için timeblock'un `time_block_start`/`time_block_end`'i gibi ayrılmış DB kolonları açmak.** Reddedildi (Karar b) — o desen SADECE tipli/aralık-sorgulanabilir alanlar için var; `artifact`'ın alanlarının hiçbiri buna ihtiyaç duymuyor, genel özel-alan altyapısı (zaten var, migration gerektirmeyen) yeterli.
- **Artifact üretimini `CommandsService.decide()`/`AgentActionRecordsService` ledger'ı üzerinden yönlendirmek (bir `ProposedAction` tipi olarak).** Reddedildi — artifact üretimi kullanıcının DOĞRUDAN, senkron olarak istediği bir çıktı (aşağıda Mimari Değişmezlerle İlişki'de detaylı), `resolveAIFieldValue`'nun kategorisinde, `parseCommand`'ın "AI kullanıcı adına aksiyonlar öneriyor" kategorisinde DEĞİL — onay/otonomi-kademesi/geri-alma anlamlı değil.
- **`dashboard` `artifactType`'ını bu görevde canlı/kendini-yenileyen yapmak.** Reddedildi (Karar f) — `SavedView`'ın hiçbir veri-snapshot yeteneği yok (Bağlam #5), ve `docs/PLAN.md`'nin kendi F3-T8 tanımı bunu AÇIKÇA ayrı bir göreve ayırmış; bu ADR'de inşa etmek F3-T8'in kapsamını ÖNDEN alırdı.
- **`AutonomyTierSettingsService.set`'in `admin`+ gate desenini artifact üretimine uygulamak.** Reddedildi (Karar g) — o desen bir POLİTİKA-AYARI yazma kapısı, "AI'ı tetikleme" kapısı değil; `CommandsService.parse()`'ın `member`+ gate'i (gerçek maliyet-kontrolü RBAC'ta değil `AIUsageService`'te) daha yakın ve daha tutarlı bir emsal.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** `artifact`, `task`/`doc`/`note`/`timeblock`/`meeting`'in AYNI event-kaynaklı Lumina Object mekanizmasını kullanan salt BİR YENİ nesne tipi — `ObjectCreated`/`FieldValueChanged` olayları, `objects_view`'ın AYNI projeksiyon mekanizması. YENİ bir persistence paradigması İCAT EDİLMEDİ; `htmlContent` yalnızca `field_values` jsonb haritasındaki BİR DEĞER, diğer herhangi bir alan gibi.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Artifact üretimi bu sözleşmenin KAPSAMI DIŞINDA — kasıtlı olarak. Bu sözleşme `ProposedAction`/`decide()`/ledger akışına özgü: AI'ın kullanıcı ADINA, onay/otonomi-kademesi/geri-alma gerektiren bir mutasyon YAPTIĞI durumlar için. Artifact üretimi bunun yerine `resolveAIFieldValue`/`answerQuestion`'ın kategorisinde: kullanıcı DOĞRUDAN "bana şunu üret" der, senkron bir sonuç alır — üretilen nesne kullanıcının kendi isteğinin DOĞRUDAN sonucu, gizli bir yan-etki DEĞİL (tıpkı bir kullanıcının `POST /objects` ile manuel bir `doc` yaratmasının hiçbir onay/otonomi-kademesi gerektirmemesi gibi). Bu yüzden `AgentActionRecordsService`/ledger'a HİÇBİR yeni yazım yolu EKLENMEDİ.
- **Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz.** `artifact` gerçek bir Lumina Object olduğundan (Karar b), var olan herhangi bir genel nesne-export yeteneği onu da otomatik kapsar — bu ADR hiçbir export kısıtlaması İCAT ETMEZ.
- **Hassas veri sınıfları buluta ham gönderilmez (ADR-0029).** Üretim prompt'u kullanıcının kendi serbest-metin isteği — `parseCommand`'ın `command` string'inin ZATEN gönderdiği AYNI kategori, YENİ bir hassas-veri kanalı AÇILMIYOR. v0'ın kapsamı (Karar f) canlı veri-getirmeyi (F3-T8'e ertelendi) İÇERMEDİĞİNDEN, bu ADR'nin GERÇEK v0 kapsamında kullanıcının kendi prompt metni ÖTESİNDE hiçbir ek hassas-veri yüzeyi açılmıyor; gelecekte "zaten getirilmiş veriyi özetle" özelliği eklenirse, o veri ADR-0029'un dört-kademeli sınıflandırmasına AYNI şekilde tabi olur — bu ADR o disiplini gevşetmiyor.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:** `docs/PLAN.md`'nin F3-T7 vaadi (tek-prompt'tan sunum/dashboard/sayfa/rapor üretimi, marka temaları) hiçbir yeni depolama alt sistemi, hiçbir yeni render altyapısı (puppeteer vb.), hiçbir yeni persistence paradigması İCAT EDİLMEDEN, MEVCUT Lumina Object/AI-gateway/AIUsageService altyapısının ÜZERİNE kurulur; en kritik güvenlik riski (LLM-üretimi HTML'in stored-XSS/session-hijack vektörü olması) yapılandırılmış-içerik+deterministik-şablon tasarımıyla (Karar c) YAPISAL OLARAK ortadan kaldırılır, sandboxed-iframe render (Karar d) savunma-derinliği katmanı olarak eklenir.

**Neyi erteliyoruz/kabul ediyoruz:**

- PDF/PowerPoint export YOK (insan kararı 1) — yalnızca öz-yeterli HTML; gerçek bir ihtiyaç doğarsa AYRI bir karar/ADR (yeni render bağımlılığı) gerektirir.
- Gerçek workspace-başına markalama YOK, yalnızca 3 sabit preset (insan kararı 3) — logo yükleme/özel renk seçici dosya-depolamaya bağımlı, AYRI, gelecekteki bir karar.
- Gerçek blob depolama YOK, içerik Postgres jsonb'de, `MAX_ARTIFACT_HTML_LENGTH=200_000` karakter sınırıyla (insan kararı 2 + Karar b) — büyük ikili varlıklar (video, yüksek-çözünürlük görsel) v0'da GÖMÜLEMEZ, `imagePlaceholder` bölüm tipi bunun yerine bir etiketli kutu render eder.
- `dashboard` `artifactType`'ı v0'da STATİK bir snapshot, canlı/kendini-yenileyen DEĞİL (Karar f) — F3-T8'in KENDİ vaadi, bu görev onu ÖNDEN almıyor.
- LLM asla ham HTML/CSS/JS üretmiyor, yalnızca yapılandırılmış içerik (Karar c) — çıktı şekli 5 bölüm tipiyle (heading/paragraph/list/table/imagePlaceholder) SINIRLI; daha zengin bir düzen (ör. yan-yana sütunlar, gömülü grafik) gelecekte şablona YENİ bir bölüm tipi eklenerek genişletilebilir, ama bu şablonun KENDİSİNİN (koddan, LLM'den DEĞİL) genişlemesi anlamına gelir.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E3/F3-T7-artifact-boru-hatti.md`) `docs-writer` ile yazılır. Bu ADR'nin onayı üzerine PR1'e (`packages/artifacts` saf domain: `ArtifactType`, `ThemePreset`/`THEME_PRESETS`, `ArtifactContent`/`artifactContentSchema`, `renderArtifactHtml` pure template renderer) `test-writer` ile başlanır:

```
docs/adr/ADR-0041-artifact-boru-hatti.md'deki Karar (a)-(h)'yi ve
docs/specs/F3-E3/F3-T7-artifact-boru-hatti.md'nin Kabul Kriterleri'ni temel alarak, F3-T7
PR1 (packages/artifacts saf domain: ArtifactType, ThemePreset/THEME_PRESETS üç preset,
ArtifactContent/artifactContentSchema yapılandırılmış içerik şeması, renderArtifactHtml
pure HTML şablon render fonksiyonu -- escapeHtml dahil) için test-writer ile başarısız
testleri yaz.
```
