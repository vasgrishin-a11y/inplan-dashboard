/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: пересчёт валовой выручки и валовой маржи по таблице margin_sales
   (задача владельца 2026-10-06).

   1. При наличии margin_sales карточки верхнего ряда («Общий», «Спрос и
      покрытие») показывают Σ revenue и Σ total_margin из неё, а не суммы
      marking_demand; подпись называет источник margin_sales.
   2. Снапшот версии (snap → «Сравнение версий») берёт те же пересчитанные
      rev/mar и фиксирует источник в finSrc.
   3. Прежние итоги marking_demand сохраняются в totals.revMd/marMd (для
      сверок), себестоимость остаётся по marking_demand.
   4. Фолбэк: пустая margin_sales → карточки и снапшот считаются по
      marking_demand, как раньше, без упоминания margin_sales и без
      предупреждений загрузки.

   Мок: агрегат marking_demand — выручка 50 млрд, маржа 20 млрд;
   margin_sales — выручка 60 млрд, маржа 25 млрд (нарочно другие числа,
   чтобы подмена источника была видна в каждой проверке).

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

/* агрегат marking_demand: выручка 50 млрд, маржа 20 млрд */
const ORDERS_TOT = {
  orders: 8, rev: 50e9, cost: 30e9, mar: 20e9,
  dem: 5000, sal: 4000, unm: 1000, lm: 3e9, full: 3,
};
/* итог margin_sales: выручка 60 млрд, маржа 25 млрд — нарочно другие числа;
   себестоимость 35 млрд — внутреннее тождество 60 − 35 = 25 сходится */
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

/* withMS=false — margin_sales «пустая» (пустой ответ, как у таблицы без строк) */
function makeRoute(withMS) {
  return (sql) => {
    const dbm = sql.match(/`(data_public_\d+)`\./);
    const db = dbm && dbm[1];
    if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
    if (/`margin_sales`/.test(sql)) return withMS ? [MS_TOT] : [];
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
const clean = (s) => String(s).replace(/\u00a0|\u202f/g, ' ').replace(/\s+/g, ' ').trim();
const toNum = (s) => Number(clean(s).replace(/\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.'));

async function loadCH(withMS) {
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
  const route = makeRoute(withMS);
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
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}

test('карточки «Общего» показывают Σ revenue / Σ total_margin из margin_sales', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('ov');

  /* сам запрос ушёл в margin_sales со стандартной дедупликацией src() */
  const msSql = ctx.captured.find((s) => /`margin_sales`/.test(s)) || '';
  assert.match(msSql, /sum\(toFloat64\(`revenue`\)\)/, 'выручка — Σ revenue');
  assert.match(msSql, /sum\(toFloat64\(`total_margin`\)\)/, 'маржа — Σ total_margin');
  assert.match(msSql, /is_deleted = 0/, 'дедупликация: is_deleted = 0');
  assert.match(msSql, /LIMIT 1 BY `sys_id`/, 'дедупликация: последняя строка по sys_id');

  /* было 50/20 млрд по marking_demand — стало 60/25 млрд по margin_sales */
  assert.equal(ctx.kpiVal('Валовая выручка'), 60, 'валовая выручка — 60 млрд из margin_sales');
  assert.equal(ctx.kpiVal('Валовая маржа'), 25, 'валовая маржа — 25 млрд из margin_sales');
  assert.match(ctx.card('Валовая выручка').s, /margin_sales/, 'источник назван в подписи');
  assert.match(ctx.card('Валовая маржа').s, /маржинальность 41,7%/, 'маржинальность 25/60, а не 20/50');
  /* себестоимость остаётся по marking_demand */
  assert.equal(ctx.kpiVal('Себестоимость'), 30, 'себестоимость — 30 млрд по marking_demand');
  /* маржа на тонну пересчитана от новой маржи: 25 млрд / 4000 т */
  assert.equal(ctx.kpiVal('Маржа на тонну'), 6250000, 'маржа на тонну от маржи margin_sales');

  /* прежние итоги marking_demand сохранены для сверок */
  assert.equal(ctx.ev('DS.agg.totals.rev'), 60e9);
  assert.equal(ctx.ev('DS.agg.totals.mar'), 25e9);
  assert.equal(ctx.ev('DS.agg.totals.revMd'), 50e9, 'revMd — прежний итог marking_demand');
  assert.equal(ctx.ev('DS.agg.totals.marMd'), 20e9, 'marMd — прежний итог marking_demand');
  assert.equal(ctx.ev('DS.agg.totals.finSrc'), 'margin_sales');
});

test('«Спрос и покрытие»: маржинальность продаж — по margin_sales, источник назван', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('dm');

  const c = ctx.card('Маржинальность продаж');
  assert.equal(c.v, '41,7%', 'маржинальность 25/60 из margin_sales');
  assert.match(c.s, /выручка 60,00 млрд/, 'выручка в подписи — из margin_sales');
  assert.match(c.s, /маржа 25,00 млрд/, 'маржа в подписи — из margin_sales');
  assert.match(c.s, /margin_sales/, 'источник назван в подписи');
});

test('снапшот версии для «Сравнения версий» берёт rev/mar из margin_sales', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);

  const snap = JSON.parse(ctx.ev('(function(){return JSON.stringify(snap(DS))})()'));
  assert.equal(snap.rev, 60e9, 'выручка снапшота — margin_sales');
  assert.equal(snap.mar, 25e9, 'маржа снапшота — margin_sales');
  assert.equal(snap.cost, 30e9, 'себестоимость снапшота — marking_demand');
  assert.equal(snap.finSrc, 'margin_sales', 'источник финансов зафиксирован в снапшоте');
});

