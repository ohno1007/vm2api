"""Candidate UI with in-memory credential/browser APIs; production APIs are GET-only."""
import base64
import json
import mimetypes
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

payload = json.loads(sys.stdin.readline())
root = Path(payload['root'])
output = Path(payload['output'])
credential_id = 'cred-00000000-0000-0000-0000-000000000001'
credential = {'id': credential_id, 'email': 'ui-fixture@outlook.de', 'mode': 'microsoft_mailbox',
              'has_password': True, 'has_totp': False, 'bound_vm_ids': [], 'updated_at': '2026-10-25T00:00:00Z'}
status = {'configured': False, 'email': '', 'credential_id': None, 'mode': 'password_totp',
          'has_password': False, 'has_totp': False, 'auto_reauthorize': True, 'login_armed': False,
          'browser': {'active': False, 'ready': False, 'remote': False},
          'subscription': None,
          'state': {'running': False, 'status': 'idle', 'stage': 'idle'}}
imported = False
calls = []
errors = []
session = {'user': {'email': credential['email']}, 'accessToken': 'ui-fixture-session-only'}
fail_subscription = False

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1100}, accept_downloads=True)
    context.add_init_script('localStorage.setItem("kin_console_token", ' + json.dumps(payload['token']) + ');')
    screen = context.new_page()
    screen.set_viewport_size({'width': 1365, 'height': 900})
    screen.set_content('<body style="background:#eef2f8;font-family:sans-serif;padding:50px"><h1>Browser fixture</h1><input placeholder="Remote input"><button>Continue</button></body>')
    frame = {'image': base64.b64encode(screen.screenshot(type='jpeg')).decode(), 'width': 1365, 'height': 900,
             'active': 0, 'paused': False, 'tabs': [{'index': 0, 'url': 'https://chatgpt.com/'}]}
    screen.close()

    def reply(route, data, status_code=200):
        route.fulfill(status=status_code, content_type='application/json', body=json.dumps({'ok': True, 'data': data}))

    def fetch_readonly(route):
        assert route.request.method in ['GET', 'HEAD'], 'Unexpected production mutation blocked'
        try:
            return route.fetch()
        except Exception:
            raise RuntimeError('Read-only fixture upstream request failed') from None

    def route_request(route):
        global imported
        request = route.request
        path = urlparse(request.url).path
        if path in ['/cc', '/cc/']:
            return route.fulfill(path=str(root / 'web/dist/index.html'), content_type='text/html')
        if path.startswith('/assets/'):
            file = root / 'web/dist' / path.lstrip('/')
            return route.fulfill(path=str(file), content_type=mimetypes.guess_type(file)[0] or 'application/octet-stream')
        if path == '/api/panel/pool/stream':
            return route.fulfill(content_type='text/event-stream', body=': fixture\n\n')
        if path in ['/api/panel/onboarding', '/api/panel/me']:
            response = fetch_readonly(route)
            body = response.json()
            data = body.get('data', body)
            if path.endswith('/onboarding'):
                data['guide_used'] = True
            else:
                data['views'] = list(set(data.get('views', []) + ['credentials']))
            return route.fulfill(response=response, json=body)
        if path.startswith('/api/panel/login-credentials'):
            calls.append(path)
            if path.endswith('/import'):
                assert request.method == 'POST'
                value = request.post_data_json['text']
                assert value == credential['email'] + '---ui-fixture-mailbox-password'
                imported = True
                return reply(route, {'created': 1, 'updated': 0, 'total': 1})
            if request.method == 'GET':
                return reply(route, {'credentials': [credential] if imported else []})
            return reply(route, {})
        if path == '/api/panel/vms':
            response = fetch_readonly(route)
            data = response.json()
            print('Slot-list response:', response.status, 'count:', len(data.get('data', data).get('items', [])))
            return route.fulfill(response=response)
        if path.startswith('/api/panel/vms/vm-03/oauth/login'):
            action = path.removeprefix('/api/panel/vms/vm-03/oauth/login').strip('/')
            if request.method == 'GET':
                return reply(route, status)
            calls.append(action)
            if action == 'bind':
                assert request.post_data_json['credential_id'] == credential_id
                credential['bound_vm_ids'] = ['vm-03']
                status.update({'configured': True, 'credential_id': credential_id, 'email': credential['email'], 'mode': 'microsoft_mailbox', 'has_password': True, 'has_totp': False})
                status['state']['stage'] = 'waiting_manual_login'
            elif action == 'start':
                status['state'].update({'running': True, 'status': 'running', 'stage': 'openai_login'})
                status['browser'].update({'active': True, 'ready': True, 'remote': False})
            elif action == 'control':
                operation = request.post_data_json['op']
                calls.append('control:' + operation)
                if operation == 'frame':
                    return reply(route, frame)
                if operation in ['takeover', 'resume']:
                    frame['paused'] = operation == 'takeover'
                return reply(route, {})
            elif action == 'session':
                return route.fulfill(content_type='application/json', headers={'content-disposition': 'attachment; filename="vm-03-chatgpt-session.json"'}, body=json.dumps(session))
            elif action == 'subscription':
                if fail_subscription:
                    status['subscription'] = None
                    return route.fulfill(status=409, content_type='application/json', body=json.dumps({'ok': False, 'error': {'code': 'subscription_verification_failed', 'message': 'subscription_verification_failed'}}))
                enabled = request.post_data_json.get('enabled', True)
                status['subscription'] = {'enabled': enabled, 'period_end': '2030-12-01T00:00:00Z', 'checked_at': '2026-10-25T00:00:00Z'}
                return reply(route, status['subscription'])
            elif action == 'cancel':
                status['browser'].update({'active': False, 'ready': False})
                status['state']['running'] = False
            return reply(route, status)
        if request.method not in ['GET', 'HEAD']:
            raise AssertionError('Unexpected mutation blocked: ' + path)
        response = fetch_readonly(route)
        return route.fulfill(response=response)

    context.route('**/*', route_request)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)[:180]))
    base = payload.get('base', 'http://172.18.0.1:8787')
    page.goto(base + '/cc#/credentials', wait_until='domcontentloaded')
    page.get_by_role('heading', name='账号池', exact=True).wait_for()
    page.get_by_label('批量账号凭据').fill('ui-fixture@outlook.de---ui-fixture-mailbox-password')
    page.get_by_role('button', name='仅导入凭据', exact=True).click()
    page.get_by_text(credential['email'], exact=True).wait_for()
    assert 'start' not in calls and 'remote' not in calls
    assert page.get_by_label('批量账号凭据').input_value() == ''
    page.screenshot(path=str(output / 'credential-pool-desktop.png'), full_page=True)
    try:
        page.get_by_label('为 ui-fixture@outlook.de 选择槽位').select_option('vm-03')
    except Exception:
        print('Available slot option values:', page.locator('select option').evaluate_all('els => els.map(e => e.value)'))
        print('Page errors:', errors)
        raise
    page.get_by_role('button', name='绑定', exact=True).click()
    page.locator('a[href*="/vm/vm-03"]').first.wait_for()
    assert 'start' not in calls and 'remote' not in calls
    page.locator('a[href*="/vm/vm-03"]').first.click()
    page.get_by_text('绑定的登录凭据', exact=True).wait_for()
    page.get_by_text(credential['email'], exact=True).wait_for()
    assert 'start' not in calls
    page.get_by_text('微软邮箱密码：已保存', exact=False).first.wait_for()
    with page.expect_download() as info:
        page.get_by_role('button', name='导出 ChatGPT Session', exact=True).click()
    info.value.save_as(str(output / 'ui-direct-session.json'))
    assert json.loads((output / 'ui-direct-session.json').read_text()) == session
    assert 'start' not in calls and 'remote' not in calls
    renewal = page.get_by_role('switch', name='自动付费续订套餐', exact=True)
    expect(renewal).to_be_disabled()
    page.get_by_role('button', name='读取官网状态', exact=True).click()
    expect(renewal).to_be_checked()
    renewal.click()
    expect(renewal).not_to_be_checked()
    renewal.click()
    expect(renewal).to_be_checked()
    fail_subscription = True
    renewal.click()
    expect(renewal).to_be_disabled()
    page.get_by_text('未能确认官网续订结果', exact=False).first.wait_for()
    assert 'start' not in calls and 'remote' not in calls
    page.get_by_role('button', name='登录', exact=True).click()
    page.get_by_role('button', name='停止登录', exact=True).wait_for()
    assert calls.count('start') == 1
    page.screenshot(path=str(output / 'credential-vm-desktop.png'), full_page=True)
    page.get_by_role('button', name='打开远程浏览器', exact=True).click()
    image = page.get_by_alt_text('槽位浏览器实时屏幕')
    image.wait_for()
    page.get_by_role('button', name='接管鼠标键盘', exact=True).click()
    page.get_by_role('button', name='继续自动登录', exact=True).wait_for()
    image.click(position={'x': 30, 'y': 30})
    page.get_by_label('向浏览器输入文字').fill('fixture-text')
    page.get_by_role('button', name='输入', exact=True).click()
    expect(page.get_by_label('向浏览器输入文字')).to_have_value('')
    with page.expect_download() as info:
        page.get_by_role('button', name='导出 ChatGPT Session', exact=True).click()
    download = info.value
    download.save_as(str(output / 'ui-fixture-session.json'))
    assert json.loads((output / 'ui-fixture-session.json').read_text()) == session
    assert 'control:click' in calls and 'control:text' in calls
    page.get_by_role('button', name='停止浏览器任务', exact=True).click()
    page.set_viewport_size({'width': 390, 'height': 1000})
    page.screenshot(path=str(output / 'credential-vm-mobile.png'), full_page=True)
    page.goto(base + '/cc#/credentials', wait_until='domcontentloaded')
    page.get_by_role('heading', name='账号池', exact=True).wait_for()
    page.screenshot(path=str(output / 'credential-pool-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Mobile horizontal overflow'
    assert not errors, errors
    print('UI passed: mailbox import/bind stayed idle; direct Session export; verified renewal read/on/off/error; explicit login; remote control; desktop/mobile.')
    context.close();browser.close()
