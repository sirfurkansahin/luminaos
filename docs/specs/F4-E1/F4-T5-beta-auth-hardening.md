# F4-T5 — Kapalı beta kimlik doğrulama sertleştirmesi

**Durum:** In Progress  
**Öncelik:** P0 — kullanıcı davetinden önce  
**Bağımlılıklar:** F4-T4, mevcut PostgreSQL ve Redis altyapısı

## Amaç

Kapalı beta oturum yüzeyini ek ücret veya sağlayıcı bağımlılığı oluşturmadan
kaba kuvvet saldırılarına ve izinsiz hesap oluşturmaya karşı sertleştirmek;
operatörün sunucu içinde güvenli biçimde beta hesabı oluşturabilmesini sağlamak.

## Kararlar

- Oran sınırı mevcut Redis üzerinde atomik sayaçlarla uygulanır; yeni servis
  veya paket alınmaz.
- Giriş denemeleri normalize edilmiş e-posta ve istemci IP'sinin SHA-256 özeti
  ile anahtarlanır; ham e-posta/IP Redis anahtarına veya loga yazılmaz.
- E-posta başına 15 dakikada 10, IP başına 15 dakikada 100 deneme kabul edilir.
  Başarılı giriş e-posta sayacını temizler; IP sayacı NAT arkasındaki kullanıcıları
  gereksiz kilitlememek için daha yüksek tutulur.
- Üretimde `POST /auth/register` kapalıdır. Geliştirme/test ortamındaki mevcut
  fixture akışı korunur.
- Beta hesabı yalnızca sunucuda çalışan, parolayı standart girdiden alan bir
  operatör komutuyla oluşturulur. Parola komut satırı argümanına veya loga girmez.
- Ters proxy yalnızca loopback kaynağından güvenilir; istemci IP'si doğrudan
  kullanıcı kontrollü `X-Forwarded-For` başlığından alınmaz.

## Kapsam

1. Redis tabanlı atomik giriş oran sınırlama servisi ve birim testleri.
2. Login controller bağlantısı: deneme öncesi kontrol, başarıda e-posta sayacı temizleme.
3. Üretimde herkese açık kayıt isteğinin reddedilmesi.
4. Loopback ters proxy güven ayarı.
5. `provision-beta-user` operatör komutu ve runbook.
6. Web arayüzünde 429 için genel, hesap varlığını sızdırmayan mesaj.

## Kabul kriterleri

- [ ] E-posta sınırını aşan istek, parola doğrulamasından önce HTTP 429 alır.
- [ ] IP sınırı e-posta değiştirerek aşılamaz.
- [ ] Sayaç artışı ve ilk süre sonu ataması tek atomik Redis işlemi içindedir.
- [ ] Başarılı giriş yalnızca ilgili e-posta sayacını temizler.
- [ ] Redis anahtarlarında ham e-posta veya IP bulunmaz.
- [ ] Üretimde kayıt API'si hesap oluşturmadan 403 döner.
- [ ] Test/geliştirmede mevcut kayıt fixture'ları çalışmaya devam eder.
- [ ] Provizyon komutu parolayı stdin'den alır, minimum/maksimum kurallarını uygular
      ve parola/özetini çıktılamaz.
- [ ] Birim, entegrasyon, typecheck, lint, build ve güvenlik kontrolleri geçer.

## Kapsam dışı

- Parola sıfırlama, e-posta doğrulama, SSO/OAuth ve davet e-postası gönderimi.
- CAPTCHA ve ücretli bot koruma servisleri.
- Genel API oran sınırlama altyapısı; bu görev yalnızca kimlik doğrulama yüzeyidir.

