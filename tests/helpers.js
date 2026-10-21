"use strict";
// Общие подставные объекты для тестов на Node без пакетов.
//
// Страницы собраны из обычных скриптов (без import/export), поэтому тесты
// выполняют их в общем пространстве Node и берут готовое пространство имён
// window.SS. Здесь же лежат поддельные DOM, WebSocket, распознавание речи,
// localStorage и часы — чтобы проверять страницы без браузера.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

/** Прочитать файл проекта как текст. */
function readProject(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

let lastFiles = [];

/**
 * Загрузить обычные скрипты страницы в это же пространство имён.
 * Возвращает window.SS. Параметр globals подставляет document, window и т. п.
 */
function loadScripts(files, globals) {
  lastFiles = files.slice();
  if (globals) Object.assign(globalThis, globals);
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  delete globalThis.SS;
  for (const file of files) {
    vm.runInThisContext(readProject(file), { filename: file });
  }
  if (!globalThis.SS) throw new Error("скрипты не создали window.SS");
  return globalThis.SS;
}

/** Перечень файлов из последней загрузки (для проверок в тестах). */
function loadedFiles() {
  return lastFiles.slice();
}

/** Только данные, без прототипов: удобно для строгого сравнения. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Дождаться обещаний: несколько кругов микро- и макро-задач.
 *
 * Одних setImmediate мало: криптография (crypto.subtle.digest) считается
 * в пуле потоков Node и может ответить на несколько оборотов позже.
 * Поэтому в каждом круге есть и setImmediate, и настоящий таймер.
 */
async function flushAsync(rounds) {
  const roundsCount = rounds === undefined ? 4 : rounds;
  for (let index = 0; index < roundsCount; index += 1) {
    await new Promise(function (resolve) {
      setImmediate(resolve);
    });
    await new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }
}

/**
 * Дождаться, пока проверка станет истинной (например, пока клиент
 * посчитает пароль и отправит Identify). Опрашивает с паузой 1 мс.
 */
async function waitFor(check, timeoutMs) {
  const limit = timeoutMs === undefined ? 2000 : timeoutMs;
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > limit) {
      throw new Error("не дождались условия за " + limit + " мс");
    }
    await new Promise(function (resolve) {
      setTimeout(resolve, 1);
    });
  }
}

/** Стиль элемента: как у HTMLElement.style, но обычный объект. */
function createStyle() {
  const style = {};
  style.setProperty = function (name, value) {
    style[String(name)] = String(value);
  };
  style.removeProperty = function (name) {
    delete style[name];
  };
  style.getPropertyValue = function (name) {
    return style[name] || "";
  };
  return style;
}

/** Список классов элемента (classList), работающий поверх className. */
function createClassList(element) {
  function tokens() {
    return String(element.className || "")
      .split(/\s+/)
      .filter(Boolean);
  }
  function write(list) {
    element.className = list.join(" ");
  }
  const list = {
    add: function () {
      const current = tokens();
      for (const name of arguments) {
        if (!current.includes(String(name))) current.push(String(name));
      }
      write(current);
    },
    remove: function () {
      const names = Array.from(arguments).map(String);
      write(tokens().filter(function (name) {
        return !names.includes(name);
      }));
    },
    contains: function (name) {
      return tokens().includes(String(name));
    },
    toggle: function (name, force) {
      const has = tokens().includes(String(name));
      const on = force === undefined ? !has : Boolean(force);
      if (on) list.add(name);
      else list.remove(name);
      return on;
    },
    get length() {
      return tokens().length;
    },
    item: function (index) {
      return tokens()[index] || null;
    },
    toString: function () {
      return element.className;
    },
  };
  return list;
}

/** Элемент поддельного DOM: только то, чем реально пользуются страницы. */
class FakeElement {
  constructor(tagName, id) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.id = id ? String(id) : "";
    this.children = [];
    this.parentNode = null;
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.title = "";
    this.draggable = false;
    this.dataset = {};
    this.attributes = Object.create(null);
    this.handlers = Object.create(null);
    this.style = createStyle();
    this.classList = createClassList(this);
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._innerHTML = "";
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    const key = String(name);
    this.attributes[key] = String(value);
    if (key === "id") this.id = String(value);
    if (key === "class") this.className = String(value);
    if (key === "type" || key === "placeholder" || key === "title") {
      this[key] = String(value);
    }
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    const key = String(type);
    if (!this.handlers[key]) this.handlers[key] = [];
    this.handlers[key].push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.handlers[String(type)];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  /** Вызвать обработчики события, как это сделал бы браузер. */
  dispatch(type, event) {
    const key = String(type);
    const payload = event || {};
    payload.type = payload.type || key;
    if (!payload.target) payload.target = this;
    const list = this.handlers[key] ? this.handlers[key].slice() : [];
    for (const handler of list) handler.call(this, payload);
    return payload;
  }

