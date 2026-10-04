import test from "node:test";
import assert from "node:assert/strict";
import { scopedSourceTree, inSyncScope, sourceRootIds } from "../lib/sync-scope.mjs";
import { notionRootIds, expectedNotionParent } from "../lib/notion-locations.mjs";

const config = { notionRoot: { pageId: "export" }, presentation: { archivePageId: "archive", keepSourceRootIds: [] }, syncScope: { sourceRootIds: ["daily"] } };
test("旧全库快照只保留日计划表及任意层后代，归档及其失败项均不进入写入范围", () => {
  const tree = { total: 5, documents: [
    { docId: "daily", parentDocId: null, ancestorIds: [], status: "ready" },
    { docId: "day", parentDocId: "daily", ancestorIds: ["daily"], status: "ready" },
    { docId: "deep", parentDocId: "day", ancestorIds: ["daily", "day"], status: "ready" },
    { docId: "archive-note", parentDocId: null, ancestorIds: [], status: "ready" },
    { docId: "failed-other", parentDocId: "archive-note", ancestorIds: ["archive-note"], status: "failed" },
  ] };
  const result = scopedSourceTree(tree, config);
  assert.deepEqual(result.documents.map(d => d.docId), ["daily", "day", "deep"]);
  assert.equal(result.total, 3); assert.equal(result.failedCount, 0); assert.equal(result.maxDepth, 2);
  assert.equal(tree.documents.length, 5);
  assert.equal(inSyncScope(tree.documents[3], config), false);
  assert.deepEqual(notionRootIds(config), ["export"]);
  assert.equal(expectedNotionParent(result.documents[0], { documents: {} }, config), "export");
});
test("缺少同步根或空范围时明确失败，不悄悄恢复全库同步", () => {
  assert.throws(() => scopedSourceTree({ documents: [] }, config), /缺少/);
  assert.throws(() => sourceRootIds({ syncScope: { sourceRootIds: [] } }), /非空/);
});
