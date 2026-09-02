# F2-T15 — Tetikleyici/Koşul/Aksiyon Çekirdeği (Zamanlanmış Tetikleyiciler + Regex Koşullar)

**Epik:** F2-E4 (Toplantı Zekâsı, Kapsam H) · **Durum:** Tamamlandı — ADR-0032 + PR1 (#173), PR2 (#174), PR3 (#175), PR4 (#176), PR5 (#177).
**Bağımlılık:** F2-T14/ADR-0031 (saklama tercihi + otomatik aksiyon çıkarımı, Tamamlandı — bu görev `CommandsService`'in öner→onayla akışını genel bir tetikleyici motoru için yeniden kullanır), F1-T16/ADR-0015 (konuşma-komutları öner→karar-ver akışı, temel sözleşme), F1-T6 (sorgu DSL'i, `FILTER_OPERATORS` — koşul motoru için olası genişletme noktası).

> ⚠️ MİMARİ-KARAR GEREKTİREN GÖREV — CLAUDE.md'nin ADR kriterinin (a) ve (b) fıkralarına giriyor: (a) reaktivite modeli (`ObjectsService.setFieldValues`'a inline hook mu, yoksa ayrı bir poller mı) event-sourcing mimari değişmeziyle doğrudan etkileşiyor; (b) `matches` (regex) operatörünün paylaşılan F1-T6 `FILTER_OPERATORS` sözleşmesine mi ekleneceği yoksa `packages/automation`'a mı izole edileceği gelecekteki görevlere dayatılan bir sözleşim kararı. `architect`'in bu iki forku netleştiren bir ADR taslağı + insan onayı koddan önce gerekli.

## Amaç

F2-T14'ün ürettiği "AI çıkarır → insan onaylar → gerçek nesne oluşur" desenini genelleştiren bir motor kurmak: kullanıcının kendi tetikleyicilerini (zamanlanmış — "her Pazartesi 09:00" gibi — VEYA olay-tabanlı — "bir `task` nesnesinin `title` alanı şu regex'e uyduğunda" gibi) ve koşullarını (regex eşleşmesi) tanımlayıp, bu tetikleyici ateşlendiğinde bir aksiyon önerisi (`ActionsProposed`, ADR-0015/ADR-0031'in aynı deseni) üretmesini sağlamak. Yalnızca AÇIKÇA onaylanan aksiyonlar gerçek nesneye dönüşür — bu görev de fail-closed öner→onayla disiplinine tabidir.

## Mevcut Durum (bir `explorer` dispatch'i ile doğrulandı)

