export const COMPOSER_MAX_HEIGHT = 160;

type ComposerKey = {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
};

/** Enterは送信、Shift+Enterは改行。IME変換の確定では送信しない。 */
export function shouldSendComposerKey({
  key,
  shiftKey,
  isComposing,
  keyCode,
}: ComposerKey): boolean {
  return (
    key === 'Enter' &&
    !shiftKey &&
    !isComposing &&
    keyCode !== 229
  );
}
