"""Тесты запасного пути Python → OBS WebSocket (obs_ws.py и режим --obs).

Никакой сети: подключение идёт к поддельным сокетам с заранее
заготовленными байтами. Проверяются рукопожатие HTTP Upgrade, вход
Hello → Identify → Identified, строка авторизации по контрольным примерам
из документации obs-websocket v5, сборка BroadcastCustomEvent, маска
клиентских кадров, разбор серверных кадров по частям, ping/pong,
переподключение и подготовка реплик для режима --obs.
"""

import contextlib
import io
import json
import re
import socket
import struct
import unittest

import obs_ws
import server

# Ответ OBS на HTTP-рукопожатие WebSocket.
HTTP_101 = (
    b"HTTP/1.1 101 Switching Protocols\r\n"
    b"Upgrade: websocket\r\n"
    b"Connection: Upgrade\r\n"
    b"Sec-WebSocket-Accept: test-accept\r\n"
    b"\r\n"
)
HTTP_400 = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"

# Контрольные примеры из задачи: такие же считает js/obs.js.
DOCUMENTED_PASSWORD = "supersecretpassword"
DOCUMENTED_SALT = "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1GAdBTXndyBHgTfSoWTY9yO1VJzSDG1jE"
DOCUMENTED_CHALLENGE = "5WZ6oNZ9PTx2H+PPRgzcLXxYKGtN1tsPdpEzQ7fk0gY="
DOCUMENTED_AUTH = "bwBhQ1JP1gV4hVV+2zhe3mh7l7C4nXw3Q1pgQP68+nc="
TEST_AUTH = "MY8+gsELNhtz8+uSIeySp61LAiYksO/5+bE9TUeDsbg="


class FakeSocket:
    """Поддельный сокет: отдаёт заготовленные байты и запоминает отправленное."""

    def __init__(self, incoming=b""):
        self.incoming = bytearray(incoming)
        self.sent = bytearray()
        self.closed = False
        self.fail_send = False
        self.timeout = None

    def recv(self, size):
        """Отдаёт очередную порцию заготовленных байтов."""
        if not self.incoming:
            return b""
        chunk = bytes(self.incoming[:size])
        del self.incoming[:size]
        return chunk

    def send(self, data):
        """Запоминает отправленные байты."""
        if self.fail_send:
            raise ConnectionResetError("сокет сломан")
        self.sent += data
        return len(data)

    def sendall(self, data):
        """То же, что send, но целиком."""
        if self.fail_send:
            raise ConnectionResetError("сокет сломан")
        self.sent += data

    def close(self):
        """Запоминает закрытие."""
        self.closed = True

    def settimeout(self, value):
        """Запоминает таймаут (настоящий сокет так делает при connect)."""
        self.timeout = value


class TimeoutSocket(FakeSocket):
    """Сокет, который после заготовленных байтов уходит в таймаут."""

    def recv(self, size):
        if not self.incoming:
            raise socket.timeout("время вышло")
        return super().recv(size)


def make_factory(*sockets):
    """Фабрика, выдающая поддельные сокеты по очереди."""
    remaining = list(sockets)

    def factory(*args, **kwargs):
        if not remaining:
            raise AssertionError("фабрика сокетов вызвана больше раз, чем заготовлено")
        return remaining.pop(0)

    return factory


def json_frame(message):
    """Серверный (без маски) текстовый кадр с JSON протокола."""
    return obs_ws.encode_frame(
        json.dumps(message, ensure_ascii=False), opcode=obs_ws.OPCODE_TEXT, mask=False,
    )


def hello_frame(authentication=None, rpc_version=1):
    """Серверный Hello (op 0)."""
    payload = {"obsWebSocketVersion": "5.5.2", "rpcVersion": rpc_version}
    if authentication is not None:
        payload["authentication"] = authentication
    return json_frame({"op": obs_ws.OP_HELLO, "d": payload})


def identified_frame():
    """Серверный Identified (op 2)."""
    return json_frame({"op": obs_ws.OP_IDENTIFIED, "d": {"negotiatedRpcVersion": 1}})


