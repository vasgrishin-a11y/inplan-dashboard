/* ─────────────────────────────────────────────────────────────────────────────
   Приоритет заказа = колонка demandtype (marking_demand / demand_coverage).

   Что было (CODE_AUDIT.md, B1): в XLSX-ветке приоритет читался из
   `margin_per_hour`, поэтому в фильтре «Приоритет» оказывались миллионы ₽/ч,
   а проверка «приоритет 1 обслужен полностью» в резюме теряла смысл.

   Что проверяется здесь:
   1. Приоритет берётся из demandtype (в ClickHouse — demand_demandtype),
      `margin_per_hour` остаётся отдельной метрикой «Маржа ₽/ч».
   2. demandtype бывает числовым (1, 2, …) и строковым (метка типа спроса):
      для чисел порядок прежний (1 важнее 2), для меток порядок НЕ выдумывается —
      резюме показывает Service Level по каждой метке.
   3. Запасной источник — demand_demandtypepriority: используется, только если
      demandtype пуст, и это видно (prioSrc, чек в «Качестве данных»).
   4. Если приоритет не определён вовсе — UI и DQ говорят об этом прямо,
      а не подставляют «2» всем заказам (так делала старая CH-ветка).
   5. Фильтр «Приоритет», таблица заказов и чек DQ работают по одному ключу pk.

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

/** 2D-контекст-пустышка: графики в jsdom не нужны, но отрисовка не должна падать. */
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
    /** прогнать строки выгрузки через настоящий parseRows + build */
    parse(rows) {
      return JSON.parse(window.eval(`(function(){
        const rows = ${JSON.stringify(rows)};
        const ds = build(parseRows(rows, 'test.xlsx'));
        return JSON.stringify(ds.orders.map(o=>({id:o.id, dt:o.dt, pr:o.pr, pk:o.pk,
          dtl:o.dtl, src:o.prioSrc, mph:o.mph})));
      })()`));
    },
    close() { try { dom.window.close(); } catch { /* jsdom: не суть */ } },
  };
}

/* Строка листа marking_demand: имена колонок — ровно как в COL (включая
   «Cебестоимость на тонну» с латинской C и «Неудовлетворенный спрос» без ё). */
const row = (id, extra = {}) => Object.assign({
  'order_id': id,
  'Период спроса': 'P0',
  'Локация спроса': 'Sale_RU_1',
  'Продукт спроса': 'FPRL_5',
  'Клиент спроса': 'Клиент',
  'План спроса': 1000,
  'План продаж': 800,
  'Неудовлетворенный спрос': 200,
  'Цена за тонну': 100000,
  'Cебестоимость на тонну': 40000,
  'Маржинальность на тонну': 60000,
  'Валовая выручка (план продаж)': 80000000,
  'Суммарная себестоимость': 32000000,
  'Валовая маржа (план продаж), руб': 48000000,
}, extra);

/* ─────────────────────── 1. Источник приоритета ─────────────────────── */

test('приоритет заказа читается из demandtype, а не из margin_per_hour', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const o = ctx.parse([
    row(1, { 'demandtype': 3, 'margin_per_hour': 1234567 }),
    row(2, { 'demandtype': 1, 'margin_per_hour': 7654321 }),
  ]);
  assert.equal(o.length, 2, 'обе строки распознаны как заказы');
  assert.deepEqual(o.map((x) => x.pr), [3, 1], 'приоритет = значение demandtype');
  assert.deepEqual(o.map((x) => x.pk), ['3', '1'], 'ключ фильтра — строковое значение demandtype');
  assert.deepEqual(o.map((x) => x.src), ['demandtype', 'demandtype'], 'источник приоритета назван');
  assert.deepEqual(o.map((x) => x.mph), [1234567, 7654321],
    'margin_per_hour прочитан отдельной метрикой и не подменён приоритетом');
  assert.ok(o.every((x) => x.pr < 100), 'приоритет не похож на сумму ₽/ч');
});

test('все варианты имени колонки demandtype распознаются', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const variants = ['demandtype', 'demand_demandtype', 'demand_type', 'Тип спроса'];
  for (const name of variants) {
    const o = ctx.parse([row(1, { [name]: 2 })]);
    assert.equal(o[0].pr, 2, `колонка «${name}» даёт приоритет 2`);
    assert.equal(o[0].src, 'demandtype', `колонка «${name}» помечена как demandtype`);
  }
});

