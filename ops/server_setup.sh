#!/usr/bin/env bash
set -euo pipefail

# Oracle Ubuntu VM bootstrap for fasting-pwa.
APP_ROOT=/opt/fasting-pwa
BACKEND_DIR="$APP_ROOT/backend"
VENV_DIR="$APP_ROOT/.venv"
WEB_ROOT=/var/www/fasting-pwa

sudo apt update
sudo apt install -y python3 python3-venv python3-pip nginx

sudo mkdir -p "$APP_ROOT" "$WEB_ROOT"
sudo chown -R "$USER":"$USER" "$APP_ROOT" "$WEB_ROOT"

# Copy project files into /opt/fasting-pwa before running the next lines.
cd "$APP_ROOT"

python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install --upgrade pip
pip install -r "$BACKEND_DIR/requirements.txt"

sudo cp "$APP_ROOT/ops/fasting-pwa.service" /etc/systemd/system/fasting-pwa.service
sudo cp "$APP_ROOT/ops/nginx-fasting-pwa.conf" /etc/nginx/sites-available/fasting-pwa
sudo ln -sf /etc/nginx/sites-available/fasting-pwa /etc/nginx/sites-enabled/fasting-pwa
sudo rm -f /etc/nginx/sites-enabled/default

sudo systemctl daemon-reload
sudo systemctl enable fasting-pwa
sudo systemctl restart fasting-pwa
sudo nginx -t
sudo systemctl restart nginx

echo "Setup done. Verify: systemctl status fasting-pwa && systemctl status nginx"
