#!/usr/bin/env node
// F1-T17 PR3 — AI eval golden-set CI regresyon kapısı için özet üretici.
// Vitest'in JSON reporter çıktısını okur, dosya-başına geçti/kaldı tablosunu
// hem konsola hem de $GITHUB_STEP_SUMMARY'e yazar. Toplam senaryo sayısı
// MIN_SCENARIOS'un altına düşerse veya herhangi bir senaryo kalırsa,
// süreç kırmızı çıkış koduyla biter (CLAUDE.md: "CI kırmızıyken merge etme").

import { appendFileSync, readFileSync } from 'node:fs';

const MIN_SCENARIOS = 100;

const resultsPath = process.argv[2];
if (resultsPath === undefined) {
  console.error('Kullanım: summarize-ai-eval.mjs <vitest-json-cikti-yolu>');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(resultsPath, 'utf8'));
} catch (error) {
  console.error(`AI eval sonuç dosyası okunamadı (${resultsPath}):`, error.message);
  process.exit(1);
}

const testFiles = data.testResults ?? [];

const rows = testFiles.map((file) => {
  const assertions = file.assertionResults ?? [];
  const passed = assertions.filter((assertion) => assertion.status === 'passed').length;
  const failed = assertions.filter((assertion) => assertion.status !== 'passed').length;
  const name = String(file.name ?? 'bilinmeyen dosya').split(/[\\/]/).pop();
  return { name, passed, failed };
});

const total = rows.reduce((sum, row) => sum + row.passed + row.failed, 0);
const totalPassed = rows.reduce((sum, row) => sum + row.passed, 0);
const totalFailed = rows.reduce((sum, row) => sum + row.failed, 0);

const table = [
  '| Dosya | Geçti | Kaldı |',
  '| --- | --- | --- |',
  ...rows.map((row) => `| ${row.name} | ${row.passed} | ${row.failed} |`),
].join('\n');

const problems = [];
if (totalFailed > 0) {
  problems.push(`${totalFailed} senaryo başarısız oldu.`);
}
if (total < MIN_SCENARIOS) {
  problems.push(
    `Toplam senaryo sayısı (${total}) F1-T17'nin ${MIN_SCENARIOS}+ hedefinin altında.`,
  );
}

const verdict =
  problems.length === 0
    ? '✅ Tüm golden senaryolar geçti, toplam senaryo sayısı hedefi karşılıyor.'
    : `❌ ${problems.join(' ')}`;

const summary = [
  '## AI Eval Golden-Set Sonucu (F1-T17)',
  '',
  table,
  '',
  `**Toplam: ${total} senaryo — ${totalPassed} geçti, ${totalFailed} kaldı.**`,
  '',
  verdict,
].join('\n');

console.log(summary);

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile !== undefined) {
  appendFileSync(summaryFile, `${summary}\n`);
}

if (problems.length > 0) {
  process.exitCode = 1;
}
