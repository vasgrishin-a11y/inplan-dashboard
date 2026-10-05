/* ─────────────────────────────────────────────────────────────────────────────
   Тесты backend-прокси PostgreSQL (server.js): эндпоинты /api/pg/schemas и
   /api/pg/unc — SQL агрегата неограниченного спроса собирается по бизнес-ключам
   independent_demand (item/demandqty/periodid/dmdstream/periodtype/demandtype/loc/date),
   фильтрует periodtype и не зависит от технических колонок sys_id/update_date_time.

   DB-слой подменён: createApp({connect}) получает мок с записью вызовов.

   Запуск:  npm test
   ───────────────────────────────────────────────────────────────────────────── */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import srv from '../server.js';

const { createApp, uncSql, mapColumns, matchSchema, schemaCandidates, bucketKeyExpr } = srv;

const sq = (s) => s.replace(/\s+/g, ' ').trim();

async function withServer(handler, fn) {
  const calls = [];
  const connect = async () => ({
    async query(sql, params) {
      calls.push({ sql: sq(sql), params });
      return handler(sql, params);
    },
    async close() {}
  });
  const app = createApp({ connect });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, calls); }
  finally { await new Promise((r) => server.close(r)); }
}
const post = (base, p, body) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const CONN = { host: 'pg.test', port: 5432, database: 'db', user: 'u', password: 'p', ssl: 'auto' };
const FULL_COLS = ['item', 'demandqty', 'periodid', 'dmdstream', 'periodtype', 'demandtype', 'loc', 'date'];
/* Реальный список столбцов продуктивной таблицы (pgs_app_data_db) — сообщён владельцем */
const PROD_COLS = ['item', 'demandqty', 'periodid', 'sys_id', 'dmdstream', 'periodtype',
  'demandtype', 'loc', 'update_date_time', 'change_author', 'unit', 'date', 'adjusteddemandqty'];

/* ── Чистые юнит-проверки SQL-сборки ── */
test('uncSql: продуктивные колонки — DISTINCT по бизнес-ключу, основной объём demandqty', () => {
  const cols = mapColumns(PROD_COLS, 'public_2');
  assert.deepEqual(cols, { item: 'item', qty: 'demandqty', periodid: 'periodid',
                           dmdstream: 'dmdstream', ptype: 'periodtype',
                           dtype: 'demandtype', loc: 'loc', date: 'date' });
  const q = uncSql('public_2', cols, 4);
  assert.match(q.total.sql,
    /SELECT DISTINCT "item", "demandqty", "periodid", "dmdstream", "periodtype", "demandtype", "loc", "date" FROM "public_2"\."independent_demand" WHERE "periodtype" = \$1/,
    'periodtype фильтруется до дедупликации по ключевым столбцам');
  assert.ok(!/sys_id|update_date_time|change_author|unit|adjusteddemandqty|is_deleted/.test(q.total.sql),
    'технические и лишние столбцы не попадают в SQL');
  assert.match(q.total.sql, /sum\("demandqty"\) AS demUnc/);
  assert.equal(q.qty, 'demandqty');
  assert.deepEqual(q.keyCols, ['item','demandqty','periodid','dmdstream','periodtype','demandtype','loc','date']);
  assert.equal(q.distinct, true);
  assert.match(q.periods.sql, /s\."date"/, 'date используется для помесячного разреза, periodid остаётся ключом');
});

test('uncSql: полный набор ключевых колонок — periodtype до DISTINCT, ключи периодов', () => {
  const cols = mapColumns(FULL_COLS, 'public_2');
  const q = uncSql('public_2', cols, 4);
  assert.match(q.total.sql, /SELECT DISTINCT "item", "demandqty", "periodid", "dmdstream", "periodtype", "demandtype", "loc", "date" FROM "public_2"\."independent_demand" WHERE "periodtype" = \$1/);
  assert.deepEqual(q.total.params, [4]);
  assert.match(q.total.sql, /sum\("demandqty"\) AS demUnc/);
  assert.match(q.periods.sql, /s\."date"/);
});

