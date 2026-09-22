from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree as ET


SCRIPT = Path(__file__).with_name("import_meme_klines.py")
SPEC = importlib.util.spec_from_file_location("meme_kline_importer", SCRIPT)
assert SPEC and SPEC.loader
importer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = importer
SPEC.loader.exec_module(importer)


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def column_name(index: int) -> str:
    result = ""
    value = index + 1
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(ord("A") + remainder) + result
    return result


def make_xlsx(path: Path, rows: list[list[str]]) -> None:
    workbook = ET.Element(f"{{{MAIN_NS}}}workbook")
    sheets = ET.SubElement(workbook, f"{{{MAIN_NS}}}sheets")
    ET.SubElement(sheets, f"{{{MAIN_NS}}}sheet", {
        "name": "信号明细", "sheetId": "1", f"{{{REL_NS}}}id": "rId1",
    })
    relationships = ET.Element(f"{{{PKG_REL_NS}}}Relationships")
    ET.SubElement(relationships, f"{{{PKG_REL_NS}}}Relationship", {
        "Id": "rId1",
        "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
        "Target": "worksheets/sheet1.xml",
    })
    worksheet = ET.Element(f"{{{MAIN_NS}}}worksheet")
    sheet_data = ET.SubElement(worksheet, f"{{{MAIN_NS}}}sheetData")
    for row_number, values in enumerate(rows, 1):
        row = ET.SubElement(sheet_data, f"{{{MAIN_NS}}}row", {"r": str(row_number)})
        for index, value in enumerate(values):
            cell = ET.SubElement(row, f"{{{MAIN_NS}}}c", {
                "r": f"{column_name(index)}{row_number}", "t": "inlineStr",
            })
            inline = ET.SubElement(cell, f"{{{MAIN_NS}}}is")
            ET.SubElement(inline, f"{{{MAIN_NS}}}t").text = value
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", ET.tostring(workbook, encoding="utf-8", xml_declaration=True))
        archive.writestr("xl/_rels/workbook.xml.rels", ET.tostring(relationships, encoding="utf-8", xml_declaration=True))
        archive.writestr("xl/worksheets/sheet1.xml", ET.tostring(worksheet, encoding="utf-8", xml_declaration=True))


class WorkbookTests(unittest.TestCase):
    def test_finds_headers_normalizes_and_deduplicates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "signals.xlsx"
            make_xlsx(path, [
                ["说明", "只作为数据"],
                ["合约地址", "忽略列", "所属 链"],
                ["CA1", "x", " SOL "],
                ["CA1", "duplicate", "sol"],
                ["CA2", "x", "ETH"],
                ["", "x", "sol"],
            ])
            self.assertEqual(
                importer.read_tokens(path),
                [importer.TokenRef("sol", "CA1", 3), importer.TokenRef("eth", "CA2", 5)],
            )

    def test_missing_columns_is_fatal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "signals.xlsx"
            make_xlsx(path, [["所属链", "名称"], ["sol", "token"]])
            with self.assertRaisesRegex(importer.ImporterError, "所属链 and 合约地址"):
                importer.read_tokens(path)


class LookupTests(unittest.TestCase):
    def test_strict_chain_match_and_creation_fallback(self) -> None:
        tokens = [importer.TokenRef("sol", "CA1", 2), importer.TokenRef("eth", "CA2", 3)]

        def request(*_args):
            return {
                "code": "200", "success": True,
                "data": {"caListTokenList": [
                    {"chain": "sol", "token_address": "CA1", "main_pair_id": "PAIR1",
                     "token_create_time": "1700000000000"},
                    {"chain": "bsc", "token_address": "CA2", "main_pair_id": "WRONG",
                     "token_create_time": "1700000000000"},
                ]},
            }

        projects, skipped = importer.lookup_projects(tokens, 1800000000000, 50, 1, 0, request)
        self.assertEqual(projects, [importer.Project("sol", "CA1", "PAIR1", 1700000000000)])
        self.assertEqual(skipped[0][0].ca, "CA2")
        self.assertIn("exact chain", skipped[0][1])

    def test_invalid_metadata_is_skipped(self) -> None:
        token = importer.TokenRef("sol", "CA", 2)

        def request(*_args):
            return {"code": "200", "data": {"caListTokenList": [
                {"chain": "sol", "token_address": "CA", "main_pair_id": ""},
            ]}}

        projects, skipped = importer.lookup_projects([token], 1800000000000, 50, 1, 0, request)
        self.assertFalse(projects)
        self.assertIn("main_pair_id", skipped[0][1])


class CandleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = importer.Project("sol", "CA", "PAIR", 60_001)
        self.candle = {
            "time": 60_000,
            "price": {"open": "10", "high": "12", "low": "9", "close": "11", "volume": "5"},
        }

    def test_windows_never_exceed_request_capacity(self) -> None:
        interval = 30
        end = importer.MAX_CANDLES_PER_WINDOW * interval * 1_000 * 2 + 30_000
        windows = list(importer.time_windows(1, end, interval))
        self.assertEqual(len(windows), 3)
        self.assertTrue(all((window_end - start) // 30_000 <= importer.MAX_CANDLES_PER_WINDOW
                            for start, window_end in windows))

    def test_only_closed_candles_are_kept(self) -> None:
        row = importer.candle_row(self.project, 30, "30s", "price", self.candle, 60_001, 120_000)
        self.assertIsNotNone(row)
        current = dict(self.candle, time=120_000)
        self.assertIsNone(importer.candle_row(self.project, 30, "30s", "price", current, 60_001, 120_000))

    def test_abnormal_complete_candle_is_marked_invalid(self) -> None:
        bad = {"time": 60_000, "price": {"open": 10, "high": 8, "low": 9, "close": 11, "volume": -1}}
        row = importer.candle_row(self.project, 30, "30s", "mcap", bad, 60_001, 120_000)
        self.assertIsNotNone(row)
        assert row is not None
        self.assertFalse(row.valid)
        self.assertIn("negative_volume", row.invalid_reason or "")
        self.assertIn("invalid_ohlc", row.invalid_reason or "")

    def test_incomplete_candle_is_discarded(self) -> None:
        incomplete = {"time": 60_000, "price": {"open": 1, "high": 1, "low": 1, "close": 1}}
        self.assertIsNone(importer.candle_row(self.project, 30, "30s", "price", incomplete, 60_001, 120_000))


class DatabaseTests(unittest.TestCase):
    def test_connection_failures_are_retryable_but_sql_errors_are_not(self) -> None:
        self.assertTrue(importer.retryable_psql_error("connection to server failed: timeout expired"))
        self.assertFalse(importer.retryable_psql_error("ERROR: syntax error at or near INSERT"))

    def test_upsert_uses_target_table_and_unique_key(self) -> None:
        row = importer.CandleRow(
            "sol", "CA", "PAIR", "30s", 60_000, 90_000,
            "1", "2", "0.5", "1.5", "10", 0, "price", "xxyy", "{}", True, None,
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "batch.csv"
            with path.open("w", encoding="utf-8", newline="") as stream:
                importer.write_csv_rows(stream, [row])
            sql = importer.build_upsert_sql(path)
        self.assertIn("INSERT INTO public.meme_kline", sql)
        self.assertIn("ON CONFLICT (chain,pair_id,interval,open_time,type) DO UPDATE", sql)
        self.assertIn("\\copy import_meme_kline", sql)
        self.assertIn(f"FROM '{path}' WITH (FORMAT csv, NULL '\\N')", sql)
        self.assertNotIn("public.xxyy_kline", sql)

    def test_dry_run_never_fetches_candles_or_writes(self) -> None:
        args = Namespace(
            workbook=Path("signals.xlsx"), dry_run=True, yes=False, workers=4,
            timeout=1, retries=0, lookup_batch_size=50,
        )
        tokens = [importer.TokenRef("sol", "CA", 2)]
        projects = [importer.Project("sol", "CA", "PAIR", int(importer.time.time()*1000)-1000)]
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://example/db"}), \
             patch.object(importer, "read_tokens", return_value=tokens), \
             patch.object(importer, "read_signals", return_value=[{"chain":"sol", "ca":"CA"}]), \
             patch.object(importer, "preflight_signals"), \
             patch.object(importer, "lookup_projects", return_value=(projects, [])), \
             patch.object(importer, "preflight_database"), \
             patch.object(importer, "fetch_project") as fetch, \
             patch.object(importer, "write_rows") as write:
            self.assertEqual(importer.run(args), 0)
        fetch.assert_not_called()
        write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
