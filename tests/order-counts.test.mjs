/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: счёт заказов по demand_coverage и водопад «Тонны/Заказы»
   (задача владельца 2026-10-05).

   1. Классификация заказов: всего строк demand_coverage = все заказы
      неограниченного спроса; 100% не покрыто — fullfilleddemandqty = 0;
      частично — unfullfilleddemandqty > 0 и fullfilleddemandqty > 0;
      полностью — uf = 0 и ff > 0. Разбиение полное: сумма групп = всем строкам.
   2. Водопад по заказам — те же названия столбцов, что в тоннах, и все шаги
      сходятся: Всего − 100% не покрыто = В оптимизации; − дефицит = План
      продаж; − опоздания = В срок (опоздания — среди полностью покрытых).
   3. Клик по столбцу водопада / чипу фильтрует таблицу RCA по стадии заказа.
   4. Карточки: «Общий» — объединённая «Упущенная маржа и выручка», без
      «Не покрыто всего»; «Спрос и покрытие» — без четырёх убранных карточек,
      «Отгружено» → «План продаж», «Упущенная маржа» — последняя.
   5. Фолбэки: без счётчиков demand_coverage — marking_demand; под фильтрами —
      загруженная выборка.
   6. DQ-проверки: разбиение заказов сходится; строка demand_coverage = заказ.
   7. Охват графиков (задача владельца 2026-10-06): водопад по умолчанию в
      режиме «Все заказы» и имеет два положения; у остальных графиков с
      охватом три положения — «План продаж» (умолчание), «Все заказы» и
      «100% непокрытые» (на графике остаются только такие заказы).

   Мок: demand_coverage — 100 строк (30 полностью непокрытых, 20 частично,
   50 полностью; из полностью покрытых 6 с опозданием, всего с признаком
   опоздания 8); marking_demand — 90 заказов плана (20 с нулевой отгрузкой,
   15 частично, 55 полностью), план 5000, отгрузка 4000, дефицит 1000;
   покрытый 4000 + непокрытый 2000 = 6000 т.

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
const HTML = process.env.INPLAN_HTML ? path.resolve(process.env.INPLAN_HTML) : path.join(ROOT, 'index.html');
const BASE = 'http://localhost:8080';
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };

const localResources = requestInterceptor((request) => {
  const u = new URL(request.url);
  if (u.origin === BASE) {
    const file = path.join(ROOT, u.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile())
      return new Response(fs.readFileSync(file), {
        headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' },
      });
  }
  return new Response('', { headers: { 'Content-Type': 'text/css' } });
});

const DBS = { data_public_1: { grans: [[4, 100]], n: 1200, ts: '2026-09-10 08:00:00' } };
const COLS = [
  'order_id','order_operation_id','resource','demand_period','demand_product',
  'demand_client','demand_location','demand_volume','results_sale','unsatisfied_demand',
  'revenue','cost_of_demand','total_margin','margin_per_unit','price','cost_per_unit_order',
  'demand_demandtype','dmdstream','demand_demandtypepriority','margin_per_hour','operation_type',
  'location','product','loc_from','loc_to','transport_type','order_operation_volume',
  'cost_rate_of_operation','supplier','bom_num',
];

/* marking_demand: 90 заказов плана — 20 с нулевой отгрузкой, 15 частично, 55 полностью */
const ORDERS_TOT = {
  orders: 90, rev: 50e9, cost: 30e9, mar: 20e9,
  dem: 5000, sal: 4000, unm: 1000, lm: 3e9, full: 55,
  zeroSalOrders: 20, partCoveredOrders: 15, fullCoveredOrders: 55,
};
/* demand_coverage: 100 строк = 30 (ff=0) + 20 (частично) + 50 (полностью);
   из 50 полностью покрытых 6 отгружены с опозданием, всего с late>0 — 8 */
