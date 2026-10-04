import test from "node:test";
import assert from "node:assert/strict";
import { preferredPageIcon, applyPageAppearance } from "../lib/page-appearance.mjs";

const appearance = { ideaIcon: "💡", datedLogIcon: "📅" };
const page = icon => ({ id: "page", icon, parent: { type: "page_id", page_id: "parent" }, properties: { title: { type: "title", title: [{ text: { content: "idea" } }] } } });
test("idea 关键词优先于日期图标，保留原标题文字", () => {
  assert.equal(preferredPageIcon("2026/09/25 - IDEA 灵感", appearance).emoji, "💡");
  assert.equal(preferredPageIcon("2026/09/25 计划表", appearance).emoji, "📅");
  assert.equal(preferredPageIcon("普通记录", appearance), null);
});
test("图标写入只改 icon，验证后记录规则；已有自选图标保留", async () => {
  let calls = 0;
  const record = {};
  const notion = { request: async (method, path, args) => { calls++; assert.deepEqual(args.body, { icon: { type: "emoji", emoji: "💡" } }); }, retrievePage: async () => page({ type: "emoji", emoji: "💡" }) };
  assert.equal((await applyPageAppearance({ notion, page: page(null), desired: { type: "emoji", emoji: "💡" }, record })).changed, true);
  assert.equal(record.managedAppearanceIcon.emoji, "💡");
  assert.equal((await applyPageAppearance({ notion, page: page({ type: "emoji", emoji: "🌟" }), desired: { type: "emoji", emoji: "💡" } })).reason, "preserved-custom-icon");
  assert.equal(calls, 1);
});
