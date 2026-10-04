import { mapPool } from "./source-tree.mjs";
import { normalizeId, sourceMarker, digest, pendingDocuments, validateTarget, safeError } from "./sync-safety.mjs";
import { pageTitle } from "./notion-catalog.mjs";
import { expectedNotionParent } from "./notion-locations.mjs";

export function verificationStateFingerprint(tree, state) {
  return digest(JSON.stringify(tree.documents.map(doc => {
    const row = state.documents[doc.docId] ?? {};
    return [doc.docId, doc.signature, doc.bodyHash, doc.parentDocId, row.notionPageId, row.notionParentId,
      row.sourceVersion, row.sourceBodyHash, row.lastNotionBodyHash, row.targetTitle, row.status, row.hierarchyVersion,
      row.assetCount, row.mediaExceptions, row.mediaArchives, row.contentFallback?.mode];
  })));
}

export function canAcceptVerification(report, tree, state, rootPageId) {
  if (!report || report.verificationSchema !== 2 || report.scope !== "full" || !report.completedAt) return false;
  if (tree.scanPolicy !== "full-block-fingerprint" || tree.failedCount || pendingDocuments(tree, state).length) return false;
  const scannedAt = Date.parse(tree.scannedAt);
  if (!Number.isFinite(scannedAt) || Date.now() - scannedAt > 24 * 3600000 || scannedAt > Date.now() + 60000) return false;
  if (normalizeId(state.rootPageId) !== normalizeId(rootPageId)) return false;
  if (report.sourceSnapshot !== tree.scannedAt || normalizeId(report.rootPageId) !== normalizeId(rootPageId)) return false;
  if (report.stateFingerprint !== verificationStateFingerprint(tree, state)) return false;
  if (["expected", "checked", "hierarchyPassed", "contentChecked", "contentPassed", "bodyFingerprintChecked", "bodyFingerprintPassed"].some(key => report[key] !== tree.total)) return false;
  if (report.failed !== 0 || report.missing !== 0 || report.duplicateTargetIds !== 0) return false;
  const mediaPages = tree.documents.filter(doc => state.documents[doc.docId]?.assetCount > 0 && state.documents[doc.docId]?.hierarchyVersion === 2).length;
  if (report.mediaSamplesRequested !== 3 || report.media?.length !== Math.min(3, mediaPages)) return false;
  if (report.media?.some(row => row.error || !row.orderedSha256Match)) return false;
  return Number.isInteger(report.mediaFilesChecked) && report.mediaFilesChecked >= (mediaPages ? 1 : 0) && report.mediaFilesChecked === report.mediaFilesPassed;
}

export async function verifyTreeDocuments({ docs, tree, state, catalog, notion, rootPageId, config = { notionRoot: { pageId: rootPageId } }, full = false, report, onProgress = async () => {} }) {
  for (const key of ["hierarchyPassed", "missing", "failed", "contentChecked", "contentPassed", "bodyFingerprintChecked", "bodyFingerprintPassed"]) report[key] ??= 0;
  report.details ??= [];
  const targetIds = Object.values(state.documents).filter(r => r.notionPageId).map(r => normalizeId(r.notionPageId));
  report.duplicateTargetIds = targetIds.length - new Set(targetIds).size;
  await mapPool(docs, 4, async doc => {
    const record = state.documents[doc.docId], result = { docId: doc.docId, title: doc.title, depth: doc.depth };
    try {
      if (!record?.notionPageId || record.hierarchyVersion !== 2 || !["synced", "synced_with_exceptions"].includes(record.status)) {
        result.result = "not-complete"; report.missing += 1; return;
      }
      const page = await catalog.get(record.notionPageId, !full);
      const expectedParent = expectedNotionParent(doc, state, config);
      if (!expectedParent || normalizeId(page.parent?.page_id) !== normalizeId(expectedParent) || page.archived || page.in_trash) throw new Error("实际父级不匹配或页面已删除");
      if (!(await catalog.ancestry(page.id))) throw new Error("实际页面脱离目标根目录");
      report.hierarchyPassed += 1;
      result.result = "passed"; result.notionPageId = page.id; result.parentPageId = page.parent.page_id;
      const md = await notion.retrievePageMarkdown(page.id), marker = sourceMarker(md.markdown);
      report.contentChecked += 1;
      if (marker?.docId !== doc.docId || marker.version !== String(record.sourceVersion) || md.truncated || md.unknown_block_ids?.length) throw new Error("来源或版本读回不一致");
      report.contentPassed += 1; result.sourceMarkerVerified = true;
      report.bodyFingerprintChecked += 1;
      if (!record.lastNotionBodyHash) throw new Error("缺少目标正文校验基线，不能宣布验收通过");
      validateTarget(doc, record, { ...md, title: pageTitle(page) });
      report.bodyFingerprintPassed += 1; result.bodyFingerprintVerified = true;
    } catch (error) {
      report.failed += 1; result.result = "failed"; result.error = safeError(error);
    } finally {
      report.details.push(result);
      await onProgress(report);
    }
  });
  return report;
}
