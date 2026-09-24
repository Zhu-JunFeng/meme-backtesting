#!/usr/bin/env python3
"""Import XXYY K-lines for projects listed in a signal-detail XLSX workbook.

The workbook is treated strictly as data. The importer discovers the columns
named ``所属链`` and ``合约地址``, resolves each token through MemeInfo, fetches
closed XXYY 30-second and 1-minute candles for price and market cap, and upserts
them into ``public.meme_kline``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import http.client
import json
import os
import posixpath
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from threading import Event, Semaphore
from typing import Any, Callable, Iterator, Sequence
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET


LOOKUP_URL = "https://app.memeinfo.net/api/projects/lookup"
XXYY_URL = "https://www.xxyy.io/api/data/candlestick/searchBarData"
REQUIRED_COLUMNS = {
    "chain",
    "ca",
    "pair_id",
    "interval",
    "open_time",
    "close_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "trade_count",
    "type",
    "source",
    "raw_data",
    "created_at",
    "valid",
    "invalid_reason",
}
UNIQUE_KEY = ("chain", "pair_id", "interval", "open_time", "type")
COMBINATIONS = ((30, "30s", "price", "price"), (30, "30s", "mc", "mcap"),
                (60, "1m", "price", "price"), (60, "1m", "mc", "mcap"))
MAX_CANDLES_PER_WINDOW = 4_800
HISTORY_MS = 24 * 60 * 60 * 1000


def normalized_ca(chain: str, ca: str) -> str:
    return ca.strip().lower() if chain in {"robin", "bsc"} else ca.strip()


def sql_json(value: Any) -> str:
    return "'" + json.dumps(value, ensure_ascii=False, allow_nan=False).replace("'", "''") + "'::jsonb"


class ImporterError(RuntimeError):
    """A fatal import error."""


@dataclass(frozen=True)
class TokenRef:
    chain: str
    ca: str
    source_row: int


@dataclass(frozen=True)
class Project:
    chain: str
    ca: str
    pair_id: str
    created_ms: int


@dataclass(frozen=True)
class CandleRow:
    chain: str
    ca: str
    pair_id: str
    interval: str
    open_time: int
    close_time: int
    open: str
    high: str
    low: str
    close: str
    volume: str
    trade_count: int
    value_type: str
    source: str
    raw_data: str
    valid: bool
    invalid_reason: str | None


@dataclass
class ProjectResult:
    project: Project
    rows: list[CandleRow]
    discarded: int = 0
    invalid: int = 0
    errors: list[str] = field(default_factory=list)
    empty_combinations: list[str] = field(default_factory=list)


@dataclass
class Totals:
    imported_projects: int = 0
    failed_projects: int = 0
    inserted: int = 0
    updated: int = 0
    invalid: int = 0
    discarded: int = 0


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def column_number(reference: str) -> int:
    letters = "".join(character for character in reference if character.isalpha())
    if not letters:
        raise ValueError(f"invalid XLSX cell reference: {reference!r}")
    value = 0
    for character in letters.upper():
        value = value * 26 + ord(character) - ord("A") + 1
    return value - 1


def normalized_header(value: Any) -> str:
    return "".join(str(value or "").split())


def read_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return ["".join(node.text or "" for node in item.iter() if local_name(node.tag) == "t")
            for item in root if local_name(item.tag) == "si"]


def workbook_sheets(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    try:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    except KeyError as error:
        raise ImporterError(f"invalid XLSX workbook: missing {error.args[0]}") from error

    targets = {
        relation.attrib["Id"]: relation.attrib["Target"]
        for relation in relations
        if local_name(relation.tag) == "Relationship"
    }
    sheets: list[tuple[str, str]] = []
    for sheet in workbook.iter():
        if local_name(sheet.tag) != "sheet":
            continue
        relation_id = next((value for key, value in sheet.attrib.items() if local_name(key) == "id"), None)
        if not relation_id or relation_id not in targets:
            continue
        target = targets[relation_id]
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        sheets.append((sheet.attrib.get("name", path), path))
    if not sheets:
        raise ImporterError("invalid XLSX workbook: no worksheets found")
    return sheets


def cell_value(cell: ET.Element, shared_strings: Sequence[str]) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iter() if local_name(node.tag) == "t")
    value_node = next((node for node in cell if local_name(node.tag) == "v"), None)
    value = "" if value_node is None or value_node.text is None else value_node.text
    if cell_type == "s" and value:
        try:
            return shared_strings[int(value)]
        except (IndexError, ValueError) as error:
            raise ImporterError("invalid XLSX shared string index") from error
    return value


def iter_sheet_rows(archive: zipfile.ZipFile, sheet_path: str, shared_strings: Sequence[str]) -> Iterator[tuple[int, dict[int, str]]]:
    try:
        stream = archive.open(sheet_path)
    except KeyError as error:
        raise ImporterError(f"invalid XLSX workbook: missing worksheet {sheet_path}") from error
    with stream:
        for _, element in ET.iterparse(stream, events=("end",)):
            if local_name(element.tag) != "row":
                continue
            row_number = int(element.attrib.get("r", "0") or 0)
            values: dict[int, str] = {}
            next_column = 0
            for cell in element:
                if local_name(cell.tag) != "c":
                    continue
                reference = cell.attrib.get("r")
                index = column_number(reference) if reference else next_column
                values[index] = cell_value(cell, shared_strings)
                next_column = index + 1
            yield row_number, values
            element.clear()


def read_tokens(path: Path) -> list[TokenRef]:
    if path.suffix.lower() != ".xlsx":
        raise ImporterError("only .xlsx workbooks are supported")
    if not path.is_file():
        raise ImporterError(f"workbook does not exist: {path}")

    try:
        archive_context = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as error:
        raise ImporterError(f"cannot open XLSX workbook: {error}") from error

    unique: dict[tuple[str, str], TokenRef] = {}
    found = False
    with archive_context as archive:
        shared_strings = read_shared_strings(archive)
        for sheet_name, sheet_path in workbook_sheets(archive):
            header: tuple[int, int, int] | None = None
            tokens: list[TokenRef] = []
            for row_number, values in iter_sheet_rows(archive, sheet_path, shared_strings):
                if header is None:
                    names = {normalized_header(value): index for index, value in values.items()}
                    if "所属链" in names and "合约地址" in names:
                        header = (row_number, names["所属链"], names["合约地址"])
                    continue
                _, chain_column, ca_column = header
                chain = str(values.get(chain_column, "")).strip().lower()
                ca = normalized_ca(chain, str(values.get(ca_column, "")))
                if chain and ca:
                    tokens.append(TokenRef(chain=chain, ca=ca, source_row=row_number))
            if header is not None:
                found = True
                for token in tokens:
                    unique.setdefault((token.chain, token.ca), token)
    if unique:
        return list(unique.values())
    if found:
        raise ImporterError("workbook has headers but no usable project rows")
    raise ImporterError("no worksheet contains both 所属链 and 合约地址 columns")


def read_signals(path: Path, chains: set[str]) -> list[dict[str, Any]]:
    required = ["所属链", "合约地址", "触发时间戳（毫秒）", "触发时间（北京时间）",
                "信号名称", "信号代码", "信号来源", "信号ID", "明细ID"]
    events: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    found = False
    with zipfile.ZipFile(path) as archive:
        strings = read_shared_strings(archive)
        for sheet, location in workbook_sheets(archive):
            columns = None
            for row, values in iter_sheet_rows(archive, location, strings):
                if columns is None:
                    header = {str(v).strip(): k for k, v in values.items()}
                    if all(h in header for h in required):
                        columns, found = header, True
                    continue
                data = {h: values.get(columns[h], "").strip() for h in required}
                if not any(data.values()):
                    continue
                chain = data["所属链"].lower()
                if chains and chain not in chains:
                    continue
                ca = normalized_ca(chain, data["合约地址"])
                raw = data["触发时间戳（毫秒）"]
                signal_code = data["信号代码"]
                if (not chain or not ca or not data["明细ID"]
                        or signal_code not in {"fomo_new_project", "fomo_new_project_expanded"}
                        or not raw.isdigit() or not 946684800000 <= int(raw) < 4102444800000):
                    raise ImporterError(f"{sheet}/{row}: invalid signal identity/time")
                ms = int(raw)
                expected = datetime.fromtimestamp(ms // 1000, timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
                if data["触发时间（北京时间）"] != expected:
                    raise ImporterError(f"{sheet}/{row}: signal timestamp/Beijing time mismatch")
                event = dict(chain=chain, ca=ca, signal_source=signal_code, detail_id=data["明细ID"],
                             signal_time=ms, source_signal=dict(name=data["信号名称"], code=data["信号代码"],
                             signalId=data["信号ID"], detailId=data["明细ID"], upstreamSource=data["信号来源"]))
                key = (chain, ca, signal_code, data["明细ID"])
                if key in events and {k: v for k, v in events[key].items() if k != "provenance"} != event:
                    raise ImporterError(f"conflicting signal detail: {key}")
                events.setdefault(key, {**event, "provenance": []})
                provenance = dict(file=path.name, sha256=digest, sheet=sheet, row=row)
                if provenance not in events[key]["provenance"]:
                    events[key]["provenance"].append(provenance)
    if not found:
        raise ImporterError("missing complete signal headers; three-table import requires signal identities and timestamps")
    return list(events.values())


def signal_relation(events: Sequence[dict[str, Any]]) -> str:
    return f"jsonb_to_recordset({sql_json(list(events))}) AS s(chain text, ca text, signal_source text, detail_id text, signal_time bigint, source_signal jsonb, provenance jsonb)"


def preflight_signals(database_url: str, events: Sequence[dict[str, Any]]) -> None:
    for table, columns, key in [
        ("token_info", {"id", "chain", "ca", "pair", "signal_source", "source_signal", "signal_time", "created_at"}, "chain,ca,pair"),
        ("token_signal_events", {"id", "chain", "ca", "signal_source", "source_signal", "signal_time", "detail_id", "provenance", "created_at"}, "chain,ca,signal_source,detail_id"),
    ]:
        output = run_psql(database_url, f"""BEGIN READ ONLY;
SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}';
SELECT 'INDEX|' || string_agg(a.attname, ',' ORDER BY k.n)
FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,n)
JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
WHERE i.indrelid=to_regclass('public.{table}') AND i.indisunique AND i.indisvalid AND i.indpred IS NULL GROUP BY i.indexrelid;
COMMIT;""")
        lines = set(output.splitlines())
        if columns - lines or f"INDEX|{key}" not in lines:
            raise ImporterError(f"public.{table}: incompatible columns/unique key; apply existing migration 008 first")
    for batch in chunks(events, 200):
        conflicts = run_psql(database_url, f"""BEGIN READ ONLY;
SELECT s.chain || ':' || s.ca || ':' || s.detail_id FROM {signal_relation(batch)}
JOIN public.token_signal_events t USING(chain,ca,signal_source,detail_id)
WHERE t.signal_time IS DISTINCT FROM s.signal_time OR t.source_signal IS DISTINCT FROM s.source_signal;
COMMIT;""").strip()
        if conflicts:
            raise ImporterError(f"existing signal conflict (no writes performed): {conflicts}")


def metadata_sql(project: Project, events: Sequence[dict[str, Any]]) -> str:
    if not events or any((e["chain"], e["ca"]) != (project.chain, project.ca) for e in events):
        raise ImporterError("project signal metadata missing or mismatched")
    identity = sql_json(dict(chain=project.chain, ca=project.ca, pair=project.pair_id))
    signal_source = "'" + events[0]["signal_source"].replace("'", "''") + "'"
    return f"""
