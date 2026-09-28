import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';

if (process.argv.includes('--test')) {
  await mkdir('.test-build', { recursive: true });
  await build({ entryPoints: ['src/converter.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: '.test-build/converter.mjs' });
  await build({ entryPoints: ['src/word-to-markdown.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: '.test-build/word-to-markdown.mjs' });
} else {
  const result = await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'iife', target: ['chrome100', 'firefox100', 'safari15'], minify: true, write: false, legalComments: 'inline' });
  const template = await readFile('src/index.html', 'utf8');
  const css = await readFile('src/styles.css', 'utf8');
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const notices = [];
  for (const [path, info] of Object.entries(lock.packages)) {
    if (!path || info.dev) continue;
    const files = await readdir(path);
    const licenses = files.filter(name => /^(license|licence|copying)(\.|$)/i.test(name));
    notices.push(`${path.replace(/^node_modules\//, '')} ${info.version}\n${(await Promise.all(licenses.map(name => readFile(`${path}/${name}`, 'utf8')))).join('\n') || `License: ${info.license || 'See package metadata'}`}`);
  }
  const licenseText = `Third-party software notices\n\n${notices.join('\n\n========================================\n\n')}`;
  await writeFile('THIRD_PARTY_NOTICES.txt', licenseText);
  const html = template.replace('/* APP_STYLES */', () => css).replace('/* APP_SCRIPT */', () => js) + `\n<!--\n${licenseText.replace(/--/g, '—')}\n-->\n`;
  await writeFile('轻转.html', html);
  console.log(`已生成 轻转.html（${Math.round(Buffer.byteLength(html) / 1024)} KB），双击即可离线使用，支持双向转换。`);
}
