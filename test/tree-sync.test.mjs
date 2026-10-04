import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TreeSync, ensureNativeChildren } from "../lib/tree-sync.mjs";
import { sourceSignature, pageBodyHash } from "../lib/source-tree.mjs";
import { plainText, renderNativeNodes } from "../lib/notion-render.mjs";
import { writeJson, readJson } from "../lib/storage.mjs";

async function fixture() {
  const baseDir = await mkdtemp(join(tmpdir(), "wolai-tree-test-"));
  const metadata = { id: "source", type: "page", parent_type: "workspace", parent_id: "ws", page_id: null, version: 1, edited_at: 1, content: [{ title: "笔记" }], children: {} };
  const signature = sourceSignature(metadata);
  const doc = { docId: "source", title: "笔记", version: 1, editedAt: 1, signature, parentDocId: null, depth: 0, ancestorIds: [], status: "ready" };
  await writeJson(join(baseDir, "cache/source/source.json"), { signature, blocks: [metadata, { id: "text", parent_id: "source", type: "text", content: [{ title: "内容" }] }] });
  const root = { id: "root", parent: { type: "workspace" }, properties: { title: { type: "title", title: [{ text: { content: "根" } }] } } };
  const pages = new Map([["root", root]]), children = new Map();
  const fake = { creates: 0, loseCreateReply: false, wrongReadback: false,
    searchPages: async () => [...pages.values()],
    retrievePage: async id => pages.get(id),
    createPageBlocks: async (parent, title, blocks) => {
      fake.creates += 1;
      const page = { id: "target", parent: { type: "page_id", page_id: parent }, properties: { title: { type: "title", title: [{ text: { content: title } }] } }, created_time: new Date().toISOString() };
      pages.set(page.id, page); children.set(page.id, blocks.map((b,i) => ({ ...b, id: `block${i}` })));
      if (fake.loseCreateReply) { fake.loseCreateReply = false; throw new Error("network response lost"); }
      return page;
    },
    retrievePageMarkdown: async id => ({ markdown: (children.get(id) ?? []).map(b => `${b.type === "quote" ? "> " : ""}${plainText(b[b.type].rich_text)}`).join("\n\n").replace("version: 1", fake.wrongReadback ? "version: 9" : "version: 1"), truncated: false, unknown_block_ids: [] }),
    listBlockChildren: async id => children.get(id) ?? [],
  };
  const state = { rootPageId: "root", documents: {} };
  const opts = { baseDir, config: { notionRoot: { pageId: "root" }, policy: { batchSize: 50 } }, state, tree: { total: 1, failedCount: 0, scannedAt: new Date().toISOString(), documents: [doc] }, source: { getDoc: async () => metadata }, notion: fake };
  return { baseDir, opts, fake, state };
}

test("创建后丢失响应，重新读取准确来源标识恢复而不是重复建页", async () => {
  const f = await fixture();
  try {
    f.fake.loseCreateReply = true;
    await new TreeSync(f.opts).run();
    assert.equal(f.state.documents.source.sourceVersion, null);
    await new TreeSync(f.opts).run();
    assert.equal(f.fake.creates, 1);
    assert.equal(f.state.documents.source.sourceVersion, 1);
    assert.equal(f.state.documents.source.status, "synced");
  } finally { await rm(f.baseDir, { recursive: true, force: true }); }
});

test("重新 fetch 验证失败时不推进源版本", async () => {
  const f = await fixture();
  try {
    f.fake.wrongReadback = true;
    const result = await new TreeSync(f.opts).run();
    assert.ok(result.failed + result.conflicts > 0);
    assert.equal(f.state.documents.source.sourceVersion, null);
    assert.notEqual(f.state.documents.source.status, "synced");
  } finally { await rm(f.baseDir, { recursive: true, force: true }); }
});

