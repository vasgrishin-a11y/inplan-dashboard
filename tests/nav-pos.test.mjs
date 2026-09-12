/* ─────────────────────────────────────────────────────────────────────────────
   Smoke-тест переключателя позиции меню (кнопка #bNavPos в шапке).

   Тест поднимает НАСТОЯЩИЙ index.html в jsdom вместе с настоящими скриптами
   приложения и кликает по настоящей кнопке — никаких стабов логики: проверяется
   поведение собранной страницы, а не её пересказ.

   Главная регрессия: раньше правило
       .app.nav-top .btn-rail-menu{display:none}
   прятало в режиме «сверху» ОБЕ кнопки шапки (у #bNavPos тоже класс
   .btn-rail-menu), включая сам переключатель — вернуться к левому меню мышью
   было нечем. Проверка «кнопка видна в nav-top» ловит ровно это.

   Запуск:  npm test
   Проверка другой ревизии страницы:  INPLAN_HTML=/path/to/index.html npm test
   ───────────────────────────────────────────────────────────────────────────── */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole, requestInterceptor } = jsdomPkg;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.INPLAN_HTML
  ? path.resolve(process.env.INPLAN_HTML)
  : path.join(ROOT, 'index.html');
const BASE = 'http://localhost:8080'; // origin страницы (нужен для localStorage)
const NAVPOS_KEY = 'inplan_navpos';
const MIME = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
};

/** Отдаём локальные файлы страницы; всё внешнее (шрифты и т.п.) глушим. */
const localResources = requestInterceptor((request) => {
  const u = new URL(request.url);
  if (u.origin === BASE) {
    const file = path.join(ROOT, u.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return new Response(fs.readFileSync(file), {
        headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' },
      });
    }
  }
  return new Response('', { headers: { 'Content-Type': 'text/css' } });
});

/** Загрузка приложения. seed — значения localStorage до первого скрипта. */
async function loadApp(seed = {}) {
  const virtualConsole = new VirtualConsole();
  const noise = [];
  // canvas/fonts не нужны для этого теста — приложение их переживает в try/catch
  virtualConsole.on('jsdomError', (e) => noise.push(String(e.message || e).split('\n')[0]));

  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: { interceptors: [localResources] },
    beforeParse(window) {
      for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
    },
  });

  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400)); // дожидаемся wiring'а

  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    app: dom.window.document.getElementById('app'),
    btn: dom.window.document.getElementById('bNavPos'),
    hdrBtn: dom.window.document.getElementById('bRailToggleHdr'),
    isTop: () => dom.window.document.getElementById('app').classList.contains('nav-top'),
    display: (el) => dom.window.getComputedStyle(el).display,
    noise,
    close() {
      try {
        dom.window.close();
      } catch {
        /* jsdom может бросить DOMException на close — не суть теста */
      }
    },
  };
}

test('кнопка переключения есть в шапке и кликабельна', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  assert.ok(ctx.btn, '#bNavPos должен существовать');
  assert.equal(typeof ctx.btn.onclick, 'function', 'на #bNavPos должен висеть обработчик клика');
  assert.ok(ctx.btn.closest('header .hdr-left'), 'кнопка должна лежать в .hdr-left шапки');

  const title = ctx.document.getElementById('pgTitle');
  assert.ok(
    !!(ctx.btn.compareDocumentPosition(title) & 4), // DOCUMENT_POSITION_FOLLOWING
    'кнопка должна стоять слева от заголовка страницы'
  );
});

test('режим «слева»: обе кнопки шапки видны', async (t) => {
  const ctx = await loadApp({ [NAVPOS_KEY]: 'left' });
  t.after(ctx.close);

  assert.equal(ctx.isTop(), false, 'по умолчанию класс nav-top не навешен');
  assert.notEqual(ctx.display(ctx.btn), 'none', '#bNavPos видна');
  assert.notEqual(ctx.display(ctx.hdrBtn), 'none', '«Свернуть панель» видна');
});