def close_frame(code, reason=""):
    """Серверный close с кодом и причиной."""
    payload = struct.pack("!H", code) + reason.encode("utf-8")
    return obs_ws.encode_frame(payload, opcode=obs_ws.OPCODE_CLOSE, mask=False)


def split_sent(sock):
    """Отделяет HTTP-запрос рукопожатия от отправленных кадров WebSocket."""
    data = bytes(sock.sent)
    head, _, rest = data.partition(b"\r\n\r\n")
    messages, leftover = obs_ws.decode_frames(rest)
    return head.decode("latin-1"), messages, leftover


def sent_messages(sock):
    """Все кадры, отправленные клиентом после HTTP-запроса."""
    return split_sent(sock)[1]


def sent_protocol_messages(sock):
    """Только текстовые JSON-сообщения протокола, отправленные клиентом."""
    result = []
    for message in sent_messages(sock):
        if message["opcode"] == obs_ws.OPCODE_TEXT:
            result.append(json.loads(message["text"]))
    return result


def make_client(incoming, password="", timeout=2.0):
    """Клиент на поддельном сокете с заготовленным входящим потоком."""
    sock = FakeSocket(incoming)
    client = obs_ws.ObsWebSocketClient(
        password=password, socket_factory=make_factory(sock), timeout=timeout,
    )
    return client, sock


class AuthStringTest(unittest.TestCase):
    """Строка авторизации obs-websocket v5."""

    def test_documented_auth_vector(self):
        """Пример из документации протокола совпадает с js/obs.js."""
        self.assertEqual(
            obs_ws.build_auth_string(
                DOCUMENTED_PASSWORD, DOCUMENTED_SALT, DOCUMENTED_CHALLENGE,
            ),
            DOCUMENTED_AUTH,
        )

    def test_second_auth_vector(self):
        """Второй контрольный пример из задачи."""
        self.assertEqual(
            obs_ws.build_auth_string("sasha", "test-salt", "test-challenge"),
            TEST_AUTH,
        )

    def test_auth_string_handles_empty_password(self):
        """Пустой пароль — это пустая строка, а не ошибка."""
        result = obs_ws.build_auth_string("", "salt", "challenge")
        self.assertEqual(len(result), 44)  # base64 от sha256 всегда 44 знака.
        self.assertTrue(result.endswith("="))
        self.assertNotEqual(result, obs_ws.build_auth_string("x", "salt", "challenge"))


class HelloTest(unittest.TestCase):
    """Разбор Hello (op 0)."""

    def test_parse_hello_with_authentication(self):
        """Hello с паролем отдаёт rpcVersion и challenge/salt."""
        message = {
            "op": 0,
            "d": {
                "obsWebSocketVersion": "5.5.2",
                "rpcVersion": 1,
                "authentication": {"challenge": "ch", "salt": "sa"},
            },
        }
        self.assertEqual(
            obs_ws.parse_hello(message),
            {
                "rpcVersion": 1,
                "authentication": {"challenge": "ch", "salt": "sa"},
            },
        )
        self.assertEqual(obs_ws.parse_hello(json.dumps(message))["rpcVersion"], 1)

    def test_parse_hello_without_authentication(self):
        """Без authentication в Hello поле остаётся None: пароль не нужен."""
        parsed = obs_ws.parse_hello({"op": 0, "d": {"rpcVersion": 1}})
        self.assertEqual(parsed, {"rpcVersion": 1, "authentication": None})

    def test_parse_hello_ignores_garbage(self):
        """Не Hello и битый JSON дают None, а не исключение."""
        self.assertIsNone(obs_ws.parse_hello({"op": 2, "d": {}}))
        self.assertIsNone(obs_ws.parse_hello({"op": 0}))
        self.assertIsNone(obs_ws.parse_hello("это не JSON"))
        self.assertIsNone(obs_ws.parse_hello(None))
        self.assertIsNone(obs_ws.parse_hello(b"\xff\xfe\xfd"))


