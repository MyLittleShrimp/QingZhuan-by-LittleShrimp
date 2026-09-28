import MarkdownIt from 'markdown-it';

export const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

// A deliberate exception to literal HTML: table cell line breaks are common in Markdown.
markdown.inline.ruler.before('text', 'cell_break', (state, silent) => {
  const match = /^<br\s*\/?\s*>/i.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) state.push('hardbreak', 'br', 0);
  state.pos += match[0].length;
  return true;
});

export const SAMPLE = `# 项目周报

把想法写进 Markdown，把文档交给 Word。

## 本周进展

支持 **加粗**、*斜体*、~~删除线~~ 和 \`行内代码\`，保留清晰的文档层级。

| 事项 | 状态 | 完成度 |
| :--- | :---: | ---: |
| 需求整理 | 已完成 | 100% |
| 页面设计 | 进行中 | 80% |
| 文档交付 | 待开始 | 0% |

## 下一步

1. 整理反馈与改进建议
2. 完成验收并交付文档

- [x] 表格可在 Word 中继续编辑
- [ ] 补充项目说明

> 专注内容，格式交给工具。
`;

export function normalizeSource(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    // XML 1.0 cannot represent these characters; preserve tabs, CR and LF.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

export function safeFilename(value: string): string {
  const name = value.replace(/\.docx$/i, '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim().replace(/[. ]+$/g, '').slice(0, 100);
  if (!name) return '未命名文档';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}
