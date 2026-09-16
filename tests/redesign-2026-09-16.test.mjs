/* ─────────────────────────────────────────────────────────────────────────────
   ТЗ владельца дашборда от 2026-09-16 (вторая итерация): компактность, навигация,
   единые KPI, переходы и визуал сравнения версий.

   Что проверяется:

   1. Навигация: 10 разделов; «Экономика отказов» удалена целиком (нет вкладки и
      нет функции tabCOST); «Сравнение версий» стоит на освободившемся месте —
      сразу после «Запасов»; «Данные и качество» — объединённый раздел в конце.
   2. Объединённый раздел: go('dq') и go('raw') ведут в «Данные и качество» с
      соответствующим видом, переключатель вида меняет содержимое.
   3. В шапке ВСЕГДА видно, какая версия активна (имя датасета/схемы), а не только
      до загрузки файла.
   4. Переключатели «метод / база» упущенной маржи — одна компактная строка с
      двумя частями и значками «?», без пояснительных подписей в теле строки.
   5. График «Упущенная маржа по периодам и продуктам» стоит непосредственно
      перед таблицей «Заказы спроса», а не первым в разделе.
   6. KPI-карточки одной структуры: заголовок (до 2 строк), значение (одна
      строка) и подпись; подсказка — только на значке «?».
   7. Клик по узкому месту в «Спрос и покрытие» открывает заказ в «Цепочке
      заказа» → «Этапы цепи» (тонны), а шестерёнка рядом оставляет переход в
      «Мощности».
   8. «Логистика»: виды транспорта выбираются мультивыбором, у графа потоков есть
      масштаб (+/− , «Вся цепочка», сброс камеры), лишние плечи больше не
      отбрасываются.
   9. «Сравнение версий»: радар профилей, мост изменений маржи, вердикт-борд и
      тепловая карта «продукт × период» с переключателем A / B / B − A.

   Тесты поднимают настоящий index.html в jsdom на настоящем демо-наборе.

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
const HTML = process.env.INPLAN_HTML
  ? path.resolve(process.env.INPLAN_HTML)
  : path.join(ROOT, 'index.html');
const BASE = 'http://localhost:8080';
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

const localResources = requestInterceptor((request) => {
  const u = new URL(request.url);
  if (u.origin === BASE) {
    const file = path.join(ROOT, u.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return new Response(fs.readFileSync(file), {
        headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' },
      });
    }
  }
  return new Response('', { headers: { 'Content-Type': 'text/css' } });
});

async function loadApp(seed = {}) {
  const virtualConsole = new VirtualConsole();
  const noise = [];
  virtualConsole.on('jsdomError', (e) => noise.push(String(e.message || e).split('\n')[0]));

  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: { interceptors: [localResources] },
    beforeParse(window) {
      for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
    },
  });

  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const window = dom.window;
  return {
    dom, window,
    document: window.document,
    noise,
    async go(tab, ms = 140) {
      window.eval(`go(${JSON.stringify(tab)})`);
      await new Promise((r) => setTimeout(r, ms));
    },
    async tick(ms = 30) { return new Promise((r) => setTimeout(r, ms)); },
    ev: (code) => window.eval(code),
    kpi(title) {
      return [...window.document.querySelectorAll('#main .kpi')]
        .find((el) => el.querySelector('.t') && el.querySelector('.t').textContent.trim() === title);
    },
    close() { try { dom.window.close(); } catch { /* jsdom: не суть */ } },
  };
}

/* ─────────────────── 1. Навигация и удалённые разделы ─────────────────── */

