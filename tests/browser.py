"""Real Chromium checks. No paid requests: model routes below are explicit mocks."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('TEST_BASE_URL', 'http://127.0.0.1:8000')
ARTIFACTS = Path(os.environ.get('TEST_ARTIFACTS', '/tmp/praktikum-browser'))
ARTIFACTS.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
        headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    page = context.new_page()
    # Ordinary UI checks must never spend requests if the development server
    # already has a real provider key configured.
    page.route('**/api/status', lambda route: route.fulfill(json={'aiAvailable': False}))
    unexpected_model_requests = []
    def block_model_request(route):
        unexpected_model_requests.append(route.request.url)
        route.abort()
    page.route('**/api/generate', block_model_request)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('.task-card')).to_have_count(5)
    expect(page.locator('#connection-status')).to_contain_text('Обычная практика доступна')
    expect(page.locator('#ai-option')).to_be_disabled()

    for topic in ('complex', 'sets', 'python'):
        for level in ('easy', 'medium', 'hard'):
            page.select_option('#topic', topic)
            page.locator(f'input[name="level"][value="{level}"]').check()
            page.fill('#count', '10' if level == 'hard' else '1')
            page.click('#generate-button')
            expect(page.locator('.task-card')).to_have_count(10 if level == 'hard' else 1)
            expect(page.locator('#settings-notice')).to_be_hidden()
    print('PASS browser: all topics and difficulty levels, task counts and changed settings')

    variant = page.locator('#variant-number').inner_text()
    question = page.locator('.task-question').first.inner_text()
    page.locator('.task-reveals summary').first.click()
    expect(page.locator('.task-reveals details').first).to_have_attribute('open', '')
    page.locator('input[data-solved="0"]').check()
    expect(page.locator('#progress-label')).to_have_text('Решено 1 из 10')
    page.reload()
    expect(page.locator('#variant-number')).to_have_text(variant)
    expect(page.locator('input[data-solved="0"]')).to_be_checked()
    expect(page.locator('.task-question').first).to_have_text(question, use_inner_text=True)
    page.click('#nav-history')
    page.fill('#history-search', 'несуществующий вариант')
    expect(page.locator('.empty-history')).to_be_visible()
    page.fill('#history-search', 'Комплексные')
    expect(page.locator('.history-entry')).to_have_count(4)  # initial + three levels
    page.locator('button[data-load]').last.click()
    opened = page.locator('#variant-number').inner_text()
    assert opened != variant
    page.reload()
    expect(page.locator('#variant-number')).to_have_text(opened)
    page.click('#nav-guide')
    expect(page.locator('#guide-dialog')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('#guide-dialog')).not_to_be_visible()
    print('PASS browser: hints, progress, history search, guide, Escape and last-opened restoration')

    page.click('#prompt-tab')
    expect(page.locator('#prompt-panel')).to_be_visible()
    context.grant_permissions(['clipboard-read', 'clipboard-write'])
    page.click('#copy-prompt')
    expect(page.locator('#toast')).to_have_text('Промпт скопирован.')
    assert page.evaluate('() => navigator.clipboard.readText()') == page.locator('#prompt-text').inner_text()
    page.locator('#prompt-tab').press('ArrowLeft')
    expect(page.locator('#tasks-panel')).to_be_visible()
    with page.expect_download() as saved:
        page.click('#download-variant')
    path = saved.value.path()
    text = Path(path).read_text(encoding='utf-8-sig')
    assert 'ЗАДАНИЕ 1' in text and 'Ответ:' not in text
    page.check('#include-answers')
    with page.expect_download() as saved:
        page.click('#download-variant')
    assert 'Ответ:' in Path(saved.value.path()).read_text(encoding='utf-8-sig')

    page.evaluate('''() => {window.print = () => {
      window.printed = [...document.querySelectorAll('#task-list details')].map(d => d.open);
      window.dispatchEvent(new Event('afterprint'));
    };}''')
    page.click('#print-variant')
    opened_details = page.evaluate('() => window.printed')
    assert all(value == (index % 2 == 1) for index, value in enumerate(opened_details))
    page.uncheck('#include-answers')
    page.click('#print-variant')
    assert not any(page.evaluate('() => window.printed'))
    page.pdf(path=str(ARTIFACTS / 'worksheet.pdf'), format='A4')
    assert (ARTIFACTS / 'worksheet.pdf').stat().st_size > 1000
    print('PASS browser: tabs, clipboard and keyboard, TXT with/without answers, print selection and PDF rendering')

    for width in (320, 390, 768, 1024, 1440):
        page.set_viewport_size({'width': width, 'height': 1000})
        assert not page.evaluate('() => document.documentElement.scrollWidth > innerWidth'), f'Overflow at {width}'
    page.screenshot(path=str(ARTIFACTS / 'desktop.png'), full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path=str(ARTIFACTS / 'mobile.png'), full_page=True)
    assert not errors, errors
    assert not unexpected_model_requests, unexpected_model_requests
    print('PASS browser: 320–1440 px, screenshots, no JavaScript errors')

    # Real frontend state transitions with an explicitly simulated model service.
    ai_context = browser.new_context(viewport={'width': 1280, 'height': 900})
    ai_page = ai_context.new_page()
    ai_page.on('pageerror', lambda error: errors.append(str(error)))
    ai_page.route('**/api/status', lambda route: route.fulfill(json={'aiAvailable': True}))
    pending = []
    ai_page.route('**/api/generate', lambda route: pending.append(route))
    ai_page.goto(BASE)
    expect(ai_page.locator('#ai-option')).to_be_enabled()
    expect(ai_page.locator('#source')).to_have_value('ai')
    assert not pending, 'Opening the page must not spend a paid model request'
    ai_page.select_option('#source', 'ai')
    ai_page.fill('#count', '1')
    ai_page.click('#generate-button')
    expect(ai_page.locator('#generate-button')).to_be_disabled()
    expect(ai_page.locator('#generation-status')).to_be_visible()
    ai_result = {'topic': 'complex', 'difficulty': 'easy', 'tasks': [{
        'type': 'Сложение', 'question': '<img src=x onerror=alert(1)> Найди 2 + 2.',
        'hint': 'Сложи два и два.', 'answer': '4', 'explanation': '2 + 2 = 4.'}]}
    pending.pop().fulfill(json={'result': ai_result})
    expect(ai_page.locator('#variant-source')).to_have_text('Создано ИИ')
    expect(ai_page.locator('.task-card')).to_have_count(1)
    expect(ai_page.locator('.task-question')).to_contain_text('<img src=x')
    expect(ai_page.locator('.task-question img')).to_have_count(0)
    expect(ai_page.locator('#model-warning')).to_be_visible()
    expect(ai_page.locator('#generate-button')).to_be_enabled()
    ai_page.reload()
    expect(ai_page.locator('#variant-source')).to_have_text('Создано ИИ')
    expect(ai_page.locator('.task-question')).to_contain_text('Найди 2 + 2.')
    ai_page.select_option('#source', 'ai')
    ai_page.click('#regenerate')
    expect(ai_page.locator('#generation-status')).to_be_visible()
    pending.pop().fulfill(status=502, json={'error': 'Сервис временно недоступен.'})
    expect(ai_page.locator('#generation-error')).to_have_text('Сервис временно недоступен.')
    expect(ai_page.locator('#variant-source')).to_have_text('Создано ИИ')
    expect(ai_page.locator('#generate-button')).to_be_enabled()
    ai_page.select_option('#source', 'local')
    ai_page.click('#generate-button')
    expect(ai_page.locator('#variant-source')).to_have_text('Локальные шаблоны')
    expect(ai_page.locator('#generation-error')).to_be_hidden()
    assert not errors, errors
    print('PASS browser: simulated AI success, loading, escaped output, restoration, failure and manual local mode')
    browser.close()
