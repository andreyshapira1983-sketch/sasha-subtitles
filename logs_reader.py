"""Чтение новых строк из журнала Саши и журнала ушей."""

import json
import os

HEAR_PREFIX = "[слышу]"


class LogTail:
    """Следит за файлом и отдаёт только новые строки."""

    def __init__(self, path, parser, start_at_end=True):
        self.path = str(path)
        self.parser = parser
        self.start_at_end = start_at_end
        self.offset = None
        self.pending = b""
        self.missing_warned = False
        self.read_warned = False

    def _warn(self, message):
        """Печатает предупреждение по-русски."""
        print(f"предупреждение: {message}")

    def _size(self):
        """Возвращает размер файла или None, если файла нет."""
        try:
            return os.path.getsize(self.path)
        except OSError:
            if not self.missing_warned:
                self._warn(f"журнал не найден: {self.path}")
                self.missing_warned = True
            return None

    def read_new(self):
        """Возвращает разобранные строки, появившиеся после прошлого чтения."""
        if self.offset is None:
            size = self._size()
            if size is None:
                return []
            # При старте прыгаем в конец, чтобы не вывалить старую историю.
            # Журнал, которого не было при старте, читаем с начала: всё в нём новое.
            self.offset = size if (self.start_at_end and not self.missing_warned) else 0
        size = self._size()
        if size is None:
            return []
        if size < self.offset:
            self._warn(f"файл стал короче, читаю сначала: {self.path}")
            self.offset = 0
            self.pending = b""
        chunk = self._read_from_offset()
        if chunk is None:
            return []
        self.offset += len(chunk)
        return self._split_lines(self.pending + chunk)

    def _read_from_offset(self):
        """Читает файл с текущей позиции."""
        try:
            with open(self.path, "rb") as stream:
                stream.seek(self.offset)
                return stream.read()
        except OSError as error:
            if not self.read_warned:
                self._warn(f"не удалось прочитать {self.path}: {error}")
                self.read_warned = True
            return None

    def _split_lines(self, data):
        """Разбирает завершённые строки, хвост оставляет до следующего раза."""
        parts = data.split(b"\n")
        self.pending = parts.pop()
        events = []
        for raw in parts:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            event = self.parser(line)
            if event is not None:
                events.append(event)
        return events


def parse_said_line(line):
    """Разбирает строку журнала Саши вида {"ts": ..., "text": ...}."""
    try:
        data = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        print(f"предупреждение: битая строка в журнале Саши: {line[:60]}")
        return None
    if not isinstance(data, dict):
        print(f"предупреждение: в журнале Саши не объект: {line[:60]}")
        return None
    text = str(data.get("text") or "").strip()
    if not text:
        return None
    return {"speaker": "sasha", "ts": data.get("ts"), "text": text}


def parse_hear_line(line):
    """Разбирает строку ушей вида «[слышу] Имя (микрофон): текст»."""
    if not line.startswith(HEAR_PREFIX):
        return None
    rest = line[len(HEAR_PREFIX):].strip()
    if ":" not in rest:
        print(f"предупреждение: строка ушей без текста: {line[:60]}")
        return None
    head, text = rest.split(":", 1)
    text = text.strip()
    if not text:
        return None
    name = head.split("(")[0].strip() or "Ведущий"
    return {"speaker": "host", "name": name, "text": text}


def open_said_log(path, start_at_end=True):
    """Открывает журнал Саши, пропуская старые строки при start_at_end."""
    return LogTail(path, parse_said_line, start_at_end=start_at_end)


def open_hear_log(path, start_at_end=True):
    """Открывает журнал ушей, пропуская старые строки при start_at_end."""
    return LogTail(path, parse_hear_line, start_at_end=start_at_end)
