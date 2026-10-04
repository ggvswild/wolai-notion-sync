import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJson, readJson } from "../lib/storage.mjs";
import { sourceSignature, pageBodyHash } from "../lib/source-tree.mjs";
import { sourceHeader } from "../lib/notion-render.mjs";
import { bodyFingerprint, digest } from "../lib/sync-safety.mjs";
import { verifyWorkspace } from "../lib/verify-workspace.mjs";
import { prepareMedia, markMediaAttached } from "../lib/media-sync.mjs";

async function fixture(includeText, fn) {
  const baseDir = await mkdtemp(join(tmpdir(), "community-verify-"));
  try {
    const metadata = { id: "source", type: "page", content: [{ title: "Demo" }], version: 1, edited_at: 1, parent_type: "workspace", children: {} };
    const blocks = [metadata, { id: "text", type: "text", parent_id: "source", content: [{ title: "Expected text" }] }];
    const doc = { docId: "source", title: "Demo", version: 1, editedAt: 1, signature: sourceSignature(metadata), bodyHash: pageBodyHash(blocks, "source"), depth: 0, parentDocId: null, ancestorIds: [], childIds: [], status: "ready", sourceType: "page" };
    const header = sourceHeader(doc), markdown = `> ${header}${includeText ? "\n\nExpected text" : ""}`;
    const target = { id: "target", parent: { type: "page_id", page_id: "root" }, properties: { title: { type: "title", title: [{ text: { content: "Demo" } }] } } };
    const root = { id: "root", parent: { type: "workspace" } };
    const notion = { searchPages: async () => [root, target], retrievePage: async id => id === "root" ? root : target,
      retrievePageMarkdown: async () => ({ markdown, truncated: false, unknown_block_ids: [] }),
      listBlockChildren: async id => id === "root" ? [{ id: "target", type: "child_page", child_page: { title: "Demo" } }] : [{ id: "header", type: "quote", quote: { rich_text: [{ text: { content: header } }] } }, ...(includeText ? [{ id: "body", type: "paragraph", paragraph: { rich_text: [{ text: { content: "Expected text" } }] } }] : [])] };
    const state = { rootPageId: "root", documents: { source: { notionPageId: "target", notionParentId: "root", hierarchyVersion: 2, status: "synced", sourceVersion: 1, sourceSignature: doc.signature, sourceBodyHash: doc.bodyHash, targetTitle: "Demo", lastNotionBodyHash: bodyFingerprint(markdown), assetCount: 0 } } };
    const tree = { scanPolicy: "full-block-fingerprint", scannedAt: new Date().toISOString(), total: 1, rootCount: 1, failedCount: 0, documents: [doc] };
    await writeJson(join(baseDir, "source-tree.json"), tree);
    await writeJson(join(baseDir, "cache/source/source.json"), { signature: doc.signature, bodyHash: doc.bodyHash, blocks });
    await fn({ baseDir, config: { syncScope: { sourceRootIds: ["source"] }, notionRoot: { pageId: "root" }, navigation: { orderedSourceRoots: ["source"] } }, state, notion });
  } finally { await rm(baseDir, { recursive: true, force: true }); }
}
test("社区验收在没有凭证和远端写入的合成接口中完整通过", async () => fixture(true, async opts => {
  const report = await verifyWorkspace(opts);
  assert.equal(report.accepted, true); assert.equal(report.coveragePassed, 1);
}));
test("目标基线自洽但正文缺失时，社区独立源覆盖仍拒绝验收", async () => fixture(false, async opts => {
  const report = await verifyWorkspace(opts);
  assert.equal(report.bodyFingerprintPassed, 1); assert.equal(report.accepted, false); assert.equal(report.coverageFailed, 1);
}));
test("迁移数据目录后，媒体缓存路径重新绑定到新目录而非旧机器", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "relocated-media-"));
  try {
    const sha = digest("synthetic asset"), key = digest(JSON.stringify({ stable: "media", version: 1 }));
    const cachePath = join(baseDir, "cache/assets", `${key}.json`);
    await writeJson(cachePath, { attached: true, uploadId: "synthetic-upload", sha256: sha, cachePath: "/old-machine/cache.json", sharedPath: "/old-machine/shared.json" });
    const assets = await prepareMedia([{ id: "image", type: "image", parent_id: "source", version: 1, media: { stable_ref: "media", download_url: "https://example.invalid/image.png" } }], "source", { baseDir, client: {} });
    assert.equal(assets.get("image").cachePath, cachePath);
    assert.equal(assets.get("image").sharedPath, join(baseDir, "cache/assets", `sha256-${sha}.json`));
    await markMediaAttached(assets);
    assert.equal((await readJson(cachePath)).sharedPath, assets.get("image").sharedPath);
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});
