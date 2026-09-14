import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBackend } from '@aws-amplify/backend';
import { CfnResource, Duration, Fn } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { auth } from './auth/resource';

// GitHub OAuth AppのClient ID。実値はコミットせず環境変数で渡す
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
if (!GITHUB_CLIENT_ID) throw new Error('Set GITHUB_CLIENT_ID for the demo OAuth App');
const SECRET_NAME = process.env.GITHUB_SECRET_NAME ?? 'consent-demo/github';
const backend = defineBackend({ auth });
const stack = backend.createStack('consent-demo');
const dirname = path.dirname(fileURLToPath(import.meta.url));
const suffix = `consent${(process.env.AWS_BRANCH ?? process.env.USER ?? 'demo').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
const portalFile = path.join(dirname, '../.local/portal.json');
const portalConfig = existsSync(portalFile) ? JSON.parse(readFileSync(portalFile, 'utf8')) : {};
const portalUrl = process.env.CONSENT_PORTAL_URL ?? portalConfig.portalUrl ?? '';
if (portalUrl && !/^https:\/\/[a-z0-9.-]+\.consent-portal\.bedrock-agentcore\.[a-z0-9-]+\.amazonaws\.com$/.test(portalUrl)) {
  throw new Error('CONSENT_PORTAL_URL must be an AWS consent portal origin without a trailing slash');
}
const callbackUrl = `${portalUrl}/connect/callback`;
const userPool = backend.auth.resources.userPool;
const userPoolClient = backend.auth.resources.userPoolClient;
userPool.addDomain('ConsentDomain', { cognitoDomain: { domainPrefix: `${suffix}-${stack.account}` } });
const portalClient = userPool.addClient('ConsentPortalClient', {
  generateSecret: true,
  supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
  oAuth: {
    flows: { authorizationCodeGrant: true },
    scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
    callbackUrls: [portalUrl ? `${portalUrl}/callback` : 'https://example.com/placeholder'],
  },
});
const loginSecret = new secretsmanager.Secret(stack, 'PortalLoginSecret', {
  secretObjectValue: { client_secret: portalClient.userPoolClientSecret },
});
const loginProvider = new CfnResource(stack, 'PortalLoginProvider', {
  type: 'AWS::BedrockAgentCore::OAuth2CredentialProvider',
  properties: {
    Name: `portal-login-${suffix}`,
    CredentialProviderVendor: 'CustomOauth2',
    Oauth2ProviderConfigInput: { CustomOauth2ProviderConfig: {
      ClientId: portalClient.userPoolClientId,
      ClientSecretSource: 'EXTERNAL',
      ClientSecretConfig: { SecretId: loginSecret.secretArn, JsonKey: 'client_secret' },
      OauthDiscovery: { DiscoveryUrl: `https://cognito-idp.${stack.region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration` },
    } },
  },
});
const outputs: Record<string, string> = { consentPortalUrl: portalUrl, portalName: suffix };

// ─── Gateway用IAMロール ─────────────────────────────
const gatewayRole = new Role(stack, 'GatewayRole', {
  assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
});

gatewayRole.addToPolicy(
  new PolicyStatement({
    actions: [
      'bedrock-agentcore:GetWorkloadAccessToken',
      // ユーザーJWTを渡すアウトバウンド認証ではJWT用の別アクションが必要
      'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
      'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
      'bedrock-agentcore:GetResourceOauth2Token',
    ],
    resources: ['*'], // 動作確認用。本番はworkload-identity / token-vaultのARNに絞る
  })
);

gatewayRole.addToPolicy(
  new PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [
      `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${SECRET_NAME}-*`,
    ],
  })
);

// ─── OAuth2 Credential Provider ──────────────────────
// シークレットは自前のSecrets Managerを参照（EXTERNAL）。値がテンプレートに乗らない
// このサンプルは検証用のOAuth Appを使い、旧アプリの設定を保持する。
const credentialProvider = new CfnResource(stack, 'GitHubCredentialProvider', {
  type: 'AWS::BedrockAgentCore::OAuth2CredentialProvider',
  properties: {
    Name: `github-provider-${suffix}`,
    CredentialProviderVendor: 'GithubOauth2',
    Oauth2ProviderConfigInput: {
      GithubOauth2ProviderConfig: {
        ClientId: GITHUB_CLIENT_ID,
        ClientSecretSource: 'EXTERNAL',
        // シークレットはJSON形式（{"client_secret": "..."}）で格納し、JsonKeyで参照する
        // （CFNスキーマ上、SecretIdとJsonKeyの両方が必須。プレーン文字列は不可）
        ClientSecretConfig: {
          SecretId: SECRET_NAME,
          JsonKey: 'client_secret',
        },
      },
    },
  },
});

// ─── Gateway ─────────────────────────────────────────
const gateway = new CfnResource(stack, 'GitHubGateway', {
  type: 'AWS::BedrockAgentCore::Gateway',
  properties: {
    Name: `github-gateway-${suffix}`,
    AuthorizerType: 'CUSTOM_JWT',
    AuthorizerConfiguration: {
      CustomJWTAuthorizer: {
        DiscoveryUrl: Fn.sub(
          'https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/openid-configuration',
          {
            region: stack.region,
            poolId: userPool.userPoolId,
          }
        ),
        AllowedClients: [userPoolClient.userPoolClientId, portalClient.userPoolClientId],
      },
    },
    RoleArn: gatewayRole.roleArn,
    ProtocolType: 'MCP',
    ProtocolConfiguration: {
      Mcp: {
        // elicitation による認可URL返却は 2025-11-25 で導入。本サンプルはこのバージョンで検証
        SupportedVersions: ['2025-11-25'],
        SearchType: 'SEMANTIC',
      },
    },
    ExceptionLevel: 'DEBUG',
  },
});