test('uncSql: минимум колонок — ничего лишнего не добавляем', () => {
  const cols = mapColumns(['demandqty'], 's1');
  const q = uncSql('s1', cols, 4);
  assert.equal(q.total.sql, sq('SELECT sum("demandqty") AS demUnc, count(*)::bigint AS n FROM (SELECT "demandqty" FROM "s1"."independent_demand") s'));
  assert.deepEqual(q.total.params, []);
  assert.equal(q.periods, null, 'без колонки date/periodid периодный разрез не строится');
});

test('mapColumns: без demandqty — понятная ошибка с перечнем колонок', () => {
  assert.throws(() => mapColumns(['a', 'b'], 'public_2'),
    /нет колонки demandqty. Найдены: a, b/);
});

/* ── Эндпоинты ── */
test('GET /api/health и /api/pg/defaults', async () => {
  await withServer(() => ({ rows: [] }), async (base) => {
    const h = await (await fetch(base + '/api/health')).json();
    assert.equal(h.ok, true);
    /* подпись сервиса и перечень эндпоинтов: по ним дашборд отличает
       «backend не запущен» от «backend старой версии» */
    assert.equal(h.service, 'inplan-dashboard');
    assert.ok(h.api >= 2);
    assert.ok(h.endpoints.includes('/api/pg/unc'));
    const d = await (await fetch(base + '/api/pg/defaults')).json();
    assert.equal(d.database, 'pgs_app_data_db');
    assert.equal(d.table, 'independent_demand');
  });
});

test('404 неизвестного эндпоинта подписан сервисом (а не голым Not found)', async () => {
  await withServer(() => ({ rows: [] }), async (base) => {
    const r = await post(base, '/api/pg/nope', CONN);
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.equal(data.service, 'inplan-dashboard');
    assert.match(data.error, /не найден/);
    assert.ok(data.endpoints.includes('/api/pg/unc'), 'сервис перечисляет, что умеет');
  });
});

/* ── Подбор схемы: регистр, префикс data_, номер версии ── */
test('matchSchema: регистр, префикс data_ и номер версии', () => {
  const names = ['public_4899', 'public_4941', 'reporting'];
  assert.equal(matchSchema(names, 'public_4899'), 'public_4899');
  assert.equal(matchSchema(names, 'Public_4941'), 'public_4941', 'регистр не важен');
  assert.equal(matchSchema(names, 'data_public_4899'), 'public_4899', 'префикс data_ снимается');
  assert.equal(matchSchema(['pub_4899', 'reporting'], 'public_4899'), 'pub_4899',
    'однозначный номер версии подходит, когда имя схемы иное');
  assert.equal(matchSchema(['pub_4899', 'x_4899'], 'public_4899'), null,
    'номер версии неоднозначен — не угадываем');
  assert.equal(matchSchema(names, 'public_1'), null);
  assert.deepEqual(schemaCandidates('Data_public_2'), ['Data_public_2', 'public_2']);
});

test('POST /api/pg/unc — схема подбирается по регистру/префиксу (Data_public_4899 → public_4899)', async () => {
  const calls = [];
  await withServer((sql, params) => {
    if (/information_schema\.columns/.test(sql)) {
      calls.push(params[0]);
      /* таблица есть только в public_4899 — запрошенную «Data_public_4899» PG не знает */
      return params[0] === 'public_4899' ? { rows: PROD_COLS.map((c) => ({ c })) } : { rows: [] };
    }
    if (/information_schema\.tables/.test(sql)) return { rows: [{ s: 'public_4899' }, { s: 'public_4941' }] };
    if (/count\(\*\)::bigint/.test(sql)) return { rows: [{ demUnc: 777, n: 7 }] };
    return { rows: [] };
  }, async (base) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, schema: 'Data_public_4899', gran: 4 });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.schema, 'public_4899', 'ответ сообщает фактическую схему');
    assert.equal(data.requested, 'Data_public_4899');
    assert.equal(data.demUnc, 777);
    assert.deepEqual(calls, ['Data_public_4899', 'public_4899'], 'сначала как просили, потом подобранная');
  });
});

test('POST /api/pg/unc — exact=true (схему выбрал человек): подмены схемы нет', async () => {
  await withServer((sql) => {
    if (/information_schema\.columns/.test(sql)) return { rows: [] };          // в выбранной схеме таблицы нет
    if (/information_schema\.tables/.test(sql)) return { rows: [{ s: 'public_4899' }] };
    return { rows: [] };
  }, async (base) => {
    /* без exact номер версии подобрал бы public_4899 — с exact получаем ошибку */
    const r = await post(base, '/api/pg/unc', { ...CONN, schema: 'public_4899x', gran: 4, exact: true });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /public_4899/, 'в ошибке — что есть на самом деле');
  });
});

