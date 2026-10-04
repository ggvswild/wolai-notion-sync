import { plainText } from "./notion-render.mjs";
import { normalizeId } from "./sync-safety.mjs";

// Only undo the precise Markdown reparse shape: an empty bullet containing one
// generated numbered item whose text is the original literal number's suffix.
export function planLiteralListRepairs(nodes, blocks, sourceIds, syncedAt) {
  const flat = [], visit = rows => rows.forEach(row => { flat.push(row); visit(row.children); });
  visit(nodes);
  const used = new Set(), plans = [];
  for (const sourceId of sourceIds) {
    const node = flat.find(row => row.sourceId === sourceId);
    const text = node && plainText(node.request.bulleted_list_item?.rich_text);
    const literal = text?.match(/^\d+[.)]\s+([\s\S]+)$/);
    if (!literal || node.children.length) throw new Error("源块不是独立字面量编号列表，禁止修复");
    const candidates = blocks.filter(block => block.type === "numbered_list_item" && !block.has_children &&
      plainText(block.numbered_list_item.rich_text) === literal[1] && !used.has(block.id));
    const matches = candidates.map(child => ({ child, parent: blocks.find(block => normalizeId(block.id) === normalizeId(child.parent?.block_id)) }))
      .filter(({ parent, child }) => parent?.type === "bulleted_list_item" && plainText(parent.bulleted_list_item.rich_text) === "" &&
        blocks.filter(block => normalizeId(block.parent?.block_id) === normalizeId(parent.id)).length === 1 &&
        Math.abs(Date.parse(child.created_time) - Date.parse(syncedAt)) <= 60000);
    if (matches.length !== 1) throw new Error("无法唯一证明同步生成的编号子块，禁止修复");
    const { parent, child } = matches[0]; used.add(child.id);
    plans.push({ sourceId, parentId: parent.id, childId: child.id, richText: node.request.bulleted_list_item.rich_text,
      originalParent: parent, generatedChild: child });
  }
  return plans;
}
