"""Тесты переноса строк, фильтра и времени показа."""

import unittest

import text_tools


class WrapTextTest(unittest.TestCase):
    """Перенос строк."""

    def test_long_word_splits_by_chars(self):
        """Слово длиннее строки режется по знакам."""
        self.assertEqual(text_tools.wrap_text("abcdefghij", 4), ["abcd", "efgh", "ij"])

    def test_line_of_exact_length_is_kept(self):
        """Строка ровно из N знаков не переносится."""
        self.assertEqual(text_tools.wrap_text("a" * 12, 12), ["a" * 12])

    def test_empty_text_gives_no_lines(self):
        """Пустая строка не даёт строк для показа."""
        self.assertEqual(text_tools.wrap_text("   ", 10), [])

    def test_words_are_wrapped_by_spaces(self):
        """Обычные слова переносятся по пробелам."""
        self.assertEqual(text_tools.wrap_text("раз два три", 9), ["раз два", "три"])


class PaginateTest(unittest.TestCase):
    """Деление реплики на экраны."""

    def test_two_lines_per_screen(self):
        """На экран попадает не больше двух строк."""
        pages = text_tools.paginate("один два три четыре пять", 9, 2)
        self.assertEqual(pages[0], ["один два", "три"])
        self.assertTrue(all(len(page) <= 2 for page in pages))

    def test_empty_text_gives_no_pages(self):
        """Из пустой строки экранов не получается."""
        self.assertEqual(text_tools.paginate("", 10, 2), [])


class FilterTest(unittest.TestCase):
    """Показ реплик: мат не прячется, команды «э:» и пустые скрываются."""

    def test_banned_line_is_shown(self):
        """Реплика с матом показывается, мат закрывается звёздочками отдельно."""
        self.assertTrue(text_tools.should_show("Проебали с этим мужчин."))

    def test_clean_line_is_shown(self):
        """Обычная реплика показывается."""
        self.assertTrue(text_tools.should_show("Здравствуйте, добро пожаловать."))

    def test_emotion_command_is_hidden(self):
        """Строки, начинающиеся с «э:», не показываются."""
        self.assertFalse(text_tools.should_show("э: удивление"))
        self.assertFalse(text_tools.should_show("Э: радость"))

    def test_empty_line_is_hidden(self):
        """Пустую реплику показывать нечего."""
        self.assertFalse(text_tools.should_show("   "))


class MaskBannedTest(unittest.TestCase):
    """Маскировка запретных слов звёздочками."""

    def test_whole_word_is_masked(self):
        """Слово целиком закрывается звёздочками, первая буква остаётся."""
        self.assertEqual(text_tools.mask_banned("пиздец", ["пиздец"]), "п*****")

    def test_root_inside_word(self):
        """Слово с запретным корнем внутри тоже маскируется."""
        self.assertEqual(text_tools.mask_banned("нахуй", ["хуй"]), "н****")

    def test_punctuation_is_kept(self):
        """Знаки препинания вокруг слова остаются."""
        self.assertEqual(text_tools.mask_banned("Нахуй!", ["хуй"]), "Н****!")

    def test_first_letter_case_is_kept(self):
        """Заглавная первая буква не теряется."""
        self.assertEqual(text_tools.mask_banned("Пиздец", ["пиздец"]), "П*****")

    def test_clean_text_is_unchanged(self):
        """Чистая реплика не меняется."""
        text = "Здравствуйте, добро пожаловать."
        self.assertEqual(text_tools.mask_banned(text, ["пиздец"]), text)

    def test_several_words_are_masked(self):
        """Маскируются все слова с корнем, регистр не важен."""
        self.assertEqual(
            text_tools.mask_banned("Пиздец, нахуй!", ["пиздец", "хуй"]),
            "П*****, н****!",
        )


class MaskRootsTest(unittest.TestCase):
    """Корни с «^»: только начало слова, как в «Светлячках»."""

    def test_caret_root_matches_word_start(self):
        """Корень с «^» закрывает слова, которые с него начинаются."""
        self.assertEqual(
            text_tools.mask_banned("бляха и бля", ["^бля"]), "б**** и б**")

    def test_caret_root_does_not_match_inside_word(self):
        """Внутри слова корень с «^» не срабатывает."""
        self.assertEqual(
            text_tools.mask_banned("рубля, оскорблять", ["^бля"]),
            "рубля, оскорблять",
        )

    def test_plain_root_still_matches_inside_word(self):
        """Обычный корень без «^» по-прежнему ищется внутри слова."""
        self.assertEqual(text_tools.mask_banned("рубля", ["бля"]), "р****")

    def test_caret_with_empty_root_is_ignored(self):
        """Одна крыша без корня ничего не закрывает."""
        self.assertEqual(
            text_tools.mask_banned("чистый текст", ["^"]), "чистый текст")

    def test_caret_root_is_case_insensitive(self):
        """Регистр корня с «^» не важен."""
        self.assertEqual(text_tools.mask_banned("Бляха", ["^БЛЯ"]), "Б****")


class DurationTest(unittest.TestCase):
    """Время показа реплики."""

    def test_short_line_has_minimum_time(self):
        """Короткая реплика висит не меньше минимума."""
        self.assertAlmostEqual(text_tools.display_seconds("да", 0.06, 2.0, 8.0), 2.0)

    def test_long_line_is_limited_to_max(self):
        """Длинная реплика висит не дольше максимума."""
        self.assertAlmostEqual(text_tools.display_seconds("а" * 300, 0.06, 2.0, 8.0), 8.0)

    def test_middle_line_uses_chars(self):
        """Средняя реплика считается по числу знаков."""
        self.assertAlmostEqual(text_tools.display_seconds("а" * 100, 0.06, 2.0, 8.0), 6.0)


if __name__ == "__main__":
    unittest.main()
