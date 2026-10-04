"""Generate narration with an already-installed Fun-CosyVoice3, fully offline.

Run from the CosyVoice checkout using its existing Python environment. No model
or frontend package is installed or modified. Output WAVs use the model rate.
"""
import argparse
import ast
import hashlib
import importlib
import json
import os
import socket
import sys
import time
from pathlib import Path

PROMPT_TEXT = 'You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。'

def read_scenes(source):
    tree = ast.parse(source.read_text(encoding='utf8'))
    value = next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'SCENES' for t in node.targets))
    return [{kw.arg: ast.literal_eval(kw.value) for kw in item.keywords} for item in value.elts]

def write_manifest(file, value):
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    temp.replace(file)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scenes', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--threads', type=int, default=12)
    args = parser.parse_args()
    repo = Path.cwd()
    model_dir = Path('pretrained_models/Fun-CosyVoice3-0.5B')
    prompt_wav = Path('asset/zero_shot_prompt.wav')
    if not (repo/'cosyvoice/cli/cosyvoice.py').is_file() or not (repo/'third_party/Matcha-TTS').is_dir():
        raise RuntimeError('必须从已有 CosyVoice 仓库目录运行')
    for name in ['cosyvoice3.yaml','llm.pt','flow.pt','hift.pt','campplus.onnx','speech_tokenizer_v3.onnx']:
        if not (model_dir/name).is_file(): raise RuntimeError('本地权重不完整，停止；不自动下载')
    if not prompt_wav.is_file(): raise RuntimeError('固定参考音缺失')
    sys.path.insert(0, str(repo))
    sys.path.insert(0, str(repo/'third_party/Matcha-TTS'))
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    # Network is blocked in this process. Local cache reads remain available.
    original_connect = socket.socket.connect
    def offline_connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6): raise OSError('Offline narration: network access disabled')
        return original_connect(sock, address)
    socket.socket.connect = offline_connect
    import modelscope
    hub = importlib.import_module('modelscope.hub.snapshot_download')
    snapshot = hub.snapshot_download
    def local_snapshot(*positional, **options):
        options['local_files_only'] = True
        return snapshot(*positional, **options)
    modelscope.snapshot_download = local_snapshot
    hub.snapshot_download = local_snapshot
    import torch
    import torchaudio
    from cosyvoice.cli.cosyvoice import AutoModel
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    cosyvoice = AutoModel(model_dir=str(model_dir), load_trt=False, load_vllm=False, fp16=False)
    if cosyvoice.model.device.type != 'cpu' or cosyvoice.fp16: raise RuntimeError('要求 CPU / FP32')
    if cosyvoice.sample_rate != 24000: raise RuntimeError('采样率与已验证环境不同，请检查')
    scenes = read_scenes(args.scenes)
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256(prompt_wav.read_bytes()).hexdigest()
    manifest = {'engine':'Fun-CosyVoice3-0.5B','device':'cpu','fp16':False,'load_trt':False,'load_vllm':False,'sample_rate':cosyvoice.sample_rate,'prompt_text':PROMPT_TEXT,'reference_sha256':fingerprint,'frontend':cosyvoice.frontend.text_frontend or 'unavailable-basic-text','offline':True,'scenes':[]}
    manifest_file = out/'manifest.json'
    if manifest_file.exists():
        previous = json.loads(manifest_file.read_text())
        if previous.get('reference_sha256') == fingerprint and previous.get('prompt_text') == PROMPT_TEXT:
            manifest['scenes'] = previous.get('scenes', [])
    completed = {s['index']:s for s in manifest['scenes']}
    print(json.dumps({'phase':'model-ready','device':'cpu','sample_rate':cosyvoice.sample_rate,'frontend':manifest['frontend'],'total':len(scenes)}),flush=True)
    for index, scene in enumerate(scenes):
        text = scene['voice']; text_hash = hashlib.sha256(text.encode()).hexdigest()
        old = completed.get(index)
        if old and old.get('text_sha256') == text_hash and (out/old['file']).is_file():
            print(json.dumps({'phase':'reused','scene':index+1}),flush=True);continue
        started = time.monotonic(); torch.manual_seed(1986+index)
        normalized = cosyvoice.frontend.text_normalize(text, split=True)
        speech_parts = []; segments = []; offset = 0
        print(json.dumps({'phase':'synthesizing','scene':index+1,'total':len(scenes)},ensure_ascii=False),flush=True)
        with torch.inference_mode():
            for number, result in enumerate(cosyvoice.inference_zero_shot(text, PROMPT_TEXT, str(prompt_wav), stream=False)):
                speech = result['tts_speech'].detach().cpu()
                if not torch.isfinite(speech).all() or not speech.numel(): raise RuntimeError('合成音频为空或包含异常值')
                seconds = speech.shape[-1]/cosyvoice.sample_rate
                speech_parts.append(speech)
                segments.append({'start':offset,'duration':seconds,'text':normalized[number] if number<len(normalized) else text})
                offset += seconds
        if len(speech_parts) != len(normalized): raise RuntimeError('语音分段与字幕文本数量不一致')
        speech = torch.cat(speech_parts, dim=-1)
        file = f'{index:02d}.wav'
        torchaudio.save(str(out/file), speech, cosyvoice.sample_rate)
        row = {'index':index,'title':scene['title'],'text':text,'text_sha256':text_hash,'file':file,'seconds':offset,'segments':segments,'wall_seconds':round(time.monotonic()-started,2),'peak':float(speech.abs().max()),'rms':float(speech.square().mean().sqrt())}
        completed[index] = row; manifest['scenes'] = [completed[k] for k in sorted(completed)]
        write_manifest(manifest_file, manifest)
        print(json.dumps({'phase':'saved','scene':index+1,'total':len(scenes),'seconds':round(offset,2),'wall_seconds':row['wall_seconds']},ensure_ascii=False),flush=True)
    manifest['complete'] = len(completed) == len(scenes)
    write_manifest(manifest_file, manifest)
    print(json.dumps({'phase':'complete','chapters':len(completed),'audio_seconds':round(sum(s['seconds'] for s in manifest['scenes']),2)},ensure_ascii=False),flush=True)

if __name__ == '__main__': main()
