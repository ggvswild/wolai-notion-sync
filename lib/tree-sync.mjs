import { join } from "node:path";
import { readJson, writeJson } from "./storage.mjs";
import { sourceSignature, pageBodyHash, mapPool } from "./source-tree.mjs";
import { NotionCatalog, pageTitle } from "./notion-catalog.mjs";
import { renderNativeNodes, nativeNodesToMarkdown, maskLiteralMarkup, packNode, requestBatches, plainText, ownBlocks, sourceHeader } from "./notion-render.mjs";
import { prepareMedia, markMediaAttached } from "./media-sync.mjs";
import { normalizeId, sourceMarker, bodyFingerprint, preserveChildPages, validateTarget, pendingDocuments, safeError } from "./sync-safety.mjs";
import { writeArchiveMirror } from "./archive-fallback.mjs";
import { inOrderedScope, desiredChildIds, pendingChildOrders, reconcileChildOrder, recoverOrderMove, childCreationPosition } from "./page-order.mjs";
import { auditSourceText, markdownMediaCount } from "./source-content-audit.mjs";
import { expectedNotionParent, notionRootIds } from "./notion-locations.mjs";
import { inSyncScope, scopedSourceTree } from "./sync-scope.mjs";
import { preferredPageIcon, applyPageAppearance } from "./page-appearance.mjs";

function comparable(block) {
  const data = block[block.type] ?? {};
  return JSON.stringify({ type: block.type, text: plainText(data.rich_text), caption: plainText(data.caption), cells: data.cells?.map(plainText),
    checked: data.checked, expression: data.expression, language: data.language, url: data.url });
}

// Creation/append operations are never blindly retried. On resume, read the
// created prefix and append only the missing tail, preserving native nesting.
export async function ensureNativeChildren(client, parentId, nodes, existing = null) {
  let rows = existing ?? await client.listBlockChildren(parentId);
  rows = rows.filter(row => !["child_page", "child_database"].includes(row.type));
  if (rows.length > nodes.length) throw new Error("未完成镜像中出现额外手工内容");
  for (let i = 0; i < rows.length; i += 1) {
    if (comparable(rows[i]) !== comparable(nodes[i].request)) throw new Error("未完成镜像正文与待续传内容不匹配");
  }
  for (const requests of requestBatches(nodes.slice(rows.length).map(node => packNode(node)))) {
    const result = await client.appendBlocks(parentId, requests);
    if (result.results?.length !== requests.length) throw new Error("Notion 追加块数量不匹配");
    rows.push(...result.results);
  }
  for (let i = 0; i < nodes.length; i += 1) {
    if (comparable(rows[i]) !== comparable(nodes[i].request)) throw new Error("原生写入读回正文不匹配");
    // A nested node was packed with a smaller depth in its parent's request.
    // Recomputing needsHydration(node) at the default depth wrongly assumes its
    // descendants already exist. Inspect the actual children at every level.
    if (nodes[i].children.length) await ensureNativeChildren(client, rows[i].id, nodes[i].children);
    else if (rows[i].has_children) {
      const extra = await client.listBlockChildren(rows[i].id);
      if (extra.some(row => !["child_page", "child_database"].includes(row.type))) throw new Error("未完成镜像中出现额外手工子内容");
    }
  }
}

export async function inspectNativeChildren(client, parentId, nodes, result = { checked: 0, missing: [], rowsByParent: new Map(), blocks: [] }) {
  const all = await client.listBlockChildren(parentId);
  result.rowsByParent.set(parentId, all);
  const rows = all.filter(row => !["child_page", "child_database"].includes(row.type));
  if (rows.length > nodes.length) throw new Error("目标结构包含额外内容，禁止补写");
  const missing = list => { for (const node of list) { result.missing.push(node.sourceId); missing(node.children); } };
  for (let i = 0; i < rows.length; i += 1) {
    if (comparable(rows[i]) !== comparable(nodes[i].request)) throw new Error("目标原生结构与源正文不匹配，禁止补写");
    result.checked += 1;
    result.blocks.push(rows[i]);
    if (nodes[i].children.length) await inspectNativeChildren(client, rows[i].id, nodes[i].children, result);
    else if (rows[i].has_children) {
      const extra = await client.listBlockChildren(rows[i].id);
      if (extra.some(row => !["child_page", "child_database"].includes(row.type))) throw new Error("目标结构包含额外子内容，禁止补写");
    }
  }
  missing(nodes.slice(rows.length));
  return result;
}

