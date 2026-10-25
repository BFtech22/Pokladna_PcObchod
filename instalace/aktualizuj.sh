#!/bin/sh
# Aktualizace pokladny na novou verzi: sudo sh instalace/aktualizuj.sh
# Spouští se ze složky s novou verzí. Před aktualizací se udělá záloha, data zůstanou.
set -eu
[ "$(id -u)" = "0" ] || { echo "Spusťte jako root: sudo sh instalace/aktualizuj.sh"; exit 1; }
exec sh "$(dirname "$0")/instaluj.sh" "$@"
