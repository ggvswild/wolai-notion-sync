import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import undici from "undici";
import { NotionRestClient } from "../lib/notion-rest-client.mjs";

async function withDownload(fetch, fn) {
  const original = undici.fetch;
  const client = Object.create(NotionRestClient.prototype);
  client.token = "test-token-must-not-be-forwarded";
  undici.fetch = async (url, options) => {
    assert.equal(url, "https://example.invalid/media");
    assert.equal(options.method ?? "GET", "GET");
    assert.equal(options.headers, undefined, "媒体下载不得转发 Notion 凭证");
    return fetch();
  };
  try { await fn(client); } finally { undici.fetch = original; }
}

test("媒体校验的瞬时网络失败有限重试，不改内容或发送凭证", async () => {
  let calls = 0;
  const bytes = Buffer.from("original media bytes");
  await withDownload(() => { if (++calls === 1) throw new TypeError("fetch failed"); return new Response(bytes); }, async client => {
    assert.deepEqual(await client.hashRemoteFile("https://example.invalid/media"), { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    assert.equal(calls, 2);
  });
});

test("媒体流中途断开后重新计算完整指纹，不累加部分下载", async () => {
  let calls = 0;
  const bytes = Buffer.from("complete payload");
  await withDownload(() => {
    calls += 1;
    if (calls === 1) return { ok: true, body: (async function* () { yield Buffer.from("partial"); throw new TypeError("connection reset"); })() };
    return new Response(bytes);
  }, async client => {
    const actual = await client.hashRemoteFile("https://example.invalid/media");
    assert.equal(actual.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(actual.bytes, bytes.length);
    assert.equal(calls, 2);
  });
});

test("媒体服务临时 503 可重试，但持续失败最多三次", async () => {
  let calls = 0;
  await withDownload(() => { calls += 1; return new Response("unavailable", { status: 503 }); }, async client => {
    await assert.rejects(client.hashRemoteFile("https://example.invalid/media"), /503/);
    assert.equal(calls, 3);
  });
});

test("媒体权限错误不重试，也不修改授权", async () => {
  let calls = 0;
  await withDownload(() => { calls += 1; return new Response("forbidden", { status: 403 }); }, async client => {
    await assert.rejects(client.hashRemoteFile("https://example.invalid/media"), /403/);
    assert.equal(calls, 1);
  });
});

test("媒体读取超过安全字节上限不重试", async () => {
  let calls = 0;
  await withDownload(() => { calls += 1; return { ok: true, body: (async function* () { yield { length: 128 * 1024 * 1024 + 1 }; })() }; }, async client => {
    await assert.rejects(client.hashRemoteFile("https://example.invalid/media"), /字节核对上限/);
    assert.equal(calls, 1);
  });
});
