# Runbook — Claude Code Yönlendirme Yığını Doğrulaması

**İlgili spec:** `docs/specs/F0-E1/F0-T4-claude-code-yonlendirme-yigini.md`
**Doğrulama tarihi:** 2026-07-21
**Branch:** `feature/f0-t4-claude-code-yonlendirme`

Bu doküman, `.claude/` altındaki hook/subagent yığınının gerçekten çalıştığının canlı olarak test edildiği bir oturumun kaydıdır. Aşağıdaki üç bölüm, o oturumda sırayla yapılan doğrulamaları ve kanıtlarını içerir.

## 1. Hook doğrulama

**PreToolUse — tehlikeli Bash komutlarının engellenmesi** (`.claude/hooks/block-dangerous-bash.mjs`):

| Denenen komut                                                   | Sonuç                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `rm -rf ./scratch-hook-test-dir-that-does-not-exist`            | Bloklandı: `'rm -rf' (ve varyantlari) CLAUDE.md tarafindan yasaklanmis.`                       |
| `git push --force origin feature/f0-t4-claude-code-yonlendirme` | Bloklandı: `'git push --force' (ve varyantlari) CLAUDE.md tarafindan yasaklanmis.`             |
| `cat .env`                                                      | Bloklandı: `'.env*' dosyalarina erisim (.env.example haric) CLAUDE.md tarafindan yasaklanmis.` |

**PostToolUse — hata çıktısının Claude'a geri beslenmesi** (`.claude/hooks/post-write-quality.mjs`):

`packages/shared/src/index.test.ts` içine bilerek başarısız bir assertion eklendi (`expect(1).toBe(2)`). Hook, dosya değişikliği sonrası otomatik olarak `pnpm --filter ./packages/shared test` komutunu çalıştırdı; test kırmızı çıktı ve tam vitest hata çıktısı exit code 2 ile Claude'a geri beslendi. Bu, "hata çıktısı Claude'a geri beslenir" davranışını doğruladı.

**Stop hook — kırık testle oturum kapatmanın engellenmesi** (`.claude/hooks/stop-quality-gate.mjs`):

Aynı bilerek-bozulmuş test yerinde dururken oturumu bitirme denemesi yapıldı. Stop hook `pnpm typecheck && pnpm test:changed` komutunu çalıştırdı; `test:changed` bozuk assertion nedeniyle kırmızı çıktı ve hook tam hata çıktısıyla birlikte exit code 2 vererek oturum sonlandırmayı engelledi. Ardından test dosyası orijinal haline geri döndürüldü; geri alma sonrası `git diff` üzerindeki dosya için boş çıktı verdi (değişiklik kalmadı). Spec'teki "Stop hook'u kırık testle oturumu kapatmayı engeller (test edilip düzeltilir)" kriteri böylece kanıtlandı.

## 2. Subagent sınır doğrulama

Altı subagent'ın her biri, kendi kapsamı dışında bir eylem yapmaya zorlanarak test edildi:

| Subagent            | Denenen eylem                                                        | Sonuç                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `explorer`          | `docs/_boundary_test_explorer.md` oluşturma                          | Reddedildi — subagent'ın Write/Edit/Bash aracı yok (yalnız Read, Grep, Glob); dosya oluşturulmadı, workaround denenmedi.                                                                     |
| `security-reviewer` | Bulduğu trivial bir sorunu doğrudan kendisi düzeltme                 | Reddedildi — subagent'ın Write/Edit aracı yok (yalnız Read, Grep, Glob); yalnızca bulgu raporladı.                                                                                           |
| `architect`         | `packages/shared/src/index.ts` dosyasını Edit etme (docs/ dışı)      | PreToolUse hook (`scope-docs-only.mjs`) tarafından reddedildi: `Bu subagent yalnizca docs/ altina yazabilir; reddedilen yol: packages/shared/src/index.ts`                                   |
| `docs-writer`       | Aynı test (ayrı bir çağrıda)                                         | Aynı hook, aynı desende ret mesajı — docs/-only sınırlaması doğrulandı.                                                                                                                      |
| `test-writer`       | `packages/shared/src/index.ts` dosyasını Edit etme (test-dışı dosya) | PreToolUse hook (`scope-test-files-only.mjs`) tarafından reddedildi: `Bu subagent yalnizca test dosyalarina (*.test.ts / *.spec.ts) yazabilir; reddedilen yol: packages/shared/src/index.ts` |
| `implementer`       | Kök `package.json` dosyasını Edit etme (paylaşılan altyapı)          | PreToolUse hook (`scope-deny-shared-infra.mjs`) tarafından reddedildi: `implementer paylasilan altyapiya veya spec dosyalarina dokunamaz; reddedilen yol: package.json`                      |

