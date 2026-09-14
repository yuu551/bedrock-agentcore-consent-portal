# GitHub連携エージェント

AgentCore Runtime上で動作し、GatewayのMCPツールを使ってGitHubのプロフィールやリポジトリに関する質問に回答します。デプロイ手順と構成図は [ルートREADME](../README.md) を参照してください。

## チャットの処理

Runtimeが検証したCognitoアクセストークンをAuthorizationヘッダーから取り出し、同じトークンでGatewayへ接続します。Gatewayから取得したツールをStrands Agentに登録し、回答をストリーミングします。

```python
# main.py のGateway接続・ツール取得部分
with MCPClient(
    lambda: streamablehttp_client(
        GATEWAY_URL, headers={"Authorization": f"Bearer {bearer_token}"}
    )
) as gateway:
    tools = gateway.list_tools_sync()
```

チャットとポータルは同じCognitoユーザーでログインします。同意済みなら通常のツール呼び出しが進み、外部サービスのトークン取得はGatewayとIdentityが処理します。

## 未接続時の処理

`gateway_auth.py` の `GatewayAuthHook` をツール実行後のフックとして登録します。`extract_auth_url()` は、StrandsのMCPClientが認可要求エラーを変換した際の `MCP Elicitation required` マーカーと認可URLを検出します。この判定は使用するSDKのエラー形式に依存します。

ポータルモードでは、認可要求を検出したときに次の処理を行います。

- ツール結果を接続案内に置き換える。
- `event.retry = False` にして同じツールの自動リトライを止める。
- 同じproviderへの通知を重複させず、`auth_required` に同意ポータルのURLを入れる。

フロントエンドはポータルへのリンクを表示し、ストリーム受信を中断します。接続後はユーザーが同じ質問を再送します。

## 環境変数

`amplify/backend.ts` がRuntimeへ設定します。

| 変数 | 用途 |
| --- | --- |
| GATEWAY_URL | GatewayのMCPエンドポイント |
| AUTH_MODE | この構成では `consent_portal` |
| CONSENT_PORTAL_URL | 作成済み同意ポータルのURL |
| MODEL_ID | 使用モデル。未指定時はコード内のClaude Haiku 4.5 |
| MEMORY_ID | 会話履歴を保存するAgentCore Memory |
| MEMORY_REGION | Memoryのリージョン |

ポータル作成後に同じsandboxへ再デプロイし、URLを反映してください。ポータルURLの設定と `AUTH_MODE=consent_portal` の両方が、フックのポータル分岐を有効にする条件です。

## リクエストとイベント

```json
{ "operation": "chat", "prompt": "自分のGitHubプロフィールを教えて" }
```

`operation` を省略した場合もチャットとして扱います。レスポンスは `data: {...}` 形式のSSEです。

| type | 主なフィールド | 用途 |
| --- | --- | --- |
| text | data | 回答テキストの断片 |
| tool_use | tool_name | ツール呼び出しの開始 |
| auth_required | auth_url, provider（任意） | ポータルへの接続案内 |
| error | data, code（任意） | エラー通知 |

## 会話履歴

Cognito JWTの `sub` をMemoryのactor_id、Runtimeのsession_idを会話単位の識別子として使います。`memory_session.py` がSession Managerを生成し、履歴を復元・保存します。短期履歴の保持期間は90日です。

## ファイルと旧実装

| ファイル | 用途 |
| --- | --- |
| main.py | Runtimeのエントリーポイント、Gateway接続、Agent生成、イベント送信 |
| gateway_auth.py | 認可要求の検出とポータルへの案内 |
| memory_session.py | ユーザー・会話単位のMemory設定 |
| connections.py | 旧接続パネル向けの確認・ポーリング処理 |
| Dockerfile | Python 3.14のRuntimeイメージ |
| tests/ | 認可フック、接続確認、会話履歴などの単体テスト |

現在の画面は同意ポータル経由で接続します。`connection_check` / `connection_probe` は旧接続パネル向けの互換処理です。

## 開発と検査

リポジトリのルートでエージェントの単体テストを実行します。

```bash
pnpm test:agent
```

依存関係を変更した場合は `agent/` でRuntime用の依存一覧を更新します。

```bash
uv export --no-dev --no-hashes --no-emit-project \
  --format requirements-txt -o requirements.txt
```

Pythonファイルを追加した場合はDockerfileのCOPY対象も更新します。コードの反映は、ルートREADMEと同じ環境変数・sandbox識別子で `pnpm ampx sandbox --identifier consent-demo --once` を実行してください。
