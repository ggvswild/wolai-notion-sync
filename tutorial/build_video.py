"""Build a narrated walkthrough from redacted captures and labelled diagrams.

Optional tutorial tooling only; not required by the sync CLI. Uses pre-generated
Fun-CosyVoice3 narration, already-redacted frames, Pillow and imageio-ffmpeg.
"""
import argparse
import json
import math
import subprocess
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
BG, INK, MUTED, BLUE = '#f3f5f8', '#152235', '#627185', '#245bce'
FONT_PATH = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
FONT = lambda size: ImageFont.truetype(FONT_PATH, size)

SCENES = [
    dict(title='Wolai → Notion：从配置到同步', badge='中文讲解 · 真实截图 + 示意', kind='intro',
         lines=['准备 2 个 Token + 2 个页面 ID', 'Wolai MCP Token → 读取来源', 'Notion Token → 写入你的目标目录'],
         voice='这段视频带你准备我来和 Notion 的凭证，配置同步工具，再交给 AI agent 执行。真实菜单画面已经裁切脱敏，其余步骤标注为示意。本次演示没有生成新密钥，也没有修改账号权限。'),
    dict(title='01  在 Wolai 打开个人设置', badge='真实菜单截图 · 已裁切', kind='wolai-menu',
         lines=['左上角「更多操作」', '选择「个人设置」', '然后进入「MCP 接入」'],
         voice='先打开我来桌面客户端。点击左上角的更多操作，选择个人设置，然后进入 MCP 接入。这里需要的是 MCP Token，不是旧开放平台的 App ID 或 App Secret。'),
    dict(title='02  创建自己的 Wolai MCP Token', badge='真实设置截图 · 已脱敏', kind='wolai-mcp',
         lines=['在自己的账号中点击「创建 Token」', '按页面提示保存凭证', '项目变量：WOLAI_MCP_TOKEN'],
         voice='在 MCP 接入页，找到创建 Token。请在你自己的账号中完成创建并安全保存。视频中的空间信息和已有密钥列表已经移除。这个项目直接连接 MCP 服务，不要求你另行配置 AI 客户端的 MCP 插件。'),
    dict(title='03  Notion：个人脚本可使用 PAT', badge='操作示意 · 官方文档核对', kind='pat',
         lines=['Developer portal → Personal access tokens', 'New token → 选择目标工作空间', '启用 Notion API，并选择有效期', 'Create token 后立即安全保存'],
         voice='进入 Notion 开发者门户，打开个人访问令牌，选择新建。确认工作空间，启用 Notion API 能力并选择有效期。生成后立即保存，因为完整值只会显示一次。将它填入本项目的 NOTION TOKEN 变量。'),
    dict(title='04  另一种选择：内部连接', badge='操作示意 · 按自己的权限选择', kind='connection',
         lines=['Internal connections → 新建连接', 'Configuration → 获取 API Token', '启用读取、插入、更新内容能力', '目标页「⋯」→ Connections → Add connection'],
         voice='如果使用内部连接，在开发者门户创建连接，并从配置页取得 API Token。为它启用读取、插入和更新内容能力，再在目标页面的连接菜单中添加这个连接。PAT 使用你自己的页面权限，不需要这一步。'),
    dict(title='05  指定来源与目标，不同步整个账号', badge='参数示意 · 无真实页面 ID', kind='roots',
         lines=['Wolai：复制要同步的根页面 ID', 'Notion：准备一个空的导出根页面', '复制 Notion 页面链接中的页面 ID', '来源根及全部子页 → 指定目标根下'],
         voice='接着准备两个页面 ID。在我来中选择要同步的根目录，复制页面 ID。Notion 一侧建议新建一个空的导出根页面，再取得它的页面 ID。使用 PAT 时，你本人需要有该目标页面的编辑权限。'),
    dict(title='06  在本地填写 .env', badge='编辑器示意 · 全部为占位内容', kind='env',
         lines=['WOLAI_MCP_TOKEN=••••••••••••', 'NOTION_TOKEN=••••••••••••', '只在自己的本地文件填写真实值', '不要把 Token 发给 AI、Issue 或 Git 仓库'],
         voice='把项目里的点 env example 复制成点 env，用本地编辑器填写两项凭证。画面中的圆点不是可用密钥。不要把真实 Token 发到聊天或提交到仓库。你也可以使用系统环境变量。'),
    dict(title='07  安装依赖并初始化', badge='命令示意 · 替换页面 ID', kind='terminal',
         lines=['npm ci', 'node bin/cli.mjs init', '  --source-root <来源ID> --notion-root <目标ID>', 'init 及其两个参数请作为同一条命令执行'],
         voice='在项目目录安装依赖，然后运行初始化命令，把画面里的来源和目标占位符替换成自己的页面 ID。初始化会建立私人数据目录。已有状态时应核对原配置，不要重新初始化覆盖。'),
    dict(title='08  先检查连接，再看只读计划', badge='命令示意 · 此处不写入 Notion', kind='terminal',
         lines=['node --env-file=.env bin/cli.mjs check --remote', 'node --env-file=.env bin/cli.mjs sync', '确认来源、目标及扫描范围正确', '若使用系统环境变量，省略 --env-file=.env'],
         voice='先执行远端连接检查，再运行不带 apply 的同步命令。它只读取来源并生成计划，不写入 Notion。确认账号、目标目录和扫描范围正确以后，再进入写入步骤。检查失败时先处理本地凭证或页面访问问题。'),
    dict(title='09  分批同步，完成后验收', badge='命令示意 · 未执行真实账号写入', kind='terminal',
         lines=['node --env-file=.env bin/cli.mjs sync --apply', 'node --env-file=.env bin/cli.mjs sync --apply --resume', 'node --env-file=.env bin/cli.mjs verify', '退出码 3：下一批；退出码 2：停止并检查'],
         voice='范围确认后，加 apply 执行写入。正常分批未结束时，用 resume 继续；快照过期或来源变化时重新扫描。正文和目录剩余都为零、导航完成以后，再运行 verify。只有验收通过，才报告本次检查通过。'),
    dict(title='10  交给 AI agent 执行', badge='可复制提示词 · 见项目文档', kind='agent',
         lines=['请阅读 docs/ai-quickstart.md 并按指南执行', '项目：<项目路径>', '来源：<Wolai 根 ID>   目标：<Notion 根 ID>', '凭证已本地配置；不要在对话中显示'],
         voice='更省事的方式，是把项目中 AI 快速使用指南的完整提示词发给 agent，填写路径和两个页面 ID。凭证在本地准备即可。agent 会依次检查、预览、分批同步和验收，出现保护冲突时保留现场。'),
    dict(title='完成前，还要看这些例外', badge='结果判断', kind='outro',
         lines=['超限来源链接、ZIP 原件、整页 ZIP 分开报告', '数据库容器不等于完整数据库记录', '媒体抽样不等于所有媒体字节验收', '完整命令与提示词：README + docs/ai-quickstart.md'],
         voice='最后确认报告里的例外。超限文件可能只保留来源链接，某些原件或整页内容会以 ZIP 保存，数据库容器不代表完整记录已经复制。视频和命令模板都在项目中，实际权限和按钮名称以你当前的客户端为准。'),
]

