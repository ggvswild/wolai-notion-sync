import { normalizeId, digest, childMarkup, childPageId, planChildPageOrder, bodyFingerprint, validateTarget } from "./sync-safety.mjs";
import { pageTitle } from "./notion-catalog.mjs";

export function inOrderedScope(doc, config) {
  return (config.navigation?.orderedSourceRoots ?? []).some(id => doc.docId === id || doc.ancestorIds?.includes(id));
}

export function desiredChildIds(doc, tree) {
  const byId = new Map(tree.documents.map(d => [d.docId, d]));
  return (doc.childIds ?? []).filter(id => byId.get(id)?.parentDocId === doc.docId);
}

export function childOrderSignature(doc, tree, state) {
  return digest(JSON.stringify(desiredChildIds(doc, tree).map(id => [id, normalizeId(state.documents[id]?.notionPageId)])));
}

export function pendingChildOrders(tree, state, config) {
  return tree.documents.filter(doc => doc.status === "ready" && inOrderedScope(doc, config) && desiredChildIds(doc, tree).length &&
    state.documents[doc.docId]?.childOrderSignature !== childOrderSignature(doc, tree, state));
}

export async function childCreationPosition({ doc, tree, state, config, notion }) {
  const parent = tree.documents.find(d => d.docId === doc.parentDocId);
  if (!parent || !inOrderedScope(parent, config)) return undefined;
  const siblings = desiredChildIds(parent, tree), index = siblings.indexOf(doc.docId);
  if (index < 0) throw new Error("新子页不在源父目录顺序中");
  const parentId = state.documents[parent.docId]?.notionPageId;
  const previous = siblings.slice(0, index).reverse().map(id => state.documents[id]).find(row => row?.notionPageId && !row.pendingOrderMove &&
    ["synced", "synced_with_exceptions"].includes(row.status) && normalizeId(row.notionParentId) === normalizeId(parentId));
  if (previous) return { type: "after_block", after_block: { id: previous.notionPageId } };
  const rows = await notion.listBlockChildren(parentId);
  const body = rows.filter(b => !["child_page", "child_database"].includes(b.type));
  return body.length ? { type: "after_block", after_block: { id: body.at(-1).id } } : { type: "page_start" };
}

const pageIds = rows => rows.filter(b => b.type === "child_page").map(b => normalizeId(b.id));
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

export function planPageMoves(actual, desired) {
  if (new Set(actual).size !== actual.length || !same([...actual].sort(), [...desired].sort())) throw new Error("目录页面集合不匹配");
  let cursor = -1, keep = 0;
  for (const id of desired) {
    const index = actual.indexOf(id, cursor + 1);
    if (index < 0) break;
    cursor = index; keep += 1;
  }
  return desired.slice(keep);
}

export async function recoverOrderMove({ sourceDocId, state, notion, catalog, persist }) {
  const record = state.documents[sourceDocId], journal = record?.pendingOrderMove;
  if (!journal) return;
  if (journal.sourceDocId !== sourceDocId || normalizeId(journal.pageId) !== normalizeId(record.notionPageId) ||
      normalizeId(journal.fromParentId) !== normalizeId(record.notionParentId) || normalizeId(journal.rootPageId) !== normalizeId(state.rootPageId) ||
      normalizeId(journal.fromParentId) === normalizeId(state.rootPageId) || !(await catalog.ancestry(journal.fromParentId))) throw new Error("排序恢复日志与授权范围不匹配");
  let page = await notion.retrievePage(journal.pageId);
  if (page.in_trash || page.archived) throw new Error("排序恢复页面已删除，保留现场");
  if (normalizeId(page.parent?.page_id) === normalizeId(journal.rootPageId)) {
    await notion.movePage(page.id, journal.fromParentId);
    page = await notion.retrievePage(page.id);
  }
  if (normalizeId(page.parent?.page_id) !== normalizeId(journal.fromParentId)) throw new Error("排序恢复遇到手工移动，保留现场");
  catalog.put?.(page);
  const parent = Object.values(state.documents).find(row => normalizeId(row.notionPageId) === normalizeId(journal.fromParentId));
  if (parent) parent.childOrderSignature = null;
  delete record.pendingOrderMove;
  await persist();
}

