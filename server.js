'use strict';
/**
 * In.Plan dashboard — backend-прокси к PostgreSQL.
 *
 * Неограниченный спрос дашборда — это Σ demandqty таблицы independent_demand,
 * которая физически лежит в PostgreSQL (планировщик пишет результаты прогонов
 * в схемы public, public_2, …; в ClickHouse тем же прогонам соответствуют базы
 * data_public, data_public_2, …). Браузер не умеет открывать TCP к Postgres,
 * поэтому эти запросы обслуживает этот сервис. Эндпоинты:
 *
 *   GET  /api/health        — проверка, что backend жив (+ версия API и список
 *                             эндпоинтов: по ним дашборд отличает «нет backend»
 *                             от «backend устарел»)
 *   GET  /api/pg/defaults   — хост/порт/база по умолчанию для формы подключения
 *   POST /api/pg/schemas    — схемы, в которых есть таблица independent_demand
 *   POST /api/pg/unc        — агрегат неограниченного спроса схемы:
 *                             {schema, gran} → {demUnc, n, periods, qtySource,
 *                             diagnostics}
 *
 * Логин/пароль приходят в теле каждого запроса и нигде не сохраняются и не
 * логируются. Сервис также раздаёт статику дашборда (index.html, assets/),
 * поэтому страница и API работают на одном origin — CORS-проблем нет; для
 * открытых со статического хостинга страниц CORS разрешён («*», без cookies).
 *
 * Соответствие версий: база ClickHouse «data_public_2» ↔ схема Postgres
 * «public_2» (префикс data_ отрезается на фронтенде, регистр не важен).
 *
 * Для тестов DB-слой инжектится: createApp({connect}).
 * Запуск: npm start (PORT=8080, HOST=0.0.0.0 по умолчанию).
 */

const path = require('path');
const express = require('express');
const { Client } = require('pg');

const PG_DEFAULTS = {
  host: 'db-postgresql-app.k8s.b1gahmn2gdjf3lsm4jeh.in-plan.ru',
  port: 48235,
  database: 'pgs_app_data_db'       // точное имя продуктивной базы (владелец, 2026-10)
};
/* Фактическое имя таблицы в PostgreSQL — independent_demand. Старое слитное
   написание оставлено только как обратная совместимость для прежних выгрузок. */
const TABLE_NAME = 'independent_demand';
const TABLE_CANDIDATES = ['independent_demand', 'independentdemand'];
const MAX_SCHEMAS = 512;
/* Подпись сервиса в каждом ответе (в т.ч. в ошибках). По ней фронтенд
   отличает три разные ситуации, которые раньше сливались в «Not found»:
     • ответил не наш сервис (статика/ingress) → backend не запущен / не тот адрес;
     • ответил наш, но без нужного эндпоинта  → backend устарел, нужен npm start свежей версии;
     • ответил наш и с эндпоинтом             → настоящая ошибка Postgres. */
