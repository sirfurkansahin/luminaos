# F1-T8 — Calendar + Timeline Görünümleri

**Epik:** F1-E2 · **Durum:** Yapılacak
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

- [ ] Calendar: bir nesnenin tarih alanı, doğru günde/hücrede görünür; sürükle-bırak ile tarih değişir ve API'ye yazılır.
- [ ] Timeline: başlangıç/bitiş tarihli bir nesne doğru pozisyon ve genişlikte çubuk olarak render edilir.
- [ ] Görünen tarih aralığı dışındaki nesneler sorguya dahil edilmez (performans testi — sorgu her ay değiştiğinde yeniden tetiklenir, tüm veri bir kerede çekilmez).
- [ ] Her iki görünüm de F0-T7 tema sistemiyle (light/dark) uyumlu render edilir.
