#!/usr/bin/env node
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { isEntryPoint } from "../lib/entry-point.mjs";
import undici from "undici";
import { initializeWorkspace, loadWorkspace } from "../lib/config.mjs";
import { readJson, writeJson, sourceCache, acquireLock } from "../lib/storage.mjs";
import { WolaiClient } from "../lib/wolai-client.mjs";
import { NotionRestClient } from "../lib/notion-rest-client.mjs";
import { discoverSourceTree } from "../lib/source-tree.mjs";
import { scopedSourceTree } from "../lib/sync-scope.mjs";
import { pendingDocuments, safeError } from "../lib/sync-safety.mjs";
import { pendingChildOrders } from "../lib/page-order.mjs";
import { TreeSync } from "../lib/tree-sync.mjs";
import { verifyWorkspace } from "../lib/verify-workspace.mjs";

const HELP = `Wolai → Notion, local-first and one-way
Usage: wolai-notion-sync <init|check|sync|status|verify> [options]
  --data-dir DIR          Private runtime directory (default .wolai-notion-sync)
  --source-root ID        Wolai root, repeatable; init only
  --notion-root UUID      Existing Notion export root; init only
  --apply                Write to Notion; otherwise sync is a read-only plan
  --resume               Reuse a complete source snapshot under 24 hours old
  --limit N              Batch budget, 1–500 (default configured batchSize)
  --concurrency N        1–6 (default 4)
  --remote               Read-only permission/API check; check only
  --help                 Show this help
Credentials: WOLAI_MCP_TOKEN and NOTION_TOKEN in your environment.
No credential is read from another application or saved by this CLI.`;
export async function main(argv = process.argv.slice(2), log = console.log) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { "data-dir": { type: "string" }, "source-root": { type: "string", multiple: true }, "notion-root": { type: "string" }, apply: { type: "boolean" }, resume: { type: "boolean" }, limit: { type: "string" }, concurrency: { type: "string" }, remote: { type: "boolean" }, help: { type: "boolean" } } });
  if (v.help || !positionals.length) { log(HELP); return 0; }
  const command = positionals[0], baseDir = resolve(v["data-dir"] ?? ".wolai-notion-sync");
  if (positionals.length !== 1 || !["init", "check", "sync", "status", "verify"].includes(command)) throw new Error("未知命令，请使用 --help");
  const allowed = { init: ["data-dir", "source-root", "notion-root"], check: ["data-dir", "remote"], sync: ["data-dir", "apply", "resume", "limit", "concurrency"], status: ["data-dir"], verify: ["data-dir"] }[command];
  if (Object.keys(v).some(key => key !== "help" && !allowed.includes(key))) throw new Error("参数不适用于当前命令，请使用 --help");
  if (command === "init") {
    await initializeWorkspace(baseDir, { syncScope: { sourceRootIds: v["source-root"] }, notionRoot: { pageId: v["notion-root"] } });
    log(JSON.stringify({ initialized: true, credentialsStored: false })); return 0;
  }
  const { config, state } = await loadWorkspace(baseDir);
  if (command === "status") { const report = await readJson(join(baseDir, "tree-sync-result.json"), null); log(JSON.stringify(report ?? { initialized: true, synced: false })); return 0; }
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
  if (command === "check") {
    const credentials = { wolai: Boolean(process.env.WOLAI_MCP_TOKEN?.trim()), notion: Boolean(process.env.NOTION_TOKEN?.trim()) };
    if (!v.remote) { log(JSON.stringify({ configValid: true, credentials })); return credentials.wolai && credentials.notion ? 0 : 2; }
    const source = new WolaiClient(), notion = new NotionRestClient();
    await notion.getCurrentUser(); const root = await notion.retrievePage(config.notionRoot.pageId);
    if (root.in_trash || root.archived) throw new Error("Notion 目标根页面已在垃圾箱中");
    const tools = await source.listTools();
    if (!tools.includes("get_page_blocks") || !tools.some(t => ["get_doc", "get_page"].includes(t))) throw new Error("Wolai MCP 缺少完整块或页面读取工具");
    for (const id of config.syncScope.sourceRootIds) {
      const blocks = await source.getPageBlocks(id);
      if (!blocks.some(b => b.id === id && ["page", "database"].includes(b.type))) throw new Error("Wolai 根页面完整块缺少有效元信息");
    }
    // Ensure the actual credential can use the required March 2026 endpoint.
    await notion.retrievePageMarkdown(config.notionRoot.pageId);
    log(JSON.stringify({ configValid: true, credentials, sourceReadable: true, targetReadable: true, markdownApiAvailable: true, writePermissionTested: false })); return 0;
  }
  const release = await acquireLock(baseDir);
  try {
    if (command === "verify") { const report = await verifyWorkspace({ baseDir, config, state }); log(JSON.stringify({ ...report, details: undefined, media: undefined })); return report.accepted ? 0 : 2; }
    const limit = Number(v.limit ?? config.policy.batchSize), concurrency = Number(v.concurrency ?? 4);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error("批量应为 1–500、并发为 1–6 的整数");
    const source = new WolaiClient(); let tree;
    if (v.resume) {
      tree = scopedSourceTree(await readJson(join(baseDir, "source-tree.json")), config);
      const at = Date.parse(tree.scannedAt);
      if (tree.scanPolicy !== "full-block-fingerprint" || !Number.isFinite(at) || Date.now() - at > 86400000 || at > Date.now() + 60000) throw new Error("源快照过期或不完整，请去掉 --resume 重新扫描");
    } else {
      tree = scopedSourceTree(await discoverSourceTree({ client: source, cache: sourceCache(baseDir), rootIds: config.syncScope.sourceRootIds }), config);
      // Persist diagnostic errors without logging server-provided note content.
      tree.documents.forEach(doc => { if (doc.error) doc.error = safeError(doc.error); });
      await writeJson(join(baseDir, "source-tree.json"), tree);
    }
    if (tree.failedCount) throw new Error(`源扫描有 ${tree.failedCount} 个失败页面，本次不写入 Notion`);
    if (!v.apply) { log(JSON.stringify({ mode: "read-only-plan", scanned: tree.total, roots: tree.rootCount, maxDepth: tree.maxDepth, pending: pendingDocuments(tree, state).length, orderRemaining: pendingChildOrders(tree, state, config).length, batchLimit: limit })); return 0; }
    const runner = new TreeSync({ baseDir, config, state, tree, source, notion: new NotionRestClient({ maxFileUploadBytes: config.media.maxFileUploadBytes }), onProgress: counts => { if (counts.processed && counts.processed % 25 === 0) log(JSON.stringify(counts)); } });
    const stop = () => { runner.stopRequested = true; };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const report = await runner.run({ limit, concurrency }); log(JSON.stringify(report));
      return report.failed || report.conflicts || report.stopped ? 2 : report.remaining || report.orderRemaining ? 3 : 0;
    } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  } finally { await release(); }
}
if (isEntryPoint(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(safeError(error)); process.exitCode = 2; }
}
