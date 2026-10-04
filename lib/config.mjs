import { mkdir, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "./storage.mjs";
import { digest, normalizeId } from "./sync-safety.mjs";

const uuid = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const keys = new Set(["schemaVersion", "syncScope", "notionRoot", "policy", "navigation", "appearance", "media"]);
export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是 JSON 对象");
  if (Object.keys(value).some(k => !keys.has(k))) throw new Error("配置包含不支持的字段；凭证只能放在环境变量中");
  for (const [name, allowed] of Object.entries({ syncScope: ["sourceRootIds"], notionRoot: ["pageId"], policy: ["sourceOfTruth", "batchSize", "maxRetries", "deleteInNotionWhenMissingFromWolai", "overwriteManualNotionEdits"], navigation: ["orderedSourceRoots"], appearance: ["ideaIcon", "datedLogIcon"], media: ["maxFileUploadBytes"] })) {
    if (value[name] !== undefined && (!value[name] || typeof value[name] !== "object" || Array.isArray(value[name]) || Object.keys(value[name]).some(k => !allowed.includes(k)))) throw new Error("嵌套配置包含不支持的字段；不要在配置中保存凭证");
  }
  const roots = value.syncScope?.sourceRootIds;
  if (!Array.isArray(roots) || !roots.length || roots.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || /REPLACE|YOUR_|ROOT_ID/.test(id)) || new Set(roots).size !== roots.length) throw new Error("必须显式配置非空、唯一的 Wolai 根页面 ID");
  const pageId = value.notionRoot?.pageId;
  if (typeof pageId !== "string" || !uuid.test(pageId) || /^0+$/.test(normalizeId(pageId))) throw new Error("Notion 根页面必须是有效的页面 ID，不能使用占位符");
  if (value.policy?.deleteInNotionWhenMissingFromWolai || value.policy?.overwriteManualNotionEdits) throw new Error("不能关闭不删除页面和手工内容保护策略");
  const batchSize = value.policy?.batchSize ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("batchSize 必须是 1 至 500 的整数");
  const maxFileUploadBytes = value.media?.maxFileUploadBytes ?? 5242880;
  if (!Number.isInteger(maxFileUploadBytes) || maxFileUploadBytes < 1024 || maxFileUploadBytes > 20971520) throw new Error("媒体上限必须在 1 KiB 至 20 MiB 之间");
  const appearance = value.appearance ?? {};
  if (Object.values(appearance).some(v => typeof v !== "string" || v.length > 32)) throw new Error("图标规则必须是短字符串");
  return { schemaVersion: 1, syncScope: { sourceRootIds: [...roots] }, notionRoot: { pageId },
    policy: { sourceOfTruth: "wolai", deleteInNotionWhenMissingFromWolai: false, overwriteManualNotionEdits: false, batchSize, maxRetries: 3 },
    navigation: { orderedSourceRoots: [...roots] }, appearance: { ideaIcon: appearance.ideaIcon ?? "💡", datedLogIcon: appearance.datedLogIcon ?? "📅" },
    media: { maxFileUploadBytes } };
}
export const configBinding = config => digest(JSON.stringify({ roots: [...config.syncScope.sourceRootIds].sort(), target: normalizeId(config.notionRoot.pageId) }));
export async function initializeWorkspace(baseDir, input) {
  const config = validateConfig(input);
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  // Reserve initialization atomically; never overwrite an existing workspace.
  const marker = join(baseDir, ".initialized");
  for (const name of ["sync-state.json", "sync-config.json"]) {
    try { await access(join(baseDir, name)); throw new Error("数据目录已有同步状态或配置，请使用其他目录或继续原同步"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await writeFile(marker, "wolai-notion-sync\n", { flag: "wx", mode: 0o600 });
  await writeJson(join(baseDir, "sync-config.json"), config);
  await writeJson(join(baseDir, "sync-state.json"), { schemaVersion: 2, rootPageId: config.notionRoot.pageId, configBinding: configBinding(config), documents: {}, hierarchyBackfillComplete: false, navigationComplete: false, mediaBackfillComplete: false });
  return config;
}
export async function loadWorkspace(baseDir) {
  const config = validateConfig(await readJson(join(baseDir, "sync-config.json")));
  const state = await readJson(join(baseDir, "sync-state.json"));
  if (normalizeId(state.rootPageId) !== normalizeId(config.notionRoot.pageId) || state.configBinding !== configBinding(config)) throw new Error("配置与状态绑定不一致；改变来源范围或目标时请新建数据目录");
  if (!state.documents || typeof state.documents !== "object" || Array.isArray(state.documents)) throw new Error("同步状态损坏，请恢复同一目标的备份，不要伪造成功版本");
  return { config, state };
}