const SERVICE = 'inplan-dashboard';
const API_LEVEL = 5;
const ENDPOINTS = ['/api/health', '/api/pg/defaults', '/api/pg/schemas', '/api/pg/unc'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ── Идентификаторы и валидация входа: только квотирование/параметры ── */
function qi(ident) {
  if (typeof ident !== 'string' || !ident) throw new HttpError(400, 'Пустое имя схемы/таблицы/столбца.');
  if (ident.length > 128) throw new HttpError(400, 'Слишком длинное имя схемы/таблицы/столбца.');
  return '"' + ident.replace(/"/g, '""') + '"';
}
function asStr(v, field) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if (s.length > 512) throw new HttpError(400, `Поле «${field}» слишком длинное.`);
  return s;
}
function reqStr(v, field) {
  const s = asStr(v, field).trim();
  if (!s) throw new HttpError(400, `Заполните поле «${field}».`);
  return s;
}
function normalizeConn(body) {
  const b = body || {};
  const host = reqStr(b.host, 'Хост');
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new HttpError(400, 'Порт должен быть целым числом от 1 до 65535.');
  const database = reqStr(b.database, 'База данных');
  const user = reqStr(b.user, 'Логин');
  const password = b.password === undefined || b.password === null ? '' : String(b.password);
  const ssl = b.ssl === undefined || b.ssl === null || b.ssl === '' ? 'auto' : String(b.ssl);
  if (!['auto', 'off', 'insecure', 'strict'].includes(ssl))
    throw new HttpError(400, 'Некорректный режим SSL.');
  return { host, port, database, user, password, ssl };
}
function normalizeSchema(v) {
  const s = reqStr(v, 'Схема');
  if (s.length > 128) throw new HttpError(400, 'Слишком длинное имя схемы.');
  return s;
}
function normalizeGran(v) {
  const g = Number(v);
  if (!Number.isInteger(g) || g < 1 || g > 6)
    throw new HttpError(400, 'Гранулярность (periodtype) должна быть целым числом от 1 до 6.');
  return g;
}

/* ── Мэппинг столбцов independent_demand ─────────────────────────────────
   Продуктивная база (pgs_app_data_db), реальные столбцы:
     item, demandqty, periodid, sys_id, dmdstream, periodtype, demandtype,
     loc, update_date_time, change_author, unit, date, adjusteddemandqty.

   По уточнению владельца для расчёта нужны только бизнес-ключи строки:
     item, demandqty, periodid, dmdstream, periodtype, demandtype, loc, date.
   Технические/служебные поля sys_id, update_date_time, change_author, unit и
   adjusteddemandqty в SQL больше не используются. Это убирает зависимость от
   схемной «истории» записей: backend берёт DISTINCT по доступным ключевым
   столбцам и суммирует только demandqty. */
const COL_CANDIDATES = {
  item:        ['item'],
  qty:         ['demandqty', 'demand_qty'],
  periodid:    ['periodid', 'period_id'],
  dmdstream:   ['dmdstream', 'dmd_stream'],
  ptype:       ['periodtype', 'period_type'],
  dtype:       ['demandtype', 'demand_type'],
  loc:         ['loc', 'location'],
  date:        ['date', 'period_date']
};
function colIndex(columnNames) {
  const lower = new Map();
  for (const c of columnNames || []) {
    const k = String(c).toLowerCase();
    if (!lower.has(k)) lower.set(k, c);
  }
  return lower;
}
function mapColumns(columnNames, schemaName) {
  const lower = colIndex(columnNames);
  const mapped = {};
  for (const key of Object.keys(COL_CANDIDATES)) {
    const hit = COL_CANDIDATES[key].map(c => lower.get(c)).find(Boolean);
    mapped[key] = hit || null;
  }
  if (!mapped.qty) {
    const found = (columnNames && columnNames.length) ? columnNames.join(', ') : '—';
    throw new HttpError(
      400,
      `Схема «${schemaName}»: в таблице ${TABLE_NAME} нет колонки demandqty. Найдены: ${found}.`
    );
  }
  return mapped;
}

/* ── Дружелюбные тексты ошибок (коды node-pg) ── */
function isSslError(err) {
  if (!err) return false;
  if (['28P01', '28P04', '28000', '3D000'].includes(err.code)) return false;
  return /ssl/i.test(err.message || '');
}
function friendlyPgError(err, conn) {
  if (err instanceof HttpError) return err;
  const code = err && err.code;
  const where = conn && conn.host ? ` (${conn.host}:${conn.port || ''})` : '';
  if (code === '28P01' || code === '28P04' || code === '28000') {
    const who = conn && conn.user ? ` пользователя «${conn.user}»` : '';
    return new HttpError(401, `Неверный логин или пароль — Postgres отклонил аутентификацию${who}.`);
  }
  if (code === '3D000')
    return new HttpError(400, `База данных «${conn && conn.database}» не существует или недоступна.`);
  if (code === '42P01')
    return new HttpError(400, `Таблица ${TABLE_NAME} не найдена (или нет прав на неё).`);
  if (code === '42501' || code === '42000')
    return new HttpError(403, 'Недостаточно прав: пользователь не видит нужные схемы/таблицы.');
  if (code === 'ENOTFOUND') return new HttpError(502, `Хост «${conn && conn.host}» не найден (DNS).`);
  if (code === 'ECONNREFUSED')
    return new HttpError(502, `Нет соединения с ${conn && conn.host}:${conn && conn.port}${where}.`);
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EAI_AGAIN')
    return new HttpError(502, `Превышено время ожидания соединения${where}. Проверьте хост, порт и доступность сети.`);
  if (isSslError(err))
    return new HttpError(502, 'Ошибка SSL при подключении. Попробуйте другой режим SSL в форме подключения.');
  const raw = String((err && err.message) || '');
  if (/timeout expired|timed out/i.test(raw))
    return new HttpError(502, `Превышено время ожидания соединения${where}. Проверьте хост, порт и доступность сети.`);
  if (/connection terminated|connection reset|econnreset/i.test(raw))
    return new HttpError(502, `Соединение с сервером${where} разорвано. Проверьте хост/порт и режим SSL.`);
  if (/password authentication failed/i.test(raw))
    return new HttpError(401, 'Неверный логин или пароль — Postgres отклонил аутентификацию.');
  if (/database .* does not exist/i.test(raw))
    return new HttpError(400, `База данных «${conn && conn.database}» не существует или недоступна.`);
  return new HttpError(500, `Postgres: ${raw.slice(0, 400) || 'неизвестная ошибка'}`);
}

/* ── Подключение через node-pg (SSL-режимы как в opti) ── */
function sslConfig(mode) {
  if (mode === 'off') return false;
  if (mode === 'strict') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false }; // insecure
}
async function defaultConnect(conn) {
  const base = {
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    connectionTimeoutMillis: 15000,
    statement_timeout: 180000,
    application_name: 'inplan-dashboard'
  };
  const open = async mode => {
    const client = new Client({ ...base, ssl: sslConfig(mode) });
    await client.connect();
    return client;
  };
  let client;
  if (conn.ssl && conn.ssl !== 'auto') client = await open(conn.ssl);
  else {
    try { client = await open('insecure'); }
    catch (e) {
      if (isSslError(e)) client = await open('off');
      else throw e;
    }
  }
  return {
    query: (text, params) => client.query(text, params),
    close: () => client.end().catch(() => {})
  };
}

