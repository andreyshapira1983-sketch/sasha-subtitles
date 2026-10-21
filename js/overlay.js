"use strict";
// Оверлей субтитров: общая часть страницы overlay.html и тестов на Node.
//
// Страница бывает в трёх состояниях:
//   ws   — адрес вида overlay.html#ws://127.0.0.1:4455|пароль: подключаемся
//          к встроенному в OBS WebSocket и слушаем CustomEvent;
//   poll — настройки пришли от server.py (__SASHA_CONFIG__):
//          опрашиваем /lines?after=N, как старый оверлей;
//   hint — ничего не настроено: показываем подсказку по-русски с примером.
//
// Обычный браузерный скрипт без модулей. К document и window напрямую не
// обращаемся: всё приходит из doc / win / options, поэтому поддельные DOM и
// часы в тестах работают без браузера.
(function (global) {
  "use strict";

  const SS = global.SS || (global.SS = {});

  // Длительности показов. Те же числа стоят в CSS overlay.html.
  const TIMING = Object.freeze({
    fadeMs: 350,
    gapMs: 120,
    pollMs: 500,
    maxQueue: 12,
  });

  const DEFAULTS = Object.freeze({
    columns: 34,
    maxLines: 2,
    secondsPerChar: 0.1,
    minSeconds: 3.0,
    maxSeconds: 12.0,
    fontSize: 44,
  });

  // Запасные корни мата: нужны в режиме OBS WebSocket, где config.json
  // недоступен и мат закрывает сам оверлей.
  const DEFAULT_ROOTS = Object.freeze(["блять", "хуй", "пизд", "ебал"]);

  const DEFAULT_NAME = "Ведущий";
  const DEFAULT_COLOR = "#8fd8ff";

  // Подсказка человеку, если страница открыта без настроек и без адреса.
  const HINT_TEXT =
    "Оверлей не настроен. Добавьте в OBS источник «Браузер» и укажите адрес " +
    "overlay.html#ws://127.0.0.1:4455|пароль — пароль задаётся в OBS: " +
    "Сервис → Настройки WebSocket-сервера. Для старого режима запустите " +
    "server.py и откройте адрес, который он напечатает.";

  /** Число из настроек: мусор заменяем запасным значением. */
  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  /** Строка из настроек: null и undefined дают запасное значение. */
  function textOr(value, fallback) {
    const empty = fallback === undefined ? "" : fallback;
    if (value === undefined || value === null) return empty;
    const text = String(value);
    return text || empty;
  }

  /**
   * Разобрать адрес страницы.
   *
   * location — объект вроде location страницы (hash, search, href).
   * config — __SASHA_CONFIG__ из server.py (может не быть).
   *
   * Возвращает {mode, wsUrl, password, config}:
   *   ws   — в хвосте адреса OBS WebSocket (пароль только там, не в запросах);
   *   poll — есть настройки от Python-сервера;
   *   hint — ничего нет, страницу надо настроить.
   */
  function parseLocation(location, config) {
    const loc = location && typeof location === "object" ? location : {};
    let settings = config;
    if (settings === undefined || settings === null) {
      settings = loc.config !== undefined && loc.config !== null ? loc.config : null;
    }
    if (settings !== null && typeof settings !== "object") settings = null;

    let hash = loc.hash;
    if (hash === undefined || hash === null) {
      // На случай, если передан только href целиком.
      const href = textOr(loc.href, "");
      const index = href.indexOf("#");
      hash = index >= 0 ? href.slice(index) : "";
    }

    const fromHash = hash && SS.Obs && typeof SS.Obs.parseWebSocketHash === "function"
      ? SS.Obs.parseWebSocketHash(hash)
      : null;
    if (fromHash) {
      return {
        mode: "ws",
        wsUrl: fromHash.url,
        password: fromHash.password,
        config: settings,
      };
    }
    if (settings) {
      return { mode: "poll", wsUrl: null, password: "", config: settings };
    }
    return { mode: "hint", wsUrl: null, password: "", config: null };
  }

  /**
   * Создать оверлей страницы.
   *
   * doc — документ (в браузере document), win — окно (в браузере window).
   * options: mode, wsUrl, password, config, roots, columns, maxLines,
   *          secondsPerChar, minSeconds, maxSeconds, fontSize,
   *          setTimeout, clearTimeout (по умолчанию win.setTimeout/clearTimeout),
   *          fetch (по умолчанию win.fetch), createClient (для тестов),
   *          createSocket, crypto, pollMs, onState, onError.
   */
  function createOverlay(doc, win, options) {
    const settings = options && typeof options === "object" ? options : {};
    let documentRef = doc && typeof doc === "object" ? doc : null;
    let windowRef = win && typeof win === "object" ? win : null;

    const config =
      settings.config && typeof settings.config === "object" ? settings.config : {};
    const mode = settings.mode === "ws" || settings.mode === "poll" ? settings.mode : "hint";
    const speakers =
      config.speakers && typeof config.speakers === "object" ? config.speakers : {};

    const pageSettings = {
      columns: numberOr(settings.columns, numberOr(config.columns, DEFAULTS.columns)),
      maxLines: numberOr(settings.maxLines, numberOr(config.max_lines, DEFAULTS.maxLines)),
      secondsPerChar: numberOr(
        settings.secondsPerChar,
        numberOr(config.seconds_per_char, DEFAULTS.secondsPerChar)
      ),
      minSeconds: numberOr(settings.minSeconds, numberOr(config.min_seconds, DEFAULTS.minSeconds)),
      maxSeconds: numberOr(
        settings.maxSeconds,
        numberOr(config.max_seconds, DEFAULTS.maxSeconds)
      ),
    };

    const roots =
      settings.roots !== undefined
        ? settings.roots
        : Array.isArray(config.banned_words)
          ? config.banned_words
          : DEFAULT_ROOTS;

    const pollMs = Math.max(1, numberOr(settings.pollMs, TIMING.pollMs));

    // Очередь экранов и то, что сейчас на экране.
    const queue = [];
    let currentPage = null;
    let started = false;
    let polling = false;
    let after = null;
    let client = null;
    let holdTimer = null;
    let fadeTimer = null;
    let gapTimer = null;
    let pollTimer = null;

    /** Найти элемент страницы по id (или null, если его нет). */
    function element(id) {
      if (!documentRef || typeof documentRef.getElementById !== "function") return null;
      return documentRef.getElementById(id);
    }

    /** setTimer плавно берёт таймеры из options, потом из win, потом из общего. */
    function setTimer(callback, ms) {
      if (typeof settings.setTimeout === "function") return settings.setTimeout(callback, ms);
      if (windowRef && typeof windowRef.setTimeout === "function") {
        return windowRef.setTimeout(callback, ms);
      }
      return global.setTimeout(callback, ms);
    }

    /** Остановить таймер так же, как его заводили. */
    function clearTimer(id) {
      if (typeof settings.clearTimeout === "function") {
        settings.clearTimeout(id);
        return;
      }
      if (windowRef && typeof windowRef.clearTimeout === "function") {
        windowRef.clearTimeout(id);
        return;
      }
      global.clearTimeout(id);
    }

    /** Применить размер шрифта из настроек к странице. */
    function applyFontSize() {
      const root = documentRef && documentRef.documentElement;
      if (!root || !root.style || typeof root.style.setProperty !== "function") return;
      const size = numberOr(settings.fontSize, numberOr(config.font_size, DEFAULTS.fontSize));
      root.style.setProperty("--font-size", String(size) + "px");
    }

    /** Имя и цвет говорящего: сначала из реплики, потом из настроек. */
    function speakerStyle(payload) {
      const key = textOr(payload.speaker, "");
      const preset = key && speakers[key] && typeof speakers[key] === "object"
        ? speakers[key]
        : {};
      const name = textOr(payload.name, "") || textOr(preset.name, "") || key || DEFAULT_NAME;
      const color = textOr(payload.color, "") || textOr(preset.color, "") || DEFAULT_COLOR;
      return { name: name, color: color };
    }

    /** Убрать класс показа (начать затухание). */
    function hideStage() {
      const stage = element("stage");
      if (stage) stage.classList.remove("show");
    }

    /** Полностью убрать сцену с экрана. */
    function clearStage() {
      const stage = element("stage");
      if (stage) {
        stage.classList.remove("show");
        stage.classList.remove("interim");
      }
      const speakerEl = element("speaker");
      if (speakerEl) speakerEl.textContent = "";
      const lineEl = element("line");
      if (lineEl) lineEl.textContent = "";
    }

    /** Снять все таймеры показа. */
    function clearShowTimers() {
      if (holdTimer !== null) {
        clearTimer(holdTimer);
        holdTimer = null;
      }
      if (fadeTimer !== null) {
        clearTimer(fadeTimer);
        fadeTimer = null;
      }
      if (gapTimer !== null) {
        clearTimer(gapTimer);
        gapTimer = null;
      }
    }

    /** Показать один экран и запланировать его исчезновение. */
    function showPage(page) {
      const stage = element("stage");
      if (stage) {
        stage.classList.remove("show");
        if (page.final === false) stage.classList.add("interim");
        else stage.classList.remove("interim");
      }
      const speakerEl = element("speaker");
      if (speakerEl) {
        speakerEl.textContent = page.name || "";
        speakerEl.style.color = page.color || DEFAULT_COLOR;
      }
      const lineEl = element("line");
      if (lineEl) lineEl.textContent = page.text || "";

      currentPage = page;
      if (stage) stage.classList.add("show");

      const holdMs = Math.max(0, Math.round(numberOr(page.seconds, DEFAULTS.minSeconds) * 1000));
      holdTimer = setTimer(handleHoldEnd, holdMs);
    }

    /** Время показа вышло: плавно гасим экран. */
    function handleHoldEnd() {
      holdTimer = null;
      hideStage();
      fadeTimer = setTimer(handleFadeEnd, TIMING.fadeMs);
    }

    /** Экран погас: освобождаем место для следующего. */
    function handleFadeEnd() {
      fadeTimer = null;
      currentPage = null;
      const stage = element("stage");
      if (stage) stage.classList.remove("interim");
      // Небольшая пауза между репликами, чтобы они не сливались.
      gapTimer = setTimer(handleGapEnd, TIMING.gapMs);
    }

    /** Пауза прошла: показываем следующий экран из очереди. */
    function handleGapEnd() {
      gapTimer = null;
      showNext();
    }

    /** Показать следующий экран, если сцена свободна. */
    function showNext() {
      if (currentPage !== null) return;
      if (queue.length === 0) return;
      showPage(queue.shift());
    }

    /** Оборвать текущий показ (для промежуточного текста и новых фраз). */
    function interrupt() {
      clearShowTimers();
      queue.length = 0;
      currentPage = null;
      const stage = element("stage");
      if (stage) {
        stage.classList.remove("show");
        stage.classList.remove("interim");
      }
    }

    /**
     * Принять реплику: {app, speaker, name, color, text, final}.
     *
     * Готовая фраза режется на экраны и встаёт в очередь. Промежуточный
     * текст (final:false) в очереди не копится и показывается, только пока
     * на экране и в очереди нет готовых фраз.
     * Чужие события, пустой текст и команды «э:» игнорируются.
     */
    function push(payload) {
      if (!payload || typeof payload !== "object") return 0;
      if (
        payload.app !== undefined &&
        payload.app !== null &&
        SS.Obs &&
        payload.app !== SS.Obs.APP
      ) {
        return 0;
      }
      const final = payload.final !== false;
      const style = speakerStyle(payload);
      const pages = SS.Text.pagesFor(textOr(payload.text, ""), roots, pageSettings);
      if (pages.length === 0) return 0;

      const prepared = [];
      for (const page of pages) {
        prepared.push({
          name: style.name,
          color: style.color,
          text: page.text,
          lines: page.lines.slice(),
          seconds: page.seconds,
          final: final,
        });
      }

      if (!final) {
        // Готовую фразу живой текст не перебивает: иначе её не успеть прочитать.
        if ((currentPage !== null && currentPage.final !== false) || queue.length > 0) return 0;
        // Поверх другого живого текста — сразу заменяем то, что на экране.
        interrupt();
        showPage(prepared[0]);
        return 1;
      }

      // Готовая фраза вытесняет застывший промежуточный текст.
      if (currentPage !== null && currentPage.final === false) interrupt();
      for (const page of prepared) queue.push(page);
      while (queue.length > TIMING.maxQueue) queue.shift();
      showNext();
      return prepared.length;
    }

    /** Очистить экран и очередь. */
    function clearDisplay() {
      clearShowTimers();
      queue.length = 0;
      currentPage = null;
      clearStage();
    }

    /** Спрятать подсказку, когда режим уже настроен. */
    function hideHint() {
      const hint = element("hint");
      if (hint) hint.hidden = true;
    }

    /** Показать подсказку по-русски с примером адреса. */
    function showHint() {
      clearDisplay();
      const hint = element("hint");
      if (!hint) return;
      hint.hidden = false;
      hint.textContent = HINT_TEXT;
    }

    /** Один запрос к Python-серверу за новыми репликами. */
    function pollUrl() {
      return after === null ? "/lines" : "/lines?after=" + after;
    }

    /** Взять fetch: сначала options.fetch, потом win.fetch. */
    function request(url, init) {
      if (typeof settings.fetch === "function") return settings.fetch(url, init);
      if (windowRef && typeof windowRef.fetch === "function") {
        return windowRef.fetch(url, init);
      }
      if (typeof global.fetch === "function") return global.fetch(url, init);
      return null;
    }

    /** Разложить ответ /lines по экранам. */
    function handleLines(data) {
      if (!data || typeof data !== "object") return;
      const paused = Boolean(data.paused);
      const last = typeof data.last === "number" ? data.last : null;

      // Сервер перезапустили: его нумерация началась заново.
      if (after !== null && last !== null && last < after) {
        clearDisplay();
        after = 0;
      }
      if (paused) {
        clearDisplay();
        if (last !== null) after = last;
        return;
      }
      const lines = Array.isArray(data.lines) ? data.lines : [];
      if (lines.length > 0) {
        for (const line of lines) push(line);
        const lastLine = lines[lines.length - 1];
        if (lastLine && typeof lastLine.n === "number") after = lastLine.n;
        else if (last !== null) after = last;
        return;
      }
      // Первый запрос без after: запоминаем текущий номер, чтобы не
      // показывать старое при следующем опросе.
      if (after === null && last !== null) after = last;
    }

    /** Запланировать следующий опрос. */
    function schedulePoll() {
      if (!polling) return;
      pollTimer = setTimer(pollOnce, pollMs);
    }

    /** Сходить за новыми репликами и запланировать следующий опрос. */
    function pollOnce() {
      pollTimer = null;
      if (!polling) return;
      let response;
      try {
        response = request(pollUrl(), { cache: "no-store" });
      } catch (error) {
        schedulePoll();
        return;
      }
      if (!response) {
        schedulePoll();
        return;
      }
      Promise.resolve(response)
        .then(function (raw) {
          return raw && typeof raw.json === "function" ? raw.json() : null;
        })
        .then(function (data) {
          try {
            handleLines(data);
          } catch (error) {
            // Кривой ответ не должен останавливать субтитры.
          }
          schedulePoll();
        })
        .catch(function () {
          // Сервер перезапускается или не ответил — попробуем ещё раз.
          schedulePoll();
        });
    }

    /** Подключиться к OBS WebSocket и слушать CustomEvent. */
    function startWebSocket() {
      const factory =
        typeof settings.createClient === "function"
          ? settings.createClient
          : SS.Obs && typeof SS.Obs.createClient === "function"
            ? SS.Obs.createClient
            : null;
      if (typeof factory !== "function") {
        showHint();
        return;
      }
      const clientOptions = {
        url: textOr(settings.wsUrl, "") || textOr(config.ws_url, "") || SS.Obs.DEFAULT_URL,
        password: settings.password === undefined || settings.password === null
          ? ""
          : String(settings.password),
        setTimeout: setTimer,
        clearTimeout: clearTimer,
        onCustomEvent: push,
        onState: function (state) {
          if (typeof settings.onState === "function") settings.onState(state);
        },
        onError: function (message) {
          if (typeof settings.onError === "function") settings.onError(message);
        },
      };
      if (settings.crypto !== undefined) clientOptions.crypto = settings.crypto;
      else if (windowRef && windowRef.crypto) clientOptions.crypto = windowRef.crypto;
      if (typeof settings.createSocket === "function") {
        clientOptions.createSocket = settings.createSocket;
      }
      if (typeof settings.reconnectDelay === "number") {
        clientOptions.reconnectDelay = settings.reconnectDelay;
      }
      if (typeof settings.maxReconnectDelay === "number") {
        clientOptions.maxReconnectDelay = settings.maxReconnectDelay;
      }
      client = factory(clientOptions);
      if (client && typeof client.connect === "function") client.connect();
    }

    /** Начать получать текст: WebSocket, опрос сервера или подсказка. */
    function start(docArg, winArg) {
      if (docArg && typeof docArg === "object") documentRef = docArg;
      if (winArg && typeof winArg === "object") windowRef = winArg;
      applyFontSize();
      if (started) return;
      started = true;
      if (mode === "hint") {
        showHint();
        return;
      }
      hideHint();
      if (mode === "ws") {
        startWebSocket();
        return;
      }
      polling = true;
      pollOnce();
    }

    /** Перестать получать текст и снять таймеры (экран не трогаем). */
    function stop() {
      started = false;
      clearShowTimers();
      polling = false;
      if (pollTimer !== null) {
        clearTimer(pollTimer);
        pollTimer = null;
      }
      if (client && typeof client.close === "function") client.close();
      client = null;
    }

    /** Полный сброс: пустой экран, пустая очередь, опрос с начала. */
    function reset() {
      clearDisplay();
      after = null;
    }

    /** Текущий экран или null. */
    function current() {
      if (!currentPage) return null;
      return {
        name: currentPage.name,
        color: currentPage.color,
        text: currentPage.text,
        lines: currentPage.lines.slice(),
        seconds: currentPage.seconds,
        final: currentPage.final,
      };
    }

    applyFontSize();

    return {
      mode: mode,
      push: push,
      start: start,
      stop: stop,
      reset: reset,
      current: current,
      queueLength: function () {
        return queue.length;
      },
    };
  }

  SS.Overlay = {
    HINT_TEXT: HINT_TEXT,
    TIMING: TIMING,
    DEFAULTS: DEFAULTS,
    DEFAULT_ROOTS: DEFAULT_ROOTS,
    DEFAULT_NAME: DEFAULT_NAME,
    DEFAULT_COLOR: DEFAULT_COLOR,
    parseLocation: parseLocation,
    createOverlay: createOverlay,
  };
})(typeof window !== "undefined" ? window : globalThis);