export async function reconcileChildOrder({ doc, tree, state, notion, catalog, persist, backup, targetPage, targetMarkdown, maxPageMoves = Infinity, onMoveAttempt = () => {} }) {
  const record = state.documents[doc.docId];
  const children = desiredChildIds(doc, tree);
  let recovered = false;
  for (const id of children) if (state.documents[id]?.pendingOrderMove) {
    await recoverOrderMove({ sourceDocId: id, state, notion, catalog, persist }); recovered = true;
  }
  const ready = row => row?.notionPageId && ["synced", "synced_with_exceptions"].includes(row.status);
  if (!ready(record) || children.some(id => !ready(state.documents[id]))) throw new Error("目录子页尚未同步完成");
  const desired = children.map(id => normalizeId(state.documents[id].notionPageId));
  if (!(await catalog.ancestry(record.notionPageId))) throw new Error("排序页面不在授权根目录内");
  const page = targetPage ?? await catalog.get(record.notionPageId, true);
  const expectedParent = doc.parentDocId ? state.documents[doc.parentDocId]?.notionPageId : state.rootPageId;
  if (normalizeId(page.parent?.page_id) !== normalizeId(expectedParent)) throw new Error("目标页面父级存在手工移动");
  const md = !recovered && targetMarkdown ? targetMarkdown : await catalog.readMarkdown(page.id, true);
  validateTarget(doc, record, { ...md, title: pageTitle(page) });
  const plan = planChildPageOrder(md.markdown, desired);
  const before = await notion.listBlockChildren(page.id);
  const beforeIds = pageIds(before);
  const known = new Set(desired);
  if (new Set(beforeIds).size !== beforeIds.length || desired.some(id => !beforeIds.includes(id))) throw new Error("目录实际子页缺失或重复");
  const markdownIds = childMarkup(md.markdown).map(childPageId).filter(Boolean);
  if (!same(markdownIds, beforeIds)) throw new Error("目录 Markdown 与实际子页顺序不一致");
  if (plan.changed) {
    const fresh = await catalog.get(page.id, true);
    if (normalizeId(fresh.parent?.page_id) !== normalizeId(expectedParent)) throw new Error("排序前目标父级存在手工移动");
    validateTarget(doc, record, { ...md, title: pageTitle(fresh) });
    await backup({ pageId: page.id, markdown: md.markdown, childIds: beforeIds, desiredIds: desired });
    // Markdown round trips can reparse literal list prefixes and trim spaces.
    // Reorder page entities only: move a managed child to the authorized export
    // root, then back to append it. Persist a recovery journal before each move.
    // Keeping the longest desired prefix already in relative order minimizes
    // the pages that need moving. Bodies and native body blocks are untouched.
    const plannedAllIds = childMarkup(plan.content).map(childPageId).filter(Boolean);
    const moves = planPageMoves(beforeIds, plannedAllIds);
    record.childOrderSignature = null;
    await persist();
    if (moves.some(id => !known.has(id))) throw new Error("手工子页位置无法安全排序，保留现场");
    let movedPages = 0;
    for (const id of moves.slice(0, maxPageMoves)) {
      const sourceDocId = children.find(childId => normalizeId(state.documents[childId].notionPageId) === id);
      const childRecord = state.documents[sourceDocId], child = await notion.retrievePage(childRecord.notionPageId);
      if (normalizeId(child.parent?.page_id) !== normalizeId(page.id) || child.in_trash || child.archived) throw new Error("排序子页父级不匹配，禁止移动");
      onMoveAttempt();
      childRecord.pendingOrderMove = { sourceDocId, pageId: child.id, fromParentId: page.id, rootPageId: state.rootPageId, startedAt: new Date().toISOString() };
      record.childOrderSignature = null;
      await persist();
      try {
        await notion.movePage(child.id, state.rootPageId);
        await notion.movePage(child.id, page.id);
        await recoverOrderMove({ sourceDocId, state, notion, catalog, persist });
      } catch (error) {
        // A read determines whether the first or second move committed; never
        // leave a successfully staged page detached after a recoverable error.
        try { await recoverOrderMove({ sourceDocId, state, notion, catalog, persist }); } catch {}
        throw error;
      }
      movedPages += 1;
    }
    if (movedPages < moves.length) return { reordered: false, deferred: true, movedPages, remainingMoves: moves.length - movedPages };
    const afterMd = await catalog.readMarkdown(page.id, true);
    validateTarget(doc, record, { ...afterMd, title: pageTitle(page) });
    if (bodyFingerprint(md.markdown) !== bodyFingerprint(afterMd.markdown)) throw new Error("目录排序后正文指纹不匹配");
    const after = await notion.listBlockChildren(page.id), afterIds = pageIds(after);
    if (!same([...afterIds].sort(), [...beforeIds].sort()) || !same(afterIds.filter(id => known.has(id)), desired)) throw new Error("目录排序后实际页面 ID 或顺序不匹配");
    if (!same(afterIds, plannedAllIds)) throw new Error("目录排序后手工子页位置不匹配");
    const bodyIds = rows => rows.filter(b => !["child_page", "child_database"].includes(b.type)).map(b => b.id);
    if (!same(bodyIds(before), bodyIds(after))) throw new Error("目录排序意外改动正文块 ID");
    if (planChildPageOrder(afterMd.markdown, desired).changed) throw new Error("目录排序读回未生效");
  } else if (!same(beforeIds.filter(id => known.has(id)), desired)) throw new Error("目录顺序不匹配");
  record.childOrderSignature = childOrderSignature(doc, tree, state);
  record.childOrderVerifiedAt = new Date().toISOString();
  record.childOrderError = null;
  await persist();
  return { reordered: plan.changed, childCount: desired.length, retainedExtraChildren: beforeIds.filter(id => !known.has(id)).length };
}
