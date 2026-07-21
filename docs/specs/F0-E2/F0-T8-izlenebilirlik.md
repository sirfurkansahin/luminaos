# F0-T8 — İzlenebilirlik (Log, Trace, Hata Takibi)

**Epik:** F0-E2 · **Durum:** Yapılacak
**Bağımlılık:** F0-T5

## Amaç

Sistemde ne olup bittiğinin her zaman görülebilmesini sağlamak: yapılandırılmış loglar, istek izleri ve yakalanmamış hataların raporlanması.

## Kapsam

1. **Yapılandırılmış log:** pino ile JSON log; her istekte `requestId` üretimi ve tüm loglara otomatik eklenmesi; log seviyeleri env ile ayarlanır.
2. **PII maskeleme:** e-posta, şifre, token alanlarını otomatik maskeleyen redaction katmanı (CLAUDE.md kuralı: kullanıcı verisi loglanmaz).
3. **OpenTelemetry:** apps/server'da HTTP + DB sorgu izleri; yerel geliştirmede konsol exporter, üretim için OTLP exporter konfigürasyonu.
4. **Hata yakalama:** Global hata işleyici (server) + React ErrorBoundary (web); yakalanmamış hatalar log'a `error` seviyesinde requestId ile düşer.
5. **Sağlık uçları:** `/health` genişletilir: DB + Redis bağlantı kontrolü, sürüm bilgisi.

## Kapsam DIŞI

- Harici APM/hata servisi entegrasyonu (Sentry vb.) — exporter soyutlaması yeter.
- Metrik panoları (Grafana vb.).

## Kabul Kriterleri

- [ ] Bir API isteğinin logları tek `requestId` ile uçtan uca takip edilebilir (testle kanıtlı).
- [ ] Log çıktısında e-posta/şifre/token asla düz görünmez (bilerek loglanmaya çalışılır, maskelendiği kanıtlanır).
- [ ] Bilerek fırlatılan hata: server'da 500 + yapılandırılmış log; web'de ErrorBoundary ekranı.
- [ ] `/health` DB kapalıyken `degraded` döner (Testcontainers ile kanıtlı).
