import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel,
  ImageRun, LevelFormat, Packer, PageOrientation, Paragraph, ShadingType,
  Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType,
  type IRunOptions, type IParagraphOptions, type INumberingOptions,
} from 'docx';
import type Token from 'markdown-it/lib/token.mjs';
import { markdown, normalizeSource } from './markdown';

export { markdown, normalizeSource, safeFilename, SAMPLE } from './markdown';

export interface LocalImage {
  data: Uint8Array;
  width: number;
  height: number;
  type: 'png' | 'jpg' | 'gif' | 'bmp';
  previewUrl?: string;
}
export interface ConvertOptions {
  title?: string;
  landscape?: boolean;
  images?: Map<string, LocalImage>;
}
type Child = TextRun | ExternalHyperlink | ImageRun;
type Block = Paragraph | Table;
const font = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Microsoft YaHei', cs: 'Calibri' };
const mono = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'Microsoft YaHei', cs: 'Consolas' };
const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' };
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

export function imageKey(path: string): string {
  let result = path;
  try { result = decodeURIComponent(path); } catch { /* Keep literal paths with malformed escapes. */ }
  return result.replace(/\\/g, '/').replace(/^\.\//, '').normalize('NFC');
}

export function findImage(path: string, images?: Map<string, LocalImage>): LocalImage | undefined {
  if (!images || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path)) return undefined;
  const key = imageKey(path);
  const exact = images.get(key);
  if (exact) return exact;
  const name = key.split('/').pop();
  const matches = [...images.entries()].filter(([p]) => imageKey(p).split('/').pop() === name);
  return matches.length === 1 ? matches[0][1] : undefined;
}

export function inspectMarkdown(source: string, images?: Map<string, LocalImage>) {
  const tokens = markdown.parse(normalizeSource(source), {});
  const missing = new Set<string>();
  let tables = 0;
  let widestTable = 0;
  let columns = 0;
  for (const token of tokens) {
    if (token.type === 'table_open') tables++;
    if (token.type === 'tr_open') columns = 0;
    if (token.type === 'th_open' || token.type === 'td_open') columns++;
    if (token.type === 'tr_close') widestTable = Math.max(widestTable, columns);
    for (const child of token.children ?? []) {
      if (child.type === 'image' && !findImage(child.attrGet('src') ?? '', images)) missing.add(child.attrGet('src') ?? '');
    }
  }
  return { tables, widestTable, missingImages: [...missing], tokens };
}

