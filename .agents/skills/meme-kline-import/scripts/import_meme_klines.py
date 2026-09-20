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
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
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
                ca = str(values.get(ca_column, "")).strip()
                if chain and ca:
                    tokens.append(TokenRef(chain=chain, ca=ca, source_row=row_number))
            if header is not None:
                unique: dict[tuple[str, str], TokenRef] = {}
                for token in tokens:
                    unique.setdefault((token.chain, token.ca), token)
                if not unique:
                    raise ImporterError(f"worksheet {sheet_name!r} has headers but no usable project rows")
                return list(unique.values())
    raise ImporterError("no worksheet contains both 所属链 and 合约地址 columns")


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
                key = (str(candidate.get("chain") or "").strip().lower(),
                       str(candidate.get("token_address") or "").strip())
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
    for interval_seconds, interval_name, request_type, stored_type in COMBINATIONS:
        cutoff = closed_cutoff(now_ms, interval_seconds)
        for start_ms, end_ms in time_windows(project.created_ms, cutoff, interval_seconds):
            candles = fetch_xxyy_window(project, interval_seconds, request_type, start_ms, end_ms,
                                        timeout, retries, requester)
            for candle in candles:
                row = candle_row(project, interval_seconds, interval_name, stored_type, candle,
                                 project.created_ms, cutoff)
                if row is None:
                    discarded += 1
                    continue
                rows[(row.interval, row.value_type, row.open_time)] = row
    values = sorted(rows.values(), key=lambda row: (row.interval, row.value_type, row.open_time))
    return ProjectResult(project=project, rows=values, discarded=discarded,
                         invalid=sum(not row.valid for row in values))


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
    ))


def run_psql(database_url: str, sql: str, *, field_separator: str | None = None,
             connection_retries: int = 3) -> str:
    executable = shutil.which("psql")
    if executable is None:
        raise ImporterError("psql is required but was not found in PATH")
    command = [executable, database_url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]
    if field_separator is not None:
        command.extend(["-F", field_separator])
    environment = os.environ.copy()
    environment.setdefault("PGCONNECT_TIMEOUT", "10")
    completed: subprocess.CompletedProcess[str] | None = None
    for attempt in range(connection_retries + 1):
        completed = subprocess.run(command, input=sql, text=True, capture_output=True, env=environment)
        if not completed.returncode:
            return completed.stdout
        detail = (completed.stderr or completed.stdout or "unknown psql error").strip()[-1_500:]
        if attempt == connection_retries or not retryable_psql_error(detail):
            break
        time.sleep(2 ** attempt)
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


def build_upsert_sql(csv_path: Path) -> str:
    path_text = str(csv_path)
    if "\n" in path_text or "\r" in path_text or "'" in path_text:
        raise ImporterError("temporary CSV path contains unsupported characters")
    return rf"""BEGIN;
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


def write_rows(database_url: str, rows: Sequence[CandleRow], batch_size: int = 20_000) -> tuple[int, int]:
    inserted = 0
    updated = 0
    for batch in chunks(rows, batch_size):
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", suffix=".csv", delete=False) as temporary:
                temporary_path = Path(temporary.name)
                write_csv_rows(temporary, batch)
            output = run_psql(database_url, build_upsert_sql(temporary_path))
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
        result = next((line for line in output.splitlines() if line.startswith("RESULT|")), None)
        if result is None:
            raise ImporterError("PostgreSQL upsert did not return row counts")
        _, inserted_text, updated_text = result.split("|", 2)
        inserted += int(inserted_text)
        updated += int(updated_text)
    return inserted, updated


def utc_text(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1_000, timezone.utc).isoformat(timespec="seconds")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path, help="XLSX workbook containing 所属链 and 合约地址 columns")
    parser.add_argument("--dry-run", action="store_true", help="parse, lookup, and validate the database without writing")
    parser.add_argument("--yes", action="store_true", help="skip the IMPORT confirmation; use only with explicit authorization")
    parser.add_argument("--workers", type=int, default=4, help="number of concurrent project fetches (default: 4)")
    parser.add_argument("--timeout", type=float, default=30, help="HTTP timeout in seconds (default: 30)")
    parser.add_argument("--retries", type=int, default=3, help="HTTP retries after the first attempt (default: 3)")
    parser.add_argument("--lookup-batch-size", type=int, default=50, help="CAs per MemeInfo lookup request (default: 50)")
    return parser


def run(args: argparse.Namespace) -> int:
    if args.workers < 1 or args.workers > 32:
        raise ImporterError("--workers must be between 1 and 32")
    if args.timeout <= 0 or args.retries < 0 or not 1 <= args.lookup_batch_size <= 200:
        raise ImporterError("invalid timeout, retry, or lookup batch-size option")
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise ImporterError("DATABASE_URL is required")

    now_ms = int(time.time() * 1_000)
    tokens = read_tokens(args.workbook.resolve())
    print(f"已解析项目：{len(tokens)} 个唯一 chain + CA")
    projects, skipped = lookup_projects(tokens, now_ms, args.lookup_batch_size, args.timeout, args.retries)
    for token, reason in skipped:
        print(f"[WARN] 跳过 {token.chain}:{token.ca}（Excel 第 {token.source_row} 行）：{reason}", file=sys.stderr)

    preflight_database(database_url)
    print(f"Lookup 匹配：{len(projects)}；跳过：{len(skipped)}")
    print(f"数据库目标：{safe_database_target(database_url)} / public.meme_kline")
    if projects:
        print(f"创建时间范围：{utc_text(min(project.created_ms for project in projects))} 至 {utc_text(max(project.created_ms for project in projects))}")
    print("K线组合：30s/1m × price/mcap；仅保存已收盘 K 线")

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
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(fetch_project, project, now_ms, args.timeout, args.retries): project
                   for project in projects}
        for future in as_completed(futures):
            project = futures[future]
            try:
                result = future.result()
            except Exception as error:  # User chose continue-and-skip behavior for project failures.
                totals.failed_projects += 1
                print(f"[WARN] 跳过 {project.chain}:{project.ca}：{error}", file=sys.stderr)
                continue
            if result.rows:
                inserted, updated = write_rows(database_url, result.rows)
                totals.inserted += inserted
                totals.updated += updated
            totals.imported_projects += 1
            totals.invalid += result.invalid
            totals.discarded += result.discarded
            print(f"[{totals.imported_projects}/{len(projects)}] {project.chain}:{project.ca} "
                  f"K线 {len(result.rows)}，无效 {result.invalid}，丢弃 {result.discarded}")

    print("导入完成："
          f"成功项目 {totals.imported_projects}，失败项目 {totals.failed_projects}，"
          f"插入 {totals.inserted}，更新 {totals.updated}，"
          f"标记无效 {totals.invalid}，丢弃不完整 {totals.discarded}。")
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
