# F4-T8 — Harici erişilebilirlik ve olay akışı

**Durum:** In Progress

**Öncelik:** P0 — kapalı beta davetinden önce

**Bağımlılıklar:** F4-T2, canlı HTTPS web/API

## Amaç

LuminaOS web ve API yüzeyini üretim makinesinin dışından, ek ücret ve
sağlayıcıya özgü çalışma zamanı bağımlılığı olmadan izlemek; kesintiyi tek bir
takip edilebilir olaya dönüştürmek ve hizmet iyileştiğinde olayı kapatmak.

## Karar

- Taşınabilir bir Node betiği web kabuğunu ve `/api/health` yanıtını doğrular.
- GitHub Actions betiği 15 dakikada bir ve elle çalıştırır. Zamanlayıcı daha
  sonra herhangi bir cron/CI sağlayıcısına aynı komutla taşınabilir.
- Başarısızlıkta sabit başlıklı tek bir GitHub issue açılır veya yeniden açılır;
  tekrar eden kontroller yeni issue üretmez.
- İyileşmede açık olay kapanır ve iyileşme zamanı kaydedilir.
- GitHub Actions ve Issues ücretsiz sınırları dışında ücretli servis, SDK,
  telemetri veya yeni üretim sırrı eklenmez.
- Olay sahibi kapalı beta boyunca depo sahibidir. E-posta bildirimi GitHub
  kullanıcısının standart bildirim ayarından gelir.

## Kapsam dışı

- Tarayıcı ve sunucu istisnalarının harici bir hata izleme ürününe gönderilmesi.
- SLA garantisi veya gerçek zamanlı/saniyelik alarm.
- Yedek içeriğinin ya da üretim sırlarının GitHub'a aktarılması.

## Kabul kriterleri

- [ ] Geçersiz veya HTTPS olmayan hedef çalıştırılmadan reddedilir.
- [ ] Web kontrolü HTTP 200 ve uygulama kökünü doğrular.
- [ ] API kontrolü HTTP 200 ile birlikte `status`, `db` ve `redis` alanlarını
      doğrular.
- [ ] Her istek sınırlı bir zaman aşımıyla çalışır ve hassas yanıt gövdesini
      loglamaz.
- [ ] Zamanlanmış ve elle çalıştırılabilir iş akışı en az yetkiyle çalışır.
- [ ] Arızada tek olay açılır/yeniden açılır; iyileşmede açık olay kapanır.
- [ ] Betik birim testleri ve gerçek canlı hedef doğrulaması geçer.

## Maliyet, etki ve risk

| Ölçüt      | Değerlendirme                                                         |
| ---------- | --------------------------------------------------------------------- |
| Etki       | Yüksek — VM/TLS/web/API kesintisi kullanıcıdan önce görünür olur.     |
| Çaba       | Düşük — mevcut GitHub ve standart Node çalışma zamanı kullanılır.     |
| Risk       | Orta — zamanlanmış GitHub işleri gecikebilir; beta için kabul edilir. |
| Maliyet    | Sıfır — yeni ücretli hesap veya altyapı yoktur.                       |
| Kilitlenme | Düşük — asıl probe betiği GitHub API'sinden bağımsızdır.              |
