import { extname } from "node:path";

export function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^(\d{4})[/.年-](\d{1,2})[/.月-](\d{1,2})日?/, (_, year, month, day) =>
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    )
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*(日计划表|计划表)/g, " - $1")
    .toLowerCase();
}

export function identityKey(value) {
  const normalized = normalizeTitle(value);
  const date = normalized.match(/(?:^|\D)(20\d{2})-(\d{2})-(\d{2})(?:\D|$)/);
  return date ? `date:${date[1]}-${date[2]}-${date[3]}` : `title:${normalized}`;
}

export function safeFilename(value, fallback = "untitled") {
  const safe = String(value ?? "")
    .normalize("NFKC")
    .replace(/[/:*?"<>|\\]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (safe || fallback).slice(0, 140);
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_[\]<>])/g, "\\$1");
}

function richText(content = []) {
  return content
    .map((span) => {
      let text = String(span.title ?? "");
      if (span.type === "equation") text = `$${text}$`;
      else if (span.inline_code) text = `\`${text.replace(/`/g, "\\`")}\``;
      else text = escapeMarkdown(text);

      if (span.bold) text = `**${text}**`;
      if (span.italic) text = `*${text}*`;
      if (span.strikethrough) text = `~~${text}~~`;
      if (span.underline) text = `<u>${text}</u>`;
      if (span.link) text = `[${text || span.link}](${span.link})`;
      return text;
    })
    .join("");
}

function depthOf(block, byId, pageId) {
  let depth = 0;
  let current = block;
  const seen = new Set();
  while (current?.parent_id && current.parent_id !== pageId && byId.has(current.parent_id)) {
    if (seen.has(current.parent_id)) break;
    seen.add(current.parent_id);
    depth += 1;
    current = byId.get(current.parent_id);
  }
  return Math.min(depth, 6);
}

function isInsideNestedPage(block, byId, pageId) {
  let current = block;
  const seen = new Set();
  while (current?.parent_id && current.parent_id !== pageId && byId.has(current.parent_id)) {
    if (seen.has(current.parent_id)) break;
    seen.add(current.parent_id);
    current = byId.get(current.parent_id);
    if (current?.type === "page" && current.id !== pageId) return true;
  }
  return false;
}

function fencedCode(text, language = "") {
  const longest = Math.max(3, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length + 1));
  const fence = "`".repeat(longest);
  const normalizedLanguage = String(language).trim().toLowerCase();
  return `${fence}${normalizedLanguage}\n${text}\n${fence}`;
}

export function blocksToMarkdown(blocks, { docId, title, version, editedAt, mediaPaths = new Map() }) {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const lines = [
    `> 来源：wolai · doc_id: ${docId} · version: ${version ?? "unknown"} · edited_at: ${editedAt ?? "unknown"}`,
    "",
  ];

  for (const block of blocks) {
    if (block.id === docId || block.type === "page" || isInsideNestedPage(block, byId, docId)) continue;
    const text = richText(block.content);
    const indent = "  ".repeat(depthOf(block, byId, docId));

    switch (block.type) {
      case "heading":
        lines.push(`${"#".repeat(Math.max(1, Math.min(3, block.level ?? 2)))} ${text}`);
        break;
      case "bull_list":
        lines.push(`${indent}- ${text}`);
        break;
      case "enum_list":
        lines.push(`${indent}1. ${text}`);
        break;
      case "todo_list":
        lines.push(`${indent}- [${block.checked ? "x" : " "}] ${text}`);
        break;
      case "todo_list_pro":
        lines.push(`${indent}- [${block.task_status === "done" ? "x" : " "}] ${text}`);
        break;
      case "quote":
        lines.push(`> ${text}`);
        break;
      case "callout":
        lines.push(`> ${text}`);
        break;
      case "code":
        lines.push(fencedCode(text, block.language ?? ""));
        break;
      case "divider":
        lines.push("---");
        break;
      case "block_equation":
        lines.push(`$$\n${text}\n$$`);
        break;
      case "simple_table":
        if (Array.isArray(block.table_content) && block.table_content.length) {
          const rows = block.table_content.map((row) => row.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")));
          lines.push(`| ${rows[0].join(" | ")} |`);
          lines.push(`| ${rows[0].map(() => "---").join(" | ")} |`);
          for (const row of rows.slice(1)) lines.push(`| ${row.join(" | ")} |`);
        }
        break;
      case "image": {
        const localPath = mediaPaths.get(block.id);
        const source = localPath ?? block.media?.download_url ?? block.link;
        if (source) lines.push(`![${escapeMarkdown(block.caption ?? "图片")}](${source})`);
        break;
      }
      case "video":
      case "audio":
      case "file":
      case "bookmark":
      case "embed": {
        const source = block.media?.download_url ?? block.link ?? block.original_link ?? block.embed_link;
        if (source) lines.push(`[${escapeMarkdown(block.caption ?? block.type)}](${source})`);
        break;
      }
      default:
        lines.push(text);
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function mediaExtension(block) {
  const url = block.media?.download_url;
  if (!url) return ".bin";
  try {
    const extension = extname(new URL(url).pathname);
    return extension && extension.length <= 8 ? extension : ".bin";
  } catch {
    return ".bin";
  }
}
