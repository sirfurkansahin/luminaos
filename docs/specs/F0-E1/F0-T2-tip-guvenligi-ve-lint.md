# F0-T2 — Tip Güvenliği, Lint ve Biçimlendirme Standartları

**Epik:** F0-E1 · **Durum:** Yapılacak
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

- [ ] `pnpm typecheck` ve `pnpm lint` kökten tek komutla tüm workspace'te koşar ve yeşildir.
- [ ] Bilerek eklenen bir `any` kullanımı `pnpm lint`'i kırar (test edilip geri alınır).
- [ ] `packages/core-objects` içinde `import React` denemesi lint hatası üretir (test edilip geri alınır).
- [ ] Biçimsiz bir dosya commit edilmeye çalışıldığında hook otomatik düzeltir veya engeller.

## Notlar

- Kural gevşetme yalnız ADR ile: herhangi bir `eslint-disable` satırı gerekçe yorumu taşımak zorundadır.