test('POST /api/pg/unc — схемы нет: ошибка перечисляет доступные схемы', async () => {
  await withServer((sql) => {
    if (/information_schema\.tables/.test(sql)) return { rows: [{ s: 'public_12' }, { s: 'public_13' }] };
    return { rows: [] };
  }, async (base) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, schema: 'public_4899', gran: 4 });
    assert.equal(r.status, 400);
    const err = (await r.json()).error;
    assert.match(err, /не найдена или нет доступа/);
    assert.match(err, /public_12, public_13/, 'видно, какие схемы есть на самом деле');
  });
});

test('POST /api/pg/unc — в базе вообще нет схем с independent_demand: подсказка про базу и права', async () => {
  await withServer(() => ({ rows: [] }), async (base) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, database: 'wrong_db', schema: 'public_1', gran: 4 });
    assert.equal(r.status, 400);
    const err = (await r.json()).error;
    assert.match(err, /нет ни одной схемы с этой таблицей/);
    assert.match(err, /pgs_app_data_db/, 'названа продуктивная база');
    assert.match(err, /«u»/, 'назван пользователь, у которого может не быть прав');
  });
});

test('POST /api/pg/schemas — схемы с independent_demand', async () => {
  await withServer((sql) => {
    if (/information_schema\.tables/.test(sql)) return { rows: [{ s: 'public_2', n: 12 }, { s: 'public_5', n: 7 }] };
    throw new Error('нет таблицы для ' + sql);
  }, async (base, calls) => {
    const r = await post(base, '/api/pg/schemas', CONN);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.deepEqual(data.schemas, [{ schema: 'public_2', n: 12 }, { schema: 'public_5', n: 7 }]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /lower\(t\.table_name\) = \$1/);
  });
});

test('POST /api/pg/unc — итог по Σ demandqty и помесячный разрез', async () => {
  await withServer((sql) => {
    if (/information_schema\.columns/.test(sql)) return { rows: FULL_COLS.map((c) => ({ c })) };
    if (/count\(\*\)::bigint/.test(sql)) return { rows: [{ demUnc: 1500.5, n: 12 }] };
    if (/GROUP BY k ORDER BY k/.test(sql)) return { rows: [{ k: '2026-09', demUnc: 900 }, { k: '2026-10', demUnc: 600.5 }] };
    return { rows: [] };
  }, async (base, calls) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, schema: 'public_2', gran: 4 });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.demUnc, 1500.5);
    assert.equal(data.n, 12);
    assert.deepEqual(data.periods, [{ k: '2026-09', demUnc: 900 }, { k: '2026-10', demUnc: 600.5 }]);
    assert.equal(data.cols.qty, 'demandqty');
    const totalCall = calls.find((c) => /count\(\*\)::bigint/.test(c.sql));
    assert.ok(totalCall, 'итоговый запрос выполнен');
    assert.deepEqual(totalCall.params, [4]);
    /* схема попадает в SQL только квотированной */
    assert.match(totalCall.sql, /"public_2"\."independent_demand"/);
  });
});

test('POST /api/pg/unc — нулевой demandqty возвращает demUnc=0 без маскировки', async () => {
  await withServer((sql) => {
    if (/information_schema\.columns/.test(sql)) return { rows: PROD_COLS.map((c) => ({ c })) };
    if (/count\(\*\)::bigint/.test(sql)) return { rows: [{ demUnc: 0, n: 210 }] };
    if (/GROUP BY k ORDER BY k/.test(sql)) return { rows: [] };
    return { rows: [] };
  }, async (base) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, schema: 'public_2', gran: 4 });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.demUnc, 0);
    assert.equal(data.n, 210);
    assert.equal(data.qtySource, 'demandqty');
    assert.equal(data.diagnostics.demandqty.demUnc, 0);
  });
});

