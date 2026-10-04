export function sourceRootIds(config) {
  const ids = config.syncScope?.sourceRootIds;
  if (ids === undefined) return null;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error("同步来源范围必须是非空、唯一的页面 ID 列表");
  return ids;
}

export function inSyncScope(doc, config) {
  const ids = sourceRootIds(config);
  return !ids || ids.some(id => doc.docId === id || doc.ancestorIds?.includes(id));
}

export function scopedSourceTree(tree, config) {
  const ids = sourceRootIds(config);
  if (!ids) return tree;
  if (ids.some(id => !tree.documents.some(doc => doc.docId === id))) throw new Error("源清单缺少配置的同步根页面，必须重新扫描");
  const roots = new Set(ids);
  const documents = tree.documents.filter(doc => inSyncScope(doc, config)).map(doc => {
    const first = (doc.ancestorIds ?? []).findIndex(id => roots.has(id));
    const ancestorIds = roots.has(doc.docId) ? [] : doc.ancestorIds.slice(first);
    return { ...doc, parentDocId: roots.has(doc.docId) ? null : doc.parentDocId, ancestorIds, depth: ancestorIds.length };
  });
  return { ...tree, scopeRootIds: [...ids], rootCount: ids.length, total: documents.length,
    failedCount: documents.filter(doc => doc.status === "failed").length, maxDepth: Math.max(0, ...documents.map(doc => doc.depth)), documents };
}
