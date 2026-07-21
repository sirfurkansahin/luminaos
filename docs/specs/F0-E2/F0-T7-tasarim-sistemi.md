# F0-T7 — Tasarım Sistemi v0 (packages/ui)

**Epik:** F0-E2 · **Durum:** Yapılacak
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

- [ ] 12 bileşen Ladle galerisinde görüntülenir; light/dark geçişi çalışır.
- [ ] Dialog ve DropdownMenu tam klavye ile kullanılabilir (Tab/Esc/ok tuşları — testle kanıtlı).
- [ ] apps/web yeni bileşenleri kullanır; hiçbir sayfada ham `<button>`/`<input>` kalmaz.
- [ ] Bileşen başına en az 1 davranış testi; paket kapsamı ≥ %85.
