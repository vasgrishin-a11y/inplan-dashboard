/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: источник «Неограниченный спрос = Σ demandqty из independent_demand»
   — POSTGRESQL через backend-прокси (server.js), а не ClickHouse.

   Уточнение владельца (2026-10): таблица independent_demand физически лежит
   в PostgreSQL (та же база, к которой подключён дашборд opti). ClickHouse-версии
   сопоставляются PG-схемам по имени: data_public_2 ↔ public_2.

   Проверяется на моке без таблицы в ClickHouse вообще: покрытие в CH есть
   (1200), а входной спрос приходит только из PG (1500 / 1700 — разный у схем).
   Дашборд обязан везде показать значения из PG, пометить источник
   «PostgreSQL · схема» и не смешивать источники версий. Второй сценарий —
   PG недоступен: честный фолбэк на demand_coverage с заметкой в статусе.

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
const HTML = path.join(ROOT, 'index.html');
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
const ORDERS_TOT = { orders: 2, rev: 5380, cost: 3170, mar: 2210, dem: 1000, sal: 900, unm: 100, lm: 90, full: 1 };
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
/* Покрытие в ClickHouse — исход прогона: 1200 = 950 + 250. */
const COV = { demUnc: 1200, ff: 950, uf: 250, inTime: 850, late: 50, lostRev: 120, planRev: 6000, prop: 1200 };
const COV_P = [{ k: '2026-09', demUnc: 1200, ff: 950, uf: 250, late: 50 }];

/* Вход модели в PostgreSQL: у public_1 — 1500 (с периодом, которого нет в покрытии!), у public_2 — 1700. */
const PG = {
  public_1: { demUnc: 1500, n: 15, periods: [{ k: '2026-09', demUnc: 900 }, { k: '2026-10', demUnc: 600 }] },
  public_2: { demUnc: 1700, n: 17, periods: [{ k: '2026-09', demUnc: 1700 }] },
};
const PG_SCHEMAS = [{ schema: 'public_1', n: 15 }, { schema: 'public_2', n: 17 }];

