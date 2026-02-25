# Version History
# v1.0 - Prayer times provider with JAKIM primary source and AlAdhan fallback.

from __future__ import annotations

import json
import os
import re
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import requests

JAKIM_API_URL = "https://www.e-solat.gov.my/index.php"
JAKIM_ROUTE = "esolatApi/takwimsolat"
ALADHAN_API_URL = "https://api.aladhan.com/v1/calendarByCity"

CACHE_PATH = os.path.join(os.path.dirname(__file__), "prayer_times_cache.json")
CACHE_TTL = timedelta(hours=6)

SOURCE_JAKIM = "jakim"
SOURCE_ALADHAN = "aladhan"
SOURCE_META = {
    SOURCE_JAKIM: {
        "name": "Jabatan Kemajuan Islam Malaysia (JAKIM)",
        "url": "https://www.e-solat.gov.my/",
    },
    SOURCE_ALADHAN: {
        "name": "AlAdhan (fallback)",
        "url": "https://aladhan.com/prayer-times-api",
    },
}


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


def _parse_jakim_date(value: str) -> date:
    value = value.strip()
    for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unsupported JAKIM date format: {value}")


def _clean_time_token(value: str) -> str:
    # AlAdhan returns values like "06:07 (+08)"; JAKIM returns "06:17:00".
    match = re.search(r"\d{1,2}:\d{2}(?::\d{2})?", value or "")
    if not match:
        return ""
    token = match.group(0)
    if token.count(":") == 1:
        token = f"{token}:00"
    return token


def _normalize_jakim_entry(raw: dict[str, Any]) -> dict[str, str] | None:
    date_token = raw.get("date")
    if not isinstance(date_token, str):
        return None

    try:
        iso_date = _parse_jakim_date(date_token).isoformat()
    except ValueError:
        return None

    return {
        "date": iso_date,
        "day": str(raw.get("day", "")),
        "hijri": str(raw.get("hijri", "")),
        "imsak": _clean_time_token(str(raw.get("imsak", ""))),
        "fajr": _clean_time_token(str(raw.get("fajr", ""))),
        "sunrise": _clean_time_token(str(raw.get("syuruk", ""))),
        "dhuhr": _clean_time_token(str(raw.get("dhuhr", ""))),
        "asr": _clean_time_token(str(raw.get("asr", ""))),
        "maghrib": _clean_time_token(str(raw.get("maghrib", ""))),
        "isha": _clean_time_token(str(raw.get("isha", ""))),
    }


def _normalize_aladhan_entry(raw: dict[str, Any]) -> dict[str, str] | None:
    date_raw = ((raw.get("date") or {}).get("gregorian") or {}).get("date")
    if not isinstance(date_raw, str):
        return None

    try:
        iso_date = datetime.strptime(date_raw, "%d-%m-%Y").date().isoformat()
    except ValueError:
        return None

    timings = raw.get("timings") or {}
    day = (((raw.get("date") or {}).get("gregorian") or {}).get("weekday") or {}).get("en", "")
    hijri = ((raw.get("date") or {}).get("hijri") or {}).get("date", "")

    return {
        "date": iso_date,
        "day": str(day),
        "hijri": str(hijri),
        "imsak": _clean_time_token(str(timings.get("Imsak", ""))),
        "fajr": _clean_time_token(str(timings.get("Fajr", ""))),
        "sunrise": _clean_time_token(str(timings.get("Sunrise", ""))),
        "dhuhr": _clean_time_token(str(timings.get("Dhuhr", ""))),
        "asr": _clean_time_token(str(timings.get("Asr", ""))),
        "maghrib": _clean_time_token(str(timings.get("Maghrib", ""))),
        "isha": _clean_time_token(str(timings.get("Isha", ""))),
    }


