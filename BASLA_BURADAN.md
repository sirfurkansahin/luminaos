# BAŞLA BURADAN — Bu Dosyalarla Ne Yapacaksın?

Elindeki her şeyin ne işe yaradığını ve sırayla ne yapacağını en basit haliyle anlatıyorum.

## Benzetme: İnşaat

- **docs/PLAN.md** → İnşaatın mimari projesi. Sen (patron) ve Claude Code (usta) için yol haritası. Kod değil, plan.
- **CLAUDE.md** → Şantiye kuralları panosu. Claude Code bu dosyayı **her açılışta otomatik okur** ve kurallara uyar. Senin bir şey yapmana gerek yok; sadece doğru yerde (proje klasörünün kökünde) durması yeterli.
- **docs/specs/ içindeki dosyalar** → İş emri fişleri. Her dosya = Claude Code'a vereceğin **tek bir görev**. Sen bunları teker teker "yap" diye vereceksin.

## Adım Adım Kurulum (bir kere yapılır)

1. **Node.js kur** (bilgisayarında yoksa): nodejs.org adresinden LTS sürümünü indir, kur.
2. **Claude Code'u kur:** Terminal'i aç (Mac: Terminal, Windows: PowerShell) ve şunu yaz:
   ```
   npm install -g @anthropic-ai/claude-code
   ```
3. **Proje klasörü oluştur:** Bilgisayarında `luminaos` adında boş bir klasör aç.
4. **Bu kitteki dosyaları o klasöre kopyala** (klasör yapısını bozmadan):
   ```
   luminaos/
   ├── CLAUDE.md
   ├── BASLA_BURADAN.md
   └── docs/
       ├── PLAN.md
       └── specs/F0-E1/  (4 görev dosyası)
   ```
5. **Claude Code'u başlat:** Terminal'de proje klasörüne gir ve `claude` yaz:
   ```
   cd luminaos
   claude
   ```
   İlk açılışta Anthropic hesabınla giriş yapmanı ister; ekrandaki adımları izle.

## Sonra Ne Olacak? (Her gün yapacağın şey)

Claude Code açıldığında ona **ilk görevi** ver. Şunu aynen yapıştır:

```
docs/specs/F0-E1/F0-T1-monorepo-kurulumu.md dosyasını oku.
Önce plan mode'da bir uygulama planı çıkar ve bana onaylat.
Onayladıktan sonra görevi CLAUDE.md'deki ritüele uyarak uygula.
Kapsam dışına çıkma.
```

Claude Code sana bir plan gösterecek → sen "onaylıyorum" diyeceksin → o kodu yazacak, test edecek, bitirecek. Görev bitince aynı şeyi **F0-T2**, sonra **F0-T3**, sonra **F0-T4** dosyası için tekrarlayacaksın.

F0-T4 bittiğinde sistem tam kurulmuş olur; ondan sonra PLAN.md'nin 6. bölümündeki Faz 1 görevlerine geçilir (o görevlerin spec dosyalarını sırası geldikçe yine benimle yazabilirsin).

## Senin Rolün Ne?

Kod yazmayacaksın. Üç şey yapacaksın:

1. **Görev vermek** (yukarıdaki kalıpla, sırayla).
2. **Planı onaylamak/reddetmek** (Claude plan gösterdiğinde okuyup "evet" veya "şunu değiştir" demek).
3. **Sonucu kontrol etmek** (görev sonunda "kabul kriterlerinin hepsini kanıtla" diye sormak — Claude test çıktılarını gösterir).

## Sık Sorulanlar

- **"CLAUDE.md'yi Claude'a vermem gerekiyor mu?"** Hayır. Klasörde durduğu sürece otomatik okunur.
- **"PLAN.md'yi vermem gerekiyor mu?"** Gerekmez ama ilk oturumda "docs/PLAN.md'yi oku, projeyi tanı" demek iyi bir başlangıçtır.
- **"Bir şey ters giderse?"** Claude Code'a "bu hatayı düzelt" de; ya da bu sohbete dön, birlikte çözelim.
- **"Sıra önemli mi?"** Evet: F0-T1 → T2 → T3 → T4. Her görev bir öncekinin üstüne kuruludur.