test('навигация: разделов десять, «Экономика отказов» удалена, «Сравнение версий» — на её месте', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const nav = [...ctx.document.querySelectorAll('#nav button')].map((b) => b.textContent.trim());
  assert.equal(nav.length, 10, `пунктов меню: ${nav.length} (${nav.join(' | ')})`);
  assert.ok(!nav.some((n) => /Экономика отказов/i.test(n)), 'раздела «Экономика отказов» в меню нет');
  assert.ok(nav.includes('Сравнение версий'), 'раздел «Сравнение версий» остался');
  assert.ok(nav.includes('Данные и качество'), 'разделы «Данные» и «Качество данных» объединены');
  assert.ok(!nav.includes('Данные') && !nav.includes('Качество данных'),
    'отдельных пунктов «Данные» и «Качество данных» больше нет');

  /* Место удалённого раздела: «Сравнение версий» сразу после «Запасов» */
  assert.equal(nav[8], 'Сравнение версий', 'сравнение версий стоит девятым пунктом — на месте бывшей «Экономики отказов»');
  assert.equal(nav[7], 'Запасы', 'перед сравнением — «Запасы»');

  const tabs = ctx.ev('JSON.stringify(TABS.map(x=>x[0]))');
  assert.equal(tabs, JSON.stringify(['ov', 'dm', 'tree', 'lg', 'pd', 'caps', 'pc', 'st', 'vs', 'data']),
    'список идентификаторов вкладок без cost/raw/dq');

  /* Удалён не только пункт меню, но и код раздела */
  assert.equal(ctx.ev('typeof tabCOST'), 'undefined',
    'функция tabCOST удалена вместе с разделом');
  assert.equal(ctx.ev('METRIC_HELP["cost|Упущенная маржа"]||""'), '',
    'пояснения к показателям удалённого раздела вычищены');
});

test('go(«старые» идентификаторы) не ломается: cost → «Общий», dq/raw → объединённый раздел', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  await ctx.go('cost', 120);
  assert.equal(ctx.ev('TAB'), 'ov', 'устаревшая ссылка на удалённый раздел ведёт в «Общий»');

  await ctx.go('dq', 140);
  assert.equal(ctx.ev('TAB'), 'data', 'go(«dq») открывает объединённый раздел');
  assert.equal(ctx.ev('DATA_VIEW'), 'dq', 'и включает вид «проверки качества»');
  assert.ok(ctx.kpi('Индекс качества данных'), 'вид проверок качества отрисован');

  await ctx.go('raw', 140);
  assert.equal(ctx.ev('TAB'), 'data', 'go(«raw») открывает тот же раздел');
  assert.equal(ctx.ev('DATA_VIEW'), 'raw', 'и включает вид таблиц');
  assert.ok(ctx.kpi('Не задействовано в плане'), 'вид таблиц и реестров отрисован');
});

test('переключатель вида в объединённом разделе работает и не уводит из раздела', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  await ctx.go('data', 160);
  const seg = ctx.document.getElementById('dataView');
  assert.ok(seg, 'в разделе есть переключатель вида');
  assert.equal(seg.querySelectorAll('.btn').length, 2, 'два вида: проверки и таблицы');
  assert.equal(seg.querySelector('.btn.p').dataset.dv, 'dq', 'по умолчанию открыты проверки качества');

  const raw = seg.querySelector('[data-dv="raw"]');
  raw.click();
  await ctx.tick(140);
  assert.equal(ctx.ev('DATA_VIEW'), 'raw', 'клик переключил вид');
  assert.equal(ctx.ev('TAB'), 'data', 'навигация осталась на объединённом разделе');
  assert.ok(ctx.document.querySelector('#main .dt-table, #main #rawTbl'),
    'показаны таблицы данных');
});

/* ─────────────────── 2. Активная версия в шапке ─────────────────── */

