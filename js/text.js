"use strict";
// Текст субтитров: пробелы, перенос строк, страницы, мат и время показа.
//
// Это обычный браузерный скрипт без модулей: его одинаково понимают
// control.html, overlay.html и тесты на Node. Наружу всё отдаётся через
// общее пространство имён window.SS (см. js/obs.js и js/overlay.js).
(function (global) {
  "use strict";

  const SS = global.SS || (global.SS = {});

  // Слово — непрерывная последовательность букв, цифр и подчёркиваний.
  // Проверяем по одной кодовой точке, поэтому эмодзи слово разбивают.
  const WORD_CHAR_RE = /^[\p{L}\p{N}_]$/u;

  // Команда эмоции «э:» в субтитрах не показывается: это не речь.
  const EMOTION_PREFIX = "э:";

  // Настройки показа по умолчанию. Число строк и знаков подобрано под
  // кадр 1920×1080 при шрифте 44 пикселя.
  const DEFAULTS = {
    columns: 34,
    maxLines: 2,
    secondsPerChar: 0.1,
    minSeconds: 3.0,
    maxSeconds: 12.0,
    fontSize: 44,
  };

  // Слово целиком (для проверки границ слов в тексте).
  const FULL_WORD_RE = /^[\p{L}\p{N}_]+$/u;

  /** Привести число из настроек к целому, подставив значение по умолчанию. */
  function _toInt(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.trunc(number);
  }

  /** Привести число из настроек к дробному, подставив значение по умолчанию. */
  function _toNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  /** Кодовые точки строки: JavaScript режет строку по единицам UTF-16. */
  function codePoints(text) {
    return Array.from(text);
  }

  /** Схлопнуть пробелы и обрезать края текста. */
  function normalize(text) {
    if (text === null || text === undefined) return "";
    return String(text).split(/\s+/).filter(Boolean).join(" ");
  }

  /** Свести регистр: для кириллицы и латиницы хватает toLowerCase. */
  function fold(text) {
    return String(text).toLowerCase();
  }

  /** Проверить, что символ — часть слова. */
  function _isWordChar(char) {
    return WORD_CHAR_RE.test(char);
  }

  /**
   * Разбить текст на строки не длиннее columns знаков.
   *
   * Слова переносятся по пробелам; слово длиннее строки режется по знакам,
   * другого места переноса в нём нет. Длина считается в кодовых точках,
   * как в Python-версии (text_tools.wrap_text), поэтому переносы совпадают.
   */
  function wrapText(text, columns) {
    const width = Math.max(1, _toInt(columns, DEFAULTS.columns));
    const lines = [];
    let current = "";
    for (const word of normalize(text).split(" ")) {
      if (!word) continue;
      let rest = word;
      // Слово длиннее строки режем по знакам.
      while (codePoints(rest).length > width) {
        if (current) {
          lines.push(current);
          current = "";
        }
        const chars = codePoints(rest);
        lines.push(chars.slice(0, width).join(""));
        rest = chars.slice(width).join("");
      }
      if (!rest) continue;
      const candidate = current ? current + " " + rest : rest;
      if (codePoints(candidate).length <= width) {
        current = candidate;
      } else {
        lines.push(current);
        current = rest;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  /**
   * Разделить текст на экраны не больше maxLines строк каждый.
   * Возвращает массив экранов, каждый экран — массив строк.
   */
  function paginate(text, columns, maxLines) {
    const lines = wrapText(text, columns);
    const height = Math.max(1, _toInt(maxLines, DEFAULTS.maxLines));
    const pages = [];
    for (let start = 0; start < lines.length; start += height) {
      pages.push(lines.slice(start, start + height));
    }
    return pages;
  }

  /**
   * Сколько секунд держать текст на экране: по длине, но в пределах
   * minSeconds..maxSeconds (по умолчанию 3..12 секунд, 0,1 с на знак).
   */
  function displaySeconds(text, secondsPerChar, minSeconds, maxSeconds) {
    const perChar = _toNumber(secondsPerChar, DEFAULTS.secondsPerChar);
    const minimum = _toNumber(minSeconds, DEFAULTS.minSeconds);
    const maximum = _toNumber(maxSeconds, DEFAULTS.maxSeconds);
    const length = codePoints(normalize(text)).length;
    const seconds = length * perChar;
    // min раньше max: если в настройках их перепутали, минимум всё равно
    // держится, а не превращается в отрицательное время.
    return Math.max(minimum, Math.min(maximum, seconds));
  }

  /** Привести корни мата к нижнему регистру и разобрать крышу «^». */
  function _prepareRoots(roots) {
    if (roots === null || roots === undefined) return [];
    const list = typeof roots === "string" ? [roots] : roots;
    if (!Array.isArray(list)) return [];
    const prepared = [];
    for (const root of list) {
      if (typeof root !== "string") continue;
      let folded = fold(root.trim());
      if (!folded) continue;
      const atStart = folded.startsWith("^");
      if (atStart) folded = folded.slice(1);
      if (!folded) continue;
      prepared.push({ root: folded, atStart: atStart });
    }
    return prepared;
  }

  /** Привести слова-исключения к нижнему регистру: сравнение целых слов. */
  function _prepareExceptions(exceptions) {
    const ignored = new Set();
    if (exceptions === null || exceptions === undefined) return ignored;
    const list = typeof exceptions === "string" ? [exceptions] : exceptions;
    if (!Array.isArray(list)) return ignored;
    for (const word of list) {
      if (typeof word !== "string") continue;
      const folded = fold(word.trim());
      if (folded) ignored.add(folded);
    }
    return ignored;
  }

  /**
   * Закрыть звёздочками слова с запретным корнем.
   *
   * Корень — подстрока слова («хуй» найдётся и в «нахуй»). Корень,
   * начинающийся с крыши «^», ищется только в начале слова: «^бля»
   * закроет «бля» и «бляха», но не тронет «рубля». У найденного слова
   * остаётся первый знак, остальные заменяются звёздочками; знаки
   * препинания вокруг слова сохраняются. Регистр не важен.
   */
  function maskRoots(text, roots, exceptions) {
    const source = text === null || text === undefined ? "" : String(text);
    const prepared = _prepareRoots(roots);
    const ignored = _prepareExceptions(exceptions);
    if (prepared.length === 0 || source === "") return source;

    const chars = codePoints(source);
    const parts = [];
    let index = 0;
    while (index < chars.length) {
      if (!_isWordChar(chars[index])) {
        parts.push(chars[index]);
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < chars.length && _isWordChar(chars[end])) end += 1;
      const wordChars = chars.slice(index, end);
      const word = wordChars.join("");
      const folded = fold(word);
      let masked = false;
      if (!ignored.has(folded)) {
        for (const item of prepared) {
          const hit = item.atStart
            ? folded.startsWith(item.root)
            : folded.includes(item.root);
          if (hit) {
            masked = true;
            break;
          }
        }
      }
      if (masked) {
        parts.push(wordChars[0] + "*".repeat(wordChars.length - 1));
      } else {
        parts.push(word);
      }
      index = end;
    }
    return parts.join("");
  }

  /** Проверить, что текст — команда эмоции «э:». */
  function isEmotionCommand(text) {
    return fold(normalize(text)).startsWith(EMOTION_PREFIX);
  }

  /**
   * Решает, показывать ли реплику: пустые и команды «э:» не показываем,
   * всё остальное, включая реплики с матом, показываем (мат закроется).
   */
  function shouldShow(text) {
    if (!normalize(text)) return false;
    return !isEmotionCommand(text);
  }

  /** Собрать текст экрана из строк: строки склеиваются переводом строки. */
  function joinLines(lines) {
    return (lines || []).join("\n");
  }

  /**
   * Готовая реплика → экраны для показа.
   *
   * Каждый экран: {text, lines, seconds}. Текст уже с маскировкой мата;
   * пустой текст и команды «э:» дают пустой список. Так одинаково считают
   * и overlay.html, и Python-режим (см. test_text_tools.py).
   */
  function pagesFor(text, roots, settings) {
    const options = settings || {};
    const columns = _toInt(options.columns, DEFAULTS.columns);
    const maxLines = _toInt(options.maxLines, DEFAULTS.maxLines);
    const clean = maskRoots(normalize(text), roots);
    if (!shouldShow(clean)) return [];
    return paginate(clean, columns, maxLines).map(function (lines) {
      const pageText = joinLines(lines);
      return {
        text: pageText,
        lines: lines.slice(),
        seconds: displaySeconds(
          pageText,
          options.secondsPerChar,
          options.minSeconds,
          options.maxSeconds
        ),
      };
    });
  }

  /** Проверить, что строка — слово целиком (для тестов и проверок). */
  function isWord(text) {
    return FULL_WORD_RE.test(String(text));
  }

  SS.Text = {
    DEFAULTS: DEFAULTS,
    codePoints: codePoints,
    normalize: normalize,
    fold: fold,
    wrapText: wrapText,
    paginate: paginate,
    displaySeconds: displaySeconds,
    maskRoots: maskRoots,
    isEmotionCommand: isEmotionCommand,
    shouldShow: shouldShow,
    joinLines: joinLines,
    pagesFor: pagesFor,
    isWord: isWord,
  };
})(typeof window !== "undefined" ? window : globalThis);
