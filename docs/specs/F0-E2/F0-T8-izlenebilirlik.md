# F0-T8 — İzlenebilirlik (Log, Trace, Hata Takibi)

**Epik:** F0-E2 · **Durum:** Tamamlandı
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

- [x] Bir API isteğinin logları tek `requestId` ile uçtan uca takip edilebilir (testle kanıtlı).
- [x] Log çıktısında e-posta/şifre/token asla düz görünmez (bilerek loglanmaya çalışılır, maskelendiği kanıtlanır).
- [x] Bilerek fırlatılan hata: server'da 500 + yapılandırılmış log; web'de ErrorBoundary ekranı.
- [x] `/health` DB kapalıyken `degraded` döner (Testcontainers ile kanıtlı).

## Tamamlanma Notu

PR #6 (branch: `feature/f0-t8-izlenebilirlik`) ile üç dilimde uygulandı: **PR-A** (72295ee) pino yapılandırılmış log + requestId + PII maskeleme; **PR-B** (4ceb786) OpenTelemetry elle span'ler (HTTP + DB izleri); **PR-C** (e03da58) Redis + genişletilmiş `/health` + web ErrorBoundary.
