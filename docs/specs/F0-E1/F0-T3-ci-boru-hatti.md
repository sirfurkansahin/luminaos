# F0-T3 — CI Boru Hattı (GitHub Actions)

**Epik:** F0-E1 · **Durum:** Tamamlandı
**Bağımlılık:** F0-T1, F0-T2

## Amaç

Her PR'da kalite kapılarını otomatik çalıştıran, kırmızıyken birleştirmeye izin vermeyen CI kurmak.

## Kapsam

1. `.github/workflows/ci.yml`:
   - Tetikleyici: PR ve `main`'e push.
   - Aşamalar (sırayla): install (önbellekli) → lint → typecheck → test (kapsam raporlu) → build.
   - Turborepo uzak önbelleği veya actions cache ile hızlandırma; yalnız etkilenen paketleri koşma.
2. Güvenlik aşaması: gizli anahtar taraması (gitleaks) + `pnpm audit` (kritik bulguda kır).
3. Kapsam eşiği: Vitest coverage raporu; `packages/*` için satır kapsamı < %85 ise iş kırılır (Faz 1'de domain paketleri %95'e çekilecek — konfig parametrik olsun).
4. PR boyut bekçisi: diff ±400 satırı aşarsa uyarı yorumu ekleyen hafif bir adım.
5. Branch koruması dokümantasyonu: `docs/runbooks/branch-korumasi.md` (main'e doğrudan push kapalı, CI zorunlu, 1 onay zorunlu — repo ayarlarından elle yapılacak adımlar listelenir).

## Kapsam DIŞI

- Dağıtım/CD (Faz 1 sonunda ayrı görev).
- E2E testleri (Playwright altyapısı Faz 1'de).

## Kabul Kriterleri

- [x] Örnek bir PR açıldığında tüm aşamalar koşar ve yeşil biter.
- [x] Bilerek kırık bir test içeren PR'da CI kırmızı olur (test edilip geri alınır).
- [x] Gizli anahtar içeren bir commit denemesi güvenlik aşamasında yakalanır (sahte anahtarla test edilir).
- [x] CI toplam süresi (önbellek sıcakken) < 5 dakika.

## Notlar

- Tüm workflow adımları sürüm sabitlemeli (action'lar SHA ile pinlenir).

## Tamamlanma Notu

PR #1 (branch: `feature/f0-t3-ci-pipeline`, commit 87d3fca) ile uygulandı: `.github/workflows/ci.yml` — `quality` (lint→typecheck→test→build), `security` (gitleaks + `pnpm audit --audit-level critical`), `pr-size-guard` (satır-sayısı uyarı yorumu) job'ları. Sonradan `pr-size-guard` eşiği CLAUDE.md'nin PR Boyutu güncellemesiyle uyumlu şekilde 400→800'e çekildi (chore/pr-size-esigi-guncelle, PR #14).
