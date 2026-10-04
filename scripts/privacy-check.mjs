import { readdir, readFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { isEntryPoint } from "../lib/entry-point.mjs";
import { execFileSync } from "node:child_process";

const roots = ["bin", "lib", "test", "scripts", "docs", "examples", ".github"];
const files = ["package.json", "package-lock.json", "README.md", "README.en.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md", ".gitignore", ".env.example"];
const forbiddenName = file => /(?:^|\/)(?:sync-state\.json|sync-config\.json|source-tree\.json|\.tree-sync\.lock|\.env(?:\..*)?|cache|backups|proof|audits)(?:\/|$)/.test(file) && file !== ".env.example";
export function privacyFindings(content, file) {
  const result = [];
  const patterns = [
    ["credential-pattern", /(?:ntn_|secret_|sk-)[A-Za-z0-9_.-]{18,}/g],
    ["literal-bearer-token", /Bearer\s+[A-Za-z0-9_.-]{18,}/g],
    ["private-machine-path", /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//g],
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ["credential-store-binding", /(?:const\s+KEYCHAIN_ACCOUNT\s*=|from\s+["'][^"']*codex-primary-runtime)/g],
  ];
  if (forbiddenName(file)) result.push({ file, kind: "private-runtime-file" });
  if (file === ".env.example" && /^(?:WOLAI_MCP_TOKEN|NOTION_TOKEN)[\t ]*=[\t ]*\S+/m.test(content)) result.push({ file, kind: "filled-credential-template" });
  for (const [kind, pattern] of patterns) for (const match of content.matchAll(pattern)) result.push({ file, kind, line: content.slice(0, match.index).split("\n").length });
  return result;
}
async function walk(base, rel) {
  const result = [];
  for (const entry of await readdir(join(base, rel), { withFileTypes: true })) {
    const file = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error("发布源码不能使用指向私人数据的符号链接");
    if (entry.isDirectory()) result.push(...await walk(base, file)); else result.push(file);
  }
  return result;
}
export async function audit(base) {
  const selected = [...files];
  for (const root of roots) selected.push(...await walk(base, root));
  // A force-added ignored file must still fail the release audit.
  try {
    const tracked = execFileSync("git", ["-C", base, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
    selected.push(...tracked);
  } catch { /* Source archives without .git still receive the allowlist audit. */ }
  const unique = [...new Set(selected)], findings = [];
  for (const file of unique) findings.push(...privacyFindings(await readFile(join(base, file), "utf8"), file.replaceAll("\\", "/")));
  const pkg = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
  if (!pkg.files?.length || pkg.files.includes("*") || pkg.files.some(f => f !== ".env.example" && /test|scripts|\.env|cache|state|proof/.test(f))) findings.push({ file: "package.json", kind: "unsafe-package-allowlist" });
  return { filesChecked: unique.length, findings };
}
if (isEntryPoint(import.meta.url)) {
  const base = resolve(import.meta.dirname, ".."), report = await audit(base);
  console.log(JSON.stringify(report)); process.exitCode = report.findings.length ? 2 : 0;
}
