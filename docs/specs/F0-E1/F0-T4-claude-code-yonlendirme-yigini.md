# F0-T4 — Claude Code Yönlendirme Yığınının Kurulumu

**Epik:** F0-E1 · **Durum:** Yapılacak
**Bağımlılık:** F0-T1 (repo mevcut olmalı); F0-T2 hook komutları için tercihen tamam

## Amaç

Claude Code'un bu projede disiplinli çalışmasını sağlayan `.claude/` yapılandırmasını (subagent'lar, skill'ler, hook'lar) kurmak ve örnek bir görevle uçtan uca prova etmek.

## Kapsam

1. **Subagent'lar** — `.claude/agents/` altında 6 Markdown dosyası (YAML frontmatter + görev tanımı):
   - `explorer.md`: salt-okunur keşif; çıktı olarak "ilgili dosya haritası + özet" döndürür.
   - `architect.md`: spec'ten teknik tasarım + ADR taslağı; yalnız `docs/` yazabilir.
   - `test-writer.md`: kabul kriterlerinden başarısız testler üretir; yalnız test dosyalarına yazar.
   - `implementer.md`: testleri geçirecek asgari kod; spec'te belirtilen paketle sınırlı.
   - `security-reviewer.md`: diff denetimi (girdi doğrulama, izin sızıntısı, PII log, injection); salt-okunur.
   - `docs-writer.md`: API doküman/changelog güncelleme; yalnız `docs/`.
2. **Skill'ler** — `.claude/skills/<ad>/SKILL.md` olarak 5 prosedür: `yeni-ozellik`, `yeni-lumina-object-tipi`, `mcp-baglayici`, `agent-skill-sdk`, `release`. Her biri: ne zaman tetiklenir + adım listesi + kontrol listesi. (İlk ikisi dolu içerik, son üçü Faz 2/3'te doldurulacak iskelet.)
3. **Hook'lar** — `.claude/settings.json`:
   - PostToolUse (Write|Edit): değişen dosyada `prettier` + `eslint --fix` + ilgili paket testleri; hata çıktısı Claude'a geri beslenir.
   - PreToolUse (Bash): `rm -rf`, `git push --force`, `.env*` okuma/yazma girişimlerini blokla.
   - Stop: `pnpm typecheck && pnpm test --changed` — kırıksa oturum "bitti" diyemez.
4. **Prova:** Küçük bir örnek görevle (ör. `packages/shared`'a `slugify` fonksiyonu ekleme) CLAUDE.md'deki ritüelin uçtan uca çalıştığının kanıtlanması; sonuç `docs/runbooks/claude-code-ritueli.md`'ye ekran akışıyla not edilir.

## Kapsam DIŞI

- Plugin paketleme ve ekip dağıtımı (Faz 1 sonunda).
- MCP sunucu bağlantıları (Faz 2).

## Kabul Kriterleri

- [ ] 6 subagent tanımlı; her biri kendi araç kısıtına uyar (yasak eylem denemesi reddedilir — test edilir).
- [ ] Hook'lar çalışır: bilerek biçimsiz yazılan dosya otomatik düzelir; `rm -rf` denemesi bloklanır.
- [ ] Stop hook'u kırık testle oturumu kapatmayı engeller (test edilip düzeltilir).
- [ ] Prova görevi ritüelin 7 adımını da geçerek PR ile tamamlanır.

## Notlar

- Subagent/skill dosyaları İngilizce yazılabilir (modelin en güçlü olduğu dil); insan yüzü Türkçe kalır.
- Bu görev tamamlandığında `CLAUDE.md`'nin "Subagent ve Skill Rehberi" bölümüyle birebir tutarlılık doğrulanır.
