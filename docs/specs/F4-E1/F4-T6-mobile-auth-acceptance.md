# F4-T6 — Mobil oturum ve çalışma alanı kabul testi

**Durum:** In Progress  
**Öncelik:** P0 — kapalı beta davetinden önce  
**Bağımlılıklar:** F4-T3, F4-T4, F4-T5

## Amaç

Mobil beta için en kritik gerçek kullanıcı yolunu ücretli cihaz laboratuvarı veya
yerel uygulama mağazası bağımlılığı eklemeden her CI çalışmasında doğrulamak.

## Kapsam

1. Pixel 5 profilinde 393 CSS piksel genişliğinde gerçek tarayıcı testi.
2. Gerçek API üzerinden kullanıcı ve çalışma alanı test verisi hazırlama.
3. Giriş formunun etiket, klavye sırası ve gönderim davranışı.
4. Oturum sonrasında doğru çalışma alanı ve kullanıcı bağlamının yüklenmesi.
5. Sayfa düzeyinde yatay taşma olmaması ve kritik kontrollerin en az 44 piksel olması.
6. Gelişmiş araçların varsayılan kapalı kalması ve çıkış akışı.

## Kabul kriterleri

- [x] Test gerçek Chromium tarayıcısında mobil cihaz profiliyle çalışır.
- [x] Giriş alanları ve düğmesi mantıksal Tab sırasındadır.
- [x] Başarılı giriş doğru kullanıcı ve çalışma alanını gösterir.
- [x] 393 piksel görünümde sayfa yatay taşmaz.
- [x] Görünüm sekmeleri ve çıkış düğmesi en az 44 piksel yüksekliktedir.
- [x] Gelişmiş araçlar varsayılan kapalıdır.
- [x] Çıkış kullanıcıyı tekrar giriş ekranına döndürür.
- [ ] E2E typecheck, lint ve Playwright paketi CI'da geçer.

## Yerel doğrulama

- E2E typecheck ve lint geçti.
- Pixel 5 profilli Chromium testi 3,6 saniyede geçti.

## Fiziksel cihaz kontrolü

Safari/iOS ve Chrome/Android kurulum istemleri emülasyonla güvenilir biçimde
kanıtlanamaz. Bu nedenle en az bir gerçek iPhone ve bir gerçek Android cihazda
PWA kurulum ve ana ekrandan açılış kontrolü beta davetinden önce manuel kabul
adımı olarak kalır.

## Kapsam dışı

- App Store veya Play Store paketi.
- Yerel push bildirimi ve çevrimdışı yazma.
- Ücretli bulut cihaz laboratuvarı.