test('в шапке всегда видно, какая версия активна', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const ver = ctx.document.getElementById('pgVer');
  assert.ok(ver, 'в шапке есть подпись активной версии');
  assert.match(ver.textContent, /Активная версия/i, 'подпись объясняет, что это версия');
  assert.ok(ver.textContent.includes(ctx.ev('DS.name')), 'в подписи — имя активного датасета');

  /* Имя остаётся на месте и после того, как в #stat зафиксировано сообщение
     о загрузке файла (раньше версия из шапки исчезала) */
  ctx.ev('STAT_PIN=true; render()');
  await ctx.tick(80);
  assert.ok(ctx.document.getElementById('pgVer').textContent.includes(ctx.ev('DS.name')),
    'версия видна и при зафиксированном статусе загрузки');

  ctx.ev("DS.name='Версия 2026-09 / прогноз 4'; render()");
  await ctx.tick(80);
  assert.match(ctx.document.getElementById('pgVer').textContent, /Версия 2026-09 \/ прогноз 4/,
    'подпись обновляется вместе с активным датасетом');
});

/* ─────────────────── 3. Компактная строка метода и базы ─────────────────── */

test('переключатели упущенной маржи — одна компактная строка с двумя частями', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('ov', 140);

  const rows = [...ctx.document.querySelectorAll('#main .lmrow')];
  assert.equal(rows.length, 1, 'строка ровно одна (было две с рамкой и фоном)');
  const row = rows[0];
  assert.ok(row.querySelector('.lm-head'), 'у строки есть общий заголовок «Упущенная маржа»');
  assert.equal(row.querySelectorAll('.lm-half').length, 2, 'строка разделена на две части');
  assert.ok(row.querySelector('.lm-div'), 'части разделены вертикальной чертой');
  assert.ok(row.querySelector('#lmSeg'), 'первая часть — метод');
  assert.ok(row.querySelector('#lmBaseSeg'), 'вторая часть — база');
  assert.equal(ctx.document.querySelectorAll('#main .lmrow-note').length, 0,
    'длинных пояснительных подписей в строке нет');

  /* Пояснения живут в значках «?» */
  for (const id of ['#lmSegInfo', '#lmBaseInfo']) {
    const q = row.querySelector(id);
    assert.ok(q, `есть значок «?» ${id}`);
    assert.ok((q.getAttribute('data-help') || '').length > 20, 'подсказка значка содержательна');
    assert.equal(q.getAttribute('title'), null, 'нативного title нет — не дублирует кастомную подсказку');
  }

  /* База переключается и пересчитывает показатели */
  const before = ctx.ev("fOrders().length");
  const unc = row.querySelector('#lmBaseSeg [data-lmb="unc"]');
  assert.ok(unc, 'вторая база доступна без фильтров');
  unc.click();
  await ctx.tick(140);
  assert.equal(ctx.document.querySelector('#lmBaseSeg .btn.p').dataset.lmb, 'unc',
    'выбранная база подсвечена');
  assert.equal(ctx.ev("localStorage.getItem('inplan_lm_base')") || ctx.ev("localStorage.getItem(LM_BASE_KEY)"),
    'unc', 'выбор базы сохраняется');
  assert.equal(ctx.ev("fOrders().length"), before, 'переключение базы не меняет выборку');
});

/* ─────────────────── 4. Порядок карточек в «Общем» ─────────────────── */

test('график упущенной маржи стоит непосредственно перед таблицей заказов', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('ov', 160);

  const cards = [...ctx.document.querySelectorAll('#main .grid > .card')];
  const titles = cards.map((c) => (c.querySelector('h3') || {}).textContent || '');
  const i8 = titles.findIndex((x) => /Упущенная маржа по периодам и продуктам/.test(x));
  const i7 = titles.findIndex((x) => /^Заказы спроса/.test(x));
  assert.ok(i8 >= 0 && i7 >= 0, 'обе карточки на месте');
  assert.equal(i7 - i8, 1, `график идёт прямо перед таблицей (${titles[i8]} → ${titles[i7]})`);
  assert.ok(cards[i8].querySelector('#o8'), 'канвас графика сохранён');
  assert.ok(cards[i7].querySelector('#o7'), 'таблица заказов сохранена');
});

/* ─────────────────── 5. Единая структура KPI и подсказка на «?» ─────────────────── */

