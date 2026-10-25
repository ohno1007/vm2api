#!/usr/bin/env python3
"""Runs in the selected Linux slot. Passwords arrive over stdin, never argv."""
import base64
import hmac
import struct
import hashlib
import json
import os
import queue
import re
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, parse_qs

MS_HOSTS = {'login.live.com', 'login.microsoftonline.com', 'account.live.com'}
MAIL_HOSTS = {'outlook.live.com', 'outlook.office.com', 'outlook.office365.com'}
OPENAI_HOSTS = {'auth.openai.com', 'auth0.openai.com', 'chatgpt.com'}
OTP_INPUT = 'input[autocomplete="one-time-code"]:visible, input[name="code"]:visible, input[name="otc"]:visible, input[name="otp"]:visible, input[name="totp"]:visible, input[name="mfa_code"]:visible, input[id="idTxtBx_SAOTCC_OTC"]:visible, input[inputmode="numeric"]:visible'


class FlowError(Exception):
    pass


def emit(stage, **data):
    print(json.dumps({'event': 'stage', 'stage': stage, **data}), flush=True)


def host(page):
    return (urlparse(page.url).hostname or '').lower()


def codes(text):
    return set(re.findall(r'(?<!\d)(\d{6})(?!\d)', str(text)))


def callback_value(url, state):
    parsed = urlparse(url)
    try:
        valid = parsed.scheme == 'http' and parsed.hostname == 'localhost' and parsed.port == 1455 and parsed.path == '/auth/callback' and not parsed.username and not parsed.password
    except ValueError:
        valid = False
    if not valid:
        return None
    params = parse_qs(parsed.query)
    if params.get('state', [''])[0] != state:
        raise FlowError('oauth_state_mismatch')
    if params.get('error'):
        raise FlowError('oauth_denied')
    return url if params.get('code', [''])[0] else None


def fill_otp(page, code):
    if not re.fullmatch(r'[A-Za-z0-9-]{4,12}', code):
        raise FlowError('invalid_verification_code')
    digits = page.locator('input[maxlength="1"]:visible')
    if digits.count() >= len(code):
        for index, char in enumerate(code):
            digits.nth(index).fill(char)
        return True
    single = page.locator(OTP_INPUT).first
    if single.count():
        single.fill(code)
        return True
    return False


