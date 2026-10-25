"""Exercise actual grid/list actions with mocked mutations; production is GET-only."""
import json
import mimetypes
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

payload = json.loads(sys.stdin.readline())
root = Path(payload['root'])
output = Path(payload['output'])
role = 'admin'
calls = []
states = {}
session = {'user': {'email': 'slot-fixture@outlook.com'}, 'accessToken': 'slot-menu-fixture-only'}

def login_state(vm_id):
    return states.setdefault(vm_id, {
        'configured': vm_id == 'vm-03', 'email': session['user']['email'] if vm_id == 'vm-03' else '',
        'credential_id': None, 'mode': 'microsoft_mailbox', 'has_password': True, 'has_totp': False,
        'auto_reauthorize': False, 'login_armed': False, 'subscription': None,
        'browser': {'active': False, 'ready': False, 'remote': False},
        'state': {'running': False, 'status': 'idle', 'stage': 'idle'},
    })

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    context.add_init_script('localStorage.setItem("kin_console_token", ' + json.dumps(payload['token']) + ');')
    errors = []

    def fetch_readonly(route):
        assert route.request.method in ['GET', 'HEAD'], 'Production mutation blocked'
        try:
            return route.fetch()
        except Exception:
            raise RuntimeError('Read-only upstream request failed') from None

    def reply(route, data):
        route.fulfill(content_type='application/json', body=json.dumps({'ok': True, 'data': data}))

    def handle(route):
        request = route.request
        path = urlparse(request.url).path
        if path in ['/cc', '/cc/']:
            return route.fulfill(path=str(root / 'web/dist/index.html'), content_type='text/html')
        if path.startswith('/assets/'):
            file = root / 'web/dist' / path.lstrip('/')
            return route.fulfill(path=str(file), content_type=mimetypes.guess_type(file)[0] or 'application/octet-stream')
        if path == '/api/panel/pool/stream':
            return route.fulfill(content_type='text/event-stream', body=': fixture\n\n')
        if path == '/api/panel/login-credentials':
            return reply(route, {'credentials': []})
        if path.startswith('/api/panel/vms/') and '/oauth/login' in path:
            vm_id = path.split('/')[4]
            suffix = path.split('/oauth/login', 1)[1]
            if request.method == 'GET':
                return reply(route, login_state(vm_id))
            calls.append((vm_id, suffix, request.post_data_json))
            assert vm_id == 'vm-03', 'Resting slot must never receive a mutation'
            if suffix == '/session':
                return route.fulfill(content_type='application/json', headers={'content-disposition': 'attachment; filename="vm-03-chatgpt-session.json"'}, body=json.dumps(session))
            if suffix == '/subscription':
                value = request.post_data_json.get('enabled', True)
                state = {'enabled': value, 'period_end': '2030-12-01T00:00:00Z', 'checked_at': '2026-10-25T00:00:00Z'}
                login_state(vm_id)['subscription'] = state
                return reply(route, state)
            raise AssertionError('Unexpected slot mutation blocked')
        response = fetch_readonly(route)
        if path in ['/api/panel/onboarding', '/api/panel/me', '/api/panel/vms']:
            body = response.json()
            data = body.get('data', body)
            if path.endswith('/onboarding'):
                data['guide_used'] = True
            elif path.endswith('/me'):
                data['role'] = role
            else:
                for vm in data.get('items', []):
                    if vm['id'] in ['vm-03', 'vm-10']:
                        vm['email'] = session['user']['email'] if vm['id'] == 'vm-03' else ''
                        vm['name'] = vm['id']
                        vm['schedulable'] = vm['id'] == 'vm-03'
            return route.fulfill(response=response, json=body)
        return route.fulfill(response=response)

    context.route('**/*', handle)
    page = context.new_page()
    page.on('pageerror', lambda _: errors.append('pageerror'))
    base = payload.get('base', 'http://172.18.0.1:8787')
    page.goto(base + '/cc#/vm', wait_until='domcontentloaded')
    page.get_by_role('button', name='更多操作 vm-10', exact=True).wait_for()
    assert calls == []
    page.get_by_role('button', name='更多操作 vm-10', exact=True).click()
    expect(page.get_by_role('menuitem', name='导出 ChatGPT Session', exact=True)).to_be_disabled()
    page.get_by_role('menuitem', name='自动付费续订', exact=True).click()
    expect(page.get_by_role('switch', name='自动付费续订套餐', exact=True)).to_be_disabled()
    expect(page.get_by_role('button', name='读取官网状态', exact=True)).to_be_disabled()
    page.get_by_text('槽位已关闭调度，保持静置；', exact=False).wait_for()
    assert calls == []
    page.keyboard.press('Escape')
    page.get_by_role('button', name='更多操作 vm-03', exact=True).click()
    page.screenshot(path=str(output / 'slot-menu-desktop.png'), full_page=True)
    with page.expect_download() as info:
        page.get_by_role('menuitem', name='导出 ChatGPT Session', exact=True).click()
    info.value.save_as(str(output / 'slot-menu-fixture-session.json'))
    assert json.loads((output / 'slot-menu-fixture-session.json').read_text()) == session
    assert calls == [('vm-03', '/session', {})]
    page.get_by_role('button', name='更多操作 vm-03', exact=True).click()
    page.get_by_role('menuitem', name='自动付费续订', exact=True).click()
    page.get_by_role('heading', name='自动付费续订 · vm-03', exact=True).wait_for()
    assert len(calls) == 1
    page.get_by_role('button', name='读取官网状态', exact=True).click()
    switch = page.get_by_role('switch', name='自动付费续订套餐', exact=True)
    expect(switch).to_be_checked()
    switch.click()
    expect(switch).not_to_be_checked()
    assert calls[-1] == ('vm-03', '/subscription', {'enabled': False})
    page.screenshot(path=str(output / 'slot-menu-renewal.png'), full_page=True)
    page.keyboard.press('Escape')
    count = len(calls)
    page.get_by_role('button', name='查看 vm-03 详情', exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_text('绑定的登录凭据', exact=True).wait_for()
    dialog.get_by_role('button', name='导出 ChatGPT Session', exact=True).wait_for()
    dialog.get_by_role('switch', name='自动付费续订套餐', exact=True).wait_for()
    assert len(calls) == count
    page.screenshot(path=str(output / 'slot-card-dialog.png'), full_page=True)
    page.keyboard.press('Escape')
    saved = login_state('vm-03')['subscription']
    login_state('vm-03')['subscription'] = None
    login_state('vm-03')['state']['error_code'] = 'session_not_authenticated'
    page.reload(wait_until='domcontentloaded')
    page.get_by_role('button', name='更多操作 vm-03', exact=True).click()
    page.get_by_role('menuitem', name='自动付费续订', exact=True).click()
    page.get_by_role('alert').filter(has_text='此槽位尚未登录 ChatGPT 网页').wait_for()
    expect(page.get_by_role('link', name='前往槽位登录 / 远程浏览器', exact=True)).to_be_visible()
    expect(page.get_by_role('switch', name='自动付费续订套餐', exact=True)).to_be_disabled()
    assert len(calls) == count, 'Opening saved browser errors must not start login or billing reads'
    page.keyboard.press('Escape')
    login_state('vm-03')['subscription'] = saved
    login_state('vm-03')['state'].pop('error_code')
    page.set_viewport_size({'width': 390, 'height': 900})
    page.get_by_role('button', name='更多操作 vm-03', exact=True).click()
    expect(page.get_by_role('menuitem', name='导出 ChatGPT Session', exact=True)).to_be_visible()
    expect(page.get_by_role('menuitem', name='自动付费续订', exact=True)).to_be_visible()
    page.screenshot(path=str(output / 'slot-menu-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Mobile overflow'
    page.keyboard.press('Escape')
    for current_role in ['user', 'super']:
        role = current_role
        page.reload(wait_until='domcontentloaded')
        page.get_by_role('button', name='更多操作 vm-03', exact=True).click()
        item = page.get_by_role('menuitem', name='导出 ChatGPT Session', exact=True)
        if role == 'user':
            expect(item).to_be_visible()
        else:
            expect(item).to_have_count(0)
            expect(page.get_by_role('menuitem', name='自动付费续订', exact=True)).to_have_count(0)
        page.keyboard.press('Escape')
    assert len(calls) == count
    assert not errors
    print('Slot menu passed: direct Session download, renewal dialog/switch, idle-slot guard, card detail, mobile and role visibility; no real mutation.')
    context.close(); browser.close()
