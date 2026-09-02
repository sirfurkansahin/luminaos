# ADR-0033: Yeniden Kullanılabilir Outbound Webhook'lar + Otomasyon Geçmişi/Denetim Ekranı

**Durum:** Kabul edildi (Plan Mode oturumunda, bir `Plan` subagent pressure-test'i + İKİ insan-cevaplı `AskUserQuestion` turuyla — en yüksek riskli güvenlik ödünleşimleri (SSRF kalıntı-risk kabulü, HTTPS zorunluluğu) üzerine — insan onayı zaten alındı; bu ADR o kararları biçimlendirir, yeniden tartışmaz)
**Tarih:** 2026-09-02
**İlgili görev:** [F2-T16 — Yeniden Kullanılabilir Webhook'lar + Otomasyon Geçmişi/Denetim Ekranı](../specs/F2-E5/F2-T16-yeniden-kullanilabilir-webhooklar-otomasyon-gecmisi.md)
**İlgili ADR referansları:** [ADR-0032](./ADR-0032-tetikleyici-kosul-aksiyon-cekirdegi.md) (F2-T15, bu görevin dışa açtığı `ActionsProposed`/`ActionsDecided` olaylarının ikinci/üçüncü kaynağı — bu ADR onun `AutomationTriggersService` RBAC deseninden BİLİNÇLİ olarak sapar, bkz. Karar g), [ADR-0031](./ADR-0031-toplanti-saklama-tercihi-ve-aksiyon-onerisi.md) (F2-T14, §f'nin "transkripti `command.command`'a ham kopyalama" reddi + `encryptSecret`/`decryptSecret` emsali), [ADR-0015](./ADR-0015-konusma-komutlari-ajan-aksiyon-sozlesmesi.md) (F1-T16, öner→onayla temel sözleşmesi + `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` payload sözleşmesi), [ADR-0030](./ADR-0030-notetaker-botu-mimarisi.md) (F2-T13, bu görevin "yeniden kullanılabilir" karşıtı örneği olan tek-amaçlı INBOUND webhook), [ADR-0025](./ADR-0025-mcp-istemci-catisi.md) (F2-T9, `connector_credentials`'ın şifreli-sır-saklama şeması + "event-sourced olmayan hassas config" emsali — Karar h).

> Bu ADR, spec'in kendi "⚠️ MİMARİ-KARAR GEREKTİREN GÖREV" işaretinin (a)/(b) fıkralarına karşılık gelir: (a) yeni bir outbound-webhook teslim mekanizması (imzalama şeması, yeniden-deneme semantiği, hangi olay tiplerinin tetiklediği) sıfırdan icat ediliyor — gelecekteki her otomasyon-ilişkili görevin (F2-T17 dahil) üzerine inşa edeceği bir sözleşim; (b) `CommandsService`'e ilk kez genel bir "önerileri listele" yeteneği ekleniyor — ADR-0015'in orijinal öner→onayla sözleşmesini genişletiyor. Aşağıdaki (a)-(h) maddeleri, Plan Mode oturumunda `Plan` subagent'ının pressure-test'iyle ve iki `AskUserQuestion` turuyla netleşen kararların birebir kaydı — ADR-0030/ADR-0032'nin tek dosyada birden fazla kararı harfle numaralandırma emsali burada da izleniyor.

## Bağlam

Bir `explorer` dispatch'i + `Plan` subagent pressure-test'iyle doğrulanan mevcut durum (ayrıntılar spec'in "Mevcut Durum" bölümünde):

1. Inbound webhook'lar (`apps/server/src/notetaker/notetaker-webhook.controller.ts`) tek-amaçlı, parametresiz, tek bir hardcoded servise dispatch ediyor — genel bir "abonelik" kavramı hiçbir yerde yok. Bu görev tamamen AYRI, yeni bir OUTBOUND mekanizma.
2. Outbound HTTP-to-kullanıcı-URL'si, `CommandsService`'in genel liste yeteneği ve `apps/web`'de herhangi bir onay/red arayüzü — üçü de kod tabanında hiç yok.
3. **Kritik ek bulgu:** `InProcessEventBus` (`apps/server/src/event-store/event-bus.ts`) var, test edilmiş, ama PRODÜKSİYONDA HİÇBİR YERE BAĞLI DEĞİL — `EventStoreService.append()` asla `.publish()` çağırmıyor, `EventStoreModule` onu sağlamıyor (`grep -rn "\.publish("` üretim kodunda sıfır sonuç döndürüyor). Kod tabanındaki HER "bir şey olunca tepki ver" mantığı (`calendar-sync-poller.service.ts`, `meeting-retention-sweeper.service.ts`, `trigger-scheduler.service.ts`, `trigger-condition-evaluator.service.ts`) bir olay-veriyolu abonesi değil, bir TABLO-DURUMU POLLER'ıdır.
4. `connector_credentials` (F2-T9/ADR-0025) + `ConnectorCredentialsService`'in `encryptSecret`/`decryptSecret` (`packages/shared/src/secrets/token-encryption.ts:16,41`, `env.encryptionKey`-keyed) deseni webhook imzalama sırrı için doğrudan yeniden kullanılabilir.
5. `McpAccessPanel.tsx`'in `flushSync`+"yalnızca bir kez göster, kapattıktan sonra tekrar görüntülenemez" sır-ifşa deseni (satır ~2, 93, 123-129, 182-192) doğrulandı — webhook imzalama sırrının oluşturma-anı ifşası için birebir emsal.
6. `AutomationTriggersService`'in (F2-T15/ADR-0032 §h) düz admin-yazma/member-okuma RBAC deseni doğrulandı — ama webhook ABONELİĞİ farklı bir kaynak (bir aboneliğin varlığı/hedef URL'si bile hassas, dışarıya veri sızdıran bir entegrasyonun ipucu).
7. `CommandsService.recordProposal()` zaten genelleştirilmiş (ADR-0031 §g, ADR-0032 §f) — ama karşılık gelen bir OKUMA/liste yeteneği hiçbir katmanda yok; `MAX_DECISIONS_PER_CALL` (`commands.service.ts:55`) tek mevcut sayfalama-benzeri sınır.

## Karar

### (a) SSRF savunması: yazma-anı + teslimat-anı doğrulama, bağlantı-seviyesi IP pinleme YOK (insan onaylı kalıntı risk)

`ssrf-guard.ts`'nin `assertSafeWebhookUrl(url)`'ü HEM abonelik oluşturma/güncelleme yazma-anında HEM her teslimattan HEMEN ÖNCE (fetch çağrısına milisaniyeler kala) çağrılır: DNS çözümleme + çözümlenen IP'nin private/reserved aralıklardan biri olup olmadığının kontrolü —

- RFC1918: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Link-local: `169.254.0.0/16` (bulut-metadata-endpoint aralığı, ör. `169.254.169.254`)
- Loopback: `127.0.0.0/8`, `::1`
- IPv6 unique-local: `fc00::/7`
- IPv6 link-local: `fe80::/10`

Herhangi biri eşleşirse istek reddedilir (yazma-anında `400`, teslimat-anında `status:'failed'` + sanitized `lastError`).

**Kabul edilen kalıntı risk (insan tarafından `AskUserQuestion` turunda AÇIKÇA onaylandı):** native `fetch`/Undici'nin bağlantı-seviyesinde IP pinleme (DNS çözümü sonucu IP'ye doğrudan bağlanma, ayrıca yeniden DNS sorgusu yapmadan) için trivial bir desteği yok. Bu, teslimat-anı doğrulama ile gerçek TCP bağlantısı arasında ufak bir DNS-rebinding penceresi bırakır: bir kötü niyetli/ele geçirilmiş hedef, doğrulama sorgusuna güvenli bir IP döndürüp hemen ardından gelen gerçek bağlantı sorgusuna private bir IP döndürebilir. Bunu kapatmanın maliyeti — private IP'ye doğrudan bağlanan özel bir Undici `Agent`/dispatcher yazmak (host-header'ı korurken TLS-SNI'yi doğru hedefe yönlendirme gibi ek karmaşıklıkla) — v0'ın tehdit modeli için faydasından ağır basıyor: bu self-hosted, çok-kiracılı-olmayan bulut ortamı değil (workspace'ler birbirine düşman değil), ve HTTPS zorunluluğu (Karar b) zaten en yaygın gerçek-dünya SSRF hedefini (düz-HTTP metadata endpoint'i) kapatıyor. Bu, bir gözden kaçırma değil, v0 için AÇIKÇA kayıtlı bir insan kararıdır; bağlantı-seviyesi pinleme gelecekte (ör. çok-kiracılı-cloud sunumu düşünülürse) ayrı bir karar olarak yeniden değerlendirilebilir.

### (b) HTTPS zorunlu, `http://` yazma-anında reddedilir (insan onaylı)

`assertSafeWebhookUrl`, şema `https:` değilse yazma-anında reddeder — hiçbir `http://` hedef asla kaydedilemez. Birincil gerekçe düz-metin imza/payload iletiminin önlenmesi (bir ağ-gözlemcisi imzalama sırrının ürettiği HMAC'i ve tüm payload'u görebilirdi). Bunun bonus bir yan etkisi: yaygın bulut-metadata-endpoint deseni (`http://169.254.169.254/...`) zaten düz HTTP olduğundan bu zorunluluk o saldırı yüzeyini de varsayılan olarak kapatıyor (Karar a'nın kalıntı riskini kısmen azaltan bağımsız bir katman, ama onun yerini TUTMAZ — bir saldırgan HTTPS sunan bir rebinding hedefi de kurabilir). Self-hosted bir admin'in dahili bir `http://` alıcısına teslimat yapması gerekiyorsa çözüm LuminaOS'un HTTPS zorunluluğunu gevşetmek değil, kendi yerel TLS-sonlandıran ters-proxy'sini çalıştırmaktır.

### (c) Olay-tipi kapsamı: v0 yalnızca `ActionsProposed`/`ActionsDecided`

Bir webhook aboneliğinin `eventTypes` alanı yalnızca `['ActionsProposed', 'ActionsDecided']`'ın alt-kümesini kabul eder (zod ile kısıtlı). Tetikleyici-yaşam-döngüsü olayları (`TriggerCreated`/`TriggerUpdated`/`TriggerDeleted`, F2-T15) AÇIKÇA kapsam DIŞI:

- Farklı bir kaynak — tetikleyici TANIMLARININ yaşam döngüsü, onların ÜRETTİĞİ ETKİLER değil.
- İkisini aynı abonelik kaynağında birleştirmek iki farklı hedef kitleyi (otomasyonu yapılandıran admin vs. otomasyonun ürettiği aksiyonları izleyen dış entegratör) karıştırırdı.
- Görevin kendi başlığındaki "otomasyon geçmişi" çerçevesi, tam olarak öner→onayla akışının kendisidir — tetikleyici CRUD'u değil.

Bu kalıcı bir kapatma değil: enum'a yeni bir literal eklemek saf katmalı bir genişletme, migration gerektirmez.

### (d) Teslimat mekanizması: `webhook_deliveries` kuyruk tablosu + poller, ASLA dormant `InProcessEventBus`, ASLA inline fire-and-forget

Somut bulgu: `InProcessEventBus` (`apps/server/src/event-store/event-bus.ts`) var ve test edilmiş, ama `EventStoreService.append()` hiçbir zaman `.publish()` çağırmıyor ve `EventStoreModule` onu hiçbir yerde sağlamıyor — üretim kodunda `.publish(` için sıfır eşleşme (grep ile doğrulandı). Kod tabanındaki HER mevcut "bir şey olunca tepki ver" mekanizması (`calendar-sync-poller.service.ts`, `meeting-retention-sweeper.service.ts`, `trigger-scheduler.service.ts`, `trigger-condition-evaluator.service.ts`) bir tablo-durumu poller'ıdır, hiçbiri bir olay-veriyolu abonesi değildir.

Bu görev crash-proof/bounded-retry/restart-hayatta-kalan teslimat gerektiriyor — dormant bus'ı ŞİMDİ, tam olarak bu gereksinimlerin en çok kanıtlanmaya ihtiyaç duyduğu bir özellik için canlandırmak, hiç prod'da denenmemiş bir altyapıyı en kritik gereksinimler altında ilk kez kanıtlamak demektir. Inline fire-and-forget ise bir sunucu restart'ında bekleyen yeniden-denemeleri sessizce kaybeder (kalıcılık yok).

Bunun yerine: kuyruk-tablosu INSERT'i, `ActionsProposed`/`ActionsDecided`'ın KENDİ projection-runner catch-up transaction'ı İÇİNDE olur — `ActionProposalProjection`'ın yanına eklenen yeni bir `webhook-delivery-enqueue.projection.ts`. Bu, enqueue işlemini `command_proposals`'ın kendisiyle TAM AYNI dayanıklılık garantisine sahip kılar; ayrı bir durabilite hikayesi icat edilmez.

`WebhookDeliveryWorker`, `TriggerSchedulerService`'in birebir şeklini izler (`OnModuleInit`/`OnModuleDestroy`+`setInterval`, per-satır try/catch), `pending AND next_attempt_at <= now()` satırlarını tarar. Poll aralığı ~15-30 saniye — `TriggerSchedulerService`'in 60 saniyesinden DAHA SIK, çünkü webhook teslimat gecikmesi dış bir entegratör için bir zamanlanmış-tetikleyicinin dakika-granülerliğinden daha önemli. Üstel geri-çekilmeyle 3 deneme sonrası `status:'failed'`, bir daha asla otomatik yeniden denenmez (spec Açık Soru 3'ün kararı).

### (e) İmzalama şeması: HMAC-SHA256 üzerinde `${timestamp}.${rawBody}`, tek-serileştirme disiplini, mevcut şifreleme yeniden kullanımı

İmzalanan mesaj yalnızca ham body değil, `${timestamp}.${rawBody}` birleşimidir — zaman damgası dahil edilmesinin amacı ALICI için replay-koruması rehberliğidir (alıcı SHOULD `|now - timestamp| > 5 dakika` ise isteği reddetsin; LuminaOS kendisi bir alıcının kendi kontrolünü uygulayıp uygulamadığını zorlayamaz). Başlıklar: `X-LuminaOS-Timestamp` (unix saniye) + `X-LuminaOS-Signature: sha256=<hex-hmac>` — Stripe/GitHub webhook konvansiyonunu birebir yansıtır (yaygın, iyi anlaşılmış).

**Kanonikleştirme:** TEK bir `JSON.stringify(payload)` çağrısının çıktısı HEM imzalanır HEM literal request body olarak gönderilir — asla aynı objenin iki ayrı serileştirmesi (anahtar-sırası/sayı-biçimlendirme kaymasıyla her alıcının imza doğrulamasını sessizce bozabilirdi).

**Sır saklama:** `packages/shared/src/secrets/token-encryption.ts`'nin `encryptSecret`/`decryptSecret`'ı (zaten `ConnectorCredentialsService` tarafından kullanılıyor, `env.encryptionKey`-keyed) DOĞRUDAN yeniden kullanılır — yeni kriptografi icat edilmez.

### (f) Teslimat sağlamlığı: yönlendirme yok, timeout, boyut-tavanı, yanıt gövdesi asla loglanmaz

`fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })` — hiçbir yönlendirme takip edilmez. Bu, "doğrulanmış URL 302 ile `169.254.169.254`'e yönlendirir" bypass'ını kapatır (meşru bir webhook alıcısının kendi ingestion endpoint'ini yönlendirmesi için bir gerekçe yok). Yanıt gövdesi boyut-tavanlı okunur (en fazla N bayt okunup sonra abort edilir — kötü niyetli/yanlış-yapılandırılmış bir alıcının teslimat worker'ını OOM'a sürüklemesini önler).

Yanıt gövdesi ASLA loglanmaz — yalnızca durum kodu + opak abonelik/teslimat id'si (CLAUDE.md'nin "kullanıcı verisini asla log'a yazma" kuralı). `webhook_deliveries.lastError` kolonu yalnızca SANİTİZE edilmiş bir mesaj taşır (ör. `"HTTP 500"`, `"timeout"`, `"ssrf-rejected"`), ham yanıt içeriği asla.

### (g) İki farklı RBAC kuralı, iki farklı kaynak için — karıştırılmaz

**Webhook ABONELİKLERİ** (bu görevin yeni kaynağı) HEM okuma HEM yazma için `admin`+ gerektirir — `AutomationTriggersService`'in (F2-T15/ADR-0032 §h) member-okuma/admin-yazma bölünmesinden BİLİNÇLİ bir sapma. Gerekçe: bir aboneliğin salt VARLIĞI + hedef URL'si kendi başına veri-sızıntısına-yakın bir sinyaldir — bir `member`'ın "bu workspace her onaylanan aksiyonu sessizce `https://saldirgan.example/topla`'ya POST ediyor" göremesi, imzalama sırrına erişimden BAĞIMSIZ olarak hassastır. İmzalama sırrının kendisi hiçbir okuma uç noktasında oluşturmadan sonra ASLA döndürülmez — yalnızca oluşturma-yanıtında BİR KEZ gösterilir, `McpAccessPanel.tsx`'in `flushSync`+bir-kez-ifşa diyalog desenini (satır ~2, 93, 123-129, 182-192: "Bu token yalnızca bir kez gösterilir; kapattıktan sonra tekrar görüntülenemez") birebir yansıtarak.

**`CommandsService.listProposals`** (FARKLI bir kaynak — otomasyon geçmişi/öneriler, webhook yapılandırması DEĞİL) `member`+ ile okunabilir — `AutomationTriggersService.list`'in kendi member-okuma emsalini AYNEN yansıtır: bir otomasyonun ne önerdiğini/karar verdiğini görmek "otomasyon geçmişi" özelliğinin tam da amacıdır ve bir tetikleyici TANIMINI görmekten daha hassas değildir.

### (h) Şema şekli: düz (event-sourced OLMAYAN) CRUD tabloları

`webhook_subscriptions`/`webhook_deliveries`, `automation_triggers`'ın (ADR-0032) event-sourced desenini BİLİNÇLİ olarak taklit ETMEZ. `automation_triggers` event-sourcing gerektirdi çünkü `packages/automation`'ın domain paketi tetikleyici durumunu saf `createTrigger`/`updateTrigger`/`deleteTrigger`/`replayTrigger` fonksiyonları üzerinden olay geçmişinden replay ediyor — olay geçmişini TÜKETEN gerçek bir domain-mantığı var. Bir webhook aboneliğinin böyle bir durum-makinesi YOK; bu salt yapılandırma (hedef URL + olay tipleri + şifreli sır), yapısal olarak `connector_credentials`'ın (F2-T9/ADR-0025) "hassas workspace-kapsamlı harici-entegrasyon yapılandırması" şekliyle ÖZDEŞ — o da event-sourced DEĞİL. Bu ihtiyacı olmayan bir olay-kaynaklama desenini memnun etmek için yeni bir domain paketi icat etmek aşırı-mühendislik olurdu.

## Alternatifler ve Reddedilme Gerekçeleri

- **Bağlantı-seviyesi IP pinleme (özel Undici `Agent`/dispatcher, doğrulanan IP'ye doğrudan bağlanır).** Reddedildi (Karar a) — v0'ın self-hosted/çok-kiracılı-olmayan tehdit modeli için maliyeti (host-header/TLS-SNI karmaşıklığı dahil özel dispatcher inşası) faydasından ağır basıyor; insan tarafından kalıntı risk olarak açıkça kabul edildi.
- **`http://` hedeflere izin vermek (bir admin-onay bayrağı arkasında).** Reddedildi (Karar b) — düz-metin imza/payload iletimini önlemenin basit, istisnasız kuralı; bir self-hosted admin'in dahili `http://` alıcısı için çözüm kendi TLS-sonlandıran proxy'sini çalıştırmaktır, LuminaOS'un kendi kuralını gevşetmesi değil.
- **Tetikleyici-yaşam-döngüsü olaylarını (`TriggerCreated` vb.) da v0 kapsamına almak.** Reddedildi (Karar c) — farklı bir kaynağın (tanımlar vs. etkiler) yaşam döngüsü, görevin "otomasyon geçmişi" çerçevesiyle karışırdı; saf katmalı bir gelecekteki genişletme olarak ertelendi.
- **Dormant `InProcessEventBus`'ı canlandırmak.** Reddedildi (Karar d) — hiç prod'da kanıtlanmamış altyapıyı, tam olarak crash-proof/bounded-retry/restart-hayatta-kalan gereksinimlerinin en çok kanıtlanmaya ihtiyaç duyduğu bir özellik için ilk kez test etmek anlamına gelirdi.
- **Inline fire-and-forget teslimat (kuyruk tablosu olmadan).** Reddedildi (Karar d) — bir sunucu restart'ında bekleyen yeniden-denemeleri sessizce kaybeder, kalıcılık yok.
- **İmzayı yalnızca ham body üzerinden hesaplamak (timestamp'siz).** Reddedildi (Karar e) — replay-koruması rehberliği alıcıya hiç sağlanamazdı; Stripe/GitHub konvansiyonundan sapmak da entegratörler için sürpriz yaratırdı.
- **Payload'ı ayrı ayrı iki kez serileştirmek (biri imzalama için, biri gönderme için).** Reddedildi (Karar e) — anahtar-sırası/sayı-biçimlendirme kayması riski, her alıcının imza doğrulamasını sessizce bozabilirdi.
- **Yönlendirmeleri takip etmek (`redirect:'follow'`).** Reddedildi (Karar f) — "doğrulanmış URL 302 ile private IP'ye yönlendirir" SSRF bypass'ını açık bırakırdı.
- **Webhook abonelikleri için `AutomationTriggersService`'in member-okuma/admin-yazma kuralını aynen kopyalamak.** Reddedildi (Karar g) — bir aboneliğin varlığı/hedef URL'si, bir tetikleyici tanımından NİTELİKSEL olarak daha hassas (dışa-veri-akışının kendisinin ipucu); üzerine tam bir admin+ okuma kısıtlaması kondu.
- **`webhook_subscriptions`/`webhook_deliveries`'i event-sourced yapmak (`automation_triggers` deseni).** Reddedildi (Karar h) — tüketen bir domain-durum-makinesi yok; `connector_credentials`'ın düz-CRUD emsali doğrudan uygulanabilir, yeni bir domain paketi icat etmek aşırı-mühendislik olurdu.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** `webhook_subscriptions`/`webhook_deliveries` düz config/kuyruk durumudur, olay günlüğünün BİR PARÇASI DEĞİLDİR — `connector_credentials` (ADR-0025) ile AYNI kategoridedir. Bu, ZATEN kurulmuş bir emsalle tutarlı, BİLİNÇLİ ve gerekçeli bir istisnadır (Karar h), yeni bir ihlal değil: bu tablolar hiçbir domain-durum-makinesi tüketmiyor, salt yapılandırma+kuyruk. `ActionsProposed`/`ActionsDecided` olaylarının kendisi (webhook'ların dışa açtığı içerik) event-sourced kalmaya devam ediyor — bu ADR o olayların ÜRETİMİNE dokunmuyor, yalnızca zaten var olan bir okuma-modeli projeksiyonuna (`ActionProposalProjection`'ın yanına eklenen `webhook-delivery-enqueue.projection.ts`) bir ikinci tüketici ekliyor.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Bu ADR YENİ bir ajan-aksiyon tipi eklemiyor — yalnızca ZATEN VAR OLAN `ActionsProposed`/`ActionsDecided` olaylarını (ADR-0015'in kurduğu `intent`/`rationale`/`resources`/`rollbackNote` şeklini zaten taşıyan) harici sistemlere dışa açıyor. Sözleşme değişmiyor, yalnızca payload'ın alıcı kümesi genişliyor.
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Önceki otomasyon-ilişkili ADR'lerin (ADR-0031, ADR-0032) aksine bu değişmez BURADA DOĞRUDAN İLGİLİ: bu ADR'nin outbound webhook mekanizmasının kendisi bir veri-dışa-aktarma biçimidir. Tasarım, bir admin'in normal RBAC'ın (Karar g) ÜZERİNE hiçbir ek "dışa-aktarma onayı" iş akışı KOYMADIĞINI doğrular — bir `admin` rolündeki kullanıcı her zaman bir webhook aboneliği oluşturabilir, ek bir onay/inceleme adımı gerektirmez. Bu, "veri dışa aktarma kısıtlanamaz" değişmeziyle tam olarak tutarlıdır: RBAC bir yetki-sınırıdır, bir dışa-aktarma-kısıtlaması değil, ve bu ADR ikisini karıştırmaz.
- **Hassas veri sınıflarının buluta ham gönderilmemesi.** `ActionsProposed`/`ActionsDecided` olayının `payload`'ı (webhook'un gönderdiği TAM body) `actions`/`params` alanlarını içerir — ör. `createTaskFromMeeting`'in `assigneeHint`/`dueDateHint`'i (ADR-0031). ADR-0031 §f zaten `command_proposals.command`'ın ham transkripti ASLA saklamadığını, yalnızca sentetik bir dize taşıdığını kurmuştu — ama BU o garantiyi tam kapsamıyla ÖRTMÜYOR: `actions[].params` alanları (assignee/tarih ipuçları gibi) transkript-TÜREVLİ olabilir ve bugün AI-özetleme/çıkarım sürecinden geçmiş, insan-gözden-geçirilmiş içeriktir, ham transkript değil. Bu ADR bunu ÇÖZÜLMÜŞ bir sorun olarak sunmuyor, açıkça NOT EDİYOR: bir workspace admin'inin otomasyon geçmişini harici bir URL'ye webhook ile dışa aktarma kararı, admin-başlatımlı, AÇIK bir veri-dışa-aktarma kararıdır — ve "veri dışa aktarma kısıtlanamaz" değişmezine göre bu TAM OLARAK kısıtlanmaması gereken türden bir karardır. Ancak bu, admin'in hangi ALAN İÇERİĞİNİN (transkript-türevli ipuçları dahil) dışarı gittiğini bilerek karar verdiğinden EMİN olmayı gerektirir — bu ADR bunu bir açık risk olarak kaydeder, çözümü (ör. abonelik oluşturma diyaloğunda bir uyarı metni: "bu abonelik onaylanan aksiyonların tüm alanlarını (varsa transkript-türevli ipuçları dahil) hedef URL'ye gönderir") implementasyon-seviyesi bir iyileştirme olarak `implementer`/insan onayına bırakılır, bu ADR'nin kapsamını genişletmez.

## Şema Taslağı

```ts
// apps/server/src/db/schema/webhook-subscriptions.ts
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: varchar('id', { length: 26 }).primaryKey(), // ULID
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    targetUrl: text('target_url').notNull(), // https:// zorunlu, yazma-anı assertSafeWebhookUrl doğrulaması
    eventTypes: jsonb('event_types').notNull(), // string[], zod ile ['ActionsProposed','ActionsDecided'] alt-kümesine kısıtlı
    encryptedSigningSecret: text('encrypted_signing_secret').notNull(), // encryptSecret() çıktısı
    lifecycle: varchar('lifecycle', { length: 20 }).notNull().default('active'), // 'active' | 'deleted'
    createdByUserId: uuid('created_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('webhook_subscriptions_workspace_id_lifecycle_idx').on(
      table.workspaceId,
      table.lifecycle,
    ),
  ],
);

// apps/server/src/db/schema/webhook-deliveries.ts
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: varchar('subscription_id', { length: 26 })
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 40 }).notNull(),
    payload: jsonb('payload').notNull(), // gönderilen TAM body (imzalanan JSON.stringify çıktısıyla aynı)
    status: varchar('status', { length: 20 }).notNull().default('pending'), // 'pending' | 'delivered' | 'failed'
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastError: text('last_error'), // nullable, sanitize edilmiş mesaj — yanıt gövdesi ASLA
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }), // nullable
  },
  (table) => [
    index('webhook_deliveries_status_next_attempt_at_idx').on(table.status, table.nextAttemptAt),
    index('webhook_deliveries_subscription_id_idx').on(table.subscriptionId),
  ],
);
```

`subscriptionId` KASITLI olarak `webhook_subscriptions.id`'ye FK'li (ADR-0032'nin `objectId`'nin FK'siz kalma gerekçesinin AKSİNE) — çünkü `webhook_subscriptions`, `objects_view` gibi bir projeksiyon değil, fiziksel bir tablo; FK burada gerçek bir bütünlük garantisi sağlıyor.

## PR Bölünmesi

1. **PR1** — `webhook_subscriptions`/`webhook_deliveries` şeması + migration (down script dahil) + `ssrf-guard.ts` (saf, tam birim-test edilmiş: RFC1918/link-local/loopback/unique-local-IPv6 tablo-güdümlü testler + HTTPS-zorunluluğu reddi) + `WebhookSubscriptionsService`/`Controller` CRUD (admin+ RBAC her iki yönde de).
2. **PR2** — Outbound teslimat mekanizması: `webhook-delivery-enqueue.projection.ts` + `WebhookDeliveryService` (imzalama + teslimat-anı SSRF yeniden-doğrulama + `redirect:'manual'`+timeout+boyut-tavanı) + `WebhookDeliveryWorker` (poller).
3. **PR3** — `CommandsService.listProposals` + `GET .../commands/proposals` (member+ RBAC, cross-workspace izolasyon testi).
4. **PR4** — Frontend: `AutomationHistoryPanel.tsx` (onay/red akışı, F1-T16'nın İLK gerçek UI'ı) + `WebhookSubscriptionsPanel.tsx` (bir-kez-sır-ifşa) + hook'lar + `App.tsx` bağlama.

PR1/PR2'nin `security-reviewer`'ı özellikle SSRF yüzeyini (private-IP reddi, HTTPS zorunluluğu, yönlendirme-reddi, teslimat-anı yeniden-doğrulama) ve sır sızıntısını (loglarda/API yanıtlarında ham sır asla görünmez) denetler. PR2'den sonra, PR3/PR4'e geçmeden ÖNCE ayrı bir security-review turu yapılır (teslimat mekanizması SSRF yüzeyinin gerçekten ÇALIŞTIĞI yer).

## İnsan Onayı (ADR taslağından sonra, implementasyondan önce)

Aşağıdaki iki karar, Plan Mode oturumunda AYRI `AskUserQuestion` turlarında (en yüksek riskli güvenlik ödünleşimleri olduğu için) insana AÇIKÇA soruldu ve onaylandı:

- **Karar (a):** SSRF için bağlantı-seviyesi IP pinleme yapılmayacak, DNS-rebinding penceresi v0'da kalıntı risk olarak kabul edilecek — insan onayladı.
- **Karar (b):** HTTPS zorunlu, `http://` hedeflere hiçbir istisna/bypass mekanizması eklenmeyecek — insan onayladı.

Diğer kararlar (c-h) Plan Mode oturumunun `Plan` subagent pressure-test'i sırasında netleşti, ayrı bir soru turu gerektirmedi (mevcut kod tabanı emsallerinden doğrudan türetilebilir nitelikteydi).

## Sonuçlar

- `apps/server/src/webhooks/` yeni bir NestJS modülü olarak açılır — `packages/automation` gibi yeni bir domain paketi İCAT EDİLMEZ (Karar h), mevcut `apps/server/src/notetaker/`/`apps/server/src/calendar/` gibi "framework-katmanlı modül + düz şema" yerleşimini izler.
- `InProcessEventBus` (`event-store/event-bus.ts`) bu görevden sonra da DORMANT kalır — bu ADR onu canlandırmaz, gelecekte prod'a alınması ayrı bir karar/ADR gerektirir.
- `CommandsService.listProposals`, F1-T16/ADR-0015'in öner→onayla sözleşmesine eklenen ilk genel OKUMA yeteneğidir; `recordProposal`'ın kendisi (ADR-0031 §g, ADR-0032 §f) DEĞİŞMEZ.
- `apps/web`'de F1-T16'dan beri hiç var olmamış onay/red arayüzü bu görevle ilk kez inşa edilir (`AutomationHistoryPanel.tsx`) — `decide()` uç noktasının ilk gerçek kullanıcı-arayüzü tüketicisi.
- Webhook abonelik RBAC'ının `AutomationTriggersService`'ten sapması (Karar g), gelecekteki her yeni "hassas config kaynağı" görevinin kendi RBAC kararını `AutomationTriggersService`'in düz emsalinden mi yoksa bu ADR'nin admin-okuma+admin-yazma emsalinden mi türeteceğine dair bir soru bırakır — kaynağın kendi hassasiyet profiline göre değerlendirilmesi gerektiği, ADR-0032/ADR-0033'ün BİRLİKTE gösterdiği örnek.

---

**Sıradaki adım:** Bu ADR insan onayına sunulur. Onaylanırsa PR1'den başlayarak her PR için ayrı `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir:

```
Şu an F2-T16 PR1'e başlıyoruz: webhook_subscriptions/webhook_deliveries şeması+migration
+ ssrf-guard.ts (saf, tam birim-test edilmiş) + WebhookSubscriptionsService/Controller CRUD
(admin+ RBAC her iki yönde de). docs/adr/ADR-0033-yeniden-kullanilabilir-webhooklar-otomasyon-gecmisi.md'deki
Karar (a)-(h)'yi uygulayarak test-writer ile başarısız testleri yaz.
```
