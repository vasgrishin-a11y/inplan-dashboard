/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: гранулярность (periodtype) версий при выборе версии в БД.

   Сообщённый дефект: «при выборе версии в БД некорректно отображает/подтягивает
   гранулярность версии». Разбирается на четыре части:

   1. Панель подключения: список гранулярностей пробовался по ПЕРВОЙ схеме в
      алфавитном порядке (data_public_*), а не по выбранной версии. После
      выбора версии селект «Гранулярность» показывал чужой набор periodtype
      с чужими счётчиками строк, а «тихая» смена базовой версии (первая
      галочка / снятие галочки с текущей базы) не переспрашивала их вовсе.
   2. Загрузка: ВСЕ версии агрегировались одной общей гранулярностью. Для
      версии, у которой такого periodtype нет, фильтр `periodtype = N` не
      попадает ни в одну строку — покрытие/мощности/штрафы версии
      прилетали нулями, без единой пометки.
   3. Устаревшая база из автосессии (схема, которой больше нет в кластере)
      использовалась как объект пробы гранулярности.
   4. «Сравнение версий» показывало одну гранулярность для всех версий, даже
      когда версии агрегированы на своих.

   ClickHouse эмулируется перехватом fetch: у каждой «версии» (схемы
   data_public_N) — свой набор periodtype, а запрос с `periodtype = N`,
   которого у версии нет, возвращает пустой набор — как в настоящем CH.

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
const MIME = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
};

/** Локальные файлы страницы; всё внешнее глушим (как в nav-pos-тесте). */
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

/* ── Кластер: у каждой версии (схемы) свой набор periodtype ──
   periodtype: 3 — неделя, 4 — месяц. */
const DBS = {
  data_public_1: { grans: [[4, 100]], n: 1200, ts: '2026-09-10 08:00:00' },              // месяц
  data_public_2: { grans: [[3, 50]], n: 900, ts: '2026-09-11 09:00:00' },                // неделя
  data_public_3: { grans: [[3, 20], [4, 10]], n: 700, ts: '2026-09-12 10:00:00' },       // и то, и другое
};

const COLS = [
  'order_id','order_operation_id','resource','demand_period','demand_product',
  'demand_client','demand_location','demand_volume','results_sale','unsatisfied_demand',
  'revenue','cost_of_demand','total_margin','margin_per_unit','price','cost_per_unit_order',
  'demand_demandtype','dmdstream','demand_demandtypepriority','margin_per_hour','operation_type',
  'location','product','loc_from','loc_to','transport_type','order_operation_volume',
  'cost_rate_of_operation','supplier','bom_num',
];

/* Ответы агрегатов (одинаковы для всех версий — важно, что ОНИ ДОСТИЖИМЫ,
   если гранулярность версии подходит, и ПУСТЫ, если нет). */