class IdentifyTest(unittest.TestCase):
    """Сборка Identify (op 1)."""

    def test_build_identify_with_authentication(self):
        """Пароль считается по challenge/salt из Hello."""
        hello = {"rpcVersion": 1, "authentication": {
            "challenge": "test-challenge", "salt": "test-salt",
        }}
        self.assertEqual(
            obs_ws.build_identify("sasha", hello),
            {"op": 1, "d": {"rpcVersion": 1, "authentication": TEST_AUTH}},
        )

    def test_build_identify_without_authentication(self):
        """Если OBS не требует пароль, поле authentication не отправляется."""
        identify = obs_ws.build_identify("секрет", {"rpcVersion": 1, "authentication": None})
        self.assertEqual(identify, {"op": 1, "d": {"rpcVersion": 1}})
        self.assertNotIn("authentication", identify["d"])


class BroadcastRequestTest(unittest.TestCase):
    """Сборка BroadcastCustomEvent — ровно как в js/obs.js."""

    def test_broadcast_request_is_exact(self):
        """Полная структура запроса: op 5, requestType и eventData."""
        request = obs_ws.build_broadcast_request(
            {
                "app": "чужое", "speaker": "sasha", "name": "Саша",
                "color": "#ff9ee6", "text": "Привет", "final": True,
                "лишнее": "отброшено",
            },
            "sasha-1-123",
        )
        self.assertEqual(request, {
            "op": 6,
            "d": {
                "requestType": "BroadcastCustomEvent",
                "requestId": "sasha-1-123",
                "requestData": {
                    "eventData": {
                        "eventType": "sasha-subtitles",
                        "eventData": {
                            "app": "sasha-subtitles",
                            "speaker": "sasha",
                            "name": "Саша",
                            "color": "#ff9ee6",
                            "text": "Привет",
                            "final": True,
                        },
                    },
                },
            },
        })

    def test_broadcast_defaults(self):
        """Пустая реплика получает значения по умолчанию, как в js/obs.js."""
        event_data = obs_ws.build_broadcast_request({}, 7)["d"]["requestData"]["eventData"]["eventData"]
        self.assertEqual(event_data, {
            "app": "sasha-subtitles",
            "speaker": "host",
            "name": "Ведущий",
            "color": "#8fd8ff",
            "text": "",
            "final": True,
        })
        self.assertEqual(obs_ws.build_broadcast_request({}, 7)["d"]["requestId"], "7")

    def test_broadcast_final_false(self):
        """Промежуточный текст с final=False сохраняется как есть."""
        request = obs_ws.build_broadcast_request({"text": "живой", "final": False}, "id")
        self.assertFalse(request["d"]["requestData"]["eventData"]["eventData"]["final"])