test("归档中的非日计划根笔记增量仍在指定归档下创建，日计划入口不会重新变乱", async () => {
  const f = await fixture();
  try {
    f.opts.config.presentation = { archivePageId: "archive", keepSourceRootIds: ["daily"] };
    const retrieve = f.fake.retrievePage;
    f.fake.retrievePage = async id => id === "archive" ? { id, parent: { type: "workspace" }, properties: { title: { type: "title", title: [{ text: { content: "资料归档" } }] } } } : retrieve(id);
    const result = await new TreeSync(f.opts).run();
    assert.equal(result.created, 1);
    assert.equal(result.failed, 0);
    assert.equal(f.state.documents.source.notionParentId, "archive");
  } finally { await rm(f.baseDir, { recursive: true, force: true }); }
});

test("归档迁移未完成时日常同步等待，不在部分移动后的目录重复写入", async () => {
  const f = await fixture();
  try {
    f.state.organizationMigration = { status: "running" };
    await assert.rejects(new TreeSync(f.opts).run(), /归档调整尚未完成/);
    assert.equal(f.fake.creates, 0);
  } finally { await rm(f.baseDir, { recursive: true, force: true }); }
});

test("仅同步日计划时旧全库候选和归档例外不会被处理或计入本次结果", async () => {
  const f = await fixture();
  try {
    f.opts.config.syncScope = { sourceRootIds: ["source"] };
    f.opts.config.presentation = { archivePageId: "archive", keepSourceRootIds: [] };
    f.opts.tree.documents.push({ docId: "other", parentDocId: null, ancestorIds: [], depth: 0, status: "ready", version: 2 });
    f.opts.tree.total = 2;
    f.state.documents.other = { notionPageId: "old-other", status: "pending", sourceVersion: 1, mediaExceptions: [{ bytes: 9000000 }], contentFallback: { mode: "archive" } };
    const before = structuredClone(f.state.documents.other);
    const runner = new TreeSync(f.opts), result = await runner.run();
    assert.equal(result.scanned, 1); assert.equal(result.created, 1); assert.equal(result.failed, 0);
    assert.equal(f.state.documents.source.notionParentId, "root");
    assert.deepEqual(f.state.documents.other, before);
    assert.equal(result.mediaExceptions, 0); assert.equal(result.archivePages, 0);
    await assert.rejects(runner.process(f.opts.tree.documents[1]), /同步范围/);
  } finally { await rm(f.baseDir, { recursive: true, force: true }); }
});

test("来源标识正确但实际写入缺少正文时，不把残缺目标保存成成功基线", async () => {
  const f = await fixture();
  try {
    const create = f.fake.createPageBlocks;
    f.fake.createPageBlocks = (parent, title, blocks) => create(parent, title, blocks.slice(0, 1));
    const result = await new TreeSync(f.opts).run();
    assert.ok(result.failed + result.conflicts > 0);
    assert.equal(f.state.documents.source.sourceVersion, null);
    assert.equal(f.state.documents.source.lastNotionBodyHash, undefined);
  } finally { await rm(f.baseDir, { recursive: true, force: true }); }
});

test("未完成正文只追加缺失尾部，不重写已写入块", async () => {
  const request = text => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text } }] } });
  const rows = [{ ...request("第一段"), id: "one" }];
  const appended = [];
  await ensureNativeChildren({ listBlockChildren: async () => rows, appendBlocks: async (id, body) => { appended.push(...body); return { results: body.map(b => ({ ...b, id: "two" })) }; } }, "page", ["第一段", "第二段"].map(text => ({ request: request(text), children: [] })));
  assert.equal(appended.length, 1);
  assert.equal(plainText(appended[0].paragraph.rich_text), "第二段");
});

test("首次请求只打包两层后，补写必须读取第三层实际内容而不是重新按打包深度推断", async () => {
  const req = (type, text) => ({ object: "block", type, [type]: { rich_text: [{ type: "text", text: { content: text } }] } });
  const deep = { sourceId: "deep", request: req("paragraph", "第三层原文"), children: [] };
  const child = { sourceId: "child", request: req("bulleted_list_item", "第二层"), children: [deep] };
  const root = { sourceId: "root", request: req("to_do", "第一层"), children: [child] };
  const rows = new Map([["page", [{ ...root.request, id: "r" }]], ["r", [{ ...child.request, id: "c" }]], ["c", []]]);
  let appended = 0;
  const client = { listBlockChildren: async id => structuredClone(rows.get(id) ?? []), appendBlocks: async (id, requests) => {
    const created = requests.map((request, i) => ({ ...request, id: `${id}-added-${i}` }));
    rows.set(id, [...(rows.get(id) ?? []), ...created]); appended += created.length;
    return { results: created };
  } };
  await ensureNativeChildren(client, "page", [root]);
  assert.equal(rows.get("c").length, 1);
  assert.equal(plainText(rows.get("c")[0].paragraph.rich_text), "第三层原文");
  await ensureNativeChildren(client, "page", [root]);
  assert.equal(appended, 1);
});

