# Version History
# v1.0 - Initial FastAPI backend with subscriptions, check-ins, and scheduler wiring.

from __future__ import annotations

import os
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from db import init_db, upsert_subscription, update_last_answered_date
from jakim_calendar import get_cached_ramadan_window
from scheduler import build_scheduler

load_dotenv()

TIMEZONE = ZoneInfo("Asia/Kuala_Lumpur")


@dataclass(frozen=True)
class Settings:
    vapid_public_key: str
    vapid_private_key: str
    vapid_subject: str
    frontend_base_url: str


def get_settings() -> Settings:
    public = os.getenv("VAPID_PUBLIC_KEY", "")
    private = os.getenv("VAPID_PRIVATE_KEY", "")
    subject = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com")
    frontend = os.getenv("FRONTEND_BASE_URL", "http://localhost:5500")

    if not public or not private:
        raise RuntimeError("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set.")

    return Settings(
        vapid_public_key=public,
        vapid_private_key=private,
        vapid_subject=subject,
        frontend_base_url=frontend.rstrip("/"),
    )


settings = get_settings()
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
    endpoint: str
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    status: str = Field(..., pattern=r"^(fasting|not_fasting)$")


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
    }


@app.get("/ramadan-window")
def ramadan_window() -> dict:
    return get_cached_ramadan_window(TIMEZONE)


@app.post("/subscribe")
def subscribe(payload: SubscribeRequest) -> dict:
    upsert_subscription(payload.subscription.model_dump())
    return {"ok": True}


@app.post("/checkin")
def checkin(payload: CheckInRequest) -> dict:
    updated = update_last_answered_date(payload.endpoint, payload.date)
    if not updated:
        raise HTTPException(status_code=404, detail="Subscription endpoint not found")

    return {"ok": True, "status": payload.status, "date": payload.date}