class FrameTest(unittest.TestCase):
    """Кадры WebSocket: маска клиента, длина и разбор по частям."""

    def test_text_frame_is_masked_client_frame(self):
        """Клиентский кадр: FIN=1, opcode=1, маска и правильный текст."""
        text = "Привет, OBS!"
        frame = obs_ws.encode_text_frame(text)
        payload = text.encode("utf-8")
        self.assertEqual(frame[0], 0x81)  # FIN + opcode 1.
        self.assertTrue(frame[1] & 0x80)  # Бит маски.
        self.assertEqual(frame[1] & 0x7F, len(payload))
        key = frame[2:6]
        masked = frame[6:]
        unmasked = bytes(byte ^ key[index % 4] for index, byte in enumerate(masked))
        self.assertEqual(unmasked.decode("utf-8"), text)
        messages, rest = obs_ws.decode_frames(frame)
        self.assertEqual(rest, b"")
        self.assertEqual(messages, [{"opcode": 1, "text": text}])

    def test_long_frames_use_extended_length(self):
        """Средние и очень длинные тексты кодируются 126 и 127."""
        medium = "я" * 200
        frame = obs_ws.encode_text_frame(medium)
        self.assertEqual(frame[1] & 0x7F, 126)
        self.assertEqual(obs_ws.decode_frames(frame)[0][0]["text"], medium)
        large = "x" * 70000
        frame = obs_ws.encode_text_frame(large)
        self.assertEqual(frame[1] & 0x7F, 127)
        self.assertEqual(obs_ws.decode_frames(frame)[0][0]["text"], large)

    def test_decode_partial_frame_keeps_rest(self):
        """Неполный кадр остаётся в остатке до следующего чтения."""
        full = obs_ws.encode_frame("части", mask=False)
        first, rest = obs_ws.decode_frames(full[:3])
        self.assertEqual(first, [])
        self.assertEqual(rest, full[:3])
        second, rest = obs_ws.decode_frames(rest + full[3:])
        self.assertEqual(second, [{"opcode": 1, "text": "части"}])
        self.assertEqual(rest, b"")

    def test_decode_fragmented_message(self):
        """Сообщение из двух фрагментов собирается в одно."""
        first = obs_ws.encode_frame("При", mask=False, fin=False)
        second = obs_ws.encode_frame(
            "вет", opcode=obs_ws.OPCODE_CONTINUATION, mask=False, fin=True,
        )
        messages, rest = obs_ws.decode_frames(first + second)
        self.assertEqual(messages, [{"opcode": 1, "text": "Привет"}])
        self.assertEqual(rest, b"")

    def test_decode_fragmented_partial_returns_rest(self):
        """Недоконченная фрагментация целиком возвращается в остаток."""
        first = obs_ws.encode_frame("При", mask=False, fin=False)
        second = obs_ws.encode_frame(
            "вет", opcode=obs_ws.OPCODE_CONTINUATION, mask=False, fin=True,
        )
        messages, rest = obs_ws.decode_frames(first + second[:2])
        self.assertEqual(messages, [])
        self.assertEqual(rest, first + second[:2])

    def test_decode_multiple_frames(self):
        """Несколько кадров в одном буфере разбираются по порядку."""
        data = (
            obs_ws.encode_frame("раз", mask=False)
            + obs_ws.encode_frame("два", mask=False)
        )
        messages, rest = obs_ws.decode_frames(data)
        self.assertEqual([message["text"] for message in messages], ["раз", "два"])
        self.assertEqual(rest, b"")

    def test_ping_and_pong(self):
        """Ping разбирается, а pong клиента тоже маскируется."""
        ping = obs_ws.encode_frame(b"ping-data", opcode=obs_ws.OPCODE_PING, mask=False)
        messages, _ = obs_ws.decode_frames(ping)
        self.assertEqual(messages[0]["opcode"], obs_ws.OPCODE_PING)
        self.assertEqual(messages[0]["data"], b"ping-data")
        pong = obs_ws.encode_pong_frame(b"ping-data")
        self.assertEqual(pong[0], 0x8A)  # FIN + opcode 10.
        self.assertTrue(pong[1] & 0x80)
        messages, _ = obs_ws.decode_frames(pong)
        self.assertEqual(messages[0]["opcode"], obs_ws.OPCODE_PONG)
        self.assertEqual(messages[0]["data"], b"ping-data")

    def test_close_frame_has_code_and_reason(self):
        """Close отдаёт код и причину — из них получается понятная ошибка."""
        frame = close_frame(4009, "неверный пароль")
        messages, _ = obs_ws.decode_frames(frame)
        self.assertEqual(messages[0]["opcode"], obs_ws.OPCODE_CLOSE)
        self.assertEqual(messages[0]["code"], 4009)
        self.assertEqual(messages[0]["reason"], "неверный пароль")