SELECT pg_advisory_xact_lock(hashtextextended(({identity}->>'chain') || ':' || ({identity}->>'ca'), 0));
CREATE TEMP TABLE import_signals ON COMMIT DROP AS SELECT * FROM {signal_relation(events)};
DO $guard$ BEGIN
IF EXISTS (SELECT 1 FROM import_signals s JOIN public.token_signal_events t USING(chain,ca,signal_source,detail_id)
WHERE t.signal_time IS DISTINCT FROM s.signal_time OR t.source_signal IS DISTINCT FROM s.source_signal)
THEN RAISE EXCEPTION 'conflicting signal metadata'; END IF;
END $guard$;
WITH saved AS (
INSERT INTO public.token_signal_events(chain,ca,signal_source,detail_id,signal_time,source_signal,provenance)
SELECT chain,ca,signal_source,detail_id,signal_time,source_signal,provenance FROM import_signals
ON CONFLICT(chain,ca,signal_source,detail_id) DO UPDATE SET provenance=(
 SELECT coalesce(jsonb_agg(DISTINCT p),'[]'::jsonb)
 FROM jsonb_array_elements(token_signal_events.provenance || EXCLUDED.provenance) p)
RETURNING (xmax=0) AS inserted)
SELECT 'SIGNALS|' || count(*) FILTER(WHERE inserted) || '|' || count(*) FILTER(WHERE NOT inserted) FROM saved;
INSERT INTO public.token_info(chain,ca,pair,signal_source)
VALUES ({identity}->>'chain', {identity}->>'ca', {identity}->>'pair', {signal_source})
ON CONFLICT(chain,ca,pair) DO NOTHING;
WITH first_signal AS (
 SELECT chain,ca,signal_source,signal_time,source_signal FROM public.token_signal_events
 WHERE chain={identity}->>'chain' AND ca={identity}->>'ca'
 ORDER BY signal_time,detail_id LIMIT 1)
