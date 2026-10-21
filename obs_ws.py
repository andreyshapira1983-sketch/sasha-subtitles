"""Клиент OBS WebSocket (протокол obs-websocket v5) на чистой стандартной библиотеке.

Запасной путь Python → OBS: сервер читает свои журналы и отправляет готовые
фразы в OBS запросом BroadcastCustomEvent — ровно так же, как это делает
страница control.html (js/obs.js). Никаких сторонних пакетов, только ws://
на своём компьютере, без TLS.

Что здесь есть:
  * build_auth_string — строка авторизации SHA-256 из протокола v5;
  * parse_hello / build_identify — вход Hello → Identify → Identified;
  * build_broadcast_request — запрос BroadcastCustomEvent;
  * encode_text_frame / encode_pong_frame — кадры клиента (с маской);
  * decode_frames — разбор кадров сервера (без маски), включая ping→pong;
  * ObsWebSocketClient — подключение, вход по паролю и отправка реплик.

Сообщения об ошибках — по-русски, с подсказкой, где включить WebSocket в OBS.
"""

import base64
import hashlib
import json
import os
import socket
import struct
import time

# Имя программы внутри OBS: по нему overlay отличает чужие CustomEvent.
APP = "sasha-subtitles"
EVENT_TYPE = "sasha-subtitles"
CUSTOM_EVENT = "CustomEvent"
BROADCAST_REQUEST = "BroadcastCustomEvent"
RPC_VERSION = 1
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4455

# Подсказка человеку, когда OBS не отвечает: путь в меню OBS.
HINT_WS_OFF = "OBS → Сервис → Настройки WebSocket-сервера → Включить, задать пароль"

# Коды операций протокола obs-websocket v5 (числа не меняются).
OP_HELLO = 0
OP_IDENTIFY = 1
OP_IDENTIFIED = 2
OP_EVENT = 5
OP_REQUEST = 6
OP_REQUEST_RESPONSE = 7

# Коды opcode WebSocket (RFC 6455).
OPCODE_CONTINUATION = 0x0
OPCODE_TEXT = 0x1
OPCODE_BINARY = 0x2
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA

# Ограничение на заголовок рукопожатия: защита от мусора в сокете.
MAX_HANDSHAKE_BYTES = 64 * 1024
# Сколько байт читаем из сокета за один раз.
RECV_CHUNK = 4096


class ObsWebSocketError(Exception):
    """Общая ошибка связи с OBS WebSocket: текст уже понятен человеку."""


class ObsConnectionError(ObsWebSocketError):
    """Не удалось подключиться или связь оборвалась."""


class ObsHandshakeError(ObsWebSocketError):
    """OBS не принял HTTP-рукопожатие WebSocket."""


class ObsAuthError(ObsWebSocketError):
    """OBS отклонил вход (обычно неверный пароль)."""


class ObsProtocolError(ObsWebSocketError):
    """OBS прислал кадр или сообщение, которого нет в протоколе."""


def build_auth_string(password, salt, challenge):
    """Считает строку авторизации obs-websocket v5.

    secret = base64(sha256(password + salt))
    auth   = base64(sha256(secret + challenge))

    Ровно так же считает js/obs.js (authString), поэтому обе реализации
    проходят одни и те же контрольные примеры из документации протокола.
    """
    password = "" if password is None else str(password)
    salt = "" if salt is None else str(salt)
    challenge = "" if challenge is None else str(challenge)
    secret = base64.b64encode(
        hashlib.sha256((password + salt).encode("utf-8")).digest()
    ).decode("ascii")
    return base64.b64encode(
        hashlib.sha256((secret + challenge).encode("utf-8")).digest()
    ).decode("ascii")


def _loads_message(message):
    """Разбирает JSON из сообщения; мусор даёт None, а не исключение."""
    if isinstance(message, dict):
        return message
    if isinstance(message, (bytes, bytearray)):
        try:
            message = bytes(message).decode("utf-8")
        except UnicodeDecodeError:
            return None
    if not isinstance(message, str):
        return None
    try:
        data = json.loads(message)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def parse_hello(message):
    """Разбирает Hello (op 0).

    Возвращает {"rpcVersion": int, "authentication": {...}|None} или None,
    если это не Hello. authentication есть только тогда, когда OBS требует
    пароль (в Hello пришли challenge и salt).
    """
    data = _loads_message(message)
    if data is None or data.get("op") != OP_HELLO:
        return None
    payload = data.get("d")
    if not isinstance(payload, dict):
        return None
    try:
        rpc_version = int(payload.get("rpcVersion", RPC_VERSION))
    except (TypeError, ValueError):
        rpc_version = RPC_VERSION
    auth = payload.get("authentication")
    authentication = None
    if isinstance(auth, dict) and auth.get("challenge") and auth.get("salt"):
        authentication = {
            "challenge": str(auth["challenge"]),
            "salt": str(auth["salt"]),
        }
    return {"rpcVersion": rpc_version, "authentication": authentication}