test('KPI-карточки одной структуры, подсказка — только на значке «?»', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  let checked = 0, withHelp = 0;
  for (const tab of ['ov', 'dm', 'caps', 'lg', 'vs']) {
    if (tab === 'vs') ctx.ev("localStorage.setItem('sop_vers', JSON.stringify([snap(DS)]))");
    await ctx.go(tab, 150);
    for (const card of ctx.document.querySelectorAll('#main .kpi')) {
      checked++;
      assert.ok(card.querySelector('.t'), `«${tab}»: есть заголовок карточки`);
      assert.ok(card.querySelector('.v'), `«${tab}»: есть значение`);
      assert.ok(card.querySelector('.s'), `«${tab}»: есть подпись`);
      /* Значение не содержит переносов и иных блоков — значит, не «скачет» */
      assert.equal(card.querySelector('.v').querySelectorAll('br,div').length, 0,
        `«${tab}»: значение — одна строка`);
      /* Подсказка не висит на карточке (иначе всплывает при наведении на неё) */
      assert.equal(card.getAttribute('data-help'), null, `«${tab}»: на карточке нет data-help`);
      assert.equal(card.getAttribute('title'), null, `«${tab}»: нативный title убран`);
      const q = card.querySelector('.kpi-q');
      if (q) {
        withHelp++;
        assert.equal(q.getAttribute('tabindex'), '0', `«${tab}»: значок достижим с клавиатуры`);
        assert.ok((q.getAttribute('aria-label') || '').length > 20, `«${tab}»: у значка есть текстовая альтернатива`);
      }
    }
  }
  assert.ok(checked >= 40, `проверено карточек: ${checked}`);
  assert.ok(withHelp / checked > 0.9, `подсказка есть почти у всех расчётных карточек (${withHelp}/${checked})`);
});

/* ─────────────────── 6. Узкое место ведёт в цепочку заказа ─────────────────── */

test('узкое место открывает «Этапы цепи» заказа, шестерёнка — цепочку мощностей заказа', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('dm', 260);

  const badge = ctx.document.querySelector('#d7 [data-goto-order][data-tree-mode="stages"]');
  assert.ok(badge, 'в таблице дефицитов бейдж узкого места ведёт в цепочку заказа');
  assert.ok(!badge.hasAttribute('data-rca-jump'), 'бейдж больше не открывает «Мощности»');

  /* Перед переходом ставим заведомо чужой режим — цепочка обязана открыться в тоннах */
  ctx.ev("TREE_VIEW_MODE='bom'; TREE_METRIC_MODE='cost'");
  const wantId = Number(badge.dataset.gotoOrder);
  badge.click();
  await ctx.tick(200);

  assert.equal(ctx.ev('TAB'), 'tree', 'открылся раздел «Цепочка заказа»');
  assert.equal(ctx.ev('TREE_VIEW_MODE'), 'stages', 'режим — «Этапы цепи»');
  assert.equal(ctx.ev('TREE_METRIC_MODE'), 'vol', 'единица измерения — тонны');
  assert.equal(Number(ctx.ev('SELECTED_ORDER_ID')), wantId, 'открыт именно этот заказ');

  /* Шестерёнка сохраняет прежний сценарий: цепочка мощностей этого заказа
     («Цепочка заказа» → режим мощностей) с фокусом на лимите. */
  await ctx.go('dm', 260);
  const gear = ctx.document.querySelector('#d7 .tag.gear[data-rca-jump]');
  assert.ok(gear, 'рядом с бейджем осталась шестерёнка для цепочки мощностей');
  assert.equal(gear.dataset.mode, 'prod_res', 'шестерёнка ведёт в производственные мощности');
  gear.click();
  await ctx.tick(240);
  const g = JSON.parse(ctx.ev('JSON.stringify({tab:TAB,view:TREE_VIEW_MODE,focus:TREE_FOCUSED_KEY})'));
  assert.equal(g.tab, 'tree', 'шестерёнка открывает цепочку заказа');
  assert.equal(g.view, 'prod_res', 'в режиме цепочки мощностей');
  assert.ok(g.focus, 'с фокусом на узком месте');
});

