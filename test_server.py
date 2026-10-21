"""Тесты сервера: порт, страница оверлея, скрипты js/ и старый режим."""

import http.client
import json
import threading
import unittest

import server


class AllowReuseAddressTest(unittest.TestCase):
    """Настройка повторного занятия порта."""

    def test_allow_reuse_address_is_false(self):
        """SubtitleServer явно запрещает повторное занятие того же порта."""
        self.assertFalse(server.SubtitleServer.allow_reuse_address)


class SamePortTest(unittest.TestCase):
    """Второй сервер на занятом порту не стартует."""

    def test_second_server_on_same_port_fails(self):
        """Второй SubtitleServer на том же порту получает OSError."""
        first = None
        second = None
        try:
            first = server.SubtitleServer(("127.0.0.1", 0), {}, server.LineStore(), "")
            port = first.server_address[1]
            with self.assertRaises(OSError):
                second = server.SubtitleServer(("127.0.0.1", port), {}, server.LineStore(), "")
        finally:
            if second is not None:
                second.server_close()
            if first is not None:
                first.server_close()


class RenderOverlayTest(unittest.TestCase):
    """Старый режим Python-сервера: страница получает настройки и скрипты."""

    def test_config_is_injected_instead_of_placeholder(self):
        """render_overlay подставляет config.json вместо __CONFIG_JSON__."""
        page = server.render_overlay(server.DEFAULT_CONFIG)
        self.assertNotIn("__CONFIG_JSON__", page)
        self.assertIn("window.__SASHA_CONFIG__", page)
        self.assertIn("SS.Overlay.parseLocation", page)

    def test_page_connects_scripts_from_js_folder(self):
        """Страница старого режима подключает js/*.js — сервер обязан их отдать."""
        page = server.render_overlay(server.DEFAULT_CONFIG)
        for name in ("js/text.js", "js/obs.js", "js/overlay.js"):
            self.assertIn(name, page)


class HttpTest(unittest.TestCase):
    """Настоящий HTTP на 127.0.0.1: страница, скрипты и старые /lines."""

    def setUp(self):
        self.httpd = server.SubtitleServer(
            ("127.0.0.1", 0),
            dict(server.DEFAULT_CONFIG),
            server.LineStore(),
            server.render_overlay(server.DEFAULT_CONFIG),
        )
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def request(self, path):
        """Запрос к тестовому серверу; возвращает (статус, тип, тело)."""
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, response.getheader("Content-Type"), response.read()
        finally:
            connection.close()

    def test_page_is_served_with_settings(self):
        """Страница оверлея отдаётся с уже подставленными настройками."""
        status, content_type, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", content_type or "")
        text = body.decode("utf-8")
        self.assertIn("window.__SASHA_CONFIG__", text)
        self.assertIn("js/text.js", text)
        self.assertNotIn("__CONFIG_JSON__", text)

    def test_js_files_are_served(self):
        """js/*.js отдаются с правильным типом — иначе OBS покажет пустую страницу."""
        for name in ("text.js", "obs.js", "overlay.js"):
            status, content_type, body = self.request("/js/" + name)
            self.assertEqual(status, 200, name)
            self.assertIn("javascript", content_type or "", name)
            self.assertTrue(body, name)

    def test_text_script_has_real_code(self):
        """Отдаётся именно код, а не заглушка."""
        status, _, body = self.request("/js/text.js")
        self.assertEqual(status, 200)
        self.assertIn("SS.Text", body.decode("utf-8"))

    def test_unknown_js_is_404(self):
        """Несуществующий скрипт — 404, а не падение сервера."""
        status, _, _ = self.request("/js/missing-file.js")
        self.assertEqual(status, 404)

    def test_traversal_outside_js_is_404(self):
        """Через /js/.. нельзя выйти из папки js."""
        status, _, _ = self.request("/js/../server.py")
        self.assertEqual(status, 404)

    def test_lines_first_request_has_no_history(self):
        """Первый запрос /lines только сообщает текущий номер, без старых реплик."""
        status, content_type, body = self.request("/lines")
        self.assertEqual(status, 200)
        self.assertIn("application/json", content_type or "")
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["lines"], [])
        self.assertIn("last", data)
        self.assertIn("paused", data)


if __name__ == "__main__":
    unittest.main()