test('нет demandtype — приоритет не выдумывается, margin_per_hour им не становится', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const o = ctx.parse([row(1, { 'margin_per_hour': 9876543 })]);
  assert.equal(o[0].pr, 0, 'приоритет не определён (0), а не «2 по умолчанию» и не ₽/ч');
  assert.equal(o[0].pk, '—', 'ключ фильтра помечает неопределённый приоритет');
  assert.equal(o[0].src, '', 'источник приоритета пуст');
  assert.equal(o[0].mph, 9876543, '₽/ч остались отдельной метрикой');
});

test('запасной источник — demand_demandtypepriority, только если demandtype пуст', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const only = ctx.parse([row(1, { 'demand_demandtypepriority': 5 })]);
  assert.equal(only[0].pr, 5, 'приоритет взят из запасной колонки');
  assert.equal(only[0].src, 'demandtypepriority', 'источник помечен как запасной');

  const both = ctx.parse([row(1, { 'demandtype': 2, 'demand_demandtypepriority': 5 })]);
  assert.equal(both[0].pr, 2, 'demandtype важнее запасной колонки');
  assert.equal(both[0].src, 'demandtype', 'источник — demandtype');

  const zero = ctx.parse([row(1, { 'demandtype': 0, 'demand_demandtypepriority': 4 })]);
  assert.equal(zero[0].pr, 4, 'нулевой demandtype считается пустым — сработал запасной');
  assert.equal(zero[0].src, 'demandtypepriority', 'и это отражено в источнике');
});

test('строковый demandtype: метка сохраняется, порядок не выдумывается', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const o = ctx.parse([row(1, { 'demandtype': 'FIRM' }), row(2, { 'demandtype': 'FORECAST' })]);
  assert.deepEqual(o.map((x) => x.pk), ['FIRM', 'FORECAST'], 'ключ фильтра — сама метка');
  assert.deepEqual(o.map((x) => x.dtl), ['FIRM', 'FORECAST'], 'метка показывается как есть');
  assert.deepEqual(o.map((x) => x.pr), [0, 0], 'числового приоритета нет — и не придумано');
  assert.deepEqual(o.map((x) => x.dt), ['FIRM', 'FORECAST'], 'demandtype сохранён в данных');
});

test('prioKeySort: числа по возрастанию (1 важнее 2), метки после чисел', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  const sorted = JSON.parse(ctx.ev(`JSON.stringify(['10','2','FIRM','1','20'].sort(prioKeySort))`));
  assert.deepEqual(sorted, ['1', '2', '10', '20', 'FIRM'],
    'числовой порядок соблюдён («2» раньше «10»), строки — после чисел');
});

/* ─────────────────────── 2. Демо-набор и UI ─────────────────────── */

test('демо-набор: приоритет у всех заказов из demandtype', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const r = JSON.parse(ctx.ev(`JSON.stringify({
    n: DS.orders.length,
    fromDt: DS.orders.filter(o=>o.prioSrc==='demandtype').length,
    pks: [...new Set(DS.orders.map(o=>o.pk))].sort(prioKeySort),
    dts: [...new Set(DS.orders.map(o=>String(o.dt)))].sort(prioKeySort),
    undefinedPrio: DS.orders.filter(o=>!o.pr).length,
    mph: DS.orders.filter(o=>o.mph>0).length
  })`));
  assert.ok(r.n > 0, 'демо-набор загружен');
  assert.equal(r.fromDt, r.n, 'у всех заказов приоритет из demandtype');
  assert.deepEqual(r.pks, ['1', '2'], 'в демо два типа спроса');
  assert.deepEqual(r.dts, ['1', '2'], 'поле dt хранит demandtype');
  assert.equal(r.undefinedPrio, 0, 'неопределённых приоритетов нет');
  assert.equal(r.mph, 0, 'margin_per_hour в демо-наборе не заполнен');
});

test('фильтр «Приоритет» отбирает заказы по demandtype', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const before = JSON.parse(ctx.ev(`JSON.stringify({
    total: DS.orders.length,
    p1: DS.orders.filter(o=>o.pk==='1').length,
    p2: DS.orders.filter(o=>o.pk==='2').length
  })`));
  assert.ok(before.p1 > 0 && before.p2 > 0, 'в демо есть заказы обоих приоритетов');

  ctx.ev("setF('pi','1')");
  await ctx.tick(60);
  const after = JSON.parse(ctx.ev(`JSON.stringify({
    f: F.pi.slice(), n: fOrders().length,
    allP1: fOrders().every(o=>o.pk==='1')
  })`));
  assert.deepEqual(after.f, ['1'], 'в фильтре лежит ключ demandtype');
  assert.equal(after.n, before.p1, 'отобрано ровно столько заказов, сколько с приоритетом 1');
  assert.equal(after.allP1, true, 'в выборке нет заказов другого приоритета');

  // список значений в панели — это значения demandtype, отсортированные по важности
  ctx.ev("clearF();fillSelects()");
  await ctx.tick(60);
  const pills = [...ctx.document.querySelectorAll('#pop_pi .pop-list *')]
    .map((el) => el.textContent.trim()).filter(Boolean).join(' | ');
  assert.match(pills, /Приоритет 1/, 'в фильтре видно приоритет 1');
  assert.match(pills, /Приоритет 2/, 'в фильтре видно приоритет 2');
  assert.ok(pills.indexOf('Приоритет 1') < pills.indexOf('Приоритет 2'),
    'значения отсортированы по важности (1 раньше 2)');
});

