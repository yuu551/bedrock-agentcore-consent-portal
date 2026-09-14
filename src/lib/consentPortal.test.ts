import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { consentPortalUrl } from './consentPortal';
const portal = 'https://demo-abcd.consent-portal.bedrock-agentcore.us-east-1.amazonaws.com';
test('accepts an AWS managed portal origin', () => {
  assert.equal(consentPortalUrl(portal), portal);
  assert.equal(consentPortalUrl(portal + '/'), portal);
});
test('rejects missing config, attacker origins, credentials, paths and query strings', () => {
  for (const value of [undefined, '', 'javascript:alert(1)', portal.replace('https:', 'http:'),
    portal + '.evil.example', portal + '/connect/callback', portal + '?token=secret',
    portal.replace('https://', 'https://user@'), portal + '#fragment']) {
    assert.equal(consentPortalUrl(value), '', String(value));
  }
});
