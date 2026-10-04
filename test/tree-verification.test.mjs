import test from "node:test";
import assert from "node:assert/strict";
import { verifyTreeDocuments, verificationStateFingerprint, canAcceptVerification } from "../lib/tree-verification.mjs";
import { bodyFingerprint, digest } from "../lib/sync-safety.mjs";

function fixture() {
  const docs = [
    { docId: "a", title: "根笔记", depth: 0, parentDocId: null },
    { docId: "b", title: "浅层笔记", depth: 1, parentDocId: "a" },
    { docId: "c", title: "深层笔记", depth: 2, parentDocId: "b" },
    { docId: "d", title: "浅层笔记二", depth: 1, parentDocId: "a" },
  ];
  const state = { rootPageId: "root", documents: {} }, pages = new Map(), markdown = new Map(), reads = [];
  for (const doc of docs) {
    Object.assign(doc, { status: "ready", version: 1, signature: digest(doc.docId), bodyHash: digest(`body-${doc.docId}`) });
    const id = `target-${doc.docId}`, content = `> 来源：wolai · doc_id: ${doc.docId} · version: 1\n\n原始正文 ${doc.docId}`;
    state.documents[doc.docId] = { notionPageId: id, hierarchyVersion: 2, status: "synced", sourceVersion: 1, sourceSignature: doc.signature, sourceBodyHash: doc.bodyHash, parentDocId: doc.parentDocId, lastNotionBodyHash: bodyFingerprint(content) };
    pages.set(id, { id, parent: { type: "page_id", page_id: doc.parentDocId ? `target-${doc.parentDocId}` : "root" } });
    markdown.set(id, { markdown: content, truncated: false, unknown_block_ids: [] });
  }
  const opts = {
    docs, tree: { documents: docs, total: docs.length, maxDepth: 2, failedCount: 0, scannedAt: new Date().toISOString(), scanPolicy: "full-block-fingerprint" }, state, rootPageId: "root", full: true, report: {},
    catalog: { get: async id => pages.get(id), ancestry: async () => [{}] },
    notion: { retrievePageMarkdown: async id => { reads.push(id); return markdown.get(id); } },
  };
  return { opts, state, pages, markdown, reads };
}

test("全量验收逐页读取所有来源标识，不只读最深层", async () => {
  const f = fixture(), report = await verifyTreeDocuments(f.opts);
  assert.equal(f.reads.length, 4);
  assert.equal(report.contentChecked, 4);
  assert.equal(report.contentPassed, 4);
  assert.equal(report.bodyFingerprintChecked, 4);
  assert.equal(report.bodyFingerprintPassed, 4);
  assert.equal(report.failed, 0);
});

test("浅层页面标识错误必须使全量验收失败", async () => {
  const f = fixture();
  f.markdown.get("target-b").markdown = f.markdown.get("target-b").markdown.replace("doc_id: b", "doc_id: impostor");
  const report = await verifyTreeDocuments(f.opts);
  assert.equal(report.failed, 1);
  assert.equal(report.contentChecked, 4);
  assert.equal(report.details.find(d => d.docId === "b").result, "failed");
});

test("来源标识未变但目标正文被手工修改，验收仍失败", async () => {
  const f = fixture();
  f.markdown.get("target-b").markdown += "\n手工增加的内容";
  const report = await verifyTreeDocuments(f.opts);
  assert.equal(report.failed, 1);
  assert.equal(report.bodyFingerprintPassed, 3);
});

test("浅层页面读取失败不能计入通过", async () => {
  const f = fixture(), read = f.opts.notion.retrievePageMarkdown;
  f.opts.notion.retrievePageMarkdown = async id => { if (id === "target-b") throw new Error("fetch failed"); return read(id); };
  const report = await verifyTreeDocuments(f.opts);
  assert.equal(report.failed, 1);
  assert.equal(report.contentPassed, 3);
});

test("验收保留目标 ID 唯一性检查", async () => {
  const f = fixture();
  f.state.documents.d.notionPageId = f.state.documents.b.notionPageId;
  const report = await verifyTreeDocuments(f.opts);
  assert.equal(report.duplicateTargetIds, 1);
});

async function completeReport(f) {
  const report = await verifyTreeDocuments(f.opts);
  return Object.assign(report, { verificationSchema: 2, scope: "full", completedAt: new Date().toISOString(), rootPageId: "root",
    sourceSnapshot: f.opts.tree.scannedAt, stateFingerprint: verificationStateFingerprint(f.opts.tree, f.state), expected: 4, checked: 4,
    mediaSamplesRequested: 3, media: [], mediaFilesChecked: 0, mediaFilesPassed: 0 });
}

test("仅接受完整且绑定当前源清单与状态的全库报告", async () => {
  const f = fixture(), report = await completeReport(f);
  assert.equal(canAcceptVerification(report, f.opts.tree, f.state, "root"), true);
  for (const change of [{ verificationSchema: 1 }, { contentChecked: 1 }, { bodyFingerprintPassed: 3 }, { failed: 1 }, { missing: 1 },
    { duplicateTargetIds: 1 }, { sourceSnapshot: "old" }, { stateFingerprint: "old" }, { completedAt: null }, { mediaSamplesRequested: 0 }, { rootPageId: "outside" }]) {
    assert.equal(canAcceptVerification({ ...report, ...change }, f.opts.tree, f.state, "root"), false);
  }
  f.state.documents.b.lastNotionBodyHash = "changed-after-verification";
  assert.equal(canAcceptVerification(report, f.opts.tree, f.state, "root"), false);
});

test("过期源清单和空媒体验收不能触发恢复每日同步", async () => {
  const f = fixture(), report = await completeReport(f);
  const oldTree = { ...f.opts.tree, scannedAt: "2020-01-01T00:00:00Z" };
  assert.equal(canAcceptVerification({ ...report, sourceSnapshot: oldTree.scannedAt }, oldTree, f.state, "root"), false);
  f.state.documents.a.assetCount = 1;
  report.stateFingerprint = verificationStateFingerprint(f.opts.tree, f.state);
  report.media = [{ docId: "a", count: 0, orderedSha256Match: true }];
  assert.equal(canAcceptVerification(report, f.opts.tree, f.state, "root"), false);
});