test('таблица заказов: колонка «Приоритет» с подсказкой про demandtype', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev("go('raw')");
  await ctx.tick(80);

  const th = [...ctx.document.querySelectorAll('#rawTbl th')]
    .find((el) => /Приоритет/.test(el.textContent));
  assert.ok(th, 'колонка «Приоритет» есть');
  assert.match(th.getAttribute('title') || '', /demandtype/,
    'в подсказке назван источник — demandtype');

  const heads = [...ctx.document.querySelectorAll('#rawTbl th')].map((el) => el.textContent.trim());
  assert.ok(!heads.some((h) => /Маржа ₽\/ч/.test(h)),
    'колонки «Маржа ₽/ч» нет, пока margin_per_hour пуст');

  // как только в данных появляется margin_per_hour — метрика видна отдельно
  ctx.ev(`DS.orders.forEach(o=>{o.mph=1000+o.id});render()`);
  await ctx.tick(80);
  const heads2 = [...ctx.document.querySelectorAll('#rawTbl th')].map((el) => el.textContent.trim());
  assert.ok(heads2.some((h) => /Маржа ₽\/ч/.test(h)),
    'колонка «Маржа ₽/ч» появляется при заполненном margin_per_hour');
});

/* ─────────────────────── 3. Резюме и качество данных ─────────────────────── */

test('резюме «Спрос»: наивысший приоритет назван по данным, а не «приоритет 1»', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev("go('dm')");
  await ctx.tick(80);
  const txt = ctx.document.querySelector('#main').textContent.replace(/\s+/g, ' ');

  const r = JSON.parse(ctx.ev(`(function(){
    const g = grp(DS.orders, o=>o.pk, v=>({sl:S(v,o=>o.sal)/Math.max(S(v,o=>o.dem),1)}))
      .sort((a,b)=>prioKeySort(a.k,b.k));
    return JSON.stringify(g);
  })()`));
  const top = r[0];
  assert.equal(top.k, '1', 'наивысший приоритет в демо — 1');

  if (top.sl < 0.9) {
    assert.match(txt, /Приоритет 1 \(наивысший из \d+\) не обслужен полностью/,
      'резюме называет приоритет по данным и сообщает о недоборе');
  } else {
    assert.match(txt, /Приоритет 1 \(наивысший из \d+\) обслужен полностью/,
      'резюме называет приоритет по данным');
  }
});

test('резюме «Спрос»: строковые метки demandtype — SL по типам, без ложного «приоритет 1»', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  ctx.ev(`DS.orders.forEach((o,i)=>{
    const l = i % 2 ? 'FIRM' : 'FORECAST';
    o.pk = l; o.dtl = l; o.pr = 0; o.prioSrc = 'demandtype';
  });render()`);
  ctx.ev("go('dm')");
  await ctx.tick(80);
  const txt = ctx.document.querySelector('#main').textContent.replace(/\s+/g, ' ');

  assert.match(txt, /Service Level по типам спроса/, 'показан SL в разрезе типов спроса');
  assert.match(txt, /FIRM/, 'названа метка FIRM');
  assert.match(txt, /FORECAST/, 'названа метка FORECAST');
  assert.ok(!/Приоритет 1 обслужен полностью/.test(txt),
    'резюме не утверждает, что «приоритет 1» обслужен, когда приоритетов в данных нет');
  assert.match(txt, /порядок в данных не задан/, 'честно сказано, что порядка между метками нет');
});

test('резюме «Спрос»: приоритет не определён — сказано прямо', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  ctx.ev(`DS.orders.forEach(o=>{o.pk='—';o.dtl='—';o.pr=0;o.prioSrc=''});render()`);
  ctx.ev("go('dm')");
  await ctx.tick(80);
  const txt = ctx.document.querySelector('#main').textContent.replace(/\s+/g, ' ');
  assert.match(txt, /Приоритет заказа не определён/, 'резюме сообщает об отсутствии приоритета');
  assert.match(txt, /demandtype/, 'названа колонка, которой не хватает');
  assert.ok(!/Приоритет 1 обслужен/.test(txt), 'пустых утверждений об обслуживании нет');
});

