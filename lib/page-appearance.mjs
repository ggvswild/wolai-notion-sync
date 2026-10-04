import { pageTitle } from "./notion-catalog.mjs";
import { normalizeId } from "./sync-safety.mjs";

export function preferredPageIcon(title, appearance) {
  if (!appearance) return null;
  if (/idea/i.test(title) && appearance.ideaIcon) return { type: "emoji", emoji: appearance.ideaIcon };
  if (/20\d{2}[/-]\d{1,2}[/-]\d{1,2}/.test(title) && appearance.datedLogIcon) return { type: "emoji", emoji: appearance.datedLogIcon };
  return null;
}

export function sameIcon(a, b) {
  return a?.type === "emoji" && b?.type === "emoji" && a.emoji === b.emoji;
}

export async function applyPageAppearance({ notion, page, desired, record = null }) {
  if (!desired || sameIcon(page.icon, desired)) return { changed: false, reason: "already-set-or-no-rule", page };
  const generic = page.icon?.type === "emoji" && ["📄", "📃"].includes(page.icon.emoji);
  if (page.icon && !generic && !sameIcon(page.icon, record?.managedAppearanceIcon)) return { changed: false, reason: "preserved-custom-icon", page };
  const beforeTitle = pageTitle(page), beforeParent = JSON.stringify(page.parent);
  await notion.request("PATCH", `/pages/${page.id}`, { retryable: false, body: { icon: desired } });
  const after = await notion.retrievePage(page.id);
  if (!sameIcon(after.icon, desired) || normalizeId(after.id) !== normalizeId(page.id) || pageTitle(after) !== beforeTitle || JSON.stringify(after.parent) !== beforeParent || after.in_trash || after.archived) throw new Error("图标、标题或父级读回不匹配，保留现场");
  if (record) {
    record.managedAppearanceIcon = desired;
    record.appearanceVerifiedAt = new Date().toISOString();
    record.appearanceError = null;
  }
  return { changed: true, reason: "verified", page: after };
}
