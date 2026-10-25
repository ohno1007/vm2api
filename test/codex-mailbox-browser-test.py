"""Offline browser fixtures: all MS/OpenAI requests served locally by route()."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('mailbox', ROOT / 'scripts/codex-mailbox-browser.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class PureTests(unittest.TestCase):
    def test_rfc6238_six_digit_totp_vectors(self):
        secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
        for timestamp, expected in [(59, '287082'), (1111111109, '081804'), (1111111111, '050471'),
                                    (1234567890, '005924'), (2000000000, '279037'), (20000000000, '353130')]:
            self.assertEqual(mod.totp_code(secret, timestamp), expected)

    def test_navigation_restricted_to_provider_https(self):
        self.assertTrue(mod.safe_navigation('https://chatgpt.com/'))
        for url in ['http://chatgpt.com/', 'https://127.0.0.1/', 'file:///etc/passwd', 'https://chatgpt.com.evil.example/', 'https://x:y@chatgpt.com/', 'https://chatgpt.com:8443/']:
            self.assertFalse(mod.safe_navigation(url))

    def test_callback_origin_state_and_code(self):
        good = 'http://localhost:1455/auth/callback?state=fixture&code=ok'
        self.assertEqual(mod.callback_value(good, 'fixture'), good)
        self.assertIsNone(mod.callback_value(good.replace('localhost', 'evil.example'), 'fixture'))
        self.assertIsNone(mod.callback_value(good.replace(':1455', ':bad'), 'fixture'))
        with self.assertRaisesRegex(mod.FlowError, 'oauth_state_mismatch'):
            mod.callback_value(good, 'wrong')

    def test_codes_exactly_six_digits(self):
        self.assertEqual(mod.codes('12345 123456 1234567 999888'), {'123456', '999888'})

    def test_subscription_requires_recognized_existing_paid_period(self):
        self.assertTrue(mod.subscription_state('ChatGPT Plus\nNext payment: December 1, 2030', now=1)['enabled'])
        self.assertFalse(mod.subscription_state('ChatGPT Pro\nCancels on December 1, 2030', now=1)['enabled'])
        for text in ['ChatGPT Plus trial', 'Other Service\nNext payment December 1, 2030',
                     'ChatGPT Plus\nNext payment December 1, 2000', 'ChatGPT Plus\nPast due',
                     'ChatGPT Plus\nNext payment December 1, 2030\nCancels on December 1, 2030']:
            with self.assertRaises(mod.FlowError):
                mod.subscription_state(text)
        self.assertTrue(mod.billing_portal_url('https://billing.stripe.com/p/session/fixture'))
        for url in ['https://billing.stripe.com.evil.example/p/session/fixture', 'https://pay.openai.com/c/pay/fixture',
                    'https://checkout.stripe.com/p/session/fixture', 'https://user@billing.stripe.com/p/session/fixture']:
            self.assertFalse(mod.billing_portal_url(url))


class BrowserFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.context.set_default_timeout(3000)
        self.logged = False
        self.requested = False
        self.received_password = None
        self.seen_code = None
        self.mode = 'success'
        self.context.route('**/*', self.route)
        self.flow = mod.BrowserLogin({'email': 'fixture@outlook.com', 'password': 'mailbox-fixture-secret',
            'auth_url': 'https://auth.openai.com/start', 'state': 'fixture', 'timeout_sec': 60})
        self.flow.pause = lambda page, milliseconds=750: (self.flow.check(), page.wait_for_timeout(25))

    def tearDown(self):
        self.context.close()

    @staticmethod
    def form(action, field, kind='text', label='Continue'):
        return f'<form action="{action}"><input name="{field}" type="{kind}"><button type="submit">{label}</button></form>'

    def route(self, route):
        u = urlparse(route.request.url)
        q = parse_qs(u.query)
        if u.hostname == 'outlook.live.com':
            if not self.logged:
                return route.fulfill(content_type='text/html', body='<script>location.href="https://login.live.com/email"</script>')
            # Old messages have a code only in the body. Baseline must exclude
            # them, including Junk. The new code arrives in Junk after request.
            body = '<div role="treeitem">Inbox</div><div role="option" data-convid="old">OpenAI old sign in</div>'
            if self.requested and u.path.endswith('junkemail'):
                body += '<div role="option" data-convid="new">OpenAI verification code 111222</div>'
            body += '<div email="noreply@tm.openai.com">OpenAI</div><div role="document">654321</div>'
            return route.fulfill(content_type='text/html', body=body)
        if u.hostname == 'login.live.com':
            if u.path == '/email':
                body = self.form('https://login.live.com/password', 'loginfmt', 'email')
            elif u.path == '/password':
                body = self.form('https://login.live.com/complete', 'passwd', 'password')
            else:
                self.received_password = q.get('passwd', [''])[0]
                if self.mode == 'bad_password':
                    body = '<p>Your password is incorrect</p>'
                else:
                    self.logged = True
                    return route.fulfill(content_type='text/html', body='<script>location.href="https://outlook.live.com/mail/0/inbox"</script>')
            return route.fulfill(content_type='text/html', body=body)
        if u.hostname == 'auth.openai.com':
            if u.path == '/start':
                body = self.form('https://auth.openai.com/password', 'email', 'email')
            elif u.path == '/password':
                body = '<input type="password" id="gpt-password">'
                if self.mode != 'no_email_code':
                    body += '<a href="https://auth.openai.com/otp">Email me a one-time code</a>'
            elif u.path == '/otp':
                self.requested = True
                body = self.form('https://auth.openai.com/consent', 'code')
            elif u.path == '/consent':
                self.seen_code = q.get('code', [''])[0]
                body = '<p>Authorize Codex</p><a role="button" href="http://localhost:1455/auth/callback?state=fixture&code=mock-authorization">Allow</a>'
            else:
                body = '<p>Unknown fixture</p>'
            return route.fulfill(content_type='text/html', body=body)
        return route.abort()

    def test_mailbox_password_otp_consent_callback(self):
        self.flow.open_mailbox(self.context)
        self.assertEqual(self.received_password, 'mailbox-fixture-secret')
        result = self.flow.authorize(self.context)
        self.assertIn('code=mock-authorization', result)
        self.assertEqual(self.seen_code, '111222')
        self.assertIn(('old', 'OpenAI old sign in'), self.flow.baseline_messages)
        self.assertIn('654321', self.flow.used_codes)

    def test_microsoft_rejected_password_is_controlled_error(self):
        self.mode = 'bad_password'
        with self.assertRaisesRegex(mod.FlowError, 'mailbox_password_rejected'):
            self.flow.open_mailbox(self.context)

    def test_never_fills_mailbox_password_in_gpt_password_form(self):
        self.mode = 'no_email_code'
        self.flow.open_mailbox(self.context)
        with self.assertRaisesRegex(mod.FlowError, 'openai_email_code_unavailable'):
            self.flow.authorize(self.context)
        auth = self.context.pages[-1]
        self.assertEqual(auth.locator('#gpt-password').input_value(), '')

    def test_gpt_password_totp_and_oauth_consent(self):
        self.context.unroute('**/*')
        seen = {}
        def route(request):
            u = urlparse(request.request.url)
            q = parse_qs(u.query)
            if u.path == '/start':
                body = self.form('https://auth.openai.com/password', 'email', 'email')
            elif u.path == '/password':
                seen['email'] = q.get('email', [''])[0]
                body = self.form('https://auth.openai.com/mfa', 'password', 'password')
            elif u.path == '/mfa':
                seen['password'] = q.get('password', [''])[0]
                body = '<p>Authenticator two-factor verification</p>' + self.form('https://auth.openai.com/consent', 'code')
            elif u.path == '/consent':
                seen['totp'] = q.get('code', [''])[0]
                body = '<p>Authorize Codex</p><a role="button" href="http://localhost:1455/auth/callback?state=fixture&code=mock-authorization">Allow</a>'
            else:
                return request.abort()
            request.fulfill(content_type='text/html', body=body)
        self.context.route('**/*', route)
        self.flow.mode = 'password_totp'
        self.flow.password = 'GPT-only-fixture'
        self.flow.payload['totp_secret'] = 'JBSWY3DPEHPK3PXP'
        self.flow.authorize(self.context)
        self.assertEqual(seen['email'], self.flow.email)
        self.assertEqual(seen['password'], 'GPT-only-fixture')
        self.assertRegex(seen['totp'], r'^\d{6}$')
        self.assertTrue(self.flow.callback)

    def test_web_login_returns_actual_authenticated_session(self):
        self.context.unroute('**/*')
        logged = [False]
        def route(request):
            u = urlparse(request.request.url)
            if u.path == '/api/auth/session':
                return request.fulfill(content_type='application/json', body=json.dumps({'user': {'email': self.flow.email}, 'accessToken': 'web-fixture'} if logged[0] else {}))
            if u.hostname == 'chatgpt.com' and not logged[0]:
                body = '<a role="button" href="https://auth.openai.com/password">Log in</a>'
            elif u.path == '/password':
                body = self.form('https://auth.openai.com/complete', 'password', 'password')
            elif u.path == '/complete':
                self.assertEqual(parse_qs(u.query).get('password'), ['GPT-web-fixture'])
                logged[0] = True
                body = '<script>location.href="https://chatgpt.com/"</script>'
            else:
                body = '<p>Authenticated ChatGPT fixture</p>'
            request.fulfill(content_type='text/html', body=body)
        self.context.route('**/*', route)
        self.flow.mode = 'password_totp'
        self.flow.password = 'GPT-web-fixture'
        self.flow.now = lambda: time.monotonic() * 100
        self.flow.deadline = self.flow.now() + 6000
        session = self.flow.authorize(self.context, web=True)
        self.assertEqual(session['accessToken'], 'web-fixture')

    def test_remote_screen_input_and_real_session_response(self):
        self.context.unroute('**/*')
        fixture = {'user': {'email': self.flow.email}, 'accessToken': 'fixture-session-only', 'expires': '2030-01-01T00:00:00Z'}
        def route(request):
            if urlparse(request.request.url).path == '/api/auth/session':
                request.fulfill(content_type='application/json', body=json.dumps(fixture))
            else:
                request.fulfill(content_type='text/html', body='<input id="value"><button onclick="document.body.dataset.clicked=1">Click</button>')
        self.context.route('**/*', route)
        page = self.context.new_page()
        page.goto('https://chatgpt.com/')
        self.flow.context = self.context
        self.flow.active_page = page
        self.flow.remote = True
        box = page.locator('#value').bounding_box()
        self.flow.control({'op': 'click', 'x': box['x'] + 5, 'y': box['y'] + 5})
        self.flow.control({'op': 'text', 'text': 'remote fixture'})
        self.assertEqual(page.locator('#value').input_value(), 'remote fixture')
        self.flow.control({'op': 'key', 'key': 'Control+A'})
        self.flow.control({'op': 'text', 'text': 'replacement'})
        self.assertEqual(page.locator('#value').input_value(), 'replacement')
        frame = self.flow.control({'op': 'frame'})
        self.assertGreater(len(frame['image']), 1000)
        self.assertEqual(self.flow.control({'op': 'session'}), fixture)
        fixture['user']['email'] = 'another@example.com'
        with self.assertRaisesRegex(mod.FlowError, 'authorized_email_mismatch'):
            self.flow.control({'op': 'session'})
        with self.assertRaisesRegex(mod.FlowError, 'browser_url_not_allowed'):
            self.flow.control({'op': 'navigate', 'url': 'https://127.0.0.1/'})
        self.flow.remote = False
        with self.assertRaisesRegex(mod.FlowError, 'takeover_required'):
            self.flow.control({'op': 'text', 'text': 'blocked'})

    def subscription_fixture(self, immediate_charge=False, expired=False):
        self.context.unroute('**/*')
        state = {'enabled': True, 'changes': 0}
        portal = 'https://billing.stripe.com/p/session/fixture'
        def route(request):
            u = urlparse(request.request.url)
            if u.hostname == 'chatgpt.com':
                if u.path == '/api/auth/session':
                    return request.fulfill(content_type='application/json', body=json.dumps({'user': {'email': self.flow.email}, 'accessToken': 'fixture-web-session'}))
                return request.fulfill(content_type='text/html', body='<div role="dialog"><h2>Account</h2><p>ChatGPT Plus subscription</p><a href="' + portal + '">Manage subscription</a></div>')
            if u.hostname == 'billing.stripe.com':
                if u.path.endswith('/apply'):
                    state['enabled'] = parse_qs(u.query)['enabled'][0] == 'true'
                    state['changes'] += 1
                    return request.fulfill(content_type='text/html', body='<script>location.href=' + json.dumps(portal) + '</script>')
                if u.path.endswith('/confirm'):
                    desired = parse_qs(u.query)['enabled'][0]
                    text = 'Resume subscription' if desired == 'true' else 'Cancel at the end of the current billing period; access until December 1, 2030.'
                    if immediate_charge:
                        text += ' Amount due today. Pay now.'
                    label = 'Resume subscription' if desired == 'true' else 'Cancel subscription'
                    body = '<p>ChatGPT Plus</p><p>' + text + '</p><a role="button" href="' + portal + '/apply?enabled=' + desired + '">' + label + '</a>'
                else:
                    date = 'December 1, 2000' if expired else 'December 1, 2030'
                    label = 'Cancel subscription' if state['enabled'] else 'Resume subscription'
                    text = 'Next payment: ' if state['enabled'] else 'Cancels on '
                    desired = 'false' if state['enabled'] else 'true'
                    body = '<h1>ChatGPT Plus</h1><p>' + text + date + '</p><a role="button" href="' + portal + '/confirm?enabled=' + desired + '">' + label + '</a>'
                return request.fulfill(content_type='text/html', body=body)
            return request.abort()
        self.context.route('**/*', route)
        self.flow.context = self.context
        self.flow.remote = True
        self.flow.active_page = self.context.new_page()
        return state

    def test_subscription_read_cancel_at_period_end_and_resume_are_verified(self):
        state = self.subscription_fixture()
        self.assertTrue(self.flow.manage_subscription()['enabled'])
        self.assertEqual(state['changes'], 0)
        self.flow.payload['enabled'] = False
        self.assertFalse(self.flow.manage_subscription()['enabled'])
        self.assertEqual(state['changes'], 1)
        self.flow.payload['enabled'] = True
        self.assertTrue(self.flow.manage_subscription()['enabled'])
        self.assertEqual(state['changes'], 2)
        self.assertTrue(self.flow.manage_subscription()['enabled'])
        self.assertEqual(state['changes'], 2)

    def test_subscription_stops_before_immediate_payment_or_expired_period(self):
        state = self.subscription_fixture(immediate_charge=True)
        self.flow.payload['enabled'] = False
        with self.assertRaisesRegex(mod.FlowError, 'subscription_needs_attention'):
            self.flow.manage_subscription()
        self.assertEqual(state['changes'], 0)
        state = self.subscription_fixture(expired=True)
        with self.assertRaisesRegex(mod.FlowError, 'subscription_period_ended'):
            self.flow.manage_subscription()
        self.assertEqual(state['changes'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
