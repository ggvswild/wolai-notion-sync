import { readFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import { writeJson, readJson } from "./storage.mjs";
import { writeFile } from "node:fs/promises";
import { ownBlocks, renderNativeNodes, nativeNodesToMarkdown, richText, sourceHeader, plainText } from "./notion-render.mjs";
import { bodyFingerprint, sourceMarker, normalizeId } from "./sync-safety.mjs";

const sha = value=>createHash("sha256").update(value).digest("hex");
const crcTable = Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32 = bytes=>{let c=0xffffffff;for(const byte of bytes)c=crcTable[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;};

export function storedZip(entries) {
  const local=[],central=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name),data=Buffer.from(entry.bytes),crc=crc32(data);
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(0x21,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);
    local.push(h,name,data);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(0x21,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
    central.push(c,name);offset+=h.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

function stableExport(value){
  if(Array.isArray(value))return value.map(stableExport);
  if(!value||typeof value!=="object")return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key=>!["download_url","expires_in","api_url"].includes(key)).map(key=>[key,stableExport(value[key])]));
}

export async function buildArchive({baseDir,doc,blocks,maxBytes}){
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(doc.docId))throw new Error("源页面 ID 不安全");
  const key=sha(`${doc.signature}:${doc.bodyHash}`),dir=join(baseDir,"cache/archives",doc.docId,key);
  const cached=await readJson(join(dir,"manifest.json"),null);
  if(cached){try{const files=cached.files.map(file=>{if(!/^[A-Za-z0-9_.-]+\.zip$/.test(file.name))throw new Error("归档文件名不安全");return {...file,path:join(dir,file.name)};});await Promise.all(files.map(file=>readFile(file.path)));return {...cached,files};}catch{}}
  await mkdir(dir,{recursive:true,mode:0o700});
  const entries=[],assets=new Map(),urls=new Map(),media=[],exceptions=[];
  for(const block of ownBlocks(blocks,doc.docId).filter(b=>["image","file","audio","video"].includes(b.type)&&(b.media?.download_url||b.link))){
    if(Number(block.file_size)>maxBytes-1024){const item={blockId:block.id,oversize:true,bytes:Number(block.file_size),limit:maxBytes,filename:plainText(block.file_name)||block.id,sourceUrl:`https://www.wolai.com/${doc.docId}#${block.id}`};exceptions.push(item);assets.set(block.id,item);continue;}
    const url=block.media?.download_url??block.link;
    if(!/^https?:\/\//.test(url))throw new Error("归档媒体地址无效");
    const response=await fetch(url,{signal:AbortSignal.timeout(45000)});
    if(!response.ok)throw new Error(`归档媒体读取失败 HTTP ${response.status}`);
    const length=Number(response.headers.get("content-length"));
    if(length>maxBytes-1024){await response.body.cancel();const item={blockId:block.id,oversize:true,bytes:length,limit:maxBytes,filename:plainText(block.file_name)||block.id,sourceUrl:`https://www.wolai.com/${doc.docId}#${block.id}`};exceptions.push(item);assets.set(block.id,item);continue;}
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes-1024)throw new Error("媒体过大，保留源文件等待处理");chunks.push(chunk);}
    const bytes=Buffer.concat(chunks),type=(response.headers.get("content-type")??"application/octet-stream").split(";")[0];
    if(type==="text/html")throw new Error("归档媒体返回网页，未当作图片保存");
    const suffix=extname(new URL(url).pathname);const extension=/^\.[a-z0-9]{1,8}$/i.test(suffix)?suffix:({"image/png":".png","image/jpeg":".jpg","image/gif":".gif","image/svg+xml":".svg","application/pdf":".pdf"}[type]??".bin");
    const name=`assets/${sha(block.id).slice(0,24)}${extension}`;
    entries.push({name,bytes});media.push({blockId:block.id,name,bytes:bytes.length,sha256:sha(bytes)});
    assets.set(block.id,{uploadId:block.id,filename:name,contentType:type});urls.set(block.id,name);
  }
  const warnings=new Set(),nodes=renderNativeNodes(blocks,doc,assets,warnings);
  const heading=nativeNodesToMarkdown([{sourceId:"title",request:{type:"heading_1",heading_1:{rich_text:richText(doc.title)}},children:[]}]);
  entries.unshift({name:"note.md",bytes:Buffer.from(`${heading}\n\n${nativeNodesToMarkdown(nodes,urls)}\n`)},{name:"blocks.json",bytes:Buffer.from(JSON.stringify(stableExport(blocks),null,2))},{name:"manifest.json",bytes:Buffer.from(JSON.stringify({docId:doc.docId,title:doc.title,version:doc.version,bodyHash:doc.bodyHash,media,exceptions},null,2))},{name:"README.txt",bytes:Buffer.from("此包保留 Wolai 原文与原始图片，不做图片降质或代码改写。若有多个包，请全部解压到同一目录后查看 note.md。blocks.json 保留源块结构；临时签名下载地址已移除。\n")});
  const groups=[];let group=[],size=22;
  for(const entry of entries){const cost=entry.bytes.length+76+Buffer.byteLength(entry.name)*2;if(cost+22>maxBytes)throw new Error("单个归档成员超过 Notion 上传限额");if(group.length&&size+cost>maxBytes){groups.push(group);group=[];size=22;}group.push(entry);size+=cost;}if(group.length)groups.push(group);
  const files=[];
  for(let i=0;i<groups.length;i++){const bytes=storedZip(groups[i]);const name=`wolai-${doc.docId}-${key.slice(0,20)}-${i+1}.zip`,path=join(dir,name);await writeFile(path,bytes,{mode:0o600});files.push({name,path,sha256:sha(bytes),bytes:bytes.length});}
  const result={docId:doc.docId,bodyHash:doc.bodyHash,files,mediaCount:media.length,exceptions};await writeJson(join(dir,"manifest.json"),result);return result;
}

