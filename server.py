"""Сервер субтитров Саши: раздаёт оверлей и отдаёт новые реплики."""

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import logs_reader
import text_tools

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
OVERLAY_PATH = os.path.join(BASE_DIR, "overlay.html")
PAUSE_PATH = os.path.join(BASE_DIR, "PAUSE")

HOST = "127.0.0.1"  # Слушаем только свой компьютер: снаружи сервер недоступен.
POLL_SECONDS = 0.25
LINE_LIMIT = 500

DEFAULT_CONFIG = {
    "said_log": "logs/said.jsonl",
    "hear_log": "logs/hear_stream.log",
    "demo_said_log": "samples/said.jsonl",
    "demo_hear_log": "samples/hear_stream.log",
    "port": 8765,
    "columns": 34,
    "max_lines": 2,
    "seconds_per_char": 0.06,
    "min_seconds": 2.0,
    "max_seconds": 8.0,
    "font_size": 44,
    "speakers": {
        "sasha": {"name": "Саша", "color": "#ff9ee6"},
        "host": {"name": "Ведущий", "color": "#8fd8ff"},
    },
    "banned_words": ["блять", "хуй", "пизд", "ебал"],
}


def load_config():
    """Читает config.json и добавляет недостающие значения по умолчанию."""
    with open(CONFIG_PATH, "r", encoding="utf-8") as stream:
        config = json.load(stream)
    merged = dict(DEFAULT_CONFIG)
    merged.update(config)
    speakers = dict(DEFAULT_CONFIG["speakers"])
    speakers.update(config.get("speakers") or {})
    merged["speakers"] = speakers
    return merged


def resolve_path(value):
    """Превращает путь из настроек в абсолютный путь от папки программы."""
    if os.path.isabs(value):
        return value
    return os.path.normpath(os.path.join(BASE_DIR, value))


def is_paused():
    """Проверяет, лежит ли рядом с программой файл PAUSE."""
    return os.path.exists(PAUSE_PATH)


def speaker_style(config, event):
    """Возвращает имя и цвет говорящего из настроек."""
    speaker = event.get("speaker", "")
    settings = (config.get("speakers") or {}).get(speaker) or {}
    name = settings.get("name") or event.get("name") or speaker
    color = settings.get("color") or "#ffffff"
    return name, color


def render_overlay(config):
    """Читает overlay.html и подставляет в него настройки."""
    with open(OVERLAY_PATH, "r", encoding="utf-8") as stream:
        page = stream.read()
    return page.replace("__CONFIG_JSON__", json.dumps(config, ensure_ascii=False))


class LineStore:
    """Хранит последние реплики и отдаёт их по номеру."""

    def __init__(self, limit=LINE_LIMIT):
        self.limit = limit
        self.items = []
        self.last = 0
        self.lock = threading.Lock()

    def add(self, item):
        """Добавляет реплику и возвращает её номер."""
        with self.lock:
            self.last += 1
            entry = dict(item)
            entry["n"] = self.last
            self.items.append(entry)
            if len(self.items) > self.limit:
                del self.items[:len(self.items) - self.limit]
            return self.last

    def after(self, number):
        """Возвращает копии реплик с номером больше number."""
        with self.lock:
            return [dict(item) for item in self.items if item["n"] > number]


class SubtitleFeed(threading.Thread):
    """Фоновая нить: превращает новые строки журналов в реплики оверлея."""

    def __init__(self, config, store, demo=False):
        super().__init__(daemon=True)
        self.config = config
        self.store = store
        self.demo = demo

    def run(self):
        """Читает журналы или крутит образцы в демо-режиме."""
        if self.demo:
            self._run_demo()
        else:
            self._run_logs()

    def _run_logs(self):
        """Читает журналы в бесконечном цикле."""
        readers = [
            logs_reader.open_said_log(resolve_path(self.config["said_log"])),
            logs_reader.open_hear_log(resolve_path(self.config["hear_log"])),
        ]
        while True:
            try:
                for reader in readers:
                    for event in reader.read_new():
                        self.publish(event)
            except Exception as error:  # Нить не должна умирать молча: иначе субтитры просто исчезнут.
                print(f"Ошибка чтения журналов: {error}")
            time.sleep(POLL_SECONDS)

    def _run_demo(self):
        """Показывает образцы по кругу с темпом оверлея."""
        events = demo_events(self.config)
        if not events:
            print("Не удалось прочитать образцы журналов — показываю тестовую реплику.")
            events = [{"speaker": "sasha", "text": "Проверка субтитров: раз, два, три."}]
        print(f"Демо-режим: {len(events)} реплик по кругу.")
        index = 0
        while True:
            if is_paused():
                time.sleep(POLL_SECONDS)
                continue
            event = events[index % len(events)]
            index += 1
            shown = self.publish(event)
            if shown:
                # По 0,5 с на экран: столько оверлей тратит на затухание и паузу между репликами.
                time.sleep(sum(entry["seconds"] for entry in shown) + 0.5 * len(shown))
            else:
                time.sleep(POLL_SECONDS)

    def publish(self, event):
        """Проверяет реплику, режет её на экраны и кладёт в хранилище."""
        if is_paused():
            return []
        text = event.get("text", "")
        if not text_tools.should_show(text):
            return []
        text = text_tools.mask_banned(text, self.config.get("banned_words") or [])
        name, color = speaker_style(self.config, event)
        pages = text_tools.paginate(
            text,
            self.config["columns"],
            self.config["max_lines"],
        )
        entries = []
        for page in pages:
            page_text = "\n".join(page)
            entries.append({
                "speaker": event.get("speaker", ""),
                "name": name,
                "color": color,
                "text": page_text,
                "seconds": round(text_tools.display_seconds(
                    page_text,
                    self.config["seconds_per_char"],
                    self.config["min_seconds"],
                    self.config["max_seconds"],
                ), 2),
            })
        for entry in entries:
            self.store.add(entry)
        return entries