def wrap(text, font, width):
    rows, line = [], ''
    for c in text:
        if c == '\n' or font.getlength(line + c) > width:
            rows.append(line); line = '' if c == '\n' else c
        else: line += c
    if line: rows.append(line)
    return rows

def text(draw, xy, value, size=26, fill=INK, width=1100, gap=12):
    x,y=xy; font=FONT(size)
    for line in wrap(value,font,width): draw.text((x,y),line,font=font,fill=fill);y+=size+gap
    return y

def badge(draw, xy, label, fill=BLUE):
    x,y=xy; f=FONT(17); width=int(f.getlength(label))+26
    draw.rounded_rectangle((x,y,x+width,y+32),radius=9,fill=fill)
    draw.text((x+13,y+4),label,font=f,fill='white')

def base(scene,index):
    img=Image.new('RGB',(W,H),BG); d=ImageDraw.Draw(img)
    d.rectangle((0,0,W,9),fill=BLUE)
    d.text((48,34),'WOLAI → NOTION',font=FONT(17),fill=MUTED)
    d.text((1140,34),f'{index+1:02d} / {len(SCENES):02d}',font=FONT(17),fill=MUTED)
    text(d,(48,76),scene['title'],38,width=1175)
    badge(d,(48,134),scene['badge'], '#3d6871' if '真实' in scene['badge'] else '#766541')
    d.rounded_rectangle((48,185,1232,604),radius=18,fill='white')
    return img