function routeCH(sql) {
  const dbm = sql.match(/`(data_public_\d+)`\./);
  const db = dbm && dbm[1];
  if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
  if (/FROM system\.databases/.test(sql))
    return [{ name: 'system' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
  /* independent_demand в ClickHouse ОТСУТСТВУЕТ — в system.columns её колонок нет */
  if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
  if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
  if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
  if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
  if (/`operation_type` AS t/.test(sql)) return BY_OP;
  if (/`o_p` AS k/.test(sql)) return DIM_P;
  if (/`o_prod` AS k/.test(sql)) return DIM_PR;
  if (/`o_cl` AS k/.test(sql)) return DIM_CL;
  if (/`independent_demand`/.test(sql)) throw new Error('в ClickHouse таблицы быть не должно — дашборд обязан идти в PG');
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
const toNum = (s) => Number(String(s).replace(/ | |\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.'));

async function boot(t) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  t.after(() => { try { dom.window.close(); } catch { /* jsdom */ } });
  return { w: dom.window, d: dom.window.document };
}

/* pgMode 'ok' — backend отвечает агрегатами; 'lost' — backend жив, но таблицы
   independent_demand нет ни в одной схеме (ответ 400 «не найдена»);
   'zero' — demandqty равен 0, но PG-источник считается прочитанным. */
async function loadWithPG(t, pgMode) {
  const { w, d } = await boot(t);
  w.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/pg/')) {
      const body = JSON.parse(String((opts && opts.body) || '{}'));
      if (u.includes('/api/pg/schemas')) {
        if (pgMode === 'lost') return { ok: true, status: 200, json: async () => ({ ok: true, table: 'independent_demand', schemas: [] }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, table: 'independent_demand', schemas: PG_SCHEMAS }) };
      }
      if (u.includes('/api/pg/unc')) {
        const rec = (pgMode === 'ok' || pgMode === 'zero') && PG[body.schema];
        if (!rec) {
          return { ok: false, status: 400, json: async () => ({ error: `Схема «${body.schema}»: таблица «independent_demand» не найдена или нет доступа.` }) };
        }
        const payload = pgMode === 'zero'
          ? { ...rec, demUnc: 0 }
          : rec;
        return { ok: true, status: 200, json: async () => ({ ok: true, schema: body.schema, table: 'independent_demand', gran: body.gran, cols: { item: 'item', qty: 'demandqty', periodid: 'periodid', dmdstream: 'dmdstream', ptype: 'periodtype', dtype: 'demandtype', loc: 'loc', date: 'date' }, keyCols: ['item','demandqty','periodid','dmdstream','periodtype','demandtype','loc','date'], distinct: true, ...payload }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    }
    const sql = String((opts && opts.body) || '');
    let rows;
    try { rows = routeCH(sql); }
    catch (e) { return { ok: false, status: 500, text: async () => e.message } };
    return { ok: true, status: 200, text: async () => rows.map((r) => JSON.stringify(r)).join('\n') };
  };
  /* PG-подключение задано — как будто пользователь ввёл логин/пароль в модалке */
  w.PGX.cfg.user = 'reader';
  w.PGX.cfg.password = 'secret';

  await w.CHX.connect();
  w.CHX.openModal();
  d.querySelector('input[data-db="data_public_1"]').click();
  await settle();
  d.querySelector('input[data-db="data_public_2"]').click();
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => w.CHX.versions.length === 2, 20000, 'версии загружены');

  const kpi = (title) => [...d.querySelectorAll('#main .kpi')]
    .find((k) => ((k.querySelector('.t') || {}).textContent || '').trim() === title);
  const goTab = async (id) => { w.go(id); await settle(250); };
  return { w, d, kpi, goTab };
}

test('неограниченный спрос приходит из PostgreSQL через backend-прокси (data_public_N ↔ public_N)', async (t) => {
  const ctx = await loadWithPG(t, 'ok');
  const { w, d } = ctx;

  /* источники версий зафиксированы: ни одна не ушла в CH или demand_coverage */
  const v1 = w.CHX.versions.find((v) => v.id === 'data_public_1');
  const v2 = w.CHX.versions.find((v) => v.id === 'data_public_2');
  assert.equal(v1.agg.totals.uncSrc, 'independentdemand');
  assert.equal(v1.agg.totals.uncDetail, 'PostgreSQL · public_1', 'схема = база без префикса data_');
  assert.equal(v2.agg.totals.uncDetail, 'PostgreSQL · public_2');
  assert.equal(v1.agg.totals.cov.demUnc, 1500, 'итог покрытия-карточек — значение PG, а не 1200 из demand_coverage');
  assert.equal(v2.agg.totals.cov.demUnc, 1700, 'у второй версии — СВОЁ значение из её PG-схемы');
  assert.equal(v1.agg.totals.cov.demUncCov, 1200, 'исход прогона сохранён отдельно для DQ-сверки');

  /* заметок о фолбэке нет — источник основной */
  const notes = w.CHX.versions.flatMap((v) => v.agg.notes || []).join(' ');
  assert.ok(!/independent_demand недоступна/.test(notes), 'ошибок источника нет: ' + notes);

  /* помесячный разрез: PG-периоды слились с покрытием; период, которого нет
     в покрытии, дописан с нулями составляющих */
  const dims = v1.agg.dims.coverage;
  /* данные живут в jsdom-реалме (другие Array.prototype) — перегоняем через JSON,
     иначе deepStrictEqual падает на прототипах при визуально верных значениях */
  const dimsPlain = JSON.parse(JSON.stringify(dims.map((r) => [r.k, r.demUnc, r.ff, r.uf])));
  assert.deepEqual(dimsPlain, [
    ['2026-09', 900, 950, 250],
    ['2026-10', 600, 0, 0],
  ], 'разрез идёт по месяцам входного спроса (PostgreSQL)');

  /* «Спрос и покрытие»: карточка и производные — от PG-входа */
  await ctx.goTab('dm');
  assert.equal(toNum(ctx.kpi('Неограниченный спрос').querySelector('.v').textContent), 1500);
  assert.equal(toNum(ctx.kpi('Не принято в план').querySelector('.v').textContent), 500, '1500 − 1000 плана');
  assert.equal(toNum(ctx.kpi('Не покрыто всего').querySelector('.v').textContent), 600, '1500 − 900 отгрузки');

  /* «Сравнение версий»: у версий разные PG-значения, источник подписан */
  await ctx.goTab('vs');
  const trs = [...d.querySelectorAll('#vsMat table tbody tr')];
  const uncTr = trs.find((x) => (x.querySelector('td') || {}).textContent?.trim().startsWith('Неограниченный спрос'));
  assert.ok(uncTr, 'строка неограниченного спроса есть');
  assert.match(uncTr.querySelector('td').innerHTML, /independent_demand/, 'тег источника');
  /* ячейки версий идут с дельтой к базе «1 700 (+200)» — отрезаем её */
  const cells = [...uncTr.querySelectorAll('td')].slice(1)
    .map((td) => toNum(td.textContent.split('(')[0]));
  assert.deepEqual(cells.slice(0, 2), [1500, 1700], 'обе версии читаются из своих PG-схем');
  assert.match(d.getElementById('main').textContent, /PostgreSQL · public_1/,
    'в сравнении версий подписана PG-схема каждой версии');

  /* DQ: сверка «определение» работает и на PG-источнике */
  await ctx.goTab('data');
  const checks = [...d.querySelectorAll('#q3 .dq')].map((x) => x.textContent.replace(/\s+/g, ' '));
  const def = checks.find((x) => /Неограниченный спрос: определение/.test(x));
  assert.ok(def);
  assert.match(def, /1 500/, 'вход из PG назван числом');
  assert.match(def, /1 200/, 'исход прогона из demand_coverage назван числом');

  /* сопоставление CH-базы → PG-схемы без учёта регистра */
  w.PGX.state.schemas = [{ schema: 'Public_2', n: 1 }];
  assert.equal(w.PGX.pgSchemaFor('data_PUBLIC_2'), 'Public_2');
  assert.equal(w.PGX.pgSchemaFor('public_9'), 'public_9', 'без попадания в справочник — снятое имя как есть');
});

test('нулевой demandqty в independent_demand не маскируется demand_coverage', async (t) => {
  const ctx = await loadWithPG(t, 'zero');
  const v1 = ctx.w.CHX.versions.find((v) => v.id === 'data_public_1');

  assert.equal(v1.agg.totals.uncSrc, 'independentdemand');
  assert.equal(v1.agg.totals.uncDetail, 'PostgreSQL · public_1');
  assert.equal(v1.agg.totals.cov.demUnc, 0, 'нулевой вход модели остаётся нулём');
  assert.equal(v1.agg.totals.cov.demUncCov, 1200, 'покрытый+непокрытый сохранены только для сверки');
  const notes = (v1.agg.notes || []).join(' ');
  assert.match(notes, /Σ demandqty = 0/);
  assert.match(notes, /фолбэк demand_coverage не применён/);
  assert.ok(!/independent_demand недоступна/.test(notes), 'источник прочитан, это не ошибка доступности: ' + notes);

  await ctx.goTab('dm');
  assert.equal(toNum(ctx.kpi('Неограниченный спрос').querySelector('.v').textContent), 0);
});

test('PG недоступен для схем — честный фолбэк на покрытый + непокрытый с причиной в статусе', async (t) => {
  const ctx = await loadWithPG(t, 'lost');
  const { w, d } = ctx;

  const v1 = w.CHX.versions.find((v) => v.id === 'data_public_1');
  assert.equal(v1.agg.totals.uncSrc, 'demand_coverage', 'фолбэк помечен');
  assert.equal(v1.agg.totals.cov.demUnc, 1200, 'показан покрытый + непокрытый');

  const notes = w.CHX.versions.flatMap((v) => v.agg.notes || []).join(' ');
  assert.match(notes, /independent_demand недоступна/, 'причина фолбэка зафиксирована');
  assert.match(notes, /PG: /, 'в заметке — ошибка PostgreSQL-пути');
  assert.ok(!/CH: /.test(notes), 'в ClickHouse таблицу не ищем вовсе: ' + notes);
  assert.match(notes, /покрытый \+ непокрытый из demand_coverage/, 'подмена источника объяснена');

  await ctx.goTab('dm');
  assert.equal(toNum(ctx.kpi('Неограниченный спрос').querySelector('.v').textContent), 1200,
    'карточка — старое поведение');
});

test('без заданного PG загрузчик не дёргает backend и не ищет таблицу в ClickHouse', async (t) => {
  const { w, d } = await boot(t);
  /* PGX без логина — выключен: вообще не должен ходить в backend */
  assert.equal(w.PGX.enabled(), false);
  let pgCalls = 0;
  w.fetch = async (url, opts) => {
    if (String(url).includes('/api/pg/')) { pgCalls++; return { ok: false, status: 404, json: async () => ({}) }; }
    const sql = String((opts && opts.body) || '');
    const rows = routeCH(sql);
    return { ok: true, status: 200, text: async () => rows.map((r) => JSON.stringify(r)).join('\n') };
  };
  await w.CHX.connect();
  d.querySelector('input[data-db="data_public_1"]')?.click || null;
  /* загружаемся напрямую, без модалки */
  w.CHX.cfg.schemas = ['data_public_1'];
  w.CHX.cfg.base = 'data_public_1';
  await w.CHX.loadAll();
  assert.equal(pgCalls, 0, 'ни одного обращения к backend без учётных данных');
  const v1 = w.CHX.versions[0];
  assert.equal(v1.agg.totals.uncSrc, 'demand_coverage');
  assert.match((v1.agg.notes || []).join(' '), /independent_demand недоступна \(нет подключения к PostgreSQL\)/,
    'причина — не задан креды PG, и только они');
});