export async function writeArchiveMirror({baseDir,doc,blocks,record,parentId,client,catalog,persist}){
  const bundle=await buildArchive({baseDir,doc,blocks,maxBytes:client.maxFileUploadBytes??5242880});
  record.contentFallback={mode:"archive",reason:"notion-content-gateway",sourceBodyHash:doc.bodyHash,files:bundle.files};
  record.pendingWrite={kind:"archive",sourceSignature:doc.signature,bodyHash:doc.bodyHash};record.archiveUploads??={};await persist();
  let page=record.notionPageId?await client.retrievePage(record.notionPageId):null;
  let rows=page?await client.listBlockChildren(page.id):[];
  const fileBlocks=[];
  for(const file of bundle.files){
    if(rows.some(b=>b.type==="file"&&b.file.name===file.name))continue;
    let upload=record.archiveUploads[file.name];
    if(!upload||Date.now()-Date.parse(upload.at)>45*60000){upload={id:await client.uploadBytes(await readFile(file.path),file.name,"application/zip"),at:new Date().toISOString()};record.archiveUploads[file.name]=upload;await persist();}
    fileBlocks.push({object:"block",type:"file",file:{type:"file_upload",file_upload:{id:upload.id},name:file.name,caption:richText("原文与图片存档；多包请解压到同一目录")}});
  }
  const message="此页正文通过接口写入时被内容网关拦截，已改为原文和图片附件存档。没有改写代码或降低图片质量。后续版本仍会同步到这里；若有历史内联正文，以最新附件为准。"+(bundle.exceptions.length?` 其中 ${bundle.exceptions.length} 个超限原件仅保留来源链接，详见包内 manifest.json。`:"");
  if(!page){
    record.pendingCreateAt=new Date().toISOString();await persist();
    page=await client.createPageBlocks(parentId,doc.title,[{object:"block",type:"quote",quote:{rich_text:richText(sourceHeader(doc))}},{object:"block",type:"paragraph",paragraph:{rich_text:richText(message)}},...fileBlocks]);
    record.notionPageId=page.id;record.targetTitle=doc.title;record.status="partial";catalog.put(page);await persist();
  }else{
    if(fileBlocks.length)await client.appendBlocks(page.id,fileBlocks);
    const first=rows[0];
    if(!first||sourceMarker(plainText(first[first.type]?.rich_text))?.docId!==doc.docId)throw new Error("归档页来源标识不匹配");
    await client.request("PATCH",`/blocks/${first.id}`,{retryable:false,body:{[first.type]:{rich_text:richText(sourceHeader(doc))}}});
  }
  rows=await client.listBlockChildren(page.id);
  for(const file of bundle.files){
    const matches=rows.filter(b=>b.type==="file"&&b.file.name===file.name);
    if(matches.length!==1)throw new Error("归档附件无法唯一定位");
    const actual=await client.hashRemoteFile(matches[0].file.file?.url??matches[0].file.external?.url);
    if(actual.sha256!==file.sha256)throw new Error("归档附件字节校验失败");
  }
  if(normalizeId(page.parent?.page_id)!==normalizeId(parentId))await client.movePage(page.id,parentId);
  const title=plainText(Object.values(page.properties??{}).find(p=>p.type==="title")?.title);
  if(title!==doc.title)await client.updateTitle(page.id,doc.title);
  const verified=await client.retrievePage(page.id),md=await client.retrievePageMarkdown(page.id),marker=sourceMarker(md.markdown);
  if(normalizeId(verified.parent?.page_id)!==normalizeId(parentId)||marker?.docId!==doc.docId||marker.version!==String(doc.version)||marker.contentHash!==doc.bodyHash||md.truncated)throw new Error("归档页面最终验证失败");
  Object.assign(record,{title:doc.title,sourceVersion:doc.version,sourceEditedAt:doc.editedAt,sourceSignature:doc.signature,sourceBodyHash:doc.bodyHash,notionParentId:parentId,parentDocId:doc.parentDocId,depth:doc.depth,hierarchyVersion:2,targetTitle:doc.title,status:"synced_with_exceptions",lastSyncedAt:new Date().toISOString(),lastNotionBodyHash:bodyFingerprint(md.markdown),pendingWrite:null,pendingCreateAt:null,lastError:null,assetCount:0,archivedAssetCount:bundle.mediaCount,mediaExceptions:bundle.exceptions,formatWarnings:["content-archived-not-inline"],retryAssets:false});
  catalog.put(verified);await persist();return {pageId:page.id,archives:bundle.files.length};
}
