# Version History
# v1.0 - Initial FastAPI backend with subscriptions, check-ins, and scheduler wiring.
# v1.1 - Google login auth with account-linked subscriptions and check-ins.

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel, Field

from db import (
    create_session,
    delete_session,
    get_user,
    get_user_by_session,
    init_db,
    update_notification_settings_for_user,
    update_last_answered_date_for_user,
    upsert_subscription,
    upsert_user,
)
from jakim_calendar import get_cached_ramadan_window
from prayer_times import get_prayer_times_window
from scheduler import build_scheduler

load_dotenv()

TIMEZONE = ZoneInfo("Asia/Kuala_Lumpur")
VALID_PRAYER_KEYS = {"imsak", "fajr", "sunrise", "dhuhr", "asr", "sunset", "maghrib", "isha"}
DEFAULT_REMINDER_SLOTS = [
    {"type": "fixed", "time": "09:00"},
    {"type": "fixed", "time": "13:30"},
    {"type": "fixed", "time": "18:00"},
]


@dataclass(frozen=True)
class Settings:
    vapid_public_key: str
    vapid_private_key: str
    vapid_subject: str
    frontend_base_url: str
    prayer_zone: str
    prayer_location: str
    prayer_city: str
    prayer_country: str
    prayer_method: int
    google_client_id: str
    session_ttl_days: int


def get_settings() -> Settings:
    public = os.getenv("VAPID_PUBLIC_KEY", "")
    private = os.getenv("VAPID_PRIVATE_KEY", "")
    subject = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com")
    frontend = os.getenv("FRONTEND_BASE_URL", "http://localhost:5500")
    prayer_zone = os.getenv("PRAYER_ZONE", "SGR01")
    prayer_location = os.getenv(
        "PRAYER_LOCATION",
        "Taman Pinggiran Putra, Seri Kembangan, Selangor",
    )
    prayer_city = os.getenv("PRAYER_CITY", "Seri Kembangan")
    prayer_country = os.getenv("PRAYER_COUNTRY", "Malaysia")
    prayer_method = int(os.getenv("PRAYER_METHOD", "11"))
    google_client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    session_ttl_days = int(os.getenv("SESSION_TTL_DAYS", "30"))

    if not public or not private:
        raise RuntimeError("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set.")
    if not google_client_id:
        raise RuntimeError("GOOGLE_CLIENT_ID must be set.")

    return Settings(
        vapid_public_key=public,
        vapid_private_key=private,
        vapid_subject=subject,
        frontend_base_url=frontend.rstrip("/"),
        prayer_zone=prayer_zone,
        prayer_location=prayer_location,
        prayer_city=prayer_city,
        prayer_country=prayer_country,
        prayer_method=prayer_method,
        google_client_id=google_client_id,
        session_ttl_days=session_ttl_days,
    )


settings = get_settings()
google_request = google_requests.Request()
app = FastAPI(title="fasting-pwa-backend")

