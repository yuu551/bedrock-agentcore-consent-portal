import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { createHandler } from './handler';

const conditionalError = () => {
  const e = new Error('The conditional request failed');
  e.name = 'ConditionalCheckFailedException';
  return e;
};

type Item = {
  userId: string;
  flowId: string;
  status: string;
  ttl: number;
  [key: string]: unknown;
};

class FakeDdb {
  store = new Map<string, Item>();

  private key(k: { userId: unknown; flowId: unknown }) {
    return `${String(k.userId)}#${String(k.flowId)}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(command: any): Promise<any> {
    const input = command.input;
    if (command.constructor.name === 'PutCommand') {
      const item = input.Item as Item;
      const key = this.key(item);
      if (input.ConditionExpression && this.store.has(key)) {
        throw conditionalError();
      }
      this.store.set(key, { ...item });
      return {};
    }
    if (command.constructor.name === 'GetCommand') {
      return { Item: this.store.get(this.key(input.Key)) };
    }
    if (command.constructor.name === 'UpdateCommand') {
      const key = this.key(input.Key);
      const item = this.store.get(key);
      const v = input.ExpressionAttributeValues as Record<string, unknown>;
      const cond: string = input.ConditionExpression ?? '';

      if (!item) throw conditionalError();
      if (cond.includes(':pending') && cond.includes(':nowEpoch')) {
        if (
          item.status !== v[':pending'] ||
          item.ttl <= Number(v[':nowEpoch'])
        ) {
          throw conditionalError();
        }
      }
      if (cond === '#st = :completed' && item.status !== v[':completed']) {
        throw conditionalError();
      }

      if (input.UpdateExpression.includes(':completed')) {
        item.status = String(v[':completed']);
        item.boundAt = v[':now'];
      } else {
        item.status = String(v[':pending']);
      }
      return {};
    }
    throw new Error(`unexpected command: ${command.constructor.name}`);
  }
}

class FakeAgentCore {
  calls: string[] = [];
  fail = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(command: any): Promise<any> {
    if (this.fail) throw new Error('Identity API failed');
    this.calls.push(command.input.sessionUri as string);
    return {};
  }
}

const makeEvent = (
  rawPath: string,
  body?: string
): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    rawPath,
    body,
    headers: { authorization: 'Bearer test-token' },
    requestContext: {
      authorizer: { jwt: { claims: { sub: 'user-1' }, scopes: [] } },
    },
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

const FLOW_A = 'urn:ietf:params:oauth:request_uri:flow-a';
const FLOW_B = 'urn:ietf:params:oauth:request_uri:flow-b';

const setup = () => {
  const ddb = new FakeDdb();
  const agentcore = new FakeAgentCore();
  const handler = createHandler({ ddb, agentcore, tableName: 'test-table' });
  return { ddb, agentcore, handler };
};

const pendingBody = (flow: string) =>
  JSON.stringify({ flow_id: flow, provider: 'github' });
const completeBody = (session: string) =>
  JSON.stringify({ session_id: session });

describe('session-binding handler', () => {
  it('pending 登録から complete まで成功する', async () => {
    const { ddb, agentcore, handler } = setup();

    const pending = await handler(
      makeEvent('/auth/pending', pendingBody(FLOW_A))
    );
    assert.equal(pending.statusCode, 200);

    const complete = await handler(
      makeEvent('/auth/complete', completeBody(FLOW_A))
    );
    assert.equal(complete.statusCode, 200);
    assert.deepEqual(agentcore.calls, [FLOW_A]);
    assert.equal([...ddb.store.values()][0].status, 'COMPLETED');
  });

  it('同じフローの重複 pending は冪等に成功する', async () => {
    const { ddb, handler } = setup();

    await handler(makeEvent('/auth/pending', pendingBody(FLOW_A)));
    const retry = await handler(
      makeEvent('/auth/pending', pendingBody(FLOW_A))
    );
    assert.equal(retry.statusCode, 200);
    assert.equal(ddb.store.size, 1);
  });

  it('完了済みフローへの再 pending は 409 で上書きできない', async () => {
    const { ddb, handler } = setup();

    await handler(makeEvent('/auth/pending', pendingBody(FLOW_A)));
    await handler(makeEvent('/auth/complete', completeBody(FLOW_A)));

    const again = await handler(
      makeEvent('/auth/pending', pendingBody(FLOW_A))
    );
    assert.equal(again.statusCode, 409);
    assert.equal([...ddb.store.values()][0].status, 'COMPLETED');
  });

  it('期限切れのフローは complete できない', async () => {
    const { ddb, handler } = setup();

    await handler(makeEvent('/auth/pending', pendingBody(FLOW_A)));
    [...ddb.store.values()][0].ttl = Math.floor(Date.now() / 1000) - 1;

    const complete = await handler(
      makeEvent('/auth/complete', completeBody(FLOW_A))
    );
    assert.equal(complete.statusCode, 403);
  });

  it('開始していない別フローの session_id では complete できない', async () => {
    const { handler } = setup();

    await handler(makeEvent('/auth/pending', pendingBody(FLOW_A)));

    const complete = await handler(
      makeEvent('/auth/complete', completeBody(FLOW_B))
    );
    assert.equal(complete.statusCode, 403);
  });

  it('二重 complete は拒否される（ワンタイム遷移）', async () => {
    const { agentcore, handler } = setup();

    await handler(makeEvent('/auth/pending', pendingBody(FLOW_A)));
    const first = await handler(
      makeEvent('/auth/complete', completeBody(FLOW_A))
    );
    const second = await handler(
      makeEvent('/auth/complete', completeBody(FLOW_A))
    );

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 403);
    assert.equal(agentcore.calls.length, 1);
  });

  it('Identity 失敗時は PENDING へロールバックして再試行できる', async () => {
    const { ddb, agentcore, handler } = setup();

    await handler(makeEvent('/auth/pending', pendingBody(FLOW_A)));
    agentcore.fail = true;
    const failed = await handler(
      makeEvent('/auth/complete', completeBody(FLOW_A))
    );
    assert.equal(failed.statusCode, 500);
    assert.equal([...ddb.store.values()][0].status, 'PENDING');

    agentcore.fail = false;
    const retry = await handler(
      makeEvent('/auth/complete', completeBody(FLOW_A))
    );
    assert.equal(retry.statusCode, 200);
  });

  it('壊れた JSON ボディは 400 を返す', async () => {
    const { handler } = setup();

    const pending = await handler(makeEvent('/auth/pending', '{broken'));
    const complete = await handler(makeEvent('/auth/complete', '{broken'));
    assert.equal(pending.statusCode, 400);
    assert.equal(complete.statusCode, 400);
  });

  it('flow_id / session_id が無い場合は 400 を返す', async () => {
    const { handler } = setup();

    const pending = await handler(makeEvent('/auth/pending', '{}'));
    const complete = await handler(makeEvent('/auth/complete', '{}'));
    assert.equal(pending.statusCode, 400);
    assert.equal(complete.statusCode, 400);
  });
});