const COV = {
  demUnc: 6000, ff: 4000, uf: 2000, inTime: 3800, late: 200, prop: 6000,
  orderRows: 100, fullyUncoveredOrders: 30, partiallyCoveredOrders: 20, fullyCoveredOrders: 50,
  lateOrdersAll: 8, lateFullyCoveredOrders: 6,
  lostRev: 20e9, planRev: 50e9,
};
const COV_NO_COUNTS = { demUnc: 6000, ff: 4000, uf: 2000, inTime: 3800, late: 200, lostRev: 20e9, planRev: 50e9 };
const COV_P = [{ k: '2026-09', demUnc: 6000, ff: 4000, uf: 2000, late: 200 }];
const BY_OP = [{ t: 'production', c: 5e9, v: 900, n: 2 }, { t: 'movement', c: 3e9, v: 900, n: 2 }];
const DIM_P = [{ k: '1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
const DIM_PR = [{ k: 'P1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
const DIM_CL = [{ k: 'C1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
/* детализация: 3 заказа — по одной каждой стадии (полностью / частично / 100% не покрыто) */
const ORDERS = [
  { id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1',
    dem: 400, sal: 400, unm: 0, price: 20e6, cpt: 12e6, mpt: 8e6, rev: 8e9, cost: 4.8e9, mar: 3.2e9, prio: 1, mph: 0 },
  { id: 102, p: '2', loc: 'L1', prod: 'P2', cl: 'C2', dtype: 1, stream: 'S1',
    dem: 600, sal: 300, unm: 300, price: 4e6, cpt: 2.5e6, mpt: 1.5e6, rev: 1.2e9, cost: 0.75e9, mar: 0.45e9, prio: 2, mph: 0 },
  { id: 103, p: '2', loc: 'L1', prod: 'P3', cl: 'C3', dtype: 1, stream: 'S1',
    dem: 500, sal: 0, unm: 500, price: 5e6, cpt: 3e6, mpt: 2e6, rev: 0, cost: 0, mar: 0, prio: 2, mph: 0 },
];
const OPS = [
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 400, r: 12e6, vd: '', rt: '1.1', oid: '101.1', rc: 0 },
];

function makeRoute(withCounts) {
  return (sql) => {
    const dbm = sql.match(/`(data_public_\d+)`\./);
    const db = dbm && dbm[1];
    if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
    if (/AS oid/.test(sql)) return OPS;
    if (/FROM system\.databases/.test(sql))
      return [{ name: 'system' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
    if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
    if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
    if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
    if (/`independent_demand`/.test(sql)) throw new Error('в ClickHouse таблицы independent_demand быть не должно');
    if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
    if (/`operation_type` AS t/.test(sql)) return BY_OP;
    if (/`o_p` AS k/.test(sql)) return DIM_P;
    if (/`o_prod` AS k/.test(sql)) return DIM_PR;
    if (/`o_cl` AS k/.test(sql)) return DIM_CL;
    if (/lostrevenue/.test(sql)) return [withCounts ? COV : COV_NO_COUNTS];
    if (/GROUP BY k ORDER BY k/.test(sql)) return COV_P;
    if (/SELECT order_id AS id/.test(sql)) return ORDERS;
    if (/IN \(/.test(sql)) return OPS;
    return [];
  };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 10000)) {
    try { if (fn()) return; } catch { /* ещё не готово */ }
    await settle(25);
  }
  throw new Error('timeout: ' + (label || 'условие'));
}
const clean = (s) => String(s).replace(/\u00a0|\u202f/g, ' ').replace(/\s+/g, ' ').trim();
const toNum = (s) => Number(clean(s).replace(/\s/g, '').replace(/[^0-9.,-]/g, '').replace(',', '.'));

async function loadCH(withCounts = true) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
  const route = makeRoute(withCounts);
  w.fetch = async (url, opts) => {
    const sql = String((opts && opts.body) || '');
    return { ok: true, status: 200, text: async () => route(sql).map((r) => JSON.stringify(r)).join('\n') };
  };
  await w.CHX.connect();
  w.CHX.openModal();
  d.querySelector('input[data-db="data_public_1"]').click();
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => w.CHX.versions.length === 1 && w.DS, 20000, 'версия загружена');

  const kpi = (title) => [...d.querySelectorAll('#main .kpi')]
    .find((k) => ((k.querySelector('.t') || {}).textContent || '').trim() === title);
  return {
    window: w, document: d, kpi,
    kpiVal: (title) => toNum(kpi(title).querySelector('.v').textContent),
    ev: (code) => w.eval(code),
    goTab: async (id) => { w.go(id); await settle(300); },
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}

test('счёт заказов demand_coverage: разбиение полное, опоздания — среди полностью покрытых', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('dm');

  const ord = JSON.parse(ctx.ev('(function(){return JSON.stringify(covBasis(fOrders()).ord)})()'));
  assert.equal(ord.src, 'demand_coverage', 'основной источник — агрегат demand_coverage');
  assert.equal(ord.total, 100, 'всего строк = все заказы неограниченного спроса');
  assert.equal(ord.fullUnc, 30, '100% не покрыто = fullfilleddemandqty = 0');
  assert.equal(ord.part, 20, 'частично = uf > 0 и ff > 0');
  assert.equal(ord.full, 50, 'полностью = uf = 0 и ff > 0');
  assert.equal(ord.fullUnc + ord.part + ord.full, ord.total, 'разбиение полное: сумма групп = всем строкам');
  assert.equal(ord.inOpt, 70, 'в оптимизации = всего − 100% не покрытых');
  assert.equal(ord.inOpt, ord.part + ord.full, 'в оптимизации = частично + полностью');
  assert.equal(ord.late, 6, 'с опозданием — среди полностью покрытых (lateFullyCoveredOrders)');
  assert.equal(ord.intime, 64, 'в срок = все заказы плана − опоздавшие');
  assert.equal(ord.late + ord.intime, ord.inOpt, 'План продаж (заказов) = В срок + С опозданием');
});

test('водопад по заказам: те же столбцы, шаги сходятся, режим переключается и сохраняется', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('dm');

  const wf = JSON.parse(ctx.ev('(function(){return JSON.stringify(dmOrderWaterfall(covBasis(fOrders()).ord).map(b=>[b.k,b.v]))})()'));
  assert.deepEqual(wf.map((x) => x[0]), [
    'Неограниченный спрос', 'Заказов 100% не покрыто', 'Заказов в оптимизации',
    'План продаж', 'Отгружено с опозданием', 'В срок',
  ], 'дефицит объединён с планом продаж');
  assert.deepEqual(wf.map((x) => x[1]), [100, -30, 70, 70, -6, 64], 'значения — счёт заказов');
  assert.equal(wf[0][1] + wf[1][1], wf[2][1], 'Всего − 100% не покрыто = В оптимизации');
  assert.equal(wf[2][1], wf[3][1], 'План продаж включает полностью и частично выполненные заказы');
  assert.equal(wf[3][1] + wf[4][1], wf[5][1], 'План продаж − Опоздания = В срок');
  const plan=JSON.parse(ctx.ev('(function(){return JSON.stringify(dmOrderWaterfall(covBasis(fOrders()).ord).find(b=>b.st==="plan"))})()'));
  assert.deepEqual(plan.segments.map(s=>s.v),[50,20],'столбец разделён на полностью выполненные и дефицит');

  /* переключалка на карточке водопада: «Заказы» меняет подпись и сохраняется */
  const seg = ctx.document.getElementById('d0mode');
  assert.ok(seg, 'переключатель «Тонны/Заказы» есть на карточке водопада');
  const btnOrders = [...seg.querySelectorAll('button')].find((b) => b.dataset.wfmode === 'orders');
  assert.ok(btnOrders, 'кнопка «Заказы» есть');
  btnOrders.click();
  await settle(120);
  assert.match(ctx.document.getElementById('d0sub').textContent, /Заказы/, 'подпись карточки сменилась на заказы');
  assert.equal(ctx.window.localStorage.getItem('inplan_dm_wf_mode'), 'orders', 'режим сохранён в localStorage');
  assert.ok(btnOrders.classList.contains('p'), 'кнопка «Заказы» подсвечена');
});

test('карточки «Общего»: объединённая «Упущенная маржа и выручка», без «Не покрыто всего»', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('ov');

  const merged = ctx.kpi('Упущенная маржа и выручка');
  assert.ok(merged, 'объединённая карточка есть');
  assert.match(clean(merged.querySelector('.s').textContent), /упущенная выручка/, 'в подписи — упущенная выручка');
  assert.match(clean(merged.querySelector('.s').textContent), /база:/, 'в подписи — база расчёта');
  assert.equal(ctx.kpi('Упущенная выручка'), undefined, 'отдельной карточки «Упущенная выручка» нет');
  assert.equal(ctx.kpi('Упущенная маржа'), undefined, 'отдельной карточки «Упущенная маржа» нет');
  assert.equal(ctx.kpi('Не покрыто всего'), undefined, 'карточки «Не покрыто всего» в «Общем» нет');
  /* «Заказов выполнено» — по новой классификации demand_coverage */
  assert.equal(clean(ctx.kpi('Заказов выполнено').querySelector('.v').textContent), '50 из 100',
    'полностью покрытые заказы ко всем заказам неограниченного спроса');
});

test('карточки «Спроса и покрытия»: ряд без убранных карточек, «Упущенная маржа» — последняя', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('dm');

  assert.ok(ctx.kpi('План продаж'), 'карточка «План продаж» (ранее «Отгружено») есть');
  assert.ok(ctx.kpi('Неограниченный спрос'), 'карточка «Неограниченный спрос» есть');
  assert.ok(ctx.kpi('Не покрыто всего'), 'карточка «Не покрыто всего» осталась в этом разделе');
  for (const gone of ['Не принято в план', 'Ограниченный спрос (план)', 'Дефицит плана',
    'Отгружено с опозданием', 'Отгружено'])
    assert.equal(ctx.kpi(gone), undefined, `карточки «${gone}» больше нет`);
  const titles = [...ctx.document.querySelectorAll('#main .kpi .t')].map((x) => x.textContent.trim());
  assert.equal(titles[titles.length - 1], 'Упущенная маржа', '«Упущенная маржа» — последняя в ряду');
  /* подписи карточек — короткие (п.6): не больше двух строк текста */
  for (const card of ctx.document.querySelectorAll('#main .kpi'))
    assert.ok(clean((card.querySelector('.s') || {}).textContent).length <= 120,
      'подпись карточки краткая: ' + clean(card.querySelector('.s').textContent));
});

test('клик по стадии водопада и чипы фильтруют таблицу RCA, границы названы', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('dm');

  /* чипы над таблицей — по названиям столбцов водопада, со счётчиками */
  const chips = [...ctx.document.querySelectorAll('#d7chips .stage-chip')];
  assert.equal(chips.length, 6, 'шесть чипов — отдельный фильтр дефицита удалён');
  const chipTxt = chips.map((c) => clean(c.textContent)).join(' | ');
  for (const name of ['Неограниченный спрос', 'Заказов 100% не покрыто', 'Заказов в оптимизации',
    'План продаж', 'Отгружено с опозданием', 'В срок'])
    assert.match(chipTxt, new RegExp(name), `чип «${name}» есть`);
  assert.doesNotMatch(chipTxt,/Дефицит плана/,'отдельного фильтра дефицита нет');
  assert.match(chipTxt, /Неограниченный спрос 100/, 'в чипе «Неограниченный спрос» — счётчик 100');

  /* таблица по умолчанию — все заказы, с колонкой стадии */
  let rows = [...ctx.document.querySelectorAll('#d7 table tbody tr')];
  assert.equal(rows.length, 3, 'без фильтра показаны все заказы водопада (детализация: 3)');
  const stages = rows.map((r) => clean(r.querySelectorAll('td')[1].textContent));
  assert.ok(stages.includes('Полностью покрыто') && stages.includes('Частично покрыто') && stages.includes('100% не покрыто'),
    'колонка «Стадия» классифицирует каждую строку');

  assert.equal(chips.find((c) => c.dataset.stage === 'deficit'),undefined,
    'фильтр «Дефицит плана» удалён');

  /* единый «План продаж» включает полностью и частично выполненные заказы */
  ctx.ev("DM_STAGE='plan';render();undefined");
  await settle(300);
  rows = [...ctx.document.querySelectorAll('#d7 table tbody tr')];
  assert.equal(rows.length, 2, '«План продаж» содержит полностью и частично покрытые заказы');
  assert.match(rows.map(r=>clean(r.textContent)).join(' '), /№101/);
  assert.match(rows.map(r=>clean(r.textContent)).join(' '), /№102/);

  /* «100% не покрыто»: в таблице — принятые в план с нулевой отгрузкой,
     остальное названо (вне плана / лимит детализации) */
  ctx.ev("DM_STAGE='fullUnc';render();undefined");
  await settle(300);
  rows = [...ctx.document.querySelectorAll('#d7 table tbody tr')];
  assert.equal(rows.length, 1, 'показан заказ №103 (sal=0)');
  assert.match(clean(rows[0].textContent), /№103/, 'заказ с нулевой отгрузкой виден');
  const note = clean((ctx.document.getElementById('d7note') || {}).textContent || '');
  assert.match(note, /В столбце 30 заказов, в таблице — 1/,
    'заметка честно называет, сколько заказов не показано');

  /* «С опозданием»: по-заказная разбивка недоступна — заметка объясняет,
     показано надёжное надмножество (полностью покрытые) */
  ctx.ev("DM_STAGE='late';render();undefined");
  await settle(300);
  const noteLate = clean((ctx.document.getElementById('d7note') || {}).textContent || '');
  assert.match(noteLate, /с опозданием — 6 из 50/, 'агрегат опозданий назван числом');
  assert.match(noteLate, /По-заказная разбивка недоступна/, 'причина названа');
  rows = [...ctx.document.querySelectorAll('#d7 table tbody tr')];
  assert.equal(rows.length, 1, 'показаны полностью покрытые заказы (надёжное надмножество)');

  /* сброс — все заказы */
  ctx.ev('DM_STAGE=null;render();undefined');
  await settle(300);
  rows = [...ctx.document.querySelectorAll('#d7 table tbody tr')];
  assert.equal(rows.length, 3, 'сброс стадии возвращает все заказы');
});

