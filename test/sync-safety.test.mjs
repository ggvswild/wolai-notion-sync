import test from "node:test";
import assert from "node:assert/strict";
import { sourceMarker, bodyFingerprint, preserveChildPages, validateTarget, pendingDocuments } from "../lib/sync-safety.mjs";

test("来源标识必须完整一致，正文中的相似 ID 不算", () => {
  assert.deepEqual(sourceMarker("> 来源：wolai · doc\\_id: abc123 · version: 7 · edited\\_at: 1\n\n正文"), { docId: "abc123", version: "7", payload: null });
  assert.equal(sourceMarker("正文 abc123"), null);
  assert.equal(sourceMarker("来源：wolai · doc_id: abc123 · version: 7").docId, "abc123");
  assert.equal(sourceMarker("> 来源：wolai · doc_id: abc1234 · version: 7").docId, "abc1234");
});

test("父页内容指纹忽略自动出现的子页面，但不忽略手工文本", () => {
  const body = "> 来源：wolai · doc_id: abc · version: 1\n\n正文\n";
  const children = '<page url="https://www.notion.so/123">孩子</page>\n';
  assert.equal(bodyFingerprint(body), bodyFingerprint(body + children));
  assert.notEqual(bodyFingerprint(body), bodyFingerprint(body + "手工备注"));
});

test("代码块中的 page 示例不是实际子页面，不能从指纹中去除", () => {
  const a = '```xml\n<page url="https://example.com/a">示例</page>\n```';
  const b = a.replace("/a", "/b");
  assert.notEqual(bodyFingerprint(a), bodyFingerprint(b));
  assert.equal(preserveChildPages(a, "新正文"), "新正文\n");
});

test("更新父页保留所有已有子页面与数据库，不允许删除", () => {
  const children = '<page url="https://www.notion.so/123">孩子</page>\n<database url="https://www.notion.so/456" inline="true">数据</database>';
  const result = preserveChildPages(`旧正文\n${children}`, "新正文");
  assert.ok(result.includes(children));
  assert.ok(result.startsWith("新正文"));
});

test("手工修改及来源标识冲突阻止覆盖", () => {
  const old = "> 来源：wolai · doc_id: abc · version: 1\n\n正文";
  const record = { sourceVersion: 1, lastNotionBodyHash: bodyFingerprint(old), targetTitle: "标题" };
  assert.throws(() => validateTarget({ docId: "abc" }, record, { title: "标题", markdown: `${old}\n手工内容` }), /手工/);
  assert.throws(() => validateTarget({ docId: "abcd" }, record, { title: "标题", markdown: old }), /来源/);
  assert.doesNotThrow(() => validateTarget({ docId: "abc" }, record, { title: "标题", markdown: old }));
});

test("重试未成功版本，并优先处理父级，批量严格限额", () => {
  const tree = { documents: [{ docId: "child", parentDocId: "root", depth: 1, version: 2, signature: "b", status: "ready" }, { docId: "root", parentDocId: null, depth: 0, version: 1, signature: "a", status: "ready" }] };
  const state = { documents: { root: { notionPageId: "notion-root", status: "synced", sourceVersion: 1, sourceSignature: "a", hierarchyVersion: 2 }, child: { notionPageId: "notion-child", status: "failed", sourceVersion: 1, sourceSignature: "old", hierarchyVersion: 2 } } };
  assert.deepEqual(pendingDocuments(tree, state, 1).map(d => d.docId), ["child"]);
  assert.deepEqual(pendingDocuments(tree, { documents: {} }, 1).map(d => d.docId), ["root"]);
});

test("只改正文块而页面版本不变也会进入增量队列",()=>{
  const tree={documents:[{docId:"d",parentDocId:null,depth:0,version:1,signature:"same",bodyHash:"new",status:"ready"}]};
  const state={documents:{d:{notionPageId:"p",status:"synced",hierarchyVersion:2,sourceVersion:1,sourceSignature:"same",sourceBodyHash:"old"}}};
  assert.equal(pendingDocuments(tree,state).length,1);
  state.documents.d.sourceBodyHash="new";
  assert.equal(pendingDocuments(tree,state).length,0);
});

test("结构补写尚未读回完成时，旧成功版本不能产生剩余零的结论", () => {
  const tree = { documents: [{ docId: "d", parentDocId: null, depth: 0, version: 1, signature: "same", bodyHash: "body", status: "ready" }] };
  const state = { documents: { d: { notionPageId: "p", status: "synced", hierarchyVersion: 2, sourceVersion: 1, sourceSignature: "same", sourceBodyHash: "body", pendingStructureRepair: { sourceSignature: "same" } } } };
  assert.equal(pendingDocuments(tree, state).length, 1);
  state.documents.d.pendingStructureRepair = null;
  assert.equal(pendingDocuments(tree, state).length, 0);
});
