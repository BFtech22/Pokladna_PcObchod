import sys, pathlib
from pypdf import PdfReader
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
for pdf in sorted(src.glob("*.pdf")):
    r = PdfReader(str(pdf))
    parts = []
    for i, p in enumerate(r.pages, 1):
        parts.append(f"\n===== strana {i} =====\n" + (p.extract_text() or ""))
    (out / (pdf.stem + ".txt")).write_text("".join(parts), encoding="utf-8")
    print(pdf.name, len(r.pages))
