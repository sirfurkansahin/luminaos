# LuminaOS — Proje Anayasası (CLAUDE.md)

Bu dosya her Claude Code oturumunda yüklüdür. Buradaki kurallar tartışmasızdır.

## Proje Özeti

LuminaOS: bağlam-öncelikli, ajan-destekli bir Work OS. Monorepo: `apps/` (desktop, web, mobile, server) + `packages/` (domain paketleri). Ayrıntılı harita: `docs/adr/ADR-0001.md`.

## Komutlar

- Kurulum: `pnpm install`
- Derleme: `pnpm build` · Tek paket: `pnpm --filter <paket> build`
- Test: `pnpm test` · Değişenler: `pnpm test:changed` · İzle: `pnpm --filter <paket> test:watch`
- Tip kontrolü: `pnpm typecheck` · Lint: `pnpm lint`
- Yerel ortam: `pnpm dev` (server + web), `pnpm dev:desktop`

## Çalışma Ritüeli (zorunlu sıra)

1. Görevin spec dosyası olmadan kod yazma: `docs/specs/<EPIK>/<GOREV>.md` önce oku.
2. Plan mode ile başla; keşfi `explorer` subagent'ına devret; planı insana onaylat. Plan birden fazla alt-PR tanımlıyorsa (ör. PR1/PR2/PR3), bu tek onay tüm alt-PR'ları kapsar — her alt-PR'a geçişte planından sapma yoksa tekrar "proceed?" onayı istenmez, doğrudan devam edilir. Yalnızca onaylanan plandan sapma gerekirse (kapsam değişikliği, yeni bağımlılık, mimari karar) insana tekrar sorulur.
3. TDD: önce `test-writer` ile başarısız test, sonra asgari uygulama.
4. Bitirmeden önce `security-reviewer` subagent'ını çağır.
5. Küçük, tek amaçlı commit'ler; PR boyutu görev tipine göre değişir (bkz. "PR Boyutu").
6. PR'ı `gh pr create` ile kendin aç; CI yeşil olunca `gh pr merge --squash` ile kendin birleştir. İnsanı beklemeye gerek yok — tarayıcıya gidip tıklama adımı kalktı. CI kırmızıysa asla merge etme, bulguyu insana bildir.

## PR Boyutu

Gerçek kalite güvencesi PR satır sayısından değil, test-writer → implementer → security-reviewer ritüelinden gelir. Buna göre:

- Mimari-kritik görevler (spec'te işaretli veya ADR gerektiren): ±400 satır — insan gözden geçirmesi hâlâ ince taneli olmalı.
- Mekanik/tekrarlı görevler (test iskeleti, CRUD, taşıma, dokümantasyon): ±600-800 satır'a kadar kabul edilir.
- Sınırı zorlayan her PR, tek amaçlı ve tek commit mesajıyla açıklanabilir olmalı; birden fazla amaç varsa böl.

## ADR Ne Zaman Gerekir

Her yeni kütüphane/paket kararı ADR değildir — ADR ritüeli (architect taslağı + insan onayı, koddan önce) yalnızca şu durumlarda zorunludur:

- Karar "Mimari Değişmezler"den birine dokunuyor veya onunla gerilim yaratıyorsa (ör. F1-T11'in CRDT'si event-sourcing değişmeziyle çakışıyor).
- Karar birden fazla pakete veya gelecekteki görevlere dayatılan bir sözleşim tanımlıyorsa (veri şekli, event tipi, API kontratı — ör. F1-T6'nın sorgu DSL'i, F1-T5'in ai-gateway soyutlaması).

Salt görünüm-katmanı kütüphane seçimleri (`apps/web`/`packages/ui` içinde kalan, kolayca değiştirilebilir seçimler — sanallaştırma, sürükle-bırak, state yönetimi vb.) ADR gerektirmez; plan dosyasında kısaca gerekçelendirilip doğrudan implementer'a geçilir.

## Kodlama Sözleşmeleri

- TypeScript strict; `any` yasak (kaçınılmazsa `unknown` + tip daraltma).
- Tüm dış girdiler zod ile doğrulanır (API, MCP, webhook, form).
- Hatalar `packages/shared/errors` sınıflarıyla fırlatılır; çıplak `throw new Error` yasak.
- AI çağrıları yalnızca `packages/ai-gateway` üzerinden; sağlayıcı SDK'sını doğrudan import etme.
- Domain paketleri (`core-objects`, `context-fabric`, `memory`, `automation`) framework import edemez (React/Nest yasak) — saf TypeScript kalır.
- Olay adları geçmiş zaman: `TaskCompleted`, `FieldValueChanged`. Olaylar değişmezdir (immutable); düzeltme = yeni olay.
- UI metinleri i18n kataloğundan gelir; koda gömülü kullanıcı metni yasak.

## Asla Yapma

- Migration'ı down script'i olmadan yazma.
- Kullanıcı verisini veya API anahtarını log'a yazma.
- `main`'e doğrudan push; `--force` push; `rm -rf` (hook zaten bloklar).
- Testleri geçirmek için testi zayıflatma; kırık testi skip'leme.
- Spec'te olmayan kapsamı "hazır olmuşken" ekleme — öner, ama ekleme.
- CI kırmızıyken `gh pr merge` çalıştırma.

## Tanım of Done

- [ ] Kabul kriterlerinin tamamı testle kanıtlı (birim + gerekiyorsa entegrasyon)
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil
- [ ] security-reviewer bulguları kapatıldı
- [ ] Public API değiştiyse `docs-writer` ile doküman güncellendi
- [ ] Spec dosyasına Done + PR linki işlendi
- [ ] Bir görev/PR tamamlandığında, özetin en altına PLAN.md sırasına göre sıradaki görevin spec dosyasını referans alan, doğrudan kopyala-yapıştır çalıştırılabilecek hazır bir "Sıradaki adım:" komutu eklenir. Bu, kullanıcının sıradaki adımı sormak için ayrı bir yere (başka bir Claude oturumuna) gitmesini gereksiz kılar — bir sonraki spec dosyası biliniyorsa bu adım asla atlanmaz.

## Subagent ve Skill Rehberi

- Keşif → `explorer` · Tasarım/ADR → `architect` · Test → `test-writer` · Uygulama → `implementer` · Denetim → `security-reviewer` · Doküman → `docs-writer`
- Tekrarlanan prosedürler için skill'ler: `yeni-ozellik`, `yeni-lumina-object-tipi`, `mcp-baglayici`, `agent-skill-sdk`, `release` (`.claude/skills/`).
- Subagent'lar ana oturuma yalnızca damıtılmış sonuç döner: "bulgu var/yok + 1-2 cümle özet". Tam dosya diff'i veya log dökümü ana oturuma taşınmaz — gerekirse insan ayrıca ister.

## Özetleme Disiplini (token tasarrufu — kaliteden ödün vermeden)

- Oturum/görev sonu özeti kısa olur: "N dosya değişti, M test geçti/kaldı, kalan elle-adım: X" formatında tek paragraf. PR açıklamasını, commit listesini veya dosya içeriklerini özet içinde tekrar yazma — bunlar zaten GitHub'da ve diff'te duruyor.
- Başarılı adımların ayrıntılı çıktısı (test logu, lint çıktısı) ana oturuma basılmaz; yalnızca başarısızlıkta tam çıktı gösterilir (hook'lar zaten bu şekilde: `post-write-quality.mjs`, `stop-quality-gate.mjs`).
- İnsana durum aktarırken (ör. `durum-kontrol` çıktısı) yalnızca aktif branch/görev/son commit/bekleyen değişiklik yeterlidir; tamamlanmış görev listesinin tamamı yalnızca açıkça istenince verilir.

## Mimari Değişmezler

- Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir.
- Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar.
- Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz.
- Hassas veri sınıfları buluta ham gönderilmez (bkz. `docs/adr/ADR-000X-hibrit-ai.md`).
