/* ═══════════════════════════════════════════════════════════════════════════
   In.Plan · PostgreSQL-коннектор (неограниченный спрос из independentdemand)
   Зачем отдельное подключение: таблица independentdemand физически лежит в
   PostgreSQL, а не в ClickHouse. Браузер не умеет открывать TCP к Postgres,
   поэтому запросы идут через backend-прокси (server.js этого репозитория,
   POST /api/pg/schemas и /api/pg/unc) — как в дашборде opti.

   Соответствие версий: база ClickHouse «data_public_2» ↔ схема Postgres
   «public_2» (снимается префикс data_, регистр не важен; список схем, где
   есть independentdemand, приходит от backend и служит справочником имён).

   Зависимости: только fetch/localStorage. CHX (assets/inplan-ch.js) вызывает
   PGX.enabled() и PGX.uncFor() внутри loadVersionAgg.
   ВНИМАНИЕ: namespace PGX — не путать с CHX (ClickHouse) и CH (палитра).
   ═════════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

const LS_SESSION = 'inplan_pg_session_v1';
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 часа с последней активности

/* ─────────────── 1. КОНФИГУРАЦИЯ ─────────────── */
const PGX = window.PGX = {
  cfg:{
    /* адрес backend-прокси: '' — тот же origin, что и страница (npm start).
       При открытии дашборда со статического хостинга/file:// здесь должен
       быть URL запущенного server.js (например http://host:8080). */
    backend:'',
    host:'db-postgresql-app.k8s.b1gahmn2gdjf3lsm4jeh.in-plan.ru',
    port:48235,
    database:'pgs_app_data_db',
    user:'', password:'', ssl:'auto'
  },
  state:{
    connected:false,          // backend ответил списком схем (креды валидны)
    checked:false,            // в этой загрузке уже пробовали (не дёргаем повторно)
    schemas:[],               // [{schema:'public_2', n:123}]
    lastError:null
  }
};

/* ─────────────── 2. АВТОСЕССИЯ НА 4 ЧАСА ───────────────
   Тот же осознанный компромисс, что и автосессия ClickHouse: логин и пароль
   хранятся в localStorage этого origin, сессия истекает через 4 часа
   бездействия, кнопка «Забыть PG-сессию» стирает её досрочно. */
PGX.session = {
  disabled:false,
  read(){
    try{
      const raw = localStorage.getItem(LS_SESSION);
      if(!raw) return null;
      const rec = JSON.parse(raw);
      if(!rec || rec.v!==1 || !rec.cfg || !rec.expiresAt || rec.expiresAt<=Date.now()){
        localStorage.removeItem(LS_SESSION);
        return null;
      }
      return rec;
    }catch(e){ return null }
  },
  save(){
    if(this.disabled) return false;
    const c = PGX.cfg, now = Date.now();
    const rec = { v:1, savedAt:now, expiresAt:now+SESSION_TTL_MS,
      cfg:{ backend:c.backend, host:c.host, port:c.port, database:c.database,
            user:c.user, password:c.password, ssl:c.ssl } };
    try{ localStorage.setItem(LS_SESSION, JSON.stringify(rec)); return true }
    catch(e){ console.warn('PG-автосессия не сохранена:', e); return false }
  },
  touch(){ return this.save() },
  enable(){ this.disabled=false },
  clear(){ this.disabled=true; try{ localStorage.removeItem(LS_SESSION) }catch(e){} },
  exists(){ return !!this.read() }
};
PGX.forgetSession = ()=>{ PGX.session.clear(); PGX.state.connected=false; PGX.state.checked=false; PGX.state.schemas=[] };
/* Восстановление без сети: креды подставляются в cfg, фактическое
   подключение произойдёт при первой загрузке версий (ensureSchemas). */
PGX.restoreSession = function(){
  const rec = PGX.session.read();
  if(!rec) return false;
  Object.assign(PGX.cfg, rec.cfg);
  PGX.state.sessionRestored = true;
  return true;
};

