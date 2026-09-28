import { convertMarkdown, findImage, imageKey, inspectMarkdown, markdown, normalizeSource, safeFilename, SAMPLE, type LocalImage } from './converter';
import { convertWord, packageMarkdown, type ExtractedImage } from './word-to-markdown';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const editor = $<HTMLTextAreaElement>('editor');
const filename = $<HTMLInputElement>('filename');
const orientation = $<HTMLSelectElement>('orientation');
const exportButton = $<HTMLButtonElement>('export-button');
const input = $<HTMLInputElement>('file-input');
const imageInput = $<HTMLInputElement>('image-input');
const preview = $('preview');
const status = $('status');
let images = new Map<string, LocalImage>();
type Mode = 'md-to-word' | 'word-to-md';
let mode: Mode = 'md-to-word';
let extractedImages: ExtractedImage[] = [];
let conversionWarnings: string[] = [];
// Keep the imported content separate from the editable Markdown result.
let wordSource: { markdown: string; name: string } | null = null;
const drafts: Record<Mode, { text: string; filename: string; label: string; dirty: boolean; images: Map<string, LocalImage> }> = {
  'md-to-word': { text: SAMPLE, filename: '项目周报', label: '示例内容', dirty: false, images },
  'word-to-md': { text: '', filename: '未命名文档', label: '等待 Word 文件', dirty: false, images: new Map() },
};
const MAX_BYTES = 5 * 1024 * 1024;
let dirty = false;
let busy = false;
let previewTimer: ReturnType<typeof setTimeout>;
let importVersion = 0;

function setStatus(message: string, kind = '') {
  status.textContent = message;
  status.className = kind;
}

function updateExportControls() {
  const wordMode = mode === 'word-to-md';
  $('export-label').textContent = busy ? '正在转换…' : wordMode ? extractedImages.length ? '导出 MD + 图片' : '导出 Markdown' : '导出 Word';
  $('file-extension').textContent = wordMode ? extractedImages.length ? '.zip' : '.md' : '.docx';
  exportButton.disabled = busy || (!editor.value.trim() && !(wordMode && extractedImages.length));
  $<HTMLButtonElement>('copy-button').disabled = busy || !editor.value.trim();
}

function setBusy(value: boolean) {
  busy = value;
  for (const id of ['mode-md', 'mode-word', 'sample-button', 'clear-button', 'image-button']) $<HTMLButtonElement>(id).disabled = value;
  editor.readOnly = value;
  input.disabled = value;
  imageInput.disabled = value;
  orientation.disabled = value;
  updateExportControls();
}

