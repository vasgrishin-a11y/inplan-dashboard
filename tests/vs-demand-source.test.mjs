/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: «Сравнение версий» использует те же определения, что вкладки
   «Общий» и «Спрос и покрытие».

   - Неограниченный спрос: Σ demandqty из PostgreSQL independent_demand.
   - Плановая цепочка: demand_volume / results_sale / unsatisfied_demand,
     Service Level = results_sale / demand_volume — marking_demand.
   - «Непокрытый спрос» в матрице = карточка «Не покрыто всего»:
     max(0, Σ demandqty independent_demand − Σ results_sale marking_demand).
   - Сырые покрытый / непокрытый итоги demand_coverage остаются отдельными строками.
   - Заказов всего — точный independent_demand.n, не число строк
     demand_coverage. Статусы и невязка показываются отдельно; недоступное —
     «—», известный ноль — «0».
   - Операционные объёмы по версиям: order_operation_volume из marking_demand;
     логистика = movement + stock.

   Моки намеренно дают разные охваты: marking_demand — 2 заказа, независимый
   вход — n=15, demand_coverage — 100 строк со статусами 30/20/50.
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
/* demand_coverage: покрытый 950 + непокрытый 250 = 1200 — не совпадает с планом marking_demand */
const COV = { demUnc: 1200, ff: 950, uf: 250, inTime: 900, late: 50, lostRev: 120, planRev: 6000, prop: 1200,
  orderRows: 100, fullyUncoveredOrders: 30, partiallyCoveredOrders: 20, fullyCoveredOrders: 50 };
const COV0 = { demUnc: 0, ff: 0, uf: 0, inTime: 0, late: 0, lostRev: 0, planRev: 0, prop: 0 };
const COV_P = [{ k: '2026-09', demUnc: 1200, ff: 950, uf: 250, late: 50 }];
/* independent_demand в PostgreSQL: входной спрос 1300 — не совпадает ни с покрытием, ни с планом */
const UNC = { demUnc: 1300, n: 15 };
const UNC_P = [{ k: '2026-09', demUnc: 1300 }];
const BY_OP = {
  data_public_1: [
    { t: 'production', c: 500, v: 48, n: 2 },
    { t: 'movement', c: 300, v: 40, n: 2 },
    { t: 'stock', c: 120, v: 8, n: 1 },
    { t: 'procurement', c: 200, v: 13, n: 1 },
  ],
  data_public_2: [
    { t: 'production', c: 700, v: 71, n: 3 },
    { t: 'movement', c: 250, v: 23, n: 2 },
    { t: 'stock', c: 140, v: 7, n: 2 },
    { t: 'procurement', c: 310, v: 31, n: 2 },
  ],
};
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

/** Маршрутизация ClickHouse SQL → строки ответа. noCovFor — схема без demand_coverage.
    independent_demand здесь быть не может — она в PostgreSQL. */
