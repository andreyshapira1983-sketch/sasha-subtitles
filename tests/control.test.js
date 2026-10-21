"use strict";
// Тесты страницы управления «Субтитры Саши» версии 4.1 (control.html + js/control.js).
//
// Страница состоит из обычных скриптов, поэтому здесь нет ни браузера, ни
// сети: поддельные document, window, распознавание речи и WebSocket лежат в
// tests/helpers.js. Проверяем ровно то, что человек увидит и получит в OBS:
// явный старт микрофона, автоправку только готовых фраз, словарь и историю.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readProject,
  loadScripts,
  flushAsync,
  createDocument,
  createWindow,
  createSpeechFactory,
  createWebSocketFactory,
  scriptSources,
  findUrls,
} = require("./helpers");

// Скрипты страницы — в том же порядке, что в control.html.
const SS = loadScripts([
  "js/text.js",
  "js/autofix.js",
  "js/obs.js",
  "js/control.js",
]);
const Control = SS.Control;
const Autofix = SS.Autofix;
const OBS_HINT = SS.Obs.HINT_WS_OFF;
const AUTOFIX_KEY = "sasha-subtitles.autofix";

/** Собрать поддельный document из id, которые есть в control.html. */
function documentFromPage() {
  const html = readProject("control.html");
  const ids = [];
  const pattern = /id="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(html)) !== null) ids.push(match[1]);
  const elements = {};
  for (const id of ids) elements[id] = { tag: "div" };
  return createDocument(elements);
}

/**
 * Собрать всё для одного теста: документ, окно с часами, распознавание,
 * поддельный WebSocket и контроллер.
 */
function setup(options) {
  const opts = options || {};
  const doc = documentFromPage();
  const winInfo = createWindow();
  const win = winInfo.window;
  const clock = winInfo.clock;
  const speech = createSpeechFactory();
  const sockets = createWebSocketFactory();

  if (opts.speech !== false) {
    if (opts.speechProperty === "SpeechRecognition") {
      win.SpeechRecognition = speech.Recognition;
    } else {
      // Chrome и Edge дают webkitSpeechRecognition, его и проверяем по умолчанию.
      win.webkitSpeechRecognition = speech.Recognition;
    }
  }
  if (opts.stored) {
    win.localStorage.setItem(Control.STORAGE_KEY, JSON.stringify(opts.stored));
  }
  if (opts.autofixStored !== undefined) {
    win.localStorage.setItem(
      AUTOFIX_KEY,
      typeof opts.autofixStored === "string"
        ? opts.autofixStored
        : JSON.stringify(opts.autofixStored)
    );
  }

  const controlOptions = Object.assign(
    { createSocket: sockets.create, restartDelay: 20 },
    opts.control || {}
  );
  const control = Control.createControl(doc, win, controlOptions);
  return { doc, win, clock, speech, sockets, control };
}

/**
 * Поддельное распознавание без автоматического onstart: браузер в жизни
 * подтверждает старт не сразу, а тест решает, когда это произойдёт.
 */
function createManualSpeechFactory() {
  const instances = [];

  class ManualRecognition {
    constructor() {
      this.lang = "";
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
      this.started = false;
      this.startCount = 0;
      this.onstart = null;
      this.onaudiostart = null;
      this.onend = null;
      this.onerror = null;
      this.onresult = null;
      instances.push(this);
    }

    start() {
      this.started = true;
      this.startCount += 1;
    }

    stop() {
      this.started = false;
      if (this.onend) this.onend({});
    }

    abort() {
      this.started = false;
      if (this.onend) this.onend({});
    }

    emitStart() {
      if (this.onstart) this.onstart({});
    }

    emitAudioStart() {
      if (this.onaudiostart) this.onaudiostart({});
    }

    emitEnd() {
      this.started = false;
      if (this.onend) this.onend({});
    }

    emitError(code) {
      if (this.onerror) this.onerror({ error: code, message: code });
    }

    emitResult(alternatives, isFinal) {
      const list = (alternatives || []).map(function (text) {
        const alternative = [{ transcript: String(text), confidence: 0.9 }];
        alternative.isFinal = Boolean(isFinal);
        return alternative;
      });
      if (this.onresult) {
        this.onresult({ resultIndex: 0, results: list });
      }
    }
  }

  return {
    Recognition: ManualRecognition,
    instances: instances,
    last: function () {
      return instances[instances.length - 1] || null;
    },
    count: function () {
      return instances.length;
    },
  };
}

/** Контроллер, у которого распознавание стартует только по команде теста. */
function setupManual(options) {
  const opts = options || {};
  const manual = createManualSpeechFactory();
  const controlOptions = Object.assign(
    { createRecognition: manual.Recognition },
    opts.control || {}
  );
  const ctx = setup(Object.assign({}, opts, { speech: false, control: controlOptions }));
  ctx.manual = manual;
  return ctx;
}

/** Сыграть за OBS: открыть сокет, поздороваться, подтвердить вход. */
async function connectObs(ctx) {
  const socket = ctx.sockets.last();
  assert.ok(socket, "клиент OBS должен создать WebSocket");
  socket.open();
  socket.hello();
  await flushAsync();
  socket.identified();
  await flushAsync();
  assert.equal(ctx.control.client && ctx.control.client.isReady(), true);
  return socket;
}

/**
 * Дождаться ответа клиента в сокете. Пароль OBS считается через
 * crypto.subtle, а это работа вне очереди микро/макро-задач Node,
 * поэтому небольшая пауза реального времени надёжнее flushAsync.
 */
async function waitForSent(socket, attempts) {
  const limit = attempts || 500;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (socket.lastSent()) return socket.lastSent();
    await new Promise(function (resolve) {
      setTimeout(resolve, 1);
    });
  }
  return socket.lastSent();
}

/** Все запросы BroadcastCustomEvent, ушедшие в сокет. */
function broadcasts(socket) {
  return socket.sentParsed.filter(function (message) {
    return (
      message &&
      message.op === 5 &&
      message.d &&
      message.d.requestType === "BroadcastCustomEvent"
    );
  });
}

