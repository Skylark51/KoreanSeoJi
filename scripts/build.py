"""Build through an ASCII junction: CMake's VS linker wrapper mishandles Korean paths."""
from pathlib import Path
import hashlib, os, subprocess, sys
from dependencies import ROOT, setup, resources

setup()
resources()
vswhere=Path(os.environ['ProgramFiles(x86)'])/'Microsoft Visual Studio/Installer/vswhere.exe'
vs=subprocess.check_output([str(vswhere),'-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],text=True).strip()
if not vs: raise SystemExit('Install Visual Studio Build Tools: Desktop development with C++.')
tag=hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
base=Path(os.environ['LOCALAPPDATA'])/'KoreanSeoJi-build'/tag
base.mkdir(parents=True,exist_ok=True)
alias=base/'source'
if not alias.exists(): subprocess.run(['cmd','/c','mklink','/J',str(alias),str(ROOT)],check=True)
if alias.resolve()!=ROOT: raise SystemExit('Build junction points to a different folder.')
batch=base/'compile.cmd'
batch.write_text(f'''@echo off
set VSLANG=1033
call "{vs}\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cmake -S "{alias}" -B "{alias}\\build\\native" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release
if errorlevel 1 exit /b 1
cmake --build "{alias}\\build\\native"
exit /b %errorlevel%
''',encoding='utf-8')
result=subprocess.run(['cmd','/c',str(batch)],cwd=alias)
if result.returncode: raise SystemExit(result.returncode)
print('Built:',ROOT/'dist/KoreanSeoJi.exe')
