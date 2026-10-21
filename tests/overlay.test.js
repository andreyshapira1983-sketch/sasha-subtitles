"use strict";
// Тесты оверлея субтитров: js/overlay.js и страница overlay.html.
//
// Обычный Node без пакетов: node:test + node:assert/strict. Поддельные DOM,
// часы и fetch берём из tests/helpers.js. Настоящие OBS, WebSocket и сеть не
// нужны: клиент OBS подменяется, опрос сервера — поддельным fetch.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  readProject,
  loadScripts,
  createClock,
  createDocument,
  createWindow,
  findUrls,
  scriptSources,
  flushAsync,
  plain,
} = require("./helpers");

// Скрипты страницы подключаются в том же порядке, что и в overlay.html.
const SS = loadScripts(["js/text.js", "js/obs.js", "js/overlay.js"]);

const FADE = SS.Overlay.TIMING.fadeMs;
const GAP = SS.Overlay.TIMING.gapMs;
const POLL = SS.Overlay.TIMING.pollMs;

/** Оверлей на поддельных DOM и часах: всё, что нужно тесту, в одном месте. */
function makeOverlay(options) {
  const created = createWindow();
  const doc = createDocument({
    hint: { tag: "div" },
    stage: { tag: "div" },
    speaker: { tag: "div" },
    line: { tag: "div" },
  });
  const hint = doc.getElementById("hint");
  hint.hidden = true;
  const overlay = SS.Overlay.createOverlay(doc, created.window, options || {});
  return {
    overlay: overlay,
    doc: doc,
    win: created.window,
    clock: created.clock,
    hint: hint,
    stage: doc.getElementById("stage"),
    speaker: doc.getElementById("speaker"),
    line: doc.getElementById("line"),
  };
}

/** Досмотреть один экран: истечь по времени, переждать затухание и паузу. */
function finishPage(clock, overlay) {
  const page = overlay.current();
  assert.ok(page, "на экране должен быть текст");
  clock.advance(Math.round(page.seconds * 1000) + FADE + GAP);
}

test("parseLocation: режим OBS WebSocket, пароль только после «#»", () => {
  const config = { columns: 34 };
  const parsed = SS.Overlay.parseLocation(
    {
      href: "http://127.0.0.1:8765/overlay.html?password=лишний",
      search: "?password=лишний",
      hash: "#ws://127.0.0.1:4455|секрет",
    },
    config
  );
  assert.equal(parsed.mode, "ws");
  assert.equal(parsed.wsUrl, "ws://127.0.0.1:4455");
  assert.equal(parsed.password, "секрет");
  assert.deepEqual(plain(parsed.config), config);
  // Пароль не попал ни в адрес, ни в запрос.
  assert.ok(!parsed.wsUrl.includes("секрет"));
  assert.ok(!parsed.wsUrl.includes("password"));
  assert.ok(!parsed.wsUrl.includes("лишний"));
});

test("parseLocation: настройки Python-сервера дают режим опроса", () => {
  const config = { port: 8765, columns: 34, banned_words: ["хуй"] };
  const parsed = SS.Overlay.parseLocation({ hash: "", search: "" }, config);
  assert.equal(parsed.mode, "poll");
  assert.equal(parsed.wsUrl, null);
  assert.equal(parsed.password, "");
  assert.deepEqual(plain(parsed.config), plain(config));
});

test("parseLocation: без настроек — подсказка, чужой адрес не принимается", () => {
  const hint = SS.Overlay.parseLocation({ hash: "", search: "" });
  assert.equal(hint.mode, "hint");
  assert.equal(hint.wsUrl, null);
  assert.equal(hint.config, null);

  const evil = SS.Overlay.parseLocation({ hash: "#ws://evil.example:4455|пароль" });
  assert.equal(evil.mode, "hint");
  assert.equal(evil.wsUrl, null);
});

test("показ: имя и цвет говорящего из настроек", () => {
  const created = makeOverlay({
    config: {
      columns: 34,
      max_lines: 2,
      speakers: { sasha: { name: "Зритель", color: "#ff9ee6" } },
    },
  });
  created.overlay.push({ speaker: "sasha", text: "Привет, это субтитры." });
  const page = created.overlay.current();
  assert.ok(page);
  assert.equal(created.speaker.textContent, "Зритель");
  assert.equal(created.speaker.style.color, "#ff9ee6");
  assert.equal(created.line.textContent, "Привет, это субтитры.");
  assert.ok(created.stage.classList.contains("show"));
});

