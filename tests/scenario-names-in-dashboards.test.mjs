/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия: названия версий во всех разделах дашборда — текстом из таблицы
   сценариев (pgs_app_metadata_db.scenario), а не техническими именами схем.

   Требование владельца (2026-10-07): везде, где дашборд показывает версию,
   должно стоять её текстовое название из `scenario` (сопоставление цифрового
   суффикса базы ClickHouse с `sys_id`); если записи в сценариях нет —
   остаётся текущий вариант (техническое имя схемы).

   Проверяются: подпись активной версии в шапке, колонки матрицы «Сравнение
   версий», заметки загрузки в значке ⚠ (включая строку «Версии: …») и подсказка
   гранулярности в модалке подключения. Сетевые запросы к ClickHouse и
   backend-прокси подменены.

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

/* Три версии: у первой и третьей записи в сценариях есть, у второй — нет
   (проверка фолбэка на техническое имя). У второй и третьей в PostgreSQL нет
   схемы с independent_demand — загрузчик запишет заметки, и по ним видно, что
   расшифрованная версия подписана названием из сценариев, а нерасшифрованная —
   текущим техническим именем. */
const SCENARIOS = [
  { sys_id: '1', name: 'Версия осеннего плана' },
  { sys_id: '3', name: 'Версия после корректировки' },
];
const NAME_1 = 'Версия осеннего плана';
const NAME_3 = 'Версия после корректировки';
const DB_2 = 'data_public_2'; // без записи в сценариях — остаётся как есть
const DB_3 = 'data_public_3';