/* ── Столбцы таблицы схемы ── */
class TableMissing extends HttpError {
  constructor(schema) {
    super(400, `Схема «${schema}»: таблица «${TABLE_NAME}» не найдена или нет доступа.`);
    this.schema = schema;
  }
}
async function listColumns(db, schema, tableName = TABLE_NAME) {
  let res;
  try {
    res = await db.query(
      'SELECT table_name AS t, column_name AS c FROM information_schema.columns ' +
      'WHERE table_schema=$1 AND lower(table_name) IN ($2, $3) ORDER BY table_name, ordinal_position',
      [schema, TABLE_CANDIDATES[0], TABLE_CANDIDATES[1]]
    );
  } catch (e) {
    throw friendlyPgError(e, null);
  }
  const rows = res.rows || [];
  const actual = rows.length && rows[0].t ? String(rows[0].t) : tableName;
  const names = rows.filter(r => !r.t || String(r.t).toLowerCase() === actual.toLowerCase())
    .map(r => String(r.c));
  if (!names.length) throw new TableMissing(schema);
  return { names, tableName: actual };
}

/* ── Поиск схемы с independent_demand ─────────────────────────────────────
   Имя схемы дашборд выводит из имени базы ClickHouse (Data_public_4899 →
   public_4899). Регистр, префикс data_ и редкие расхождения в именовании
   не должны стоить пользователю «таблица недоступна»: если точного
   совпадения нет, ищем среди реальных схем базы — без учёта регистра, с
   префиксом/без него и по номеру версии (…_4899), когда он однозначен. */