const ORDERS_TOT = { orders: 2, rev: 5380, cost: 3170, mar: 2210, dem: 50, sal: 48, unm: 2, lm: 90, full: 1 };
const BY_OP = [
  { t: 'production', c: 500, v: 48, n: 2 },
  { t: 'movement', c: 300, v: 40, n: 2 },
];
const DIM_P = [
  { k: '1', mar: 760, sal: 19, unm: 1, rev: 1900 },
  { k: '2', mar: 1450, sal: 29, unm: 1, rev: 3480 },
];
const DIM_PR = [{ k: 'P1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const DIM_CL = [{ k: 'C1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const COV = { demUnc: 60, ff: 58, uf: 2, inTime: 56, late: 2, lostRev: 120, planRev: 6000, prop: 60 };
const COV0 = { demUnc: 0, ff: 0, uf: 0, inTime: 0, late: 0, lostRev: 0, planRev: 0, prop: 0 };
const COV_P = [{ k: '2026-09', demUnc: 60, ff: 58, uf: 2, late: 2 }];
const CAP = [{
  rs: 'R1', pl: 'L1', resTypeDescr: 'Линия', resType: 10, grp: 'G1', periodKey: '2026-09',
  norm: 400, avail: 380, load: 300, useIp: 200, useP: 50, useS: 30, useT: 20, maint: 30, oee: 0.85,
}];
const CAP_PLAN = [{ rs: 'R1', pl: 'L1', periodKey: '2026-09', norm: 400, availNet: 380, avail: 380, expansion: 0, maint: 20 }];
const PEN = [{ item: 'P1', loc: 'L1', dt: 1, stream: 'S1', nonDel: 5, lateRate: 2, latePeriods: 1 }];
const TI = [{ item: 'P1', loc: 'L1', dt: 1, stream: 'S1', nonDel: 4, lateRate: 1, latePeriods: 1, priority: 2, quota: 0 }];
const UF = [{ item: 'P1', loc: 'L1', dt: 1, stream: 'S1', uf: 1, late: 0 }];
const ORDERS = [
  { id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1', dem: 20, sal: 19, unm: 1, price: 100, cpt: 60, mpt: 40, rev: 1900, cost: 1140, mar: 760, prio: 1, mph: 0 },
  { id: 102, p: '2', loc: 'L1', prod: 'P2', cl: 'C2', dtype: 1, stream: 'S1', dem: 30, sal: 29, unm: 1, price: 120, cpt: 70, mpt: 50, rev: 3480, cost: 2030, mar: 1450, prio: 2, mph: 0 },
];
const OPS = [
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 19, r: 26, vd: '', rt: '1.1', oid: '101.1', rc: 0 },
  { o: 101, p: '1', type: 'movement', pl: 'L1', pr: 'P1', rs: '', fr: 'L1', to: 'L2', tm: 'truck', v: 19, r: 3, vd: 'V1', rt: '', oid: '101.2', rc: 0 },
  { o: 102, p: '2', type: 'production', pl: 'L1', pr: 'P2', rs: 'R1', fr: '', to: '', tm: '', v: 29, r: 24, vd: '', rt: '2.1', oid: '102.1', rc: 0 },
];

const hasGran = (db, g) => !!DBS[db] && DBS[db].grans.some(([t]) => t === Number(g));

/** Маршрутизация SQL → строки ответа JSONEachRow. undefined = не маршрутизировано. */
function route(sql) {
  const dbm = sql.match(/`(data_public_\d+)`\./);
  const db = dbm && dbm[1];
  const ptm = sql.match(/`periodtype`\s*=\s*(\d+)/);
  const pt = ptm && Number(ptm[1]);
  /* у версии нет такого periodtype — запрос отдаёт пустой набор, как настоящий CH */
  const empty = db && pt !== undefined && !hasGran(db, pt);

  if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
  if (/FROM system\.databases/.test(sql))
    return [{ name: 'system' }, { name: 'default' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
  if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
  if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
  if (/SELECT periodtype AS t/.test(sql)) {
    if (!db || !DBS[db]) return [];
    return DBS[db].grans.map(([t, n]) => ({ t, n }));
  }
  if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
  if (/`operation_type` AS t/.test(sql)) return BY_OP;
  if (/`o_p` AS k/.test(sql)) return DIM_P;
  if (/`o_prod` AS k/.test(sql)) return DIM_PR;
  if (/`o_cl` AS k/.test(sql)) return DIM_CL;
  if (/`lostrevenue`/.test(sql)) return empty ? [COV0] : [COV];
  if (/GROUP BY k ORDER BY k/.test(sql)) return empty ? [] : COV_P;
  if (/calcavailablebucketcapacity/.test(sql)) return empty ? [] : CAP;
  if (/netavailbucketcapacity/.test(sql)) return empty ? [] : CAP_PLAN;
  if (/`quota`/.test(sql)) return TI;
  if (/nondelcostrate/.test(sql)) return empty ? [] : PEN;
  if (/unfullfilleddemandqty/.test(sql) && /GROUP BY item/.test(sql)) return empty ? [] : UF;
  if (/SELECT order_id AS id/.test(sql)) return ORDERS;
  if (/IN \(/.test(sql)) return OPS;
  return undefined;
}

/** Перехват fetch: имитация HTTP-интерфейса ClickHouse. */
function installCHMock(window, log = []) {
  window.fetch = async (url, opts) => {
    const sql = String((opts && opts.body) || '');
    const rows = route(sql);
    log.push(sql);
    if (rows === undefined) log.missed = (log.missed || []).concat(sql);
    const text = (rows || []).map((r) => JSON.stringify(r)).join('\n');
    return { ok: true, status: 200, text: async () => text };
  };
}

async function loadApp(seed = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: { interceptors: [localResources] },
    beforeParse(window) {
      for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
    },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    close() {
      try { dom.window.close(); } catch { /* jsdom: не суть */ }
    },
  };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 10000)) {
    try { if (fn()) return; } catch { /* ещё не готово */ }
    await settle(25);
  }
  throw new Error('timeout: ' + (label || 'условие'));
}

test('выбор версии: гранулярность в панели подтягивается по ВЫБРАННОЙ версии', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  const log = [];
  installCHMock(ctx.window, log);

  await ctx.window.CHX.connect();
  ctx.window.CHX.openModal();
  const d = ctx.document;

  /* data_public_2 становится базовой (первая галочка) */
  d.querySelector('input[data-db="data_public_2"]').click();

  await waitFor(() => {
    const s = d.getElementById('chmGran');
    return s && s.options.length === 1 && s.options[0].value === '3';
  }, 5000, 'список гранулярностей обновился по выбранной версии');

  const s = d.getElementById('chmGran');
  assert.equal(s.value, '3', 'в селекте стоит доступная версии гранулярность');
  assert.match(s.options[0].textContent, /Неделя/);
  assert.match(s.options[0].textContent, /50 строк/,
    'счётчик строк — из demand_coverage ВЫБРАННОЙ версии, а не проба-схемы (у неё 100)');
  assert.equal(ctx.window.CHX.cfg.gran, 3, 'cfg.gran переключён на гранулярность выбранной версии');
  assert.equal(log.missed, undefined, 'все запросы обработаны моком');
});

test('переключение базовой версии радиокнопкой обновляет гранулярности', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  const log = [];
  installCHMock(ctx.window, log);

  await ctx.window.CHX.connect();
  ctx.window.CHX.openModal();
  const d = ctx.document;

  d.querySelector('input[data-db="data_public_1"]').click(); // база = _1 (месяц)
  await settle();
  let s = d.getElementById('chmGran');
  assert.equal(s.value, '4', 'база _1: месяц');
  assert.match(s.options[0].textContent, /100 строк/);

  d.querySelector('input[data-base="data_public_2"]').click(); // явная смена базы
  await waitFor(() => d.getElementById('chmGran').value === '3', 5000, 'смена радиокнопкой обновляет список');
  s = d.getElementById('chmGran');
  assert.equal(s.options.length, 1);
  assert.match(s.options[0].textContent, /Неделя/);
  assert.equal(ctx.window.CHX.cfg.gran, 3);
  assert.ok(d.querySelector('input[data-base="data_public_2"]').checked, 'радио стоит на новой версии');
  assert.equal(log.missed, undefined, 'все запросы обработаны моком');
});

