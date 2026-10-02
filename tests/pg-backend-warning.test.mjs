/* ─────────────────────────────────────────────────────────────────────────────
   Регрессия по жалобе пользователя (2026-10-02):

   1) «Data_public_4899 → independentdemand недоступна (PG: Not found)» —
      дашборд был открыт НЕ с server.js, поэтому POST /api/pg/* упирался в
      статический хостинг и получал его собственный 404 «Not found». Теперь
      такой ответ распознаётся: сообщение называет адрес, по которому нет
      backend-прокси, и что с этим делать (npm start / поле «Backend»).

   2) Эти длинные красные тексты больше не печатаются в шапке: там остаётся
      короткий итог загрузки, а предупреждения уходят в значок ⚠ (#bWarn),
      который появляется только при проблемах и раскрывает детали по клику.

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

const DBS = { data_public_4899: { grans: [[4, 100]], n: 1200, ts: '2026-10-01 08:00:00' } };
const COLS = [
  'order_id','order_operation_id','resource','demand_period','demand_product',
  'demand_client','demand_location','demand_volume','results_sale','unsatisfied_demand',
  'revenue','cost_of_demand','total_margin','margin_per_unit','price','cost_per_unit_order',
  'demand_demandtype','dmdstream','demand_demandtypepriority','margin_per_hour','operation_type',
  'location','product','loc_from','loc_to','transport_type','order_operation_volume',
  'cost_rate_of_operation','supplier','bom_num',
];
const ORDERS_TOT = { orders: 1, rev: 1900, cost: 1140, mar: 760, dem: 400, sal: 380, unm: 20, lm: 10, full: 0 };
const COV = { demUnc: 1200, ff: 950, uf: 250, inTime: 850, late: 50, lostRev: 120, planRev: 6000, prop: 1200 };
const ORDERS = [{ id: 101, p: '1', loc: 'L1', prod: 'P1', cl: 'C1', dtype: 1, stream: 'S1',
  dem: 400, sal: 380, unm: 20, price: 100, cpt: 60, mpt: 40, rev: 1900, cost: 1140, mar: 760, prio: 1, mph: 0 }];

function routeCH(sql) {
  const dbm = sql.match(/`(data_public_\d+)`\./);
  const db = dbm && dbm[1];
  if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
  if (/FROM system\.databases/.test(sql)) return [{ name: 'system' }, ...Object.keys(DBS).map((name) => ({ name }))];
  if (/FROM system\.columns/.test(sql)) return COLS.map((name) => ({ name }));
  if (/max\(update_date_time\)/.test(sql) && db && DBS[db]) return [{ n: DBS[db].n, ts: DBS[db].ts }];
  if (/SELECT periodtype AS t/.test(sql)) return db && DBS[db] ? DBS[db].grans.map(([t, n]) => ({ t, n })) : [];
  if (/count\(\) AS orders/.test(sql)) return [ORDERS_TOT];
  if (/`lostrevenue`/.test(sql)) return [COV];
  if (/SELECT order_id AS id/.test(sql)) return ORDERS;
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

/* Хостинг без backend: на любой /api/* отвечает своим JSON-404 «Not found» —
   ровно то, что пользователь увидел в проде. */
async function loadWithoutBackend(t) {
  const { w, d } = await boot(t);
  const pgUrls = [];
  w.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/')) {
      pgUrls.push(u);
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    }
    const rows = routeCH(String((opts && opts.body) || ''));
    return { ok: true, status: 200, text: async () => rows.map((r) => JSON.stringify(r)).join('\n') };
  };
  w.PGX.cfg.user = 'reader';
  w.PGX.cfg.password = 'secret';

  await w.CHX.connect();
  w.CHX.cfg.schemas = ['data_public_4899'];
  w.CHX.cfg.base = 'data_public_4899';
  const res = await w.CHX.loadAll();
  return { w, d, res, pgUrls };
}

test('нет backend-прокси: вместо «Not found» — адрес и что сделать', async (t) => {
  const { w, res, pgUrls } = await loadWithoutBackend(t);

  const notes = res.notes.join(' ');
  assert.match(notes, /independentdemand недоступна/, 'фолбэк на demand_coverage объяснён');
  assert.ok(!/PG: Not found/.test(notes), 'чужое «Not found» не показываем как ошибку Postgres: ' + notes);
  assert.match(notes, /нет backend-прокси/, 'названа настоящая причина');
  assert.match(notes, /localhost:8080/, 'назван адрес, по которому стучались');
  assert.ok(notes.length < 320, 'заметка короткая: «что делать» живёт в значке, а не в тексте');
  assert.ok(pgUrls.some((u) => u.includes('/api/health')), 'backend сначала ищется по /api/health');

  /* стадия зафиксирована — значок покажет подсказку именно про backend */
  assert.equal(w.PGX.state.backendOk, false);
  assert.equal(w.PGX.state.stage, 'backend');
  const problem = w.PGX.problem();
  assert.equal(problem.stage, 'backend');
  assert.match(problem.hint, /npm start|Backend/);

  /* данные при этом загрузились: спрос — фолбэком из demand_coverage */
  const v = w.CHX.versions[0];
  assert.equal(v.agg.totals.uncSrc, 'demand_coverage');
  assert.equal(v.agg.totals.cov.demUnc, 1200);
});