test("原生补写拒绝叶子块内的额外手工内容和写入返回的文字差异", async () => {
  const request = { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "原文" } }] } };
  const nodes = [{ request, children: [] }];
  await assert.rejects(ensureNativeChildren({ listBlockChildren: async id => id === "page" ? [{ ...request, id: "leaf", has_children: true }] : [{ ...request, id: "manual" }] }, "page", nodes), /手工子内容/);
  await assert.rejects(ensureNativeChildren({ listBlockChildren: async () => [], appendBlocks: async () => ({ results: [{ ...request, id: "new", paragraph: { rich_text: [{ text: { content: "截断" } }] } }] }) }, "page", nodes), /读回正文不匹配/);
});

test("续传能识别 Notion 自动移除回车控制字符后的原生块", async () => {
  for (const type of ["code", "bull_list", "todo_list"]) {
    const warnings = new Set();
    const nodes = renderNativeNodes([
      { id: "source", type: "page" },
      { id: "first", parent_id: "source", type, language: "javascript", content: "before\rmiddle\r\nafter\r" },
      { id: "tail", parent_id: "source", type: "text", content: "缺失尾部" },
    ], { docId: "source", version: 1, signature: "x" }, new Map(), warnings);
    const rows = nodes.slice(0, 2).map((node, i) => {
      const row = structuredClone(node.request);
      row.id = `block-${i}`;
      for (const span of row[row.type].rich_text) span.text.content = span.text.content.replaceAll("\r", "");
      return row;
    });
    const appended = [];
    await ensureNativeChildren({ listBlockChildren: async () => rows, appendBlocks: async (id, blocks) => {
      appended.push(...blocks);
      return { results: blocks.map(block => ({ ...block, id: "new-tail" })) };
    } }, "page", nodes);
    assert.equal(appended.length, 1);
    assert.equal(plainText(appended[0].paragraph.rich_text), "缺失尾部");
    assert.ok(warnings.has("notion-normalized-carriage-return"));
  }
});

test("续传仍严格拒绝正文和空格的手工差异，不能因回车兼容而忽略", async () => {
  const nodes = renderNativeNodes([{ id: "text", parent_id: "source", type: "text", content: "original content" }], { docId: "source", version: 1, signature: "x" });
  for (const changed of ["manual content", "original  content", "original content "]) {
    const rows = nodes.map((node, i) => ({ ...structuredClone(node.request), id: `block-${i}` }));
    rows[1].paragraph.rich_text[0].text.content = changed;
    let appended = false;
    await assert.rejects(ensureNativeChildren({ listBlockChildren: async () => rows, appendBlocks: async () => { appended = true; } }, "page", nodes), /不匹配/);
    assert.equal(appended, false);
  }
});

test("页面版本不变的正文增量会真正写入，而不是仅推进状态",async()=>{
  const f=await fixture();
  try{
    await new TreeSync(f.opts).run();
    const cached=await readJson(join(f.baseDir,"cache/source/source.json"));
    cached.blocks[1].content=[{title:"真正变化的正文"}];
    const nextHash=pageBodyHash(cached.blocks,"source");
    await writeJson(join(f.baseDir,"cache/source/source.json"),cached);
    f.opts.tree.documents[0].bodyHash=nextHash;
    f.opts.source.getPageBlocks=async()=>cached.blocks;
    const originalRead=f.fake.retrievePageMarkdown;
    let replacement;
    f.fake.retrievePageMarkdown=async id=>replacement?{markdown:replacement,truncated:false,unknown_block_ids:[]}:originalRead(id);
    f.fake.replacePageMarkdown=async(id,markdown)=>{replacement=markdown;return {markdown};};
    const result=await new TreeSync(f.opts).run();
    assert.equal(result.updated,1);
    assert.match(replacement,/真正变化的正文/);
    assert.equal(f.state.documents.source.sourceVersion,1);
    assert.equal(f.state.documents.source.sourceBodyHash,nextHash);
  }finally{await rm(f.baseDir,{recursive:true,force:true});}
});

