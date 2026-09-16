/* ─────────────────────────────────────────────────────────────────────────────
   Доступность графиков (CODE_AUDIT.md, C2).

   Canvas не имеет содержимого для скринридера: без текстовой альтернативы
   пользователь вспомогательных технологий получает на вкладке десять пустых
   областей. Поэтому каждый график проходит через cv(), который ставит
   role="img" и aria-label из заголовка и подписи карточки — тех же строк, что
   объясняют график sighted-пользователю. Подпись меняется при переключении
   разреза, поэтому альтернатива пересчитывается на каждой отрисовке.

   Проверяется по всем вкладкам сразу: регрессия «новый график без альтернативы»
   ловится тестом, а не ревью.

   Запуск:  npm test
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
const BASE = 'http://localhost:8080';
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

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

/** 2D-контекст-пустышка: отрисовка не должна падать в jsdom. */
function installCanvasStub(window) {
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return 1240; },
  });
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (this.__ctx) return this.__ctx;
    const state = {};
    const base = {
      canvas: this,
      measureText: (t) => ({ width: String(t == null ? '' : t).length * 6.2 }),
      getLineDash: () => [],
      createLinearGradient: () => ({ addColorStop() {} }),
      createPattern: () => null,
      isPointInPath: () => false,
    };
    this.__ctx = new Proxy(base, {
      get(t, k) {
        if (k in t) return t[k];
        if (k in state) return state[k];
        const noop = () => {};
        state[k] = noop;
        return noop;
      },
      set(t, k, v) { state[k] = v; return true; },
      has(t, k) { return k in t || k in state; },
    });
    return this.__ctx;
  };
}

async function loadApp(seed = {}) {
  const virtualConsole = new VirtualConsole();
  const noise = [];
  virtualConsole.on('jsdomError', (e) => noise.push(String(e.message || e).split('\n')[0]));

  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: { interceptors: [localResources] },
    beforeParse(window) {
      installCanvasStub(window);
      for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
    },
  });

  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const window = dom.window;
  return {
    dom, window,
    document: window.document,
    noise,
    tick: (ms = 40) => new Promise((r) => setTimeout(r, ms)),
    ev: (code) => window.eval(code),
    /** все канвасы вкладки: id, роль, альтернатива */
    async canvases(tab) {
      window.eval(`go('${tab}')`);
      await new Promise((r) => setTimeout(r, 220));
      return [...window.document.querySelectorAll('#main canvas')].map((c) => ({
        id: c.id || '(без id)',
        role: c.getAttribute('role'),
        alt: c.getAttribute('aria-label') || '',
      }));
    },
    close() { try { dom.window.close(); } catch { /* jsdom: не суть */ } },
  };
}

const TABS_WITH_CHARTS = ['ov', 'dm', 'tree', 'lg', 'pd', 'caps', 'pc', 'st', 'cost', 'dq'];

test('у каждого графика на каждой вкладке есть роль и текстовая альтернатива', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  let total = 0;
  for (const tab of TABS_WITH_CHARTS) {
    const cs = await ctx.canvases(tab);
    assert.ok(cs.length > 0, `на вкладке «${tab}» есть графики`);
    total += cs.length;
    const noRole = cs.filter((c) => c.role !== 'img');
    const noAlt = cs.filter((c) => !c.alt.trim());
    const junk = cs.filter((c) => /NaN|undefined|\[object/.test(c.alt));
    assert.deepEqual(noRole.map((c) => c.id), [], `«${tab}»: все канвасы помечены role="img"`);
    assert.deepEqual(noAlt.map((c) => c.id), [], `«${tab}»: у всех канвасов есть aria-label`);
    assert.deepEqual(junk.map((c) => c.id), [], `«${tab}»: в альтернативе нет мусора`);
    cs.forEach((c) => assert.ok(c.alt.length <= 300,
      `«${tab}» ${c.id}: альтернатива не расползается (${c.alt.length} символов)`));
  }
  assert.ok(total >= 40, `проверено ${total} графиков — покрыты все вкладки с диаграммами`);
});

test('альтернатива графика объясняет, что нарисовано, а не называет его «график»', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const cs = await ctx.canvases('ov');
  const lm = cs.find((c) => c.id === 'o8');
  assert.ok(lm, 'график упущенной маржи найден');
  assert.match(lm.alt, /Упущенная маржа/, 'в альтернативе назван показатель');
  assert.match(lm.alt, /период/i, 'в альтернативе назван разрез');
  assert.ok(!/^\s*(график|диаграмма|canvas)\s*$/i.test(lm.alt), 'альтернатива не общая заглушка');

  const wf = cs.find((c) => /o1/.test(c.id));
  assert.ok(wf && /Выручка|Себестоимость|период/i.test(wf.alt),
    'у графика выручки/себестоимости альтернатива тоже содержательная');
});

test('альтернатива обновляется вместе с подписью при переключении разреза', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  ctx.ev("go('ov')");
  await ctx.tick(200);
  const before = ctx.document.getElementById('o8').getAttribute('aria-label');
  assert.match(before, /период/i, 'исходно активен разрез «Периоды»');

  ctx.document.querySelector('#o8dim [data-lmdim="prod"]').click();
  await ctx.tick(120);
  const after = ctx.document.getElementById('o8').getAttribute('aria-label');
  assert.notEqual(after, before, 'альтернатива пересчитана после переключения разреза');
  assert.match(after, /продукт/i, 'в альтернативе назван новый разрез');

  ctx.document.querySelector('#o8dim [data-lmdim="pp"]').click();
  await ctx.tick(120);
  const matrix = ctx.document.getElementById('o8').getAttribute('aria-label');
  assert.match(matrix, /продукт × период|продукт/i, 'альтернатива комбинированного разреза');
});

test('переключатели метода, базы и разреза — подписанные группы кнопок', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  ctx.ev("go('ov')");
  await ctx.tick(150);
  for (const id of ['lmSeg', 'lmBaseSeg', 'o8dim']) {
    const seg = ctx.document.getElementById(id);
    assert.ok(seg, `переключатель #${id} есть на вкладке «Общий»`);
    assert.equal(seg.getAttribute('role'), 'group', `#${id} — группа`);
    assert.ok(seg.getAttribute('aria-label'), `#${id} — группа подписана`);
    const btns = [...seg.querySelectorAll('button')];
    assert.ok(btns.length >= 2, `в #${id} несколько вариантов`);
    const pressed = btns.filter((b) => b.getAttribute('aria-pressed') === 'true');
    assert.equal(pressed.length, 1, `в #${id} ровно один активный вариант, и он помечен aria-pressed`);
    btns.forEach((b) => assert.ok(b.textContent.trim(), `кнопки в #${id} подписаны текстом`));
  }
});

test('канвас цепочки заказа помечен, а её данные продублированы реестром', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const cs = await ctx.canvases('tree');
  const chain = cs.find((c) => c.id === 'treeCanvas');
  assert.ok(chain, 'канвас цепочки заказа есть');
  assert.equal(chain.role, 'img', 'помечен как изображение');
  assert.match(chain.alt, /цепочк/i, 'в альтернативе сказано, что это цепочка');

  // табличный эквивалент: реестр шагов/мощностей под графиком
  const tables = ctx.document.querySelectorAll('#main table');
  assert.ok(tables.length > 0, 'под канвасом есть таблица — данные доступны без графики');
});
