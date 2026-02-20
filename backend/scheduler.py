# Version History
# v1.0 - APScheduler jobs for 10-minute check-ins and post-Ramadan summary prompt.

from __future__ import annotations

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from db import list_subscriptions
from jakim_calendar import get_cached_ramadan_window
from push import send_push_batch

TIMEZONE = ZoneInfo("Asia/Kuala_Lumpur")


def _inside_checkin_window(now: datetime) -> bool:
    t = now.time()
    windows = [
        (time(8, 0), time(11, 0)),
        (time(13, 0), time(16, 0)),
        (time(17, 0), time(19, 30)),
    ]

    for start, end in windows:
        if start <= t <= end:
            return True
    return False


def _run_checkin_job(settings) -> None:
    now = datetime.now(TIMEZONE)
    if not _inside_checkin_window(now):
        return

    date_iso = now.date().isoformat()
    subscriptions = list_subscriptions()
    pending = [
        item for item in subscriptions if item.get("last_answered_date") != date_iso
    ]
    if not pending:
        return

    payload = {
        "title": "Check-in puasa",
        "body": "Sudah jawab check-in puasa hari ini?",
        "url": f"{settings.frontend_base_url}/?view=checkin&date={date_iso}",
        "tag": f"checkin-{date_iso}",
    }
    send_push_batch(pending, payload, settings)


def _run_summary_job(settings) -> None:
    now = datetime.now(TIMEZONE)
    window = get_cached_ramadan_window(TIMEZONE)

    ramadan_end = datetime.strptime(window["end_date"], "%Y-%m-%d").date()
    due = datetime.combine(ramadan_end, time(23, 59, 59), TIMEZONE) + timedelta(hours=72)
    due_window_end = due + timedelta(minutes=10)

    if not (due <= now < due_window_end):
        return

    subscriptions = list_subscriptions()
    if not subscriptions:
        return

    payload = {
        "title": "Ringkasan Ramadan",
        "body": "Semak ringkasan puasa anda dan rancang ganti sebelum Ramadan seterusnya.",
        "url": f"{settings.frontend_base_url}/?view=summary",
        "tag": f"summary-{window['end_date']}",
    }
    send_push_batch(subscriptions, payload, settings)


def build_scheduler(settings) -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone="Asia/Kuala_Lumpur")
    scheduler.add_job(
        _run_checkin_job,
        trigger=CronTrigger(minute="*/10", timezone="Asia/Kuala_Lumpur"),
        kwargs={"settings": settings},
        id="checkin-every-10-min",
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