def build_identify(password, hello):
    """Собирает Identify (op 1).

    Пароль нужен, только если OBS его требует: без authentication в Hello
    поле authentication не отправляется (как в js/obs.js).
    """
    data = {"rpcVersion": RPC_VERSION}
    authentication = (hello or {}).get("authentication")
    if authentication:
        data["authentication"] = build_auth_string(
            password,
            authentication.get("salt", ""),
            authentication.get("challenge", ""),
        )
    return {"op": OP_IDENTIFY, "d": data}


def build_broadcast_payload(payload):
    """Приводит реплику к виду, который понимает overlay.

    {app, speaker, name, color, text, final}: лишние поля отбрасываются,
    значения по умолчанию — «Ведущий» и голубой цвет, как в js/obs.js.
    """
    source = payload if isinstance(payload, dict) else {}
    speaker = source.get("speaker")
    name = source.get("name")
    color = source.get("color")
    text = source.get("text")
    return {
        "app": APP,
        "speaker": "host" if speaker is None else str(speaker),
        "name": "Ведущий" if name is None else str(name),
        "color": "#8fd8ff" if color is None else str(color),
        "text": "" if text is None else str(text),
        # Без явного final:false считаем реплику готовой фразой.
        "final": source.get("final") is not False,
    }


def build_broadcast_request(payload, request_id):
    """Собирает запрос BroadcastCustomEvent (op 5, Request) как js/obs.js."""
    return {
        "op": OP_REQUEST,
        "d": {
            "requestType": BROADCAST_REQUEST,
            "requestId": str(request_id),
            "requestData": {
                "eventType": EVENT_TYPE,
                "eventData": build_broadcast_payload(payload),
            },
        },
    }


def encode_frame(payload, opcode=OPCODE_TEXT, fin=True, mask=True):
    """Собирает кадр WebSocket.

    Клиент обязан маскировать свои кадры (RFC 6455), поэтому по умолчанию
    mask=True. Для поддельного сервера в тестах можно собрать кадр без маски.
    """
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    elif isinstance(payload, (bytes, bytearray)):
        payload = bytes(payload)
    else:
        payload = str(payload).encode("utf-8")
    length = len(payload)
    first = (0x80 if fin else 0x00) | (int(opcode) & 0x0F)
    mask_bit = 0x80 if mask else 0x00
    header = bytes([first])
    if length < 126:
        header += bytes([mask_bit | length])
    elif length < 65536:
        header += bytes([mask_bit | 126]) + struct.pack("!H", length)
    else:
        header += bytes([mask_bit | 127]) + struct.pack("!Q", length)
    if not mask:
        return header + payload
    key = os.urandom(4)
    masked = bytes(byte ^ key[index % 4] for index, byte in enumerate(payload))
    return header + key + masked


def encode_text_frame(text):
    """Клиентский текстовый кадр с маской (FIN=1, opcode=1)."""
    return encode_frame(text, opcode=OPCODE_TEXT, fin=True, mask=True)


def encode_pong_frame(payload=b""):
    """Клиентский pong с маской — ответ на ping от OBS."""
    return encode_frame(payload, opcode=OPCODE_PONG, fin=True, mask=True)


def encode_close_frame(code=1000, reason=""):
    """Клиентский close с маской: вежливое прощание перед закрытием сокета."""
    payload = struct.pack("!H", int(code)) + str(reason).encode("utf-8")
    return encode_frame(payload, opcode=OPCODE_CLOSE, fin=True, mask=True)


def _read_frame(data, offset):
    """Разбирает один кадр из буфера.

    Возвращает {"fin", "opcode", "payload", "offset"} или None, если байтов
    ещё не хватает (кадр придёт следующим чтением).
    """
    available = len(data)
    if available - offset < 2:
        return None
    first = data[offset]
    second = data[offset + 1]
    fin = bool(first & 0x80)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    position = offset + 2
    if length == 126:
        if available - position < 2:
            return None
        length = struct.unpack("!H", data[position:position + 2])[0]
        position += 2
    elif length == 127:
        if available - position < 8:
            return None
        length = struct.unpack("!Q", data[position:position + 8])[0]
        position += 8
    key = b""
    if masked:
        if available - position < 4:
            return None
        key = data[position:position + 4]
        position += 4
    if available - position < length:
        return None
    payload = bytes(data[position:position + length])
    position += length
    if masked:
        payload = bytes(byte ^ key[index % 4] for index, byte in enumerate(payload))
    return {"fin": fin, "opcode": opcode, "payload": payload, "offset": position}


