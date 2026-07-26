# F0-T7 — Tasarım Sistemi v0 (packages/ui)

**Epik:** F0-E2 · **Durum:** Tamamlandı
**Bağımlılık:** F0-T1..T4 (F0-T5/T6 ile paralel yürütülebilir)

## Amaç

Tüm arayüzün üzerine kurulacağı tutarlı, erişilebilir ve karanlık mod destekli temel bileşen kütüphanesini oluşturmak.

## Kapsam

1. **Tasarım token'ları:** renk paleti (light/dark), tipografi ölçeği, spacing, radius, gölge — CSS değişkenleri olarak; tema sağlayıcı bileşen.
2. **12 temel bileşen:** Button, Input, Textarea, Select, Checkbox, Dialog (modal), DropdownMenu, Tabs, Tooltip, Card, Badge, Toast. Her biri: klavye erişilebilirliği (WAI-ARIA), focus yönetimi, birim test.
3. **Bileşen galerisi:** Ladle (hafif Storybook alternatifi) ile her bileşenin canlı örnek sayfası; `pnpm ui:preview` ile açılır.
4. **apps/web entegrasyonu:** Mevcut "merhaba dünya" sayfası yeni bileşenlerle yeniden kurulur (tema değiştirici dahil).

## Kapsam DIŞI

- Karmaşık bileşenler (DataTable, DatePicker, Command Palette) — F1'de ihtiyaç anında.
- Marka/logo çalışması.

## Kabul Kriterleri

- [x] 12 bileşen Ladle galerisinde görüntülenir; light/dark geçişi çalışır.
- [x] Dialog ve DropdownMenu tam klavye ile kullanılabilir (Tab/Esc/ok tuşları — testle kanıtlı).
- [x] apps/web yeni bileşenleri kullanır; hiçbir sayfada ham `<button>`/`<input>` kalmaz.
- [x] Bileşen başına en az 1 davranış testi; paket kapsamı ≥ %85.

## Tamamlanma Notu

PR #5 (branch: `feature/f0-t7-tasarim-sistemi`) ile üç dilimde uygulandı: **PR-A** (eb190ca) tasarım token'ları + ThemeProvider + 5 temel bileşen; **PR-B** (74ff18d) Radix tabanlı 7 etkileşimli bileşen; **PR-C** (51bba75) Ladle galerisi + apps/web entegrasyonu. F1-T7'de Skeleton ve EmptyState bileşenleriyle genişletildi.
