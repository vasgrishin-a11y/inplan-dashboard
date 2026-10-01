/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: источник строк спроса во вкладке «Сравнение версий» (ветка ClickHouse).

   Требование владельца дашборда: все три строки спроса читаются из ОДНОЙ таблицы
   `demand_coverage`, где спрос уже разложен на покрытый и непокрытый:

     Неограниченный спрос, т    = fullfilleddemandqty + unfullfilleddemandqty
     Ограниченный спрос, т      = fullfilleddemandqty    (покрытый спрос)
     Неудовлетворённый спрос, т = unfullfilleddemandqty  (непокрытый спрос)

   Найденный дефект: из трёх строк из `demand_coverage` приходила только первая.
   «Ограниченный спрос» считался как Σ `demand_volume`, а «Неудовлетворённый
   спрос» — как Σ `unsatisfied_demand` из `marking_demand`, то есть с другой базой
   (план вместо спроса) и без фильтра по periodtype. Строки не складывались в
   тождество «Неограниченный = Ограниченный + Неудовлетворённый».

   Проверяется подстановкой заведомо РАЗНЫХ чисел в два источника: по значению в
   матрице однозначно видно, какая таблица его дала.

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

/* Две схемы-версии на одной гранулярности (месяц): сравнение требует минимум двух. */
const DBS = {
  data_public_1: { grans: [[4, 100]], n: 1200, ts: '2026-09-10 08:00:00' },
  data_public_2: { grans: [[4, 100]], n: 900, ts: '2026-09-11 09:00:00' },
};

const COLS = [
  'order_id','order_operation_id','resource','demand_period','demand_product',
  'demand_client','demand_location','demand_volume','results_sale','unsatisfied_demand',
  'revenue','cost_of_demand','total_margin','margin_per_unit','price','cost_per_unit_order',
  'demand_demandtype','dmdstream','demand_demandtypepriority','margin_per_hour','operation_type',
  'location','product','loc_from','loc_to','transport_type','order_operation_volume',
  'cost_rate_of_operation','supplier','bom_num',
];

