import { normalizeId } from "./sync-safety.mjs";
import { sourceRootIds } from "./sync-scope.mjs";

export function notionRootIds(config) {
  const primary = config.notionRoot.pageId, archive = config.presentation?.archivePageId;
  if (sourceRootIds(config)) return [primary];
  if (archive && normalizeId(archive) === normalizeId(primary)) throw new Error("资料归档不能与日计划主入口相同");
  return archive ? [primary, archive] : [primary];
}

export function expectedNotionParent(doc, state, config) {
  if (doc.parentDocId) return state.documents[doc.parentDocId]?.notionPageId;
  if (sourceRootIds(config)?.includes(doc.docId)) return config.notionRoot.pageId;
  const presentation = config.presentation;
  return presentation?.archivePageId && !presentation.keepSourceRootIds?.includes(doc.docId)
    ? presentation.archivePageId : config.notionRoot.pageId;
}