test("增量更新只保留了正确来源标识却漏写正文时，不推进源正文指纹或目标基线", async () => {
  const f = await fixture();
  try {
    await new TreeSync(f.opts).run();
    const before = structuredClone(f.state.documents.source);
    const cached = await readJson(join(f.baseDir, "cache/source/source.json"));
    cached.blocks[1].content = [{ title: "不得静默丢失的新正文" }];
    f.opts.tree.documents[0].bodyHash = pageBodyHash(cached.blocks, "source");
    f.opts.source.getPageBlocks = async () => cached.blocks;
    await writeJson(join(f.baseDir, "cache/source/source.json"), cached);
    const originalRead = f.fake.retrievePageMarkdown;
    let replacement;
    f.fake.retrievePageMarkdown = async id => replacement ? { markdown: replacement, truncated: false, unknown_block_ids: [] } : originalRead(id);
    f.fake.replacePageMarkdown = async (id, markdown) => ({ markdown: replacement = markdown.split("\n")[0] });
    const result = await new TreeSync(f.opts).run();
    assert.ok(result.failed + result.conflicts > 0);
    assert.equal(f.state.documents.source.sourceBodyHash, before.sourceBodyHash);
    assert.equal(f.state.documents.source.lastNotionBodyHash, before.lastNotionBodyHash);
  } finally { await rm(f.baseDir, { recursive: true, force: true }); }
});

test("ZIP 附件必须字节读回一致才推进版本，失败后在原页面恢复", async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  try {
    const sourceBytes = Buffer.from("original drawing bytes");
    globalThis.fetch = async () => new Response(sourceBytes, { headers: { "content-type": "application/octet-stream" } });
    const cached = await readJson(join(f.baseDir, "cache/source/source.json"));
    cached.blocks.push({ id: "file", parent_id: "source", type: "file", version: 1, file_name: "diagram.drawio", media: { stable_ref: "drawing", download_url: "https://example.invalid/diagram.drawio" } });
    await writeJson(join(f.baseDir, "cache/source/source.json"), cached);
    let uploaded, wrongHash = true, hashReads = 0;
    f.fake.uploadBytes = async bytes => { uploaded = Buffer.from(bytes); return "zip-upload"; };
    const list = f.fake.listBlockChildren;
    f.fake.listBlockChildren = async id => (await list(id)).map(block => block.type === "file" ? { ...block, file: { ...block.file, type: "file", file: { url: "https://example.invalid/attached.zip" } } } : block);
    f.fake.hashRemoteFile = async url => {
      assert.equal(url, "https://example.invalid/attached.zip");
      hashReads += 1;
      return { bytes: uploaded.length, sha256: wrongHash ? "incorrect" : createHash("sha256").update(uploaded).digest("hex") };
    };
    const first = await new TreeSync(f.opts).run();
    assert.equal(first.failed, 1);
    assert.equal(f.state.documents.source.sourceVersion, null);
    assert.equal(f.state.documents.source.status, "partial");
    wrongHash = false;
    const second = await new TreeSync(f.opts).run();
    assert.equal(second.failed, 0);
    assert.equal(f.fake.creates, 1);
    assert.equal(hashReads, 2);
    assert.equal(f.state.documents.source.sourceVersion, 1);
    assert.equal(f.state.documents.source.status, "synced_with_exceptions");
    assert.equal(second.mediaArchives, 1);
    assert.equal(second.mediaBackfillComplete, false);
  } finally { globalThis.fetch = originalFetch; await rm(f.baseDir, { recursive: true, force: true }); }
});
