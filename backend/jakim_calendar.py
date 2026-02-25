# Version History
# v1.0 - e-Solat scraping with file-based cache for Ramadan start and end dates.

from __future__ import annotations

import json
import os
import re
from datetime import date, datetime, timedelta
from typing import Iterable
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

ESOLAT_URL = "https://www.e-solat.gov.my/index.php?pageId=26&siteId=24"
ALADHAN_API_URL = "https://api.aladhan.com/v1/calendarByCity"
CACHE_PATH = os.path.join(os.path.dirname(__file__), "ramadan_cache.json")
CACHE_TTL = timedelta(hours=24)


def _parse_date_token(token: str) -> date | None:
    token = token.strip()
    fmts = ["%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%d %B %Y", "%d %b %Y"]
    for fmt in fmts:
        try:
            return datetime.strptime(token, fmt).date()
        except ValueError:
            continue
    return None


def _collect_dates(text: str) -> Iterable[date]:
    for token in re.findall(r"\d{1,4}[/-]\d{1,2}[/-]\d{1,4}", text):
        parsed = _parse_date_token(token)
        if parsed:
            yield parsed
    for token in re.findall(r"\b\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}\b", text):
        parsed = _parse_date_token(token)
        if parsed:
            yield parsed


def _extract_window_from_html(html: str, target_year: int) -> tuple[date, date]:
    soup = BeautifulSoup(html, "html.parser")
    ramadan_dates: list[date] = []

    for row in soup.select("tr"):
        cells = list(row.stripped_strings)
        if not cells:
            continue
        # Only trust rows whose Hijri date column is Ramadan, not descriptions.
        if not re.search(r"ramad(?:an|han)", cells[0], flags=re.IGNORECASE):
            continue
        row_text = " ".join(cells)
        for parsed in _collect_dates(row_text):
            if parsed.year == target_year:
                ramadan_dates.append(parsed)

    if not ramadan_dates:
        full_text = soup.get_text("\n", strip=True)
        for line in full_text.splitlines():
            if re.search(r"ramad(?:an|han)", line, flags=re.IGNORECASE):
                for parsed in _collect_dates(line):
                    if parsed.year == target_year:
                        ramadan_dates.append(parsed)

    if not ramadan_dates:
        raise RuntimeError("Unable to parse Ramadan dates from e-Solat page.")

    return min(ramadan_dates), max(ramadan_dates)


def _parse_hijri_day_month(value: str) -> tuple[int | None, int | None]:
    token = (value or "").strip().lower()
    if not token:
        return None, None

    numeric = re.search(r"(\d{1,2})[-/](\d{1,2})[-/](\d{3,4})", token)
    if numeric:
        day = int(numeric.group(1))
        month = int(numeric.group(2))
        return day, month

    day_match = re.search(r"\b(\d{1,2})\b", token)
    day = int(day_match.group(1)) if day_match else None

    if re.search(r"ramad(?:an|han)|رمضان", token):
        return day, 9

    return day, None


def _infer_window_from_prayer_times(now: datetime, timezone: ZoneInfo) -> dict:
    # Fallback when e-Solat is temporarily unreachable.
    from prayer_times import get_prayer_times_window

    zone = os.getenv("PRAYER_ZONE", "SGR01")
    city = os.getenv("PRAYER_CITY", "Seri Kembangan")
    country = os.getenv("PRAYER_COUNTRY", "Malaysia")
    method = int(os.getenv("PRAYER_METHOD", "11"))

    payload = get_prayer_times_window(
        timezone=timezone,
        zone=zone,
        days=90,
        city=city,
        country=country,
        method=method,
    )
    items = payload.get("items", [])
    if not items:
        raise RuntimeError("Unable to infer Ramadan window from prayer times.")

    today_iso = now.date().isoformat()
    ramadan_dates: list[str] = []
    today_hijri_day: int | None = None

    for row in items:
        row_date = str(row.get("date", ""))
        day, month = _parse_hijri_day_month(str(row.get("hijri", "")))
        if month == 9 and row_date:
            ramadan_dates.append(row_date)
            if row_date == today_iso:
                today_hijri_day = day

    if not ramadan_dates:
        raise RuntimeError("No Ramadan dates found in prayer-times fallback data.")

    start_iso = min(ramadan_dates)
    end_iso = max(ramadan_dates)

    # If window starts today while already in Ramadan, infer prior days by Hijri day number.
    if start_iso >= today_iso and today_hijri_day and today_hijri_day > 1:
        inferred_start = now.date() - timedelta(days=today_hijri_day - 1)
        start_iso = inferred_start.isoformat()

    return {
        "start_date": start_iso,
        "end_date": end_iso,
        "fetched_at": now.isoformat(),
        "source_url": "inferred-from-prayer-times",
        "stale": True,
    }


def _infer_window_from_aladhan(now: datetime) -> dict:
    city = os.getenv("PRAYER_CITY", "Seri Kembangan")
    country = os.getenv("PRAYER_COUNTRY", "Malaysia")
    method = int(os.getenv("PRAYER_METHOD", "11"))

    year = now.year
    ramadan_dates: list[date] = []

    for month in range(1, 13):
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
        payload = response.json()
        if payload.get("code") != 200:
            continue

        for row in payload.get("data", []):
            hijri = (row.get("date") or {}).get("hijri") or {}
            month_num = int((hijri.get("month") or {}).get("number") or 0)
            if month_num != 9:
                continue

            greg = (row.get("date") or {}).get("gregorian") or {}
            gdate = greg.get("date")
            if not isinstance(gdate, str):
                continue
            parsed = _parse_date_token(gdate)
            if parsed and parsed.year == year:
                ramadan_dates.append(parsed)

    if not ramadan_dates:
        raise RuntimeError("Unable to infer Ramadan window from AlAdhan data.")

    return {
        "start_date": min(ramadan_dates).isoformat(),
        "end_date": max(ramadan_dates).isoformat(),
        "fetched_at": now.isoformat(),
        "source_url": "https://aladhan.com/prayer-times-api",
        "stale": True,
    }


def _read_cache() -> dict | None:
    if not os.path.exists(CACHE_PATH):
        return None

    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(payload: dict) -> None:
    with open(CACHE_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def _fetch_ramadan_window(now: datetime) -> dict:
    response = requests.get(ESOLAT_URL, timeout=(8, 20))
    response.raise_for_status()

    start, end = _extract_window_from_html(response.text, now.year)
    return {
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "fetched_at": now.isoformat(),
        "source_url": ESOLAT_URL,
        "stale": False,
    }


def get_cached_ramadan_window(timezone: ZoneInfo) -> dict:
    now = datetime.now(timezone)
    cached = _read_cache()

    if cached:
        try:
            fetched_at = datetime.fromisoformat(cached["fetched_at"])
            if fetched_at.tzinfo is None:
                fetched_at = fetched_at.replace(tzinfo=timezone)
            is_fresh = (now - fetched_at) <= CACHE_TTL
            same_year = (
                datetime.fromisoformat(cached["start_date"]).year == now.year
                or datetime.fromisoformat(cached["end_date"]).year == now.year
            )
            if is_fresh and same_year:
                return cached
        except Exception:
            pass

    try:
        fresh = _fetch_ramadan_window(now)
        _write_cache(fresh)
        return fresh
    except Exception:
        if cached:
            cached["stale"] = True
            return cached
        try:
            inferred = _infer_window_from_prayer_times(now, timezone)
        except Exception:
            inferred = _infer_window_from_aladhan(now)
        _write_cache(inferred)
        return inferred