test('загрузка: каждая версия агрегируется своей гранулярностью', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  const log = [];
  installCHMock(ctx.window, log);

  await ctx.window.CHX.connect();
  ctx.window.CHX.openModal();
  const d = ctx.document;

  d.querySelector('input[data-db="data_public_2"]').click(); // база = _2 (неделя)
  await waitFor(() => ctx.window.CHX.cfg.gran === 3, 5000, 'база _2: гранулярность = неделя');
  d.querySelector('input[data-db="data_public_1"]').click(); // сравнение: _1 (месяц)
  await settle();
  d.getElementById('chmLoad').click();

  await waitFor(() => ctx.window.CHX.versions.length === 2, 15000,
    'версии загружены (' + ((d.getElementById('chmProg') || {}).textContent || '') + ')');

  const v2 = ctx.window.CHX.versions.find((v) => v.id === 'data_public_2');
  const v1 = ctx.window.CHX.versions.find((v) => v.id === 'data_public_1');
  assert.ok(v1 && v2, 'обе версии загружены');

  assert.equal(v2.gran, 3, 'базовая версия — её гранулярность');
  assert.equal(Number(v2.agg.totals.cov.demUnc), 60,
    'у базовой версии покрытие посчитано, а не обнулено чужим periodtype');
  assert.equal(v1.gran, 4, 'версия без periodtype 3 агрегируется СОБОЙ periodtype 4');
  assert.equal(Number(v1.agg.totals.cov.demUnc), 60,
    'у сравнимой версии покрытие посчитано по ЕЁ гранулярности');
  assert.ok(v1.agg.notes.some((n) => /нет periodtype 3/.test(n)),
    'честная пометка, что версия посчитана другой гранулярностью');
  assert.ok(!v2.agg.notes.some((n) => /нет periodtype/.test(n)), 'у базовой версии ложных пометок нет');
  assert.equal(ctx.window.CHX.cfg.gran, 3, 'основной датасет — на гранулярности базовой версии');
  assert.equal(ctx.window.DS.gran, 3, 'DS.gran — гранулярность базовой версии');
  assert.equal(log.missed, undefined, 'все запросы обработаны моком');
});

