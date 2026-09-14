# 検証記録

## AWSでの動作確認

2026-09-08に、us-east-1のAmplify sandboxで確認しました。

- 同意ポータルがACTIVE、GatewayとGitHubターゲットがREADYになった。
- チャットとポータルに同じCognitoユーザーでログインできた。
- GitHubで認可すると、ポータルの表示がNot connectedからConnectedへ変わった。
- チャットから `githubmcp___get_me` を呼び出し、GitHubプロフィールを取得できた。

トークンの期限切れ後の自動更新は未検証です。

## Python 3.14での検査

2026-09-14に、Python 3.14へ更新して確認しました。

- フロントエンド：36件成功。
- Session Bindingの回帰テスト：9件成功。
- エージェント：18件成功。
- ポータル設定スクリプト：3件成功。
- フロントエンド・Amplifyの型検査、Viteビルド：成功。
- Linux ARM64のRuntimeコンテナ：ビルド成功。Python 3.14.7でSDKのインポートとエージェントの18件のテストが成功。

Python 3.14への更新後はローカルとコンテナで検査しました。AWS上での再デプロイ・GitHub連携の再確認は今後の確認対象です。
