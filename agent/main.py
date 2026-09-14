import asyncio
import logging
import os

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.tools.mcp import MCPClient

from connections import PROVIDER_PROBES, run_connection_check, run_connection_probe
from gateway_auth import GatewayAuthHook
from memory_session import create_session_manager

MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
GATEWAY_URL = os.environ.get("GATEWAY_URL", "")

logger = logging.getLogger("agent_main")

SYSTEM_PROMPT = """あなたはユーザーのGitHubアカウントの情報を調べるアシスタントです。
ツールで取得した情報をもとに、日本語で簡潔に回答してください。
通常の回答は短い見出しと箇条書きで整理してください。
ただし、ユーザーがMarkdownテーブルを明示的に求めた場合は、その指示を優先して正しいGFM形式の表で回答してください。
GFM表では見出し行、区切り行、各データ行を必ず別の行にし、表の前後に空行を入れてください。
Markdownテーブルを表示できない実装上の制約があるとは説明しないでください。
ASCIIアートや区切り文字だけのテキスト表、表をコードブロックで囲む表現は使わないでください。
ユーザーがコード例を求めた場合を除き、コードブロックも使わないでください。
ツールを呼び出す前に進捗を伝える場合は、表や一覧を出さず1文だけにしてください。
GitHub関連でユーザー自身のログイン名が必要な場合は、先にget_me系のツールで確認してください。
GitHubの読み取り専用ツールだけを利用できます。変更や投稿は実行できません。"""

app = BedrockAgentCoreApp()


def _bearer_token(context: RequestContext) -> str:
    headers = context.request_headers or {}
    raw_auth = headers.get("Authorization") or headers.get("authorization") or ""
    return raw_auth.removeprefix("Bearer ").removeprefix("bearer ").strip()


def _parse_operation(payload: dict) -> str:
    operation = payload.get("operation")
    if operation is None:
        return "chat"
    if operation in ("chat", "connection_probe", "connection_check"):
        return operation
    return "invalid"


async def _run_connection_operation(operation: str, provider: str, bearer_token: str):
    logger.info("invoke %s provider=%s", operation, provider)
    gateway = MCPClient(
        lambda: streamablehttp_client(
            GATEWAY_URL, headers={"Authorization": f"Bearer {bearer_token}"}
        )
    )
    runner = (
        run_connection_check
        if operation == "connection_check"
        else run_connection_probe
    )
    with gateway:
        async for event in runner(gateway=gateway, provider=provider):
            yield event


@app.entrypoint
async def invoke(payload, context: RequestContext):
    operation = _parse_operation(payload if isinstance(payload, dict) else {})
    bearer_token = _bearer_token(context)

    if operation == "invalid":
        yield {
            "type": "error",
            "data": "このサービスは利用できません。",
            "code": "invalid_provider",
        }
        return

    if operation in ("connection_probe", "connection_check"):
        provider = payload.get("provider")
        if provider not in PROVIDER_PROBES:
            yield {
                "type": "error",
                "scope": "connection",
                "code": "invalid_provider",
                "data": "このサービスは利用できません。",
            }
            return

        async for event in _run_connection_operation(
            operation, provider, bearer_token
        ):
            yield event
        return

    # chat（後方互換: operation 省略 + prompt）
    prompt = payload.get("prompt", "") if isinstance(payload, dict) else ""

    session_manager = await asyncio.to_thread(create_session_manager, context)

    event_queue = asyncio.Queue()

    gateway = MCPClient(
        lambda: streamablehttp_client(
            GATEWAY_URL, headers={"Authorization": f"Bearer {bearer_token}"}
        )
    )

    with gateway:
        tools = gateway.list_tools_sync()

        agent = Agent(
            model=MODEL_ID,
            tools=tools,
            system_prompt=SYSTEM_PROMPT,
            hooks=[GatewayAuthHook(event_queue, portal_url=os.environ.get("CONSENT_PORTAL_URL") if os.environ.get("AUTH_MODE") == "consent_portal" else None)],
            session_manager=session_manager,
            agent_id="default",
        )

        async def run_agent():
            seen_tool_ids = set()
            try:
                async for event in agent.stream_async(prompt):
                    if isinstance(event.get("data"), str):
                        await event_queue.put({
                            "type": "text",
                            "data": event["data"],
                        })
                    elif "current_tool_use" in event:
                        tool_use = event["current_tool_use"]
                        tool_id = tool_use.get("toolUseId", "")
                        if tool_id and tool_id not in seen_tool_ids:
                            seen_tool_ids.add(tool_id)
                            await event_queue.put({
                                "type": "tool_use",
                                "tool_name": tool_use.get("name", ""),
                            })
            except Exception as e:
                await event_queue.put({"type": "error", "data": str(e)})
            finally:
                await event_queue.put(None)

        task = asyncio.create_task(run_agent())

        while True:
            item = await event_queue.get()
            if item is None:
                break
            yield item

        await task


if __name__ == "__main__":
    app.run()
