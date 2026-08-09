# F1-T16 — Konuşma Komutları v1: Çok Adımlı Aksiyonlar + Onay Kartı

**Epik:** F1-E4 (AI Servisi v1 + Veri Çıkışı) · **Durum:** Yapılacak
**Bağımlılık:** F1-T14 (`AIProvider.complete()` + model yönlendirme + `AIUsageService`, ADR-0008), F1-T15 (RAG/QA deseni — `QAService`/`answerQuestion`, ADR-0014), F1-T1 (nesne çekirdeği — `createObject`), F1-T2 (Custom Fields — `people` alanı), F1-T3 (ilişki sistemi — `parentChild`, döngü reddi), F1-T10 (görev deneyimi — mevcut alan/komut desenleri), F0-T5 (RBAC), F0-T6 (event store — `Actor` zarfı)

## Amaç

PLAN.md (satır 229) bu görevi "konuşma komutları v1: 'görev aç, alt görev üret, atama yap' tarzı çok adımlı aksiyonlar — her aksiyon onay kartıyla" olarak tanımlıyor. Kullanıcı doğal dilde bir komut verir ("şunun için 3 alt görev üret", "bunu Ayşe'ye ata" gibi); sistem bunu sabit, kapalı bir aksiyon-tipi kümesinden (v1: görev oluşturma, alt görev üretme, kişi atama) sıralı bir öneri listesine ayrıştırır ve HİÇBİRİNİ kullanıcı onaylamadan yürütmez. F1-T15 (QA) salt-okunur bir özellikti; F1-T16, `ai-gateway` çıktısının ilk kez GERÇEK STATE MUTASYONUNA yol açtığı görevdir — onay kartı adımı bu yüzden mimari olarak zorunlu, kozmetik değil.

## Mevcut Durum (keşif — koddan doğrulandı)

