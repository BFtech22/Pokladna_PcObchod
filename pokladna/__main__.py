"""Spuštění: python -m pokladna [--port 8080] [--host 0.0.0.0]"""

import argparse
import logging

import uvicorn


def main() -> None:
    ap = argparse.ArgumentParser(description="Pokladna PcObchod")
    ap.add_argument("--host", default="0.0.0.0", help="adresa (0.0.0.0 = dostupné z celé sítě prodejny)")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run("pokladna.server:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
