import test from "node:test";
import assert from "node:assert/strict";
import { reconcileChildOrder, pendingChildOrders, planPageMoves, childCreationPosition } from "../lib/page-order.mjs";
import { bodyFingerprint, childMarkup, childPageId } from "../lib/sync-safety.mjs";

function fixture() {
  const a = "11111111111111111111111111111111", b = "22222222222222222222222222222222";
  const tag = id => `<page url="https://www.notion.so/${id}">${id}</page>`;
  let order = [b, a], bodyText = "正文";
  const markdown = () => `> 来源：wolai · doc_id: parent · version: 1\n\n${bodyText}\n${order.map(tag).join("\n")}`;
  const state = { rootPageId: "root", documents: { parent: { notionPageId: "parent-target", status: "synced", targetTitle: "父页", lastNotionBodyHash: bodyFingerprint(markdown()) }, a: { notionPageId: a, notionParentId: "parent-target", status: "synced" }, b: { notionPageId: b, notionParentId: "parent-target", status: "synced" } } };
  const doc = { docId: "parent", parentDocId: null, ancestorIds: [], childIds: ["a", "b"], status: "ready" };
  const tree = { documents: [doc, { docId: "a", parentDocId: "parent" }, { docId: "b", parentDocId: "parent" }] };
  const page = { id: "parent-target", parent: { type: "page_id", page_id: "root" }, properties: { title: { type: "title", title: [{ plain_text: "父页" }] } } };
  const control = { writes: 0, persists: 0, ignoreWrite: false, alterBody: false, loseRestoreReply: false };
  const parents = new Map([[a, page.id], [b, page.id]]);
  const notion = { listBlockChildren: async () => [{ id: "body", type: "paragraph" }, ...order.map(id => ({ id, type: "child_page" }))],
    retrievePage: async id => ({ id, parent: { type: "page_id", page_id: parents.get(id) } }),
    movePage: async (id, parentId) => {
      control.writes += 1;
      if (!control.ignoreWrite) { order = order.filter(value => value !== id); parents.set(id, parentId); if (parentId === page.id) order.push(id); }
      if (control.alterBody) bodyText = "误改正文";
      if (control.loseRestoreReply && parentId === page.id) { control.loseRestoreReply = false; throw new Error("response lost"); }
    },
  };
  const catalog = { ancestry: async () => [page], get: async () => page, readMarkdown: async () => ({ markdown: markdown(), truncated: false, unknown_block_ids: [] }) };
  const opts = { doc, tree, state, notion, catalog, backup: async () => {}, persist: async () => { control.persists += 1; } };
  return { opts, control, config: { navigation: { orderedSourceRoots: ["parent"] } } };
}

test("真实目录读回成功后才记录顺序，重复运行不重复写入", async () => {
  const f = fixture();
  assert.equal(pendingChildOrders(f.opts.tree, f.opts.state, f.config).length, 1);
  assert.equal((await reconcileChildOrder(f.opts)).reordered, true);
  assert.equal(pendingChildOrders(f.opts.tree, f.opts.state, f.config).length, 0);
  assert.equal((await reconcileChildOrder(f.opts)).reordered, false);
  assert.equal(f.control.writes, 2);
});

test("服务返回成功但真实顺序不变时不能推进校验标记", async () => {
  const f = fixture(); f.control.ignoreWrite = true;
  await assert.rejects(reconcileChildOrder(f.opts), /顺序不匹配/);
  assert.equal(f.opts.state.documents.parent.childOrderSignature, null);
});

test("排序造成正文变化时保留失败状态，不接受新正文为基线", async () => {
  const f = fixture(); f.control.alterBody = true;
  const original = f.opts.state.documents.parent.lastNotionBodyHash;
  await assert.rejects(reconcileChildOrder(f.opts), /手工修改|指纹不匹配/);
  assert.equal(f.opts.state.documents.parent.lastNotionBodyHash, original);
  assert.equal(f.opts.state.documents.parent.childOrderSignature, null);
});

test("排序响应丢失时依照持久化日志恢复父级，重试不重复移动", async () => {
  const f = fixture(); f.control.loseRestoreReply = true;
  await assert.rejects(reconcileChildOrder(f.opts), /response lost/);
  assert.equal(f.opts.state.documents.b.pendingOrderMove, undefined);
  assert.equal((await reconcileChildOrder(f.opts)).reordered, false);
  assert.equal(f.control.writes, 2);
});

test("目录预算耗尽时不修改页面，也不能记录排序成功", async () => {
  const f = fixture();
  const result = await reconcileChildOrder({ ...f.opts, maxPageMoves: 0 });
  assert.equal(result.deferred, true); assert.equal(f.control.writes, 0);
  assert.equal(pendingChildOrders(f.opts.tree, f.opts.state, f.config).length, 1);
});

test("只移动不能保留的后缀，前缀相对顺序已正确时无需移动", () => {
  assert.deepEqual(planPageMoves(["b", "a", "c"], ["a", "b", "c"]), ["b", "c"]);
  assert.deepEqual(planPageMoves(["a", "b", "c"], ["a", "b", "c"]), []);
  assert.throws(() => planPageMoves(["a", "b"], ["a", "c"]), /集合/);
});

test("子页还未同步完成时目录不能被记为完成", async () => {
  const f = fixture(); f.opts.state.documents.a.status = "pending";
  await assert.rejects(reconcileChildOrder(f.opts), /尚未同步完成/);
  assert.equal(f.control.writes, 0);
});

test("新增日志根据源顺序定位，第一张子页卡片放在正文之后", async () => {
  const f = fixture(), { tree, state, notion } = f.opts;
  const first = await childCreationPosition({ doc: tree.documents[1], tree, state, config: f.config, notion });
  assert.deepEqual(first, { type: "after_block", after_block: { id: "body" } });
  const second = await childCreationPosition({ doc: tree.documents[2], tree, state, config: f.config, notion });
  assert.deepEqual(second, { type: "after_block", after_block: { id: state.documents.a.notionPageId } });
});