def demo_events(config):
    """Собирает реплики из образцов журналов для демо-режима."""
    said = logs_reader.open_said_log(
        resolve_path(config["demo_said_log"]), start_at_end=False).read_new()
    hear = logs_reader.open_hear_log(
        resolve_path(config["demo_hear_log"]), start_at_end=False).read_new()
    events = []
    # Перемежаем говорящих, чтобы сразу видеть оба имени и оба цвета.
    for index in range(max(len(said), len(hear))):
        if index < len(said):
            events.append(said[index])
        if index < len(hear):
            events.append(hear[index])
    return events


class SubtitleServer(ThreadingHTTPServer):
    """HTTP-сервер, который знает настройки, страницу и хранилище реплик."""

    daemon_threads = True
    # Не разрешаем SO_REUSEADDR: иначе на Windows вторая копия молча займёт занятый порт.
    allow_reuse_address = False

    def __init__(self, address, config, store, overlay):
        self.config = config
        self.store = store
        self.overlay = overlay
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    """Отвечает на запросы OBS и браузера."""

    server_version = "SashaSubtitles/1.0"

    def log_message(self, format, *args):
        """Молчит: обычные запросы оверлея в консоль не пишем."""

    def do_GET(self):
        """Раздаёт страницу и новые реплики."""
        try:
            self._route()
        except (BrokenPipeError, ConnectionResetError):
            pass  # Браузер закрыл страницу — это штатное событие, не ошибка.

    def _route(self):
        """Выбирает ответ по адресу запроса."""
        path = urlparse(self.path).path
        if path in ("/", "/overlay.html", "/index.html"):
            self._send_html(self.server.overlay)
        elif path == "/lines":
            self._send_lines()
        elif path == "/favicon.ico":
            self._send_empty()
        else:
            self._send_text("Не найдено", 404)

    def _send_lines(self):
        """Отдаёт реплики новее номера из параметра after."""
        query = parse_qs(urlparse(self.path).query)
        paused = is_paused()
        numbers = query.get("after")
        if not numbers:
            # Первый запрос без after: клиент просто узнаёт текущий номер.
            self._send_json({"paused": paused, "last": self.server.store.last, "lines": []})
            return
        try:
            after = int(numbers[0])
        except (TypeError, ValueError):
            after = 0
        lines = [] if paused else self.server.store.after(after)
        self._send_json({"paused": paused, "last": self.server.store.last, "lines": lines})

    def _send_html(self, page):
        """Отдаёт страницу оверлея."""
        self._send_bytes(page.encode("utf-8"), "text/html; charset=utf-8")

    def _send_json(self, payload):
        """Отдаёт JSON."""
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(data, "application/json; charset=utf-8")

    def _send_text(self, message, status):
        """Отдаёт простой текст."""
        data = message.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, data, content_type):
        """Отдаёт байты с нужным типом."""
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_empty(self):
        """Отдаёт пустой ответ (для favicon)."""
        self.send_response(204)
        self.end_headers()


def main(argv=None):
    """Читает настройки и запускает сервер до Ctrl+C."""
    parser = argparse.ArgumentParser(description="Субтитры Саши: оверлей для OBS")
    parser.add_argument(
        "--demo",
        action="store_true",
        help="показывать по кругу реплики из папки samples",
    )
    args = parser.parse_args(argv)
    try:
        config = load_config()
    except (OSError, ValueError) as error:
        print(f"Не удалось прочитать config.json: {error}")
        return 1
    try:
        port = int(config["port"])
    except (KeyError, TypeError, ValueError):
        print("В config.json неправильный порт: нужно целое число.")
        return 1
    try:
        overlay = render_overlay(config)
    except OSError as error:
        print(f"Не удалось прочитать overlay.html: {error}")
        return 1
    store = LineStore()
    try:
        server = SubtitleServer((HOST, port), config, store, overlay)
    except OSError as error:
        print(f"Не удалось занять порт {port}: {error}")
        print("Проверьте, свободен ли порт, или поменяйте его в config.json.")
        return 1
    feed = SubtitleFeed(config, store, demo=args.demo)
    feed.start()
    print("Субтитры Саши запущены.")
    print(f"Страница для OBS: http://{HOST}:{server.server_address[1]}/")
    print(f"Журнал Саши: {resolve_path(config['said_log'])}")
    print(f"Журнал ушей: {resolve_path(config['hear_log'])}")
    print(f"Пауза: создайте файл PAUSE здесь — {PAUSE_PATH}")
    print("Остановка: Ctrl+C.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
