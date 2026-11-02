"""Pinned, local-only runtime assets. Downloads are only needed when building."""
from pathlib import Path
import hashlib, io, json, tarfile, urllib.request, zipfile, shutil

ROOT = Path(__file__).resolve().parents[1]
DEPS = ROOT / '.deps'

def fetch(url):
    print('Download:', url, flush=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'KoreanSeoJi-build/0.1'})
    return urllib.request.urlopen(req, timeout=90).read()

def npm(name, version, target):
    if target.exists():
        return
    data = fetch(f'https://registry.npmjs.org/{name}/-/{name}-{version}.tgz')
    target.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive.getmembers():
            if not member.isfile(): continue
            relative = Path(*Path(member.name).parts[1:])
            dest = (target / relative).resolve()
            if not dest.is_relative_to(target.resolve()): raise ValueError('Archive path')
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(archive.extractfile(member).read())

def setup():
    DEPS.mkdir(exist_ok=True)
    sdk = DEPS / 'webview'
    if not sdk.exists():
        data = fetch('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg')
        with zipfile.ZipFile(io.BytesIO(data)) as z: z.extractall(sdk)
    sqlite = DEPS / 'sqlite'
    if not sqlite.exists():
        data = fetch('https://www.sqlite.org/2025/sqlite-amalgamation-3500400.zip')
        sqlite.mkdir()
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for name in z.namelist():
                if name.endswith(('sqlite3.c', 'sqlite3.h')): (sqlite / Path(name).name).write_bytes(z.read(name))
    header = DEPS / 'json' / 'json.hpp'
    if not header.exists():
        header.parent.mkdir(exist_ok=True)
        header.write_bytes(fetch('https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp'))
    npm('pdfjs-dist', '6.5.438', DEPS / 'pdfjs')
    npm('tesseract.js', '6.0.1', DEPS / 'tesseract')
    npm('tesseract.js-core', '6.0.0', DEPS / 'tesseract-core')
    for lang in ('kor', 'eng'):
        model = DEPS / 'models' / f'{lang}.traineddata'
        if not model.exists():
            model.parent.mkdir(exist_ok=True)
            model.write_bytes(fetch(f'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/{lang}.traineddata'))

def resources():
    build = ROOT / 'build'
    ui = build / 'ui'
    ui.mkdir(parents=True, exist_ok=True)
    for p in (ROOT / 'web').rglob('*'):
        if p.is_file():
            out = ui / p.relative_to(ROOT / 'web')
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, out)
    vendor = ui / 'vendor'
    vendor.mkdir(exist_ok=True)
    for f in ('pdf.mjs', 'pdf.worker.mjs'):
        shutil.copy2(DEPS / 'pdfjs' / 'build' / f, vendor / f)
    for folder in ('cmaps', 'standard_fonts', 'wasm', 'iccs'):
        shutil.copytree(DEPS / 'pdfjs' / folder, vendor / folder, dirs_exist_ok=True)
    for name in ('tesseract.min.js', 'worker.min.js'):
        shutil.copy2(DEPS / 'tesseract' / 'dist' / name, vendor / name)
    for name in ('tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm'):
        shutil.copy2(DEPS / 'tesseract-core' / name, vendor / name)
    for p in (DEPS / 'models').glob('*'): shutil.copy2(p, vendor / p.name)
    licenses = ui / 'licenses'
    licenses.mkdir(exist_ok=True)
    if (ROOT/'third_party').exists(): shutil.copytree(ROOT/'third_party',licenses/'third_party',dirs_exist_ok=True)
    if (ROOT/'THIRD_PARTY_NOTICES.md').exists(): shutil.copy2(ROOT/'THIRD_PARTY_NOTICES.md',licenses/'README.md')
    for name, source in [('pdfjs', DEPS/'pdfjs'/'LICENSE'), ('tesseract', DEPS/'tesseract'/'LICENSE.md'), ('json', DEPS/'json'/'json.hpp')]:
        if source.exists():
            if name != 'json': shutil.copy2(source, licenses / (name+'.txt'))
    entries = sorted(p for p in ui.rglob('*') if p.is_file())
    digest = hashlib.sha256()
    lines = ['#include <windows.h>', '1 24 "../src/app.manifest"', '2 ICON "../assets/app.ico"']
    table = []
    for i, p in enumerate(entries, 101):
        rel = p.relative_to(ui).as_posix()
        digest.update(rel.encode()); digest.update(p.read_bytes())
        lines.append(f'{i} RCDATA "ui/{rel}"')
        table.append(f'{{{i}, L"{rel}"}}')
    (build/'resources.rc').write_text('\n'.join(lines), encoding='utf-8')
    (build/'assets.h').write_text('struct Asset { int id; const wchar_t* path; };\nstatic const Asset assets[] = {' + ',\n'.join(table) + '};\nstatic const wchar_t* assetVersion = L"' + digest.hexdigest()[:16] + '";\n', encoding='utf-8')
    print(f'Embedded assets: {len(entries)}, {sum(p.stat().st_size for p in entries)/1024/1024:.1f} MB')

if __name__ == '__main__': setup(); resources()