export function createWordDocument(source: string, options: ConvertOptions = {}) {
  const normalized = normalizeSource(source);
  if (!normalized.trim()) throw new Error('请先导入或输入 Markdown 内容。');
  const { tokens, missingImages } = inspectMarkdown(normalized, options.images);
  const pageWidth = options.landscape ? 16838 : 11906;
  const contentWidth = pageWidth - 2268;
  const numbering: INumberingOptions['config'][number][] = [];
  let nextListId = 0;

  function inline(children: Token[], base: IRunOptions = {}, maxWidth = contentWidth / 15): Child[] {
    const output: Child[] = [];
    let bold = 0, italic = 0, strike = 0;
    let link: { url: string; children: (TextRun | ImageRun)[] } | undefined;
    const add = (run: TextRun | ImageRun) => link ? link.children.push(run) : output.push(run);
    const flushLink = () => {
      if (link) {
        output.push(new ExternalHyperlink({ link: link.url, children: link.children }));
        link = undefined;
      }
    };
    for (const token of children) {
      if (token.type === 'strong_open') { bold++; continue; }
      if (token.type === 'strong_close') { bold--; continue; }
      if (token.type === 'em_open') { italic++; continue; }
      if (token.type === 'em_close') { italic--; continue; }
      if (token.type === 's_open') { strike++; continue; }
      if (token.type === 's_close') { strike--; continue; }
      if (token.type === 'link_open') { flushLink(); link = { url: token.attrGet('href') ?? '', children: [] }; continue; }
      if (token.type === 'link_close') { flushLink(); continue; }
      const style: IRunOptions = { ...base, bold: base.bold || bold > 0 || undefined, italics: base.italics || italic > 0 || undefined, strike: strike > 0 || undefined, ...(link ? { color: '2563A6', underline: {} } : {}) };
      switch (token.type) {
        case 'softbreak': add(new TextRun({ ...style, text: ' ' })); break;
        case 'hardbreak': add(new TextRun({ ...style, break: 1 })); break;
        case 'code_inline': add(new TextRun({ ...style, text: token.content, font: mono, size: 20, shading: { type: ShadingType.CLEAR, fill: 'F1F3F5' } })); break;
        case 'image': {
          const src = token.attrGet('src') ?? '';
          const asset = findImage(src, options.images);
          if (asset) {
            const ratio = Math.min(1, maxWidth / asset.width, 780 / asset.height);
            add(new ImageRun({ data: asset.data, type: asset.type, transformation: { width: Math.max(1, Math.round(asset.width * ratio)), height: Math.max(1, Math.round(asset.height * ratio)) }, altText: { name: token.content || '图片', title: token.content || '图片', description: token.content || src } }));
          } else add(new TextRun({ ...style, text: `[图片：${token.content || src}]`, color: '666666' }));
          break;
        }
        default: if (token.content) add(new TextRun({ ...style, text: token.content }));
      }
    }
    flushLink();
    return output.length ? output : [new TextRun('')];
  }

  function makeTable(start: number): { table: Table; end: number } {
    type Cell = { children: Token[]; align: typeof AlignmentType.LEFT | typeof AlignmentType.CENTER | typeof AlignmentType.RIGHT; header: boolean };
    const rows: Cell[][] = [];
    let row: Cell[] = [];
    let cell: Cell | undefined;
    let index = start + 1;
    for (; index < tokens.length && tokens[index].type !== 'table_close'; index++) {
      const token = tokens[index];
      if (token.type === 'tr_open') row = [];
      if (token.type === 'th_open' || token.type === 'td_open') {
        const css = token.attrGet('style') ?? '';
        cell = { children: [], align: css.includes('center') ? AlignmentType.CENTER : css.includes('right') ? AlignmentType.RIGHT : AlignmentType.LEFT, header: token.type === 'th_open' };
        row.push(cell);
      }
      if (token.type === 'inline' && cell) cell.children = token.children ?? [];
      if (token.type === 'tr_close') rows.push(row);
    }
    const count = Math.max(1, ...rows.map(r => r.length));
    // Estimate rendered text lengths; cap influence so long descriptions wrap instead of swallowing other columns.
    const weights = Array.from({ length: count }, (_, col) => {
      const lengths = rows.map(r => {
        const value = (r[col]?.children ?? []).map(t => t.content).join('');
        return [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
      });
      return Math.sqrt(Math.min(48, Math.max(6, ...lengths)));
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map(w => Math.floor(contentWidth * w / total));
    widths[widths.length - 1] += contentWidth - widths.reduce((a, b) => a + b, 0);
    const table = new Table({
      width: { size: contentWidth, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: rows.map(r => new TableRow({
        tableHeader: r.every(c => c.header),
        // Allow very tall cells to continue across pages rather than clipping.
        cantSplit: false,
        children: Array.from({ length: count }, (_, column) => {
          const c = r[column] ?? { children: [], align: AlignmentType.LEFT, header: false };
          return new TableCell({
            width: { size: widths[column], type: WidthType.DXA },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            verticalAlign: VerticalAlign.CENTER,
            shading: { type: ShadingType.CLEAR, fill: c.header ? 'EDF1F5' : 'FFFFFF' },
            children: [new Paragraph({ alignment: c.align, spacing: { after: 0, line: 276 }, keepNext: false, children: inline(c.children, { bold: c.header, size: count > 6 ? 19 : 21 }, Math.max(10, (widths[column] - 240) / 15)) })],
          });
        }),
      })),
    });
    return { table, end: index };
  }

  interface ListContext { reference: string; depth: number; pending: boolean; ordered: boolean; }
  const lists: ListContext[] = [];
  const blocks: Block[] = [];
  let quoteDepth = 0;
  let tableSpacer: Paragraph | undefined;

  function paragraph(children: Child[], extra: IParagraphOptions = {}, task = false): Paragraph {
    const current = lists.at(-1);
    const indent = quoteDepth * 360 + (current ? (current.depth + 1) * 420 : 0);
    const number = current?.pending && !task ? { reference: current.reference, level: 0 } : undefined;
    if (current) current.pending = false;
    return new Paragraph({
      children, spacing: { after: 140, line: 300 }, widowControl: true,
      ...(indent ? { indent: { left: indent, ...(task ? { hanging: 300 } : {}) } } : {}),
      ...(quoteDepth ? { style: 'Quote', spacing: { before: 60, after: 120, line: 300 } } : {}),
      ...(number ? { numbering: number } : {}),
      ...extra,
    });
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'blockquote_open') { quoteDepth++; continue; }
    if (token.type === 'blockquote_close') { quoteDepth--; continue; }
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const ordered = token.type === 'ordered_list_open';
      const depth = lists.length;
      const reference = `list-${nextListId++}`;
      numbering.push({ reference, levels: [{ level: 0, format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET, text: ordered ? '%1.' : ['•', '◦', '▪'][depth % 3], start: ordered ? Number(token.attrGet('start') ?? 1) : 1, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: (depth + 1) * 420 + quoteDepth * 360, hanging: 260 } } } }] });
      lists.push({ reference, depth, ordered, pending: false });
      continue;
    }
    if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') { lists.pop(); continue; }
    if (token.type === 'list_item_open') { if (lists.length) lists[lists.length - 1].pending = true; continue; }
    if (token.type === 'table_open') {
      const result = makeTable(i);
      tableSpacer = new Paragraph({ spacing: { after: 100 }, children: [] });
      blocks.push(result.table, tableSpacer);
      i = result.end;
      continue;
    }
    if (token.type === 'heading_open') {
      const level = Math.min(6, Math.max(1, Number(token.tag.slice(1))));
      blocks.push(paragraph(inline(tokens[i + 1]?.children ?? []), { heading: HEADINGS[level - 1], spacing: { before: level === 1 ? 240 : 220, after: 120 }, keepNext: true }));
      i += 2;
      continue;
    }
    if (token.type === 'paragraph_open') {
      const children = (tokens[i + 1]?.children ?? []).map(t => Object.assign(Object.create(Object.getPrototypeOf(t)), t)) as Token[];
      const taskMatch = lists.length && children[0]?.type === 'text' ? /^\[([ xX])\]\s+/.exec(children[0].content) : null;
      if (taskMatch) children[0].content = (taskMatch[1] === ' ' ? '☐  ' : '☑  ') + children[0].content.slice(taskMatch[0].length);
      blocks.push(paragraph(inline(children), {}, Boolean(taskMatch)));
      i += 2;
      continue;
    }
    if (token.type === 'fence' || token.type === 'code_block') {
      const lines = token.content.replace(/\n$/, '').split('\n');
      blocks.push(paragraph(lines.map((line, n) => new TextRun({ text: line || ' ', ...(n ? { break: 1 } : {}), font: mono, size: 19 })), { shading: { type: ShadingType.CLEAR, fill: 'F4F5F7' }, spacing: { before: 100, after: 160, line: 260 }, keepLines: false }));
      continue;
    }
    if (token.type === 'hr') blocks.push(new Paragraph({ border: { bottom: border }, spacing: { before: 160, after: 160 }, children: [] }));
  }
  // A trailing spacer can overflow onto a blank page when a table fills the page.
  if (blocks.at(-1) === tableSpacer) blocks.pop();
  const document = new Document({
    title: options.title || 'Markdown 文档', creator: '轻转', description: '由轻转在本地将 Markdown 转换为 Word',
    styles: {
      default: {
        document: { run: { font, size: 22, color: '202124' }, paragraph: { spacing: { after: 140, line: 300 } } },
        heading1: { run: { font, size: 36, bold: true, color: '000000' } },
        heading2: { run: { font, size: 29, bold: true, color: '000000' } },
        heading3: { run: { font, size: 25, bold: true, color: '000000' } },
        heading4: { run: { font, size: 23, bold: true, color: '000000' } },
        heading5: { run: { font, size: 22, bold: true, color: '000000' } },
        heading6: { run: { font, size: 22, bold: true, color: '000000' } },
      },
      paragraphStyles: [{ id: 'Quote', name: 'Quote', basedOn: 'Normal', run: { color: '595959' } }],
    },
    numbering: { config: numbering },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838, orientation: options.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children: blocks }],
  });
  return { document, warnings: missingImages.map(src => `未嵌入图片：${src}（保留文字说明）`) };
}

export async function convertMarkdown(source: string, options: ConvertOptions = {}) {
  const { document, warnings } = createWordDocument(source, options);
  return { blob: await Packer.toBlob(document), warnings };
}