test("показ: имя и цвет из самой реплики важнее настроек", () => {
  const created = makeOverlay({
    config: { speakers: { host: { name: "Ведущий", color: "#8fd8ff" } } },
  });
  created.overlay.push({
    speaker: "host",
    name: "Зритель",
    color: "#ffcc00",
    text: "Проверка цвета.",
  });
  assert.equal(created.speaker.textContent, "Зритель");
  assert.equal(created.speaker.style.color, "#ffcc00");
});

test("показ: не больше 2 строк по 34 знака", () => {
  const created = makeOverlay();
  // 40 знаков без пробелов: перенос режет слово на 34 + 6.
  created.overlay.push({ text: "а".repeat(40) });
  let page = created.overlay.current();
  assert.equal(page.lines.length, 2);
  assert.deepEqual(page.lines, ["а".repeat(34), "а".repeat(6)]);
  assert.equal(page.text, page.lines.join("\n"));
  assert.ok(SS.Text.codePoints(page.lines[0]).length <= 34);

  // 70 знаков — три строки, значит два экрана; ни на одном больше 2 строк.
  created.overlay.reset();
  created.overlay.push({ text: "а".repeat(70) });
  page = created.overlay.current();
  assert.equal(page.lines.length, 2);
  assert.ok(page.lines[0].length <= 34);
  assert.equal(created.overlay.queueLength(), 1);
  finishPage(created.clock, created.overlay);
  page = created.overlay.current();
  assert.ok(page);
  assert.equal(page.lines.length, 1);
});

test("показ: длинная фраза идёт частями последовательно", () => {
  const created = makeOverlay();
  const words = [];
  for (let index = 0; index < 30; index += 1) words.push("слово" + index);
  created.overlay.push({ text: words.join(" ") });
  assert.ok(created.overlay.queueLength() >= 2);

  const pages = [];
  for (let step = 0; step < 10 && created.overlay.current(); step += 1) {
    const page = created.overlay.current();
    pages.push(page.text);
    // Экран не больше 2 строк по 34 знака.
    assert.ok(page.lines.length <= 2);
    for (const line of page.lines) assert.ok(SS.Text.codePoints(line).length <= 34);
    finishPage(created.clock, created.overlay);
  }
  const expected = SS.Text.pagesFor(words.join(" "), SS.Overlay.DEFAULT_ROOTS, {
    columns: 34,
    maxLines: 2,
  });
  assert.ok(pages.length >= 3, "длинная фраза должна идти частями");
  assert.deepEqual(pages, expected.map(function (page) {
    return page.text;
  }));
  assert.equal(new Set(pages).size, pages.length, "экраны не должны повторяться");
  assert.equal(created.overlay.queueLength(), 0);
  assert.equal(created.overlay.current(), null);
});

test("показ: время по длине — 0,06 с/знак, но не меньше 2 с", () => {
  const created = makeOverlay();
  created.overlay.push({ text: "привет" });
  assert.equal(created.overlay.current().seconds, 2);

  created.overlay.reset();
  // 34 знака: 34 * 0,06 = 2,04 с.
  created.overlay.push({ text: "а".repeat(34) });
  const page = created.overlay.current();
  assert.equal(page.text.length, 34);
  assert.ok(Math.abs(page.seconds - 2.04) < 1e-9);

  // Чуть раньше срока текст ещё на экране.
  created.clock.advance(2039);
  assert.ok(created.stage.classList.contains("show"));
  assert.ok(created.overlay.current());
  // Ровно в срок начинается затухание: класс show снят, но текст ещё виден.
  created.clock.advance(1);
  assert.ok(!created.stage.classList.contains("show"));
  assert.ok(created.overlay.current());
  // После перехода экран пуст.
  created.clock.advance(FADE);
  assert.equal(created.overlay.current(), null);
});

test("показ: плавное исчезновение, затем следующая реплика", () => {
  const created = makeOverlay();
  created.overlay.push({ text: "первая" });
  created.overlay.push({ text: "вторая" });
  assert.equal(created.overlay.current().text, "первая");
  assert.equal(created.overlay.queueLength(), 1);

  // Время показа первой реплики (7 знаков — минимум 2 с).
  created.clock.advance(2000);
  assert.ok(!created.stage.classList.contains("show"), "должно начаться затухание");
  assert.equal(created.overlay.current().text, "первая");

  created.clock.advance(FADE);
  assert.equal(created.overlay.current(), null);

  created.clock.advance(GAP);
  assert.equal(created.overlay.current().text, "вторая");
  assert.ok(created.stage.classList.contains("show"));
});

