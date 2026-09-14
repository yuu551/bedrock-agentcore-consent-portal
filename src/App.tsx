import { useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { withAuthenticator, type WithAuthenticatorProps } from '@aws-amplify/ui-react';
import { Streamdown } from 'streamdown';
import outputs from '../amplify_outputs.json';
import {
  displayNameFromAuthUrl,
  guessProviderFromUrl,
  PROVIDER_META,
} from './hooks/connectionState';
import { consentPortalUrl } from './lib/consentPortal';
import {
  invokeRuntime,
} from './lib/agentRuntime';
import {
  COMPOSER_MAX_HEIGHT,
  shouldSendComposerKey,
} from './lib/composer';
import type { ProviderId } from './types/runtime';

const custom = (
  outputs as {
    custom: { consentPortalUrl?: string; agentArn?: string };
  }
).custom;
const PORTAL_URL = consentPortalUrl(custom.consentPortalUrl);
const AGENT_ARN = custom.agentArn ?? '';
const REGION = AGENT_ARN.split(':')[3] || 'us-east-1';

const SESSION_STORAGE_PREFIX = 'agentcore-session-id';

function sessionStorageKey(userId: string): string {
  return `${SESSION_STORAGE_PREFIX}:${userId}`;
}

function getOrCreateSessionId(userId: string): string {
  const key = sessionStorageKey(userId);
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

function resetSessionId(userId: string): string {
  const key = sessionStorageKey(userId);
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}

const SUGGESTIONS = [
  '私のリポジトリを教えて',
  'アサインされているIssueは？',
  '自分のGitHubプロフィールを教えて',
  '自分が作成したIssueを探して',
];

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  authUrl?: string;
  provider?: ProviderId;
}

function App({ signOut, user }: WithAuthenticatorProps) {
  const userId = user?.userId ?? '';
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(() => getOrCreateSessionId(userId));
  const logEndRef = useRef<HTMLDivElement>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);


  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    const height = Math.min(composer.scrollHeight, COMPOSER_MAX_HEIGHT);
    composer.style.height = `${height}px`;
    composer.style.overflowY =
      composer.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [input]);

  useEffect(() => {
    return () => {
      chatAbortRef.current?.abort();
      chatAbortRef.current = null;
    };
  }, []);

  const handleNewConversation = () => {
    const newId = resetSessionId(userId);
    setSessionId(newId);
    setMessages([]);
    setInput('');
  };

  const chatLocked = loading;

  const pushAssistantError = (content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content,
      },
    ]);
  };

  const send = async () => {
    if (!input.trim() || chatLocked || !AGENT_ARN) return;
    const text = input.trim();
    setInput('');
    setLoading(true);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: text },
    ]);

    chatAbortRef.current?.abort();
    const controller = new AbortController();
    chatAbortRef.current = controller;

    const abortChat = () => {
      controller.abort();
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
      }
    };

    try {
      const session = await fetchAuthSession();
      if (controller.signal.aborted) return;
      const token = session.tokens?.accessToken?.toString() ?? '';

      let assistantText = '';
      let assistantId = crypto.randomUUID();

      await invokeRuntime({
        payload: { prompt: text },
        runtimeSessionId: sessionId,
        accessToken: token,
        agentArn: AGENT_ARN,
        region: REGION,
        signal: controller.signal,
        onEvent: async (event) => {
          if (controller.signal.aborted) return;

          if (event.type === 'text') {
            assistantText += event.data;
            setMessages((prev) => {
              const others = prev.filter((m) => m.id !== assistantId);
              return [
                ...others,
                { id: assistantId, role: 'assistant', content: assistantText },
              ];
            });
          } else if (event.type === 'tool_use') {
            assistantText = '';
            assistantId = crypto.randomUUID();
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'tool' && last.content === event.tool_name) {
                return prev;
              }
              return [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'tool',
                  content: event.tool_name,
                },
              ];
            });
          } else if (event.type === 'auth_required') {
            const provider =
              event.provider ?? guessProviderFromUrl(event.auth_url) ?? undefined;

            const label = provider
              ? PROVIDER_META[provider].label
              : displayNameFromAuthUrl(event.auth_url);

            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                content:
                  `${label}へのアクセス許可が必要です。` +
                  '同意ポータルに、このチャットと同じアカウントでログインしてください。接続後、この画面で同じ質問をもう一度送信してください。',
                authUrl: PORTAL_URL,
                provider,
              },
            ]);
            abortChat();
          } else if (event.type === 'error' && event.scope !== 'connection') {
            pushAssistantError(
              event.data.startsWith('エラーが発生しました:')
                ? event.data
                : `エラーが発生しました: ${event.data}`,
            );
          }
        },
      });
    } catch {
      if (!controller.signal.aborted) {
        pushAssistantError(
          'エラーが発生しました: 接続状態を確認できませんでした。',
        );
      }
    } finally {
      setLoading(false);
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
      }
    }
  };

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <span className="brand">Consent Portal Agent</span>
        <div className="header-actions">
          {PORTAL_URL && <a className="ghost-btn" href={PORTAL_URL} target="_blank" rel="noreferrer">サービスを連携</a>}
          <button
            type="button"
            className="ghost-btn"
            onClick={handleNewConversation}
            disabled={chatLocked}
          >
            <span className="label-full">新しい会話</span>
            <span className="label-short">新規</span>
          </button>
          <button type="button" className="ghost-btn" onClick={signOut}>
            <span className="label-full">ログアウト</span>
            <span className="label-short">ログアウト</span>
          </button>
        </div>
      </header>

      <main className="chat-log">
        {!PORTAL_URL && <p className="notice">同意ポータルが未設定です。セットアップを完了してください。</p>}
        {!AGENT_ARN && (
          <p className="notice">エージェントが未登録です</p>
        )}

        {messages.length === 0 && AGENT_ARN && (
          <div className="empty">
            <h2>何をお手伝いしましょう？</h2>
            <p>あなたのGitHubプロフィール・リポジトリ・Issueを調べます</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="suggestion"
                  onClick={() => setInput(s)}
                  disabled={chatLocked}
                >
                  {s}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="empty-connect"
              disabled={!PORTAL_URL}
              onClick={() => window.open(PORTAL_URL, "_blank", "noopener,noreferrer")}
            >
              先に外部サービスを連携する
            </button>
          </div>
        )}

        {messages.map((m) =>
          m.role === 'tool' ? (
            <div key={m.id} className="msg msg-tool">
              <span className="tool-chip">
                <span className="tool-prompt">&gt;_</span>
                {m.content}
              </span>
            </div>
          ) : (
            <div
              key={m.id}
              className={`msg ${m.role === 'user' ? 'msg-user' : 'msg-agent'}`}
            >
              <div className="msg-label">
                {m.role === 'user' ? 'YOU' : 'AGENT'}
              </div>
              <div className="msg-body">
                {m.role === 'assistant' ? (
                  <Streamdown
                    controls={false}
                    linkSafety={{ enabled: false }}
                    lineNumbers={false}
                    shikiTheme={['github-dark', 'github-dark']}
                  >
                    {m.content}
                  </Streamdown>
                ) : (
                  m.content
                )}
              </div>
              {m.authUrl && (
                <div className="auth-card">
                  <p>ポータルで接続したら、ここへ戻って同じ質問を送信してください。</p>
                  <a
                    className="auth-btn"
                    href={m.authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    同意ポータルを開く
                  </a>
                </div>
              )}
            </div>
          ),
        )}

        {loading && (
          <div className="msg msg-agent">
            <div className="msg-label">AGENT</div>
            <div className="typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={logEndRef} />
      </main>

      <div className="composer">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={composerRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                shouldSendComposerKey({
                  key: e.key,
                  shiftKey: e.shiftKey,
                  isComposing: e.nativeEvent.isComposing,
                  keyCode: e.nativeEvent.keyCode,
                })
              ) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="メッセージを入力（Shift+Enterで改行）"
            aria-label="メッセージ"
            disabled={!AGENT_ARN || loading}
          />
          <button type="submit" disabled={chatLocked || !AGENT_ARN}>
            送信
          </button>
        </form>
      </div>


    </div>
  );
}

export default withAuthenticator(App);