/** Данные последней реплики, которую получил OBS. */
function lastPayload(socket) {
  const list = broadcasts(socket);
  if (list.length === 0) return null;
  return list[list.length - 1].d.requestData.eventData;
}

/** Включить контроллер и дождаться связи с поддельным OBS. */
async function startedWithObs(options) {
  const ctx = setup(options);
  ctx.control.start();
  const socket = await connectObs(ctx);
  return Object.assign(ctx, { socket });
}

/** Текст двух строк истории у первого <li> (как распознано / как исправлено). */
function historyLines(doc) {
  const list = doc.getElementById("history");
  return list.children.map(function (item) {
    return item.children.map(function (child) {
      return child.textContent;
    });
  });
}

// ---------------------------------------------------------------------------
// Страница: разметка, скрипты, адреса
// ---------------------------------------------------------------------------

test("control.html: скрипты подключены по порядку и без внешних адресов", () => {
  const html = readProject("control.html");

  // text.js, autofix.js, obs.js, control.js — именно в таком порядке.
  assert.deepEqual(scriptSources(html), [
    "js/text.js",
    "js/autofix.js",
    "js/obs.js",
    "js/control.js",
  ]);
  assert.match(html, /SS\.Control\.start\(document,\s*window\)/);

  // Модулей нет: страница работает и из файла, и с GitHub Pages.
  assert.doesNotMatch(html, /type="module"/);
  assert.doesNotMatch(html, /\bimport\s+[\w{*]/);

  // Единственный допустимый адрес — ws://127.0.0.1 (страница OBS не нужна).
  const urls = findUrls(html);
  assert.ok(urls.length > 0, "на странице должен быть адрес OBS по умолчанию");
  for (const url of urls) {
    assert.match(url, /^ws:\/\/127\.0\.0\.1(:\d+)?$/, "лишний адрес: " + url);
  }
  assert.doesNotMatch(html, /https?:\/\//i);

  // В самих скриптах страницы тоже нет посторонних адресов.
  for (const file of ["js/control.js", "js/autofix.js"]) {
    const source = readProject(file);
    assert.doesNotMatch(source, /https?:\/\//i, "внешний адрес в " + file);
    for (const url of findUrls(source)) {
      // «ws://» без хоста — это склейка адреса из частей, а не готовый адрес.
      if (url === "ws://") continue;
      assert.match(
        url,
        /^ws:\/\/127\.0\.0\.1(?:[:/]|$)/,
        "лишний адрес в " + file + ": " + url
      );
    }
  }

  // Шесть языков перечислены и в самой разметке: страница понятна сразу.
  for (const code of ["ru-RU", "en-US", "uk-UA", "he-IL", "de-DE", "es-ES"]) {
    assert.ok(html.includes('value="' + code + '"'), "в разметке нет языка " + code);
  }
});

test("control.html: на странице есть все поля, которые нужны человеку", () => {
  const doc = documentFromPage();
  const ids = [
    "start",
    "pause",
    "status",
    "live",
    "history",
    "notice",
    "language",
    "speaker-name",
    "speaker-color",
    "mask-roots",
    "obs-url",
    "obs-port",
    "obs-password",
    "obs-status",
    "obs-hint",
    "fix-dictionary",
    "fix-capitalize",
    "fix-punctuation",
    "fix-commas",
    "fix-cleanup",
    "dict-list",
    "dict-add",
    "dict-export",
    "dict-import",
    "dict-import-file",
    "dict-message",
  ];
  for (const id of ids) {
    assert.ok(doc.getElementById(id), "нет элемента #" + id);
  }
});

test("control.html: блок «Автоправка» с галочками, словарём и импортом", () => {
  const html = readProject("control.html");
  assert.match(html, /Автоправка/);
  assert.equal((html.match(/type="checkbox" checked/g) || []).length, 5);
  assert.match(
    html,
    /id="dict-import-file"[^>]*accept="\.json,application\/json"/
  );
  assert.match(html, /<script src="js\/autofix\.js"><\/script>/);
});

// ---------------------------------------------------------------------------
// Языки и поддержка распознавания
// ---------------------------------------------------------------------------

test("control.js: ровно шесть языков из задания", () => {
  assert.deepEqual(
    Control.LANGUAGES.map(function (item) {
      return item.code;
    }),
    ["ru-RU", "en-US", "uk-UA", "he-IL", "de-DE", "es-ES"]
  );
  assert.deepEqual(
    Control.LANGUAGES.map(function (item) {
      return item.label;
    }),
    ["Русский", "Английский", "Украинский", "Иврит", "Немецкий", "Испанский"]
  );

  // В списке на странице те же шесть вариантов, по умолчанию — русский.
  const doc = documentFromPage();
  const { window: win } = createWindow();
  const control = Control.createControl(doc, win);
  const select = doc.getElementById("language");
  assert.equal(select.children.length, 6);
  assert.deepEqual(
    select.children.map(function (option) {
      return option.textContent;
    }),
    ["Русский", "Английский", "Украинский", "Иврит", "Немецкий", "Испанский"]
  );
  assert.equal(select.children[0].value, "ru-RU");
  assert.equal(select.value, "ru-RU");
  assert.equal(control.settings().language, "ru-RU");
});

test("control.js: recognitionSupported видит оба имени распознавания", () => {
  assert.equal(Control.recognitionSupported(null), false);
  assert.equal(Control.recognitionSupported({}), false);
  assert.equal(
    Control.recognitionSupported({ webkitSpeechRecognition: function () {} }),
    true
  );
  assert.equal(
    Control.recognitionSupported({ SpeechRecognition: function () {} }),
    true
  );
});

test("control.js: без распознавания — понятная надпись и недоступная кнопка", () => {
  const ctx = setup({ speech: false });
  const notice = ctx.doc.getElementById("notice");
  const startButton = ctx.doc.getElementById("start");

  assert.equal(notice.textContent, "Откройте эту страницу в Chrome или Edge");
  assert.equal(notice.textContent, Control.NOTICE_BROWSER);
  assert.equal(notice.hidden, false);
  assert.equal(startButton.disabled, true);
  assert.equal(startButton.textContent, "Начать");

  // Ничего не падает: start() просто отказывается включаться.
  assert.doesNotThrow(function () {
    assert.equal(ctx.control.start(), false);
  });
  assert.equal(ctx.control.state(), "unsupported");
  assert.equal(ctx.speech.count(), 0);
});

// ---------------------------------------------------------------------------
// Раздел 0.1: явный старт микрофона (без автозапуска)
// ---------------------------------------------------------------------------

test("SS.Control.start: только создаёт контроллер, микрофон не включает", () => {
  const doc = documentFromPage();
  const { window: win } = createWindow();
  const speech = createSpeechFactory();
  win.webkitSpeechRecognition = speech.Recognition;
  const sockets = createWebSocketFactory();
  const options = { createSocket: sockets.create, restartDelay: 20 };

  const control = Control.start(doc, win, options);
  assert.equal(control.state(), "stopped");
  assert.equal(control.status(), "остановлено");
  assert.equal(doc.getElementById("status").textContent, "остановлено");
  assert.equal(doc.getElementById("start").textContent, "Начать");
  assert.equal(speech.count(), 0, "при открытии страницы распознавание не создаётся");
  assert.equal(sockets.count(), 0, "при открытии страницы OBS не подключается");

  // Повторный вызов — тот же контроллер, распознавание так и не появилось.
  const again = Control.start(doc, win, options);
  assert.equal(again, control);
  assert.equal(speech.count(), 0);
  assert.equal(sockets.count(), 0);
});

test("control.js: «Начать» — ждём разрешения микрофона, «слушаю» только после onstart", () => {
  const ctx = setupManual();
  assert.equal(ctx.control.start(), true);
  const recognition = ctx.manual.last();
  assert.ok(recognition, "распознавание должно создаться по кнопке");
  assert.equal(recognition.started, true);

  // Пока браузер не подтвердил старт — честное ожидание.
  assert.equal(ctx.control.state(), "waiting");
  assert.equal(ctx.control.status(), "ждём разрешения микрофона");
  assert.equal(ctx.doc.getElementById("status").textContent, "ждём разрешения микрофона");
  assert.equal(ctx.doc.getElementById("start").textContent, "Остановить");
  assert.equal(ctx.doc.getElementById("pause").disabled, true);
  assert.equal(ctx.control.togglePause(), false, "в ожидании пауза недоступна");
  assert.equal(ctx.control.state(), "waiting");

  // Браузер прислал настоящий onstart — только теперь «слушаю».
  recognition.emitStart();
  assert.equal(ctx.control.state(), "listening");
  assert.equal(ctx.control.status(), "слушаю");
  assert.equal(ctx.doc.getElementById("status").textContent, "слушаю");
  assert.equal(ctx.doc.getElementById("start").textContent, "Остановить");
  assert.equal(ctx.doc.getElementById("pause").disabled, false);
});

test("control.js: onaudiostart тоже переводит в «слушаю»", () => {
  const ctx = setupManual();
  ctx.control.start();
  assert.equal(ctx.control.status(), "ждём разрешения микрофона");
  ctx.manual.last().emitAudioStart();
  assert.equal(ctx.control.state(), "listening");
  assert.equal(ctx.control.status(), "слушаю");
});

test("control.js: из ожидания микрофона «Остановить» работает", () => {
  const ctx = setupManual();
  ctx.control.start();
  const recognition = ctx.manual.last();

  assert.equal(ctx.control.stop(), true);
  assert.equal(ctx.control.state(), "stopped");
  assert.equal(ctx.control.status(), "остановлено");
  assert.equal(recognition.started, false);
  assert.equal(ctx.doc.getElementById("start").textContent, "Начать");

  const instances = ctx.manual.count();
  ctx.clock.advance(60000);
  assert.equal(ctx.manual.count(), instances, "после остановки не перезапускаем");
});

test("control.js: автоперезапуск снова ждёт onstart", () => {
  const ctx = setupManual();
  ctx.control.start();
  ctx.manual.last().emitStart();
  assert.equal(ctx.control.status(), "слушаю");

  // Браузер сам прекратил распознавание: до нового onstart — ожидание.
  ctx.manual.last().emitEnd();
  assert.equal(ctx.control.state(), "waiting");
  assert.equal(ctx.control.status(), "ждём разрешения микрофона");

  ctx.clock.advance(1000);
  assert.equal(ctx.manual.count(), 2);
  assert.equal(ctx.manual.last().started, true);
  assert.equal(ctx.control.state(), "waiting");
  ctx.manual.last().emitStart();
  assert.equal(ctx.control.state(), "listening");
});

test("control.js: отказ в микрофоне при ожидании — сообщение и «остановлено»", () => {
  const ctx = setupManual();
  ctx.control.start();
  ctx.manual.last().emitError("not-allowed");

  assert.equal(ctx.control.state(), "stopped");
  assert.equal(ctx.control.status(), "остановлено");
  assert.equal(ctx.doc.getElementById("notice").textContent, Control.NOTICE_NO_MIC);
  assert.match(ctx.doc.getElementById("notice").textContent, /микрофон/i);
  assert.equal(ctx.doc.getElementById("notice").hidden, false);
  assert.equal(ctx.doc.getElementById("start").textContent, "Начать");

  const instances = ctx.manual.count();
  ctx.clock.advance(60000);
  assert.equal(ctx.manual.count(), instances, "после запрета микрофона не перезапускаем");
});

test("control.js: service-not-allowed тоже понятно останавливает", () => {
  const ctx = setupManual();
  ctx.control.start();
  ctx.manual.last().emitError("service-not-allowed");
  assert.equal(ctx.control.state(), "stopped");
  assert.equal(ctx.doc.getElementById("notice").textContent, Control.NOTICE_NO_MIC);
});

// ---------------------------------------------------------------------------
// Распознавание речи (поведение v4 сохранено)
// ---------------------------------------------------------------------------

test("control.js: настройки по умолчанию — «Ведущий», голубой цвет, ws://127.0.0.1:4455", () => {
  const ctx = setup();
  const settings = ctx.control.settings();
  assert.equal(settings.name, "Ведущий");
  assert.equal(settings.color, "#8fd8ff");
  assert.equal(settings.url, "ws://127.0.0.1:4455");
  assert.equal(settings.port, "4455");
  assert.equal(settings.password, "");
  assert.equal(settings.language, "ru-RU");
  assert.equal(ctx.doc.getElementById("speaker-name").value, "Ведущий");
  assert.equal(ctx.doc.getElementById("speaker-color").value, "#8fd8ff");
  assert.equal(ctx.doc.getElementById("obs-url").value, "ws://127.0.0.1:4455");
  assert.equal(ctx.control.state(), "stopped");
  assert.equal(ctx.control.status(), "остановлено");
});

test("control.js: непрерывное распознавание с промежуточными результатами", () => {
  const ctx = setup();
  assert.equal(ctx.control.start(), true);
  const recognition = ctx.speech.last();
  assert.ok(recognition, "распознавание должно создаться");
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.lang, "ru-RU");
  assert.equal(recognition.started, true);
  // Поддельное распознавание само эмитирует onstart, как настоящий браузер.
  assert.equal(ctx.control.state(), "listening");
  assert.equal(ctx.control.status(), "слушаю");
  assert.equal(ctx.doc.getElementById("status").textContent, "слушаю");
  assert.equal(ctx.doc.getElementById("start").textContent, "Остановить");

  // Смена языка перезапускает распознавание уже с новым языком.
  const select = ctx.doc.getElementById("language");
  select.value = "en-US";
  select.dispatch("change");
  assert.equal(ctx.control.settings().language, "en-US");
  assert.equal(ctx.speech.count(), 2);
  assert.equal(ctx.speech.last().lang, "en-US");
  assert.equal(ctx.speech.last().started, true);
});

test("control.js: промежуточный результат — final:false и живой текст", async () => {
  const ctx = await startedWithObs();
  ctx.speech.last().emitResult(["привет"], false);

  assert.deepEqual(lastPayload(ctx.socket), {
    app: "sasha-subtitles",
    speaker: "host",
    name: "Ведущий",
    color: "#8fd8ff",
    text: "привет",
    final: false,
  });
  assert.equal(ctx.control.liveText(), "привет");
  assert.equal(ctx.doc.getElementById("live").textContent, "привет");
  assert.equal(broadcasts(ctx.socket).length, 1);
  assert.equal(ctx.control.history().length, 0);
});

test("control.js: готовая фраза — final:true, payload и история", async () => {
  const ctx = await startedWithObs();
  ctx.speech.last().emitResult(["привет"], false);
  ctx.speech.last().emitResult(["Привет,  мир!"], true);

  assert.deepEqual(lastPayload(ctx.socket), {
    app: "sasha-subtitles",
    speaker: "host",
    name: "Ведущий",
    color: "#8fd8ff",
    text: "Привет, мир!",
    final: true,
  });
  assert.equal(ctx.control.liveText(), "");
  assert.equal(ctx.doc.getElementById("live").textContent, "");
  assert.deepEqual(ctx.control.history(), ["Привет, мир!"]);
});

test("control.js: готовую фразу можно отправить и вручную через sendText", async () => {
  const ctx = await startedWithObs();
  assert.equal(ctx.control.sendText("  проверка   связи ", true), true);
  // Автоправка добавляет заглавную букву и точку — это осознанное изменение.
  assert.equal(lastPayload(ctx.socket).text, "Проверка связи.");
  assert.deepEqual(ctx.control.history(), ["Проверка связи."]);
});

test("control.js: мат закрывается звёздочками через SS.Text.maskRoots", async () => {
  const ctx = await startedWithObs({ control: { settings: { roots: "хуй" } } });
  ctx.speech.last().emitResult(["Нахуй это"], true);

  assert.equal(lastPayload(ctx.socket).text, "Н**** это.");
  assert.deepEqual(ctx.control.history(), ["Н**** это."]);
});

test("control.js: корень с «^» ищется только в начале слова", async () => {
  const ctx = await startedWithObs({ control: { settings: { roots: "^бля" } } });
  // «Рубля» не трогаем, «бляха» закрываем: звёздочки с первого знака, он остаётся.
  ctx.speech.last().emitResult(["Рубля и бляха"], true);
  assert.equal(lastPayload(ctx.socket).text, "Рубля и б****.");
  assert.deepEqual(ctx.control.history(), ["Рубля и б****."]);
});

test("control.js: пустое и команды «э:» не отправляются", async () => {
  const ctx = await startedWithObs();
  const recognition = ctx.speech.last();

  recognition.emitResult(["э: улыбка"], true);
  recognition.emitResult(["Э: смех"], true);
  recognition.emitResult(["   "], true);
  recognition.emitResult([""], false);

  assert.equal(broadcasts(ctx.socket).length, 0);
  assert.equal(ctx.control.history().length, 0);
  assert.equal(ctx.control.liveText(), "");
});

test("control.js: история хранит не больше 20 последних фраз", async () => {
  const ctx = await startedWithObs();
  for (let number = 1; number <= 25; number += 1) {
    ctx.speech.last().emitResult(["фраза " + number], true);
  }
  const history = ctx.control.history();
  assert.equal(history.length, Control.MAX_HISTORY);
  assert.equal(history.length, 20);
  assert.equal(history[0], "Фраза 25.");
  assert.equal(history[19], "Фраза 6.");
  // На странице тоже 20 строк, старые вытеснены.
  const list = ctx.doc.getElementById("history");
  assert.equal(list.children.length, 20);
  assert.equal(list.children[0].children[0].textContent, "как распознано: фраза 25");
  assert.equal(list.children[0].children[1].textContent, "как исправлено: Фраза 25.");
});

// ---------------------------------------------------------------------------
// Пауза и ручная остановка
// ---------------------------------------------------------------------------

test("control.js: на паузе ничего не отправляется, живой текст очищается", async () => {
  const ctx = await startedWithObs();
  const recognition = ctx.speech.last();

  recognition.emitResult(["живой"], false);
  assert.equal(ctx.control.liveText(), "живой");
  recognition.emitResult(["до паузы"], true);
  assert.equal(ctx.control.history().length, 1);
  const sentBeforePause = broadcasts(ctx.socket).length;

  assert.equal(ctx.control.togglePause(), true);
  assert.equal(ctx.control.status(), "пауза");
  assert.equal(ctx.control.state(), "paused");
  assert.equal(ctx.doc.getElementById("status").textContent, "пауза");
  assert.equal(ctx.doc.getElementById("live").textContent, "");
  assert.equal(ctx.doc.getElementById("pause").textContent, "Продолжить");
  assert.equal(ctx.speech.last(), recognition, "на паузе распознавание не перезапускают");

  // Пока пауза — ни живой текст, ни готовые фразы в OBS не уходят.
  recognition.emitResult(["во время паузы"], false);
  recognition.emitResult(["тоже во время паузы"], true);
  assert.equal(broadcasts(ctx.socket).length, sentBeforePause);
  assert.equal(ctx.control.history().length, 1);

  // Сняли паузу — всё снова работает.
  assert.equal(ctx.control.togglePause(), false);
  assert.equal(ctx.control.status(), "слушаю");
  recognition.emitResult(["после паузы"], true);
  assert.equal(lastPayload(ctx.socket).text, "После паузы.");
  assert.equal(ctx.control.history().length, 2);
});

test("control.js: «Остановить» выключает распознавание и не перезапускает", async () => {
  const ctx = await startedWithObs();
  const recognition = ctx.speech.last();
  assert.equal(ctx.control.stop(), true);
  assert.equal(ctx.control.state(), "stopped");
  assert.equal(ctx.control.status(), "остановлено");
  assert.equal(ctx.control.client, null);
  assert.equal(recognition.started, false);
  assert.equal(ctx.doc.getElementById("start").textContent, "Начать");
  assert.equal(ctx.doc.getElementById("pause").disabled, true);

  const instances = ctx.speech.count();
  ctx.clock.advance(60000);
  assert.equal(ctx.speech.count(), instances);
});

test("control.js: после остановки «Начать» снова включает распознавание", async () => {
  const ctx = await startedWithObs();
  ctx.control.stop();
  assert.equal(ctx.control.start(), true);
  assert.equal(ctx.control.state(), "listening");
  assert.equal(ctx.speech.count(), 2, "создано новое распознавание");
  assert.equal(ctx.sockets.count(), 2, "создан новый клиент OBS");
  assert.equal(ctx.sockets.last().url, "ws://127.0.0.1:4455");

  // Заново здороваемся с OBS — и фразы снова доходят.
  const socket = await connectObs(ctx);
  ctx.speech.last().emitResult(["снова в эфире"], true);
  assert.equal(lastPayload(socket).text, "Снова в эфире.");
});

// ---------------------------------------------------------------------------
// Автоправка: только готовые фразы
// ---------------------------------------------------------------------------

test("control.js: автоправка применяется к готовой фразе, история хранит пару", async () => {
  const ctx = await startedWithObs();
  ctx.speech.last().emitResult(["сегодня твич и обс"], true);

  assert.equal(lastPayload(ctx.socket).text, "Сегодня Twitch и OBS.");
  assert.deepEqual(ctx.control.history(), ["Сегодня Twitch и OBS."]);
  assert.deepEqual(ctx.control.historyDetails(), [
    { raw: "сегодня твич и обс", fixed: "Сегодня Twitch и OBS." },
  ]);
});

test("control.js: промежуточный текст автоправка не трогает", async () => {
  const ctx = await startedWithObs();
  ctx.speech.last().emitResult(["сегодня твич и обс"], false);

  assert.equal(lastPayload(ctx.socket).text, "сегодня твич и обс");
  assert.equal(lastPayload(ctx.socket).final, false);
  assert.equal(ctx.control.liveText(), "сегодня твич и обс");
  assert.equal(ctx.control.history().length, 0);
});

test("control.js: автоправка идёт до маскировки мата", async () => {
  const ctx = await startedWithObs({ control: { settings: { roots: "хуй" } } });
  ctx.speech.last().emitResult(["нахуй твич"], true);

  assert.equal(lastPayload(ctx.socket).text, "Н**** Twitch.");
  assert.deepEqual(ctx.control.historyDetails(), [
    { raw: "нахуй твич", fixed: "Н**** Twitch." },
  ]);
});

test("control.js: fixText — тот же путь, но без записи истории", () => {
  const ctx = setup();
  assert.equal(ctx.control.fixText("твич", true), "Twitch.");
  assert.equal(ctx.control.fixText("твич", false), "твич");
  assert.equal(ctx.control.fixText("", true), "");
  assert.equal(ctx.control.history().length, 0);
});

test("control.js: язык из настроек влияет на автоправку", () => {
  const ctx = setup();
  const select = ctx.doc.getElementById("language");
  select.value = "en-US";
  select.dispatch("change");

  assert.equal(ctx.control.fixText("what are you doing", true), "What are you doing?");
  assert.equal(
    ctx.control.fixText("i like it but not now", true),
    "I like it, but not now."
  );
});

// ---------------------------------------------------------------------------
// Словарь и правила автоправки
// ---------------------------------------------------------------------------

test("control.js: словарь по умолчанию, замена и сохранение", () => {
  const ctx = setup();
  assert.deepEqual(ctx.control.dictionary(), Autofix.DEFAULT_DICTIONARY);
  assert.equal(ctx.control.fixText("твич и обс", true), "Twitch и OBS.");

  // Пустые пары отбрасываются, словарь по умолчанию заменяется целиком.
  ctx.control.setDictionary([
    { from: "обс", to: "OBS" },
    { from: "", to: "пусто" },
  ]);
  assert.deepEqual(ctx.control.dictionary(), [{ from: "обс", to: "OBS" }]);
  assert.equal(ctx.control.fixText("твич", true), "Твич.");

  const stored = JSON.parse(ctx.win.localStorage.getItem(AUTOFIX_KEY));
  assert.deepEqual(stored.dictionary, [{ from: "обс", to: "OBS" }]);
});

test("control.js: правила по умолчанию включены и сохраняются в localStorage", () => {
  const ctx = setup();
  assert.deepEqual(ctx.control.rules(), Autofix.DEFAULT_RULES);
  assert.equal(ctx.control.fixText("привет", true), "Привет.");

  ctx.control.setRules({ capitalize: false });
  assert.deepEqual(ctx.control.rules(), {
    dictionary: true,
    capitalize: false,
    punctuation: true,
    commas: true,
    cleanup: true,
  });
  assert.equal(ctx.control.fixText("привет", true), "привет.");

  const stored = JSON.parse(ctx.win.localStorage.getItem(AUTOFIX_KEY));
  assert.equal(stored.rules.capitalize, false);
  assert.equal(stored.rules.punctuation, true);

  // Новый контроллер читает сохранённые правила и показывает их галочкой.
  const again = setup({ autofixStored: stored });
  assert.equal(again.control.rules().capitalize, false);
  assert.equal(again.doc.getElementById("fix-capitalize").checked, false);
  assert.equal(again.doc.getElementById("fix-punctuation").checked, true);
});

test("control.js: все пять правил включены по умолчанию галочками", () => {
  const ctx = setup();
  for (const name of Object.keys(Control.FIX_RULE_IDS)) {
    const box = ctx.doc.getElementById(Control.FIX_RULE_IDS[name]);
    assert.ok(box, "нет галочки правила " + name);
    assert.equal(box.checked, true, "правило " + name + " должно быть включено");
  }
  assert.deepEqual(ctx.control.rules(), Autofix.DEFAULT_RULES);
});

test("control.js: галочка правила на странице выключает автоправку", () => {
  const ctx = setup();
  const box = ctx.doc.getElementById("fix-punctuation");
  assert.equal(box.checked, true);

  box.checked = false;
  box.dispatch("change");

  assert.equal(ctx.control.rules().punctuation, false);
  assert.equal(ctx.control.fixText("привет", true), "Привет");
  const stored = JSON.parse(ctx.win.localStorage.getItem(AUTOFIX_KEY));
  assert.equal(stored.rules.punctuation, false);
});

test("control.js: выключенный словарь не заменяет слова", () => {
  const ctx = setup();
  ctx.control.setRules({ dictionary: false });
  assert.equal(ctx.control.fixText("твич", true), "Твич.");
});

test("control.js: история показывает «как распознано» и «как исправлено»", async () => {
  const ctx = await startedWithObs();
  ctx.speech.last().emitResult(["сегодня твич"], true);

  assert.deepEqual(historyLines(ctx.doc), [
    ["как распознано: сегодня твич", "как исправлено: Сегодня Twitch."],
  ]);
  // history() по-прежнему отдаёт строки fixed — совместимость со старыми тестами.
  assert.deepEqual(ctx.control.history(), ["Сегодня Twitch."]);
  assert.deepEqual(ctx.control.historyDetails(), [
    { raw: "сегодня твич", fixed: "Сегодня Twitch." },
  ]);
});

test("control.js: строки словаря добавляются, редактируются и удаляются", () => {
  const ctx = setup();
  const list = ctx.doc.getElementById("dict-list");
  const initial = list.children.length;
  assert.equal(initial, Autofix.DEFAULT_DICTIONARY.length);

  // Новая строка: два поля и кнопка удаления.
  ctx.doc.getElementById("dict-add").click();
  assert.equal(list.children.length, initial + 1);
  const row = list.children[list.children.length - 1];
  assert.equal(row.children.length, 3);

  row.children[0].value = "ник";
  row.children[0].dispatch("input");
  row.children[1].value = "Ник";
  row.children[1].dispatch("input");

  assert.ok(
    ctx.control.dictionary().some(function (pair) {
      return pair.from === "ник" && pair.to === "Ник";
    })
  );
  assert.equal(ctx.control.fixText("ник", true), "Ник.");
  const stored = JSON.parse(ctx.win.localStorage.getItem(AUTOFIX_KEY));
  assert.ok(
    stored.dictionary.some(function (pair) {
      return pair.from === "ник" && pair.to === "Ник";
    })
  );

  // Удаляем строку «ник» — она уходит и из словаря.
  list.children[initial].children[2].click();
  assert.equal(list.children.length, initial);
  assert.equal(ctx.control.dictionary().length, initial);
  assert.ok(
    !ctx.control.dictionary().some(function (pair) {
      return pair.from === "ник";
    })
  );

  // Пустая строка тоже удаляется и в сохранённый словарь не попадает.
  ctx.doc.getElementById("dict-add").click();
  assert.equal(list.children.length, initial + 1);
  assert.equal(ctx.control.dictionary().length, initial);
  list.children[list.children.length - 1].children[2].click();
  assert.equal(list.children.length, initial);
});

test("control.js: «Импорт» открывает выбор файла, а файл загружает словарь", async () => {
  const ctx = setup();
  const input = ctx.doc.getElementById("dict-import-file");
  let clicks = 0;
  input.click = function () {
    clicks += 1;
  };
  ctx.doc.getElementById("dict-import").click();
  assert.equal(clicks, 1);

  input.files = [
    {
      text: function () {
        return Promise.resolve(JSON.stringify([{ from: "обс", to: "OBS" }]));
      },
    },
  ];
  input.dispatch("change");
  await flushAsync();

  assert.deepEqual(ctx.control.dictionary(), [{ from: "обс", to: "OBS" }]);
  assert.equal(ctx.doc.getElementById("dict-list").children.length, 1);
});

// ---------------------------------------------------------------------------
// Автоправка: экспорт, импорт и хранение
// ---------------------------------------------------------------------------

test("control.js: словарь экспортируется в JSON и импортируется обратно", () => {
  const ctx = setup();
  const json = ctx.control.exportDictionary();
  assert.equal(typeof json, "string");
  assert.deepEqual(JSON.parse(json), ctx.control.dictionary());

  const parsed = Autofix.dictionaryFromJson(json);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.dictionary, ctx.control.dictionary());

  // Кнопка «Экспорт» не падает и сообщает о результате.
  ctx.doc.getElementById("dict-export").click();
  assert.equal(ctx.doc.getElementById("dict-message").hidden, false);
});

test("control.js: ошибка импорта показывается по-русски", () => {
  const ctx = setup();
  assert.equal(ctx.control.importDictionary("это не json"), false);

  const message = ctx.doc.getElementById("dict-message");
  assert.equal(message.hidden, false);
  assert.match(message.textContent, /JSON/i);
  assert.deepEqual(ctx.control.dictionary(), Autofix.DEFAULT_DICTIONARY);

  // Пустой список замен — тоже ошибка, а не молчаливая очистка словаря.
  assert.equal(ctx.control.importDictionary(JSON.stringify({ dictionary: [] })), false);
  assert.match(ctx.doc.getElementById("dict-message").textContent, /пар/i);
});

test("control.js: успешный импорт заменяет словарь и сохраняет его", () => {
  const ctx = setup();
  const json = JSON.stringify([{ from: "ник", to: "Ник" }]);

  assert.equal(ctx.control.importDictionary(json), true);
  assert.deepEqual(ctx.control.dictionary(), [{ from: "ник", to: "Ник" }]);
  assert.equal(ctx.doc.getElementById("dict-list").children.length, 1);
  assert.equal(ctx.control.fixText("ник", true), "Ник.");

  const message = ctx.doc.getElementById("dict-message");
  assert.equal(message.hidden, false);
  assert.match(message.textContent, /словар/i);

  const stored = JSON.parse(ctx.win.localStorage.getItem(AUTOFIX_KEY));
  assert.deepEqual(stored.dictionary, [{ from: "ник", to: "Ник" }]);
});

test("control.js: правила и словарь читаются из localStorage при запуске", () => {
  const ctx = setup({
    autofixStored: {
      rules: { capitalize: false },
      dictionary: [{ from: "твич", to: "Twitch" }],
    },
  });

  assert.equal(ctx.control.rules().capitalize, false);
  assert.equal(ctx.control.rules().punctuation, true);
  assert.deepEqual(ctx.control.dictionary(), [{ from: "твич", to: "Twitch" }]);
  assert.equal(ctx.doc.getElementById("fix-capitalize").checked, false);
  assert.equal(ctx.doc.getElementById("fix-punctuation").checked, true);
  assert.equal(ctx.doc.getElementById("dict-list").children.length, 1);
  assert.equal(ctx.control.fixText("твич", true), "Twitch.");
});

test("control.js: битые настройки автоправки не ломают страницу", () => {
  const broken = setup({ autofixStored: "{не json" });
  assert.deepEqual(broken.control.rules(), Autofix.DEFAULT_RULES);
  assert.deepEqual(broken.control.dictionary(), Autofix.DEFAULT_DICTIONARY);

  const wrong = setup({
    autofixStored: { rules: null, dictionary: "не список" },
  });
  assert.deepEqual(wrong.control.rules(), Autofix.DEFAULT_RULES);
  assert.deepEqual(wrong.control.dictionary(), Autofix.DEFAULT_DICTIONARY);
  assert.equal(wrong.doc.getElementById("fix-dictionary").checked, true);
});

// ---------------------------------------------------------------------------
// OBS: переподключение, подсказки
// ---------------------------------------------------------------------------

test("control.js: смена адреса OBS на ходу переподключает клиент", async () => {
  const ctx = await startedWithObs();
  const urlInput = ctx.doc.getElementById("obs-url");
  urlInput.value = "ws://127.0.0.1:4460";
  urlInput.dispatch("change");

  assert.equal(ctx.control.settings().url, "ws://127.0.0.1:4460");
  assert.equal(ctx.sockets.count(), 2);
  assert.equal(ctx.sockets.last().url, "ws://127.0.0.1:4460");
});

// ---------------------------------------------------------------------------
// Автоперезапуск и ошибки распознавания
// ---------------------------------------------------------------------------

test("control.js: после onend распознавание перезапускается само", () => {
  const ctx = setup();
  ctx.control.start();
  assert.equal(ctx.speech.count(), 1);

  ctx.speech.last().emitEnd();
  assert.equal(ctx.speech.count(), 1, "перезапуск идёт по таймеру, не мгновенно");
  assert.equal(ctx.control.state(), "waiting");

  ctx.clock.advance(1000);
  assert.equal(ctx.speech.count(), 2);
  assert.equal(ctx.speech.last().started, true);
  assert.equal(ctx.speech.last().lang, "ru-RU");
  // Поддельное распознавание эмитирует onstart при start() — снова «слушаю».
  assert.equal(ctx.control.state(), "listening");
});

test("control.js: после ошибки network распознавание перезапускается", () => {
  const ctx = setup();
  ctx.control.start();
  ctx.speech.last().emitError("network");
  assert.equal(ctx.control.state(), "waiting");
  ctx.clock.advance(1000);
  assert.equal(ctx.speech.count(), 2);
  assert.equal(ctx.speech.last().started, true);
  assert.equal(ctx.control.state(), "listening");
});

test("control.js: not-allowed — русское сообщение и остановка без перезапуска", () => {
  const ctx = setup();
  ctx.control.start();
  ctx.speech.last().emitError("not-allowed");

  assert.equal(ctx.control.state(), "stopped");
  assert.equal(ctx.control.status(), "остановлено");
  assert.match(ctx.doc.getElementById("notice").textContent, /микрофон/i);
  assert.equal(ctx.doc.getElementById("notice").hidden, false);
  assert.equal(ctx.doc.getElementById("start").textContent, "Начать");

  const instances = ctx.speech.count();
  ctx.clock.advance(60000);
  assert.equal(ctx.speech.count(), instances, "после запрета микрофона не перезапускаем");
});

// ---------------------------------------------------------------------------
// localStorage OBS
// ---------------------------------------------------------------------------

test("control.js: настройки OBS читаются из localStorage этого браузера", async () => {
  const ctx = setup({
    stored: {
      url: "ws://127.0.0.1:5000",
      port: "5000",
      password: "секрет",
    },
  });
  const settings = ctx.control.settings();
  assert.equal(settings.url, "ws://127.0.0.1:5000");
  assert.equal(settings.port, "5000");
  assert.equal(settings.password, "секрет");
  assert.equal(ctx.doc.getElementById("obs-url").value, "ws://127.0.0.1:5000");
  assert.equal(ctx.doc.getElementById("obs-port").value, "5000");
  assert.equal(ctx.doc.getElementById("obs-password").value, "секрет");

  ctx.control.start();
  assert.equal(ctx.sockets.last().url, "ws://127.0.0.1:5000");

  // Пароль из localStorage доходит до OBS в строке авторизации.
  const socket = ctx.sockets.last();
  socket.open();
  socket.hello({ authentication: { salt: "salt", challenge: "challenge" } });
  const identify = await waitForSent(socket);
  assert.ok(identify, "Identify должен уйти в OBS");
  assert.equal(identify.op, 1);
  assert.equal(
    identify.d.authentication,
    await SS.Obs.authString("секрет", "salt", "challenge")
  );
});

test("control.js: настройки OBS сохраняются в localStorage при изменении", () => {
  const ctx = setup();
  const urlInput = ctx.doc.getElementById("obs-url");
  const portInput = ctx.doc.getElementById("obs-port");
  const passwordInput = ctx.doc.getElementById("obs-password");

  urlInput.value = "ws://127.0.0.1:4466";
  urlInput.dispatch("change");
  portInput.value = "4466";
  portInput.dispatch("change");
  passwordInput.value = "пароль OBS";
  passwordInput.dispatch("change");

  const stored = JSON.parse(ctx.win.localStorage.getItem(Control.STORAGE_KEY));
  assert.deepEqual(stored, {
    url: "ws://127.0.0.1:4466",
    port: "4466",
    password: "пароль OBS",
  });
  assert.equal(ctx.control.settings().url, "ws://127.0.0.1:4466");
  assert.equal(ctx.control.settings().password, "пароль OBS");

  // Новый клиент начнёт подключаться по новому адресу.
  ctx.control.start();
  assert.equal(ctx.sockets.last().url, "ws://127.0.0.1:4466");
});

test("control.js: приватный режим localStorage не роняет страницу", () => {
  const doc = documentFromPage();
  const { window: win } = createWindow();
  const speech = createSpeechFactory();
  win.webkitSpeechRecognition = speech.Recognition;
  win.localStorage = {
    getItem: function () {
      throw new Error("приватный режим");
    },
    setItem: function () {
      throw new Error("приватный режим");
    },
    removeItem: function () {
      throw new Error("приватный режим");
    },
  };
  const sockets = createWebSocketFactory();
  const control = Control.createControl(doc, win, { createSocket: sockets.create });

  const urlInput = doc.getElementById("obs-url");
  urlInput.value = "ws://127.0.0.1:4477";
  assert.doesNotThrow(function () {
    urlInput.dispatch("change");
  });
  assert.equal(control.settings().url, "ws://127.0.0.1:4477");
  assert.doesNotThrow(function () {
    control.start();
  });
  assert.equal(control.state(), "listening");
  // Автоправка тоже должна работать без localStorage.
  assert.doesNotThrow(function () {
    control.setRules({ capitalize: false });
    control.setDictionary([{ from: "твич", to: "Twitch" }]);
  });
  assert.equal(control.fixText("привет", true), "привет.");
  assert.equal(control.fixText("твич", true), "Twitch.");
});

// ---------------------------------------------------------------------------
// Подсказка про WebSocket и страница без элементов
// ---------------------------------------------------------------------------

test("control.js: если OBS не отвечает — подсказка, как включить WebSocket", async () => {
  const ctx = setup();
  ctx.control.start();
  // Сокет создан, но сервер не ответил: связи нет.
  assert.equal(ctx.sockets.count(), 1);
  ctx.speech.last().emitResult(["без связи"], true);

  const hint = ctx.doc.getElementById("obs-hint");
  assert.equal(hint.textContent, OBS_HINT);
  assert.equal(hint.hidden, false);
  assert.equal(ctx.sockets.last().sent.length, 0);
});

test("control.js: страница без ожидаемых элементов не падает", () => {
  const doc = createDocument({});
  const { window: win } = createWindow();
  let control;
  assert.doesNotThrow(function () {
    control = Control.createControl(doc, win);
  });
  assert.equal(control.state(), "unsupported");
  assert.equal(control.start(), false);
  // API автоправки тоже работает без разметки.
  assert.equal(control.fixText("твич", true), "Twitch.");
  assert.equal(control.setRules({ commas: false }).commas, false);
  assert.equal(control.importDictionary("не json"), false);
});

test("SS.Control.start: повторный вызов возвращает тот же контроллер", () => {
  const doc = documentFromPage();
  const { window: win } = createWindow();
  win.webkitSpeechRecognition = createSpeechFactory().Recognition;
  const sockets = createWebSocketFactory();
  const options = { createSocket: sockets.create };

  const first = Control.start(doc, win, options);
  const second = Control.start(doc, win, options);
  assert.equal(first, second);
  assert.equal(second.state(), "stopped");
});