test("промежуточный текст: бледнее, перебивает и не копится в очереди", () => {
  const created = makeOverlay();
  // Готовая фраза из двух экранов — в очереди один ждёт.
  created.overlay.push({ text: "слово ".repeat(30), final: true });
  assert.ok(created.overlay.queueLength() >= 1);

  created.overlay.push({ text: "живой текст", final: false });
  const page = created.overlay.current();
  assert.equal(page.text, "живой текст");
  assert.equal(page.final, false);
  assert.ok(created.stage.classList.contains("interim"));
  assert.equal(created.overlay.queueLength(), 0);

  // Каждый следующий промежуточный кусок заменяет предыдущий, а не копится.
  created.overlay.push({ text: "живой текст два", final: false });
  created.overlay.push({ text: "живой текст три", final: false });
  assert.equal(created.overlay.current().text, "живой текст три");
  assert.equal(created.overlay.queueLength(), 0);

  // Готовая фраза вытесняет бледный текст и снова яркая.
  created.overlay.push({ text: "готовая фраза", final: true });
  assert.equal(created.overlay.current().text, "готовая фраза");
  assert.equal(created.overlay.current().final, true);
  assert.ok(!created.stage.classList.contains("interim"));
});

test("чужое событие, пустой текст и «э:» игнорируются", () => {
  const created = makeOverlay();
  created.overlay.push({ app: "чужая-программа", text: "не наше" });
  assert.equal(created.overlay.current(), null);

  created.overlay.push({ app: SS.Obs.APP, text: "   " });
  assert.equal(created.overlay.current(), null);

  created.overlay.push({ app: SS.Obs.APP, text: "э: удивление" });
  assert.equal(created.overlay.current(), null);

  created.overlay.push(null);
  created.overlay.push("просто строка");
  assert.equal(created.overlay.current(), null);

  // Чужой app отсекает и SS.Obs.parseCustomEvent — до оверлея не доходит.
  const foreign = SS.Obs.parseCustomEvent({
    op: 5,
    d: {
      eventType: "CustomEvent",
      eventData: {
        eventType: "sasha-subtitles",
        eventData: { app: "чужая-программа", text: "не наше" },
      },
    },
  });
  assert.equal(foreign, null);
});

test("мат закрывается звёздочками", () => {
  const created = makeOverlay({ config: { banned_words: ["блять", "хуй"] } });
  created.overlay.push({ text: "ну блять и хуйня" });
  const text = created.overlay.current().text;
  assert.ok(text.includes("б****"), "ожидались звёздочки: " + text);
  assert.ok(text.includes("х****"), "ожидались звёздочки: " + text);
  assert.ok(!text.includes("блять"));
  assert.ok(!text.includes("хуй"));

  // В режиме OBS настройки не приходят — работает запасной список корней.
  const plainOverlay = makeOverlay();
  plainOverlay.overlay.push({ text: "блять" });
  assert.equal(plainOverlay.overlay.current().text, "б****");
});

test("режим опроса: /lines, затем /lines?after=N, переживает перезапуск", async () => {
  const calls = [];
  const responses = [
    { paused: false, last: 0, lines: [] },
    {
      paused: false,
      last: 2,
      lines: [
        { speaker: "host", name: "Ведущий", color: "#8fd8ff", text: "первая реплика", seconds: 2, n: 1 },
        { speaker: "host", name: "Ведущий", color: "#8fd8ff", text: "вторая реплика", seconds: 2, n: 2 },
      ],
    },
    { paused: false, last: 1, lines: [] },
  ];
  const created = makeOverlay({
    mode: "poll",
    config: {},
    fetch: function (url) {
      calls.push(url);
      const data = responses.shift() || { paused: false, last: 1, lines: [] };
      return Promise.resolve({
        ok: true,
        json: function () {
          return Promise.resolve(data);
        },
      });
    },
  });
  const overlay = created.overlay;

  overlay.start();
  await flushAsync();
  assert.equal(calls[0], "/lines");
  assert.equal(overlay.current(), null);

  created.clock.advance(POLL);
  await flushAsync();
  assert.equal(calls[1], "/lines?after=0");
  assert.equal(overlay.current().text, "первая реплика");
  assert.equal(overlay.queueLength(), 1);

  created.clock.advance(POLL);
  await flushAsync();
  assert.equal(calls[2], "/lines?after=2");
  // Сервер перезапустился: last меньше after — экран очищен.
  assert.equal(overlay.current(), null);
  assert.equal(overlay.queueLength(), 0);

  created.clock.advance(POLL);
  await flushAsync();
  assert.equal(calls[3], "/lines?after=0");
  overlay.stop();
});

