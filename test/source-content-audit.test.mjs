import test from "node:test";
import assert from "node:assert/strict";
import { auditSourceText, markdownMediaCount } from "../lib/source-content-audit.mjs";

test("源正文覆盖检查发现本地成功基线之外的缺失内容", () => {
  const blocks = [{ id: "p", type: "page" }, { id: "a", type: "text", parent_id: "p", content: [{ title: "第一段" }] }, { id: "b", type: "text", parent_id: "p", content: [{ title: "第二段" }] }];
  assert.deepEqual(auditSourceText(blocks, "p", "> 来源：wolai\n第一段").missing, [{ blockId: "b", type: "text", unmatchedSegments: 1 }]);
  assert.equal(auditSourceText(blocks, "p", "> 来源：wolai\n**第一段**\n第二段").missing.length, 0);
});

test("父页正文覆盖不以子页面标题冒充正文", () => {
  const blocks = [{ id: "p", type: "page" }, { id: "a", type: "text", parent_id: "p", content: "应有的正文" }];
  const md = '> 来源：wolai\n<page url="https://www.notion.so/11111111111111111111111111111111">应有的正文</page>';
  assert.equal(auditSourceText(blocks, "p", md).missing.length, 1);
});

test("图片和文件数量检查排除代码里的示例", () => {
  const md = '![图片](https://example.com/a)\n\t<file src="https://example.com/b">附件</file>\n```md\n![示例](https://example.com/c)\n```';
  assert.equal(markdownMediaCount(md), 2);
});

test("原生正文复核保留代码运算符，不用格式归一化掩盖差异", () => {
  const blocks = [{ id: "code", type: "code", parent_id: "p", content: "a > b" }];
  assert.equal(auditSourceText(blocks, "p", "a b", { native: true }).missing.length, 1);
  assert.equal(auditSourceText(blocks, "p", "a > b", { native: true }).missing.length, 0);
});
