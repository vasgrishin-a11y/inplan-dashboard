/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: цепочка спроса считается в ОДНОМ охвате.

     Неограниченный спрос = Не принято в план + Ограниченный спрос (план)
     Ограниченный спрос   = Отгружено + Дефицит плана
     Неограниченный спрос = Отгружено + Не покрыто всего

   Найденный дефект: в режиме ClickHouse заказы грузятся с лимитом детализации
   (`ORDER BY abs(mar) DESC LIMIT N`, по умолчанию 2000), а неограниченный спрос
   приходит агрегатом по ВСЕЙ схеме. «Ограниченный спрос», «Отгружено» и
   «Дефицит плана» считались по урезанной выборке, поэтому весь незагруженный
   план молча уезжал в «Не принято в план» и в «Не покрыто всего»: на схеме с
   5000 т плана, из которых загружено 1000 т, дашборд сообщал «4000 т спроса
   оптимизатор не принял в план» и рекомендовал проверять ограничения модели.
   Тождество «Неограниченный = Ограниченный + Не принято в план» при этом
   показывало «✓ сходится», потому что оно выполняется по построению.

   Мок: агрегат схемы — план 5000, отгрузка 4500, дефицит 500 (5 заказов);
   детализация — 2 заказа на 1000 / 900 / 100; покрытие — 4500 + 1500 = 6000.

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
/* агрегат по ВСЕЙ схеме: 5 заказов, план 5000, отгрузка 4500, дефицит 500 */
const ORDERS_TOT = { orders: 5, rev: 26900, cost: 15850, mar: 11050, dem: 5000, sal: 4500, unm: 500, lm: 24000, full: 2 };
/* покрытие: покрытый 4500 + непокрытый 1500 = 6000 */
/* lostRev подобран так, чтобы денежная сверка сходилась: 175 000 × 41,1% ≈ 72 000 ₽ */
const COV = { demUnc: 6000, ff: 4500, uf: 1500, inTime: 4300, late: 200, lostRev: 175000, planRev: 30000, prop: 6000 };
const COV_P = [{ k: '2026-09', demUnc: 6000, ff: 4500, uf: 1500, late: 200 }];
/* неограниченный спрос — по умолчанию фолбэк «покрытый + непокрытый» из demand_coverage
   (таблица independentdemand лежит в PostgreSQL, в CH её нет и не ищем) */