def totp_code(secret, timestamp=None):
    try:
        raw = base64.b32decode(secret.upper() + '=' * ((8 - len(secret) % 8) % 8))
        counter = int(time.time() if timestamp is None else timestamp) // 30
        digest = hmac.new(raw, struct.pack('>Q', counter), hashlib.sha1).digest()
        offset = digest[-1] & 15
        return str((struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000).zfill(6)
    except Exception:
        raise FlowError('invalid_totp_secret')


def safe_navigation(url):
    try:
        parsed = urlparse(url)
        return billing_portal_url(url) or (parsed.scheme == 'https' and parsed.hostname in OPENAI_HOSTS | MS_HOSTS | MAIL_HOSTS | {'www.chatgpt.com', 'login.microsoft.com'} and not parsed.username and not parsed.password and parsed.port in (None, 443))
    except ValueError:
        return False


def billing_portal_url(url):
    try:
        parsed = urlparse(url)
        return parsed.scheme == 'https' and parsed.hostname in {'billing.stripe.com', 'pay.openai.com'} and parsed.path.startswith('/p/session/') and not parsed.username and not parsed.password and parsed.port in (None, 443)
    except ValueError:
        return False


def subscription_state(text, now=None):
    """Recognize an existing paid subscription with a future billing/end date."""
    if not re.search(r'chatgpt\s+(?:plus|pro|go)\b', text, re.I):
        raise FlowError('subscription_paid_plan_required')
    if re.search(r'past due|unpaid|payment failed|subscription has ended|no active subscriptions|free trial|逾期|付款失败|试用', text, re.I):
        raise FlowError('subscription_needs_attention')
    date = r'([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{4}年\d{1,2}月\d{1,2}日)'
    patterns = [(False, r'(?:cancels?|will be canceled|will be cancelled|ends?|expires?)\s*(?:on)?\s*:?\s*' + date),
                (True, r'(?:renews?(?:\s+on)?|next\s+(?:payment|invoice|billing date)(?:\s+is|\s+on)?)\s*:?\s*' + date),
                (False, r'(?:将于|到期日|结束日期)\s*:?\s*' + date),
                (True, r'(?:下次付款|下次账单|续订日期)\s*:?\s*' + date)]
    found = []
    for enabled, pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            value = match[1].replace(',', '')
            end = None
            for fmt in ['%B %d %Y', '%b %d %Y', '%Y-%m-%d', '%Y年%m月%d日']:
                try:
                    end = datetime.strptime(value, fmt).replace(tzinfo=timezone.utc)
                    break
                except ValueError:
                    pass
            if end is not None:
                found.append((enabled, end))
    if not found or len(set(found)) != 1:
        raise FlowError('subscription_status_unrecognized')
    enabled, end = found[0]
    if end.timestamp() <= (time.time() if now is None else now):
        raise FlowError('subscription_period_ended')
    return {'enabled': enabled, 'period_end': end.isoformat()}


class BrowserLogin:
    def __init__(self, payload, controls=None, now=time.monotonic):
        self.payload = payload
        self.email = payload.get('email', '')
        self.password = payload.get('password', '')
        self.mode = payload.get('mode', 'microsoft_mailbox')
        self.remote = payload.get('remote', False)
        self.context = None
        self.active_page = None
        self.paused = False
        self.codes_queue = queue.Queue()
        self.last_control = now()
        self.now = now
        self.deadline = now() + (1800 if payload.get('remote') else min(480, int(payload.get('timeout_sec', 480))))
        self.controls = controls or queue.Queue()
        self.callback = None
        self.used_codes = set()
        self.baseline_messages = set()
        self.ms_submits = {}
        self.mail = None

    def check(self):
        if self.now() >= self.deadline:
            raise FlowError('login_timeout')
        self.pump_controls()
        while self.paused:
            if self.now() >= self.deadline:
                raise FlowError('login_timeout')
            self.pump_controls()
            pages = [p for p in self.context.pages if not p.is_closed()] if self.context else []
            if pages:
                pages[0].wait_for_timeout(100)
            else:
                time.sleep(0.1)

    def pump_controls(self):
        for _ in range(16):
            try:
                message = self.controls.get_nowait()
            except queue.Empty:
                break
            if message.get('verification_code'):
                self.codes_queue.put(message)
                continue
            request_id = message.get('id')
            if not request_id or not self.context:
                continue
            self.last_control = self.now()
            try:
                data = self.control(message)
                print(json.dumps({'event': 'rpc', 'id': request_id, 'ok': True, 'data': data}), flush=True)
            except Exception as error:
                code = str(error) if isinstance(error, FlowError) else 'browser_control_failed'
                print(json.dumps({'event': 'rpc', 'id': request_id, 'ok': False, 'error_code': code}), flush=True)

    def control(self, message):
        op = message.get('op')
        pages = [p for p in self.context.pages if not p.is_closed()]
        page = self.active_page if self.active_page in pages else (pages[-1] if pages else self.context.new_page())
        self.active_page = page
        if op == 'frame':
            tabs = []
            for index, tab in enumerate(self.context.pages):
                parsed = urlparse(tab.url)
                tabs.append({'index': index, 'url': parsed.scheme + '://' + (parsed.hostname or '') + parsed.path})
            return {'image': base64.b64encode(page.screenshot(type='jpeg', quality=55, timeout=6000)).decode(),
                    'width': 1365, 'height': 900, 'tabs': tabs, 'active': self.context.pages.index(page), 'paused': self.paused}
        if op == 'takeover':
            self.paused = True
            emit('manual_control')
            return {'paused': True}
        if op == 'resume':
            self.paused = False
            emit('openai_login' if not self.remote else 'remote_ready')
            return {'paused': False}
        if op == 'session':
            if not self.remote and not self.paused:
                raise FlowError('takeover_required')
            if not safe_navigation(page.url) or host(page) not in {'chatgpt.com', 'www.chatgpt.com'}:
                page = self.context.new_page()
                self.active_page = page
                page.goto('https://chatgpt.com/', wait_until='domcontentloaded', timeout=30000)
            result = page.evaluate("""async () => {
                const r = await fetch('https://chatgpt.com/api/auth/session', {credentials:'include',cache:'no-store',redirect:'error'});
                if (!r.ok || !r.headers.get('content-type')?.includes('json')) return null;
                const text = await r.text(); if (text.length > 524288) return null;
                return JSON.parse(text);
            }""")
            if not isinstance(result, dict) or not result.get('accessToken') or not isinstance(result.get('user'), dict):
                raise FlowError('session_not_authenticated')
            actual = str(result['user'].get('email') or '').lower()
            if self.email and actual != self.email.lower():
                raise FlowError('authorized_email_mismatch')
            return result
        if op == 'tab':
            index = message.get('index')
            if not isinstance(index, int) or index < 0 or index >= len(self.context.pages):
                raise FlowError('invalid_browser_tab')
            self.active_page = self.context.pages[index]
            self.active_page.bring_to_front()
            return {}
        if not self.remote and not self.paused:
            raise FlowError('takeover_required')
        if op == 'navigate':
            url = str(message.get('url', ''))
            if not safe_navigation(url):
                raise FlowError('browser_url_not_allowed')
            page.goto(url, wait_until='domcontentloaded', timeout=30000)
        elif op == 'click':
            x, y = message.get('x'), message.get('y')
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not 0 <= x < 1365 or not 0 <= y < 900:
                raise FlowError('invalid_browser_coordinates')
            page.mouse.click(x, y, button=message.get('button', 'left'))
        elif op == 'wheel':
            page.mouse.wheel(max(-2000, min(2000, float(message.get('x', 0)))), max(-2000, min(2000, float(message.get('y', 0)))))
        elif op == 'key':
            key = str(message.get('key', ''))
            if not re.fullmatch(r'(?:Control\+|Alt\+|Shift\+|Meta\+){0,3}(?:[A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)', key):
                raise FlowError('invalid_browser_key')
            page.keyboard.press(key)
        elif op == 'text':
            text = message.get('text')
            if not isinstance(text, str) or len(text) > 4096:
                raise FlowError('invalid_browser_text')
            page.keyboard.insert_text(text)
        elif op == 'reload':
            page.reload(wait_until='domcontentloaded', timeout=30000)
        elif op == 'back':
            page.go_back(wait_until='domcontentloaded', timeout=30000)
        else:
            raise FlowError('invalid_browser_operation')
        return {}

    def pause(self, page, milliseconds=750):
        self.check()
        page.wait_for_timeout(milliseconds)
        self.check()

    def subscription_portal(self):
        # Identity must be verified from the actual ChatGPT session first.
        self.control({'op': 'session'})
        page = self.active_page
        emit('opening_subscription')
        page.goto('https://chatgpt.com/#settings/Account', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_timeout(1200)
        dialog = page.get_by_role('dialog').last
        if not dialog.count():
            profile = page.locator('[data-testid="profile-button"], [data-testid="accounts-profile-button"]').first
            if not profile.count():
                raise FlowError('subscription_portal_unavailable')
            profile.click(timeout=5000)
            if not self.click(page, [r'^Settings$|^设置$']):
                raise FlowError('subscription_portal_unavailable')
            page.wait_for_timeout(700)
            dialog = page.get_by_role('dialog').last
        if not dialog.count():
            raise FlowError('subscription_portal_unavailable')
        for role in ['tab', 'button']:
            account = dialog.get_by_role(role, name=re.compile(r'^(Account|Subscription|账户|账号|订阅)$', re.I)).first
            if account.count():
                account.click(timeout=5000)
                page.wait_for_timeout(500)
                break
        text = dialog.inner_text(timeout=5000)
        if not re.search(r'chatgpt\s+(?:plus|pro|go)|subscription|billing|订阅|账单', text, re.I):
            raise FlowError('subscription_paid_plan_required')
        targets = dialog.get_by_role('button', name=re.compile(r'^(Manage|Manage subscription|Manage plan|管理|管理订阅|管理套餐)$', re.I))
        links = dialog.get_by_role('link', name=re.compile(r'^(Manage|Manage subscription|Manage plan|管理|管理订阅|管理套餐)$', re.I))
        available = [locator.nth(i) for locator in [targets, links] for i in range(locator.count()) if locator.nth(i).is_visible()]
        if len(available) != 1:
            raise FlowError('subscription_portal_unavailable')
        href = available[0].get_attribute('href')
        if href and not (billing_portal_url(href) or href.startswith('/') or safe_navigation(href)):
            raise FlowError('subscription_portal_unavailable')
        before = {p: p.url for p in self.context.pages}
        available[0].click(timeout=10000)
        end = min(self.deadline, self.now() + 20)
        while self.now() < end:
            self.check()
            candidates = [p for p in self.context.pages if not p.is_closed() and billing_portal_url(p.url) and before.get(p) != p.url]
            if len(candidates) == 1:
                self.active_page = candidates[0]
                self.active_page.wait_for_load_state('domcontentloaded', timeout=15000)
                return self.active_page
            page.wait_for_timeout(250)
        raise FlowError('subscription_portal_unavailable')

    def manage_subscription(self):
        page = self.subscription_portal()
        text = page.locator('body').inner_text(timeout=5000)
        current = subscription_state(text)
        desired = self.payload.get('enabled')
        if desired is None or desired == current['enabled']:
            return current
        if not isinstance(desired, bool):
            raise FlowError('invalid_subscription_setting')
        if re.search(r'pay now|amount due today|charge today|cancel immediately|immediately cancel|立即付款|立即取消|今天.*收费', text, re.I):
            raise FlowError('subscription_needs_attention')
        # These actions only manage the currently active plan. Never select an
        # upgrade, checkout, purchase, payment retry, or an immediate cancellation.
        pattern = r'^(Renew plan|Renew subscription|Resume subscription|Keep subscription|续订套餐|恢复订阅|保留订阅)$' if desired else r'^(Cancel plan|Cancel subscription|取消套餐|取消订阅)$'
        emit('updating_subscription')
        if not self.click(page, [pattern]):
            raise FlowError('subscription_action_unavailable')
        page.wait_for_timeout(900)
        if not billing_portal_url(page.url):
            raise FlowError('subscription_portal_unavailable')
        try:
            result = subscription_state(page.locator('body').inner_text(timeout=5000))
            if result['enabled'] == desired:
                return result
        except FlowError:
            pass
        text = page.locator('body').inner_text(timeout=5000)
        if re.search(r'pay now|amount due today|charge today|cancel immediately|immediately cancel|立即付款|立即取消|今天.*收费', text, re.I):
            raise FlowError('subscription_needs_attention')
        if not desired and not re.search(r'end of (?:the |your )?(?:current )?billing period|(?:access|use|using).*until|will be cancel(?:l)?ed on|账单周期.*结束|可.*使用至', text, re.I):
            raise FlowError('subscription_confirmation_required')
        if desired and not re.search(r'renew|resume|keep.*(?:plan|subscription)|恢复订阅|续订', text, re.I):
            raise FlowError('subscription_confirmation_required')
        if not self.click(page, [pattern]):
            raise FlowError('subscription_confirmation_required')
        end = min(self.deadline, self.now() + 15)
        while self.now() < end:
            self.check()
            if not billing_portal_url(page.url):
                raise FlowError('subscription_portal_unavailable')
            try:
                result = subscription_state(page.locator('body').inner_text(timeout=5000))
                if result['enabled'] == desired:
                    return result
            except FlowError:
                pass
            page.wait_for_timeout(400)
        raise FlowError('subscription_verification_failed')

    def click(self, page, patterns):
        self.check()
        for pattern in patterns:
            for role in ['button', 'link']:
                target = page.get_by_role(role, name=re.compile(pattern, re.I)).first
                if target.count() and target.is_visible():
                    target.click(timeout=5000)
                    return True
        return False

    def submit(self, page):
        self.check()
        target = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first
        if target.count():
            target.click(timeout=5000)
        elif not self.click(page, [r'^(Continue|Next|Sign in|Verify|继续|下一步|登录|验证)$']):
            page.keyboard.press('Enter')

    def manual_code(self, page, stage='waiting_mfa'):
        emit(stage)
        while self.now() < self.deadline:
            self.check()
            try:
                message = self.codes_queue.get_nowait()
            except queue.Empty:
                self.pause(page, 500)
                continue
            code = str(message.get('verification_code') or '').strip()
            if code:
                if not fill_otp(page, code):
                    raise FlowError('verification_input_missing')
                self.submit(page)
                emit('verifying')
                return
        raise FlowError('manual_verification_timeout')

    def microsoft_step(self, page):
        if self.mode != 'microsoft_mailbox' or host(page) not in MS_HOSTS:
            return False
        body = page.locator('body').inner_text(timeout=5000).lower()
        if re.search(r'incorrect password|password is incorrect|密码不正确|帐户或密码不正确', body):
            raise FlowError('mailbox_password_rejected')
        if re.search(r'account has been locked|account is locked|帐户已被锁定|账户已被锁定', body):
            raise FlowError('mailbox_account_locked')
        if re.search(r'captcha|solve the puzzle|prove you.re human|验证你是真人|完成拼图', body):
            raise FlowError('captcha_required')
        if page.locator(OTP_INPUT).count():
            self.manual_code(page)
            return True
        username = page.locator('input[type="email"]:visible, input[name="loginfmt"]:visible').first
        password = page.locator('input[type="password"]:visible').first
        if username.count() or password.count():
            key = ('password' if password.count() else 'email', page.url)
            attempts = self.ms_submits.get(key, 0)
            if attempts >= 2:
                raise FlowError('microsoft_login_needs_attention')
            self.ms_submits[key] = attempts + 1
            if password.count():
                # Mailbox password is only ever filled on a Microsoft login origin.
                password.fill(self.password)
                emit('microsoft_password')
            else:
                username.fill(self.email)
                emit('microsoft_email')
            self.submit(page)
            self.pause(page, 1800)
            return True
        if re.search(r'approve.*request|authenticator|two.step verification|安全信息|验证你的身份', body):
            # An approval-only challenge cannot be completed using the mailbox password.
            if not self.click(page, [r'use.*verification code|使用验证码|使用代码']):
                raise FlowError('microsoft_mfa_required')
            return True
        if re.search(r'stay signed in|保持登录', body):
            self.click(page, [r'^(Yes|是)$', r'^(No|否)$'])
            return True
        self.click(page, [r'^(Continue|Next|继续|下一步)$'])
        return True

    def open_mailbox(self, context):
        emit('mailbox_login')
        page = context.new_page()
        self.mail = page
        page.goto('https://outlook.live.com/mail/0/', wait_until='domcontentloaded', timeout=45000)
        while self.now() < self.deadline:
            self.check()
            if self.microsoft_step(page):
                self.pause(page)
                continue
            if host(page) in MAIL_HOSTS:
                # OWA uses both role=option and data-convid in its message list.
                inbox = page.get_by_role('treeitem', name=re.compile(r'Inbox|收件箱', re.I)).first
                if inbox.count() or page.locator('[data-convid], [role="option"]').count():
                    self.used_codes.update(codes(page.locator('body').inner_text(timeout=5000)))
                    self.capture_mail_baseline()
                    emit('mailbox_ready')
                    return page
                if self.click(page, [r'^Sign in$', r'^登录$']):
                    continue
            if host(page) not in MS_HOSTS | MAIL_HOSTS | {'www.microsoft.com', 'www.microsoft365.com', 'www.office.com'}:
                raise FlowError('unexpected_mailbox_origin')
            self.pause(page)
        raise FlowError('mailbox_login_timeout')

    def message_key(self, row, preview):
        return (row.get_attribute('data-convid') or row.get_attribute('data-itemid') or '', preview)

    def capture_mail_baseline(self):
        # Snapshot both folders BEFORE requesting a GPT code. An old code that
        # appears only inside a message body must never be mistaken for new mail.
        for folder in ['inbox', 'junkemail']:
            self.mail.goto('https://outlook.live.com/mail/0/' + folder, wait_until='domcontentloaded', timeout=30000)
            self.pause(self.mail, 1500)
            if host(self.mail) not in MAIL_HOSTS:
                raise FlowError('mailbox_session_expired')
            for row in self.mail.locator('[role="option"], [data-convid]').all()[:100]:
                preview = row.inner_text(timeout=1500)
                self.baseline_messages.add(self.message_key(row, preview))
                self.used_codes.update(codes(preview))

    def read_email_code(self, auth_page):
        if self.mail is None:
            raise FlowError('mailbox_not_ready')
        emit('waiting_email_code')
        end = min(self.deadline, self.now() + 150)
        checked = set()
        folders = ['inbox', 'junkemail']
        index = 0
        while self.now() < end:
            self.check()
            folder = folders[index % len(folders)]
            index += 1
            self.mail.goto('https://outlook.live.com/mail/0/' + folder, wait_until='domcontentloaded', timeout=30000)
            self.pause(self.mail, 1500)
            if host(self.mail) in MS_HOSTS:
                raise FlowError('mailbox_session_expired')
            rows = self.mail.locator('[role="option"], [data-convid]')
            for row in rows.all()[:20]:
                self.check()
                try:
                    preview = row.inner_text(timeout=1500)
                    if self.message_key(row, preview) in self.baseline_messages:
                        continue
                    if not re.search(r'openai|chatgpt', preview, re.I):
                        continue
                    if preview in checked:
                        continue
                    checked.add(preview)
                    row.click(timeout=3000)
                    self.pause(self.mail, 500)
                    # Require an OpenAI sender, not just a message mentioning the brand.
                    body = self.mail.locator('body').inner_text(timeout=5000)
                    if not re.search(r'[\w.+-]+@(?:[\w-]+\.)*(?:openai\.com|chatgpt\.com)\b', body, re.I):
                        sender = self.mail.locator('[email], [title*="openai.com"], [title*="chatgpt.com"]')
                        attributes = sender.evaluate_all('els => els.map(e => (e.getAttribute("email")||"")+" "+(e.getAttribute("title")||"")).join(" ")')
                        if not re.search(r'@(?:[\w-]+\.)*(?:openai\.com|chatgpt\.com)\b', attributes, re.I):
                            continue
                    new_codes = codes(preview) - self.used_codes
                    if not new_codes:
                        pane = self.mail.locator('[role="document"], [aria-label="Message body"], [aria-label="邮件正文"]').first
                        if pane.count():
                            new_codes = codes(pane.inner_text(timeout=3000)) - self.used_codes
                    if len(new_codes) == 1:
                        code = next(iter(new_codes))
                        self.used_codes.add(code)
                        auth_page.bring_to_front()
                        return code
                except FlowError:
                    raise
                except Exception:
                    continue
            self.pause(self.mail, 2500)
        raise FlowError('email_code_timeout')

    def authorize(self, context, web=False):
        start_url = 'https://chatgpt.com/' if web else self.payload['auth_url']
        parsed = urlparse(start_url)
        if parsed.scheme != 'https' or parsed.hostname not in OPENAI_HOSTS:
            raise FlowError('unexpected_authorization_origin')
        state = self.payload.get('state', '')

        def intercept(route):
            value = callback_value(route.request.url, state)
            if value:
                self.callback = value
            route.fulfill(status=200, content_type='text/html', body='<p>Authorization complete. You may close this page.</p>')

        if not web:
            context.route(re.compile(r'^http://localhost:1455/auth/callback(?:\?|$)'), intercept)
        self.context = context
        page = context.new_page()
        self.active_page = page
        emit('openai_login')
        page.goto(start_url, wait_until='domcontentloaded', timeout=45000)
        email_submitted = False
        otp_attempts = 0
        consent_clicks = 0
        password_attempts = 0
        totp_attempts = 0
        last_totp = None
        session_check_at = 0
        while self.now() < self.deadline:
            self.check()
            if self.callback:
                return self.callback
            # OAuth may open a new tab while leaving the mailbox in the same context.
            candidates = [p for p in context.pages if p is not self.mail and not p.is_closed()]
            if page.is_closed() and candidates:
                page = candidates[-1]
            popups = [p for p in candidates if p.opener == page]
            if popups:
                page = popups[-1]
            if not self.paused:
                self.active_page = page
            if self.microsoft_step(page):
                self.pause(page)
                continue
            if host(page) not in OPENAI_HOSTS | {'localhost'} or (host(page) != 'localhost' and urlparse(page.url).scheme != 'https'):
                raise FlowError('unexpected_authorization_origin')
            body = page.locator('body').inner_text(timeout=5000).lower()
            pathname = urlparse(page.url).path
            if web and host(page) == 'chatgpt.com' and self.now() >= session_check_at:
                session_check_at = self.now() + 3
                try:
                    session = page.evaluate("""async () => {
                        const r = await fetch('/api/auth/session', {credentials:'include',cache:'no-store'});
                        return r.ok && r.headers.get('content-type')?.includes('json') ? await r.json() : null;
                    }""")
                except Exception:
                    session = None
                if isinstance(session, dict) and session.get('accessToken'):
                    if str((session.get('user') or {}).get('email') or '').lower() != self.email.lower():
                        raise FlowError('authorized_email_mismatch')
                    emit('web_session_ready')
                    return session
            if re.search(r'complete.*captcha|please.*captcha|verify you are human|checking your browser|验证你是真人|完成拼图', body):
                emit('captcha_required')
                self.paused = True
                self.check()
                continue
            if pathname in ['/about-you', '/add-phone'] or re.search(r'create.account|signup', pathname):
                raise FlowError('existing_account_or_phone_required')
            if re.search(r'authenticator|two.factor|two.step|身份验证器|两步验证', body) and page.locator(OTP_INPUT).count():
                if self.mode == 'password_totp' and self.payload.get('totp_secret'):
                    if totp_attempts >= 2:
                        raise FlowError('totp_rejected')
                    current_totp = totp_code(self.payload['totp_secret'])
                    if current_totp == last_totp:
                        self.pause(page, 1000)
                        continue
                    fill_otp(page, current_totp)
                    last_totp = current_totp
                    self.submit(page)
                    totp_attempts += 1
                    emit('totp_submitted')
                else:
                    self.manual_code(page)
                self.pause(page, 1500)
                continue
            if page.locator(OTP_INPUT).count() or page.locator('input[maxlength="1"]:visible').count() >= 6:
                if otp_attempts >= 3:
                    raise FlowError('email_code_rejected')
                if self.mode == 'password_totp':
                    self.manual_code(page)
                    self.pause(page, 1500)
                    continue
                code = self.read_email_code(page)
                if not fill_otp(page, code):
                    raise FlowError('verification_input_missing')
                self.submit(page)
                otp_attempts += 1
                emit('email_code_submitted')
                self.pause(page, 1800)
                continue
            if self.mode == 'password_totp' and re.search(r'incorrect password|wrong password|密码不正确', body):
                raise FlowError('openai_password_rejected')
            if page.locator('input[type="password"]:visible').count():
                if self.mode == 'password_totp':
                    if host(page) not in {'auth.openai.com', 'auth0.openai.com'} or urlparse(page.url).scheme != 'https':
                        raise FlowError('unexpected_authorization_origin')
                    if password_attempts >= 2:
                        raise FlowError('openai_password_rejected')
                    page.locator('input[type="password"]:visible').first.fill(self.password)
                    self.submit(page)
                    password_attempts += 1
                    emit('openai_password')
                    self.pause(page, 1800)
                    continue
                if not self.click(page, [r'(email|one.time|temporary).*(code)|code.*instead', r'验证码.*登录|发送.*验证码|使用.*验证码|其他方式']):
                    raise FlowError('openai_email_code_unavailable')
                self.pause(page, 1500)
                continue
            email = page.locator('input[type="email"]:visible, input[name="email"]:visible, input[name="username"]:visible').first
            if email.count() and not email_submitted:
                email.fill(self.email)
                self.submit(page)
                email_submitted = True
                self.pause(page, 1800)
                continue
            if self.click(page, [r'^Sign in with ChatGPT$|^Continue with ChatGPT$', r'^(Log in|Sign in|登录)$']):
                self.pause(page, 1500)
                continue
            if re.search(r'consent|authorize|授权|允许.*访问|continue to codex|sign in to codex', pathname + ' ' + body):
                if consent_clicks >= 4:
                    raise FlowError('oauth_consent_stalled')
                if self.click(page, [r'^(Continue|Authorize|Allow|Accept|Confirm|继续|授权|允许|确认)$']):
                    consent_clicks += 1
                    emit('oauth_consent')
                    self.pause(page, 1500)
                    continue
            if self.click(page, [r'email.*code|one.time code|发送.*验证码|使用.*验证码', r'Continue with Microsoft|Microsoft.*继续']):
                self.pause(page, 1500)
                continue
            self.pause(page)
        raise FlowError('login_timeout')

    def run(self):
        from playwright.sync_api import sync_playwright
        profile_key = hashlib.sha256((self.email or ('slot:' + self.payload.get('profile_id', 'default'))).encode()).hexdigest()[:24]
        legacy = Path('/var/lib/kin-mailbox') / profile_key
        runtime = Path(os.environ.get('KIN_MAILBOX_ROOT', '/opt/kin-mailbox'))
        profile = legacy if legacy.exists() or not os.environ.get('KIN_MAILBOX_ROOT') else runtime / 'profiles' / profile_key
        profile.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(profile, 0o700)
        os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', str(runtime / 'browsers'))
        with sync_playwright() as pw:
            context = pw.chromium.launch_persistent_context(str(profile), headless=True,
                viewport={'width': 1365, 'height': 900}, locale='en-US',
                args=['--disable-quic', '--disable-dev-shm-usage', '--disable-background-networking',
                      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'])
            context.set_default_timeout(8000)
            try:
                self.context = context
                if self.payload.get('operation') in ['session', 'subscription']:
                    self.remote = True
                    self.active_page = context.new_page()
                    result = self.control({'op': 'session'}) if self.payload['operation'] == 'session' else self.manage_subscription()
                    print(json.dumps({'event': 'result', 'data': result}), flush=True)
                    return
                if self.remote:
                    self.active_page = context.pages[0] if context.pages else context.new_page()
                    try:
                        self.active_page.goto('https://chatgpt.com/', wait_until='domcontentloaded', timeout=30000)
                    except Exception:
                        pass  # Keep the real screen available when navigation times out.
                    emit('remote_ready')
                    while self.now() < self.deadline:
                        self.check()
                        if self.now() - self.last_control > 120:
                            raise FlowError('remote_idle_timeout')
                        self.active_page.wait_for_timeout(100)
                    return
                if self.mode == 'microsoft_mailbox':
                    self.open_mailbox(context)
                if self.mode in ['microsoft_mailbox', 'password_totp']:
                    self.authorize(context, web=True)
                result = self.authorize(context)
                print(json.dumps({'event': 'callback', 'callback_url': result}), flush=True)
            finally:
                context.close()


def main():
    os.umask(0o077)
    payload = json.loads(sys.stdin.readline())
    controls = queue.Queue()

    def cancel(_signum, _frame):
        raise FlowError('login_cancelled')

    signal.signal(signal.SIGUSR1, cancel)
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(FlowError('login_timeout')))
    signal.alarm(1810 if payload.get('remote') else 500)

    def input_loop():
        for line in sys.stdin:
            try:
                value = json.loads(line)
                if value.get('cancel'):
                    os.kill(os.getpid(), signal.SIGUSR1)
                    return
                controls.put(value)
            except Exception:
                continue
        # A dead control plane must not leave a browser logging in unattended.
        os.kill(os.getpid(), signal.SIGUSR1)

    threading.Thread(target=input_loop, daemon=True).start()
    try:
        BrowserLogin(payload, controls).run()
        return 0
    except FlowError as error:
        emit('failed', code=str(error))
    except ModuleNotFoundError:
        emit('failed', code='browser_runtime_missing')
    except Exception:
        # Never include Playwright error details: page URLs can contain codes.
        emit('failed', code='browser_login_failed')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