test('версия, в которой общая гранулярность ЕСТЬ, агрегируется ею (без ложного fallback)', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  const log = [];
  installCHMock(ctx.window, log);

  await ctx.window.CHX.connect();
  ctx.window.CHX.openModal();
  const d = ctx.document;

  d.querySelector('input[data-db="data_public_2"]').click(); // база = _2 (неделя)
  await waitFor(() => ctx.window.CHX.cfg.gran === 3, 5000, 'база _2: неделя');
  d.querySelector('input[data-db="data_public_3"]').click(); // _3: и неделя, и месяц
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => ctx.window.CHX.versions.length === 2, 15000, 'версии загружены');

  const v3 = ctx.window.CHX.versions.find((v) => v.id === 'data_public_3');
  assert.equal(v3.gran, 3, 'общая периодtype 3 доступна в версии — агрегируется ею');
  assert.equal(Number(v3.agg.totals.cov.demUnc), 60);
  assert.ok(!v3.agg.notes.some((n) => /нет periodtype/.test(n)), 'пометка не нужна');
  assert.equal(log.missed, undefined, 'все запросы обработаны моком');
});

test('устаревшая база из автосессии не используется как объект пробы гранулярности', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  const log = [];
  installCHMock(ctx.window, log);

  ctx.window.CHX.cfg.base = 'data_public_99';       // схемы уже нет в кластере
  ctx.window.CHX.cfg.schemas = ['data_public_99'];
  await ctx.window.CHX.connect();

  assert.equal(ctx.window.CHX.cfg.base, '', 'фантомная база сброшена');
  assert.equal(ctx.window.CHX.cfg.schemas.length, 0, 'фантомная схема вычищена из выбора');
  /* JSON-сравнение: объекты из jsdom-окна не проходят deepStrictEqual (чужой realm) */
  assert.equal(JSON.stringify(ctx.window.CHX.state.granOptions), '[{"t":4,"n":100}]',
    'гранулярности пробуются по существующей схеме, а не по несуществующей');
  assert.equal(log.missed, undefined, 'все запросы обработаны моком');
});

test('«Сравнение версий» показывает фактическую гранулярность каждой версии', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  const log = [];
  installCHMock(ctx.window, log);

  await ctx.window.CHX.connect();
  ctx.window.CHX.openModal();
  const d = ctx.document;

  d.querySelector('input[data-db="data_public_2"]').click();
  await waitFor(() => ctx.window.CHX.cfg.gran === 3, 5000, 'база _2: неделя');
  d.querySelector('input[data-db="data_public_1"]').click();
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => ctx.window.CHX.versions.length === 2, 15000, 'версии загружены');

  ctx.window.go('vs');
  await settle();

  const kpi = [...d.querySelectorAll('#main .kpi')].find(
    (k) => k.querySelector('.t').textContent === 'Гранулярность');
  assert.ok(kpi, 'KPI «Гранулярность» есть в сравнении');
  const val = kpi.querySelector('.v').textContent;
  assert.match(val, /Месяц/, 'KPI отражает гранулярность версии _1');
  assert.match(val, /Неделя/, 'KPI отражает гранулярность версии _2');

  const sum = d.querySelector('#main .sum');
  assert.ok(sum, 'есть резюме сравнения');
  assert.match(sum.textContent, /разные/i, 'резюме честно указывает на разные гранулярности');
  assert.equal(log.missed, undefined, 'все запросы обработаны моком');
});