function switchMode(next: Mode) {
  if (mode === next || busy) return;
  drafts[mode] = { text: editor.value, filename: filename.value, label: $('source-label').textContent ?? '', dirty, images };
  importVersion++;
  mode = next;
  const draft = drafts[mode];
  editor.value = draft.text; filename.value = draft.filename; images = draft.images; dirty = draft.dirty;
  $('source-label').textContent = draft.label;
  const wordMode = mode === 'word-to-md';
  document.body.classList.toggle('word-mode', wordMode);
  if (wordMode) $('source-label').textContent = wordSource?.name ?? '等待 Word 文件';
  // Move the actual content so visual, keyboard and reading order all remain input → output.
  $('source-panel').append($(wordMode ? 'preview-content' : 'editor-content'));
  $('result-panel').append($(wordMode ? 'editor-content' : 'preview-content'));
  for (const [id, active] of [['mode-md', !wordMode], ['mode-word', wordMode]] as const) {
    $(id).classList.toggle('active', active); $(id).setAttribute('aria-pressed', String(active));
  }
  $('hero-title').textContent = wordMode ? 'Word，轻松变成 Markdown。' : 'Markdown，轻松变成 Word。';
  $('hero-description').textContent = wordMode ? '左侧导入并查看 Word，右侧编辑、复制或下载转换后的 Markdown。' : '放入你的 Markdown，一键得到排版整洁、表格可编辑的 Word 文档。';
  $('editor-heading').innerHTML = `<span class="step">01</span> ${wordMode ? 'Word 文件' : 'Markdown 内容'}`;
  $('preview-heading').innerHTML = `<span class="step">02</span> ${wordMode ? 'Markdown 结果' : '效果预览'}`;
  $('result-tag').textContent = wordMode ? '可编辑' : '基础排版';
  $('result-editor-label').hidden = !wordMode;
  editor.setAttribute('aria-label', wordMode ? 'Markdown 转换结果' : 'Markdown 内容');
  preview.setAttribute('aria-label', wordMode ? '导入的 Word 内容预览' : '文档内容预览');
  $('drop-description').innerHTML = wordMode ? '<strong>选择 Word 文件</strong>，或将文件拖到这里<small>.docx，最大 20 MB · 旧版 .doc 请先另存为 .docx</small>' : '<strong>选择文件</strong>，或将 Markdown 拖到这里<small>.md / .markdown / .txt，最大 5 MB</small>';
  $('drop-zone').setAttribute('aria-label', wordMode ? '选择 Word DOCX 文件，也可拖入此处' : '选择 Markdown 文件，也可以将文件拖入此处');
  input.accept = wordMode ? '.docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document' : '.md,.markdown,.txt,text/markdown,text/plain';
  $('editor-tip').textContent = wordMode ? 'Word 内容预览' : '也可以直接粘贴、编辑';
  $('image-button').hidden = wordMode;
  $('copy-button').hidden = !wordMode;
  $('page-field').hidden = wordMode;
  $('word-export-note').hidden = !wordMode;
  $('sample-button').textContent = wordMode ? '试用示例' : '载入示例';
  $('preview-note').textContent = wordMode ? '导入内容预览 · 原始排版以 Word 为准' : '保留内容结构，实际分页以 Word 为准';
  $('empty-preview').querySelector('h3')!.textContent = wordMode ? '把 Word 放进来' : '从一段 Markdown 开始';
  $('empty-preview').querySelector('p')!.textContent = wordMode ? '导入 .docx 后，在这里查看内容。' : '导入文件或粘贴内容，预览会显示在这里。';
  editor.placeholder = wordMode ? '从左侧导入 Word，Markdown 结果会显示在这里。\n\n转换后可以直接编辑、复制或导出。' : '# 在这里开始\n\n粘贴 Markdown 内容，或从上方导入文件。';
  $('image-count').textContent = images.size ? ` (${images.size})` : '';
  refreshPreview();
  setStatus(wordMode ? '导入 .docx，内容会在本地转换为 Markdown。' : '导入文件或粘贴 Markdown，即可导出 Word。');
}
$('mode-md').addEventListener('click', () => switchMode('md-to-word'));
$('mode-word').addEventListener('click', () => switchMode('word-to-md'));

markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = token.attrGet('src') ?? '';
  const asset = findImage(src, images);
  const alt = markdown.utils.escapeHtml(token.content || src);
  return asset?.previewUrl
    ? `<img src="${markdown.utils.escapeHtml(asset.previewUrl)}" alt="${alt}">`
    : `<span class="image-placeholder">[图片：${alt}]</span>`;
};
const renderLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderLink ? renderLink(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};

function refreshPreview() {
  clearTimeout(previewTimer);
  const source = normalizeSource(editor.value);
  const previewSource = mode === 'word-to-md' ? wordSource?.markdown ?? '' : source;
  const empty = !previewSource.trim();
  $('empty-preview').hidden = !empty;
  preview.hidden = empty;
  updateExportControls();
  if (source.length > MAX_BYTES) {
    setStatus('Markdown 内容过长，请拆分为小于 5 MB 的文档再转换。', 'error');
    if (mode === 'md-to-word') preview.textContent = '内容过长，请拆分为小于 5 MB 的文档再转换。';
    exportButton.disabled = true;
    return;
  }
  try {
    const info = inspectMarkdown(source, images);
    $('stats').textContent = `${source.length.toLocaleString('zh-CN')} 字符 · ${info.tables} 个表格`;
    const previewInfo = mode === 'word-to-md' ? inspectMarkdown(previewSource, images) : info;
    // Markdown HTML is disabled; the only custom HTML comes from escaped image labels and <br> tokens.
    preview.innerHTML = markdown.renderer.render(previewInfo.tokens, markdown.options, {});
    for (const table of preview.querySelectorAll('table')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'table-scroll';
      table.replaceWith(wrapper);
      wrapper.append(table);
    }
    for (const li of preview.querySelectorAll('li')) {
      const node = li.firstElementChild?.tagName === 'P' ? li.firstElementChild.firstChild : li.firstChild;
      if (node?.nodeType === Node.TEXT_NODE && /^\[[ xX]\]\s/.test(node.textContent ?? '')) {
        node.textContent = node.textContent!.replace(/^\[([ xX])\]\s/, (_, check: string) => check === ' ' ? '☐  ' : '☑  ');
        li.style.listStyle = 'none';
      }
    }
    const notices = mode === 'word-to-md' ? [...conversionWarnings] : [];
    if (info.missingImages.length) notices.push(mode === 'word-to-md'
      ? `Markdown 中有 ${info.missingImages.length} 个图片引用未找到附件，请检查图片路径或重新导入 Word。`
      : `有 ${info.missingImages.length} 张图片未添加，导出时将保留文字说明。可点击「添加本地图片」；网络图片请先下载到本地。`);
    if (info.widestTable > 6 && orientation.value === 'portrait' && mode === 'md-to-word') notices.push('检测到列数较多的表格，建议选择「A4 横向」以留出更多空间。');
    $('notice').textContent = notices.join('\n');
    $('notice').hidden = notices.length === 0;
  } catch (error) {
    setStatus(`预览失败：${error instanceof Error ? error.message : '请检查 Markdown 内容'}`, 'error');
  }
}

