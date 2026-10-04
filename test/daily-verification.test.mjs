import test from "node:test";
import assert from "node:assert/strict";
import { dailyVerificationFingerprint, canAcceptDailyVerification } from "../lib/daily-verification.mjs";

function fixture() {
  const tree = { total: 1, failedCount: 0, scannedAt: new Date().toISOString(), documents: [{ docId: "r", parentDocId: null, ancestorIds: [], childIds: [], status: "ready", version: 1, signature: "s", bodyHash: "b" }] };
  const state = { rootPageId: "export", documents: { r: { notionPageId: "p", status: "synced", sourceVersion: 1, sourceSignature: "s", sourceBodyHash: "b", hierarchyVersion: 2, lastNotionBodyHash: "target" } } };
  const config = { notionRoot: { pageId: "export" }, navigation: { orderedSourceRoots: ["r"] } };
  const report = { verificationSchema: 3, scope: "daily-tree-full", completedAt: new Date().toISOString(), stopped: false, rootId: "r", rootPageId: "export", sourceSnapshot: tree.scannedAt,
    expected: 1, checked: 1, passed: 1, failed: 0, duplicateTargetIds: 0, textCoverageFailed: 0, mediaCountFailed: 0, orderMismatches: 0, orderedParents: 0, textSegmentsChecked: 1,
    mediaExpected: 1, mediaChecked: 1, mediaPagesChecked: 1, sourceMediaPages: 1, sourceMediaCount: 1, exceptions: { oversizedSourceLinks: 0 },
    details: [{ docId: "r", notionPageId: "p", result: "passed", bodyHash: "target", sourceSignature: "s", sourceBodyHash: "b" }], stateFingerprint: dailyVerificationFingerprint(tree, state) };
  return { tree, state, config, report };
}

test("日计划表验收要求完整正文、目录和媒体证据绑定当前状态", () => {
  const f = fixture(); assert.equal(canAcceptDailyVerification(f.report, f.tree, f.state, f.config), true);
  for (const change of [{ checked: 0 }, { verificationSchema: 2 }, { mediaChecked: 0 }, { failed: 1 }, { stopped: true }, { details: [] }]) {
    assert.equal(canAcceptDailyVerification({ ...f.report, ...change }, f.tree, f.state, f.config), false);
  }
});

test("修复未结束、旧基线和不完整媒体验收不能被当成成功", () => {
  const f = fixture(); f.state.documents.r.lastNotionBodyHash = "changed";
  assert.equal(canAcceptDailyVerification(f.report, f.tree, f.state, f.config), false);
  f.state.documents.r.lastNotionBodyHash = "target"; f.state.documents.r.pendingStructureRepair = {};
  f.report.stateFingerprint = dailyVerificationFingerprint(f.tree, f.state);
  assert.equal(canAcceptDailyVerification(f.report, f.tree, f.state, f.config), false);
});