async function listSchemaNames(db) {
  const r = await db.query(
    `SELECT table_schema AS s FROM information_schema.tables
      WHERE lower(table_name) IN ($1, $2)
        AND table_schema NOT IN ('pg_catalog','information_schema')
      UNION
      SELECT table_schema AS s FROM information_schema.views
      WHERE lower(table_name) IN ($1, $2)
        AND table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY 1`,
    TABLE_CANDIDATES
  );
  return (r.rows || []).map(x => String(x.s)).slice(0, MAX_SCHEMAS);
}
function schemaCandidates(wanted) {
  const s = String(wanted || '').trim();
  const bare = s.replace(/^data_/i, '');
  const out = [];
  for (const v of [s, bare, 'data_' + bare])
    if (v && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v);
  return out;
}
function matchSchema(names, wanted) {
  for (const cand of schemaCandidates(wanted)) {
    const hit = names.find(n => n.toLowerCase() === cand.toLowerCase());
    if (hit) return hit;
  }
  const num = (String(wanted || '').match(/(\d+)\s*$/) || [])[1];
  if (num) {
    const re = new RegExp('(^|[^0-9])' + num + '$');
    const hits = names.filter(n => re.test(n));
    if (hits.length === 1) return hits[0];
  }
  return null;
}
/* Ошибка «таблицы нет» с перечнем реально доступных схем: без него
   пользователь видел только «не найдена» и не знал, что именно искать. */
function tableMissingError(wanted, names, conn) {
  if (!names.length)
    return new HttpError(400,
      `Схема «${wanted}»: таблица «${TABLE_NAME}» не найдена или нет доступа. ` +
      `В базе «${conn && conn.database}» нет ни одной схемы с этой таблицей — ` +
      `проверьте имя базы (продуктивная: ${PG_DEFAULTS.database}) и права пользователя` +
      `${conn && conn.user ? ` «${conn.user}»` : ''}.`);
  const head = names.slice(0, 12).join(', ');
  return new HttpError(400,
    `Схема «${wanted}»: таблица «${TABLE_NAME}» не найдена или нет доступа. ` +
    `Схемы с этой таблицей (${names.length}): ${head}${names.length > 12 ? ', …' : ''}.`);
}

/* ── SQL агрегата неограниченного спроса ─────────────────────────────────
   Семантика independent_demand теперь привязана только к бизнес-ключу строки:
   item + demandqty + periodid + dmdstream + periodtype + demandtype + loc + date
   (берём те колонки, которые реально есть в схеме). Технические sys_id,
   update_date_time, change_author, unit и adjusteddemandqty не участвуют ни в
   фильтрах, ни в дедупликации, ни в выборе источника объёма.

   Фильтр periodtype применяется до DISTINCT. Ключи периодов совпадают с
   расчётом ClickHouse: неделя — дата понедельника, месяц/квартал/год —
   «YYYY-MM», день — дата. Поддерживаются столбцы date и целочисленный periodid
   (4YYYYMMDD, e.g. 420260401). */
