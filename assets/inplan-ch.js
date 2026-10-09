/* ═══════════════════════════════════════════════════════════════════════════
   In.Plan · ClickHouse-коннектор, реестр таблиц, версии планов
   Зависимости из index.html: $, $$, esc, sany, nf, num, pnum, S, uq, grp,
   dtable, chBars, chH, chHeat, bn, mln, pc, build, render, go, plural,
   normalizePeriodKey, CH (палитра графиков), PAL, H, cv, TBL
   ВНИМАНИЕ: namespace CHX — не путать с CH (цвета графиков).
   ═════════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

const LS_PROFILES = 'inplan_ch_profiles_v1';
const LS_SCENARIO = 'inplan_ch_scenario_v1';
const LS_SESSION = 'inplan_ch_session_v1';
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 часа с последней активности

/* ─────────────── 1. КОНФИГУРАЦИЯ ─────────────── */
const CHX = window.CHX = {
  cfg:{
    host:'clickhouse.k8s.b1gahmn2gdjf3lsm4jeh.in-plan.ru',
    port:443, proto:'https', user:'readonly', pass:'',
    useProxy:false, proxyUrl:'/api/ch',
    schemas:[], base:'', gran:4,
    detailOrders:2000            // сколько заказов тянуть детально в основную схему
  },
  state:{
    connected:false, dbs:[], granOptions:[], granByDb:{}, scenario:new Map(),
    pgScenario:new Map(),
    lastError:null, busy:false
  },
  versions:[]                    // [{id,label,src,isBase,agg,dims}]
};

/* ─────────────── 1.1. АВТОСЕССИЯ НА 4 ЧАСА ───────────────
   Вариант 2: для автоматического переподключения после закрытия браузера
   сохраняем также пароль. Это осознанный компромисс удобства и безопасности:
   значение находится в localStorage и доступно JavaScript этого origin.
   Сессия удаляется автоматически после 4 часов бездействия. */
CHX.session = {
  disabled:false,
  read(){
    try{
      const raw = localStorage.getItem(LS_SESSION);
      if(!raw) return null;
      const rec = JSON.parse(raw);
      if(!rec || rec.v !== 1 || !rec.cfg || !rec.expiresAt || rec.expiresAt <= Date.now()){
        localStorage.removeItem(LS_SESSION);
        return null;
      }
      return rec;
    }catch(e){ return null }
  },
  save(){
    if(this.disabled) return false;
    const c = CHX.cfg, now = Date.now();
    const rec = {
      v:1,
      savedAt:now,
      expiresAt:now + SESSION_TTL_MS,
      cfg:{
        host:c.host, port:c.port, proto:c.proto, user:c.user, pass:c.pass,
        useProxy:!!c.useProxy, proxyUrl:c.proxyUrl,
        schemas:Array.isArray(c.schemas)?c.schemas.slice():[],
        base:c.base, gran:c.gran, detailOrders:c.detailOrders
      }
    };
    try{ localStorage.setItem(LS_SESSION, JSON.stringify(rec)); return true }
    catch(e){ console.warn('Автосессия не сохранена:',e); return false }
  },
  touch(){
    const ok=this.save();
    if(ok && typeof window.onCHSessionTouched==='function') window.onCHSessionTouched(this.read()?.expiresAt);
    return ok;
  },
  enable(){ this.disabled=false },
  clear(){ this.disabled=true; try{ localStorage.removeItem(LS_SESSION) }catch(e){} },
  exists(){ return !!this.read() },
  ttl(){
    const rec=this.read();
    return rec ? Math.max(0,rec.expiresAt-Date.now()) : 0;
  }
};
CHX.forgetSession = ()=>CHX.session.clear();

/* ─────────────── 2. РЕЕСТР ТАБЛИЦ ───────────────
   Добавление новой таблицы из ClickHouse = добавление одного объекта.
   role      — что таблица даёт дашборду (проверяется вкладками)
   mode      — 'agg' (только агрегаты) | 'detail' (построчно, с лимитом)
   dedupBy   — ключ идентичности строки для LIMIT 1 BY
   periodCol — колонка даты для гранулярности ('' = нет, период по номеру)
   ptypeCol  — колонка periodtype ('' = фильтр по гранулярности не применяется)
*/
const TABLES = CHX.TABLES = {
  marking_demand:{
    role:'core', required:true, mode:'detail',
    dedupBy:['order_id','order_operation_id','resource'],
    periodCol:'', ptypeCol:'', periodNumCol:'demand_period',
    label:'Ограниченный спрос и разузлование'
  },
  demand_coverage:{
    role:'demand', mode:'agg',
    dedupBy:['sys_id'], periodCol:'date', ptypeCol:'periodtype',
    label:'Входной спрос и покрытие'
  },
  /* Итоговые финансы прогона (задача владельца 2026-10-06): «Валовая выручка»
     = Σ revenue и «Валовая маржа» = Σ total_margin берутся отсюда — для
     карточек верхнего ряда и сравнения версий. Детализация по заказам
     (таблицы, графики) остаётся на marking_demand. Колонки periodtype в
     таблице нет — фильтр гранулярности не применяется. */
  margin_sales:{
    role:'finance', mode:'agg',
    dedupBy:['sys_id'], periodCol:'date', ptypeCol:'',
    label:'Итоговая маржа и выручка продаж'
  },
  capacity_view_sp:{
    role:'capacity_fact', mode:'agg',
    dedupBy:['sys_id'], periodCol:'date', ptypeCol:'periodtype',
    label:'Загрузка мощностей (факт прогона)'
  },
  rescapacity:{
    role:'capacity_plan', mode:'agg',
    dedupBy:['sys_id'], periodCol:'datefr', ptypeCol:'periodtype',
    label:'Плановые мощности ресурсов'
  },
  demand_cost:{
    role:'penalty_period', mode:'agg',
    dedupBy:['sys_id'], periodCol:'datefr', ptypeCol:'periodtype',
    label:'Стоимость спроса по периодам'
  },
  demand_cost_ti:{
    role:'penalty_flat', mode:'agg',
    dedupBy:['sys_id'], periodCol:'', ptypeCol:'',
    label:'Стоимость спроса без периодов'
  },
  /* Источники вне ClickHouse — грузятся из Excel, объявлены здесь же,
     чтобы вкладки проверяли наличие роли единообразно. */
  res_loc_loc:{ role:'route_limit', source:'excel', label:'Лимиты направлений' },
  scenario:{    role:'scenario',    source:'excel', label:'Названия версий' }
};

/* какие роли нужны вкладкам — для честного сообщения «источник отсутствует» */
CHX.TAB_NEEDS = {
  ov:['core'], dm:['core'], cov:['demand'], tree:['core'],
  lg:['core'], pd:['core','capacity_fact'], pc:['core'], st:['core'],
  cost:['penalty_period','penalty_flat'], caps:['capacity_fact','capacity_plan'],
  vs:[], raw:['core'], dq:[]
};
CHX.hasRole = role => Object.keys(TABLES).some(t =>
  TABLES[t].role === role && (CHX.loaded && CHX.loaded[t]));
CHX.loaded = {};

