"use strict";
// Тесты моста к OBS: пароль obs-websocket v5, Hello/Identify,
// BroadcastCustomEvent, разбор CustomEvent и переподключение.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadScripts,
  waitFor,
  createClock,
  createWebSocketFactory,
} = require("./helpers");

const SS = loadScripts(["js/obs.js"]);
const Obs = SS.Obs;

// Контрольные строки авторизации: входные данные взяты из примера
// документации протокола obs-websocket v5 (password + salt + challenge),
// ожидаемая строка посчитана независимо на Python (hashlib) — тот же
// расчёт проверяется в test_obs_ws.py. Если формула изменится, тест упадёт.
const AUTH_VECTORS = [
  {
    password: "supersecretpassword",
    salt: "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1GAdBTXndyBHgTfSoWTY9yO1VJzSDG1jE",
    challenge: "5WZ6oNZ9PTx2H+PPRgzcLXxYKGtN1tsPdpEzQ7fk0gY=",
    expected: "bwBhQ1JP1gV4hVV+2zhe3mh7l7C4nXw3Q1pgQP68+nc=",
  },
  {
    password: "sasha",
    salt: "test-salt",
    challenge: "test-challenge",
    expected: "MY8+gsELNhtz8+uSIeySp61LAiYksO/5+bE9TUeDsbg=",
  },
  {
    password: "",
    salt: "salt",
    challenge: "challenge",
    expected: "5fmcrqR0I7snYOpUX/Ac22UdSA81TwCyHqCr6eFQyyI=",
  },
];

test("obs.js: строка авторизации совпадает с примером протокола v5", async () => {
  for (const vector of AUTH_VECTORS) {
    const actual = await Obs.authString(
      vector.password,
      vector.salt,
      vector.challenge
    );
    assert.equal(actual, vector.expected, "вектор " + vector.password);
  }
});

test("obs.js: sha256 в base64 считается верно", async () => {
  assert.equal(
    await Obs.sha256Base64("abc"),
    "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
  );
});

test("obs.js: bytesToBase64 кодирует с «=» и без лишних знаков", () => {
  assert.equal(Obs.bytesToBase64(new Uint8Array([])), "");
  assert.equal(Obs.bytesToBase64(new Uint8Array([72])), "SA==");
  assert.equal(Obs.bytesToBase64(new Uint8Array([72, 105])), "SGk=");
  assert.equal(Obs.bytesToBase64(new Uint8Array([72, 105, 33])), "SGkh");
});

test("obs.js: parseMessage понимает JSON и не падает на мусоре", () => {
  assert.deepEqual(Obs.parseMessage('{"op":0}'), { op: 0 });
  assert.equal(Obs.parseMessage("не json"), null);
  assert.equal(Obs.parseMessage("42"), null);
  assert.equal(Obs.parseMessage(42), null);
  assert.deepEqual(Obs.parseMessage({ op: 0 }), { op: 0 });
});

test("obs.js: parseHello достаёт версию и данные входа", () => {
  const hello = Obs.parseHello({
    op: 0,
    d: {
      obsWebSocketVersion: "5.5.2",
      rpcVersion: 1,
      authentication: { challenge: "ch", salt: "sa" },
    },
  });
  assert.deepEqual(hello, {
    rpcVersion: 1,
    authentication: { challenge: "ch", salt: "sa" },
  });
});

test("obs.js: Hello без пароля даёт authentication = null", () => {
  const hello = Obs.parseHello({ op: 0, d: { rpcVersion: 1 } });
  assert.deepEqual(hello, { rpcVersion: 1, authentication: null });
  assert.equal(Obs.parseHello({ op: 2, d: {} }), null);
  assert.equal(Obs.parseHello(null), null);
});

test("obs.js: Identify содержит пароль, только если OBS его требует", async () => {
  const withAuth = await Obs.identifyMessage("secret", {
    rpcVersion: 1,
    authentication: { salt: "salt", challenge: "challenge" },
  });
  assert.equal(withAuth.op, 1);
  assert.equal(withAuth.d.rpcVersion, 1);
  assert.equal(
    withAuth.d.authentication,
    await Obs.authString("secret", "salt", "challenge")
  );

  const withoutAuth = await Obs.identifyMessage("secret", {
    rpcVersion: 1,
    authentication: null,
  });
  assert.deepEqual(withoutAuth, { op: 1, d: { rpcVersion: 1 } });
});

