/* ═══════════════════════════════════════════════════════════════════════════
   In.Plan · PostgreSQL-коннектор (неограниченный спрос из independent_demand)
   Зачем отдельное подключение: таблица independent_demand физически лежит в
   PostgreSQL, а не в ClickHouse. Браузер не умеет открывать TCP к Postgres,
   поэтому запросы идут через backend-прокси (server.js этого репозитория,
   POST /api/pg/schemas и /api/pg/unc) — как в дашборде opti.

   Соответствие версий: база ClickHouse «data_public_2» ↔ схема Postgres
   «public_2» (снимается префикс data_, регистр не важен; список схем, где
   есть independent_demand, приходит от backend и служит справочником имён).

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
    user:'', password:'', ssl:'auto',
    /* Ручное соответствие «база ClickHouse → схема PostgreSQL»:
       {'data_public_4899':'public_1494'}. Нужно, когда нумерация прогонов в
       ClickHouse и схем в Postgres не совпадает (а она совпадает не всегда:
       в CH выбраны data_public_4899/4941, а в PG — public_13…public_1726 и
       далее). Пустая запись = автоподбор по имени. Живёт в автосессии. */
    schemaMap:{}
  },
  state:{
    connected:false,          // backend ответил списком схем (креды валидны)
    checked:false,            // в этой загрузке уже пробовали (не дёргаем повторно)
    schemas:[],               // [{schema:'public_2', n:123}]
    lastError:null,          // ошибка подключения (список схем)
    lastDataError:null,      // ошибка чтения конкретной схемы
    /* диагностика backend-прокси: без неё ошибка «Not found» от чужого
       статического хостинга выглядела как проблема Postgres */
    backend:null,             // фактически выбранный адрес ('' = свой origin)
    backendOk:null,           // true/false/null — отвечает ли /api/health
    backendInfo:null,         // {service, api, endpoints} из /api/health
    stage:null                // 'backend' | 'pg' — на чём именно сломалось
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
            user:c.user, password:c.password, ssl:c.ssl,
            schemaMap:Object.assign({}, c.schemaMap||{}) } };
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
  if(!PGX.cfg.schemaMap || typeof PGX.cfg.schemaMap!=='object') PGX.cfg.schemaMap = {};
  PGX.state.sessionRestored = true;
  return true;
};

/* ─────────────── 3. API-КЛИЕНТ ─────────────── */
const LOCAL_BACKEND = 'http://localhost:8080';
/* Адрес из настроек (пусто — свой origin). Если автопоиск нашёл рабочий
   backend, пользуемся им: пользователю не нужно знать про поле «Backend». */
PGX.backendBase = function(){
  const b = (PGX.cfg.backend||'').trim().replace(/\/+$/,'');
  if(b) return b;
  if(PGX.state.backend) return PGX.state.backend;
  /* страница открыта из файла: backend работает на той же машине локально */
  if(typeof location!=='undefined' && location.protocol==='file:') return LOCAL_BACKEND;
  return '';
};
PGX.backendLabel = function(base){
  const b = base===undefined ? PGX.backendBase() : base;
  if(b) return b;
  /* без скобок и тире: текст попадает внутрь «(PG: …)» в заметках загрузки */
  return (typeof location!=='undefined' && location.origin) ? location.origin : 'этот же origin';
};
/* Кандидаты автопоиска: заданный вручную адрес — единственный (пользователь
   знает лучше); иначе свой origin, а для http/file — ещё и локальный npm start.
   С https-страницы браузер всё равно заблокирует http://localhost (mixed
   content), поэтому туда не стучимся и честно пишем это в подсказке. */
PGX.backendCandidates = function(){
  const manual = (PGX.cfg.backend||'').trim().replace(/\/+$/,'');
  if(manual) return [manual];
  const proto = (typeof location!=='undefined' && location.protocol) || 'http:';
  if(proto==='file:') return [LOCAL_BACKEND, 'http://127.0.0.1:8080'];
  const list = [''];
  if(proto!=='https:') list.push(LOCAL_BACKEND, 'http://127.0.0.1:8080');
  return list;
};
/* GET /api/health: жив ли backend и какой он версии. Никогда не бросает. */
PGX.health = async function(base){
  const url = (base||'') + '/api/health';
  try{
    const resp = await fetch(url, {method:'GET', headers:{'Accept':'application/json'}});
    if(!resp || !resp.ok || typeof resp.json!=='function') return null;
    const data = await resp.json();
    if(!data || data.ok!==true) return null;
    return { base:base||'', service:data.service||'', api:Number(data.api)||0,
             endpoints:Array.isArray(data.endpoints)?data.endpoints:[] };
  }catch(e){ return null }
};
/* Автопоиск backend перед первым запросом: заполняет state.backend/backendOk.
   Ошибок не бросает — если ничего не нашли, запрос всё равно уйдёт по
   текущему адресу, а понятную причину соберёт PGX.api. */
