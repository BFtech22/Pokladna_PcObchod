#!/bin/sh
# Instalace pokladny na server v prodejně (Debian 12+, Ubuntu 24.04+, Raspberry Pi OS 64bit).
#
#   sudo sh instalace/instaluj.sh [--nazev pokladna-rumburk]
#
# Spouští se ze složky s pokladnou (zkopírovaná z USB, scp nebo git clone). Skript:
#   - nainstaluje Python, rclone, avahi (adresa <název>.local) a automatické bezpečnostní aktualizace,
#   - nastaví časové pásmo Europe/Prague a synchronizaci času (EET),
#   - zkopíruje aplikaci do /opt/pokladna, data dá do /var/lib/pokladna,
#   - založí systémového uživatele „pokladna“ a službu pokladna.service (port 80, start po zapnutí).
# Opakované spuštění je bezpečné: data se nemažou, aplikace se jen přepíše novou verzí.
set -eu

NAZEV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --nazev) NAZEV="$2"; shift 2 ;;
    *) echo "Neznámý parametr: $1"; exit 1 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "Spusťte jako root: sudo sh instalace/instaluj.sh"; exit 1; }
ZDROJ=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ZDROJ/pokladna/server.py" ] || { echo "Nenašel jsem aplikaci ve $ZDROJ"; exit 1; }

APP=/opt/pokladna
DATA=/var/lib/pokladna
UZIV=pokladna

echo "==> Balíčky"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q python3 python3-venv python3-pip rclone avahi-daemon unattended-upgrades ca-certificates curl unzip fonts-dejavu-core

echo "==> Čas a název"
timedatectl set-timezone Europe/Prague
timedatectl set-ntp true || true
if [ -n "$NAZEV" ]; then
  hostnamectl set-hostname "$NAZEV"
  grep -q "127.0.1.1" /etc/hosts && sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$NAZEV/" /etc/hosts || echo "127.0.1.1	$NAZEV" >> /etc/hosts
fi
systemctl enable --now avahi-daemon >/dev/null 2>&1 || true

echo "==> Uživatel a složky"
id "$UZIV" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin "$UZIV"
mkdir -p "$DATA"
chown "$UZIV:$UZIV" "$DATA"
chmod 750 "$DATA"

echo "==> Aplikace do $APP"
if systemctl is-active --quiet pokladna 2>/dev/null; then
  echo "    záloha před aktualizací"
  ( cd "$APP" && runuser -u "$UZIV" -- env POKLADNA_DB="$DATA/pokladna.sqlite" RCLONE_CONFIG="$DATA/rclone.conf" \
    "$APP/.venv/bin/python" -m pokladna.zaloha ) || echo "    (záloha se nepovedla, pokračuji)"
fi
mkdir -p "$APP"
# Zkopíruje kód, ale ne vývojová data, prostředí ani certifikáty.
( cd "$ZDROJ" && tar --exclude=./.venv --exclude=./data --exclude=./.git --exclude=./eet/log \
    --exclude='*.p12' --exclude='__pycache__' -cf - . ) | ( cd "$APP" && tar -xf - )
[ -d "$APP/.venv" ] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --upgrade pip
"$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt"
# Veřejné testovací certifikáty finanční správy – pokladna po instalaci jede v testovacím režimu EET.
( cd "$APP" && sh _zdroje/skripty/stahni_testovaci_certifikaty.sh >/dev/null ) || echo "    (testovací certifikáty se nestáhly)"
chown -R root:root "$APP"
chmod -R go-w "$APP"

echo "==> Služba"
install -m 644 "$APP/instalace/pokladna.service" /etc/systemd/system/pokladna.service
systemctl daemon-reload
systemctl enable pokladna >/dev/null
systemctl restart pokladna

echo "==> Kontrola"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null http://127.0.0.1/api/stav; then OK=1; break; fi
  sleep 1
done
if [ "${OK:-0}" = "1" ]; then
  ADRESA=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo ""
  echo "Hotovo. Pokladna běží na:"
  echo "  http://$(hostname).local    (v síti prodejny)"
  [ -n "$ADRESA" ] && echo "  http://$ADRESA"
  echo "Další kroky jsou v instalace/README.md (správce, EET certifikát, záloha)."
else
  echo "Služba nenaběhla. Výpis: journalctl -u pokladna -n 50"
  exit 1
fi
