"""Create/delete only this fork's portal; CloudFormation owns its supporting resources.

Use the current AWS credential chain (no profile switching). No secrets are printed.
"""
import argparse
import json
import os
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.local/portal.json'


def validate_url(value):
    import re
    if not isinstance(value, str) or not re.fullmatch(
        r'https://[a-z0-9-]+\.consent-portal\.bedrock-agentcore\.[a-z0-9-]+\.amazonaws\.com', value
    ):
        raise ValueError('Expected an AWS consent portal origin without a trailing slash')
    return value


def write_state(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(value, file, indent=2)
        file.write('\n')
    temp.replace(path)


def wait_active(control, portal_id, timeout=900):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = control.get_consent_portal(consentPortalIdentifier=portal_id)
        if response['status'] == 'ACTIVE':
            validate_url(response['portalUrl'])
            return response
        if response['status'] in ('FAILED', 'DELETING', 'DELETE_FAILED'):
            raise RuntimeError(f"Portal is {response['status']}; inspect statusReason in AWS")
        time.sleep(10)
    raise TimeoutError('Portal is still provisioning; run create again to resume')


def create(control, config, state_path=STATE):
    gateway_id = config['gatewayId']
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if state and state['gatewayId'] != gateway_id:
        raise ValueError('Saved portal belongs to another gateway; use a separate checkout')
    if not state:
        response = control.create_consent_portal(
            name=config['portalName'],
            executionRoleArn=config['portalExecutionRoleArn'],
            idpConfig={'credentialProviderArn': config['portalLoginProviderArn'],
                       'scopes': ['openid', 'email', 'profile']},
            sources=[{'identifier': gateway_id, 'type': 'agentcore-gateway'}],
            tags={'Project': 'consent-portal-demo'},
        )
        state = {'gatewayId': gateway_id, 'consentPortalId': response['consentPortalId']}
        # Save the identifier before waiting so a timeout can be resumed.
        write_state(state_path, state)
    response = wait_active(control, state['consentPortalId'])
    state.update(portalUrl=response['portalUrl'], consentPortalArn=response['consentPortalArn'])
    write_state(state_path, state)
    return state


def main():
    import boto3
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['create', 'status', 'delete'])
    parser.add_argument('--outputs', type=Path, default=ROOT / 'amplify_outputs.json')
    args = parser.parse_args()
    outputs = json.loads(args.outputs.read_text())
    config = outputs['custom']
    arn = config['portalExecutionRoleArn']
    session = boto3.Session(region_name=outputs['auth']['aws_region'])
    account = session.client('sts').get_caller_identity()['Account']
    if arn.split(':')[4] != account:
        raise ValueError('Current AWS account does not match the deployed outputs')
    control = session.client('bedrock-agentcore-control')
    if args.command == 'create':
        state = create(control, config)
        print('Portal ACTIVE:', state['portalUrl'])
        print('Next: deploy the same Amplify sandbox again to configure Cognito and targets.')
    else:
        state = json.loads(STATE.read_text())
        if state['gatewayId'] != config['gatewayId']:
            raise ValueError('Saved portal does not belong to this deployment')
        if args.command == 'status':
            response = control.get_consent_portal(consentPortalIdentifier=state['consentPortalId'])
            print(json.dumps({k: response.get(k) for k in ('status', 'portalUrl')}))
        else:
            control.delete_consent_portal(consentPortalIdentifier=state['consentPortalId'])
            # Keep the state until the service confirms removal. Never delete other portals.
            for _ in range(90):
                try:
                    control.get_consent_portal(consentPortalIdentifier=state['consentPortalId'])
                except control.exceptions.ResourceNotFoundException:
                    STATE.unlink()
                    print('Portal deleted. Now delete this Amplify sandbox.')
                    return
                time.sleep(10)
            raise TimeoutError('Deletion pending; retain .local/portal.json and check AWS')


if __name__ == '__main__':
    main()
