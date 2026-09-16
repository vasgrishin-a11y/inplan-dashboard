/* ─────────────────────────────────────────────────────────────────────────────
   ТЗ владельца дашборда от 2026-09-16: навигация, фильтры, пояснения.

   Что проверяется:

   1. Режим «Сетка» в «Цепочке заказа» удалён ЦЕЛИКОМ: нет кнопки, нет ветки
      отрисовки, нет оценки высоты. Устаревшее значение режима (например, из
      открытой вкладки до обновления) не ломает отрисовку — работает «Площадки».
   2. Переход по заказу с узкого места из «Спрос и покрытие» открывает
      «Цепочку заказа» в виде «Этапы цепи» и в тоннах, а не в том режиме,
      который случайно остался включённым после прошлого просмотра.
   3. В «Мощностях» — отдельный переключатель по виду ресурса: один вид,
      несколько или все. Фильтр пересчитывает ВЕСЬ раздел (KPI, графики,
      реестр), а не только таблицу, и запоминается между перезагрузками.
   4. Инфостроки «ИСТОЧНИК» в начале «Спрос и покрытие» и «Экономика отказов»
      свёрнуты: суть видна в одну строку, детали — по клику. Предупреждения
      (когда данных не хватает) свёрнутыми быть не должны.
   5. У каждого расчётного показателя есть тултип-пояснение: формула и источник
      данных. Показываются наведением мыши и фокусом с клавиатуры.
   6. Во вкладке «Данные» — сколько маршрутов, ресурсов и поставщиков НЕ
      задействовано в плане и какой это процент от реестра. «Всего» берётся из
      реестра (capacity_view_sp / res_loc_loc), а не из операций, иначе
      незадействованное тождественно нулю; при отсутствии реестра это сказано
      вслух, а не замалчивается.

   Тесты поднимают настоящий index.html в jsdom на настоящем демо-наборе.

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
const CAPS_RT_KEY = 'inplan_caps_restype';

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

/** Записывающий 2D-контекст: вызовы — пустышки, тексты и hit-зоны запоминаются. */
function installCanvasStub(window) {
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      const w = this.ownerDocument && this.ownerDocument.defaultView;
      return Number(this.dataset.testWidth) || Number(w && w.__CANVAS_W) || 1240;
    },
  });
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (this.__ctx) return this.__ctx;
    const canvasEl = this;
    const state = {};
    const base = {
      canvas: this,
      fillText(t) { (canvasEl.__texts = canvasEl.__texts || []).push(String(t == null ? '' : t)); },
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
    tick: (ms = 60) => new Promise((r) => setTimeout(r, ms)),
    ev: (code) => window.eval(code),
    /** открыть вкладку и дождаться отрисовки (графики рисуются в setTimeout) */
    async go(tab, ms = 120) {
      window.eval(`go(${JSON.stringify(tab)})`);
      await new Promise((r) => setTimeout(r, ms));
    },
    /** KPI-карточка по заголовку */
    kpi(title) {
      return [...window.document.querySelectorAll('#main .kpi')]
        .find((el) => el.querySelector('.t') && el.querySelector('.t').textContent.trim() === title);
    },
    close() { try { dom.window.close(); } catch { /* jsdom: не суть */ } },
  };
}

