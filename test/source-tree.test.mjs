import test from "node:test";
import assert from "node:assert/strict";
import { childPagesOf, discoverSourceTree, pageBodyHash } from "../lib/source-tree.mjs";

function fixture() {
  const p = (id, parent_id, parent_type, page_id) => ({ id, type: "page", parent_id, parent_type, page_id, version: 1, content: [{ title: id }], children: {} });
  const pages = {
    root: [p("root", "ws", "workspace", null), { id: "toggle", type: "toggle_list", parent_id: "root" }, p("child", "toggle", "block", "root")],
    child: [p("child", "toggle", "block", "root"), p("grandchild", "child", "block", "child")],
    grandchild: [p("grandchild", "child", "block", "child")],
  };
  const stored = new Map();
  const calls = [];
  return { pages, calls,
    cache: { get: async (id) => stored.get(id), set: async (id, value) => stored.set(id, value) },
    client: { listDocs: async () => [{ id: "root", title: "root" }],
      getDoc: async (id) => { calls.push(`meta:${id}`); return pages[id][0]; },
      getPageBlocks: async (id) => { calls.push(`blocks:${id}`); return structuredClone(pages[id]); } },
  };
}

test("递归发现折叠块内子页及孙级页，按真实父级排序", async () => {
  const f = fixture();
  const tree = await discoverSourceTree(f);
  assert.deepEqual(tree.documents.map((d) => [d.docId, d.parentDocId, d.depth]), [["root", null, 0], ["child", "root", 1], ["grandchild", "child", 2]]);
  assert.equal(tree.failedCount, 0);
});

test("指定日计划根时不枚举其它笔记，仍完整读取折叠块内的后代", async () => {
  const f = fixture();
  f.client.listDocs = async () => { throw new Error("不应枚举全库"); };
  const tree = await discoverSourceTree({ ...f, rootIds: ["root"] });
  assert.deepEqual(tree.scopeRootIds, ["root"]);
  assert.equal(tree.total, 3); assert.equal(tree.failedCount, 0);
  assert.deepEqual(f.calls, ["blocks:root", "blocks:child", "blocks:grandchild"]);
});

test("父页版本不变时仍发现子页自己的变化", async () => {
  const f = fixture();
  await discoverSourceTree(f);
  f.calls.length = 0;
  f.pages.child[0].version = 2;
  const tree = await discoverSourceTree(f);
  assert.equal(tree.documents.find((d) => d.docId === "child").version, 2);
  assert.ok(f.calls.includes("blocks:child"));
  assert.ok(f.calls.includes("blocks:root"));
});

test("页面版本不变而正文块变化时，内容指纹仍检测到变化", async()=>{
  const f=fixture();
  f.pages.child.push({id:"text",type:"text",parent_id:"child",content:[{title:"旧内容"}]});
  const before=await discoverSourceTree(f);
  f.pages.child.at(-1).content=[{title:"新内容"}];
  const after=await discoverSourceTree(f);
  const a=before.documents.find(d=>d.docId==="child"), b=after.documents.find(d=>d.docId==="child");
  assert.equal(a.signature,b.signature);
  assert.notEqual(a.bodyHash,b.bodyHash);
  assert.equal(b.baselineBodyHash,a.bodyHash);
  const again=await discoverSourceTree(f);
  assert.equal(again.documents.find(d=>d.docId==="child").baselineBodyHash,a.bodyHash);
});

test("签名 URL 刷新不引起假增量，正文修改会引起增量",()=>{
  const first=[{id:"root",type:"page"},{id:"img",type:"image",parent_id:"root",media:{stable_ref:"file",download_url:"https://example.com/a?expires=1",expires_in:3600}},{id:"text",type:"text",parent_id:"root",content:[{title:"内容"}]}];
  const second=structuredClone(first);second[1].media.download_url="https://example.com/a?expires=2";
  assert.equal(pageBodyHash(first,"root"),pageBodyHash(second,"root"));
  second[2].content=[{title:"修改"}];
  assert.notEqual(pageBodyHash(first,"root"),pageBodyHash(second,"root"));
});

test("同一页面重复出现不会重复同步", async () => {
  const f = fixture();
  f.client.listDocs = async () => [{ id: "root" }, { id: "root" }];
  const tree = await discoverSourceTree(f);
  assert.equal(new Set(tree.documents.map((d) => d.docId)).size, tree.total);
});

test("不把子页面内部的孙页误认作父页直接孩子", () => {
  assert.deepEqual(childPagesOf([
    { id: "r", type: "page" },
    { id: "c", type: "page", parent_id: "r" },
    { id: "g", type: "page", parent_id: "c" },
  ], "r").map((b) => b.id), ["c"]);
});

test("缺失或损坏响应必须失败，不能当作空页", async () => {
  const f = fixture();
  f.client.getPageBlocks = async () => [];
  const tree = await discoverSourceTree(f);
  assert.equal(tree.failedCount, 1);
});
