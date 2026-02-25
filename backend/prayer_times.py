# Version History
# v1.0 - JAKIM/e-Solat prayer times fetcher with month cache and 30-day window output.

from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import requests

ESOLAT_API_URL = "https://www.e-solat.gov.my/index.php"
ESOLAT_ROUTE = "esolatApi/takwimsolat"
CACHE_PATH = os.path.join(os.path.dirname(__file__), "prayer_times_cache.json")
CACHE_TTL = timedelta(hours=6)


def _read_cache() -> dict[str, Any]:
    if not os.path.exists(CACHE_PATH):
        return {}

    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
            return payload if isinstance(payload, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _write_cache(payload: dict[str, Any]) -> None:
    with open(CACHE_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def _month_key(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


def _parse_api_date(value: str) -> date:
    value = value.strip()
    for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unsupported prayer date format: {value}")


def _normalize_prayer_entry(raw: dict[str, Any]) -> dict[str, str] | None:
    date_token = raw.get("date")
    if not isinstance(date_token, str):
        return None

    try:
        iso_date = _parse_api_date(date_token).isoformat()
    except ValueError:
        return None

    return {
        "date": iso_date,
        "day": str(raw.get("day", "")),
        "hijri": str(raw.get("hijri", "")),
        "imsak": str(raw.get("imsak", "")),
        "fajr": str(raw.get("fajr", "")),
        "sunrise": str(raw.get("syuruk", "")),
        "dhuhr": str(raw.get("dhuhr", "")),
        "asr": str(raw.get("asr", "")),
        "maghrib": str(raw.get("maghrib", "")),
        "isha": str(raw.get("isha", "")),
    }


def _fetch_month_from_api(zone: str, year: int, month: int) -> list[dict[str, str]]:
    response = requests.get(
        ESOLAT_API_URL,
        params={
            "r": ESOLAT_ROUTE,
            "period": "month",
            "zone": zone,
            "year": str(year),
            "month": str(month),
        },
        timeout=30,
    )
    response.raise_for_status()

    data = response.json()
    if data.get("status") != "OK!":
        raise RuntimeError(f"e-Solat API status is not OK for {year}-{month:02d}.")

    items: list[dict[str, str]] = []
    for raw in data.get("prayerTime", []):
        if not isinstance(raw, dict):
            continue
        normalized = _normalize_prayer_entry(raw)
        if normalized:
            items.append(normalized)

    if not items:
        raise RuntimeError(f"No prayer times returned for {year}-{month:02d}.")

    return items


def _load_month(zone: str, year: int, month: int, now: datetime) -> tuple[list[dict[str, str]], bool]:
    cache = _read_cache()
    zones = cache.setdefault("zones", {})
    zone_cache = zones.setdefault(zone, {})
    key = _month_key(year, month)
    cached = zone_cache.get(key) if isinstance(zone_cache, dict) else None

    if isinstance(cached, dict):
        try:
            fetched_at = datetime.fromisoformat(str(cached["fetched_at"]))
            if fetched_at.tzinfo is None:
                fetched_at = fetched_at.replace(tzinfo=now.tzinfo)
            if (now - fetched_at) <= CACHE_TTL and isinstance(cached.get("items"), list):
                return cached["items"], False
        except Exception:
            pass

    try:
        fresh_items = _fetch_month_from_api(zone, year, month)
        zone_cache[key] = {
            "fetched_at": now.isoformat(),
            "items": fresh_items,
        }
        _write_cache(cache)
        return fresh_items, False
    except Exception:
        if isinstance(cached, dict) and isinstance(cached.get("items"), list) and cached["items"]:
            return cached["items"], True
        raise


def _iter_month_starts(start_date: date, end_date: date) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    year = start_date.year
    month = start_date.month

    while (year, month) <= (end_date.year, end_date.month):
        out.append((year, month))
        if month == 12:
            year += 1
            month = 1
        else:
            month += 1

    return out


def get_prayer_times_window(timezone: ZoneInfo, zone: str, days: int = 30) -> dict[str, Any]:
    now = datetime.now(timezone)
    start = now.date()
    total_days = max(1, days)
    end = start + timedelta(days=total_days - 1)

    stale = False
    merged: dict[str, dict[str, str]] = {}

    for year, month in _iter_month_starts(start, end):
        month_items, month_stale = _load_month(zone, year, month, now)
        stale = stale or month_stale
        for row in month_items:
            d = row.get("date")
            if d:
                merged[d] = row

    items = [
        row
        for d, row in sorted(merged.items(), key=lambda kv: kv[0])
        if start.isoformat() <= d <= end.isoformat()
    ]

    if not items:
        raise RuntimeError("Unable to build prayer times window from JAKIM data.")

    return {
        "timezone": "Asia/Kuala_Lumpur",
        "zone": zone,
        "days": total_days,
        "today": start.isoformat(),
        "generated_at": now.isoformat(),
        "source_name": "Jabatan Kemajuan Islam Malaysia (JAKIM)",
        "source_url": "https://www.e-solat.gov.my/",
        "stale": stale,
        "items": items,
    }
