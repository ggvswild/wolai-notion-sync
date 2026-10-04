import { File } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import undici from "undici";
import { richText } from "./notion-render.mjs";

const API_BASE = "https://api.notion.com/v1";
const API_VERSION = "2026-03-11";

// Standard JSON Unicode escapes preserve the exact string value while keeping
// literal HTML/control delimiters out of the transport envelope.
export function encodeJsonPayload(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,"0")}`);
}

const MIME_TYPES = {
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".ico": "image/vnd.microsoft.icon",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

function readPat() {
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) throw new Error("请设置 NOTION_TOKEN 环境变量");
  return token;
}

export class NotionRestClient {
  constructor({ token = readPat(), maxFileUploadBytes, apiVersion = API_VERSION } = {}) {
    if (typeof token !== "string" || !token.trim()) throw new Error("请设置 NOTION_TOKEN 环境变量");
    this.token = token.trim().replace(/^Bearer\s+/i, "");
    this.apiVersion = apiVersion;
    if (maxFileUploadBytes) this.maxFileUploadBytes = maxFileUploadBytes;
    this.dispatcher = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? new undici.EnvHttpProxyAgent() : undefined;
    this.nextRequestAt = 0;
  }

  async throttle() {
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    this.nextRequestAt = Math.max(this.nextRequestAt, Date.now()) + 360;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  async request(method, path, { body, form, retryable = method === "GET" } = {}) {
    let lastError;
    const attempts = retryable ? 4 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.throttle();
      try {
        const headers = {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": this.apiVersion ?? API_VERSION,
        };
        if (!form) headers["Content-Type"] = "application/json";
        const response = await undici.fetch(`${API_BASE}${path}`, {
          method,
          headers,
          body: form ?? (body === undefined ? undefined : encodeJsonPayload(body)),
          dispatcher: this.dispatcher,
          signal: AbortSignal.timeout(45000),
        });
        const text = await response.text();
        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = { message: text };
        }
        if (response.ok) return payload;
        const error = new Error(`Notion API ${response.status} ${payload.code ?? "unknown_error"}${/cloudflare/i.test(payload.message ?? text) ? " cloudflare" : ""}`);
        error.status = response.status;
        error.payload = payload;
        error.apiPath = path;
        error.apiMethod = method;
        if (response.status === 429 && attempt < attempts) {
          const retryAfter = Number(response.headers.get("retry-after") ?? 1);
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          lastError = error;
          continue;
        }
        throw error;
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || error.status && error.status !== 429 && error.status < 500) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
    }
    throw lastError;
  }

  getCurrentUser() {
    return this.request("GET", "/users/me");
  }

  retrievePage(pageId) {
    return this.request("GET", `/pages/${pageId}`);
  }

  retrievePageMarkdown(pageId) {
    return this.request("GET", `/pages/${pageId}/markdown`);
  }

  createPageMarkdown(parentPageId, title, markdown) {
    return this.request("POST", "/pages", {
      retryable: false,
      body: {
        parent: { type: "page_id", page_id: parentPageId },
        properties: {
          title: {
            type: "title",
            title: richText(title.slice(0, 2000), { plain: true }),
          },
        },
        markdown,
      },
    });
  }

  replacePageMarkdown(pageId, markdown) {
    return this.request("PATCH", `/pages/${pageId}/markdown`, {
      retryable: false,
      body: { type: "replace_content", replace_content: { new_str: markdown, allow_deleting_content: false } },
    });
  }

  createPageBlocks(parentPageId, title, children, position) {
    if (!parentPageId) throw new Error("必须指定 Notion 父页面");
    return this.request("POST", "/pages", { retryable: false, body: {
      parent: { type: "page_id", page_id: parentPageId },
      properties: { title: { type: "title", title: richText(title.slice(0, 2000), { plain: true }) } },
      children, ...(position ? { position } : {}),
    } });
  }

  updateTitle(pageId, title) {
    return this.request("PATCH", `/pages/${pageId}`, { body: {
      properties: { title: { type: "title", title: richText(title.slice(0, 2000), { plain: true }) } },
    } });
  }

  movePage(pageId, parentPageId) {
    if (!pageId || !parentPageId || pageId.replaceAll("-", "") === parentPageId.replaceAll("-", "")) throw new Error("不安全的页面移动");
    return this.request("POST", `/pages/${pageId}/move`, { retryable: false,
      body: { parent: { type: "page_id", page_id: parentPageId } },
    });
  }

  async listBlockChildren(blockId) {
    const results = [];
    let cursor;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      const page = await this.request("GET", `/blocks/${blockId}/children?${query}`);
      results.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return results;
  }

  appendBlocks(blockId, children, after) {
    return this.request("PATCH", `/blocks/${blockId}/children`, { retryable: false,
      body: { children, ...(after ? { position: { type: "after_block", after_block: { id: after } } } : {}) },
    });
  }

  attachUploadToBlock(blockId, type, uploadId) {
    if (!["image", "file", "pdf", "audio", "video"].includes(type)) throw new Error("不支持的媒体块类型");
    return this.request("PATCH", `/blocks/${blockId}`, { retryable: false,
      body: { [type]: { file_upload: { id: uploadId } } },
    });
  }

  archiveOwnedPlaceholder(blockId) {
    // Callers must verify this is their own temporary paragraph, never a page.
    return this.request("PATCH", `/blocks/${blockId}`, { body: { in_trash: true }, retryable: false });
  }

  async searchPages() {
    const results = [];
    let cursor;
    do {
      const page = await this.request("POST", "/search", { retryable: true, body: {
        filter: { property: "object", value: "page" }, page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      } });
      results.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return results;
  }

  async uploadBytes(bytes, filename, contentType) {
    const upload = await this.request("POST", "/file_uploads", { retryable: true,
      body: { mode: "single_part", filename, content_type: contentType },
    });
    const form = new undici.FormData();
    form.append("file", new File([bytes], filename, { type: contentType }));
    const sent = await this.request("POST", `/file_uploads/${upload.id}/send`, { retryable: true, form });
    if (sent.status !== "uploaded") throw new Error("Notion 媒体上传未完成");
    return sent.id;
  }

  async hashRemoteFile(url) {
    if (!/^https?:\/\//.test(url ?? "")) throw new Error("文件地址无效");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response;
      try {
        // These are unauthenticated, read-only downloads. Never send the PAT
        // to a media URL, and restart the hash after an interrupted stream.
        response = await undici.fetch(url, { method: "GET", dispatcher: this.dispatcher, signal: AbortSignal.timeout(45000) });
        if (!response.ok) { const error = new Error(`文件读取失败 HTTP ${response.status}`); error.status = response.status; throw error; }
        const hash = createHash("sha256"); let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 128 * 1024 * 1024) {
            const error = new Error("文件超过本次字节核对上限"); error.code = "MEDIA_BYTE_LIMIT"; throw error;
          }
          hash.update(chunk);
        }
        return { sha256: hash.digest("hex"), bytes };
      } catch (error) {
        try { await response?.body?.cancel?.(); } catch {}
        if (attempt === 3 || error.code === "MEDIA_BYTE_LIMIT" || error.status && error.status < 500 && error.status !== 408) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 250));
      }
    }
  }

  async uploadFile(path) {
    const filename = basename(path);
    const contentType = MIME_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
    const upload = await this.request("POST", "/file_uploads", {
      retryable: true,
      body: { mode: "single_part", filename, content_type: contentType },
    });
    const bytes = await readFile(path);
    const form = new undici.FormData();
    form.append("file", new File([bytes], filename, { type: contentType }));
    const sent = await this.request("POST", `/file_uploads/${upload.id}/send`, {
      retryable: true,
      form,
    });
    if (sent.status !== "uploaded") throw new Error(`Notion 文件未完成上传: ${filename}`);
    return sent.id;
  }

  appendImageUploads(pageId, uploads) {
    if (!uploads.length) return Promise.resolve({ results: [] });
    return this.request("PATCH", `/blocks/${pageId}/children`, {
      retryable: false,
      body: {
        children: uploads.map(({ id, caption }) => ({
          object: "block",
          type: "image",
          image: {
            type: "file_upload",
            file_upload: { id },
            caption: caption
              ? [{ type: "text", text: { content: caption.slice(0, 2000) } }]
              : [],
          },
        })),
      },
    });
  }
}
