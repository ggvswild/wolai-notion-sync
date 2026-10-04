import { createHash } from "node:crypto";

export const normalizeId = (id) => String(id ?? "").replaceAll("-", "").toLowerCase();
export const digest = (value) => createHash("sha256").update(value).digest("hex");
function splitChildMarkup(markdown) {
  const body = [], children = [], childLineIndices = [];
  let fence = null, unsafe = false;
  for (const [index, line] of String(markdown).split("\n").entries()) {
    const mark = line.match(/^\s*(`{3,}|~{3,})/);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      body.push(line); continue;
    }
    if (!fence && /^\s*<(?:page|database)\s+url="[^\n]+<\/(?:page|database)>\s*$/.test(line)) { children.push(line.trim()); childLineIndices.push(index); }
    else {
      if (!fence && /<(?:page|database)\s+url=/.test(line)) unsafe = true;
      body.push(line);
    }
  }
  return { body: body.join("\n"), children, unsafe, childLineIndices };
}
export const childMarkup = markdown => splitChildMarkup(markdown).children;

export function childPageId(markup) {
  const url = markup.match(/^<page\s+url="([^"]+)"/)?.[1];
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    return normalizeId(path.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})(?:\/)?$/i)?.[1]) || null;
  } catch { return null; }
}

export function orderChildMarkup(children, desiredPageIds, { requireAll = false } = {}) {
  const desired = desiredPageIds.map(normalizeId);
  if (desired.some(id => !id) || new Set(desired).size !== desired.length) throw new Error("目录目标 ID 缺失或重复");
  const available = new Map();
  for (const line of children) {
    const id = childPageId(line);
    if (!id) continue;
    if (available.has(id)) throw new Error("目录中同一目标页面重复出现");
    available.set(id, line);
  }
  if (requireAll && desired.some(id => !available.has(id))) throw new Error("目录缺失已映射子页面，禁止仅凭排序标为完成");
  const ordered = desired.filter(id => available.has(id)).map(id => available.get(id));
  const known = new Set(desired);
  let cursor = 0;
  // Unknown/manual children keep their existing slots and exact markup.
  return children.map(line => known.has(childPageId(line)) ? ordered[cursor++] : line);
}

export function planChildPageOrder(markdown, desiredPageIds) {
  const { children, unsafe, childLineIndices } = splitChildMarkup(markdown);
  if (unsafe) throw new Error("子页面布局无法安全保留");
  const ordered = orderChildMarkup(children, desiredPageIds, { requireAll: true });
  if (children.every((line, index) => line === ordered[index])) return { changed: false };
  const lines = String(markdown).split("\n");
  const first = childLineIndices[0], last = childLineIndices.at(-1);
  const slots = new Set(childLineIndices);
  for (let i = first; i <= last; i += 1) {
    if (!slots.has(i) && lines[i].trim()) throw new Error("子页之间含正文，不能通过目录排序改写正文布局");
  }
  const replacement = lines.slice(first, last + 1);
  for (let i = 0; i < childLineIndices.length; i += 1) {
    const offset = childLineIndices[i] - first;
    replacement[offset] = replacement[offset].replace(children[i], ordered[i]);
  }
  const oldStr = lines.slice(first, last + 1).join("\n"), newStr = replacement.join("\n");
  const content = [...lines.slice(0, first), ...replacement, ...lines.slice(last + 1)].join("\n");
  if (bodyFingerprint(content) !== bodyFingerprint(markdown)) throw new Error("目录排序会改变正文，禁止写入");
  return { changed: true, oldStr, newStr, content };
}

export function sourceMarker(markdown) {
  const firstLine = String(markdown ?? "").trimStart().split("\n")[0].replace(/\\([_*])/g, "$1");
  const match = firstLine.match(/^(?:>\s*)?来源：wolai\s*·\s*doc_id:\s*([A-Za-z0-9_-]+)\s*·\s*version:\s*([^\s·]+)/);
  if (!match) return null;
  const contentHash = firstLine.match(/content_hash:\s*([a-f0-9]{64})/)?.[1];
  return { docId: match[1], version: match[2], payload: firstLine.match(/payload:\s*([a-f0-9]{64})/)?.[1] ?? null, ...(contentHash ? {contentHash} : {}) };
}

export function bodyFingerprint(markdown) {
  const stable = splitChildMarkup(markdown).body
    .replace(/https:\/\/[^\s"<>)]*/g, (value) => {
      try {
        const url = new URL(value);
        if (/\.amazonaws\.com$|\.notion-static\.com$|^file\.notion\.so$/.test(url.hostname)) url.search = "";
        return url.toString();
      } catch { return value; }
    })
    .replace(/\n{3,}/g, "\n\n").trim();
  return digest(stable);
}

export function preserveChildPages(oldMarkdown, content, { desiredPageIds } = {}) {
  const { children, unsafe } = splitChildMarkup(oldMarkdown);
  // An inline/nested reference that cannot be preserved verbatim is a conflict,
  // never a reason to switch off Notion's child-deletion protection.
  if (unsafe) throw new Error("子页面布局无法安全保留");
  const preserved = desiredPageIds ? orderChildMarkup(children, desiredPageIds) : children;
  return `${content.trim()}\n${preserved.length ? `\n${preserved.join("\n")}\n` : ""}`;
}

export function validateTarget(doc, record, target, { allowPending = false } = {}) {
  const marker = sourceMarker(target.markdown);
  if (!marker || marker.docId !== doc.docId) throw new Error("目标页面来源标识不匹配");
  if (target.truncated || target.unknown_block_ids?.length) throw new Error("目标内容未完整读取，禁止覆盖");
  if (record.targetTitle && target.title !== record.targetTitle && !(allowPending && target.title===doc.title)) throw new Error("目标标题存在手工修改");
  if (record.lastNotionBodyHash && bodyFingerprint(target.markdown) !== record.lastNotionBodyHash && !allowPending) throw new Error("目标正文存在手工修改");
  return marker;
}

export function pendingDocuments(tree, state, limit = Infinity) {
  return tree.documents.filter((doc) => {
    if (doc.status !== "ready") return false;
    const prev = state.documents[doc.docId];
    const baseline = prev?.sourceBodyHash ?? (prev?.sourceSignature===doc.baselineSignature ? doc.baselineBodyHash : undefined);
    return !prev || !prev.notionPageId || !["synced", "synced_with_exceptions"].includes(prev.status) || prev.pendingStructureRepair || prev.pendingOrderMove || prev.retryAssets || prev.hierarchyVersion !== 2 ||
      prev.sourceVersion !== doc.version || prev.sourceSignature !== doc.signature ||
      doc.bodyHash && baseline !== doc.bodyHash ||
      (prev.parentDocId ?? null) !== doc.parentDocId;
  }).sort((a, b) => a.depth - b.depth || a.docId.localeCompare(b.docId)).slice(0, limit);
}

export function safeError(error) {
  let message = String(error?.message ?? error);
  for (const key of ["NOTION_TOKEN", "WOLAI_MCP_TOKEN"]) if (process.env[key]) message = message.split(process.env[key]).join("[REDACTED]");
  return message.replace(/(?:Bearer\s+|\b(?:ntn_|secret_|sk-))[A-Za-z0-9_.-]+/gi, "[REDACTED]")
    .replace(/https?:\/\/\S+/g, "[URL]").slice(0, 400);
}
