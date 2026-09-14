import unittest

from main import SYSTEM_PROMPT


class SystemPromptFormatTests(unittest.TestCase):
    def test_explicit_markdown_table_request_takes_priority(self):
        self.assertIn(
            "ユーザーがMarkdownテーブルを明示的に求めた場合",
            SYSTEM_PROMPT,
        )
        self.assertIn("その指示を優先", SYSTEM_PROMPT)
        self.assertIn("正しいGFM形式の表", SYSTEM_PROMPT)

    def test_broken_text_table_fallback_is_forbidden(self):
        self.assertIn("各データ行を必ず別の行", SYSTEM_PROMPT)
        self.assertIn("区切り文字だけのテキスト表", SYSTEM_PROMPT)
        self.assertIn(
            "Markdownテーブルを表示できない実装上の制約があるとは説明しない",
            SYSTEM_PROMPT,
        )


if __name__ == "__main__":
    unittest.main()