test('«Качество данных»: чек приоритета — норма, отсутствие и неправдоподобные значения', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  /* чеки DQ рисуются в setTimeout после вставки HTML — ждём тик */
  const check = async () => {
    ctx.ev("go('dq')");
    await ctx.tick(90);
    const el = [...ctx.document.querySelectorAll('#main .dq')]
      .find((e) => /Приоритет заказа/.test(e.textContent));
    assert.ok(el, 'чек приоритета есть');
    return { sev: el.className, txt: el.textContent.replace(/\s+/g, ' ').trim() };
  };

  // 1) демо: demandtype на месте — норма
  let c = await check();
  assert.match(c.txt, /Приоритет заказа \(demandtype\)/, 'в названии чека назван источник');
  assert.match(c.txt, /Приоритет задан в 37 из 37 заказов/, 'чек говорит, у скольких заказов приоритет есть');
  assert.match(c.txt, /Значения: 1, 2/, 'значения demandtype перечислены');
  assert.ok(!/\bw\b|\be\b/.test(c.sev.replace('dq', '').trim()), `статус не предупреждение (${c.sev})`);

  // 2) demandtype пропал — ошибка с внятной рекомендацией
  ctx.ev(`DS.orders.forEach(o=>{o.pk='—';o.dtl='—';o.pr=0;o.prioSrc=''});render()`);
  await ctx.tick(60);
  c = await check();
  assert.match(c.sev, /\be\b/, 'без demandtype чек в статусе ошибки');
  assert.match(c.txt, /приоритет не определён/i, 'сказано, что приоритет не определён');
  assert.match(c.txt, /margin_per_hour/, 'названа прежняя ошибочная колонка');
  assert.match(c.txt, /Перезагрузить файл/, 'дана рекомендация');

  // 3) в demandtype попали деньги — ошибка, а не молчаливый «приоритет»
  ctx.ev(`DS.orders.forEach((o,i)=>{o.pr=1234567+i;o.pk=String(o.pr);o.dtl=String(o.pr);o.prioSrc='demandtype'});render()`);
  await ctx.tick(60);
  c = await check();
  assert.match(c.sev, /\be\b/, 'неправдоподобные значения — ошибка');
  assert.match(c.txt, /не похожи на приоритет/, 'объяснено, почему значения неверны');
});

test('«Качество данных»: запасной источник приоритета помечен предупреждением', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev(`DS.orders.forEach(o=>{o.pr=3;o.pk='3';o.dtl='3';o.prioSrc='demandtypepriority'});render()`);
  await ctx.tick(60);
  ctx.ev("go('dq')");
  await ctx.tick(40);
  const el = [...ctx.document.querySelectorAll('#main .dq')]
    .find((e) => /Приоритет заказа/.test(e.textContent));
  assert.match(el.className, /\bw\b/, 'запасной источник — предупреждение, а не норма');
  assert.match(el.textContent, /demand_demandtypepriority/, 'названа запасная колонка');
  assert.match(el.textContent, /сверить оба источника/, 'дана рекомендация сверить источники');
});

test('«Незаполненные поля» считается по данным, а не утверждается заранее', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev("go('dq')");
  await ctx.tick(80);

  const el = [...ctx.document.querySelectorAll('#main .dq')]
    .find((e) => /Незаполненные поля/.test(e.textContent));
  assert.ok(el, 'чек незаполненных полей есть');
  const txt = el.textContent.replace(/\s+/g, ' ');
  assert.match(txt, /Потреблённый запас/, 'поля, которых в выгрузке правда нет, перечислены');
  assert.ok(!/«Тип спроса/.test(txt),
    '«Тип спроса» больше не объявлен пустым: demandtype читается (регрессия B1)');
  assert.ok(!/mapper_run_id пусты во всей выгрузке/.test(txt),
    'старая жёстко зашитая формулировка заменена расчётом по данным');
});

test('в демо-наборе приоритет и demandtype — одно и то же значение', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  const r = JSON.parse(ctx.ev(`JSON.stringify(DS.orders.map(o=>({
    dt: o.dt, pr: o.pr, pk: o.pk, dtl: o.dtl, src: o.prioSrc
  })))`));
  assert.ok(r.every((x) => String(x.dt) === String(x.pr)), 'pr = demandtype у всех заказов');
  assert.ok(r.every((x) => x.pk === String(x.pr)), 'ключ фильтра совпадает с приоритетом');
  assert.ok(r.every((x) => x.dtl === String(x.pr)), 'метка для вывода совпадает с приоритетом');
  assert.ok(r.every((x) => x.src === 'demandtype'), 'источник — demandtype');
});
