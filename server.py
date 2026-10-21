"""Сервер субтитров Саши: раздаёт оверлей и отдаёт новые реплики."""

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import logs_reader
import obs_ws
import text_tools

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
OVERLAY_PATH = os.path.join(BASE_DIR, "overlay.html")
PAUSE_PATH = os.path.join(BASE_DIR, "PAUSE")
JS_DIR = os.path.join(BASE_DIR, "js")  # overlay.html подключает js/*.js и в старом режиме.

# Что можно раздавать рядом со страницей оверлея: только скрипты стилей.
STATIC_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}

HOST = "127.0.0.1"  # Слушаем только свой компьютер: снаружи сервер недоступен.
POLL_SECONDS = 0.25
LINE_LIMIT = 500
OBS_RETRY_SECONDS = 2.0  # Пауза перед повторной попыткой связи с OBS.
OBS_DEMO_SECONDS = 2.5  # Пауза между репликами в демо-режиме --obs.

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
    "obs": {"host": "127.0.0.1", "port": 4455, "password": ""},
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
    obs = dict(DEFAULT_CONFIG["obs"])
    raw_obs = config.get("obs")
    if isinstance(raw_obs, dict):
        obs.update(raw_obs)
    merged["obs"] = obs
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


def obs_settings(config):
    """Достаёт и проверяет настройки OBS WebSocket из config.json.

    Возвращает {"host": str, "port": int, "password": str}. При мусоре в
    настройках поднимает ValueError с понятным русским текстом.
    """
    raw = (config or {}).get("obs") or {}
    if not isinstance(raw, dict):
        raise ValueError("В config.json раздел obs должен быть объектом { ... }.")
    defaults = DEFAULT_CONFIG["obs"]
    host = str(raw.get("host") or defaults["host"]).strip() or defaults["host"]
    try:
        port = int(raw.get("port", defaults["port"]))
    except (TypeError, ValueError) as error:
        raise ValueError(
            "В config.json obs.port должен быть целым числом (например, 4455)."
        ) from error
    if not 1 <= port <= 65535:
        raise ValueError("В config.json obs.port должен быть от 1 до 65535.")
    password = raw.get("password", defaults["password"])
    password = "" if password is None else str(password)
    return {"host": host, "port": port, "password": password}


def to_obs_payload(config, event):
    """Собирает реплику для BroadcastCustomEvent: полный текст, final=True.

    На экраны текст не режем — это сделает overlay.html. Пустой текст и
    команды эмоций отсеиваются раньше (should_show); здесь только маскируем
    мат и подставляем имя и цвет говорящего из настроек.
    """
    event = event if isinstance(event, dict) else {}
    text = text_tools.mask_banned(
        text_tools.normalize(event.get("text") or ""),
        config.get("banned_words") or [],
    )
    speaker = event.get("speaker") or "host"
    name, color = speaker_style(
        config, {"speaker": speaker, "name": event.get("name")},
    )
    return {
        "app": obs_ws.APP,
        "speaker": str(speaker),
        "name": name,
        "color": color,
        "text": text,
        "final": True,
    }


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


class ObsRelay:
    """Держит связь с OBS WebSocket и шлёт в него реплики.

    При обрыве связь рвётся и восстанавливается при следующей реплике.
    Повторные попытки не чаще retry_seconds, чтобы не забивать консоль.
    client_factory и clock подменяются в тестах.
    """

    def __init__(self, config, client_factory=None, retry_seconds=OBS_RETRY_SECONDS,
                 clock=time.monotonic):
        self.config = config
        self.settings = obs_settings(config)
        self.client_factory = client_factory
        self.retry_seconds = float(retry_seconds)
        self.clock = clock
        self.client = None
        self._next_attempt = 0.0

    @property
    def url(self):
        """Адрес OBS WebSocket для сообщений человеку."""
        return f"ws://{self.settings['host']}:{self.settings['port']}"

    def _make_client(self):
        """Создаёт клиента OBS WebSocket (в тестах — поддельного)."""
        if self.client_factory is not None:
            return self.client_factory()
        return obs_ws.ObsWebSocketClient(
            host=self.settings["host"],
            port=self.settings["port"],
            password=self.settings["password"],
        )

    def _report_unavailable(self, error):
        """Печатает понятную строку и подсказку, где включить WebSocket."""
        print(f"OBS WebSocket недоступен: {error}")
        print(f"Подсказка: {obs_ws.HINT_WS_OFF}")

    def ensure_connected(self):
        """Подключается, если связи нет. False — OBS пока недоступен."""
        if self.client is not None and self.client.connected:
            return True
        self._drop()
        now = self.clock()
        if now < self._next_attempt:
            return False
        self._next_attempt = now + self.retry_seconds
        client = None
        try:
            client = self._make_client()
            client.connect()
        except (obs_ws.ObsWebSocketError, OSError) as error:
            if client is not None:
                try:
                    client.close()
                except OSError:
                    pass
            self._report_unavailable(error)
            return False
        self.client = client
        self._next_attempt = 0.0
        print(f"OBS WebSocket: подключено ({self.url}). Реплики уходят в OBS.")
        return True

    def send(self, payload):
        """Отправляет реплику. При обрыве возвращает False и готов к переподключению."""
        if not self.ensure_connected():
            return False
        try:
            self.client.send_custom_event(payload)
            return True
        except (obs_ws.ObsWebSocketError, OSError) as error:
            print(f"Связь с OBS потеряна: {error}")
            self._drop()
            self._next_attempt = self.clock() + self.retry_seconds
            return False

    def _drop(self):
        """Закрывает текущий клиент, не трогая настройки."""
        if self.client is None:
            return
        client = self.client
        self.client = None
        try:
            client.close()
        except OSError:
            pass

    def close(self):
        """Закрывает связь насовсем."""
        self._drop()