test('фолбэки счёта заказов: marking_demand без счётчиков demand_coverage, выборка под фильтрами', async (t) => {
  const ctx = await loadCH(false);   /* demand_coverage без счётчиков заказов */
  t.after(ctx.close);
  await ctx.goTab('dm');

  const ord = JSON.parse(ctx.ev('(function(){return JSON.stringify(covBasis(fOrders()).ord)})()'));
  assert.equal(ord.src, 'marking_demand', 'без счётчиков demand_coverage — агрегат marking_demand');
  assert.equal(ord.total, 90, 'всего — заказы плана');
  assert.equal(ord.full, 55, 'полностью покрытые — countIf(sal > 0, unm <= tol)');
  assert.equal(ord.part, 15, 'частично покрытые');
  assert.equal(ord.fullUnc, 20, '100% не покрыто — заказы плана с нулевой отгрузкой');
  assert.equal(ord.fullUnc + ord.part + ord.full, ord.total, 'разбиение полное и в фолбэке');
  assert.equal(ord.late, null, 'опоздания по заказам в фолбэке недоступны');

  /* водопад по заказам без demand_coverage — от «Заказов в оптимизации» */
  const wf = JSON.parse(ctx.ev('(function(){return JSON.stringify(dmOrderWaterfall(covBasis(fOrders()).ord).map(b=>b.k))})()'));
  assert.deepEqual(wf, ['Заказов в оптимизации', 'План продаж'],
    'дефицит остаётся жёлтым сегментом единого плана продаж');

  /* под фильтрами — загруженная выборка */
  ctx.ev("setF('pr',['P1']);undefined");
  await settle(300);
  const ordF = JSON.parse(ctx.ev('(function(){return JSON.stringify(covBasis(fOrders()).ord)})()'));
  assert.equal(ordF.src, 'выборка под фильтрами', 'под фильтрами — классификация выборки');
  assert.equal(ordF.total, 1, 'в выборке один заказ P1');
  assert.equal(ordF.full, 1, 'он полностью покрыт');
  ctx.ev("clearF();render();undefined");
});