test("obs.js: payload по умолчанию — «Ведущий» и голубой цвет", () => {
  assert.deepEqual(Obs.buildBroadcastPayload({}), {
    app: "sasha-subtitles",
    speaker: "host",
    name: "Ведущий",
    color: "#8fd8ff",
    text: "",
    final: true,
  });
});

test("obs.js: final:false сохраняется, текст приводится к строке", () => {
  const payload = Obs.buildBroadcastPayload({
    speaker: "sasha",
    name: "Зритель",
    color: "#ff9ee6",
    text: 42,
    final: false,
    лишнее: "отбросить",
  });
  assert.deepEqual(payload, {
    app: "sasha-subtitles",
    speaker: "sasha",
    name: "Зритель",
    color: "#ff9ee6",
    text: "42",
    final: false,
  });
});

test("obs.js: BroadcastCustomEvent собирается по протоколу v5", () => {
  const request = Obs.broadcastRequest(
    {
      speaker: "host",
      name: "Ведущий",
      color: "#8fd8ff",
      text: "привет",
      final: true,
    },
    "req-1"
  );
  assert.deepEqual(request, {
    op: 5,
    d: {
      requestType: "BroadcastCustomEvent",
      requestId: "req-1",
      requestData: {
        eventType: "sasha-subtitles",
        eventData: {
          app: "sasha-subtitles",
          speaker: "host",
          name: "Ведущий",
          color: "#8fd8ff",
          text: "привет",
          final: true,
        },
      },
    },
  });
});

test("obs.js: CustomEvent разбирается обратно в реплику", () => {
  const payload = Obs.buildBroadcastPayload({
    speaker: "host",
    name: "Ведущий",
    color: "#8fd8ff",
    text: "тест",
    final: true,
  });
  const message = {
    op: 4,
    d: {
      eventType: "CustomEvent",
      eventData: { eventType: "sasha-subtitles", eventData: payload },
    },
  };
  assert.deepEqual(Obs.parseCustomEvent(message), payload);
});

test("obs.js: чужие события и мусор не считаются нашими", () => {
  const base = {
    op: 4,
    d: {
      eventType: "CustomEvent",
      eventData: { eventType: "sasha-subtitles", eventData: { app: "sasha-subtitles", text: "x" } },
    },
  };
  assert.equal(Obs.parseCustomEvent({ op: 5, d: base.d }), null);
  assert.equal(Obs.parseCustomEvent({ op: 4, d: { eventType: "Other" } }), null);
  assert.equal(
    Obs.parseCustomEvent({
      op: 4,
      d: {
        eventType: "CustomEvent",
        eventData: { eventType: "sasha-subtitles", eventData: { app: "другая" } },
      },
    }),
    null
  );
  assert.equal(Obs.parseCustomEvent(null), null);
});

test("obs.js: адрес OBS приводится к ws://127.0.0.1:4455", () => {
  assert.equal(Obs.normalizeUrl(""), "ws://127.0.0.1:4455");
  assert.equal(Obs.normalizeUrl("127.0.0.1:4455"), "ws://127.0.0.1:4455");
  assert.equal(Obs.normalizeUrl("ws://127.0.0.1:4456"), "ws://127.0.0.1:4456");
  assert.equal(Obs.normalizeUrl("ws://localhost:4455/"), "ws://localhost:4455");
  assert.equal(Obs.normalizeUrl("ws://127.0.0.1"), "ws://127.0.0.1:4455");
});

test("obs.js: чужие и опасные адреса не принимаются", () => {
  assert.equal(Obs.normalizeUrl("ws://example.com:4455"), null);
  assert.equal(Obs.normalizeUrl("https://127.0.0.1:4455"), null);
  assert.equal(Obs.normalizeUrl("wss://127.0.0.1:4455"), null);
  assert.equal(Obs.normalizeUrl("не адрес"), null);
});

