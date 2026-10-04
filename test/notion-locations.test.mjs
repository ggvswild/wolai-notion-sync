import test from "node:test";
import assert from "node:assert/strict";
import { expectedNotionParent, notionRootIds } from "../lib/notion-locations.mjs";
import { NotionCatalog } from "../lib/notion-catalog.mjs";

const config = { notionRoot: { pageId: "showcase" }, presentation: { archivePageId: "archive", keepSourceRootIds: ["daily"] } };
test("日计划主目录继续留在原入口，其他根笔记及新增笔记进入资料归档", () => {
  const state = { documents: { parent: { notionPageId: "actual-parent" } } };
  assert.equal(expectedNotionParent({ docId: "daily" }, state, config), "showcase");
  assert.equal(expectedNotionParent({ docId: "other" }, state, config), "archive");
  assert.equal(expectedNotionParent({ docId: "new" }, state, config), "archive");
  assert.equal(expectedNotionParent({ docId: "child", parentDocId: "parent" }, state, config), "actual-parent");
});
test("只能接管明确配置的两个根目录，其它工作区页面和垃圾箱页面仍不属于镜像", async () => {
  const pages = new Map([
    ["a", { id: "a", parent: { type: "page_id", page_id: "archive" } }],
    ["b", { id: "b", parent: { type: "page_id", page_id: "unrelated" } }],
    ["unrelated", { id: "unrelated", parent: { type: "workspace" } }],
    ["trash", { id: "trash", in_trash: true, parent: { type: "page_id", page_id: "showcase" } }],
  ]);
  const catalog = new NotionCatalog({ retrievePage: async id => pages.get(id) }, "showcase", notionRootIds(config).slice(1));
  assert.equal((await catalog.ancestry("a")).length, 1);
  assert.equal(await catalog.ancestry("b"), null);
  assert.equal(await catalog.ancestry("trash"), null);
  assert.throws(() => notionRootIds({ ...config, presentation: { archivePageId: "showcase" } }), /不能/);
});