/** «1 234,5» / «12 345» (ru-RU, неразрывные пробелы) → число */
const parseNum = (txt) => {
  const s = String(txt).replace(/[\s\u00A0\u202F]/g, '').replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

/* ─────────────── 1. Режим «Сетка» удалён из «Цепочки заказа» ─────────────── */

test('режим «Сетка» удалён: нет кнопки, а устаревшее значение не ломает отрисовку', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const src = fs.readFileSync(HTML, 'utf8');
  assert.ok(!/id="rlGrid"/.test(src), 'в разметке нет кнопки #rlGrid');
  assert.ok(!/RES_LAYOUT_MODE\s*===?\s*'grid'/.test(src), 'в коде не осталось ветки режима «Сетка»');
  assert.ok(!/rlGrid/.test(src), 'в файле вообще не осталось упоминаний rlGrid');

  await ctx.go('tree');
  /* Раскладка «Мощности цехов» — там lived переключатель раскладки */
  ctx.ev(`SELECTED_ORDER_ID=(DS.orders[0]||{}).id; TREE_VIEW_MODE='prod_res'; render()`);
  await ctx.tick();
  assert.equal(ctx.document.getElementById('rlGrid'), null, 'кнопки «Сетка» в DOM нет');
  assert.ok(ctx.document.getElementById('rlPlants'), 'кнопка «Площадки» на месте');
  assert.ok(ctx.document.getElementById('rlFocus'), 'кнопка «Фокус» на месте');

  /* Устаревшее значение (вкладка была открыта до обновления) → «Площадки».
     Канвас рисуется в setTimeout, поэтому читаем факт отрисовки после тика. */
  ctx.ev(`RES_LAYOUT_MODE='grid'; render()`);
  await ctx.tick(150);
  const r = JSON.parse(ctx.ev(`(function(){
    const c=document.getElementById('treeCanvas');
    const hs=(c&&c._h)||[];
    const btn=document.getElementById('rlPlants');
    return JSON.stringify({mode:RES_LAYOUT_MODE, cards:hs.filter(x=>x.h===58).length,
      plantsBtn:!!btn, plantsOn:!!btn && /(^|\\s)p(\\s|$)/.test(btn.className)});
  })()`));
  assert.ok(r.cards > 0, `карточки площадок нарисованы (${r.cards}) при устаревшем значении режима`);
  assert.equal(r.plantsOn, true, 'кнопка «Площадки» подсвечена — неизвестный режим ведёт себя как «Площадки»');
  assert.deepEqual(ctx.noise, [], 'отрисовка без ошибок: ' + ctx.noise.join(' | '));
});

/* ───────── 2. Переход из «Спрос и покрытие» → «Этапы цепи (тонны)» ───────── */

test('переход по заказу с узкого места открывает «Этапы цепи» в тоннах', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  await ctx.go('dm', 200);
  const link = ctx.document.querySelector('#main [data-goto-order]');
  assert.ok(link, 'в таблице дефицитных заказов есть ссылка перехода к цепочке заказа');
  assert.equal(link.dataset.treeMode, 'stages',
    'ссылка просит вид «Этапы цепи» — иначе откроется режим, оставшийся от прошлого просмотра');
  const orderId = Number(link.dataset.gotoOrder);
  assert.ok(Number.isFinite(orderId) && orderId > 0, `id заказа читается (${orderId})`);

  /* Мешаем переходу: ставим другой вид и другую метрику, как после прошлого
     просмотра. render() не вызываем — иначе ссылка пересоздастся и клик по
     старому узлу уйдёт в никуда (в жизни клик тоже идёт по живому узлу). */
  ctx.ev(`TREE_VIEW_MODE='bom'; TREE_METRIC_MODE='cost'`);
  const before = ctx.ev(`JSON.stringify({tab:TAB, view:TREE_VIEW_MODE, metric:TREE_METRIC_MODE})`);
  assert.equal(JSON.parse(before).view, 'bom', 'до клика вид — «Дерево BOM»');
  assert.equal(JSON.parse(before).tab, 'dm', 'до клика мы на «Спрос и покрытие»');

  link.click();
  await ctx.tick(140);

  const after = JSON.parse(ctx.ev(`JSON.stringify({tab:TAB, view:TREE_VIEW_MODE, metric:TREE_METRIC_MODE,
    sel:SELECTED_ORDER_ID})`));
  assert.equal(after.tab, 'tree', 'открылась вкладка «Цепочка заказа»');
  assert.equal(after.sel, orderId, 'выбран тот самый заказ из таблицы дефицита');
  assert.equal(after.view, 'stages', 'вид — «Этапы цепи»');
  assert.equal(after.metric, 'vol', 'метрика — тонны, а не себестоимость');

  /* Видимое состояние кнопок и карточки «Режим» совпадает с внутренним */
  assert.match(ctx.document.getElementById('vmStages').className, /\bp\b/, 'кнопка «Этапы цепи» активна');
  const unit = ctx.document.getElementById('treeUnitVol');
  assert.ok(unit, 'переключатель «Тонны» показан для режима этапов');
  assert.match(unit.className, /\bp\b/, 'кнопка «Тонны» активна');
  const modeCard = ctx.kpi('Режим');
  assert.ok(modeCard, 'карточка «Режим» есть');
  assert.equal(modeCard.querySelector('.v').textContent.trim(), 'Физический объём, т',
    'в карточке «Режим» сказано про тонны');
  assert.deepEqual(ctx.noise, [], 'переход без ошибок: ' + ctx.noise.join(' | '));
});

