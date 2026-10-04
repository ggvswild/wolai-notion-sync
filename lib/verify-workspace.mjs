import { join } from "node:path";
import { readJson, writeJson } from "./storage.mjs";
import { scopedSourceTree } from "./sync-scope.mjs";
import { NotionRestClient } from "./notion-rest-client.mjs";
import { NotionCatalog } from "./notion-catalog.mjs";
import { pendingDocuments, digest, normalizeId, safeError } from "./sync-safety.mjs";
import { pendingChildOrders, desiredChildIds } from "./page-order.mjs";
import { verifyTreeDocuments, verificationStateFingerprint, canAcceptVerification } from "./tree-verification.mjs";
import { auditSourceText } from "./source-content-audit.mjs";
import { ownBlocks, plainText } from "./notion-render.mjs";

// This command only reads remote pages/files. No markdown round-trip writes.
export async function verifyWorkspace({ baseDir, config, state, notion = new NotionRestClient() }) {
  const tree = scopedSourceTree(await readJson(join(baseDir, "source-tree.json")), config);
  const at = Date.parse(tree.scannedAt);
  if (tree.scanPolicy !== "full-block-fingerprint" || tree.failedCount || !Number.isFinite(at) || Date.now() - at > 86400000 || at > Date.now() + 60000 || pendingDocuments(tree, state).length || pendingChildOrders(tree, state, config).length) throw new Error("请先完成最新完整源扫描、正文和目录增量，不能验收旧快照或待处理页");
  const catalog = new NotionCatalog(notion, config.notionRoot.pageId);
  const report = { verificationSchema: 2, scope: "full", verifiedAt: new Date().toISOString(), rootPageId: config.notionRoot.pageId, sourceSnapshot: tree.scannedAt, stateFingerprint: verificationStateFingerprint(tree, state), expected: tree.total, checked: tree.total,
    mediaSamplesRequested: 3, mediaFilesChecked: 0, mediaFilesPassed: 0, media: [], details: [], coveragePassed: 0, coverageFailed: 0, orderedParents: 0, orderFailed: 0,
    exceptions: { oversizedSourceLinks: 0, zippedOriginalFiles: 0, archivedPages: 0, databaseContainers: 0, formatWarningPages: 0 } };
  await catalog.refresh();
  await verifyTreeDocuments({ docs: tree.documents, tree, state, catalog, notion, rootPageId: config.notionRoot.pageId, config, full: true, report });
  for (const doc of tree.documents) {
    const record = state.documents[doc.docId];
    report.exceptions.oversizedSourceLinks += record.mediaExceptions?.length ?? 0;
    report.exceptions.zippedOriginalFiles += record.mediaArchives?.length ?? 0;
    report.exceptions.archivedPages += Number(record.contentFallback?.mode === "archive");
    report.exceptions.databaseContainers += Number(doc.sourceType === "database");
    report.exceptions.formatWarningPages += Number(Boolean(record.formatWarnings?.length));
    try {
      const cached = await readJson(join(baseDir, "cache/source", `${doc.docId}.json`));
      if (cached.signature !== doc.signature || cached.bodyHash !== doc.bodyHash) throw new Error("来源缓存与当前快照不一致");
      const body = await catalog.readBody(record.notionPageId);
      if (record.contentFallback?.mode === "archive") {
        for (const file of record.contentFallback.files ?? []) {
          const target = body.media.filter(b => b.type === "file" && b.file.name === file.name);
          if (target.length !== 1 || (await notion.hashRemoteFile(target[0].file.file?.url ?? target[0].file.external?.url)).sha256 !== file.sha256) throw new Error("整页 ZIP 附件校验失败");
        }
        if (!record.contentFallback.files?.length) throw new Error("缺少 ZIP 原文附件清单");
      } else {
        const text = body.rows.map(block => { const data = block[block.type] ?? {}; return plainText(data.rich_text ?? data.cells?.flat() ?? ""); }).join("\n");
        const audit = auditSourceText(cached.blocks, doc.docId, text, { native: true });
        if (audit.missing.length) throw new Error("独立源正文覆盖检查失败");
        const expected = ownBlocks(cached.blocks, doc.docId).filter(b => ["image", "file", "audio", "video"].includes(b.type) && (b.media?.download_url || b.link) && !record.mediaExceptions?.some(e => e.blockId === b.id));
        if (body.media.length !== expected.length) throw new Error("源与目标媒体数量不一致");
      }
      report.coveragePassed++;
      const children = desiredChildIds(doc, tree);
      if (children.length) {
        const desired = children.map(id => normalizeId(state.documents[id]?.notionPageId));
        const known = new Set(desired);
        const actual = (await notion.listBlockChildren(record.notionPageId)).filter(b => b.type === "child_page").map(b => normalizeId(b.id)).filter(id => known.has(id));
        if (JSON.stringify(actual) !== JSON.stringify(desired)) { report.orderFailed++; throw new Error("真实子页顺序不一致"); }
        report.orderedParents++;
      }
    } catch (e) { report.coverageFailed++; report.details.push({ docId: doc.docId, result: "coverage-failed", error: safeError(e) }); }
  }
  const samples = tree.documents.filter(d => state.documents[d.docId]?.assetCount > 0).slice(0, 3);
  for (const doc of samples) {
    const record = state.documents[doc.docId], row = { docId: doc.docId };
    try {
      const source = await readJson(join(baseDir, "cache/source", `${doc.docId}.json`)), expected = [];
      for (const block of ownBlocks(source.blocks, doc.docId).filter(b => ["image", "file", "audio", "video"].includes(b.type) && (b.media?.download_url || b.link))) {
        if (record.mediaExceptions?.some(a => a.blockId === block.id)) continue;
        const key = digest(JSON.stringify({ stable: block.media?.stable_ref ?? block.link ?? block.id, version: block.version }));
        const asset = await readJson(join(baseDir, "cache/assets", `${key}.json`));
        if (!asset.sha256) throw new Error("缺少源媒体字节指纹"); expected.push(asset.sha256);
      }
      const actual = [];
      for (const block of (await catalog.readBody(record.notionPageId)).media) { const data = block[block.type]; actual.push((await notion.hashRemoteFile(data.file?.url ?? data.external?.url)).sha256); }
      report.mediaFilesChecked += actual.length;
      actual.forEach((hash, i) => { if (hash === expected[i]) report.mediaFilesPassed++; });
      row.orderedSha256Match = JSON.stringify(actual) === JSON.stringify(expected);
      if (!row.orderedSha256Match) report.failed++;
    } catch (e) { row.error = safeError(e); report.failed++; }
    report.media.push(row);
  }
  report.completedAt = new Date().toISOString();
  report.accepted = canAcceptVerification(report, tree, state, config.notionRoot.pageId) && report.coveragePassed === tree.total && report.coverageFailed === 0 && report.orderFailed === 0;
  await writeJson(join(baseDir, "reports/full-tree-verification.json"), report);
  return report;
}