class HandshakeTest(unittest.TestCase):
    """Рукопожатие HTTP Upgrade и вход Hello → Identify → Identified."""

    def test_connect_sends_upgrade_and_identify(self):
        """В запросе есть GET/Upgrade/Key, затем уходит Identify с паролем."""
        authentication = {"challenge": "test-challenge", "salt": "test-salt"}
        client, sock = make_client(
            HTTP_101 + hello_frame(authentication) + identified_frame(),
            password="sasha",
        )
        client.connect()
        self.assertTrue(client.connected)
        self.assertEqual(client.url, "ws://127.0.0.1:4455")
        head, messages, leftover = split_sent(sock)
        self.assertEqual(leftover, b"")
        self.assertIn("GET / HTTP/1.1", head)
        self.assertIn("Upgrade: websocket", head)
        self.assertIn("Connection: Upgrade", head)
        self.assertIn("Sec-WebSocket-Version: 13", head)
        key = re.search(r"Sec-WebSocket-Key: (\S+)", head)
        self.assertIsNotNone(key)
        self.assertEqual(len(key.group(1)), 24)  # base64 от 16 байт.
        protocol = sent_protocol_messages(sock)
        self.assertEqual(protocol, [{
            "op": 1,
            "d": {"rpcVersion": 1, "authentication": TEST_AUTH},
        }])
        self.assertTrue(any(message["opcode"] == 1 for message in messages))

    def test_connect_without_password_omits_authentication(self):
        """Если Hello без authentication, Identify идёт без пароля."""
        client, sock = make_client(HTTP_101 + hello_frame() + identified_frame())
        client.connect()
        self.assertTrue(client.connected)
        self.assertEqual(
            sent_protocol_messages(sock),
            [{"op": 1, "d": {"rpcVersion": 1}}],
        )

    def test_connect_rejected_handshake(self):
        """Ответ не 101 — понятная ошибка, сокет закрыт."""
        client = obs_ws.ObsWebSocketClient(
            password="", socket_factory=make_factory(FakeSocket(HTTP_400)), timeout=2.0,
        )
        with self.assertRaises(obs_ws.ObsHandshakeError) as caught:
            client.connect()
        self.assertIn("400", str(caught.exception))
        self.assertIn("WebSocket", str(caught.exception))
        self.assertFalse(client.connected)

    def test_connect_answers_ping(self):
        """Ping от OBS получает маскированный pong ещё до Identify."""
        ping = obs_ws.encode_frame(b"ping!", opcode=obs_ws.OPCODE_PING, mask=False)
        client, sock = make_client(HTTP_101 + ping + hello_frame() + identified_frame())
        client.connect()
        self.assertTrue(client.connected)
        pongs = [message for message in sent_messages(sock)
                 if message["opcode"] == obs_ws.OPCODE_PONG]
        self.assertEqual(len(pongs), 1)
        self.assertEqual(pongs[0]["data"], b"ping!")

    def test_connect_connection_closed_before_hello(self):
        """OBS закрыл соединение до Hello — ошибка с подсказкой."""
        client = obs_ws.ObsWebSocketClient(
            password="", socket_factory=make_factory(FakeSocket(HTTP_101)), timeout=2.0,
        )
        with self.assertRaises(obs_ws.ObsConnectionError) as caught:
            client.connect()
        self.assertIn("закрыл соединение", str(caught.exception))
        self.assertIn("OBS → Сервис", str(caught.exception))

    def test_connect_timeout_waiting_hello(self):
        """Если OBS молчит, клиент не висит вечно."""
        client = obs_ws.ObsWebSocketClient(
            password="", socket_factory=make_factory(TimeoutSocket(HTTP_101)),
            timeout=0.1,
        )
        with self.assertRaises(obs_ws.ObsConnectionError) as caught:
            client.connect()
        self.assertIn("не ответил", str(caught.exception))

    def test_connect_rejects_bad_password(self):
        """Close 4009 при входе превращается в понятную ошибку про пароль."""
        client = obs_ws.ObsWebSocketClient(
            password="неверный",
            socket_factory=make_factory(
                FakeSocket(HTTP_101 + hello_frame({"challenge": "c", "salt": "s"})
                           + close_frame(4009, "Authentication failed")),
            ),
            timeout=2.0,
        )
        with self.assertRaises(obs_ws.ObsAuthError) as caught:
            client.connect()
        self.assertIn("4009", str(caught.exception))
        self.assertIn("пароль", str(caught.exception))

    def test_close_marks_disconnected(self):
        """close() закрывает сокет и снимает признак связи."""
        client, sock = make_client(HTTP_101 + hello_frame() + identified_frame())
        client.connect()
        self.assertTrue(client.connected)
        client.close()
        self.assertFalse(client.connected)
        self.assertTrue(sock.closed)