test('drill-down с узкого места открывает мощности заказа тоже в тоннах', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  await ctx.go('dm', 220);
  const badge = ctx.document.querySelector('#main [data-rca-jump]');
  if (!badge) { t.skip('в демо-наборе нет заказа с узким местом в таблице дефицита'); return; }

  ctx.ev(`TREE_METRIC_MODE='cost'`);            // мешаем переходу, как после прошлого просмотра
  const ord = Number(badge.dataset.ord);
  badge.click();
  await ctx.tick(160);

  const r = JSON.parse(ctx.ev(`JSON.stringify({tab:TAB, view:TREE_VIEW_MODE, metric:TREE_METRIC_MODE,
    sel:SELECTED_ORDER_ID, focus:TREE_FOCUSED_KEY})`));
  assert.equal(r.tab, 'tree', 'открылась «Цепочка заказа»');
  assert.equal(r.sel, ord, 'выбран заказ с узкого места');
  assert.equal(r.view, badge.dataset.mode || 'prod_res', 'вид — мощности из бейджа узкого места');
  assert.equal(r.metric, 'vol', 'метрика — тонны: drill-down не оставляет себестоимость от прошлого просмотра');
  assert.ok(r.focus, 'узел узкого места подсвечен');
});

/* ─────────── 3. «Мощности»: переключатель по виду ресурса ─────────── */

test('фильтр по виду ресурса пересчитывает весь раздел «Мощности»', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  /* В демо-наборе все строки мощностей одного вида — делаем два, чтобы
     переключатель было на чём проверить (в бою виды приходят из выгрузки) */
  ctx.ev(`DS.capacity.forEach((c,i)=>{ c.resType = i%2 ? 'Склад готовой продукции' : 'Мощность цеха'; }); render()`);
  await ctx.go('caps');

  const chips = () => [...ctx.document.querySelectorAll('#main .rt-filter .chip')];
  assert.ok(chips().length >= 3, `переключатель вида ресурса показан (чипов: ${chips().length})`);
  const labels = chips().map((c) => c.textContent.replace(/\s+/g, ' ').trim());
  assert.ok(labels.some((l) => /^Все(\s|$)/.test(l)), 'есть вариант «Все»');
  assert.ok(labels.some((l) => l.includes('Мощность цеха')), 'есть чип «Мощность цеха»');
  assert.ok(labels.some((l) => l.includes('Склад готовой продукции')), 'есть чип «Склад готовой продукции»');

  const fund = () => parseNum(ctx.kpi('Доступный фонд').querySelector('.v').textContent);
  const all = ctx.ev(`DS.capacity.reduce((s,c)=>s+(c.avail||0),0)`);
  const only = (rt) => ctx.ev(`DS.capacity.filter(c=>(c.resType||'—')===${JSON.stringify(rt)})
    .reduce((s,c)=>s+(c.avail||0),0)`);
  assert.ok(close(fund(), all, 1e-9), 'без фильтра фонд — по всем видам ресурса');

  // один вид
  chips().find((c) => c.textContent.includes('Склад готовой продукции')).click();
  await ctx.tick(140);
  assert.ok(close(fund(), only('Склад готовой продукции'), 1e-9),
    'фонд пересчитан по выбранному виду ресурса');
  assert.deepEqual(JSON.parse(ctx.ev(`JSON.stringify(CAPS_RT)`)), ['Склад готовой продукции'],
    'состояние фильтра — один вид');
  assert.equal(ctx.window.localStorage.getItem(CAPS_RT_KEY), '["Склад готовой продукции"]',
    'выбор запомнен между перезагрузками');
  const rowsHtml = ctx.document.getElementById('cs5').textContent;
  assert.ok(!rowsHtml.includes('Мощность цеха'), 'в реестре остались только строки выбранного вида');
  assert.match(ctx.document.querySelector('#main .rt-note').textContent, /Показано \d+ из \d+/,
    'сказано, сколько ресурс-периодов показано из всех');

  // несколько видов
  chips().find((c) => c.textContent.includes('Мощность цеха')).click();
  await ctx.tick(140);
  assert.deepEqual(JSON.parse(ctx.ev(`JSON.stringify(CAPS_RT.slice().sort())`)),
    ['Мощность цеха', 'Склад готовой продукции'].sort(), 'виды складываются — фильтр множественный');
  assert.ok(close(fund(), all, 1e-9), 'оба вида выбраны — фонд снова полный');

  // сброс
  chips().find((c) => /^Все(\s|$)/.test(c.textContent.replace(/\s+/g, ' ').trim())).click();
  await ctx.tick(140);
  assert.deepEqual(JSON.parse(ctx.ev(`JSON.stringify(CAPS_RT)`)), [], '«Все» снимает фильтр');
  assert.ok(close(fund(), all, 1e-9), 'фонд — по всем видам');
  assert.equal(ctx.window.localStorage.getItem(CAPS_RT_KEY), '[]', 'сброс тоже запомнен');
  assert.deepEqual(ctx.noise, [], 'фильтр без ошибок: ' + ctx.noise.join(' | '));
});

