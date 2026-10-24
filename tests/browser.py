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
    page.click('#new-dialog')
    page.select_option('#topic', topic)
    page.locator(f'input[name="level"][value="{level}"]').check()
    page.fill('#count', str(count))
    page.click('#generate-button')
    expect(page.locator('#settings-dialog')).not_to_be_visible()
    expect(page.locator('[data-select-task]')).to_have_count(count)
    expect(page.locator('#chat-send')).to_be_enabled()


def send_answer(page, text):
    page.fill('#chat-input', text)
    page.click('#chat-send')


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
            'provider': 'gemini', 'solved': [False] * config['count'],
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
        if path == '/api/models':
            return route.fulfill(json={'defaultProvider':'gemini','providers':[{'id':'gemini','label':'Gemini','available':True},{'id':'qwen','label':'Qwen','available':True}]})
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
        match = re.fullmatch(r'/api/tasks/([^/]+)/(check|hint|solution|chat|similar|respond)', path)
        assert match, (request.method, path)
        variant, index, task = self.find_task(match[1])
        action = match[2]
        automatic = action == 'respond'
        if automatic:
            text = body.get('message','').strip()
            if text == 'Напиши подробное решение': action='solution'
            elif re.fullmatch(r'[0-9.,/ +*-]+',text): action='check';body['answer']=text
            else: action='chat'
        def reply(data):
            kind={'check':'feedback','solution':'solution','similar':'variant'}.get(action,'message')
            return route.fulfill(json={'kind':kind,**data} if automatic else data)
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
            variant['solved'][index] = variant['solved'][index] or verdict == 'correct'
            return reply(self.checked(verdict))
        if action == 'hint':
            return reply({'message': 'Начни с преобразования дроби в десятичную запись.'})
        if action == 'solution':
            return reply({'answer': '0,5', 'explanation': 'Одна из двух равных частей — половина.'})
        if action == 'chat':
            text = body.get('message', '')
            message = 'Сначала определи, на сколько равных частей делят целое. <script>alert(1)</script>'
            task['chat'].extend([{'role': 'user', 'content': text}, {'role': 'assistant', 'content': message}])
            return reply({'message': message})
        if action == 'similar':
            return reply({'variant': self.variant({**variant['config'], 'count': 1}, variant['source'])})
        raise AssertionError(action)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1440,'height':1000}, accept_downloads=True)
    status = context.request.get(BASE + '/api/status')
    assert status.ok and status.json().get('aiAvailable') is False, 'Use a keyless createApp({settings:{}}) server.'
    page = context.new_page()
    errors, public_responses, solution_requests = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: solution_requests.append(request.url) if urlparse(request.url).path.endswith('/solution') else None)
    def capture_public(response):
        path=urlparse(response.url).path
        if response.status==200 and (path in {'/api/generate','/api/history'} or path.startswith('/api/variants/')):
            value=response.json(); assert_public(value); public_responses.append(value)
    page.on('response',capture_public)
    page.goto(BASE)
    page.click('#new-dialog')
    assert page.locator('#topic option[value="custom"]').is_disabled()
    assert page.locator('#topic option[value="physics"]').is_disabled()
    expect(page.locator('#custom-topic-field')).not_to_be_visible()
    page.keyboard.press('Escape')
    page.click('[data-topic="custom"]')
    expect(page.locator('#source-description')).to_contain_text('подключи Gemini или Qwen')
    expect(page.locator('#generate-button')).to_be_disabled()
    page.select_option('#topic','complex')
    expect(page.locator('#source')).to_have_value('local')
    expect(page.locator('#generate-button')).to_be_enabled()
    page.keyboard.press('Escape')
    expect(page).to_have_title(re.compile('Экзамен\\+'))
    expect(page.locator('#welcome')).to_be_visible()
    expect(page.locator('#chat-send')).to_be_disabled()
    assert not any('variant' in value for value in public_responses), 'Opening must not generate tasks or spend balance'
    for topic in ('complex','sets','python'):
        for level in ('easy','medium','hard'):
            choose_settings(page,topic,level,10 if level=='hard' else 1)
    print('PASS browser: new branding/welcome, explicit generation, all topics/levels and task navigation')

    choose_settings(page,'python','easy',3)
    page.locator('[data-select-task]').filter(has_text='Цикл for').click()
    question=page.locator('#task-question').inner_text()
    upper=int(re.search(r'range\((\d+)\)',question).group(1)); factor=int(re.search(r's\s*\+=\s*(\d+)\s*\*\s*i',question).group(1))
    expected=factor*sum(range(upper))
    page.click('#chat-send'); expect(page.locator('#chat-error')).to_contain_text('Напиши')
    send_answer(page,str(expected+1)); expect(page.locator('.verdict-label').last).to_have_text('Неверно')
    send_answer(page,f'{expected*2}/2'); expect(page.locator('.verdict-label').last).to_have_text('Верно')
    expect(page.locator('#progress-label')).to_contain_text('1 из 3')
    first_task=page.locator('[data-select-task].active').get_attribute('data-select-task')
    page.fill('#chat-input','мой черновик')
    page.locator('[data-select-task]').filter(has_text='Срезы списков').click()
    expect(page.locator('#chat-input')).to_have_value('')
    page.locator(f'[data-select-task="{first_task}"]').click()
    expect(page.locator('#chat-input')).to_have_value('мой черновик')
    page.reload(); expect(page.locator('#task-question')).to_have_text(question,use_inner_text=True)
    expect(page.locator('#chat-messages')).to_contain_text(f'{expected*2}/2')
    expect(page.locator('#chat-messages')).to_contain_text('Верно')
    expect(page.locator('#chat-input')).to_have_value('мой черновик')
    expect(page.locator('#progress-label')).to_contain_text('1 из 3')
    assert not solution_requests
    page.locator('[data-chat-action="hint"]').click(); expect(page.locator('#chat-messages')).to_contain_text('Дай подсказку')
    expect(page.locator('#chat-send')).to_be_enabled(); assert not solution_requests
    page.locator('[data-chat-action="solution"]').click(); expect(page.locator('.solution-content')).to_be_visible()
    assert len(solution_requests)==1
    page.locator('[data-chat-action="solution"]').click(); assert len(solution_requests)==1, 'Repeated reveal uses its explicitly loaded solution'
    assert_public(context.request.get(BASE+'/api/history').json())
    print('PASS browser: conversation answer checking, independent calculation, equivalent fractions, drafts, restoration and explicit solution')

    # Free dialogue is deliberately distinct from grading the same input.
    page.fill('#chat-input','Как начать решение?');page.locator('#chat-input').press('Enter')
    expect(page.locator('#chat-messages')).to_contain_text('Как начать решение?')
    expect(page.locator('#chat-send')).to_be_enabled()
    with page.expect_download() as saved:
        page.click('#download-variant')
    text=Path(saved.value.path()).read_text(encoding='utf-8-sig')
    assert 'ЭКЗАМЕН+' in text and 'ЗАДАНИЕ 1' in text and 'Разбор по шагам' not in text
    page.evaluate('() => { window.print=()=>{ window.printText=document.querySelector("#print-sheet").textContent; }; }')
    page.click('#print-variant'); assert 'ЭКЗАМЕН+' in page.evaluate('window.printText')
    assert 'Ответ:' not in page.evaluate('window.printText')
    page.click('#nav-history'); page.fill('#history-search','нет такого занятия'); expect(page.locator('.empty-history')).to_be_visible()
    page.fill('#history-search','Комплексные'); page.locator('[data-load]').first.click(); expect(page.locator('#history-dialog')).not_to_be_visible()
    page.click('#rail-guide'); expect(page.locator('#guide-dialog')).to_be_visible();page.keyboard.press('Escape')
    print('PASS browser: unified chat, keyboard submit, export/print, history search and guide')

    for width in (320,390,768,1024,1440):
        page.set_viewport_size({'width':width,'height':1000})
        assert not page.evaluate('() => document.documentElement.scrollWidth > innerWidth'), f'Overflow {width}'
        page.locator('#chat-input').focus();assert page.locator('#chat-input').evaluate('(e)=>e===document.activeElement')
        choose_settings(page,'python','easy',3)
        assert not page.evaluate('() => document.documentElement.scrollWidth > innerWidth'), f'Dialog overflow {width}'
    screenshot_clean(page,ARTIFACTS/'desktop.png')
    page.set_viewport_size({'width':390,'height':844});screenshot_clean(page,ARTIFACTS/'mobile.png')
    assert public_responses and not errors, errors
    print('PASS browser: responsive 320–1440px, real API privacy, screenshots and no JS errors')

    fixture=SimulatedAPI()
    ai_context=browser.new_context(viewport={'width':1440,'height':1000})
    ai_context.route('**/api/**',fixture.route)
    ai_page=ai_context.new_page();ai_page.on('pageerror',lambda error: errors.append(str(error)))
    ai_page.goto(BASE); expect(ai_page.locator('#welcome')).to_be_visible()
    assert not any(path=='/api/generate' for path,_ in fixture.calls)
    ai_page.click('#new-dialog'); expect(ai_page.locator('#source')).to_have_value('ai')
    fixture.hold_generate=True; ai_page.fill('#count','2');ai_page.click('#generate-button')
    expect(ai_page.locator('#generate-button')).to_be_disabled()
    ai_page.locator('#generator-form').evaluate('(f)=>f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    assert len(fixture.pending_generate)==1
    route=fixture.pending_generate.pop();fixture.hold_generate=False
    route.fulfill(json={'variant':fixture.variant(route.request.post_data_json['config'])})
    expect(ai_page.locator('#settings-dialog')).not_to_be_visible()
    expect(ai_page.locator('#task-question')).to_contain_text('<img src=x')
    assert ai_page.locator('#task-question img').count()==0
    fixture.hold_check=True;send_answer(ai_page,'0,5')
    expect(ai_page.locator('#chat-send')).to_be_disabled()
    ai_page.locator('#chat-form').evaluate('(f)=>f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    assert len(fixture.pending_check)==1
    fixture.pending_check.pop().fulfill(json={'kind':'feedback',**fixture.checked('correct')});fixture.hold_check=False
    expect(ai_page.locator('.verdict-label').last).to_have_text('Верно')
    send_answer(ai_page,'1');expect(ai_page.locator('.verdict-label').last).to_have_text('Неверно')
    fixture.next_check_error=True;ai_page.fill('#chat-input','1');ai_page.click('#chat-send')
    expect(ai_page.locator('#chat-error')).to_contain_text('Проверка временно недоступна')
    expect(ai_page.locator('#chat-input')).to_have_value('1');expect(ai_page.locator('#chat-send')).to_be_enabled()
    fixture.hold_check=True;send_answer(ai_page,'0,5')
    fixture.pending_check.pop().fulfill(json={'kind':'feedback',**fixture.checked('clarify'),'explanation':'Уточни, какое значение ты получил?','error':'Ответ отсутствует.','hint':'Ненужный повтор.'})
    fixture.hold_check=False
    expect(ai_page.locator('.verdict-label').last).to_have_text('Уточни ответ')
    assert 'Что исправить' not in ai_page.locator('.reply').last.inner_text()
    assert 'Ответ отсутствует' not in ai_page.locator('.reply').last.inner_text()
    assert 'Ненужный повтор' not in ai_page.locator('.reply').last.inner_text()
    first_id=fixture.variants[0]['tasks'][0]['id'];second_id=fixture.variants[0]['tasks'][1]['id']
    assert ai_page.locator('#mode-answer').count()==0
    ai_page.select_option('#chat-provider','qwen')
    ai_page.fill('#chat-input','Почему нужно делить числитель?');ai_page.click('#chat-send')
    expect(ai_page.locator('#chat-messages')).to_contain_text('Сначала определи')
    assert any(path==f'/api/tasks/{first_id}/respond' and body.get('provider')=='qwen' for path,body in fixture.calls)
    ai_page.reload();expect(ai_page.locator('#chat-provider')).to_have_value('qwen')
    expect(ai_page.locator('#chat-messages')).to_contain_text('Почему нужно делить числитель?')
    assert ai_page.locator('#chat-messages script').count()==0
    ai_page.locator('[data-chat-action="hint"]').click();expect(ai_page.locator('#chat-messages')).to_contain_text('Начни с преобразования')
    expect(ai_page.locator('#chat-send')).to_be_enabled()
    ai_page.locator('[data-chat-action="simpler"]').click();expect(ai_page.locator('#chat-send')).to_be_enabled()
    assert any(path==f'/api/tasks/{first_id}/chat' and body.get('action')=='simpler' for path,body in fixture.calls)
    ai_page.locator(f'[data-select-task="{second_id}"]').click()
    expect(ai_page.locator('#chat-messages')).not_to_contain_text('Почему нужно делить числитель?')
    ai_page.fill('#chat-input','Объясни второе задание.');ai_page.click('#chat-send')
    expect(ai_page.locator('#chat-messages')).to_contain_text('Объясни второе задание.')
    ai_page.locator(f'[data-select-task="{first_id}"]').click()
    expect(ai_page.locator('#chat-messages')).to_contain_text('Почему нужно делить числитель?')
    assert not any(path.endswith('/solution') for path,_ in fixture.calls)
    ai_page.fill('#chat-input','Напиши подробное решение');ai_page.click('#chat-send')
    expect(ai_page.locator('.solution-content')).to_contain_text('Одна из двух равных частей')
    assert any(path==f'/api/tasks/{first_id}/respond' and body.get('message')=='Напиши подробное решение' for path,body in fixture.calls)
    ai_page.click('#new-dialog');fixture.hold_generate=True;ai_page.click('#generate-button')
    expect(ai_page.locator('#generation-status')).to_be_visible()
    fixture.pending_generate.pop().fulfill(status=502,json={'error':'Сервис ИИ временно недоступен.'});fixture.hold_generate=False
    expect(ai_page.locator('#generation-error')).to_have_text('Сервис ИИ временно недоступен.')
    expect(ai_page.locator('#generate-button')).to_be_enabled()
    ai_page.locator('#settings-dialog [data-close]').click()
    expect(ai_page.locator('[data-select-task]')).to_have_count(2)
    ai_page.click('#new-dialog');fixture.hold_generate=True;ai_page.click('#generate-button')
    expect(ai_page.locator('#generate-button')).to_be_disabled()
    ai_page.keyboard.press('Escape')
    expect(ai_page.locator('#settings-dialog')).not_to_be_visible()
    expect(ai_page.locator('#new-dialog')).to_be_disabled()
    fixture.pending_generate.pop().fulfill(status=502,json={'error':'Сервис не ответил.'});fixture.hold_generate=False
    expect(ai_page.locator('#app-error')).to_have_text('Сервис не ответил.')
    expect(ai_page.locator('#new-dialog')).to_be_enabled()
    expect(ai_page.locator('[data-select-task]')).to_have_count(2)
    ai_page.locator('[data-chat-action="similar"]').click();expect(ai_page.locator('[data-select-task]')).to_have_count(1)
    assert fixture.variants[0]['config']['count']==1 and fixture.variants[0]['source']=='ai'
    assert not errors,errors
    print('PASS browser: mocked AI locking/errors/safe text, automatic routing and model selection, task-bound chat and all quick actions')
    ai_page.click('#new-dialog');ai_page.select_option('#topic','custom')
    expect(ai_page.locator('#custom-topic-field')).to_be_visible()
    expect(ai_page.locator('#source')).to_have_value('ai')
    expect(ai_page.locator('#source')).to_be_disabled()
    calls_before=len(fixture.calls)
    ai_page.fill('#custom-topic','');ai_page.click('#generate-button')
    assert len(fixture.calls)==calls_before, 'Empty subject must not reach API'
    ai_page.fill('#custom-topic','   ');ai_page.click('#generate-button')
    expect(ai_page.locator('#generation-error')).to_contain_text('Укажи тему')
    assert len(fixture.calls)==calls_before
    subject='Биология <img src=x onerror=alert(1)> ' + 'ДНК'*30
    ai_page.fill('#custom-topic',subject);ai_page.fill('#count','1');ai_page.click('#generate-button')
    expect(ai_page.locator('#settings-dialog')).not_to_be_visible()
    expect(ai_page.locator('#session-topic')).to_have_text(subject)
    assert ai_page.locator('#session-topic img').count()==0
    custom_config=fixture.variants[0]['config']
    assert custom_config['topic']=='custom' and custom_config['customTopic']==subject
    ai_page.reload();expect(ai_page.locator('#session-topic')).to_have_text(subject)
    ai_page.click('#nav-history');ai_page.fill('#history-search','Биология')
    expect(ai_page.locator('.history-entry h3')).to_contain_text(subject)
    assert ai_page.locator('#history-list img').count()==0
    ai_page.locator('[data-load]').first.click()
    with ai_page.expect_download() as custom_download:
        ai_page.click('#download-variant')
    assert subject in Path(custom_download.value.path()).read_text(encoding='utf-8-sig')
    for width in (320,390,768,1024,1440):
        ai_page.set_viewport_size({'width':width,'height':1000})
        assert not ai_page.evaluate('() => document.documentElement.scrollWidth > innerWidth'), f'Custom subject overflow {width}'
        ai_page.click('#new-dialog')
        expect(ai_page.locator('#custom-topic')).to_have_value(subject)
        assert not ai_page.evaluate('() => document.documentElement.scrollWidth > innerWidth'), f'Custom dialog overflow {width}'
        ai_page.keyboard.press('Escape')
    ai_page.locator('[data-chat-action="similar"]').click()
    expect(ai_page.locator('#session-topic')).to_have_text(subject)
    assert fixture.variants[0]['config']['customTopic']==subject
    ai_page.click('#new-dialog');ai_page.select_option('#topic','physics')
    expect(ai_page.locator('#custom-topic-field')).not_to_be_visible()
    ai_page.click('#generate-button')
    expect(ai_page.locator('#session-topic')).to_have_text('Физика')
    assert 'customTopic' not in fixture.variants[0]['config']
    assert not errors,errors
    print('PASS browser: custom subjects, empty input, AI-only presets, reload/history/export, safe titles and 320–1440px')
    for blocked_getter in (True, False):
        guarded = browser.new_context(viewport={'width':390,'height':844})
        if blocked_getter:
            guarded.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError')}})")
        else:
            guarded.add_init_script("Object.defineProperty(window,'localStorage',{value:Object.freeze({getItem(){return null},setItem(){throw Error('readonly')},removeItem(){throw Error('readonly')}})})")
        guarded_fixture = SimulatedAPI()
        protected_variant = guarded_fixture.variant({'topic':'python','level':'easy','count':1})
        protected_variant['tasks'][0]['question'] = 'Что выведет программа?\nprint("<img src=x onerror=alert(1)>")'
        guarded.route('**/api/**',guarded_fixture.route)
        guarded_page = guarded.new_page()
        guarded_page.on('pageerror',lambda error:errors.append(str(error)))
        guarded_page.goto(BASE)
        expect(guarded_page.locator('.code-block')).to_contain_text('<img src=x')
        assert guarded_page.locator('.code-block img').count() == 0
        guarded_page.fill('#chat-input','черновик')
        guarded_page.fill('#chat-input','первая строка')
        before = len(guarded_fixture.calls)
        guarded_page.locator('#chat-input').press('Shift+Enter')
        assert '\n' in guarded_page.locator('#chat-input').input_value()
        assert len(guarded_fixture.calls) == before, 'Shift+Enter must not send a request'
        assert not guarded_page.evaluate('() => document.documentElement.scrollWidth > innerWidth')
        guarded.close()
    assert not errors, errors
    print('PASS browser: blocked/readonly storage, safe Python code text and Shift+Enter')
    browser.close()