UPDATE public.token_info t SET signal_source=s.signal_source, signal_time=s.signal_time, source_signal=s.source_signal
FROM first_signal s WHERE t.chain=s.chain AND t.ca=s.ca AND (t.signal_time IS NULL OR s.signal_time<=t.signal_time);
"""


def request_json(url: str, payload: dict[str, Any], headers: dict[str, str], timeout: float, retries: int) -> dict[str, Any]:
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        request = urllib.request.Request(url, data=encoded, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.load(response)
            if not isinstance(result, dict):
                raise ValueError("response is not a JSON object")
            return result
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException,
                json.JSONDecodeError, ValueError) as error:
            last_error = error
            if attempt == retries:
                break
            time.sleep(2 ** attempt)
    raise RuntimeError(f"request failed after {retries + 1} attempts: {last_error}") from last_error


def chunks(items: Sequence[Any], size: int) -> Iterator[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def parse_timestamp_ms(value: Any) -> int:
    try:
        timestamp = int(float(str(value)))
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("invalid timestamp") from error
    if timestamp < 100_000_000_000:
        timestamp *= 1_000
    if timestamp <= 0:
        raise ValueError("timestamp must be positive")
    return timestamp


def lookup_projects(
    tokens: Sequence[TokenRef],
    now_ms: int,
    batch_size: int,
    timeout: float,
    retries: int,
    requester: Callable[[str, dict[str, Any], dict[str, str], float, int], dict[str, Any]] = request_json,
) -> tuple[list[Project], list[tuple[TokenRef, str]]]:
    projects: list[Project] = []
    skipped: list[tuple[TokenRef, str]] = []
    headers = {
        "User-Agent": "Apifox/1.0.0 (https://apifox.com)",
        "Content-Type": "application/json",
        "Accept": "*/*",
    }
    for batch in chunks(tokens, batch_size):
        try:
            response = requester(LOOKUP_URL, {"caList": [token.ca for token in batch], "symbolList": [""]}, headers, timeout, retries)
            if response.get("success") is False or str(response.get("code", "200")) != "200":
                raise RuntimeError(str(response.get("message") or response.get("msg") or "lookup API error"))
            candidates = ((response.get("data") or {}).get("caListTokenList") or [])
            by_key: dict[tuple[str, str], dict[str, Any]] = {}
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                chain = str(candidate.get("chain") or "").strip().lower()
                key = (chain, normalized_ca(chain, str(candidate.get("token_address") or "")))
                if all(key):
                    by_key.setdefault(key, candidate)
        except Exception as error:  # Batch-level network/API failure is non-fatal.
            skipped.extend((token, f"lookup failed: {error}") for token in batch)
            continue

        for token in batch:
            candidate = by_key.get((token.chain, token.ca))
            if candidate is None:
                skipped.append((token, "no exact chain + CA lookup match"))
                continue
            pair_id = str(candidate.get("main_pair_id") or "").strip()
            if not pair_id:
                skipped.append((token, "lookup result has no main_pair_id"))
                continue
            raw_created = candidate.get("token_create_time")
            if raw_created in (None, ""):
                raw_created = (candidate.get("project_meta") or {}).get("create_time")
            try:
                created_ms = parse_timestamp_ms(raw_created)
            except ValueError:
                skipped.append((token, "lookup result has no valid creation time"))
                continue
            if created_ms > now_ms:
                skipped.append((token, "project creation time is in the future"))
                continue
            projects.append(Project(token.chain, token.ca, pair_id, created_ms))
    return projects, skipped


def aligned_start(timestamp_ms: int, interval_seconds: int) -> int:
    interval_ms = interval_seconds * 1_000
    return timestamp_ms - timestamp_ms % interval_ms


def recent_projects(projects: Sequence[Project], now_ms: int, days: int) -> tuple[list[Project], list[Project]]:
    cutoff = now_ms - days * HISTORY_MS
    return ([p for p in projects if cutoff <= p.created_ms <= now_ms],
            [p for p in projects if not cutoff <= p.created_ms <= now_ms])


def closed_cutoff(now_ms: int, interval_seconds: int) -> int:
    return aligned_start(now_ms, interval_seconds)


def time_windows(start_ms: int, cutoff_ms: int, interval_seconds: int) -> Iterator[tuple[int, int]]:
    cursor = aligned_start(start_ms, interval_seconds)
    window_ms = interval_seconds * 1_000 * MAX_CANDLES_PER_WINDOW
    while cursor < cutoff_ms:
        end = min(cursor + window_ms, cutoff_ms)
        yield cursor, end
        cursor = end


def decimal_value(value: Any) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as error:
        raise ValueError("not numeric") from error
    if not result.is_finite():
        raise ValueError("not finite")
    return result


def decimal_text(value: Decimal) -> str:
    return format(value, "f")


def candle_row(project: Project, interval_seconds: int, interval_name: str, value_type: str,
               candle: dict[str, Any], start_ms: int, cutoff_ms: int) -> CandleRow | None:
    try:
        open_time = int(candle["time"])
        price = candle["price"]
        if not isinstance(price, dict):
            return None
        open_value = decimal_value(price["open"])
        high_value = decimal_value(price["high"])
        low_value = decimal_value(price["low"])
        close_value = decimal_value(price["close"])
        volume_value = decimal_value(price["volume"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return None

    interval_ms = interval_seconds * 1_000
    if open_time < aligned_start(start_ms, interval_seconds) or open_time + interval_ms > cutoff_ms:
        return None

    reasons: list[str] = []
    if open_time % interval_ms:
        reasons.append("unaligned_time")
    if min(open_value, high_value, low_value, close_value) < 0:
        reasons.append("negative_ohlc")
    if volume_value < 0:
        reasons.append("negative_volume")
    if high_value < max(open_value, low_value, close_value) or low_value > min(open_value, high_value, close_value):
        reasons.append("invalid_ohlc")

    raw_data = json.dumps(candle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return CandleRow(
        chain=project.chain,
        ca=project.ca,
        pair_id=project.pair_id,
        interval=interval_name,
        open_time=open_time,
        close_time=open_time + interval_ms,
        open=decimal_text(open_value),
        high=decimal_text(high_value),
        low=decimal_text(low_value),
        close=decimal_text(close_value),
        volume=decimal_text(volume_value),
        trade_count=0,
        value_type=value_type,
        source="xxyy",
        raw_data=raw_data,
        valid=not reasons,
        invalid_reason=",".join(reasons) if reasons else None,
    )


def fetch_xxyy_window(project: Project, interval_seconds: int, request_type: str, start_ms: int,
                      end_ms: int, timeout: float, retries: int,
                      requester: Callable[[str, dict[str, Any], dict[str, str], float, int], dict[str, Any]]) -> list[dict[str, Any]]:
    response = requester(
        XXYY_URL,
        {"pairId": project.pair_id, "valueType": request_type, "interval": interval_seconds,
         "priceType": "usd", "from": start_ms, "to": end_ms, "countBack": 5_000},
        {"X-CHAIN": project.chain, "X-VERSION": "1", "X-LANGUAGE": "zh", "Content-Type": "application/json"},
        timeout,
        retries,
    )
    if response.get("code") != 0:
        raise RuntimeError(str(response.get("msg") or response.get("message") or "XXYY API error"))
    data = response.get("data") or []
    if not isinstance(data, list):
        raise RuntimeError("XXYY data is not a list")
    return [item for item in data if isinstance(item, dict)]


def fetch_project(project: Project, now_ms: int, timeout: float, retries: int,
                  requester: Callable[[str, dict[str, Any], dict[str, str], float, int], dict[str, Any]] = request_json) -> ProjectResult:
    rows: dict[tuple[str, str, int], CandleRow] = {}
    discarded = 0
    errors, empty = [], []
    for interval_seconds, interval_name, request_type, stored_type in COMBINATIONS:
        cutoff = closed_cutoff(min(now_ms, project.created_ms + HISTORY_MS), interval_seconds)
        before = len(rows)
        for start_ms, end_ms in time_windows(project.created_ms, cutoff, interval_seconds):
            try:
                candles = fetch_xxyy_window(project, interval_seconds, request_type, start_ms, end_ms,
                                            timeout, retries, requester)
            except Exception as error:
                errors.append(f"{interval_name}/{stored_type}: {error}")
                continue
            for candle in candles:
                row = candle_row(project, interval_seconds, interval_name, stored_type, candle,
                                 project.created_ms, cutoff)
                if row is None:
                    discarded += 1
                    continue
                rows[(row.interval, row.value_type, row.open_time)] = row
        if len(rows) == before:
            empty.append(f"{interval_name}/{stored_type}")
    values = sorted(rows.values(), key=lambda row: (row.interval, row.value_type, row.open_time))
    return ProjectResult(project=project, rows=values, discarded=discarded,
                         invalid=sum(not row.valid for row in values), errors=errors, empty_combinations=empty)


def safe_database_target(database_url: str) -> str:
    parsed = urlsplit(database_url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        return "PostgreSQL target (connection string redacted)"
    host = parsed.hostname or "localhost"
    port = f":{parsed.port}" if parsed.port else ""
    database = parsed.path.lstrip("/") or "(default)"
    return f"{host}{port}/{database}"


def retryable_psql_error(detail: str) -> bool:
    lowered = detail.lower()
    return any(fragment in lowered for fragment in (
        "timeout expired",
        "could not connect",
        "connection to server",
        "server closed the connection",
        "ssl syscall error",
        "connection reset by peer",
        "protocol synchronization was lost",
        "unexpected eof on client connection",
    ))


def run_psql(database_url: str, sql: str, *, field_separator: str | None = None,
             connection_retries: int = 3, retry_events: list[int] | None = None) -> str:
    executable = shutil.which("psql")
    if executable is None:
        raise ImporterError("psql is required but was not found in PATH")
    command = [executable, database_url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]
    if field_separator is not None:
        command.extend(["-F", field_separator])
    environment = os.environ.copy()
    environment["PGOPTIONS"] = "-c standard_conforming_strings=on -c statement_timeout=120000 -c lock_timeout=30000"
    environment.setdefault("PGCONNECT_TIMEOUT", "10")
    completed: subprocess.CompletedProcess[str] | None = None
    for attempt in range(connection_retries + 1):
        completed = subprocess.run(command, input=sql, text=True, capture_output=True, env=environment)
        if not completed.returncode:
            return completed.stdout
        detail = (completed.stderr or completed.stdout or "unknown psql error").strip()[-1_500:]
        if attempt == connection_retries or not retryable_psql_error(detail):
            break
        if retry_events is not None:
            retry_events.append(attempt + 1)
        delay = min(30, 2 ** attempt)
        print(f"[WARN] PostgreSQL connection interrupted; reconnect/replay {attempt + 1}/{connection_retries} in {delay}s", file=sys.stderr)
        time.sleep(delay)
    assert completed is not None
    if completed.returncode:
        detail = (completed.stderr or completed.stdout or "unknown psql error").strip()[-1_500:]
        raise ImporterError(f"PostgreSQL command failed: {detail}")
    return completed.stdout


def preflight_database(database_url: str) -> None:
    sql = """
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'meme_kline'
ORDER BY column_name;
SELECT 'INDEX|' || string_agg(a.attname, ',' ORDER BY keys.ordinality)
FROM pg_index i
CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS keys(attnum, ordinality)
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = keys.attnum
WHERE i.indrelid = to_regclass('public.meme_kline') AND i.indisunique
GROUP BY i.indexrelid;
"""
    output = run_psql(database_url, sql)
    columns = {line for line in output.splitlines() if line and not line.startswith("INDEX|")}
    missing = sorted(REQUIRED_COLUMNS - columns)
    if missing:
        raise ImporterError(f"public.meme_kline is missing required columns: {', '.join(missing)}")
    indexes = {tuple(line.removeprefix("INDEX|").split(",")) for line in output.splitlines() if line.startswith("INDEX|")}
    if UNIQUE_KEY not in indexes:
        raise ImporterError("public.meme_kline lacks the required unique key (chain, pair_id, interval, open_time, type)")


def copy_field(value: Any) -> Any:
    return r"\N" if value is None else value


def write_csv_rows(stream: Any, rows: Sequence[CandleRow]) -> None:
    writer = csv.writer(stream, lineterminator="\n")
    for row in rows:
        writer.writerow([
            row.chain, row.ca, row.pair_id, row.interval, row.open_time, row.close_time,
            row.open, row.high, row.low, row.close, row.volume, row.trade_count,
            row.value_type, row.source, row.raw_data, "true" if row.valid else "false",
            copy_field(row.invalid_reason),
        ])


def build_upsert_sql(csv_path: Path, metadata: str = "") -> str:
    path_text = str(csv_path)
    if "\n" in path_text or "\r" in path_text or "'" in path_text:
        raise ImporterError("temporary CSV path contains unsupported characters")
    return rf"""BEGIN;
{metadata}
CREATE TEMP TABLE import_meme_kline (
  chain varchar, ca varchar, pair_id varchar, interval varchar,
  open_time bigint, close_time bigint, open numeric, high numeric, low numeric,
  close numeric, volume numeric, trade_count bigint, type varchar, source varchar,
  raw_data jsonb, valid boolean, invalid_reason text
) ON COMMIT DROP;
\copy import_meme_kline (chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,trade_count,type,source,raw_data,valid,invalid_reason) FROM '{path_text}' WITH (FORMAT csv, NULL '\N')
WITH upserted AS (
  INSERT INTO public.meme_kline
    (chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,trade_count,type,source,raw_data,valid,invalid_reason)
  SELECT chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,trade_count,type,source,raw_data,valid,invalid_reason
  FROM import_meme_kline
  ON CONFLICT (chain,pair_id,interval,open_time,type) DO UPDATE SET
    ca=EXCLUDED.ca, close_time=EXCLUDED.close_time, open=EXCLUDED.open,
    high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close,
    volume=EXCLUDED.volume, trade_count=EXCLUDED.trade_count,
    source=EXCLUDED.source, raw_data=EXCLUDED.raw_data,
    valid=EXCLUDED.valid, invalid_reason=EXCLUDED.invalid_reason
  RETURNING (xmax = 0) AS inserted
)
SELECT 'RESULT|' || count(*) FILTER (WHERE inserted) || '|' || count(*) FILTER (WHERE NOT inserted)
FROM upserted;
COMMIT;
"""


def write_rows(database_url: str, rows: Sequence[CandleRow], batch_size: int = 1_000,
               metadata: str = "", signal_counts: list[int] | None = None,
               connection_retries: int = 5, retry_events: list[int] | None = None) -> tuple[int, int]:
    inserted = 0
    updated = 0
    for batch in (list(chunks(rows, batch_size)) or ([[]] if metadata else [])):
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", suffix=".csv", delete=False) as temporary:
                temporary_path = Path(temporary.name)
                write_csv_rows(temporary, batch)
            # A fresh psql process replays the same complete three-table transaction.
            # Unique keys and metadata UPSERT make even a lost COMMIT reply safe.
            output = run_psql(database_url, build_upsert_sql(temporary_path, metadata),
                              connection_retries=connection_retries, retry_events=retry_events)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
        result = next((line for line in output.splitlines() if line.startswith("RESULT|")), None)
        if result is None:
            raise ImporterError("PostgreSQL upsert did not return row counts")
        _, inserted_text, updated_text = result.split("|", 2)
        inserted += int(inserted_text)
        updated += int(updated_text)
        signal_result = next((line for line in output.splitlines() if line.startswith("SIGNALS|")), None)
        if signal_counts is not None and signal_result:
            _, new, duplicate = signal_result.split("|")
            signal_counts[0] += int(new)
            signal_counts[1] += int(duplicate)
    return inserted, updated


def utc_text(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1_000, timezone.utc).isoformat(timespec="seconds")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path, help="XLSX workbook containing 所属链 and 合约地址 columns")
    parser.add_argument("--dry-run", action="store_true", help="parse, lookup, and validate the database without writing")
    parser.add_argument("--yes", action="store_true", help="skip the IMPORT confirmation; use only with explicit authorization")
    parser.add_argument("--workers", type=int, default=8, help="concurrent project download threads (default: 8)")
    parser.add_argument("--db-writers", type=int, help="maximum concurrent PostgreSQL writers (default: up to 2)")
    parser.add_argument("--timeout", type=float, default=30, help="HTTP timeout in seconds (default: 30)")
    parser.add_argument("--retries", type=int, default=3, help="HTTP retries after the first attempt (default: 3)")
    parser.add_argument("--db-retries", type=int, default=5, help="bounded connection retries per write batch (default: 5)")
    parser.add_argument("--db-batch-size", type=int, default=1000, help="candles per atomic three-table write (default: 1000)")
    parser.add_argument("--lookup-batch-size", type=int, default=50, help="CAs per MemeInfo lookup request (default: 50)")
    parser.add_argument("--chains", default="", help="comma-separated chain allowlist, e.g. sol,robin,bsc")
    parser.add_argument("--created-within-days", type=int, default=30, help="only projects created within this many rolling days (default: 30)")
    parser.add_argument("--report", type=Path, help="append per-project audit results as JSONL (no credentials)")
    parser.add_argument("--resume-report", type=Path, help="resume a verified previous report, retaining its fixed cutoff and committed projects")
    return parser


def run(args: argparse.Namespace) -> int:
    args.db_retries = getattr(args, "db_retries", 5)
    args.db_batch_size = getattr(args, "db_batch_size", 1000)
    if args.workers < 1 or args.workers > 32:
        raise ImporterError("--workers must be between 1 and 32")
    configured_writers = getattr(args, "db_writers", None)
    db_writers = min(2, args.workers) if configured_writers is None else configured_writers
    if not 1 <= db_writers <= args.workers:
        raise ImporterError("--db-writers must be between 1 and --workers")
    if args.timeout <= 0 or args.retries < 0 or not 1 <= args.lookup_batch_size <= 200:
        raise ImporterError("invalid timeout, retry, or lookup batch-size option")
    if not 0 <= args.db_retries <= 10 or not 1 <= args.db_batch_size <= 20000:
        raise ImporterError("--db-retries must be 0..10; --db-batch-size must be 1..20000")
    created_days = getattr(args, "created_within_days", 30)
    if created_days < 1:
        raise ImporterError("--created-within-days must be positive")
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise ImporterError("DATABASE_URL is required")

    now_ms = int(time.time() * 1_000)
    resumed: dict[tuple[str, str, str], dict[str, Any]] = {}
    resume_path = getattr(args, "resume_report", None)
    if resume_path:
        if getattr(args, "report", None) and resume_path.resolve() == args.report.resolve():
            raise ImporterError("resume report and output report must differ")
        records = [json.loads(line) for line in resume_path.read_text().splitlines() if line.strip()]
        start = next((r for r in records if r.get("kind") == "start"), None)
        if not start or Path(start["workbook"]).resolve() != args.workbook.resolve() or start.get("created_within_days") != created_days:
            raise ImporterError("resume workbook or age filter differs")
        workbook_hash = hashlib.sha256(args.workbook.read_bytes()).hexdigest()
        if start.get("workbook_hash") and start["workbook_hash"] != workbook_hash:
            raise ImporterError("resume workbook checksum differs")
        now_ms = start["now_ms"]
        resumed = {(r["chain"], r["ca"], r["pair_id"]): r for r in records
                   if r.get("kind") == "project" and r.get("status") in {"success", "partial", "no_data"} and not r.get("errors")}
    tokens = read_tokens(args.workbook.resolve())
    chains = {c.strip().lower() for c in getattr(args, "chains", "").split(",") if c.strip()}
    tokens = [t for t in tokens if not chains or t.chain in chains]
    events = read_signals(args.workbook.resolve(), chains)
    by_token: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for event in events:
        by_token.setdefault((event["chain"], event["ca"]), []).append(event)
    if any((t.chain, t.ca) not in by_token for t in tokens):
        raise ImporterError("selected CA missing valid signal metadata")
    print(f"已解析项目：{len(tokens)} 个唯一 chain + CA")
    projects, skipped = lookup_projects(tokens, now_ms, args.lookup_batch_size, args.timeout, args.retries)
    token_keys = {(t.chain, t.ca) for t in tokens}
    project_map = {(p.chain, p.ca): p for p in projects}
    for previous in resumed.values():
        key = (previous["chain"], previous["ca"])
        if key in token_keys:
            project_map[key] = Project(previous["chain"], previous["ca"], previous["pair_id"], previous["created_ms"])
    projects = list(project_map.values())
    skipped = [(t, reason) for t, reason in skipped if (t.chain, t.ca) not in project_map]
    projects, outside_age = recent_projects(projects, now_ms, created_days)
    selected_keys = {(p.chain, p.ca) for p in projects}
    events = [e for e in events if (e["chain"], e["ca"]) in selected_keys]
    for token, reason in skipped:
        print(f"[WARN] 跳过 {token.chain}:{token.ca}（Excel 第 {token.source_row} 行）：{reason}", file=sys.stderr)

    preflight_database(database_url)
    preflight_signals(database_url, events)
    print(f"Lookup 匹配：{len(projects)}；跳过：{len(skipped)}")
    print(f"创建时间筛选：最近 {created_days} 天（{utc_text(now_ms-created_days*HISTORY_MS)} 起）；超出范围 {len(outside_age)} 个")
    print(f"数据库目标：{safe_database_target(database_url)} / public.meme_kline")
    if projects:
        print(f"创建时间范围：{utc_text(min(project.created_ms for project in projects))} 至 {utc_text(max(project.created_ms for project in projects))}")
    print(f"K线组合：30s/1m × price/mcap；创建后24h，仅保存已收盘K线；理论上限 {len(projects)*8640:,} 行")
    print(f"同步 token_info + token_signal_events：文件唯一信号 {len(events)}")
    print(f"并发：{args.workers} 个下载线程，最多 {db_writers} 个数据库写入线程")

    if args.dry_run:
        print("Dry run 完成：未请求 XXYY K 线，未写入数据库。")
        return 0
    if not projects:
        print("没有可导入的项目。")
        return 0
    if not args.yes:
        answer = input("输入 IMPORT 确认开始抓取并写入数据库：").strip()
        if answer != "IMPORT":
            print("已取消，未请求 XXYY K 线，未写入数据库。")
            return 0

    totals = Totals()
    chain_totals: dict[str, dict[str, int]] = {}
    report_path = getattr(args, "report", None)
    write_slots = Semaphore(db_writers)
    stopping = Event()

    def record(item: dict[str, Any]) -> None:
        if report_path:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            with report_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(item, ensure_ascii=False) + "\n")

    record(dict(kind="start", workbook=str(args.workbook), now_ms=now_ms, projects=len(projects),
                selected=len(tokens), created_within_days=created_days, database=safe_database_target(database_url),
                workbook_hash=hashlib.sha256(args.workbook.read_bytes()).hexdigest(), resume_report=str(resume_path) if resume_path else None,
                db_retries=args.db_retries, db_batch_size=args.db_batch_size,
                chains=sorted(chains), workers=args.workers, db_writers=db_writers))
    for project in outside_age:
        record(dict(kind="creation_excluded", **asdict(project), reason=f"created outside last {created_days} days"))
    for token, reason in skipped:
        record(dict(kind="lookup_skipped", **asdict(token), reason=reason))

    def import_project(project: Project) -> dict[str, Any]:
        previous = resumed.get((project.chain, project.ca, project.pair_id))
        if previous and previous["created_ms"] == project.created_ms:
            return {**previous, "resumed": True}
        result = fetch_project(project, now_ms, args.timeout, args.retries)
        if stopping.is_set():
            raise ImporterError("import stopped after a global failure")
        signals = [0, 0]
        retry_events: list[int] = []
        with write_slots:
            if stopping.is_set():
                raise ImporterError("import stopped after a global failure")
            inserted, updated = write_rows(database_url, result.rows, batch_size=args.db_batch_size,
                metadata=metadata_sql(project, by_token[(project.chain, project.ca)]), signal_counts=signals,
                connection_retries=args.db_retries, retry_events=retry_events)
        status = ("failed" if not result.rows and result.errors else "no_data" if not result.rows
                  else "partial" if result.errors or result.empty_combinations or result.invalid or result.discarded else "success")
        return dict(kind="project", **asdict(project), status=status, inserted=inserted, updated=updated,
                    signal_inserted=signals[0], signal_duplicates=signals[1], invalid=result.invalid,
                    discarded=result.discarded, errors=result.errors, empty=result.empty_combinations,
                    db_reconnects=len(retry_events), write_counts_may_include_replay=bool(retry_events),
                    cutoff_ms=min(now_ms, project.created_ms + HISTORY_MS),
                    age_under_24h=now_ms < project.created_ms + HISTORY_MS)

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        remaining = iter(projects)
        futures: dict[Any, Project] = {}

        def submit_next() -> None:
            try:
                project = next(remaining)
            except StopIteration:
                return
            futures[executor.submit(import_project, project)] = project

        for _ in range(min(len(projects), args.workers * 2)):
            submit_next()
        while futures:
            completed, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in completed:
                project = futures.pop(future)
                try:
                    result = future.result()
                except ImporterError:
                    stopping.set()
                    for pending in futures:
                        pending.cancel()
                    raise
                except Exception as error:
                    totals.failed_projects += 1
                    print(f"[WARN] 跳过 {project.chain}:{project.ca}：{error}", file=sys.stderr)
                    record(dict(kind="project", **asdict(project), status="failed", error=str(error)))
                    summary = chain_totals.setdefault(project.chain, {})
                    summary["failed"] = summary.get("failed", 0) + 1
                    submit_next()
                    continue
                record(result)
                summary = chain_totals.setdefault(project.chain, {})
                summary[result["status"]] = summary.get(result["status"], 0) + 1
                for key in ["inserted", "updated", "signal_inserted", "signal_duplicates", "invalid", "discarded"]:
                    summary[key] = summary.get(key, 0) + result[key]
                totals.inserted += result["inserted"]
                totals.updated += result["updated"]
                totals.imported_projects += 1
                totals.invalid += result["invalid"]
                totals.discarded += result["discarded"]
                print(f"[{totals.imported_projects}/{len(projects)}] {project.chain}:{project.ca} "
                      f"{result['status']} 新增 {result['inserted']} 更新 {result['updated']}", flush=True)
                submit_next()

    print("导入完成："
          f"处理项目 {totals.imported_projects}，异常项目 {totals.failed_projects}，"
          f"插入 {totals.inserted}，更新 {totals.updated}，"
          f"标记无效 {totals.invalid}，丢弃窗口外或不完整 {totals.discarded}。")
    record(dict(kind="summary", chains=chain_totals, totals=asdict(totals)))
    print(json.dumps(chain_totals, ensure_ascii=False))
    return 0


def main() -> int:
    parser = build_parser()
    try:
        return run(parser.parse_args())
    except ImporterError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("已中断。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
