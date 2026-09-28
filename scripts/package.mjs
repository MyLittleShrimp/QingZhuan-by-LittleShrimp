import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';

const { name, version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^[a-z0-9-]+$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('打包名称或版本格式不正确。');
}
const prefix = `${name}-${version}`;

async function addFile(zip, source, target = source) {
  zip.file(target, await readFile(source));
}

async function addDirectory(zip, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await addDirectory(zip, path);
    else if (entry.isFile()) await addFile(zip, path);
    else throw new Error(`打包不接受特殊文件：${path}`);
  }
}

// An explicit file list keeps local installers, caches and private QA files out of releases.
const source = new JSZip();
const repository = source.folder(prefix);
for (const file of [
  '.gitignore', 'README.md', 'GITHUB.md', 'VALIDATION.md',
  'package.json', 'package-lock.json', 'tsconfig.json',
  'THIRD_PARTY_NOTICES.txt', '轻转.html',
  'scripts/build.mjs', 'scripts/package.mjs',
]) await addFile(repository, file);
for (const directory of ['src', 'tests', 'docs']) await addDirectory(repository, directory);

const offline = new JSZip();
await addFile(offline, '轻转.html');
await addFile(offline, 'docs/QUICKSTART.txt', '使用说明.txt');
await addFile(offline, 'THIRD_PARTY_NOTICES.txt');

await mkdir('release', { recursive: true });
for (const [suffix, zip] of [['source', source], ['offline', offline]]) {
  const filename = `release/${prefix}-${suffix}.zip`;
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await writeFile(filename, bytes);
  console.log(`已生成 ${filename}（${Math.round(bytes.length / 1024)} KB）`);
}