test('DQ: разбиение заказов сходится, строка demand_coverage = заказу', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('data');

  const checks = [...ctx.document.querySelectorAll('#q3 .dq')].map((x) => clean(x.textContent));
  const cls = checks.find((x) => /Заказы: классификация/.test(x));
  assert.ok(cls, 'проверка классификации заказов есть');
  assert.match(cls, /100% не покрыто 30 \+ частично покрыто 20 \+ полностью покрыто 50/, 'группы названы числами');
  assert.ok(!/⚠/.test(cls), 'разбиение сходится');

  const row = checks.find((x) => /Заказы: строка = заказ/.test(x));
  assert.ok(row, 'проверка «строка = заказ» есть');
  assert.match(row, /100 строк = 90 заказов плана \+ 10 вне плана/, 'два независимых расчёта сошлись');
});

test('стадия заказа считается по правилам demand_coverage на данных marking_demand', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('dm');

  const st = ctx.ev(`JSON.stringify([
    orderStageOf({sal:0,unm:500}),
    orderStageOf({sal:300,unm:300}),
    orderStageOf({sal:400,unm:0}),
    orderStageOf({sal:400,unm:1e-12})
  ])`);
  assert.deepEqual(JSON.parse(st), ['fullUnc', 'part', 'full', 'full'],
    'ff ≈ sal, uf ≈ unm; допуск 1e-9 отсекает шум двенадцатого знака');
});


