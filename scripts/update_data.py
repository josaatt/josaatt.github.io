#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import datetime as dt
import json
import os
import re
import sys
from urllib.parse import urlencode

import requests

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(REPO_ROOT, "norrkoping_jonkoping_manad.json")

REGION_CODES = ["0581", "0680"]  # Norrköping, Jönköping
REGION_NAMES = {"0581": "Norrköping", "0680": "Jönköping"}

SCB_BASE = "https://api.scb.se/ov0104/v2beta/api/v2/tables/TAB6471/data"
SCB_COMMON_PARAMS = {
    "lang": "sv",
    "valueCodes[ContentsCode]": "000007SF",
    "valueCodes[Region]": ",".join(REGION_CODES),
    "valueCodes[Alder]": "TotSA",
    "valueCodes[Kon]": "TotSa",
    "codelist[Region]": "vs_CKM03Kommun",
    "codelist[Alder]": "vs_CKM01AlderTot",
}

MONTH_RE = re.compile(r"^(\d{4})M(\d{2})$")


def parse_month(s: str) -> dt.date:
    m = MONTH_RE.match(s)
    if not m:
        raise ValueError(f"Invalid month string: {s}")
    y, mm = int(m.group(1)), int(m.group(2))
    return dt.date(y, mm, 1)


def month_to_str(d: dt.date) -> str:
    return f"{d.year}M{d.month:02d}"


def add_months(d: dt.date, n: int) -> dt.date:
    y = d.year + (d.month - 1 + n) // 12
    m = (d.month - 1 + n) % 12 + 1
    return dt.date(y, m, 1)



def find_latest_complete_month(rows: list[dict], all_region_names: set[str]) -> dt.date | None:
    from collections import defaultdict

    # Group regions found for each month
    regions_by_month = defaultdict(set)
    for r in rows:
        regions_by_month[r["month"]].add(r["region"])

    # Find the latest month that has a complete set of regions
    latest_complete = None
    for month_str, region_set in regions_by_month.items():
        if region_set == all_region_names:
            try:
                d = parse_month(month_str)
                if latest_complete is None or d > latest_complete:
                    latest_complete = d
            except ValueError:
                continue
    return latest_complete


def read_existing(path: str):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return [], set(), None
    with open(path, "r", encoding="utf-8") as f:
        rows = json.load(f)
    
    all_region_names = set(REGION_NAMES.values())
    latest = find_latest_complete_month(rows, all_region_names)

    # Filter out any partial data after the latest complete month
    if latest:
        latest_str = month_to_str(latest)
        rows = [r for r in rows if r["month"] <= latest_str]

    seen = {(r.get("region"), r.get("month")) for r in rows}
    return rows, seen, latest


def months_between(start_exclusive: dt.date, end_inclusive: dt.date):
    # Return list of YYYYMmm strings: (start_exclusive, end_inclusive]
    out = []
    cur = add_months(start_exclusive, 1) if start_exclusive else end_inclusive
    while cur <= end_inclusive:
        out.append(month_to_str(cur))
        cur = add_months(cur, 1)
    return out


def fetch_scb(months: list[str]) -> list[dict]:
    if not months:
        return []
    params = SCB_COMMON_PARAMS.copy()
    params["valueCodes[Tid]"] = ",".join(months)
    url = f"{SCB_BASE}?{urlencode(params, safe=',[ ]')}"

    try:
        # SCB returns PC-Axis-like text in latin-1 for this endpoint
        resp = requests.get(url, timeout=45)
        resp.raise_for_status()
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 400:
            print(f"Got 400 Bad Request from SCB API for months {months}. Assuming data is not yet available.", file=sys.stderr)
            return []  # Return empty list, not an error
        raise e # Re-raise other HTTP errors (like 500, 503)

    text = resp.content.decode("latin-1", errors="ignore")

    # Extract region code order
    m_codes = re.search(r"CODES\(\"region\"\)=\"([^\"]+)\";", text)
    if not m_codes:
        # Fallback to our request order
        reg_codes = REGION_CODES
    else:
        reg_codes = m_codes.group(1).split("\",\"")

    # Extract DATA block
    m_data = re.search(r"DATA=\s*([^;]+);", text)
    if not m_data:
        raise RuntimeError("SCB response missing DATA block")
    numbers = [int(x) for x in re.findall(r"-?\d+", m_data.group(1))]

    expected = len(reg_codes) * len(months)
    if len(numbers) != expected:
        # Sometimes SCB may omit months; handle gracefully by truncating
        pass

    rows = []
    idx = 0
    for rc in reg_codes:
        for mo in months:
            if idx >= len(numbers):
                break
            val = numbers[idx]
            idx += 1
            rows.append({
                "region": REGION_NAMES.get(rc, rc),
                "month": mo,
                "population": val,
            })
    return rows


def main():
    rows, seen, latest = read_existing(DATA_FILE)

    # target end = last full month (previous month)
    today = dt.date.today()
    first_of_this = dt.date(today.year, today.month, 1)
    end = add_months(first_of_this, -1)

    if latest is None:
        # If file missing, start at e.g. 2025-01 to end
        # But better: do nothing to avoid wiping; user already has full history
        print("No existing data found; skipping to avoid overwriting.", file=sys.stderr)
        return 0

    if latest >= end:
        print("No new months to fetch.")
        return 0

    months = months_between(latest, end)
    print(f"Fetching months: {months}")

    new_rows = fetch_scb(months)
    added = 0
    for r in new_rows:
        key = (r["region"], r["month"])
        if key in seen:
            continue
        rows.append(r)
        seen.add(key)
        added += 1

    if added == 0:
        print("No new rows added.")
        return 0

    # Keep stable order by month then region for readability
    def sort_key(r):
        d = parse_month(r["month"]) if MONTH_RE.match(r["month"]) else dt.date.min
        return (d, r["region"])  # month asc, region asc

    rows.sort(key=sort_key)

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Wrote {added} new rows to {os.path.basename(DATA_FILE)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
