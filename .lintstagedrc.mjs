export default {
  '*.{ts,tsx,js,jsx,json,md}': ['prettier --write'],
  // Yalnizca packages/ ve apps/ altindaki dosyalarin bir eslint.config.js atasi var
  // (tooling/ paylasilan yardimcilarinin yok - ESLint dosyanin kendi dizininden
  // yukari arar, cwd'den degil; bulamayinca crash eder). Ayni glob'da tek
  // fonksiyon dondurerek iki komutu da calistiriyoruz (duplicate key olmasin diye).
  '{packages,apps}/**/*.{ts,tsx}': (files) => [
    `eslint --fix ${files.join(' ')}`,
    'turbo run typecheck --filter=...[HEAD]',
  ],
};