test('«Данные и качество»: сверка margin_sales против marking_demand + внутреннее тождество', async (t) => {
  const ctx = await loadCH(true);
  t.after(ctx.close);
  await ctx.goTab('dq');
  await settle(300); /* реестр #q3 рисуется в setTimeout(…,0) */

  const q3 = ctx.document.getElementById('q3');
  assert.ok(q3, 'реестр проверок отрисован');
  const items = [...q3.querySelectorAll('.dq')];

  /* кросс-сверка источников: 60/25 млрд (margin_sales) против 50/20 млрд
     (marking_demand) — расхождение 16,7% / 20% больше допуска 0,5% → warning */
  const cross = items.find((el) => /margin_sales против marking_demand/.test(el.textContent));
  assert.ok(cross, 'проверка «Финансы: margin_sales против marking_demand» есть в реестре');
  assert.ok(cross.classList.contains('w'), 'расхождение источников — предупреждение');
  assert.match(clean(cross.textContent), /60,00 млрд/, 'названо число margin_sales');
  assert.match(clean(cross.textContent), /50,00 млрд/, 'названо число marking_demand');
  assert.match(cross.textContent, /iteration_number/, 'рекомендация называет вероятную причину');

  /* внутреннее тождество margin_sales: 60 − 35 = 25 → info */
  const ident = items.find((el) => /выручка − себестоимость = маржа/.test(el.textContent));
  assert.ok(ident, 'проверка внутреннего тождества margin_sales есть в реестре');
  assert.ok(ident.classList.contains('i'), 'тождество сходится — информационный статус');
});

test('фолбэк: пустая margin_sales → итоги marking_demand, без предупреждений', async (t) => {
  const ctx = await loadCH(false);
  t.after(ctx.close);
  await ctx.goTab('ov');

  assert.equal(ctx.kpiVal('Валовая выручка'), 50, 'валовая выручка — 50 млрд по marking_demand');
  assert.equal(ctx.kpiVal('Валовая маржа'), 20, 'валовая маржа — 20 млрд по marking_demand');
  assert.ok(!/margin_sales/.test(ctx.card('Валовая выручка').s), 'источник margin_sales не упоминается');
  assert.equal(ctx.ev('DS.agg.totals.finSrc') || 'нет', 'нет', 'finSrc не ставится без margin_sales');

  const snap = JSON.parse(ctx.ev('(function(){return JSON.stringify(snap(DS))})()'));
  assert.equal(snap.rev, 50e9);
  assert.equal(snap.mar, 20e9);
  assert.equal(snap.finSrc, 'marking_demand');

  /* тихий фолбэк: пустая margin_sales — не повод для значка ⚠ */
  const warns = JSON.parse(ctx.ev('JSON.stringify(LOAD_WARNINGS.map(x=>x.title))'));
  assert.ok(!warns.some((x) => /margin_sales/.test(x)), 'нет предупреждений о margin_sales: ' + warns.join('; '));

  /* и сверка источников в «Данных и качестве» не показывается — сверять нечего */
  await ctx.goTab('dq');
  await settle(300);
  const q3 = ctx.document.getElementById('q3');
  assert.ok(!/margin_sales против marking_demand/.test(q3.textContent),
    'без margin_sales кросс-сверка не выводится');
});