/* ───────── 6b. Спрос и покрытие: «Свод спроса» в конце раздела ───────── */

test('«Свод спроса» перенесён в конец блока, после резюме', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('dm', 300);

  const main = ctx.document.querySelector('#main');
  const recon = main.querySelector('table.rec');
  assert.ok(recon, 'карточка-сверка «Свод спроса» на месте');

  const sum = main.querySelector('.sum');
  assert.ok(sum, 'резюме раздела отрисовано');

  /* Порядок в документе: резюме идёт раньше свода */
  const pos = sum.compareDocumentPosition(recon);
  assert.ok(pos & ctx.window.Node.DOCUMENT_POSITION_FOLLOWING,
    '«Свод спроса» расположен после блока «Резюме: спрос и покрытие»');

  /* И это последний содержательный блок раздела */
  const tail = main.querySelector('.recon-tail');
  assert.ok(tail, 'свод вынесен в отдельный завершающий блок');
  assert.ok(tail.contains(recon), 'таблица тождеств лежит в этом блоке');

  /* Свод больше не стоит вторым в сетке графиков */
  const firstGrid = main.querySelector('.grid:not(.recon-tail)');
  assert.ok(!firstGrid.querySelector('table.rec'),
    'в основной сетке графиков свода больше нет');
});

/* ─────────────────── 7. Логистика: мультивыбор и масштаб ─────────────────── */

test('логистика: виды транспорта выбираются мультивыбором, у графа есть масштаб', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('lg', 300);

  const chips = [...ctx.document.querySelectorAll('[data-ltm]')];
  assert.ok(chips.length >= 3, 'есть чипы видов транспорта (включая «Все виды»)');
  const types = chips.map((c) => c.dataset.ltm).filter((v) => v !== 'all');
  assert.ok(types.length >= 2, `видов транспорта в демо-наборе: ${types.join(', ')}`);

  /* Мультивыбор: два клика подряд оставляют оба вида выбранными */
  chips.find((c) => c.dataset.ltm === types[0]).click();
  await ctx.tick(200);
  assert.deepEqual(JSON.parse(ctx.ev('JSON.stringify(LG_FLOW_TMS)')), [types[0]],
    'первый вид выбран');
  const chips2 = [...ctx.document.querySelectorAll('[data-ltm]')];
  chips2.find((c) => c.dataset.ltm === types[1]).click();
  await ctx.tick(200);
  const sel = JSON.parse(ctx.ev('JSON.stringify(LG_FLOW_TMS)'));
  assert.equal(sel.length, 2, `выбрано два вида: ${sel.join(', ')}`);
  const active = [...ctx.document.querySelectorAll('[data-ltm].on')].map((c) => c.dataset.ltm);
  assert.deepEqual(active.sort(), sel.slice().sort(), 'оба вида подсвечены как активные');

  /* Лишние плечи больше не отбрасываются: рисуются все плечи контура */
  const allLegs = JSON.parse(ctx.ev(`JSON.stringify((function(){
    const O=fOps().filter(r=>r.type==='movement');
    const legs=grp(O,r=>r.fr+' → '+r.to,v=>({tm:v[0].tm,layer:(v[0].fr.startsWith('Vendor_')?'inbound':(v[0].fr.startsWith('Plant_')&&v[0].to.startsWith('Plant_')?'interplant':'distrib'))}));
    return legs.filter(l=>l.tm&&['${sel.join("','")}'].includes(l.tm)).length;
  })())`));
  assert.ok(allLegs > 0, 'в выбранных видах транспорта есть плечи');

  /* Панель графа: кнопки +/− убраны, осталась только «Вся цепочка».
     Камера живёт под ключом '#l3' (селектор), а не 'l3'. */
  for (const id of ['lgZoomIn', 'lgZoomOut']) {
    assert.equal(ctx.document.getElementById(id), null, `кнопка масштаба #${id} убрана`);
  }
  const fit = ctx.document.getElementById('lgZoomFit');
  assert.ok(fit, 'кнопка «Вся цепочка» на месте');

  /* Камера не тронута и узел не выбран — сбрасывать нечего, кнопка погашена */
  ctx.ev("flowReset('#l3')");
  ctx.ev('render()');
  await ctx.tick(240);
  assert.equal(ctx.document.getElementById('lgZoomFit').disabled, true,
    'без изменений вида кнопка неактивна, а не «мертва»');

  /* После зума колесом кнопка оживает и реально возвращает автоподбор */
  ctx.ev("flowView('#l3').k=2.5");
  ctx.ev('render()');
  await ctx.tick(240);
  const fit2 = ctx.document.getElementById('lgZoomFit');
  assert.equal(fit2.disabled, false, 'изменённый масштаб активирует кнопку');
  fit2.click();
  await ctx.tick(200);
  assert.equal(ctx.ev("flowView('#l3').k"), 0, '«Вся цепочка» возвращает автоподбор масштаба');
});

