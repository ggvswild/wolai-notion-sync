import { basename, join } from "node:path";
import { readJson, writeJson } from "./storage.mjs";
import { digest } from "./sync-safety.mjs";
import { ownBlocks, plainText } from "./notion-render.mjs";
import { mapPool } from "./source-tree.mjs";
import { mediaUploadPayload } from "./media-format.mjs";

export async function prepareMedia(blocks, docId, { client, baseDir, refreshBlocks, forceSourceIds = new Set() }) {
  const media = ownBlocks(blocks, docId).filter(b => ["image", "file", "video", "audio"].includes(b.type) && (b.media?.download_url || b.link));
  const results = await mapPool(media, 3, async (block) => {
    const mediaKey = digest(JSON.stringify({ stable: block.media?.stable_ref ?? block.link ?? block.id, version: block.version }));
    const cachePath = join(baseDir, "cache/assets", `${mediaKey}.json`);
    const cached = await readJson(cachePath, null);
    if (!forceSourceIds.has(block.id) && (cached?.attached || cached?.uploadId && Date.now() - Date.parse(cached.uploadedAt) < 45 * 60000)) return [block.id, { ...cached, cachePath, sharedPath: /^[a-f0-9]{64}$/.test(cached.sha256 ?? "") ? join(baseDir, "cache/assets", `sha256-${cached.sha256}.json`) : undefined }];
    const limit = Math.min(client.maxFileUploadBytes ?? 5 * 1024 * 1024, 20 * 1024 * 1024);
    const oversize = bytes => [block.id, { oversize: true, reason: "workspace_file_limit", bytes, limit,
      filename: plainText(block.file_name || block.file_alias || block.caption) || `${block.type}-${block.id}`,
      sourceUrl: `https://www.wolai.com/${docId}#${block.id}`,
    }];
    if (Number(block.file_size) > limit) return oversize(Number(block.file_size));
    let url = block.media?.download_url ?? block.link;
    if (!/^https?:\/\//.test(url)) throw new Error("媒体 URL 协议不受支持");
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(45000) });
        if (response.ok) break;
        if ([401, 403].includes(response.status) && refreshBlocks) {
          const fresh = (await refreshBlocks()).find(b => b.id === block.id);
          url = fresh?.media?.download_url ?? fresh?.link ?? url;
        }
        if (attempt === 2) throw new Error(`媒体读取失败 HTTP ${response.status}`);
      } catch (error) { if (attempt === 2) throw error; }
    }
    if (!response?.ok) throw new Error("媒体下载失败");
    if (Number(response.headers.get("content-length")) > limit) { await response.body.cancel(); return oversize(Number(response.headers.get("content-length"))); }
    const parts = []; let length = 0;
    for await (const part of response.body) {
      length += part.length;
      if (length > limit) return oversize(length);
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    const responseType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
    if (responseType === "text/html") throw new Error("媒体 URL 返回网页，不能当作图片或附件上传");
    const rawName = plainText(block.file_name || block.file_alias) || basename(new URL(url).pathname) || block.id;
    const name = rawName.replace(/[\x00-\x1f/:*?"<>|\\]/g, "-").slice(0, 150);
    const payload = mediaUploadPayload(bytes, name, responseType, block.type);
    if (payload.bytes.length > limit) return oversize(payload.bytes.length);
    const sha256 = digest(payload.bytes);
    const sharedPath = join(baseDir, "cache/assets", `sha256-${sha256}.json`);
    const shared = await readJson(sharedPath, null);
    if (!forceSourceIds.has(block.id) && (shared?.attached || shared?.uploadId && Date.now() - Date.parse(shared.uploadedAt) < 45 * 60000)) {
      await writeJson(cachePath, shared);
      return [block.id, { ...shared, cachePath, sharedPath }];
    }
    const { filename, contentType, archive } = payload;
    const uploadId = await client.uploadBytes(payload.bytes, filename, contentType);
    const asset = { uploadId, filename, contentType, sha256, bytes: payload.bytes.length, ...(archive ? { archive } : {}), uploadedAt: new Date().toISOString(), attached: false, cachePath, sharedPath };
    await writeJson(cachePath, asset); await writeJson(sharedPath, asset);
    return [block.id, asset];
  });
  return new Map(results);
}

export async function markMediaAttached(assets) {
  for (const asset of assets.values()) {
    if (asset.oversize) continue;
    asset.attached = true;
    if (asset.cachePath) await writeJson(asset.cachePath, asset);
    if (asset.sharedPath) await writeJson(asset.sharedPath, asset);
  }
}
