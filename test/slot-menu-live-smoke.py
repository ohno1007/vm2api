"""Read-only verification of the deployed slot action menu."""
import json
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

payload = json.loads(sys.stdin.readline())
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    context.add_init_script('localStorage.setItem("kin_console_token", ' + json.dumps(payload['token']) + ');')
    errors = []
    def handle(route):
        assert route.request.method in ['GET', 'HEAD'], 'Mutation blocked in live verification'
        path = urlparse(route.request.url).path
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
    context.route('**/*', handle)
    page = context.new_page()
    page.on('pageerror', lambda _: errors.append('pageerror'))
    page.goto('http://172.18.0.1:8787/cc#/vm', wait_until='domcontentloaded')
    page.get_by_role('button', name='更多操作 vm-10', exact=True).click()
    expect(page.get_by_role('menuitem', name='导出 ChatGPT Session', exact=True)).to_be_visible()
    page.get_by_role('menuitem', name='自动付费续订', exact=True).click()
    page.get_by_role('heading', name='自动付费续订 · vm-10', exact=True).wait_for()
    expect(page.get_by_role('switch', name='自动付费续订套餐', exact=True)).to_be_visible()
    page.keyboard.press('Escape')
    page.get_by_role('button', name='查看 vm-10 详情', exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('button', name='导出 ChatGPT Session', exact=True).wait_for()
    dialog.get_by_role('switch', name='自动付费续订套餐', exact=True).wait_for()
    assert not errors
    print('Live slot menu and card detail show Session export and renewal switch; no POST, login, billing read or payment.')
    context.close(); browser.close()
