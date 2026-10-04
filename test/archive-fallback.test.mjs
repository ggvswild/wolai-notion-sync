import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { storedZip } from "../lib/archive-fallback.mjs";

test("归档使用标准 ZIP，HTML 示例逐字可还原且 CRC 检查通过",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"wolai-zip-test-"));
  try{
    const content=Buffer.from('<iframe onload="ready()"><script>literal</script></iframe>\n中文');
    const archive=storedZip([{name:"note.md",bytes:content},{name:"assets/sample.bin",bytes:Buffer.from([0,1,2,3,255])}]);
    const path=join(dir,"test.zip");await writeFile(path,archive);
    execFileSync("/usr/bin/unzip",["-tq",path]);
    const restored=execFileSync("/usr/bin/unzip",["-p",path,"note.md"]);
    assert.deepEqual(restored,content);
  }finally{await rm(dir,{recursive:true,force:true});}
});
