"""Chromium user-flow checks. Run against a keyless test server.

TEST_BASE_URL=http://127.0.0.1:8011 python tests/browser.py
The first context exercises the real local API. The second mocks every API
route to test AI/loading/failure UI without sending any model request.
"""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('TEST_BASE_URL', 'http://127.0.0.1:8011').rstrip('/')
ARTIFACTS = Path(os.environ.get('TEST_ARTIFACTS', '/tmp/praktikum-assistant-browser'))
ARTIFACTS.mkdir(parents=True, exist_ok=True)
PRIVATE_FIELDS = {'answer', 'explanation', 'proof', 'hint', 'result', 'LLM_API_KEY'}


def assert_public(value):
    """Generation/history must not preload a solution, even in hidden JSON."""
    if isinstance(value, dict):
        assert not PRIVATE_FIELDS.intersection(value), value.keys()
        for item in value.values():
            assert_public(item)
    elif isinstance(value, list):
        for item in value:
            assert_public(item)


def choose_settings(page, topic, level, count):
    page.select_option('#topic', topic)
    page.locator(f'input[name="level"][value="{level}"]').check()
    page.fill('#count', str(count))
    page.click('#generate-button')
    expect(page.locator('.task-card')).to_have_count(count)
    expect(page.locator('#generate-button')).to_be_enabled()


def answer_field(card):
    return card.locator('textarea').first


def check_button(card):
    return card.get_by_role('button', name='Проверить', exact=True)


def screenshot_clean(page, path):
    # Screenshots should show the page, without transient focus/notification
    # overlays left by the preceding keyboard and form checks.
    page.evaluate('''() => {
      document.activeElement?.blur();
      const toast = document.querySelector('#toast');
      if (toast) toast.hidden = true;
      window.scrollTo({top: 0, left: 0, behavior: 'instant'});
    }''')
    page.screenshot(path=str(path), full_page=True)


