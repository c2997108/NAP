import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'docs');
await mkdir(destination, { recursive: true });
await cp(path.join(root, 'public'), destination, { recursive: true, force: true });
await writeFile(path.join(destination, '.nojekyll'), '');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses']) {
  await cp(path.join(root, name), path.join(destination, name), { recursive: true, force: true });
}
console.log('NAP: public/ を docs/ にコピーしました。GitHub Pagesで公開ブランチの /docs を指定できます。');
if (process.argv.includes('--with-annotation-db')) await import('./prepare-pages-db.mjs');
