#!/usr/bin/env python3
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

HOME = Path.home()
DB_PATH = HOME / "Library/Application Support/AddressBook/Sources/115CB84A-8170-4DC4-82C0-D8E8A15ADFE0/AddressBook-v22.abcddb"


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.startswith("ORBIT_") and key not in os.environ:
            os.environ[key] = value.strip().strip("\"'")


load_env(HOME / ".hermes/.env")

ORBIT_BASE = os.environ.get("ORBIT_API_BASE", "https://orbit-mu-roan.vercel.app").rstrip("/")
ORBIT_KEY = os.environ.get("ORBIT_API_KEY", "")
DRY_RUN = os.environ.get("DRY_RUN", "1") != "0"
LIMIT = int(os.environ.get("LIMIT", "0") or "0")


def canon_phone(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    text = str(raw).strip()
    had_plus = text.startswith("+")
    digits = re.sub(r"\D", "", text)
    if len(digits) < 8:
        return None
    if had_plus:
        return f"+{digits}"
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return None


def normalize_email(raw: Optional[str]) -> Optional[str]:
    email = str(raw or "").strip().lower()
    if re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return email
    return None


def orbit_request(method: str, path: str, body: Optional[dict] = None) -> dict:
    if not ORBIT_KEY:
        raise RuntimeError("ORBIT_API_KEY missing")
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"{ORBIT_BASE}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {ORBIT_KEY}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise RuntimeError(f"{method} {path} -> {exc.code} {detail}") from exc


def fetch_all_persons() -> list[dict]:
    persons: list[dict] = []
    cursor = ""
    for _ in range(20):
        params = {"limit": "500"}
        if cursor:
            params["cursor"] = cursor
        data = orbit_request("GET", f"/api/v1/persons/enriched?{urllib.parse.urlencode(params)}")
        persons.extend(data.get("persons") or [])
        cursor = data.get("next_cursor") or ""
        if not cursor:
            break
    return persons


def read_contact_pairs() -> list[sqlite3.Row]:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        return list(con.execute(
            """
            select
              r.Z_PK as contact_id,
              coalesce(
                nullif(trim(coalesce(r.ZFIRSTNAME, '') || ' ' || coalesce(r.ZLASTNAME, '')), ''),
                r.ZORGANIZATION,
                r.ZNAME
              ) as name,
              p.ZFULLNUMBER as phone,
              e.ZADDRESS as email
            from ZABCDRECORD r
            join ZABCDPHONENUMBER p on p.ZOWNER = r.Z_PK
            join ZABCDEMAILADDRESS e on e.ZOWNER = r.Z_PK
            where p.ZFULLNUMBER is not null
              and e.ZADDRESS is not null
            """
        ))
    finally:
        con.close()


persons = fetch_all_persons()
by_phone: dict[str, list[dict]] = {}
for person in persons:
    for raw_phone in person.get("phones") or []:
        phone = canon_phone(raw_phone)
        if phone:
            by_phone.setdefault(phone, []).append(person)

candidates: dict[tuple[str, str], dict] = {}
ambiguous = 0
no_orbit_match = 0
invalid = 0
contact_pairs = read_contact_pairs()

for row in contact_pairs:
    phone = canon_phone(row["phone"])
    email = normalize_email(row["email"])
    if not phone or not email:
        invalid += 1
        continue
    matches = by_phone.get(phone, [])
    if not matches:
        no_orbit_match += 1
        continue
    if len(matches) > 1:
        ambiguous += 1
        continue
    person = matches[0]
    existing = {str(value).lower() for value in person.get("emails") or []}
    if email in existing:
        continue
    candidates[(person["id"], email)] = {
        "person_id": person["id"],
        "person_name": person.get("name"),
        "contact_name": row["name"],
        "phone": phone,
        "email": email,
    }

writes = list(candidates.values())
if LIMIT > 0:
    writes = writes[:LIMIT]

print(json.dumps({
    "dry_run": DRY_RUN,
    "persons": len(persons),
    "contact_pairs": len(contact_pairs),
    "candidate_writes": len(writes),
    "ambiguous": ambiguous,
    "no_orbit_match": no_orbit_match,
    "invalid": invalid,
    "sample": writes[:10],
}, indent=2))

if DRY_RUN:
    sys.exit(0)

inserted = 0
failed = 0
for row in writes:
    try:
        result = orbit_request("POST", "/api/v1/observation", {
            "person_id": row["person_id"],
            "email": row["email"],
            "source": "contacts_backfill_macos",
            "confidence": 1,
        })
        inserted += int((result.get("observation") or {}).get("inserted") or 0)
    except Exception as exc:
        failed += 1
        print(json.dumps({"error": str(exc), "row": row}), file=sys.stderr)

print(json.dumps({"posted": len(writes), "inserted": inserted, "failed": failed}, indent=2))
