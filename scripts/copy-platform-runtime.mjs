import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'packages/shared/python/nullius_windows');
const destination = path.join(root, 'packages/shared/dist/python/nullius_windows');
fs.mkdirSync(destination, { recursive: true });
const names = fs.readdirSync(source).filter(name => name.endsWith('.py'));
for (const name of names) {
  const original = path.join(source, name);
  if (!fs.lstatSync(original).isFile()) throw new Error(`Platform runtime must be a regular file: ${name}`);
  fs.copyFileSync(original, path.join(destination, name));
}
for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.py') && !names.includes(entry.name)) {
    fs.unlinkSync(path.join(destination, entry.name));
  }
}
