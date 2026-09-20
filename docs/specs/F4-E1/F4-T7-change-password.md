# F4-T7 — Uygulama içinden parola değiştirme

**Durum:** Done  
**Öncelik:** P0 — kapalı beta hesabı tesliminden hemen sonra  
**Bağımlılıklar:** F4-T4, F4-T5  
**Pull request:** [#280](https://github.com/sirfurkansahin/luminaos/pull/280)

## Amaç

Beta kullanıcısının sunucu operatörüne veya ücretli kimlik sağlayıcısına
bağımlı olmadan başlangıç parolasını güvenli biçimde değiştirebilmesini sağlamak.

## Güvenlik kararları

- Uç nokta etkin ve süresi dolmamış oturum gerektirir.
- Mevcut parola Argon2id ile doğrulanmadan yeni parola yazılmaz.
- Yeni parola 12–200 karakterdir ve mevcut paroladan farklı olmalıdır.
- Başarılı değişiklik bütün eski oturumları iptal eder ve yalnızca isteği yapan
  cihaza yeni bir oturum çerezi verir.
- İstekler mevcut e-posta/IP tabanlı Redis hız sınırından geçirilir.
- Parolalar URL'ye, loga, istemci depolamasına veya yanıta yazılmaz.
- Yeni ücretli servis, paket veya sağlayıcı bağımlılığı eklenmez.

## Kabul kriterleri

- [x] Oturumsuz istek HTTP 401 alır.
- [x] Hatalı mevcut parola değişiklik yapmadan HTTP 401 alır.
- [x] Kısa, aynı veya fazladan alan içeren istek HTTP 400 alır.
- [x] Başarılı değişiklikten sonra eski parola ile giriş başarısız olur.
- [x] Kullanıcının bütün eski oturumları iptal edilir; yeni oturum çalışır.
- [x] Mobil uyumlu form mevcut, yeni ve tekrar parola alanlarını içerir.
- [x] İstemci eşleşmeyen yeni parolaları sunucuya göndermez.
- [x] Birim, entegrasyon, web, typecheck, lint, build ve güvenlik kontrolleri geçer.

## Yerel doğrulama

- Sunucu: 67 dosya / 660 test geçti.
- Web: 100 dosya / 1007 test geçti.
- Gerçek PostgreSQL ve Redis ile parola değiştirme entegrasyonu: 2/2 geçti.
- Pixel 5 Chromium akışı: parola değiştir, çıkış yap, yeni parola ile giriş yap geçti.
- Sunucu, web ve E2E typecheck/lint; sunucu ve web üretim derlemeleri geçti.

## Canlı doğrulama

- API sağlık kontrolü HTTP 200 döndürdü.
- Web uygulaması HTTP 200 döndürdü ve yeni parola güvenliği arayüzü canlı
  JavaScript paketinde doğrulandı.
- Oturumsuz `POST /api/auth/change-password` isteği HTTP 401 döndürdü.
- Kullanıcının gerçek parolası yayın doğrulaması sırasında değiştirilmedi.
- PR #280 üzerindeki yedi zorunlu CI kontrolünün tamamı geçti.