test("режим опроса: fetch можно подставить через win", async () => {
  const created = makeOverlay({ mode: "poll", config: {} });
  const calls = [];
  created.win.fetch = function (url) {
    calls.push(url);
    return Promise.resolve({
      json: function () {
        return Promise.resolve({ paused: false, last: 0, lines: [] });
      },
    });
  };
  created.overlay.start();
  await flushAsync();
  assert.equal(calls[0], "/lines");
  created.overlay.stop();
});

test("режим подсказки: понятный русский текст с примером адреса", () => {
  const created = makeOverlay({ mode: "hint" });
  assert.equal(created.hint.hidden, true);

  created.overlay.start();
  assert.equal(created.hint.hidden, false);
  assert.ok(created.hint.textContent.includes("overlay.html#ws://127.0.0.1:4455|пароль"));
  assert.ok(created.hint.textContent.includes("Браузер"));
  assert.equal(created.overlay.current(), null);
  assert.ok(!created.stage.classList.contains("show"));
});

test("режим OBS WebSocket: подключается с паролем и показывает событие", () => {
  let captured = null;
  let connected = false;
  let closed = false;
  const created = makeOverlay({
    mode: "ws",
    wsUrl: "ws://127.0.0.1:4455",
    password: "секрет",
    config: {},
    createClient: function (options) {
      captured = options;
      return {
        connect: function () {
          connected = true;
        },
        close: function () {
          closed = true;
        },
      };
    },
  });
  const overlay = created.overlay;

  overlay.start();
  assert.equal(connected, true);
  assert.ok(captured, "клиент OBS должен быть создан");
  assert.equal(captured.url, "ws://127.0.0.1:4455");
  assert.equal(captured.password, "секрет");
  assert.ok(!String(captured.url).includes("секрет"));
  assert.equal(typeof captured.onCustomEvent, "function");
  assert.equal(typeof captured.setTimeout, "function");
  assert.equal(typeof captured.clearTimeout, "function");

  captured.onCustomEvent({
    app: SS.Obs.APP,
    speaker: "sasha",
    name: "Зритель",
    color: "#ff9ee6",
    text: "привет из OBS",
    final: true,
  });
  assert.equal(overlay.current().text, "привет из OBS");
  assert.equal(created.speaker.textContent, "Зритель");
  assert.equal(created.speaker.style.color, "#ff9ee6");
  assert.ok(created.stage.classList.contains("show"));

  overlay.stop();
  assert.equal(closed, true);
});

