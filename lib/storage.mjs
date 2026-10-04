import { mkdir, readFile, rename, writeFile, open, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export function sourceCache(baseDir) {
  const fileFor = id => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("源页面 ID 不安全，拒绝读写缓存");
    return join(baseDir, "cache/source", `${id}.json`);
  };
  return {
    get: (id) => readJson(fileFor(id), null),
    set: (id, value) => writeJson(fileFor(id), value),
  };
}

export async function acquireLock(baseDir) {
  const path = join(baseDir, ".tree-sync.lock");
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const lock = await readJson(path);
    if (!Number.isInteger(lock.pid) || lock.pid < 1) throw new Error("互斥锁损坏；保留现场，不能自动删除");
    try { process.kill(lock.pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") { await unlink(path); return acquireLock(baseDir); }
      throw error;
    }
    throw new Error("已有同步进程运行；本次不重复写入");
  }
  return async () => { await unlink(path); };
}
