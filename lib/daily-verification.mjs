import { digest, normalizeId, pendingDocuments } from "./sync-safety.mjs";
import { desiredChildIds, pendingChildOrders } from "./page-order.mjs";

export function dailyVerificationFingerprint(tree, state) {
  return digest(JSON.stringify(tree.documents.map(doc => {
    const row = state.documents[doc.docId] ?? {};
    return [doc.docId, doc.signature, doc.bodyHash, doc.parentDocId, doc.childIds,
      row.notionPageId, row.notionParentId, row.sourceVersion, row.sourceSignature, row.sourceBodyHash,
      row.lastNotionBodyHash, row.status, row.childOrderSignature, row.pendingStructureRepair, row.pendingOrderMove];
  })));
}

export function canAcceptDailyVerification(report, tree, state, config) {
  if (!report || report.verificationSchema !== 3 || report.scope !== "daily-tree-full" || !report.completedAt || report.stopped) return false;
  if (normalizeId(report.rootPageId) !== normalizeId(config.notionRoot.pageId) || normalizeId(state.rootPageId) !== normalizeId(config.notionRoot.pageId)) return false;
  if (!config.navigation?.orderedSourceRoots?.includes(report.rootId)) return false;
  if (tree.documents.some(doc => doc.docId !== report.rootId && !doc.ancestorIds.includes(report.rootId))) return false;
  if (tree.failedCount || pendingDocuments(tree, state).length || pendingChildOrders(tree, state, config).length) return false;
  const scannedAt = Date.parse(tree.scannedAt);
  if (report.sourceSnapshot !== tree.scannedAt || !Number.isFinite(scannedAt) || Date.now() - scannedAt > 86400000 || scannedAt > Date.now() + 60000) return false;
  if (report.stateFingerprint !== dailyVerificationFingerprint(tree, state)) return false;
  if (report.expected !== tree.total || report.checked !== tree.total || report.passed !== tree.total || report.details?.length !== tree.total) return false;
  if (["failed", "duplicateTargetIds", "textCoverageFailed", "mediaCountFailed", "orderMismatches"].some(key => report[key] !== 0)) return false;
  if (!Number.isInteger(report.mediaExpected) || report.mediaChecked !== report.mediaExpected || report.mediaPagesChecked !== report.sourceMediaPages) return false;
  if (report.mediaExpected + report.exceptions?.oversizedSourceLinks !== report.sourceMediaCount) return false;
  if (report.orderedParents !== tree.documents.filter(doc => desiredChildIds(doc, tree).length).length || !(report.textSegmentsChecked > 0)) return false;
  const rows = new Map(report.details.map(row => [row.docId, row]));
  if (rows.size !== tree.total) return false;
  return tree.documents.every(doc => {
    const row = rows.get(doc.docId), record = state.documents[doc.docId];
    return row?.result === "passed" && normalizeId(row.notionPageId) === normalizeId(record.notionPageId) &&
      row.bodyHash === record.lastNotionBodyHash && row.sourceSignature === doc.signature && row.sourceBodyHash === doc.bodyHash;
  });
}
