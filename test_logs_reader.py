"""Тесты разбора журналов и слежения за файлом."""

import io
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

import logs_reader
import server


class HearLineTest(unittest.TestCase):
    """Разбор строки ушей."""

    def test_hear_line_parsed(self):
        """Из строки ушей берутся имя и текст."""
        event = logs_reader.parse_hear_line("[слышу] Ведущий (микрофон): Проснись!")
        self.assertEqual(event["speaker"], "host")
        self.assertEqual(event["name"], "Ведущий")
        self.assertEqual(event["text"], "Проснись!")

    def test_other_lines_are_skipped(self):
        """Строки без «[слышу]» не берутся."""
        self.assertIsNone(logs_reader.parse_hear_line("просто строка"))
        self.assertIsNone(logs_reader.parse_hear_line("[тишина] что-то"))


class SaidLineTest(unittest.TestCase):
    """Разбор строки журнала Саши."""

    def test_valid_json_line(self):
        """Хорошая строка JSON разбирается в реплику."""
        event = logs_reader.parse_said_line('{"ts": 1.5, "text": "Привет"}')
        self.assertEqual(event["speaker"], "sasha")
        self.assertEqual(event["text"], "Привет")
        self.assertEqual(event["ts"], 1.5)

    def test_broken_json_is_skipped_with_warning(self):
        """Битая строка JSON пропускается с предупреждением."""
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            event = logs_reader.parse_said_line('{"ts": 1.5, "text": ')
        self.assertIsNone(event)
        self.assertIn("битая", buffer.getvalue())


class LogTailTest(unittest.TestCase):
    """Слежение за файлом журнала."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "log.txt"

    def _reader(self, start_at_end=False):
        """Создаёт читатель, который отдаёт строки как есть."""
        return logs_reader.LogTail(self.path, lambda line: line, start_at_end=start_at_end)

    def test_reads_only_new_lines(self):
        """При старте старые строки не отдаются, только новые."""
        self.path.write_bytes("старое\n".encode("utf-8"))
        reader = self._reader(start_at_end=True)
        self.assertEqual(reader.read_new(), [])
        with self.path.open("ab") as stream:
            stream.write("новое\n".encode("utf-8"))
        self.assertEqual(reader.read_new(), ["новое"])

    def test_file_became_shorter_starts_over(self):
        """Если файл стал короче, чтение начинается сначала."""
        self.path.write_bytes("длинная строка\n".encode("utf-8"))
        reader = self._reader()
        self.assertEqual(reader.read_new(), ["длинная строка"])
        self.path.write_bytes("да\n".encode("utf-8"))
        self.assertEqual(reader.read_new(), ["да"])

    def test_partial_line_waits_for_newline(self):
        """Неполная строка ждёт перевода строки и не теряется."""
        self.path.write_bytes("первая".encode("utf-8"))
        reader = self._reader()
        self.assertEqual(reader.read_new(), [])
        with self.path.open("ab") as stream:
            stream.write("\nвторая\n".encode("utf-8"))
        self.assertEqual(reader.read_new(), ["первая", "вторая"])

    def test_missing_file_is_skipped(self):
        """Отсутствующий журнал не роняет программу."""
        reader = self._reader()
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            events = reader.read_new()
        self.assertEqual(events, [])
        self.assertIn("не найден", buffer.getvalue())

    def test_broken_line_does_not_stop_reader(self):
        """Битая строка журнала не мешает читать следующие."""
        raw = (
            '{"ts": 1, "text": "можно"}\n'
            "{битая\n"
            '{"ts": 2, "text": "тоже можно"}\n'
        )
        self.path.write_bytes(raw.encode("utf-8"))
        reader = logs_reader.LogTail(
            self.path, logs_reader.parse_said_line, start_at_end=False)
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            events = reader.read_new()
        self.assertEqual([event["text"] for event in events], ["можно", "тоже можно"])
        self.assertIn("битая", buffer.getvalue())


class DemoPathsTest(unittest.TestCase):
    """Демо-режим читает только ключи demo_*."""

    def test_demo_reads_demo_keys(self):
        """Реплики демо берутся из demo_said_log и demo_hear_log."""
        with TemporaryDirectory() as tmp:
            folder = Path(tmp)
            said = folder / "demo_said.jsonl"
            hear = folder / "demo_hear.log"
            said.write_text('{"ts": 1, "text": "Из демо-ключа"}\n', encoding="utf-8")
            hear.write_text("[слышу] Ведущий (микрофон): Тоже демо\n", encoding="utf-8")
            config = dict(server.DEFAULT_CONFIG)
            config["said_log"] = str(folder / "нет-said.jsonl")
            config["hear_log"] = str(folder / "нет-hear.log")
            config["demo_said_log"] = str(said)
            config["demo_hear_log"] = str(hear)
            events = server.demo_events(config)
        self.assertEqual([event["text"] for event in events], ["Из демо-ключа", "Тоже демо"])


if __name__ == "__main__":
    unittest.main()
