/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия типовой валидности SQL для реального ClickHouse.

   Продакшен-баг 2026-10-05 (Data_public_4941, Data_public_4899): агрегат
   demand_coverage использовал toFloat64OrZero() для классификации заказов.
   В ClickHouse функции с постфиксом OrZero/OrNull принимают ТОЛЬКО String,
   а столбцы demand_coverage — Decimal, поэтому сервер ответил
   «Code: 43. DB::Exception: Illegal type Decimal ... should take String
   argument» и упал весь агрегат — включая demUnc (фолбэк неограниченного
   спроса для PostgreSQL). Дашборд молча ушёл в фолбэки и показал ⚠
   «Загрузка прошла с оговорками».

   Обычные моки тестов возвращают готовые строки и НЕ проверяют сам SQL —
   поэтому баг прошёл все 139 тестов. Этот файл добавляет «типопроверяющий»
   ClickHouse: каждый запрос валидируется так, как его проверил бы реальный
   сервер, и проверяет честность деградации при отказе.

   1. Агрегат demand_coverage проходит типовую проверку: без OrZero/OrNull,
      с приведением toFloat64(Decimal) и допуском 1e-9; предупреждений
      «demand_coverage: ClickHouse 500» нет.
   2. Валидатор отклоняет именно продакшен-сломанный SQL (Code: 43), а
      текущий SQL проходит — гарант гаранта.
   3. Статический запрет: в исходниках нет конверсий *OrZero/*OrNull,
      применённых к столбцу (они принимают только String).
   4. Деградация: если ClickHouse отверг агрегат, приложение честно уходит
      в фолбэк marking_demand и показывает предупреждение с текстом ошибки.

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

/* ── «Типопроверяющий» ClickHouse ──────────────────────────────────────────
   Объёмные столбцы demand_coverage и marking_demand в проде — Decimal (ошибка
   продакшена доказывает это для demand_coverage). Функции to*OrZero/to*OrNull
   принимают только String — любое их применение к таким столбцам обязано
   падать с Code: 43, как в реальном сервере. */
