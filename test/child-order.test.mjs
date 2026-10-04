import test from "node:test";
import assert from "node:assert/strict";
import { preserveChildPages, childMarkup, bodyFingerprint, planChildPageOrder } from "../lib/sync-safety.mjs";

const ids = ["11111111111111111111111111111111", "22222222222222222222222222222222", "33333333333333333333333333333333"];
const tag = (id, title = id) => `<page url="https://www.notion.so/${id}">${title}</page>`;

test("父页更新按源目录顺序保留真实子页，而不是延续并发创建顺序", () => {
  const original = `旧正文\n${ids.map(id => tag(id)).join("\n")}`;
  const result = preserveChildPages(original, "新正文", { desiredPageIds: [...ids].reverse() });
  assert.deepEqual(childMarkup(result), [...ids].reverse().map(id => tag(id)));
  assert.equal(bodyFingerprint(result), bodyFingerprint("新正文"));
});

test("目录排序保留手工子页位置以及每个已有页面 ID", () => {
  const manual = "44444444444444444444444444444444";
  const original = [tag(ids[0]), tag(manual, "手工子页"), tag(ids[1]), tag(ids[2])].join("\n");
  const result = preserveChildPages(original, "正文", { desiredPageIds: [...ids].reverse() });
  assert.deepEqual(childMarkup(result), [tag(ids[2]), tag(manual, "手工子页"), tag(ids[1]), tag(ids[0])]);
});

test("增量尚未创建的孩子不凭空写成新页面或伪造页面链接", () => {
  const original = tag(ids[0]);
  const result = preserveChildPages(original, "正文", { desiredPageIds: [ids[2], ids[1], ids[0]] });
  assert.deepEqual(childMarkup(result), [tag(ids[0])]);
});

test("排序补丁只包含目录区域，代码中的页面示例和正文逐字保留", () => {
  const body = `> 来源：wolai · doc_id: src · version: 1\n\n正文\n\n\`\`\`xml\n${tag(ids[2])}\n\`\`\`\n\n`;
  const md = body + [tag(ids[0]), "", tag(ids[1]), tag(ids[2])].join("\n") + "\n";
  const plan = planChildPageOrder(md, [...ids].reverse());
  assert.equal(plan.changed, true);
  assert.ok(plan.content.startsWith(body));
  assert.equal(bodyFingerprint(plan.content), bodyFingerprint(md));
  assert.equal(plan.oldStr, [tag(ids[0]), "", tag(ids[1]), tag(ids[2])].join("\n"));
  assert.equal(planChildPageOrder(plan.content, [...ids].reverse()).changed, false);
});

test("验收不能忽略缺失子页、重复目标或夹在目录中的正文", () => {
  assert.throws(() => planChildPageOrder(tag(ids[0]), ids), /缺失/);
  assert.throws(() => planChildPageOrder([tag(ids[0]), tag(ids[0])].join("\n"), [ids[0]]), /重复/);
  assert.throws(() => planChildPageOrder([tag(ids[0]), "手工备注", tag(ids[1])].join("\n"), [ids[1], ids[0]]), /正文/);
});