const DBS = {
  data_public_1: { grans: [[4, 100]], n: 1200, ts: '2026-09-10 08:00:00' },
  [DB_2]: { grans: [[4, 100]], n: 900, ts: '2026-09-11 09:00:00' },
  [DB_3]: { grans: [[4, 100]], n: 700, ts: '2026-09-12 10:00:00' },
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
const COV = { demUnc: 1200, ff: 950, uf: 250, inTime: 900, late: 50, lostRev: 120, planRev: 6000, prop: 1200 };
const COV_P = [{ k: '2026-09', demUnc: 1200, ff: 950, uf: 250, late: 50 }];
const UNC = { demUnc: 1300, n: 15 };
const UNC_P = [{ k: '2026-09', demUnc: 1300 }];
const BY_OP = {
  data_public_1: [{ t: 'production', c: 500, v: 48, n: 2 }],
  [DB_2]: [{ t: 'production', c: 700, v: 71, n: 3 }],
  [DB_3]: [{ t: 'production', c: 600, v: 55, n: 2 }],
};
const DIM = [{ k: '1', mar: 760, sal: 19, unm: 1, rev: 1900 }];
const ORDERS = [
  { id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1', dem: 400, sal: 380, unm: 20, price: 100, cpt: 60, mpt: 40, rev: 1900, cost: 1140, mar: 760, prio: 1, mph: 0 },
  { id: 102, p: '2', loc: 'L1', prod: 'P2', cl: 'C2', dtype: 1, stream: 'S1', dem: 600, sal: 520, unm: 80, price: 120, cpt: 70, mpt: 50, rev: 3480, cost: 2030, mar: 1450, prio: 2, mph: 0 },
];
const OPS = [
  { o: 101, p: '1', type: 'production', pl: 'L1', pr: 'P1', rs: 'R1', fr: '', to: '', tm: '', v: 19, r: 26, vd: '', rt: '1.1', oid: '101.1', rc: 0 },
];

/* PG-схемы: только public_1 есть в PostgreSQL — для остальных версий
   загрузчик запишет заметки с именами версий (их отображение проверяется в ⚠). */

function route(sql) {
  const dbm = sql.match(/`(data_public_\d+)`\./);
  const db = dbm && dbm[1];
  if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
  if (/FROM system\.databases/.test(sql))
    return [{ name: 'system' }, ...Object.keys(DBS).sort().map((name) => ({ name }))];
  if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
  if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
  if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
  if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
  if (/`operation_type` AS t/.test(sql)) return BY_OP[db] || [];
  if (/`o_p` AS k/.test(sql)) return DIM;
  if (/`o_prod` AS k/.test(sql)) return DIM;
  if (/`o_cl` AS k/.test(sql)) return DIM;
  if (/`independent_demand`/.test(sql))
    throw new Error('в ClickHouse таблицы independent_demand нет — дашборд обязан идти в PostgreSQL');
  if (/`lostrevenue`/.test(sql)) return [COV];
  if (/GROUP BY k ORDER BY k/.test(sql)) return COV_P;
  if (/calcavailablebucketcapacity/.test(sql)) return [];
  if (/netavailbucketcapacity/.test(sql)) return [];
  if (/`quota`/.test(sql)) return [];
  if (/nondelcostrate/.test(sql)) return [];
  if (/unfullfilleddemandqty/.test(sql) && /GROUP BY item/.test(sql)) return [];
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

async function boot() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle(400);
  const w = dom.window, d = w.document;
  w.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/pg/')) {
      const body = JSON.parse(String((opts && opts.body) || '{}'));
      if (u.includes('/api/pg/scenarios'))
        return { ok: true, status: 200, json: async () => ({ ok: true,
          database: 'pgs_app_metadata_db', schema: 'public', table: 'scenario',
          scenarios: SCENARIOS }) };
      if (u.includes('/api/pg/schemas'))
        return { ok: true, status: 200, json: async () => ({ ok: true,
          table: 'independent_demand',
          schemas: [{ schema: 'public_1', n: 15 }] }) };
      if (u.includes('/api/pg/unc')) {
        if (body.schema !== 'public_1')
          return { ok: false, status: 400, json: async () => ({ error: `Схема «${body.schema}»: таблица «independent_demand» не найдена или нет доступа.` }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, schema: body.schema,
          table: 'independent_demand', gran: 4, cols: { qty: 'demandqty' },
          keyCols: ['item'], distinct: true, ...UNC, periods: UNC_P }) };
      }
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
  d.querySelector(`input[data-db="${DB_2}"]`).click();
  await settle();
  d.querySelector(`input[data-db="${DB_3}"]`).click();
  await settle();
  d.getElementById('chmLoad').click();
  await waitFor(() => w.CHX.versions.length === 3, 20000, 'версии загружены');
  return { dom, w, d, close() { try { dom.window.close(); } catch { /* jsdom */ } } };
}

test('названия версий в шапке, сравнении и заметках загрузки — из таблицы сценариев', async (t) => {
  const ctx = await boot();
  t.after(ctx.close);
  const { w, d } = ctx;

  /* Версия с записью в сценариях — текстовое название; без записи — текущий
     вариант (техническое имя схемы). */
  const v1 = w.CHX.versions.find((v) => v.id === 'data_public_1');
  const v2 = w.CHX.versions.find((v) => v.id === DB_2);
  const v3 = w.CHX.versions.find((v) => v.id === DB_3);
  assert.equal(v1.label, NAME_1, 'labelFor берёт имя из сценариев');
  assert.equal(v3.label, NAME_3, 'labelFor берёт имя из сценариев и для второй расшифрованной версии');
  assert.equal(v2.label, DB_2, 'без записи в сценариях остаётся техническое имя');

  /* Шапка: активная версия подписана названием из сценариев */
  const cap = d.querySelector('#pgVer .hv-v');
  assert.equal(cap && cap.textContent.trim(), NAME_1,
    'в шапке активная версия показана текстовым названием из сценариев');

  /* Сравнение версий: колонки матрицы — названия из сценариев */
  w.go('vs');
  await waitFor(() => d.querySelector('#vsMat table thead'), 10000, 'матрица отрисована');
  const head = d.querySelector('#vsMat table thead').textContent;
  assert.ok(head.includes(NAME_1), 'колонка базовой версии подписана именем из сценариев');
  assert.ok(head.includes(NAME_3), 'вторая расшифрованная версия подписана именем из сценариев');
  assert.ok(head.includes(DB_2), 'версия без сценария показана техническим именем (фолбэк)');

  /* Заметки загрузки: имя версии в префиксе — из сценариев, а не схема */
  const noteOk = waitFor(() => !!w.document.getElementById('warnN'), 5000, 'значок ⚠ появился')
    .then(() => true).catch(() => false);
  assert.ok(await noteOk, 'у загрузки есть предупреждение (фолбэк версии без PG-схемы)');
  d.getElementById('bWarn').click();
  await waitFor(() => d.querySelector('#warnPop .warn-item'), 5000, 'панель ⚠ раскрыта');
  const pop = d.getElementById('warnPop').textContent;
  assert.ok(pop.includes(NAME_3),
    'в предупреждении расшифрованная версия названа именем из сценариев');
  assert.ok(!pop.includes(DB_3),
    'техническое имя расшифрованной версии в заметках не осталось');
  assert.ok(pop.includes(DB_2),
    'версия без записи в сценариях показана текущим вариантом — техническим именем');
  const versLines = [...d.querySelectorAll('#warnPop .wi-src')]
    .map((x) => x.textContent).filter((s) => s.startsWith('Версии:'));
  assert.ok(versLines.some((s) => s.includes(NAME_3)),
    'строка «Версии:» в панели ⚠ показывает текстовое название из сценариев');
  assert.ok(!versLines.some((s) => s.includes(DB_3)),
    'в строке «Версии:» нет технического имени расшифрованной версии');
});

test('подсказка гранулярности в модалке подключения называет основную версию из сценариев', async (t) => {
  const ctx = await boot();
  t.after(ctx.close);
  const { w, d } = ctx;
  w.CHX.openModal();
  await waitFor(() => d.getElementById('chmGran'), 5000, 'модалка открыта');
  const hints = [...d.querySelectorAll('.chm-hint')].map((x) => x.textContent).join(' ');
  assert.ok(hints.includes('набор периодов основной версии: ' + NAME_1),
    'подсказка гранулярности показывает название версии из сценариев');
  assert.ok(!hints.includes('набор периодов основной версии: data_public_1'),
    'техническое имя в подсказке не осталось');
});
