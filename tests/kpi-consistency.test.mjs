/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: сквозной аудит показателей.

   1. «Общий» считает итоги в том же охвате, что «Спрос и покрытие».
      Дефект: tabOV суммировал выручку, маржу, план и отгрузку по загруженной
      ВЫБОРКЕ заказов (топ-N по модулю маржи), а tabDM — по агрегатам схемы.
      На одном и том же наборе две вкладки показывали разный Service Level.
   2. «Упущенная выручка» строится как «ставка × объём» (как упущенная маржа),
      а не как сумма по выборке: иначе цифра занижена во столько же раз,
      во сколько урезана детализация.
   3. «Заказов без дефицита» берётся из агрегата (countIf(unm <= 1e-9)),
      а не «сколько из загруженных двух заказов без дефицита».
   4. Единица фонда мощностей — из данных: capacity_view_sp отдаёт ЧАСЫ,
      а в карточке было жёстко написано «т».
   5. «Пустых атрибутов» в «Качестве данных» считается по тем же полям, что
      рисует график заполненности, а не константой 4.

   Мок: агрегат схемы — 8 заказов, план 5000, отгрузка 4000, дефицит 1000,
   выручка 50 млрд, маржа 20 млрд, без дефицита 3 заказа;
   детализация — 2 заказа: план 1000, отгрузка 900, дефицит 100,
   выручка 9,68 млрд, маржа 3,82 млрд, без дефицита 0.

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

/* агрегат по ВСЕЙ схеме: 8 заказов, 50 млрд выручки, Service Level 80% */
const ORDERS_TOT = {
  orders: 8, rev: 50e9, cost: 30e9, mar: 20e9,
  dem: 5000, sal: 4000, unm: 1000, lm: 3e9, full: 3,
};
/* покрытие: покрытый 4000 (= отгрузке) + непокрытый 1500 = 5500 */
const COV = { demUnc: 5500, ff: 4000, uf: 1500, inTime: 3800, late: 200, lostRev: 20e9, planRev: 50e9, prop: 5500 };
const COV_P = [{ k: '2026-09', demUnc: 5500, ff: 4000, uf: 1500, late: 200 }];
/* неограниченный спрос — по умолчанию фолбэк «покрытый + непокрытый» из demand_coverage
   (таблица independent_demand лежит в PostgreSQL, в CH её нет и не ищем) */
