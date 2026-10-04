import test from "node:test";
import assert from "node:assert/strict";
import { NotionCatalog } from "../lib/notion-catalog.mjs";

function page(id, title, parent) {
  return { id, parent: parent ? { type: "page_id", page_id: parent } : { type: "workspace" }, properties: { title: { type: "title", title: [{ text: { content: title } }] } }, created_time: "2020-01-01T00:00:00Z" };
}

test("两个同名同内容源页并发认领时，不能使用同一个 Notion ID", async () => {
  const pages = [page("root", "根"), page("parent", "分类", "root"), page("legacy", "同名笔记", "parent")];
  const catalog = new NotionCatalog({ retrievePageMarkdown: async()=>({ markdown: "正文", truncated: false }), listBlockChildren: async()=>[{ id: "body", type: "paragraph", paragraph: { rich_text: [{ text: { content: "正文" } }] } }] }, "root");
  pages.forEach(p=>catalog.put(p));
  const tree = { documents: [{ docId: "source-parent", title: "分类" }] }, state={documents:{"source-parent":{notionPageId:"parent"}}};
  const docs = ["source-a","source-b"].map(docId=>({docId,title:"同名笔记",parentDocId:"source-parent",ancestorIds:["source-parent"]}));
  const matches = await Promise.all(docs.map(doc=>catalog.resolve(doc,[{id:doc.docId,type:"page"},{id:"text",type:"text",parent_id:doc.docId,content:[{title:"正文"}]}],tree,state)));
  assert.equal(matches.filter(Boolean).length,1);
});

test("同内容日期子笔记不能跨日期认领", async () => {
  const pages = [page("root", "根"),page("diary","日计划表","root"),page("wrong-date","2025/06/24","diary"),page("legacy","开发","wrong-date")];
  const catalog = new NotionCatalog({ retrievePageMarkdown:async()=>({markdown:"正文"}),listBlockChildren:async()=>[{type:"paragraph",paragraph:{rich_text:[{text:{content:"正文"}}]}}] },"root");
  pages.forEach(p=>catalog.put(p));
  const doc={docId:"source",title:"开发",parentDocId:"day",ancestorIds:["diary-source","day"]};
  const match=await catalog.resolve(doc,[{id:"text",type:"text",parent_id:"source",content:[{title:"正文"}]}],{documents:[{docId:"diary-source",title:"日计划表"},{docId:"day",title:"2025/06/25"}]},{documents:{}});
  assert.equal(match,null);
});

test("历史图片只有字节一致才能认领", async()=>{
  const catalog=new NotionCatalog({hashRemoteFile:async url=>({sha256:url.endsWith("same")?"same":"different"})},"root");
  assert.equal(await catalog.matchMedia([{media:{download_url:"https://source/same"}}],[{type:"image",image:{file:{url:"https://target/same"}}}]),true);
  assert.equal(await catalog.matchMedia([{media:{download_url:"https://source/same"}}],[{type:"image",image:{file:{url:"https://target/different"}}}]),false);
});