/* marking_demand: план 1000, отгрузка 900, дефицит ВНУТРИ плана 100 */
const ORDERS_TOT = { orders: 2, rev: 5380, cost: 3170, mar: 2210, dem: 1000, sal: 900, unm: 100, lm: 90, full: 1 };
/* demand_coverage: покрытый 950 + непокрытый 250 = 1200 — ни одно число не совпадает с marking_demand */
const COV = { demUnc: 1200, ff: 950, uf: 250, inTime: 900, late: 50, lostRev: 120, planRev: 6000, prop: 1200 };
const COV0 = { demUnc: 0, ff: 0, uf: 0, inTime: 0, late: 0, lostRev: 0, planRev: 0, prop: 0 };
const COV_P = [{ k: '2026-09', demUnc: 1200, ff: 950, uf: 250, late: 50 }];
const BY_OP = [{ t: 'production', c: 500, v: 48, n: 2 }, { t: 'movement', c: 300, v: 40, n: 2 }];
const DIM_P = [{ k: '1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const DIM_PR = [{ k: 'P1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const DIM_CL = [{ k: 'C1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const ORDERS = [
  { id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1', dem: 400, sal: 380, unm: 20, price: 100, cpt: 60, mpt: 40, rev: 1900, cost: 1140, mar: 760, prio: 1, mph: 0 },
  { id: 102, p: '2', loc: 'L1', prod: 'P2', cl: 'C2', dtype: 1, stream: 'S1', dem: 600, sal: 520, unm: 80, price: 120, cpt: 70, mpt: 50, rev: 3480, cost: 2030, mar: 1450, prio: 2, mph: 0 },
];
const OPS = [
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 19, r: 26, vd: '', rt: '1.1', oid: '101.1', rc: 0 },
];

/** Маршрутизация SQL → строки ответа. noCovFor — схема, у которой покрытия нет. */
function makeRoute(noCovFor) {
  return function route(sql) {
    const dbm = sql.match(/`(data_public_\d+)`\./);
    const db = dbm && dbm[1];
    const noCov = !!noCovFor && db === noCovFor;
    if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
    if (/FROM system\.databases/.test(sql))
      return [{ name: 'system' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
    if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
    if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
    if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
    if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
    if (/`operation_type` AS t/.test(sql)) return BY_OP;
    if (/`o_p` AS k/.test(sql)) return DIM_P;
    if (/`o_prod` AS k/.test(sql)) return DIM_PR;
    if (/`o_cl` AS k/.test(sql)) return DIM_CL;
    if (/`lostrevenue`/.test(sql)) return [noCov ? COV0 : COV];
    if (/GROUP BY k ORDER BY k/.test(sql)) return noCov ? [] : COV_P;
    if (/calcavailablebucketcapacity/.test(sql)) return [];
    if (/netavailbucketcapacity/.test(sql)) return [];
    if (/`quota`/.test(sql)) return [];
    if (/nondelcostrate/.test(sql)) return [];
    if (/unfullfilleddemandqty/.test(sql) && /GROUP BY item/.test(sql)) return [];
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

/** Загружает дашборд, подключает мок CH, грузит две версии и открывает вкладку сравнения. */
async function openVS(noCovFor) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
  const route = makeRoute(noCovFor);
  w.fetch = async (url, opts) => {
    const sql = String((opts && opts.body) || '');
    return { ok: true, status: 200, text: async () => route(sql).map((r) => JSON.stringify(r)).join('\n') };
  };

  await w.CHX.connect();
  w.CHX.openModal();
  d.querySelector('input[data-db="data_public_1"]').click();
  await settle();
  d.querySelector('input[data-db="data_public_2"]').click();
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => w.CHX.versions.length === 2, 20000, 'версии загружены');

  w.go('vs');
  await waitFor(() => d.querySelector('#vsMat table tbody tr'), 10000, 'матрица отрисована');

  /** Строка матрицы по названию показателя: { label, src, vals:[базовая, сравниваемая] }. */
  const row = (name) => {
    const tr = [...d.querySelectorAll('#vsMat table tbody tr')].find(
      (x) => (x.querySelector('td') || {}).textContent?.trim().startsWith(name));
    if (!tr) throw new Error('нет строки «' + name + '» в матрице');
    const tds = [...tr.querySelectorAll('td')];
    const toNum = (s) => Number(String(s).replace(/\u00a0|\u202f|\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.'));
    return {
      src: (tds[0].querySelector('.tag') || {}).textContent || '',
      /* вторая колонка — база, третья — сравниваемая версия (в ней ещё дельта в скобках) */
      base: toNum(tds[1].textContent),
      other: toNum(tds[2].textContent.split('(')[0]),
    };
  };
  return { dom, window: w, document: d, row, close() { try { dom.window.close(); } catch { /* jsdom */ } } };
}

test('строки спроса в сравнении версий читаются из demand_coverage, а не из marking_demand', async (t) => {
  const ctx = await openVS(null);
  t.after(ctx.close);

  const unlimited = ctx.row('Неограниченный спрос, т');
  const limited = ctx.row('Ограниченный спрос, т');
  const unsat = ctx.row('Неудовлетворённый спрос, т');

  assert.equal(unlimited.base, 1200, 'Неограниченный спрос = покрытый 950 + непокрытый 250');
  assert.equal(limited.base, 950,
    'Ограниченный спрос = fullfilleddemandqty (покрытый), а не demand_volume = 1000 из marking_demand');
  assert.equal(unsat.base, 250,
    'Неудовлетворённый спрос = unfullfilleddemandqty (непокрытый), а не unsatisfied_demand = 100 из marking_demand');

  /* то же самое во второй колонке — значение второй версии, а не только базы */
  assert.equal(limited.other, 950, 'вторая версия считается по тому же источнику');
  assert.equal(unsat.other, 250, 'вторая версия считается по тому же источнику');

  /* тождество, ради которого строки и сводятся к одной таблице */
  assert.equal(limited.base + unsat.base, unlimited.base,
    'Неограниченный = Ограниченный + Неудовлетворённый');

  /* источник подписан прямо в строке */
  assert.equal(unlimited.src, 'demand_coverage');
  assert.equal(limited.src, 'demand_coverage');
  assert.equal(unsat.src, 'demand_coverage');
  assert.equal(ctx.row('План продаж, т').src, 'marking_demand',
    'отгрузка по-прежнему из marking_demand и помечена как таковая');
});

test('план и затраты не затронуты: отгрузка, Service Level и маржа — из marking_demand', async (t) => {
  const ctx = await openVS(null);
  t.after(ctx.close);

  assert.equal(ctx.row('План продаж, т').base, 900, 'results_sale');
  assert.equal(ctx.row('Заказов').base, 2, 'количество заказов из marking_demand');
  /* SL = отгружено / принято в план = 900/1000 = 90%, а не 950/1200 */
  const sl = ctx.document.querySelectorAll('#vsMat table tbody tr');
  const slRow = [...sl].find((x) => x.querySelector('td').textContent.trim().startsWith('Service Level'));
  assert.match(slRow.querySelectorAll('td')[1].textContent, /90,0%/,
    'Service Level остаётся на базе плана marking_demand (900/1000)');
});

test('если demand_coverage у версии недоступен — честный фолбэк на marking_demand с предупреждением', async (t) => {
  /* у базовой версии (data_public_1) покрытия нет: запрос вернул нули */
  const ctx = await openVS('data_public_1');
  t.after(ctx.close);

  const limited = ctx.row('Ограниченный спрос, т');
  const unsat = ctx.row('Неудовлетворённый спрос, т');
  assert.equal(limited.base, 1000, 'без покрытия — demand_volume из marking_demand');
  assert.equal(unsat.base, 100, 'без покрытия — unsatisfied_demand из marking_demand');
  assert.equal(limited.other, 950, 'у версии с покрытием источник прежний — demand_coverage');
  assert.equal(unsat.other, 250, 'у версии с покрытием источник прежний — demand_coverage');

  const subs = [...ctx.document.querySelectorAll('#main .card .sub')].map((x) => x.textContent).join(' ');
  assert.match(subs, /demand_coverage недоступен у версий/,
    'подмена источника названа явно, а не спрятана');
});
