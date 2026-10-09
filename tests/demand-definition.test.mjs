/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: определение «Неограниченный спрос = Σ demandqty из independent_demand»
   действует во ВСЁМ дашборде, а не в одном разделе.

   Требование владельца (2026-10): неограниченный спрос — вход модели
   `Σ demandqty` из PostgreSQL independent_demand; плановые demand_volume,
   results_sale и unsatisfied_demand — marking_demand; покрытый и непокрытый
   спрос из demand_coverage — отдельные итоги прогона, не замена плана.
   Для заказов total — independent_demand.n, а статусы/невязка — отдельные
   поля с явными источниками.

   Проверяется моком, где таблицы намеренно расходятся (вход 1500 против
   950 + 250 coverage, план 1000/900/100): дашборд показывает каждое число
   на своей методике и поднимает проверку входа против исхода.

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

/** uncTotal — Σ demandqty из PG independent_demand (вход); покрытие в CH — 950 + 250 = 1200 (исход). */
function makeRoute(uncTotal) {
  const COV = { demUnc: 1200, ff: 950, uf: 250, inTime: 850, late: 50, lostRev: 120, planRev: 6000, prop: 1200 };
  const COV_P = [{ k: '2026-09', demUnc: 1200, ff: 950, uf: 250, late: 50 }];
  return function route(sql) {
    const dbm = sql.match(/`(data_public_\d+)`\./);
    const db = dbm && dbm[1];
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
    if (/`independent_demand`/.test(sql)) throw new Error('в ClickHouse таблицы independent_demand нет — идём в PostgreSQL');
    if (/`lostrevenue`/.test(sql)) return [COV];
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
const toNum = (s) => Number(String(s).replace(/ | |\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.'));

async function loadCH(uncTotal) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
  const route = makeRoute(uncTotal);
  w.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/pg/')) {
      const body = JSON.parse(String((opts && opts.body) || '{}'));
      if (u.includes('/api/pg/schemas'))
        return { ok: true, status: 200, json: async () => ({ ok: true, table: 'independent_demand', schemas: [{ schema: 'public_1', n: 15 }, { schema: 'public_2', n: 15 }] }) };
      if (u.includes('/api/pg/unc'))
        return { ok: true, status: 200, json: async () => ({ ok: true, schema: body.schema, table: 'independent_demand', gran: body.gran, cols: { qty: 'demandqty', ptype: 'periodtype', date: 'date' }, demUnc: uncTotal, n: 15, periods: [{ k: '2026-09', demUnc: uncTotal }] }) };
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    }
    const sql = String((opts && opts.body) || '');
    let rows;
    try { rows = route(sql); }
    catch (e) { return { ok: false, status: 500, text: async () => e.message }; }
    return { ok: true, status: 200, text: async () => rows.map((r) => JSON.stringify(r)).join('\n') };
  };
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
  const vsRow = (name) => {
    const tr = [...d.querySelectorAll('#vsMat table tbody tr')].find(
      (x) => (x.querySelector('td') || {}).textContent?.trim().startsWith(name));
    if (!tr) throw new Error('нет строки «' + name + '»');
    return toNum([...tr.querySelectorAll('td')][1].textContent);
  };
  return { window: w, document: d, kpi, goTab, vsRow, close() { try { dom.window.close(); } catch { /* jsdom */ } } };
}

test('неограниченный спрос = Σ demandqty (independent_demand) во всех разделах, даже если покрытие говорит другое', async (t) => {
  /* входной спрос 1500, а покрытый + непокрытый — 1200 */
  const ctx = await loadCH(1500);
  t.after(ctx.close);

  await ctx.goTab('dm');
  const unlim = ctx.kpi('Неограниченный спрос');
  assert.ok(unlim, 'карточка «Неограниченный спрос» есть во вкладке «Спрос и покрытие»');
  assert.equal(toNum(unlim.querySelector('.v').textContent), 1500,
    'показан вход 1500 из independent_demand, а не покрытый+непокрытый 1200');

  /* производные от него величины считаются от того же числа.
     2026-10-05: карточка «Не принято в план» убрана из верхнего ряда (её место —
     водопад), величины читаются из covBasis — единой точки определения */
  const B = JSON.parse(ctx.window.eval('(function(){const b=covBasis(fOrders());return JSON.stringify({np:b.notPlanned,gap:b.gapTotal})})()'));
  assert.equal(B.np, 500, '1500 − 1000 плана');
  assert.equal(toNum(ctx.kpi('Не покрыто всего').querySelector('.v').textContent), 600, '1500 − 900 отгрузки');
  assert.equal(B.gap, 600, 'gapTotal в covBasis — то же число');

  await ctx.goTab('ov');
  assert.equal(JSON.parse(ctx.window.eval('(function(){return JSON.stringify(covBasis(fOrders()).gapTotal)})()')), 600,
    '«Общий» использует то же определение');

  await ctx.goTab('vs');
  assert.equal(ctx.vsRow('Неограниченный спрос, т'), 1500, 'входной спрос — независимый агрегат');
  assert.equal(ctx.vsRow('Ограниченный спрос (план), т'), 1000, 'плановый спрос — marking_demand');
  assert.equal(ctx.vsRow('План продаж, т'), 900, 'продажи — marking_demand');
  /* строки дефицита в матрице больше нет; величина та же — из marking_demand (covBasis.gapPlan) */
  assert.equal(JSON.parse(ctx.window.eval('(function(){return JSON.stringify(covBasis(fOrders()).gapPlan)})()')), 100,
    'дефицит плана — marking_demand (covBasis.gapPlan)');
  const deficitRowShown = [...ctx.document.querySelectorAll('#vsMat table tbody tr')].some(
    (x) => ((x.querySelector('td') || {}).textContent || '').trim().startsWith('Дефицит плана'));
  assert.equal(deficitRowShown, false, 'строки «Дефицит плана» в матрице нет');
  assert.equal(ctx.vsRow('Покрытый спрос, т'), 950, 'покрытый объём — demand_coverage');
  assert.equal(ctx.vsRow('Непокрытый спрос, т'), 600,
    'итог непокрытого спроса совпадает с карточкой: 1500 independent_demand − 900 продаж');
  assert.equal(ctx.vsRow('Непокрытый спрос по demand_coverage, т'), 250,
    'сырой unfullfilleddemandqty сохранён отдельной строкой');
  assert.equal(ctx.vsRow('Заказов (неогр. спрос)'), 15,
    'total заказов — independent_demand.n, не число строк demand_coverage');

  await ctx.goTab('data');
  const checks = [...ctx.document.querySelectorAll('#q3 .dq')].map((x) => x.textContent.replace(/\s+/g, ' '));
  const def = checks.find((x) => /Неограниченный спрос: определение/.test(x));
  assert.ok(def, 'во вкладке «Данные и качество» есть проверка определения');
  assert.match(def, /1 500/, 'вход (independent_demand) назван числом');
  assert.match(def, /1 200/, 'исход (demand_coverage) назван числом');
  assert.match(def, /расхождение/, 'проверка сообщает о расхождении, а не молчит');
  assert.match(def, /independent_demand/, 'назван источник определения');
});

test('когда вход (independent_demand) согласован с исходом (demand_coverage) — проверка определения зелёная', async (t) => {
  const ctx = await loadCH(1200);
  t.after(ctx.close);

  await ctx.goTab('dm');
  assert.equal(toNum(ctx.kpi('Неограниченный спрос').querySelector('.v').textContent), 1200);
  /* 2026-10-05: «Не принято в план» — в водопаде, не в карточках */
  assert.equal(JSON.parse(ctx.window.eval('(function(){return JSON.stringify(covBasis(fOrders()).notPlanned)})()')), 200, '1200 − 1000 плана');
  assert.equal(toNum(ctx.kpi('Не покрыто всего').querySelector('.v').textContent), 300, '1200 − 900 отгрузки');

  await ctx.goTab('data');
  const checks = [...ctx.document.querySelectorAll('#q3 .dq')].map((x) => x.textContent.replace(/\s+/g, ' '));
  const def = checks.find((x) => /Неограниченный спрос: определение/.test(x));
  assert.ok(def, 'проверка выполняется и в согласованном случае');
  assert.match(def, /совпадает с суммой покрытого и непокрытого/,
    'подтверждение, а не предупреждение');
});

test('нулевой independent_demand — возвращаем demand_coverage как фолбэк', async (t) => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
  const route = makeRoute(0);   /* в PG таблица есть, но строк нет / нулевой объём */
  w.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/pg/')) {
      const body = JSON.parse(String((opts && opts.body) || '{}'));
      if (u.includes('/api/pg/schemas'))
        return { ok: true, status: 200, json: async () => ({ ok: true, table: 'independent_demand', schemas: [{ schema: 'public_1', n: 0 }, { schema: 'public_2', n: 0 }] }) };
      if (u.includes('/api/pg/unc'))
        return { ok: true, status: 200, json: async () => ({ ok: true, schema: body.schema, table: 'independent_demand', gran: body.gran, cols: { qty: 'demandqty' }, demUnc: 0, n: 0, periods: [] }) };
    }
    const sql = String((opts && opts.body) || '');
    let rows;
    try { rows = route(sql); }
    catch (e) { return { ok: false, status: 500, text: async () => e.message }; }
    return { ok: true, status: 200, text: async () => rows.map((r) => JSON.stringify(r)).join('\n') };
  };
  w.PGX.cfg.user = 'reader';
  w.PGX.cfg.password = 'secret';
  t.after(() => { try { dom.window.close(); } catch { /* jsdom */ } });

  await w.CHX.connect();
  w.CHX.openModal();
  d.querySelector('input[data-db="data_public_1"]').click();
  await settle();
  d.querySelector('input[data-db="data_public_2"]').click();
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => w.CHX.versions.length === 2, 20000, 'версии загружены');

  /* PostgreSQL прочитан, но нулевой вход переключает показатель на покрытие. */
  const notes = w.CHX.versions.map((v) => (v.agg.notes || []).join(' ')).join(' ');
  assert.match(notes, /Σ demandqty = 0/, 'нулевой вход зафиксирован в заметках загрузки');
  assert.match(notes, /применён фолбэк demand_coverage/, 'фолбэк явно зафиксирован');
  assert.ok(!/independent_demand недоступна/.test(notes), 'нулевой PG-ответ не называется недоступностью');
  assert.equal(w.CHX.versions[0].agg.totals.uncSrc, 'demand_coverage',
    'источник переключён на demand_coverage');
  assert.equal(w.CHX.versions[0].agg.totals.cov.demUnc, 1200,
    'покрытый+непокрытый используются как итог');
  assert.equal(w.CHX.versions[0].agg.totals.cov.demUncCov, 1200,
    'покрытый+непокрытый сохранены');

  w.go('dm');
  await settle(250);
  const unlim = [...d.querySelectorAll('#main .kpi')]
    .find((k) => ((k.querySelector('.t') || {}).textContent || '').trim() === 'Неограниченный спрос');
  assert.equal(toNum(unlim.querySelector('.v').textContent), 1200,
    'карточка показывает фолбэк из demand_coverage');
});