const DECIMAL_COLS = new Set([
  'fullfilleddemandqty', 'unfullfilleddemandqty', 'demandfullfilledintimeqty',
  'demandfullfilledlateqty', 'propagated_demand', 'lostrevenue', 'plannedrevenue',
  'results_sale', 'unsatisfied_demand', 'demand_volume', 'revenue',
  'cost_of_demand', 'total_margin', 'margin_per_unit',
  'cost_rate_of_operation', 'order_operation_volume',
]);
function rejectSql(sql) {
  const re = /to\w+Or(?:Zero|Null)\s*\(\s*`([^`]+)`/g;
  let m;
  while ((m = re.exec(sql))) {
    if (DECIMAL_COLS.has(m[1].toLowerCase())) {
      const fn = m[0].slice(0, m[0].indexOf('('));
      return { exception: `Code: 43. DB::Exception: Illegal type Decimal of first argument of function ${fn}. ` +
        `Conversion functions with postfix 'OrZero' or 'OrNull' should take String argument: In scope ${sql.slice(0, 160)}` };
    }
  }
  return null;
}

/* ── данные мока (как в order-counts.test.mjs) ── */
const DBS = { data_public_1: { grans: [[4, 100]], n: 1200, ts: '2026-09-10 08:00:00' } };
const COLS = [
  'order_id','order_operation_id','resource','demand_period','demand_product',
  'demand_client','demand_location','demand_volume','results_sale','unsatisfied_demand',
  'revenue','cost_of_demand','total_margin','margin_per_unit','price','cost_per_unit_order',
  'demand_demandtype','dmdstream','demand_demandtypepriority','margin_per_hour','operation_type',
  'location','product','loc_from','loc_to','transport_type','order_operation_volume',
  'cost_rate_of_operation','supplier','bom_num',
];
const ORDERS_TOT = {
  orders: 90, rev: 50e9, cost: 30e9, mar: 20e9,
  dem: 5000, sal: 4000, unm: 1000, lm: 3e9, full: 55,
  zeroSalOrders: 20, partCoveredOrders: 15, fullCoveredOrders: 55,
};
const COV = {
  demUnc: 6000, ff: 4000, uf: 2000, inTime: 3800, late: 200, prop: 6000,
  orderRows: 100, fullyUncoveredOrders: 30, partiallyCoveredOrders: 20, fullyCoveredOrders: 50,
  lateOrdersAll: 8, lateFullyCoveredOrders: 6,
  lostRev: 20e9, planRev: 50e9,
};
const COV_P = [{ k: '2026-09', demUnc: 6000, ff: 4000, uf: 2000, late: 200 }];
const BY_OP = [{ t: 'production', c: 5e9, v: 900, n: 2 }, { t: 'movement', c: 3e9, v: 900, n: 2 }];
const DIM_P = [{ k: '1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
const DIM_PR = [{ k: 'P1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
const DIM_CL = [{ k: 'C1', mar: 3.04e9, sal: 380, unm: 20, rev: 7.6e9 }];
const ORDERS = [
  { id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1',
    dem: 400, sal: 400, unm: 0, price: 20e6, cpt: 12e6, mpt: 8e6, rev: 8e9, cost: 4.8e9, mar: 3.2e9, prio: 1, mph: 0 },
  { id: 102, p: '2', loc: 'L1', prod: 'P2', cl: 'C2', dtype: 1, stream: 'S1',
    dem: 600, sal: 300, unm: 300, price: 4e6, cpt: 2.5e6, mpt: 1.5e6, rev: 1.2e9, cost: 0.75e9, mar: 0.45e9, prio: 2, mph: 0 },
  { id: 103, p: '2', loc: 'L1', prod: 'P3', cl: 'C3', dtype: 1, stream: 'S1',
    dem: 500, sal: 0, unm: 500, price: 5e6, cpt: 3e6, mpt: 2e6, rev: 0, cost: 0, mar: 0, prio: 2, mph: 0 },
];
const OPS = [
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 400, r: 12e6, vd: '', rt: '1.1', oid: '101.1', rc: 0 },
];

function makeRoute() {
  return (sql) => {
    const dbm = sql.match(/`(data_public_\d+)`\./);
    const db = dbm && dbm[1];
    if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
    if (/AS oid/.test(sql)) return OPS;
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
    if (/lostrevenue/.test(sql)) return [COV];
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

/* opts.breakDc — имитировать отказ реального CH на агрегате demand_coverage */
async function loadCH(opts = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
  const route = makeRoute();
  const captured = [];
  w.fetch = async (url, requestOptions) => {
    const sql = String((requestOptions && requestOptions.body) || '');
    captured.push(sql);
    /* типопроверка, как в реальном CH: OrZero/OrNull не для Decimal */
    const err = rejectSql(sql);
    if (err) return { ok: false, status: 500, text: async () => JSON.stringify(err) };
    /* имитация отказа агрегата demand_coverage (продакшен-сценарий) */
    if (opts.breakDc && /fullyUncoveredOrders/.test(sql))
      return { ok: false, status: 500, text: async () => JSON.stringify({ exception: 'Code: 43. DB::Exception: Illegal type Decimal of first argument of function toFloat64OrZero.' }) };
    return { ok: true, status: 200, text: async () => route(sql).map((r) => JSON.stringify(r)).join('\n') };
  };
  await w.CHX.connect();
  w.CHX.openModal();
  d.querySelector('input[data-db="data_public_1"]').click();
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => w.CHX.versions.length === 1 && w.DS, 20000, 'версия загружена');
  return {
    window: w, document: d, captured,
    ev: (code) => w.eval(code),
    warnings: () => { try { return JSON.parse(w.eval('JSON.stringify(LOAD_WARNINGS.map(x=>[x.title,x.cause,x.effect].filter(Boolean).join(" | ")))')) || []; } catch { return []; } },
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}

test('агрегат demand_coverage проходит типовую проверку реального ClickHouse (регрессия Code 43)', async (t) => {
  const ctx = await loadCH();
  t.after(ctx.close);

  /* ошибок загрузки, связанных с demand_coverage / Code 43, быть не должно.
     (Заметка «independent_demand недоступна — фолбэк demand_coverage» легитимна:
     в тесте нет PostgreSQL, и фолбэк сработал штатно.) */
  const warns = ctx.warnings();
  const bad = warns.filter((x) => /ClickHouse 500|Code: 43/.test(x) || /^demand_coverage:/i.test(x));
  assert.deepEqual(bad, [], 'нет предупреждений об отказе demand_coverage');
  assert.equal(ctx.ev('CHX.loaded.demand_coverage'), true, 'demand_coverage загружена');
  assert.equal(ctx.ev('CHX.versions.length'), 1, 'версия загружена');

  /* счёт заказов — из demand_coverage, разбиение полное */
  const ord = JSON.parse(ctx.ev('(function(){return JSON.stringify(covBasis(fOrders()).ord)})()'));
  assert.equal(ord.src, 'demand_coverage');
  assert.equal(ord.total, 100);
  assert.equal(ord.fullUnc + ord.part + ord.full, ord.total);

  /* SQL агрегата: приведение toFloat64 (OrZero для Decimal запрещён),
     допуски 1e-9, счётчики опозданий — среди полностью покрытых.
     Комментарии в шаблоне уезжают в запрос (CH их легально игнорирует),
     поэтому ищем именно ВЫЗОВ функции, а не слово в комментарии. */
  const dcSql = ctx.captured.find((s) => /fullyUncoveredOrders/.test(s));
  assert.ok(dcSql, 'агрегат demand_coverage запрошен');
  assert.ok(!/to\w+Or(?:Zero|Null)\s*\(/.test(dcSql), 'в SQL нет вызовов OrZero/OrNull (только String-аргументы)');
  assert.match(dcSql, /countIf\(toFloat64\(`fullfilleddemandqty`\) <= 0\.000000001\) AS fullyUncoveredOrders/,
    'классификация «100% не покрыто» — toFloat64 + допуск 1e-9');
  assert.match(dcSql, /countIf\(toFloat64\(`unfullfilleddemandqty`\) > 0\.000000001 AND toFloat64\(`fullfilleddemandqty`\) > 0\.000000001\) AS partiallyCoveredOrders/,
    'классификация «частично покрыто» — оба объёма > 0');
  assert.match(dcSql, /countIf\(toFloat64\(`unfullfilleddemandqty`\) <= 0\.000000001 AND toFloat64\(`fullfilleddemandqty`\) > 0\.000000001\) AS fullyCoveredOrders/,
    'классификация «полностью покрыто»');
  assert.match(dcSql, /AS lateOrdersAll/, 'счётчик всех опозданий есть');
  assert.match(dcSql, /AS lateFullyCoveredOrders/, 'опоздания среди полностью покрытых есть');
  assert.equal(rejectSql(dcSql), null, 'текущий SQL проходит типопроверку');

  /* все запросы сессии — без запрещённых конверсий */
  for (const sql of ctx.captured)
    assert.equal(rejectSql(sql), null, 'SQL проходит типопроверку: ' + sql.slice(0, 60));
});

test('валидатор отклоняет именно продакшен-сломанный SQL (гарант гаранта)', () => {
  const broken = 'SELECT count() AS orderRows,\n' +
    "  countIf(toFloat64OrZero(`fullfilleddemandqty`) = 0) AS fullyUncoveredOrders,\n" +
    "  countIf(toFloat64OrZero(`unfullfilleddemandqty`) > 0 AND toFloat64OrZero(`fullfilleddemandqty`) > 0) AS partiallyCoveredOrders\n" +
    'FROM `data_public_4941`.`demand_coverage`';
  const err = rejectSql(broken);
  assert.ok(err, 'сломанный SQL отклонён');
  assert.match(err.exception, /Code: 43\. DB::Exception: Illegal type Decimal of first argument of function toFloat64OrZero/,
    'текст ошибки — как в продакшене');
  assert.match(err.exception, /should take String argument/, 'причина названа');
  /* корректные конверсии не задеваются */
  assert.equal(rejectSql('SELECT countIf(toFloat64(`fullfilleddemandqty`) <= 0.000000001) FROM `x`.`demand_coverage`'), null);
  assert.equal(rejectSql('SELECT toFloat64OrZero(\'\') FROM `x`.`t`'), null, 'строковый литерал — законный аргумент');
});

test('исходники: конверсии *OrZero/*OrNull не применяются к столбцам', () => {
  /* ловим и прямой бэктик, и шаблон ${q('...')} — столбец в любом случае
     не String, а OrZero/OrNull принимают только String */
  const badCall = /to\w+Or(?:Zero|Null)\s*\(\s*(?:`|\$\{q\()/;
  for (const f of ['assets/inplan-ch.js', 'index.html']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!badCall.test(src),
      `${f}: функции с постфиксом OrZero/OrNull принимают только String — применять их к столбцу (Decimal/число) нельзя`);
  }
});

