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
CACHE_PATH = os.path.join(os.path.dirname(__file__), "ramadan_cache.json")
CACHE_TTL = timedelta(hours=24)


def _parse_date_token(token: str) -> date | None:
    token = token.strip()
    fmts = ["%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d"]
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


def _extract_window_from_html(html: str, target_year: int) -> tuple[date, date]:
    soup = BeautifulSoup(html, "html.parser")
    ramadan_dates: list[date] = []

    for row in soup.select("tr"):
        text = " ".join(row.stripped_strings)
        if not re.search(r"ramad(?:an|han)", text, flags=re.IGNORECASE):
            continue
        for parsed in _collect_dates(text):
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
    response = requests.get(ESOLAT_URL, timeout=30)
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
        raise
