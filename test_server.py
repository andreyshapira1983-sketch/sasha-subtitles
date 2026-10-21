"""Тесты сервера: занятый порт не переиспользуется."""

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


if __name__ == "__main__":
    unittest.main()
