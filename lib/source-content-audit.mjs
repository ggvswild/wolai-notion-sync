import { ownBlocks, plainText } from "./notion-render.mjs";
import { childMarkup } from "./sync-safety.mjs";

const decodeEntities = text => text.replace(/&(?:lt|gt|amp|quot|apos);/g, value => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" })[value])
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const textKey = text => decodeEntities(String(text)).normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "");

// A separate source-to-target text coverage check, in addition to the strict
// stored body hash. Formatting punctuation is ignored only for this diagnostic;
// passing it alone never authorizes overwrites or advances successful versions.
export function auditSourceText(blocks, docId, markdown, { native = false } = {}) {
  const children = new Set(childMarkup(markdown));
  const keyFor = native ? text => String(text).normalize("NFC").replace(/\s+/g, "") : textKey;
  const target = keyFor(native ? markdown : String(markdown).split("\n").slice(1).filter(line => !children.has(line.trim())).join("\n"));
  let segments = 0;
  const missing = [];
  for (const block of ownBlocks(blocks, docId)) {
    if (["image", "file", "audio", "video", "row", "column"].includes(block.type)) continue;
    const values = ["table", "simple_table"].includes(block.type)
      ? (block.table_content ?? []).flatMap(row => (Array.isArray(row) ? row : row.cells ?? []).flatMap(cell => Array.isArray(cell) ? cell : [cell]))
      : Array.isArray(block.content) ? block.content : [block.content];
    let unmatched = 0;
    for (const value of values) for (const line of plainText(value).split("\n")) {
      const key = keyFor(line);
      if (!key) continue;
      segments += 1;
      if (!target.includes(key)) unmatched += 1;
    }
    if (unmatched) missing.push({ blockId: block.id, type: block.type, unmatchedSegments: unmatched });
  }
  return { segments, missing };
}

export function markdownMediaCount(markdown) {
  let fence = null, count = 0;
  for (const line of String(markdown).split("\n")) {
    const mark = line.match(/^\s*(`{3,}|~{3,})/);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^\s*(?:>\s*)?!\[.*\]\(/.test(line)) count += 1;
    count += [...line.matchAll(/<(?:file|pdf|image|video|audio)\s+(?:[^>]*\s)?(?:src|source)="/g)].length;
  }
  return count;
}
