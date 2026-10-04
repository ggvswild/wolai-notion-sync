import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

// Creates and removes only its own synthetic temporary workspace. No accounts.
const temp = await mkdtemp(join(tmpdir(), "wolai-package-smoke-"));
const base = resolve(import.meta.dirname, ".."), env = { ...process.env };
for (const name of ["WOLAI_MCP_TOKEN", "NOTION_TOKEN", "CODEX_HOME"]) delete env[name];
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("请通过 npm run smoke 执行，以使用当前 npm 路径");
const npm = args => execFileSync(process.execPath, [npmCli, ...args], { cwd: base, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
try {
  const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", temp]))[0];
  const install = join(temp, "install");
  npm(["install", "--prefix", install, join(temp, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"]);
  const cli = join(install, "node_modules/wolai-notion-sync/bin/cli.mjs"), data = join(temp, "private-data");
  const run = args => execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  if (!run(["--help"]).includes("Wolai")) throw new Error("安装包入口不可用");
  run(["init", "--source-root", "demo-root", "--notion-root", "11111111-1111-4111-8111-111111111111", "--data-dir", data]);
  const state = JSON.parse(await readFile(join(data, "sync-state.json"), "utf8"));
  if (Object.keys(state.documents).length || !JSON.parse(run(["status", "--data-dir", data])).initialized) throw new Error("离线初始化/状态检查失败");
  console.log(JSON.stringify({ packageInstalled: true, helpPassed: true, offlineInitPassed: true, statusPassed: true, credentialsUsed: false, remoteWrites: 0, packageFiles: packed.entryCount }));
} finally { await rm(temp, { recursive: true, force: true }); }
