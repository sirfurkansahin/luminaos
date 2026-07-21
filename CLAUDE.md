# LuminaOS — Proje Anayasası (CLAUDE.md)

Bu dosya her Claude Code oturumunda yüklüdür. Buradaki kurallar tartışmasızdır.

## Proje Özeti

LuminaOS: bağlam-öncelikli, ajan-destekli bir Work OS. Monorepo: `apps/` (desktop, web, mobile, server) + `packages/` (domain paketleri). Ayrıntılı harita: `docs/adr/ADR-0001.md`.

## Komutlar

- Kurulum: `pnpm install`
- Derleme: `pnpm build` · Tek paket: `pnpm --filter <paket> build`
- Test: `pnpm test` · Değişenler: `pnpm test --changed` · İzle: `pnpm --filter <paket> test:watch`
- Tip kontrolü: `pnpm typecheck` · Lint: `pnpm lint`
- Yerel ortam: `pnpm dev` (server + web), `pnpm dev:desktop`

## Çalışma Ritüeli (zorunlu sıra)

1. Görevin spec dosyası olmadan kod yazma: `docs/specs/<EPIK>/<GOREV>.md` önce oku.
2. Plan mode ile başla; keşfi `explorer` subagent'ına devret; planı insana onaylat.
3. TDD: önce `test-writer` ile başarısız test, sonra asgari uygulama.
4. Bitirmeden önce `security-reviewer` subagent'ını çağır.
5. Küçük, tek amaçlı commit'ler; PR ±400 satırı geçmez.

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

## Tanım of Done

- [ ] Kabul kriterlerinin tamamı testle kanıtlı (birim + gerekiyorsa entegrasyon)
- [ ] `pnpm typecheck && pnpm lint && pnpm test --changed` yeşil
- [ ] security-reviewer bulguları kapatıldı
- [ ] Public API değiştiyse `docs-writer` ile doküman güncellendi
- [ ] Spec dosyasına Done + PR linki işlendi

## Subagent ve Skill Rehberi

- Keşif → `explorer` · Tasarım/ADR → `architect` · Test → `test-writer` · Uygulama → `implementer` · Denetim → `security-reviewer` · Doküman → `docs-writer`
- Tekrarlanan prosedürler için skill'ler: `yeni-ozellik`, `yeni-lumina-object-tipi`, `mcp-baglayici`, `agent-skill-sdk`, `release` (`.claude/skills/`).

## Mimari Değişmezler

- Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir.
- Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar.
- Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz.
- Hassas veri sınıfları buluta ham gönderilmez (bkz. `docs/adr/ADR-000X-hibrit-ai.md`).
