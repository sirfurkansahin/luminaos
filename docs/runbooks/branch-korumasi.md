# Branch Koruması — `main`

Bu adımlar `.github/workflows/ci.yml`'in devreye girmesiyle **bir kez, elle** yapılır. GitHub, branch koruma kurallarını API/kod ile kurmayı da destekler, ama F0-T3 spec'i bunun elle yapılacak bir kurulum adımı olarak kalmasını istiyor — bu dosya yalnız adımları listeler.

## Adımlar (repo sahibi/admin tarafından)

1. GitHub'da repoya git → **Settings → Branches**.
2. **Branch protection rules → Add rule** (veya **Add branch ruleset**).
3. **Branch name pattern**: `main`.
4. Aşağıdaki seçenekleri işaretle:
   - **Require a pull request before merging**
     - **Require approvals**: `1`
   - **Require status checks to pass before merging**
     - **Require branches to be up to date before merging**
     - Zorunlu status check'ler olarak şu iş adlarını seç (workflow ilk kez bir PR'da koştuktan sonra listede görünürler): `quality`, `security`
   - **Do not allow bypassing the above settings** (repo admin'leri de dahil — istisna yok)
   - **Restrict who can push to matching branches** → kimseye doğrudan push izni verme (yalnız PR üzerinden birleştirme).
5. **Force pushes**: kapalı bırak (izin verme).
6. **Allow deletions**: kapalı bırak.
7. Kaydet.

## Doğrulama

- `main`'e doğrudan `git push` denemesi reddedilmeli ("protected branch" hatası).
- Status check'leri geçmeyen (CI kırmızı) bir PR'ın "Merge" butonu GitHub tarafından devre dışı bırakılmalı.
- 0 onaylı bir PR birleştirilememeli.

## İlgili

- CI workflow: `.github/workflows/ci.yml` (`quality`, `security`, `pr-size-guard` job'ları).
- Spec: `docs/specs/F0-E1/F0-T3-ci-boru-hatti.md`.
