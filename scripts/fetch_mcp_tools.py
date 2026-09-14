"""リモートMCPサーバーからツール定義を取得し、Gateway用の静的スキーマJSONを生成する。

使い方:
  GitHub: GITHUB_TOKEN=<token> uv run python scripts/fetch_mcp_tools.py github
  Slack:  SLACK_TOKEN=<xoxp-token> uv run python scripts/fetch_mcp_tools.py slack
  全ツール確認（選定前の一覧出力のみ）: ... fetch_mcp_tools.py slack --list

別のサーバーのスキーマを生成するときは SERVERS にエントリを追加する。
description には取得時のユーザー固有情報や未採用ツールへの言及が含まれることが
あるため、出力前に sanitize_description() で除去し、残存は警告で知らせる。
"""
import asyncio
import json
import os
import re
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

SERVERS = {
    "github": {
        "endpoint": "https://api.githubcopilot.com/mcp/",
        "token_env": "GITHUB_TOKEN",
        "output": "amplify/github-mcp-tools.json",
        "pick": ["get_me", "search_repositories", "list_commits",
                 "list_pull_requests", "search_code", "search_issues"],
    },
    "slack": {
        "endpoint": "https://mcp.slack.com/mcp",
        "token_env": "SLACK_TOKEN",
        "output": "amplify/slack-mcp-tools.json",
        # 公開サンプルは読み取り専用方針。送信系（slack_send_message）はpickしない
        "pick": ["slack_search_channels", "slack_search_public",
                 "slack_read_channel", "slack_read_thread"],
    },
}

ALLOWED = {"type", "properties", "required", "items", "description"}

# 取得時のユーザー固有情報を含む文。description から除去する
USER_SPECIFIC_PATTERNS = [
    re.compile(
        r"If the user wants to send a message to themselves, the\s+"
        r"current logged in user's user_id is [A-Z0-9]+\.[ \t]*"
    ),
    re.compile(r"[Cc]urrent logged in user's user_id is [A-Z0-9]+\.[ \t]*"),
    re.compile(r"[✅❌]\s*Semantic search is (?:not )?available for this user\.[ \t]*"),
    re.compile(r"[Ss]emantic search is (?:not )?available for this user\.[ \t]*"),
]

# サニタイズ後も残っていた場合に警告するIDらしきトークン（SlackのU/T/C等9文字以上）
ID_LIKE = re.compile(r"\b[UTWCGD][A-Z0-9]{8,}\b")


def sanitize(schema):
    if not isinstance(schema, dict):
        return schema
    out = {}
    for k, v in schema.items():
        if k not in ALLOWED:
            continue
        if k == "properties" and isinstance(v, dict):
            out[k] = {pk: sanitize(pv) for pk, pv in v.items()}
        elif k == "items":
            out[k] = sanitize(v)
        else:
            out[k] = v
    out.setdefault("type", "object")
    return out


def sanitize_description(desc: str, picked: set[str], all_tool_names: set[str]) -> str:
    """descriptionからユーザー固有情報と未採用ツールへの言及を取り除く。"""
    for pattern in USER_SPECIFIC_PATTERNS:
        desc = pattern.sub("", desc)

    unpicked = [n for n in all_tool_names if n not in picked]
    for name in unpicked:
        # "..., slack_search_users to find user IDs" のような列挙内の1節を除去
        desc = re.sub(
            rf",?\s*`?{re.escape(name)}`?\s+(?:to|for)\s+[^.,\n]+", "", desc
        )
    lines = []
    for line in desc.splitlines():
        # 未採用ツールへの言及が主題の行はまるごと落とす
        if any(re.search(rf"\b{re.escape(n)}\b", line) for n in unpicked):
            continue
        lines.append(line.rstrip())
    desc = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()

    leftovers = sorted(set(ID_LIKE.findall(desc)))
    if leftovers:
        print(f"警告: descriptionにIDらしき文字列が残っています: {leftovers}")
    return desc


async def main(server: dict, list_only: bool):
    headers = {"Authorization": f"Bearer {os.environ[server['token_env']]}"}
    tools = []
    async with streamablehttp_client(
        server["endpoint"], headers=headers
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            cursor = None
            while True:
                result = await session.list_tools(cursor=cursor)
                tools.extend(result.tools)
                cursor = result.nextCursor
                if not cursor:
                    break

    if list_only or not server["pick"]:
        print(f"=== {server['endpoint']} のツール一覧（{len(tools)}件） ===")
        for t in tools:
            print(f"  - {t.name}: {(t.description or '').splitlines()[0][:80]}")
        if not server["pick"]:
            print("\npickが未設定のため出力ファイルは生成していません。"
                  "SERVERSのpickにツール名を設定してください。")
        return

    all_names = {t.name for t in tools}
    curated = [
        {
            "name": t.name,
            "description": sanitize_description(
                t.description or t.name, set(server["pick"]), all_names
            ),
            "inputSchema": sanitize(t.inputSchema),
        }
        for t in tools
        if t.name in server["pick"]
    ]
    missing = set(server["pick"]) - {t["name"] for t in curated}
    if missing:
        print(f"警告: 見つからなかったツール: {sorted(missing)}")
    with open(server["output"], "w") as f:
        json.dump({"tools": curated}, f, ensure_ascii=False, indent=2)
    print(f"{len(curated)} tools written to {server['output']}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args or args[0] not in SERVERS:
        print(f"Usage: python scripts/fetch_mcp_tools.py {{{'|'.join(SERVERS)}}} [--list]")
        sys.exit(1)
    asyncio.run(main(SERVERS[args[0]], "--list" in sys.argv))