def _build_message(opcode, payload):
    """Превращает собранный кадр в сообщение для вызывающего кода."""
    if opcode == OPCODE_TEXT:
        return {"opcode": OPCODE_TEXT, "text": payload.decode("utf-8", errors="replace")}
    message = {"opcode": opcode, "data": payload}
    if opcode == OPCODE_CLOSE:
        if len(payload) >= 2:
            message["code"] = struct.unpack("!H", payload[:2])[0]
        else:
            message["code"] = None
        message["reason"] = payload[2:].decode("utf-8", errors="replace")
    return message


def decode_frames(buffer):
    """Разбирает кадры WebSocket из буфера.

    Возвращает пару (сообщения, остаток буфера). Каждое сообщение — словарь:
      {"opcode": 1, "text": "..."} — текст (JSON протокола);
      {"opcode": 2, "data": b"..."} — двоичные данные;
      {"opcode": 8, "data": ..., "code": 1000, "reason": "..."} — close;
      {"opcode": 9|10, "data": b"..."} — ping/pong.

    Серверные кадры обычно без маски, но клиентские кадры тоже разбираются:
    маска снимается, если она есть. Неполный кадр или недоконченная
    фрагментация остаются в остатке — их нужно дослать следующим чтением.
    Фрагментированные сообщения (FIN=0, затем continuation) собираются
    в одно сообщение.
    """
    data = bytes(buffer) if buffer else b""
    messages = []
    index = 0
    fragment_opcode = None
    fragment_parts = []
    fragment_start = 0
    while True:
        frame = _read_frame(data, index)
        if frame is None:
            break
        opcode = frame["opcode"]
        payload = frame["payload"]
        if opcode == OPCODE_CONTINUATION:
            if fragment_opcode is None:
                raise ObsProtocolError(
                    "OBS прислал кадр продолжения без начала сообщения."
                )
            fragment_parts.append(payload)
            index = frame["offset"]
            if frame["fin"]:
                messages.append(_build_message(fragment_opcode, b"".join(fragment_parts)))
                fragment_opcode = None
                fragment_parts = []
            continue
        if fragment_opcode is not None:
            raise ObsProtocolError(
                "OBS начал новое сообщение, не закончив предыдущее."
            )
        if frame["fin"]:
            messages.append(_build_message(opcode, payload))
            index = frame["offset"]
        else:
            fragment_opcode = opcode
            fragment_parts = [payload]
            fragment_start = index
            index = frame["offset"]
    # Недоконченную фрагментацию возвращаем целиком: в следующий раз
    # разберём её заново, когда подойдёт продолжение.
    rest_start = fragment_start if fragment_opcode is not None else index
    return messages, data[rest_start:]


