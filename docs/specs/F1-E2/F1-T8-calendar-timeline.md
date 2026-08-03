# F1-T8 — Calendar + Timeline Görünümleri

**Epik:** F1-E2 · **Durum:** Devam Ediyor (PR1 tamamlandı, PR2 gözden geçiriliyor)
**Bağımlılık:** F1-T6, F1-T7 (aynı veri/etkileşim altyapısını paylaşır)

## Amaç

Tarih alanlarına dayalı iki görsel görünüm eklemek: aylık/haftalık takvim ve yatay zaman çizelgesi (basit Gantt öncüsü).

## Kapsam

1. **Calendar görünümü:** Ay/hafta modu; bir `date`/`datetime` tipi custom field'a göre nesneleri günlere yerleştirir (hangi alanın kullanılacağı görünüm ayarında seçilir); sürükle-bırak ile tarih değiştirme (`setFieldValues` tetikler).
2. **Timeline görünümü:** Yatay çubuklar, başlangıç+bitiş tarih alanı olan nesneler için tarih aralığını gösterir; yatay kaydırma ile zaman ekseninde gezinme.
3. **Her ikisi de F1-T6'nın sorgu katmanını** (tarih aralığı filtresiyle: yalnızca görünen ay/hafta aralığındaki nesneler çekilir — performans için tam liste değil).
4. **Bugün işareti** (calendar'da bugünün günü vurgulanır), **F1-T3'ün ilişkileri** ile bağlantılı nesneler arasında görsel bağlantı (opsiyonel, basit çizgi — karmaşık layout algoritması gerekmez).

## Kapsam DIŞI

- Sürükle-bırakta bağımlılık zincirinin otomatik kayması (Faz 2 — otomasyon işleri).
- Kaynak/kişi bazlı satır gruplaması (Workload görünümü, ayrı bir görev).

## Kabul Kriterleri

- [x] Calendar: bir nesnenin tarih alanı, doğru günde/hücrede görünür; sürükle-bırak ile tarih değişir ve API'ye yazılır (PR1, birim/component testleriyle kanıtlı — `CalendarView.test.tsx`, `dragEndUpdate.test.ts`). **Not:** gerçek tarayıcıda `claude-in-chrome` ile ayrıca doğrulanmadı.
- [ ] Timeline: başlangıç/bitiş tarihli bir nesne doğru pozisyon ve genişlikte çubuk olarak render edilir. (PR2 — #27 — henüz CI'da, main'e alınmadı.)
- [ ] Görünen tarih aralığı dışındaki nesneler sorguya dahil edilmez (performans testi — sorgu her ay değiştiğinde yeniden tetiklenir, tüm veri bir kerede çekilmez). Calendar tarafı `calendarQuery.ts` ile sağlandı (PR1); Timeline tarafı PR2'yi (#27) bekliyor, bu yüzden kriter genel olarak henüz işaretlenmedi.
- [ ] Her iki görünüm de F0-T7 tema sistemiyle (light/dark) uyumlu render edilir. **Calendar tarafı PR1'de tamamlandı** (token-only CSS Module); Timeline tarafı PR2'de (#27) tamamlanacak — bu yüzden kriter bütün olarak henüz `[x]` yapılmadı.

## İlerleme Notu

- **PR1** (branch: `feature/f1-t8-pr1-calendar-view`, [#25](https://github.com/sirfurkansahin/luminaos/pull/25), main'e squash-merge edildi): Calendar görünümü — `apps/web/src/lib/dateMath.ts` (UTC-anchored ay/hafta ızgara matematiği, kütüphane eklenmeden), `dateFieldCandidates.ts` (tarih alanı tespiti — henüz kayıtlı görünüm ayarı olmadığından bootstrap sorgusuyla ilk sayfadan türetiliyor), `apps/web/src/views/calendar/calendarQuery.ts` (F1-T6'nın `between` operatörüyle yalnızca görünen aralığı sorgulama), `dragEndUpdate.ts` + `CalendarGrid`/`CalendarObjectChip`/`CalendarView` (Board'daki (F1-T7 PR3) per-drag optimistic override + per-call `onError` deseni tekrarlandı). `ViewSwitcher`/`useViewParam`/`App.tsx`'e Takvim sekmesi eklendi. **security-reviewer bulgusu (kapatıldı):** `computeVisibleRange`'in çıplak `throw new RangeError`'ı `packages/shared/errors`'ın `ValidationError`'ına çevrildi.
- **PR2** (branch adı henüz bu spec'e işlenmedi, [#27](https://github.com/sirfurkansahin/luminaos/pull/27)): Timeline görünümü — CI'da, henüz main'e alınmadı. Merge sonrası bu spec ayrıca güncellenecek.

## Bilinen Sınırlamalar / Takip

- İlişki bağlantı çizgileri (F1-T3'ün ilişkileriyle görsel bağlantı — opsiyonel, bu spec'in kabul kriterlerinde yer almıyor) PR1 kapsamı dışında bırakıldı.
- Tarih alanı/mod (ay/hafta) seçimi şu an yerel component state'inde tutuluyor, URL'e veya kalıcı bir görünüm ayarına senkron değil — F1-T9 (kayıtlı görünüm ayarları) tamamlanınca ele alınacak.
- Gerçek tarayıcıda `pnpm dev` + `claude-in-chrome` ile uçtan uca doğrulama PR1 için henüz yapılmadı — yalnızca birim/component test seviyesinde kanıtlı.