class SimulatedAPI:
    """Browser-only fixture, not evidence of model quality or real access."""
    def __init__(self):
        self.variants = []
        self.calls = []
        self.pending_generate = []
        self.pending_check = []
        self.hold_generate = False
        self.hold_check = False
        self.next_check_error = False

    def variant(self, config, source='ai'):
        value = {
            'id': str(uuid4()), 'number': len(self.variants) + 1,
            'config': dict(config), 'source': source,
            'created': datetime.now(timezone.utc).isoformat(),
            'tasks': [
                {'id': str(uuid4()), 'tag': 'Дробь',
                 'question': 'Вычисли 1 / 2. <img src=x onerror=alert(1)>',
                 'chat': []}
                for _ in range(config['count'])
            ],
            'solved': [False] * config['count'],
        }
        self.variants.insert(0, value)
        return value

    def find_task(self, task_id):
        for variant in self.variants:
            for index, task in enumerate(variant['tasks']):
                if task['id'] == task_id:
                    return variant, index, task
        raise AssertionError('Unknown mock task: ' + task_id)

    @staticmethod
    def checked(verdict):
        return {
            'verdict': verdict,
            'explanation': 'Равнозначная запись принята.' if verdict == 'correct' else 'Вычисление требует ещё одного шага.',
            'error': '' if verdict == 'correct' else 'Проверь деление.',
            'hint': '' if verdict == 'correct' else 'Раздели числитель на знаменатель.',
            'method': 'code', 'needsClarification': verdict == 'clarify',
        }

    def route(self, route):
        request = route.request
        path = urlparse(request.url).path
        body = request.post_data_json if request.method == 'POST' else {}
        self.calls.append((path, body))
        if path == '/api/status':
            return route.fulfill(json={'aiAvailable': True})
        if path == '/api/history':
            return route.fulfill(json={'variants': self.variants})
        if path.startswith('/api/variants/'):
            variant = next((v for v in self.variants if v['id'] == path.rsplit('/', 1)[1]), None)
            return route.fulfill(status=200 if variant else 404, json={'variant': variant} if variant else {'error': 'Вариант больше недоступен. Создай новый.'})
        if path == '/api/generate':
            if body.get('source') == 'ai' and self.hold_generate:
                self.pending_generate.append(route)
                return
            return route.fulfill(json={'variant': self.variant(body['config'], body.get('source', 'ai'))})
        match = re.fullmatch(r'/api/tasks/([^/]+)/(check|hint|solution|chat|similar)', path)
        assert match, (request.method, path)
        variant, index, task = self.find_task(match[1])
        action = match[2]
        if action == 'check':
            if self.next_check_error:
                self.next_check_error = False
                return route.fulfill(status=502, json={'error': 'Проверка временно недоступна. Попробуй ещё раз.'})
            if self.hold_check:
                self.pending_check.append(route)
                return
            answer = body.get('answer', '').strip()
            if not answer:
                return route.fulfill(status=400, json={'error': 'Введи ответ перед проверкой.'})
            verdict = 'correct' if answer in {'0,5', '0.5', '1/2'} else 'incorrect'
            variant['solved'][index] = verdict == 'correct'
            return route.fulfill(json=self.checked(verdict))
        if action == 'hint':
            return route.fulfill(json={'message': 'Начни с преобразования дроби в десятичную запись.'})
        if action == 'solution':
            return route.fulfill(json={'answer': '0,5', 'explanation': 'Одна из двух равных частей — половина.'})
        if action == 'chat':
            text = body.get('message', '')
            message = 'Сначала определи, на сколько равных частей делят целое. <script>alert(1)</script>'
            task['chat'].extend([{'role': 'user', 'content': text}, {'role': 'assistant', 'content': message}])
            return route.fulfill(json={'message': message})
        if action == 'similar':
            return route.fulfill(json={'variant': self.variant({**variant['config'], 'count': 1}, variant['source'])})
        raise AssertionError(action)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
        headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    # Refuse a keyed production/development server before any action can spend
    # API balance. Mocking only /api/status in the page would not be sufficient.
    status = context.request.get(BASE + '/api/status')
    assert status.ok and status.json().get('aiAvailable') is False, (
        'Use a separate createApp({settings:{}}) server and set TEST_BASE_URL. '
        'This browser suite must not send real model requests.')
    page = context.new_page()
    errors = []
    public_responses = []
    solution_requests = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: solution_requests.append(request.url) if urlparse(request.url).path.endswith('/solution') else None)

    def capture_public(response):
        path = urlparse(response.url).path
        if response.status == 200 and (path in {'/api/generate', '/api/history'} or path.startswith('/api/variants/')):
            value = response.json()
            assert_public(value)
            public_responses.append(value)

    page.on('response', capture_public)
    page.goto(BASE)
    expect(page.locator('.task-card')).to_have_count(5)
    expect(page.locator('#ai-option')).to_be_disabled()
    assert page.locator('input[data-solved]').count() == 0, 'Solved state must come from checking'
    assert all(not text.strip() for text in page.locator('.answer-main').all_text_contents()), 'No preloaded answers in hidden markup'

    for topic in ('complex', 'sets', 'python'):
        for level in ('easy', 'medium', 'hard'):
            choose_settings(page, topic, level, 10 if level == 'hard' else 1)
    print('PASS browser: real local generation for all three topics, levels and 1/10 tasks; public API omits solutions')

    # The expected sum is independently computed from the displayed program,
    # rather than fetched from the server's reference answer.
    choose_settings(page, 'python', 'easy', 3)
    card = page.locator('.task-card').filter(has=page.locator('.task-tag', has_text='Цикл for')).first
    code = card.locator('.task-question').inner_text()
    upper = int(re.search(r'range\((\d+)\)', code).group(1))
    factor = int(re.search(r's\s*\+=\s*(\d+)\s*\*\s*i', code).group(1))
    expected_answer = factor * upper * (upper - 1) // 2
    check_button(card).click()
    expect(card).to_contain_text(re.compile(r'введи|введите|пуст', re.IGNORECASE))
    answer_field(card).fill(str(expected_answer + 1))
    check_button(card).click()
    expect(card).to_contain_text('Неверно')
    answer_field(card).fill(f'{expected_answer * 2}/2')
    check_button(card).click()
    expect(card).to_contain_text('Верно')
    expect(page.locator('#progress-label')).to_contain_text('1 из 3')
    variant_number = page.locator('#variant-number').inner_text()
    question = card.locator('.task-question').inner_text()
    page.reload()
    expect(page.locator('#variant-number')).to_have_text(variant_number)
    expect(page.locator('#progress-label')).to_contain_text('1 из 3')
    expect(page.locator('.task-question').filter(has_text=question)).to_have_count(1)
    print('PASS browser: empty/wrong/equivalent numeric answers, checked progress and history restoration')

    # Explicitly opening a solution may fetch it; ordinary page loading and
    # generation/history responses above may not.
    active_card = page.locator('.task-card').first
    assert not solution_requests, 'No solution request before explicit reveal'
    active_card.locator('[data-task-action="hint"]').click()
    expect(active_card.locator('.task-hint')).to_be_visible()
    assert not solution_requests, 'A hint must not preload the solution'
    active_card.locator('[data-task-action="solution"]').click()
    expect(active_card.locator('.task-solution')).to_be_visible()
    assert len(solution_requests) == 1
    assert_public(context.request.get(BASE + '/api/history').json())
    page.click('#nav-history')
    expect(page.locator('#history-dialog')).to_be_visible()
    page.fill('#history-search', 'несуществующая тема')
    expect(page.locator('.empty-history')).to_be_visible()
    page.locator('#history-dialog [data-close]').click()
    expect(page.locator('#history-dialog')).not_to_be_visible()
    page.click('#nav-guide')
    expect(page.locator('#guide-dialog')).to_be_visible()
    page.keyboard.press('Escape')
    print('PASS browser: on-demand hint and solution, private reference stays out of history, guide and history search')

    for width in (320, 390, 768, 1024, 1440):
        page.set_viewport_size({'width': width, 'height': 1000})
        assert not page.evaluate('() => document.documentElement.scrollWidth > innerWidth'), f'Overflow at {width}'
        answer_field(page.locator('.task-card').first).focus()
        assert answer_field(page.locator('.task-card').first).evaluate('(element) => element === document.activeElement')
    screenshot_clean(page, ARTIFACTS / 'desktop.png')
    page.set_viewport_size({'width': 390, 'height': 844})
    screenshot_clean(page, ARTIFACTS / 'mobile.png')
    assert public_responses, 'No public API responses checked'
    assert not errors, errors
    print('PASS browser: 320–1440px layouts and desktop/mobile screenshots; no JavaScript errors')

    # Every API call in this separate context is mocked, including task/chat
    # routes. These checks establish UI behavior, not model correctness.
    fixture = SimulatedAPI()
    ai_context = browser.new_context(viewport={'width': 1280, 'height': 900})
    ai_context.route('**/api/**', fixture.route)
    ai_page = ai_context.new_page()
    ai_page.on('pageerror', lambda error: errors.append(str(error)))
    ai_page.goto(BASE)
    expect(ai_page.locator('.task-card')).to_have_count(5)
    expect(ai_page.locator('#source')).to_have_value('ai')
    assert all(body.get('source') != 'ai' for path, body in fixture.calls if path == '/api/generate'), 'No paid generation on page load'
    fixture.hold_generate = True
    ai_page.fill('#count', '2')
    ai_page.click('#generate-button')
    expect(ai_page.locator('#generate-button')).to_be_disabled()
    expect(ai_page.locator('#generation-status')).to_be_visible()
    ai_page.locator('#generator-form').evaluate('(form) => form.dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}))')
    assert len(fixture.pending_generate) == 1
    route = fixture.pending_generate.pop()
    fixture.hold_generate = False
    route.fulfill(json={'variant': fixture.variant(route.request.post_data_json['config'])})
    expect(ai_page.locator('.task-card')).to_have_count(2)
    expect(ai_page.locator('#generate-button')).to_be_enabled()
    expect(ai_page.locator('.task-question').first).to_contain_text('<img src=x')
    assert ai_page.locator('.task-question img').count() == 0
    ai_card = ai_page.locator('.task-card').first
    answer_field(ai_card).fill('0,5')
    fixture.hold_check = True
    check_button(ai_card).click()
    expect(check_button(ai_card)).to_be_disabled()
    ai_card.locator('.answer-form').evaluate('(form) => form.dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}))')
    assert len(fixture.pending_check) == 1
    fixture.pending_check.pop().fulfill(json=fixture.checked('correct'))
    fixture.hold_check = False
    expect(ai_card).to_contain_text('Верно')
    expect(check_button(ai_card)).to_be_enabled()
    answer_field(ai_card).fill('1')
    check_button(ai_card).click()
    expect(ai_card).to_contain_text('Неверно')
    fixture.next_check_error = True
    check_button(ai_card).click()
    expect(ai_card).to_contain_text('Проверка временно недоступна.')
    expect(check_button(ai_card)).to_be_enabled()
    expect(answer_field(ai_card)).to_have_value('1')
    print('PASS browser: simulated AI generation, request locking, escaped model text and decimal answer UI')

    first_id = fixture.variants[0]['tasks'][0]['id']
    second_id = fixture.variants[0]['tasks'][1]['id']
    ai_card.locator('[data-task-action="discuss"]').click()
    ai_page.fill('#chat-input', 'Почему нужно делить числитель?')
    ai_page.click('#chat-send')
    expect(ai_page.locator('#chat-messages')).to_contain_text('Почему нужно делить числитель?')
    expect(ai_page.locator('#chat-messages')).to_contain_text('Сначала определи')
    assert any(path == f'/api/tasks/{first_id}/chat' for path, _ in fixture.calls)
    assert ai_page.locator('#chat-messages script').count() == 0, 'Assistant text cannot inject markup'
    ai_page.locator('[data-chat-action="hint"]').click()
    expect(ai_page.locator('#chat-messages')).to_contain_text('Начни с преобразования')
    ai_page.locator('[data-chat-action="simpler"]').click()
    expect(ai_page.locator('#chat-send')).to_be_enabled()
    assert any(path == f'/api/tasks/{first_id}/chat' and body.get('action') == 'simpler' for path, body in fixture.calls)
    ai_page.select_option('#chat-task', index=1)
    expect(ai_page.locator('#chat-messages')).not_to_contain_text('Почему нужно делить числитель?')
    ai_page.fill('#chat-input', 'Объясни второе задание.')
    ai_page.click('#chat-send')
    expect(ai_page.locator('#chat-messages')).to_contain_text('Объясни второе задание.')
    expect(ai_page.locator('#chat-send')).to_be_enabled()
    assert any(path == f'/api/tasks/{second_id}/chat' for path, _ in fixture.calls)
    ai_page.select_option('#chat-task', index=0)
    expect(ai_page.locator('#chat-messages')).to_contain_text('Почему нужно делить числитель?')
    assert not any(path.endswith('/solution') for path, _ in fixture.calls)
    ai_page.locator('[data-chat-action="solution"]').click()
    expect(ai_card.locator('.task-solution')).to_be_visible()
    expect(ai_card.locator('.task-solution')).to_contain_text('Одна из двух равных частей')
    assert sum(path.endswith('/solution') for path, _ in fixture.calls) == 1
    print('PASS browser: task-bound chat, history switching, hint/simpler/explicit-solution actions and safe assistant text')

    fixture.hold_generate = True
    ai_page.click('#regenerate')
    expect(ai_page.locator('#generation-status')).to_be_visible()
    fixture.pending_generate.pop().fulfill(status=502, json={'error': 'Сервис ИИ временно недоступен.'})
    fixture.hold_generate = False
    expect(ai_page.locator('#generation-error')).to_have_text('Сервис ИИ временно недоступен.')
    expect(ai_page.locator('#generate-button')).to_be_enabled()
    expect(ai_page.locator('.task-card')).to_have_count(2)
    ai_page.locator('[data-chat-action="similar"]').click()
    expect(ai_page.locator('.task-card')).to_have_count(1)
    assert fixture.variants[0]['config']['count'] == 1
    assert fixture.variants[0]['config']['topic'] == 'complex'
    assert fixture.variants[0]['source'] == 'ai'
    assert not errors, errors
    print('PASS browser: provider error preserves current tasks, restores controls and similar task starts a new variant')
    browser.close()
