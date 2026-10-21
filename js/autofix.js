"use strict";
// Автоправка распознанного текста: заглавные, точки, вопросы, запятые,
// свой словарь замен. Работает бесплатно и без интернета: одни правила.
//
// Это обычный браузерный скрипт без модулей. control.html вызывает
// SS.Autofix.autofix(...) только для готовых фраз (final: true), а
// промежуточный текст не трогает — он меняется несколько раз в секунду.
//
// Правила нарочно простые и осторожные: лучше не поставить запятую,
// чем поставить лишнюю. Каждое правило включается и выключается
// настройкой rules; все правила вместе — это DEFAULT_RULES.
(function (global) {
  "use strict";

  const SS = global.SS || (global.SS = {});

  // Словарь замен по умолчанию: «как распознаётся → как писать».
  // Последняя пара — образец «ничего не менять»: замена на то же слово.
  const DEFAULT_DICTIONARY = [
    { from: "твич", to: "Twitch" },
    { from: "ютуб", to: "YouTube" },
    { from: "дискорд", to: "Discord" },
    { from: "обс", to: "OBS" },
    { from: "стрим", to: "стрим" },
  ];

  const DEFAULT_RULES = {
    dictionary: true,
    capitalize: true,
    punctuation: true,
    commas: true,
    cleanup: true,
  };

  // Вопросительные слова: если фраза с них начинается — ставим «?».
  const RUS_QUESTION_WORDS = [
    "как", "что", "почему", "зачем", "где", "куда", "откуда", "когда",
    "кто", "чей", "какой", "какая", "какое", "какие", "сколько",
    "разве", "неужели",
  ];

  const ENG_QUESTION_WORDS = [
    "what", "why", "how", "where", "when", "who", "which",
    "do", "does", "did", "is", "are", "can", "could", "will", "would",
  ];

  // Подчинительные союзы: запятая перед ними, если впереди уже 2 слова.
  const RUS_SUBORDINATORS = [
    "что", "чтобы", "если", "когда",
    "который", "которая", "которое", "которые", "которого", "которой",
    "которому", "которым", "которых",
    "где", "куда", "хотя",
  ];

  // Составные союзы: запятая ставится перед всем союзом, а не между словами.
  const RUS_SUBORDINATOR_PHRASES = [
    ["потому", "что"],
    ["так", "как"],
  ];

  // Противительные союзы: запятая перед ними, если это не первое слово.
  const RUS_SHORT_CONJUNCTIONS = ["но", "а", "однако", "зато"];

  // Случаи, когда перед «что» запятая НЕ ставится (она уже стоит раньше
  // или это часть оборота): «потому что», «так что», «а что», «ну что»,
  // «вот что», «то, что».
  const RUS_WHAT_EXCEPTIONS = ["потому", "так", "а", "ну", "вот", "то"];

  // Вводные слова: выделяются запятой только в начале фразы.
  const RUS_INTRO_WORDS = [
    "кстати", "короче", "конечно", "наверное", "вообще", "значит",
  ];
  const RUS_INTRO_PHRASES = [["может", "быть"]];

  // Знаки в конце фразы — после них новое предложение начинается с заглавной.
  const END_MARKS_RE = /[.!?…]/;
  const CLOSING_CHARS = "»\"'”’)])}";
  // Слово — буквы/цифры/подчёркивания, внутри может быть дефис:
  // «как-то», «что-то» и «по-русски» — одно слово, а не два.
  const WORD_RE = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
  const LETTER_RE = /[\p{L}]/u;
  const SPACE_RE = /\s/;

  /** Экранировать строку для регулярного выражения. */
  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Это английский язык? Код приходит из настроек страницы. */
  function isEnglish(language) {
    return /^en/i.test(String(language || ""));
  }

  /** Схлопнуть пробелы, убрать пробелы перед знаками препинания и по краям. */
  function cleanupSpaces(text) {
    return String(text)
      .replace(/\s+/g, " ")
      .replace(/\s+([.,!?;:…])/g, "$1")
      .replace(/^\s+|\s+$/g, "");
  }

  /** Привести пары словаря к безопасному виду: только непустые строки. */
  function sanitizeDictionary(dictionary) {
    const source = Array.isArray(dictionary)
      ? dictionary
      : dictionary && Array.isArray(dictionary.pairs)
        ? dictionary.pairs
        : [];
    const result = [];
    for (const pair of source) {
      if (!pair || typeof pair !== "object") continue;
      const from = pair.from === undefined || pair.from === null
        ? ""
        : String(pair.from).trim();
      const to = pair.to === undefined || pair.to === null ? "" : String(pair.to);
      if (!from) continue;
      result.push({ from: from, to: to });
    }
    return result;
  }

  /** Развернуть словарь в JSON для экспорта (красивый и читаемый). */
  function dictionaryToJson(dictionary) {
    return JSON.stringify(sanitizeDictionary(dictionary), null, 2);
  }

  /**
   * Разобрать импортированный JSON словаря.
   * Возвращает {ok, dictionary, error}; ошибка — по-русски.
   */
  function dictionaryFromJson(text) {
    let data;
    try {
      data = JSON.parse(String(text));
    } catch (error) {
      return { ok: false, dictionary: [], error: "Это не JSON-файл словаря" };
    }
    const raw = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray(data.dictionary)
        ? data.dictionary
        : null;
    if (!raw) {
      return { ok: false, dictionary: [], error: "В файле нет списка замен" };
    }
    const dictionary = sanitizeDictionary(raw);
    if (!dictionary.length) {
      return { ok: false, dictionary: [], error: "В файле нет ни одной пары «было — стало»" };
    }
    return { ok: true, dictionary: dictionary, error: "" };
  }

  /**
   * Правило 1: свой словарь замен. Работает без учёта регистра и только
   * по целым словам и фразам: «обс» заменится, «обстановка» — нет.
   */
  function applyDictionary(text, dictionary) {
    const pairs = sanitizeDictionary(dictionary);
    let result = String(text);
    for (const pair of pairs) {
      const words = pair.from.split(/\s+/).filter(Boolean).map(escapeRegExp);
      if (!words.length) continue;
      const pattern = new RegExp(
        "(?<![\\p{L}\\p{N}_])" + words.join("\\s+") + "(?![\\p{L}\\p{N}_])",
        "giu"
      );
      result = result.replace(pattern, function () {
        return pair.to;
      });
    }
    return result;
  }

  /** Правило 2: заглавная буква в начале фразы и после . ! ? … */
  function capitalizeSentences(text) {
    const chars = Array.from(String(text));
    let atStart = true;
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index];
      if (END_MARKS_RE.test(char)) {
        atStart = true;
        continue;
      }
      if (SPACE_RE.test(char)) continue;
      if (atStart && /[«»"'„“”‘’()[\]{}]/.test(char)) {
        // Открывающая кавычка или скобка не мешает заглавной букве.
        continue;
      }
      if (LETTER_RE.test(char)) {
        if (atStart) chars[index] = char.toUpperCase();
        atStart = false;
        continue;
      }
      // Цифра или другой знак в начале фразы: дальше заглавную не ищем,
      // числа не трогаем («2026 год» остаётся как есть).
      atStart = false;
    }
    return chars.join("");
  }

  /** Разобрать текст на слова (буквы, цифры, подчёркивания) с позициями. */
  function wordTokens(text) {
    const source = String(text);
    const tokens = [];
    WORD_RE.lastIndex = 0;
    let match;
    while ((match = WORD_RE.exec(source)) !== null) {
      tokens.push({
        word: match[0],
        lower: match[0].toLowerCase(),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    return tokens;
  }

  /**
   * Начинается ли слово новое предложение (между ним и предыдущим словом
   * стоит точка, восклицательный, вопросительный знак или многоточие).
   * Запятые внутрь нового предложения не переносим.
   */
  function isSentenceStartToken(text, tokens, index) {
    if (index === 0) return true;
    const between = String(text).slice(tokens[index - 1].end, tokens[index].start);
    return END_MARKS_RE.test(between);
  }

  /** Есть ли запятая перед позицией (между предыдущим словом и pos). */
  function hasCommaBefore(text, pos) {
    for (let index = pos - 1; index >= 0; index -= 1) {
      const char = text[index];
      if (char === " " || char === "\t" || char === "\n") continue;
      return char === ",";
    }
    return false;
  }

  /** Есть ли запятая сразу после позиции. */
  function hasCommaAfter(text, pos) {
    for (let index = pos; index < text.length; index += 1) {
      const char = text[index];
      if (char === " " || char === "\t" || char === "\n") continue;
      return char === ",";
    }
    return false;
  }

  /** Аккуратно вставить запятые по позициям, не создавая двойных. */
  function insertCommas(text, positions) {
    let result = String(text);
    const unique = Array.from(new Set(positions)).sort(function (left, right) {
      return right - left;
    });
    for (const position of unique) {
      if (result[position] === ",") continue;
      if (hasCommaBefore(result, position)) continue;
      // Соседняя запятая уже поставлена правым правилом («Короче, но …»):
      // второй такой же быть не должно.
      if (hasCommaAfter(result, position)) continue;
      // После запятой нужен пробел: «думаю, что», а не «думаю,что».
      const next = result[position];
      const comma = next === undefined || SPACE_RE.test(next) ? "," : ", ";
      result = result.slice(0, position) + comma + result.slice(position);
    }
    return result;
  }

  /** Правило 4 для английского: только but и because. */
  function addEnglishCommas(text) {
    const tokens = wordTokens(text);
    const positions = [];
    for (let index = 1; index < tokens.length; index += 1) {
      if (isSentenceStartToken(text, tokens, index)) continue;
      const lower = tokens[index].lower;
      if (lower === "but" || lower === "because") positions.push(tokens[index].start);
    }
    return insertCommas(text, positions);
  }

  /**
   * Правило 4 для русского. Ставим запятую:
   *  - перед подчинительными союзами, если впереди уже 2 слова;
   *  - перед составными союзами («потому что», «так как») целиком;
   *  - перед «но», «а», «однако», «зато», если это не первое слово;
   *  - после вводного слова в начале фразы («Короче, …»).
   */
  function addRussianCommas(text) {
    const tokens = wordTokens(text);
    const positions = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const lower = token.lower;
      const previous = index > 0 ? tokens[index - 1].lower : "";
      // В начале нового предложения запятые не ставим: «Привет! Где был?».
      if (isSentenceStartToken(text, tokens, index)) continue;

      // Составные союзы: «потому что», «так как» — запятая перед первым словом.
      let phraseLength = 0;
      for (const phrase of RUS_SUBORDINATOR_PHRASES) {
        if (lower === phrase[0]) {
          let matches = true;
          for (let offset = 1; offset < phrase.length; offset += 1) {
            const next = tokens[index + offset];
            if (!next || next.lower !== phrase[offset]) matches = false;
          }
          if (matches) {
            phraseLength = phrase.length;
            break;
          }
        }
      }
      if (phraseLength) {
        if (index >= 2) positions.push(token.start);
        continue;
      }

      if (RUS_SUBORDINATORS.indexOf(lower) !== -1) {
        // Исключения: «потому что», «так что», «а что», «ну что»,
        // «вот что», «то, что»; «а если», «но если».
        if (lower === "что" && RUS_WHAT_EXCEPTIONS.indexOf(previous) !== -1) continue;
        if (lower === "если" && (previous === "а" || previous === "но")) continue;
        if (index >= 2) positions.push(token.start);
        continue;
      }

      if (RUS_SHORT_CONJUNCTIONS.indexOf(lower) !== -1 && index >= 1) {
        positions.push(token.start);
      }
    }

    // Вводные слова в начале фразы: «Короче, …», «Может быть, …».
    if (tokens.length > 1) {
      const first = tokens[0].lower;
      if (RUS_INTRO_WORDS.indexOf(first) !== -1) {
        if (!hasCommaAfter(text, tokens[0].end)) positions.push(tokens[0].end);
      } else {
        for (const phrase of RUS_INTRO_PHRASES) {
          let matches = true;
          for (let offset = 0; offset < phrase.length; offset += 1) {
            const token = tokens[offset];
            if (!token || token.lower !== phrase[offset]) matches = false;
          }
          if (matches) {
            const end = tokens[phrase.length - 1].end;
            if (!hasCommaAfter(text, end)) positions.push(end);
            break;
          }
        }
      }
    }

    return insertCommas(text, positions);
  }

  /** Похоже ли русское предложение на вопрос (без знака в конце). */
  function isRussianQuestion(text) {
    const tokens = wordTokens(text);
    if (!tokens.length) return false;
    if (RUS_QUESTION_WORDS.indexOf(tokens[0].lower) !== -1) return true;
    // Частица «ли» после первого слова: «Пойдёшь ли ты».
    for (let index = 1; index < tokens.length; index += 1) {
      if (tokens[index].lower === "ли") return true;
    }
    return false;
  }

  /** Похоже ли английское предложение на вопрос. */
  function isEnglishQuestion(text) {
    const tokens = wordTokens(text);
    if (!tokens.length) return false;
    return ENG_QUESTION_WORDS.indexOf(tokens[0].lower) !== -1;
  }

  /** Правило 3: знак в конце фразы — «?» для вопроса, иначе «.». */
  function addEndMark(text, english) {
    const source = String(text);
    const trimmed = source.replace(/\s+$/, "");
    if (!trimmed) return "";
    // Закрывающие кавычки и скобки не мешают понять, какой знак стоит.
    let end = trimmed.length;
    while (end > 0 && CLOSING_CHARS.indexOf(trimmed[end - 1]) !== -1) end -= 1;
    const body = trimmed.slice(0, end);
    if (!body) return trimmed;
    const closers = trimmed.slice(end);
    const last = Array.from(body).pop();
    if (END_MARKS_RE.test(last)) return trimmed;
    // Висячая запятая/точка с запятой/двоеточие в конце заменяются знаком
    // фразы: «привет,» → «Привет.», а не «Привет,.».
    let core = body;
    if (/[,;:]/.test(last)) {
      core = Array.from(body).slice(0, -1).join("");
      if (!core) return trimmed;
    }
    // Вопрос определяем по последнему предложению: «Привет. Как дела?».
    const sentenceStart = Math.max(
      core.lastIndexOf("."),
      core.lastIndexOf("!"),
      core.lastIndexOf("?"),
      core.lastIndexOf("…")
    ) + 1;
    const lastSentence = core.slice(sentenceStart).trim() || core;
    const question = english
      ? isEnglishQuestion(lastSentence)
      : isRussianQuestion(lastSentence);
    // Знак ставится после закрывающей кавычки: «Он сказал «привет».»
    return core + closers + (question ? "?" : ".");
  }

  /** Правило 4 с выбором языка. */
  function addCommas(text, english) {
    return english ? addEnglishCommas(text) : addRussianCommas(text);
  }

  /**
   * Главная функция: применить включённые правила к готовой фразе.
   *
   * options: { language, dictionary, rules }.
   * - language — "ru-RU", "en-US" и т. п. (влияет на запятые и знак конца);
   * - dictionary — массив пар {from, to}; по умолчанию DEFAULT_DICTIONARY;
   * - rules — какие правила включены, по умолчанию все.
   */
  function autofix(text, options) {
    const source = text === undefined || text === null ? "" : String(text);
    const opts = options && typeof options === "object" ? options : {};
    const rules = Object.assign({}, DEFAULT_RULES, opts.rules || {});
    // Словарь принимаем и массивом пар, и объектом {pairs: [...]} — как удобнее.
    const dictionary = opts.dictionary === undefined || opts.dictionary === null
      ? DEFAULT_DICTIONARY
      : sanitizeDictionary(opts.dictionary);
    const english = isEnglish(opts.language);

    let result = source;
    if (rules.cleanup) result = cleanupSpaces(result);
    if (rules.dictionary) result = applyDictionary(result, dictionary);
    if (rules.capitalize) result = capitalizeSentences(result);
    if (rules.commas) result = addCommas(result, english);
    if (rules.punctuation) result = addEndMark(result, english);
    if (rules.cleanup) result = cleanupSpaces(result);
    return result;
  }

  SS.Autofix = {
    DEFAULT_DICTIONARY: DEFAULT_DICTIONARY,
    DEFAULT_RULES: DEFAULT_RULES,
    RUS_QUESTION_WORDS: RUS_QUESTION_WORDS,
    ENG_QUESTION_WORDS: ENG_QUESTION_WORDS,
    isEnglish: isEnglish,
    cleanupSpaces: cleanupSpaces,
    sanitizeDictionary: sanitizeDictionary,
    dictionaryToJson: dictionaryToJson,
    dictionaryFromJson: dictionaryFromJson,
    applyDictionary: applyDictionary,
    capitalizeSentences: capitalizeSentences,
    addEndMark: addEndMark,
    addCommas: addCommas,
    addRussianCommas: addRussianCommas,
    addEnglishCommas: addEnglishCommas,
    isRussianQuestion: isRussianQuestion,
    isEnglishQuestion: isEnglishQuestion,
    wordTokens: wordTokens,
    autofix: autofix,
  };
})(typeof window !== "undefined" ? window : globalThis);