def render(scene,index,raw):
    img=base(scene,index); d=ImageDraw.Draw(img); kind=scene['kind']
    if kind=='wolai-menu':
        # Only the generic menu is retained. No notebook, account or breadcrumb.
        crop=Image.open(raw/'wolai-mcp.png').convert('RGB').crop((296,122,452,455))
        crop=crop.resize((174,372),Image.Resampling.LANCZOS);img.paste(crop,(113,210))
        d.rounded_rectangle((110,210,290,248),radius=6,outline=BLUE,width=4)
        y=255
        for i,line in enumerate(scene['lines']): y=text(d,(350,y),f'{i+1}. {line}',29,width=810)+24
    elif kind=='wolai-mcp':
        # Whitelist a small UI region. The existing-token list is not retained.
        crop=Image.open(raw/'wolai-settings.png').convert('RGB').crop((628,145,1334,407))
        cd=ImageDraw.Draw(crop);cd.rectangle((0,48,706,88),fill='white')
        cd.text((9,56),'空间信息已遮挡',font=FONT(18),fill=MUTED)
        crop=crop.resize((1059,393),Image.Resampling.LANCZOS);img.paste(crop,(110,195))
        d.rounded_rectangle((989,201,1165,268),radius=9,outline='#d84952',width=5)
        badge(d,(95,544),'在你的账号中创建；本演示未生成 Token','#3d6871')
    elif kind in ['terminal','env','agent']:
        d.rounded_rectangle((74,211,1206,575),radius=14,fill='#17263b')
        for i,c in enumerate(['#e87070','#e7c571','#72c397']):d.ellipse((96+23*i,230,109+23*i,243),fill=c)
        d.text((201,221),'本地命令 / 内容示意',font=FONT(19),fill='#acbcd1')
        y=278
        for line in scene['lines']:
            y=text(d,(99,y),line,25 if len(line)<75 else 22,'#e6eefb',1067,9)+16
    elif kind=='pat':
        d.rounded_rectangle((80,212,651,570),radius=14,fill='#f0f4fb')
        text(d,(103,231),'New token  ·  表单示意',26,width=520)
        for i,(label,value) in enumerate([('Name','Wolai sync'),('Workspace','你的目标工作空间'),('Capability','✓ Notion API'),('Expiration','按你的需要选择')]):
            y=291+i*61;d.text((104,y),label,font=FONT(21),fill=MUTED);d.text((284,y),value,font=FONT(24),fill=INK)
        text(d,(695,237),'Developer portal\n↓\nPersonal access tokens\n↓\nNew token',27,width=490,gap=10)
        badge(d,(696,512),'Token 完整值仅在创建后显示','#b35c36')
    else:
        y=226
        for i,line in enumerate(scene['lines']):
            d.ellipse((82,y+6,112,y+36),fill=BLUE)
            d.text((91,y+6),str(i+1),font=FONT(18),fill='white')
            y=text(d,(136,y),line,29,INK,1030,10)+27
    return img

def split_captions(value, max_chars=40):
    out=[];line=''
    for c in value:
        line+=c
        if len(line)>=max_chars or c in '。！？':out.append(line);line=''
    if line:out.append(line)
    return out