class ObsWebSocketClient:
    """Клиент OBS WebSocket: connect(), send_custom_event(payload), close().

    Только ws:// на своём компьютере, без TLS. socket_factory нужен для
    тестов на поддельном сокете; по умолчанию socket.create_connection.
    """

    def __init__(self, host=DEFAULT_HOST, port=DEFAULT_PORT, password="",
                 socket_factory=None, timeout=5.0):
        self.host = str(host or DEFAULT_HOST)
        self.port = int(port)
        self.password = "" if password is None else str(password)
        self.socket_factory = socket_factory
        self.timeout = float(timeout)
        self._socket = None
        self._buffer = b""
        self._pending = []
        self._identified = False
        self._request_counter = 0

    @property
    def url(self):
        """Адрес OBS WebSocket для сообщений человеку."""
        return f"ws://{self.host}:{self.port}"

    @property
    def connected(self):
        """True, когда рукопожатие и вход Hello→Identify→Identified пройдены."""
        return self._socket is not None and self._identified

    # ---------- служебное ----------

    def _open_socket(self):
        """Открывает TCP-соединение с OBS (через поддельный сокет в тестах)."""
        if self.socket_factory is None:
            return socket.create_connection((self.host, self.port), self.timeout)
        try:
            return self.socket_factory((self.host, self.port), self.timeout)
        except TypeError:
            # Простые фабрики в тестах могут принимать только адрес или ничего.
            try:
                return self.socket_factory((self.host, self.port))
            except TypeError:
                return self.socket_factory()

    def _send_all(self, data):
        """Отправляет все байты, даже если send() принял только часть."""
        sock = self._socket
        if sock is None:
            raise ObsConnectionError("Нет связи с OBS WebSocket: сначала подключитесь.")
        if hasattr(sock, "sendall"):
            sock.sendall(data)
            return
        sent = 0
        while sent < len(data):
            chunk = sock.send(data[sent:])
            if not chunk:
                raise ObsConnectionError("OBS закрыл соединение при отправке данных.")
            sent += chunk

    def _send_message(self, message):
        """Собирает JSON-сообщение протокола в текстовый кадр и отправляет."""
        raw = json.dumps(message, ensure_ascii=False)
        self._send_all(encode_text_frame(raw))

    def _fill_pending(self):
        """Разбирает буфер и складывает готовые сообщения в очередь.

        Ping сразу получает pong, pong ничего не делает — как в браузерном
        WebSocket. Остальные сообщения ждут в очереди.
        """
        messages, self._buffer = decode_frames(self._buffer)
        for message in messages:
            opcode = message["opcode"]
            if opcode == OPCODE_PING:
                try:
                    self._send_all(encode_pong_frame(message.get("data", b"")))
                except OSError as error:
                    raise ObsConnectionError(
                        f"Не удалось ответить на ping OBS: {error}"
                    ) from error
                continue
            if opcode == OPCODE_PONG:
                continue
            self._pending.append(message)

    def _next_message(self, deadline):
        """Ждёт следующее сообщение протокола до deadline (time.monotonic)."""
        while True:
            # Сначала разбираем то, что уже лежит в буфере: после рукопожатия
            # в нём могут быть Hello и Identified, прочитанные с HTTP-ответом.
            self._fill_pending()
            if self._pending:
                return self._pending.pop(0)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ObsConnectionError(
                    f"OBS WebSocket не ответил за {self.timeout:g} с. "
                    f"Проверьте, что OBS запущен. {HINT_WS_OFF}"
                )
            sock = self._socket
            if sock is None:
                raise ObsConnectionError("Связь с OBS WebSocket потеряна.")
            try:
                chunk = sock.recv(RECV_CHUNK)
            except socket.timeout as error:
                raise ObsConnectionError(
                    f"OBS WebSocket не ответил за {self.timeout:g} с. "
                    f"Проверьте, что OBS запущен. {HINT_WS_OFF}"
                ) from error
            except OSError as error:
                raise ObsConnectionError(
                    f"Связь с OBS WebSocket прервана: {error}"
                ) from error
            if not chunk:
                raise ObsConnectionError(
                    "OBS закрыл соединение. Проверьте, что WebSocket-сервер включён "
                    f"и пароль в config.json совпадает. {HINT_WS_OFF}"
                )
            self._buffer += chunk

    def _describe_close(self, message):
        """Превращает close от OBS в понятную русскую ошибку."""
        code = message.get("code")
        reason = (message.get("reason") or "").strip()
        if code == 4009:
            return ObsAuthError(
                "OBS не принял пароль (код 4009). Проверьте поле obs.password "
                f"в config.json. {HINT_WS_OFF}"
            )
        if code == 4008:
            return ObsAuthError(
                "OBS отклонил вход: несовместимая версия протокола. "
                "Нужен OBS 28 или новее (obs-websocket v5)."
            )
        text = "OBS закрыл соединение"
        if code:
            text += f" (код {code})"
        if reason:
            text += f": {reason}"
        else:
            text += "."
        return ObsConnectionError(text)

    # ---------- рукопожатие ----------

    def _handshake_request(self):
        """Собирает HTTP-запрос Upgrade на ws://host:port/."""
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        return (
            "GET / HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ).encode("ascii")

    def _read_handshake_response(self):
        """Читает ответ OBS и требует код 101 Switching Protocols."""
        while b"\r\n\r\n" not in self._buffer:
            if len(self._buffer) > MAX_HANDSHAKE_BYTES:
                raise ObsHandshakeError(
                    "OBS прислал слишком длинный ответ на рукопожатие WebSocket."
                )
            sock = self._socket
            if sock is None:
                raise ObsHandshakeError("Связь с OBS оборвалась во время рукопожатия.")
            try:
                chunk = sock.recv(RECV_CHUNK)
            except socket.timeout as error:
                raise ObsHandshakeError(
                    f"OBS WebSocket не ответил за {self.timeout:g} с. "
                    f"Проверьте, что OBS запущен. {HINT_WS_OFF}"
                ) from error
            except OSError as error:
                raise ObsHandshakeError(
                    f"Не удалось подключиться к OBS WebSocket: {error}. {HINT_WS_OFF}"
                ) from error
            if not chunk:
                raise ObsHandshakeError(
                    f"OBS закрыл соединение во время рукопожатия. {HINT_WS_OFF}"
                )
            self._buffer += chunk
        head, _, self._buffer = self._buffer.partition(b"\r\n\r\n")
        lines = head.decode("latin-1", errors="replace").split("\r\n")
        status = lines[0].strip() if lines else ""
        parts = status.split(" ", 2)
        code = parts[1] if len(parts) > 1 else ""
        if code != "101":
            raise ObsHandshakeError(
                f"OBS не принял WebSocket-подключение (ответ «{status or 'пусто'}»). "
                f"Проверьте, что WebSocket-сервер включён. {HINT_WS_OFF}"
            )
        return status

    def _wait_hello_and_identify(self, deadline):
        """Ждёт Hello, отправляет Identify и ждёт Identified."""
        while True:
            message = self._next_message(deadline)
            if message["opcode"] == OPCODE_CLOSE:
                raise self._describe_close(message)
            if message["opcode"] != OPCODE_TEXT:
                raise ObsProtocolError(
                    f"OBS прислал неожиданный кадр (opcode {message['opcode']}) "
                    "вместо Hello."
                )
            hello = parse_hello(message.get("text"))
            if hello is None:
                raise ObsProtocolError(
                    "OBS прислал не Hello — проверить протокол WebSocket не удалось."
                )
            self._send_message(build_identify(self.password, hello))
            return self._wait_identified(deadline)

    def _wait_identified(self, deadline):
        """Ждёт Identified (op 2); события OBS до него пропускает."""
        while True:
            message = self._next_message(deadline)
            if message["opcode"] == OPCODE_CLOSE:
                raise self._describe_close(message)
            if message["opcode"] != OPCODE_TEXT:
                raise ObsProtocolError(
                    f"OBS прислал неожиданный кадр (opcode {message['opcode']}) "
                    "вместо Identified."
                )
            data = _loads_message(message.get("text"))
            if data is None:
                raise ObsProtocolError("OBS прислал непонятный JSON вместо Identified.")
            op = data.get("op")
            if op == OP_IDENTIFIED:
                return
            if op == OP_EVENT:
                continue  # Событие до Identified не мешает входу.
            raise ObsProtocolError(
                f"OBS прислал вместо Identified сообщение op {op!r}. "
                "Скорее всего, это другая версия obs-websocket."
            )

    # ---------- публичные методы ----------

    def connect(self):
        """Подключается, проходит Hello→Identify→Identified. Возвращает self."""
        self.close()
        try:
            self._socket = self._open_socket()
        except OSError as error:
            self._socket = None
            raise ObsConnectionError(
                f"Не удалось подключиться к OBS WebSocket {self.url}: {error}. "
                f"Проверьте, что OBS запущен. {HINT_WS_OFF}"
            ) from error
        self._buffer = b""
        self._pending = []
        self._identified = False
        deadline = time.monotonic() + self.timeout
        try:
            self._send_all(self._handshake_request())
            self._read_handshake_response()
            self._wait_hello_and_identify(deadline)
        except ObsWebSocketError:
            self.close()
            raise
        except OSError as error:
            self.close()
            raise ObsConnectionError(
                f"Связь с OBS WebSocket {self.url} прервана: {error}"
            ) from error
        self._identified = True
        return self

    def send_custom_event(self, payload):
        """Отправляет реплику одним запросом BroadcastCustomEvent.

        Возвращает requestId отправленного запроса. При обрыве связи
        закрывает сокет и поднимает ObsConnectionError — вызывающий код
        должен переподключиться.
        """
        if not self.connected:
            raise ObsConnectionError(
                "Нет связи с OBS WebSocket: сначала подключитесь (connect)."
            )
        self._request_counter += 1
        request_id = f"sasha-{self._request_counter}-{int(time.time() * 1000)}"
        try:
            self._send_message(build_broadcast_request(payload, request_id))
        except OSError as error:
            self.close()
            raise ObsConnectionError(
                f"Не удалось отправить реплику в OBS: {error}"
            ) from error
        return request_id

    def close(self):
        """Вежливо прощается и закрывает сокет; переподключения сам не делает."""
        sock = self._socket
        was_identified = self._identified
        self._socket = None
        self._buffer = b""
        self._pending = []
        self._identified = False
        if sock is None:
            return
        if was_identified:
            # Best-effort: OBS не должен считать, будто мы пропали молча.
            try:
                sock.sendall(encode_close_frame())
            except OSError:
                pass  # Сокет уже сломан — закрываем как есть.
        try:
            sock.close()
        except OSError:
            pass  # Сокет уже закрыт — это не ошибка.