test('фильтр по виду ресурса переживает перезагрузку и чужие значения отбрасывает', async (t) => {
  const ctx = await loadApp({ [CAPS_RT_KEY]: '["Вид из прошлой выгрузки"]' });
  t.after(ctx.close);
  await ctx.go('caps');
  /* Значения, которых нет в текущей выгрузке, не должны оставлять раздел пустым:
     сохранённый список остаётся как есть (вдруг вернётся выгрузка с этим видом),
     но в расчёт не берётся. */
  const onChips = ctx.ev(`JSON.stringify([...document.querySelectorAll('#main .rt-filter .chip.on')]
    .map(c=>c.textContent.replace(/\\s+/g,' ').trim()))`);
  assert.deepEqual(JSON.parse(onChips).filter((l) => !/^Все(\s|$)/.test(l)), [],
    'ни один несуществующий вид не подсвечен как выбранный');
  assert.equal(ctx.document.querySelector('#main .rt-note'), null,
    'подписи «Показано N из M» нет — раздел не отфильтрован');
  const fund = parseNum(ctx.kpi('Доступный фонд').querySelector('.v').textContent);
  const all = ctx.ev(`DS.capacity.reduce((s,c)=>s+(c.avail||0),0)`);
  assert.ok(close(fund, all, 1e-9), 'раздел показан целиком, а не пустым');
});

/* ─────────── 4. Инфостроки «Источник» свёрнуты ─────────── */

test('строки «Источник» свёрнуты, а предупреждения — раскрыты', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  for (const tab of ['dm', 'cost']) {
    await ctx.go(tab, 160);
    const fold = ctx.document.querySelector('#main details.src-fold');
    assert.ok(fold, `в «${tab}» инфострока свёрнута в <details>`);
    const sum = fold.querySelector('summary');
    assert.ok(sum, 'есть <summary> — по нему раскрывают детали');
    const tag = sum.querySelector('.tag');
    assert.ok(tag, 'в свёрнутом виде виден тег строки');
    const brief = sum.querySelector('.sf-b');
    assert.ok(brief && brief.textContent.trim().length > 10,
      'в свёрнутом виде видна суть, а не только слово «Источник»');
    const body = fold.querySelector('.dq .m');
    assert.ok(body && body.textContent.trim().length > 20, 'полный текст строки сохранён внутри');

    const sev = [...(fold.querySelector('.dq') || {}).classList || []].filter((c) => c !== 'dq')[0];
    const isOpen = fold.hasAttribute('open');
    if (sev === 'i') {
      assert.equal(isOpen, false, `«${tab}»: обычная инфострока по умолчанию свёрнута`);
    } else {
      assert.equal(isOpen, true, `«${tab}»: предупреждение (${sev}) прятать нельзя — оно раскрыто`);
    }
  }

  /* В «Спрос и покрытие» при базе «непокрытый спрос» строка информационная */
  await ctx.go('dm', 160);
  const fold = ctx.document.querySelector('#main details.src-fold');
  assert.equal(fold.querySelector('.tag').textContent.trim(), 'Источник',
    'свёрнутая строка помечена как «Источник»');
  const looseSrc = [...ctx.document.querySelectorAll('#main > .dq')]
    .filter((el) => /Источник/.test(el.textContent));
  assert.deepEqual(looseSrc, [], 'несвёрнутого баннера «Источник» в начале раздела больше нет');
});