// ─── Gateway Target: GitHub公式リモートMCPサーバー ────
// 3LOのMCPサーバーターゲットは作成時に対話認可が必要になるため、
// ツール定義（mcpToolSchema）を静的に渡して、デプロイ中の対話認可を避ける
// （静的スキーマは認可コードグラント専用の仕組み。同期は無効になる）
const mcpToolsSchema = readFileSync(
  path.join(dirname, 'github-mcp-tools.json'),
  'utf-8'
);

if (portalUrl) new CfnResource(stack, 'GitHubMcpTarget', {
  type: 'AWS::BedrockAgentCore::GatewayTarget',
  properties: {
    Name: 'githubmcp',
    GatewayIdentifier: gateway.ref,
    TargetConfiguration: {
      Mcp: {
        McpServer: {
          Endpoint: 'https://api.githubcopilot.com/mcp/',
          McpToolSchema: {
            InlinePayload: mcpToolsSchema,
          },
        },
      },
    },
    // この派生版専用のProviderを、ポータルとGatewayで使用する。
    CredentialProviderConfigurations: [
      {
        CredentialProviderType: 'OAUTH',
        CredentialProvider: {
          OauthCredentialProvider: {
            ProviderArn: credentialProvider
              .getAtt('CredentialProviderArn')
              .toString(),
            Scopes: ['repo', 'read:user'],
            GrantType: 'AUTHORIZATION_CODE',
            DefaultReturnUrl: callbackUrl,
          },
        },
      },
    ],
  },
});

// The portal is created after this stack, then its URL is supplied on the second deploy.
const portalRole = new Role(stack, 'ConsentPortalRole', {
  assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com', {
    conditions: { StringEquals: { 'aws:SourceAccount': stack.account },
      ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:consent-portal/*` } },
  }),
});
portalRole.addToPolicy(new PolicyStatement({
  actions: ['bedrock-agentcore:GetGateway', 'bedrock-agentcore:GetGatewayTarget', 'bedrock-agentcore:ListGatewayTargets'],
  resources: [gateway.getAtt('GatewayArn').toString()],
}));
portalRole.addToPolicy(new PolicyStatement({
  actions: ['bedrock-agentcore:GetOauth2CredentialProvider', 'bedrock-agentcore:ListOauth2CredentialProviders'],
  resources: [`arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:token-vault/default`,
    ...[loginProvider, credentialProvider].map(p => p.getAtt('CredentialProviderArn').toString())],
}));
portalRole.addToPolicy(new PolicyStatement({
  actions: ['bedrock-agentcore:CompleteResourceTokenAuth', 'bedrock-agentcore:GetResourceOauth2Token', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT'],
  resources: ['*'],
}));
portalRole.addToPolicy(new PolicyStatement({
  actions: ['secretsmanager:GetSecretValue'],
  resources: [loginSecret.secretArn,
    ...[SECRET_NAME].map(name => `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${name}-*`)],
}));
outputs.gatewayId = gateway.ref;
outputs.portalExecutionRoleArn = portalRole.roleArn;
outputs.portalLoginProviderArn = loginProvider.getAtt('CredentialProviderArn').toString();

const gatewayUrl = gateway.getAtt('GatewayUrl').toString();
outputs.gatewayUrl = gatewayUrl;

// ─── AgentCore Memory（短期記憶のみ） ────────────────
// memoryStrategiesを指定しないため、会話イベントだけを90日保持する
const memory = new agentcore.Memory(stack, 'AgentMemory', {
  memoryName: `github_agent_memory_${suffix}`,
  description: 'Short-term conversation memory for the 3LO agent',
  expirationDuration: Duration.days(90),
});

// ─── Agent Runtime（CodeBuild でイメージビルド → ECR → Runtime） ──
// ContainerImageBuild を使うことで、ローカル Docker が不要になり
// Amplify Hosting の CI/CD 環境でもビルドが通る
const agentImage = new ContainerImageBuild(stack, 'AgentImage', {
  directory: path.join(dirname, '../agent'),
  platform: Platform.LINUX_ARM64,
});

const runtime = new agentcore.Runtime(stack, 'GithubAgentRuntime', {
  runtimeName: `github_agent_${suffix}`,
  agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
    agentImage.repository,
    agentImage.imageTag,
  ),
  authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(
    userPool,
    [userPoolClient]
  ),
  environmentVariables: {
    GATEWAY_URL: gatewayUrl,
    CONSENT_PORTAL_URL: portalUrl,
    AUTH_MODE: 'consent_portal',
    MEMORY_ID: memory.memoryId,
    MEMORY_REGION: stack.region,
  },
});

// ECR Pull 権限（fromEcrRepository では自動付与されないケースがある）
runtime.addToRolePolicy(
  new PolicyStatement({
    actions: ['ecr:GetAuthorizationToken'],
    resources: ['*'],
  })
);
agentImage.repository.grantPull(runtime);

// Bedrockモデルの呼び出し許可
runtime.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: ['*'],
  })
);

// Session Managerが短期イベントを保存・復元・必要時に置換/移行できる権限
memory.grantWrite(runtime);
memory.grantReadShortTermMemory(runtime);
memory.grantDeleteShortTermMemory(runtime);

// JWTの転送許可リスト（環境変数はL2プロパティに移行済み）
const cfnRuntime = runtime.node.defaultChild as CfnResource;
cfnRuntime.addPropertyOverride('RequestHeaderConfiguration', {
  RequestHeaderAllowlist: ['Authorization'],
});

outputs.agentArn = runtime.agentRuntimeArn;
outputs.githubCallbackUrl = credentialProvider.getAtt('CallbackUrl').toString();

backend.addOutput({
  custom: outputs,
});