function discardImages() {
  for (const asset of images.values()) if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl);
  images.clear();
  $('image-count').textContent = '';
  if (mode === 'word-to-md') { extractedImages = []; conversionWarnings = []; wordSource = null; }
}

function canReplace(): boolean {
  return !dirty || !editor.value.trim() || window.confirm('当前内容尚未导出，确定替换吗？');
}

async function importFile(file?: File) {
  if (!file) return;
  if (busy) return;
  if (mode === 'word-to-md') { await importWordFile(file); return; }
  if (!/\.(md|markdown|txt)$/i.test(file.name)) { setStatus('请选择 .md、.markdown 或 .txt 文件。', 'error'); return; }
  if (file.size > MAX_BYTES) { setStatus('文件超过 5 MB，请拆分后再导入。', 'error'); return; }
  if (!canReplace()) return;
  const version = ++importVersion;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let source: string;
    let encoding = '';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) source = new TextDecoder('utf-16le').decode(bytes);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) source = new TextDecoder('utf-16be').decode(bytes);
    else {
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { source = new TextDecoder('gb18030').decode(bytes); encoding = '，已按 GB18030 读取'; }
    }
    if (version !== importVersion) return;
    discardImages();
    editor.value = normalizeSource(source);
    filename.value = safeFilename(file.name.replace(/\.(md|markdown|txt)$/i, ''));
    $('source-label').textContent = file.name;
    dirty = true;
    refreshPreview();
    setStatus(`已导入 ${file.name}${encoding}。`, 'success');
  } catch { setStatus('文件读取失败，请重新选择文件。', 'error'); }
}

async function loadWord(bytes: ArrayBuffer, name: string) {
  const version = ++importVersion;
  const start = performance.now();
  setBusy(true); setStatus('正在本地读取 Word 文档…');
  try {
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const result = await convertWord(bytes);
    if (version !== importVersion) return;
    discardImages();
    extractedImages = result.images;
    conversionWarnings = result.warnings;
    for (const asset of extractedImages) {
      if (!asset.previewable) continue;
      const blob = new Blob([asset.data.slice().buffer as ArrayBuffer], { type: asset.mime });
      images.set(asset.path, { data: asset.data, type: 'png', width: 1, height: 1, previewUrl: URL.createObjectURL(blob) });
    }
    editor.value = result.markdown;
    wordSource = { markdown: result.markdown, name };
    filename.value = safeFilename(name.replace(/\.docx$/i, ''));
    $('source-label').textContent = name;
    dirty = Boolean(result.markdown || result.images.length);
    refreshPreview();
    setStatus(`转换完成 · ${((performance.now() - start) / 1000).toFixed(2)} 秒${result.images.length ? ` · 提取 ${result.images.length} 张图片` : ''}。${result.warnings.length ? '请留意下方转换提示。' : '可以编辑、复制或下载 Markdown。'}`, 'success');
  } catch (error) {
    if (version === importVersion) setStatus(`转换失败：${error instanceof Error ? error.message : '请检查文件是否完整、未加密'} 当前内容已保留。`, 'error');
  } finally { setBusy(false); }
}

