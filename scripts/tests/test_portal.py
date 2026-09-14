import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from scripts.portal import create, validate_url, wait_active

URL = 'https://demo-abcd.consent-portal.bedrock-agentcore.us-east-1.amazonaws.com'
CONFIG = {'gatewayId': 'demo-gateway', 'portalName': 'consent-demo',
          'portalExecutionRoleArn': 'role', 'portalLoginProviderArn': 'provider'}
ACTIVE = {'status': 'ACTIVE', 'portalUrl': URL, 'consentPortalArn': 'arn:portal'}


class PortalTests(unittest.TestCase):
    def test_resume_does_not_create_second_portal(self):
        control = Mock()
        control.create_consent_portal.return_value = {'consentPortalId': 'portal'}
        control.get_consent_portal.return_value = ACTIVE
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'portal.json'
            create(control, CONFIG, path)
            create(control, CONFIG, path)
            self.assertEqual(control.create_consent_portal.call_count, 1)
            self.assertEqual(json.loads(path.read_text())['portalUrl'], URL)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                create(control, {**CONFIG, 'gatewayId': 'other'}, path)

    def test_failed_portal_does_not_become_active(self):
        control = Mock()
        control.get_consent_portal.return_value = {'status': 'FAILED'}
        with self.assertRaises(RuntimeError):
            wait_active(control, 'portal')

    def test_rejects_callback_or_external_url(self):
        self.assertEqual(validate_url(URL), URL)
        for value in (URL + '/', URL + '/callback', 'https://example.com', None):
            with self.assertRaises(ValueError):
                validate_url(value)


if __name__ == '__main__':
    unittest.main()