- **`packages/automation/` henüz YOK** — `docs/PLAN.md:84`'te yalnızca prose referansı var, gerçek dosya/paket yok, hiçbir workspace/package.json onu referans etmiyor. Bu görev bu paketi sıfırdan açacak.
- **Zamanlanmış iş için üç mevcut emsal var, hepsi AYNI elle-yazılmış deseni paylaşıyor** (`OnModuleInit`/`OnModuleDestroy` + `setInterval` + testler için doğrudan çağrılabilir bir `xxxOnce()` metodu + per-satır try/catch): `apps/server/src/calendar/calendar-sync-poller.service.ts` (5 dk aralık), `apps/server/src/notetaker/meeting-retention-sweeper.service.ts` (1 saat aralık, F2-T14 PR2), `apps/server/src/context/context-graph-sync.worker.ts` (5 sn aralık, ADR-0018). **Hiçbir yerde `@nestjs/schedule` veya başka bir zamanlama kütüphanesi kullanılmıyor** — bu görev de aynı elle-yazılmış `setInterval` desenini takip etmeli, yeni bir kütüphane eklenmemeli.
- **`CommandsService`'in öner→onayla akışı ZATEN genelleştirilmiş durumda.** F2-T14 tam olarak bu genişletme için `recordProposal()`'ı (`apps/server/src/commands/commands.service.ts:273-310`) `parse()`'tan çıkarıp ayrı bir yardımcıya dönüştürdü; `proposeFromMeeting()` (229-261) bu yardımcının ikinci çağıranı. **Bu görev üçüncü bir çağıran ekler** (ör. `proposeFromTrigger(workspaceId, triggerId, actions)`), kendi sabit aktörüyle (`TRIGGER_ENGINE_ACTOR = {type:'agent', id:'trigger-engine'}` gibi) — `recordProposal`'ın kendisi DEĞİŞMEZ, genişletme noktası zaten hazır.
- **`ProposedAction.type`'ın bugünkü hâli** (`apps/server/src/ai/parse-command.ts:26-34`): `'createTask' | 'generateSubtasks' | 'assignPeople' | 'createTaskFromMeeting'`. Bu görev muhtemelen yeni bir literal ekler (Açık Soru 4) — `executeDecidedAction`'ın (`commands.service.ts:487-515`) exhaustive switch'i derleme zamanında eksik case'i yakalar (F2-T14 PR3'te bu güvenlik ağı bizzat deneyimlendi).
- **Hiçbir yerde regex/koşul-değerlendirme motoru YOK.** F1-T6'nın sorgu DSL'i (`packages/shared/src/query/query-spec.ts`) `FILTER_OPERATORS`'ı sabit 14 literal olarak tanımlıyor (`equals, notEquals, contains, notContains, gt, gte, lt, lte, between, before, after, in, notIn, isEmpty, isNotEmpty`) — **`matches` (regex) operatörü YOK**. `packages/core-objects/src/fields/query/filter-operators.ts`'in `FieldType`→geçerli-operatör eşlemesi de bunu yansıtıyor. Bu görev ya (a) paylaşılan `FILTER_OPERATORS` enum'ına yeni bir `matches` literal'i ekler (F1-T6'nın sorgu UI'ı da bundan faydalanır, ama paylaşılan bir sözleşimi genişletmek ADR gerektirir), ya da (b) kendi, `packages/automation`'a izole bir koşul şeması tanımlar (Açık Soru 2).
- **Olay-tabanlı ("bir alan değiştiğinde") tetikleyiciler için genel bir abonelik noktası YOK.** `FieldValueChanged` olayı (`packages/core-objects/src/fields/field-value-commands.ts:30-35`) her zaman nesnenin KENDİ stream'ine yazılıyor, `previousValue` taşımıyor. Tek mevcut emsal — task recurrence (ADR-0010) — **`ObjectsService.setFieldValues` içine GÖMÜLÜ, senkron, doğrudan çağrı** (`apps/server/src/objects/objects.service.ts:772-920`), genel bir "alan değişti, kayıtlı koşulları değerlendir" kancası DEĞİL. Bu, mimari-kritik bir fork: (a) `ObjectsService`'e yeni bir genel post-write kancası eklemek (paylaşılan, ağır-denetimli bir servise dokunur, muhtemelen kendi ADR'ını gerektirir) vs (b) `objects_view`'ı zamanlanmış-tetikleyicilerle AYNI `setInterval` deseninde periyodik taramak (daha basit, izole, ama gerçek-zamanlı değil — Açık Soru 1).
- **`saved_views` şeması güçlü bir tetikleyici-tanımı-saklama emsali.** `apps/server/src/db/schema/saved-views.ts:18-51`: ULID `id` + `stream_id` + `workspace_id` + `jsonb('query_spec')` + nullable `owner_id` (null = workspace-genelinde paylaşılan) + `lifecycle: 'active'|'deleted'` soft-delete. Yeni bir `automation_triggers` tablosu bu şekli birebir izleyebilir (ULID id + stream_id + workspace_id + jsonb koşul/zamanlama spec'i + lifecycle), kendi olay-kaynaklı `TriggerCreated`/`TriggerUpdated`/`TriggerDeleted` olaylarıyla (`packages/core-objects/src/saved-views/`'in saved-view-commands.ts/saved-view-replay.ts deseni emsal alınarak).
- **Genel/yeniden-kullanılabilir webhook mekanizması YOK (beklenen gibi).** `notetaker-webhook.controller.ts` tek-amaçlı, sabit bir uç nokta — genel bir abonelik tablosu/çıkış webhook'u mekanizması hiçbir yerde yok. Bu KASITLI: F2-T16 ("Yeniden kullanılabilir webhook'lar + otomasyon geçmişi/denetim ekranı") bu boşluğu dolduracak, BU görev yalnızca zamanlanmış + regex-koşullu tetikleyicilere odaklanır.

## Kapsam

1. **`packages/automation/` paketinin açılması** — tetikleyici tanımı (schedule VEYA event-condition), koşul değerlendirme (regex eşleşmesi), ve tetiklendiğinde `CommandsService.proposeFromTrigger()`'ı çağıran orkestrasyon mantığı.
2. **Zamanlanmış tetikleyiciler** — kullanıcının "her N dakikada/saatte/günde bir çalış" gibi bir zamanlama tanımlayabildiği, mevcut `setInterval`+`OnModuleInit`/`OnModuleDestroy` deseniyle tutarlı bir `TriggerSchedulerService`.
3. **Regex koşulları** — bir tetikleyicinin "hangi nesne tipi + hangi alan + hangi regex" üçlüsünü tanımlayabildiği bir koşul şeması ve bunu `objects_view`'a karşı değerlendiren bir motor.
4. **Tetikleyici tanımı CRUD'u** — workspace-kapsamlı, olay-kaynaklı `automation_triggers` tablosu + temel `POST`/`GET`/`PATCH`(soft-delete) uç noktaları (rol-bazlı: en az `member`, tercihen `admin`+ yazma).
5. **Aksiyon üretimi** — tetiklenen bir koşul, `CommandsService.proposeFromTrigger()` üzerinden mevcut öner→onayla akışına (ADR-0015/ADR-0031) bir `ActionsProposed` olayı olarak katılır; hiçbir aksiyon açıkça onaylanmadan gerçek nesneye dönüşmez.

## Kapsam DIŞI

- **F2-T16'nın yeniden-kullanılabilir webhook'ları** — bu görev yalnızca zamanlanmış ve olay/regex-tabanlı tetikleyicileri kapsar, dışa açık genel webhook abonelik mekanizması İNŞA ETMEZ.
- **F2-T16'nın otomasyon geçmişi/denetim ekranı** — bu görevin ürettiği `ActionsProposed`/`ActionsDecided` olayları F2-T16'nın denetim ekranı için VERİ üretir, ekranın kendisi kapsam dışı.
- **F2-T17'nin AI-önerili otomasyon şablonları** — kullanım desenlerinden şablon öğrenme bu görevin işi değil.
- **Karmaşık koşul kombinasyonları (AND/OR/NOT ağaçları)** — v0 yalnızca TEK bir regex koşulunu destekler; birleşik/iç içe koşul mantığı gelecekteki bir genişletme.
- **F1-T6'nın sorgu DSL UI'ının regex desteğiyle güncellenmesi** — `matches` operatörü paylaşılan enum'a eklenirse bile, F1-T6'nın kendi filtre-oluşturma arayüzüne regex girişi eklemek bu görevin kapsamında değil (yalnızca arka-uç sözleşimi genişler).

## Açık Sorular

1. **[KRİTİK] Olay-tabanlı tetikleyicilerin reaktivite modeli: `ObjectsService.setFieldValues`'a inline kanca mı, yoksa periyodik `objects_view` taraması mı?**
   - **Bağlam:** Mevcut TEK emsal (task recurrence, ADR-0010) inline/senkron. Ama `ObjectsService` mimari-kritik, ağır-denetimli bir paylaşılan servis — yeni bir genel "her yazımdan sonra kayıtlı tetikleyicileri değerlendir" kancası eklemek onun blast radius'unu genişletir ve potansiyel performans/döngü riski taşır (bir tetikleyicinin ürettiği aksiyon başka bir tetikleyiciyi ateşleyebilir mi?). Periyodik tarama daha izole ama gerçek-zamanlı değil (F2-T14'ün sweeper'ları gibi dakikalar mertebesinde gecikme kabul edilebilir mi?).
   - **Öneri:** v0 için periyodik tarama (mevcut `setInterval` desenine tam uyum, `ObjectsService`'e dokunmadan izole kalır) — gerçek-zamanlı inline kanca gelecekte, ayrı bir ADR ile değerlendirilebilir.
2. **[KRİTİK] `matches` (regex) operatörü paylaşılan F1-T6 `FILTER_OPERATORS` enum'ına mı eklenir, yoksa `packages/automation`'a mı izole edilir?**
   - **Bağlam:** Paylaşılan enum'a eklemek F1-T6'nın sorgu UI'ına da regex desteği getirir ama `packages/shared`'ı değiştirmek (birden fazla pakete dayatılan bir sözleşim) CLAUDE.md'nin ADR kriterine giriyor. İzole tutmak daha düşük blast radius ama F1-T6 ile potansiyel gelecekteki birleşme fırsatını kaçırır.
   - **Öneri:** `architect` netleştirir; düşük-risk varsayılan izole tutmaktır (yalnızca `packages/automation`'ın kendi koşul şeması), paylaşılan enum'a eklenmesi ayrı bir gelecekteki karar olarak bırakılır.
3. **Regex, kullanıcı girdisi olarak nasıl sınırlandırılır (ReDoS riski)?**
   - **Bağlam:** Kullanıcı-tanımlı bir regex'in `objects_view`'daki potansiyel olarak büyük alan değerlerine karşı çalıştırılması bir ReDoS (regular expression denial of service) vektörü olabilir.
   - **Öneri:** Regex uzunluk sınırı + basit bir "tehlikeli desen" reddi (ör. iç içe nicelik belirteçleri) VEYA bir zaman-aşımlı regex çalıştırıcısı (Node'un yerleşik `RegExp`'i senkron ve kesilemez olduğundan, bu ikincisi ekstra bir bağımlılık/worker-thread gerektirebilir — `architect` karar verir).
4. **Tetikleyici-üretimli aksiyonlar hangi `ProposedAction.type` literalini kullanır?**
   - **Bağlam:** `createTaskFromMeeting`'in `assigneeHint`/`dueDateHint` gibi transkript-türetilmiş ipuçları var; bir tetikleyici-üretimli aksiyonun böyle ipuçları olmayabilir (yalnızca sabit bir şablon: "şu regex eşleştiğinde şu başlıkla bir task oluştur").
   - **Öneri:** Yeni bir literal, `createTaskFromTrigger` (mevcut `createTask`'ı DEĞİŞTİRMEDEN, F2-T14'ün `createTaskFromMeeting` ekleme desenini birebir tekrarlayarak) — `params` yalnızca `{title}` gibi sabit şablon alanları taşır.
5. **Tetikleyici tanımının kendisi kim tarafından yazılabilir/silinebilir — rol gereksinimi ne?**
   - **Bağlam:** Bir tetikleyici tanımı workspace-genelinde davranış değiştiren bir yapılandırma (F2-T14'ün saklama tercihi kararına benzer bir "workspace-yönetişimi" kararı).
   - **Öneri:** F2-T14'ün kendi kararıyla tutarlı: yazma (`POST`/`PATCH`) `admin`+ gerektirir, okuma (`GET`) `member`+ (tetikleyicinin ne yaptığını görmek hassas değil, ama değiştirmek workspace-genelinde etkili).

## Kabul Kriterleri

- [x] Açık Soru 1-5'in insan kararları netleşti (`architect` taslağı + insan onayı, ADR-0032) ve insan onayından önce sunuldu.
- [x] Kullanıcı, bir workspace için zamanlanmış (periyodik) bir tetikleyici tanımlayabilir; tetikleyici gerçekten periyodik olarak değerlendirilir. PR2 (#174, CRUD) + PR4 (#176, `TriggerSchedulerService`, 60sn tick).
- [x] Kullanıcı, bir nesne tipi + alan + regex üçlüsünden oluşan bir koşul tetikleyicisi tanımlayabilir; koşul gerçekten `objects_view` verisine karşı doğru değerlendirilir. PR2 (#174) + PR5 (#177, `TriggerConditionEvaluatorService`, 2dk tick, match/diff dedup).
- [x] Bir tetikleyici ateşlendiğinde, `CommandsService.proposeFromTrigger()` üzerinden bir `ActionsProposed` olayı üretilir — hiçbir aksiyon AÇIKÇA onaylanmadan gerçek nesneye dönüşmez (fail-closed). PR3 (#175).
- [x] Cross-workspace izolasyon: bir workspace'in tetikleyicisi başka bir workspace'in verisini asla değerlendirmez/etkilemez. PR2/PR4/PR5'in her birinin integration testlerinde ayrı ayrı doğrulandı.
- [x] ReDoS koruması: kötü niyetli/patolojik bir regex, tetikleyici motorunu veya sunucuyu kilitlemez. PR1'in 4-katmanlı `assertSafeRegexPattern`'i (#173) — PR1 security-review'ında bulunan `(a|A)+` gibi case-insensitive-alternasyon bypass'ı düzeltildi ve regresyon testiyle kilitlendi.
- [x] Testler: zamanlanmış tetikleyicinin gerçekten periyodik çalıştığı, regex koşulunun doğru eşleştiği/eşleşmediği, onaylanmayan aksiyonun asla nesne oluşturmadığı, cross-workspace izolasyonu, ReDoS koruması. Her PR kendi entegrasyon testlerini taşıyor (toplam 5 PR).
- [x] `security-reviewer` denetiminde bulgu yok (özellikle: rol-bazlı CRUD kontrolü, ReDoS, onay akışının bypass edilemediği). Her PR ayrı ayrı denetlendi, bulgular ya düzeltildi ya da bilinen kısıt olarak belgelendi (aşağıya bakın).
- [x] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil (her PR için ayrı ayrı doğrulandı).

## Bilinen Kısıtlar / Gelecek Takip

- **PR1 security-review düzeltmesi:** `automation_trigger_matches.trigger_id`'nin gerçek bir FK'si yoktu (yalnızca `objectId` FK'siz olmalıydı) — düzeltildi, migration yeniden üretildi.
- **PR5 security-reviewer bulgusu (bilgilendirici, düzeltilmedi):** Bir koşul-tetikleyicisi İLK değerlendirme döngüsünde zaten 50'den fazla nesneyle eşleşiyorsa (hiçbir `automation_trigger_matches` satırı henüz birikmemişken), anti-runaway tavanı (N=50, insan onaylı) bu tetikleyiciyi teorik olarak süresiz reddedebilir — otomatik-devre-dışı-bırakma bu oturumda kasıtlı olarak v0 kapsamı dışında bırakılmıştı (ADR-0032 Karar (j)). Gelecekte bir görev/ADR'ye taşınabilir (ör. bir "sıkışmış tetikleyici" sinyali workspace admin'ine gösterilebilir).
- **PR4/PR5 ortak, bilgilendirici not:** `setInterval` tabanlı zamanlayıcılarda art arda çalışma (in-flight overlap) koruması yok — bir tick'in önceki tick bitmeden başlaması teorik olarak yinelenen bir öneriye yol açabilir (veri bozulması değil, `automation_trigger_matches`'in birincil anahtarı ikinci denemeyi zaten engeller). Mevcut `MeetingRetentionSweeperService`/`CalendarSyncPollerService` desenleriyle tutarlı, bu görevde yeni bir risk değil.

---

**Sıradaki adım:** F2-T15 tamamlandı. `docs/PLAN.md`'ye göre sıradaki görev F2-T16 ("Yeniden kullanılabilir webhook'lar + otomasyon geçmişi/denetim ekranı") — henüz bir spec dosyası yok, CLAUDE.md'nin ritüeli gereği önce spec yazılmalı:

```
/yeni-ozellik F2-T16 — Yeniden kullanılabilir webhook'lar + otomasyon geçmişi/denetim ekranı. F2-T15'in ürettiği tetikleyici/aksiyon önerisi akışının (ADR-0032) ürettiği ActionsProposed/ActionsDecided olaylarını görünür kılan bir denetim ekranı + genel amaçlı gelen/giden webhook mekanizması inşa edilecek.
```