PGX.detectBackend = async function(){
  const cands = PGX.backendCandidates();
  for(const base of cands){
    const info = await PGX.health(base);
    if(info){
      PGX.state.backend = base;
      PGX.state.backendOk = true;
      PGX.state.backendInfo = info;
      return info;
    }
  }
  PGX.state.backend = null;
  PGX.state.backendOk = false;
  PGX.state.backendInfo = null;
  return null;
};
/* Почему backend не отвечает — текст для модалки и значка предупреждения. */
PGX.backendHint = function(){
  const manual = (PGX.cfg.backend||'').trim();
  const https = typeof location!=='undefined' && location.protocol==='https:';
  if(manual) return 'Проверьте адрес backend «'+manual+'»: там должен отвечать server.js (npm start).';
  if(https) return 'Откройте дашборд по адресу запущенного server.js (npm start → http://localhost:8080) '+
    'или укажите его адрес в поле «Backend»: со страницы по HTTPS браузер не пустит запрос на http://localhost.';
  return 'Запустите backend: npm start в папке дашборда — и откройте страницу по адресу http://localhost:8080 '+
    '(или впишите адрес запущенного server.js в поле «Backend»).';
};
PGX.api = async function(pathName, body){
  const base = PGX.backendBase();
  const url = base + pathName;
  let resp;
  try{
    resp = await fetch(url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(body||{})
    });
  }catch(e){
    /* Текст короткий: «что делать» показывают модалка и значок ⚠ отдельной
       строкой (PGX.backendHint) — иначе заметка загрузки превращается в абзац. */
    PGX.state.stage = 'backend';
    throw new Error('backend-прокси не отвечает по адресу '+PGX.backendLabel(base));
  }
  let data=null;
  try{ if(typeof resp.json==='function') data = await resp.json() }
  catch(e){ /* не JSON — сообщим статусом */ }
  const ours = !!(data && data.service==='inplan-dashboard');
  if(resp.status===404 && !ours){
    /* Самая частая причина «PG: Not found»: страница открыта НЕ с server.js,
       и POST /api/pg/* упирается в статический хостинг, который отвечает
       своим 404. Так и пишем — вместо чужого «Not found». */
    PGX.state.stage = 'backend';
    throw new Error('по адресу '+PGX.backendLabel(base)+' нет backend-прокси: на '+pathName+
      ' пришёл ответ 404'+((data&&data.error)?' «'+data.error+'»':''));
  }
  if(resp.status===404 && ours){
    PGX.state.stage = 'backend';
    throw new Error('backend по адресу '+PGX.backendLabel(base)+' не знает эндпоинт '+pathName+
      ': версия устарела, обновите server.js и перезапустите npm start');
  }
  /* структурированная ошибка в теле — отвечал API (наш или совместимый):
     это проблема Postgres, а не отсутствие прокси */
  const apiErr = !!(data && data.error);
  if(!resp.ok){
    PGX.state.stage = (ours||apiErr) ? 'pg' : 'backend';
    throw new Error((data&&data.error)||('backend по адресу '+PGX.backendLabel(base)+
      ' ответил HTTP '+resp.status));
  }
  if(!data || data.ok===false){
    PGX.state.stage = (ours||apiErr) ? 'pg' : 'backend';
    throw new Error((data&&data.error)||'пустой ответ backend-прокси по адресу '+PGX.backendLabel(base));
  }
  PGX.state.stage = null;
  PGX.state.backendOk = true;          // запрос прошёл — backend точно на месте
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
/* Первый вызов в рамках загрузки: получить список схем с independent_demand.
   Ошибка запоминается до смены кредов/переподключения — 10 версий не должны
   отправлять 10 одинаковых неудачных запросов. */
