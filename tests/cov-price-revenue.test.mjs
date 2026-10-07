/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: приоритетный расчёт валовой выручки по ценам спроса
   (задача владельца 2026-10-07).

   Методика: выручка = Σ fullfilleddemandqty (demand_coverage) × цена из
   demand_cost / demand_cost_ti; сшивка по item + loc + dmdstream + demandtype
   + период; нет цены в периоде — ближайший период (при равном удалении —
   более ранний); периодные цены demand_cost приоритетнее безпериодных
   demand_cost_ti; колонка цены — nondelcostrate (при нулях/отсутствии —
   следующий кандидат). Маржа и себестоимость не пересчитываются.

   1. Точный период + ближайший (более ранний из двух) + безпериодная цена
      demand_cost_ti + объём без цены: totals.rev = Σ qty×цена, revSrc
      фиксирует источник, прежние итоги сохраняются (revMs/revMd), маржа
      остаётся margin_sales; карточки и снапшот показывают пересчёт; DQ
      показывает долю объёма с ценой.
   2. Равноудалённые периоды → берётся более ранний.
   3. Календарный periodid (4YYYYMMDD) сопоставляется с date/datefr другой
      таблицы — точное совпадение без «ближайшего периода».
   4. Нулевой nondelcostrate → используется следующий кандидат (price).
   5. Справочник есть, но ключи не совпадают → заметка и честный возврат к
      margin_sales.
   6. Пустые справочники цен → тихий возврат к margin_sales (без предупреждений).

   Мок: marking_demand — выручка 50 млрд / маржа 20 млрд; margin_sales —
   60 / 25 млрд (нарочно другие числа, чтобы подмена источника была видна).

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

const DBS = { data_public_1: { grans: [[4, 100]], n: 1200, ts: '2026-10-01 08:00:00' } };
const COLS = [
  'order_id','order_operation_id','resource','demand_period','demand_product',
  'demand_client','demand_location','demand_volume','results_sale','unsatisfied_demand',
  'revenue','cost_of_demand','total_margin','margin_per_unit','price','cost_per_unit_order',
  'demand_demandtype','dmdstream','demand_demandtypepriority','margin_per_hour','operation_type',
  'location','product','loc_from','loc_to','transport_type','order_operation_volume',
  'cost_rate_of_operation','supplier','bom_num',
];
/* колонки справочников для запроса system.columns нового блока 8.9 */
const SYS_COLS = [
  ...['demand_coverage','item','loc','dmdstream','demandtype','date','periodtype',
     'fullfilleddemandqty','unfullfilleddemandqty','demandfullfilledintimeqty',
     'demandfullfilledlateqty','lostrevenue','plannedrevenue','sys_id','update_date_time',
     'is_deleted'].map((name) => ({ t: 'demand_coverage', name })),
  ...['demand_cost','item','loc','dmdstream','demandtype','datefr','periodtype',
     'nondelcostrate','latedelivcostrate','latedelivperiods','sys_id',
     'update_date_time','is_deleted'].map((name) => ({ t: 'demand_cost', name })),
  ...['demand_cost_ti','item','loc','dmdstream','demandtype','nondelcostrate',
     'latedelivcostrate','latedelivperiods','priority','quota','sys_id',
     'update_date_time','is_deleted'].map((name) => ({ t: 'demand_cost_ti', name })),
];

