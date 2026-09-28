import mammoth from 'mammoth/mammoth.browser.js';
import TurndownService from 'turndown';
import JSZip from 'jszip';
import { safeFilename } from './markdown';

export interface ExtractedImage { path: string; data: Uint8Array; mime: string; previewable: boolean; }
export interface WordResult { markdown: string; images: ExtractedImage[]; warnings: string[]; }
const MB = 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp', 'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'image/x-emf': 'emf', 'image/x-wmf': 'wmf' };
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp']);

interface WordNode {
  type: string;
  children?: WordNode[];
  styleId?: string;
  styleName?: string;
  alignment?: string;
  numbering?: unknown;
  font?: string;
}

function transformStyles(node: WordNode, insideTable = false): WordNode {
  const inTable = insideTable || node.type === 'table';
  if (node.type === 'paragraph') {
    const runs = node.children?.filter(child => child.type === 'run') ?? [];
    const mono = (run: WordNode) => /^(Consolas|Courier New|Courier|Menlo|Monaco|Lucida Console)$/i.test(run.font ?? '');
    const isCode = !node.numbering && !node.styleName?.match(/heading|标题/i) && runs.length > 0 && runs.every(mono);
    if (isCode && !inTable) { node.styleId = 'MdCodeBlock'; node.styleName = 'MdCodeBlock'; }
    else if (inTable && ['center', 'right', 'end'].includes(node.alignment ?? '')) {
      node.styleId = node.styleName = node.alignment === 'center' ? 'MdAlignCenter' : 'MdAlignRight';
    }
  }
  if (node.type === 'run' && (/^(Consolas|Courier New|Courier|Menlo|Monaco|Lucida Console)$/i.test(node.font ?? '') || /^(Code|Inline Code)$/i.test(node.styleName ?? ''))) {
    node.styleId = node.styleName = 'MdInlineCode';
  }
  node.children?.forEach(child => transformStyles(child, inTable));
  return node;
}

function safeLink(href: string) {
  const normalized = href.trim().replace(/[\u0000-\u0020\u007f]/g, '');
  return !normalized.startsWith('//') && !normalized.startsWith('\\') && (!/^[a-z][a-z\d+.-]*:/i.test(normalized) || /^(https?:|mailto:)/i.test(normalized));
}

