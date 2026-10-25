"""Read-only UI verification; token is received over stdin and never recorded."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

payload = json.loads(sys.stdin.readline())
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1100})
    context.add_init_script('localStorage.setItem("kin_console_token", ' + json.dumps(payload['token']) + ');')
    # The test uses a master key, which has no user's completed guide record.
    # Suppress that UI-only redirect without modifying server onboarding state.
    def onboarding(route):
        response = route.fetch()
        data = response.json()
        data.get('data', data)['guide_used'] = True
        route.fulfill(response=response, json=data)
    context.route('**/api/panel/onboarding', onboarding)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda _e: errors.append('pageerror'))
    page.goto(payload.get('base', 'http://127.0.0.1:8787') + '/cc#/vm/vm-03', wait_until='domcontentloaded')
    try:
        page.get_by_role('tab', name='账号', exact=True).click(timeout=15000)
    except Exception:
        print('UI location:', page.url)
        print('UI tab labels:', page.get_by_role('tab').all_text_contents())
        print('UI heading labels:', page.get_by_role('heading').all_text_contents())
        raise
    page.get_by_role('tab', name='微软邮箱', exact=True).click(timeout=15000)
    password = page.get_by_label('微软邮箱密码', exact=True)
    password.wait_for(state='visible')
    assert password.input_value() == ''
    assert password.get_attribute('type') == 'password'
    assert page.get_by_role('button', name='保存并登录授权', exact=True).is_disabled()
    panel = password.locator('../..')
    output = Path(payload.get('output', '/tmp'))
    panel.screenshot(path=str(output / 'mailbox-desktop.png'))
    page.set_viewport_size({'width': 390, 'height': 1000})
    page.wait_for_timeout(300)
    assert panel.bounding_box()['width'] <= 390
    panel.screenshot(path=str(output / 'mailbox-mobile.png'))
    assert not errors, 'Frontend browser error'
    print('Mailbox form renders at desktop and mobile sizes; blank password and safe disabled submit verified.')
    context.close()
    browser.close()