test('independent_demand дополняет RCA и определяет разрешённое опоздание по сроку заказа', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);

  const merged = JSON.parse(ctx.ev(`JSON.stringify(CHX.mergeIndependentOrders([
    {id:201,p:2,loc:'L1',prod:'SKU-1',dt:1,stream:'S1',dem:100,sal:100,unm:0}
  ],[
    {sourceId:1,item:'SKU-1',loc:'L1',demandtype:'1',dmdstream:'S1',demandqty:100,periodid:'420260101',date:'2026-01-01'},
    {sourceId:2,item:'SKU-2',loc:'L1',demandtype:'1',dmdstream:'S1',demandqty:50,periodid:'420260101',date:'2026-01-01'}
  ],[
    {item:'SKU-1',loc:'L1',dt:1,stream:'S1',latePeriods:2}
  ]))`));
  assert.equal(merged.length, 2, 'в реестре есть заказ плана и отсутствующий в плане входной заказ');
  assert.equal(merged[0].lateAllowed, true, 'поздняя отгрузка разрешена справочником');
  assert.equal(merged[0].late, true, 'P2 позже срока P1 — заказ отгружен с опозданием');
  assert.equal(merged[1].independentOnly, true, 'недостающая строка создана из independent_demand');
  assert.equal(merged[1].sal, 0);
  assert.equal(merged[1].unm, 50);
  assert.equal(ctx.ev('orderStageLabel('+JSON.stringify(merged[1])+')'), '100% не покрыто');

  await ctx.goTab('dm');
  const headers=[...ctx.document.querySelectorAll('#d7 th')].map(x=>clean(x.textContent));
  assert.ok(headers.some(x=>x.includes('Статус покрытия')), 'столбец RCA переименован');
  const card=ctx.document.getElementById('d7card'),fs=card.querySelector('.card-fs');
  assert.ok(fs,'у RCA есть кнопка полноэкранного режима');
  fs.click();await settle(200);
  assert.ok(ctx.document.getElementById('d7card').classList.contains('full'),'таблица разворачивается');
  ctx.document.querySelector('#d7card .card-fs').click();await settle(200);
  assert.ok(!ctx.document.getElementById('d7card').classList.contains('full'),'таблица возвращается');
});