/* ─────────── 5. Тултип-пояснение у каждого расчётного показателя ─────────── */

const SERVICE_CARDS = new Set([
  'Возможности', 'Активная таблица', 'Режим', 'Выбранный заказ',
]);

test('у расчётных KPI есть пояснение: формула и источник данных', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const tabs = ['ov', 'dm', 'caps', 'cost', 'pd', 'pc', 'lg', 'st', 'raw', 'dq', 'tree'];
  let checked = 0, withHelp = 0;
  const missing = [];

  for (const tab of tabs) {
    if (tab === 'tree') {
      ctx.ev(`SELECTED_ORDER_ID=(DS.orders[0]||{}).id;`);
    }
    await ctx.go(tab, 140);
    const cards = [...ctx.document.querySelectorAll('#main .kpi')];
    assert.ok(cards.length > 0, `в «${tab}» есть KPI-карточки`);
    for (const card of cards) {
      const title = card.querySelector('.t').textContent.trim();
      if (SERVICE_CARDS.has(title)) continue;
      checked++;
      const help = card.getAttribute('data-help') || '';
      if (help.trim().length > 20) withHelp++;
      else missing.push(`${tab}: ${title}`);
    }
  }

  assert.ok(checked > 60, `проверено много карточек (${checked})`);
  assert.deepEqual(missing, [], 'у всех расчётных показателей есть пояснение');
  assert.equal(withHelp, checked, 'пояснение есть у каждой расчётной карточки');
});

test('пояснение показывает формулу и источник, а не общие слова', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('caps', 140);

  const card = ctx.kpi('Средняя утилизация');
  assert.ok(card, 'карточка «Средняя утилизация» есть');
  const help = card.getAttribute('data-help');
  assert.match(help, /load/, 'в пояснении названы слагаемые формулы');
  assert.match(help, /avail/, 'в пояснении назван знаменатель');
  const plain = card.getAttribute('title');
  assert.ok(plain && !/<[^>]+>/.test(plain), 'в title — тот же текст без разметки (его читают скринридеры)');

  /* Значок «?» — точка входа с клавиатуры; заголовок карточки остаётся чистым */
  const q = card.querySelector('.kpi-q');
  assert.ok(q, 'у карточки есть значок «?»');
  assert.equal(q.getAttribute('tabindex'), '0', 'значок достижим с клавиатуры');
  assert.ok((q.getAttribute('aria-label') || '').length > 20, 'у значка есть текстовая альтернатива');
  assert.equal(card.querySelector('.t').textContent.trim(), 'Средняя утилизация',
    'значок не попал в текст заголовка');

  const n = ctx.ev(`Object.keys(METRIC_HELP).length`);
  assert.ok(n >= 60, `реестр пояснений покрывает показатели (записей: ${n})`);
});

test('в сравнении версий у показателей тоже есть пояснения', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  /* Кладём один снапшот в историю — иначе вкладка «Версии» показывает пустое
     состояние и проверять нечего. alert() не дёргаем: пишем прямо в хранилище. */
  ctx.ev(`localStorage.setItem('sop_vers', JSON.stringify([snap(DS)]))`);
  await ctx.go('vs', 180);

  const cards = [...ctx.document.querySelectorAll('#main .kpi')];
  assert.ok(cards.length >= 5, `карточки сравнения версий отрисованы (${cards.length})`);
  const missing = cards.filter((c) => (c.getAttribute('data-help') || '').length <= 20)
    .map((c) => c.querySelector('.t').textContent.trim());
  assert.deepEqual(missing, [], 'у всех показателей сравнения есть пояснение');
});