test("obs.js: пароль overlay берётся после «#» и не попадает в адрес", () => {
  assert.deepEqual(Obs.parseWebSocketHash("#ws://127.0.0.1:4455|секрет"), {
    url: "ws://127.0.0.1:4455",
    password: "секрет",
  });
  assert.deepEqual(Obs.parseWebSocketHash("ws://127.0.0.1:4456"), {
    url: "ws://127.0.0.1:4456",
    password: "",
  });
  // Вертикальная черта в самом пароле не теряется.
  assert.equal(
    Obs.parseWebSocketHash("#ws://127.0.0.1:4455|a|b").password,
    "a|b"
  );
  assert.equal(Obs.parseWebSocketHash(""), null);
  assert.equal(Obs.parseWebSocketHash("#ws://example.com:4455|x"), null);
});

test("obs.js: хвост адреса собирается из адреса и пароля", () => {
  assert.equal(
    Obs.buildWebSocketHash("127.0.0.1:4455", "секрет"),
    "#ws://127.0.0.1:4455|секрет"
  );
  assert.equal(
    Obs.buildWebSocketHash("ws://127.0.0.1:4455", ""),
    "#ws://127.0.0.1:4455"
  );
});

test("obs.js: подсказка про WebSocket называет путь в меню OBS", () => {
  assert.match(Obs.HINT_WS_OFF, /Настройки WebSocket-сервера/);
  assert.match(Obs.HINT_WS_OFF, /Включить/);
});

function setupClient(extra) {
  const clock = createClock();
  const sockets = createWebSocketFactory();
  const states = [];
  const events = [];
  const errors = [];
  const client = Obs.createClient(
    Object.assign(
      {
        url: "ws://127.0.0.1:4455",
        password: "secret",
        createSocket: sockets.create,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        now: function () {
          return 1000;
        },
        onState: function (state) {
          states.push(state);
        },
        onCustomEvent: function (payload) {
          events.push(payload);
        },
        onError: function (message) {
          errors.push(message);
        },
      },
      extra || {}
    )
  );
  return { client, clock, sockets, states, events, errors };
}

test("obs.js: клиент входит в OBS по паролю (Hello → Identify → Identified)", async () => {
  const setup = setupClient();
  setup.client.connect();
  assert.equal(setup.sockets.count(), 1);
  const ws = setup.sockets.last();
  assert.equal(ws.url, "ws://127.0.0.1:4455");
  assert.equal(setup.client.getState(), "connecting");

  ws.open();
  ws.hello({ authentication: { salt: "salt", challenge: "challenge" } });
  // Пароль считается через crypto.subtle (пул потоков Node), поэтому ждём
  // именно появления Identify в сокете, а не фиксированное число тиков.
  await waitFor(function () {
    return ws.lastSent();
  });

  const identify = ws.lastSent();
  assert.equal(identify.op, 1);
  assert.equal(identify.d.rpcVersion, 1);
  assert.equal(
    identify.d.authentication,
    await Obs.authString("secret", "salt", "challenge")
  );
  assert.equal(setup.client.getState(), "identifying");

  ws.identified();
  assert.equal(setup.client.isReady(), true);
  assert.equal(setup.client.getState(), "ready");
  assert.ok(setup.states.includes("ready"));
});

test("obs.js: без пароля клиент входит без authentication", async () => {
  const setup = setupClient({ password: "" });
  setup.client.connect();
  const ws = setup.sockets.last();
  ws.open();
  ws.hello();
  await waitFor(function () {
    return ws.lastSent();
  });
  const identify = ws.lastSent();
  assert.equal(identify.op, 1);
  assert.equal("authentication" in identify.d, false);
});