class SendCustomEventTest(unittest.TestCase):
    """Отправка реплики в OBS и поведение при обрыве."""

    def test_send_custom_event_is_exact(self):
        """После входа уходит ровно один BroadcastCustomEvent с нашей репликой."""
        client, sock = make_client(HTTP_101 + hello_frame() + identified_frame())
        client.connect()
        request_id = client.send_custom_event({
            "speaker": "sasha", "name": "Саша", "color": "#ff9ee6",
            "text": "Привет", "final": True,
        })
        self.assertTrue(request_id.startswith("sasha-"))
        protocol = sent_protocol_messages(sock)
        self.assertEqual(len(protocol), 2)  # Identify и BroadcastCustomEvent.
        request = protocol[-1]
        self.assertEqual(request["op"], 6)
        self.assertEqual(request["d"]["requestType"], "BroadcastCustomEvent")
        self.assertEqual(request["d"]["requestId"], request_id)
        self.assertEqual(request["d"]["requestData"], {"eventData": {
            "eventType": "sasha-subtitles",
            "eventData": {
                "app": "sasha-subtitles",
                "speaker": "sasha",
                "name": "Саша",
                "color": "#ff9ee6",
                "text": "Привет",
                "final": True,
            },
        }})

    def test_send_without_connection_raises(self):
        """Без connect() отправка невозможна — понятная ошибка."""
        client = obs_ws.ObsWebSocketClient(timeout=1.0)
        with self.assertRaises(obs_ws.ObsConnectionError) as caught:
            client.send_custom_event({"text": "некуда"})
        self.assertIn("connect", str(caught.exception))

    def test_send_after_break_reconnects(self):
        """После обрыва повторный connect() на новом сокете снова отправляет."""
        broken = FakeSocket(HTTP_101 + hello_frame() + identified_frame())
        fresh = FakeSocket(HTTP_101 + hello_frame() + identified_frame())
        client = obs_ws.ObsWebSocketClient(
            password="", socket_factory=make_factory(broken, fresh), timeout=2.0,
        )
        client.connect()
        broken.fail_send = True
        with self.assertRaises(obs_ws.ObsConnectionError):
            client.send_custom_event({"text": "потерялось"})
        self.assertFalse(client.connected)
        self.assertTrue(broken.closed)
        client.connect()
        self.assertTrue(client.connected)
        request_id = client.send_custom_event({"text": "долетело"})
        self.assertTrue(request_id.startswith("sasha-"))
        protocol = sent_protocol_messages(fresh)
        self.assertEqual(protocol[-1]["op"], 6)
        self.assertEqual(
            protocol[-1]["d"]["requestData"]["eventData"]["eventData"]["text"], "долетело",
        )


