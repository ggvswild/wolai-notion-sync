import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, initializeWorkspace, loadWorkspace } from "../lib/config.mjs";
import { sourceCache, writeJson } from "../lib/storage.mjs";
import { WolaiClient, parseMcpMessage } from "../lib/wolai-client.mjs";
import { NotionRestClient } from "../lib/notion-rest-client.mjs";
import { safeError } from "../lib/sync-safety.mjs";
import { main } from "../bin/cli.mjs";
import { privacyFindings } from "../scripts/privacy-check.mjs";

const target = "11111111-1111-4111-8111-111111111111";
const config = () => ({ syncScope: { sourceRootIds: ["demo-root"] }, notionRoot: { pageId: target } });
async function workspace(fn) { const dir = await mkdtemp(join(tmpdir(), "portable-sync-")); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test("公开配置没有账号默认值，缺失根或关闭保护时拒绝运行", () => {
  assert.throws(() => validateConfig({ notionRoot: { pageId: target } }), /显式配置/);
  assert.throws(() => validateConfig({ ...config(), policy: { overwriteManualNotionEdits: true } }), /保护/);
  assert.throws(() => validateConfig({ ...config(), token: "private-value" }), /凭证/);
  assert.throws(() => validateConfig({ ...config(), syncScope: { sourceRootIds: ["../escape"] } }), /根页面/);
  assert.equal(validateConfig(config()).policy.batchSize, 50);
});
test("无需凭证即可初始化；已有状态和不同目标绑定不被覆盖", async () => workspace(async dir => {
  await initializeWorkspace(dir, config());
  assert.equal((await loadWorkspace(dir)).state.rootPageId, target);
  await assert.rejects(initializeWorkspace(dir, config()), /已有同步状态/);
  await writeJson(join(dir, "sync-config.json"), { ...config(), notionRoot: { pageId: "22222222-2222-4222-8222-222222222222" } });
  await assert.rejects(loadWorkspace(dir), /绑定不一致/);
}));
test("缓存中的不安全来源 ID 不会逃出私人数据目录", async () => workspace(async dir => {
  assert.throws(() => sourceCache(dir).get("../outside"), /不安全/);
}));
test("Wolai 客户端不读取应用凭证，只允许读取工具", async () => {
  assert.throws(() => new WolaiClient({ token: "" }), /WOLAI_MCP_TOKEN/);
  const client = new WolaiClient({ token: "synthetic-token", fetchImpl: () => { throw new Error("must not run"); } });
  await assert.rejects(client.call("delete_page"), /禁止写入/);
});
test("MCP JSON/SSE 响应、匹配 ID 和实际资源结构均检查", async () => {
  assert.deepEqual(parseMcpMessage('data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', 1), { tools: [] });
  const client = new WolaiClient({ token: "synthetic-token", fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer synthetic-token");
    const req = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: req.id, result: { content: [{ type: "text", text: JSON.stringify({ data: { data: [{ id: "demo-root", type: "page" }] } }) }] } }));
  } });
  assert.equal((await client.getPageBlocks("demo-root"))[0].id, "demo-root");
});
test("授权失败不重试、不改凭证，也不回显服务正文", async () => {
  let calls = 0;
  const client = new WolaiClient({ token: "synthetic-token", fetchImpl: async () => { calls++; return new Response("private server body", { status: 403 }); } });
  await assert.rejects(client.getPageBlocks("demo-root"), e => !e.message.includes("private server body") && /403/.test(e.message));
  assert.equal(calls, 1);
});
test("Notion 只接受显式环境或参数凭证，不依赖钥匙串", () => {
  const old = process.env.NOTION_TOKEN; delete process.env.NOTION_TOKEN;
  try { assert.throws(() => new NotionRestClient(), /NOTION_TOKEN/); assert.equal(new NotionRestClient({ token: "synthetic-token" }).token, "synthetic-token"); }
  finally { if (old !== undefined) process.env.NOTION_TOKEN = old; }
});
test("CLI 状态为本地操作，非法参数拒绝且不会启动写入", async () => workspace(async dir => {
  await initializeWorkspace(dir, config()); const lines = [];
  assert.equal(await main(["status", "--data-dir", dir], value => lines.push(value)), 0);
  assert.equal(JSON.parse(lines[0]).synced, false);
  await assert.rejects(main(["status", "--data-dir", dir, "--apply"]), /参数/);
}));
test("未知格式的实际环境凭证也能脱敏，不只依赖 Token 前缀", () => {
  const old = process.env.WOLAI_MCP_TOKEN; process.env.WOLAI_MCP_TOKEN = "opaque-synthetic-credential";
  try { assert.ok(!safeError(new Error("opaque-synthetic-credential failed")).includes("opaque-synthetic-credential")); }
  finally { if (old === undefined) delete process.env.WOLAI_MCP_TOKEN; else process.env.WOLAI_MCP_TOKEN = old; }
});
test("发布隐私检查能发现真实格式凭证和私有运行文件，不打印匹配值", () => {
  const secret = "ntn_" + "x".repeat(30);
  const findings = privacyFindings(secret, "lib/example.mjs");
  assert.equal(findings[0].kind, "credential-pattern");
  assert.ok(!JSON.stringify(findings).includes(secret));
  assert.equal(privacyFindings("{}", "sync-state.json")[0].kind, "private-runtime-file");
});
