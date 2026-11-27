/* ─────────────────────────────────────────────────────────────────────────────
   Ноль-фильтрация: бизнес-бессмысленные строки с нулевым объёмом отсекаются
   на входе (XLSX parseRows и ClickHouse loadMainDetail), а реальные данные
   и KPI при этом не меняются.

   Проверяется:
   1. XLSX: операции с v=0 и rc=0 не попадают в DS.ops; заказы с
      dem=sal=unm=0 (и их операции) не попадают в DS.orders; 100%-непокрытые
      (sal=0, unm>0) и отрицательные объёмы сохраняются.
   2. XLSX: KPI-инвариантность — Σdem/Σsal/Σunm/Σrev/Σmar одинаковы с
      нулевыми строками и без них.
   3. ClickHouse: SQL детализации содержит HAVING/WHERE с допуском 1e-9
      (abs(...) > 0.000000001) для заказов, операций и demand_coverage;
      нулевой заказ из мока не попадает в DS.orders, нулевые операции —
      не попадают в DS.ops; итоги DS совпадают с итогами без нулевых строк.

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

async function loadApp() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const window = dom.window;
  return {
    dom, window, document: window.document,
    ev: (code) => window.eval(code),
    parse(rows) {
      return JSON.parse(window.eval(`(function(){
        const rows = ${JSON.stringify(rows)};
        const parsed = parseRows(rows, 'test.xlsx');
        const ds = build(parsed);
        return JSON.stringify({
          orders: ds.orders.map(o=>({id:o.id, dem:o.dem, sal:o.sal, unm:o.unm, rev:o.rev, mar:o.mar})),
          ops: ds.ops.map(o=>({o:o.o, v:o.v, rc:o.rc||0, oid:o.oid})),
          skippedOps: parsed.skippedOps
        });
      })()`));
    },
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}

/* Строка листа marking_demand: имена колонок — ровно как в COL. */
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
  'Тип операции': 'production',
  'Локация производства': 'Plant_1',
  'Продукт производства': 'FPRL_5',
  'Ресурс': 'RES_1',
  'Размеченный объем операции': 800,
  'Затраты на тонну': 40000,
  'order_operation_id': String(id) + '.1',
  'resource_consumption_operation': 0,
}, extra);

const zeroRow = (id) => row(id, {
  'План спроса': 0, 'План продаж': 0, 'Неудовлетворенный спрос': 0,
  'Валовая выручка (план продаж)': 0, 'Суммарная себестоимость': 0,
  'Валовая маржа (план продаж), руб': 0,
  'Размеченный объем операции': 0,
});

/* ─────────────────────── 1. XLSX: нулевые операции и заказы ─────────────────────── */

test('XLSX: операции с нулевым объёмом и расходом отсекаются, отрицательные сохраняются', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const ds = ctx.parse([
    row(1),                                                            // v=800 — остаётся
    row(1, { 'order_operation_id': '1.2', 'Размеченный объем операции': 0 }), // v=0, rc=0 — отсекается
    row(1, { 'order_operation_id': '1.3', 'Размеченный объем операции': -50 }), // отрицательный — остаётся
    row(1, { 'order_operation_id': '1.4', 'Размеченный объем операции': 1e-10 }), // ниже допуска — отсекается
    row(1, { 'order_operation_id': '1.5', 'Размеченный объем операции': 0, 'resource_consumption_operation': 5 }), // расход > 0 — остаётся
  ]);
  assert.deepEqual(ds.ops.map((o) => o.oid), ['1.1', '1.3', '1.5'],
    'нулевые операции выкинуты, отрицательная и с ненулевым расходом — на месте');
  assert.equal(ds.orders.length, 1, 'заказ не потерян');
});

test('XLSX: заказ со всеми нулями отсекается вместе с операциями, 100%-непокрытый остаётся', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const ds = ctx.parse([
    row(1),                                                            // обычный заказ
    zeroRow(2),                                                        // dem=sal=unm=0 — отсекается
    row(3, { 'План продаж': 0, 'Неудовлетворенный спрос': 1000,
             'Валовая выручка (план продаж)': 0, 'Суммарная себестоимость': 0,
             'Валовая маржа (план продаж), руб': 0 }),                 // 100% не покрыто — остаётся
  ]);
  assert.deepEqual(ds.orders.map((o) => o.id), [1, 3],
    'нулевой заказ выкинут, 100%-непокрытый сохранён');
  assert.ok(ds.ops.every((o) => o.o !== 2), 'операции нулевого заказа тоже выкинуты');
  assert.ok(ds.ops.some((o) => o.o === 3), 'операции 100%-непокрытого заказа на месте');
});

