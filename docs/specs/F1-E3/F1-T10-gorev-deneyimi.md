# F1-T10 — Görev Deneyimi (Durum, Öncelik, Kontrol Listesi, Yinelenen, Hatırlatıcı)

**Epik:** F1-E3 (Görev + Doküman + Takvim Çekirdeği) · **Durum:** Yapılacak
**Bağımlılık:** F1-T1 (varlık çekirdeği), F1-T2 (custom fields), F1-T3 (ilişki sistemi), F1-T6 (sorgu katmanı)

## Amaç

`task` nesne tipini gerçek bir görev deneyimine dönüştürmek: durum/öncelik, kontrol listesi, yinelenen görevler, hatırlatıcı. Tasarım ilkesi: mümkün olduğunca F1-T1/T2/T3'te zaten kurulan genel mekanizmalar (Custom Fields, ilişkiler, event sourcing) yeniden kullanılır — görev için özel bir paralel veri modeli açılmaz.

## Kapsam

1. **Durum/Öncelik varsayılan alanları:** Yeni workspace oluşturulduğunda `task` tipi için iki `select` Custom Field otomatik provizyone edilir (F1-T2 mekanizmasıyla, idempotent seed — F0-T5 workspace oluşturma akışına eklenir): `status` (Yapılacak/Sürüyor/Bitti, seçenekler silinemez yalnızca yeni eklenebilir) ve `priority` (Düşük/Orta/Yüksek/Acil). Bu tasarım sayesinde F1-T7'deki Board görünümü ekstra kod olmadan `status`'a göre gruplanabilir.
2. **`select` alan seçeneklerine `isDone` bayrağı:** F1-T2'nin seçenek şemasına opsiyonel `isDone: boolean` eklenir (yalnız `status` alanında anlamlı; varsayılan seed'de "Bitti" seçeneğinde `true`). Bu bayrak, madde 4'teki yinelenen görev tetikleyicisinin veri kaynağıdır.
3. **Kontrol listesi (checklist):** Ayrı LuminaObject açılmaz — `packages/core-objects`'e gömülü `ChecklistItem[]` değer tipi eklenir: `{ id(ULID), text, done: boolean, order: number }`. Komutlar: `addChecklistItem/toggleChecklistItem/removeChecklistItem/reorderChecklistItem` → olaylar `ChecklistItemAdded/Toggled/Removed/Reordered`. Üst sınır: görev başına 200 öğe (aşımda `ValidationError`).
4. **Yinelenen görevler:** Task'a `recurrenceRule` alanı (`{ frequency: 'daily'|'weekly'|'monthly', interval: number, byWeekday?: number[], endDate?: string }`). `status` alanı `isDone=true` seçeneğine geçtiğinde (madde 2), bir sonraki tekrarın tek bir yeni `task` nesnesi olarak üretilmesi tetiklenir; yeni nesne F1-T3 ilişki sistemiyle önceki nesneye `recurrence-of` ilişkisiyle bağlanır. Üretim idempotent olmalı (aynı tamamlanma olayı için ikinci kez tetiklenmez — olay ID'si ile kilitlenir).
5. **Hatırlatıcı:** `remindAt` (datetime) + `remindAcknowledged` (boolean) alanları. OS-seviyesi push bildirimi bu görevin kapsamında DEĞİL (bkz. Kapsam Dışı); bunun yerine F1-T6 sorgu katmanı üzerinden `remindAt <= now() AND remindAcknowledged = false` sorgusu açık istemcide 60 sn'de bir çalışır, süresi geçen hatırlatıcılar uygulama içi bildirim (toast/badge) olarak gösterilir; kullanıcı görünce `ReminderAcknowledged` olayı üretilir.
6. **UI:** Görev detay panelinde durum/öncelik seçiciler, kontrol listesi widget'ı, yinelenme kural seçici, hatırlatıcı seçici — `packages/ui` (F0-T7) bileşenleriyle.

## Kapsam DIŞI

- OS-seviyesi/push bildirimleri (Tauri native notification, web push, mobil push) — otomasyon motoruyla (F2-E5) birlikte ele alınacak.
- Atama/mention bildirim sistemi.
- Çoklu kullanıcının aynı kontrol listesini eşzamanlı düzenlerken çakışma çözümü (CRDT) — F1-T11'deki doküman CRDT altyapısından ayrı, bu görevde son-yazan-kazanır yeterli.
- Takvimden otomatik hatırlatıcı türetme (F1-T12).

## Kabul Kriterleri

- [ ] Yeni workspace oluşturulduğunda `task` tipi için `status`/`priority` alanları otomatik var olur (entegrasyon testli); seed ikinci kez çalıştırılırsa yinelenmez (idempotent, testli).
- [ ] Kontrol listesi: ekleme/işaretleme/silme/yeniden sıralama olayları `replayObject` ile doğru sırayla katlandığı property-based testle kanıtlı.
- [ ] `status` alanı `isDone=true` seçeneğine geçince tam olarak bir yeni yinelenen görev üretildiği, önceki göreve `recurrence-of` ilişkisiyle bağlandığı testli; aynı tamamlanma olayının iki kez işlenmesi ikinci nesneyi üretmediği (idempotency) testli.
- [ ] Hatırlatıcı: `remindAt` geçmiş ve `remindAcknowledged=false` olan görevler sorgu katmanından doğru döner; kullanıcı gördükten sonra `ReminderAcknowledged` olayı üretilip tekrar listelenmediği testli.
- [ ] F1-T7 Board görünümü, ek kod gerekmeden `status` alanına göre gruplayabildiği regresyon testiyle doğrulanır.