/* ─────────────── 3. ТРАНСПОРТ ─────────────── */
function endpoint(){
  const c = CHX.cfg;
  if(c.useProxy) return c.proxyUrl.replace(/\/+$/,'');
  return `${c.proto}://${c.host}:${c.port}`;
}
async function chQuery(sql, fmt){
  fmt = fmt || 'JSONEachRow';
  const c = CHX.cfg;
  const url = endpoint() + '/?' + new URLSearchParams({
    default_format: fmt,
    add_http_cors_header:'1',
    max_execution_time:'120',
    readonly:'1'
  });
  const headers = {'Content-Type':'text/plain; charset=utf-8'};
  if(!c.useProxy){
    if(c.user) headers['X-ClickHouse-User'] = c.user;
    if(c.pass) headers['X-ClickHouse-Key']  = c.pass;
  }
  let res;
  try{
    res = await fetch(url, {method:'POST', headers, body:sql, mode:'cors', credentials:'omit'});
  }catch(e){
    throw new Error('Сеть/CORS: браузер не смог обратиться к '+endpoint()+
      '. Проверьте CORS на стороне ClickHouse, валидность TLS-сертификата и доступность хоста. ('+e.message+')');
  }
  const text = await res.text();
  if(!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0,600)}`);
  if(fmt !== 'JSONEachRow') return text;
  return text.split('\n').filter(Boolean).map(l=>{
    try{ return JSON.parse(l) }catch(e){ return null }
  }).filter(Boolean);
}
CHX.query = chQuery;

/* ─────────────── 4. SQL-ХЕЛПЕРЫ ─────────────── */
const q = s => '`' + String(s).replace(/`/g,'') + '`';
const qs = s => "'" + String(s).replace(/'/g,"\\'") + "'";

/* Источник с дедупликацией: is_deleted=0 + последняя версия строки.
   ReplacingMergeTree без FINAL может отдать дубли, поэтому LIMIT 1 BY. */
function src(db, tbl, extraWhere){
  const t = TABLES[tbl] || {};
  const w = ['is_deleted = 0'];
  if(extraWhere) w.push('('+extraWhere+')');
  let s = `SELECT * FROM ${q(db)}.${q(tbl)} WHERE ${w.join(' AND ')}`;
  if(t.dedupBy && t.dedupBy.length)
    s += ` ORDER BY update_date_time DESC LIMIT 1 BY ${t.dedupBy.map(q).join(', ')}`;
  return '('+s+')';
}

/* Гранулярность: усечение даты под тип периода.
   3 — неделя, 4 — месяц (подтверждено), 5 — квартал, 6 — год, прочее — день. */
function bucketExpr(col, gran){
  const g = Number(gran);
  if(g === 3) return `toMonday(toDate(${q(col)}))`;
  if(g === 4) return `toStartOfMonth(toDate(${q(col)}))`;
  if(g === 5) return `toStartOfQuarter(toDate(${q(col)}))`;
  if(g === 6) return `toStartOfYear(toDate(${q(col)}))`;
  return `toDate(${q(col)})`;
}
function periodKeyExpr(tbl, gran){
  const t = TABLES[tbl];
  if(!t.periodCol) return t.periodNumCol ? `toString(${q(t.periodNumCol)})` : `''`;
  const g = Number(gran);
  const b = bucketExpr(t.periodCol, gran);
  if(g === 4 || g === 5 || g === 6) return `formatDateTime(${b}, '%Y-%m')`;
  return `formatDateTime(${b}, '%Y-%m-%d')`;
}
function granWhere(tbl, gran){
  const t = TABLES[tbl];
  return t.ptypeCol ? `${q(t.ptypeCol)} = ${Number(gran)}` : '';
}
CHX.sql = {src, periodKeyExpr, granWhere, q, qs};

/* ─────────────── 4.1. ПЕРИОД ДЛЯ ЦЕН СПРОСА (задача владельца 2026-10-07) ───────────────
   Канонизация периода из сырых значений demand_coverage / demand_cost /
   demand_cost_ti: date ('2026-09-01', DateTime), календарный periodid
   4YYYYMMDD / YYYYMMDD (как в independent_demand) или технический бакет
   ('P1', '3'). Возвращает {k, ms}: k — канонический ключ ('d:YYYY-MM-DD' для
   дат, 'r:техзначение' для бакетов), ms — Date.UTC периода (NaN у бакетов).
   Один период в разных кодировках ('420260901' и '2026-09-01') даёт один
   ключ — сшивка таблиц с разными колонками периода не ломается. Мусор
   ('0000-00-00', '\N', пусто) — не период: {k:'', ms:NaN}. */
function covPeriodCanon(raw){
  if(raw==null) return {k:'', ms:NaN};
  if(raw instanceof Date)
    return {k:'d:'+raw.toISOString().slice(0,10), ms:raw.getTime()};
  let s = String(raw).trim();
  if(s==='' || s==='\\N' || s.toLowerCase()==='null') return {k:'', ms:NaN};
  if(/^P/i.test(s)) s = s.slice(1);
  if(/^\d{9}$/.test(s) && /^[1-6]/.test(s)) s = s.slice(1);   // periodid 4YYYYMMDD
  const ymd = m => {
    const y=+m[1], mo=+m[2], d=+m[3];
    if(y>1900 && mo>=1 && mo<=12 && d>=1 && d<=31)
      return {k:'d:'+m[1]+'-'+m[2]+'-'+m[3], ms:Date.UTC(y,mo-1,d)};
    return {k:'', ms:NaN};
  };
  if(/^\d{8}$/.test(s)){
    const r = ymd([s, s.slice(0,4), s.slice(4,6), s.slice(6,8)]);
    if(r.k) return r;
    return {k:'', ms:NaN};
  }
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m2) return ymd(m2);
  return {k:'r:'+s.toLowerCase(), ms:NaN};
}
CHX.covPeriodCanon = covPeriodCanon;

/* ─────────────── 5. ОБНАРУЖЕНИЕ СХЕМ И ГРАНУЛЯРНОСТЕЙ ─────────────── */
CHX.connect = async function(){
  CHX.state.busy = true; CHX.state.lastError = null;
  try{
    /* Полный список баз; фильтр data_public* — без учёта регистра,
       т.к. в кластере базы называются «Data_public_N» с заглавной буквы */
    const all = await chQuery(`SELECT name FROM system.databases ORDER BY name`);
    const names = all.map(r=>String(r.name));
    const sysDb = new Set(['system','information_schema','INFORMATION_SCHEMA','default']);
    CHX.state.allDbs = names;
    let hit = names.filter(n=>n.toLowerCase().startsWith('data_public'));
    CHX.state.dbs = hit.length ? hit : names.filter(n=>!sysDb.has(n));
    CHX.state.fallbackAll = !hit.length;
    if(!CHX.state.dbs.length)
      throw new Error("Подключение прошло, но список баз пуст. Проверьте права пользователя на system.databases.");
    /* Перепроверяем базу и выбранные схемы по текущему кластеру: устаревшая
       база из автосессии/профиля не должна оставаться фантомом и тем более
       становиться объектом пробы гранулярности (схемы может не существовать). */
    CHX.cfg.schemas = (CHX.cfg.schemas||[]).filter(db=>CHX.state.dbs.includes(db));
    if(CHX.cfg.schemas.length && !CHX.cfg.schemas.includes(CHX.cfg.base))
      CHX.cfg.base = CHX.cfg.schemas[0];
    if(!CHX.cfg.schemas.length) CHX.cfg.base = '';
    /* мета по каждой схеме: свежесть и объём */
    const metas = await Promise.allSettled(CHX.state.dbs.map(async db=>{
      const r = await chQuery(
        `SELECT count() AS n, max(update_date_time) AS ts
         FROM ${q(db)}.${q('marking_demand')} WHERE is_deleted = 0`);
      return {db, n:num(r[0]&&r[0].n), ts:(r[0]&&r[0].ts)||''};
    }));
    CHX.state.meta = {};
    metas.forEach(m=>{ if(m.status==='fulfilled') CHX.state.meta[m.value.db]=m.value; });
    /* гранулярности — динамически из данных основной/первой схемы */
    const probe = CHX.cfg.base || CHX.state.dbs[0];
    CHX.state.granOptions = (await CHX.granOptionsFor(probe, {fresh:true})) || [{t:4,n:0}];
    if(!CHX.state.granOptions.some(o=>o.t===CHX.cfg.gran))
      CHX.cfg.gran = CHX.state.granOptions[0].t;
    CHX.state.connected = true;
    CHX.session.enable();
    // Успешное подключение продлевает автосессию ещё на 4 часа.
    CHX.session.touch();
    return CHX.state.dbs;
  }catch(e){
    CHX.state.connected = false; CHX.state.lastError = e.message; throw e;
  }finally{ CHX.state.busy = false; }
};

/* ─────────────── 5.1. ВОССТАНОВЛЕНИЕ АВТОСЕССИИ ─────────────── */
let sessionRestoreBusy = false;
let lastSessionCheck = 0;
function emitSessionStatus(type, extra){
  if(typeof window.onCHSessionStatus === 'function')
    window.onCHSessionStatus(Object.assign({type}, extra||{}));
}
CHX.restoreSession = async function(){
  if(sessionRestoreBusy || CHX.state.busy) return false;
  const rec = CHX.session.read();
  if(!rec) return false;
  /* Excel is the last active source: an old CH session must not overwrite it. */
  if(typeof window.getActiveDatasetSource==='function' &&
     window.getActiveDatasetSource()==='excel') return false;
  sessionRestoreBusy = true;
  lastSessionCheck = Date.now();
  Object.assign(CHX.cfg, rec.cfg, {
    schemas:Array.isArray(rec.cfg.schemas)?rec.cfg.schemas.slice():[],
    pass:String(rec.cfg.pass||'')
  });
  emitSessionStatus('restoring', {expiresAt:rec.expiresAt});
  try{
    await CHX.connect();
    /* Loading the dataset is part of session restoration; connection alone
       must not leave the dashboard on demo data. */
    if(CHX.cfg.schemas.length) await CHX.loadAll();
    emitSessionStatus('restored', {expiresAt:CHX.session.read()?.expiresAt||Date.now()+SESSION_TTL_MS});
    return true;
  }catch(e){
    CHX.state.connected = false;
    CHX.state.lastError = e.message;
    emitSessionStatus('error', {error:e.message, expiresAt:rec.expiresAt});
    return false;
  }finally{ sessionRestoreBusy = false }
};

CHX.checkSession = async function(force){
  const rec = CHX.session.read();
  if(!rec) return false;
  const now = Date.now();
  if(!force && now-lastSessionCheck < 30000) return CHX.state.connected;
  lastSessionCheck = now;
  if(sessionRestoreBusy || CHX.state.busy) return CHX.state.connected;
  if(CHX.state.connected){
    try{
      await chQuery('SELECT 1 AS ok');
      CHX.session.touch();
      emitSessionStatus('active', {expiresAt:CHX.session.read()?.expiresAt||Date.now()+SESSION_TTL_MS});
      return true;
    }catch(e){
      CHX.state.connected = false;
      CHX.state.lastError = e.message;
    }
  }
  return CHX.restoreSession();
};
/* Фактические гранулярности схемы — что реально есть в её demand_coverage.
   У разных версий планов набор periodtype может отличаться, поэтому список
   всегда спрашивается у КОНКРЕТНОЙ схемы, а не раз и навсегда.
   Результат кэшируется на время сессии; {fresh:true} — переспросить принудительно.
   Возврат null — в схеме нет demand_coverage (фильтр по гранулярности не применим). */
CHX.granOptionsFor = async function(db, opts){
  db = db || CHX.cfg.base;
  if(!db) return null;
  if(!(opts && opts.fresh) && CHX.state.granByDb[db]) return CHX.state.granByDb[db];
  try{
    const g = await chQuery(
      `SELECT periodtype AS t, count() AS n FROM ${q(db)}.${q('demand_coverage')}
       WHERE is_deleted = 0 GROUP BY t ORDER BY n DESC`);
    const list = g.map(r=>({t:num(r.t), n:num(r.n)})).filter(x=>x.t);
    if(!list.length) return null;
    CHX.state.granByDb[db] = list;
    return list;
  }catch(e){ return null }
};

/* Пересчёт доступных гранулярностей по выбранной основной схеме:
   панель должна показывать periods ВЫБРАННОЙ версии, а не той, что была раньше */
CHX.refreshGran = async function(db){
  db = db || CHX.cfg.base;
  if(!db) return;
  CHX.state.granOptions = (await CHX.granOptionsFor(db, {fresh:true})) || [{t:4,n:0}];
  /* если текущая гранулярность в новой схеме отсутствует — берём самую массовую */
  if(!CHX.state.granOptions.some(o=>o.t===CHX.cfg.gran))
    CHX.cfg.gran = CHX.state.granOptions[0].t;
};
const GRAN_LABEL = {1:'День',2:'Тип 2',3:'Неделя',4:'Месяц',5:'Квартал',6:'Год'};
CHX.granLabel = t => GRAN_LABEL[t] || ('Тип '+t);

/* ─────────────── 6. ПРОФИЛИ ПОДКЛЮЧЕНИЯ (без пароля) ─────────────── */
CHX.profiles = {
  all(){ try{ return JSON.parse(localStorage.getItem(LS_PROFILES)||'[]') }catch(e){ return [] } },
  save(name){
    const c = CHX.cfg, list = CHX.profiles.all().filter(p=>p.name!==name);
    list.unshift({name, host:c.host, port:c.port, proto:c.proto, user:c.user,
      useProxy:c.useProxy, proxyUrl:c.proxyUrl, schemas:c.schemas.slice(),
      base:c.base, gran:c.gran});
    localStorage.setItem(LS_PROFILES, JSON.stringify(list.slice(0,10)));
  },
  apply(name){
    const p = CHX.profiles.all().find(x=>x.name===name);
    if(!p) return false;
    Object.assign(CHX.cfg, p, {pass:''});  // пароль намеренно не восстанавливаем
    return true;
  },
  drop(name){
    localStorage.setItem(LS_PROFILES,
      JSON.stringify(CHX.profiles.all().filter(p=>p.name!==name)));
  }
};

/* ─────────────── 7. НАЗВАНИЯ ВЕРСИЙ (scenario.xlsx) ─────────────── */
CHX.loadScenarioFile = function(file){
  return new Promise((resolve,reject)=>{
    if(typeof XLSX === 'undefined') return reject(new Error('SheetJS недоступен'));
    const fr = new FileReader();
    fr.onload = e=>{
      try{
        const wb = XLSX.read(e.target.result,{type:'array',cellDates:true});
        const sh = wb.SheetNames.find(n=>/scenario/i.test(n)) || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sh],{defval:''});
        const map = new Map();
        rows.forEach(r=>{
          const pick = keys=>{
            for(const k of Object.keys(r)){
              const kk = k.toLowerCase().replace(/[\s_\-]/g,'');
              if(keys.includes(kk) && r[k]!=='') return r[k];
            }
            return '';
          };
          const sysId  = String(pick(['sysid','id'])||'').trim();
          const schema = String(pick(['database','schema','db'])||'').trim();
          const name   = String(pick(['name','название'])||'').trim();
          if(!name) return;
          const rec = {name,
            comment:String(pick(['comment','описание'])||''),
            author:String(pick(['author','автор'])||''),
            created:String(pick(['createdatetime','createdate'])||''),
            type:String(pick(['type'])||''), tag:String(pick(['tag'])||''),
            sysId, schema};
          if(schema) map.set('db:'+schema.toLowerCase(), rec);
          if(sysId)  map.set('id:'+sysId, rec);
        });
        CHX.state.scenario = map;
        try{ localStorage.setItem(LS_SCENARIO, JSON.stringify([...map])) }catch(e){}
        CHX.relabelVersions();
        resolve(map.size);
      }catch(err){ reject(err) }
    };
    fr.onerror = ()=>reject(new Error('Не удалось прочитать файл'));
    fr.readAsArrayBuffer(file);
  });
};
(function restoreScenario(){
  try{
    const raw = localStorage.getItem(LS_SCENARIO);
    if(raw) CHX.state.scenario = new Map(JSON.parse(raw));
  }catch(e){}
})();

/* Справочник PG сопоставляет цифровой суффикс базы ClickHouse
   (например, data_public_4899) с scenario.sys_id. Нормализация нулей слева
   помогает при строковых sys_id; исходная XLSX-логика остаётся фолбэком. */
function scenarioIdKey(value){
  const id=String(value==null?'':value).trim();
  return /^\d+$/.test(id)?id.replace(/^0+(?=\d)/,''):'';
}
CHX.versionNumber = function(db){
  const m=String(db||'').match(/_(\d+)$/);
  return m?m[1]:'';
};
CHX.applyPostgresScenarioRows = function(rows){
  const map=new Map();
  (Array.isArray(rows)?rows:[]).forEach(r=>{
    const sysId=scenarioIdKey(r&&r.sys_id);
    const name=String(r&&r.name!=null?r.name:'').trim();
    if(sysId&&name&&!map.has(sysId)) map.set(sysId,{sysId,name});
  });
  CHX.state.pgScenario=map;
  CHX.relabelVersions();
  return map.size;
};
CHX.refreshPostgresScenarioLabels = async function(options){
  if(!window.PGX||typeof PGX.loadScenarioNames!=='function')
    return CHX.applyPostgresScenarioRows([]);
  if(!PGX.cfg.host||!PGX.cfg.user)
    return CHX.applyPostgresScenarioRows([]);
  const key=PGX.scenarioNamesRequestKey?PGX.scenarioNamesRequestKey():null;
  const generation=PGX.state.scenarioNamesGeneration||0;
  const rows=await PGX.loadScenarioNames(options);
  if((PGX.state.scenarioNamesGeneration||0)!==generation ||
     (key&&PGX.scenarioNamesRequestKey&&key!==PGX.scenarioNamesRequestKey()))
    return CHX.state.pgScenario.size;
  return CHX.applyPostgresScenarioRows(rows);
};

/* Сопоставление версии с подписью: сначала scenario из metadata PG по
   суффиксу sys_id, затем прежний scenario.xlsx (database/schema или sys_id),
   и в последнюю очередь — техническое имя схемы. */
CHX.labelFor = function(db){
  const id=scenarioIdKey(CHX.versionNumber(db));
  const pgMap=CHX.state.pgScenario;
  const pgRec=id&&pgMap?pgMap.get(id):null;
  if(pgRec&&pgRec.name) return pgRec.name;
  const m = CHX.state.scenario;
  if(!m || !m.size) return db;
  const direct = m.get('db:'+String(db).toLowerCase());
  if(direct) return direct.name;
  const suf = String(db).match(/(\d+)$/);
  if(suf){
    const byId = m.get('id:'+suf[1]);
    if(byId) return byId.name;
  }
  return db;
};
CHX.relabelVersions = function(){
  CHX.versions.forEach(v=>{ if(v.src==='ch') v.label = CHX.labelFor(v.id) });
  if(typeof render === 'function' && window.DS) render();
};
CHX.unmatchedSchemas = () =>
  (CHX.cfg.schemas||[]).filter(db => CHX.labelFor(db) === db);

/* Полная построчная сводка плана для классификации каждой строки
   independent_demand в той же логике, что и в основной версии.
   В независимом реестре нет order_id: используем бизнес-ключ товара,
   локации, типа/потока спроса и ближайший объём (см. mergeIndependentOrders).
   Читаем только компактные поля статуса, а не все финансы/операции. */
async function loadVersionOrderSummary(db,gran){
  const S_MD = src(db,'marking_demand');
  let mdCols = null;
  try{
    const cols = await chQuery(`SELECT name FROM system.columns
      WHERE database = ${qs(db)} AND table = 'marking_demand'`);
    mdCols = new Set(cols.map(r=>String(r.name||'').toLowerCase()));
  }catch(e){ /* без system.columns пробуем гарантированный набор */ }
  const anyOr = (col, fallback) => mdCols && !mdCols.has(String(col).toLowerCase())
    ? fallback : `any(${q(col)})`;
  /* Сопоставляем тот же periodtype, что и DISTINCT-вход independent_demand.n.
     Если схема не публикует periodtype в marking_demand, оставляем её исходный
     охват: query ниже всё равно будет помечен как fallback в случае ошибки. */
  const periodFilter=mdCols&&!mdCols.has('periodtype')?'':`WHERE ${q('periodtype')} = ${Math.trunc(num(gran))}`;
  const rows = await chQuery(`SELECT order_id AS id,
      ${anyOr('demand_period','0')} AS p,
      ${anyOr('demand_product',"''")} AS prod,
      ${anyOr('demand_location',"''")} AS loc,
      ${anyOr('demand_demandtype',"''")} AS dt,
      ${anyOr('dmdstream',"''")} AS stream,
      ${anyOr('demand_volume','0')} AS dem,
      ${anyOr('results_sale','0')} AS sal,
      ${anyOr('unsatisfied_demand','0')} AS unm
    FROM ${S_MD} ${periodFilter} GROUP BY order_id`);
  return rows.map(r=>({id:num(r.id), p:r.p, prod:sany(r.prod), loc:sany(r.loc),
    dt:sany(r.dt), stream:sany(r.stream), dem:num(r.dem), sal:num(r.sal), unm:num(r.unm)}));
}

/* ─────────────── 8. АГРЕГАТЫ ВЕРСИИ (считает ClickHouse) ─────────────── */
async function loadVersionAgg(db, gran){
  const out = {db, gran, totals:{}, dims:{}, notes:[]};
  const S_MD = src(db,'marking_demand');

   /* 8.1 финансы и объёмы: дедуп до уровня заказа, потом агрегация.
     ВАЖНО: колонки подзапроса названы с префиксом o_ — ClickHouse подставляет
     алиасы глобально по запросу, и если подзапрос даёт колонку «unm», а внешняя
     выборка объявляет sum(unm) AS unm, то внутри sum(unm*mpt) «unm» разворачивается
     в sum(unm) → ILLEGAL_AGGREGATION (ошибка 184). Префикс разрывает конфликт. */
  const ordSub = `(SELECT order_id,
      any(${q('demand_period')})   AS o_p,
      any(${q('demand_product')})  AS o_prod,
      any(${q('demand_client')})   AS o_cl,
      any(${q('demand_location')}) AS o_loc,
      any(${q('demand_volume')})   AS o_dem,
      any(${q('results_sale')})    AS o_sal,
      any(${q('unsatisfied_demand')}) AS o_unm,
      any(${q('revenue')})         AS o_rev,
      any(abs(${q('cost_of_demand')})) AS o_cost,
      any(${q('total_margin')})    AS o_mar,
      any(${q('margin_per_unit')}) AS o_mpt
    FROM ${S_MD} GROUP BY order_id)`;

  /* toFloat64: unsatisfied_demand и margin_per_unit — Decimal(18,12),
     их произведение переполняет десятичный разряд (ошибка 407) */
  const tot = await chQuery(`SELECT count() AS orders,
      sum(toFloat64(o_rev)) AS rev, sum(toFloat64(o_cost)) AS cost, sum(toFloat64(o_mar)) AS mar,
      sum(toFloat64(o_dem)) AS dem, sum(toFloat64(o_sal)) AS sal, sum(toFloat64(o_unm)) AS unm,
      sum(toFloat64(o_unm)*toFloat64(o_mpt)) AS lm,
      countIf(toFloat64(o_unm) <= 0.000000001) AS full,
      /* Классификация заказов плана по marking_demand — фолбэк для водопада
         по заказам, когда demand_coverage недоступна (или под фильтрами):
         ff ≈ sal (покрытый = отгруженный), uf ≈ unm. Те же три группы, что
         у countIf из demand_coverage, поэтому обе схемы счёта сопоставимы. */
      countIf(toFloat64(o_sal) <= 0.000000001) AS zeroSalOrders,
      countIf(toFloat64(o_sal) > 0.000000001 AND toFloat64(o_unm) > 0.000000001) AS partCoveredOrders,
      countIf(toFloat64(o_sal) > 0.000000001 AND toFloat64(o_unm) <= 0.000000001) AS fullCoveredOrders
    FROM ${ordSub}`);
  Object.assign(out.totals, tot[0]||{});

  /* 8.1.1 итоговые финансы из margin_sales (задача владельца 2026-10-06):
     «Валовая выручка» = Σ revenue, «Валовая маржа» = Σ total_margin по всей
     таблице margin_sales — эти значения ПЕРЕКРЫВАЮТ rev/mar из marking_demand
     и питают карточки верхнего ряда и сравнение версий (covBasis, snap,
     vsFlat читают totals.rev/mar). Таблицы и графики остаются на детализации
     marking_demand, поэтому прежние итоги сохраняем в revMd/marMd, а источник
     фиксируем в finSrc. Дедупликация — стандартный src(): is_deleted = 0 +
     последняя версия строки по sys_id. toFloat64 — Decimal-поля, как в 8.1.
     Пустая/нулевая margin_sales — тихий фолбэк на marking_demand (finSrc не
     ставится); ошибка запроса (нет таблицы, нет прав) — заметка загрузки. */
  try{
    const S_MS = src(db,'margin_sales');
    const ms = await chQuery(`SELECT
        sum(toFloat64(${q('revenue')}))      AS msRev,
        sum(toFloat64(${q('total_margin')})) AS msMar,
        sum(toFloat64(abs(${q('cost_of_demand')}))) AS msCost,
        count() AS msRows
      FROM ${S_MS}`);
    const m0 = ms[0]||{};
    const msRev = num(m0.msRev), msMar = num(m0.msMar), msRows = num(m0.msRows);
    if(msRows>0 && (msRev!==0 || msMar!==0)){
      out.totals.revMd = num(out.totals.rev);   // прежние итоги marking_demand —
      out.totals.marMd = num(out.totals.mar);   // для сверки в «Данных и качестве»
      out.totals.rev = msRev;
      out.totals.mar = msMar;
      out.totals.msCost = num(m0.msCost);       // Σ |cost_of_demand| — внутреннее тождество DQ
      out.totals.msRows = msRows;
      out.totals.finSrc = 'margin_sales';
      CHX.loaded.margin_sales = true;
    }
  }catch(e){
    out.notes.push('margin_sales: '+e.message+' — выручка и маржа посчитаны по marking_demand');
  }

  /* 8.2 затраты по блокам операций.
     toFloat64: cost_rate_of_operation и order_operation_volume — Decimal(18,12),
     их произведение переполняет разряд (ошибка 407) */
  const ops = await chQuery(`SELECT ${q('operation_type')} AS t,
      sum(toFloat64(abs(${q('cost_rate_of_operation')})) * toFloat64(${q('order_operation_volume')})) AS c,
      sum(toFloat64(${q('order_operation_volume')})) AS v, count() AS n
    FROM ${S_MD} GROUP BY t`);
  out.totals.byOp = {};
  ops.forEach(r=>{ out.totals.byOp[r.t] = {c:num(r.c), v:num(r.v), n:num(r.n)} });

  /* 8.3 разрезы для тепловой карты сравнения.
     Внешний SELECT ссылается только на колонки подзапроса o_*: подзапрос
     отдаёт o_p / o_prod / o_cl (префикс против глобальной подстановки алиасов,
     ошибка 184), поэтому имена без префикса ClickHouse не находит —
     «Unknown expression identifier 'p'» (ошибка 47). */
  const dimQ = alias => chQuery(
    `SELECT ${q('o_'+alias)} AS k, sum(o_mar) AS mar, sum(o_sal) AS sal, sum(o_unm) AS unm, sum(o_rev) AS rev
     FROM ${ordSub} GROUP BY k ORDER BY mar DESC LIMIT 60`);
  const [dP,dPr,dCl] = await Promise.all([dimQ('p'), dimQ('prod'), dimQ('cl')]);
  out.dims.period  = dP.map(r=>({k:String(r.k), mar:num(r.mar), sal:num(r.sal), unm:num(r.unm)}));
  out.dims.product = dPr.map(r=>({k:String(r.k), mar:num(r.mar), sal:num(r.sal), unm:num(r.unm)}));
  out.dims.client  = dCl.map(r=>({k:String(r.k), mar:num(r.mar), sal:num(r.sal), unm:num(r.unm)}));

  /* 8.4 покрытие спроса (demand_coverage): покрытый/непокрытый/опоздания.
     Сама таблица отдаёт и «покрытый + непокрытый» как demUnc — сохраняем его
     отдельным полем demUncCov: это сверка источников для DQ, а НЕ определение
     неограниченного спроса (см. 8.4.1). */
  let coverageAvailable = false;
  try{
    const gw = granWhere('demand_coverage', gran);
    const pk = periodKeyExpr('demand_coverage', gran);
    const S_DC = src(db,'demand_coverage', gw);
    const cov = await chQuery(`SELECT
        sum(${q('fullfilleddemandqty')} + ${q('unfullfilleddemandqty')}) AS demUnc,
        sum(${q('fullfilleddemandqty')})    AS ff,
        sum(${q('unfullfilleddemandqty')})  AS uf,
        sum(${q('demandfullfilledintimeqty')}) AS inTime,
        sum(${q('demandfullfilledlateqty')})   AS late,
        count() AS orderRows,
        /* Классификация заказов по demand_coverage (задача владельца 2026-10-05):
           всего строк = все заказы неограниченного спроса;
           100% не покрыто — fullfilleddemandqty = 0;
           частично покрыто — unfullfilleddemandqty > 0 И fullfilleddemandqty > 0;
           полностью покрыто — unfullfilleddemandqty = 0 И fullfilleddemandqty > 0.
           Три группы — разбиение всех строк: A + B + C = orderRows (ловится
           проверкой в «Данных и качестве»). Допуск 1e-9 — тот же, что у
           countIf(unm <= 0.000000001) в marking_demand: Decimal(18,12) даёт
           шум в двенадцатом знаке, и строгое «= 0» считало бы его данными.
           Приведение — toFloat64, а НЕ toFloat64OrZero: функции с постфиксом
           OrZero/OrNull принимают только String, а столбцы demand_coverage —
           Decimal, и реальный ClickHouse отвечает «Code: 43. DB::Exception:
           Illegal type Decimal ... should take String argument», роняя весь
           агрегат вместе с demUnc (фолбэком PG) — ошибка продакшена 2026-10-05. */
        countIf(toFloat64(${q('fullfilleddemandqty')}) <= 0.000000001) AS fullyUncoveredOrders,
        countIf(toFloat64(${q('unfullfilleddemandqty')}) > 0.000000001 AND toFloat64(${q('fullfilleddemandqty')}) > 0.000000001) AS partiallyCoveredOrders,
        countIf(toFloat64(${q('unfullfilleddemandqty')}) <= 0.000000001 AND toFloat64(${q('fullfilleddemandqty')}) > 0.000000001) AS fullyCoveredOrders,
        /* Опоздания в заказах: считаем среди ПОЛНОСТЬЮ покрытых (решение
           владельца 2026-10-05), чтобы водопад сходился:
           План продаж (заказов) = В срок + Отгружено с опозданием.
           lateOrdersAll — все строки с признаком опоздания (для тултипа:
           сколько опозданий скрывается у частично покрытых). */
        countIf(toFloat64(${q('demandfullfilledlateqty')}) > 0.000000001) AS lateOrdersAll,
        countIf(toFloat64(${q('unfullfilleddemandqty')}) <= 0.000000001 AND toFloat64(${q('fullfilleddemandqty')}) > 0.000000001 AND toFloat64(${q('demandfullfilledlateqty')}) > 0.000000001) AS lateFullyCoveredOrders,
        sum(${q('lostrevenue')})   AS lostRev,
        sum(${q('plannedrevenue')}) AS planRev,
        sum(${q('propagated_demand')}) AS prop
      FROM ${S_DC}`);
    out.totals.cov = cov[0] || {};
    out.totals.cov.demUncCov = num(out.totals.cov.demUnc);
    /* Сохраняем исходную гранулярность demand_coverage до того, как основной
       independent_demand-счётчик может заменить legacy-поля orderRows. */
    if(Object.prototype.hasOwnProperty.call(out.totals.cov,'orderRows'))
      out.totals.cov.demandCoverageOrderRows=num(out.totals.cov.orderRows);
    if(Object.prototype.hasOwnProperty.call(out.totals.cov,'fullyUncoveredOrders'))
      out.totals.cov.demandCoverageFullyUncoveredOrders=num(out.totals.cov.fullyUncoveredOrders);
    if(Object.prototype.hasOwnProperty.call(out.totals.cov,'partiallyCoveredOrders'))
      out.totals.cov.demandCoveragePartiallyCoveredOrders=num(out.totals.cov.partiallyCoveredOrders);
    if(Object.prototype.hasOwnProperty.call(out.totals.cov,'fullyCoveredOrders'))
      out.totals.cov.demandCoverageFullyCoveredOrders=num(out.totals.cov.fullyCoveredOrders);
    out.totals.covAvailable = true;
    coverageAvailable = true;
    const covP = await chQuery(`SELECT ${pk} AS k,
        sum(${q('fullfilleddemandqty')} + ${q('unfullfilleddemandqty')}) AS demUnc,
        sum(${q('fullfilleddemandqty')}) AS ff,
        sum(${q('unfullfilleddemandqty')}) AS uf,
        sum(${q('demandfullfilledlateqty')}) AS late
      FROM ${S_DC} GROUP BY k ORDER BY k`);
    out.dims.coverage = covP.map(r=>({k:r.k, demUnc:num(r.demUnc), demUncCov:num(r.demUnc),
      ff:num(r.ff), uf:num(r.uf), late:num(r.late)}));
    CHX.loaded.demand_coverage = true;
  }catch(e){ out.notes.push('demand_coverage: '+e.message) }

  /* 8.4.1 НЕОГРАНИЧЕННЫЙ СПРОС = Σ demandqty из таблицы independent_demand.
     Основной источник — вход модели independent_demand. Если PostgreSQL
     прочитан, но после фильтра/дедупликации получен нулевой объём, возвращаем
     прежний фолбэк «покрытый + непокрытый» из demand_coverage, когда покрытие
     доступно. Это позволяет показать рабочий показатель, не скрывая причину
     нулевого PG-входа в заметке загрузки.

     Таблица физически лежит в PostgreSQL (продуктивные столбцы: item,
     demandqty, periodid, sys_id, dmdstream, periodtype, demandtype, loc,
     update_date_time, change_author, unit, date, adjusteddemandqty;
     основной показатель — Σ demandqty; backend использует только бизнес-ключи
     item/demandqty/periodid/dmdstream/periodtype/demandtype/loc/date и не
     зависит от sys_id/update_date_time/adjusteddemandqty); в ClickHouse её нет и не ищем. Источники:
     1) PostgreSQL через backend-прокси (PGX, assets/inplan-pg.js →
        server.js POST /api/pg/unc): схема PG = CH-базе без префикса data_
        (data_public_2 ↔ public_2) — основной и единственный путь к таблице;
     2) фолбэк: прежний «покрытый + непокрытый» из demand_coverage,
        если PG недоступен или вернул ноль при ненулевом покрытии;
        версия помечается uncSrc='demand_coverage'.

     Независимо от источника значение складываем в totals.cov.demUnc — все
     разделы читают его оттуда и получают одно определение; фактический
     источник фиксируется в totals.uncDetail и уходит в статусы. */
  const applyUnc = (total, periods, srcDetail, qtySource)=>{
    out.totals.unc = { demUnc:total, qtySource:qtySource||'demandqty' };
    out.totals.cov = out.totals.cov || {};
    out.totals.cov.demUnc = total;
    out.totals.uncSrc = 'independentdemand';
    out.totals.uncDetail = srcDetail;
    out.totals.uncQty = qtySource||'demandqty';
    /* помесячный разрез покрытия пополняем тоннами входного спроса: у периода
       без строк в покрытии спрос всё равно может существовать (и наоборот) */
    const uncP = (periods||[]).map(r=>({k:String(r.k), demUnc:num(r.demUnc)}));
    if(uncP.length){
      const um = new Map(uncP.map(r=>[r.k, r.demUnc]));
      const covD = (out.dims.coverage || []).slice();
      covD.forEach(r=>{
        const k = String(r.k);
        if(um.has(k)){ r.demUnc = um.get(k); um.delete(k) }
        else r.demUnc = 0;
      });
      um.forEach((v,k)=>covD.push({k, demUnc:v, demUncCov:0, ff:0, uf:0, late:0}));
      covD.sort((a,b)=>String(a.k).localeCompare(String(b.k)));
      out.dims.coverage = covD;
    }
    CHX.loaded.independentdemand = true;
  };
  /* Фолбэк намеренно оформлен тем же helper-путём, что и PG-источник:
     все потребители продолжают читать cov.demUnc, а источник и формула
     остаются видны в totals. */
  const applyCoverageFallback = (reason)=>{
    const cov = out.totals.cov || {};
    const total = num(cov.demUncCov);
    cov.demUnc = total;
    out.totals.cov = cov;
    out.totals.unc = {
      demUnc: total,
      qtySource: 'fullfilleddemandqty + unfullfilleddemandqty'
    };
    out.totals.uncSrc = 'demand_coverage';
    out.totals.uncDetail = 'ClickHouse · demand_coverage';
    out.totals.uncQty = 'fullfilleddemandqty + unfullfilleddemandqty';
    if(reason) out.notes.push(reason);
  };
  const uncErrs = [];
  if(window.PGX && PGX.enabled()){
    try{
      const u = await PGX.uncFor(db, gran);   // backend агрегирует в самой PG
      const totalUnc = num(u.demUnc);
      const qty = u.qtySource||'demandqty';
      const detail = 'PostgreSQL · '+u.schema;
      /* n — точное число строк того же DISTINCT-реестра, по которому посчитана
         Σ demandqty. Сохраняем его отдельно от необязательной детализации API:
         count(*) важнее длины пустого массива, если backend старый/не смог
         прочитать строки. */
      out.independentOrders = Array.isArray(u.orders) ? u.orders : [];
      const hasIndependentOrderCount=!!u.countAvailable||out.independentOrders.length>0;
      if(hasIndependentOrderCount){
        out.totals.independentOrderCount = u.countAvailable
          ? Math.max(0,Math.trunc(num(u.n))) : out.independentOrders.length;
        out.totals.independentOrderCountSource = 'independent_demand';
        out.totals.independentOrderDetailsCount = out.independentOrders.length;
        out.totals.independentOrderDetailsComplete = out.independentOrders.length === out.totals.independentOrderCount;
      }
      /* Для каждой версии нужна такая же классификация входного заказа по
         фактическому результату плана, как в covBasis()/DS основной версии.
         Ошибка этого необязательного запроса не скрывает независимый счётчик:
         матрица тогда покажет резервную классификацию и явную невязку. */
      if(hasIndependentOrderCount && out.totals.independentOrderDetailsComplete && out.totals.independentOrderCount>0){
        try{ out.orderSummary = await loadVersionOrderSummary(db,gran); }
        catch(e){ out.notes.push('independent_demand × marking_demand: '+e.message+' — разбиение заказов сверяется по demand_coverage'); }
      }
      if(totalUnc>0){
        applyUnc(totalUnc, u.periods, detail, qty);
      }else{
        const where = (u.schema||'?')+'.'+(u.table||'independent_demand');
        const zeroNote = 'independent_demand: в '+where+' Σ demandqty = '+totalUnc+
          ' при periodtype '+gran+' (строк после дедупликации по ключевым столбцам: '+
          (num(u.n)||0)+') — PostgreSQL прочитан';
        /* Пользовательский фолбэк: при ненулевом покрытии показываем рабочий
           итог из demand_coverage, но не теряем информацию о нулевом PG-входе. */
        if(coverageAvailable){
          applyCoverageFallback(zeroNote+'; применён фолбэк demand_coverage (покрытый + непокрытый из demand_coverage)');
        }else{
          applyUnc(totalUnc, u.periods, detail, qty);
          out.notes.push(zeroNote+'; demand_coverage пуст — фолбэк не применён');
        }
      }
    }catch(e){ uncErrs.push('PG: '+e.message); }
  }
  if(!out.totals.uncSrc){
    if(coverageAvailable){
      applyCoverageFallback('independent_demand недоступна ('+
        (uncErrs.length?uncErrs.join(' · '):'нет подключения к PostgreSQL')+') — применён фолбэк demand_coverage (покрытый + непокрытый из demand_coverage)');
    }else{
      out.notes.push('independent_demand недоступна ('+
        (uncErrs.length?uncErrs.join(' · '):'нет подключения к PostgreSQL')+') — неограниченный спрос недоступен');
    }
  }

  /* 8.5 мощности: единицы — ЧАСЫ (calendarcapacity/OEE), не тонны.
     Свободно берём расчётом avail − load: поле freecapacity в примере
     расходится (411 против 423) и не согласуется с составляющими. */
  try{
    const gw = granWhere('capacity_view_sp', gran);
    const pk = periodKeyExpr('capacity_view_sp', gran);
    const S_CV = src(db,'capacity_view_sp', gw);
    /* Актуальный доступный фонд: calcavailable — основной, но у складов и
       погрузки он бывает NULL. Тогда используем avail/net/freecapacity.
       greatest безопасен для приведённых Float64 и не теряет 21 600 ч
       погрузки из freecapacity в реальных данных владельца. */
    const cap0=c=>`toFloat64(ifNull(${q(c)},0))`;
    const rowLoadExpr=`greatest(${cap0('totalcapausage')},${cap0('inipcapaplannedusage')},
        ${cap0('pcapaplannedusage')},${cap0('scapaplannedusage')},${cap0('transcapaplannedusage')})`;
    /* freecapacity — остаток, поэтому полный фонд в fallback = free + load. */
    const availExpr = `greatest(${cap0('calcavailablebucketcapacity')},
        ${cap0('availbucketcapacity')}, ${cap0('netavailablecapacity')},
        ${cap0('freecapacity')} + ${rowLoadExpr})`;
    const cap = await chQuery(`SELECT
        ${q('res')} AS rs, any(${q('loc')}) AS pl,
        any(${q('restypedescr')}) AS resTypeDescr, any(${q('restype')}) AS resType,
        any(${q('resgroup')}) AS grp, ${pk} AS periodKey,
        sum(${q('calendarcapacity')}) AS norm,
        sum(${availExpr})             AS avail,
        sum(${q('totalcapausage')})   AS load,
        sum(${q('inipcapaplannedusage')})   AS useIp,
        sum(${q('pcapaplannedusage')})      AS useP,
        sum(${q('scapaplannedusage')})      AS useS,
        sum(${q('transcapaplannedusage')})  AS useT,
        sum(${q('maintenance')} + ${q('plannedmaintenance')} +
            ${q('capitalmaintenance')} + ${q('externalmaintenance')}) AS maint,
        avg(${q('oee')}) AS oee
      FROM ${S_CV} GROUP BY rs, periodKey`);
    out.capacity = cap.map(r=>{
      const avail = num(r.avail), code=num(r.resType);
      const use={ip:num(r.useIp),p:num(r.useP),s:num(r.useS),t:num(r.useT)};
      /* totalcapausage — основной итог. Компоненты страхуют NULL/неполный итог:
         для склада важен scapaplannedusage, для погрузки — transcapaplannedusage.
         Компоненты не суммируем: они могут уже входить в totalcapausage. */
      const load=Math.max(num(r.load),use.ip,use.p,use.s,use.t);
      const preferred=code===2?'s':code===4?'t':code===1?'p':'ip';
      const sourceNames={ip:'inipcapaplannedusage',p:'pcapaplannedusage',
        s:'scapaplannedusage',t:'transcapaplannedusage'};
      const loadSource=num(r.load)>use[preferred]?'totalcapausage':sourceNames[preferred];
      const free=avail-load;                 // отрицательный резерв показывает перегруз
      const util=avail>0?load/avail:(load>0?1:0); // не обрезаем 100%: перегруз должен быть виден
      const typeByCode={1:'Производство',2:'Склад',3:'Разгрузка',4:'Погрузка'};
      const typeRaw=sany(r.resTypeDescr),resType=typeByCode[code]||typeRaw||('Тип '+code);
      const cat={1:'production',2:'warehouse',3:'unloading',4:'loading'}[code]||'production';
      return {rs:sany(r.rs), pl:sany(r.pl), rsName:sany(r.rs),
        resType, resTypeCode:code,
        grp:sany(r.grp), periodKey:String(r.periodKey||''), cat, unit:'h',
        norm:num(r.norm), avail, load, loadSource, free, util,
        use,
        maint:num(r.maint), oee:num(r.oee),
        isBottleneck: util >= 0.90, isCrit: util >= 0.999};
    });
    out.totals.capAvail = S(out.capacity,c=>c.avail);
    out.totals.capLoad  = S(out.capacity,c=>c.load);
    out.totals.capUtil  = out.totals.capAvail>0 ? out.totals.capLoad/out.totals.capAvail : 0;
    out.totals.bnCount  = out.capacity.filter(c=>c.isBottleneck).length;
    out.resTypes        = uq(out.capacity, c=>c.resType);   // справочник строим из данных
    CHX.loaded.capacity_view_sp = true;
  }catch(e){ out.notes.push('capacity_view_sp: '+e.message) }

  /* 8.6 плановые мощности (rescapacity) — вход прогона, для «план vs факт» */
  try{
    const gw = granWhere('rescapacity', gran);
    const pk = periodKeyExpr('rescapacity', gran);
    const S_RC = src(db,'rescapacity', gw);
    const rc = await chQuery(`SELECT ${q('res')} AS rs, any(${q('loc')}) AS pl,
        ${pk} AS periodKey,
        sum(${q('calendarcapacity')})     AS norm,
        sum(${q('netavailbucketcapacity')}) AS availNet,
        sum(${q('availbucketcapacity')})  AS avail,
        sum(${q('capaexpansion')})        AS expansion,
        sum(${q('maintenance')} + ${q('plannedmaintenance')}) AS maint
      FROM ${S_RC} GROUP BY rs, periodKey`);
    out.capacityPlan = rc.map(r=>({rs:sany(r.rs), pl:sany(r.pl),
      periodKey:String(r.periodKey||''), unit:'h',
      norm:num(r.norm), avail:num(r.avail)||num(r.availNet),
      expansion:num(r.expansion), maint:num(r.maint)}));
    out.totals.planAvail = S(out.capacityPlan,c=>c.avail);
    out.totals.expansion = S(out.capacityPlan,c=>c.expansion);
    CHX.loaded.rescapacity = true;
  }catch(e){ out.notes.push('rescapacity: '+e.message) }

  /* 8.7 экономика отказов: периодные ставки перекрывают безпериодные */
  try{
    const gw = granWhere('demand_cost', gran);
    const S_DCst = src(db,'demand_cost', gw);
    const dc = await chQuery(`SELECT
        ${q('item')} AS item, ${q('loc')} AS loc,
        ${q('demandtype')} AS dt, ${q('dmdstream')} AS stream,
        avg(${q('nondelcostrate')})   AS nonDel,
        avg(${q('latedelivcostrate')}) AS lateRate,
        avg(${q('latedelivperiods')})  AS latePeriods
      FROM ${S_DCst} GROUP BY item, loc, dt, stream LIMIT 20000`);
    out.penalty = dc.map(r=>({item:sany(r.item), loc:sany(r.loc), dt:num(r.dt),
      stream:sany(r.stream), nonDel:num(r.nonDel), lateRate:num(r.lateRate),
      latePeriods:num(r.latePeriods), grain:'period'}));
    CHX.loaded.demand_cost = true;
  }catch(e){ out.notes.push('demand_cost: '+e.message) }
  try{
    const S_TI = src(db,'demand_cost_ti');
    const ti = await chQuery(`SELECT ${q('item')} AS item, ${q('loc')} AS loc,
        ${q('demandtype')} AS dt, ${q('dmdstream')} AS stream,
        avg(${q('nondelcostrate')}) AS nonDel, avg(${q('latedelivcostrate')}) AS lateRate,
        avg(${q('latedelivperiods')}) AS latePeriods,
        avg(${q('priority')}) AS priority, avg(${q('quota')}) AS quota
      FROM ${S_TI} GROUP BY item, loc, dt, stream LIMIT 20000`);
    out.penaltyFlat = ti.map(r=>({item:sany(r.item), loc:sany(r.loc), dt:num(r.dt),
      stream:sany(r.stream), nonDel:num(r.nonDel), lateRate:num(r.lateRate),
      latePeriods:num(r.latePeriods), priority:num(r.priority), quota:num(r.quota),
      grain:'flat'}));
    CHX.loaded.demand_cost_ti = true;
  }catch(e){ out.notes.push('demand_cost_ti: '+e.message) }

  /* 8.8 оценка штрафов: ставка × неудовлетворённый объём */
  out.totals.penaltyNonDel = 0;
  if(out.penalty || out.penaltyFlat){
    const key = r => [r.item,r.loc,r.dt,r.stream].join('|');
    const rate = new Map();
    (out.penaltyFlat||[]).forEach(r=>rate.set(key(r), r));   // fallback
    (out.penalty||[]).forEach(r=>rate.set(key(r), r));       // период перекрывает
    try{
      const gw = granWhere('demand_coverage', gran);
      const S_DC = src(db,'demand_coverage', gw);
      const uf = await chQuery(`SELECT ${q('item')} AS item, ${q('loc')} AS loc,
          ${q('demandtype')} AS dt, ${q('dmdstream')} AS stream,
          sum(${q('unfullfilleddemandqty')}) AS uf,
          sum(${q('demandfullfilledlateqty')}) AS late
        FROM ${S_DC} GROUP BY item, loc, dt, stream`);
      let pen = 0, penLate = 0;
      uf.forEach(r=>{
        const k = [sany(r.item),sany(r.loc),num(r.dt),sany(r.stream)].join('|');
        const rr = rate.get(k);
        if(rr){
          pen     += num(r.uf)   * (rr.nonDel||0);
          penLate += num(r.late) * (rr.lateRate||0) * (rr.latePeriods||1);
        }
      });
      out.totals.penaltyNonDel = pen;
      out.totals.penaltyLate   = penLate;
    }catch(e){ out.notes.push('penalty calc: '+e.message) }
  }

  /* 8.9 ПРИОРИТЕТНАЯ ВЫРУЧКА: выполненный спрос × цена спроса (2026-10-07).
     Методика владельца: выручка = Σ fullfilleddemandqty (demand_coverage) ×
     цена из справочника demand_cost / demand_cost_ti; сшивка по
     item + loc + dmdstream + demandtype + период. Нет цены в периоде строки —
     берём цену ближайшего периода (в любую сторону, при равном удалении —
     более ранний). demand_cost (по периодам) приоритетнее demand_cost_ti
     (без периодов); строки demand_cost без распознаваемого периода работают
     как безпериодная цена. Колонка цены — nondelcostrate (решение владельца),
     при её отсутствии/нулевых значениях — первый подходящий кандидат
     (наборы колонок различаются между версиями планов → смотрим
     system.columns). Колонка периода — periodid, если есть, иначе штатные
     date/datefr; обе тянутся одновременно и канонизируются covPeriodCanon,
     поэтому periodid ↔ date разных таблиц сопоставимы.

     Метод приоритетен над margin_sales: при успехе totals.rev = Σ qty×цена,
     источник — totals.revSrc, прежние итоги сохраняются для сверок DQ
     (revMd — marking_demand, revMs — margin_sales). Маржа и себестоимость
     НЕ пересчитываются. Любая ошибка или пусто → тихий возврат к прежней
     цепочке margin_sales → marking_demand; заметка — только когда цены есть,
     а сопоставить не удалось (или все нулевые), и про объём без цены. */
  if(coverageAvailable){
    try{
      /* фактические колонки таблиц (паттерн loadMainDetail). Нет прав на
         system.columns → знаем только гарантированную nondelcostrate и
         штатные колонки периода из реестра TABLES. */
      const cpCols = {};
      try{
        const cl = await chQuery(`SELECT table AS t, name FROM system.columns
          WHERE database = ${qs(db)}
            AND lower(table) IN ('demand_coverage','demand_cost','demand_cost_ti')`);
        cl.forEach(r=>{
          const t = String(r.t||'').toLowerCase();
          if(t) (cpCols[t] = cpCols[t] || new Set()).add(String(r.name).toLowerCase());
        });
      }catch(e){ /* колонки неизвестны — работаем по реестру */ }
      const cpKnow = Object.keys(cpCols).length > 0;
      const cpTabCols = t => cpKnow ? (cpCols[t] || new Set()) : null;  // null = нет информации
      const cpCol = (t, want, dflt) => {
        const s = cpTabCols(t);
        if(!s) return dflt;                      // нет информации — колонка реестра
        return want.some(c => s.has(c)) ? want.find(c => s.has(c)) : '';
      };
      /* кандидаты цены: nondelcostrate приоритетен (владелец 2026-10-07),
         далее — другие правдоподобные имена колонки цены */
      const CP_PRICE_COLS = ['nondelcostrate','price','demandprice','demandcost','demand_cost','cost','unitcost','value'];
      const dcCand = cpKnow ? CP_PRICE_COLS.filter(c=>cpTabCols('demand_cost').has(c)) : ['nondelcostrate'];
      const tiCand = cpKnow ? CP_PRICE_COLS.filter(c=>cpTabCols('demand_cost_ti').has(c)) : ['nondelcostrate'];
      /* колонки периода: periodid приоритетнее штатной date/datefr; тянутся обе */
      const covPid = cpCol('demand_coverage', ['periodid'], '');
      const covPd  = cpCol('demand_coverage', ['date'], TABLES.demand_coverage.periodCol);
      const dcPid  = cpCol('demand_cost', ['periodid'], '');
      const dcPd   = cpCol('demand_cost', ['datefr'], TABLES.demand_cost.periodCol);

      /* объём выполненного спроса, сгруппированный по ключу + период */
      const S_DCc = src(db,'demand_coverage', granWhere('demand_coverage', gran));
      const vol = await chQuery(`SELECT
          ${q('item')} AS item, ${q('loc')} AS loc, ${q('dmdstream')} AS stream, ${q('demandtype')} AS dt,
          toString(${covPid ? q(covPid) : "''"}) AS vpid,
          toString(${covPd ? q(covPd) : "''"}) AS vdate,
          sum(toFloat64(${q('fullfilleddemandqty')})) AS ff,
          count() AS cpn
        FROM ${S_DCc}
        WHERE toFloat64(${q('fullfilleddemandqty')}) > 0.000000001
        GROUP BY item, loc, stream, dt, vpid, vdate
        LIMIT 200001`);
      if(vol.length > 200000)
        throw new Error('в demand_coverage больше 200000 групп товар×локация×поток×тип×период');

      /* цены demand_cost — по периодам. Без фильтра periodtype: ближайший
         период ищем по всему справочнику; дедупликация src() стандартная.
         Строки справочника без распознаваемого периода — безпериодная цена. */
      let dcRows = [];
      if(dcCand.length && (dcPid || dcPd)){
        try{
          const exprs = dcCand.map((c,i)=>`avg(toFloat64(${q(c)})) AS pc${i}`).join(', ');
          dcRows = await chQuery(`SELECT
              ${q('item')} AS item, ${q('loc')} AS loc, ${q('dmdstream')} AS stream, ${q('demandtype')} AS dt,
              toString(${dcPid ? q(dcPid) : "''"}) AS vpid,
              toString(${dcPd ? q(dcPd) : "''"}) AS vdate,
              count() AS cpn${exprs ? ', ' + exprs : ''}
            FROM ${src(db,'demand_cost')}
            GROUP BY item, loc, stream, dt, vpid, vdate
            LIMIT 200001`);
          if(dcRows.length > 200000) dcRows = [];
        }catch(e){ dcRows = [] }
      }
      /* цены demand_cost_ti — без периодов */
      let tiRows = [];
      if(tiCand.length){
        try{
          const exprs = tiCand.map((c,i)=>`avg(toFloat64(${q(c)})) AS pc${i}`).join(', ');
          tiRows = await chQuery(`SELECT
              ${q('item')} AS item, ${q('loc')} AS loc, ${q('dmdstream')} AS stream, ${q('demandtype')} AS dt,
              count() AS cpn${exprs ? ', ' + exprs : ''}
            FROM ${src(db,'demand_cost_ti')}
            GROUP BY item, loc, stream, dt
            LIMIT 200001`);
          if(tiRows.length > 200000) tiRows = [];
        }catch(e){ tiRows = [] }
      }

      /* колонка цены: первая кандидатная колонка с хоть одним ненулевым
         значением (nondelcostrate может существовать, но быть пустой) */
      const cpPickIdx = (rows, cand) => {
        for(let i=0; i<cand.length; i++)
          if(rows.some(r => Math.abs(num(r['pc'+i])) > 1e-9)) return i;
        return -1;
      };
      const dcIdxCol = cpPickIdx(dcRows, dcCand);
      const tiIdxCol = cpPickIdx(tiRows, tiCand);

      /* нормализация ключа строки: пробелы/регистр, demandtype-числа к числу
         ('1' и 1 — один ключ), прочие значения — как строки */
      const nk  = v => String(v==null?'':v).trim().toLowerCase();
      const dtk = v => {
        const s = String(v==null?'':v).trim();
        return /^-?\d+(\.\d+)?$/.test(s) ? 'n'+Number(s) : 's'+s.toLowerCase();
      };
      const rkey = r => nk(r.item)+'|'+nk(r.loc)+'|'+nk(r.stream)+'|'+dtk(r.dt);
      const mean = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;

      /* индекс периодных цен: ключ строки → {exact: ключ периода → [цены],
         list: [{msList, price}], flat: [цены без периода]} */
      const buildIdx = (rows, colIdx) => {
        const idx = new Map();
        rows.forEach(r=>{
          const price = num(r['pc'+colIdx]);
          if(!Number.isFinite(price)) return;
          const k = rkey(r);
          let e = idx.get(k);
          if(!e){ e = {exact:new Map(), list:[], flat:[]}; idx.set(k,e) }
          const c1 = covPeriodCanon(r.vpid), c2 = covPeriodCanon(r.vdate);
          [c1,c2].forEach(c=>{
            if(c.k){
              if(!e.exact.has(c.k)) e.exact.set(c.k,[]);
              e.exact.get(c.k).push(price);
            }
          });
          const msList = [c1.ms,c2.ms].filter(Number.isFinite);
          if(msList.length) e.list.push({msList, price});
          if(!c1.k && !c2.k) e.flat.push(price);
        });
        return idx;
      };
      const dcIdx = dcIdxCol >= 0 ? buildIdx(dcRows, dcIdxCol) : new Map();
      const tiIdx = new Map();
      if(tiIdxCol >= 0)
        tiRows.forEach(r=>{
          const price = num(r['pc'+tiIdxCol]);
          if(!Number.isFinite(price)) return;
          const k = rkey(r);
          if(!tiIdx.has(k)) tiIdx.set(k,[]);
          tiIdx.get(k).push(price);
        });

      /* сшивка: точный период → ближайший (|Δдата|, при равном удалении более
         ранний) → безпериодная цена demand_cost → цена demand_cost_ti */
      let rev=0, ffTotal=0, ffMatched=0, ffExact=0, ffNearest=0, ffFlatDc=0, ffFlatTi=0, ffNoPrice=0, ffZero=0;
      vol.forEach(r=>{
        const ff = num(r.ff);
        if(!(ff>0)) return;
        ffTotal += ff;
        const k = rkey(r);
        const e = dcIdx.get(k);
        const c1 = covPeriodCanon(r.vpid), c2 = covPeriodCanon(r.vdate);
        const keySet = new Set([c1.k,c2.k].filter(Boolean));
        const msList = [c1.ms,c2.ms].filter(Number.isFinite);
        let price = null, bucket = '';
        if(e){
          const ex = [];
          keySet.forEach(kk => (e.exact.get(kk)||[]).forEach(p => ex.push(p)));
          if(ex.length){ price = mean(ex); bucket = 'exact' }
          else if(msList.length && e.list.length){
            let bd=Infinity, bms=Infinity, bp=[];
            e.list.forEach(p => p.msList.forEach(ms => msList.forEach(cm=>{
              const d = Math.abs(ms-cm);
              if(d<bd || (d===bd && ms<bms)){ bd=d; bms=ms; bp=[p.price] }
              else if(d===bd && ms===bms) bp.push(p.price);
            })));
            price = mean(bp); bucket = 'nearest';
          }
          if(price==null && e.flat.length){ price = mean(e.flat); bucket = 'flatdc' }
        }
        if(price==null){
          const fp = tiIdx.get(k);
          if(fp && fp.length){ price = mean(fp); bucket = 'flatti' }
        }
        if(price==null){ ffNoPrice += ff; return }
        rev += ff*price; ffMatched += ff;
        if(bucket==='exact') ffExact += ff;
        else if(bucket==='nearest') ffNearest += ff;
        else if(bucket==='flatdc') ffFlatDc += ff;
        else ffFlatTi += ff;
        if(Math.abs(price) <= 1e-9) ffZero += ff;
      });

      const pricesExist = (dcIdxCol>=0 && dcRows.length>0) || (tiIdxCol>=0 && tiRows.length>0);
      if(rev>0 && ffMatched>0){
        const usesDc = (ffExact+ffNearest+ffFlatDc) > 0, usesTi = ffFlatTi > 0;
        const label = usesDc && usesTi ? 'demand_coverage × demand_cost + demand_cost_ti'
          : usesTi ? 'demand_coverage × demand_cost_ti' : 'demand_coverage × demand_cost';
        const prevRev = num(out.totals.rev);
        /* прежние итоги — для сверок DQ: revMd всегда итог marking_demand,
           revMs — итог margin_sales, если она была источником до подмены */
        if(out.totals.finSrc==='margin_sales') out.totals.revMs = prevRev;
        else out.totals.revMd = prevRev;
        out.totals.rev = rev;
        out.totals.revSrc = label;
        out.totals.covPrice = {rev, ffTotal, ffMatched, ffExact, ffNearest, ffFlatDc, ffFlatTi,
          ffNoPrice, ffZero, colDc:dcIdxCol>=0?dcCand[dcIdxCol]:'', colTi:tiIdxCol>=0?tiCand[tiIdxCol]:'',
          priceRows:dcRows.length, flatRows:tiRows.length, covRows:vol.length};
        if(ffNoPrice>0)
          out.notes.push('цены спроса: у '+nf(ffNoPrice)+' т выполненного спроса нет цены в demand_cost/demand_cost_ti (ключ товар×локация×поток×тип не встретился) — объём учтён с нулевой ценой');
      }else if(pricesExist && ffMatched===0){
        out.notes.push('цены спроса: справочник demand_cost/demand_cost_ti загружен, но ни одна строка demand_coverage не сопоставилась по item+loc+dmdstream+demandtype — выручка посчитана по прежней цепочке (margin_sales, фолбэк marking_demand)');
      }else if(pricesExist && rev===0 && ffMatched>0){
        out.notes.push('цены спроса: все сопоставленные цены нулевые — выручка посчитана по прежней цепочке (margin_sales, фолбэк marking_demand)');
      }
    }catch(e){
      out.notes.push('цены спроса: '+e.message+' — выручка посчитана по прежней цепочке (margin_sales, фолбэк marking_demand)');
    }
  }
  return out;
}
CHX.loadVersionAgg = loadVersionAgg;

/* ─────────────── 9. ОСНОВНАЯ СХЕМА: ДЕТАЛИ ─────────────── */
const T2 = {movement:'mv', production:'pd', procurement:'pc', stock:'st'};

async function loadMainDetail(db, gran, limitOrders){
    /* заказы: дедуп до order_id, отсечение по марже — детали нужны для топа */
  const S_MD = src(db,'marking_demand');

  /* Набор колонок marking_demand различается между схемами/версиями:
     в части схем нет dmdstream, demand_demandtype, margin_per_hour и т.п.
     Без проверки запрос падает с ошибкой 47 «Unknown expression identifier».
     Читаем фактический список колонок и включаем только существующие. */
  let mdCols = new Set();
  try{
    const cl = await chQuery(`SELECT name FROM system.columns
      WHERE database = ${qs(db)} AND table = 'marking_demand'`);
    mdCols = new Set(cl.map(r=>String(r.name).toLowerCase()));
  }catch(e){ /* нет прав на system.columns — работаем полным набором, как раньше */ }
  const has = c => !mdCols.size || mdCols.has(String(c).toLowerCase());
  const orNot = (col, fallback) => has(col) ? `any(${q(col)})` : fallback;
  const colOr = (col, fallback) => has(col) ? q(col) : fallback;

  const ords = await chQuery(`SELECT order_id AS id,
      ${orNot('demand_period','0')}      AS p,
      ${orNot('demand_location',"''")}   AS loc,
      ${orNot('demand_product',"''")}    AS prod,
      ${orNot('demand_client',"''")}     AS cl,
      ${orNot('demand_demandtype','0')}  AS dtype,
      ${orNot('dmdstream',"''")}         AS stream,
      ${orNot('demand_volume','0')}      AS dem,
      ${orNot('results_sale','0')}       AS sal,
      ${orNot('unsatisfied_demand','0')} AS unm,
      ${orNot('price','0')}              AS price,
      ${orNot('cost_per_unit_order','0')} AS cpt,
      ${orNot('margin_per_unit','0')}    AS mpt,
      ${orNot('revenue','0')}            AS rev,
      ${orNot('cost_of_demand','0')}     AS cost,
      ${orNot('total_margin','0')}       AS mar,
      ${orNot('demand_demandtypepriority','0')} AS prio,
      ${orNot('margin_per_hour','0')}    AS mph
    FROM ${S_MD} GROUP BY order_id
    ORDER BY abs(mar) DESC
    LIMIT ${Number(limitOrders)||2000}`);

  const orders = ords.map(r=>({
    id:num(r.id), p:pnum(r.p), d:'', loc:sany(r.loc), prod:sany(r.prod),
    cl:sany(r.cl)||'—', stream:sany(r.stream),
    /* Приоритет заказа определяется колонкой demandtype (в marking_demand она
       называется demand_demandtype). demand_demandtypepriority — запасной
       вариант: build() возьмёт его, только если demandtype пуст или нулевой.
       Нормализация (pr / dtl / pk / prioSrc) — в build() из index.html, чтобы
       XLSX и ClickHouse не расходились в правилах.
       Прежнее pr:num(r.prio)||2 подставляло «2» всем заказам, когда колонки
       приоритета в схеме не было, — отсутствие данных выглядело как данные. */
    dt:num(r.dtype), dtype:num(r.dtype), prioAlt:num(r.prio),
    pr:num(r.dtype)>0?num(r.dtype):num(r.prio),
    dem:num(r.dem), sal:num(r.sal), unm:num(r.unm),
    price:num(r.price), cpt:Math.abs(num(r.cpt)), mpt:num(r.mpt),
    rev:num(r.rev), cost:Math.abs(num(r.cost)), mar:num(r.mar),
    mph:num(r.mph)
  }));
  if(!orders.length) throw new Error('В схеме '+db+' не найдено заказов в marking_demand');

  /* операции: только для загруженных заказов, чанками по IN */
  const ids = orders.map(o=>o.id);
  const ops = [];
  for(let i=0;i<ids.length;i+=500){
    const chunk = ids.slice(i,i+500);
    const rows = await chQuery(`SELECT
        ${colOr('order_id','0')} AS o, ${colOr('demand_period','0')} AS p,
        ${colOr('operation_type',"''")} AS type, ${colOr('location',"''")} AS pl,
        ${colOr('product',"''")} AS pr, ${colOr('resource',"''")} AS rs,
        ${colOr('loc_from',"''")} AS fr, ${colOr('loc_to',"''")} AS to,
        ${colOr('transport_type',"''")} AS tm, ${colOr('order_operation_volume','0')} AS v,
        abs(${colOr('cost_rate_of_operation','0')}) AS r, ${colOr('supplier',"''")} AS vd,
        ${colOr('bom_num',"''")} AS rt, ${colOr('order_operation_id',"''")} AS oid,
        ${colOr('resource_consumption_operation','0')} AS rc
      FROM ${src(db,'marking_demand', `${q('order_id')} IN (${chunk.join(',')})`)}`);
    rows.forEach(r=>{
      const t = T2[String(r.type||'').toLowerCase()];
      if(!t) return;
      const oid = sany(r.oid);
      ops.push({o:num(r.o), p:pnum(r.p), d:'', t,
        pl:sany(r.pl), pr:sany(r.pr), rs:(t==='mv'?'':sany(r.rs)),
        fr:sany(r.fr), to:sany(r.to), tm:sany(r.tm),
        v:num(r.v), r:Math.abs(num(r.r)), vd:sany(r.vd), rt:sany(r.rt),
        oid, dp:oid?oid.split('.').length:1,
        rc:num(r.rc)||undefined});
    });
  }
  return {orders, ops};
}
CHX.loadMainDetail = loadMainDetail;

/* точечный drill-down: операции конкретного заказа (для «Цепочки заказа») */
CHX.loadOpsForOrder = async function(orderId){
  const db = CHX.cfg.base; if(!db) return [];
  const rows = await chQuery(`SELECT ${q('order_id')} AS o, ${q('demand_period')} AS p,
      ${q('operation_type')} AS type, ${q('location')} AS pl, ${q('product')} AS pr,
      ${q('resource')} AS rs, ${q('loc_from')} AS fr, ${q('loc_to')} AS to,
      ${q('transport_type')} AS tm, ${q('order_operation_volume')} AS v,
      abs(${q('cost_rate_of_operation')}) AS r, ${q('supplier')} AS vd,
      ${q('bom_num')} AS rt, ${q('order_operation_id')} AS oid,
      ${q('resource_consumption_operation')} AS rc
    FROM ${src(db,'marking_demand', `${q('order_id')} = ${Number(orderId)}`)}`);
  const out = [];
  rows.forEach(r=>{
    const t = T2[String(r.type||'').toLowerCase()]; if(!t) return;
    const oid = sany(r.oid);
    out.push({o:num(r.o), p:pnum(r.p), d:'', t, pl:sany(r.pl), pr:sany(r.pr),
      rs:(t==='mv'?'':sany(r.rs)), fr:sany(r.fr), to:sany(r.to), tm:sany(r.tm),
      v:num(r.v), r:Math.abs(num(r.r)), vd:sany(r.vd), rt:sany(r.rt),
      oid, dp:oid?oid.split('.').length:1, rc:num(r.rc)||undefined});
  });
  return out;
};

/* ─────────────── 10. ГЛАВНАЯ ТОЧКА ВХОДА ─────────────── */
/* Сводим вход independent_demand с результатом marking_demand.
   В independent_demand нет order_id, поэтому бизнес-ключ — товар, локация,
   тип и поток спроса; при повторах выбирается строка с ближайшим объёмом.
   Непарные строки — реальные входные заказы, не попавшие в план. */
function mergeIndependentOrders(markingOrders, inputRows, penalties){
  if(!Array.isArray(inputRows) || !inputRows.length) return markingOrders;
  const norm=v=>String(v==null?'':v).trim().toLowerCase();
  const key=(prod,loc,dt,stream)=>[norm(prod),norm(loc),norm(dt),norm(stream)].join('|');
  const rank=v=>{
    let s=String(v==null?'':v).replace(/\D/g,'');
    if(s.length===9 && /^[1-6]/.test(s))s=s.slice(1); // periodid: 4YYYYMMDD
    return s ? Number(s.slice(0,8)) : 0;
  };
  const dueRanks=[...new Set(inputRows.map(r=>rank(r.periodid||r.date)).filter(Boolean))].sort((a,b)=>a-b);
  const planPeriods=[...new Set(markingOrders.map(o=>pnum(o.p)))].sort((a,b)=>a-b);
  /* Совпавшие строки дают точный мост «календарный periodid → P-бакет плана».
     Он нужен непарным строкам: раньше 420270401 превращался в P420270401, пока
     тот же апрель в marking_demand назывался P0. */
  const dueToPlan=new Map();
  const periodPosition=(v,isDue)=>{
    const r=rank(v);if(!r&&String(v)!=='0'&&String(v).toUpperCase()!=='P0')return 0;
    if(isDue||r>=10000){const i=dueRanks.indexOf(r);return i>=0?i+1:0}
    const p=pnum(v);return planPeriods.includes(0)?p+1:(p===0?1:p);
  };
  const canonicalPeriod=due=>{
    const r=rank(due),i=dueRanks.indexOf(r);
    if(dueToPlan.has(r))return dueToPlan.get(r);
    /* Для неизвестной даты продолжаем ближайшее известное соответствие. */
    const anchors=[...dueToPlan.entries()].map(([dr,p])=>({i:dueRanks.indexOf(dr),p:pnum(p)}))
      .filter(a=>a.i>=0).sort((a,b)=>Math.abs(a.i-i)-Math.abs(b.i-i));
    if(anchors.length&&i>=0)return Math.max(0,anchors[0].p+(i-anchors[0].i));
    if(i>=0&&planPeriods[i]!==undefined)return planPeriods[i];
    if(i>=0&&planPeriods.length)return Math.max(0,planPeriods[0]+i);
    return Math.max(0,i);
  };
  const pools=new Map();
  inputRows.forEach((r,i)=>{
    const x=Object.assign({_i:i,_used:false},r);
    const k=key(x.item,x.loc,x.demandtype,x.dmdstream);
    if(!pools.has(k))pools.set(k,[]);
    pools.get(k).push(x);
  });
  const compatible=(a,b)=>!norm(a)||!norm(b)||norm(a)===norm(b);
  const lateAllowed=o=>(penalties||[]).some(r=>num(r.latePeriods)>0
    &&norm(r.item)===norm(o.prod)&&norm(r.loc)===norm(o.loc)
    &&compatible(r.dt,o.dt)&&compatible(r.stream,o.stream));
  const allInputs=[...pools.values()].flat();
  const out=markingOrders.map(o=>{
    let list=(pools.get(key(o.prod,o.loc,o.dt,o.stream))||[]).filter(r=>!r._used);
    /* В некоторых marking_demand нет demandtype/dmdstream. Не превращаем
       совпадающий товар той же локации в ложный «не попал в план» из-за
       отсутствующего необязательного атрибута. */
    if(!list.length)list=allInputs.filter(r=>!r._used&&norm(r.item)===norm(o.prod)
      &&norm(r.loc)===norm(o.loc)&&compatible(r.demandtype,o.dt)&&compatible(r.dmdstream,o.stream));
    if(!list.length)return o;
    list.sort((a,b)=>Math.abs(num(a.demandqty)-num(o.dem))-Math.abs(num(b.demandqty)-num(o.dem)));
    const r=list[0];r._used=true;
    const due=r.periodid||r.date, dueRank=rank(due),allowed=lateAllowed(o);
    if(dueRank)dueToPlan.set(dueRank,pnum(o.p));
    const late=allowed&&num(o.sal)>ORD_TOL&&periodPosition(o.p,false)>0&&periodPosition(due,true)>0
      &&periodPosition(o.p,false)>periodPosition(due,true);
    return Object.assign({},o,{independentSourceId:r.sourceId,duePeriod:due,
      duePeriodKey:normalizePeriodKey(due),lateAllowed:allowed,late:!!late});
  });
  inputRows.forEach((r,i)=>{
    const pool=pools.get(key(r.item,r.loc,r.demandtype,r.dmdstream))||[];
    const x=pool.find(v=>v._i===i);
    if(!x || x._used)return;
    const qty=num(r.demandqty), due=r.periodid||r.date;
    out.push({
      id:-1000000000-i, idLabel:'ID-'+(r.sourceId||i+1), independentOnly:true,
      independentSourceId:r.sourceId||i+1, p:canonicalPeriod(due), d:normalizePeriodKey(r.date||due),
      periodSource:String(due||''), periodKey:normalizePeriodKey(due),
      loc:String(r.loc||''), prod:String(r.item||''), cl:'—', stream:String(r.dmdstream||''),
      dt:r.demandtype, dtype:r.demandtype, pr:0, dem:qty, sal:0, unm:qty,
      price:0,cpt:0,mpt:0,rev:0,cost:0,mar:0,mph:0,duePeriod:due,
      lateAllowed:lateAllowed({prod:r.item,loc:r.loc,dt:r.demandtype,stream:r.dmdstream}),late:false
    });
  });
  /* Infer economics for demand that never entered the plan. */
  const median=xs=>{xs=xs.filter(Number.isFinite).sort((a,b)=>a-b);return xs.length?xs[Math.floor(xs.length/2)]:0};
  const refs=out.filter(o=>!o.independentOnly&&num(o.sal)>ORD_TOL);
  const gp=median(refs.map(o=>num(o.price)).filter(v=>v>0));
  const gc=median(refs.map(o=>num(o.cpt)).filter(v=>v>=0));
  out.filter(o=>o.independentOnly).forEach(o=>{
    const same=refs.filter(x=>norm(x.prod)===norm(o.prod)&&norm(x.loc)===norm(o.loc));
    const byProd=same.length?same:refs.filter(x=>norm(x.prod)===norm(o.prod));
    const src=byProd.length?byProd:refs;
    o.price=median(src.map(x=>num(x.price)).filter(v=>v>0))||gp;
    o.cpt=median(src.map(x=>num(x.cpt)).filter(v=>v>=0))||gc;
    /* Цена и маржа на тонну нужны для оценки потерь. Фактические выручка,
       себестоимость и валовая маржа остаются нулевыми: заказ не был продан и
       не должен попадать в финансовый результат как будто выполненный. */
    o.mpt=Math.max(0,o.price-o.cpt); o.rev=0; o.cost=0; o.mar=0;
  });
  let next=out.filter(o=>!o.independentOnly).length;
  out.filter(o=>o.independentOnly).forEach(o=>o.idLabel='ID-'+(++next));
  return out;
}
CHX.mergeIndependentOrders=mergeIndependentOrders;

/* Точное разложение реестра independent_demand по результату плана.
   Строки плана без пары НЕ прибавляются к числу входных заказов; непарные
   входные строки попадают в 100%-непокрытые. Поэтому total и три части имеют
   один и тот же охват и должны складываться без остатка. */
function independentOrderBreakdown(markingOrders, inputRows, penalties){
  const inputs=Array.isArray(inputRows)?inputRows:[];
  const merged=mergeIndependentOrders(markingOrders||[],inputs,penalties||[]);
  const rows=merged.filter(o=>o.independentOnly||o.independentSourceId!=null);
  const fullUnc=rows.filter(o=>num(o.sal)<=ORD_TOL).length;
  const part=rows.filter(o=>num(o.sal)>ORD_TOL&&num(o.unm)>ORD_TOL).length;
  const full=rows.filter(o=>num(o.sal)>ORD_TOL&&num(o.unm)<=ORD_TOL).length;
  const lateRows=rows.filter(o=>o.late);
  const lateFull=rows.filter(o=>o.late&&num(o.sal)>ORD_TOL&&num(o.unm)<=ORD_TOL).length;
  return {
    total:inputs.length, classified:rows.length,
    fullyUncoveredOrders:fullUnc, partiallyCoveredOrders:part, fullyCoveredOrders:full,
    coveredOrders:part+full, delta:inputs.length-(fullUnc+part+full),
    lateOrdersAll:lateRows.length, lateFullyCoveredOrders:lateFull,
    lateFromIndependent:lateRows.reduce((sum,o)=>sum+num(o.sal),0),
    source:'independent_demand × marking_demand'
  };
}
CHX.independentOrderBreakdown=independentOrderBreakdown;

CHX.loadAll = async function(onProgress){
  const c = CHX.cfg;
  if(!c.schemas.length) throw new Error('Не выбрано ни одной схемы');
  if(!c.base) c.base = c.schemas[0];
  const step = m => { if(onProgress) onProgress(m) };
  /* Справочник имён необязательный: грузим параллельно с агрегатами и ждём
     перед формированием подписей. При недоступности остаётся прежний labelFor. */
  const scenarioNamesTask = Promise.resolve()
    .then(()=>CHX.refreshPostgresScenarioLabels())
    .catch(()=>CHX.applyPostgresScenarioRows([]));

  step('Загрузка агрегатов версий…');
  const aggs = [];
  for(const db of c.schemas){
    step(`Агрегаты: ${CHX.labelFor(db)}…`);
    /* У версии может быть свой набор periodtype. Если выбранной общей
       гранулярности в ней нет, фильтр `periodtype = N` не попадёт ни в одну
       строку и периодные агрегаты версии (покрытие, мощности, штрафы)
       прилетят нулями. Берём самую массовую гранулярность ЭТОЙ версии
       и честно помечаем смену в заметках. */
    const opts = await CHX.granOptionsFor(db);
    let g = c.gran;
    if(opts && !opts.some(o=>o.t===g)) g = opts[0].t;
    const a = await loadVersionAgg(db, g);
    if(g !== c.gran)
      a.notes.push('в версии нет periodtype '+c.gran+' — периодные агрегаты (покрытие, мощности, штрафы) посчитаны по periodtype '+g+' ('+CHX.granLabel(g)+')');
    aggs.push(a);
  }
  await scenarioNamesTask;

  /* Сопоставляем каждую PG-строку с заказами всей своей marking_demand-версии.
     Это компактная классификация: полные orderSummary не остаются в памяти после
     расчёта, а независимый total сохраняет backend count(*) из DISTINCT-входа. */
  aggs.forEach(a=>{
    const t=a.totals||{};
    if(t.independentOrderCountSource==='independent_demand' && t.independentOrderDetailsComplete){
      if(t.independentOrderCount===0){
        t.orderStats=independentOrderBreakdown([],[],[]);
      }else if(Array.isArray(a.orderSummary)){
        const penalties=[].concat(a.penaltyFlat||[],a.penalty||[]);
        t.orderStats=independentOrderBreakdown(a.orderSummary,a.independentOrders,penalties);
        if(t.orderStats.delta!==0)
          a.notes.push('independent_demand × marking_demand: '+t.orderStats.delta+' заказ(ов) не попали в разбиение статусов');
      }
    }
    delete a.orderSummary;
  });

  step('Детализация основной схемы…');
  const baseAgg = aggs.find(a=>a.db===c.base) || aggs[0];
  /* Если PG отдал полный реестр входа, загружаем не меньше строк плана:
     иначе заказ за пользовательским detail-limit ошибочно выглядел бы как
     «100% не покрыто» только потому, что его не было в локальной выборке. */
  const detailLimit=Math.max(c.detailOrders||2000,(baseAgg.independentOrders||[]).length);
  const detail = await loadMainDetail(c.base, c.gran, detailLimit);

  /* Построчный вход PG дополняет детализацию: теперь RCA действительно
     содержит все заказы неограниченного спроса, включая не попавшие в план. */
  const penalties=[].concat(baseAgg.penaltyFlat||[],baseAgg.penalty||[]);
  const mergedOrders=mergeIndependentOrders(detail.orders,baseAgg.independentOrders,penalties);
  const baseOrderStats=baseAgg.totals.orderStats;
  const baseOrderInputCount=baseAgg.totals.independentOrderCount;
  const baseHasIndependentCount=baseAgg.totals.independentOrderCountSource==='independent_demand';
  if(baseOrderStats){
    const cov=baseAgg.totals.cov||(baseAgg.totals.cov={});
    Object.assign(cov,{orderRows:baseOrderStats.total,
      fullyUncoveredOrders:baseOrderStats.fullyUncoveredOrders,
      partiallyCoveredOrders:baseOrderStats.partiallyCoveredOrders,
      fullyCoveredOrders:baseOrderStats.fullyCoveredOrders,
      lateOrdersAll:baseOrderStats.lateOrdersAll,
      lateFullyCoveredOrders:baseOrderStats.lateFullyCoveredOrders,
      lateFromIndependent:baseOrderStats.lateFromIndependent});
    baseAgg.totals.orderSource='independent_demand';
    baseAgg.totals.orderStatusSource=baseOrderStats.source;
  }else if((baseAgg.independentOrders||[]).length){
    /* Совместимость со старым backend без счётчика n/orderSummary. В основной
       детализации явно отделяем совпавшие входные строки от plan-only строк,
       иначе total выходил за пределы independent_demand. */
    const linked=mergedOrders.filter(o=>o.independentOnly||o.independentSourceId!=null);
    const fullUnc=linked.filter(o=>num(o.sal)<=ORD_TOL).length;
    const part=linked.filter(o=>num(o.sal)>ORD_TOL&&num(o.unm)>ORD_TOL).length;
    const full=linked.filter(o=>num(o.sal)>ORD_TOL&&num(o.unm)<=ORD_TOL).length;
    const lateRows=linked.filter(o=>o.late);
    const cov=baseAgg.totals.cov||(baseAgg.totals.cov={});
    Object.assign(cov,{orderRows:baseHasIndependentCount?baseOrderInputCount:linked.length,
      fullyUncoveredOrders:fullUnc,partiallyCoveredOrders:part,fullyCoveredOrders:full,
      lateOrdersAll:lateRows.length,
      lateFullyCoveredOrders:lateRows.filter(o=>num(o.sal)>ORD_TOL&&num(o.unm)<=ORD_TOL).length});
    cov.lateFromIndependent=S(lateRows,o=>o.sal);
    baseAgg.totals.orderSource='independent_demand';
    baseAgg.totals.orderStatusSource='independent_demand × marking_demand (детализация)';
  }
  /* сборка DS через существующий build() — вкладки продолжают работать */
  const ds = build({
    name: CHX.labelFor(c.base) + ' · ' + CHX.granLabel(c.gran),
    orders: mergedOrders,
    ops: detail.ops,
    capacity: baseAgg.capacity || []
  });
  ds.src = 'clickhouse';
  ds.schema = c.base;
  ds.gran = c.gran;
  ds.agg = baseAgg;                    // агрегаты для вкладок без деталей
  ds.capacityPlan = baseAgg.capacityPlan || [];
  ds.penalty = baseAgg.penalty || [];
  ds.penaltyFlat = baseAgg.penaltyFlat || [];
  ds.resTypes = baseAgg.resTypes || [];
  ds.detailLimited = detail.orders.length >= detailLimit;
  ds._demo = false;

  CHX.versions = c.schemas.map(db=>{
    const a = aggs.find(x=>x.db===db) || {};
    return {
      id:db, label:CHX.labelFor(db), src:'ch', isBase:(db===c.base),
      agg:a, gran:a.gran || c.gran,   // фактическая гранулярность агрегатов этой версии
      ts:(CHX.state.meta&&CHX.state.meta[db]||{}).ts||''
    };
  });
  CHX.loaded.marking_demand = true;

  window.DS = ds;
  if(typeof window.onCHDataset === 'function') window.onCHDataset(ds, CHX.versions);
  // Сохраняем уже выбранные схемы и основную схему вместе с данными.
  CHX.session.touch();
  const notes = aggs.flatMap(a=>a.notes.map(n=>a.db+' → '+n));
  return {ds, versions:CHX.versions, notes};
};

/* ─────────────── 11. МОДАЛКА ПОДКЛЮЧЕНИЯ ─────────────── */
function modalEl(){
  let m = document.getElementById('chModal');
  if(m) return m;
  m = document.createElement('div');
  m.id = 'chModal';
  m.innerHTML = `<div class="chm-back"></div><div class="chm-win"></div>`;
  document.body.appendChild(m);
  m.querySelector('.chm-back').onclick = ()=>CHX.closeModal();
  return m;
}
CHX.closeModal = ()=>{ const m=document.getElementById('chModal'); if(m) m.style.display='none' };

CHX.openModal = function(){
  const m = modalEl(); m.style.display='block';
  drawModal();
};

/* Текст статуса PG-блока модалки подключения.
   Отдельно показываем состояние backend-прокси: ошибка «нет такого адреса»
   (страница открыта не с server.js) и ошибка Postgres — разные проблемы,
   и раньше они обе выглядели как невнятное «Not found». */
function pgStatText(){
  if(!window.PGX) return '';
  const ps = PGX.state;
  if(ps.lastError){
    const hint = ps.stage==='backend' ? `<br><span class="chm-hint" style="max-width:none">${esc(PGX.backendHint())}</span>` : '';
    return `<span class="neg">${esc(ps.lastError)}</span>${hint}`;
  }
  if(ps.connected){
    const sel = (CHX.cfg.schemas||[]);
    const plan = typeof PGX.schemaPlan==='function' ? PGX.schemaPlan(sel) : [];
    const miss = plan.filter(m=>!m.ok);
    const warn = miss.length
      ? `<br><span class="neg">Схема не найдена у ${miss.length} из ${plan.length} выбранных версий — укажите её вручную ниже, иначе спрос будет взят из demand_coverage</span>`
      : '';
    return `<span class="pos">PG подключён · схем с independent_demand: ${ps.schemas.length}${
      ps.schemas.length?' ('+esc(ps.schemas.slice(0,5).map(x=>x.schema).join(', '))+(ps.schemas.length>5?', …':'')+')':''}</span>${warn}`;
  }
  if(ps.backendOk===false)
    return `<span class="neg">backend-прокси не найден (${esc(PGX.backendLabel())})</span>` +
      `<br><span class="chm-hint" style="max-width:none">${esc(PGX.backendHint())}</span>`;
  if(PGX.enabled()) return 'PG задан — подключится при загрузке данных';
  return 'PG не задан — источник: demand_coverage (покрытый + непокрытый)';
}

/* Соответствие «версия ClickHouse → схема PostgreSQL».
   Нумерация прогонов в CH и схем в PG совпадает не всегда (бывает выбрана
   база data_public_4899, а схемы в Postgres — public_13…public_1726), поэтому
   автоподбор по имени дополнен ручным выбором: он имеет приоритет над любыми
   догадками и запоминается в автосессии. */
function pgMapBlock(){
  if(!window.PGX || !PGX.state.connected) return '';
  const sel = CHX.cfg.schemas||[];
  if(!sel.length)
    return `<div class="chm-note">Выберите схемы ClickHouse ниже — здесь появится их
      соответствие схемам PostgreSQL (откуда брать <code>independent_demand</code>).</div>`;
  const plan = PGX.schemaPlan(sel);
  const opts = PGX.state.schemas||[];
  return `<div class="chm-sec">Соответствие версий и схем PostgreSQL</div>
  <div class="chm-note">Неограниченный спрос версии читается из выбранной здесь схемы.
    «Авто» подбирает по имени (<code>data_public_2</code> → <code>public_2</code>; регистр и
    префикс <code>data_</code> не важны). Если нумерация ClickHouse и Postgres расходится —
    выберите схему вручную, выбор сохранится в автосессии.</div>
  ${plan.map(m=>{
    const label = CHX.labelFor(m.db);
    const auto = m.ok?`авто → ${m.schema}`:`авто → нет схемы «${m.schema}»`;
    return `<div class="chm-row"><label title="${esc(m.db)}">${esc(label)}</label>
      <select data-pgmap="${esc(m.db)}" style="flex:1">
        <option value="">${esc(m.manual?'авто (подбор по имени)':auto)}</option>
        ${opts.map(o=>`<option value="${esc(o.schema)}" ${
          m.manual&&String(o.schema).toLowerCase()===String(m.schema).toLowerCase()?'selected':''}>${
          esc(o.schema)}${o.n?' · '+nf(o.n)+' строк':''}</option>`).join('')}
      </select>
      <span class="chm-hint">${m.ok
        ? `<span class="pos">✓ ${esc(m.schema)}${m.manual?' (вручную)':''}</span>`
        : `<span class="neg">схемы «${esc(m.schema)}» нет — спрос из demand_coverage</span>`}</span></div>`;
  }).join('')}`;
}

function drawModal(){
  const m = modalEl(), w = m.querySelector('.chm-win'), c = CHX.cfg, st = CHX.state;
  const profs = CHX.profiles.all();
  /* Позиция прокрутки списка схем и фокус: drawModal вызывается после каждого
     клика по чекбоксу — без этого список «уезжает» в начало */
  const prevScroll=(document.getElementById('chmDbList')||{}).scrollTop||0;
  const prevFocusId=(document.activeElement&&document.activeElement.id)||'';
  w.innerHTML = `
  <div class="chm-h"><span>⚡ Прямое подключение к ClickHouse</span>
    <span class="chm-x" id="chmX">✕</span></div>
  <div class="chm-note">Версия данных — это проект (база вида <code>data_public*</code>).
    После подключения выберите схемы: одна основная (полная детализация) и до нескольких для сравнения.
    <b>Автосессия на 4 часа включена:</b> параметры и пароль сохраняются в браузере для автоматического
    восстановления после закрытия браузера. Кнопка «Забыть автосессию» удаляет сохранённые данные.</div>

  ${profs.length?`<div class="chm-row"><label>Профиль</label>
    <select id="chmProf"><option value="">— не выбран —</option>
      ${profs.map(p=>`<option value="${esc(p.name)}">${esc(p.name)} · ${esc(p.host)}</option>`).join('')}
    </select><button class="btn" id="chmProfApply">Применить</button>
    <button class="btn d" id="chmProfDrop">Удалить</button></div>`:''}

  <div class="chm-row"><label>Режим</label>
    <select id="chmMode">
      <option value="direct" ${!c.useProxy?'selected':''}>Напрямую в ClickHouse</option>
      <option value="proxy"  ${c.useProxy?'selected':''}>Через прокси (CORS решён на сервере)</option>
    </select></div>
  ${c.useProxy?`
  <div class="chm-row"><label>URL прокси</label>
    <input id="chmProxy" type="text" value="${esc(c.proxyUrl)}" placeholder="/api/ch"></div>`:`
  <div class="chm-row"><label>Хост</label>
    <input id="chmHost" type="text" value="${esc(c.host)}" placeholder="ch.company.ru"></div>
  <div class="chm-row"><label>Порт</label>
    <input id="chmPort" type="number" value="${c.port}"></div>
  <div class="chm-row"><label>Протокол</label>
    <select id="chmProto">
      <option value="https" ${c.proto==='https'?'selected':''}>HTTPS · 443</option>
      <option value="http"  ${c.proto==='http'?'selected':''}>HTTP · 8123</option>
    </select></div>
  <div class="chm-row"><label>Логин</label>
    <input id="chmUser" type="text" value="${esc(c.user)}" placeholder="readonly"></div>
  <div class="chm-row"><label>Пароль</label>
    <input id="chmPass" type="password" value="${esc(c.pass)}" placeholder="пусто — если не задан"></div>`}

  <div class="chm-act">
    <button class="btn p" id="chmConn">${st.connected?'Обновить список схем':'Подключиться'}</button>
    <button class="btn" id="chmSaveProf">Сохранить профиль</button>
    ${CHX.session.exists()?`<button class="btn d" id="chmForgetSession">Забыть автосессию</button>`:''}
    <button class="btn" id="chmClose">Закрыть</button>
    <span id="chmStat" class="chm-stat">${st.lastError
      ?`<span class="neg">${esc(st.lastError)}</span>`
      :(st.connected?`<span class="pos">Подключено · схем: ${st.dbs.length}</span>`:'')}</span>
  </div>

  ${window.PGX?`
  <div class="chm-sec">PostgreSQL — independent_demand (неограниченный спрос)</div>
  <div class="chm-note">Неограниченный спрос (Σ <code>demandqty</code>) лежит в Postgres,
    в схемах <code>public_N</code> ↔ базы ClickHouse <code>data_public_N</code>. Браузер не умеет открывать TCP к Postgres,
    поэтому запросы идут через backend-прокси (<code>server.js</code>, как в дашборде opti).
    Не задан — неограниченный спрос считается как покрытый + непокрытый из
    <code>demand_coverage</code> (ClickHouse).</div>
  <div class="chm-row"><label>Backend</label>
    <input id="pgmBackend" type="text" value="${esc(PGX.cfg.backend)}"
      placeholder="пусто = этот же сервер (npm start)">
    <span class="chm-hint">URL запущенного server.js. Пусто — берётся адрес этой страницы, поэтому
      открывать дашборд нужно по адресу server.js (http://localhost:8080): со статического хостинга
      запросы <code>/api/pg/*</code> упираются в чужой 404</span></div>
  <div class="chm-row"><label>Хост / Порт</label>
    <input id="pgmHost" type="text" value="${esc(PGX.cfg.host)}" style="flex:1">
    <input id="pgmPort" type="number" value="${num(PGX.cfg.port)||48235}" style="width:110px;margin-left:8px"></div>
  <div class="chm-row"><label>База</label>
    <input id="pgmDb" type="text" value="${esc(PGX.cfg.database)}" placeholder="pgs_app_data_db">
    <span class="chm-hint">продуктивная база: <code>pgs_app_data_db</code> — в ней лежат схемы
      <code>public_N</code> с <code>independent_demand</code></span></div>
  <div class="chm-row"><label>Логин</label>
    <input id="pgmUser" type="text" value="${esc(PGX.cfg.user)}" autocomplete="off"
      placeholder="рекомендуется read-only"></div>
  <div class="chm-row"><label>Пароль</label>
    <input id="pgmPass" type="password" value="${esc(PGX.cfg.password)}" autocomplete="new-password"></div>
  <div class="chm-act">
    <select id="pgmSsl">${['auto','off','insecure','strict'].map(v=>
      `<option value="${v}" ${PGX.cfg.ssl===v?'selected':''}>SSL: ${{auto:'авто',off:'выкл',insecure:'без проверки сертификата',strict:'строгий'}[v]}</option>`).join('')}</select>
    <button class="btn" id="pgmTest">Проверить PG</button>
    ${PGX.session.exists()?`<button class="btn d" id="pgmForget">Забыть PG-сессию</button>`:''}
    <span id="pgmStat" class="chm-stat">${pgStatText()}</span>
  </div>
  ${pgMapBlock()}`:''}

  ${st.connected?`
  <div class="chm-sec">Схемы (версии планов)</div>
  ${st.fallbackAll?`<div class="chm-note" style="color:var(--scp-warn)">Схем вида data_public* не найдено —
    показаны все доступные базы. Отметьте нужные вручную; если нужных нет в списке,
    пользователю не выданы права на них в ClickHouse.</div>`:''}
  ${c.schemas.length?`
  <div class="chm-sel">
    <span class="chm-hint" style="max-width:none">Выбрано: <b>${c.schemas.length}</b> · основная:
      <b>${esc(CHX.labelFor(c.base))}</b></span>
    ${c.schemas.map(db=>`<span class="dt-chip" data-rmdb="${esc(db)}"
      title="Клик: убрать из выбора">${esc(CHX.labelFor(db))} ✕</span>`).join('')}
  </div>`:''}
  <input class="pop-q" id="chmDbQ" type="text" placeholder="Поиск версии — по названию, номеру или схеме…"
    value="${esc(st.dbq||'')}" style="margin-bottom:6px;width:100%">
  <div class="chm-list" id="chmDbList">
    ${st.dbs.slice()
      .sort((a,b)=>(Number(c.schemas.includes(b))-Number(c.schemas.includes(a))) || a.localeCompare(b))
      .map(db=>{
      const on = c.schemas.includes(db), isBase = (c.base===db);
      const meta = (st.meta&&st.meta[db])||{};
      const lbl = CHX.labelFor(db);
      const dbSearch = [lbl, db, CHX.versionNumber(db)].filter(Boolean).join(' ');
      return `<div class="chm-item ${on?'on':''}" data-dbrow="${esc(db)}"
        data-dbsearch="${esc(dbSearch)}">
        <input type="radio" name="chmBase" ${isBase?'checked':''} data-base="${esc(db)}"
               title="Основная схема (полная детализация)">
        <input type="checkbox" ${on?'checked':''} data-db="${esc(db)}">
        <span class="chm-nm">${esc(lbl)}${lbl!==db?` <code>${esc(db)}</code>`:''}</span>
        <span class="chm-meta">${meta.n?nf(meta.n)+' строк':'—'}${meta.ts?' · '+esc(String(meta.ts).slice(0,16)):''}</span>
      </div>`}).join('')}
  </div>

  <div class="chm-row"><label>Гранулярность</label>
    <select id="chmGran">${st.granOptions.map(o=>
      `<option value="${o.t}" ${c.gran===o.t?'selected':''}>${esc(CHX.granLabel(o.t))} (periodtype ${o.t}${o.n?', '+nf(o.n)+' строк':''})</option>`).join('')}
    </select>
    <span class="chm-hint">набор периодов основной схемы ${c.base?esc(c.base):'—'}</span></div>
  <div class="chm-row"><label>Детализация</label>
    <input id="chmDet" type="number" min="100" step="100" value="${c.detailOrders}">
    <span class="chm-hint">заказов основной схемы грузим построчно; остальное — агрегатами, детали по клику</span></div>

  <div class="chm-sec">Названия версий</div>
  <div class="chm-note">При наличии учётных данных PostgreSQL названия загружаются автоматически из
    <code>pgs_app_metadata_db.scenario</code>: номер в конце имени версии (например, <code>_4899</code>)
    сопоставляется с <code>sys_id</code>, подпись берётся из <code>name</code>. Если база или запись недоступна,
    сохраняются прежние подписи; файл ниже можно использовать как ручной фолбэк.</div>
  <div class="chm-row"><label>scenario.xlsx</label>
    <input type="file" id="chmScen" accept=".xlsx,.xls">
    <span class="chm-hint">${CHX.state.pgScenario&&CHX.state.pgScenario.size
      ?`PG scenario: ${CHX.state.pgScenario.size} названий`
      :CHX.state.scenario.size?`scenario.xlsx: ${CHX.state.scenario.size} записей`
        :'если соответствие не найдено, останется текущее имя схемы'}</span></div>

  <div class="chm-act">
    <button class="btn p" id="chmLoad" ${c.schemas.length?'':'disabled'}>
      Загрузить данные (${c.schemas.length} ${plural(c.schemas.length,['схема','схемы','схем'])})</button>
    <span id="chmProg" class="chm-stat"></span>
  </div>`:''}

  <div class="chm-foot">Браузер подключается к серверу напрямую, поэтому на стороне ClickHouse
    должен быть разрешён CORS для чужих источников. Если страница открыта по HTTPS, хост ClickHouse
    тоже должен отвечать по HTTPS с действующим сертификатом. Используйте аккаунт только с правами чтения.</div>`;

  const g = id => document.getElementById(id);
  const sync = ()=>{
    if(c.useProxy){ c.proxyUrl = (g('chmProxy')||{}).value || c.proxyUrl }
    else{
      c.host = (g('chmHost')||{}).value || c.host;
      c.port = num((g('chmPort')||{}).value) || c.port;
      c.proto = (g('chmProto')||{}).value || c.proto;
      c.user = (g('chmUser')||{}).value || '';
      c.pass = (g('chmPass')||{}).value || '';
    }
  };
  /* PostgreSQL-блок: читаем поля в PGX.cfg, проверяем подключение вызовом
     списка схем; ошибки показывает pgStatText после перерисовки */
  const pgSync = ()=>{ if(!window.PGX) return; const p=PGX.cfg;
    const rd=(id)=>{const el=g(id);return el?el.value:undefined};
    let v;
    if((v=rd('pgmBackend'))!==undefined) p.backend=String(v).trim();
    if((v=rd('pgmHost'))!==undefined) p.host=String(v).trim();
    if((v=rd('pgmPort'))!==undefined) p.port=num(v)||p.port;
    if((v=rd('pgmDb'))!==undefined) p.database=String(v).trim();
    if((v=rd('pgmUser'))!==undefined) p.user=String(v).trim();
    if((v=rd('pgmPass'))!==undefined) p.password=String(v);
    if((v=rd('pgmSsl'))!==undefined) p.ssl=v;
  };
  if(g('pgmTest')) g('pgmTest').onclick = async ()=>{
    pgSync(); PGX.invalidate();
    g('pgmStat').innerHTML = 'Поиск backend-прокси…';
    try{
      /* две стадии с разными причинами отказа: сначала ищем server.js,
         потом логинимся в Postgres — пользователь видит, где именно встало */
      await PGX.detectBackend();
      if(g('pgmStat')) g('pgmStat').innerHTML = PGX.state.backendOk
        ? 'Backend найден — подключение к PostgreSQL…'
        : 'Backend не ответил на /api/health — пробуем запрос напрямую…';
      await PGX.ensureSchemas();
    }
    catch(e){ /* перерисовка покажет ошибку в pgmStat */ }
    /* Названия версий читаются отдельно от independent_demand: отсутствие
       таблицы scenario не должно мешать обычному подключению PG. */
    await CHX.refreshPostgresScenarioLabels({force:true});
    if(st.connected) CHX.session.touch();
    drawModal();
  };
  if(g('pgmForget')) g('pgmForget').onclick = ()=>{ PGX.forgetSession(); drawModal() };
  /* ручная привязка версии к схеме PG: сразу в cfg и в автосессию */
  m.querySelectorAll('select[data-pgmap]').forEach(selEl=>selEl.onchange = ()=>{
    PGX.setSchemaOverride(selEl.dataset.pgmap, selEl.value);
    PGX.state.lastDataError = null;
    drawModal();
  });
  g('chmX').onclick = g('chmClose').onclick = CHX.closeModal;
  g('chmMode').onchange = e=>{ sync(); c.useProxy = (e.target.value==='proxy'); drawModal() };
  g('chmConn').onclick = async ()=>{
    sync(); pgSync(); g('chmStat').innerHTML = 'Подключение…';
    try{
      await CHX.connect();
      await CHX.refreshPostgresScenarioLabels();
      drawModal();
    }
    catch(e){ CHX.state.lastError = e.message; drawModal() }
  };
  g('chmSaveProf').onclick = ()=>{
    sync();
    const nm = prompt('Название профиля:', c.host);
    if(nm){ CHX.profiles.save(nm.trim()); drawModal() }
  };
  if(g('chmProfApply')) g('chmProfApply').onclick = ()=>{
    const nm = g('chmProf').value; if(nm && CHX.profiles.apply(nm)) drawModal();
  };
  if(g('chmProfDrop')) g('chmProfDrop').onclick = ()=>{
    const nm = g('chmProf').value; if(nm){ CHX.profiles.drop(nm); drawModal() }
  };
  if(g('chmForgetSession')) g('chmForgetSession').onclick = ()=>{
    CHX.forgetSession();
    drawModal();
  };
  if(g('chmGran')) g('chmGran').onchange = e=>{
    c.gran = num(e.target.value); if(st.connected) CHX.session.touch();
  };
  if(g('chmDet'))  g('chmDet').onchange  = e=>{
    c.detailOrders = Math.max(100,num(e.target.value)); if(st.connected) CHX.session.touch();
  };
  /* Только чекбоксы, не строки: строка-див тоже несла data-db, и всплывшее
     событие change от чекбокса срабатывало на ней вторично — div.checked === undefined,
     и схема сразу же удалялась из выбора. Отсюда «галочки не ставятся». */
  m.querySelectorAll('input[type=checkbox][data-db]').forEach(cb=>cb.onchange = async ()=>{
    const db = cb.dataset.db, i = c.schemas.indexOf(db);
    if(cb.checked && i<0) c.schemas.push(db);
    if(!cb.checked && i>=0) c.schemas.splice(i,1);
    const oldBase = c.base;
    if(!c.schemas.includes(c.base)) c.base = c.schemas[0] || '';
    /* Смена основной схемы — в т.ч. «тихая»: первая галочка назначает базу,
       снятие галочки с текущей базы перекладывает её на другую. Без переспроса
       панель показывала бы periodtype ПРЕЖНЕЙ версии, а следующая загрузка
       пошла бы с чужим periodtype (данных по нему в новой базе может не быть). */
    if(st.connected && c.base && c.base !== oldBase) await CHX.refreshGran(c.base);
    if(window.PGX){
      pgSync();
      await CHX.refreshPostgresScenarioLabels();
    }
    if(st.connected) CHX.session.touch();
    drawModal();
  });
  m.querySelectorAll('[data-base]').forEach(rb=>rb.onchange = async ()=>{
    c.base = rb.dataset.base;
    if(!c.schemas.includes(c.base)) c.schemas.push(c.base);
    const stat = document.getElementById('chmStat');
    if(stat) stat.innerHTML = 'Обновляю гранулярность основной схемы…';
    await CHX.refreshGran(c.base);
    if(window.PGX){
      pgSync();
      await CHX.refreshPostgresScenarioLabels();
    }
    if(st.connected) CHX.session.touch();
    drawModal();
  });
  /* Чип выбранной схемы: клик — убрать из выбора */
  m.querySelectorAll('[data-rmdb]').forEach(ch=>ch.onclick = ()=>{
    const i = c.schemas.indexOf(ch.dataset.rmdb);
    if(i>=0) c.schemas.splice(i,1);
    if(c.base===ch.dataset.rmdb) c.base = c.schemas[0] || '';
    if(st.connected) CHX.session.touch();
    drawModal();
  });
  /* Поиск по названию scenario, номеру суффикса и техническому имени схемы. */
  const applyDbFilter = ()=>{
    const s = String((g('chmDbQ')||{}).value||'').trim().toLowerCase();
    m.querySelectorAll('#chmDbList .chm-item').forEach(it=>{
      const hay = ((it.dataset.dbsearch||'')+' '+(it.dataset.dbrow||'')).toLowerCase();
      it.style.display = (!s || hay.includes(s)) ? '' : 'none';
    });
  };
  if(g('chmDbQ')){
    g('chmDbQ').oninput = ()=>{
      st.dbq = g('chmDbQ').value;
      applyDbFilter();
    };
    /* Если окно открыли на уже подключённом CH, попробуем подтянуть имена
       при первом фокусе поиска — до того, как пользователь начнёт вводить имя. */
    g('chmDbQ').onfocus = async ()=>{
      if(!window.PGX||typeof PGX.loadScenarioNames!=='function') return;
      pgSync();
      if(!PGX.cfg.user){
        if(CHX.state.pgScenario&&CHX.state.pgScenario.size){
          CHX.applyPostgresScenarioRows([]);
          if(m.style.display==='block') drawModal();
        }
        return;
      }
      if(PGX.scenarioNamesCurrent&&PGX.scenarioNamesCurrent()) return;
      if(PGX.state.scenarioNamesPending) return;
      await CHX.refreshPostgresScenarioLabels();
      if(m.style.display==='block') drawModal();
    };
  }
  if(g('chmScen')) g('chmScen').onchange = async e=>{
    if(!e.target.files||!e.target.files[0]) return;
    try{ const n = await CHX.loadScenarioFile(e.target.files[0]);
      alert('Загружено записей scenario: '+n); drawModal(); }
    catch(err){ alert('Ошибка чтения scenario: '+err.message) }
  };
  if(g('chmLoad')) g('chmLoad').onclick = async ()=>{
    const prog = g('chmProg');
    g('chmLoad').disabled = true;
    try{
       const res = await CHX.loadAll(msg=>{ if(prog) prog.textContent = msg });
      CHX.closeModal();
      const stat = document.getElementById('stat');
      /* В шапке — только короткий итог. Заметки загрузки (недоступная
         independent_demand, смена periodtype и т.п.) уходят в значок ⚠:
         длинные красные простыни в шапке больше не печатаем. */
      if(stat) stat.innerHTML =
        `<span class="pos">ClickHouse:</span> ${esc(res.ds.name)}<br>`
        + `${res.ds.orders.length} заказов${res.ds.detailLimited?' (лимит детализации)':''} | `
        + `${res.ds.ops.length} операций | версий: ${res.versions.length}`;
      if(typeof window.setLoadWarnings==='function') window.setLoadWarnings(res.notes);
    }catch(e){
      if(prog) prog.innerHTML = `<span class="neg">${esc(e.message)}</span>`;
      g('chmLoad').disabled = false;
    }
  };
  /* Возвращаем прокрутку списка и фокус туда, где они были до перерисовки */
  const listEl=document.getElementById('chmDbList');
  if(listEl&&prevScroll)listEl.scrollTop=prevScroll;
  applyDbFilter();
  if(prevFocusId==='chmDbQ'){const fe=document.getElementById('chmDbQ');if(fe){fe.focus();fe.selectionStart=fe.value.length}}
}

/* ─────────────── 12. СРАВНЕНИЕ N ВЕРСИЙ ─────────────── */
let VS_VIEW = 'matrix';   // matrix | profile | waterfall | heat
let VS_DIM  = 'period';   // period | product | client
let VS_TARGET = null;     // версия для waterfall

/* Метрики версии: [ключ, название, направление (1 лучше больше), формат, источник].
   Источник — таблица/формула, из которой реально считается строка: он выводится
   тегом в матрице, чтобы входной спрос (independent_demand), итог «Не покрыто всего»
   (independent_demand − marking_demand) и сырое покрытие (demand_coverage) не путались. */
const VS_METRICS = [
  ['rev','Валовая выручка',1,bn,'marking_demand'],
  ['cost','Себестоимость',-1,bn,'marking_demand'],
  ['mar','Валовая маржа',1,bn,'marking_demand'],
  ['mrg','Маржинальность',1,pc,'marking_demand'],
  ['mpt','Маржа на тонну',1,v=>nf(v)+' ₽','marking_demand'],
  ['demUnc','Неограниченный спрос, т',0,v=>nf(v),'independent_demand'],
  ['demPlan','Ограниченный спрос (план), т',0,v=>nf(v),'marking_demand'],
  ['sal','План продаж, т',1,v=>nf(v),'marking_demand'],
  /* Порядок — от общего к частному. Total берётся из DISTINCT-реестра
     independent_demand; статусы — из того же реестра, сопоставленного с
     заказами плана. У старого/частично совместимого источника матрица
     показывает невязку, а не подменяет независимый total. */
  ['ordTotal','Заказов (неогр. спрос)',0,v=>v==null?'—':nf(v),'independent_demand'],
  ['ordCovered','Заказов всего покрыто',0,v=>v==null?'—':nf(v),'independent_demand × marking_demand'],
  ['ordFull','Заказов полностью покрыто',1,v=>v==null?'—':nf(v),'independent_demand × marking_demand'],
  ['ordPart','Заказов частично покрыто',0,v=>v==null?'—':nf(v),'independent_demand × marking_demand'],
  ['ordFullUnc','Заказов 100% не покрыто',-1,v=>v==null?'—':nf(v),'independent_demand × marking_demand'],
  ['ordCheck','Невязка заказов (должна быть 0)',0,v=>v==null?'—':nf(v),'сверка счёта'],
  ['demLim','Покрытый спрос, т',0,v=>v==null?'—':nf(v),'demand_coverage'],
  ['gapTotal','Непокрытый спрос, т',-1,v=>nf(v),'independent_demand − marking_demand'],
  ['covUf','Непокрытый спрос по demand_coverage, т',-1,v=>v==null?'—':nf(v),'demand_coverage'],
  /* Объёмы операций, т: логистический контур дашборда включает movement и stock. */
  ['planProduction','План производства, т',0,v=>nf(v,1),'marking_demand · production'],
  ['planMovements','План перемещений, т',0,v=>nf(v,1),'marking_demand · movement'],
  ['planLogistics','План логистики, т',0,v=>nf(v,1),'marking_demand · movement + stock'],
  ['planProcurement','План закупки сырья, т',0,v=>nf(v,1),'marking_demand · procurement'],
  ['sl','Service Level',1,pc,'marking_demand'],
  ['late','Отгружено с опозданием, т',-1,v=>v==null?'—':nf(v),'demand_coverage'],
  ['lm','Упущенная маржа по дефициту плана (база: маржа/т заказа)',-1,bn,'marking_demand'],
  ['penNonDel','Штраф за непоставку',-1,bn,'demand_cost × demand_coverage'],
  ['penLate','Штраф за опоздание',-1,bn,'demand_cost × demand_coverage'],
  ['pd','Затраты: производство',-1,bn,'marking_demand'],
  ['mv','Затраты: логистика',-1,bn,'marking_demand'],
  ['pcst','Затраты: закупки',-1,bn,'marking_demand'],
  ['st','Затраты: хранение',-1,bn,'marking_demand'],
  ['capUtil','Средняя загрузка мощностей',0,pc,'capacity_view_sp'],
  ['bn','Узких мест (≥90%)',-1,v=>nf(v),'capacity_view_sp'],
  ['planAvail','Плановый ФРВ, ч',0,v=>nf(v),'rescapacity'],
  ['expansion','Расширение мощности, ч',0,v=>nf(v),'rescapacity']
];

/* ── Источники строк спроса в сравнении версий ──
   Входной (неограниченный) спрос: Σ demandqty из independent_demand.
   Плановая цепочка, как в «Общем» и «Спросе и покрытии»:
     ограниченный спрос (план) = Σ demand_volume,
     план продаж = Σ results_sale,
     дефицит плана = Σ unsatisfied_demand — всё из marking_demand;
     Service Level = results_sale / demand_volume.
   Строка «Непокрытый спрос» в матрице повторяет карточку «Не покрыто всего»:
     max(0, Σ independent_demand.demandqty − Σ marking_demand.results_sale).
   Если неограниченный вход недоступен, его база — покрытый + непокрытый из
   demand_coverage; если и она нулевая/недоступна, используется дефицит плана.
   Сырые итоги demand_coverage показаны отдельными строками: покрытый = Σ
   fullfilleddemandqty, непокрытый = Σ unfullfilleddemandqty. Это отдельный срез,
   который может не совпасть с total gap.

   Заказы: точный total — число строк backend `n` после той же DISTINCT-выборки
   independent_demand, что использована для Σ demandqty. Для классификации эта
   выборка сопоставляется с per-order результатом marking_demand по
   item/location/demandtype/dmdstream и ближайшему объёму (как в основной
   версии). Непарные входные строки — 100% не покрыты; plan-only строки не
   прибавляются к total. Если деталей для сопоставления нет, статусы берутся из
   demand_coverage, а строка невязки явно показывает расхождение источников.
*/
function vsFlat(v){
  const a = v.agg || {}, t = a.totals || {}, cov = t.cov || {}, op = t.byOp || {};
  const rev = num(t.rev), cost = num(t.cost), mar = num(t.mar), sal = num(t.sal);
  const ff = num(cov.ff), uf = num(cov.uf);
  const hasMetric=(obj,key)=>Object.prototype.hasOwnProperty.call(obj||{},key)
    && obj[key]!==undefined && obj[key]!==null && Number.isFinite(Number(obj[key]));
  /* Неограниченный спрос: primary — Σ demandqty из independent_demand.
     Если источника нет, используется прежний фолбэк demand_coverage. */
  const hasExplicitUnc = Object.prototype.hasOwnProperty.call(cov,'demUnc') && !!t.uncSrc;
  const demUnc = hasExplicitUnc ? num(cov.demUnc) : (ff+uf);
  const covOk = t.covAvailable!==undefined ? !!t.covAvailable
    : (hasMetric(cov,'orderRows') || ff!==0 || uf!==0);
  const uncSrc = t.uncSrc || (covOk?'demand_coverage':'');
  const demPlan = num(t.dem);
  const unm = num(t.unm);
  /* Та же формула, что в covBasis() и карточке «Не покрыто всего»:
     входной спрос − продажи плана; при отсутствии ненулевой базы — дефицит плана.
     Входной источник уже выбран единообразно выше: independent_demand или
     отмеченный фолбэк demand_coverage (покрытый + непокрытый). */
  const gapTotal = demUnc>0 ? Math.max(0,demUnc-sal) : unm;
  const gapSrc = demUnc>0
    ? ((uncSrc==='independentdemand'||uncSrc==='independent_demand')
      ? 'independent_demand − marking_demand' : 'demand_coverage − marking_demand')
    : 'marking_demand';

  const stats=t.orderStats||null;
  const independentCountKnown=t.independentOrderCountSource==='independent_demand'
    &&hasMetric(t,'independentOrderCount');
  const dcPartsKnown=hasMetric(cov,'fullyUncoveredOrders')
    &&hasMetric(cov,'partiallyCoveredOrders') && hasMetric(cov,'fullyCoveredOrders');
  const mdPartsKnown=hasMetric(t,'zeroSalOrders')
    &&hasMetric(t,'partCoveredOrders') && hasMetric(t,'fullCoveredOrders');
  let ordTotal=independentCountKnown?Math.max(0,Math.trunc(num(t.independentOrderCount))):null;
  let ordFullUnc=null,ordPart=null,ordFull=null;
  let orderTotalSrc=independentCountKnown?'independent_demand':'',orderStatusSrc='';
  if(independentCountKnown&&stats&&hasMetric(stats,'fullyUncoveredOrders')
      &&hasMetric(stats,'partiallyCoveredOrders')&&hasMetric(stats,'fullyCoveredOrders')){
    ordFullUnc=Math.max(0,Math.trunc(num(stats.fullyUncoveredOrders)));
    ordPart=Math.max(0,Math.trunc(num(stats.partiallyCoveredOrders)));
    ordFull=Math.max(0,Math.trunc(num(stats.fullyCoveredOrders)));
    orderStatusSrc=stats.source||'independent_demand × marking_demand';
  }else if(dcPartsKnown){
    /* Это статусы результата coverage, а не подмена independent_demand.n.
       Если охваты не совпадают, ниже останется ненулевая невязка. */
    ordFullUnc=Math.max(0,Math.trunc(num(cov.fullyUncoveredOrders)));
    ordPart=Math.max(0,Math.trunc(num(cov.partiallyCoveredOrders)));
    ordFull=Math.max(0,Math.trunc(num(cov.fullyCoveredOrders)));
    orderStatusSrc='demand_coverage';
  }else if(mdPartsKnown){
    ordFullUnc=Math.max(0,Math.trunc(num(t.zeroSalOrders)));
    ordPart=Math.max(0,Math.trunc(num(t.partCoveredOrders)));
    ordFull=Math.max(0,Math.trunc(num(t.fullCoveredOrders)));
    orderStatusSrc='marking_demand';
  }
  const orderPartsKnown=ordFullUnc!=null&&ordPart!=null&&ordFull!=null;
  const ordCovered=orderPartsKnown?ordPart+ordFull:null;
  const ordDelta=orderPartsKnown&&ordTotal!=null?ordTotal-(ordFullUnc+ordPart+ordFull):null;
  const ordCheck=ordDelta;
  const orderCheckSrc=orderStatusSrc
    ?(orderTotalSrc?orderTotalSrc+' ↔ '+orderStatusSrc:'нет independent_demand total · '+orderStatusSrc):'';
  const lateIndependentKnown=!!(stats&&hasMetric(stats,'lateFromIndependent'));
  const lateCoverageKnown=!!(covOk&&hasMetric(cov,'late'));
  return {
    _v:v, label:v.label, id:v.id, isBase:v.isBase, covOk, uncSrc,
    finSrc: t.finSrc||'marking_demand',
    revSrc: t.revSrc||t.finSrc||'marking_demand',
    rev, cost, mar, mrg: rev?mar/rev:0, mpt: sal?mar/sal:0,
    demUnc, demPlan, demLim:covOk?ff:null, sal, unm,
    gapTotal, gapSrc,
    covUf:covOk?uf:null,
    /* Service Level совпадает с covBasis(): Σ results_sale / Σ demand_volume. */
    sl: demPlan?sal/demPlan:0,
    late:lateIndependentKnown?num(stats.lateFromIndependent)
      :lateCoverageKnown?num(cov.late):null,
    lateSrc:lateIndependentKnown?'independent_demand × marking_demand × demand_cost'
      :lateCoverageKnown?'demand_coverage':'',
    ordTotal, ordCovered, ordFullUnc, ordPart, ordFull, ordCheck,
    ordDelta, orderTotalSrc, orderStatusSrc, orderCheckSrc,
    lm: num(t.lm), penNonDel: num(t.penaltyNonDel), penLate: num(t.penaltyLate),
    pd:(op.production||{}).c||0, mv:(op.movement||{}).c||0,
    pcst:(op.procurement||{}).c||0, st:(op.stock||{}).c||0,
    /* order_operation_volume из marking_demand: агрегат своей версии по operation_type.
       План логистики — движение плюс хранение (movement + stock), как в RCA логистики. */
    planProduction:num((op.production||{}).v),
    planMovements:num((op.movement||{}).v),
    planLogistics:num((op.movement||{}).v)+num((op.stock||{}).v),
    planProcurement:num((op.procurement||{}).v),
    capUtil: num(t.capUtil), bn: num(t.bnCount),
    planAvail: num(t.planAvail), expansion: num(t.expansion)
  };
}

CHX.tabVS = function(){
  const V = CHX.versions;
  if(!V.length || V.length < 2)
    return `<div class="empty"><h2>Версий для сравнения меньше двух</h2>
      <p>Откройте подключение к ClickHouse и выберите две или более схемы
      <code>data_public*</code>: одну основной, остальные — для сравнения.</p>
      <p style="margin-top:14px"><button class="btn p" onclick="CHX.openModal()">Открыть подключение</button></p></div>`;

  const rows = V.map(vsFlat);
  const base = rows.find(r=>r.isBase) || rows[0];
  if(!VS_TARGET || !rows.some(r=>r.id===VS_TARGET))
    VS_TARGET = (rows.find(r=>!r.isBase)||rows[0]).id;
  const target = rows.find(r=>r.id===VS_TARGET);

  /* фактическая гранулярность каждой версии: если версия без общего periodtype,
     её периодные агрегаты посчитаны по её собственной гранулярности (см. loadAll) */
  const vGran = r => r._v.gran || CHX.cfg.gran;
  const gransU = uq(rows, vGran);
  const gransMix = gransU.length > 1;

  /* лучшая версия по каждой метрике; неизвестные значения не считаются нулём */
  const best = {};
  VS_METRICS.forEach(([k,,dir])=>{
    if(!dir) return;
    let bv = null;
    rows.forEach(r=>{
      if(r[k]==null) return;
      if(bv===null || r[k]*dir > bv.v*dir) bv = {id:r.id, v:r[k]};
    });
    best[k] = bv && bv.id;
  });
  const orderChecks=rows.filter(r=>r.ordCheck!=null);
  const maxOrderCheck=orderChecks.length?Math.max(...orderChecks.map(r=>Math.abs(r.ordCheck))):null;

  const K = [
    ['Версий в сравнении', nf(rows.length), 'база: '+base.label, ''],
    ['Лидер по марже',
      (rows.slice().sort((a,b)=>b.mar-a.mar)[0]||{}).label||'—',
      bn((rows.slice().sort((a,b)=>b.mar-a.mar)[0]||{}).mar||0), 'pos'],
    ['Лидер по Service Level',
      (rows.slice().sort((a,b)=>b.sl-a.sl)[0]||{}).label||'—',
      pc((rows.slice().sort((a,b)=>b.sl-a.sl)[0]||{}).sl||0), 'pos'],
    ['Разброс маржи',
      bn(Math.max(...rows.map(r=>r.mar))-Math.min(...rows.map(r=>r.mar))),
      'между лучшей и худшей версией', 'mid'],
    ['Макс. невязка заказов',
      maxOrderCheck==null?'—':nf(maxOrderCheck),
      `проверено ${orderChecks.length} из ${rows.length} версий · ожидается 0`,
      maxOrderCheck==null||orderChecks.length<rows.length?'mid':maxOrderCheck>0?'neg':'pos'],
    ['Гранулярность',
      gransMix ? gransU.map(g=>CHX.granLabel(g)).join(', ') : CHX.granLabel(gransU[0]),
      gransMix ? 'у версий разные periodtype — см. заметки загрузки' : 'periodtype '+gransU[0],
      gransMix ? 'mid' : '']
  ];

  const html = `
  <div class="frow">
    <div class="fg"><label>База сравнения</label>
      <select id="vsBase">${rows.map(r=>
        `<option value="${esc(r.id)}" ${r.isBase?'selected':''}>${esc(r.label)}</option>`).join('')}</select></div>
    <div class="fg"><label>Версия для разложения дельты</label>
      <select id="vsTarget">${rows.filter(r=>!r.isBase).map(r=>
        `<option value="${esc(r.id)}" ${r.id===VS_TARGET?'selected':''}>${esc(r.label)}</option>`).join('')}</select></div>
    <div class="fg"><label>Разрез тепловой карты</label>
      <select id="vsDim">
        <option value="period"  ${VS_DIM==='period'?'selected':''}>Период</option>
        <option value="product" ${VS_DIM==='product'?'selected':''}>Продукт</option>
        <option value="client"  ${VS_DIM==='client'?'selected':''}>Клиент</option>
      </select></div>
    <button class="btn" onclick="CHX.openModal()">Изменить набор версий</button>
  </div>
  <div class="kpis">${K.map(k=>
    `<div class="kpi"><div class="t">${k[0]}</div><div class="v ${k[3]}">${esc(String(k[1]))}</div>
     <div class="s">${esc(String(k[2]))}</div></div>`).join('')}</div>
  <div class="seg" style="margin:0 0 12px">
    <button class="btn ${VS_VIEW==='matrix'?'p':''}"    id="vsVMat">Матрица KPI</button>
    <button class="btn ${VS_VIEW==='profile'?'p':''}"   id="vsVPro">Профиль версий</button>
    <button class="btn ${VS_VIEW==='waterfall'?'p':''}" id="vsVWf">Разложение дельты</button>
    <button class="btn ${VS_VIEW==='heat'?'p':''}"      id="vsVHeat">Дельта по разрезу</button>
  </div>
  <div class="grid">
    ${VS_VIEW==='matrix'?`
    <div class="card w"><h3>Матрица показателей: все версии</h3>
      <div id="vsMat"></div></div>`:''}
    ${VS_VIEW==='profile'?`
    <div class="card w"><h3>Радар версий</h3>
      <div class="sub">Лучшее значение по каждой оси задаёт длину луча: наружу — сильнее.
      Дефицит, штрафы и логистика инвертированы (меньше — дальше от центра)</div>
      <canvas id="vsProR"></canvas></div>
    <div class="card w"><h3>Профиль версий</h3>
      <div class="sub">Значения нормированы к лучшей версии по каждой метрике (100% = лучшая)</div>
      <canvas id="vsPro"></canvas></div>`:''}
    ${VS_VIEW==='waterfall'?`
    <div class="card w"><h3>Разложение дельты маржи: ${esc(base.label)} → ${esc(target.label)}</h3>
      <div class="sub">Из чего сложилось изменение валовой маржи между версиями</div>
      <canvas id="vsWf"></canvas></div>`:''}
    ${VS_VIEW==='heat'?`
    <div class="card w"><h3>Отклонение маржи от базы по разрезу «${
      VS_DIM==='period'?'Период':VS_DIM==='product'?'Продукт':'Клиент'}»</h3>
      <div class="sub">Где именно версии расходятся, млн ₽ относительно базы</div>
      <canvas id="vsHeat"></canvas></div>`:''}
  </div>`;

  setTimeout(()=>{
    const g = id=>document.getElementById(id);
    g('vsBase').onchange = e=>{
      CHX.versions.forEach(v=>v.isBase = (v.id===e.target.value));
      CHX.cfg.base = e.target.value; render();
    };
    if(g('vsTarget')) g('vsTarget').onchange = e=>{ VS_TARGET = e.target.value; render() };
    g('vsDim').onchange = e=>{ VS_DIM = e.target.value; render() };
    g('vsVMat').onclick  = ()=>{ VS_VIEW='matrix';    render() };
    g('vsVPro').onclick  = ()=>{ VS_VIEW='profile';   render() };
    g('vsVWf').onclick   = ()=>{ VS_VIEW='waterfall'; render() };
    g('vsVHeat').onclick = ()=>{ VS_VIEW='heat';      render() };

    /* ── Матрица: динамические колонки по числу версий ── */
    if(VS_VIEW==='matrix'){
      const data = VS_METRICS.map(([k,name,dir,fmt,src])=>{
        const rec = {n:name, _k:k, _dir:dir, _fmt:fmt, _src:src, base:base[k]};
        /* Источник неограниченного спроса — фактический: если версии используют
           разные источники, тег показывает их оба. */
        if(k==='demUnc'){
          const srcName=s=>s==='independentdemand'?'independent_demand':s;
          const srcs=uq(rows.map(r=>srcName(r.uncSrc||'')).filter(Boolean),x=>x);
          rec._src=srcs.length?srcs.join(' + '):'нет источника';
        }else if(k==='gapTotal'){
          const srcs=uq(rows.map(r=>r.gapSrc).filter(Boolean),x=>x);
          rec._src=srcs.length?srcs.join(' / '):'нет источника';
        }else if(k==='late'){
          const srcs=uq(rows.map(r=>r.lateSrc).filter(Boolean),x=>x);
          rec._src=srcs.length?srcs.join(' / '):'нет источника';
        }else if(['ordTotal','ordCovered','ordFull','ordPart','ordFullUnc','ordCheck'].includes(k)){
          const srcs=uq(rows.map(r=>k==='ordTotal'?r.orderTotalSrc:
            k==='ordCheck'?r.orderCheckSrc:r.orderStatusSrc).filter(Boolean),x=>x);
          rec._src=srcs.length?srcs.join(' / '):'нет источника';
        }
        /* финансы — фактический источник: margin_sales (пересчёт 2026-10-06)
           или фолбэк marking_demand; при смешении версий тег называет обе.
           Выручка может идти из цен спроса (revSrc: demand_coverage ×
           demand_cost, 2026-10-07), а маржа — из margin_sales: теги строк
           называют источники раздельно, маржинальность — обе таблицы. */
        if(k==='rev'){
          const srcs=uq(rows.map(r=>r.revSrc||r.finSrc||'marking_demand'),x=>x);
          rec._src=srcs.join(' / ');
        }else if(k==='mar'){
          const srcs=uq(rows.map(r=>r.finSrc||'marking_demand'),x=>x);
          rec._src=srcs.join(' / ');
        }else if(k==='mrg'){
          const srcs=uq(rows.map(r=>{
            const rs=r.revSrc||r.finSrc||'marking_demand', ms=r.finSrc||'marking_demand';
            return rs===ms ? ms : (ms+' / '+rs);
          }),x=>x);
          rec._src=srcs.join(' / ');
        }
        if(k==='mpt'&&rows.some(r=>r.finSrc==='margin_sales'))
          rec._src='margin_sales × marking_demand';
        rows.forEach(r=>{
          rec['v_'+r.id] = r[k];
          rec['d_'+r.id] = (r[k]==null||base[k]==null)?null:r[k] - base[k];
        });
        /* null (нет счётчиков заказов у старых снапшотов) не участвует в разбросе */
        const vals = rows.map(r=>r[k]).filter(v=>v!=null);
        rec.spread = vals.length ? Math.max(...vals) - Math.min(...vals) : null;
        return rec;
      });
      const cols = [
        {k:'n', t:'Показатель', left:1, flt:1,
         f:(v,r)=>`${esc(v)}${r._src?` <span class="tag" style="margin-left:6px">${esc(r._src)}</span>`:''}`},
        {k:'base', t:base.label+' (база)', num:1, f:(v,r)=>v==null?'—':r._fmt(v)}
      ];
      rows.filter(r=>!r.isBase).forEach(r=>{
    cols.push({k:'v_'+r.id,
      t:r.label + (vGran(r)!==vGran(base)?' · '+CHX.granLabel(vGran(r)):''),
      num:1,
          f:(v,row)=>{
            if(v==null) return '—';
            const d = row['d_'+r.id], dir = row._dir;
            const star = (best[row._k]===r.id && dir) ? ' ★' : '';
            const cls = !dir ? '' : (d*dir>0 ? 'pos' : d*dir<0 ? 'neg' : '');
            const dd = d===0 ? '' :
              ` <span class="${cls}">(${d>0?'+':''}${row._fmt(d)})</span>`;
            return `${row._fmt(v)}${dd}${star}`;
          }});
      });
      cols.push({k:'spread', t:'Разброс', num:1, f:(v,r)=>v==null?'—':r._fmt(v)});
      /* Строки — в порядке VS_METRICS («от общего к частному»); алфавитной сортировки по умолчанию нет.
         Клик по заголовку сортирует как раньше. */
      dtable('#vsMat', cols, data,
        {key:'vs_matrix', sort:'__preserve__', dir:'asc', h:520, csv:1, name:'versions_matrix'});
    }

    /* ── Профиль: нормировка к лучшей версии ── */
    if(VS_VIEW==='profile'){
      const rdef = [['mar','Валовая маржа',1,bn],['sl','Service Level',1,pc],
        ['mpt','Маржа/т',1,v=>nf(v)+' ₽'],['capUtil','Загрузка мощностей',1,pc],
        ['unm','Дефицит',-1,v=>nf(v)+' т'],['penNonDel','Штрафы',-1,bn],['mv','Логистика',-1,bn]];
      const raxes = rdef.map(([k,name,dir,fmt])=>{
        const mx = Math.max(...rows.map(r=>Math.abs(r[k])||0),1e-9);
        const norm = v => { const t = (Math.abs(v[k])||0)/mx; return dir>0 ? t : 1-t };
        return {t:name,f:fmt,vOf:v=>v[k],norm:rows.map(norm)};
      });
      chRadar('#vsProR', H('#vsProR',320,0.5), raxes,
        rows.slice(0,6).map((r,i)=>({name:r.label,c:PAL[i%PAL.length],
          vals:raxes.map(ax=>ax.norm[i]),raw:raxes.map(ax=>ax.vOf(r))})));
      const keys = ['mar','sl','mpt','capUtil'];
      const names = ['Маржа','Service Level','Маржа/т','Загрузка мощностей'];
      const inv = ['unm','penNonDel','mv'];
      const invNames = ['Дефицит (инв.)','Штрафы (инв.)','Логистика (инв.)'];
      const allK = keys.concat(inv), allN = names.concat(invNames);
      const norm = allK.map(k=>{
        const vals = rows.map(r=>Math.abs(r[k])||0);
        const mx = Math.max(...vals,1e-9), mn = Math.min(...vals);
        return rows.map(r=>{
          const v = Math.abs(r[k])||0;
          return inv.includes(k) ? (mx? (1-(v-mn)/(mx-mn||1))*100 : 0) : (v/mx)*100;
        });
      });
      chBars('#vsPro', H('#vsPro',320,0.42), allN,
        rows.map((r,i)=>({c:PAL[i%PAL.length], v:norm.map(arr=>arr[i])})),
        v=>nf(v,0)+'%',
        i=>`<b>${esc(allN[i])}</b><br>`+rows.map((r,j)=>
          `${esc(r.label)}: ${nf(norm[i][j],0)}%`).join('<br>'),
        null, 1);
        const host = document.getElementById('vsPro');
      if(host && host.parentElement){
        const wrap=document.createElement('div');
        wrap.innerHTML=lg('#vsPro',rows.map((r,i)=>[PAL[i%PAL.length],r.label]));
        host.parentElement.insertBefore(wrap.firstChild, host);
      }   
    }

    /* ── Waterfall: раскладка дельты маржи ── */
    if(VS_VIEW==='waterfall'){
      const steps = [
        ['Маржа базы', base.mar, 'base'],
        ['Δ Выручка', target.rev - base.rev, ''],
        ['Δ Закупки', -(target.pcst - base.pcst), ''],
        ['Δ Производство', -(target.pd - base.pd), ''],
        ['Δ Логистика', -(target.mv - base.mv), ''],
        ['Δ Хранение', -(target.st - base.st), ''],
        ['Маржа версии', target.mar, 'total']
      ];
      const resid = target.mar - (base.mar +
        (target.rev-base.rev) - (target.pcst-base.pcst) - (target.pd-base.pd)
        - (target.mv-base.mv) - (target.st-base.st));
      if(Math.abs(resid) > Math.abs(target.mar)*1e-6)
        steps.splice(6,0,['Прочее / нераспределённое', resid, '']);
      /* Мост: уровни базы и версии + шаги-дельты между ними — видно направление
         изменения, чего столбцы абсолютных значений не показывали. */
      const wfItems = steps.map(([k,v,kind])=>{
        if(kind==='base'||kind==='total')return {k,v,type:'total',c:kind==='base'?CH.d1:CH.d3};
        return {k,v,type:'delta'};
      });
      chWaterfall('#vsWf', H('#vsWf',320,0.45), wfItems, v=>bn(Math.abs(v)),
        i=>`<b>${esc(wfItems[i].k)}</b><br>`+(wfItems[i].type==='total'?bn(wfItems[i].v):
          `${wfItems[i].v>=0?'+':'−'}${bn(Math.abs(wfItems[i].v))} к марже`), null);
    }

    /* ── Heatmap: отклонение от базы по разрезу ── */
    if(VS_VIEW==='heat'){
      const dimOf = v => ((v._v.agg||{}).dims||{})[VS_DIM] || [];
      const keysAll = uq(rows.flatMap(r=>dimOf(r).map(d=>d.k)), k=>k).slice(0,24);
      const baseMap = new Map(dimOf(base).map(d=>[d.k,d.mar]));
      const others = rows.filter(r=>!r.isBase);
      const mat = keysAll.map(k=> others.map(r=>{
        const m = new Map(dimOf(r).map(d=>[d.k,d.mar]));
        return (m.get(k)||0) - (baseMap.get(k)||0);
      }));
      if(keysAll.length && others.length)
        chHeat('#vsHeat', H('#vsHeat',360,0.55), keysAll, others.map(r=>r.label),
          mat.map(row=>row.map(v=>Math.abs(v))),
          v=>mln(v)+' ₽', null);
      else{
        const g2 = cv('#vsHeat',180);
        if(g2){ g2.x.fillStyle=CH.axis; g2.x.textAlign='center'; g2.x.font='13px Open Sans, sans-serif';
          g2.x.fillText('Недостаточно данных по выбранному разрезу', g2.w/2, 90) }
      }
    }
  },0);

  /* ── Вердикт по блокам для N версий ── */
  const blocks = [
    ['Финансы (маржа)','mar',1], ['Спрос (Service Level)','sl',1],
    ['Дефицит','unm',-1], ['Штрафы','penNonDel',-1],
    ['Логистика','mv',-1], ['Производство','pd',-1],
    ['Закупки','pcst',-1], ['Загрузка мощностей','capUtil',1]
  ];
  const winners = blocks.map(([name,k,dir])=>{
    const b = rows.slice().sort((a,z)=>(z[k]-a[k])*dir)[0];
    return {name, who:b.label, val:b[k]};
  });
  const score = {};
  rows.forEach(r=>score[r.label]=0);
  winners.forEach(w=>score[w.who] = (score[w.who]||0)+1);
  const rank = Object.entries(score).sort((a,b)=>b[1]-a[1]);

  return html + summary('Резюме: сравнение версий', [
    {t:'Кто выигрывает по блокам', i: winners.map(w=>
      `<b>${w.name}</b>: <span class="h">${esc(w.who)}</span>`)},
    {t:'Сводный рейтинг', i:[
      rank.map(([nm,n])=>`<b>${esc(nm)}</b> — ${n} ${plural(n,['блок','блока','блоков'])} из ${blocks.length}`).join('; ')+'.',
      rank.length && rank[0][1] > (rank[1]?rank[1][1]:0)
        ? `Версия <span class="h">${esc(rank[0][0])}</span> доминирует. Перед принятием проверьте,
           не достигнут ли результат за счёт роста штрафов или нереалистичной загрузки мощностей.`
        : `Явного лидера нет — версии выигрывают в разных блоках. Решение принимать по приоритетному
           блоку: обычно маржа, затем Service Level.`,
      `Если маржа выросла, а Service Level упал — это перераспределение объёма в пользу дорогих позиций;
       смотрите разрез «Клиент» на тепловой карте.`,
      `Если снизилась логистика, но выросло хранение — затраты переехали между статьями,
       сравнивайте сумму блоков, а не отдельные строки.`
    ]},
    {t:'Гигиена сравнения', i:[
      gransMix
        ? `<span class="h">Гранулярности версий разные:</span> `
          + rows.map(r=>`${esc(r.label)} — ${CHX.granLabel(vGran(r))}`).join('; ')
          + `. Версия, в которой общего periodtype нет, агрегирована своей самой массовой гранулярностью —
             при сравнении блоков «Спрос/Мощности» учитывайте базу периодов.`
        : `Все версии агрегированы с одной гранулярностью (<b>${CHX.granLabel(gransU[0])}</b>) —
       смешивания месяцев с неделями не происходит.`,
      `Дедупликация: <code>is_deleted = 0</code> + последняя версия строки по <code>update_date_time</code>.`,
      CHX.unmatchedSchemas().length
        ? `<span class="h">${CHX.unmatchedSchemas().join(', ')}</span> не сопоставлены со scenario.xlsx —
           отображаются техническими именами.`
        : `Все схемы сопоставлены с названиями из scenario.xlsx.`
    ]}
  ]);
};


/* Восстанавливаем подключение после закрытия браузера и контролируем его
   при возвращении на вкладку или после восстановления сети. */
function installSessionLifecycle(){
  CHX.restoreSession();
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible') CHX.checkSession(false);
  });
  window.addEventListener('online',()=>CHX.checkSession(true));
  window.addEventListener('pageshow',()=>CHX.checkSession(false));
}
if(document.readyState==='loading')
  document.addEventListener('DOMContentLoaded',installSessionLifecycle,{once:true});
else installSessionLifecycle();
})();
