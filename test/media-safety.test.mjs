import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { NotionRestClient, encodeJsonPayload } from "../lib/notion-rest-client.mjs";
import { prepareMedia, markMediaAttached } from "../lib/media-sync.mjs";

test("更新媒体只发送 file_upload，不发送不兼容的 type 判别字段", async () => {
  const client = Object.create(NotionRestClient.prototype);
  let request;
  client.request = async (...args) => { request = args; return {}; };
  await client.attachUploadToBlock("block", "image", "upload");
  assert.deepEqual(request, ["PATCH", "/blocks/block", { retryable: false, body: { image: { file_upload: { id: "upload" } } } }]);
});

test("JSON 传输转义不会修改 HTML 示例或链接的原文",()=>{
  const value={text:'<script src="https://example.com/a?x=1&y=2"></script>\n中文',line:"\u2028\u2029"};
  const encoded=encodeJsonPayload(value);
  assert.deepEqual(JSON.parse(encoded),value);
  assert.ok(!encoded.includes("<script"));
});

test("已知超过工作区限额的附件不下载、不压缩、不上传", async () => {
  const results = await prepareMedia([{ id: "file", parent_id: "root", type: "file", version: 1, file_name: "大文件.pdf", file_size: 10000000, media: { download_url: "https://example.invalid/file.pdf", stable_ref: "oversize-test" } }], "root", {
    baseDir: "/tmp/wolai-no-such-test-cache",
    client: { maxFileUploadBytes: 5242880, uploadBytes: () => { throw new Error("不得上传"); } },
  });
  assert.equal(results.get("file").oversize, true);
  assert.equal(results.get("file").sourceUrl, "https://www.wolai.com/root#file");
  assert.equal(results.get("file").uploadId, undefined);
});

async function withMediaFixture(filename, bytes, fn) {
  const baseDir = await mkdtemp(join(tmpdir(), "wolai-media-test-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } });
  const uploads = [];
  const client = { maxFileUploadBytes: 5242880, uploadBytes: async (body, name, contentType) => {
    if (contentType === "application/octet-stream") throw new Error("The content type application/octet-stream is not supported for the File Upload API.");
    if (/\.(drawio|excalidraw)$/.test(name)) throw new Error("Provided filename has an extension that is not supported for the File Upload API.");
    uploads.push({ bytes: Buffer.from(body), filename: name, contentType });
    return "upload-fixture";
  } };
  const block = { id: "file", parent_id: "source", type: "file", version: 1, file_name: filename, file_size: bytes.length, media: { stable_ref: filename, download_url: `https://example.invalid/${filename}` } };
  try { await fn({ baseDir, client, block, uploads }); }
  finally { globalThis.fetch = originalFetch; await rm(baseDir, { recursive: true, force: true }); }
}

test("Markdown 附件使用真实扩展名补全 MIME，不改变原始字节", async () => {
  const bytes = Buffer.from("# 原件\n\n中文内容\r\n");
  await withMediaFixture("原件.md", bytes, async ({ baseDir, client, block, uploads }) => {
    const assets = await prepareMedia([block], "source", { baseDir, client });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].filename, "原件.md");
    assert.equal(uploads[0].contentType, "text/markdown");
    assert.deepEqual(uploads[0].bytes, bytes);
    assert.equal(assets.get("file").archive, undefined);
  });
});

test("已证实漏写的媒体可重新上传，不把旧 attached 缓存当成目标存在证明", async () => {
  const bytes = Buffer.from("# 原件\n完整原文");
  await withMediaFixture("missing.md", bytes, async ({ baseDir, client, block, uploads }) => {
    const first = await prepareMedia([block], "source", { baseDir, client });
    await markMediaAttached(first);
    await prepareMedia([block], "source", { baseDir, client });
    assert.equal(uploads.length, 1);
    const repaired = await prepareMedia([block], "source", { baseDir, client, forceSourceIds: new Set([block.id]) });
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[1].bytes, bytes);
    assert.equal(repaired.get(block.id).attached, false);
  });
});

test("Notion 不支持的编辑器文件原样封装为 ZIP，并记录原件及上传指纹", async () => {
  for (const filename of ["图表.drawio", "草图.excalidraw"]) {
    const bytes = Buffer.from("原始编辑器文件\r\n\u0000original bytes");
    await withMediaFixture(filename, bytes, async ({ baseDir, client, block, uploads }) => {
      const assets = await prepareMedia([block], "source", { baseDir, client });
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].filename, `${filename}.zip`);
      assert.equal(uploads[0].contentType, "application/zip");
      const zip = uploads[0].bytes;
      assert.equal(zip.readUInt32LE(0), 0x04034b50);
      assert.equal(zip.readUInt16LE(8), 0, "只封装，不重编码或压缩原件");
      const nameLength = zip.readUInt16LE(26), extraLength = zip.readUInt16LE(28), fileLength = zip.readUInt32LE(22);
      assert.equal(zip.subarray(30, 30 + nameLength).toString(), filename);
      assert.deepEqual(zip.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + fileLength), bytes);
      const asset = assets.get("file");
      assert.equal(asset.archive.format, "zip");
      assert.equal(asset.archive.filename, filename);
      assert.equal(asset.archive.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(asset.sha256, createHash("sha256").update(zip).digest("hex"));
    });
  }
});