raw_origins = os.getenv("CORS_ORIGINS", "*")
allow_origins = [item.strip() for item in raw_origins.split(",") if item.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

scheduler = None


class SubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class SubscriptionPayload(BaseModel):
    endpoint: str
    keys: SubscriptionKeys


class SubscribeRequest(BaseModel):
    subscription: SubscriptionPayload


class CheckInRequest(BaseModel):
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    status: str = Field(..., pattern=r"^(fasting|not_fasting)$")


class GoogleAuthRequest(BaseModel):
    credential: str = Field(..., min_length=20)


class NotificationSettingsRequest(BaseModel):
    slots: list[dict] = Field(default_factory=list)


def _parse_hhmm(value: str) -> str | None:
    try:
        token = (value or "").strip()
        hh, mm = token.split(":")
        hour = int(hh)
        minute = int(mm)
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return f"{hour:02d}:{minute:02d}"
    except Exception:
        return None
    return None


def _normalize_notification_slots(raw_slots: object) -> list[dict]:
    if not isinstance(raw_slots, list):
        return DEFAULT_REMINDER_SLOTS

    out: list[dict] = []
    for item in raw_slots[:3]:
        if not isinstance(item, dict):
            continue

        slot_type = str(item.get("type") or "").strip().lower()
        if slot_type == "fixed":
            hhmm = _parse_hhmm(str(item.get("time") or ""))
            if hhmm:
                out.append({"type": "fixed", "time": hhmm})
            continue

        if slot_type == "prayer":
            prayer = str(item.get("prayer") or "").strip().lower()
            if prayer not in VALID_PRAYER_KEYS:
                continue
            try:
                offset = int(item.get("offset_minutes", 0))
            except (TypeError, ValueError):
                offset = 0
            offset = max(-180, min(180, offset))
            out.append({"type": "prayer", "prayer": prayer, "offset_minutes": offset})

    return out if out else DEFAULT_REMINDER_SLOTS


def _load_notification_slots(settings_json: str | None) -> list[dict]:
    if not settings_json:
        return DEFAULT_REMINDER_SLOTS
    try:
        parsed = json.loads(settings_json)
    except Exception:
        return DEFAULT_REMINDER_SLOTS
    slots = parsed.get("slots") if isinstance(parsed, dict) else None
    return _normalize_notification_slots(slots)


def _verify_google_credential(credential: str) -> dict:
    try:
        payload = google_id_token.verify_oauth2_token(
            credential,
            google_request,
            settings.google_client_id,
        )
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid Google credential") from exc

    google_sub = payload.get("sub")
    email = payload.get("email")
    if not google_sub or not email:
        raise HTTPException(status_code=401, detail="Google credential missing sub/email")

    return {
        "google_sub": google_sub,
        "email": email,
        "name": payload.get("name"),
        "picture": payload.get("picture"),
    }


def _extract_bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid Authorization header")

    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return token


def require_user(authorization: str | None = Header(default=None)) -> dict:
    token = _extract_bearer_token(authorization)
    user = get_user_by_session(token)
    if not user:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    user["session_token"] = token
    return user


@app.on_event("startup")
def on_startup() -> None:
    global scheduler
    init_db()
    scheduler = build_scheduler(settings)
    scheduler.start()


@app.on_event("shutdown")
def on_shutdown() -> None:
    if scheduler:
        scheduler.shutdown(wait=False)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/config")
def get_config() -> dict:
    return {
        "timezone": "Asia/Kuala_Lumpur",
        "vapidPublicKey": settings.vapid_public_key,
        "frontendBaseUrl": settings.frontend_base_url,
        "prayerZone": settings.prayer_zone,
        "prayerLocation": settings.prayer_location,
        "prayerCity": settings.prayer_city,
        "prayerCountry": settings.prayer_country,
        "googleClientId": settings.google_client_id,
        "authRequired": True,
    }


@app.get("/ramadan-window")
def ramadan_window() -> dict:
    return get_cached_ramadan_window(TIMEZONE)


@app.get("/prayer-times")
def prayer_times(days: int = Query(default=30, ge=1, le=60)) -> dict:
    payload = get_prayer_times_window(
        timezone=TIMEZONE,
        zone=settings.prayer_zone,
        days=days,
        city=settings.prayer_city,
        country=settings.prayer_country,
        method=settings.prayer_method,
    )
    payload["location"] = settings.prayer_location
    return payload


@app.post("/auth/google")
def auth_google(payload: GoogleAuthRequest) -> dict:
    verified = _verify_google_credential(payload.credential)
    upsert_user(verified)
    session = create_session(verified["google_sub"], ttl_days=settings.session_ttl_days)
    user = get_user(verified["google_sub"]) or verified

    return {
        "ok": True,
        "sessionToken": session["token"],
        "expiresAt": session["expires_at"],
        "user": {
            "googleSub": user["google_sub"],
            "email": user["email"],
            "name": user.get("name"),
            "picture": user.get("picture"),
            "lastAnsweredDate": user.get("last_answered_date"),
        },
    }


@app.post("/auth/logout")
def auth_logout(user: dict = Depends(require_user)) -> dict:
    delete_session(user["session_token"])
    return {"ok": True}


@app.get("/me")
def me(user: dict = Depends(require_user)) -> dict:
    notification_slots = _load_notification_slots(user.get("notification_settings_json"))
    return {
        "ok": True,
        "user": {
            "googleSub": user["google_sub"],
            "email": user["email"],
            "name": user.get("name"),
            "picture": user.get("picture"),
            "lastAnsweredDate": user.get("last_answered_date"),
            "sessionExpiresAt": user.get("expires_at"),
            "notificationSettings": {"slots": notification_slots},
        },
    }


@app.post("/subscribe")
def subscribe(payload: SubscribeRequest, user: dict = Depends(require_user)) -> dict:
    upsert_subscription(payload.subscription.model_dump(), user["google_sub"])
    return {"ok": True}


@app.get("/notification-settings")
def get_notification_settings(user: dict = Depends(require_user)) -> dict:
    current = get_user(user["google_sub"])
    slots = _load_notification_slots((current or {}).get("notification_settings_json"))
    return {"ok": True, "settings": {"slots": slots}}


@app.put("/notification-settings")
def put_notification_settings(
    payload: NotificationSettingsRequest,
    user: dict = Depends(require_user),
) -> dict:
    slots = _normalize_notification_slots(payload.slots)
    settings_json = json.dumps({"slots": slots}, separators=(",", ":"))
    updated = update_notification_settings_for_user(user["google_sub"], settings_json)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True, "settings": {"slots": slots}}


@app.post("/checkin")
def checkin(payload: CheckInRequest, user: dict = Depends(require_user)) -> dict:
    updated = update_last_answered_date_for_user(user["google_sub"], payload.date)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    return {"ok": True, "status": payload.status, "date": payload.date}
