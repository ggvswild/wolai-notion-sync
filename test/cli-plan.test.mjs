import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeWorkspace } from "../lib/config.mjs";
import { readJson } from "../lib/storage.mjs";
import { main } from "../bin/cli.mjs";

test("CLI 不加 apply 时只扫描所选来源，不需要 Notion 凭证也不写目标", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-plan-"));
  const oldFetch = globalThis.fetch, oldWolai = process.env.WOLAI_MCP_TOKEN, oldNotion = process.env.NOTION_TOKEN;
  try {
    await initializeWorkspace(dir, { syncScope: { sourceRootIds: ["demo-root"] }, notionRoot: { pageId: "11111111-1111-4111-8111-111111111111" } });
    process.env.WOLAI_MCP_TOKEN = "synthetic-token"; delete process.env.NOTION_TOKEN;
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://api.wolai.com/v1/mcp"); calls++;
      const req = JSON.parse(options.body);
      assert.equal(req.params.name, "get_page_blocks"); assert.equal(req.params.arguments.page_id, "demo-root");
      const data = [{ id: "demo-root", type: "page", parent_type: "workspace", content: [{ title: "Synthetic note" }], version: 1, edited_at: 1, children: {} }];
      return new Response(JSON.stringify({ id: req.id, result: { content: [{ type: "text", text: JSON.stringify({ data: { data } }) }] } }));
    };
    const lines = [];
    assert.equal(await main(["sync", "--data-dir", dir], x => lines.push(x)), 0);
    const plan = JSON.parse(lines[0]);
    assert.equal(plan.mode, "read-only-plan"); assert.equal(plan.scanned, 1); assert.equal(plan.pending, 1);
    assert.equal(calls, 1); assert.deepEqual((await readJson(join(dir, "sync-state.json"))).documents, {});
  } finally {
    globalThis.fetch = oldFetch;
    if (oldWolai === undefined) delete process.env.WOLAI_MCP_TOKEN; else process.env.WOLAI_MCP_TOKEN = oldWolai;
    if (oldNotion === undefined) delete process.env.NOTION_TOKEN; else process.env.NOTION_TOKEN = oldNotion;
    await rm(dir, { recursive: true, force: true });
  }
});