async function importWordFile(file: File) {
  if (/\.doc$/i.test(file.name)) { setStatus('旧版 .doc 请先用 Word / LibreOffice 另存为 .docx，再导入。', 'error'); return; }
  if (!/\.docx$/i.test(file.name)) { setStatus('请选择 .docx 格式的 Word 文档。', 'error'); return; }
  if (file.size > 20 * 1024 * 1024) { setStatus('Word 文件超过 20 MB，请压缩图片或拆分后导入。', 'error'); return; }
  if (!canReplace()) return;
  setBusy(true);
  try { await loadWord(await file.arrayBuffer(), file.name); }
  catch { setStatus('文件读取失败，请重新选择文件。', 'error'); }
  finally { setBusy(false); }
}

input.addEventListener('change', () => { void importFile(input.files?.[0]); input.value = ''; });
$('drop-zone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
let dragDepth = 0;
document.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; $('workspace').classList.add('dragging'); } });
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; } });
document.addEventListener('dragleave', event => { if (event.dataTransfer?.types.includes('Files') && --dragDepth <= 0) { $('workspace').classList.remove('dragging'); dragDepth = 0; } });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('workspace').classList.remove('dragging');
  if (busy) return;
  const files = [...(event.dataTransfer?.files ?? [])];
  const documents = files.filter(file => /\.(md|markdown|txt|docx|doc)$/i.test(file.name));
  if (documents.length > 1) { setStatus('每次转换一个文件，请只拖入一个文档。', 'error'); return; }
  if (documents.length) {
    switchMode(/\.(docx|doc)$/i.test(documents[0].name) ? 'word-to-md' : 'md-to-word');
    void importFile(documents[0]);
  } else if (files.length) setStatus('请拖入 Markdown 或 .docx 文档。', 'error');
});

editor.addEventListener('input', () => {
  dirty = true;
  if (mode === 'md-to-word') $('source-label').textContent = '编辑中的内容';
  setStatus(mode === 'word-to-md' ? 'Markdown 已更新，可以复制或下载。' : '内容已更新，可以导出 Word。');
  updateExportControls();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 180);
});
editor.addEventListener('keydown', event => {
  if (busy) return;
  if (event.key === 'Tab') {
    event.preventDefault();
    editor.setRangeText('    ', editor.selectionStart, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input'));
  }
});
$('sample-button').addEventListener('click', async () => {
  if (!canReplace()) return;
  if (mode === 'word-to-md') {
    setBusy(true);
    try { const { blob } = await convertMarkdown(SAMPLE); await loadWord(await blob.arrayBuffer(), '项目周报.docx'); }
    catch { setStatus('示例生成失败，请重试。', 'error'); }
    finally { setBusy(false); }
    return;
  }
  importVersion++;
  discardImages(); editor.value = SAMPLE; filename.value = '项目周报';
  $('source-label').textContent = '示例内容'; dirty = false;
  refreshPreview(); setStatus('已载入示例，替换为你的内容即可转换。');
});
$('clear-button').addEventListener('click', () => {
  if (!canReplace()) return;
  importVersion++;
  discardImages(); editor.value = ''; filename.value = '未命名文档';
  $('source-label').textContent = mode === 'word-to-md' ? '等待 Word 文件' : '等待输入'; dirty = false;
  refreshPreview(); setStatus(mode === 'word-to-md' ? '已清空，导入新的 Word 文件即可开始。' : '已清空，导入文件或粘贴内容即可开始。');
  (mode === 'word-to-md' ? $('drop-zone') : editor).focus();
});
orientation.addEventListener('change', refreshPreview);
$('image-button').addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', async () => {
  const files = [...(imageInput.files ?? [])];
  imageInput.value = '';
  const version = importVersion;
  let added = 0;
  const failed: string[] = [];
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024 || !/\.(png|jpe?g|gif|bmp)$/i.test(file.name)) { failed.push(file.name); continue; }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url;
      await img.decode();
      const data = new Uint8Array(await file.arrayBuffer());
      if (version !== importVersion) { URL.revokeObjectURL(url); continue; }
      const ext = file.name.split('.').pop()!.toLowerCase();
      const key = imageKey(file.name);
      const old = images.get(key);
      if (old?.previewUrl) URL.revokeObjectURL(old.previewUrl);
      images.set(key, { data, width: img.naturalWidth, height: img.naturalHeight, type: ext === 'jpeg' ? 'jpg' : ext as LocalImage['type'], previewUrl: url });
      added++;
    } catch { URL.revokeObjectURL(url); failed.push(file.name); }
  }
  if (version !== importVersion) return;
  $('image-count').textContent = images.size ? ` (${images.size})` : '';
  if (added) dirty = true;
  refreshPreview();
  setStatus(failed.length ? `已添加 ${added} 张图片；${failed.length} 张无法读取（请使用不超过 15 MB 的 PNG、JPG、GIF 或 BMP）。` : `已添加 ${added} 张图片，将按文件名匹配文档中的引用。`, failed.length ? 'error' : 'success');
});

