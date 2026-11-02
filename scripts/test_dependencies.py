from pathlib import Path
from dependencies import npm, DEPS
DEPS.mkdir(exist_ok=True)
npm('playwright-core','1.56.1',DEPS/'playwright')
print('Test-only Playwright ready. No browser installation is needed.')