const BY_OP = [{ t: 'production', c: 5e9, v: 900, n: 2 }, { t: 'movement', c: 3e9, v: 900, n: 2 }];
const DIM_P = [{ k: '1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
const DIM_PR = [{ k: 'P1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
const DIM_CL = [{ k: 'C1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
/* детализация: 2 заказа из 8 — Service Level 90%, маржинальность 39,5% */
const ORDERS = [
  { id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1',
    dem: 400, sal: 380, unm: 20, price: 20e6, cpt: 12e6, mpt: 8e6, rev: 7.6e9, cost: 4.56e9, mar: 3.04e9, prio: 1, mph: 0 },
  { id: 102, p: '2', loc: 'L1', prod: 'P2', cl: 'C2', dtype: 1, stream: 'S1',
    dem: 600, sal: 520, unm: 80, price: 4e6, cpt: 2.5e6, mpt: 1.5e6, rev: 2.08e9, cost: 1.3e9, mar: 0.78e9, prio: 2, mph: 0 },
];
const OPS = [
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 380, r: 12e6, vd: '', rt: '1.1', oid: '101.1', rc: 0 },
  { o: 102, p: '2', type: 'movement', pl: '', pr: 'P2', rs: '', fr: 'L1', to: 'L2', tm: 'авто', v: 520, r: 2.5e6, vd: '', rt: '', oid: '102.1', rc: 0 },
];
/* вариант набора, где все плечи логистики — строки-заглушки (тариф ≤ 1 ₽/т):
   объём «реальных» строк нулевой, и средний тариф посчитать не из чего */
const OPS_STUB = [
  OPS[0],
  { ...OPS[1], r: 1 },
];
let stubLogistics = false;

/* мощности: ЧАСЫ (capacity_view_sp), всего доступно 1000 ч */
const CAPS = [
  { rs: 'R1', pl: 'L1', resTypeDescr: 'Печь', resType: 1, grp: 'G1', periodKey: '2026-09',
    norm: 1000, avail: 900, load: 810, useIp: 0, useP: 810, useS: 0, useT: 0, maint: 50, oee: 0.9 },
  { rs: 'R2', pl: 'L1', resTypeDescr: 'Линия', resType: 1, grp: 'G1', periodKey: '2026-09',
    norm: 120, avail: 100, load: 50, useIp: 0, useP: 50, useS: 0, useT: 0, maint: 10, oee: 0.8 },
];

function route(sql) {
  const dbm = sql.match(/`(data_public_\d+)`\./);
  const db = dbm && dbm[1];
  if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
  if (/AS oid/.test(sql)) return stubLogistics ? OPS_STUB : OPS;   /* детализация операций заказов */
  if (/FROM system\.databases/.test(sql))
    return [{ name: 'system' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
  if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
  if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
  if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
  if (/`independent_demand`/.test(sql)) throw new Error('в ClickHouse таблицы independent_demand быть не должно');
  if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
  if (/AS resTypeDescr/.test(sql)) return CAPS;
  if (/`operation_type` AS t/.test(sql)) return BY_OP;
  if (/`o_p` AS k/.test(sql)) return DIM_P;
  if (/`o_prod` AS k/.test(sql)) return DIM_PR;
  if (/`o_cl` AS k/.test(sql)) return DIM_CL;
  if (/`lostrevenue`/.test(sql)) return [COV];
  if (/GROUP BY k ORDER BY k/.test(sql)) return COV_P;
  if (/SELECT order_id AS id/.test(sql)) return ORDERS;
  if (/IN \(/.test(sql)) return OPS;
  return [];
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
const toNum = (s) => Number(clean(s).replace(/\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.'));

async function loadCH() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
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
  const card = (title) => {
    const k = kpi(title);
    if (!k) throw new Error('нет карточки «' + title + '»');
    return { v: clean(k.querySelector('.v').textContent), s: clean((k.querySelector('.s') || {}).textContent || '') };
  };
  return {
    window: w, document: d, kpi, card,
    kpiVal: (title) => toNum(card(title).v),
    ev: (code) => w.eval(code),
    goTab: async (id) => { w.go(id); await settle(300); },
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}

test('«Общий» считает итоги в охвате цепочки спроса, а не по урезанной выборке', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);
  await ctx.goTab('ov');

  /* было: 9,68 млрд (две загруженные строки) — стало: агрегат всей схемы */
  assert.equal(ctx.kpiVal('Валовая выручка'), 50, 'валовая выручка — 50 млрд по схеме');
  assert.equal(ctx.kpiVal('Себестоимость'), 30, 'себестоимость — 30 млрд по схеме');
  assert.equal(ctx.kpiVal('Валовая маржа'), 20, 'валовая маржа — 20 млрд по схеме');
  assert.equal(ctx.card('Валовая маржа').s, 'маржинальность 40,0%', 'маржинальность 20/50, а не 3,82/9,68');
  assert.equal(ctx.kpiVal('Маржа на тонну'), 5000000, 'маржа на тонну 20 млрд / 4000 т');

  /* было: 90,0% по выборке — стало: 80,0%, как на вкладке «Спрос и покрытие» */
  assert.equal(ctx.card('Service Level').v, '80,0%', 'Service Level — 4000 из 5000 т');
  assert.equal(ctx.card('Service Level').s, '4 000 из 5 000 т', 'подпись в том же охвате');
  assert.match(ctx.card('Валовая выручка').s, /агрегат всей схемы/, 'охват назван явно');
});

test('Service Level и дефицит одинаковы на «Общем» и в «Спросе и покрытии»', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);

  await ctx.goTab('ov');
  /* 2026-10-05: «Не покрыто всего» удалена из «Общего», «Упущенная маржа» и
     «Упущенная выручка» объединены в одну карточку */
  const ov = { sl: ctx.card('Service Level').v, lm: ctx.kpiVal('Упущенная маржа и выручка') };
  await ctx.goTab('dm');
  const dm = { sl: ctx.card('План продаж').s, gap: ctx.kpiVal('Не покрыто всего'), lm: ctx.kpiVal('Упущенная маржа'),
    mrg: ctx.card('Маржинальность продаж') };
  /* величины цепочки — из covBasis: карточки «Ограниченный спрос (план)» и
     «Дефицит плана» убраны из верхнего ряда (2026-10-05), их место — водопад */
  const V = JSON.parse(ctx.ev('(function(){const b=covBasis(fOrders());'
    + 'return JSON.stringify({shipped:b.sal,limited:b.dem,deficit:b.unm,gap:b.gapTotal})})()'));

  assert.match(dm.sl, new RegExp('SL ' + ov.sl.replace(',', ',')), 'Service Level совпадает на обеих вкладках');
  assert.equal(ov.lm, dm.lm, 'упущенная маржа совпадает');
  assert.equal(dm.mrg.v, '40,0%', 'маржинальность продаж — 20/50 по схеме, как «Валовая маржа» на «Общем»');
  assert.equal(dm.mrg.s, 'выручка 50,00 млрд · маржа 20,00 млрд · схема', 'финансы в охвате схемы');
  assert.match(clean(ctx.kpi('Упущенная маржа').textContent), /упущенная выручка 7,20 млрд/,
    'упущенная выручка здесь та же, что на «Общем»');
  assert.equal(V.shipped, 4000, 'отгружено — агрегат схемы');
  assert.equal(V.limited, 5000, 'ограниченный спрос — агрегат схемы');
  assert.equal(V.deficit, 1000, 'дефицит плана — агрегат схемы');
  assert.equal(V.gap, dm.gap, '«Не покрыто всего» — агрегат схемы');
});

test('упущенная выручка и «заказы без дефицита» берут объём из того же охвата', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);
  await ctx.goTab('ov');

  /* ставка отказа по выборке = (20×20 млн + 80×4 млн)/100 = 7,2 млн ₽/т,
     объём дефицита по схеме = 1000 т  →  7,20 млрд (было 0,72 млрд).
     2026-10-05: выручка — в подписи объединённой карточки «Упущенная маржа и выручка» */
  const merged = ctx.card('Упущенная маржа и выручка');
  assert.match(clean(merged.s), /упущенная выручка 7,20 млрд/, 'упущенная выручка = ставка × объём схемы');

  /* было «0 из 2» — считались только загруженные заказы.
     2026-10-05: счёт — по классификации заказов (demand_coverage → marking_demand):
     фолбэком служит агрегат countIf(unm <= 1e-9) */
  assert.equal(ctx.card('Заказов без дефицита').v, '3 из 8', 'из агрегата заказов схемы');
  assert.equal(ctx.card('Заказов без дефицита').s, '37,5% портфеля', 'доля от всех заказов схемы');
});

test('снапшот версии описывает план целиком, а не верхушку портфеля', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);

  const s = ctx.ev('JSON.stringify((({orders,ordersDet,scope,rev,cost,mar,dem,sal,unm,lm,full})=>'
    + '({orders,ordersDet,scope,rev,cost,mar,dem,sal,unm,lm,full}))(snap(DS)))');
  const snap = JSON.parse(s);
  assert.equal(snap.scope, 'schema', 'снапшот помечен охватом схемы');
  assert.equal(snap.orders, 8, 'заказов — 8 по схеме (загружено 2)');
  assert.equal(snap.ordersDet, 2, 'размер загруженной выборки сохранён отдельно');
  assert.equal(snap.rev, 50e9, 'выручка — агрегат схемы');
  assert.equal(snap.mar, 20e9, 'маржа — агрегат схемы');
  assert.equal(snap.dem, 5000, 'план — агрегат схемы');
  assert.equal(snap.sal, 4000, 'отгрузка — агрегат схемы');
  assert.equal(snap.unm, 1000, 'дефицит — агрегат схемы');
  assert.equal(snap.full, 3, 'заказов без дефицита — из агрегата');
  /* упущенная маржа: ставка выборки (20×8 млн + 80×1,5 млн)/100 = 2,8 млн ₽/т × 1000 т */
  assert.equal(Math.round(snap.lm), 2.8e9, 'упущенная маржа = ставка выборки × объём схемы');
});

test('единица фонда мощностей берётся из данных: capacity_view_sp отдаёт часы', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);
  await ctx.goTab('pd');

  const c = ctx.card('Средняя загрузка мощностей');
  assert.equal(c.s, 'доступно 1 000 ч', 'часы, а не тонны');
  assert.equal(ctx.ev('DS.capacity[0].unit'), 'h', 'коннектор помечает мощности часами');
});

test('«Пустых атрибутов» считается по данным и перечисляет поля', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);
  await ctx.goTab('dq');

  const c = ctx.card('Пустых атрибутов');
  /* в наборе пусты: машино-часы (rc=0), потреблённый запас и late_delivery
     (полей нет в выгрузке вовсе); закупок в наборе нет — это не пустой атрибут */
  assert.equal(toNum(c.v), 3, 'три пустых поля, а не константа 4');
  assert.match(c.s, /Машино-часы/, 'в подписи перечислены сами поля');
  assert.match(c.s, /late_delivery|Потреблённый запас/, 'перечислены и неиспользуемые поля');
  assert.doesNotMatch(c.s, /из выгрузки не используются/, 'старая обезличенная подпись убрана');
});

test('удельные показатели не выдумываются при нулевом знаменателе', async (t) => {
  stubLogistics = true;
  t.after(() => { stubLogistics = false; });
  const ctx = await loadCH();
  t.after(ctx.close);
  await ctx.goTab('lg');

  /* все плечи — заглушки (тариф 1 ₽/т), объём «реальных» строк = 0.
     Было: cost / Math.max(0, 1) → «0 ₽/т», что читается как «перевозка
     ничего не стоит». Стало: честное «—» с объяснением причины. */
  const c = ctx.card('Средний тариф');
  assert.equal(c.v, '—', 'ставка не считается без базы');
  assert.equal(c.s, 'все строки — заглушки, тариф не рассчитывается', 'причина названа');
  assert.equal(ctx.card('Строк-заглушек').v, '100,0%', 'набор действительно состоит из заглушек');
});