PGX.ensureSchemas = async function(){
  if(PGX.state.connected) return PGX.state.schemas;
  if(PGX.state.checked && PGX.state.lastError) throw new Error(PGX.state.lastError);
  PGX.state.checked = true;
  try{
    /* сначала ищем сам backend — чтобы отличить «нет прокси» от «ошибка PG» */
    if(PGX.state.backendOk===null) await PGX.detectBackend();
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
/* Дисквалификация текущего подключения — при смене кредов в модалке.
   Адрес backend ищем заново: его могли поправить в том же окне. */
PGX.invalidate = function(){
  PGX.state.connected=false; PGX.state.checked=false; PGX.state.schemas=[];
  PGX.state.lastError=null; PGX.state.lastDataError=null; PGX.state.stage=null;
  PGX.state.backend=null; PGX.state.backendOk=null; PGX.state.backendInfo=null;
};
/* Схема Postgres для базы ClickHouse: data_public_2 ↔ public_2.
   Список схем из backend — справочник: имя матчится без префикса в любом
   регистре («Data_public_2» → «public_2»), затем по номеру версии
   («public_4899» ↔ единственная схема, оканчивающаяся на 4899). Когда список
   ещё не получен, возвращаем снятое имя как есть — схему подберёт backend. */
PGX.pgSchemaFor = function(db){
  const stripped = String(db||'').replace(/^data_/i,'');
  /* ручное соответствие важнее любых догадок по имени */
  const ov = (PGX.cfg.schemaMap||{})[String(db||'').toLowerCase()];
  if(ov) return String(ov);
  const list = (PGX.state.schemas||[]).map(s=>String(s.schema));
  if(!list.length) return stripped;
  const cands = [stripped, String(db||''), 'data_'+stripped];
  for(const c of cands){
    const hit = list.find(s=>s.toLowerCase()===String(c).toLowerCase());
    if(hit) return hit;
  }
  const num = (stripped.match(/(\d+)\s*$/)||[])[1];
  if(num){
    const re = new RegExp('(^|[^0-9])'+num+'$');
    const hits = list.filter(s=>re.test(s));
    if(hits.length===1) return hits[0];
  }
  return stripped;
};
/* Сопоставление выбранных версий ClickHouse и схем Postgres — для модалки:
   [{db:'data_public_4899', schema:'public_4899', ok:true, manual:false, n:123}].
   ok=false — такой схемы в Postgres нет: версия уйдёт в фолбэк
   demand_coverage, пока пользователь не выберет схему руками. */
PGX.schemaPlan = function(dbs){
  const list = PGX.state.schemas||[];
  const man = PGX.cfg.schemaMap||{};
  return (dbs||[]).map(db=>{
    const schema = PGX.pgSchemaFor(db);
    const hit = list.find(s=>String(s.schema).toLowerCase()===String(schema).toLowerCase());
    return { db, schema, ok:!!hit, manual:!!man[String(db||'').toLowerCase()], n:hit?hit.n:0 };
  });
};
/* Ручная привязка версии к схеме (или сброс в автоподбор пустым значением).
   Сохраняется в автосессии: выбор переживает перезагрузку страницы. */
PGX.setSchemaOverride = function(db, schema){
  const key = String(db||'').toLowerCase();
  if(!key) return;
  if(!PGX.cfg.schemaMap || typeof PGX.cfg.schemaMap!=='object') PGX.cfg.schemaMap = {};
  const val = String(schema||'').trim();
  if(val) PGX.cfg.schemaMap[key] = val;
  else delete PGX.cfg.schemaMap[key];
  PGX.session.touch();
  return PGX.cfg.schemaMap;
};
/* Короткая диагностика для значка предупреждения в шапке:
   {stage:'backend'|'pg', title, detail, hint}. null — проблем нет. */
PGX.problem = function(){
  if(!PGX.enabled()) return null;
  const msg = PGX.state.lastError || PGX.state.lastDataError;
  if(!msg) return null;
  const backend = PGX.state.stage==='backend';
  return {
    stage: backend?'backend':'pg',
    title: backend?'Backend-прокси PostgreSQL недоступен':'PostgreSQL: таблица independent_demand недоступна',
    detail: msg,
    hint: backend?PGX.backendHint():''
  };
};
/* Агрегат неограниченного спроса версии: {demUnc, n, periods:[{k,demUnc}], schema}.
   Бросает ошибку — вызывающий (loadVersionAgg) перейдёт к следующему источнику. */
PGX.uncFor = async function(db, gran){
  await PGX.ensureSchemas();
  const schema = PGX.pgSchemaFor(db);
  /* схему выбрал человек — backend не должен подбирать похожую */
  const exact = !!(PGX.cfg.schemaMap||{})[String(db||'').toLowerCase()];
  let r;
  try{
    r = await PGX.api('/api/pg/unc', Object.assign(PGX.connBody(), {schema, gran:Number(gran), exact}));
  }catch(e){
    /* ошибка данных версии не гасит подключение (другие версии могут
       прочитаться), но попадает в значок предупреждения */
    PGX.state.lastDataError = e.message;
    throw e;
  }
  PGX.state.lastDataError = null;
  return { demUnc:Number(r.demUnc)||0, n:Number(r.n)||0,
           periods:(r.periods||[]).map(p=>({k:String(p.k), demUnc:Number(p.demUnc)||0})),
           schema:r.schema||schema, table:r.table||'independent_demand',
           qtySource:r.qtySource||((r.cols||{}).qty)||'demandqty',
           qtyFallback:r.qtyFallback||null,
           primaryDemUnc:Number(r.primaryDemUnc)||0,
           adjustedDemUnc:r.adjustedDemUnc==null?null:Number(r.adjustedDemUnc)||0,
           diagnostics:r.diagnostics||null };
};

/* При загрузке страницы: подставить креды из автосессии (без сети). */
PGX.restoreSession();
})();
