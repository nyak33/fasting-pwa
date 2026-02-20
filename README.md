# fasting-pwa

Malaysia-first fasting tracker PWA with local-first IndexedDB logs, FastAPI push scheduler, and Oracle VM deployment templates.

## Project Structure

```text
fasting-pwa/
  backend/
    main.py
    db.py
    scheduler.py
    jakim_calendar.py
    push.py
    requirements.txt
    .env.example
  frontend/
    index.html
    app.js
    sw.js
    manifest.json
  ops/
    server_setup.sh
    fasting-pwa.service
    nginx-fasting-pwa.conf
  README.md
```

## What It Does

- Uses timezone `Asia/Kuala_Lumpur` everywhere.
- Stores only push subscriptions and `last_answered_date` in SQLite.
- Logs fasting answers locally in IndexedDB (local-first).
- Sends check-in push every 10 minutes during these windows until answered:
  - 08:00-11:00
  - 13:00-16:00
  - 17:00-19:30
- Notification deep links open `/?view=checkin&date=YYYY-MM-DD`.
- `?view=checkin` shows a modal with 2 choices.
- Scrapes Ramadan start/end from e-Solat URL and caches backend result.
- Sends summary prompt 72h after the last Ramadan day to open `/?view=summary`.
- `?view=summary` is computed locally from IndexedDB and reminds ganti days.
- Frontend can run under repo subpath for GitHub Pages; service worker registers under subpath scope.

## Backend Setup (Local)

1. Create backend env file:

```bash
cd backend
cp .env.example .env
```

2. Generate VAPID keys and put values in `.env`.

Option A (Node):

```bash
npx web-push generate-vapid-keys
```

3. Install dependencies and run:

```bash
python -m venv .venv
. .venv/Scripts/activate  # Windows PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

## Frontend Setup (Local)

Serve frontend over HTTP (not file://):

```bash
cd frontend
python -m http.server 5500
```

Then open `http://127.0.0.1:5500`.

If needed, set backend URL from browser console:

```js
localStorage.setItem("fastingPwaBackendBase", "http://127.0.0.1:8000");
location.reload();
```

## Oracle VM Deploy (Ubuntu)

1. Copy project to `/opt/fasting-pwa`.
2. Put production `.env` at `/opt/fasting-pwa/backend/.env`.
3. Set `FRONTEND_BASE_URL` in `.env` to your public frontend URL.
4. Run:

```bash
cd /opt/fasting-pwa
bash ops/server_setup.sh
```

5. Copy frontend static files to `/var/www/fasting-pwa/frontend`.

## GitHub Pages Notes

- Publish `frontend/` as the Pages artifact.
- Keep `start_url` and `scope` in `manifest.json` as `./`.
- In `frontend/app.js`, replace `https://REPLACE_WITH_BACKEND_DOMAIN/api` with your backend API base URL.
- Ensure your backend CORS allow list includes your GitHub Pages domain.

## Final Checklist Commands

### Local Run

```bash
cd backend
cp .env.example .env
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000

# new terminal
cd frontend
python -m http.server 5500
```

### Oracle Deploy

```bash
sudo mkdir -p /opt/fasting-pwa
# copy files into /opt/fasting-pwa
cd /opt/fasting-pwa
bash ops/server_setup.sh
sudo systemctl status fasting-pwa
sudo systemctl status nginx
```

### GitHub Pages

```bash
# from repo root containing frontend/
# publish frontend/ to gh-pages (or Actions artifact)
# then set backend base URL in app.js and redeploy
```
