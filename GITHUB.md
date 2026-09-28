# GitHub 发布资料

## 仓库名称

仓库：[MyLittleShrimp/QingZhuan-by-LittleShrimp](https://github.com/MyLittleShrimp/QingZhuan-by-LittleShrimp)，软件显示名称为 **轻转 MDWord**。

## 仓库简介（About / Description）

```text
轻转 MDWord：本地离线的 Markdown ↔ Word 双向转换工具。无需 AI，文件不上传，支持表格与图片，单个 HTML 文件双击即用。
```

英文简介（可选）：

```text
MDWord — an offline Markdown ↔ Word converter with table and image support. A single HTML file. No AI, no uploads, no setup.
```

## Topics

```text
markdown docx word converter offline local-first typescript document-converter
```

## 维护源码

源码、README、截图和可直接运行的 `轻转.html` 均位于此仓库。仓库 About 可使用上面的简介和 Topics。

在新电脑上获取项目：

```bash
git clone https://github.com/MyLittleShrimp/QingZhuan-by-LittleShrimp.git
cd QingZhuan-by-LittleShrimp
npm ci
```

修改后先检查、测试并构建，再提交源码和新的 HTML：

```bash
npm run check
npm test
npm run build
git add .
git commit -m "Update Qingzhuan"
git push
```

源码包已经排除依赖、缓存、本地测试文件和安装脚本。当前未添加项目许可证；如果决定开放复用，可在仓库中补充所选许可证的 `LICENSE` 文件。

## 发布离线版

创建 GitHub Release，建议标签为 `v1.0.0`，标题为 **轻转 v1.0.0**。上传附件 `qingzhuan-1.0.0-offline.zip`，也可以额外上传独立的 `轻转.html`。

以下内容可直接作为 Release 说明：

---

轻转，让 Markdown 与 Word 在本地轻松互转。

- MD → Word：保留标题、列表、代码、链接和可编辑表格，支持本地图片与 A4 横向页面。
- Word → MD：提取正文、表格和嵌入图片，支持编辑、复制及 Markdown / 图片 ZIP 导出。
- 双击 HTML 即可使用，无需 AI、账号或服务器，文件不上传。

**使用方法：** 下载并解压离线版 ZIP，双击 `轻转.html`，选择转换方向并导入文件。

支持未加密的 `.docx`；旧版 `.doc` 请先另存为 `.docx`。合并单元格会展开，复杂 Word 版式可能简化，详细说明见 README。