test("overlay.html: порядок скриптов, try/catch и никаких внешних адресов", () => {
  const html = readProject("overlay.html");
  assert.deepEqual(scriptSources(html), ["js/text.js", "js/obs.js", "js/overlay.js"]);
  assert.ok(!/type\s*=\s*["']module["']/.test(html), "модули не нужны");
  assert.ok(!/\bimport\s+/.test(html), "импортов быть не должно");

  // __CONFIG_JSON__ встречается один раз: server.py заменяет его целиком.
  assert.equal((html.match(/__CONFIG_JSON__/g) || []).length, 1);
  assert.ok(/try\s*{[\s\S]*?__CONFIG_JSON__[\s\S]*?}\s*catch/.test(html));
  assert.ok(html.includes("window.__SASHA_CONFIG__"));

  // Никаких адресов, кроме localhost WebSocket OBS.
  const urls = findUrls(html).concat(findUrls(readProject("js/overlay.js")));
  for (const url of urls) {
    assert.ok(
      /^ws:\/\/127\.0\.0\.1:4455(?:\||$)/.test(url),
      "внешний адрес: " + url
    );
  }
});

test("js/overlay.js: IIFE, SS.Overlay, без прямых document/window", () => {
  const source = readProject("js/overlay.js");
  assert.ok(source.trimStart().startsWith('"use strict";'));
  assert.ok(source.includes("SS.Overlay"));
  assert.ok(!/\bdocument\./.test(source), "нужно всё через doc");
  assert.ok(!/\bwindow\./.test(source), "нужно всё через win");

  assert.equal(typeof SS.Overlay.parseLocation, "function");
  assert.equal(typeof SS.Overlay.createOverlay, "function");

  const created = makeOverlay();
  for (const name of ["push", "start", "stop", "reset", "current", "queueLength"]) {
    assert.equal(typeof created.overlay[name], "function", "нет метода " + name);
  }
  assert.ok(["ws", "poll", "hint"].includes(created.overlay.mode));
});

test("reset() очищает экран и очередь, stop() снимает таймеры", () => {
  const created = makeOverlay();
  created.overlay.push({ text: "первая" });
  created.overlay.push({ text: "вторая" });
  assert.ok(created.overlay.current());
  assert.equal(created.overlay.queueLength(), 1);

  created.overlay.reset();
  assert.equal(created.overlay.current(), null);
  assert.equal(created.overlay.queueLength(), 0);
  assert.ok(!created.stage.classList.contains("show"));

  created.overlay.push({ text: "третья" });
  assert.ok(created.clock.pending() > 0);
  created.overlay.stop();
  assert.equal(created.clock.pending(), 0);
});

test("таймеры берутся из options.setTimeout, а не из win", () => {
  const clock = createClock();
  const doc = createDocument({
    hint: { tag: "div" },
    stage: { tag: "div" },
    speaker: { tag: "div" },
    line: { tag: "div" },
  });
  const overlay = SS.Overlay.createOverlay(
    doc,
    {
      setTimeout: function () {
        throw new Error("win.setTimeout не должен вызываться");
      },
    },
    { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }
  );

  overlay.push({ text: "привет" });
  assert.equal(clock.pending(), 1);
  clock.advance(2000);
  assert.ok(!doc.getElementById("stage").classList.contains("show"));
});

test("server.py: подстановка __CONFIG_JSON__ даёт рабочий inline-скрипт", () => {
  // Ровно то, что делает render_overlay: json.dumps(config) вместо заглушки.
  const html = readProject("overlay.html");
  const config = {
    columns: 34,
    max_lines: 2,
    font_size: 44,
    speakers: { host: { name: "Ведущий", color: "#8fd8ff" } },
  };
  const rendered = html.replace("__CONFIG_JSON__", JSON.stringify(config));
  assert.ok(!rendered.includes("__CONFIG_JSON__"));

  // Вставленный JSON — действительно объект настроек, а не мусор.
  const substituted = rendered.match(/config = (\{[\s\S]*?\});/);
  assert.ok(substituted, "в скрипте должна быть подстановка config");
  assert.deepEqual(plain(JSON.parse(substituted[1])), config);

  // Inline-скрипт после подстановки синтаксически цел.
  const inline = rendered.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(inline, "на странице должен быть inline-скрипт");
  assert.doesNotThrow(function () {
    // Только компиляция: выполнять скрипт здесь незачем.
    new Function("window", "document", "SS", inline[1]);
  });
});

test("overlay.html: без сервера страница не падает, а показывает подсказку", () => {
  const html = readProject("overlay.html");
  const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(inline, "на странице должен быть inline-скрипт");

  const doc = createDocument({
    hint: { tag: "div" },
    stage: { tag: "div" },
    speaker: { tag: "div" },
    line: { tag: "div" },
  });
  doc.getElementById("hint").hidden = true;
  const win = {
    location: { hash: "", search: "", href: "file:///overlay.html" },
  };

  // __CONFIG_JSON__ не определён — ровно как при открытии файла без server.py.
  const run = new Function("window", "document", "SS", inline[1]);
  assert.doesNotThrow(function () {
    run(win, doc, SS);
  });
  assert.equal(win.__SASHA_CONFIG__, null);
  const overlay = win.__SASHA_OVERLAY__;
  assert.ok(overlay, "страница должна создать оверлей");
  assert.equal(overlay.mode, "hint");
  assert.equal(doc.getElementById("hint").hidden, false);
  assert.ok(doc.getElementById("hint").textContent.includes("overlay.html#ws://127.0.0.1:4455|пароль"));
});