function makeRoute(noCovFor, chOptions = {}) {
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
    if (/`operation_type` AS t/.test(sql)) return BY_OP[db] || [];
    if (/`o_p` AS k/.test(sql)) return DIM_P;
    if (/`o_prod` AS k/.test(sql)) return DIM_PR;
    if (/`o_cl` AS k/.test(sql)) return DIM_CL;
    if (/`independent_demand`/.test(sql))
      throw new Error('в ClickHouse таблицы independent_demand нет — дашборд обязан идти в PostgreSQL');
    if (/`lostrevenue`/.test(sql)) {
      if (noCov) throw new Error('таблица demand_coverage недоступна');
      const cov={...COV};
      if(chOptions.omitOrderCounts)
        for(const key of ['orderRows','fullyUncoveredOrders','partiallyCoveredOrders','fullyCoveredOrders']) delete cov[key];
      return [cov];
    }
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

/** Ответ backend-прокси для PG-схемы: одно и то же входное значение на схему. */
function pgUncPayload(schema, options = {}) {
  const counts = { ...UNC };
  if (options.omitIndependentCount) delete counts.n;
  else if (Object.hasOwn(options, 'independentCount')) counts.n = options.independentCount;
  return { ok: true, schema, table: 'independent_demand', gran: 4,
           cols: { item: 'item', qty: 'demandqty', periodid: 'periodid', dmdstream: 'dmdstream', ptype: 'periodtype', dtype: 'demandtype', loc: 'loc', date: 'date' },
           keyCols: ['item','demandqty','periodid','dmdstream','periodtype','demandtype','loc','date'], distinct: true,
           ...counts, periods: UNC_P };
}

/** Загружает дашборд, подключает моки CH и PG, грузит две версии, открывает вкладку сравнения.
    pgMissingFor — CH-база (data_public_N), для которой в PostgreSQL таблицы нет
    (схемы такой в списке backend нет, /api/pg/unc отвечает 400);
    'noPG' — PostgreSQL вообще не настроен (креды не заданы, backend не дёргается). */
async function openVS(noCovFor, pgMissingFor, pgOptions = {}, chOptions = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
  const route = makeRoute(noCovFor, chOptions);
  const pgMissing = (pgMissingFor && pgMissingFor !== 'noPG')
    ? String(pgMissingFor).replace(/^data_/i, '') : null;
  w.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/pg/')) {
      const body = JSON.parse(String((opts && opts.body) || '{}'));
      if (u.includes('/api/pg/schemas')) {
        const schemas = ['public_1', 'public_2'].filter((s) => s !== pgMissing).map((s) => ({ schema: s, n: 15 }));
        return { ok: true, status: 200, json: async () => ({ ok: true, table: 'independent_demand', schemas }) };
      }
      if (u.includes('/api/pg/unc')) {
        if (body.schema === pgMissing)
          return { ok: false, status: 400, json: async () => ({ error: `Схема «${body.schema}»: таблица «independent_demand» не найдена или нет доступа.` }) };
        return { ok: true, status: 200, json: async () => pgUncPayload(body.schema, pgOptions) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    }
    const sql = String((opts && opts.body) || '');
    let rows;
    try { rows = route(sql); }
    catch (e) { return { ok: false, status: 500, text: async () => e.message }; }
    return { ok: true, status: 200, text: async () => rows.map((r) => JSON.stringify(r)).join('\n') };
  };
  if (pgMissingFor !== 'noPG') {
    w.PGX.cfg.user = 'reader';
    w.PGX.cfg.password = 'secret';
  }

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
    const toNum = (s) => {
      const raw=String(s).replace(/\u00a0|\u202f/g,' ').trim();
      if(!raw||raw==='—'||/нет данных/i.test(raw)) return null;
      const parsed=raw.replace(/\s/g,'').replace(/[^\d.,-]/g,'').replace(',', '.');
      if(!/\d/.test(parsed)) return null;
      const n=Number(parsed);
      return Number.isFinite(n)?n:null;
    };
    return {
      src: (tds[0].querySelector('.tag') || {}).textContent || '',
      /* вторая колонка — база, третья — сравниваемая версия (в ней ещё дельта в скобках) */
      base: toNum(tds[1].textContent),
      other: toNum(tds[2].textContent.split('(')[0]),
    };
  };
  /** Названия строк матрицы в порядке отрисовки, без тега источника. */
  const labels = () => [...d.querySelectorAll('#vsMat table tbody tr')].map((tr) => {
    const cell = tr.querySelector('td').cloneNode(true);
    cell.querySelectorAll('.tag').forEach((tag) => tag.remove());
    return cell.textContent.trim();
  });
  return {
    dom, window: w, document: d, row, labels,
    hasRow: (name) => labels().includes(name),
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}

test('источники спроса: вход и план из своих таблиц, coverage показан отдельно', async (t) => {
  const ctx = await openVS(null, null);
  t.after(ctx.close);

  const unlimited = ctx.row('Неограниченный спрос, т');
  const plan = ctx.row('Ограниченный спрос (план), т');
  const sales = ctx.row('План продаж, т');
  const coveredTons = ctx.row('Покрытый спрос, т');
  const uncoveredTons = ctx.row('Непокрытый спрос, т');
  const coverageUncoveredTons = ctx.row('Непокрытый спрос по demand_coverage, т');

  assert.equal(unlimited.base, 1300, 'неограниченный спрос = Σ demandqty из independent_demand');
  assert.equal(plan.base, 1000, 'ограниченный спрос (план) = Σ demand_volume из marking_demand');
  assert.equal(sales.base, 900, 'план продаж = Σ results_sale из marking_demand');
  assert.equal(ctx.hasRow('Дефицит плана, т'), false, 'строки «Дефицит плана» в матрице нет');
  assert.equal(coveredTons.base, 950, 'покрытый спрос отдельно из demand_coverage');
  assert.equal(uncoveredTons.base, 400, 'непокрытый спрос в сравнении = 1300 independent_demand − 900 results_sale');
  assert.equal(coverageUncoveredTons.base, 250, 'сырой unfullfilleddemandqty доступен отдельно из demand_coverage');
  assert.equal(sales.base + uncoveredTons.base, unlimited.base,
    'сумма плана продаж и непокрытого спроса совпадает с карточкой «Не покрыто всего»');

  const orders = ctx.row('Заказов (неогр. спрос)');
  assert.equal(orders.base, 15, 'total заказов = independent_demand.n, не 100 строк coverage');
  assert.equal(orders.other, 15, 'во второй версии используется её точный независимый n');
  assert.equal(orders.src, 'independent_demand', 'источник total подписан');
  assert.equal(ctx.row('Заказов всего покрыто').base, 70, 'покрытые = полностью + частично по status source');
  assert.equal(ctx.row('Заказов полностью покрыто').base, 50);
  assert.equal(ctx.row('Заказов частично покрыто').base, 20);
  assert.equal(ctx.row('Заказов 100% не покрыто').base, 30);
  assert.equal(ctx.row('Невязка заказов').base, -85,
    'сравнение показывает независимый total 15 против 100 классифицированных строк, а не подменяет его');
  assert.match(ctx.row('Заказов всего покрыто').src, /demand_coverage/,
    'fallback-статусы имеют собственную подпись источника');

  for (const [metric, source] of [
    [unlimited, 'independent_demand'], [plan, 'marking_demand'], [sales, 'marking_demand'],
    [coveredTons, 'demand_coverage'],
    [uncoveredTons, 'independent_demand − marking_demand'],
    [coverageUncoveredTons, 'demand_coverage'],
  ]) assert.equal(metric.src, source, `источник ${source} подписан`);

  const matrixCard = ctx.document.querySelector('#vsMat')?.closest('.card');
  assert.ok(matrixCard, 'карточка матрицы показателей отображается');
  assert.equal(matrixCard.querySelectorAll('.sub').length, 0,
    'описательные абзацы под заголовком матрицы убраны');
  assert.notEqual(coveredTons.base + coverageUncoveredTons.base, unlimited.base,
    'сырые суммы demand_coverage остаются отдельным срезом входа');
});


test('независимый счётчик: точный ноль виден, отсутствующий total не заменяется строками coverage', async (t) => {
  const zero = await openVS(null, null, { independentCount: 0 });
  t.after(zero.close);
  assert.equal(zero.row('Заказов (неогр. спрос)').base, 0, 'точный независимый ноль сохранён');
  assert.equal(zero.row('Невязка заказов').base, 0, 'пустое разбиение даёт точную нулевую невязку');

  const missing = await openVS(null, null, { omitIndependentCount: true });
  t.after(missing.close);
  assert.equal(missing.row('Заказов (неогр. спрос)').base, null,
    'когда PG не вернул n, число строк demand_coverage не подставляется');
  assert.equal(missing.row('Невязка заказов').base, null,
    'без total невязка недоступна, а не равна нулю');
  assert.equal(missing.row('Заказов всего покрыто').base, 70,
    'при этом независимо доступная разбивка coverage сохраняется');

  const invalid = await openVS(null, null, { independentCount: 'not-a-number' });
  t.after(invalid.close);
  assert.equal(invalid.row('Заказов (неогр. спрос)').base, null,
    'некорректный ответ n не считается точным нулём');

  const noBreakdown = await openVS(null, null, {}, { omitOrderCounts: true });
  t.after(noBreakdown.close);
  assert.equal(noBreakdown.row('Заказов (неогр. спрос)').base, 15,
    'точный total остаётся доступен');
  assert.equal(noBreakdown.row('Заказов полностью покрыто').base, null,
    'без разбивки статусов нельзя подставить ноль');
  assert.equal(noBreakdown.row('Невязка заказов').base, null,
    'невязка без второй стороны недоступна');
});

test('план и затраты не затронуты: отгрузка, Service Level и маржа — из marking_demand', async (t) => {
  const ctx = await openVS(null, null);
  t.after(ctx.close);

  assert.equal(ctx.row('План продаж, т').base, 900, 'results_sale');
  assert.equal(ctx.hasRow('Заказов в marking_demand'), false, 'строки «Заказов в marking_demand» в матрице нет');
  /* SL = отгружено / принято в план = 900/1000 = 90%, а не 950/1200 и не 900/1300 */
  const sl = ctx.document.querySelectorAll('#vsMat table tbody tr');
  const slRow = [...sl].find((x) => x.querySelector('td').textContent.trim().startsWith('Service Level'));
  assert.match(slRow.querySelectorAll('td')[1].textContent, /90,0%/,
    'Service Level остаётся на базе плана marking_demand (900/1000)');
});

test('объёмные планы считаются отдельно по версиям: логистика = перемещения + хранение', async (t) => {
  const ctx = await openVS(null, null);
  t.after(ctx.close);

  const versions = ctx.window.CHX.versions;
  const base = versions.find((v) => v.isBase);
  const other = versions.find((v) => !v.isBase);
  assert.ok(base && other, 'сравнение содержит базовую и вторую версии');

  const expectations = {
    'План производства, т': {
      src: 'marking_demand · production', byDb: { data_public_1: 48, data_public_2: 71 },
    },
    'План перемещений, т': {
      src: 'marking_demand · movement', byDb: { data_public_1: 40, data_public_2: 23 },
    },
    'План логистики, т': {
      src: 'marking_demand · movement + stock', byDb: { data_public_1: 48, data_public_2: 30 },
    },
    'План закупки сырья, т': {
      src: 'marking_demand · procurement', byDb: { data_public_1: 13, data_public_2: 31 },
    },
  };

  for (const [label, expected] of Object.entries(expectations)) {
    const actual = ctx.row(label);
    assert.equal(actual.src, expected.src, `${label}: тегом указан тип операции`);
    assert.equal(actual.base, expected.byDb[base.id], `${label}: значение своей базовой версии`);
    assert.equal(actual.other, expected.byDb[other.id], `${label}: значение своей сравниваемой версии`);
  }

});

test('если demand_coverage у версии недоступна — total gap считается по independent_demand и плану, сырые показатели недоступны', async (t) => {
  /* у базовой версии (data_public_1) покрытия нет: запрос вернул нули.
     PostgreSQL при этом доступна — неограниченный спрос остаётся 1300. */
  const ctx = await openVS('data_public_1', null);
  t.after(ctx.close);

  const unlimited = ctx.row('Неограниченный спрос, т');
  const plan = ctx.row('Ограниченный спрос (план), т');
  const covered = ctx.row('Покрытый спрос, т');
  const uncovered = ctx.row('Непокрытый спрос, т');
  assert.equal(unlimited.base, 1300, 'неограниченный спрос по-прежнему из PostgreSQL');
  assert.equal(plan.base, 1000, 'плановый спрос берётся из marking_demand');
  assert.equal(covered.base, null, 'недоступный demand_coverage не маскируется нулём');
  assert.equal(uncovered.base, 400, 'итог непокрытого спроса доступен по independent_demand − marking_demand');
  assert.equal(ctx.row('Непокрытый спрос по demand_coverage, т').base, null,
    'сырой итог demand_coverage остаётся неизвестным, если таблица недоступна');
  assert.equal(covered.other, 950, 'у второй версии с покрытием показатель доступен');
  assert.equal(uncovered.other, 400, 'у второй версии total gap = independent_demand − продажи');
  assert.equal(unlimited.src, 'independent_demand', 'источник неограниченного спроса не менялся');

});

test('если нет independent_demand и demand_coverage — total gap возвращается к дефициту плана', async (t) => {
  const ctx = await openVS('data_public_1', 'noPG');
  t.after(ctx.close);

  assert.equal(ctx.row('Непокрытый спрос, т').base, 100,
    'когда входная и coverage-базы недоступны, gap равен Σ unsatisfied_demand');
  assert.equal(ctx.row('Непокрытый спрос по demand_coverage, т').base, null,
    'сырой unfullfilleddemandqty без demand_coverage недоступен');
  assert.equal(ctx.hasRow('Неудовлетворённый спрос, т'), false,
    'отдельную строку дефицита плана не возвращаем в матрицу');
});

test('если в PostgreSQL таблицы у версии нет — фолбэк неограниченного спроса на покрытый + непокрытый с пометкой', async (t) => {
  /* у базовой версии (data_public_1 ↔ public_1) нет independent_demand в PG: backend вернул 400 */
  const ctx = await openVS(null, 'data_public_1');
  t.after(ctx.close);

  const unlimited = ctx.row('Неограниченный спрос, т');
  assert.equal(unlimited.base, 1200, 'без PG-таблицы — покрытый 950 + непокрытый 250 из demand_coverage');
  assert.equal(unlimited.other, 1300, 'у версии с PG-таблицей — Σ demandqty');
  const gap = ctx.row('Непокрытый спрос, т');
  assert.equal(gap.base, 300, 'фолбэк gap = (950 + 250) из demand_coverage − 900 продаж');
  assert.equal(gap.other, 400, 'основной gap = 1300 из independent_demand − 900 продаж');
  assert.match(gap.src, /demand_coverage.*marking_demand/);
  assert.match(gap.src, /independent_demand.*marking_demand/);
  const orderTotal = ctx.row('Заказов (неогр. спрос)');
  assert.equal(orderTotal.base, null, 'без точного independent_demand.n общее число заказов недоступно');
  assert.equal(orderTotal.other, 15, 'у версии с PG-таблицей показан независимый n');
  assert.equal(ctx.row('Невязка заказов').base, null, 'нет total — нет и невязки');
  assert.match(unlimited.src, /demand_coverage/, 'тег строки показывает фолбэк-базу');
  assert.match(unlimited.src, /independent_demand/, 'тег строки показывает и основную базу');

  const notes = ctx.window.CHX.versions.flatMap((v) => (v.agg && v.agg.notes) || []).join(' ');
  assert.match(notes, /PG: Схема «public_1»/, 'в заметках загрузки — конкретная ошибка PostgreSQL');
});

test('матрица: строки в заданном порядке — заказы сразу за «План продаж, т»; дефицит и «Заказов в marking_demand» убраны', async (t) => {
  const ctx = await openVS(null, null);
  t.after(ctx.close);

  const names = ctx.labels();
  assert.equal(ctx.hasRow('Дефицит плана, т'), false, 'строки «Дефицит плана, т» нет');
  assert.equal(ctx.hasRow('Заказов в marking_demand'), false, 'строки «Заказов в marking_demand» нет');

  /* блок заказов — сразу за «План продаж, т», от общего к частному;
     «100% не покрыто» и «Невязка» идут следом, не отрывая статусы от группы */
  const at = names.indexOf('План продаж, т');
  assert.ok(at >= 0, 'строка «План продаж, т» есть');
  assert.deepEqual(names.slice(at, at + 7), [
    'План продаж, т',
    'Заказов (неогр. спрос)',
    'Заказов всего покрыто',
    'Заказов полностью покрыто',
    'Заказов частично покрыто',
    'Заказов 100% не покрыто',
    'Невязка заказов (должна быть 0)',
  ], 'после «План продаж, т» — заказы от общего к частному');

  for (const name of ['Покрытый спрос, т', 'Непокрытый спрос, т',
    'Непокрытый спрос по demand_coverage, т', 'Service Level', 'Отгружено с опозданием, т', 'Плановый ФРВ, ч'])
    assert.ok(names.includes(name), `строка «${name}» на месте`);

  /* по умолчанию таблица не сортируется по алфавиту (раньше сортировалась) */
  const byName = (a, b) => a.localeCompare(b, 'ru', { numeric: true });
  assert.notDeepEqual(names, names.slice().sort(byName), 'порядок по умолчанию — не алфавитный');

  /* клик по заголовку «Показатель» сортирует, как прежде */
  ctx.document.querySelector('#vsMat .dt-t[data-sk="n"]').click();
  assert.deepEqual(ctx.labels(), names.slice().sort((a, b) => byName(b, a)),
    'клик по «Показатель» сортирует по убыванию');
});