test("obs.js: клиент отправляет реплику запросом BroadcastCustomEvent", async () => {
  const setup = setupClient();
  setup.client.connect();
  const ws = setup.sockets.last();
  ws.open();
  ws.hello();
  await waitFor(function () {
    return ws.lastSent();
  });
  ws.identified();

  assert.equal(setup.client.sendPayload({ text: "привет", final: true }), true);
  const request = ws.lastSent();
  assert.equal(request.op, 5);
  assert.equal(request.d.requestType, "BroadcastCustomEvent");
  assert.match(request.d.requestId, /^sasha-1-/);
  assert.equal(request.d.requestData.eventType, "sasha-subtitles");
  assert.equal(request.d.requestData.eventData.app, "sasha-subtitles");
  assert.equal(request.d.requestData.eventData.text, "привет");
  assert.equal(request.d.requestData.eventData.final, true);

  setup.client.sendPayload({ text: "второй" });
  assert.match(ws.lastSent().d.requestId, /^sasha-2-/);
});

test("obs.js: до входа реплики не отправляются", () => {
  const setup = setupClient();
  assert.equal(setup.client.sendPayload({ text: "рано" }), false);
  setup.client.connect();
  assert.equal(setup.client.sendPayload({ text: "рано" }), false);
  assert.equal(setup.sockets.last().sent.length, 0);
});

test("obs.js: наши CustomEvent доходят до страницы, чужие — нет", async () => {
  const setup = setupClient();
  setup.client.connect();
  const ws = setup.sockets.last();
  ws.open();
  ws.hello();
  await waitFor(function () {
    return ws.lastSent();
  });
  ws.identified();

  const payload = Obs.buildBroadcastPayload({ text: "привет", final: true });
  ws.receive({
    op: 4,
    d: {
      eventType: "CustomEvent",
      eventData: { eventType: "sasha-subtitles", eventData: payload },
    },
  });
  ws.receive({
    op: 4,
    d: {
      eventType: "CustomEvent",
      eventData: { eventType: "sasha-subtitles", eventData: { app: "чужая" } },
    },
  });
  assert.deepEqual(setup.events, [payload]);
});

test("obs.js: мусор вместо сообщения не ломает клиент", async () => {
  const setup = setupClient();
  setup.client.connect();
  const ws = setup.sockets.last();
  ws.open();
  ws.receive("{это не json");
  ws.hello();
  await waitFor(function () {
    return ws.lastSent();
  });
  ws.identified();
  assert.equal(setup.client.isReady(), true);
});

test("obs.js: после обрыва клиент переподключается с растущей паузой", async () => {
  const setup = setupClient();
  setup.client.connect();
  setup.sockets.last().open();
  setup.sockets.last().hello();
  await waitFor(function () {
    return setup.sockets.last().lastSent();
  });
  setup.sockets.last().identified();

  setup.sockets.last().fail(1006);
  assert.equal(setup.client.isReady(), false);
  assert.equal(setup.clock.pending(), 1);

  setup.clock.advance(999);
  assert.equal(setup.sockets.count(), 1);
  setup.clock.advance(1);
  assert.equal(setup.sockets.count(), 2);
  assert.equal(setup.client.getState(), "connecting");

  // Вторая пауза вдвое длиннее: 1000 мс не хватает.
  setup.sockets.last().fail(1006);
  setup.clock.advance(1000);
  assert.equal(setup.sockets.count(), 2);
  setup.clock.advance(1000);
  assert.equal(setup.sockets.count(), 3);
});

test("obs.js: close() закрывает клиент и не переподключается", () => {
  const setup = setupClient();
  setup.client.connect();
  const ws = setup.sockets.last();
  ws.open();
  setup.client.close();
  assert.equal(setup.clock.pending(), 0);
  setup.clock.advance(60000);
  assert.equal(setup.sockets.count(), 1);
  assert.equal(setup.client.isReady(), false);
  assert.equal(setup.client.getState(), "closed");
});

test("obs.js: ошибка запроса от OBS попадает в onError", async () => {
  const setup = setupClient();
  setup.client.connect();
  const ws = setup.sockets.last();
  ws.open();
  ws.hello();
  await waitFor(function () {
    return ws.lastSent();
  });
  ws.receive({
    op: 6,
    d: {
      requestType: "BroadcastCustomEvent",
      requestId: "sasha-1-1000",
      requestStatus: { result: false, code: 500, comment: "нет прав" },
    },
  });
  assert.equal(setup.errors.length, 1);
  assert.match(setup.errors[0], /нет прав/);
});