test('шапка без красных простыней: предупреждения — в значке ⚠', async (t) => {
  const { w, d, res } = await loadWithoutBackend(t);

  /* как это делает модалка после загрузки */
  const stat = d.getElementById('stat');
  stat.innerHTML = `<span class="pos">ClickHouse:</span> ${res.ds.name}`;
  w.setLoadWarnings(res.notes);

  assert.ok(!/independentdemand недоступна/.test(stat.textContent),
    'в шапке больше нет длинного красного текста: ' + stat.textContent);
  assert.equal(stat.querySelectorAll('.neg').length, 0, 'красных блоков в шапке нет');

  const wrap = d.getElementById('warnWrap');
  assert.ok(wrap.classList.contains('on'), 'значок предупреждения показан');
  assert.equal(d.getElementById('warnN').textContent, '1', 'счётчик предупреждений');
  assert.ok(/Предупреждени/.test(d.getElementById('bWarn').getAttribute('data-tip')));

  /* детали — только по клику */
  const pop = d.getElementById('warnPop');
  assert.ok(!pop.classList.contains('open'), 'панель закрыта по умолчанию');
  d.getElementById('bWarn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(pop.classList.contains('open'), 'клик раскрывает детали');
  assert.match(pop.textContent, /independentdemand недоступна/);
  assert.match(pop.textContent, /нет backend-прокси/, 'причина в панели');
  assert.match(pop.textContent, /data_public_4899/, 'перечислены затронутые версии');
  assert.match(pop.textContent, /Что сделать/, 'есть подсказка по backend');

  /* закрытие: крестик и Escape */
  d.getElementById('warnX').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok(!pop.classList.contains('open'));

  /* успешная загрузка без заметок убирает значок совсем */
  w.setLoadWarnings([]);
  assert.ok(!wrap.classList.contains('on'), 'без проблем значка в шапке нет');
});

test('одинаковая причина у разных версий схлопывается в одно предупреждение', async (t) => {
  const { w, d } = await boot(t);
  const n = w.setLoadWarnings([
    'data_public_4899 → independentdemand недоступна (PG: нет backend-прокси) — неограниченный спрос показан как покрытый + непокрытый из demand_coverage',
    'data_public_4941 → independentdemand недоступна (PG: нет backend-прокси) — неограниченный спрос показан как покрытый + непокрытый из demand_coverage',
    'data_public_4941 → demand_cost: таблица не найдена',
  ]);
  assert.equal(n, 2, 'две разные причины, а не три строки');
  d.getElementById('bWarn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const items = [...d.querySelectorAll('#warnPop .warn-item')];
  assert.ok(items.length >= 2);
  assert.match(items[0].textContent, /data_public_4899, data_public_4941/, 'версии перечислены вместе');
  assert.equal(d.getElementById('warnN').textContent, '2');
});

test('ошибка самого Postgres остаётся текстом Postgres (а не советом про backend)', async (t) => {
  const { w } = await boot(t);
  w.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/health'))
      return { ok: true, status: 200, json: async () => ({ ok: true, service: 'inplan-dashboard', api: 2, endpoints: ['/api/pg/unc'] }) };
    if (u.includes('/api/pg/schemas'))
      return { ok: true, status: 200, json: async () => ({ ok: true, service: 'inplan-dashboard', schemas: [{ schema: 'public_4899', n: 5 }] }) };
    return { ok: false, status: 400, json: async () => ({ ok: false, service: 'inplan-dashboard',
      error: 'Схема «public_4941»: таблица «independentdemand» не найдена или нет доступа. Схемы с этой таблицей (1): public_4899.' }) };
  };
  w.PGX.cfg.user = 'reader';
  await assert.rejects(() => w.PGX.uncFor('Data_public_4941', 4), /Схемы с этой таблицей/);
  assert.equal(w.PGX.state.stage, 'pg', 'это проблема данных, а не адреса backend');
  const p = w.PGX.problem();
  assert.match(p.title, /PostgreSQL/);
  assert.equal(p.hint, '', 'совет про npm start здесь не нужен');
  /* сопоставление версий и схем для модалки */
  const map = w.PGX.schemaPlan(['Data_public_4899', 'data_public_4941']);
  assert.deepEqual(map.map((m) => [m.db, m.schema, m.ok]), [
    ['Data_public_4899', 'public_4899', true],
    ['data_public_4941', 'public_4941', false],
  ]);
});

/* ── Ручное соответствие «версия CH → схема PG» ──────────────────────────────
   Нумерация прогонов ClickHouse и схем Postgres совпадает не всегда: в CH
   выбраны data_public_4899/4941, а схемы в PG — public_13…public_1726 и далее.
   Автоподбор по имени тогда промахивается, и версия должна получить схему из
   ручного соответствия (оно же переживает перезагрузку страницы). */
async function pgReady(t, schemas) {
  const { w, d } = await boot(t);
  w.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/health'))
      return { ok: true, status: 200, json: async () => ({ ok: true, service: 'inplan-dashboard', api: 2, endpoints: ['/api/pg/unc'] }) };
    if (u.includes('/api/pg/schemas'))
      return { ok: true, status: 200, json: async () => ({ ok: true, service: 'inplan-dashboard', schemas }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, service: 'inplan-dashboard', schema: 'x', demUnc: 0, n: 0, periods: [] }) };
  };
  w.PGX.cfg.user = 'reader';
  await w.PGX.ensureSchemas();
  return { w, d };
}