test('пояснение показывается наведением мыши и фокусом с клавиатуры', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('ov', 140);

  const card = ctx.kpi('Упущенная маржа');
  assert.ok(card, 'карточка «Упущенная маржа» есть');
  const tip = ctx.document.getElementById('tip');
  assert.ok(tip, 'в приложении есть элемент тултипа');

  const fire = (el, type, x = 300, y = 200) => el.dispatchEvent(new ctx.window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
  }));

  assert.notEqual(tip.style.display, 'block', 'до наведения тултип скрыт');
  fire(card, 'mousemove', 320, 240);
  await ctx.tick(10);
  assert.equal(tip.style.display, 'block', 'при наведении на карточку тултип показан');
  assert.ok(tip.innerHTML.length > 20, 'в тултипе есть текст пояснения');
  assert.match(tip.innerHTML, /марж|Марж/, 'пояснение — про этот показатель');
  assert.ok(tip.style.left && tip.style.top, 'тултип позиционирован');

  fire(card, 'mouseout');
  await ctx.tick(10);
  assert.notEqual(tip.style.display, 'block', 'при уходе мыши тултип скрыт');

  const q = card.querySelector('.kpi-q');
  q.dispatchEvent(new ctx.window.FocusEvent('focusin', { bubbles: true }));
  await ctx.tick(10);
  assert.equal(tip.style.display, 'block', 'фокус на значке «?» тоже показывает пояснение');
  q.dispatchEvent(new ctx.window.FocusEvent('focusout', { bubbles: true }));
  await ctx.tick(10);
  assert.notEqual(tip.style.display, 'block', 'после снятия фокуса тултип скрыт');
});

/* ───── 6. «Данные»: маршруты, ресурсы и поставщики не задействованы ───── */

test('во вкладке «Данные» видно, что не задействовано в плане, и в процентах', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('raw', 200);

  const kpi = ctx.kpi('Не задействовано в плане');
  assert.ok(kpi, 'KPI «Не задействовано в плане» есть');
  assert.ok(kpi.getAttribute('data-help'), 'у KPI есть пояснение, как он считается');

  const cv = ctx.document.getElementById('rUn');
  assert.ok(cv && cv.tagName === 'CANVAS', 'график незадействованных нарисован на канвасе');
  const tbl = ctx.document.getElementById('rUnTbl');
  assert.ok(tbl, 'таблица с точными числами есть');
  const txt = tbl.textContent;
  for (const cat of ['Маршруты', 'Ресурсы', 'Поставщики']) {
    assert.ok(txt.includes(cat), `в таблице есть категория «${cat}»`);
  }
  assert.match(txt, /Источник «всего»/, 'для каждой категории назван источник реестра');
  assert.match(txt, /Не задействовано, %/, 'процент от общего количества показан отдельной колонкой');

  /* Числа сходятся: всего = задействовано + не задействовано, % = доля,
     KPI = сумма по трём категориям. Считаем независимо от кода вкладки. */
  const r = JSON.parse(ctx.ev(`(function(){
    const cap=DS.capacity||[], ops=DS.ops||[];
    const regRs=new Set(cap.filter(c=>c.cat!=='route').map(c=>c.rs).filter(Boolean));
    const usedRs=new Set(ops.filter(o=>o.rs&&Number(o.v)>0).map(o=>o.rs));
    const allVd=new Set(ops.map(o=>o.vd).filter(Boolean));
    const usedVd=new Set(ops.filter(o=>o.type==='procurement'&&o.vd&&Number(o.v)>0).map(o=>o.vd));
    const legs=new Set(ops.filter(o=>o.type==='movement'&&Number(o.v)>0)
      .map(o=>(o.fr||'')+'\\u2192'+(o.to||'')));
    return JSON.stringify({regRs:regRs.size, usedRsInReg:[...regRs].filter(r=>usedRs.has(r)).length,
      allVd:allVd.size, usedVdInAll:[...allVd].filter(v=>usedVd.has(v)).length, legs:legs.size,
      routeReg:cap.filter(c=>c.cat==='route').length,
      outside:[...usedRs].filter(r=>!regRs.has(r)).length});
  })()`));

  const rows = JSON.parse(ctx.ev(`JSON.stringify([...document.querySelectorAll('#rUnTbl tbody tr')]
    .map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent.trim())))`))
    .filter((c) => c.length >= 5);
  assert.equal(rows.length, 3, `в таблице три категории (есть ${rows.length})`);
  const byCat = Object.fromEntries(rows.map((c) => [c[0].replace(/\s*\(.*/, ''), c]));

  // поставщики: реестр = упоминания в операциях
  const vd = byCat['Поставщики'];
  assert.ok(vd, 'строка поставщиков найдена: ' + rows.map((c) => c[0]).join(' | '));
  assert.equal(parseNum(vd[1]), r.allVd, 'всего поставщиков = упомянутых в операциях');
  assert.equal(parseNum(vd[2]), r.usedVdInAll, 'задействовано = с закупкой ненулевого объёма');
  assert.equal(parseNum(vd[3]), r.allVd - r.usedVdInAll, 'не задействовано = разница');
  const vdPct = parseNum(vd[4]);
  assert.ok(close(vdPct, (r.allVd - r.usedVdInAll) / Math.max(r.allVd, 1) * 100, 1e-2),
    `процент считается от общего числа (${vdPct})`);

  // ресурсы: реестр = capacity_view_sp
  const rs = byCat['Ресурсы'];
  assert.ok(rs, 'строка ресурсов найдена');
  if (r.regRs > 0) {
    assert.equal(parseNum(rs[1]), r.regRs, 'всего ресурсов = реестр мощностей');
    assert.equal(parseNum(rs[2]), r.usedRsInReg, 'задействовано = ресурсы реестра с объёмом в операциях');
    assert.equal(parseNum(rs[3]), r.regRs - r.usedRsInReg, 'не задействовано = разница');
  }

  // KPI = сумма по категориям
  const kpiVal = parseNum(kpi.querySelector('.v').textContent);
  const sum = rows.reduce((s, c) => s + parseNum(c[3]), 0);
  assert.ok(close(kpiVal, sum, 1e-9), `KPI «Не задействовано в плане» (${kpiVal}) = сумма категорий (${sum})`);

  /* Честность: если реестра маршрутов нет — это сказано вслух, а не показано нулём
     как «всё задействовано» без оговорок */
  const notes = ctx.document.getElementById('main').textContent;
  if (r.routeReg === 0) {
    assert.match(notes, /res_loc_loc/, 'сказано, откуда берутся маршруты и почему реестра нет');
  }
  if (r.outside > 0) {
    assert.match(notes, /отсутствуют в реестре мощностей/,
      'ресурсы операций вне реестра мощностей названы вслух — иначе утилизация по ним не считается');
  }
  assert.deepEqual(ctx.noise, [], 'вкладка «Данные» без ошибок: ' + ctx.noise.join(' | '));
});