test('XLSX: KPI-инвариантность — итоги не зависят от нулевых строк', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const clean = [row(1), row(2, { 'План спроса': 500, 'План продаж': 500,
    'Неудовлетворенный спрос': 0, 'Валовая выручка (план продаж)': 50000000,
    'Суммарная себестоимость': 20000000, 'Валовая маржа (план продаж), руб': 30000000 })];
  const withZeros = [
    ...clean,
    zeroRow(90),
    zeroRow(91),
    row(1, { 'order_operation_id': '1.9', 'Размеченный объем операции': 0 }),
  ];
  const sum = (ds, k) => ds.orders.reduce((s, o) => s + o[k], 0);
  const a = ctx.parse(clean), b = ctx.parse(withZeros);
  for (const k of ['dem', 'sal', 'unm', 'rev', 'mar']) {
    assert.equal(sum(b, k), sum(a, k), `Σ${k} не изменилась от нулевых строк`);
  }
  assert.equal(b.orders.length, a.orders.length, 'число заказов не изменилось');
  assert.equal(b.ops.length, a.ops.length, 'число операций не изменилось');
});

/* ─────────────────────── 2. ClickHouse: SQL и фильтрация ─────────────────────── */

const DBS = { data_public_1: { grans: [[4, 100]], n: 1200, ts: '2026-09-10 08:00:00' } };
const COLS = [
  'order_id','order_operation_id','resource','demand_period','demand_product',
  'demand_client','demand_location','demand_volume','results_sale','unsatisfied_demand',
  'revenue','cost_of_demand','total_margin','margin_per_unit','price','cost_per_unit_order',
  'demand_demandtype','dmdstream','demand_demandtypepriority','margin_per_hour','operation_type',
  'location','product','loc_from','loc_to','transport_type','order_operation_volume',
  'cost_rate_of_operation','supplier','bom_num','resource_consumption_operation',
];
const ORDERS_TOT = { orders: 2, rev: 5380, cost: 3170, mar: 2210, dem: 1000, sal: 900, unm: 100, lm: 90, full: 1 };
const BY_OP = [{ t: 'production', c: 500, v: 48, n: 2 }, { t: 'movement', c: 300, v: 40, n: 2 }];
const DIM_P = [{ k: '1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const DIM_PR = [{ k: 'P1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const DIM_CL = [{ k: 'C1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const COV = { demUnc: 1200, ff: 950, uf: 250, inTime: 850, late: 50, lostRev: 120, planRev: 6000, prop: 1200 };
const COV_P = [{ k: '2026-09', demUnc: 1200, ff: 950, uf: 250, late: 50 }];
/* В моке — и нулевой заказ (999), и нулевая операция: загрузчик обязан их отсечь. */
const ORDERS = [
  { id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1', dem: 400, sal: 380, unm: 20, price: 100, cpt: 60, mpt: 40, rev: 1900, cost: 1140, mar: 760, prio: 1, mph: 0 },
  { id: 102, p: '2', loc: 'L1', prod: 'P2', cl: 'C2', dtype: 1, stream: 'S1', dem: 600, sal: 520, unm: 80, price: 120, cpt: 70, mpt: 50, rev: 3480, cost: 2030, mar: 1450, prio: 2, mph: 0 },
  { id: 999, p: '1', loc: 'L1', prod: 'PZ', cl: 'C1', dtype: 1, stream: 'S1', dem: 0, sal: 0, unm: 0, price: 0, cpt: 0, mpt: 0, rev: 0, cost: 0, mar: 0, prio: 1, mph: 0 },
];
const OPS = [
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 19, r: 26, vd: '', rt: '1.1', oid: '101.1', rc: 0 },
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 0, r: 0, vd: '', rt: '1.2', oid: '101.2', rc: 0 },
  { o: 102, p: '2', type: 'production', pl: 'L1', pr: 'P2', rs: 'R1', fr: '', to: '', tm: '', v: 29, r: 24, vd: '', rt: '2.1', oid: '102.1', rc: 0 },
];

function routeCH(sql) {
  const dbm = sql.match(/`(data_public_\d+)`\./);
  const db = dbm && dbm[1];
  if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
  if (/FROM system\.databases/.test(sql))
    return [{ name: 'system' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
  if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
  if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
  if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
  if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
  /* IN ( — раньше operation_type: запрос операций детализации содержит
     `operation_type` AS type, который иначе матчится как агрегат BY_OP */
  if (/IN \(/.test(sql)) return OPS;
  if (/`operation_type` AS t/.test(sql)) return BY_OP;
  if (/`o_p` AS k/.test(sql)) return DIM_P;
  if (/`o_prod` AS k/.test(sql)) return DIM_PR;
  if (/`o_cl` AS k/.test(sql)) return DIM_CL;
  if (/`lostrevenue`/.test(sql)) return [COV];
  if (/GROUP BY k ORDER BY k/.test(sql)) return COV_P;
  if (/SELECT order_id AS id/.test(sql)) return ORDERS;
  return [];
}

test('ClickHouse: SQL содержит ноль-фильтры 1e-9, нулевые строки не попадают в DS', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  const { window: w, document: d } = ctx;
  const sqlLog = [];
  w.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/pg/')) return { ok: false, status: 404, json: async () => ({}) };
    const sql = String((opts && opts.body) || '');
    sqlLog.push(sql);
    const rows = routeCH(sql);
    return { ok: true, status: 200, text: async () => rows.map((r) => JSON.stringify(r)).join('\n') };
  };
  /* PG отключён явно: тест изолирует ClickHouse-ветку */
  w.PGX.cfg.host = ''; w.PGX.cfg.database = ''; w.PGX.cfg.user = '';

  await w.CHX.connect();
  w.CHX.cfg.schemas = ['data_public_1'];
  w.CHX.cfg.base = 'data_public_1';
  await w.CHX.loadAll();

  const ds = w.DS;
  assert.ok(ds, 'датасет собран');
  assert.ok(!ds.orders.some((o) => o.id === 999), 'нулевой заказ 999 отсечён');
  /* JSON-перегон: массивы из jsdom-реалма не проходят deepStrictEqual на прототипах */
  const orderIds = JSON.parse(JSON.stringify(ds.orders.map((o) => o.id).sort()));
  assert.deepEqual(orderIds, [101, 102], 'реальные заказы на месте');
  assert.ok(!ds.ops.some((o) => o.oid === '101.2'), 'нулевая операция 101.2 отсечена');
  assert.ok(ds.ops.some((o) => o.oid === '101.1'), 'ненулевая операция на месте');

  /* KPI-инвариантность: итоги DS равны итогам без нулевых строк */
  const sum = (k) => ds.orders.reduce((s, o) => s + o[k], 0);
  assert.equal(sum('dem'), 1000, 'Σdem без нулевого заказа');
  assert.equal(sum('sal'), 900, 'Σsal без нулевого заказа');
  assert.equal(sum('unm'), 100, 'Σunm без нулевого заказа');

  /* SQL: ноль-фильтры с допуском 1e-9 стоят на заказах, операциях и покрытии */
  const TOL = /0\.000000001/;
  assert.ok(sqlLog.some((s) => /HAVING abs\(toFloat64\(dem\)\)/.test(s) && TOL.test(s)),
    'заказы marking_demand: HAVING abs(dem/sal/unm) > 1e-9');
  assert.ok(sqlLog.some((s) => /WHERE \(abs\(toFloat64\(`order_operation_volume`\)\)/.test(s) && TOL.test(s)),
    'операции marking_demand: WHERE abs(volume/rc) > 1e-9');
  assert.ok(sqlLog.some((s) => /WHERE \(abs\(toFloat64\(`fullfilleddemandqty`\)\)/.test(s) && TOL.test(s)),
    'demand_coverage: WHERE abs(ff/uf) > 1e-9');
  /* ноль-фильтр — ПОСЛЕ дедупликации src() (внешний WHERE/HAVING), а не внутри */
  const opsSql = sqlLog.find((s) => /WHERE \(abs\(toFloat64\(`order_operation_volume`\)\)/.test(s));
  assert.ok(opsSql.indexOf('LIMIT 1 BY') < opsSql.indexOf('WHERE (abs'),
    'фильтр операций стоит после LIMIT 1 BY дедупликации');
});