const BY_OP = [{ t: 'production', c: 500, v: 48, n: 2 }, { t: 'movement', c: 300, v: 40, n: 2 }];
const DIM_P = [{ k: '1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const DIM_PR = [{ k: 'P1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const DIM_CL = [{ k: 'C1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
/* детализация: только 2 заказа из 5 — как при упоре в лимит загрузки */
const ORDERS = [
  { id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1', dem: 400, sal: 380, unm: 20, price: 100, cpt: 60, mpt: 40, rev: 1900, cost: 1140, mar: 760, prio: 1, mph: 0 },
  { id: 102, p: '2', loc: 'L1', prod: 'P2', cl: 'C2', dtype: 1, stream: 'S1', dem: 600, sal: 520, unm: 80, price: 120, cpt: 70, mpt: 50, rev: 3480, cost: 2030, mar: 1450, prio: 2, mph: 0 },
];
const OPS = [
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 19, r: 26, vd: '', rt: '1.1', oid: '101.1', rc: 0 },
];

function route(sql) {
  const dbm = sql.match(/`(data_public_\d+)`\./);
  const db = dbm && dbm[1];
  if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
  if (/AS oid/.test(sql)) return OPS;              /* детализация операций заказов */
  if (/FROM system\.databases/.test(sql))
    return [{ name: 'system' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
  if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
  if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
  if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
  if (/`independentdemand`/.test(sql)) throw new Error('в ClickHouse таблицы independentdemand быть не должно');
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
const toNum = (s) => Number(String(s).replace(/\u00a0|\u202f|\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.'));

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
  d.querySelector('input[data-db="data_public_2"]').click();
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => w.CHX.versions.length === 2, 20000, 'версии загружены');

  const kpi = (title) => [...d.querySelectorAll('#main .kpi')]
    .find((k) => ((k.querySelector('.t') || {}).textContent || '').trim() === title);
  const kpiVal = (title) => {
    const k = kpi(title);
    if (!k) throw new Error('нет карточки «' + title + '»');
    return toNum(k.querySelector('.v').textContent);
  };
  return {
    window: w, document: d, kpi, kpiVal,
    ev: (code) => w.eval(code),
    goTab: async (id) => { w.go(id); await settle(250); },
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}

test('пять величин цепочки спроса бьются между собой при урезанной детализации', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);
  await ctx.goTab('dm');

  const unlim = ctx.kpiVal('Неограниченный спрос');
  const notPlanned = ctx.kpiVal('Не принято в план');
  const limited = ctx.kpiVal('Ограниченный спрос (план)');
  const shipped = ctx.kpiVal('Отгружено');
  const deficit = ctx.kpiVal('Дефицит плана');
  const gapTotal = ctx.kpiVal('Не покрыто всего');

  /* значения — в охвате всей схемы, а не загруженных двух заказов */
  assert.equal(unlim, 6000, 'неограниченный = покрытый 4500 + непокрытый 1500');
  assert.equal(limited, 5000, 'ограниченный спрос — агрегат схемы, а не 1000 т загруженной выборки');
  assert.equal(shipped, 4500, 'отгружено — агрегат схемы, а не 900 т выборки');
  assert.equal(deficit, 500, 'дефицит плана — агрегат схемы, а не 100 т выборки');
  assert.equal(notPlanned, 1000, 'не принято в план = 6000 − 5000, без незагруженных заказов');
  assert.equal(gapTotal, 1500, 'не покрыто всего = 6000 − 4500');

  /* три тождества цепочки */
  assert.equal(limited + notPlanned, unlim, 'Неограниченный = Ограниченный + Не принято в план');
  assert.equal(shipped + deficit, limited, 'Ограниченный = Отгружено + Дефицит плана');
  assert.equal(shipped + gapTotal, unlim, 'Неограниченный = Отгружено + Не покрыто всего');
  assert.equal(notPlanned + deficit, gapTotal, 'Не покрыто всего = вне плана + дефицит плана');

  /* и независимая сверка с источником: непокрытый спрос выгрузки = 1500 */
  assert.equal(gapTotal, 1500, 'сходится с unfullfilleddemandqty');
});

test('«Свод спроса» показывает все тождества сошедшимися, включая сверку источников', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);
  await ctx.goTab('dm');

  const rows = [...ctx.document.querySelectorAll('#main table.rec tbody tr')]
    .map((tr) => tr.textContent.replace(/\s+/g, ' ').trim())
    .filter((x) => /спрос|покрыт/i.test(x));
  assert.ok(rows.length >= 4, 'тождества выведены');
  const bad = rows.filter((x) => /⚠/.test(x));
  assert.deepEqual(bad, [], 'ни одно тождество не разошлось: ' + bad.join(' | '));
  assert.ok(rows.some((x) => /Не покрыто всего = unfullfilleddemandqty/.test(x) && /✓/.test(x)),
    'сверка «не покрыто всего» с непокрытым спросом выгрузки сходится');
});

test('урезанная детализация названа явно, а ставка упущенной маржи берётся с выборки', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);
  await ctx.goTab('dm');

  const warn = ctx.document.querySelector('#main details.src-warn');
  assert.ok(warn, 'предупреждение о состоянии данных показано');
  assert.match(warn.textContent.replace(/\s+/g, ' '), /Детализация ограничена лимитом загрузки/,
    'лимит детализации назван прямо');
  assert.match(warn.textContent.replace(/\s+/g, ' '), /2 заказов из 5/, 'сколько загружено из скольких');

  /* ставка = упущенная маржа выборки / дефицит выборки = 4800 / 100 = 48 ₽/т,
     база «дефицит плана» = 500 т схемы → LM = 24 000 ₽ */
  const T = JSON.parse(ctx.ev(`(function(){
    const D=fOrders(), B=covBasis(D), T=lmTotals(B,D);
    return JSON.stringify({rate:T.rate, lmPlan:T.lmPlan, lmUnc:T.lmUnc, k:T.k,
      unmDet:B.unmDet, gapPlan:B.gapPlan, gapTotal:B.gapTotal, partial:B.partial, scope:B.scope});
  })()`));
  assert.equal(T.scope, 'schema', 'цепочка считается в охвате схемы');
  assert.equal(T.partial, true, 'флаг урезанной детализации выставлен');
  assert.equal(T.unmDet, 100, 'дефицит загруженной выборки');
  assert.equal(T.gapPlan, 500, 'дефицит плана по схеме');
  assert.equal(T.rate, 48, 'средневзвешенная ставка ₽/т — с выборки (4800 / 100)');
  assert.equal(T.lmPlan, 24000, 'упущенная маржа по дефициту плана = 48 × 500');
  assert.equal(T.lmUnc, 72000, 'по непокрытому спросу = 48 × 1500');
});

test('Service Level считается в том же охвате, что и цепочка', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);

  await ctx.goTab('dm');
  assert.match(ctx.kpi('Отгружено').querySelector('.s').textContent, /90,0%/,
    'SL = 4500 / 5000 по схеме, а не 900 / 1000 по выборке');

  await ctx.goTab('ov');
  assert.equal(ctx.kpiVal('Не покрыто всего'), 1500, '«Общий» согласован с «Спросом и покрытием»');
});
