import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreClient,
  CompleteResourceTokenAuthCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { createHash } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

// テストでフェイクを差し込めるよう、send だけを持つ構造的な型にする
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sendable = { send: (command: any) => Promise<any> };

// session URI（URN）はBearer相当のため、DynamoDBにはSHA-256ハッシュだけを保存する
const flowKeyOf = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const isConditionalFailure = (e: unknown) =>
  e instanceof Error && e.name === 'ConditionalCheckFailedException';

const parseBody = (body: string | undefined): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(body ?? '{}');
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const createHandler =
  (deps: { ddb: Sendable; agentcore: Sendable; tableName: string }) =>
  async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const { ddb, agentcore, tableName } = deps;
    const claims = event.requestContext.authorizer.jwt.claims;
    const userId = String(claims.sub);
    const rawToken = (event.headers.authorization ?? '').replace(
      /^Bearer\s+/i,
      ''
    );

    if (event.rawPath === '/auth/pending') {
      const body = parseBody(event.body);
      if (!body) {
        return json(400, { error: 'invalid JSON body' });
      }
      const { flow_id: flowId, provider } = body;
      if (
        typeof flowId !== 'string' ||
        flowId.length === 0 ||
        flowId.length > 2048
      ) {
        return json(400, { error: 'flow_id is required' });
      }

      const hashedFlowId = flowKeyOf(flowId);
      try {
        await ddb.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              userId,
              flowId: hashedFlowId,
              ...(typeof provider === 'string' ? { provider } : {}),
              status: 'PENDING',
              createdAt: new Date().toISOString(),
              ttl: Math.floor(Date.now() / 1000) + 900,
            },
            // COMPLETED済みレコードをPENDINGへ上書きして二重Bindingを許さない
            ConditionExpression:
              'attribute_not_exists(userId) AND attribute_not_exists(flowId)',
          })
        );
      } catch (e) {
        if (!isConditionalFailure(e)) throw e;

        // 同じフローの再登録（未完了一致）は冪等に成功として扱う
        const existing = await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { userId, flowId: hashedFlowId },
          })
        );
        const item = existing.Item as
          | { status?: string; ttl?: number }
          | undefined;
        if (
          item?.status === 'PENDING' &&
          Number(item.ttl) > Math.floor(Date.now() / 1000)
        ) {
          return json(200, { status: 'ok' });
        }
        return json(409, { error: 'この認可フローは既に完了しています' });
      }
      return json(200, { status: 'ok' });
    }

    if (event.rawPath === '/auth/complete') {
      const body = parseBody(event.body);
      if (!body) {
        return json(400, { error: 'invalid JSON body' });
      }
      const { session_id: sessionId } = body;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return json(400, { error: 'session_id is required' });
      }

      // callbackのsession_idは認可URLのrequest_uriと同じURNなので、
      // ハッシュが一致するレコードだけが開始済みフローとして照合できる
      const flowId = flowKeyOf(sessionId);

      try {
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { userId, flowId },
            UpdateExpression: 'SET #st = :completed, boundAt = :now',
            ConditionExpression: '#st = :pending AND #ttl > :nowEpoch',
            ExpressionAttributeNames: { '#st': 'status', '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':completed': 'COMPLETED',
              ':pending': 'PENDING',
              ':now': new Date().toISOString(),
              ':nowEpoch': Math.floor(Date.now() / 1000),
            },
          })
        );
      } catch (e) {
        if (isConditionalFailure(e)) {
          return json(403, { error: '有効な認可フローが見つかりません' });
        }
        throw e;
      }

      try {
        await agentcore.send(
          new CompleteResourceTokenAuthCommand({
            sessionUri: sessionId,
            userIdentifier: { userToken: rawToken },
          })
        );
      } catch (e) {
        console.error('CompleteResourceTokenAuth failed', e);
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { userId, flowId },
            UpdateExpression: 'SET #st = :pending',
            // 自分がCOMPLETEDにしたレコードだけを戻す
            ConditionExpression: '#st = :completed',
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: {
              ':completed': 'COMPLETED',
              ':pending': 'PENDING',
            },
          })
        );
        return json(500, { error: '連携の完了処理に失敗しました' });
      }
      return json(200, { status: 'bound' });
    }

    return json(404, { error: 'not found' });
  };

export const handler = createHandler({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  agentcore: new BedrockAgentCoreClient({}),
  tableName: process.env.TABLE_NAME!,
});

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
