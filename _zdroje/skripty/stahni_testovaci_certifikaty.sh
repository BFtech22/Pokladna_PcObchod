#!/bin/sh
# Stáhne veřejné testovací certifikáty finanční správy pro Playground EET 2.0
# a rozbalí je tam, kde je pokladna hledá. Spouštět z kořene projektu.
set -e
CIL="_zdroje/eet2_dokumentace"
mkdir -p "$CIL/certs_playground"
curl -fsSL -o "$CIL/CAEET_Playground_2026_v1.zip" \
  "https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/CAEET_Playground_2026_v1.zip"
unzip -o -q "$CIL/CAEET_Playground_2026_v1.zip" -d "$CIL/certs_playground"
ls "$CIL/certs_playground"
