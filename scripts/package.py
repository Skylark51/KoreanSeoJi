from pathlib import Path
import hashlib, zipfile, shutil
ROOT=Path(__file__).resolve().parents[1]
exe=ROOT/'dist/KoreanSeoJi.exe'
if not exe.exists(): raise SystemExit('Build the executable first.')
archive=ROOT/'dist/KoreanSeoJi-portable-v0.3.1-win-x64.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    z.write(exe,exe.name)
    z.write(ROOT/'README.md','사용안내.md')
    z.write(ROOT/'THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.md')
    z.write(ROOT/'docs/study-preview.png','docs/study-preview.png')
    for p in (ROOT/'third_party').rglob('*'):
        if p.is_file():z.write(p,p.relative_to(ROOT))
shutil.copy2(ROOT/'README.md',ROOT/'dist/사용안내.md')
(ROOT/'dist/docs').mkdir(exist_ok=True)
shutil.copy2(ROOT/'docs/study-preview.png',ROOT/'dist/docs/study-preview.png')
(ROOT/'dist/SHA256SUMS.txt').write_text('\n'.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name for p in [exe,archive])+'\n',encoding='utf-8')
print(archive)
print(f'Executable: {exe.stat().st_size/1024/1024:.1f} MiB; ZIP: {archive.stat().st_size/1024/1024:.1f} MiB')
