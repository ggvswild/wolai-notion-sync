import test from "node:test";
import assert from "node:assert/strict";
import { planLiteralListRepairs } from "../lib/literal-list-repair.mjs";
import { richText, plainText } from "../lib/notion-render.mjs";

const time = "2026-08-30T06:32:00.000Z";
function fixture() {
  return { nodes: [{ sourceId: "s", children: [], request: { type: "bulleted_list_item", bulleted_list_item: { rich_text: richText("3. 原始条目") } } }],
    blocks: [{ id: "p", type: "bulleted_list_item", bulleted_list_item: { rich_text: [] } },
      { id: "c", parent: { block_id: "p" }, type: "numbered_list_item", numbered_list_item: { rich_text: richText("原始条目") }, has_children: false, created_time: time }] };
}
test("只修复源编号被同步重解析的唯一空列表形状", () => {
  const f = fixture(), result = planLiteralListRepairs(f.nodes, f.blocks, ["s"], time);
  assert.equal(result.length, 1); assert.equal(result[0].childId, "c");
  assert.equal(plainText(result[0].richText), "3. 原始条目");
});
test("有额外内容、正文差异或后续创建的编号块时不自动归档", () => {
  for (const change of [f => f.blocks.push({ id: "extra", parent: { block_id: "p" } }),
    f => { f.blocks[1].numbered_list_item.rich_text = richText("手工文字"); },
    f => { f.blocks[1].created_time = "2026-09-30T06:32:00.000Z"; }]) {
    const f = fixture(); change(f);
    assert.throws(() => planLiteralListRepairs(f.nodes, f.blocks, ["s"], time), /禁止修复/);
  }
});