/* ───────── 7b. Логистика: сквозная цепочка при выборе узла ───────── */

test('выбор узла на графе потоков показывает всю сквозную цепочку, а не соседей', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.go('lg', 300);

  /* Берём узел из середины сети — завод, у которого есть и снабжение, и сбыт */
  const pick = JSON.parse(ctx.ev(`JSON.stringify((function(){
    const O=fOps().filter(r=>r.type==='movement');
    const legs=[...new Set(O.map(r=>r.fr+'>'+r.to))].map(s=>({fr:s.split('>')[0],to:s.split('>')[1]}));
    const plants=[...new Set(legs.map(l=>l.fr).concat(legs.map(l=>l.to)))]
      .filter(n=>n.startsWith('Plant_')
        && legs.some(l=>l.to===n) && legs.some(l=>l.fr===n));
    return plants[0]||null;
  })())`));
  assert.ok(pick, 'в демо-наборе есть транзитный завод с входом и выходом');

  /* Транзитивное замыкание должно быть строго шире круга прямых соседей */
  const counts = JSON.parse(ctx.ev(`JSON.stringify((function(){
    const O=fOpsChain?fOps().filter(r=>r.type==='movement'):[];
    const legs=[...new Set(O.map(r=>r.fr+'>'+r.to))].map(s=>({fr:s.split('>')[0],to:s.split('>')[1]}));
    const n=${JSON.stringify(pick)};
    const neigh=new Set([n]);
    legs.forEach(l=>{if(l.fr===n)neigh.add(l.to);if(l.to===n)neigh.add(l.fr)});
    const ch=flowChainOf(legs,n);
    return {neighbours:neigh.size, chain:ch.nodes.size};
  })())`));
  assert.ok(counts.chain > counts.neighbours,
    `сквозная цепочка шире прямых соседей (цепочка ${counts.chain} против соседей ${counts.neighbours})`);

  /* Клик по узлу: раздел переходит в режим сквозной цепочки */
  ctx.ev(`(function(){
    const O=fOpsChain().filter(r=>r.type==='movement');
    return O.length;
  })()`);
  ctx.ev(`F.nd=[${JSON.stringify(pick)}];LG_FLOW_LAYER='all';render()`);
  await ctx.tick(320);

  const note = ctx.document.querySelector('.chain-note');
  assert.ok(note, 'под графом появилось пояснение о сквозной цепочке');
  assert.match(note.textContent, /сквозная цепочка/i, 'пояснение говорит о сквозной цепочке');

  /* Ключевая проверка: показатели считаются по ВСЕЙ цепочке заказов узла,
     а не только по операциям, касающимся узла (как делал fOps). */
  const cmp = JSON.parse(ctx.ev(`JSON.stringify({
    touching: fOps().filter(r=>r.type==='movement').length,
    chain: fOpsChain().filter(r=>r.type==='movement').length
  })`));
  assert.ok(cmp.chain > cmp.touching,
    `цепочка охватывает больше операций, чем касающиеся узла (${cmp.chain} против ${cmp.touching})`);

  /* «Вся цепочка» снимает выделение и возвращает прежний контур */
  const fitBtn = ctx.document.getElementById('lgZoomFit');
  assert.equal(fitBtn.disabled, false, 'при выбранном узле кнопка активна');
  fitBtn.click();
  await ctx.tick(300);
  assert.deepEqual(JSON.parse(ctx.ev('JSON.stringify(F.nd)')), [], 'выделение узла снято');
  assert.equal(ctx.document.querySelector('.chain-note'), null, 'пояснение убрано');
});

