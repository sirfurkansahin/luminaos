# F1-T12 — Takvim: Google/Outlook Senkronu, Zaman Bloklama v1, Odak/OOO

**Epik:** F1-E3 (Görev + Doküman + Takvim Çekirdeği) · **Durum:** Yapılacak
**Bağımlılık:** F1-T1 (varlık tipi kayıt defteri), F1-T3 (ilişki sistemi), F1-T8 (Calendar/Timeline görünümü), F0-T5 (auth/secrets deseni)

## Amaç

Dış takvimlerle (Google, Outlook) temel senkron, LuminaOS içi zaman bloklama ve kullanıcı Odak/OOO durumu.

## Kapsam

1. **Bağlayıcılar** (`packages/integrations/google-calendar`, `packages/integrations/outlook-calendar`): OAuth2 (Google) ve Microsoft Graph OAuth akışı; token'lar F0-T5'teki secrets deseniyle şifreli saklanır; minimal scope (`calendar.readonly` + zaman bloğu push'u için `calendar.events`).
2. **v1 senkron yönü (bilinçli kapsam sınırlaması):** Dış takvim etkinlikleri **salt-okunur** içeri çekilir (5 dakikalık polling — webhook/push aboneliği Faz 2'de). LuminaOS'te oluşturulan zaman blokları (madde 3) **tek yönlü** dışa yazılır. Dış takvimde yapılan bir düzenlemenin LuminaOS zaman bloğuna geri yansıması bu görevde YOK.
3. **`timeblock` nesne tipi:** F1-T1'in tip kayıt defterine eklenir (`start`, `end` alanları); F1-T3 ilişki sistemiyle isteğe bağlı bir `task`'a `blocks-time-for` ilişkisiyle bağlanabilir.
4. **Çakışma tespiti:** Aynı kullanıcı için aynı zaman aralığında örtüşen iki `timeblock` (veya bir `timeblock` ve içeri çekilen dış etkinlik), F1-T8 Calendar görünümünde uyarı rozeti ile işaretlenir (engelleme değil, yalnızca uyarı).
5. **Odak/OOO durumu:** `UserAvailability` event-sourced aggregate (`UserAvailabilityChanged` olayı, `available|focus|ooo` + opsiyonel `until` zaman damgası); kullanıcı manuel değiştirir. Takvimden otomatik türetme bu görevde YOK (madde Kapsam Dışı).
6. **UI:** Calendar görünümünde dış/iç etkinlik ayrımı (renk/ikon), zaman bloğu oluşturma (sürükle-bırak, F1-T8 altyapısını kullanır), header'da Odak/OOO seçici.

## Kapsam DIŞI

- Tam iki yönlü senkron (dış düzenleme → LuminaOS'e yansıma) ve webhook-tabanlı anlık güncelleme.
- Takvim durumundan (ör. toplantı sırasında) otomatik Odak/OOO türetme.
- Zoom/Meet/Notetaker entegrasyonu (F2-T13).
- Diğer takvim sağlayıcıları (yalnızca Google + Outlook).
- **Saatlik grid görünümü (gün-içi zaman konumlandırması).** F1-T8'in Calendar görünümü aylık bir grid'dir (hücre = gün, saat dilimi yok). Madde 6'daki "sürükle-bırak" zaman bloğu oluşturma bu yüzden PR8'de gün hücresine tıkla → başlangıç/bitiş saati formu ile karşılanır, piksel-hassasiyetli saat-aralığı sürükleme ile DEĞİL. Google Calendar tarzı saatlik/haftalık grid + gerçek saat-aralığı sürükleme, F1-T8'in gelecekteki bir genişlemesi olarak ayrı ele alınmalı.

## Kabul Kriterleri

- [ ] Mock OAuth + sahte Google/Outlook istemcisiyle: hesap bağlanır, dış etkinlikler Calendar görünümünde salt-okunur görünür (entegrasyon testli).
- [ ] Zaman bloğu oluşturulduğunda karşılık gelen dış etkinliğin (mock adaptör üzerinden) oluştuğu testli; güncelleme/silme de dışa yansır.
- [ ] Token süresi dolduğunda otomatik yenileme akışı testli; yenileme başarısızsa kullanıcıya tanımlı hata/yeniden bağlanma isteği gösterilir.
- [ ] Çakışan iki zaman bloğu (veya blok + dış etkinlik) Calendar görünümünde uyarı rozetiyle işaretlendiği testli.
- [ ] Odak/OOO durum değişikliği event log'da izlenebilir; UI'da anlık yansır (testli).
- [ ] security-reviewer: OAuth token depolama ve scope minimizasyonu denetlendi.
