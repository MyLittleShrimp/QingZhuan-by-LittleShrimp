import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { convertMarkdown, SAMPLE, markdown as parser } from '../.test-build/converter.mjs';
import { convertWord, htmlToMarkdown, packageMarkdown } from '../.test-build/word-to-markdown.mjs';

async function wordBytes(source, options = {}) {
  const { blob } = await convertMarkdown(source, options);
  return new Uint8Array(await blob.arrayBuffer());
}

test('sample round trip preserves headings, table columns, inline styles and tasks', async () => {
  const { markdown, warnings } = await convertWord(await wordBytes(SAMPLE));
  assert.match(markdown, /^# 项目周报/m);
  assert.match(markdown, /^## 本周进展/m);
  assert.match(markdown, /\*\*加粗\*\*/);
  assert.match(markdown, /~~删除线~~/);
  assert.match(markdown, /`行内代码`/);
  assert.match(markdown, /\| :--- \| :---: \| ---: \|/);
  assert.match(markdown, /- \[x\] 表格可在 Word 中继续编辑/);
  assert.match(markdown, /^> 专注内容/m);
  assert.equal(parser.parse(markdown, {}).filter(token => token.type === 'table_open').length, 1);
  assert.deepEqual(warnings, []);
});

test('headerless Word tables, merged cells and line breaks become valid Markdown grids', async () => {
  const cell = (text, properties = {}) => new TableCell({ children: [new Paragraph(text)], ...properties });
  const document = new Document({ sections: [{ children: [new Table({ rows: [
    new TableRow({ children: [cell('合并表头', { columnSpan: 2 }), cell('数值')] }),
    new TableRow({ children: [cell('A|B'), cell('第一行\n第二行'), cell('100')] }),
  ] })] }] });
  const bytes = await Packer.toBuffer(document);
  const result = await convertWord(new Uint8Array(bytes));
  assert.match(result.markdown, /\| 合并表头 \|  \| 数值 \|/);
  assert.match(result.markdown, /A\\\|B/);
  assert.ok(result.warnings.some(w => w.includes('合并单元格')));
  const tokens = parser.parse(result.markdown, {});
  assert.equal(tokens.filter(t => t.type === 'table_open').length, 1);
  assert.equal(tokens.filter(t => t.type === 'td_open').length, 3);
  await mkdir('qa', { recursive: true });
  await writeFile('qa/word-merged.docx', bytes);
});

test('row spans keep the rectangular grid and empty cells without duplicating content', () => {
  const warnings = new Set();
  const markdown = htmlToMarkdown('<table><tr><td>列一</td><td>列二</td></tr><tr><td rowspan="2">共享值</td><td>第一行<br>换行</td></tr><tr><td>第二行</td></tr></table>', warnings);
  assert.equal((markdown.match(/共享值/g) ?? []).length, 1);
  assert.match(markdown, /\|  \| 第二行 \|/);
  assert.match(markdown, /第一行<br>换行/);
  assert.ok(warnings.size > 0);
});

test('code and literal HTML text remain code or literal Markdown text', async () => {
  const source = '# 代码\n\n```html\n<div>A & B</div>\nconst n = 3;\n```\n\n<script>window.pwned=1</script>\n\n| 内容 |\n| --- |\n| 第一行<br>第二行 |';
  const result = await convertWord(await wordBytes(source));
  assert.match(result.markdown, /```[\s\S]*<div>A & B<\/div>[\s\S]*const n = 3;/);
  assert.match(result.markdown, /第一行<br>第二行/);
  assert.ok(!result.markdown.includes('\n<script>'));
  assert.ok(!parser.render(result.markdown).includes('<script>'));
});

test('nested lists and non-default HTML numbering produce Markdown lists', () => {
  const markdown = htmlToMarkdown('<ol start="3"><li>第三项<ul><li>子项</li></ul></li><li>第四项</li></ol>');
  assert.match(markdown, /^3\.\s+第三项/m);
  assert.match(markdown, /^\s+-\s+子项/m);
  assert.match(markdown, /^4\.\s+第四项/m);
});

test('embedded images are packaged with working relative references and original bytes', async () => {
  const data = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const source = '# 配图文档\n\n![图解](local.png)';
  const bytes = await wordBytes(source, { images: new Map([['local.png', { data, type: 'png', width: 1, height: 1 }]]) });
  const result = await convertWord(bytes);
  assert.equal(result.images.length, 1);
  assert.match(result.markdown, /!\[图解\]\(images\/image-001\.png\)/);
  assert.deepEqual(result.images[0].data, data);
  const output = await packageMarkdown(result.markdown + '\n修改内容', '配图文档', result.images);
  assert.equal(output.filename, '配图文档.zip');
  const zip = await JSZip.loadAsync(await output.blob.arrayBuffer());
  assert.match(await zip.file('配图文档.md').async('string'), /修改内容/);
  assert.deepEqual(await zip.file('images/image-001.png').async('uint8array'), data);
  await mkdir('qa', { recursive: true });
  await writeFile('qa/word-images.docx', bytes);
});

test('plain Markdown downloads use UTF-8 and safe filenames', async () => {
  const output = await packageMarkdown('# 中文\n\n已编辑', 'CON.md', []);
  assert.equal(output.filename, '_CON.md');
  assert.equal(await output.blob.text(), '# 中文\n\n已编辑\n');
});

test('unsafe links and raw HTML cannot become active content', () => {
  const warnings = new Set();
  const result = htmlToMarkdown('<p><a href="javascript:alert(1)">保留名称</a> <a href="https://example.com/a(b)">正常链接</a></p><script>danger</script><p>&lt;script&gt;literal&lt;/script&gt;</p>', warnings);
  assert.match(result, /保留名称/);
  assert.ok(!result.includes('javascript:'));
  assert.ok(!result.includes('danger'));
  assert.match(result, /https:\/\/example.com\/a%28b%29/);
  assert.ok(result.includes('\\<script\\>'));
  assert.ok(warnings.size > 0);
});

test('invalid, encrypted/legacy and oversized archives report usable errors', async () => {
  await assert.rejects(() => convertWord(new Uint8Array([1,2,3])), /完整、未加密/);
  await assert.rejects(() => convertWord(new Uint8Array([0xd0,0xcf,0x11,0xe0])), /旧版 .doc 或加密/);
  const zip = new JSZip(); zip.file('other.txt', 'not a document');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  await assert.rejects(() => convertWord(bytes), /不是有效/);
  await assert.rejects(() => convertWord(new Uint8Array(20 * 1024 * 1024 + 1)), /超过 20 MB/);
});

test('archive expansion is bounded before parsing contents', async () => {
  const bytes = await wordBytes('测试');
  const modified = bytes.slice();
  const view = new DataView(modified.buffer);
  let changed = false;
  for (let offset = 0; offset < modified.length - 46; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      const size = view.getUint16(offset + 28, true);
      const name = new TextDecoder().decode(modified.subarray(offset + 46, offset + 46 + size));
      if (name === 'word/document.xml') { view.setUint32(offset + 24, 150 * 1024 * 1024, true); changed = true; break; }
    }
  }
  assert.ok(changed);
  await assert.rejects(() => convertWord(modified), /解压后的内容过大/);
});