test('охват графиков: водопад по умолчанию «Все заказы», у остальных три режима включая «100% непокрытые»', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('dm');

  /* ── водопад: два положения, по умолчанию «Все заказы» (2026-10-06) ── */
  const wfBtn=ctx.document.querySelector('[data-chart-scope="d0"]');
  assert.ok(wfBtn,'у водопада есть переключатель охвата');
  const wfSeg=wfBtn.closest('.chart-scope');
  assert.ok(wfSeg,'кнопки охвата водопада собраны в сегмент');
  assert.equal(wfSeg.querySelectorAll('button').length,2,'у водопада два положения — без «100% непокрытые»');
  assert.ok(!wfSeg.querySelector('[data-scope="unc"]'),'режим «только 100% непокрытые» к водопаду не добавляется');
  const wfAll=wfSeg.querySelector('[data-scope="all"]');
  assert.ok(wfAll.classList.contains('p'),'по умолчанию активен «Все заказы»');
  assert.equal(wfAll.getAttribute('aria-pressed'),'true','состояние кнопки доступно скринридеру');
  assert.equal(ctx.ev("chartShowsAll('d0')"),true,'водопад строится от неограниченного спроса без переключений');
  assert.match(ctx.document.getElementById('d0sub').textContent,/Показаны все заказы/,'подпись карточки подтверждает полный охват');

  ctx.document.querySelector('[data-chart-scope="d0"][data-scope="plan"]').click();
  await settle(250);
  assert.equal(ctx.ev("chartShowsAll('d0')"),false,'водопад можно вернуть к «Плану продаж»');
  assert.match(ctx.document.getElementById('d0sub').textContent,/непокрытые заказы скрыты/,'подпись предупреждает о скрытых заказах');
  ctx.document.querySelector('[data-chart-scope="d0"][data-scope="all"]').click();
  await settle(250);
  assert.equal(ctx.ev("chartShowsAll('d0')"),true,'вернулись к «Все заказы»');

  /* ── остальные графики: три положения, по умолчанию «План продаж» ── */
  for (const id of ['d1','d2','d8','d9']) {
    const btn=ctx.document.querySelector(`[data-chart-scope="${id}"]`);
    assert.ok(btn,`у графика ${id} есть переключатель охвата`);
    const seg=btn.closest('.chart-scope');
    assert.equal(seg.querySelectorAll('button').length,3,`${id}: три положения охвата`);
    assert.ok(seg.querySelector('[data-scope="unc"]'),`${id}: есть режим «100% непокрытые»`);
    const plan=seg.querySelector('[data-scope="plan"]');
    assert.ok(plan.classList.contains('p'),`${id}: по умолчанию «План продаж»`);
    assert.equal(plan.getAttribute('aria-pressed'),'true',`${id}: состояние доступно скринридеру`);
    assert.match(plan.textContent,/План продаж/,`${id}: первое положение названо «План продаж»`);
  }
  const before=JSON.parse(ctx.ev(`JSON.stringify({
    all:fOrders().length,
    chart:chartOrders('d1',fOrders()).length,
    full:chartOrders('d1',fOrders()).filter(o=>orderStageOf(o)==='fullUnc').length
  })`));
  assert.equal(before.all,3,'в детализации три заказа');
  assert.equal(before.chart,2,'на графике по умолчанию только План продаж');
  assert.equal(before.full,0,'100% непокрытых на графике по умолчанию нет');

  /* «Все заказы» — точечно для одного графика */
  ctx.document.querySelector('[data-chart-scope="d1"][data-scope="all"]').click();
  await settle(250);
  const after=JSON.parse(ctx.ev(`JSON.stringify({
    on:chartShowsAll('d1'),
    chart:chartOrders('d1',fOrders()).length,
    full:chartOrders('d1',fOrders()).filter(o=>orderStageOf(o)==='fullUnc').length
  })`));
  assert.equal(after.on,true,'переключатель включил полный охват только этого графика');
  assert.equal(after.chart,3,'показаны все заказы');
  assert.equal(after.full,1,'100% непокрытый заказ добавлен');
  assert.equal(ctx.ev("chartShowsAll('d2')"),false,'соседний график не переключился');

  /* «100% непокрытые» — на графике остаются только такие заказы (2026-10-06) */
  ctx.document.querySelector('[data-chart-scope="d1"][data-scope="unc"]').click();
  await settle(250);
  const unc=JSON.parse(ctx.ev(`(function(){
    const rows=chartOrders('d1',fOrders());
    return JSON.stringify({n:rows.length,fullUnc:rows.filter(o=>orderStageOf(o)==='fullUnc').length,
      ids:rows.map(o=>o.id),mode:scopeOf('d1'),showsAll:chartShowsAll('d1')});
  })()`));
  assert.equal(unc.mode,'unc','режим графика записан в состояние охвата');
  assert.equal(unc.n,1,'в режиме «100% непокрытые» на графике один заказ');
  assert.equal(unc.fullUnc,1,'и это заказ со 100% непокрытым спросом');
  assert.deepEqual(unc.ids,[103],'остался только заказ 103 — единственный 100% непокрытый');
  assert.equal(unc.showsAll,false,'режим «Все заказы» при этом выключен');
  const uncBtn=ctx.document.querySelector('[data-chart-scope="d1"][data-scope="unc"]');
  assert.ok(uncBtn&&uncBtn.classList.contains('p'),'кнопка «100% непокрытые» подсвечена после перерисовки');
  assert.equal(ctx.ev("scopeOf('d2')"),'plan','соседний график остался в «Плане продаж»');

  /* повторный клик по активной кнопке ничего не меняет */
  ctx.document.querySelector('[data-chart-scope="d1"][data-scope="unc"]').click();
  await settle(150);
  assert.equal(ctx.ev("scopeOf('d1')"),'unc','режим не сломался повторным кликом');

  await ctx.goTab('ov');
  const o8Btn=ctx.document.querySelector('[data-chart-scope="o8"]');
  assert.ok(o8Btn,'у графика упущенной маржи есть тот же переключатель охвата');
  const o8=o8Btn.closest('.chart-scope');
  assert.equal(o8.querySelectorAll('button').length,3,'в «Общем» тоже три положения');
  assert.ok(o8.querySelector('[data-scope="plan"]').classList.contains('p'),'в «Общем» по умолчанию тоже только План продаж');
  assert.ok(ctx.document.querySelector('[data-chart-scope="o8"][data-scope="unc"]'),'в «Общем» доступен режим «100% непокрытые»');
});

