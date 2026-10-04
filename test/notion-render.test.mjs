import test from "node:test";
import assert from "node:assert/strict";
import { renderNativeNodes, packNode, requestBatches, plainText, maskLiteralMarkup, nativeNodesToMarkdown, richText } from "../lib/notion-render.mjs";

test("字面量列表前缀和首尾空格通过原生补写保留，不被 Markdown 重新解释", () => {
  for (const content of ["1. 这不是嵌套编号", "文字后保留空格 ", " 前置空格", "# 普通文字标题"]) {
    const nodes = renderNativeNodes([{ id: "text", parent_id: "p", type: "bull_list", content }], { docId: "p", signature: "s", version: 1 });
    const masked = maskLiteralMarkup(nodes), replacement = masked.replacements.find(r => r.sourceId === "text");
    assert.ok(replacement);
    assert.equal(plainText(replacement.payload.rich_text), content);
    assert.ok(nativeNodesToMarkdown(masked.nodes).replace(/\\_/g, "_").includes(replacement.placeholder));
  }
});

test("正文不混入子页内容，图片保持原位置且使用 Notion 文件", () => {
  const doc = { docId: "root", version: 1, editedAt: 2, signature: "a".repeat(64) };
  const nodes = renderNativeNodes([
    { id: "root", type: "page" },
    { id: "a", parent_id: "root", type: "text", content: [{ title: "前" }] },
    { id: "img", parent_id: "root", type: "image", media: { download_url: "https://example.com/image.png" } },
    { id: "b", parent_id: "root", type: "text", content: [{ title: "后" }] },
    { id: "child", parent_id: "root", type: "page" },
    { id: "childbody", parent_id: "child", type: "text", content: [{ title: "属于子页" }] },
  ], doc, new Map([["img", { uploadId: "upload-1" }]]));
  assert.deepEqual(nodes.map(n=>n.request.type), ["quote", "paragraph", "image", "paragraph"]);
  assert.equal(nodes[2].request.image.file_upload.id, "upload-1");
  assert.ok(!JSON.stringify(nodes).includes("属于子页"));
});

test("代码不额外插入 Markdown 转义，嵌套列表仍保持父子关系", () => {
  const nodes = renderNativeNodes([
    { id: "root", type: "page" },
    { id: "list", parent_id: "root", type: "bull_list", content: [{ title: "父项" }] },
    { id: "sub", parent_id: "list", type: "code", language: "JavaScript", content: [{ title: "const x = a_b[0];" }] },
  ], { docId: "root", version: 1, signature: "x" }, new Map());
  assert.equal(plainText(nodes[1].children[0].request.code.rich_text), "const x = a_b[0];");
  assert.equal(packNode(nodes[1]).bulleted_list_item.children[0].code.language, "javascript");
});

test("每批满足 Notion 的 100 块和大小上限", () => {
  const requests = Array.from({ length: 205 }, (_, i) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: String(i) } }] } }));
  const batches = requestBatches(requests);
  assert.equal(batches.flat().length, 205);
  assert.ok(batches.every(b => b.length <= 100));
});

test("超限媒体必须显式标记未复制并保留源链接，不伪装成功图片", () => {
  const warnings = new Set();
  const nodes = renderNativeNodes([{ id: "file", type: "file", parent_id: "root", file_size: 9000000 }], { docId: "root", version: 1, signature: "x" }, new Map([["file", { oversize: true, bytes: 9000000, limit: 5242880, filename: "原件.pdf", sourceUrl: "https://www.wolai.com/root#file" }]]), warnings);
  assert.equal(nodes[1].request.type, "paragraph");
  assert.ok(plainText(nodes[1].request.paragraph.rich_text).includes("原文件未复制"));
  assert.ok(warnings.has("media-exceeds-workspace-limit"));
});

test("HTML 代码分段传输保持逐字一致，Markdown 更新采用可恢复占位",()=>{
  const original='<script src="test.js">\nconsole.log(1);\n</script>\n<iframe onload="ready()"></iframe>';
  const runs=richText(original,{plain:true});
  assert.equal(plainText(runs),original);
  assert.ok(runs.every(run=>!run.text.content.includes("<script")));
  assert.ok(runs.every(run=>!run.text.content.includes("onload=")));
  const nodes=[{sourceId:"code",request:{object:"block",type:"code",code:{rich_text:runs,language:"html"}},children:[]}];
  const masked=maskLiteralMarkup(nodes);
  assert.equal(masked.replacements.length,1);
  assert.ok(!nativeNodesToMarkdown(masked.nodes).includes("<script"));
  assert.equal(plainText(masked.replacements[0].payload.rich_text),original);
});

test("编辑器文件 ZIP 附件必须可见标注，不能冒充原生绘图文件", () => {
  const warnings = new Set();
  const nodes = renderNativeNodes([{ id: "file", parent_id: "source", type: "file" }], { docId: "source", version: 1, signature: "x" }, new Map([["file", {
    uploadId: "zip-upload", filename: "图表.drawio.zip", contentType: "application/zip", archive: { filename: "图表.drawio", format: "zip" },
  }]]), warnings);
  assert.equal(nodes[1].request.type, "file");
  assert.equal(nodes[1].request.file.name, "图表.drawio.zip");
  assert.match(plainText(nodes[1].request.file.caption), /无损封装为 ZIP/);
  assert.ok(warnings.has("media-original-file-zipped"));
});