async function exportWord() {
  if (busy) return;
  const source = editor.value;
  if (!source.trim()) { setStatus('请先导入或输入 Markdown 内容。', 'error'); editor.focus(); return; }
  if (new Blob([source]).size > MAX_BYTES) { setStatus('内容超过 5 MB，请拆分后再转换。', 'error'); return; }
  setBusy(true);
  setStatus('正在本地生成 Word 文档…');
  const title = safeFilename(filename.value);
  filename.value = title;
  const start = performance.now();
  const selectedOrientation = orientation.value;
  try {
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const { blob, warnings } = await convertMarkdown(source, { title, landscape: selectedOrientation === 'landscape', images: new Map(images) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${title}.docx`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (editor.value === source) dirty = false;
    const seconds = ((performance.now() - start) / 1000).toFixed(2);
    setStatus(`已生成 ${title}.docx · 耗时 ${seconds} 秒。${warnings.length ? `有 ${warnings.length} 张图片保留为文字说明。` : '请在浏览器下载中查看。'}`, 'success');
  } catch (error) {
    setStatus(`转换失败：${error instanceof Error ? error.message : '请重试或缩小文档'}。原文仍保留在左侧。`, 'error');
  } finally {
    setBusy(false);
  }
}

async function exportMarkdown() {
  if (busy || (!editor.value.trim() && !extractedImages.length)) return;
  setBusy(true);
  const text = editor.value;
  try {
    const result = await packageMarkdown(text, filename.value, extractedImages);
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a'); link.href = url; link.download = result.filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    dirty = false;
    setStatus(`已生成 ${result.filename}。${extractedImages.length ? '解压后，保持 Markdown 与 images 文件夹放在一起。' : '请在浏览器下载中查看。'}`, 'success');
  } catch { setStatus('导出失败，请重试。Markdown 内容仍保留在编辑区。', 'error'); }
  finally { setBusy(false); }
}

$('copy-button').addEventListener('click', async () => {
  try {
    try { await navigator.clipboard.writeText(editor.value); }
    catch {
      const start = editor.selectionStart, end = editor.selectionEnd;
      editor.focus(); editor.select();
      const copied = document.execCommand('copy'); editor.setSelectionRange(start, end);
      if (!copied) throw new Error('copy failed');
    }
    setStatus(`已复制 Markdown。${extractedImages.length ? '图片请通过「导出 MD + 图片」一起下载。' : ''}`, 'success');
  } catch { setStatus('浏览器不允许自动复制，请选中右侧 Markdown 并按 Ctrl / ⌘ + C。', 'error'); }
});
const exportCurrent = () => mode === 'word-to-md' ? exportMarkdown() : exportWord();
exportButton.addEventListener('click', () => void exportCurrent());
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void exportCurrent(); } });
window.addEventListener('beforeunload', event => {
  if (dirty || Object.entries(drafts).some(([key, value]) => key !== mode && value.dirty)) { event.preventDefault(); event.returnValue = ''; }
});
preview.addEventListener('click', event => {
  const link = (event.target as HTMLElement).closest('a');
  if (link && !/^(https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) { event.preventDefault(); setStatus('此链接为相对路径或文档内链接，请在原始文档中查看。'); }
});
editor.placeholder = '# 在这里开始\n\n粘贴 Markdown 内容，或从上方导入文件。';
editor.value = SAMPLE;
refreshPreview();
if (document.body.dataset.defaultMode === 'word-to-md') switchMode('word-to-md');