- `packages/shared/src/events/domain-event.ts` (`actorSchema`): event zarfı yalnızca `{type: 'user'|'agent'|'system', id}` taşıyor. Kodun kendi yorumu AÇIKÇA şunu söylüyor: **CLAUDE.md'nin "Mimari Değişmezler"deki zengin ajan-aksiyon sözleşmesi (`{niyet, gerekçe, kaynaklar[], geri_alma_planı}`) BİLİNÇLİ OLARAK Faz 3'e ertelenmiş ve bu zarfın parçası DEĞİL.** Bu, F1-T16'nın karşılaştığı MERKEZİ gerilim: görev tam olarak "ajan bir aksiyon önerir, insan onaylar" özelliği, ama event-store'un `actor` zarfı bu sözleşimi henüz hiçbir şekilde taşımıyor (bkz. Açık Sorular).
- `apps/server/src/objects/objects.controller.ts` (`POST /workspaces/:workspaceId/objects`, `createObjectSchema`): görev/nesne oluşturmak için mevcut, çalışan bir uç nokta zaten var — F1-T16 yeni bir "nesne oluşturma" mekanizması İCAT ETMEZ.
- `packages/core-objects/src/relations/` (`RelationKind = 'parentChild' | ...`, `relation-commands.ts`, `relation-graph.ts`): ebeveyn-çocuk ilişkisi VE döngü-reddi (cycle prevention) F1-T3'ten beri var ve kanıtlanmış. "Alt görev üret" bu ilişkiyi AYNEN kullanır.
- `packages/core-objects/src/fields/field-type-registry.ts`: `'people'` alan tipi zaten var (`z.array(z.string().min(1))`, boş config, F1-T2'den beri) — "atama yap" bu alanın `setFieldValues` çağrısı üzerinden çalışır, F1-T10'un `status`/`priority` deseniyle birebir aynı disiplin (yeni bir atama mekanizması icat edilmez).
- F1-T15'in `QAService`/`answerQuestion`'ı: doğal dil girdisini işleyip bir cevap üreten desen zaten var, ama SALT-OKUNUR (retrieval + completion, hiçbir yazma yok). F1-T16 bu deseni MUTASYON üreten bir bağlama taşıyan ilk görev.
- ADR-0014 (F1-T15): `AIUsageService` (kilit/kota/kullanım-kaydı) `ObjectsService`'ten paylaşılan, enjekte edilebilir bir servise çıkarıldı — tam olarak bu tür yeni completion-çağıran özellikler için. F1-T16'nın komut-ayrıştırma çağrısı da bu servisi kullanmalı, yeni bir kota mekanizması icat edilmez.
- `selectAIModel` bugün `'select'`/`'text'`/`'qa'` `outputType`'larını biliyor (F1-T14/F1-T15) — komut ayrıştırma yeni bir görev tipi olarak eklenecek.
- **Yapılandırılmış çıktı boşluğu:** `AIProvider.complete()` (ADR-0008) yalnızca serbest-metin `{text, usage}` döndürüyor — JSON/tool-use gibi yapılandırılmış bir çıktı sözleşmesi YOK. Doğal dili "N adet aksiyon nesnesi"ne güvenilir şekilde çevirmek için ya (a) prompt'ta JSON istenip çıktı çalışma-zamanında zod ile doğrulanacak (mevcut sözleşmeyle uyumlu, halüsinasyon/bozuk-JSON riskine karşı doğrulama gerektirir) ya da (b) `AIProvider`'a yeni bir yapılandırılmış-çıktı modu eklenecek (ADR-0008'in sözleşimini genişletir).

## Kapsam

1. **Komut ayrıştırma:** Doğal dil girdisi → sıralı, sabit/kapalı bir aksiyon-tipi kümesinden (v1: `createTask`, `generateSubtasks`, `assignPeople`) öneri listesi. Tasarım kararı (plan aşamasında netleşir — bkz. Açık Sorular): JSON-prompt+zod-doğrulama mı, yoksa `AIProvider`'a yeni bir yapılandırılmış-çıktı sözleşmesi mi.
2. **Onay kartı sözleşmesi:** Her önerilen aksiyon, yürütülmeden ÖNCE kullanıcıya sunulan bir "kart" olarak temsil edilir — CLAUDE.md'nin `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesiyle hizalanan alanlar (aksiyon tipi/niyet, gerekçe metni, etkilenecek kaynak nesne(ler), geri-alınabilirlik notu). Tasarım kararı (plan aşamasında netleşir, GÜÇLÜ ADR adayı — bkz. Açık Sorular): bu sözleşim event-store seviyesinde mi (kısmen) modellenir, yoksa yalnızca API/UI-seviyesinde ayrı bir "proposed action" DTO'su olarak mı kalır.
3. **Yürütme:** Kullanıcı onayladıktan SONRA, her aksiyon MEVCUT komut/servis çağrılarına (`createObject`, `parentChild` ilişkisi, `people` alanı `setFieldValues`) birebir delege edilir — yeni bir mutasyon mekanizması icat edilmez, yalnızca AI-önerili bir orkestrasyon katmanı eklenir.
4. **Aksiyon-bazlı kısmi onay:** Kullanıcı bir öneri listesindeki herhangi bir alt kümeyi onaylayıp reddedebilir (PLAN.md'nin "HER aksiyon onay kartıyla" ifadesi tekil aksiyon-seviyesinde onay istiyor, toplu-onay değil).
5. **Maliyet/kota:** Komut-ayrıştırma completion çağrısı `AIUsageService` (ADR-0014) ile ölçülür ve kotalanır — yeni bir mekanizma icat edilmez.
6. **API:** Muhtemelen iki-aşamalı (`.../commands/parse` → öneri listesi, hiçbir mutasyon yapmaz; `.../commands/execute` → onaylanan aksiyon(lar), gerçek mutasyon) — tasarım kararı, plan aşamasında netleşir.

## Kapsam DIŞI

- Ajan-aksiyon sözleşiminin (`{niyet, gerekçe, kaynaklar[], geri_alma_planı}`) event-store seviyesinde, TÜM gelecekteki ajan-özelliklerine (Faz 2/3 otomasyon motoru dahil) genellenebilir TAM bir modelini kurmak — CLAUDE.md'nin kendi notu bunu Faz 3'e erteliyor; F1-T16 yalnızca KENDİ v1 ihtiyacı için gerekeni uygular.
- Gerçek geri-alma (undo) YÜRÜTMESİ — yalnızca "geri alınabilir mi" bilgisinin onay kartında gösterilmesi bu görevin kapsamında, gerçek bir undo-komutu çalıştırmak değil (ayrı görev).
- RAG/soru-cevap (F1-T15'in kendi kapsamı; bu görev yalnızca state-mutasyonlu aksiyonları kapsar).
- Streaming, çok turlu konuşma bağlamı (F1-T15'in kendi kapsam-dışı maddesiyle aynı).
- Eval/regresyon golden-set (F1-T17'nin kapsamı).
- Genişletilebilir aksiyon-tipi/plugin sistemi — v1 sabit, kapalı 3 aksiyon tipiyle sınırlı.

## Açık Sorular (Plan Aşamasında Netleşecek)

- **[KRİTİK]** CLAUDE.md'nin ajan-aksiyon sözleşmesi `domain-event.ts`'nin kendi yorumunda AÇIKÇA Faz 3'e ertelenmiş. F1-T16 bu sözleşimi ŞİMDİ (kısmen) mi uygular, yoksa onay kartını yalnızca API/UI-seviyesinde mi (event zarfına dokunmadan) modeller? Bu CLAUDE.md'nin 1. ADR kriterine ("Mimari Değişmezler'den birine dokunuyor veya onunla gerilim yaratıyor") doğrudan giriyor — güçlü bir ADR adayı, insan onayı gerektirir.
- Yapılandırılmış aksiyon çıktısı: JSON-prompt+zod-doğrulama (ADR-0008'in sözleşimine dokunmaz) mı, yoksa `AIProvider`'a yeni bir yapılandırılmış-çıktı/tool-use modu (ADR-0008'i genişletir, muhtemelen kendi ADR'ini gerektirir) mi?
- Onay/yürütme API'si iki-aşamalı mı (önerilen aksiyonlar nerede/nasıl geçici olarak tutulur — DB'de "pending action" satırı mı, yoksa istemci tüm payload'ı geri mi gönderiyor) yoksa tek istekte mi (onay yalnızca istemci-tarafı UI'da, denetlenebilirlik/audit-trail kaybı riski) olacak?
- "Atama yap" yalnızca workspace üyeleriyle mi sınırlı (F0-T5 RBAC mirası) — atama hedefi doğrulaması nerede yapılır?

## Kabul Kriterleri

- [ ] Doğal dil komutu, sabit/kapalı aksiyon-tipi kümesinden (`createTask`/`generateSubtasks`/`assignPeople`) doğru ayrıştırılmış bir öneri listesine dönüşür (testli, `MockProvider` ile deterministik).
- [ ] Hiçbir aksiyon, kullanıcı o SPESİFİK aksiyonu onaylamadan yürütülmez; kısmi onay (listedeki bazı aksiyonları kabul, bazılarını red) doğru çalışır (testli).
- [ ] Onaylanan her aksiyon MEVCUT komut/servis çağrılarına (`createObject`/`parentChild` ilişkisi/`people` alanı `setFieldValues`) birebir delege edilir; yeni bir mutasyon yolu icat edilmediği ve mevcut RBAC/doğrulama kurallarının (F0-T5, F1-T2/T3) korunduğu testli.
- [ ] Komut-ayrıştırma completion çağrısı `aiUsageRecords`'a kaydedilir ve mevcut $ bütçe/token kotasına (`AIUsageService`, ADR-0014) tabidir; regresyonsuz (testli).
- [ ] security-reviewer: (a) prompt/komut metni/ayrıştırılan aksiyon içeriğinin hiçbir yerde loglanmadığı (ADR-0008 disiplini), (b) yürütme aşamasının yalnızca kullanıcının ZATEN sahip olduğu izinlerle çalıştığı, RBAC'ı aşan bir "ajan-yetkisi" olmadığı doğrulanır.
