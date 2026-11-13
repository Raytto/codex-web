#!/usr/bin/env python3
"""Copy only a checked process manifest into a new immutable package directory."""
import argparse,hashlib,json,os,shutil
from pathlib import Path

def prepare(source,target,manifest,check=False):
    data=json.loads(manifest.read_text())
    if data.get('schema')!='codex-web-process-package-v1' or data.get('profile') not in ('host','observer'): raise ValueError('unknown process manifest')
    if not check and target.exists(): raise ValueError('target must not exist')
    for name,item in data['files'].items():
        rel=Path(name)
        if rel.is_absolute() or '..' in rel.parts: raise ValueError('unsafe member')
        p=source/rel
        if 'link' in item:
            if not p.is_symlink() or os.readlink(p)!=item['link'] or not p.resolve().is_relative_to(source.resolve()): raise ValueError('invalid package link')
        elif p.is_symlink() or not p.is_file() or p.stat().st_size!=item['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:
            raise ValueError('package member mismatch: '+name)
    for entry in data['entries']:
        if entry not in data['files']: raise ValueError('missing process entry')
    if check:return {'ok':True,'profile':data['profile'],'files':len(data['files'])}
    target.mkdir(mode=0o700,parents=True)
    try:
        for name,item in data['files'].items():
            p=target/name;p.parent.mkdir(parents=True,exist_ok=True)
            if 'link' in item:p.symlink_to(item['link'])
            else:shutil.copyfile(source/name,p);p.chmod(item['mode'])
        (target/'package.json').write_text('{"private":true,"type":"module"}\n')
        shutil.copyfile(manifest,target/'process-manifest.json')
    except BaseException:
        shutil.rmtree(target);raise
    return {'profile':data['profile'],'files':len(data['files']),'bytes':sum(f.get('bytes',0) for f in data['files'].values())}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--target',type=Path,default=Path('/unused'));p.add_argument('--check',action='store_true');p.add_argument('--manifest',type=Path,required=True);a=p.parse_args();print(json.dumps(prepare(a.source,a.target,a.manifest,a.check)))
