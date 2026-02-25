#!/usr/bin/env bash
set -euo pipefail

# Oracle Ubuntu VM bootstrap for fasting-pwa.
APP_ROOT=/opt/fasting-pwa
BACKEND_DIR="$APP_ROOT/backend"
VENV_DIR="$APP_ROOT/.venv"
WEB_ROOT=/var/www/fasting-pwa
WEB_FRONTEND_DIR="$WEB_ROOT/frontend"

DOMAIN_ROOT="${DOMAIN_ROOT:-syaqirshaq.online}"
WWW_DOMAIN="${WWW_DOMAIN:-www.syaqirshaq.online}"
API_DOMAIN="${API_DOMAIN:-api.syaqirshaq.online}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

sudo apt update
sudo apt install -y python3 python3-venv python3-pip nginx certbot python3-certbot-nginx rsync

sudo mkdir -p "$APP_ROOT" "$WEB_FRONTEND_DIR"
sudo chown -R "$USER":"$USER" "$APP_ROOT" "$WEB_ROOT"

# Copy project files into /opt/fasting-pwa before running this script.
cd "$APP_ROOT"

python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install --upgrade pip
pip install -r "$BACKEND_DIR/requirements.txt"

# Publish frontend static files to nginx web root.
rsync -a --delete "$APP_ROOT/frontend/" "$WEB_FRONTEND_DIR/"

sudo cp "$APP_ROOT/ops/fasting-pwa.service" /etc/systemd/system/fasting-pwa.service
sudo cp "$APP_ROOT/ops/nginx-fasting-pwa.conf" /etc/nginx/sites-available/fasting-pwa
sudo ln -sf /etc/nginx/sites-available/fasting-pwa /etc/nginx/sites-enabled/fasting-pwa
sudo rm -f /etc/nginx/sites-enabled/default
sudo sed -i "s/^User=.*/User=$USER/" /etc/systemd/system/fasting-pwa.service
sudo sed -i "s/^Group=.*/Group=$USER/" /etc/systemd/system/fasting-pwa.service

sudo systemctl daemon-reload
sudo systemctl enable fasting-pwa
sudo systemctl restart fasting-pwa
sudo nginx -t
sudo systemctl restart nginx

if [[ -n "$CERTBOT_EMAIL" ]]; then
  sudo certbot --nginx --non-interactive --agree-tos --email "$CERTBOT_EMAIL" \
    --cert-name "$API_DOMAIN" --expand \
    -d "$API_DOMAIN" -d "$DOMAIN_ROOT" -d "$WWW_DOMAIN" --redirect
else
  echo "CERTBOT_EMAIL is not set. Skipping TLS provisioning."
  echo "Run certbot manually when DNS propagation is complete."
fi

echo "Setup done. Verify: systemctl status fasting-pwa && systemctl status nginx"