class ServerObsHelpersTest(unittest.TestCase):
    """Чистые helper-функции server.py для режима --obs."""

    def test_config_json_has_obs_section(self):
        """config.json и DEFAULT_CONFIG содержат настройки OBS WebSocket."""
        config = server.load_config()
        self.assertEqual(
            config["obs"],
            {"host": "127.0.0.1", "port": 4455, "password": ""},
        )
        self.assertEqual(server.obs_settings(config), config["obs"])

    def test_obs_settings_defaults_and_validation(self):
        """Пустые настройки дают значения по умолчанию, мусор — ValueError."""
        self.assertEqual(
            server.obs_settings({}),
            {"host": "127.0.0.1", "port": 4455, "password": ""},
        )
        self.assertEqual(server.obs_settings({"obs": {"port": "4455"}})["port"], 4455)
        self.assertEqual(server.obs_settings({"obs": {"password": None}})["password"], "")
        with self.assertRaises(ValueError):
            server.obs_settings({"obs": {"port": "не число"}})
        with self.assertRaises(ValueError):
            server.obs_settings({"obs": {"port": 70000}})
        with self.assertRaises(ValueError):
            server.obs_settings({"obs": "мусор"})

    def test_to_obs_payload_is_exact(self):
        """Payload для OBS: app, имя и цвет из config, мат замаскирован, final=True."""
        config = server.load_config()
        payload = server.to_obs_payload(
            config, {"speaker": "sasha", "text": "  Привет,   блять  "},
        )
        self.assertEqual(payload, {
            "app": "sasha-subtitles",
            "speaker": "sasha",
            "name": "Саша",
            "color": "#ff9ee6",
            "text": "Привет, б****",
            "final": True,
        })

    def test_to_obs_payload_defaults_for_unknown_speaker(self):
        """Незнакомый или пустой говорящий получает имя и цвет по умолчанию."""
        config = server.load_config()
        payload = server.to_obs_payload(config, {"text": "Привет"})
        self.assertEqual(payload["speaker"], "host")
        self.assertEqual(payload["name"], "Ведущий")
        self.assertEqual(payload["color"], "#8fd8ff")

    def test_to_obs_payload_keeps_full_text(self):
        """Полный текст не режется на экраны: это работа overlay.html."""
        config = server.load_config()
        text = "очень длинная фраза " * 10
        payload = server.to_obs_payload(config, {"speaker": "sasha", "text": text})
        self.assertEqual(payload["text"], text.strip())
        self.assertNotIn("\n", payload["text"])

    def test_publish_obs_event_filters(self):
        """Пустой текст и команда эмоции не уходят в OBS, обычная фраза уходит."""
        config = server.load_config()

        class RecordingRelay:
            def __init__(self):
                self.payloads = []

            def send(self, payload):
                self.payloads.append(payload)
                return True

        relay = RecordingRelay()
        self.assertFalse(server.publish_obs_event(
            config, relay, {"speaker": "sasha", "text": "э:радость"}))
        self.assertFalse(server.publish_obs_event(
            config, relay, {"speaker": "sasha", "text": "   "}))
        self.assertTrue(server.publish_obs_event(
            config, relay, {"speaker": "sasha", "text": "Привет"}))
        self.assertEqual(relay.payloads, [
            server.to_obs_payload(config, {"speaker": "sasha", "text": "Привет"}),
        ])

    def test_server_hint_is_exact(self):
        """Подсказка про WebSocket в OBS дословно совпадает с js/obs.js."""
        self.assertEqual(
            obs_ws.HINT_WS_OFF,
            "OBS → Сервис → Настройки WebSocket-сервера → Включить, задать пароль",
        )


class FakeObsClient:
    """Поддельный клиент OBS для проверки переподключения ObsRelay."""

    def __init__(self, connect_error=None):
        self.connected = False
        self.connect_error = connect_error
        self.fail_send = False
        self.sent = []
        self.closed = False

    def connect(self):
        if self.connect_error is not None:
            raise self.connect_error
        self.connected = True
        return self

    def send_custom_event(self, payload):
        if self.fail_send:
            raise obs_ws.ObsConnectionError("труба закрыта")
        self.sent.append(payload)
        return "sasha-1"

    def close(self):
        self.connected = False
        self.closed = True


class ObsRelayTest(unittest.TestCase):
    """Переподключение режима --obs после недоступного OBS и обрыва."""

    def make_relay(self, clients):
        return server.ObsRelay(
            server.load_config(),
            client_factory=lambda: clients.pop(0),
            retry_seconds=0.0,
            clock=lambda: 0.0,
        )

    def test_relay_retries_unavailable_obs(self):
        """Первая попытка падает — вторая подключается, реплика уходит."""
        first = FakeObsClient(connect_error=obs_ws.ObsConnectionError("OBS выключен"))
        second = FakeObsClient()
        relay = self.make_relay([first, second])
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertFalse(relay.ensure_connected())
            self.assertTrue(relay.send({"text": "раз"}))
        self.assertIn("OBS → Сервис", buffer.getvalue())
        self.assertTrue(first.closed)
        self.assertEqual(second.sent, [{"text": "раз"}])
        relay.close()

    def test_relay_reconnects_after_break(self):
        """После обрыва отправки Relay закрывает старый клиент и берёт новый."""
        first = FakeObsClient()
        second = FakeObsClient()
        relay = self.make_relay([first, second])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(relay.ensure_connected())
            first.fail_send = True
            self.assertFalse(relay.send({"text": "потерялось"}))
            self.assertTrue(relay.send({"text": "долетело"}))
        self.assertTrue(first.closed)
        self.assertEqual(second.sent, [{"text": "долетело"}])
        relay.close()


if __name__ == "__main__":
    unittest.main()
