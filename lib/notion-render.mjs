export function plainText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(plainText).join("");
  return value.title ?? value.plain_text ?? value.text?.content ?? plainText(value.content ?? value.value);
}

function chunks(text, size = 1900) {
  const chars = [...text];
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

export function richText(value, { plain = false } = {}) {
  const spans = Array.isArray(value) ? value : [{ title: plainText(value) }];
  return spans.flatMap((span) => {
    // Notion strips U+000D from native rich text on write. Canonicalise the
    // request, not the read-back comparison, so all other differences still fail.
    const text = plainText(span).replaceAll("\r", "");
    if (!text) return [];
    const link = !plain && /^https?:\/\//.test(span.link ?? "") ? span.link : undefined;
    // Keep active HTML delimiters in separate literal text runs. Notion joins
    // these runs without changing the text or its code formatting.
    const parts = text.split(/(<(?=\/?(?:script|iframe|object|embed|svg|math|style|form|img|input|meta|link|body)\b))/gi)
      .flatMap(part=>part.split(/(\bon[a-z]{2,30}\s*)(?==)/gi)).filter(Boolean).flatMap(part=>chunks(part));
    return parts.map((part) => ({ type: "text", text: { content: part, ...(link ? { link: { url: link.replaceAll("<","%3C").replaceAll(">","%3E") } } : {}) },
      ...(!plain ? { annotations: { bold: !!span.bold, italic: !!span.italic, strikethrough: !!span.strikethrough, underline: !!span.underline, code: !!span.inline_code } } : {}),
    }));
  });
}

export function ownBlocks(blocks, pageId) {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  return blocks.filter((block) => {
    if (block.id === pageId || ["page", "database"].includes(block.type)) return false;
    let parent = byId.get(block.parent_id);
    const seen = new Set([block.id]);
    while (parent && parent.id !== pageId) {
      if (seen.has(parent.id)) throw new Error("源块结构存在循环");
      seen.add(parent.id);
      if (["page", "database"].includes(parent.type)) return false;
      parent = byId.get(parent.parent_id);
    }
    return true;
  });
}

const LANGUAGES = new Set("abap arduino bash basic c clojure coffeescript c++ c# css dart diff docker elixir elm erlang flow fortran f# gherkin glsl go graphql groovy haskell html java javascript json julia kotlin latex less lisp livescript lua makefile markdown markup matlab mermaid nix objective-c ocaml pascal perl php powershell prolog protobuf python r reason ruby rust sass scala scheme scss shell sql swift typescript vb.net verilog vhdl webassembly xml yaml".split(" "));
const CHILD_CAPABLE = new Set(["paragraph", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "heading_1", "heading_2", "heading_3"]);

export function sourceHeader(doc) {
  return `来源：wolai · doc_id: ${doc.docId} · version: ${doc.version ?? "unknown"} · edited_at: ${doc.editedAt ?? "unknown"} · payload: ${doc.signature}${doc.bodyHash ? ` · content_hash: ${doc.bodyHash}` : ""}`;
}

function renderBlock(block, assets, warnings) {
  if ([block.content, block.caption, block.table_content].some(value => plainText(value).includes("\r"))) warnings.add("notion-normalized-carriage-return");
  const r = richText(block.content);
  const wrap = (type, body) => ({ object: "block", type, [type]: body });
  const simple = { text: "paragraph", bull_list: "bulleted_list_item", enum_list: "numbered_list_item", quote: "quote", toggle_list: "toggle", reference: "paragraph" };
  if (simple[block.type]) {
    if (block.type === "reference" && !r.length && block.source_block_id) {
      return wrap("paragraph", { rich_text: richText([{ title: "源端引用块", link: `https://www.wolai.com/${block.source_block_id}` }]) });
    }
    return wrap(simple[block.type], { rich_text: r });
  }
  if (["row", "column"].includes(block.type)) return null;
  if (block.type === "heading") return wrap(`heading_${Math.max(1, Math.min(3, block.level ?? 2))}`, { rich_text: r, is_toggleable: !!block.toggle });
  if (["todo_list", "todo_list_pro", "toggle_todo_list"].includes(block.type)) return wrap("to_do", { rich_text: r, checked: !!block.checked || block.task_status === "done" });
  if (block.type === "divider") return wrap("divider", {});
  if (block.type === "callout") return wrap("callout", { rich_text: r });
  if (block.type === "code") {
    const lang = String(block.language ?? "").toLowerCase();
    const aliases = { js: "javascript", ts: "typescript", sh: "shell", py: "python", md: "markdown" };
    return wrap("code", { rich_text: richText(block.content, { plain: true }), language: LANGUAGES.has(aliases[lang] ?? lang) ? aliases[lang] ?? lang : "plain text" });
  }
  if (block.type === "block_equation") return wrap("equation", { expression: plainText(block.content) });
  if (["table", "simple_table"].includes(block.type) && Array.isArray(block.table_content) && block.table_content.length) {
    const rows = block.table_content.map(row => Array.isArray(row) ? row : row.cells ?? row.content ?? [row]);
    const width = Math.max(...rows.map(row => row.length));
    if (width > 100) throw new Error("表格列数超过 Notion 可安全转换范围");
    return wrap("table", { table_width: width, has_column_header: !!block.table_setting?.has_header, has_row_header: false,
      children: rows.map(row => wrap("table_row", { cells: Array.from({ length: width }, (_, i) => richText(row[i] ?? "")) })),
    });
  }
  if (["image", "file", "video", "audio"].includes(block.type)) {
    const asset = assets.get(block.id);
    if (asset?.oversize) {
      warnings.add("media-exceeds-workspace-limit");
      return wrap("paragraph", { rich_text: richText([{ title: `⚠️ 原文件未复制（${(asset.bytes / 1048576).toFixed(1)} MiB，当前上限 ${(asset.limit / 1048576).toFixed(1)} MiB）：${asset.filename}。点击查看 Wolai 原件。`, link: asset.sourceUrl }]) });
    }
    if (!asset) {
      if (block.media?.download_url || block.link) throw new Error("媒体尚未成功上传");
      warnings.add("empty-media-placeholder");
      return wrap("paragraph", { rich_text: richText(`[${block.type}：源端空占位]`) });
    }
    if (asset.archive) warnings.add("media-original-file-zipped");
    const type = asset.archive ? "file" : block.type === "file" && asset.contentType === "application/pdf" ? "pdf" : block.type;
    const caption = asset.archive ? `${plainText(block.caption)}${block.caption ? " · " : ""}原文件已无损封装为 ZIP：${asset.archive.filename}` : block.caption;
    return wrap(type, { type: "file_upload", file_upload: { id: asset.uploadId }, caption: richText(caption), ...(type === "file" ? { name: asset.filename } : {}) });
  }
  const url = block.link ?? block.page_url ?? block.bookmark_url ?? block.original_link ?? block.embed_link;
  if (["bookmark", "embed"].includes(block.type) && /^https?:\/\//.test(url ?? "")) return wrap(block.type, { url });
  if (block.type === "progress_bar") return wrap("paragraph", { rich_text: richText(`进度：${block.progress ?? 0}% ${plainText(block.content)}`) });
  warnings.add(`fallback:${block.type}`);
  return wrap("paragraph", { rich_text: r.length ? r : richText([{ title: `源端 ${block.type} 块`, link: `https://www.wolai.com/${block.id}` }]) });
}

export function renderNativeNodes(blocks, doc, assets = new Map(), warnings = new Set()) {
  const own = ownBlocks(blocks, doc.docId);
  const nodes = new Map();
  const parents = new Map(own.map(block => [block.id, block.parent_id]));
  const roots = [{ sourceId: `marker:${doc.docId}`, request: { object: "block", type: "quote", quote: { rich_text: richText(sourceHeader(doc)) } }, children: [] }];
  for (const block of own) {
    const request = renderBlock(block, assets, warnings);
    if (request) {
      const text = request[request.type]?.rich_text;
      if (text?.length > 100) throw new Error("单块富文本超过 Notion 限制；保留源页等待专门处理");
      const tableRows = request.type === "table" ? request.table.children : null;
      if (tableRows) delete request.table.children;
      nodes.set(block.id, { sourceId: block.id, request, children: tableRows?.map((row, i) => ({ sourceId: `${block.id}:row:${i}`, request: row, children: [] })) ?? [] });
    }
  }
  for (const block of own) {
    const node = nodes.get(block.id);
    if (!node) continue;
    let parentId = block.parent_id;
    while (parents.has(parentId) && !nodes.has(parentId)) parentId = parents.get(parentId);
    const parent = nodes.get(parentId);
    if (parent && CHILD_CAPABLE.has(parent.request.type)) {
      if (parent.request.type.startsWith("heading_")) parent.request[parent.request.type].is_toggleable = true;
      parent.children.push(node);
    } else roots.push(node);
  }
  if (doc.sourceType === "database") {
    warnings.add("database-records-not-enumerable-by-mcp");
    roots.push({ sourceId: `database:${doc.docId}`, request: { object: "block", type: "paragraph", paragraph: {
      rich_text: richText([{ title: "数据库容器：点击查看 Wolai 原始数据库。当前 MCP 不提供完整记录枚举，数据库视图和字段未转换。", link: `https://www.wolai.com/${doc.docId}` }]),
    } }, children: [] });
  }
  return roots;
}

export function packedChildCount(node, depth = 1) {
  if (node.request.type === "table") return Math.min(node.children.length, 80);
  if (!depth || node.children.length > 80) return 0;
  const packed = node.children.map(child => packNode(child, depth - 1));
  return Buffer.byteLength(JSON.stringify(packed)) < 300000 ? node.children.length : 0;
}

export function packNode(node, depth = 1) {
  const request = structuredClone(node.request);
  const count = packedChildCount(node, depth);
  if (count) request[request.type].children = node.children.slice(0, count).map(child => packNode(child, depth - 1));
  return request;
}

export function requestBatches(requests) {
  const batches = [];
  let batch = [], size = 0, count = 0;
  const blockCount = block => 1 + (block[block.type]?.children ?? []).reduce((n, child) => n + blockCount(child), 0);
  for (const request of requests) {
    const bytes = Buffer.byteLength(JSON.stringify(request));
    if (bytes > 430000) throw new Error("单块超过 Notion 安全请求大小");
    const nestedCount = blockCount(request);
    if (nestedCount > 900) throw new Error("单个嵌套块超过安全数量限制");
    if (batch.length && (batch.length >= 90 || size + bytes > 430000 || count + nestedCount > 900)) { batches.push(batch); batch = []; size = 0; count = 0; }
    batch.push(request); size += bytes; count += nestedCount;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

const escapeText = text => String(text).replace(/([\\*~`$\[\]<>{}|^_])/g, "\\$1");
const escapeAttr = text => String(text).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function markdownText(spans) {
  return (spans ?? []).map(span => {
    const raw = plainText(span), annotations = span.annotations ?? {};
    let text = escapeText(raw);
    if (annotations.code) { const fence = "`".repeat(Math.max(1, ...[...raw.matchAll(/`+/g)].map(m=>m[0].length+1))); text = `${fence}${raw}${fence}`; }
    if (annotations.bold) text = `**${text}**`;
    if (annotations.italic) text = `*${text}*`;
    if (annotations.strikethrough) text = `~~${text}~~`;
    if (annotations.underline) text = `<span underline="true">${text}</span>`;
    if (span.text?.link?.url) text = `[${text}](${span.text.link.url.replaceAll(")", "%29")})`;
    return text.replaceAll("\n", "<br>");
  }).join("");
}

export function nativeNodesToMarkdown(nodes, mediaUrls = new Map(), depth = 0) {
  const lines = [];
  for (const node of nodes) {
    const { type } = node.request, data = node.request[type], text = markdownText(data.rich_text);
    const indent = "\t".repeat(depth);
    let value;
    if (type === "paragraph") value = text || "<empty-block/>";
    else if (type === "quote") value = `> ${text}`;
    else if (type === "bulleted_list_item") value = `- ${text}`;
    else if (type === "numbered_list_item") value = `1. ${text}`;
    else if (type === "to_do") value = `- [${data.checked ? "x" : " "}] ${text}`;
    else if (type.startsWith("heading_")) value = `${"#".repeat(Number(type.at(-1)))} ${text}${node.children.length ? ' {toggle="true"}' : ""}`;
    else if (type === "divider") value = "---";
    else if (type === "code") {
      const raw = plainText(data.rich_text), fence = "`".repeat(Math.max(3, ...[...raw.matchAll(/`+/g)].map(m=>m[0].length+1)));
      value = `${fence}${data.language === "plain text" ? "" : data.language}\n${raw}\n${fence}`;
    } else if (type === "equation") value = `$$\n${data.expression}\n$$`;
    else if (type === "callout") value = `<callout>\n\t${text}\n${nativeNodesToMarkdown(node.children, mediaUrls, 1)}\n</callout>`;
    else if (type === "toggle") value = `<details>\n<summary>${text}</summary>\n${nativeNodesToMarkdown(node.children, mediaUrls, 1)}\n</details>`;
    else if (type === "table") {
      value = `<table header-row="${data.has_column_header}">\n${node.children.map(row => `\t<tr>${row.request.table_row.cells.map(cell=>`<td>${markdownText(cell)}</td>`).join("")}</tr>`).join("\n")}\n</table>`;
    } else if (["image", "file", "pdf", "audio", "video"].includes(type)) {
      const url = mediaUrls.get(data.file_upload.id);
      if (!url) throw new Error("更新媒体缺少源下载地址");
      const caption = markdownText(data.caption);
      value = type === "image" ? `![${caption}](${url.replaceAll(")", "%29")})` : `<${type} src="${escapeAttr(url)}">${caption}</${type}>`;
    } else if (["bookmark", "embed"].includes(type)) value = `[${escapeText(data.url)}](${data.url.replaceAll(")", "%29")})`;
    else throw new Error(`不支持的更新块类型 ${type}`);
    lines.push(value.split("\n").map(line=>`${indent}${line}`).join("\n"));
    if (node.children.length && !["table", "callout", "toggle"].includes(type)) lines.push(nativeNodesToMarkdown(node.children, mediaUrls, depth + 1));
  }
  return lines.join("\n");
}

export function maskLiteralMarkup(nodes) {
  const masked = structuredClone(nodes), replacements=[];
  function walk(list) {
    for (const node of list) {
      const type=node.request.type, data=node.request[type];
      const field=data.rich_text ? "rich_text" : data.cells ? "cells" : null;
      const literal = field ? plainText(data[field]) : "";
      const markdownSyntax = /(?:^|\n)\s*(?:\d+[.)]\s|[#>+-]\s|[-=_]{3,}(?:\s|$))/.test(literal);
      if (field && (literal.includes("<") || /\bon[a-z]{2,30}\s*=/i.test(literal) || markdownSyntax || literal.trim() !== literal)) {
        const placeholder=`WOLAI_LITERAL_${replacements.length}_${node.sourceId.replace(/[^A-Za-z0-9]/g, "_")}`;
        const payload={ [field]:data[field], ...(type==="code" ? {language:data.language} : {}) };
        replacements.push({sourceId:node.sourceId,type,placeholder,payload});
        data[field]=field==="cells" ? data.cells.map((_,i)=>i===0?richText(placeholder):[]) : richText(placeholder);
      }
      walk(node.children);
    }
  }
  walk(masked);
  return {nodes:masked,replacements};
}