test('POST /api/pg/unc — populated rows recover a false zero from the PG aggregate', async () => {
  await withServer((sql) => {
    if (/information_schema\.columns/.test(sql)) return { rows: PROD_COLS.map((c) => ({ c })) };
    if (/count\(\*\)::bigint/.test(sql)) return { rows: [{ demUnc: 0, n: 210 }] };
    if (/AS value/.test(sql)) return {
      rows: [
        { value: '12,5', k: '2026-04' },
        { value: '7.5', k: '2026-04' },
      ]
    };
    throw new Error('period aggregate must not be used after row recovery');
  }, async (base) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, schema: 'public_4941', gran: 4 });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.demUnc, 20, 'Σ demandqty восстановлена по тем же 210 строкам');
    assert.equal(data.n, 210, 'число строк остаётся диагностикой дедуплированного источника');
    assert.equal(data.periods[0].demUnc, 20, 'периодный разрез использует ту же сумму');
    assert.equal(data.qtySource, 'demandqty');
    assert.equal(data.diagnostics.demandqty.recovered, true);
    assert.equal(data.diagnostics.demandqty.raw.numericN, 2);
  });
});

test('POST /api/pg/unc — value-only recovery не зависит от bucket date/periodid', async () => {
  const values = Array.from({ length: 210 }, (_, i) => ({ value: i === 0 ? '10000' : '0' }));
  await withServer((sql) => {
    if (/information_schema\.columns/.test(sql)) return { rows: PROD_COLS.map((c) => ({ c })) };
    if (/count\(\*\)::bigint/.test(sql)) return { rows: [{ demUnc: 0, n: 210 }] };
    if (/AS value FROM/.test(sql)) return { rows: values };
    if (/AS value, CASE/.test(sql)) return {
      rows: [{ value: '10000', k: '2026-04' }],
    };
    throw new Error('period aggregate must not replace row-level recovery');
  }, async (base) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, schema: 'public_4941', gran: 4 });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.demUnc, 10000, 'значение demandqty из 210 строк не теряется');
    assert.equal(data.n, 210);
    assert.equal(data.periods[0].demUnc, 10000);
    assert.equal(data.diagnostics.demandqty.recovered, true);
  });
});

test('POST /api/pg/unc — таблица без demandqty в схеме → 400 с объяснением', async () => {
  await withServer((sql) => {
    if (/information_schema\.columns/.test(sql)) return { rows: [{ c: 'x' }, { c: 'y' }] };
    return { rows: [] };
  }, async (base) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, schema: 'public_2', gran: 4 });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(data.error, /нет колонки demandqty/);
  });
});

test('POST /api/pg/unc — несуществующая схема → 400 «таблица не найдена»', async () => {
  await withServer(() => ({ rows: [] }), async (base) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, schema: 'no_such', gran: 4 });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /не найдена или нет доступа/);
  });
});

test('POST /api/pg/unc — имя схемы с кавычкой экранируется (защита от SQL-инъекции)', async () => {
  await withServer((sql) => {
    if (/information_schema\.columns/.test(sql)) return { rows: [{ c: 'demandqty' }] };
    if (/count\(\*\)::bigint/.test(sql)) return { rows: [{ demUnc: 1, n: 1 }] };
    return { rows: [] };
  }, async (base, calls) => {
    await post(base, '/api/pg/unc', { ...CONN, schema: 'we"ird', gran: 4 });
    const totalCall = calls.find((c) => /count\(\*\)::bigint/.test(c.sql));
    assert.match(totalCall.sql, /"we""ird"\."independent_demand"/);
  });
});

test('POST /api/pg/unc — валидация входа: плохая гранулярность и пустой логин', async () => {
  await withServer(() => ({ rows: [] }), async (base) => {
    let r = await post(base, '/api/pg/unc', { ...CONN, schema: 'public_2', gran: 9 });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Гранулярность/);
    r = await post(base, '/api/pg/unc', { ...CONN, user: '', schema: 'public_2', gran: 4 });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Логин/);
  });
});

test('дружелюбные ошибки: 28P01 → 401 «неверный логин или пароль»', async () => {
  const connect = async () => { const e = new Error('password authentication failed'); e.code = '28P01'; throw e; };
  const app = createApp({ connect });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await post(base, '/api/pg/schemas', CONN);
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /Неверный логин или пароль/);
  } finally { await new Promise((r) => server.close(r)); }
});

test('статика: / отдаёт index.html дашборда', async () => {
  await withServer(() => ({ rows: [] }), async (base) => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  });
});
