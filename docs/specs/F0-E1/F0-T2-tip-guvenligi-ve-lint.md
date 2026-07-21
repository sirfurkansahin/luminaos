# F0-T2 — Tip Güvenliği, Lint ve Biçimlendirme Standartları

**Epik:** F0-E1 · **Durum:** Tamamlandı
**Bağımlılık:** F0-T1 tamamlanmış olmalı

## Amaç

Tüm monorepo'da tek tip, katı (strict) TypeScript ve lint/format standardı kurmak; standartların commit anında otomatik uygulanmasını sağlamak.

## Kapsam

1. `tooling/tsconfig/` altında paylaşılan TS konfigleri: `base.json` (strict: true, noUncheckedIndexedAccess, exactOptionalPropertyTypes), `react.json`, `node.json`. Tüm paketler bunlardan extend eder.
2. `tooling/eslint/` altında paylaşılan ESLint konfigi:
   - `@typescript-eslint` önerilen + strict kural setleri,
   - `no-explicit-any: error`,
   - domain paketlerinde (`core-objects`, `context-fabric`, `memory`, `automation`) React/Nest import'unu yasaklayan `no-restricted-imports` kuralı,
   - import sıralama kuralı.
3. Prettier konfigi (kökte tek dosya) + ESLint ile çakışma çözümü.
4. Git hook'ları (husky + lint-staged): commit öncesi değişen dosyalarda `prettier` + `eslint --fix` + ilgili tip kontrolü.
5. Mevcut iskelet kodun tamamının yeni standartlara uyumlu hale getirilmesi.

## Kapsam DIŞI

- CI entegrasyonu (F0-T3).
- Claude Code hook'ları (F0-T4).

## Kabul Kriterleri

- [x] `pnpm typecheck` ve `pnpm lint` kökten tek komutla tüm workspace'te koşar ve yeşildir.
- [x] Bilerek eklenen bir `any` kullanımı `pnpm lint`'i kırar (test edilip geri alınır).
- [x] `packages/core-objects` içinde `import React` denemesi lint hatası üretir (test edilip geri alınır).
- [x] Biçimsiz bir dosya commit edilmeye çalışıldığında hook otomatik düzeltir veya engeller.

## Notlar

- Kural gevşetme yalnız ADR ile: herhangi bir `eslint-disable` satırı gerekçe yorumu taşımak zorundadır.

## Done

- Doğrulama: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` kökte hatasız (F0-T1'in kabul kriterleri regresyona uğramadı). Üç kabul kriteri elle test edilip geri alındı: `packages/shared`'a geçici `any` → `pnpm lint` kırmızı oldu (`@typescript-eslint/no-explicit-any`); `packages/core-objects`'e geçici `import React from 'react'` → `pnpm lint` çıktısında `no-restricted-imports` hatası üretti; biçimsiz bir test dosyası stage edilip commit denendiğinde husky pre-commit hook'u (`lint-staged`) `prettier --write` + `eslint --fix` ile otomatik düzeltti ve commit'i geçirdi (test commit'i sonradan `git reset --soft` ile geri alındı).
- Mimari not: `packages/ui`, `docs/PLAN.md`'de tasarım-sistemi (React) paketi olarak tanımlandığı için `react.json`'ı extend ediyor (henüz `.tsx` içermese de); `core-objects`/`shared`/`ai-gateway` framework'süz kalmaya devam ediyor, `base.json`'ı doğrudan extend ediyor.
- Sapma notu: `.claude/agents/*` (test-writer/security-reviewer vb.) henüz kurulu değil (F0-T4'te gelecek); kabul kriteri testleri ve güvenlik taraması bu oturumda ana oturumda elle uygulandı.
- Yerel commit'ler (remote/GitHub yok, bu yüzden PR linki yok):
  - `75619dd` chore: paylaşılan tsconfig üçlüsü (base/react/node)
  - `654eedb` feat: paylaşılan ESLint flat config + gerçek lint script'leri
  - `652cc67` chore: Prettier konfigi + repo genelini yeniden formatla
  - `5caa737` chore: husky + lint-staged pre-commit kancası
