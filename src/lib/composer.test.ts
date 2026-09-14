import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldSendComposerKey } from './composer';

describe('shouldSendComposerKey', () => {
  it('Enterで送信する', () => {
    assert.equal(
      shouldSendComposerKey({
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
      }),
      true,
    );
  });

  it('Shift+Enterは改行として扱う', () => {
    assert.equal(
      shouldSendComposerKey({
        key: 'Enter',
        shiftKey: true,
        isComposing: false,
      }),
      false,
    );
  });

  it('IME変換の確定中は送信しない', () => {
    assert.equal(
      shouldSendComposerKey({
        key: 'Enter',
        shiftKey: false,
        isComposing: true,
      }),
      false,
    );
    assert.equal(
      shouldSendComposerKey({
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        keyCode: 229,
      }),
      false,
    );
  });

  it('Enter以外のキーでは送信しない', () => {
    assert.equal(
      shouldSendComposerKey({
        key: 'a',
        shiftKey: false,
        isComposing: false,
      }),
      false,
    );
  });
});