test('схема выбирается вручную, когда номера CH и PG не совпадают', async (t) => {
  const SCHEMAS = [{ schema: 'public', n: 10 }, { schema: 'public_1494', n: 24581 }, { schema: 'public_1726', n: 19725 }];
  const { w } = await pgReady(t, SCHEMAS);

  /* автоподбор честно промахивается — версия ушла бы в demand_coverage */
  let plan = w.PGX.schemaPlan(['Data_public_4899']);
  assert.deepEqual(plan.map((m) => [m.schema, m.ok, m.manual]), [['public_4899', false, false]]);

  /* пользователь выбирает схему руками */
  w.PGX.setSchemaOverride('Data_public_4899', 'public_1494');
  assert.equal(w.PGX.pgSchemaFor('Data_public_4899'), 'public_1494');
  plan = w.PGX.schemaPlan(['Data_public_4899']);
  assert.deepEqual(plan.map((m) => [m.schema, m.ok, m.manual]), [['public_1494', true, true]]);

  /* запрос ушёл именно в выбранную схему */
  let sent = null;
  const prev = w.fetch;
  w.fetch = async (url, opts) => {
    if (String(url).includes('/api/pg/unc')) sent = JSON.parse(String(opts.body));
    return prev(url, opts);
  };
  await w.PGX.uncFor('Data_public_4899', 4);
  assert.equal(sent.schema, 'public_1494');

  /* выбор сохранён в автосессии и переживает перезагрузку страницы */
  assert.match(w.localStorage.getItem('inplan_pg_session_v1'), /public_1494/);
  w.PGX.cfg.schemaMap = {};
  assert.equal(w.PGX.restoreSession(), true);
  assert.equal(w.PGX.cfg.schemaMap['data_public_4899'], 'public_1494', 'восстановлено из автосессии');
  assert.equal(w.PGX.pgSchemaFor('Data_public_4899'), 'public_1494');

  /* сброс в «авто» пустым значением */
  w.PGX.setSchemaOverride('Data_public_4899', '');
  assert.equal(w.PGX.pgSchemaFor('Data_public_4899'), 'public_4899');
});

test('модалка показывает соответствие версий и схем PG со списком для выбора', async (t) => {
  const SCHEMAS = [{ schema: 'public_1494', n: 24581 }, { schema: 'public_4941', n: 19725 }];
  const { w, d } = await pgReady(t, SCHEMAS);
  w.CHX.cfg.schemas = ['Data_public_4899', 'Data_public_4941'];
  w.CHX.openModal();
  await settle(80);

  const sels = [...d.querySelectorAll('select[data-pgmap]')];
  assert.equal(sels.length, 2, 'по строке на выбранную версию');
  assert.deepEqual(sels.map((s) => s.dataset.pgmap), ['Data_public_4899', 'Data_public_4941']);
  /* в списке — все схемы PG с оценкой строк */
  assert.match(sels[0].innerHTML, /public_1494/);
  assert.match(sels[0].innerHTML, /24(&nbsp;|\s)581/, 'в списке видно, сколько строк в схеме');
  /* промах автоподбора виден прямо в строке */
  const rows = [...d.querySelectorAll('#chModal .chm-row')].map((r) => r.textContent.replace(/\s+/g, ' '));
  assert.ok(rows.some((r) => /нет схемы «public_4899»/.test(r)), 'промах назван: ' + rows.join(' | '));
  assert.ok(rows.some((r) => /✓ public_4941/.test(r)), 'попадание отмечено');

  /* выбор в списке сразу привязывает схему */
  sels[0].value = 'public_1494';
  sels[0].dispatchEvent(new w.Event('change'));
  await settle(50);
  assert.equal(w.PGX.pgSchemaFor('Data_public_4899'), 'public_1494');
  const after = [...d.querySelectorAll('#chModal .chm-row')].map((r) => r.textContent.replace(/\s+/g, ' '));
  assert.ok(after.some((r) => /✓ public_1494 \(вручную\)/.test(r)), 'подпись обновилась: ' + after.join(' | '));
});