def stamp(seconds):
    ms=round(seconds*1000);h,ms=divmod(ms,3600000);m,ms=divmod(ms,60000);s,ms=divmod(ms,1000)
    return f'{h:02}:{m:02}:{s:02},{ms:03}'

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--audio-dir',type=Path,required=True)
    p.add_argument('--base-frames',type=Path,required=True)
    p.add_argument('--work-dir',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    narration=json.loads((args.audio_dir/'manifest.json').read_text(encoding='utf8'))
    if narration.get('engine')!='Fun-CosyVoice3-0.5B' or narration.get('device')!='cpu' or narration.get('sample_rate')!=24000 or not narration.get('complete'):
        raise RuntimeError('需要已完成的 CPU / 24000 Hz Fun-CosyVoice3 旁白，不使用其他 TTS 回退')
    voices={row['index']:row for row in narration['scenes']}
    if len(voices)!=len(SCENES):raise RuntimeError('旁白章节不完整')
    out=args.output;out.mkdir(parents=True,exist_ok=True)
    work=args.work_dir;work.mkdir(parents=True,exist_ok=True)
    ff=imageio_ffmpeg.get_ffmpeg_exe();clips=[];srt=[];chapters=[];elapsed=0;cueid=0;posters=[]
    for index,scene in enumerate(SCENES):
        voice=voices[index];audio=args.audio_dir/voice['file']
        if voice['text']!=scene['voice'] or not audio.is_file():raise RuntimeError('旁白文本或文件与当前章节不一致')
        duration=math.ceil((voice['seconds']+.65)*12)/12
        # Reuse only previously reviewed redacted frames. Replace their old
        # subtitle band completely; no original screenshots are needed.
        background=Image.open(args.base_frames/f'{index:02}-00.png').convert('RGB')
        if background.size!=(W,H):raise RuntimeError('脱敏底图尺寸不匹配')
        bd=ImageDraw.Draw(background);bd.rectangle((0,611,W,H),fill=BG)
        bd.text((440,34),'Fun-CosyVoice3 · 固定参考声线',font=FONT(17),fill=MUTED)
        cues=[]
        for segment in voice['segments']:
            chunks=split_captions(segment['text']);weights=[len(x) for x in chunks];total=sum(weights);start=segment['start']
            for caption,weight in zip(chunks,weights):
                part=segment['duration']*weight/total;cues.append([start,part,caption]);start+=part
        cues[-1][1]+=duration-voice['seconds']
        frame_entries=[]
        for j,(caption_start,part,caption) in enumerate(cues):
            frame=background.copy();d=ImageDraw.Draw(frame)
            d.rounded_rectangle((42,624,1238,700),radius=12,fill='#152235')
            rows=wrap(caption,FONT(24),1134)
            y=635 if len(rows)>1 else 646
            for row in rows:d.text((64,y),row,font=FONT(24),fill='white');y+=30
            file=work/f'{index:02}-{j:02}.png';frame.save(file)
            frame_entries += [f"file '{file.as_posix()}'",f'duration {part:.6f}']
            cueid+=1;srt += [str(cueid),f'{stamp(elapsed+caption_start)} --> {stamp(elapsed+caption_start+part)}',caption,'']
            if j==0:
                poster=out/f'scene-{index+1:02}.jpg';frame.save(poster,quality=90);posters.append(poster)
        frame_entries.append(f"file '{file.as_posix()}'")
        manifest=work/f'{index:02}-frames.txt';manifest.write_text('\n'.join(frame_entries)+'\n',encoding='utf8')
        clip=work/f'{index:02}.mp4'
        subprocess.run([ff,'-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(manifest),'-i',str(audio),'-t',str(duration),'-vf',f'fps=12,fade=t=in:st=0:d=0.2,fade=t=out:st={duration-.2:.3f}:d=0.2','-af','apad','-c:v','libx264','-preset','veryfast','-crf','21','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-ar','24000','-ac','1','-map_metadata','-1','-movflags','+faststart',str(clip)],check=True)
        clips.append(clip);chapters.append({'start':round(elapsed,3),'duration':duration,'title':scene['title'],'type':scene['badge']});elapsed+=duration
        print(json.dumps({'scene':index+1,'total':len(SCENES),'seconds':round(elapsed,1)},ensure_ascii=False),flush=True)
    manifest=work/'clips.txt';manifest.write_text('\n'.join(f"file '{x.as_posix()}'" for x in clips)+'\n',encoding='utf8')
    video=out/'wolai-notion-setup.zh-CN.mp4'
    subprocess.run([ff,'-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(manifest),'-c','copy','-map_metadata','-1','-movflags','+faststart',str(video)],check=True)
    (out/'wolai-notion-setup.zh-CN.srt').write_text('\n'.join(srt),encoding='utf8')
    (out/'chapters.json').write_text(json.dumps(chapters,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    (out/'narration.txt').write_text('\n\n'.join(s['title']+'\n'+s['voice'] for s in SCENES)+'\n',encoding='utf8')
    (out/'voice-provenance.json').write_text(json.dumps({key:narration[key] for key in ['engine','device','fp16','load_trt','load_vllm','sample_rate','prompt_text','reference_sha256','frontend','offline']},ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    sheet=Image.new('RGB',(1280,math.ceil(len(posters)/3)*240),'#e5e9ef')
    for i,f in enumerate(posters):sheet.paste(Image.open(f).resize((426,240)),((i%3)*426,(i//3)*240))
    sheet.save(out/'contact-sheet.jpg',quality=92)
    print(json.dumps({'output':str(video),'seconds':round(elapsed,3),'bytes':video.stat().st_size,'scenes':len(SCENES)},ensure_ascii=False),flush=True)

if __name__=='__main__':main()
