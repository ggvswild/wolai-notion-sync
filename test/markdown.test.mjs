import test from "node:test";
import assert from "node:assert/strict";
import { blocksToMarkdown, identityKey, normalizeTitle, safeFilename } from "../lib/markdown.mjs";

test("normalizeTitle 统一日期分隔符与空白", () => {
  assert.equal(normalizeTitle(" 2025/2/6  周四 "), "2025-02-06 周四");
});

test("identityKey 用日期认领不同标题后缀的同一天笔记", () => {
  assert.equal(identityKey("2025/02/06 周四"), identityKey("2025-02-06 - 日计划表"));
});

test("safeFilename 移除文件系统保留字符", () => {
  assert.equal(safeFilename("2025/02/06: 日计划"), "2025-02-06- 日计划");
});

test("blocksToMarkdown 转换常用块并写入源标识", () => {
  const markdown = blocksToMarkdown(
    [
      { id: "doc", type: "page", parent_id: "workspace" },
      { id: "h", type: "heading", level: 2, parent_id: "doc", content: [{ title: "任务" }] },
      { id: "t", type: "todo_list", checked: true, parent_id: "doc", content: [{ title: "完成" }] },
      { id: "c", type: "code", language: "js", parent_id: "doc", content: [{ title: "console.log(1)" }] },
    ],
    { docId: "doc", title: "示例", version: 7, editedAt: 123 },
  );
  assert.doesNotMatch(markdown, /^# 示例/);
  assert.match(markdown, /doc_id: doc · version: 7/);
  assert.match(markdown, /## 任务/);
  assert.match(markdown, /- \[x\] 完成/);
  assert.match(markdown, /```js\nconsole\.log\(1\)\n```/);
});

test("blocksToMarkdown 规范化代码语言大小写", () => {
  const markdown = blocksToMarkdown(
    [
      { id: "doc", type: "page", parent_id: "workspace" },
      { id: "c", type: "code", language: "JavaScript", parent_id: "doc", content: [{ title: "const x = 1" }] },
    ],
    { docId: "doc", title: "示例", version: 1, editedAt: 1 },
  );
  assert.match(markdown, /```javascript\nconst x = 1\n```/);
});

test("blocksToMarkdown 不把嵌套子页面内容悬空写进父页", () => {
  const markdown = blocksToMarkdown(
    [
      { id: "doc", type: "page", parent_id: "workspace" },
      { id: "nested", type: "page", parent_id: "doc" },
      { id: "nested-text", type: "text", parent_id: "nested", content: [{ title: "子页面私有内容" }] },
      { id: "root-text", type: "text", parent_id: "doc", content: [{ title: "父页面内容" }] },
    ],
    { docId: "doc", title: "示例", version: 1, editedAt: 1 },
  );
  assert.doesNotMatch(markdown, /子页面私有内容/);
  assert.match(markdown, /父页面内容/);
});