  click() {
    return this.dispatch("click", {});
  }

  focus() {}

  blur() {}

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    this.textContent = "";
  }
}

/**
 * Поддельный document с уже готовыми элементами.
 * elements: {id: FakeElement | {tag, ...}}. Возвращает документ, у которого
 * getElementById находит только переданные элементы (как настоящий).
 */
function createDocument(elements, extra) {
  const map = new Map();
  const doc = {
    elements: map,
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
    head: new FakeElement("head"),
    hidden: false,
    visibilityState: "visible",
    title: "",
    handlers: Object.create(null),
    getElementById: function (id) {
      return map.get(String(id)) || null;
    },
    querySelector: function (selector) {
      const text = String(selector);
      if (text.startsWith("#")) return map.get(text.slice(1)) || null;
      for (const element of map.values()) {
        if (element.tagName === text.toUpperCase()) return element;
      }
      return null;
    },
    createElement: function (tag) {
      return new FakeElement(tag);
    },
    createTextNode: function (text) {
      const node = new FakeElement("#text");
      node.textContent = String(text);
      return node;
    },
    addEventListener: function (type, handler) {
      const key = String(type);
      if (!doc.handlers[key]) doc.handlers[key] = [];
      doc.handlers[key].push(handler);
    },
    removeEventListener: function (type, handler) {
      const list = doc.handlers[String(type)];
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch: function (type, event) {
      const key = String(type);
      const payload = event || {};
      payload.type = payload.type || key;
      for (const handler of (doc.handlers[key] || []).slice()) {
        handler.call(doc, payload);
      }
      return payload;
    },
  };
  doc.documentElement.style = createStyle();
  for (const id of Object.keys(elements || {})) {
    let element = elements[id];
    if (!element) continue;
    if (!(element instanceof FakeElement)) {
      element = new FakeElement(element.tag || "div", id);
    }
    if (!element.id) element.id = id;
    map.set(id, element);
  }
  if (extra) Object.assign(doc, extra);
  return doc;
}

/** Поддельный localStorage: хранит строки, как настоящий. */
function createLocalStorage(initial) {
  const data = new Map();
  for (const key of Object.keys(initial || {})) {
    data.set(key, String(initial[key]));
  }
  return {
    _data: data,
    getItem: function (key) {
      return data.has(String(key)) ? data.get(String(key)) : null;
    },
    setItem: function (key, value) {
      data.set(String(key), String(value));
    },
    removeItem: function (key) {
      data.delete(String(key));
    },
    clear: function () {
      data.clear();
    },
    key: function (index) {
      const keys = Array.from(data.keys());
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
    get length() {
      return data.size;
    },
  };
}

/**
 * Поддельные часы: setTimeout/clearTimeout/now и ручное продвижение времени.
 * Таймеры выполняются в порядке времени, вложенные таймеры тоже.
 */
function createClock() {
  let time = 0;
  let counter = 0;
  const timers = new Map();

  function setTimeoutImpl(callback, ms) {
    counter += 1;
    const id = counter;
    timers.set(id, {
      id: id,
      at: time + Math.max(0, Number(ms) || 0),
      callback: callback,
    });
    return id;
  }

  function clearTimeoutImpl(id) {
    timers.delete(id);
  }

  function nextTimer(limit) {
    let best = null;
    for (const timer of timers.values()) {
      if (timer.at > limit) continue;
      if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) {
        best = timer;
      }
    }
    return best;
  }

  function runDue(limit) {
    let guard = 0;
    for (;;) {
      const timer = nextTimer(limit);
      if (!timer) break;
      timers.delete(timer.id);
      time = timer.at;
      timer.callback();
      guard += 1;
      if (guard > 100000) throw new Error("слишком много таймеров: похоже на вечный цикл");
    }
    time = limit;
  }

  return {
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    now: function () {
      return time;
    },
    /** Продвинуть время и выполнить все таймеры, которые успели наступить. */
    advance: function (ms) {
      runDue(time + Math.max(0, Number(ms) || 0));
    },
    /** Выполнить таймеры, наступившие «сейчас» (например, переподключение). */
    flush: function () {
      runDue(time);
    },
    pending: function () {
      return timers.size;
    },
  };
}

/**
 * Поддельный WebSocket с ручным управлением.
 * createSocket(url) отдаёт новый объект; instances — все созданные.
 * Методы open/hello/identified/receive/fail нужны тесту, чтобы сыграть сервер.
 */
function createWebSocketFactory() {
  const instances = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0; // 0 — соединяется, 1 — открыт, 3 — закрыт
      this.sent = [];
      this.sentParsed = [];
      this.closedByClient = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      instances.push(this);
    }

    send(data) {
      if (this.readyState === 3) throw new Error("WebSocket уже закрыт");
      this.sent.push(data);
      try {
        this.sentParsed.push(JSON.parse(data));
      } catch (error) {
        this.sentParsed.push(data);
      }
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.closedByClient = true;
      if (this.onclose) this.onclose({ code: 1000, reason: "клиент закрыл" });
    }

    /** Сервер принял соединение (TCP открыт). */
    open() {
      if (this.readyState === 3) return;
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }

    /** Сервер прислал сообщение протокола. */
    receive(message) {
      if (this.onmessage) {
        this.onmessage({
          data: typeof message === "string" ? message : JSON.stringify(message),
        });
      }
    }

    /** Hello от OBS; можно передать данные входа. */
    hello(extra) {
      const data = Object.assign(
        { obsWebSocketVersion: "5.5.2", rpcVersion: 1 },
        extra || {},
      );
      this.receive({ op: 0, d: data });
    }

    /** Identified от OBS. */
    identified() {
      this.receive({ op: 2, d: { negotiatedRpcVersion: 1 } });
    }

    /** Соединение оборвалось (или OBS не ответил). */
    fail(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onerror) this.onerror({ message: reason || "" });
      if (this.onclose) this.onclose({ code: code || 1006, reason: reason || "" });
    }

    lastSent() {
      return this.sentParsed[this.sentParsed.length - 1] || null;
    }
  }

  return {
    instances: instances,
    create: function (url) {
      return new FakeWebSocket(url);
    },
    last: function () {
      return instances[instances.length - 1] || null;
    },
    count: function () {
      return instances.length;
    },
    FakeWebSocket: FakeWebSocket,
  };
}