test('незадействованные маршруты и ресурсы появляются, когда реестр шире плана', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('raw', 200);

  /* Добавляем в реестр направление и ресурс, которым план не дал объёма */
  ctx.ev(`(function(){
    DS.capacity.push({rs:'ROUTE_DEAD', rsName:'Тупиковое направление', resType:'Маршрут',
      cat:'route', locFr:'Завод X', locTo:'Склад Y', pl:'Завод X', periodKey:'P1',
      norm:0, avail:100, load:0, free:100, maint:0, util:0, isBottleneck:false, isCrit:false});
    DS.capacity.push({rs:'RES_IDLE', rsName:'Простаивающая линия', resType:'Мощность цеха',
      cat:'production', pl:'Завод X', periodKey:'P1',
      norm:0, avail:200, load:0, free:200, maint:0, util:0, isBottleneck:false, isCrit:false});
    render();
  })()`);
  await ctx.tick(200);

  const rows = JSON.parse(ctx.ev(`JSON.stringify([...document.querySelectorAll('#rUnTbl tbody tr')]
    .map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent.trim())))`))
    .filter((c) => c.length >= 5);
  const byCat = Object.fromEntries(rows.map((c) => [c[0].replace(/\s*\(.*/, ''), c]));

  assert.equal(parseNum(byCat['Маршруты'][1]), 1, 'в реестре появилось одно направление');
  assert.equal(parseNum(byCat['Маршруты'][3]), 1, 'оно не задействовано планом');
  assert.ok(close(parseNum(byCat['Маршруты'][4]), 100, 1e-9), 'это 100% реестра направлений');

  const before = parseNum(byCat['Ресурсы'][3]);
  assert.ok(before >= 1, `незадействованный ресурс учтён (${before})`);
  const kpi = ctx.kpi('Не задействовано в плане');
  assert.ok(parseNum(kpi.querySelector('.v').textContent) >= 2,
    'KPI включает и маршрут, и ресурс');
  assert.deepEqual(ctx.noise, [], 'без ошибок: ' + ctx.noise.join(' | '));
});
