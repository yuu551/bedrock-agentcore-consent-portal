# AgentCore同意ポータルでGitHubと連携するチャット

Amazon Bedrock AgentCoreの同意ポータルでGitHubへのアクセスを許可し、チャットからプロフィールやリポジトリを確認するサンプルです。認可とユーザーの紐付けを同意ポータルに任せ、AgentCore Gateway経由でGitHubのツールを呼び出します。

![GitHub連携の構成](images/consent-portal-architecture.png)

## 準備

Node.js 24以降、pnpm、Python 3.14、uvを用意し、AWS認証を済ませます。デプロイ先は `us-east-1` です。

```bash
git clone https://github.com/yuu551/bedrock-agentcore-consent-portal.git
cd bedrock-agentcore-consent-portal
pnpm install --frozen-lockfile
uv init --bare --python 3.14 portal-setup
uv add --project portal-setup -r scripts/requirements.txt
```

## GitHub OAuth Appを作る

[GitHub OAuth Appの作成画面](https://github.com/settings/applications/new)で、次の値を設定します。

| 項目 | 値 |
| --- | --- |
| Application name | AgentCore Consent Portal Demo |
| Homepage URL | `http://localhost:5173` |
| Redirect URI | `http://localhost:5173/callback`（後で変更） |

作成後にClient IDを控え、Client Secretを生成します。AWSコンソールのSecrets Managerで「その他のシークレットのタイプ」を選び、キー名に `client_secret`、値に生成したClient Secretを指定して、シークレット名 `consent-demo/github` で保存します。

## デプロイする

まずCognito・Gateway・Runtimeを作成します。

```bash
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export GITHUB_CLIENT_ID='作成したOAuth AppのClient ID'
pnpm ampx sandbox --identifier consent-demo --once
```

生成された `amplify_outputs.json` の `custom.githubCallbackUrl` を、GitHub OAuth AppのRedirect URIに設定します。

続いて同意ポータルを作成します。

```bash
uv run --project portal-setup python scripts/portal.py create
```

ポータルが `ACTIVE` になると、URLが `.local/portal.json` に保存されます。同じターミナルで再デプロイし、ポータルのログイン設定とGitHubターゲットを反映します。

```bash
pnpm ampx sandbox --identifier consent-demo --once
pnpm dev
```

## 試す

1. `http://localhost:5173` を開き、Cognitoユーザーを登録してログインします。
2. 「サービスを連携」から同意ポータルを開き、チャットと同じユーザーでログインします。
3. GitHubの「Connect」を押し、GitHubの画面でアクセスを許可します。
4. ポータルに「Connected」と表示されたらチャットへ戻り、「自分のGitHubプロフィールを教えて」と質問します。

認可前に質問した場合は、チャットにポータルへのリンクが表示されます。接続を済ませて同じ質問を再送してください。

GitHubのツールは読み取り用の6つです。OAuthの `repo` スコープには書き込み権限も含まれるため、認可画面で許可する範囲を確認してください。

モデルはClaude Haiku 4.5を使います。AWSリソースとモデルの利用には料金がかかります。

エージェントの処理は [agent/README.md](agent/README.md)、実環境で確認した内容は [検証記録](docs/verification.md) にまとめています。

## テスト

型検査とビルドは、デプロイで `amplify_outputs.json` を生成してから実行します。

```bash
pnpm test
uv run --project portal-setup python -m unittest discover -s scripts/tests -v
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p amplify/tsconfig.json
pnpm build
```

## 後片付け

ポータルを削除してから、Amplifyのsandboxを削除します。

```bash
uv run --project portal-setup python scripts/portal.py delete
pnpm ampx sandbox delete --identifier consent-demo
```

GitHub OAuth Appと、手動登録したSecrets Managerの `consent-demo/github` も削除します。CloudFormationの削除結果を確認し、保持されたシークレットやECRリポジトリも必要に応じて削除してください。

## 参考

- [同意ポータルの作成](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-create-consent-portal.html)
- [ターゲットの設定](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-configure-consent-portal-target.html)
- [実行ロール](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-consent-portal-execution-role.html)