def _fetch_month_from_jakim(zone: str, year: int, month: int) -> list[dict[str, str]]:
    response = requests.get(
        JAKIM_API_URL,
        params={
            "r": JAKIM_ROUTE,
            "period": "month",
            "zone": zone,
            "year": str(year),
            "month": str(month),
        },
        timeout=(8, 20),
    )
    response.raise_for_status()

    data = response.json()
    if data.get("status") != "OK!":
        raise RuntimeError(f"JAKIM API status is not OK for {year}-{month:02d}.")

    items: list[dict[str, str]] = []
    for raw in data.get("prayerTime", []):
        if not isinstance(raw, dict):
            continue
        normalized = _normalize_jakim_entry(raw)
        if normalized:
            items.append(normalized)

    if not items:
        raise RuntimeError(f"No JAKIM prayer times returned for {year}-{month:02d}.")

    return items


def _fetch_month_from_aladhan(
    year: int,
    month: int,
    city: str,
    country: str,
    method: int,
) -> list[dict[str, str]]:
    response = requests.get(
        ALADHAN_API_URL,
        params={
            "city": city,
            "country": country,
            "method": str(method),
            "month": str(month),
            "year": str(year),
        },
        timeout=(8, 20),
    )
    response.raise_for_status()

    data = response.json()
    if data.get("code") != 200:
        raise RuntimeError(f"AlAdhan API status is not OK for {year}-{month:02d}.")

    items: list[dict[str, str]] = []
    for raw in data.get("data", []):
        if not isinstance(raw, dict):
            continue
        normalized = _normalize_aladhan_entry(raw)
        if normalized:
            items.append(normalized)

    if not items:
        raise RuntimeError(f"No AlAdhan prayer times returned for {year}-{month:02d}.")

    return items


def _fetch_month_with_fallback(
    zone: str,
    year: int,
    month: int,
    city: str,
    country: str,
    method: int,
) -> tuple[list[dict[str, str]], str]:
    try:
        return _fetch_month_from_jakim(zone, year, month), SOURCE_JAKIM
    except Exception:
        return _fetch_month_from_aladhan(year, month, city, country, method), SOURCE_ALADHAN


def _load_month(
    zone: str,
    year: int,
    month: int,
    now: datetime,
    city: str,
    country: str,
    method: int,
) -> tuple[list[dict[str, str]], bool, str]:
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
                source = str(cached.get("source") or SOURCE_JAKIM)
                return cached["items"], False, source
        except Exception:
            pass

    try:
        fresh_items, source = _fetch_month_with_fallback(zone, year, month, city, country, method)
        zone_cache[key] = {
            "fetched_at": now.isoformat(),
            "items": fresh_items,
            "source": source,
        }
        _write_cache(cache)
        return fresh_items, False, source
    except Exception:
        if isinstance(cached, dict) and isinstance(cached.get("items"), list) and cached["items"]:
            source = str(cached.get("source") or SOURCE_JAKIM)
            return cached["items"], True, source
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


def get_prayer_times_window(
    timezone: ZoneInfo,
    zone: str,
    days: int = 30,
    city: str = "Seri Kembangan",
    country: str = "Malaysia",
    method: int = 11,
) -> dict[str, Any]:
    now = datetime.now(timezone)
    start = now.date()
    total_days = max(1, days)
    end = start + timedelta(days=total_days - 1)

    stale = False
    merged: dict[str, dict[str, str]] = {}
    sources: set[str] = set()

    for year, month in _iter_month_starts(start, end):
        month_items, month_stale, month_source = _load_month(
            zone=zone,
            year=year,
            month=month,
            now=now,
            city=city,
            country=country,
            method=method,
        )
        stale = stale or month_stale
        sources.add(month_source)

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
        raise RuntimeError("Unable to build prayer times window from upstream data.")

    source = SOURCE_JAKIM if SOURCE_JAKIM in sources else SOURCE_ALADHAN
    source_meta = SOURCE_META[source]

    return {
        "timezone": "Asia/Kuala_Lumpur",
        "zone": zone,
        "days": total_days,
        "today": start.isoformat(),
        "generated_at": now.isoformat(),
        "source_name": source_meta["name"],
        "source_url": source_meta["url"],
        "used_fallback": source == SOURCE_ALADHAN,
        "stale": stale,
        "items": items,
    }
