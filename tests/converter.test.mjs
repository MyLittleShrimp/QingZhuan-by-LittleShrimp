import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { convertMarkdown, markdown, inspectMarkdown, safeFilename, normalizeSource, findImage, SAMPLE } from '../.test-build/converter.mjs';

async function unpack(source, options) {
  const result = await convertMarkdown(source, options);
  const buffer = Buffer.from(await result.blob.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  return { ...result, buffer, zip, xml };
}

test('Word tables keep actual cells, alignment, inline formatting, escaped pipes and line breaks', async () => {
  const source = '# 中文标题\n\n| 事项 | 状态 | 金额 |\n| :--- | :---: | ---: |\n| **研发**<br>第二行 | `A\\|B` | 123.45 |\n| [官网](https://example.com) | ~~待定~~ | 0 |';
  const { xml, zip } = await unpack(source);
  assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 1);
  assert.equal((xml.match(/<w:tr>/g) ?? []).length, 3);
  assert.equal((xml.match(/<w:tc>/g) ?? []).length, 9);
  assert.match(xml, /<w:tblHeader/);
  assert.match(xml, /w:jc w:val="center"/);
  assert.match(xml, /w:jc w:val="right"/);
  assert.match(xml, /<w:br\/>/);
  assert.match(xml, /A\|B/);
  assert.match(xml, /<w:b\/>/);
  assert.match(xml, /<w:strike\/>/);
  assert.match(xml, /w:tblLayout w:type="fixed"/);
  assert.match(await zip.file('word/_rels/document.xml.rels').async('string'), /https:\/\/example.com/);
});

test('lists remain editable, nested and separate ordered lists retain starts', async () => {
  const { xml, zip } = await unpack('3. 第三项\n   - 嵌套无序项\n     1. 深层有序项\n4. 第四项\n\n段落分隔\n\n7. 第七项\n\n- [x] 已完成\n- [ ] 未完成');
  const numbering = await zip.file('word/numbering.xml').async('string');
  assert.match(numbering, /w:start w:val="3"/);
  assert.match(numbering, /w:start w:val="7"/);
  assert.match(numbering, /w:left="1260"/);
  assert.match(xml, /<w:numPr>/);
  for (const text of ['第三项', '嵌套无序项', '深层有序项', '第四项', '第七项', '☑', '☐']) assert.ok(xml.includes(text));
});

test('raw HTML stays literal; code, Unicode and XML-sensitive content survive', async () => {
  const source = '<script>alert("x")</script>\n\n```html\n<div>& 中文 🙂</div>\n  indented\n```\n\nA & B < C\n\n保留\u0000内容';
  const { xml } = await unpack(source);
  assert.match(xml, /&lt;script&gt;/);
  assert.match(xml, /&lt;div&gt;&amp; 中文 🙂&lt;\/div&gt;/);
  assert.ok(!xml.includes('\u0000'));
  assert.match(xml, /保留内容/);
  const html = markdown.render(source);
  assert.ok(!html.includes('<script>'));
  assert.ok(!markdown.render('[bad](javascript:alert(1))').includes('href="javascript:'));
});

test('long tables keep every row and landscape page dimensions fit the grid', async () => {
  const source = '| 编号 | 内容 |\n| --- | --- |\n' + Array.from({ length: 120 }, (_, i) => `| ${i + 1} | 第${i + 1}行的长内容，这是能够自动换行的中文表格内容。 |`).join('\n');
  const { xml, buffer } = await unpack(source, { landscape: true });
  assert.equal((xml.match(/<w:tr>/g) ?? []).length, 121);
  assert.match(xml, /w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/);
  const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"/g)].map(m => Number(m[1]));
  assert.equal(widths.reduce((a, b) => a + b, 0), 14570);
  assert.match(xml, /第120行/);
  await mkdir('qa', { recursive: true });
  await writeFile('qa/long-table.docx', buffer);
});

test('local images are embedded and missing/remote images are explicit', async () => {
  const data = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const asset = { data, type: 'png', width: 1, height: 1 };
  const images = new Map([['中文图片.png', asset]]);
  const { xml, zip, warnings } = await unpack('![配图](assets/中文图片.png)\n\n![缺失](missing.png)\n\n![远程](https://example.com/中文图片.png)', { images });
  assert.match(xml, /<w:drawing>/);
  assert.equal(Object.keys(zip.files).filter(p => p.startsWith('word/media/') && !zip.files[p].dir).length, 1);
  assert.equal(warnings.length, 2);
  assert.match(xml, /\[图片：缺失\]/);
  assert.equal(findImage('assets/%E4%B8%AD%E6%96%87%E5%9B%BE%E7%89%87.png', images), asset);
  assert.equal(findImage('https://example.com/中文图片.png', images), undefined);
});

test('empty input fails and filename normalization is safe on Windows', async () => {
  await assert.rejects(() => convertMarkdown(' \n '), /请先/);
  assert.equal(safeFilename('a/b:c.docx'), 'a_b_c');
  assert.equal(safeFilename('CON'), '_CON');
  assert.equal(safeFilename('...'), '未命名文档');
  assert.equal(normalizeSource('\uFEFFa\r\nb\rc'), 'a\nb\nc');
});

test('sample and multi-table documents preserve content and produce a valid ZIP', async () => {
  const { buffer, xml } = await unpack(SAMPLE, { title: '项目周报' });
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  assert.match(xml, /项目周报/);
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.equal(inspectMarkdown(SAMPLE).tables, 1);
  await mkdir('qa', { recursive: true });
  await writeFile('qa/sample.docx', buffer);
  assert.equal(inspectMarkdown(SAMPLE + '\n| a |\n| - |\n| b |').tables, 2);
});

test('large practical document converts with no content loss', async () => {
  const source = '# 性能样本\n\n' + Array.from({ length: 100 }, (_, i) => `## 第${i + 1}节\n\n这是包含**加粗**和中文的测试段落。\n\n| 编号 | 说明 |\n| --- | --- |\n| ${i + 1} | 内容保持完整 |\n\n`).join('');
  const start = performance.now();
  const { xml } = await unpack(source);
  assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 100);
  assert.match(xml, /第100节/);
  console.log(`100 个表格转换耗时 ${(performance.now() - start).toFixed(0)} ms`);
});