test('деградация: отказ агрегата demand_coverage → фолбэк marking_demand + честное предупреждение', async (t) => {
  const ctx = await loadCH({ breakDc: true });
  t.after(ctx.close);

  assert.notEqual(ctx.ev('CHX.loaded.demand_coverage'), true, 'demand_coverage не загружена');
  const ord = JSON.parse(ctx.ev('(function(){return JSON.stringify(covBasis(fOrders()).ord)})()'));
  assert.equal(ord.src, 'marking_demand', 'счёт заказов ушёл в фолбэк marking_demand');
  assert.equal(ord.total, 90);
  assert.equal(ord.fullUnc + ord.part + ord.full, ord.total, 'разбиение полное и в фолбэке');

  const warns = ctx.warnings();
  const failWarns = warns.filter((x) => /ClickHouse 500|Code: 43/.test(x));
  assert.ok(failWarns.length >= 1, 'предупреждение об отказе сервера показано');
  assert.match(failWarns.join('\n'), /demand_coverage/, 'предупреждение называет упавший источник');
  assert.match(failWarns.join('\n'), /ClickHouse 500/, 'в предупреждении — текст ошибки сервера');
  assert.match(failWarns.join('\n'), /Code: 43/, 'код ошибки виден пользователю');

  /* интерфейс жив, водопад по заказам строится от «Заказов в оптимизации» */
  ctx.window.go('dm');
  await settle(300);
  const wf = JSON.parse(ctx.ev('(function(){return JSON.stringify(dmOrderWaterfall(covBasis(fOrders()).ord).map(b=>b.k))})()'));
  assert.deepEqual(wf, ['Заказов в оптимизации', 'Дефицит плана', 'План продаж'],
    'без demand_coverage водопад по заказам начинается с «Заказов в оптимизации»');
});