const ORDERS_TOT = {
  orders: 8, rev: 50e9, cost: 30e9, mar: 20e9,
  dem: 5000, sal: 4000, unm: 1000, lm: 3e9, full: 3,
};
const MS_TOT = { msRev: 60e9, msMar: 25e9, msCost: 35e9, msRows: 12 };
const COV = { demUnc: 5500, ff: 4000, uf: 1500, inTime: 3800, late: 200, lostRev: 20e9, planRev: 50e9, prop: 5500 };
const COV_P = [{ k: '2026-09', demUnc: 5500, ff: 4000, uf: 1500, late: 200 }];
const BY_OP = [{ t: 'production', c: 5e9, v: 900, n: 2 }, { t: 'movement', c: 3e9, v: 900, n: 2 }];
const DIM_P = [{ k: '1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
const DIM_PR = [{ k: 'P1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
const DIM_CL = [{ k: 'C1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
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

/* ── данные нового блока 8.9 (цены спроса) ──
   VOL  — объём выполненного спроса (demand_coverage, GROUP BY ключ + период);
   DCP  — периодные цены demand_cost (pc0 = nondelcostrate, pc1 = price, …);
   TIP  — безпериодные цены demand_cost_ti. */
const VOL_MAIN = [
  { item: 'SKU-1', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-09-01', ff: 4000, cpn: 2 },
  { item: 'SKU-2', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-10-01', ff: 1000, cpn: 1 },
  { item: 'SKU-3', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-11-01', ff: 500, cpn: 1 },
  { item: 'SKU-4', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-09-01', ff: 200, cpn: 1 },
];
const DCP_MAIN = [
  { item: 'SKU-1', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-09-01', pc0: 20e6, cpn: 3 },
  { item: 'SKU-2', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-09-01', pc0: 10e6, cpn: 3 },
  { item: 'SKU-2', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-12-01', pc0: 12e6, cpn: 3 },
];
const TIP_MAIN = [
  { item: 'SKU-3', loc: 'L1', stream: 'S1', dt: 1, pc0: 5e6, cpn: 2 },
];

function makeRoute(scenario) {
  const sc = Object.assign({ vol: VOL_MAIN, dcp: DCP_MAIN, tip: TIP_MAIN, sysCols: SYS_COLS }, scenario);
  return (sql) => {
    const dbm = sql.match(/`(data_public_\d+)`\./);
    const db = dbm && dbm[1];
    if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
    /* запрос колонок нового блока 8.9 — три таблицы сразу */
    if (/FROM system\.columns/.test(sql) && /lower\(table\)/.test(sql)) return sc.sysCols;
    if (/`margin_sales`/.test(sql)) return [MS_TOT];
    if (/AS oid/.test(sql)) return OPS;
    if (/FROM system\.databases/.test(sql))
      return [{ name: 'system' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
    if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
    if (/max\((update_date_time)\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
    if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
    if (/`independent_demand`/.test(sql)) throw new Error('в ClickHouse таблицы independent_demand быть не должно');
    if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
    if (/`operation_type` AS t/.test(sql)) return BY_OP;
    if (/`o_p` AS k/.test(sql)) return DIM_P;
    if (/`o_prod` AS k/.test(sql)) return DIM_PR;
    if (/`o_cl` AS k/.test(sql)) return DIM_CL;
    if (/lostrevenue/.test(sql)) return [COV];
    if (/GROUP BY k ORDER BY k/.test(sql)) return COV_P;
    /* ── блок 8.9: объём demand_coverage и цены справочников (маркер cpn) ── */
    if (/AS cpn/.test(sql) && /`demand_cost_ti`/.test(sql)) return sc.tip;
    if (/AS cpn/.test(sql) && /`demand_cost`/.test(sql)) return sc.dcp;
    if (/AS cpn/.test(sql) && /`demand_coverage`/.test(sql)) return sc.vol;
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
const toNum = (s) => Number(clean(s).replace(/\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.'));

async function loadCH(scenario) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
  const captured = [];
  const route = makeRoute(scenario);
  w.fetch = async (url, opts) => {
    const sql = String((opts && opts.body) || '');
    captured.push(sql);
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
    window: w, document: d, kpi, card, captured,
    kpiVal: (title) => toNum(card(title).v),
    ev: (code) => w.eval(code),
    goTab: async (id) => { w.go(id); await settle(300); },
    notes: () => { try { return String(w.eval('(DS.agg.notes||[]).join(" | ")')); } catch { return ''; } },
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}

test('точный период, ближайший и безпериодная цена: выручка = Σ fullfilleddemandqty × цена', async (t) => {
  const ctx = await loadCH({});
  t.after(ctx.close);

  /* 4000×20e6 (точный период) + 1000×10e6 (ближайший — 2026-09-01 из 09-01/12-01)
     + 500×5e6 (demand_cost_ti, у SKU-3 нет периодных цен) = 92,5 млрд;
     SKU-4 (200 т) без цены вообще — учтён нулём */
  assert.equal(ctx.ev('DS.agg.totals.rev'), 92.5e9, 'выручка — приоритетный пересчёт по ценам спроса');
  assert.equal(ctx.ev('DS.agg.totals.revSrc'), 'demand_coverage × demand_cost + demand_cost_ti',
    'источник выручки зафиксирован (периодные и безпериодные цены)');
  assert.equal(ctx.ev('DS.agg.totals.mar'), 25e9, 'маржа НЕ пересчитывается — margin_sales');
  assert.equal(ctx.ev('DS.agg.totals.finSrc'), 'margin_sales', 'источник маржи прежний');
  assert.equal(ctx.ev('DS.agg.totals.revMs'), 60e9, 'итог margin_sales сохранён для сверок');
  assert.equal(ctx.ev('DS.agg.totals.revMd'), 50e9, 'итог marking_demand сохранён для сверок');

  const cp = JSON.parse(ctx.ev('JSON.stringify(DS.agg.totals.covPrice)'));
  assert.equal(cp.ffTotal, 5700, 'весь выполненный объём посчитан');
  assert.equal(cp.ffMatched, 5500, 'объём с ценой');
  assert.equal(cp.ffExact, 4000, 'точный период');
  assert.equal(cp.ffNearest, 1000, 'ближайший период');
  assert.equal(cp.ffFlatTi, 500, 'безпериодная цена demand_cost_ti');
  assert.equal(cp.ffNoPrice, 200, 'объём без цены учтён нулём');
  assert.equal(cp.colDc, 'nondelcostrate', 'колонка цены demand_cost');
  assert.equal(cp.colTi, 'nondelcostrate', 'колонка цены demand_cost_ti');

  /* объём без цены честно виден в предупреждениях загрузки */
  assert.match(ctx.notes(), /цены спроса: у 200 т выполненного спроса нет цены/);

  /* карточки «Общего»: выручка — новая, маржа — margin_sales, источники названы */
  await ctx.goTab('ov');
  assert.equal(ctx.kpiVal('Валовая выручка'), 92.5, 'карточка — 92,5 млрд');
  assert.match(ctx.card('Валовая выручка').s, /спрос × цена/, 'подпись называет метод');
  assert.match(ctx.card('Валовая выручка').s, /demand_cost \+ demand_cost_ti/, 'подпись называет источник');
  assert.equal(ctx.kpiVal('Валовая маржа'), 25, 'маржа — 25 млрд из margin_sales');
  assert.match(ctx.card('Валовая маржа').s, /margin_sales/, 'подпись маржи называет источник');

  /* «Спрос и покрытие»: маржинальность продаж называет источники раздельно */
  await ctx.goTab('dm');
  const c = ctx.card('Маржинальность продаж');
  assert.match(c.s, /выручка: demand_coverage × demand_cost \+ demand_cost_ti/, 'источник выручки');
  assert.match(c.s, /маржа: margin_sales/, 'источник маржи');

  /* снапшот для сравнения версий берёт пересчитанную выручку и фиксирует источник */
  const snap = JSON.parse(ctx.ev('(function(){return JSON.stringify(snap(DS))})()'));
  assert.equal(snap.rev, 92.5e9, 'выручка снапшота — цены спроса');
  assert.equal(snap.mar, 25e9, 'маржа снапшота — margin_sales');
  assert.equal(snap.finSrc, 'margin_sales', 'источник маржи в снапшоте');
  assert.equal(snap.revSrc, 'demand_coverage × demand_cost + demand_cost_ti', 'источник выручки в снапшоте');
});

test('SQL блока цен: дедупликация src(), приведение toFloat64, без фильтра periodtype у цен', async (t) => {
  const ctx = await loadCH({});
  t.after(ctx.close);

  const volSql = ctx.captured.find((s) => /AS cpn/.test(s) && /`demand_coverage`/.test(s)) || '';
  assert.ok(volSql, 'запрос объёма выполненного спроса ушёл');
  assert.match(volSql, /is_deleted = 0/, 'дедупликация: is_deleted = 0');
  assert.match(volSql, /LIMIT 1 BY `sys_id`/, 'дедупликация: последняя версия строки');
  assert.match(volSql, /sum\(toFloat64\(`fullfilleddemandqty`\)\) AS ff/, 'объём — Σ fullfilleddemandqty через toFloat64');
  assert.match(volSql, /`periodtype` = 4/, 'объём — в гранулярности выбранной схемы');
  assert.ok(!/to\w+Or(?:Zero|Null)\s*\(/.test(volSql), 'нет запрещённых конверсий OrZero/OrNull');

  const dcSql = ctx.captured.find((s) => /AS cpn/.test(s) && /\.`demand_cost`/.test(s) && !/demand_cost_ti/.test(s)) || '';
  assert.ok(dcSql, 'запрос периодных цен demand_cost ушёл');
  assert.match(dcSql, /avg\(toFloat64\(`nondelcostrate`\)\) AS pc0/, 'цена — nondelcostrate (приоритетный кандидат)');
  assert.ok(!/periodtype/.test(dcSql), 'цены НЕ фильтруются по periodtype — ближайший период ищется по всему справочнику');
  assert.match(dcSql, /LIMIT 200001/, 'ограничение объёма выгрузки');

  const tiSql = ctx.captured.find((s) => /AS cpn/.test(s) && /\.`demand_cost_ti`/.test(s)) || '';
  assert.ok(tiSql, 'запрос безпериодных цен demand_cost_ti ушёл');
  assert.ok(!/vpid|vdate/.test(tiSql), 'у demand_cost_ti периодов нет');

  /* все запросы сессии — без запрещённых конверсий (Decimal в проде) */
  for (const sql of ctx.captured)
    assert.ok(!/to\w+Or(?:Zero|Null)\s*\(\s*`/.test(sql), 'SQL без OrZero/OrNull у столбцов: ' + sql.slice(0, 60));
});

test('равноудалённые периоды — берётся более ранний', async (t) => {
  /* покрытие 2026-10-08; цены 2026-10-01 (1 млн) и 2026-10-15 (9 млн) —
     обе на 7 дней; по методике берём более раннюю */
  const ctx = await loadCH({
    vol: [{ item: 'SKU-1', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-10-08', ff: 100, cpn: 1 }],
    dcp: [
      { item: 'SKU-1', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-10-01', pc0: 1e6, cpn: 3 },
      { item: 'SKU-1', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-10-15', pc0: 9e6, cpn: 3 },
    ],
    tip: [],
  });
  t.after(ctx.close);

  assert.equal(ctx.ev('DS.agg.totals.rev'), 100 * 1e6, 'выбрана более ранняя из равноудалённых цен');
  assert.equal(ctx.ev('DS.agg.totals.revSrc'), 'demand_coverage × demand_cost', 'источник — только периодные цены');
  const cp = JSON.parse(ctx.ev('JSON.stringify(DS.agg.totals.covPrice)'));
  assert.equal(cp.ffNearest, 100, 'объём взят ближайшим периодом');
  assert.equal(cp.ffExact, 0, 'точного совпадения не было');
});

test('календарный periodid (4YYYYMMDD) сопоставляется с date справочника — точное совпадение', async (t) => {
  const ctx = await loadCH({
    vol: [{ item: 'SKU-1', loc: 'L1', stream: 'S1', dt: 1, vpid: '420260901', vdate: '', ff: 1000, cpn: 1 }],
    dcp: [{ item: 'SKU-1', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-09-01', pc0: 3e6, cpn: 3 }],
    tip: [],
  });
  t.after(ctx.close);

  assert.equal(ctx.ev('DS.agg.totals.rev'), 3e9, '420260901 и 2026-09-01 — один период');
  const cp = JSON.parse(ctx.ev('JSON.stringify(DS.agg.totals.covPrice)'));
  assert.equal(cp.ffExact, 1000, 'сопоставление точное, не «ближайший период»');
  assert.equal(cp.ffNearest, 0);
});

test('нулевой nondelcostrate — используется следующий кандидат колонки цены (price)', async (t) => {
  const ctx = await loadCH({
    vol: [{ item: 'SKU-1', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-09-01', ff: 1000, cpn: 1 }],
    dcp: [{ item: 'SKU-1', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-09-01', pc0: 0, pc1: 7e6, cpn: 3 }],
    tip: [],
    sysCols: SYS_COLS.map((r) => (r.t === 'demand_cost' && r.name === 'latedelivperiods')
      ? { t: 'demand_cost', name: 'price' } : r),
  });
  t.after(ctx.close);

  assert.equal(ctx.ev('DS.agg.totals.rev'), 7e9, 'цена взята из колонки price — nondelcostrate пуст');
  const cp = JSON.parse(ctx.ev('JSON.stringify(DS.agg.totals.covPrice)'));
  assert.equal(cp.colDc, 'price', 'фактическая колонка цены зафиксирована');
});

test('справочник есть, но ключи не совпадают — заметка и возврат к margin_sales', async (t) => {
  const ctx = await loadCH({
    dcp: [{ item: 'SKU-OTHER', loc: 'L1', stream: 'S1', dt: 1, vpid: '', vdate: '2026-09-01', pc0: 1e6, cpn: 3 }],
    tip: [],
  });
  t.after(ctx.close);

  assert.equal(ctx.ev('DS.agg.totals.rev'), 60e9, 'выручка — 60 млрд из margin_sales');
  assert.ok(!ctx.ev('DS.agg.totals.revSrc'), 'revSrc не ставится — метод не применился');
  assert.match(ctx.notes(), /цены спроса: справочник demand_cost\/demand_cost_ti загружен, но ни одна строка demand_coverage не сопоставилась/,
    'причина видна в заметках загрузки');
});

test('пустые справочники цен — тихий возврат к margin_sales, без предупреждений', async (t) => {
  const ctx = await loadCH({ dcp: [], tip: [] });
  t.after(ctx.close);
  await ctx.goTab('ov');

  assert.equal(ctx.kpiVal('Валовая выручка'), 60, 'валовая выручка — 60 млрд из margin_sales');
  assert.equal(ctx.kpiVal('Валовая маржа'), 25, 'валовая маржа — 25 млрд из margin_sales');
  assert.match(ctx.card('Валовая выручка').s, /margin_sales/, 'источник — margin_sales');
  assert.ok(!/цены спроса/.test(ctx.notes()), 'метод не сработал — молча, без значка ⚠');
});

test('«Данные и качество»: доля объёма с ценой, ближайший период, сверка с прежней цепочкой', async (t) => {
  const ctx = await loadCH({});
  t.after(ctx.close);
  await ctx.goTab('dq');
  await settle(300); /* реестр #q3 рисуется в setTimeout(…,0) */

  const q3 = ctx.document.getElementById('q3');
  assert.ok(q3, 'реестр проверок отрисован');
  const items = [...q3.querySelectorAll('.dq')];

  const check = items.find((el) => /Выручка по ценам спроса/.test(el.textContent));
  assert.ok(check, 'проверка «Выручка по ценам спроса» есть в реестре');
  assert.ok(check.classList.contains('w'), 'объём без цены (200 из 5700 т) — предупреждение');
  const txt = clean(check.textContent);
  assert.match(txt, /96,5% объёма/, 'доля объёма с ценой названа');
  assert.match(txt, /5 500 из 5 700 т/, 'объёмы названы');
  assert.match(txt, /ближайший период — 18,2%/, 'доля ближайшего периода названа');
  assert.match(txt, /margin_sales 60,00 млрд/, 'сверка с прежней цепочкой: margin_sales');
  assert.match(txt, /marking_demand 50,00 млрд/, 'сверка с прежней цепочкой: marking_demand');
  assert.match(check.textContent, /полноту справочника demand_cost\/demand_cost_ti/, 'рекомендация называет, что проверить');

  /* сверка margin_sales против marking_demand остаётся, но больше не утверждает,
     что «карточки считаются по margin_sales» — выручка-то из цен */
  const cross = items.find((el) => /margin_sales против marking_demand/.test(el.textContent));
  assert.ok(cross, 'проверка источников margin_sales/marking_demand осталась');
  assert.match(cross.textContent, /из цен спроса/, 'интро честно про выручку из цен спроса');
  assert.match(clean(cross.textContent), /60,00 млрд/, 'итог margin_sales назван');
});