/* ─────────────────── 8. Сравнение версий: визуал ─────────────────── */

test('сравнение версий обогащено: радар, мост изменений, вердикт-борд, теплокарта', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  /* Две версии: текущая и снапшот с изменёнными вводными */
  ctx.ev(`(function(){
    const v=snap(DS);
    v.name='Версия-эталон'; v.mar=v.mar*0.92; v.rev=v.rev*0.97;
    v.mv=v.mv*1.08; v.pd=v.pd*0.99; v.sal=v.sal*0.96;
    localStorage.setItem('sop_vers', JSON.stringify([v]));
  })()`);
  await ctx.go('vs', 320);

  assert.ok(ctx.document.getElementById('v4'), 'радар профилей версий отрисован');
  assert.ok(ctx.document.getElementById('v5'), 'мост изменений маржи отрисован');
  const board = ctx.document.querySelector('#main .vboard');
  assert.ok(board, 'вердикт-борд есть');
  const blocks = [...board.querySelectorAll('.vb')];
  assert.ok(blocks.length >= 6, `в вердикт-борде ${blocks.length} блоков плана`);
  blocks.forEach((b) => {
    assert.ok(b.querySelector('.vb-t').textContent.trim().length > 2, 'у блока есть название');
    assert.match(b.querySelector('.vb-v').textContent, /→/, 'показаны значения A → B');
    assert.match(b.querySelector('.vb-badge').textContent, /Версия A|Версия B|паритет/, 'есть вердикт');
  });
  assert.ok(board.querySelectorAll('.vb.ok').length + board.querySelectorAll('.vb.bad').length > 0,
    'вердикты подсвечены (лучше/хуже)');

  /* Теплокарта «продукт × период»: три режима, по умолчанию — разница B − A */
  const heat = ctx.document.getElementById('v7');
  assert.ok(heat, 'тепловая карта продукт × период отрисована');
  const seg = ctx.document.getElementById('vsHeatMode');
  assert.ok(seg, 'у теплокарты есть переключатель режима');
  assert.equal(seg.querySelector('.btn.p').dataset.vh, 'delta', 'по умолчанию — разница B − A');
  const labels = JSON.parse(ctx.ev(`JSON.stringify({
    rows:document.querySelectorAll('#v7').length,
    deltaText:(document.querySelector('#vsHeatMode .btn.p')||{}).textContent
  })`));
  assert.match(labels.deltaText, /B − A/, 'подпись режима говорит о разнице версий');
  seg.querySelector('[data-vh="b"]').click();
  await ctx.tick(200);
  assert.equal(ctx.document.getElementById('vsHeatMode').querySelector('.btn.p').dataset.vh, 'b',
    'режим «Версия B» включается');
  assert.ok(ctx.document.getElementById('v7'), 'теплокарта остаётся на месте после переключения');

  /* Таблица отличий никуда не делась, но стала компактнее */
  const table = ctx.document.getElementById('v3');
  assert.ok(table && table.textContent.length > 20, 'таблица отличий на месте');
});
