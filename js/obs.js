"use strict";
// Мост к OBS через встроенный WebSocket (OBS 28+, протокол obs-websocket v5).
//
// Ничего устанавливать не нужно: control.html и overlay.html открывают
// ws://127.0.0.1:4455 и говорят на языке протокола v5. Здесь собрано всё,
// что не зависит от страницы: пароль (SHA-256 через crypto.subtle),
// Hello → Identify, запрос BroadcastCustomEvent и разбор CustomEvent.
//
// Обычный браузерный скрипт без модулей: работает и в Chrome/Edge,
// и в тестах на Node.
(function (global) {
  "use strict";

  const SS = global.SS || (global.SS = {});

  // Имя программы внутри OBS: по нему overlay отличает чужие CustomEvent.
  const APP = "sasha-subtitles";
  const EVENT_TYPE = "sasha-subtitles";
  const CUSTOM_EVENT = "CustomEvent";
  const DEFAULT_URL = "ws://127.0.0.1:4455";
  const DEFAULT_PORT = "4455";
  const RPC_VERSION = 1;
  const BROADCAST_REQUEST = "BroadcastCustomEvent";

  // Коды операций протокола obs-websocket v5 (числа не меняются).
  const OP = Object.freeze({
    HELLO: 0,
    IDENTIFY: 1,
    IDENTIFIED: 2,
    REIDENTIFY: 3,
    EVENT: 4,
    REQUEST: 5,
    REQUEST_RESPONSE: 6,
    REQUEST_BATCH: 7,
    REQUEST_BATCH_RESPONSE: 8,
  });

  // Подсказка человеку, когда OBS не отвечает: путь в меню OBS.
  const HINT_WS_OFF =
    "OBS → Сервис → Настройки WebSocket-сервера → Включить, задать пароль";

  const BASE64_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  /** Закодировать байты в base64 (стандартный алфавит, с «=»). */
  function bytesToBase64(bytes) {
    let result = "";
    let index = 0;
    while (index < bytes.length) {
      const first = bytes[index];
      const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
      const left = index + 1 < bytes.length;
      const right = index + 2 < bytes.length;
      result += BASE64_ALPHABET[first >> 2];
      result += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
      result += left ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : "=";
      result += right ? BASE64_ALPHABET[third & 0x3f] : "=";
      index += 3;
    }
    return result;
  }

  /** SHA-256 от строки UTF-8, результат — base64. */
  async function sha256Base64(text, cryptoImpl) {
    const impl = cryptoImpl || global.crypto;
    if (!impl || !impl.subtle || typeof impl.subtle.digest !== "function") {
      throw new Error("браузер не умеет crypto.subtle");
    }
    const encoder = new global.TextEncoder();
    const data = encoder.encode(String(text));
    const digest = await impl.subtle.digest("SHA-256", data);
    return bytesToBase64(new Uint8Array(digest));
  }

  /**
   * Строка авторизации obs-websocket v5:
   *   secret = base64(sha256(password + salt))
   *   auth   = base64(sha256(secret + challenge))
   * Ровно так описано в протоколе: пример входа проверяется в
   * tests/obs.test.js, а такой же расчёт на Python — в test_obs_ws.py.
   */
  async function authString(password, salt, challenge, cryptoImpl) {
    const secret = await sha256Base64(
      String(password === undefined || password === null ? "" : password) + String(salt),
      cryptoImpl
    );
    return sha256Base64(secret + String(challenge), cryptoImpl);
  }

  /** Разобрать JSON из WebSocket; мусор даёт null, а не исключение. */
  function parseMessage(raw) {
    if (raw && typeof raw === "object") return raw;
    if (typeof raw !== "string") return null;
    try {
      const message = JSON.parse(raw);
      return message && typeof message === "object" ? message : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Разобрать Hello (op 0). Возвращает версию протокола и данные входа
   * или null, если это не Hello.
   */
  function parseHello(message) {
    if (!message || message.op !== OP.HELLO || !message.d) return null;
    const data = message.d;
    const auth = data.authentication;
    const authentication =
      auth && typeof auth === "object" && auth.challenge && auth.salt
        ? { challenge: String(auth.challenge), salt: String(auth.salt) }
        : null;
    return {
      rpcVersion: Number(data.rpcVersion) || RPC_VERSION,
      authentication: authentication,
    };
  }

  /**
   * Собрать Identify (op 1). Пароль нужен, только если OBS его требует:
   * без authentication в Hello поле authentication не отправляется.
   */
  async function identifyMessage(password, hello, cryptoImpl) {
    const data = { rpcVersion: RPC_VERSION };
    if (hello && hello.authentication) {
      data.authentication = await authString(
        password,
        hello.authentication.salt,
        hello.authentication.challenge,
        cryptoImpl
      );
    }
    return { op: OP.IDENTIFY, d: data };
  }

  /**
   * Привести реплику к виду, который понимает overlay:
   * {app, speaker, name, color, text, final}. Лишние поля отбрасываются,
   * значения по умолчанию — «Ведущий» и голубой цвет.
   */
  function buildBroadcastPayload(data) {
    const source = data && typeof data === "object" ? data : {};
    return {
      app: APP,
      speaker: source.speaker === undefined || source.speaker === null
        ? "host"
        : String(source.speaker),
      name: source.name === undefined || source.name === null
        ? "Ведущий"
        : String(source.name),
      color: source.color === undefined || source.color === null
        ? "#8fd8ff"
        : String(source.color),
      text: source.text === undefined || source.text === null
        ? ""
        : String(source.text),
      // Без явного final:false считаем реплику готовой фразой.
      final: source.final !== false,
    };
  }

  /** Собрать запрос BroadcastCustomEvent (op 5, Request). */
  function broadcastRequest(data, requestId) {
    return {
      op: OP.REQUEST,
      d: {
        requestType: BROADCAST_REQUEST,
        requestId: String(requestId),
        requestData: {
          eventType: EVENT_TYPE,
          eventData: buildBroadcastPayload(data),
        },
      },
    };
  }

  /**
   * Разобрать событие OBS и достать из него нашу реплику.
   * Чужие события (другое eventType, другое app) дают null.
   */
  function parseCustomEvent(message) {
    if (!message || message.op !== OP.EVENT || !message.d) return null;
    const data = message.d;
    if (data.eventType !== CUSTOM_EVENT) return null;
    const wrapper = data.eventData;
    if (!wrapper || typeof wrapper !== "object") return null;
    if (wrapper.eventType !== EVENT_TYPE) return null;
    const payload = wrapper.eventData;
    if (!payload || typeof payload !== "object") return null;
    if (payload.app !== APP) return null;
    return buildBroadcastPayload(payload);
  }

  /** Разрешено ли подключаться к этому адресу: только свой компьютер. */
  function isLocalHost(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }

  /**
   * Привести адрес OBS к виду ws://127.0.0.1:4455.
   * Без схемы подставляется ws://; чужие адреса запрещены — вернётся null.
   */
  function normalizeUrl(input) {
    let text = input === undefined || input === null ? "" : String(input).trim();
    if (!text) text = DEFAULT_URL;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = "ws://" + text;
    let parsed;
    try {
      parsed = new global.URL(text);
    } catch (error) {
      return null;
    }
    if (parsed.protocol !== "ws:") return null;
    if (!isLocalHost(parsed.hostname)) return null;
    const port = parsed.port || DEFAULT_PORT;
    return "ws://" + parsed.hostname.toLowerCase() + ":" + port;
  }

  /**
   * Разобрать хвост адреса overlay.html: «#ws://127.0.0.1:4455|пароль».
   * Пароль стоит после вертикальной черты и в запросах не участвует:
   * часть после «#» браузер на сервер не отправляет.
   */
  function parseWebSocketHash(hash) {
    let text = hash === undefined || hash === null ? "" : String(hash);
    if (text.startsWith("#")) text = text.slice(1);
    if (!text) return null;
    const separator = text.indexOf("|");
    const urlPart = separator >= 0 ? text.slice(0, separator) : text;
    const password = separator >= 0 ? text.slice(separator + 1) : "";
    const url = normalizeUrl(urlPart);
    if (!url) return null;
    return { url: url, password: password };
  }

  /** Собрать хвост адреса overlay.html из адреса и пароля (для README). */
  function buildWebSocketHash(inputUrl, password) {
    const url = normalizeUrl(inputUrl) || DEFAULT_URL;
    const secret = password === undefined || password === null ? "" : String(password);
    return "#" + url + (secret ? "|" + secret : "");
  }

  /** Число из настроек: если мусор — берём запасное значение. */
  function _toNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  /**
   * Клиент OBS WebSocket: подключается, входит по паролю, шлёт реплики
   * и сам переподключается после обрыва.
   *
   * options: url, password, createSocket(url), setTimeout, clearTimeout,
   *          reconnectDelay, maxReconnectDelay, now, crypto,
   *          onState(state), onReady(), onCustomEvent(payload),
   *          onError(message).
   */
  function createClient(options) {
    const settings = options || {};
    const url = normalizeUrl(settings.url) || DEFAULT_URL;
    const password =
      settings.password === undefined || settings.password === null
        ? ""
        : String(settings.password);
    const createSocket =
      typeof settings.createSocket === "function"
        ? settings.createSocket
        : function (target) {
            if (typeof global.WebSocket !== "function") {
              throw new Error("браузер не умеет WebSocket");
            }
            return new global.WebSocket(target);
          };
    const setTimer =
      typeof settings.setTimeout === "function"
        ? settings.setTimeout
        : function (callback, ms) {
            return global.setTimeout(callback, ms);
          };
    const clearTimer =
      typeof settings.clearTimeout === "function"
        ? settings.clearTimeout
        : function (id) {
            return global.clearTimeout(id);
          };
    const reconnectDelay = _toNumber(settings.reconnectDelay, 1000);
    const maxReconnectDelay = _toNumber(settings.maxReconnectDelay, 10000);
    const now = typeof settings.now === "function" ? settings.now : Date.now;
    const cryptoImpl = settings.crypto || global.crypto;

    let socket = null;
    let state = "closed";
    let ready = false;
    let manualClose = false;
    let delay = reconnectDelay;
    let reconnectTimer = null;
    let requestCounter = 0;

    /** Сообщить странице новое состояние связи. */
    function setState(next) {
      if (state === next) return;
      state = next;
      if (typeof settings.onState === "function") settings.onState(state);
    }

    /** Сообщить странице об ошибке (текст по-русски). */
    function reportError(message) {
      if (typeof settings.onError === "function") settings.onError(message);
    }

    /** Запланировать переподключение с растущей паузой. */
    function scheduleReconnect() {
      if (manualClose || reconnectTimer !== null) return;
      reconnectTimer = setTimer(function () {
        reconnectTimer = null;
        openSocket();
      }, delay);
      // Пауза растёт вдвое: 1, 2, 4, 8… но не больше maxReconnectDelay.
      delay = Math.min(maxReconnectDelay, Math.max(reconnectDelay, delay * 2));
    }

    /** Закрыть текущий сокет, не запуская переподключение. */
    function forgetSocket() {
      ready = false;
      if (!socket) return;
      const closed = socket;
      socket = null;
      closed.onopen = null;
      closed.onmessage = null;
      closed.onerror = null;
      closed.onclose = null;
      try {
        closed.close();
      } catch (error) {
        // Сокет уже закрыт — это не ошибка.
      }
    }

    /** Обработать Hello: посчитать пароль и отправить Identify. */
    function handleHello(message) {
      const hello = parseHello(message);
      if (!hello) return;
      setState("identifying");
      identifyMessage(password, hello, cryptoImpl)
        .then(function (identify) {
          // Пока считали пароль, сокет мог закрыться: тогда молчим.
          if (!socket) return;
          try {
            socket.send(JSON.stringify(identify));
          } catch (error) {
            reportError("не удалось войти в OBS: " + (error && error.message ? error.message : error));
          }
        })
        .catch(function (error) {
          reportError("не удалось войти в OBS: " + (error && error.message ? error.message : error));
        });
    }

    /** Разобрать входящее сообщение протокола. */
    function handleMessage(raw) {
      const message = parseMessage(raw);
      if (!message) return;
      if (message.op === OP.HELLO) {
        handleHello(message);
        return;
      }
      if (message.op === OP.IDENTIFIED) {
        ready = true;
        delay = reconnectDelay;
        setState("ready");
        if (typeof settings.onReady === "function") settings.onReady();
        return;
      }
      if (message.op === OP.EVENT) {
        const payload = parseCustomEvent(message);
        if (payload && typeof settings.onCustomEvent === "function") {
          settings.onCustomEvent(payload);
        }
        return;
      }
      if (message.op === OP.REQUEST_RESPONSE && message.d) {
        const status = message.d.requestStatus;
        if (status && status.result === false) {
          reportError("OBS отклонил запрос: " + (status.comment || "без пояснения"));
        }
      }
    }

    /** Обработать закрытие сокета: переподключиться, если не закрыли вручную. */
    function handleClose() {
      socket = null;
      ready = false;
      if (manualClose) {
        setState("closed");
        return;
      }
      setState("closed");
      scheduleReconnect();
    }

    /** Открыть новый сокет и ждать Hello. */
    function openSocket() {
      if (manualClose) return;
      forgetSocket();
      setState("connecting");
      let created;
      try {
        created = createSocket(url);
      } catch (error) {
        reportError("не удалось открыть WebSocket: " + (error && error.message ? error.message : error));
        scheduleReconnect();
        return;
      }
      socket = created;
      created.onopen = function () {
        // Сервер сам пришлёт Hello; до него ничего не отправляем.
        setState("connecting");
      };
      created.onmessage = function (event) {
        const data = event && typeof event === "object" && "data" in event
          ? event.data
          : event;
        handleMessage(data);
      };
      created.onerror = function () {
        // Ошибка обычно сопровождается onclose; переподключение сделает он.
      };
      created.onclose = function () {
        handleClose();
      };
    }

    /** Подключиться (или переподключиться после close()). */
    function connect() {
      manualClose = false;
      delay = reconnectDelay;
      if (state === "ready" || state === "connecting") return;
      openSocket();
    }

    /** Закрыть насовсем: переподключений больше не будет. */
    function close() {
      manualClose = true;
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      forgetSocket();
      setState("closed");
    }

    /** Отправить готовую реплику в OBS. Возвращает false, если связи нет. */
    function sendPayload(data) {
      if (!socket || !ready) return false;
      const requestId = "sasha-" + (++requestCounter) + "-" + now();
      try {
        socket.send(JSON.stringify(broadcastRequest(data, requestId)));
      } catch (error) {
        reportError("не удалось отправить реплику в OBS: " + (error && error.message ? error.message : error));
        return false;
      }
      return true;
    }

    return {
      connect: connect,
      close: close,
      sendPayload: sendPayload,
      isReady: function () {
        return ready;
      },
      getState: function () {
        return state;
      },
      getUrl: function () {
        return url;
      },
    };
  }

  SS.Obs = {
    APP: APP,
    EVENT_TYPE: EVENT_TYPE,
    CUSTOM_EVENT: CUSTOM_EVENT,
    DEFAULT_URL: DEFAULT_URL,
    RPC_VERSION: RPC_VERSION,
    BROADCAST_REQUEST: BROADCAST_REQUEST,
    HINT_WS_OFF: HINT_WS_OFF,
    OP: OP,
    bytesToBase64: bytesToBase64,
    sha256Base64: sha256Base64,
    authString: authString,
    parseMessage: parseMessage,
    parseHello: parseHello,
    identifyMessage: identifyMessage,
    buildBroadcastPayload: buildBroadcastPayload,
    broadcastRequest: broadcastRequest,
    parseCustomEvent: parseCustomEvent,
    isLocalHost: isLocalHost,
    normalizeUrl: normalizeUrl,
    parseWebSocketHash: parseWebSocketHash,
    buildWebSocketHash: buildWebSocketHash,
    createClient: createClient,
  };
})(typeof window !== "undefined" ? window : globalThis);
