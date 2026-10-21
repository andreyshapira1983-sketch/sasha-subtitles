"use strict";
// Страница управления «Субтитры Саши», версия 4.1.
//
// Распознавание речи делает сам браузер (Chrome или Edge), а готовые фразы
// уходят в OBS через встроенный WebSocket. В OBS эту страницу не открывают:
// у источника «Браузер» нет доступа к микрофону. Зато overlay.html в OBS
// показывает то, что пришло отсюда.
//
// Микрофон включается ТОЛЬКО по нажатию «Начать»: до нажатия ничего не
// создаётся и не слушается. Состояние «слушаю» появляется только после
// настоящего события onstart/onaudiostart распознавания, а до этого на
// странице честно написано «ждём разрешения микрофона».
//
// Готовые фразы (final: true) проходят автоправку из js/autofix.js: словарь,
// заглавные, точки/вопросы, запятые, мелочи. Промежуточный текст не трогаем.
//
// Обычный браузерный скрипт без модулей: control.html подключает его
// четвёртым, после js/text.js, js/autofix.js и js/obs.js. Всё внешнее
// (таймеры, localStorage, конструктор распознавания, WebSocket) берётся из
// window или options — поэтому страницу можно целиком проверить на Node без
// браузера (см. tests/control.test.js).
(function (global) {
  "use strict";

  const SS = global.SS || (global.SS = {});

  // Ключи localStorage: настройки OBS и автоправки хранятся только в этом браузере.
  const STORAGE_KEY = "sasha-subtitles.obs";
  const AUTOFIX_STORAGE_KEY = "sasha-subtitles.autofix";

  // Сколько фраз помнить в истории и сколько ждать перед автоперезапуском.
  const MAX_HISTORY = 20;
  const RESTART_DELAY = 400;

  // Понятные человеку надписи (тексты держим рядом, чтобы их проверяли тесты).
  const NOTICE_BROWSER = "Откройте эту страницу в Chrome или Edge";
  const NOTICE_NO_MIC =
    "Доступ к микрофону запрещён: разрешите его в адресной строке браузера и нажмите «Начать»";
  const NOTICE_NO_START =
    "Не удалось включить микрофон: проверьте, что он подключён, и нажмите «Начать» ещё раз";

  // Ровно шесть языков — как в задании. Код уходит в SpeechRecognition.lang
  // и в автоправку (для запятых и знака в конце фразы).
  const LANGUAGES = [
    { code: "ru-RU", label: "Русский" },
    { code: "en-US", label: "Английский" },
    { code: "uk-UA", label: "Украинский" },
    { code: "he-IL", label: "Иврит" },
    { code: "de-DE", label: "Немецкий" },
    { code: "es-ES", label: "Испанский" },
  ];

  // Настройки по умолчанию. Корни мата — как в старом config.json проекта:
  // первая буква слова остаётся, остальные заменяются звёздочками.
  const DEFAULT_SETTINGS = {
    language: "ru-RU",
    name: "Ведущий",
    color: "#8fd8ff",
    roots: "блять, хуй, пизд, ебал",
    url: "ws://127.0.0.1:4455",
    port: "4455",
    password: "",
  };

  // Человеческие имена правил автоправки → id галочек на странице.
  const FIX_RULE_IDS = {
    dictionary: "fix-dictionary",
    capitalize: "fix-capitalize",
    punctuation: "fix-punctuation",
    commas: "fix-commas",
    cleanup: "fix-cleanup",
  };

  // Запасные значения правил: нужны, если js/autofix.js не загрузился.
  const DEFAULT_FIX_RULES = {
    dictionary: true,
    capitalize: true,
    punctuation: true,
    commas: true,
    cleanup: true,
  };

  // Машинные состояния контроллера и надписи для человека.
  const STATE = {
    UNSUPPORTED: "unsupported",
    STOPPED: "stopped",
    WAITING: "waiting",
    LISTENING: "listening",
    PAUSED: "paused",
  };

  const STATUS = {
    UNSUPPORTED: "нет распознавания",
    STOPPED: "остановлено",
    WAITING: "ждём разрешения микрофона",
    LISTENING: "слушаю",
    PAUSED: "пауза",
  };

  /** Строка или запасное значение, без падений на null/undefined. */
  function asString(value, fallback) {
    if (value === undefined || value === null) return fallback;
    return String(value);
  }

  /** Привести язык к одному из шести известных кодов. */
  function normalizeLanguage(value) {
    const code = asString(value, "");
    for (const item of LANGUAGES) {
      if (item.code === code) return code;
    }
    return DEFAULT_SETTINGS.language;
  }

  /** Поле корней мата в виде строки (пользователь может передать массив). */
  function rootsToString(value) {
    if (Array.isArray(value)) return value.join(", ");
    return asString(value, "");
  }

  /** Разобрать строку корней: запятые, точка с запятой и пробелы. */
  function parseRoots(value) {
    return rootsToString(value)
      .split(/[,;\s]+/)
      .filter(Boolean);
  }

  /** Имя говорящего: пустое поле не должно оставлять субтитры без подписи. */
  function normalizeName(value) {
    const text = asString(value, "").trim();
    return text || DEFAULT_SETTINGS.name;
  }

  /** Цвет в виде #rrggbb; мусор заменяется цветом по умолчанию. */
  function normalizeColor(value) {
    const text = asString(value, "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text : DEFAULT_SETTINGS.color;
  }

  /** Порт из настроек: только цифры, иначе значение по умолчанию. */
  function normalizePort(value) {
    const digits = asString(value, "").replace(/\D+/g, "");
    return digits || DEFAULT_SETTINGS.port;
  }

  /** Есть ли у браузера встроенное распознавание речи. */
  function recognitionSupported(win) {
    if (!win) return false;
    return (
      typeof win.SpeechRecognition === "function" ||
      typeof win.webkitSpeechRecognition === "function"
    );
  }

  /**
   * Создать контроллер страницы.
   *
   * doc и win — обычные document и window (в тестах — подделки).
   * options: localStorage, setTimeout, clearTimeout, createRecognition,
   *          createSocket, crypto, settings, restartDelay.
   */
  function createControl(doc, win, options) {
    const opts = options && typeof options === "object" ? options : {};
    const document_ = doc || (win && win.document) || null;
    const window_ = win || global;

    // ---------- внешнее окружение: всё, что тесты подменяют ----------

    /** Найти элемент страницы по id; отсутствие элемента — не ошибка. */
    function el(id) {
      if (!document_ || typeof document_.getElementById !== "function") return null;
      return document_.getElementById(id);
    }

    const setTimer = typeof opts.setTimeout === "function"
      ? function (callback, ms) {
          return opts.setTimeout(callback, ms);
        }
      : typeof window_.setTimeout === "function"
        ? function (callback, ms) {
            return window_.setTimeout(callback, ms);
          }
        : function (callback, ms) {
            return global.setTimeout(callback, ms);
          };

    const clearTimer = typeof opts.clearTimeout === "function"
      ? function (id) {
          return opts.clearTimeout(id);
        }
      : typeof window_.clearTimeout === "function"
        ? function (id) {
            return window_.clearTimeout(id);
          }
        : function (id) {
            return global.clearTimeout(id);
          };

    /** localStorage этого браузера; в приватном режиме может быть недоступен. */
    function storage() {
      if (opts.localStorage !== undefined) return opts.localStorage;
      try {
        return window_.localStorage || null;
      } catch (error) {
        return null;
      }
    }

    /** Конструктор распознавания: сначала options, потом браузер. */
    function speechConstructor() {
      if (typeof opts.createRecognition === "function") return opts.createRecognition;
      if (typeof window_.SpeechRecognition === "function") return window_.SpeechRecognition;
      if (typeof window_.webkitSpeechRecognition === "function") {
        return window_.webkitSpeechRecognition;
      }
      return null;
    }

    /** Создать WebSocket: options.createSocket, иначе настоящий из браузера. */
    function socketFactory() {
      if (typeof opts.createSocket === "function") {
        return function (url) {
          return opts.createSocket(url);
        };
      }
      if (typeof window_.WebSocket === "function") {
        return function (url) {
          return new window_.WebSocket(url);
        };
      }
      // createClient сам возьмёт WebSocket из окружения или сообщит об ошибке.
      return undefined;
    }

    // ---------- настройки ----------

    const settings = Object.assign({}, DEFAULT_SETTINGS);

    /** Прочитать сохранённые настройки OBS (только они и только этот браузер). */
    function readStoredObs() {
      const store = storage();
      if (!store || typeof store.getItem !== "function") return null;
      let raw;
      try {
        raw = store.getItem(STORAGE_KEY);
      } catch (error) {
        return null;
      }
      if (!raw) return null;
      try {
        const data = JSON.parse(raw);
        return data && typeof data === "object" ? data : null;
      } catch (error) {
        return null;
      }
    }

    /** Запомнить настройки OBS; приватный режим не должен ронять страницу. */
    function saveStoredObs() {
      const store = storage();
      if (!store || typeof store.setItem !== "function") return false;
      try {
        store.setItem(
          STORAGE_KEY,
          JSON.stringify({
            url: settings.url,
            port: settings.port,
            password: settings.password,
          })
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    /** Применить настройки из options поверх значений по умолчанию. */
    function applySettings(input) {
      if (!input || typeof input !== "object") return;
      if (input.language !== undefined) settings.language = normalizeLanguage(input.language);
      if (input.name !== undefined) settings.name = normalizeName(input.name);
      if (input.color !== undefined) settings.color = normalizeColor(input.color);
      if (input.roots !== undefined) settings.roots = rootsToString(input.roots);
      if (input.url !== undefined) settings.url = asString(input.url, settings.url);
      if (input.port !== undefined) settings.port = normalizePort(input.port);
      if (input.password !== undefined) settings.password = asString(input.password, "");
    }

    settings.language = normalizeLanguage(settings.language);
    settings.name = normalizeName(settings.name);
    settings.color = normalizeColor(settings.color);
    settings.roots = rootsToString(settings.roots);
    settings.url = asString(settings.url, DEFAULT_SETTINGS.url);
    settings.port = normalizePort(settings.port);
    settings.password = asString(settings.password, "");

    // Сохранённые в браузере настройки OBS важнее значений по умолчанию,
    // а явно переданные options — важнее сохранённых.
    const storedObs = readStoredObs();
    if (storedObs) {
      if (storedObs.url !== undefined) settings.url = asString(storedObs.url, settings.url);
      if (storedObs.port !== undefined) settings.port = normalizePort(storedObs.port);
      if (storedObs.password !== undefined) {
        settings.password = asString(storedObs.password, "");
      }
    }
    applySettings(opts.settings);
    settings.language = normalizeLanguage(settings.language);
    settings.name = normalizeName(settings.name);
    settings.color = normalizeColor(settings.color);
    settings.roots = rootsToString(settings.roots);
    settings.port = normalizePort(settings.port);

    // ---------- автоправка: правила и словарь ----------

    /** Правила и словарь по умолчанию (из js/autofix.js, если он загружен). */
    function autofixDefaults() {
      const Autofix = SS.Autofix;
      const dictionary = Autofix && Array.isArray(Autofix.DEFAULT_DICTIONARY)
        ? Autofix.DEFAULT_DICTIONARY.map(function (pair) {
            return { from: asString(pair.from, ""), to: asString(pair.to, "") };
          })
        : [];
      const rules = Object.assign(
        {},
        DEFAULT_FIX_RULES,
        Autofix && Autofix.DEFAULT_RULES ? Autofix.DEFAULT_RULES : {}
      );
      return { dictionary: dictionary, rules: rules };
    }

    /** Привести пары словаря к безопасному виду; js/autofix.js умеет это лучше. */
    function sanitizeDictionary(list) {
      if (SS.Autofix && typeof SS.Autofix.sanitizeDictionary === "function") {
        return SS.Autofix.sanitizeDictionary(list);
      }
      const result = [];
      for (const pair of Array.isArray(list) ? list : []) {
        if (!pair || typeof pair !== "object") continue;
        const from = asString(pair.from, "").trim();
        if (!from) continue;
        result.push({ from: from, to: asString(pair.to, "") });
      }
      return result;
    }

    const fixDefaults = autofixDefaults();
    const fixRules = Object.assign({}, fixDefaults.rules);
    let dictionaryItems = fixDefaults.dictionary.slice();
    let dictMessageText = "";

    /** Прочитать сохранённые правила и словарь автоправки. */
    function readStoredAutofix() {
      const store = storage();
      if (!store || typeof store.getItem !== "function") return null;
      let raw;
      try {
        raw = store.getItem(AUTOFIX_STORAGE_KEY);
      } catch (error) {
        return null;
      }
      if (!raw) return null;
      try {
        const data = JSON.parse(raw);
        return data && typeof data === "object" ? data : null;
      } catch (error) {
        return null;
      }
    }

    /** Запомнить правила и словарь; приватный режим не должен ронять страницу. */
    function saveStoredAutofix() {
      const store = storage();
      if (!store || typeof store.setItem !== "function") return false;
      try {
        store.setItem(
          AUTOFIX_STORAGE_KEY,
          JSON.stringify({
            rules: Object.assign({}, fixRules),
            dictionary: sanitizeDictionary(dictionaryItems),
          })
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    /** Применить сохранённые настройки автоправки; битые данные — по умолчанию. */
    function applyStoredAutofix() {
      const stored = readStoredAutofix();
      if (!stored) return;
      if (stored.rules && typeof stored.rules === "object") {
        for (const name of Object.keys(DEFAULT_FIX_RULES)) {
          if (stored.rules[name] !== undefined) {
            fixRules[name] = Boolean(stored.rules[name]);
          }
        }
      }
      if (Array.isArray(stored.dictionary)) {
        const clean = sanitizeDictionary(stored.dictionary);
        if (clean.length) dictionaryItems = clean;
      }
    }

    /** Копия правил автоправки (чтобы снаружи нельзя было испортить настройки). */
    function rulesCopy() {
      return Object.assign({}, fixRules);
    }

    /** Копия текущего словаря без пустых пар. */
    function dictionaryCopy() {
      return sanitizeDictionary(dictionaryItems);
    }

    /** Применить автоправку к готовой фразе (промежуточную не трогаем). */
    function autofixText(text) {
      if (!SS.Autofix || typeof SS.Autofix.autofix !== "function") return text;
      return SS.Autofix.autofix(text, {
        language: settings.language,
        dictionary: dictionaryCopy(),
        rules: rulesCopy(),
      });
    }

    /**
     * Полный путь фразы так, как её увидит OBS: нормализация, автоправка
     * (только final) и маскировка мата. Историю не пишет.
     */
    function fixText(text, final) {
      const normalized = SS.Text && typeof SS.Text.normalize === "function"
        ? SS.Text.normalize(text)
        : asString(text, "").trim();
      if (!normalized) return "";
      if (final === false) return maskText(normalized);
      return maskText(autofixText(normalized));
    }

    /** Сообщение под словарём: «Словарь загружен» или понятная ошибка. */
    function setDictMessage(text, isError) {
      dictMessageText = text || "";
      setText(ui.dictMessage, dictMessageText);
      setHidden(ui.dictMessage, !dictMessageText);
      if (ui.dictMessage) {
        ui.dictMessage.className = isError
          ? "dict-message dict-message--error"
          : "dict-message";
      }
    }

    // ---------- состояние ----------

    const supported =
      recognitionSupported(window_) || typeof opts.createRecognition === "function";

    let currentState = supported ? STATE.STOPPED : STATE.UNSUPPORTED;
    let running = false; // распознавание включено и не остановлено вручную
    let paused = false;
    let live = "";
    let noticeText = supported ? "" : NOTICE_BROWSER;
    let obsStatusText = "не подключено";
    let obsHintText = "";
    const historyItems = []; // {raw: как распознано, fixed: что ушло в OBS}
    let recognition = null;
    let obsClient = null;
    let restartTimer = null;
    let restartWaiting = false;

    // Элементы страницы. Если какого-то нет (например, в тесте), просто молчим.
    const ui = {
      start: el("start"),
      pause: el("pause"),
      status: el("status"),
      live: el("live"),
      history: el("history"),
      notice: el("notice"),
      language: el("language"),
      name: el("speaker-name"),
      color: el("speaker-color"),
      roots: el("mask-roots"),
      obsUrl: el("obs-url"),
      obsPort: el("obs-port"),
      obsPassword: el("obs-password"),
      obsStatus: el("obs-status"),
      obsHint: el("obs-hint"),
      fixRules: {
        dictionary: el(FIX_RULE_IDS.dictionary),
        capitalize: el(FIX_RULE_IDS.capitalize),
        punctuation: el(FIX_RULE_IDS.punctuation),
        commas: el(FIX_RULE_IDS.commas),
        cleanup: el(FIX_RULE_IDS.cleanup),
      },
      dictList: el("dict-list"),
      dictAdd: el("dict-add"),
      dictExport: el("dict-export"),
      dictImport: el("dict-import"),
      dictImportFile: el("dict-import-file"),
      dictMessage: el("dict-message"),
    };

    /** Записать текст в элемент, не падая на отсутствующем элементе. */
    function setText(node, text) {
      if (node) node.textContent = String(text);
    }

    /** Показать или спрятать элемент. */
    function setHidden(node, hidden) {
      if (node) node.hidden = Boolean(hidden);
    }

    function statusLabel() {
      if (currentState === STATE.UNSUPPORTED) return STATUS.UNSUPPORTED;
      if (currentState === STATE.WAITING) return STATUS.WAITING;
      if (currentState === STATE.LISTENING) return STATUS.LISTENING;
      if (currentState === STATE.PAUSED) return STATUS.PAUSED;
      return STATUS.STOPPED;
    }

    function setNotice(text) {
      noticeText = text || "";
    }

    function setObsStatus(text) {
      obsStatusText = asString(text, "");
      setText(ui.obsStatus, obsStatusText);
    }

    function showObsHint(text) {
      obsHintText = text || "";
      setText(ui.obsHint, obsHintText);
      setHidden(ui.obsHint, !obsHintText);
    }

    /**
     * Перерисовать кнопки, индикатор и надпись-предупреждение.
     * В ожидании микрофона главная кнопка уже «Остановить», а пауза ещё
     * недоступна: распознавание формально запущено, но не подтвердилось.
     */
    function renderButtons() {
      if (ui.start) {
        ui.start.disabled = currentState === STATE.UNSUPPORTED;
        const active =
          currentState === STATE.WAITING ||
          currentState === STATE.LISTENING ||
          currentState === STATE.PAUSED;
        ui.start.textContent = active ? "Остановить" : "Начать";
      }
      if (ui.pause) {
        const canPause =
          currentState === STATE.LISTENING || currentState === STATE.PAUSED;
        ui.pause.disabled = !canPause;
        ui.pause.textContent = currentState === STATE.PAUSED ? "Продолжить" : "Пауза";
      }
    }

    function renderStatus() {
      if (!ui.status) return;
      ui.status.textContent = statusLabel();
      ui.status.className = "status status--" + currentState;
    }

    function renderLive() {
      setText(ui.live, live);
      if (ui.live) {
        ui.live.className = live ? "live live--on" : "live";
      }
    }

    /**
     * История: у каждой фразы две строки — «как распознано» и «как исправлено».
     * Создаём элементы через document.createElement, как и раньше.
     */
    function renderHistory() {
      const list = ui.history;
      if (!list) return;
      if (typeof document_.createElement !== "function") {
        list.textContent = historyItems
          .map(function (entry) {
            return entry.fixed;
          })
          .join("\n");
        return;
      }
      list.innerHTML = "";
      for (const entry of historyItems) {
        const item = document_.createElement("li");
        item.className = "history-item";
        const raw = document_.createElement("span");
        raw.className = "history-raw";
        raw.textContent = "как распознано: " + entry.raw;
        const fixed = document_.createElement("span");
        fixed.className = "history-fixed";
        fixed.textContent = "как исправлено: " + entry.fixed;
        item.appendChild(raw);
        item.appendChild(fixed);
        list.appendChild(item);
      }
    }

    function renderNotice() {
      setText(ui.notice, noticeText);
      setHidden(ui.notice, !noticeText);
    }

    /** Галочки правил автоправки показывают текущие настройки. */
    function renderFixRules() {
      for (const name of Object.keys(FIX_RULE_IDS)) {
        const box = ui.fixRules[name];
        if (box) box.checked = Boolean(fixRules[name]);
      }
    }

    /**
     * Таблица словаря «было → стало»: две строки ввода и кнопка удаления.
     * Пустые пары в localStorage не сохраняются, но в таблице живут, чтобы
     * человек мог начать новую строку.
     */
    function renderDictionary() {
      const list = ui.dictList;
      if (!list || typeof document_.createElement !== "function") return;
      list.innerHTML = "";
      for (let index = 0; index < dictionaryItems.length; index += 1) {
        const pair = dictionaryItems[index];
        const row = document_.createElement("div");
        row.className = "dict-row";

        const fromInput = document_.createElement("input");
        fromInput.type = "text";
        fromInput.className = "dict-from";
        fromInput.placeholder = "было";
        fromInput.value = asString(pair.from, "");
        fromInput.setAttribute("aria-label", "как распознаётся");
        on(fromInput, "input", function () {
          updateDictionaryPair(index, "from", fieldValue(fromInput));
        });
        on(fromInput, "change", function () {
          updateDictionaryPair(index, "from", fieldValue(fromInput));
        });

        const toInput = document_.createElement("input");
        toInput.type = "text";
        toInput.className = "dict-to";
        toInput.placeholder = "стало";
        toInput.value = asString(pair.to, "");
        toInput.setAttribute("aria-label", "как писать");
        on(toInput, "input", function () {
          updateDictionaryPair(index, "to", fieldValue(toInput));
        });
        on(toInput, "change", function () {
          updateDictionaryPair(index, "to", fieldValue(toInput));
        });

        const removeButton = document_.createElement("button");
        removeButton.type = "button";
        removeButton.className = "dict-remove";
        removeButton.textContent = "Удалить";
        removeButton.setAttribute("title", "Удалить строку словаря");
        on(removeButton, "click", function () {
          dictionaryItems.splice(index, 1);
          saveStoredAutofix();
          renderDictionary();
        });

        row.appendChild(fromInput);
        row.appendChild(toInput);
        row.appendChild(removeButton);
        list.appendChild(row);
      }
    }

    /** Изменить поле пары словаря и сразу сохранить настройки. */
    function updateDictionaryPair(index, field, value) {
      const pair = dictionaryItems[index];
      if (!pair) return;
      pair[field] = asString(value, "");
      saveStoredAutofix();
    }

    /** Заменить словарь (из импорта или теста) и обновить страницу. */
    function setDictionary(list) {
      dictionaryItems = sanitizeDictionary(list);
      saveStoredAutofix();
      renderDictionary();
      return dictionaryCopy();
    }

    /** Включить/выключить правила автоправки: partial поверх текущих. */
    function setRules(partial) {
      if (partial && typeof partial === "object") {
        for (const name of Object.keys(DEFAULT_FIX_RULES)) {
          if (partial[name] !== undefined) fixRules[name] = Boolean(partial[name]);
        }
        saveStoredAutofix();
        renderFixRules();
      }
      return rulesCopy();
    }

    /** JSON словаря для экспорта (красивый и читаемый). */
    function exportDictionary() {
      if (SS.Autofix && typeof SS.Autofix.dictionaryToJson === "function") {
        return SS.Autofix.dictionaryToJson(dictionaryItems);
      }
      return JSON.stringify(dictionaryCopy(), null, 2);
    }

    /** Импорт словаря из JSON: понятная ошибка по-русски и boolean. */
    function importDictionary(json) {
      if (!SS.Autofix || typeof SS.Autofix.dictionaryFromJson !== "function") {
        setDictMessage("Автоправка недоступна: подключите js/autofix.js", true);
        return false;
      }
      const result = SS.Autofix.dictionaryFromJson(json);
      if (!result || !result.ok) {
        setDictMessage(
          (result && result.error) || "Не удалось прочитать словарь",
          true
        );
        return false;
      }
      setDictionary(result.dictionary);
      setDictMessage(
        "Словарь загружен: " + dictionaryCopy().length + " строк",
        false
      );
      return true;
    }

    /** Выгрузить словарь файлом; если браузер не даёт — хотя бы не упасть. */
    function exportDictionaryToFile() {
      const json = exportDictionary();
      let downloaded = false;
      try {
        if (document_ && typeof document_.createElement === "function") {
          const link = document_.createElement("a");
          const BlobCtor = typeof window_.Blob === "function"
            ? window_.Blob
            : typeof global.Blob === "function"
              ? global.Blob
              : null;
          let href = "";
          if (
            BlobCtor &&
            window_.URL &&
            typeof window_.URL.createObjectURL === "function"
          ) {
            href = window_.URL.createObjectURL(
              new BlobCtor([json], { type: "application/json" })
            );
          } else {
            href = "data:application/json;charset=utf-8," + encodeURIComponent(json);
          }
          link.href = href;
          link.download = "sasha-subtitles-dictionary.json";
          if (typeof link.click === "function") {
            link.click();
            downloaded = true;
          }
        }
      } catch (error) {
        downloaded = false;
      }
      setDictMessage(
        downloaded
          ? "Словарь выгружен в файл"
          : "Не удалось выгрузить файл: словарь остался на странице",
        !downloaded
      );
      return json;
    }

    /** Прочитать выбранный файл словаря: File.text() или FileReader. */
    function readDictFile(file) {
      try {
        if (file && typeof file.text === "function") {
          file.text().then(
            function (text) {
              importDictionary(text);
            },
            function () {
              setDictMessage("Не удалось прочитать файл", true);
            }
          );
          return;
        }
        const Reader = window_.FileReader;
        if (typeof Reader === "function") {
          const reader = new Reader();
          reader.onload = function () {
            importDictionary(String(reader.result || ""));
          };
          reader.onerror = function () {
            setDictMessage("Не удалось прочитать файл", true);
          };
          reader.readAsText(file);
          return;
        }
      } catch (error) {
        setDictMessage("Не удалось прочитать файл", true);
        return;
      }
      setDictMessage("Браузер не умеет читать файлы", true);
    }

    function render() {
      renderButtons();
      renderStatus();
      renderLive();
      renderHistory();
      renderNotice();
    }

    // ---------- поля страницы ----------

    /** Наполнить список языков (ровно шесть записей). */
    function fillLanguages() {
      const select = ui.language;
      if (!select) return;
      if (typeof document_.createElement === "function") {
        select.innerHTML = "";
        for (const item of LANGUAGES) {
          const option = document_.createElement("option");
          option.value = item.code;
          option.textContent = item.label;
          select.appendChild(option);
        }
      }
      select.value = settings.language;
    }

    /** Показать в полях текущие настройки. */
    function syncInputs() {
      if (ui.language) ui.language.value = settings.language;
      if (ui.name) ui.name.value = settings.name;
      if (ui.color) ui.color.value = settings.color;
      if (ui.roots) ui.roots.value = settings.roots;
      if (ui.obsUrl) ui.obsUrl.value = settings.url;
      if (ui.obsPort) ui.obsPort.value = settings.port;
      if (ui.obsPassword) ui.obsPassword.value = settings.password;
    }

    /** Подписаться на событие элемента, если элемент есть. */
    function on(node, type, handler) {
      if (node && typeof node.addEventListener === "function") {
        node.addEventListener(type, handler);
      }
    }

    /** Значение поля (у поддельного DOM тоже есть value). */
    function fieldValue(node) {
      if (!node) return "";
      return node.value === undefined || node.value === null ? "" : String(node.value);
    }

    // ---------- связь с OBS ----------

    /** Адрес OBS из двух полей: адрес и порт. Только свой компьютер. */
    function targetUrl() {
      const Obs = SS.Obs;
      if (!Obs || typeof Obs.normalizeUrl !== "function") return null;
      const address = asString(settings.url, "").trim();
      const normalized = Obs.normalizeUrl(address);
      if (!normalized) return null;
      // Если в адресе нет порта, берём его из отдельного поля.
      const afterScheme = address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
      const addressHasPort = /:\d+(?:\/|$)/.test(afterScheme);
      const port = asString(settings.port, "").replace(/\D+/g, "");
      if (!addressHasPort && port) {
        return Obs.normalizeUrl(normalized.replace(/:\d+$/, ":" + port)) || null;
      }
      return normalized;
    }

    /** Сменить надпись о состоянии связи с OBS. */
    function handleObsState(state) {
      if (state === "connecting") {
        setObsStatus("подключаюсь к OBS…");
      } else if (state === "identifying") {
        setObsStatus("вхожу в OBS…");
      } else if (state === "ready") {
        setObsStatus("OBS подключён");
        showObsHint("");
      } else if (state === "closed") {
        setObsStatus("нет связи с OBS");
        if (running) showObsHint(SS.Obs ? SS.Obs.HINT_WS_OFF : "");
      }
    }

    /** Создать клиент OBS или заменить его после смены настроек. */
    function ensureObsClient(recreate) {
      const Obs = SS.Obs;
      if (!Obs || typeof Obs.createClient !== "function") {
        setObsStatus("OBS недоступен");
        return null;
      }
      if (obsClient && !recreate) return obsClient;
      if (obsClient) {
        try {
          obsClient.close();
        } catch (error) {
          // Клиент уже закрыт — это не ошибка.
        }
        obsClient = null;
      }
      const url = targetUrl();
      if (!url) {
        setObsStatus("адрес OBS неверный");
        showObsHint(Obs.HINT_WS_OFF);
        return null;
      }
      // Старое подключение уже закрыто; подсказка про WebSocket появится,
      // если новый клиент так и не соединится.
      showObsHint("");
      obsClient = Obs.createClient({
        url: url,
        password: settings.password,
        createSocket: socketFactory(),
        setTimeout: setTimer,
        clearTimeout: clearTimer,
        crypto: opts.crypto || window_.crypto,
        onState: handleObsState,
        onError: function (message) {
          setObsStatus("ошибка OBS");
          showObsHint(message || Obs.HINT_WS_OFF);
        },
      });
      obsClient.connect();
      return obsClient;
    }

    /**
     * Отправить реплику в OBS. Если связи нет — подсказка, как включить
     * WebSocket, и грустный false. Возвращает true только при отправке.
     */
    function deliver(payload) {
      let delivered = false;
      if (obsClient && typeof obsClient.sendPayload === "function" && obsClient.isReady()) {
        delivered = obsClient.sendPayload(payload) === true;
      }
      if (!delivered && SS.Obs) showObsHint(SS.Obs.HINT_WS_OFF);
      return delivered;
    }

    /** После смены адреса/порта/пароля: сохранить и переподключиться. */
    function afterObsSettingsChanged() {
      saveStoredObs();
      if (running) ensureObsClient(true);
    }

    /** Адрес в поле «Адрес»: привести к ws://127.0.0.1:порт. */
    function applyObsUrl(value) {
      const raw = asString(value, "").trim();
      const Obs = SS.Obs;
      const normalized = Obs && typeof Obs.normalizeUrl === "function"
        ? Obs.normalizeUrl(raw)
        : null;
      if (normalized) {
        settings.url = normalized;
        const match = /:(\d+)$/.exec(normalized);
        if (match) settings.port = match[1];
        if (ui.obsUrl) ui.obsUrl.value = normalized;
        if (ui.obsPort) ui.obsPort.value = settings.port;
      } else {
        settings.url = raw;
      }
      afterObsSettingsChanged();
    }

    /** Порт в отдельном поле: он же переносится в адрес. */
    function applyObsPort(value) {
      settings.port = normalizePort(value);
      if (ui.obsPort) ui.obsPort.value = settings.port;
      const normalized = SS.Obs && typeof SS.Obs.normalizeUrl === "function"
        ? SS.Obs.normalizeUrl(settings.url)
        : null;
      const host = (normalized || DEFAULT_SETTINGS.url)
        .replace(/^ws:\/\//, "")
        .replace(/:\d+$/, "");
      settings.url = "ws://" + host + ":" + settings.port;
      if (ui.obsUrl) ui.obsUrl.value = settings.url;
      afterObsSettingsChanged();
    }

    // ---------- распознавание речи ----------

    function rootsList() {
      return parseRoots(settings.roots);
    }

    /** Замаскировать мат звёздочками через общий js/text.js. */
    function maskText(text) {
      if (!SS.Text || typeof SS.Text.maskRoots !== "function") return text;
      return SS.Text.maskRoots(text, rootsList());
    }

    /** Показать или очистить живой (промежуточный) текст. */
    function setLive(text) {
      live = asString(text, "");
      renderLive();
    }

    /**
     * Принять текст: для готовой фразы — автоправка, потом маскировка мата,
     * для промежуточной — только маскировка. Пустое и команды «э:» не уходят.
     */
    function sendText(text, final) {
      const isFinal = final !== false;
      const normalized = SS.Text && typeof SS.Text.normalize === "function"
        ? SS.Text.normalize(text)
        : asString(text, "").trim();
      if (!normalized) return false;
      const shown = isFinal ? maskText(autofixText(normalized)) : maskText(normalized);
      if (SS.Text && typeof SS.Text.shouldShow === "function" && !SS.Text.shouldShow(shown)) {
        return false;
      }
      // Пауза: ничего не отправляем и не показываем; живой текст очищается.
      if (paused) {
        if (live) setLive("");
        return false;
      }
      if (isFinal) {
        if (live) setLive("");
        historyItems.unshift({ raw: normalized, fixed: shown });
        if (historyItems.length > MAX_HISTORY) historyItems.length = MAX_HISTORY;
        renderHistory();
      } else {
        setLive(shown);
      }
      deliver({
        speaker: "host",
        name: normalizeName(settings.name),
        color: normalizeColor(settings.color),
        text: shown,
        final: isFinal,
      });
      return true;
    }

    /**
     * Пока распознавание не подтвердило старт (onstart/onaudiostart),
     * честно показываем «ждём разрешения микрофона». В паузе состояние
     * остаётся «пауза»: человек сам её выбрал.
     */
    function markWaiting() {
      if (!running || paused) return;
      currentState = STATE.WAITING;
      renderButtons();
      renderStatus();
    }

    /** Браузер подтвердил старт микрофона — только теперь «слушаю». */
    function handleRecognitionStart() {
      if (!running) return;
      if (paused) {
        currentState = STATE.PAUSED;
      } else {
        currentState = STATE.LISTENING;
        setNotice("");
      }
      render();
    }

    /** Создать распознавание и сразу включить его. */
    function startRecognition() {
      if (!running) return false;
      const Ctor = speechConstructor();
      if (!Ctor) return false;
      const instance = new Ctor();
      recognition = instance;
      instance.continuous = true;
      instance.interimResults = true;
      instance.lang = settings.language;
      if ("maxAlternatives" in instance) instance.maxAlternatives = 1;
      instance.onresult = handleResult;
      instance.onerror = handleRecognitionError;
      instance.onend = handleRecognitionEnd;
      // onstart/onaudiostart — единственный признак, что микрофон правда слушает.
      instance.onstart = handleRecognitionStart;
      instance.onaudiostart = handleRecognitionStart;
      markWaiting();
      try {
        instance.start();
        return true;
      } catch (error) {
        if (recognition === instance) {
          recognition = null;
          instance.onstart = null;
          instance.onaudiostart = null;
          instance.onresult = null;
          instance.onerror = null;
          instance.onend = null;
        }
        setNotice(NOTICE_NO_START);
        renderNotice();
        scheduleRestart();
        return false;
      }
    }

    /** Выключить текущее распознавание, не запуская перезапуск. */
    function forgetRecognition() {
      const instance = recognition;
      recognition = null;
      if (!instance) return;
      instance.onresult = null;
      instance.onerror = null;
      instance.onend = null;
      instance.onstart = null;
      instance.onaudiostart = null;
      try {
        if (typeof instance.abort === "function") instance.abort();
        else if (typeof instance.stop === "function") instance.stop();
      } catch (error) {
        // Распознавание уже остановлено — это не ошибка.
      }
    }

    /** Запланировать перезапуск распознавания после onend/onerror. */
    function scheduleRestart() {
      if (!running || restartWaiting) return;
      restartWaiting = true;
      const delay = typeof opts.restartDelay === "number" ? opts.restartDelay : RESTART_DELAY;
      restartTimer = setTimer(function () {
        restartTimer = null;
        restartWaiting = false;
        if (!running) return;
        startRecognition();
      }, delay);
    }

    /** Отменить запланированный перезапуск. */
    function cancelRestart() {
      restartWaiting = false;
      if (restartTimer !== null) {
        clearTimer(restartTimer);
        restartTimer = null;
      }
    }

    /** Перезапустить распознавание сразу (например, после смены языка). */
    function restartRecognition() {
      cancelRestart();
      forgetRecognition();
      if (running) startRecognition();
    }

    /** Разобрать event.results: промежуточные и готовые фразы. */
    function handleResult(event) {
      if (!running || !event) return;
      const results = event.results || [];
      const start = Number(event.resultIndex) || 0;
      for (let index = Math.max(0, start); index < results.length; index += 1) {
        const result = results[index];
        if (!result) continue;
        const alternative = result[0] || result;
        const raw = alternative && alternative.transcript !== undefined
          ? alternative.transcript
          : alternative && alternative.text;
        const isFinal = Boolean(result.isFinal);
        if (!asString(raw, "").trim()) continue;
        sendText(raw, isFinal);
      }
    }

    /** Распознавание само остановилось — перезапустить, если не пауза вручную. */
    function handleRecognitionEnd() {
      recognition = null;
      if (!running) return;
      // Пока новое распознавание не подтвердит старт, показываем ожидание.
      if (!paused) markWaiting();
      scheduleRestart();
    }

    /** Ошибка распознавания: разный ответ на разные коды. */
    function handleRecognitionError(event) {
      const code = event && event.error ? String(event.error) : "unknown";
      if (code === "not-allowed" || code === "service-not-allowed") {
        // Микрофон запретили: перезапуск не поможет, нужна просьба к человеку.
        setNotice(NOTICE_NO_MIC);
        stop();
        renderNotice();
        return;
      }
      if (!running) return;
      if (!paused) markWaiting();
      // no-speech, network, aborted и прочие временные беды: просто продолжим.
      scheduleRestart();
    }

    // ---------- кнопки и жизнь страницы ----------

    /** Включить распознавание по кнопке «Начать». Повторный вызов безопасен. */
    function start() {
      if (currentState === STATE.UNSUPPORTED) {
        setNotice(NOTICE_BROWSER);
        renderNotice();
        return false;
      }
      if (running) return true;
      running = true;
      paused = false;
      // Микрофон просит разрешение — «слушаю» появится только после onstart.
      currentState = STATE.WAITING;
      setNotice("");
      ensureObsClient(false);
      startRecognition();
      render();
      return true;
    }

    /** Выключить распознавание вручную: перезапуска больше не будет. */
    function stop() {
      const wasActive = running || currentState === STATE.PAUSED;
      running = false;
      paused = false;
      cancelRestart();
      forgetRecognition();
      if (obsClient) {
        try {
          obsClient.close();
        } catch (error) {
          // Клиент уже закрыт — это не ошибка.
        }
        obsClient = null;
      }
      currentState = supported ? STATE.STOPPED : STATE.UNSUPPORTED;
      setLive("");
      setObsStatus("не подключено");
      showObsHint("");
      render();
      return wasActive;
    }

    /** Пауза: ничего не отправляем, живой текст убираем. */
    function togglePause() {
      if (!running) return false;
      // В ожидании микрофона пауза недоступна: ещё нечего ставить на паузу.
      if (currentState !== STATE.LISTENING && currentState !== STATE.PAUSED) {
        return false;
      }
      paused = !paused;
      currentState = paused ? STATE.PAUSED : STATE.LISTENING;
      if (paused) setLive("");
      render();
      return paused;
    }

    /** Смена языка: запомнить и сразу перезапустить распознавание. */
    function applyLanguage(value) {
      settings.language = normalizeLanguage(value);
      if (ui.language) ui.language.value = settings.language;
      if (running) restartRecognition();
    }

    /** Развесить обработчики на поля и кнопки. */
    function bindEvents() {
      on(ui.start, "click", function () {
        if (running) stop();
        else start();
      });
      on(ui.pause, "click", function () {
        togglePause();
      });
      on(ui.language, "change", function () {
        applyLanguage(fieldValue(ui.language));
      });
      on(ui.name, "input", function () {
        settings.name = normalizeName(fieldValue(ui.name));
      });
      on(ui.name, "change", function () {
        settings.name = normalizeName(fieldValue(ui.name));
      });
      on(ui.color, "input", function () {
        settings.color = normalizeColor(fieldValue(ui.color));
      });
      on(ui.color, "change", function () {
        settings.color = normalizeColor(fieldValue(ui.color));
      });
      on(ui.roots, "input", function () {
        settings.roots = fieldValue(ui.roots);
      });
      on(ui.roots, "change", function () {
        settings.roots = fieldValue(ui.roots);
      });
      on(ui.obsUrl, "change", function () {
        applyObsUrl(fieldValue(ui.obsUrl));
      });
      on(ui.obsPort, "change", function () {
        applyObsPort(fieldValue(ui.obsPort));
      });
      on(ui.obsPassword, "input", function () {
        settings.password = fieldValue(ui.obsPassword);
        afterObsSettingsChanged();
      });
      on(ui.obsPassword, "change", function () {
        settings.password = fieldValue(ui.obsPassword);
        afterObsSettingsChanged();
      });

      // Галочки правил автоправки.
      for (const name of Object.keys(FIX_RULE_IDS)) {
        (function (ruleName) {
          on(ui.fixRules[ruleName], "change", function () {
            const box = ui.fixRules[ruleName];
            fixRules[ruleName] = Boolean(box && box.checked);
            saveStoredAutofix();
          });
        })(name);
      }

      // Словарь: добавить строку, экспорт, импорт.
      on(ui.dictAdd, "click", function () {
        dictionaryItems.push({ from: "", to: "" });
        saveStoredAutofix();
        renderDictionary();
      });
      on(ui.dictExport, "click", function () {
        exportDictionaryToFile();
      });
      on(ui.dictImport, "click", function () {
        if (ui.dictImportFile && typeof ui.dictImportFile.click === "function") {
          ui.dictImportFile.click();
        } else {
          setDictMessage("Выберите файл словаря", true);
        }
      });
      on(ui.dictImportFile, "change", function () {
        const files = ui.dictImportFile.files;
        readDictFile(files && files[0]);
      });
    }

    // Начальная отрисовка: восстановить настройки, языки, поля, кнопки.
    applyStoredAutofix();
    fillLanguages();
    syncInputs();
    renderFixRules();
    renderDictionary();
    setDictMessage("");
    bindEvents();
    setObsStatus(obsStatusText);
    showObsHint(obsHintText);
    render();

    const api = {
      start: function () {
        return start();
      },
      stop: function () {
        return stop();
      },
      togglePause: function () {
        return togglePause();
      },
      sendText: function (text, final) {
        return sendText(text, final);
      },
      state: function () {
        return currentState;
      },
      history: function () {
        return historyItems.map(function (entry) {
          return entry.fixed;
        });
      },
      historyDetails: function () {
        return historyItems.map(function (entry) {
          return { raw: entry.raw, fixed: entry.fixed };
        });
      },
      liveText: function () {
        return live;
      },
      status: function () {
        return statusLabel();
      },
      settings: function () {
        return {
          language: settings.language,
          name: settings.name,
          color: settings.color,
          roots: settings.roots,
          url: settings.url,
          port: settings.port,
          password: settings.password,
        };
      },
      dictionary: function () {
        return dictionaryCopy();
      },
      setDictionary: function (list) {
        return setDictionary(list);
      },
      rules: function () {
        return rulesCopy();
      },
      setRules: function (partial) {
        return setRules(partial);
      },
      exportDictionary: function () {
        return exportDictionary();
      },
      importDictionary: function (json) {
        return importDictionary(json);
      },
      fixText: function (text, final) {
        return fixText(text, final);
      },
      get client() {
        return obsClient;
      },
    };
    return api;
  }

  // Один контроллер на страницу: повторный start() не создаёт второй.
  const controllers = typeof WeakMap === "function" ? new WeakMap() : null;
  let singleController = null;

  /**
   * Обёртка для control.html: создать контроллер и НЕ включать микрофон.
   * Микрофон запускается только по кнопке «Начать» (см. js/control.js,
   * createControl().start()), чтобы при открытии страницы ничего не слушало.
   * Повторный вызов возвращает тот же контроллер.
   */
  function startPage(doc, win, options) {
    const key = doc || win || null;
    let control = null;
    if (controllers && key) control = controllers.get(key) || null;
    else control = singleController;
    if (!control) {
      control = createControl(doc, win, options);
      if (controllers && key) controllers.set(key, control);
      else singleController = control;
    }
    return control;
  }

  SS.Control = {
    LANGUAGES: LANGUAGES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    STATE: STATE,
    STATUS: STATUS,
    STORAGE_KEY: STORAGE_KEY,
    AUTOFIX_STORAGE_KEY: AUTOFIX_STORAGE_KEY,
    FIX_RULE_IDS: FIX_RULE_IDS,
    DEFAULT_FIX_RULES: DEFAULT_FIX_RULES,
    MAX_HISTORY: MAX_HISTORY,
    NOTICE_BROWSER: NOTICE_BROWSER,
    NOTICE_NO_MIC: NOTICE_NO_MIC,
    recognitionSupported: recognitionSupported,
    createControl: createControl,
    start: startPage,
  };
})(typeof window !== "undefined" ? window : globalThis);
