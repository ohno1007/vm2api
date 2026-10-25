"""Read-only verification of deployed UI; never import, bind or log in."""
import json
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

payload = json.loads(sys.stdin.readline())
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    context.add_init_script('localStorage.setItem("kin_console_token", ' + json.dumps(payload['token']) + ');')
    errors = []
    def route_request(route):
        request = route.request
        assert request.method in ['GET', 'HEAD'], 'Unexpected mutation blocked'
        path = urlparse(request.url).path
        if path == '/api/panel/pool/stream':
            return route.fulfill(content_type='text/event-stream', body=': live-smoke\n\n')
        try:
            response = route.fetch()
        except Exception:
            errors.append('request-failed')
            return route.abort()
        if path == '/api/panel/onboarding':
            body = response.json()
            body.get('data', body)['guide_used'] = True
            return route.fulfill(response=response, json=body)
        return route.fulfill(response=response)
    context.route('**/*', route_request)
    page = context.new_page()
    page.on('pageerror', lambda _: errors.append('pageerror'))
    base = payload.get('base', 'http://172.18.0.1:8787')
    page.goto(base + '/cc#/credentials', wait_until='domcontentloaded')
    page.get_by_role('heading', name='账号池', exact=True).wait_for()
    assert page.get_by_label('批量账号凭据').input_value() == ''
    assert 'https://2fa.run/2fa/' in page.get_by_label('批量账号凭据').get_attribute('placeholder')
    assert '微软邮箱---邮箱密码' in page.get_by_label('批量账号凭据').get_attribute('placeholder')
    page.get_by_text('系统从链接提取密钥', exact=False).wait_for()
    assert page.get_by_role('button', name='仅导入凭据', exact=True).is_disabled()
    page.screenshot(path=str(Path(payload['output']) / 'live-credential-pool.png'), full_page=True)
    page.goto(base + '/cc#/vm/vm-03', wait_until='domcontentloaded')
    page.get_by_text('绑定的登录凭据', exact=True).wait_for()
    page.get_by_role('button', name='登录', exact=True).wait_for()
    page.get_by_role('button', name='打开远程浏览器', exact=True).wait_for()
    page.get_by_role('button', name='导出 ChatGPT Session', exact=True).wait_for()
    page.get_by_role('switch', name='自动付费续订套餐', exact=True).wait_for()
    page.get_by_role('button', name='读取官网状态', exact=True).wait_for()
    page.screenshot(path=str(Path(payload['output']) / 'live-credential-vm.png'), full_page=True)
    assert not errors, 'Deployed UI browser error'
    print('Deployed 2FA-link import help, account pool and VM login panels render; no mutation or browser login was performed.')
    context.close();browser.close()
