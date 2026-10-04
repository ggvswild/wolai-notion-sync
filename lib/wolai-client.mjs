import { safeError } from "./sync-safety.mjs";
const ENDPOINT = "https://api.wolai.com/v1/mcp";
const READ_TOOLS = new Set(["list_docs", "list_pages", "get_doc", "get_page", "get_page_blocks"]);

export function parseMcpMessage(body, id) {
  const trimmed = body.trim();
  const candidates = trimmed.startsWith("{") ? [trimmed] : trimmed.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).filter(l => l && l !== "[DONE]");
  for (const text of candidates) {
    let message;
    try { message = JSON.parse(text); } catch { throw new Error("Wolai MCP JSON 响应格式不支持"); }
    if (message.id !== undefined && message.id !== id) continue;
    if (message.error) { const e = new Error(`Wolai MCP 协议错误 ${message.error.code ?? "unknown"}`); e.rpcCode = message.error.code; throw e; }
    if (message.result) return message.result;
  }
  throw new Error("Wolai MCP 返回空响应或无法识别的结构");
}
export class WolaiClient {
  constructor({ token = process.env.WOLAI_MCP_TOKEN, retries = 3, fetchImpl = globalThis.fetch } = {}) {
    if (!token?.trim()) throw new Error("请设置 WOLAI_MCP_TOKEN 环境变量");
    this.token = token.trim().replace(/^Bearer\s+/i, ""); this.retries = retries; this.fetch = fetchImpl; this.requestId = 1;
  }
  async rpc(method, params) {
    let lastError;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const id = this.requestId++;
        const response = await this.fetch(ENDPOINT, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(45000) });
        if (!response.ok) { const e = new Error(`Wolai MCP HTTP ${response.status}`); e.status = response.status; throw e; }
        return parseMcpMessage(await response.text(), id);
      } catch (error) {
        lastError = error;
        if (error.rpcCode || error.status && error.status < 500 && error.status !== 429 || attempt === this.retries) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 800));
      }
    }
    throw new Error(safeError(lastError));
  }
  async call(tool, args = {}) {
    if (!READ_TOOLS.has(tool)) throw new Error("禁止写入 Wolai：此客户端只允许读取工具");
    const result = await this.rpc("tools/call", { name: tool, arguments: args });
    if (result.isError) throw new Error(`Wolai 读取工具 ${tool} 失败；请检查接入能力和权限`);
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find(c => c.type === "text")?.text;
    if (!text) throw new Error("Wolai 返回的工具结果缺少数据");
    try { return JSON.parse(text); } catch { throw new Error("Wolai 工具数据格式不支持，禁止把文本当作完整页面"); }
  }
  async listTools() { const r = await this.rpc("tools/list", {}); return (r.tools ?? []).map(t => t.name); }
  async getDoc(docId) {
    let result;
    try { result = await this.call("get_doc", { doc_id: docId, include_blocks: false }); }
    catch (e) { if (![-32601, -32602].includes(e.rpcCode)) throw e; result = await this.call("get_page", { page_id: docId, include_blocks: false }); }
    const doc = result?.data?.resource ?? result?.data?.document ?? result?.data?.page ?? result?.data?.data ?? result?.data ?? result?.page;
    if (!doc || doc.id !== docId) throw new Error("Wolai 页面元信息缺失或 ID 不匹配");
    return doc;
  }
  async getPageBlocks(pageId) {
    const result = await this.call("get_page_blocks", { page_id: pageId });
    const blocks = result?.data?.data ?? result?.data?.blocks ?? result?.blocks;
    if (!Array.isArray(blocks)) throw new Error("Wolai 完整块响应不是数组，禁止当作空页同步");
    return blocks;
  }
}
