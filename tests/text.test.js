"use strict";
// Тесты текста субтитров: переносы, экраны, мат, время показа.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./helpers");

const SS = loadScripts(["js/text.js"]);
const Text = SS.Text;

test("text.js: normalize схлопывает пробелы и обрезает края", () => {
  assert.equal(Text.normalize("  привет \n  мир  "), "привет мир");
  assert.equal(Text.normalize(""), "");
  assert.equal(Text.normalize(null), "");
  assert.equal(Text.normalize(undefined), "");
});

test("text.js: wrapText переносит слова по пробелам", () => {
  assert.deepEqual(Text.wrapText("раз два три", 9), ["раз два", "три"]);
});

test("text.js: слово длиннее строки режется по знакам", () => {
  assert.deepEqual(Text.wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("text.js: строка ровно из N знаков не переносится", () => {
  assert.deepEqual(Text.wrapText("a".repeat(12), 12), ["a".repeat(12)]);
});

test("text.js: пустой текст не даёт строк", () => {
  assert.deepEqual(Text.wrapText("   ", 10), []);
});

test("text.js: длина считается в кодовых точках, эмодзи не ломаются", () => {
  assert.deepEqual(Text.wrapText("🙂🙂🙂", 2), ["🙂🙂", "🙂"]);
});

test("text.js: paginate даёт не больше двух строк на экран", () => {
  const pages = Text.paginate("один два три четыре пять", 9, 2);
  assert.deepEqual(pages[0], ["один два", "три"]);
  assert.ok(pages.every((page) => page.length <= 2));
  assert.ok(pages.length >= 2);
});

test("text.js: paginate пустого текста — пустой список", () => {
  assert.deepEqual(Text.paginate("", 10, 2), []);
});

test("text.js: paginate с нулём строк считает как одну", () => {
  assert.deepEqual(Text.paginate("а б в", 1, 0), [["а"], ["б"], ["в"]]);
});

test("text.js: время показа короткой реплики — не меньше минимума", () => {
  assert.equal(Text.displaySeconds("да", 0.06, 2.0, 8.0), 2.0);
});

test("text.js: время показа длинной реплики — не больше максимума", () => {
  assert.equal(Text.displaySeconds("а".repeat(300), 0.06, 2.0, 8.0), 8.0);
});

test("text.js: время показа средней реплики считается по знакам", () => {
  assert.equal(Text.displaySeconds("а".repeat(100), 0.06, 2.0, 8.0), 6.0);
});

test("text.js: мусор в настройках времени заменяется значениями по умолчанию", () => {
  assert.equal(Text.displaySeconds("а".repeat(100), "мусор", NaN, undefined), 10.0);
});

test("text.js: мат закрывается звёздочками, первый знак остаётся", () => {
  assert.equal(Text.maskRoots("пиздец", ["пиздец"]), "п*****");
  assert.equal(Text.maskRoots("нахуй", ["хуй"]), "н****");
});

test("text.js: знаки препинания вокруг мата сохраняются", () => {
  assert.equal(Text.maskRoots("Нахуй!", ["хуй"]), "Н****!");
  assert.equal(Text.maskRoots("«Пиздец», — сказал он.", ["пиздец"]), "«П*****», — сказал он.");
});

test("text.js: регистр не важен", () => {
  assert.equal(Text.maskRoots("Пиздец", ["пиздец"]), "П*****");
  assert.equal(Text.maskRoots("ПИЗДЕЦ", ["ПИЗДЕЦ"]), "П*****");
});

test("text.js: корень с «^» закрывает только начало слова", () => {
  assert.equal(Text.maskRoots("бляха и бля", ["^бля"]), "б**** и б**");
  // «рубля» и «оскорблять» начинаются не с корня — их не трогаем.
  assert.equal(Text.maskRoots("рубля, оскорблять", ["^бля"]), "рубля, оскорблять");
});

test("text.js: корень без «^» находится внутри слова", () => {
  assert.equal(Text.maskRoots("рубля", ["бля"]), "р****");
});

test("text.js: слова-исключения не закрываются", () => {
  assert.equal(Text.maskRoots("рубля и бляха", ["бля"], ["рубля"]), "рубля и б****");
});

test("text.js: пустые корни и мусор игнорируются", () => {
  assert.equal(Text.maskRoots("чистый текст", [], ["", "^"]), "чистый текст");
  assert.equal(Text.maskRoots("чистый текст", null), "чистый текст");
});

test("text.js: маскировка не ломает эмодзи вокруг слова", () => {
  // «хуй2» — одно слово (цифра тоже знак слова), поэтому закрывается целиком.
  assert.equal(Text.maskRoots("🙂 хуй2 🙂", ["хуй"]), "🙂 х*** 🙂");
});

test("text.js: shouldShow скрывает пустое и команды «э:»", () => {
  assert.equal(Text.shouldShow("Здравствуйте, добро пожаловать."), true);
  assert.equal(Text.shouldShow("Проебали с этим мужчин."), true);
  assert.equal(Text.shouldShow("   "), false);
  assert.equal(Text.shouldShow("э: удивление"), false);
  assert.equal(Text.shouldShow("Э:радость"), false);
});

test("text.js: pagesFor режет длинную фразу на экраны и закрывает мат", () => {
  const pages = Text.pagesFor(
    "Это длинная придуманная реплика, чтобы проверить перенос строк и показ по частям: сначала первая пара строк, потом вторая.",
    ["пиздец"],
    { columns: 20, maxLines: 2 }
  );
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    assert.ok(page.lines.length <= 2);
    // «…» на продолжаемом экране может дать один лишний знак.
    assert.ok(page.lines.every((line) => Text.codePoints(line).length <= 21));
    assert.equal(page.text, page.lines.join("\n"));
    assert.ok(page.seconds >= 3 && page.seconds <= 12);
  }
});

test("text.js: оборванный экран кончается «…», последний — нет", () => {
  const pages = Text.pagesFor("раз два три четыре пять шесть семь восемь", [], {
    columns: 10,
    maxLines: 1,
  });
  assert.ok(pages.length >= 3);
  for (const page of pages.slice(0, -1)) assert.ok(page.text.endsWith("…"), page.text);
  assert.ok(!pages[pages.length - 1].text.endsWith("…"));
});

test("text.js: запятая перед обрывом меняется на «…», точка остаётся", () => {
  const comma = Text.pagesFor("привет всем, ребята", [], { columns: 12, maxLines: 1 });
  assert.equal(comma[0].text, "привет всем…");
  const dot = Text.pagesFor("всем привет. как дела", [], { columns: 12, maxLines: 1 });
  assert.equal(dot[0].text, "всем привет.");
});

test("text.js: pagesFor закрывает мат и считает время по длине", () => {
  const pages = Text.pagesFor("ну и пиздец", ["пиздец"], { columns: 34, maxLines: 2 });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].text, "ну и п*****");
  assert.equal(pages[0].seconds, 3);
});

test("text.js: pagesFor пустой реплики и «э:» — пустой список", () => {
  assert.deepEqual(Text.pagesFor("", [], {}), []);
  assert.deepEqual(Text.pagesFor("э: радость", [], {}), []);
});

test("text.js: настройки по умолчанию — 34 знака и 2 строки", () => {
  assert.equal(Text.DEFAULTS.columns, 34);
  assert.equal(Text.DEFAULTS.maxLines, 2);
  assert.equal(Text.DEFAULTS.secondsPerChar, 0.1);
});
