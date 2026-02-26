# Version History
# v1.0 - APScheduler jobs for 10-minute check-ins and post-Ramadan summary prompt.
# v1.1 - Per-user reminder slots (fixed or prayer-based) with dedupe logs.

from __future__ import annotations

import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from db import (
    cleanup_old_reminder_logs,
    list_subscriptions,
    mark_reminder_sent,
    was_reminder_sent,
)
from jakim_calendar import get_cached_ramadan_window
from prayer_times import get_prayer_times_window
from push import send_push_batch

TIMEZONE = ZoneInfo("Asia/Kuala_Lumpur")
VALID_PRAYER_KEYS = {"imsak", "fajr", "sunrise", "dhuhr", "asr", "sunset", "maghrib", "isha"}
DEFAULT_REMINDER_SLOTS = [
    {"type": "fixed", "time": "09:00"},
    {"type": "fixed", "time": "13:30"},
    {"type": "fixed", "time": "18:00"},
]
REMINDER_GRACE_MINUTES = 5


def _parse_hhmm(value: str) -> tuple[int, int] | None:
    try:
        token = (value or "").strip()
        hh, mm = token.split(":")
        hour = int(hh)
        minute = int(mm)
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return hour, minute
    except Exception:
        return None
    return None


def _normalize_slots(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        return DEFAULT_REMINDER_SLOTS

    out: list[dict] = []
    for item in raw[:3]:
        if not isinstance(item, dict):
            continue
        slot_type = str(item.get("type") or "").strip().lower()
        if slot_type == "fixed":
            hhmm = _parse_hhmm(str(item.get("time") or ""))
            if not hhmm:
                continue
            out.append({"type": "fixed", "time": f"{hhmm[0]:02d}:{hhmm[1]:02d}"})
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


def _parse_user_slots(settings_json: str | None) -> list[dict]:
    if not settings_json:
        return DEFAULT_REMINDER_SLOTS
    try:
        parsed = json.loads(settings_json)
    except Exception:
        return DEFAULT_REMINDER_SLOTS
    slots = parsed.get("slots") if isinstance(parsed, dict) else None
    return _normalize_slots(slots)


def _resolve_slot_time(slot: dict, today_prayers: dict[str, str], today_iso: str) -> datetime | None:
    slot_type = slot.get("type")
    if slot_type == "fixed":
        hhmm = _parse_hhmm(str(slot.get("time") or ""))
        if not hhmm:
            return None
        return datetime(
            year=int(today_iso[0:4]),
            month=int(today_iso[5:7]),
            day=int(today_iso[8:10]),
            hour=hhmm[0],
            minute=hhmm[1],
            second=0,
            tzinfo=TIMEZONE,
        )

    if slot_type == "prayer":
        prayer_key = str(slot.get("prayer") or "").strip().lower()
        if prayer_key not in VALID_PRAYER_KEYS:
            return None
        prayer_hms = today_prayers.get(prayer_key) or ""
        hhmm = _parse_hhmm(prayer_hms[0:5])
        if not hhmm:
            return None
        base = datetime(
            year=int(today_iso[0:4]),
            month=int(today_iso[5:7]),
            day=int(today_iso[8:10]),
            hour=hhmm[0],
            minute=hhmm[1],
            second=0,
            tzinfo=TIMEZONE,
        )
        try:
            offset = int(slot.get("offset_minutes", 0))
        except (TypeError, ValueError):
            offset = 0
        return base + timedelta(minutes=offset)

    return None


def _group_subscriptions_by_user() -> dict[str, dict]:
    grouped: dict[str, dict] = {}
    for row in list_subscriptions():
        user_sub = row.get("user_sub")
        if not user_sub:
            continue

        bucket = grouped.setdefault(
            user_sub,
            {
                "user_sub": user_sub,
                "last_answered_date": row.get("last_answered_date"),
                "notification_settings_json": row.get("notification_settings_json"),
                "subscriptions": [],
            },
        )
        bucket["subscriptions"].append(
            {
                "endpoint": row["endpoint"],
                "p256dh": row["p256dh"],
                "auth": row["auth"],
                "user_sub": user_sub,
            }
        )
    return grouped


def _run_checkin_job(settings) -> None:
    now = datetime.now(TIMEZONE)
    date_iso = now.date().isoformat()
    grouped = _group_subscriptions_by_user()
    if not grouped:
        return

    prayer_today: dict[str, str] = {}
    try:
        prayer_payload = get_prayer_times_window(
            timezone=TIMEZONE,
            zone=settings.prayer_zone,
            days=1,
            city=settings.prayer_city,
            country=settings.prayer_country,
            method=settings.prayer_method,
        )
        prayer_today = prayer_payload["items"][0] if prayer_payload.get("items") else {}
    except Exception:
        # Keep fixed-time reminders working even if prayer data is temporarily unavailable.
        prayer_today = {}

    for user_sub, user in grouped.items():
        if user.get("last_answered_date") == date_iso:
            continue

        slots = _parse_user_slots(user.get("notification_settings_json"))
        for slot_index, slot in enumerate(slots):
            due = _resolve_slot_time(slot, prayer_today, date_iso)
            if not due:
                continue
            if now < due or now > due + timedelta(minutes=REMINDER_GRACE_MINUTES):
                continue
            if was_reminder_sent(user_sub, date_iso, slot_index):
                continue

            payload = {
                "title": "Fasting Check-in",
                "body": "Have you completed today's fasting check-in?",
                "url": f"{settings.frontend_base_url}/?view=checkin&date={date_iso}",
                "tag": f"checkin-{date_iso}-{slot_index}",
            }
            result = send_push_batch(user["subscriptions"], payload, settings)
            if result.get("success", 0) > 0:
                mark_reminder_sent(user_sub, date_iso, slot_index)


def _run_summary_job(settings) -> None:
    now = datetime.now(TIMEZONE)
    window = get_cached_ramadan_window(TIMEZONE)

    ramadan_end = datetime.strptime(window["end_date"], "%Y-%m-%d").date()
    due = datetime.combine(ramadan_end, datetime.min.time(), TIMEZONE) + timedelta(days=3, hours=23, minutes=59, seconds=59)
    due_window_end = due + timedelta(minutes=10)

    if not (due <= now < due_window_end):
        return

    subscriptions = list_subscriptions()
    if not subscriptions:
        return

    payload = {
        "title": "Ramadan Summary",
        "body": "Review your fasting summary and plan any required make-up fasts.",
        "url": f"{settings.frontend_base_url}/?view=summary",
        "tag": f"summary-{window['end_date']}",
    }
    send_push_batch(subscriptions, payload, settings)


def build_scheduler(settings) -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone="Asia/Kuala_Lumpur")
    scheduler.add_job(
        _run_checkin_job,
        trigger=CronTrigger(minute="*", timezone="Asia/Kuala_Lumpur"),
        kwargs={"settings": settings},
        id="checkin-by-user-reminder-slots",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    scheduler.add_job(
        cleanup_old_reminder_logs,
        trigger=CronTrigger(hour=3, minute=10, timezone="Asia/Kuala_Lumpur"),
        kwargs={"keep_days": 14},
        id="cleanup-reminder-delivery-log",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    scheduler.add_job(
        _run_summary_job,
        trigger=CronTrigger(minute="*/10", timezone="Asia/Kuala_Lumpur"),
        kwargs={"settings": settings},
        id="summary-72h-post-ramadan",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    return scheduler