/* Демо-набор без ClickHouse: агрегат покрытия синтезирован (demoCoverage), а
   100% непокрытых строк в детализации нет — контроль охвата водопада обязан
   оставаться видимым (ступени «Неограниченный спрос» строятся из агрегата),
   а у остальных графиков — скрытым, потому что переключать нечего. */
async function loadDemo(){
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',()=>{});
  const dom=new JSDOM(fs.readFileSync(HTML,'utf8'),{
    url:BASE+'/',runScripts:'dangerously',pretendToBeVisual:true,
    virtualConsole,resources:{interceptors:[localResources]}});
  await new Promise((resolve)=>dom.window.addEventListener('load',resolve));
  await settle(400);
  const w=dom.window,d=w.document;
  return {window:w,document:d,
    ev:code=>w.eval(code),
    goTab:async id=>{w.go(id);await settle(300)},
    close(){try{dom.window.close()}catch(e){/* jsdom */}}};
}
test('демо-набор: контроль водопада виден и без непокрытых строк в детализации (агрегат есть)', async (t) => {
  const ctx=await loadDemo();
  t.after(ctx.close);
  await ctx.goTab('dm');

  assert.equal(ctx.ev('(function(){return chartOrders("d1",fOrders()).filter(o=>orderStageOf(o)==="fullUnc").length})()'),0,
    'фикстура: в демо-детализации нет ни одного 100% непокрытого заказа');
  const btn=ctx.document.querySelector('[data-chart-scope="d0"]');
  assert.ok(btn,'контроль охвата водопада виден: агрегат покрытия есть, хоть непокрытых строк в детализации нет');
  const seg=btn.closest('.chart-scope');
  assert.equal(seg.querySelectorAll('button').length,2,'два положения — без «100% непокрытые»');
  assert.equal(ctx.ev("scopeOf('d0')"),'all','умолчание водопада — «Все заказы»');
  assert.match(ctx.document.getElementById('d0sub').textContent,/Показаны все заказы/,
    'цепочка строится от неограниченного спроса');
  assert.equal(ctx.document.querySelector('[data-chart-scope="d1"]'),null,
    'у остальных графиков контроля нет: непокрытых заказов нет — переключать нечего');
});

