# Third-party components

KoreanSeoJi includes the following components. The original notices and license texts are distributed in `third_party/` and, for PDF.js fonts and WebAssembly modules, in embedded runtime asset folders.

| Component | Version | License / source |
| --- | --- | --- |
| Microsoft WebView2 SDK / static loader | 1.0.4314.35 | Microsoft WebView2 SDK terms; `third_party/WebView2-LICENSE.txt` |
| SQLite | 3.50.4 | [Public domain](https://www.sqlite.org/copyright.html) |
| nlohmann/json | 3.12.0 | MIT; `third_party/json-LICENSE.MIT` |
| PDF.js | 6.5.438 | Apache-2.0; `third_party/pdfjs-LICENSE.txt` |
| Tesseract.js | 6.0.1 | Apache-2.0; `third_party/tesseract-LICENSE.txt` |
| tesseract.js-core | 6.0.0 | Apache-2.0; `third_party/tesseract-core-LICENSE.txt` |
| Tesseract tessdata_fast, kor / eng | 4.1.0 | Apache-2.0; `third_party/tessdata-LICENSE.txt` |
| PDF.js standard fonts, image decoders and WASM modules | bundled | Their corresponding notices in `third_party/pdfjs/` and embedded `vendor/` folders |

The application uses a separately installed Microsoft Edge WebView2 Runtime. The Runtime is not included in the portable executable. Runtime distribution and servicing are governed by Microsoft's terms.

Development-only: Playwright Core 1.56.1 (Apache-2.0); PyMuPDF for locally generated synthetic test fixtures. Neither is included in the application. Korean Windows fonts used to generate local test fixtures are not distributed with the application.
