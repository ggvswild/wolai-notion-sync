import { createHash } from "node:crypto";

export function sourceTitle(block, fallback = "未命名") {
  const value = typeof block?.content === "string"
    ? block.content
    : (block?.content ?? []).map((span) => span.title ?? "").join("");
  return value.trim() || fallback;
}

export function childPagesOf(blocks, pageId) {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  return blocks.filter((block) => {
    if (!["page", "database"].includes(block.type) || block.id === pageId) return false;
    let parentId = block.parent_id;
    const seen = new Set([block.id]);
    while (parentId && parentId !== pageId) {
      if (seen.has(parentId)) throw new Error("源页面块存在循环引用");
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return block.page_id === pageId;
      if (["page", "database"].includes(parent.type)) return false;
      parentId = parent.parent_id;
    }
    return parentId === pageId;
  });
}

export function sourceSignature(metadata) {
  return createHash("sha256").update(JSON.stringify({
    version: metadata.version,
    editedAt: metadata.edited_at,
    parentId: metadata.parent_id,
    pageId: metadata.page_id,
    title: sourceTitle(metadata),
    children: metadata.children,
  })).digest("hex");
}

export function pageBodyHash(blocks, pageId) {
  const byId = new Map(blocks.map(block=>[block.id,block]));
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value!=="object") return value;
    return Object.fromEntries(Object.keys(value).sort().filter(key=>!["download_url","expires_in","api_url"].includes(key)).map(key=>[key,clean(value[key])]));
  };
  const own = blocks.filter(block=>{
    if(block.id===pageId)return false;
    let parent=byId.get(block.parent_id), seen=new Set([block.id]);
    while(parent&&parent.id!==pageId){
      if(seen.has(parent.id))throw new Error("源块结构存在循环");
      seen.add(parent.id);
      if(["page","database"].includes(parent.type))return false;
      parent=byId.get(parent.parent_id);
    }
    return true;
  }).map(block=>["page","database"].includes(block.type)
    ? {id:block.id,type:block.type,parent_id:block.parent_id,title:sourceTitle(block)}
    : Object.fromEntries(Object.entries(block).filter(([key])=>!["created_at","created_by","edited_at","edited_by"].includes(key))));
  return createHash("sha256").update(JSON.stringify(clean(own))).digest("hex");
}

export async function mapPool(items, concurrency, worker) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await worker(items[index], index);
    }
  }));
  return result;
}

// Wolai page metadata is not a reliable aggregate of all descendant block
// changes. Read each page's blocks and compare a stable body fingerprint; only
// changed pages are written to Notion. Signed URL rotations are excluded.
export async function discoverSourceTree({ client, cache, rootIds = null, concurrency = 6, onProgress = () => {}, maxPages = 20000 }) {
  const roots = rootIds ? rootIds.map(id => ({ id })) : await client.listDocs();
  const seen = new Set();
  const documents = [];
  let queue = roots.map((doc) => ({ docId: doc.id, title: doc.title, parentDocId: null, depth: 0, ancestorIds: [] }));
  while (queue.length) {
    const batch = [...new Map(queue.filter((doc) => !seen.has(doc.docId)).map((doc) => [doc.docId, doc])).values()];
    for (const doc of batch) seen.add(doc.docId);
    if (seen.size > maxPages) throw new Error(`源页面数量超出安全上限 ${maxPages}`);
    const rows = await mapPool(batch, concurrency, async (entry) => {
      try {
        const previous = await cache.get(entry.docId);
        const blocks = await client.getPageBlocks(entry.docId);
        const metadata = blocks.find(block=>block.id===entry.docId);
        if (!metadata || metadata.id !== entry.docId || !["page", "database"].includes(metadata.type)) throw new Error("源页面元信息不完整");
        if (!Number.isInteger(metadata.version) || metadata.version < 0) throw new Error("源页面缺少有效版本，禁止生成不完整镜像");
        if (entry.ancestorIds.includes(entry.docId)) throw new Error("源页面层级存在循环");
        const signature = sourceSignature(metadata);
        const bodyHash = pageBodyHash(blocks, entry.docId);
        const baseline = previous?.baseline ?? (previous ? {signature:previous.signature,bodyHash:previous.bodyHash??pageBodyHash(previous.blocks,entry.docId)} : {signature,bodyHash});
        const cached = {id:entry.docId,fetchedAt:new Date().toISOString(),signature,bodyHash,baseline,blocks};
        await cache.set(entry.docId,cached);
        const root = cached.blocks.find((block) => block.id === entry.docId);
        const children = childPagesOf(cached.blocks, entry.docId);
        const actualParent = metadata.parent_type === "workspace" ? null : metadata.page_id;
        const parentDocId = rootIds?.includes(entry.docId) ? null : actualParent && actualParent !== entry.docId ? actualParent : entry.parentDocId;
        const doc = {
          ...entry, parentDocId, title: sourceTitle(root, entry.title), sourceType: root.type,
          version: root.version, editedAt: root.edited_at, sourceParentBlockId: root.parent_id,
          signature: cached.signature, bodyHash, baselineSignature: baseline.signature, baselineBodyHash: baseline.bodyHash, childIds: children.map((child) => child.id),
          blockCount: cached.blocks.length, status: "ready",
        };
        onProgress(doc);
        return { doc, children: children.map((child) => ({
          docId: child.id, title: sourceTitle(child), parentDocId: entry.docId,
          depth: entry.depth + 1, ancestorIds: [...entry.ancestorIds, entry.docId],
        })) };
      } catch (error) {
        const doc = { ...entry, status: "failed", error: error.message };
        onProgress(doc);
        return { doc, children: [] };
      }
    });
    queue = [];
    for (const row of rows) {
      documents.push(row.doc);
      for (const child of row.children) {
        if (child.ancestorIds.includes(child.docId)) throw new Error("源页面层级存在循环");
        if (!seen.has(child.docId)) queue.push(child);
      }
    }
    // A page can be linked more than once; the source ID, not the title/path,
    // determines identity. Resolve the actual parent after every page is read.
    queue = [...new Map(queue.map((entry) => [entry.docId, entry])).values()];
  }
  const byId = new Map(documents.map((doc) => [doc.docId, doc]));
  function pathFor(doc, chain = new Set()) {
    if (chain.has(doc.docId)) throw new Error("源页面层级存在循环");
    if (!doc.parentDocId) return [];
    const parent = byId.get(doc.parentDocId);
    if (!parent) throw new Error("源页面父级不在已授权同步树内");
    return [...pathFor(parent, new Set([...chain, doc.docId])), parent.docId];
  }
  for (const doc of documents) {
    if (doc.status === "failed") continue;
    try {
      doc.ancestorIds = pathFor(doc);
      doc.depth = doc.ancestorIds.length;
    } catch (error) { doc.status = "failed"; doc.error = error.message; }
  }
  documents.sort((a, b) => a.depth - b.depth || a.docId.localeCompare(b.docId));
  return {
    schemaVersion: 2, scanPolicy: "full-block-fingerprint", scannedAt: new Date().toISOString(), rootCount: roots.length, ...(rootIds ? {scopeRootIds: [...rootIds]} : {}),
    total: documents.length, failedCount: documents.filter((doc) => doc.status === "failed").length,
    maxDepth: Math.max(0, ...documents.map((doc) => doc.depth)), documents,
  };
}