export function htmlToMarkdown(html: string, warnings: Set<string> = new Set()): string {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', br: '  \n' });
  const escape = service.escape.bind(service);
  service.escape = value => escape(value).replace(/</g, '\\<').replace(/>/g, '\\>');
  service.remove(['script', 'style', 'iframe', 'object']);
  service.addRule('strike', { filter: node => ['DEL', 'S', 'STRIKE'].includes(node.nodeName), replacement: text => `~~${text}~~` });
  service.addRule('safe-links', {
    filter: 'a', replacement: (text, node) => {
      const href = node.getAttribute('href') ?? '';
      if (!href) return text;
      if (!safeLink(href)) { warnings.add('不支持的链接已保留为文字。'); return text; }
      if (href.startsWith('#')) { warnings.add('文档内链接已保留链接文字；请按 Markdown 标题重新设置锚点。'); return text; }
      return `[${text}](${href.replace(/\\/g, '%5C').replace(/[\s<>]/g, char => encodeURIComponent(char)).replace(/[()]/g, char => '%' + char.charCodeAt(0).toString(16))})`;
    },
  });
  service.addRule('local-images', {
    filter: 'img', replacement: (_text, node) => {
      const path = node.getAttribute('data-md-asset');
      const alt = service.escape(node.getAttribute('alt') || '图片').replace(/\n/g, ' ');
      if (!path || !/^images\/image-\d+\.[a-z]+$/.test(path)) return `[图片：${alt}]`;
      return `${node.getAttribute('data-md-preview') === 'yes' ? '!' : ''}[${alt}](${path})`;
    },
  });
  service.addRule('checkbox', { filter: node => node.nodeName === 'INPUT' && node.getAttribute('type') === 'checkbox', replacement: (_text, node) => node.hasAttribute('checked') ? '[x] ' : '[ ] ' });
  service.addRule('code-block', {
    filter: 'pre', replacement: (_text, node) => {
      const copy = node.cloneNode(true) as HTMLElement;
      Array.from(copy.querySelectorAll('br')).forEach(br => br.parentNode!.replaceChild(copy.ownerDocument.createTextNode('\n'), br));
      const code = (copy.textContent ?? '').replace(/\n$/, '');
      const longestFence = Math.max(2, ...(code.match(/`+/g) ?? []).map(run => run.length));
      const fence = '`'.repeat(longestFence + 1);
      return `\n\n${fence}\n${code}\n${fence}\n\n`;
    },
  });
  service.addRule('word-table', {
    filter: 'table', replacement: (_text, table) => {
      // Convert direct rows only; nested tables remain inside their parent cell.
      const rows = Array.from(table.querySelectorAll('tr')).filter(row => {
        let parent = row.parentElement;
        while (parent && parent !== table) { if (parent.nodeName === 'TABLE') return false; parent = parent.parentElement; }
        return parent === table;
      });
      if (!rows.length) return '';
      if (rows.length > 10000) throw new Error('表格行数过多，请拆分文档后重试。');
      const grid: string[][] = [];
      const alignment: string[] = [];
      for (let r = 0; r < rows.length; r++) {
        grid[r] ??= [];
        let column = 0;
        for (const cell of Array.from(rows[r].children).filter(n => ['TH', 'TD'].includes(n.nodeName))) {
          while (grid[r][column] !== undefined) column++;
          const cols = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
          const rowCount = Math.max(1, Number(cell.getAttribute('rowspan')) || 1);
          if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rowCount) || column + cols > 128 || r + rowCount > 10000) throw new Error('表格结构过大或无效，请简化后重试。');
          if (cols > 1 || rowCount > 1) warnings.add('合并单元格已展开为普通表格，内容放在左上单元格，其余位置留空。');
          const copy = cell.cloneNode(true) as HTMLElement;
          const nestedTables = copy.querySelectorAll('table');
          if (nestedTables.length) {
            warnings.add('嵌套表格已展开为单元格内的文本。');
            Array.from(nestedTables).forEach(nested => nested.parentNode!.replaceChild(copy.ownerDocument.createTextNode(nested.textContent ?? ''), nested));
          }
          // Turndown must receive the cell's contents, not TD itself (which is not a block node).
          let value = service.turndown(copy.innerHTML).trim();
          value = value.replace(/\r\n?/g, '\n').replace(/\s*\n+\s*/g, '<br>');
          // GFM's table parser consumes one escape before a pipe, including inside inline code.
          value = value.replace(/(\\*)\|/g, (_match, slashes: string) => `${slashes.length % 2 ? slashes : slashes + '\\'}|`);
          if (r === 0) alignment[column] = cell.querySelector('.md-align-center') ? ':---:' : cell.querySelector('.md-align-right') ? '---:' : ':---';
          for (let dr = 0; dr < Math.min(rowCount, rows.length - r); dr++) {
            grid[r + dr] ??= [];
            for (let dc = 0; dc < cols; dc++) grid[r + dr][column + dc] = dr === 0 && dc === 0 ? value : '';
          }
          column += cols;
        }
      }
      const columns = Math.max(...grid.map(row => row.length));
      const lines = grid.map(row => `| ${Array.from({ length: columns }, (_, i) => row[i] ?? '').join(' | ')} |`);
      lines.splice(1, 0, `| ${Array.from({ length: columns }, (_, i) => alignment[i] || '---').join(' | ')} |`);
      return '\n\n' + lines.join('\n') + '\n\n';
    },
  });
  return service.turndown(html).trim().replace(/^([ \t]*(?:[-*+]\s+)?)☑\s+/gm, (_m, prefix: string) => `${prefix || '- '}[x] `).replace(/^([ \t]*(?:[-*+]\s+)?)☐\s+/gm, (_m, prefix: string) => `${prefix || '- '}[ ] `) + '\n';
}

export async function convertWord(input: ArrayBuffer | Uint8Array): Promise<WordResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > 20 * MB) throw new Error('Word 文件超过 20 MB，请压缩图片或拆分文档后再导入。');
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new Error('此文件是旧版 .doc 或加密文档，请用 Word / LibreOffice 另存为未加密的 .docx。');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error('无法读取此文件，请确认它是完整、未加密的 .docx 文档。'); }
  if (!zip.file('word/document.xml') || !zip.file('[Content_Types].xml')) throw new Error('文件不是有效的 Word .docx 文档。');
  const files = Object.values(zip.files).filter(file => !file.dir);
  // Check central-directory sizes before Mammoth inflates XML/media into memory.
  let total = 0;
  for (const file of files) {
    const size = (file as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize;
    if (!Number.isFinite(size) || size < 0 || size > 30 * MB || ((/\.(xml|rels)$/i.test(file.name)) && size > 10 * MB)) throw new Error('文档解压后的内容过大，请拆分后重试。');
    total += size;
  }
  if (total > 100 * MB || files.length > 5000) throw new Error('文档解压后的内容过大，请拆分后重试。');
  const warnings = new Set<string>();
  const xml = await zip.file('word/document.xml')!.async('string');
  const numberingXml = await zip.file('word/numbering.xml')?.async('string') ?? '';
  if ([...numberingXml.matchAll(/<w:start(?:Override)?\b[^>]*w:val=["'](\d+)["']/g)].some(match => Number(match[1]) !== 1)) warnings.add('特殊起始编号已按 Markdown 列表重新编号，请核对序号。');
  if ([...numberingXml.matchAll(/<w:numFmt\b[^>]*w:val=["']([^"']+)["']/g)].some(match => !['decimal', 'bullet', 'none'].includes(match[1]))) warnings.add('字母、罗马数字等列表编号已转换为普通数字编号。');
  if (/<(?:\w+:)?oMath\b/.test(xml)) warnings.add('Word 公式暂不支持转换，请对照原文补充。');
  if (/<w:(?:object|altChunk)\b/.test(xml)) warnings.add('文档含嵌入对象或外部内容，请对照原文检查。');
  if (files.some(file => /^word\/(?:header|footer)\d+\.xml$/.test(file.name))) warnings.add('页眉、页脚和页码未写入 Markdown。');
  const images: ExtractedImage[] = [];
  let imageIndex = 0;
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes.slice().buffer as ArrayBuffer }, {
    includeEmbeddedStyleMap: false,
    externalFileAccess: false,
    styleMap: [
      "p[style-name='Title'] => h1:fresh", "p[style-name='标题'] => h1:fresh",
      "p[style-name='Quote'] => blockquote > p:fresh", "p[style-name='引用'] => blockquote > p:fresh",
      "p[style-name='MdCodeBlock'] => pre:separator('\\n')",
      "p[style-name='MdAlignCenter'] => p.md-align-center:fresh",
      "p[style-name='MdAlignRight'] => p.md-align-right:fresh",
      "r[style-name='MdInlineCode'] => code", 'strike => del',
      ...Array.from({ length: 6 }, (_, i) => `p[style-name='标题 ${i + 1}'] => h${i + 1}:fresh`),
    ],
    transformDocument: transformStyles,
    convertImage: mammoth.images.imgElement(async image => {
      const index = ++imageIndex;
      try {
        const data = new Uint8Array(await image.readAsArrayBuffer());
        const extension = IMAGE_EXTENSIONS[image.contentType] ?? 'bin';
        const path = `images/image-${String(index).padStart(3, '0')}.${extension}`;
        const previewable = PREVIEW_TYPES.has(image.contentType);
        images.push({ path, data, mime: image.contentType, previewable });
        if (!previewable) warnings.add('部分图片格式不支持网页预览，已作为附件保留在下载包中。');
        // No source URL is fed to the HTML parser; assets are attached only to the safe Markdown preview.
        return { src: '', 'data-md-asset': path, 'data-md-preview': previewable ? 'yes' : 'no' };
      } catch {
        warnings.add('部分图片无法读取（可能为外部链接），已保留文字说明。');
        return { src: '' };
      }
    }),
  });
  for (const message of result.messages) {
    if (message.message.includes('Unrecognised paragraph style') || message.message.includes('Unrecognised run style')) warnings.add('部分自定义样式已按普通文本保留。');
    else warnings.add(`部分内容未完整还原：${message.message}`);
  }
  const output = htmlToMarkdown(result.value, warnings);
  if (!output.trim()) warnings.add('未提取到正文文字；扫描页不会自动识别为文本。');
  images.sort((a, b) => a.path.localeCompare(b.path));
  return { markdown: output.trim() ? output : '', images, warnings: [...warnings] };
}

export async function packageMarkdown(markdown: string, name: string, images: ExtractedImage[]) {
  const title = safeFilename(name.replace(/\.(md|zip)$/i, ''));
  const text = markdown.endsWith('\n') ? markdown : markdown + '\n';
  if (!images.length) return { blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }), filename: `${title}.md` };
  const zip = new JSZip();
  zip.file(`${title}.md`, text);
  for (const image of images) zip.file(image.path, image.data);
  return { blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), filename: `${title}.zip` };
}
