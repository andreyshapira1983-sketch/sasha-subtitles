"""Текст субтитров: перенос строк, время показа и маскировка мата."""

import re

EMOTION_PREFIX = "э:"
WORD_RE = re.compile(r"\w+")


def normalize(text):
    """Схлопывает пробелы и обрезает края текста."""
    return " ".join(str(text).split())


def wrap_text(text, columns):
    """Разбивает текст на строки не длиннее columns знаков."""
    columns = max(1, int(columns))
    lines = []
    current = ""
    for word in normalize(text).split():
        # Слово длиннее строки режем по знакам: другого места переноса в нём нет.
        while len(word) > columns:
            if current:
                lines.append(current)
                current = ""
            lines.append(word[:columns])
            word = word[columns:]
        if not word:
            continue
        candidate = word if not current else current + " " + word
        if len(candidate) <= columns:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def paginate(text, columns, max_lines):
    """Делит текст на экраны не больше max_lines строк каждый."""
    lines = wrap_text(text, columns)
    max_lines = max(1, int(max_lines))
    return [lines[start:start + max_lines] for start in range(0, len(lines), max_lines)]


def display_seconds(text, seconds_per_char=0.1, min_seconds=3.0, max_seconds=12.0):
    """Считает время показа текста по числу знаков."""
    seconds = len(str(text).strip()) * float(seconds_per_char)
    return max(float(min_seconds), min(float(max_seconds), seconds))


def is_emotion_command(text):
    """Проверяет, что текст — команда эмоции «э:»."""
    return normalize(text).lower().startswith(EMOTION_PREFIX)


def mask_banned(text, banned_words):
    """Заменяет звёздочками слова с запретным корнем, оставляя знаки препинания.

    Корень — подстрока слова («хуй» найдётся и в «нахуй»). Корень,
    начинающийся с крыши «^», срабатывает только в начале слова:
    «^бля» закроет «бля» и «бляха», но не тронет «рубля» и «оскорблять».
    Такой же фильтр работает на страницах (js/text.js), чтобы Python-путь
    и браузерный путь закрывали мат одинаково.
    """
    if isinstance(banned_words, str):
        banned_words = [banned_words]
    roots = []
    for word in (banned_words or ()):
        root = normalize(word).lower()
        if not root:
            continue
        at_start = root.startswith("^")
        if at_start:
            root = root[1:]
        if root:
            roots.append((root, at_start))
    text = str(text)
    if not roots:
        return text
    parts = []
    for part in re.split(r"(\w+)", text):
        if part and WORD_RE.fullmatch(part):
            low = part.lower()
            hit = any(
                low.startswith(root) if at_start else root in low
                for root, at_start in roots
            )
            if hit:
                part = part[0] + "*" * (len(part) - 1)
        parts.append(part)
    return "".join(parts)


def should_show(text):
    """Решает, показывать ли реплику в субтитрах."""
    if not normalize(text):
        return False
    return not is_emotion_command(text)