function bucketKeyExpr(dateExpr, gran) {
  return `CASE
    WHEN ${dateExpr}::text ~ '^[0-9]{9}$' AND ${gran} IN (4, 5, 6)
      THEN substr(${dateExpr}::text, 2, 4) || '-' || substr(${dateExpr}::text, 6, 2)
    WHEN ${dateExpr}::text ~ '^[0-9]{9}$' AND ${gran} = 3
      THEN to_char(date_trunc('week', to_date(substr(${dateExpr}::text, 2), 'YYYYMMDD')), 'YYYY-MM-DD')
    WHEN ${dateExpr}::text ~ '^[0-9]{9}$'
      THEN substr(${dateExpr}::text, 2, 4) || '-' || substr(${dateExpr}::text, 6, 2) || '-' || substr(${dateExpr}::text, 8, 2)
    WHEN ${gran} = 3
      THEN to_char(date_trunc('week', ${dateExpr}::timestamp), 'YYYY-MM-DD')
    WHEN ${gran} IN (4, 5, 6)
      THEN to_char(${dateExpr}::timestamp, 'YYYY-MM')
    ELSE to_char(${dateExpr}::timestamp::date, 'YYYY-MM-DD')
  END`;
}
function uniq(arr) {
  const out = [];
  for (const v of arr || []) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
function independentDemandKeyCols(cols) {
  return uniq([
    cols.item, cols.qty, cols.periodid, cols.dmdstream,
    cols.ptype, cols.dtype, cols.loc, cols.date
  ]);
}
function uncSql(schema, cols, gran, tableName = TABLE_NAME) {
  const qty = cols.qty;
  if (!qty) throw new HttpError(400, `Схема «${schema}»: не выбрана колонка объёма спроса.`);
  const filters = [];
  const params = [];
  if (cols.ptype) {
    params.push(gran);
    filters.push(`${qi(cols.ptype)} = $${params.length}`);
  }

  const keyCols = independentDemandKeyCols(cols);
  const identityCols = uniq([cols.item, cols.periodid, cols.dmdstream, cols.dtype, cols.loc, cols.date]);
  const selectCols = keyCols.length ? keyCols : [qty];
  const distinct = identityCols.length > 0;
  let src = `SELECT ${distinct ? 'DISTINCT ' : ''}${selectCols.map(qi).join(', ')} FROM ${qi(schema)}.${qi(tableName)}`;
  if (filters.length) src += ` WHERE ${filters.join(' AND ')}`;

  const total = {
    sql: `SELECT sum(${qi(qty)}) AS demUnc, count(*)::bigint AS n FROM (${src}) s`,
    params
  };
  const periodCol = cols.date || cols.periodid;
  const periods = periodCol
    ? {
        sql: `SELECT ${bucketKeyExpr('s.' + qi(periodCol), gran)} AS k, sum(${qi(qty)}) AS demUnc ` +
             `FROM (${src}) s GROUP BY k ORDER BY k`,
        params
      }
    : null;
  return { total, periods, qty, keyCols, distinct };
}

/* ── Приложение ── */
function createApp(deps) {
  const connect = (deps && deps.connect) || defaultConnect;
  const app = express();
  /* CORS: дашборд может быть открыт со статического хостинга/file://, тогда
     запросы идут на этот backend с чужого origin. Куки не используются
     (пароль — в теле), «*» без credentials безопасно. */
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (req, res) => res.json({
    ok: true, time: new Date().toISOString(),
    service: SERVICE, api: API_LEVEL, table: TABLE_NAME, endpoints: ENDPOINTS
  }));
  app.get('/api/pg/defaults', (req, res) =>
    res.json({ ...PG_DEFAULTS, table: TABLE_NAME, service: SERVICE, api: API_LEVEL }));

  /** Схемы, в которых есть таблица independent_demand (+ оценка числа строк). */
  app.post('/api/pg/schemas', async (req, res, next) => {
    try {
      const conn = normalizeConn(req.body || {});
      let db;
      try { db = await connect(conn); }
      catch (e) { throw friendlyPgError(e, conn); }
      try {
        const t = await db.query(
          `SELECT x.s, st.n_live_tup::bigint AS n
             FROM (
               SELECT t.table_schema AS s, t.table_name AS t
                 FROM information_schema.tables t
                WHERE lower(t.table_name) = $1
                  AND t.table_schema NOT IN ('pg_catalog','information_schema')
               UNION
               SELECT v.table_schema AS s, v.table_name AS t
                 FROM information_schema.tables v
                WHERE lower(v.table_name) = $2
                  AND v.table_schema NOT IN ('pg_catalog','information_schema')
               UNION
               SELECT v.table_schema AS s, v.table_name AS t
                 FROM information_schema.views v
                WHERE lower(v.table_name) IN ($1, $2)
                  AND v.table_schema NOT IN ('pg_catalog','information_schema')
             ) x
             LEFT JOIN pg_stat_user_tables st
               ON st.schemaname = x.s AND lower(st.relname) = lower(x.t)
            ORDER BY 1`,
          TABLE_CANDIDATES
        );
        const schemas = (t.rows || []).slice(0, MAX_SCHEMAS)
          .map(r => ({ schema: String(r.s), n: Number(r.n) || 0 }));
        res.json({ ok: true, table: TABLE_NAME, database: conn.database, schemas,
                   service: SERVICE, api: API_LEVEL });
      } finally { await db.close(); }
    } catch (e) { next(e); }
  });

  /** Агрегат неограниченного спроса схемы: итог + помесячный разрез. */
  app.post('/api/pg/unc', async (req, res, next) => {
    try {
      const conn = normalizeConn(req.body || {});
      const wanted = normalizeSchema((req.body || {}).schema);
      const gran = normalizeGran((req.body || {}).gran);
      const exact = (req.body || {}).exact === true || (req.body || {}).exact === 'true';
      let db;
      try { db = await connect(conn); }
      catch (e) { throw friendlyPgError(e, conn); }
      try {
        /* Быстрый путь — запрошенная схема существует: лишних запросов нет.
           Иначе один раз спрашиваем реальный список схем с independent_demand
           и либо подбираем её (регистр / префикс data_ / номер версии),
           либо отвечаем ошибкой, в которой этот список перечислен. */
        let schema = wanted, names = null, cols, tableName = null;
        const discover = async s => {
          const found = await listColumns(db, s);
          return { cols: mapColumns(found.names, s), tableName: found.tableName };
        };
        try {
          ({ cols, tableName } = await discover(schema));
        } catch (e) {
          if (!(e instanceof TableMissing)) throw e;
          names = await listSchemaNames(db);
          /* exact=true — схему выбрал человек в модалке: молча подставлять
             другую нельзя, иначе показатель приедет из чужого прогона. */
          if (exact) throw tableMissingError(wanted, names, conn);
          const alt = matchSchema(names, wanted);
          if (!alt) throw tableMissingError(wanted, names, conn);
          schema = alt;
          ({ cols, tableName } = await discover(schema));
        }
        /* Каноническое бизнес-определение — demandqty таблицы independent_demand. */
        const q = uncSql(schema, cols, gran, tableName);
        let tot;
        try { tot = await db.query(q.total.sql, q.total.params); }
        catch (e) { throw friendlyPgError(e, conn); }
        const row = (tot.rows || [])[0] || {};
        const demUnc = Number(row.demUnc) || 0;
        const n = Number(row.n) || 0;

        let periods = [];
        if (q.periods) {
          try {
            const p = await db.query(q.periods.sql, q.periods.params);
            periods = (p.rows || []).map(r => ({ k: String(r.k), demUnc: Number(r.demUnc) || 0 }));
          } catch (e) { throw friendlyPgError(e, conn); }
        }
        res.json({
          ok: true, schema, requested: wanted, exact, table: tableName, gran,
          cols, keyCols: q.keyCols, distinct: q.distinct, qtySource: cols.qty,
          demUnc, n,
          diagnostics: {
            demandqty: { column: cols.qty, demUnc, n, keyCols: q.keyCols, distinct: q.distinct }
          },
          periods,
          service: SERVICE, api: API_LEVEL
        });
      } finally { await db.close(); }
    } catch (e) { next(e); }
  });

  /* Статика дашборда: один origin для страницы и API. */
  app.use(express.static(__dirname));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  /* 404 подписан сервисом: по подписи дашборд понимает, что ответил именно
     backend (значит, адрес верный, но версия старая), а не статика/ingress. */
  app.use((req, res) => res.status(404).json({
    ok: false,
    error: `Эндпоинт ${req.method} ${req.path} не найден. Backend In.Plan отвечает на: ${ENDPOINTS.join(', ')}.`,
    service: SERVICE, api: API_LEVEL, endpoints: ENDPOINTS
  }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = (err && err.status) || 500;
    res.status(status).json({
      ok: false, error: (err && err.message) || 'Internal error',
      service: SERVICE, api: API_LEVEL
    });
  });
  return app;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 8080;
  const HOST = process.env.HOST || '0.0.0.0';
  createApp().listen(PORT, HOST, () => {
    console.log(`In.Plan dashboard + PG-прокси → http://${HOST}:${PORT}`);
    console.log(`Открывайте дашборд ИМЕННО по этому адресу (http://localhost:${PORT}): страница,`);
    console.log('открытая со статического хостинга, не найдёт /api/pg/* и покажет предупреждение.');
    console.log(`Postgres по умолчанию: ${PG_DEFAULTS.host}:${PG_DEFAULTS.port} / ${PG_DEFAULTS.database} (таблица ${TABLE_NAME})`);
  });
}

module.exports = {
  createApp, defaultConnect,
  normalizeConn, normalizeSchema, normalizeGran,
  mapColumns, COL_CANDIDATES, uncSql, bucketKeyExpr, independentDemandKeyCols,
  schemaCandidates, matchSchema,
  qi, friendlyPgError, HttpError, PG_DEFAULTS, TABLE_NAME,
  SERVICE, API_LEVEL, ENDPOINTS
};
