"""Sestaví demo pokladny pro GitHub Pages do složky docs/.

Demo = stejné rozhraní jako pokladna (pokladna/static) + demo/demo.js, které místo serveru
odpovídá přímo v prohlížeči. Spuštění z kořene projektu po každé změně rozhraní:
    .venv/bin/python -I _zdroje/skripty/postav_demo.py
"""

import json
import shutil
from pathlib import Path

KOREN = Path(__file__).resolve().parents[2]
CIL = KOREN / "docs"


def main() -> None:
    if CIL.exists():
        shutil.rmtree(CIL)
    shutil.copytree(KOREN / "pokladna" / "static", CIL / "static", ignore=shutil.ignore_patterns("_test_*", ".DS_Store"))
    index = (CIL / "static" / "index.html").read_text(encoding="utf-8")
    (CIL / "static" / "index.html").unlink()
    index = index.replace('<script src="static/app.js"></script>',
                          '<script src="static/demo.js"></script>\n  <script src="static/app.js"></script>')
    index = index.replace("<title>Pokladna PcObchod</title>", "<title>Pokladna PcObchod – demo</title>")
    assert "static/demo.js" in index, "index.html nemá očekávaný skript app.js"
    (CIL / "index.html").write_text(index, encoding="utf-8")
    shutil.copy2(KOREN / "demo" / "demo.js", CIL / "static" / "demo.js")
    shutil.copy2(KOREN / "_zdroje" / "vzorove_faktury" / "FV2026-0815.isdoc", CIL / "vzorova_faktura.isdoc")
    (CIL / "manifest.webmanifest").write_text(json.dumps({
        "name": "Pokladna PcObchod – demo", "short_name": "Pokladna demo", "start_url": "./", "display": "standalone",
        "background_color": "#ffffff", "theme_color": "#d9302a", "lang": "cs",
        "icons": [{"src": "static/img/favicon-192.png", "sizes": "192x192", "type": "image/png"}],
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    (CIL / ".nojekyll").write_text("")
    print("Demo sestaveno:", ", ".join(sorted(str(p.relative_to(CIL)) for p in CIL.rglob("*") if p.is_file())))


if __name__ == "__main__":
    main()
