#!/usr/bin/env python3
"""Fetch XXYY price candles and upsert them into TimescaleDB.

Single pool:
  python3 fetch_xxyy_klines.py --chain robin --ca 0xTOKEN --pair-id 0xPOOL \
    --from '2026-09-17 21:50' --to now --interval 60

Batch pools (CSV without a header):
  # chain,ca,pair_id
  robin,0xTOKEN_A,0xPOOL_A
"""

import argparse
import csv
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

API_URL = "https://www.xxyy.io/api/data/candlestick/searchBarData"
SHANGHAI = ZoneInfo("Asia/Shanghai")
INTERVAL_NAMES = {60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d"}


def parse_time(value: str) -> datetime:
    if value.lower() == "now":
        return datetime.now(timezone.utc)
    if value.isdigit():
        return datetime.fromtimestamp(int(value) / 1000, timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SHANGHAI)
    return parsed.astimezone(timezone.utc)


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def fetch(chain: str, pair_id: str, value_type: str, interval: int, start: datetime, end: datetime, count_back: int) -> list:
    payload = {"pairId": pair_id, "valueType": "mc" if value_type == "mcap" else "price", "interval": interval,
               "priceType": "usd", "from": int(start.timestamp() * 1000),
               "to": int(end.timestamp() * 1000), "countBack": count_back}
    request = Request(API_URL, data=json.dumps(payload).encode(), method="POST", headers={
        "X-CHAIN": chain, "X-VERSION": "1", "X-LANGUAGE": "zh", "Content-Type": "application/json"})
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result.get("code") != 0:
        raise RuntimeError(f"XXYY API error: {result.get('msg') or result}")
    return result.get("data") or []


def build_sql(chain: str, ca: str, pair_id: str, value_type: str, interval: int, candles: list, start: datetime, end: datetime) -> tuple[str, int]:
    interval_name = INTERVAL_NAMES.get(interval, f"{interval}s")
    rows = []
    for candle in candles:
        open_time = int(candle["time"])
        opened = datetime.fromtimestamp(open_time / 1000, timezone.utc)
        price = candle.get("price") or {}
        if not start <= opened <= end or any(price.get(key) is None for key in ("open", "high", "low", "close", "volume")):
            continue
        rows.append("(" + ", ".join([
            sql_literal(chain), sql_literal(ca), sql_literal(pair_id), sql_literal(interval_name),
            str(open_time), str(open_time + interval * 1000), sql_literal(price["open"]),
            sql_literal(price["high"]), sql_literal(price["low"]), sql_literal(price["close"]),
            sql_literal(price["volume"]), "0", sql_literal(value_type), sql_literal("xxyy"),
            sql_literal(json.dumps(candle, separators=(",", ":"))) + "::jsonb"]) + ")")
    if not rows:
        return "", 0
    return """INSERT INTO public.xxyy_kline
  (chain, ca, pair_id, interval, open_time, close_time, open, high, low, close, volume, trade_count, type, source, raw_data)
VALUES
  %s
ON CONFLICT (chain, pair_id, interval, open_time, type) DO UPDATE SET
  ca = EXCLUDED.ca, close_time = EXCLUDED.close_time, open = EXCLUDED.open, high = EXCLUDED.high,
  low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume,
  trade_count = EXCLUDED.trade_count, source = EXCLUDED.source, raw_data = EXCLUDED.raw_data;
""" % ",\n  ".join(rows), len(rows)


def run_psql(sql: str, database_url: str, docker_container: str | None) -> None:
    command = (["docker", "exec", "-i", docker_container, "psql"] if docker_container else ["psql"])
    subprocess.run(command + [database_url, "-v", "ON_ERROR_STOP=1"], input=sql, text=True, check=True)


def read_pairs(path: Path) -> list[tuple[str, str, str]]:
    pairs = []
    with path.open(newline="") as file:
        for number, row in enumerate(csv.reader(line for line in file if line.strip() and not line.lstrip().startswith("#")), 1):
            if len(row) != 3 or not all(cell.strip() for cell in row):
                raise ValueError(f"{path}:{number}: expected chain,ca,pair_id")
            pairs.append(tuple(cell.strip() for cell in row))
    return pairs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chain", help="chain name for --pair-id values, e.g. robin")
    parser.add_argument("--ca", help="token contract address for --pair-id values")
    parser.add_argument("--pair-id", action="append", default=[], help="XXYY pool address; repeat for pools sharing --chain and --ca")
    parser.add_argument("--pairs-file", type=Path, help="CSV: chain,ca,pair_id per line")
    parser.add_argument("--from", dest="start", required=True, help="ISO time, China-local time, epoch milliseconds, or now")
    parser.add_argument("--to", dest="end", required=True, help="ISO time, China-local time, epoch milliseconds, or now")
    parser.add_argument("--interval", type=int, default=60, help="candle interval in seconds (default: 60)")
    parser.add_argument("--value-type", choices=("price", "mcap"), default="price", help="price or market-cap K lines (default: price)")
    parser.add_argument("--count-back", type=int, default=5000, help="maximum candles requested per pool")
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"), help="PostgreSQL URL; defaults to DATABASE_URL")
    parser.add_argument("--docker-container", default=os.environ.get("POSTGRES_DOCKER_CONTAINER"), help="run psql in this Docker container")
    args = parser.parse_args()
    if not args.database_url:
        parser.error("supply --database-url or set DATABASE_URL")
    if args.pair_id and (not args.chain or not args.ca):
        parser.error("--chain and --ca are required with --pair-id")
    pairs = [(args.chain, args.ca, pair_id) for pair_id in args.pair_id]
    if args.pairs_file:
        pairs.extend(read_pairs(args.pairs_file))
    pairs = list(dict.fromkeys(pairs))
    if not pairs:
        parser.error("supply --pair-id or --pairs-file")
    start, end = parse_time(args.start), parse_time(args.end)
    if end < start:
        parser.error("--to must not be earlier than --from")
    total = 0
    for chain, ca, pair_id in pairs:
        candles = fetch(chain, pair_id, args.value_type, args.interval, start, end, args.count_back)
        sql, count = build_sql(chain, ca, pair_id, args.value_type, args.interval, candles, start, end)
        if sql:
            run_psql(sql, args.database_url, args.docker_container)
        total += count
        print(f"{pair_id}: API returned {len(candles)}, upserted {count}")
    print(f"Done: upserted {total} candle(s).")


if __name__ == "__main__":
    main()
