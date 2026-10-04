import { normalizeTitle, identityKey } from "./markdown.mjs";
import { normalizeId, sourceMarker, bodyFingerprint } from "./sync-safety.mjs";
import { ownBlocks, plainText } from "./notion-render.mjs";

export function pageTitle(page) {
  return plainText(Object.values(page.properties ?? {}).find(p => p.type === "title")?.title ?? []);
}

const normalizedText = value => String(value).normalize("NFKC").replace(/\s+/g, "");
const identity = value => /^\s*20\d{2}[/.年-]/.test(value) ? identityKey(value) : `title:${normalizeTitle(value)}`;

export function sourceText(blocks, docId) {
  return normalizedText(ownBlocks(blocks, docId).map(block =>
    ["image", "file", "audio", "video"].includes(block.type) ? "" :
      ["table", "simple_table"].includes(block.type) ? plainText(block.table_content ?? []) : plainText(block.content),
  ).join(""));
}

export class NotionCatalog {
  constructor(client, rootId, additionalRootIds = []) { this.client = client; this.rootId = normalizeId(rootId); this.rootIds = new Set([rootId, ...additionalRootIds].map(normalizeId)); this.pages = new Map(); this.markdown = new Map(); this.claims = new Map(); this.hashes = new Map(); }
  async refresh() {
    const pages = await this.client.searchPages();
    for (const page of pages) this.put(page);
    for (const rootId of this.rootIds) if (!this.pages.has(rootId)) this.put(await this.client.retrievePage(rootId));
  }
  put(page) { this.pages.set(normalizeId(page.id), page); }
  async get(id, fresh = false) {
    const key = normalizeId(id);
    if (fresh || !this.pages.has(key)) this.put(await this.client.retrievePage(id));
    return this.pages.get(key);
  }
  async readMarkdown(id, fresh = false) {
    const key = normalizeId(id);
    if (fresh || !this.markdown.has(key)) this.markdown.set(key, await this.client.retrievePageMarkdown(id));
    return this.markdown.get(key);
  }
  async ancestry(id) {
    const path = [], seen = new Set();
    let current = normalizeId(id);
    while (current && !this.rootIds.has(current)) {
      if (seen.has(current) || seen.size > 100) return null;
      seen.add(current);
      const page = await this.get(current);
      if (page.in_trash || page.archived) return null;
      path.push(page);
      if (page.parent?.type !== "page_id") return null;
      current = normalizeId(page.parent.page_id);
    }
    const root = this.pages.get(current);
    return this.rootIds.has(current) && !(root?.archived || root?.in_trash) ? path : null;
  }
  async ownedMarkdown(pageId, docId) {
    if (!(await this.ancestry(pageId))) throw new Error("目标页面不在授权根目录内");
    const md = await this.readMarkdown(pageId, true);
    if (sourceMarker(md.markdown)?.docId !== docId) throw new Error("目标页面来源标识不匹配");
    return md;
  }
  async resolve(doc, blocks, tree, state, { refreshBlocks } = {}) {
    const targetIdentity = identity(doc.title);
    const candidates = [...this.pages.values()].filter(p => identity(pageTitle(p).replace(/\s*\[wolai-[^\]]+\]$/, "")) === targetIdentity);
    const claimed = new Set(Object.entries(state.documents).filter(([id]) => id !== doc.docId).map(([, row]) => normalizeId(row.notionPageId)));
    const sourceParentTitles = doc.ancestorIds.map(id => tree.documents.find(d => d.docId === id)?.title ?? "");
    const nearestDate = sourceParentTitles.filter(title=>/^\s*20\d{2}[/.年-]/.test(title)).at(-1);
    const sourceParents = new Set(nearestDate ? [identity(nearestDate)] : sourceParentTitles.filter(title=>title && title!=="未命名").slice(-1).map(identity));
    const sourceBody = sourceText(blocks, doc.docId);
    const exact = [], legacy = [];
    for (const page of candidates) {
      if (claimed.has(normalizeId(page.id)) || this.claims.has(normalizeId(page.id)) && this.claims.get(normalizeId(page.id)) !== doc.docId) continue;
      const path = await this.ancestry(page.id);
      if (!path) continue;
      const md = await this.readMarkdown(page.id);
      if (md.truncated || md.unknown_block_ids?.length) continue;
      const marker = sourceMarker(md.markdown);
      if (marker?.docId === doc.docId) { exact.push(page); continue; }
      if (marker) continue;
      // Title/date is only a candidate filter, never proof of identity.
      const parentMatches = doc.parentDocId && normalizeId(page.parent?.page_id) === normalizeId(state.documents[doc.parentDocId]?.notionPageId);
      const contextMatches = parentMatches || targetIdentity.startsWith("date:") || path.slice(1).some(p => sourceParents.has(identity(pageTitle(p))));
      if (!contextMatches || !sourceBody) continue;
      const body = await this.readBody(page.id);
      let targetText = normalizedText(body.text);
      const titleText = normalizedText(pageTitle(page));
      if (body.firstType?.startsWith("heading_") && targetText.startsWith(titleText) && targetText.slice(titleText.length) === sourceBody) targetText = targetText.slice(titleText.length);
      if (body.firstType?.startsWith("heading_") && identity(body.firstText ?? "")===targetIdentity) {
        const headingText=normalizedText(body.firstText);
        if(targetText.startsWith(headingText)&&targetText.slice(headingText.length)===sourceBody)targetText=targetText.slice(headingText.length);
      }
      const sourceMedia = ownBlocks(blocks, doc.docId).filter(b => ["image", "file", "audio", "video"].includes(b.type) && (b.media?.download_url || b.link));
      if (targetText === sourceBody && sourceMedia.length === body.mediaCount) {
        let mediaMatch = sourceMedia.length === 0;
        if (sourceMedia.length && this.client.hashRemoteFile) {
          try { mediaMatch = await this.matchMedia(sourceMedia, body.media, refreshBlocks); } catch { mediaMatch = false; }
        }
        if (mediaMatch) legacy.push({ ...page, proofHash: bodyFingerprint(md.markdown) });
      }
    }
    if (exact.length > 1) throw new Error("同一来源标识对应多个镜像，禁止自动覆盖");
    if (exact.length) {
      const id = normalizeId(exact[0].id);
      if (this.claims.has(id) && this.claims.get(id) !== doc.docId) throw new Error("目标页面已被另一来源认领");
      this.claims.set(id, doc.docId);
      return { page: exact[0], mode: "recovered" };
    }
    if (legacy.length) {
      legacy.sort((a, b) => {
        const expected = normalizeId(state.documents[doc.parentDocId]?.notionPageId);
        return Number(normalizeId(b.parent?.page_id) === expected) - Number(normalizeId(a.parent?.page_id) === expected) || a.created_time.localeCompare(b.created_time);
      });
      const available = legacy.filter(page=>!this.claims.has(normalizeId(page.id)) || this.claims.get(normalizeId(page.id)) === doc.docId);
      if (available.length) {
        this.claims.set(normalizeId(available[0].id), doc.docId);
        return { page: available[0], proofHash: available[0].proofHash, mode: "legacy", retainedCopies: available.slice(1).map(p => p.id) };
      }
    }
    return null;
  }
  async matchMedia(source, target, refreshBlocks) {
    const hash = url => {
      if (!this.hashes.has(url)) this.hashes.set(url, this.client.hashRemoteFile(url));
      return this.hashes.get(url);
    };
    const a = [], b = [];
    for (const block of source) {
      let url = block.media?.download_url ?? block.link;
      try { a.push((await hash(url)).sha256); }
      catch (error) {
        if (![401,403].includes(error.status) || !refreshBlocks) throw error;
        const fresh = (await refreshBlocks()).find(row=>row.id===block.id);
        a.push((await hash(fresh?.media?.download_url ?? fresh?.link)).sha256);
      }
    }
    for (const block of target) {
      const data = block[block.type];
      b.push((await hash(data.file?.url ?? data.external?.url)).sha256);
    }
    return a.sort().join(",") === b.sort().join(",");
  }
  async readBody(pageId) {
    const rows = await this.client.listBlockChildren(pageId);
    const text = [], media = [], flat = [];
    async function walk(blocks, client) {
      for (const block of blocks) {
        if (["child_page", "child_database"].includes(block.type)) continue;
        flat.push(block);
        if (["image", "file", "pdf", "audio", "video"].includes(block.type)) media.push(block);
        else {
          const data = block[block.type] ?? {};
          if (data.rich_text) text.push(plainText(data.rich_text));
          if (data.cells) text.push(plainText(data.cells));
          if (data.expression) text.push(data.expression);
        }
        if (block.has_children) await walk(await client.listBlockChildren(block.id), client);
      }
    }
    await walk(rows, this.client);
    return { rows, blocks:flat, text: text.join(""), media, mediaCount: media.length, firstType: rows[0]?.type, firstText:plainText(rows[0]?.[rows[0]?.type]?.rich_text) };
  }
}