test('клик уводит меню наверх, и переключатель остаётся видимым (регрессия)', async (t) => {
  const ctx = await loadApp({ [NAVPOS_KEY]: 'left' });
  t.after(ctx.close);

  ctx.btn.click();

  assert.equal(ctx.isTop(), true, 'после клика должен появиться класс nav-top');
  assert.notEqual(
    ctx.display(ctx.btn),
    'none',
    'РЕГРЕССИЯ: в режиме «сверху» переключатель #bNavPos обязан быть виден, ' +
      'иначе вернуться к левому меню мышью нечем'
  );
  assert.equal(
    ctx.display(ctx.hdrBtn),
    'none',
    'в режиме «сверху» кнопка «Свернуть панель» не нужна и скрыта'
  );
});

test('в режиме «сверху» переключатель подсвечен акцентом', async (t) => {
  const ctx = await loadApp({ [NAVPOS_KEY]: 'left' });
  t.after(ctx.close);

  const before = ctx.window.getComputedStyle(ctx.btn).color;
  ctx.btn.click();
  const after = ctx.window.getComputedStyle(ctx.btn).color;

  assert.notEqual(after, before, 'цвет переключателя должен меняться в nav-top');
  assert.match(after, /var\(--scp-accent\)|rgb/, 'подсветка — фирменный акцент');
});

test('иконка и подсказка переключаются вместе с позицией', async (t) => {
  const ctx = await loadApp({ [NAVPOS_KEY]: 'left' });
  t.after(ctx.close);

  const line = ctx.btn.querySelector('.np-l');
  assert.ok(line, 'внутри кнопки есть линия .np-l (иконка позиции)');

  const leftTitle = ctx.btn.title;
  assert.match(leftTitle, /наверх/i, 'подсказка в режиме «слева» зовёт наверх');
  const leftAttrs = ['x1', 'y1', 'x2', 'y2'].map((a) => line.getAttribute(a)).join(',');

  ctx.btn.click();

  const topAttrs = ['x1', 'y1', 'x2', 'y2'].map((a) => line.getAttribute(a)).join(',');
  assert.notEqual(topAttrs, leftAttrs, 'геометрия иконки меняется (вертикаль ↔ горизонталь)');
  assert.match(ctx.btn.title, /вернуть|левую панель/i, 'подсказка в режиме «сверху» зовёт назад');
});

test('повторный клик возвращает меню налево', async (t) => {
  const ctx = await loadApp({ [NAVPOS_KEY]: 'left' });
  t.after(ctx.close);

  ctx.btn.click();
  assert.equal(ctx.isTop(), true);
  ctx.btn.click();

  assert.equal(ctx.isTop(), false, 'класс nav-top снят');
  assert.notEqual(ctx.display(ctx.btn), 'none', '#bNavPos по-прежнему видна');
  assert.notEqual(ctx.display(ctx.hdrBtn), 'none', '«Свернуть панель» снова видна');
  assert.equal(ctx.window.localStorage.getItem(NAVPOS_KEY), 'left');
});

test('выбор пишется в localStorage и переживает перезагрузку', async (t) => {
  const first = await loadApp({ [NAVPOS_KEY]: 'left' });
  first.btn.click();
  assert.equal(first.window.localStorage.getItem(NAVPOS_KEY), 'top');
  first.close();

  const reloaded = await loadApp({ [NAVPOS_KEY]: 'top' });
  t.after(reloaded.close);

  assert.equal(reloaded.isTop(), true, 'позиция восстановилась при загрузке');
  assert.notEqual(
    reloaded.display(reloaded.btn),
    'none',
    'после перезагрузки в режиме «сверху» переключатель виден'
  );
  assert.match(reloaded.btn.title, /вернуть|левую панель/i);
});

test('в режиме «сверху» свёрнутая панель не остаётся залипшей', async (t) => {
  const ctx = await loadApp({ [NAVPOS_KEY]: 'left' });
  t.after(ctx.close);

  ctx.app.classList.add('min'); // имитируем свёрнутую левую панель
  ctx.btn.click();

  assert.equal(ctx.isTop(), true);
  assert.equal(
    ctx.app.classList.contains('min'),
    false,
    'при переходе наверх состояние «свёрнуто» сбрасывается'
  );
  assert.equal(ctx.document.getElementById('railToggle').textContent.trim(), '‹ Свернуть панель');
});
