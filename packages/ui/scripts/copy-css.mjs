import { cpSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(dirname, '../src');
const distDir = path.resolve(dirname, '../dist');

cpSync(srcDir, distDir, {
  recursive: true,
  filter: (source) => {
    // `statSync` (not `path.extname(source) === ''`) is the correct directory
    // check: an extensionless *file* (e.g. a stray dotfile) would otherwise
    // also match `''` and get copied into `dist/`, which then ships via
    // package.json's `files: ["dist"]`.
    if (statSync(source).isDirectory()) {
      return true;
    }
    return path.extname(source) === '.css';
  },
});