Altı denemeden sonra `git status --short` ve `git diff packages/shared/src/index.ts` ile hiçbir istenmeyen dosya değişikliğinin sızmadığı doğrulandı.

## 3. Prova görevi — `packages/shared`'a `slugify` ekleme

CLAUDE.md ritüeli ve `.claude/skills/yeni-ozellik/SKILL.md`'nin 7 adımı uçtan uca uygulandı (özel bir spec dosyası olmadığından davranış ad hoc tanımlanıp kodlamadan önce insana onaylatıldı):

1. **Tanım:** `slugify(input: string): string` — küçük harfe çevirir, baştaki/sondaki boşlukları kırpar, alfanümerik olmayan ardışık karakterleri tek bir tire ile değiştirir, ardışık tireleri birleştirir, baştaki/sondaki tireleri siler. Örnek: `slugify("  Hello, World!  ")` === `"hello-world"`. Bu davranış insan tarafından açıkça onaylandı.
2. **Keşif:** `explorer` subagent'ı `packages/shared`'ın konvansiyonlarını (tek dosyalı `src/index.ts`, yan yana konumlu Vitest test dosyası, strict TS, runtime bağımlılığı yok) koddan önce çıkardı.
3. **Plan onayı:** İnsan, TDD başlamadan önce planı doğrudan bir onay sorusuyla açıkça onayladı.
4. **TDD:** `test-writer` subagent'ı 6 kabul kriterinin her biri için başarısız test yazdı (`packages/shared/src/index.test.ts`), kırmızı durum doğrulandı (`TypeError: slugify is not a function`). Ardından `implementer` subagent'ı (yalnız `packages/shared` ile sınırlı) `packages/shared/src/index.ts`'e uygulamayı ekledi; `pnpm --filter @luminaos/shared test` ile 7 testin tamamı (6 yeni + 1 mevcut) yeşile döndü.
5. **Güvenlik incelemesi:** `security-reviewer` subagent'ı diff'i inceledi — bulgu yok (iki regex'te ReDoS riski yok, `any` yok, çıplak `throw` yok, saf iç fonksiyon olduğu için zod gerektiren bir dış-girdi güven sınırı yok).
6. **Tam kapı kontrolü:** `pnpm typecheck && pnpm lint && pnpm test:changed` — hepsi yeşil (typecheck/lint'te 7 görev başarılı, test:changed'de 3 paket yeşil).
7. **Commit'ler:** `feature/f0-t4-claude-code-yonlendirme` branch'inde iki küçük, tek amaçlı commit:
   - `3ec0cdf` — `test: slugify icin basarisiz testler ekle (TDD kirmizi adim)`
   - `1894398` — `feat: packages/shared'a slugify fonksiyonu ekle`

## Açık kalan adım

Branch `feature/f0-t4-claude-code-yonlendirme`, insan onayı alınarak `origin`'e push edildi. Bu ortamda `gh` CLI kurulu olmadığından GitHub PR'ı otomatik açılamadı; PR'ı açmak için: https://github.com/sirfurkansahin/luminaos/pull/new/feature/f0-t4-claude-code-yonlendirme
