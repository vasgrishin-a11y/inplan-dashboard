/* ─────────────────────────────────────────────────────────────────────────────
   Тесты backend-прокси PostgreSQL (server.js): эндпоинты /api/pg/schemas и
   /api/pg/unc — SQL агрегата неограниченного спроса собирается по правилам
   ClickHouse-семантики (is_deleted=0, дедуп по sys_id, фильтр periodtype,
   ключи периодов как у дашборда), а колонки, которых нет в схеме, аккуратно
   отключают свои части запроса вместо падения.

   DB-слой подменён: createApp({connect}) получает мок с записью вызовов.

   Запуск:  npm test
   ───────────────────────────────────────────────────────────────────────────── */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import srv from '../server.js';

const { createApp, uncSql, mapColumns, matchSchema, schemaCandidates } = srv;

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
const FULL_COLS = ['sys_id', 'is_deleted', 'update_date_time', 'date', 'periodtype', 'demandqty'];
/* Реальный список столбцов продуктивной таблицы (pgs_app_data_db) — сообщён владельцем */
const PROD_COLS = ['item', 'demandqty', 'periodid', 'sys_id', 'dmdstream', 'periodtype',
  'demandtype', 'loc', 'update_date_time', 'change_author', 'unit', 'date', 'adjusteddemandqty'];

/* ── Чистые юнит-проверки SQL-сборки ── */
test('uncSql: продуктивные колонки — дедуп по sys_id, фильтра is_deleted нет, объём — demandqty', () => {
  const cols = mapColumns(PROD_COLS, 'public_2');
  assert.deepEqual(cols, { qty: 'demandqty', ptype: 'periodtype', date: 'date',
                           sysId: 'sys_id', upd: 'update_date_time', del: null });
  const q = uncSql('public_2', cols, 4);
  assert.match(q.total.sql,
    /DISTINCT ON \("sys_id"\) \* FROM \(SELECT \* FROM "public_2"\."independentdemand"\) d ORDER BY "sys_id", "update_date_time" DESC/,
    'строки дедуплицируются по последней версии записи, внутренний запрос — без WHERE');
  assert.ok(!/is_deleted/.test(q.total.sql), 'фильтра удалённых нет — колонки не существует');
  assert.ok(!/adjusteddemandqty/.test(q.total.sql) && !/adjusteddemandqty/.test(q.periods.sql),
    'скорректированный объём в показатель НЕ входит: по определению владельца — demandqty');
  assert.match(q.total.sql, /sum\("demandqty"\) AS demUnc/);
  assert.match(q.periods.sql, /s WHERE "periodtype" = \$1/);
});
test('uncSql: полный набор колонок — дедуп, фильтр periodtype, ключи периодов', () => {
  const cols = mapColumns(FULL_COLS, 'public_2');
  const q = uncSql('public_2', cols, 4);
  assert.match(q.total.sql, /SELECT DISTINCT ON \("sys_id"\) \* FROM \(SELECT \* FROM "public_2"\."independentdemand" WHERE COALESCE\("is_deleted"::text, '0'\) IN \('0','false','f'\)\) d ORDER BY "sys_id", "update_date_time" DESC/);
  assert.match(q.total.sql, /s WHERE "periodtype" = \$1/);
  assert.deepEqual(q.total.params, [4]);
  assert.match(q.total.sql, /sum\("demandqty"\) AS demUnc/);
  assert.match(q.periods.sql, /to_char\(s\."date"::timestamp, 'YYYY-MM'\) AS k/);
  /* неделя — ключ даты понедельника, как toMonday в ClickHouse */
  const q3 = uncSql('public_2', cols, 3);
  assert.match(q3.periods.sql, /date_trunc\('week', s\."date"::timestamp\), 'YYYY-MM-DD'/);
});

test('uncSql: минимум колонок — ничего лишнего не добавляем', () => {
  const cols = mapColumns(['demandqty'], 's1');
  const q = uncSql('s1', cols, 4);
  assert.equal(q.total.sql, sq('SELECT sum("demandqty") AS demUnc, count(*)::bigint AS n FROM (SELECT * FROM "s1"."independentdemand") s'));
  assert.deepEqual(q.total.params, []);
  assert.equal(q.periods, null, 'без колонки date периодный разрез не строится');
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
    assert.equal(d.table, 'independentdemand');
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

test('POST /api/pg/unc — в базе вообще нет схем с independentdemand: подсказка про базу и права', async () => {
  await withServer(() => ({ rows: [] }), async (base) => {
    const r = await post(base, '/api/pg/unc', { ...CONN, database: 'wrong_db', schema: 'public_1', gran: 4 });
    assert.equal(r.status, 400);
    const err = (await r.json()).error;
    assert.match(err, /нет ни одной схемы с этой таблицей/);
    assert.match(err, /pgs_app_data_db/, 'названа продуктивная база');
    assert.match(err, /«u»/, 'назван пользователь, у которого может не быть прав');
  });
});

test('POST /api/pg/schemas — схемы с independentdemand', async () => {
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
    assert.match(totalCall.sql, /"public_2"\."independentdemand"/);
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
    assert.match(totalCall.sql, /"we""ird"\."independentdemand"/);
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