/**
 * Поддельное распознавание речи: тест сам присылает результаты и ошибки.
 * Подключается как window.webkitSpeechRecognition (или SpeechRecognition).
 */
function createSpeechFactory() {
  const instances = [];

  class FakeRecognition {
    constructor() {
      this.lang = "";
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
      this.started = false;
      this.stopped = false;
      this.startCount = 0;
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
      this.onresult = null;
      this.onaudiostart = null;
      this.onspeechend = null;
      instances.push(this);
    }

    start() {
      this.started = true;
      this.stopped = false;
      this.startCount += 1;
      if (this.onstart) this.onstart({});
    }

    stop() {
      this.started = false;
      this.stopped = true;
      if (this.onend) this.onend({});
    }

    abort() {
      this.started = false;
      if (this.onend) this.onend({});
    }

    /**
     * Прислать результат распознавания.
     * alternatives: массив строк; isFinal: готовая ли фраза.
     */
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

    /** Прислать ошибку распознавания (код как в браузере). */
    emitError(code) {
      if (this.onerror) this.onerror({ error: code, message: code });
    }

    /** Прислать «распознавание остановилось» — браузер делает это сам. */
    emitEnd() {
      this.started = false;
      if (this.onend) this.onend({});
    }
  }

  return {
    Recognition: FakeRecognition,
    instances: instances,
    last: function () {
      return instances[instances.length - 1] || null;
    },
    count: function () {
      return instances.length;
    },
  };
}

/**
 * Поддельное окно страницы: localStorage, часы, crypto, URL и rAF.
 * Часы отдаются отдельно (clock), чтобы тест сам двигал время.
 */
function createWindow(overrides) {
  const clock = createClock();
  const win = {
    document: null,
    localStorage: createLocalStorage(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    crypto: globalThis.crypto,
    TextEncoder: globalThis.TextEncoder,
    URL: globalThis.URL,
    console: console,
    location: { href: "", hash: "", search: "" },
    navigator: { language: "ru-RU" },
    requestAnimationFrame: function (callback) {
      return clock.setTimeout(function () {
        callback(clock.now());
      }, 0);
    },
    cancelAnimationFrame: function (id) {
      clock.clearTimeout(id);
    },
  };
  if (overrides) Object.assign(win, overrides);
  return { window: win, clock: clock };
}

/** Найти все адреса из текста (для проверки «внешних адресов нет»). */
function findUrls(text) {
  const matches = String(text).match(/(?:https?|wss?):\/\/[^\s"'<>)]*/g) || [];
  return matches.map(function (url) {
    return url.replace(/[.,;:]+$/, "");
  });
}

/** Найти источники <script src="..."> в порядке страницы. */
function scriptSources(html) {
  const sources = [];
  const pattern = /<script\s+src="([^"]+)"\s*>\s*<\/script>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) sources.push(match[1]);
  return sources;
}

module.exports = {
  ROOT,
  readProject,
  loadScripts,
  loadedFiles,
  plain,
  flushAsync,
  waitFor,
  FakeElement,
  createDocument,
  createLocalStorage,
  createClock,
  createWebSocketFactory,
  createSpeechFactory,
  createWindow,
  findUrls,
  scriptSources,
};