def publish_obs_event(config, relay, event):
    """Фильтрует реплику (пауза, пусто, команда эмоции) и шлёт её в OBS."""
    if is_paused():
        return False
    text = (event or {}).get("text") or ""
    if not text_tools.should_show(text):
        return False
    return relay.send(to_obs_payload(config, event))


def run_obs_logs(config, relay):
    """Режим --obs: читает те же журналы и отправляет каждую фразу в OBS."""
    readers = [
        logs_reader.open_said_log(resolve_path(config["said_log"])),
        logs_reader.open_hear_log(resolve_path(config["hear_log"])),
    ]
    while True:
        try:
            for reader in readers:
                for event in reader.read_new():
                    publish_obs_event(config, relay, event)
        except Exception as error:  # Нить не должна молча умирать: субтитры пропадут.
            print(f"Ошибка чтения журналов: {error}")
        time.sleep(POLL_SECONDS)


def run_obs_demo(config, relay):
    """Режим --obs --demo: крутит образцы журналов по кругу."""
    events = demo_events(config)
    if not events:
        print("Не удалось прочитать образцы журналов — показываю тестовую реплику.")
        events = [{"speaker": "sasha", "text": "Проверка субтитров: раз, два, три."}]
    print(f"Демо-режим --obs: {len(events)} реплик по кругу.")
    index = 0
    while True:
        if is_paused():
            time.sleep(POLL_SECONDS)
            continue
        event = events[index % len(events)]
        index += 1
        sent = publish_obs_event(config, relay, event)
        time.sleep(OBS_DEMO_SECONDS if sent else POLL_SECONDS)


def run_obs_mode(config, demo=False):
    """Режим --obs: своя страница не поднимается, реплики идут в OBS WebSocket."""
    try:
        settings = obs_settings(config)
    except ValueError as error:
        print(error)
        return 1
    relay = ObsRelay(config)
    print("Режим --obs: своя страница не поднимается, реплики уходят в OBS WebSocket.")
    print(f"OBS WebSocket: ws://{settings['host']}:{settings['port']}")
    print(f"Журнал Саши: {resolve_path(config['said_log'])}")
    print(f"Журнал ушей: {resolve_path(config['hear_log'])}")
    relay.ensure_connected()
    print(f"Пауза: создайте файл PAUSE здесь — {PAUSE_PATH}")
    print("Остановка: Ctrl+C.")
    try:
        if demo:
            run_obs_demo(config, relay)
        else:
            run_obs_logs(config, relay)
    except KeyboardInterrupt:
        print("\nОстановлено.")
    finally:
        relay.close()
    return 0


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
        elif path.startswith("/js/"):
            # overlay.html подключает js/text.js, js/obs.js и js/overlay.js
            # обычными <script src>: в старом режиме сервер обязан их отдать,
            # иначе страница в OBS останется пустой.
            self._send_static(path)
        elif path == "/favicon.ico":
            self._send_empty()
        else:
            self._send_text("Не найдено", 404)

    def _send_static(self, path):
        """Отдаёт скрипт из папки js — и ничего за её пределами."""
        relative = path.lstrip("/")
        candidate = os.path.normpath(os.path.join(BASE_DIR, relative))
        # Только файлы прямо из js/: «..» и подпапки отсекаются.
        if os.path.dirname(candidate) != JS_DIR:
            self._send_text("Не найдено", 404)
            return
        content_type = STATIC_TYPES.get(os.path.splitext(candidate)[1].lower())
        if not content_type:
            self._send_text("Не найдено", 404)
            return
        try:
            with open(candidate, "rb") as stream:
                data = stream.read()
        except OSError:
            self._send_text("Не найдено", 404)
            return
        self._send_bytes(data, content_type)

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
    parser.add_argument(
        "--obs",
        action="store_true",
        help="не поднимать страницу, отправлять реплики в OBS WebSocket",
    )
    args = parser.parse_args(argv)
    try:
        config = load_config()
    except (OSError, ValueError) as error:
        print(f"Не удалось прочитать config.json: {error}")
        return 1
    if args.obs:
        return run_obs_mode(config, demo=args.demo)
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
