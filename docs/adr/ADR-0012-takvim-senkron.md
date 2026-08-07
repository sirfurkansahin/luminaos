# ADR-0012: Takvim Senkronu — Dış Kaynak Read-Through Cache, `timeblock` Nesnesi ve `UserAvailability` Aggregate'i

**Durum:** Kabul edildi
**Tarih:** 2026-08-07
**İlgili görev:** [F1-T12 — Takvim: Google/Outlook Senkronu, Zaman Bloklama v1, Odak/OOO](../specs/F1-E3/F1-T12-takvim.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E3: Görev + Doküman + Takvim Çekirdeği" (F1-T12 satırı) ve CLAUDE.md "Mimari Değişmezler": _"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."_ — ayrıca "ADR Ne Zaman Gerekir" maddesinin ikinci fıkrası: karar birden fazla pakete ve gelecekteki görevlere dayatılan sözleşmeler (`CalendarConnector` soyutlaması, token şifreleme yardımcısı, `UserAvailabilityChanged` olay tipi) tanımlıyor.

> Bu ADR mimari-kritiktir. F1-T12 spec'i açıkça işaretliyor: dış takvim (Google/Outlook) etkinliklerinin LuminaOS'e içeri çekilmesi, CLAUDE.md'nin "tek doğruluk kaynağı olay günlüğüdür" değişmeziyle doğrudan gerilim yaratıyor — dış etkinlikler LuminaOS'in üretmediği, LuminaOS'in yetki alanı dışındaki bir kaynağın verisidir. Ayrıca repoda OAuth token'larını şifreleyecek hiçbir mekanizma yok (yeni güvenlik yüzeyi). Bu ADR, o gerilimin nasıl çözüldüğünü ve token şifrelemesinin nasıl kurulacağını koddan ÖNCE belgeler (ADR-0010/F1-T10, ADR-0011/F1-T11 emsali) ve koda geçilmeden önce AYRI bir insan onayı gerektirir.

## Bağlam

F1-T12, LuminaOS'e üç ayrı ama ilişkili yetenek kazandırıyor: (1) dış takvimlerle (Google, Outlook) temel senkron, (2) LuminaOS içi `timeblock` (zaman bloklama) nesne tipi, (3) kullanıcının manuel Odak/OOO durumu. Bu yeteneklerin her biri, kod tabanında bugün var olmayan bir altyapıya dayanıyor:

1. **Token şifreleme mekanizması yok.** `apps/server` ve `packages/shared` içinde hiçbir AES-GCM/cipher/KMS/zarf-şifreleme (envelope encryption) yolu yok. Var olan tek kriptografik yol `apps/server/src/auth/password.ts`'teki `argon2` parola karması — bu tanım gereği TEK YÖNLÜ (geri-döndürülemez) bir özet fonksiyonudur ve OAuth erişim/yenileme token'ları gibi geri okunması gereken sırlar için KULLANILAMAZ. Şifreli-token depolaması sıfırdan kurulmalı. Env-tabanlı sır okuma emsali `apps/server/src/config/env.ts`'te mevcut (`readAnthropicApiKey()`, `Env` arayüzü).
2. **`packages/integrations` yok** (greenfield). Mimari emsal, `packages/ai-gateway`: bir `AIProvider` arayüzü (`provider.ts`), bir `MockProvider` ve gerçek `AnthropicProvider`, ve `apps/server/src/ai/ai-provider.module.ts`'teki `useFactory` DI fabrikası (bir `AI_PROVIDER` token'ını env'e göre Mock veya gerçek sağlayıcıya bağlar). Bu Mock-öncelikli desen birebir taklit edilecek.
3. **Yeni nesne tipi kaydı** `packages/core-objects/src/lumina-object.ts`'in `ObjectType` birleşimine + `object-type-registry.ts`'e eklenir; tipe-özgü alanlar (bugün `recurrenceRule?`/`checklist` emsalinde olduğu gibi) `LuminaObject` üzerinde GÖMÜLÜ opsiyonel alanlardır, Custom Field DEĞİL. `objects_view` projeksiyon genişletme emsali F1-T10 PR6a.
4. **Nesne-olmayan event-sourced aggregate emsali** `recordAIUsage` (`apps/server/src/objects/objects.service.ts`): kendi `streamType`/`streamId`'siyle `expectedVersion 0`'da append eder; `AIUsageProjection` (`apps/server/src/ai/ai-usage.projection.ts`) bir upsert projeksiyonudur. `EventStoreService.append(streamId, expectedVersion, events)` ve olay zarfının `streamId`'sinin `z.uuid()` olması (`packages/shared/src/events/domain-event.ts`) belirleyici kısıtlardır.
5. **Zamanlanmış-iş (scheduled job) altyapısı yok** — `@nestjs/schedule` bir bağımlılık değil; yalnızca bellek-içi bir debounce (`AIRefreshScheduler`) var. Periyodik polling için `@nestjs/schedule` yeni bir bağımlılık olarak eklenir.

Çözülmesi gereken merkezi soru: dış takvimin (Google/Outlook — kendi başına yetkili bir kaynak) verisi, "tek doğruluk kaynağı olay günlüğüdür" değişmezini ihlal etmeden LuminaOS'e nasıl getirilir; ve buna eşlik eden token güvenliği, senkron yönü ve soyutlama sınırları hangi ödünlerle çizilir?

## Karar

### (a) Dış etkinlikler event-sourced DEĞİLDİR — salt-okunur read-through cache (merkezi mimari karar)

Dış takvim (Google/Outlook), LuminaOS'in DEĞİL, KENDİSİNİN doğruluk kaynağıdır. İçeri çekilen dış etkinlikler LuminaOS'in olay günlüğüne **ASLA yazılmaz** — periyodik olarak bir okuma-modeli önbellek (cache) tablosuna (`external_calendar_events`, aşağıda) getirilir. Yalnızca LuminaOS-kökenli `timeblock` nesneleri ve `UserAvailability` aggregate'i event-sourced'tur.

Bu, "tek doğruluk kaynağı olay günlüğüdür" değişmeziyle olan gerilimi şöyle çözer: değişmez, **LuminaOS'in kendi durumu** hakkında bir iddiadır — LuminaOS'in ürettiği/sahiplendiği her olgu, önce olay günlüğüne olay olarak düşer, geri kalan her şey ondan türetilir. Dış takvim etkinliği ise LuminaOS'in bir olgusu değildir; YABANCI bir doğruluk kaynağının (Google/Outlook sunucusunun) durumunun bir izdüşümüdür (projeksiyonudur). Onu olay günlüğüne yazmak, değişmezi güçlendirmek yerine ZAYIFLATIRDI: LuminaOS, sahibi olmadığı ve tek taraflı değiştiremeyeceği veriyi kendi değişmez günlüğüne kalıcı kılarak, dış kaynak o etkinliği sildiğinde/değiştirdiğinde günlüğü ile gerçeklik arasında düzeltilemez bir tutarsızlık biriktirirdi (olaylar değişmezdir; düzeltme = yeni olay — ama burada "düzeltme"nin kaynağı LuminaOS değildir). Doğru model: dış veri, dış kaynağın izdüşümü olarak yaşayan, her polling turunda tazelenen, LuminaOS için **türetilmiş ve atılabilir** bir önbellektir. Önbelleğin kaybı veri kaybı değildir — bir sonraki polling turunda dış kaynaktan yeniden dolar.

Bunun somut sonucu: `external_calendar_events` tablosu ve `calendar_accounts` tablosu ile polling worker'ı, olay günlüğünün PARÇASI DEĞİLDİR — bunlar tamamen okuma-tarafı (read-side) altyapısıdır. Hiçbiri `EventStoreService.append` çağırmaz; hiçbiri replay'e girmez.

### (b) v1 senkron yönü — salt-okunur pull (5 dk polling) + tek yönlü `timeblock` push (bilinçli kapsam sınırlaması)

İki tek-yönlü akış:

- **İçeri (dış → LuminaOS): salt-okunur pull, 5 dakikalık polling.** `@nestjs/schedule` (yeni bağımlılık) ile bir cron/interval worker, bağlı her `calendar_accounts` satırı için dış etkinlikleri ilgili aralıkta çekip `external_calendar_events` önbelleğine upsert eder. Webhook/push aboneliği YOK (spec Kapsam Dışı, Faz 2).
- **Dışa (LuminaOS → dış): tek yönlü `timeblock` push.** LuminaOS'te oluşturulan/güncellenen/silinen `timeblock` nesneleri, `CalendarConnector` (§d) üzerinden dış takvime yansıtılır (`createEvent`/`updateEvent`/`deleteEvent`).

**Dış → LuminaOS write-back YOK, webhook YOK** (spec Kapsam Dışı): dış takvimde yapılan bir düzenleme LuminaOS `timeblock`'una geri yansımaz.

**Kabul edilen sınırlama — çoklu-örnek polling tekilleştirmesi kapsam DIŞI.** Polling worker'ı, sunucunun TEK bir süreçte çalıştığını varsayar. Birden fazla sunucu süreci (yatay ölçekleme) aynı `calendar_accounts` satırını eşzamanlı poll ederse, mükerrer dış çağrı ve önbellek yarışı doğar. F1-T12 bunu ÇÖZMÜYOR — bilinen bir sınırlama olarak kayda geçiriliyor (bir dağıtık kilit / lider seçimi / iş kuyruğu gerektiğinde ayrı bir görev). ADR-0011'in tek-örnek-varsayımı ile aynı ruhta bilinçli bir kapsam sınırıdır.

### (c) Token şifrelemesi — `ENCRYPTION_KEY` env + AES-256-GCM, `node:crypto` ile framework-free yardımcı

Yeni bir 32-baytlık `ENCRYPTION_KEY` env değişkeni tanımlanır ve AES-256-GCM (kimlik doğrulamalı şifreleme — hem gizlilik hem bütünlük) için anahtar olarak kullanılır. Şifreleme/çözme, `packages/shared` içinde saf `node:crypto`'ya dayanan bir yardımcı olarak yazılır (ör. `encryptSecret(plaintext): string` / `decryptSecret(ciphertext): string`, çıktı `iv:authTag:ciphertext` biçiminde paketlenir). `node:crypto` bir framework DEĞİLDİR (Node standart kütüphanesi), dolayısıyla CLAUDE.md'nin "domain paketleri framework import edemez" kuralını ihlal etmez ve `packages/shared`'te yaşaması uygundur.

OAuth erişim ve yenileme (refresh) token'ları, yeni `calendar_accounts` tablosunda **rest'te (at-rest) şifreli** saklanır; asla düz metin yazılmaz. Token'lar HİÇBİR ZAMAN loglanmaz — `apps/server/src/observability/redact.ts`'in mevcut redaksiyon emsali yeniden kullanılarak token alanları log yollarında maskelenir.

`ENCRYPTION_KEY`, takvim özellikleri kullanıldığında **eksikse ölümcül (fatal-if-missing)** bir sırdır: `readAnthropicApiKey()` deseniyle (`env.ts`), env okuması sırasında yokluğu net bir yapılandırma hatasıyla yüzeye çıkar. Anahtar 32 bayt değilse (AES-256'nın gerektirdiği uzunluk) yine başlangıçta reddedilir.

**Erteleme:** KMS / zarf-şifreleme (envelope encryption) ve anahtar rotasyonu bu görevin kapsamı DIŞINDADIR — tek, statik, env-tabanlı bir ana anahtar bugün için yeterli kabul edildi; üretim sertleştirmesi gerektiğinde ayrı bir görev.

### (d) `CalendarConnector` soyutlaması — arayüz + Mock + DI fabrikası; gerçek adaptörler ERTELENDİ

`ai-gateway`'in `AIProvider` desenini birebir taklit eden bir bağlayıcı soyutlaması tanımlanır (`packages/integrations`):

```
interface CalendarConnector {
  listEvents(range: { start: string; end: string }): Promise<ExternalCalendarEvent[]>;
  createEvent(event: TimeBlockDraft): Promise<{ externalId: string }>;
  updateEvent(externalId: string, event: TimeBlockDraft): Promise<void>;
  deleteEvent(externalId: string): Promise<void>;
  refreshToken(account: CalendarAccount): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }>;
}
```

Bir `MockCalendarConnector` (bellek-içi, deterministik) ve `ai-gateway`'in `AI_PROVIDER` token + `useFactory` desenini yansıtan bir sunucu DI fabrikası (`CALENDAR_CONNECTOR` token'ı, env'e göre Mock veya gerçek adaptör seçer) sağlanır.

**Gerçek Google (OAuth2) ve Outlook (Microsoft Graph) adaptörleri, AYRI bir gelecek göreve ERTELENİR** — bu, insan tarafından verilmiş bir karardır (bir omission değil): şu an gerçek OAuth kimlik bilgisi / gerçek-OAuth test ortamı yoktur. F1-T12'nin TÜM kabul kriterleri Mock bağlayıcıya karşı sağlanır — bu, `ai-gateway`'in Mock-öncelikli desenini birebir izler (gerçek `AnthropicProvider` de kendi zamanında geldi). Token yenileme akışı (Kabul #3), Mock'un `refreshToken`'ının süre-dolumu/başarısızlık senaryolarını simüle etmesiyle test edilir.

### (e) `timeblock` nesne tipi — gömülü `start`/`end` alanları + opsiyonel `blocks-time-for` ilişkisi

`timeblock`, `ObjectType` birleşimine (`lumina-object.ts`) ve `object-type-registry.ts`'e eklenir. `recurrenceRule?`/`checklist` emsalindeki gibi, `LuminaObject` üzerine iki GÖMÜLÜ opsiyonel alan eklenir: `start` ve `end` (ISO-8601 zaman damgası string'leri). Bunlar Custom Field DEĞİLDİR. Bir `timeblock`, F1-T3 ilişki sistemiyle isteğe bağlı olarak bir `task`'a **`blocks-time-for`** ilişkisiyle bağlanabilir (`fromId` = `timeblock`, `toId` = `task`). Bu ilişki, ADR-0006/ADR-0010'un `RelationKind` birleşimine eklenecek yeni bir üyedir; `parentChild`'ın tekillik kısıtını taşımaz (bir görev için birden çok zaman bloğu ayrılabilir).

### (f) `UserAvailability` event-sourced aggregate — deterministik per-user streamId

Odak/OOO durumu, nesne-olmayan bir event-sourced aggregate'tir (`recordAIUsage`/`AIUsageProjection` emsali):

- **`streamType: 'user-availability'`**, ve kullanıcı başına **DETERMİNİSTİK** bir `streamId`: `userId`'den sabit bir namespace'te UUIDv5 ile türetilir. Bu, `recordAIUsage`'ın kayıt-başına tek-kullanımlık (throwaway) rastgele UUID'sinden bilinçli bir SAPMADIR ve gereklidir: olay zarfının `streamId`'si bir UUID olmak zorunda (`z.uuid()`), ve aggregate oturumlar arasında yeniden AÇILABİLİR olmalı (aynı kullanıcının durumu tekrar tekrar değiştikçe replay + append yapılır) — bu yüzden `streamId` `userId`'nin deterministik bir fonksiyonu olmalı, rastgele değil.
- Olay: **`UserAvailabilityChanged { userId, status: 'available' | 'focus' | 'ooo', until?: string }`** — kullanıcı tarafından MANUEL değiştirilir (`until` opsiyonel bitiş zaman damgası). Append, aggregate'in mevcut versiyonuna karşı yapılır (ilk olay `expectedVersion 0`).
- **Last-write-wins upsert projeksiyonu** yeni bir `user_availability` tablosuna (userId ile anahtarlanmış), `AIUsageProjection`'ın upsert desenini yansıtır — en son durum tek satır olarak tutulur.

**Kapsam Dışı (spec):** takvim durumundan (ör. toplantı sırasında otomatik `focus`) durum türetme YOK — durum yalnızca kullanıcı-set'tir.

### (g) Çakışma tespiti — türetilmiş, yalnızca-UYARI (engelleyici değil)

Çakışma tespiti event-sourced bir olgu DEĞİL, türetilmiş bir okuma-zamanı hesabıdır: bir kullanıcının `timeblock`'ları ile önbellekteki dış etkinlikleri arasında örtüşen aralıklar, F1-T8 Calendar görünümünde bir uyarı ROZETİ olarak yüzeye çıkar. **Engelleyici DEĞİLDİR** — çakışan blok oluşturma reddedilmez; yalnızca görsel uyarı verilir. Bu, "durum verinin türetilmesidir, ayrı bir olay değildir" disipliniyle uyumludur.

### (h) OAuth minimal scope (ertelenmiş gerçek adaptörler için belgelenir)

Kabul #6 (scope minimizasyonu) gereği, gerçek adaptörler geldiğinde kullanılacak minimal scope'lar şimdiden sabitlenir: **Google** → `calendar.readonly` (pull) + `calendar.events` (timeblock push); **Microsoft Graph** → eşdeğerleri (`Calendars.Read` + `Calendars.ReadWrite`, salt gerekli olduğu ölçüde daraltılmış). Bu, ertelenen adaptör görevinin bir sözleşmesidir; F1-T12'de Mock kullanıldığı için runtime'da uygulanmaz ama ADR'de kayıtlıdır.

## Yeni olay ve şema özetleri

- **`timeblock` yaşam-döngüsü olayları** — nesne komut→olay desenini (geçmiş zaman) izler ve `timeblock`'un KENDİ nesne stream'inde yaşar. `start`/`end` GÖMÜLÜ alanlardır (Custom Field DEĞİL), dolayısıyla `FieldValueChanged` (yalnızca düz `fieldValues` Custom-Field haritası için) ile YAZILMAZLAR — `recurrenceRule` emsalindeki gibi kendi olaylarını gerektirirler: oluşturmada `ObjectCreated` payload'u `start`/`end`'i taşır (title'ın taşındığı gibi) ve güncelleme için `recurrenceRule`'un `RecurrenceRuleSet`'i emsalinde geçmiş-zamanlı ayrı bir olay (ör. `TimeBlockScheduled`/`TimeBlockRescheduled` — kesin adlandırma PR2'de test-writer/implementer tarafından, `recurrence-rule-commands` desenini izleyerek sabitlenir). Yaşam döngüsünün geri kalanı (archive/restore/delete/rename) mevcut genel nesne olaylarını paylaşır.
- **`UserAvailabilityChanged { userId, status: 'available'|'focus'|'ooo', until? }`** — yeni, nesne-olmayan aggregate olayı (§f). Replay tarafında (`packages/core-objects/src/replay.ts`'in yetkili olay-tipi listesi ile hizalı) tanınmayan-olay-no-op ileriye-uyumluluk disiplinine uyar.
- **Read-tarafı tabloları (olay günlüğünün parçası DEĞİL):**
  - `calendar_accounts` — bağlı hesap başına: provider, kullanıcı, şifreli (AES-256-GCM) access/refresh token, `expiresAt`. Migration down-script'iyle (CLAUDE.md).
  - `external_calendar_events` — polling ile doldurulan dış etkinlik önbelleği (read-through cache); atılabilir, dış kaynaktan yeniden dolar.
  - `user_availability` — `UserAvailability` aggregate'inin LWW upsert projeksiyonu (userId ile anahtarlı).
  - Polling worker'ı da dahil, bu üçü tamamen okuma-tarafı altyapısıdır (§a).

## Değerlendirilip reddedilen alternatifler

- **Dış etkinlikleri olay günlüğüne yazmak (ör. `ExternalEventImported` olayı).** Reddedildi — §a: LuminaOS'in sahibi olmadığı, tek taraflı değiştiremediği yabancı bir kaynağın verisini değişmez günlüğe kalıcı kılmak, değişmezi güçlendirmek yerine günlük ile gerçeklik arasında düzeltilemez tutarsızlık biriktirir. Dış veri türetilmiş/atılabilir önbellek olarak doğru modellenir.
- **Tam iki-yönlü senkron ve webhook/push aboneliği.** Reddedildi — spec Kapsam Dışı (Faz 2). v1, salt-okunur pull + tek-yönlü timeblock push ile bilinçli olarak sınırlı.
- **Gerçek Google/Outlook adaptörlerini şimdi yazmak.** Reddedildi/ertelendi — gerçek OAuth kimlik bilgisi / test ortamı yok; `ai-gateway`'in Mock-öncelikli emsali, tüm kabul kriterlerinin Mock'a karşı kanıtlanmasına ve gerçek adaptörün ayrı görevde gelmesine izin veriyor.
- **Token'ları `argon2` ile "korumak" veya düz metin saklamak.** Reddedildi — `argon2` tek yönlüdür, geri okunması gereken token'lar için kullanılamaz (§c); düz metin depolama, sızıntıda doğrudan hesap ele geçirme demektir. Geri-döndürülebilir kimlik-doğrulamalı şifreleme (AES-256-GCM) gerekli.
- **KMS / zarf-şifreleme ile başlamak.** Reddedildi/ertelendi — tek, env-tabanlı ana anahtar bugün yeterli; KMS operasyonel karmaşıklığı bu görevin kapsamını aşıyor.
- **`UserAvailability` için `recordAIUsage` gibi rastgele per-record streamId.** Reddedildi — aggregate oturumlar arası yeniden-açılabilir olmalı (replay + append); streamId, `userId`'den deterministik türetilmeli (UUIDv5), aksi halde aynı kullanıcının durum akışı tek bir stream'de toplanamaz.
- **Çakışmayı engelleyici (blocking) kılmak veya ayrı bir olay olarak günlüğe yazmak.** Reddedildi — spec yalnızca-uyarı istiyor; çakışma türetilmiş bir okuma-zamanı hesabıdır, ayrı bir olgu/olay değil.
- **`start`/`end`'i Custom Field olarak modellemek.** Reddedildi — `recurrenceRule`/`checklist` emsali gereği tipe-özgü alanlar `LuminaObject`'e gömülür; Custom Field, kullanıcı-tanımlı alanlar içindir, tip-içsel yapı için değil.

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- Dış takvim verisi ile olay günlüğü değişmezi arasındaki gerilim, dış veriyi YABANCI bir doğruluk kaynağının atılabilir izdüşümü (read-through cache) olarak modelleyerek çözüldü — LuminaOS'in kendi olgularının event-sourced olma değişmezi bozulmadan.
- Geri-döndürülebilir, kimlik-doğrulamalı token şifrelemesi (`packages/shared`, `node:crypto`, AES-256-GCM) kod tabanına ilk kez giriyor ve gelecekteki tüm at-rest sır ihtiyaçları için yeniden kullanılabilir bir emsal bırakıyor; `redact.ts` ile loglama-güvenliği korunuyor.
- `CalendarConnector` soyutlaması `ai-gateway`'in kanıtlanmış Mock-öncelikli + DI-fabrikası desenini yansıtıyor — gerçek sağlayıcı adaptörleri, çekirdek mantık değişmeden takılabilir.
- `timeblock` küçük, düşük riskli bir nesne-tipi genişlemesi (`recurrenceRule` emsali); `UserAvailability`, `recordAIUsage`/`AIUsageProjection`'ın nesne-olmayan aggregate desenini deterministik-streamId sapmasıyla yeniden kullanıyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- **Gerçek Google/Outlook adaptörleri** — ayrı gelecek görev; F1-T12 tamamen Mock'a karşı kanıtlanır (gerçek OAuth test ortamı yok).
- **Çoklu-örnek polling tekilleştirmesi** — tek-sunucu-örneği varsayımı; yatay ölçekleme gerektiğinde dağıtık kilit/lider-seçimi için ayrı görev.
- **KMS / zarf-şifreleme / anahtar rotasyonu** — tek statik env anahtarı bugün yeterli; üretim sertleştirmesi ayrı görev.
- **Tam iki-yönlü senkron, webhook/push, takvimden otomatik Odak/OOO türetme** — spec Kapsam Dışı (Faz 2).
- **`ENCRYPTION_KEY` yönetimi bir operasyonel yük** — eksik/yanlış-uzunlukta anahtar takvim özelliklerini ölümcül biçimde devre dışı bırakır; bu, düz-metin token riskine karşı bilinçli bir ödün.