test('periodid 4YYYYMMDD приводится к P-бакету Плана продаж', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  const rows=JSON.parse(ctx.ev(`JSON.stringify(CHX.mergeIndependentOrders([
    {id:301,p:0,loc:'L1',prod:'SKU-1',dt:1,stream:'S1',dem:100,sal:100,unm:0}
  ],[
    {sourceId:1,item:'SKU-1',loc:'L1',demandtype:'1',dmdstream:'S1',demandqty:100,periodid:'420270401',date:'2027-04-01'},
    {sourceId:2,item:'SKU-2',loc:'L1',demandtype:'1',dmdstream:'S1',demandqty:50,periodid:'420270401',date:'2027-04-01'}
  ],[]))`));
  assert.equal(rows[0].p,0,'период заказа плана сохранён как P0');
  assert.equal(rows[1].p,0,'непокрытый заказ того же календарного периода сопоставлен с P0');
  assert.equal(ctx.ev(`periodLabel(${JSON.stringify(rows[0].p)})`),'P0');
  assert.equal(ctx.ev(`periodLabel(${JSON.stringify(rows[1].p)})`),'P0');
  assert.equal(ctx.ev("normalizePeriodKey('P420270401')"),'2027-04',
    'технический periodid распознаётся как календарный апрель, а не P420270401');
});

test('«Заказы спроса» использует номера, названия и расчёты RCA', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  ctx.ev(`(function(){
    const rows=CHX.mergeIndependentOrders([
      {id:401,p:0,loc:'L1',prod:'SKU-1',cl:'C1',dt:1,stream:'S1',dem:100,sal:100,unm:0,
       price:1000,cpt:600,mpt:400,rev:100000,cost:60000,mar:40000}
    ],[
      {sourceId:1,item:'SKU-1',loc:'L1',demandtype:'1',dmdstream:'S1',demandqty:100,periodid:'420270401',date:'2027-04-01'},
      {sourceId:2,item:'SKU-2',loc:'L1',demandtype:'1',dmdstream:'S1',demandqty:50,periodid:'420270401',date:'2027-04-01'}
    ],[]);
    DS=build({name:'Проверка единого реестра',orders:rows,ops:[],capacity:[]});
    DS.agg=null;DS.penalty=[];DS.penaltyFlat=[];DS.capacityPlan=[];DS.detailLimited=false;
    clearF();LM_BASE='plan';
  })()`);

  await ctx.goTab('dm');
  const rcaHeaders=[...ctx.document.querySelectorAll('#d7 th')].map(x=>clean(x.textContent).replace(/[▲▼↕▾]/g,'').trim());
  const rcaIds=[...ctx.document.querySelectorAll('#d7 tbody tr td:first-child')].map(x=>clean(x.textContent).replace(/↗/g,'').trim());
  assert.ok(rcaIds.includes('ID-2'),'RCA показывает бизнес-метку, не отрицательный технический id');

  await ctx.goTab('raw');
  const rawHeaders=[...ctx.document.querySelectorAll('#rawTbl th')].map(x=>clean(x.textContent).replace(/[▲▼↕▾]/g,'').trim());
  const rawIds=[...ctx.document.querySelectorAll('#rawTbl tbody tr td:first-child')].map(x=>clean(x.textContent).trim());
  assert.ok(rawIds.includes('ID-2'),'«Заказы спроса» показывает тот же ID-2');
  assert.ok(!rawIds.some(x=>/-100000000/.test(x)),'отрицательные служебные ID скрыты');
  for(const h of ['# Заказа','Статус покрытия','Локация','Продукт','Клиент','Канал','Период',
    'Спрос','Отгрузка','Дефицит','Покрытие','Упущ. выручка','Упущ. маржа']) {
    assert.ok(rcaHeaders.includes(h),`RCA содержит «${h}»`);
    assert.ok(rawHeaders.includes(h),`«Заказы спроса» содержит «${h}»`);
  }
});