export class TreeSync {
  constructor({ baseDir, config, state, tree, source, notion, onProgress = () => {} }) {
    Object.assign(this, { baseDir, config, state, tree, source, notion, onProgress });
    this.tree = scopedSourceTree(tree, config);
    this.catalog = new NotionCatalog(notion, config.notionRoot.pageId, notionRootIds(config).slice(1));
    this.persistChain = Promise.resolve();
    this.runId = new Date().toISOString().replace(/[:.]/g, "-");
    this.counts = { scanned: tree.total, processed: 0, created: 0, updated: 0, adopted: 0, moved: 0, baselined: 0, conflicts: 0, failed: 0, deferred: 0, media: 0, archived:0, orderChecked: 0, reordered: 0, orderFailed: 0, orderDeferred: 0, orderMoveAttempts: 0 };
    this.counts.scanned = this.tree.total;
    this.stopRequested = false;
  }
  persist() {
    this.persistChain = this.persistChain.then(() => writeJson(join(this.baseDir, "sync-state.json"), this.state));
    return this.persistChain;
  }
  async init({ needsDiscovery = true } = {}) {
    if (normalizeId(this.state.rootPageId) !== normalizeId(this.config.notionRoot.pageId)) throw new Error("状态与配置的目标根页面不一致");
    if (this.tree.failedCount) throw new Error("源树扫描存在失败，禁止开始回填");
    if (needsDiscovery) await this.catalog.refresh();
    else this.catalog.put(await this.notion.retrievePage(this.config.notionRoot.pageId));
    await writeJson(join(this.baseDir, "backups", `state-before-tree-${this.runId}.json`), this.state);
    this.state.schemaVersion = 2;
    this.state.hierarchyBackfillComplete = false;
    await this.persist();
  }
  async sourceBlocks(doc) {
    const cached = await readJson(join(this.baseDir, "cache/source", `${doc.docId}.json`));
    if (cached.signature !== doc.signature) throw new Error("源缓存与本轮扫描版本不一致");
    return cached.blocks;
  }
  async process(doc) {
    if (!inSyncScope(doc, this.config)) throw new Error("页面不在配置的同步范围内，禁止读取或写入");
    const record = this.state.documents[doc.docId] ?? { title: doc.title, sourceVersion: null, notionPageId: null, status: "pending" };
    const previousError=record.lastError??"";
    let archiveContext;
    this.state.documents[doc.docId] = record;
    try {
      const needsContentProof = !record.lastNotionBodyHash;
      let adopted = false, baselined = false;
      if (record.pendingStructureRepair) throw new Error("未完成原生结构修复，保留现场等待专项续传");
      if (record.pendingOrderMove) await recoverOrderMove({ sourceDocId: doc.docId, state: this.state, notion: this.notion, catalog: this.catalog, persist: () => this.persist() });
      const parentRecord = doc.parentDocId ? this.state.documents[doc.parentDocId] : null;
      if (doc.parentDocId && (!parentRecord?.notionPageId || !["synced", "synced_with_exceptions"].includes(parentRecord.status))) {
        this.counts.deferred += 1; record.lastError = "等待父页面同步完成"; return;
      }
      const parentId = expectedNotionParent(doc, this.state, this.config);
      if (!(await this.catalog.ancestry(parentId))) throw new Error("目标父页面不在授权根目录内");
      let blocks = await this.sourceBlocks(doc);
      const expectedBodyHash = doc.bodyHash ?? pageBodyHash(blocks, doc.docId);
      doc = {...doc, bodyHash:expectedBodyHash};
      let freshBlocks;
      const refreshBlocks = async () => {
        if (!freshBlocks) {
          const result = await this.source.getPageBlocks(doc.docId);
          const root = result.find(block=>block.id===doc.docId);
          if (!root || sourceSignature(root)!==doc.signature || pageBodyHash(result,doc.docId)!==expectedBodyHash) throw new Error("源页面在读取媒体期间变化，等待重新扫描");
          freshBlocks = result;
        }
        return freshBlocks;
      };
      // Cache is a read optimization, not authority to overwrite a newer source.
      const latestBlocks = this.source.getPageBlocks ? await this.source.getPageBlocks(doc.docId) : null;
      const latest = latestBlocks ? latestBlocks.find(b=>b.id===doc.docId) : await this.source.getDoc(doc.docId);
      if (!latest || sourceSignature(latest) !== doc.signature || latestBlocks && pageBodyHash(latestBlocks,doc.docId)!==expectedBodyHash) { this.counts.deferred += 1; record.status = "pending"; record.lastError = "源页面已变化，等待重新扫描"; return; }
      if (latestBlocks) { blocks=latestBlocks; freshBlocks=latestBlocks; }
      archiveContext={baseDir:this.baseDir,doc,blocks,record,parentId,client:this.notion,catalog:this.catalog,persist:()=>this.persist()};
      let page, md, remoteChanged = false, mode = record.notionPageId ? "mapped" : "new";
      if (record.notionPageId) {
        page = await this.catalog.get(record.notionPageId, true);
        if (record.pendingWrite?.kind === "adopt") {
          mode = "legacy";
          md = await this.catalog.readMarkdown(page.id, true);
          const marker = sourceMarker(md.markdown);
          if (marker ? marker.docId !== doc.docId : bodyFingerprint(md.markdown) !== record.pendingWrite.legacyBodyHash) throw new Error("历史页认领期间存在手工修改");
        } else md = await this.catalog.ownedMarkdown(page.id, doc.docId);
      } else {
        const match = await this.catalog.resolve(doc, blocks, this.tree, this.state, { refreshBlocks });
        if (match) {
          page = match.page; mode = match.mode;
          md = await this.catalog.readMarkdown(page.id, true);
          if (match.proofHash && bodyFingerprint(md.markdown)!==match.proofHash) throw new Error("历史页认领前存在手工修改");
          record.notionPageId = page.id;
          record.retainedLegacyCopies = match.retainedCopies ?? [];
          record.targetTitle = pageTitle(page);
          record.pendingWrite = { kind: mode === "legacy" ? "adopt" : "native", sourceSignature: doc.signature,
            ...(sourceMarker(md.markdown)?.contentHash ? {bodyHash:sourceMarker(md.markdown).contentHash} : {}),
            ...(match.proofHash ? { legacyBodyHash: match.proofHash } : {}) };
          await this.persist();
        } else if (record.pendingCreateAt) {
          // An ambiguous POST must pass two complete catalog searches, separated
          // by a later run, before another create is attempted.
          if (!record.negativeCreateSearchAt || Date.now() - Date.parse(record.negativeCreateSearchAt) < 60000) {
            record.negativeCreateSearchAt ??= new Date().toISOString();
            record.status = "pending"; record.lastError = "创建结果待确认；本次不重复创建";
            this.counts.deferred += 1; await this.persist(); return;
          }
        }
      }
      if (page && !(await this.catalog.ancestry(page.id))) throw new Error("目标页面不在授权根目录内");
      if (mode === "mapped" && record.notionParentId && normalizeId(page.parent?.page_id) !== normalizeId(record.notionParentId) && normalizeId(page.parent?.page_id) !== normalizeId(parentId)) throw new Error("目标页面父级存在手工移动");
      if (mode === "mapped" && !record.notionParentId && !record.pendingWrite && normalizeId(page.parent?.page_id) !== normalizeId(this.config.notionRoot.pageId)) throw new Error("旧镜像父级存在手工移动");
      if (mode === "legacy" || record.pendingWrite?.kind === "adopt") {
        if (!sourceMarker(md.markdown)) {
          await writeJson(join(this.baseDir, "backups", this.runId, `${doc.docId}.json`), { page, markdown: md.markdown });
          await this.notion.request("PATCH", `/pages/${page.id}/markdown`, { retryable: false, body: {
            type: "insert_content", insert_content: { content: `> ${sourceHeader(doc)}\n\n`, position: { type: "start" } },
          } });
          remoteChanged = true;
          md = await this.catalog.readMarkdown(page.id, true);
        }
        if (sourceMarker(md.markdown)?.docId !== doc.docId) throw new Error("历史页认领标识验证失败");
        adopted = true;
      } else if (page) {
        const pending = record.pendingWrite;
        const marker = sourceMarker(md.markdown);
        const recovering = !!pending && pending.sourceSignature === doc.signature && marker?.payload === doc.signature;
        if (recovering && pending.kind === "update" && (pending.targetBodyHash ?? pending.previousBodyHash) !== bodyFingerprint(md.markdown)) throw new Error("未完成更新与已记录内容不匹配；保留现场");
        validateTarget(doc, record, { ...md, title: pageTitle(page) }, { allowPending: recovering });
        if (!record.lastNotionBodyHash && !pending) {
          if (marker.version !== String(record.sourceVersion)) throw new Error("旧镜像版本标识不一致");
          if (Date.parse(page.last_edited_time) > Date.parse(record.lastSyncedAt ?? "1970-01-01") + 5000) throw new Error("旧镜像同步后可能存在手工修改，禁止接管正文");
          record.targetTitle = pageTitle(page);
          baselined = true;
        }
      }

      let assets;
      if(record.contentFallback?.mode==="archive"){
        const existed=!!record.notionPageId;
        await writeArchiveMirror(archiveContext);
        this.counts[existed?"updated":"created"]+=1;this.counts.archived+=1;
        this.state.lastCompletedAt=record.lastSyncedAt;await this.persist();return;
      }
      if (!page || record.pendingWrite?.kind === "native") {
        assets = await prepareMedia(blocks, doc.docId, { client: this.notion, baseDir: this.baseDir, refreshBlocks });
        const warnings = new Set();
        const legacyPending = record.pendingWrite?.kind === "native" && !record.pendingWrite.bodyHash;
        const nodes = renderNativeNodes(blocks, legacyPending ? {...doc,bodyHash:undefined} : doc, assets, warnings);
        const batches = requestBatches(nodes.map(node => packNode(node)));
        record.pendingWrite = { kind: "native", sourceSignature: doc.signature, ...(legacyPending ? {} : {bodyHash:expectedBodyHash}) };
        if (!page) {
          record.pendingCreateAt = new Date().toISOString();
          await this.persist();
          const position = await childCreationPosition({ doc, tree: this.tree, state: this.state, config: this.config, notion: this.notion });
          page = await this.notion.createPageBlocks(parentId, doc.title, batches[0], position);
          remoteChanged = true;
          record.notionPageId = page.id; record.targetTitle = doc.title; record.status = "partial";
          this.catalog.put(page); await this.persist();
          this.counts.created += 1;
          await ensureNativeChildren(this.notion, page.id, nodes);
        } else { await ensureNativeChildren(this.notion, page.id, nodes); remoteChanged = true; }
        await markMediaAttached(assets);
        record.formatWarnings = [...warnings];
        record.assetCount = [...assets.values()].filter(a=>a.uploadId).length; this.counts.media += record.assetCount;
        md = await this.catalog.readMarkdown(page.id, true);
        if (sourceMarker(md.markdown)?.payload !== doc.signature) throw new Error("创建内容版本校验失败");
      } else if (mode !== "legacy" && record.pendingWrite?.kind !== "adopt" && (record.retryAssets || record.sourceVersion !== doc.version || record.sourceSignature && record.sourceSignature !== doc.signature || record.sourceBodyHash && record.sourceBodyHash!==expectedBodyHash || doc.baselineBodyHash && doc.baselineBodyHash!==expectedBodyHash || record.pendingWrite?.kind === "update" || doc.sourceType === "database" && record.hierarchyVersion !== 2)) {
        assets = await prepareMedia(blocks, doc.docId, { client: this.notion, baseDir: this.baseDir, refreshBlocks });
        if (freshBlocks) blocks = freshBlocks;
        const warnings = new Set();
        const nodes = renderNativeNodes(blocks, doc, assets, warnings);
        const literalTransport = maskLiteralMarkup(nodes);
        const mediaUrls = new Map(ownBlocks(blocks, doc.docId).filter(b=>assets.get(b.id)?.uploadId).map(b=>[assets.get(b.id).uploadId, b.media?.download_url ?? b.link]));
        const generated = nativeNodesToMarkdown(literalTransport.nodes, mediaUrls);
        const desiredPageIds = inOrderedScope(doc, this.config) ? desiredChildIds(doc, this.tree).map(id => this.state.documents[id]?.notionPageId).filter(Boolean) : undefined;
        const content = preserveChildPages(md.markdown, generated, { desiredPageIds });
        await writeJson(join(this.baseDir, "backups", this.runId, `${doc.docId}.json`), { page, markdown: md.markdown });
        const priorChildIds = [...md.markdown.matchAll(/<page\s+url="([^"]+)"/g)].map(m => m[1]);
        record.pendingWrite = { kind: "update", sourceSignature: doc.signature, bodyHash:expectedBodyHash, previousBodyHash: record.lastNotionBodyHash, targetBodyHash: record.pendingWrite?.targetBodyHash, literalTargets:record.pendingWrite?.literalTargets ?? {} };
        await this.persist();
        if (sourceMarker(md.markdown)?.payload !== doc.signature || sourceMarker(md.markdown)?.contentHash!==expectedBodyHash || record.retryAssets && !record.pendingWrite.targetBodyHash) {
          const updated = await this.notion.replacePageMarkdown(page.id, content);
          if (updated.markdown) record.pendingWrite.targetBodyHash = bodyFingerprint(updated.markdown);
          else record.pendingWrite.targetBodyHash = bodyFingerprint((await this.catalog.readMarkdown(page.id, true)).markdown);
          await this.persist();
        }
        remoteChanged = true;
        if (literalTransport.replacements.length) {
          const literalBody=await this.catalog.readBody(page.id);
          for (const replacement of literalTransport.replacements) {
            const matches=literalBody.blocks.filter(block=>block.type===replacement.type&&plainText(block[block.type].rich_text??block[block.type].cells)===replacement.placeholder);
            const savedId=record.pendingWrite.literalTargets[replacement.sourceId];
            if(matches.length>1 || !matches.length&&!savedId)throw new Error("代码或富文本占位无法唯一定位，保留待重试状态");
            const blockId=matches[0]?.id??savedId;
            record.pendingWrite.literalTargets[replacement.sourceId]=blockId;
            await this.persist();
            await this.notion.request("PATCH",`/blocks/${blockId}`,{retryable:false,body:{[replacement.type]:replacement.payload}});
            record.pendingWrite.targetBodyHash=bodyFingerprint((await this.catalog.readMarkdown(page.id,true)).markdown);
            await this.persist();
          }
        }
        if (assets.size) {
          const body = await this.catalog.readBody(page.id);
          const expected = ownBlocks(blocks, doc.docId).filter(b => assets.get(b.id)?.uploadId);
          if (body.media.length !== expected.length) throw new Error("更新后媒体块数量不一致，保留待重试状态");
          for (let i = 0; i < expected.length; i += 1) {
            const asset = assets.get(expected[i].id), target = body.media[i];
            await this.notion.attachUploadToBlock(target.id, target.type, asset.uploadId);
            record.pendingWrite.targetBodyHash = bodyFingerprint((await this.catalog.readMarkdown(page.id, true)).markdown);
            await this.persist();
          }
          await markMediaAttached(assets);
        }
        md = await this.catalog.readMarkdown(page.id, true);
        if(literalTransport.replacements.some(r=>md.markdown.includes(r.placeholder)))throw new Error("字面量正文尚未完全恢复");
        record.formatWarnings = [...warnings];
        for (const url of priorChildIds) if (!md.markdown.includes(url)) throw new Error("父页更新后子页面引用核验失败");
        this.counts.updated += 1;
      }

      if (normalizeId(page.parent?.page_id) !== normalizeId(parentId)) {
        if (record.notionParentId && normalizeId(page.parent?.page_id) !== normalizeId(record.notionParentId) && !record.pendingWrite) throw new Error("目标页面父级存在手工移动");
        await this.notion.movePage(page.id, parentId);
        remoteChanged = true;
        this.counts.moved += 1;
      }
      if (pageTitle(page) !== doc.title && (mode === "legacy" || record.hierarchyVersion === 2)) { await this.notion.updateTitle(page.id, doc.title); remoteChanged = true; }
      const verified = remoteChanged ? await this.notion.retrievePage(page.id) : page;
      this.catalog.put(verified);
      if (normalizeId(verified.parent?.page_id) !== normalizeId(parentId) || verified.in_trash || verified.archived) throw new Error("目标真实父级验证失败");
      const marker = sourceMarker(md.markdown);
      if (marker?.docId !== doc.docId || marker.version !== String(doc.version) || md.truncated || md.unknown_block_ids?.length) throw new Error("写入后来源、版本或完整性验证失败");
      if (record.pendingWrite?.bodyHash && marker.contentHash!==record.pendingWrite.bodyHash) throw new Error("写入后正文指纹标识验证失败");
      if (remoteChanged || needsContentProof) {
        // A valid source marker and a freshly saved target hash can both exist
        // on an incomplete page. Check the actual source content independently
        // before accepting the new baseline or successful source version.
        let coverage = auditSourceText(blocks, doc.docId, md.markdown);
        const expectedMedia = ownBlocks(blocks, doc.docId).filter(block =>
          ["image", "file", "audio", "video"].includes(block.type) && (block.media?.download_url || block.link) &&
          !(assets ? assets.get(block.id)?.oversize : record.mediaExceptions?.some(item => item.blockId === block.id))).length;
        let actualMedia = markdownMediaCount(md.markdown);
        if (coverage.missing.length || actualMedia !== expectedMedia) {
          const body = await this.catalog.readBody(page.id);
          coverage = auditSourceText(blocks, doc.docId, body.text, { native: true });
          actualMedia = body.mediaCount;
        }
        if (coverage.missing.length) throw new Error("写入后源正文覆盖不完整，保留待重试状态");
        if (actualMedia !== expectedMedia) throw new Error("写入后媒体覆盖不完整，保留待重试状态");
      }
      if (assets && [...assets.values()].some(asset => asset.archive)) {
        const expected = ownBlocks(blocks, doc.docId).filter(block => assets.get(block.id)?.uploadId);
        const body = await this.catalog.readBody(page.id);
        if (body.media.length !== expected.length) throw new Error("归档媒体块数量不匹配，保留待重试状态");
        for (let i = 0; i < expected.length; i += 1) {
          const asset = assets.get(expected[i].id);
          if (!asset.archive) continue;
          const target = body.media[i], data = target[target.type];
          const actual = await this.notion.hashRemoteFile(data.file?.url ?? data.external?.url);
          if (actual.sha256 !== asset.sha256 || actual.bytes !== asset.bytes) throw new Error("ZIP 原件附件字节校验失败");
        }
      }
      if (assets) record.mediaExceptions = [...assets.entries()].filter(([, a])=>a.oversize).map(([blockId, a])=>({ blockId, ...a }));
      if (assets) record.mediaArchives = [...assets.entries()].filter(([, a])=>a.archive).map(([blockId, a])=>({ blockId, ...a.archive, archiveFilename:a.filename, archiveSha256:a.sha256 }));
      if (adopted) this.counts.adopted += 1;
      if (baselined) this.counts.baselined += 1;
      try {
        const appearance = await applyPageAppearance({ notion: this.notion, page: verified, desired: preferredPageIcon(doc.title, this.config.appearance), record });
        if (appearance.changed) this.catalog.put(appearance.page);
      } catch (error) {
        // Cosmetic failures must not prevent already-verified content syncing.
        record.appearanceError = safeError(error);
      }
      Object.assign(record, {
        title: doc.title, sourceVersion: doc.version, sourceEditedAt: doc.editedAt, sourceSignature: doc.signature, sourceBodyHash:expectedBodyHash,
        notionPageId: page.id, notionParentId: parentId, targetTitle: pageTitle(verified),
        parentDocId: doc.parentDocId, depth: doc.depth, hierarchyVersion: 2,
        status: record.mediaExceptions?.length || record.mediaArchives?.length ? "synced_with_exceptions" : "synced", lastSyncedAt: new Date().toISOString(), lastNotionBodyHash: bodyFingerprint(md.markdown),
        lastError: null, pendingWrite: null, pendingCreateAt: null, negativeCreateSearchAt: null, retryAssets: false,
        ...(remoteChanged && inOrderedScope(doc, this.config) ? { childOrderSignature: null } : {}),
      });
      if (doc.sourceType === "database") record.formatWarnings = [...new Set([...(record.formatWarnings ?? []), "database-records-not-enumerable-by-mcp"])];
      this.state.lastCompletedAt = record.lastSyncedAt;
      await this.persist();
    } catch (error) {
      if(!record.notionPageId && archiveContext && error.status===403 && error.apiPath==="/pages" && error.apiMethod==="POST" && /cloudflare/i.test(error.payload?.message??"")){
        record.gatewayFailures=(record.gatewayFailures??(/cloudflare/i.test(previousError)?1:0))+1;
        if(record.gatewayFailures>=2){
          try{
            await writeArchiveMirror(archiveContext);
            this.counts.created+=1;this.counts.archived+=1;
            this.state.lastCompletedAt=record.lastSyncedAt;await this.persist();return;
          }catch(archiveError){error=archiveError;}
        }
      }
      const message = safeError(error);
      const conflict = /手工|不匹配|来源标识|授权根|多个镜像|无法安全|旧镜像/.test(message);
      record.status = conflict ? "conflict" : record.notionPageId ? "partial" : "failed";
      record.lastError = message;
      record.lastAttemptAt = new Date().toISOString();
      if (!record.notionPageId && error.status && error.status < 500) record.pendingCreateAt = null;
      this.counts[conflict ? "conflicts" : "failed"] += 1;
      await this.persist();
    } finally {
      this.counts.processed += 1;
      this.onProgress(this.counts, doc, record);
    }
  }
  async run({ limit = this.config.policy.batchSize, focus, selectedIds, concurrency = 3 } = {}) {
    if (this.state.organizationMigration && this.state.organizationMigration.status !== "complete") throw new Error("目录归档调整尚未完成，等待迁移续传后再同步");
    const scopeRecords = () => this.tree.documents.map(doc => this.state.documents[doc.docId]).filter(Boolean);
    for (const doc of this.tree.documents) {
      const row=this.state.documents[doc.docId];
      if(row && !row.sourceBodyHash && row.sourceSignature===doc.baselineSignature && doc.bodyHash===doc.baselineBodyHash && ["synced","synced_with_exceptions"].includes(row.status)) row.sourceBodyHash=doc.bodyHash;
    }
    if (this.notion.getCurrentUser) {
      const user = await this.notion.getCurrentUser();
      const capacity = Math.min(user.bot?.workspace_limits?.max_file_upload_size_in_bytes ?? this.notion.maxFileUploadBytes ?? 5242880, this.config.media?.maxFileUploadBytes ?? 20971520, 20971520);
      this.notion.maxFileUploadBytes = capacity;
      if (capacity > (this.state.maxFileUploadBytes ?? 5242880)) {
        for (const row of scopeRecords()) if (row.mediaExceptions?.some(a=>a.bytes<=capacity)) row.retryAssets = true;
      }
      this.state.maxFileUploadBytes = capacity;
    }
    const allowed = selectedIds ? new Set(selectedIds.flatMap(id => [id, ...(this.tree.documents.find(d => d.docId === id)?.ancestorIds ?? [])])) : null;
    const scoped = doc => (!focus || doc.docId === focus || doc.ancestorIds.includes(focus)) && (!allowed || allowed.has(doc.docId));
    let candidates = pendingDocuments(this.tree, this.state).filter(scoped);
    candidates = candidates.slice(0, limit);
    if (candidates.length || pendingChildOrders(this.tree, this.state, this.config).some(scoped)) await this.init({ needsDiscovery: candidates.some(doc=>!this.state.documents[doc.docId]?.notionPageId) });
    for (const depth of [...new Set(candidates.map(doc => doc.depth))].sort((a, b) => a - b)) {
      if (this.stopRequested) break;
      const groups = new Map();
      for (const doc of candidates.filter(doc => doc.depth === depth)) {
        const key = doc.parentDocId ?? doc.docId;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(doc);
      }
      await mapPool([...groups.values()], concurrency, async group => {
        const parent = this.tree.documents.find(d => d.docId === group[0].parentDocId);
        if (parent && inOrderedScope(parent, this.config)) group.sort((a, b) => parent.childIds.indexOf(a.docId) - parent.childIds.indexOf(b.docId));
        for (const doc of group) { if (this.stopRequested) break; await this.process(doc); }
      });
    }
    await this.persistChain;
    // Content creation can append child pages in any completion order. Reconcile
    // the real child-page order after the parent-first content pass, sharing its
    // batch budget. The signature also changes when a new child gains an ID.
    const orderCandidates = pendingChildOrders(this.tree, this.state, this.config).filter(scoped).slice(0, Math.max(0, limit - this.counts.processed));
    for (const doc of orderCandidates) {
      if (this.stopRequested || this.counts.processed + this.counts.orderChecked + this.counts.orderMoveAttempts >= limit) break;
      try {
        const result = await reconcileChildOrder({ doc, tree: this.tree, state: this.state, notion: this.notion, catalog: this.catalog,
          persist: () => this.persist(), backup: data => writeJson(join(this.baseDir, "backups", this.runId, `order-${doc.docId}.json`), data),
          maxPageMoves: Math.max(0, limit - this.counts.processed - this.counts.orderChecked - this.counts.orderMoveAttempts - 1), onMoveAttempt: () => { this.counts.orderMoveAttempts += 1; } });
        this.counts.reordered += Number(result.reordered);
        if (result.deferred) this.counts.orderDeferred += 1;
      } catch (error) {
        const message = safeError(error), row = this.state.documents[doc.docId];
        if (row) row.childOrderError = message;
        if (/尚未同步完成/.test(message)) this.counts.orderDeferred += 1;
        else { this.counts.orderFailed += 1; this.counts[/手工|不匹配|来源标识|授权根|无法安全|正文/.test(message) ? "conflicts" : "failed"] += 1; }
        await this.persist();
      } finally { this.counts.orderChecked += 1; }
    }
    const remaining = pendingDocuments(this.tree, this.state).length;
    const orderRemaining = pendingChildOrders(this.tree, this.state, this.config).length;
    this.state.hierarchyBackfillComplete = remaining === 0 && this.tree.failedCount === 0;
    this.state.lastTreeScanAt = this.tree.scannedAt;
    this.state.lastTreeTotal = this.tree.total;
    this.state.navigationComplete = remaining === 0 && orderRemaining === 0 && this.tree.failedCount === 0 && this.counts.failed === 0 && this.counts.conflicts === 0;
    const mediaExceptions = scopeRecords().reduce((n, row)=>n+(row.mediaExceptions?.length ?? 0),0);
    const mediaArchives = scopeRecords().reduce((n, row)=>n+(row.mediaArchives?.length ?? 0),0);
    const archivePages=scopeRecords().filter(row=>row.contentFallback?.mode==="archive").length;
    this.state.mediaBackfillComplete = remaining === 0 && mediaExceptions === 0 && mediaArchives === 0 && archivePages === 0;
    await this.persist();
    const report = { runId: this.runId, ...this.counts, remaining, orderRemaining, navigationComplete: this.state.navigationComplete, mediaExceptions, mediaArchives, archivePages, stopped: this.stopRequested, hierarchyBackfillComplete: this.state.hierarchyBackfillComplete, mediaBackfillComplete: this.state.mediaBackfillComplete };
    await writeJson(join(this.baseDir, "tree-sync-result.json"), report);
    return report;
  }
}