/* ─────────────── 3. API-КЛИЕНТ ─────────────── */
PGX.backendBase = function(){
  const b = (PGX.cfg.backend||'').trim().replace(/\/+$/,'');
  if(b) return b;
  /* страница открыта из файла: backend работает на той же машине локально */
  if(typeof location!=='undefined' && location.protocol==='file:') return 'http://localhost:8080';
  return '';
};
PGX.api = async function(pathName, body){
  const url = PGX.backendBase() + pathName;
  let resp;
  try{
    resp = await fetch(url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(body||{})
    });
  }catch(e){
    throw new Error('backend-прокси недоступен по адресу '+(url||'/api')+
      ' — запустите server.js (npm start) или укажите его адрес в подключении ('+e.message+')');
  }
  let data=null;
  try{ data = await resp.json() }
  catch(e){ /* не JSON — сообщим статусом */ }
  if(!resp.ok)
    throw new Error((data&&data.error)||('Ошибка сервера: '+resp.status));
  if(!data || data.ok===false)
    throw new Error((data&&data.error)||'пустой ответ backend-прокси');
  return data;
};
PGX.connBody = function(){
  const c = PGX.cfg;
  return { host:c.host, port:Number(c.port)||48235, database:c.database,
           user:c.user, password:c.password, ssl:c.ssl||'auto' };
};

/* PG-подключение считается настроенным, когда заданы хост/база/логин —
   пароль может быть пустым (trust-аутентификация). Без этих полей
   загрузчик работает по ClickHouse/demand_coverage, как раньше. */
PGX.enabled = function(){
  const c = PGX.cfg;
  return !!(c.host && c.database && c.user);
};

/* ─────────────── 4. СХЕМЫ И АГРЕГАТ ─────────────── */
/* Первый вызов в рамках загрузки: получить список схем с independentdemand.
   Ошибка запоминается до смены кредов/переподключения — 10 версий не должны
   отправлять 10 одинаковых неудачных запросов. */
PGX.ensureSchemas = async function(){
  if(PGX.state.connected) return PGX.state.schemas;
  if(PGX.state.checked && PGX.state.lastError) throw new Error(PGX.state.lastError);
  PGX.state.checked = true;
  try{
    const r = await PGX.api('/api/pg/schemas', PGX.connBody());
    PGX.state.schemas = (r.schemas||[]).map(s=>({schema:String(s.schema), n:Number(s.n)||0}));
    PGX.state.connected = true;
    PGX.state.lastError = null;
    PGX.session.enable();
    PGX.session.touch();
    return PGX.state.schemas;
  }catch(e){
    PGX.state.connected = false;
    PGX.state.lastError = e.message;
    throw e;
  }
};
/* Дисквалификация текущего подключения — при смене кредов в модалке. */
PGX.invalidate = function(){
  PGX.state.connected=false; PGX.state.checked=false; PGX.state.schemas=[];
  PGX.state.lastError=null;
};
/* Схема Postgres для базы ClickHouse: data_public_2 ↔ public_2.
   Список схем из backend — справочник: имя матчится без префикса в любом
   регистре («Data_public_2» → «public_2»); когда список ещё не получен,
   возвращаем снятое имя как есть и пусть сервер ответит ошибкой. */
PGX.pgSchemaFor = function(db){
  const stripped = String(db||'').replace(/^data_/i,'');
  const list = PGX.state.schemas||[];
  const hit = list.find(s=>String(s.schema).toLowerCase()===stripped.toLowerCase());
  return hit ? hit.schema : stripped;
};
/* Агрегат неограниченного спроса версии: {demUnc, n, periods:[{k,demUnc}], schema}.
   Бросает ошибку — вызывающий (loadVersionAgg) перейдёт к следующему источнику. */
PGX.uncFor = async function(db, gran){
  await PGX.ensureSchemas();
  const schema = PGX.pgSchemaFor(db);
  const r = await PGX.api('/api/pg/unc', Object.assign(PGX.connBody(), {schema, gran:Number(gran)}));
  return { demUnc:Number(r.demUnc)||0, n:Number(r.n)||0,
           periods:(r.periods||[]).map(p=>({k:String(p.k), demUnc:Number(p.demUnc)||0})),
           schema:r.schema||schema };
};

/* При загрузке страницы: подставить креды из автосессии (без сети). */
PGX.restoreSession();
})();
