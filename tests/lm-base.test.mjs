/* ─────────────────────────────────────────────────────────────────────────────
   Упущенная маржа: база «непокрытый спрос неограниченного спроса» и свод спроса.

   Что проверяется (задача владельца дашборда от 2026-09-15):

   1. Упущенная маржа считается по непокрытому спросу ОТ ОБЩЕГО НЕОГРАНИЧЕННОГО
      СПРОСА: непокрытый объём = неограниченный спрос − отгружено
      = «не принято в план» + «дефицит плана»; ставка — средневзвешенная ₽/т
      дефицита плана под активным методом. Если demand_coverage нет/нулевой или
      активны фильтры — автоматический возврат к прежнему варианту (дефицит плана).
   2. Обе базы видны одновременно: активная — в значении KPI, вторая — в подписи.
   3. Тождества спроса сходятся и показаны числами:
        Неограниченный = Ограниченный + Не принято в план
        Ограниченный   = Отгружено + Дефицит плана
        Неограниченный = Отгружено + Не покрыто всего
      Карточка «Неограниченный спрос» подписана количеством заказов, а не
      техническим «demand_coverage, вся схема».
   4. В блоке «Общий» есть график упущенной маржи с переключателем разреза
      «Периоды / Продукты / Период × продукт».
   5. Режим «Фокус» в цепочке заказа рисует ВСЕ критические ограничения
      (раньше влезало 4 карточки в одну строку, остальные молча терялись),
      а строки capacity без категории больше не выпадают из отбора.

   Тест поднимает настоящий index.html в jsdom и работает с настоящим
   демо-набором: никаких стабов бизнес-логики.

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
const LM_MODE_KEY = 'inplan_lm_mode';
const LM_BASE_KEY = 'inplan_lm_base';
const MIME = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
};

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

/** Загрузка приложения; seed — значения localStorage до первого скрипта. */
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
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  return {
    dom,
    window,
    document: window.document,
    noise,
    tick,
    /** вычисление в глобальной области страницы (видны let/const приложения) */
    ev: (code) => window.eval(code),
    /** KPI-карточка по заголовку */
    kpi(title) {
      return [...window.document.querySelectorAll('#main .kpi')]
        .find((el) => el.querySelector('.t') && el.querySelector('.t').textContent.trim() === title);
    },
    close() {
      try { dom.window.close(); } catch { /* jsdom: не суть */ }
    },
  };
}

/** «1 234,5» / «1 234» (ru-RU, неразрывные пробелы) → число */
const parseNum = (txt) => {
  const s = String(txt).replace(/[\s\u00A0\u202F]/g, '').replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};
/** «175,50 млрд» → 175.5e9 */
const parseBn = (txt) => {
  const s = String(txt).replace(/[\s\u00A0\u202F]/g, '').replace(',', '.');
  const m = s.match(/(-?\d+(?:\.\d+)?)(млрд|млн)?/);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  return m[2] === 'млрд' ? v * 1e9 : m[2] === 'млн' ? v * 1e6 : v;
};
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

/* ─────────────────────── 1. Расчёт базы и масштаба ─────────────────────── */

test('непокрытый спрос = неограниченный − отгружено = «не принято в план» + дефицит плана', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const B = ctx.ev(`(function(){
    const D = fOrders(), b = covBasis(D);
    return JSON.stringify({demUnc:b.demUnc, dem:b.dem, sal:b.sal, unm:b.unm,
      notPlanned:b.notPlanned, gapPlan:b.gapPlan, gapTotal:b.gapTotal,
      hasDC:b.hasDC, useUnc:b.useUnc, demo:b.demo});
  })()`);
  const b = JSON.parse(B);

  assert.equal(b.hasDC, true, 'в демо-наборе агрегат покрытия должен быть (иначе базу не проверить)');
  assert.equal(b.useUnc, true, 'без фильтров неограниченный спрос применяется');
  assert.ok(b.demUnc > b.dem, 'неограниченный спрос больше ограниченного');
  assert.ok(close(b.demUnc, b.dem + b.notPlanned, 1e-9), 'Неограниченный = Ограниченный + Не принято в план');
  assert.ok(close(b.gapTotal, b.notPlanned + b.unm, 1e-9), 'Не покрыто всего = вне плана + дефицит плана');
  assert.ok(close(b.gapTotal, b.demUnc - b.sal, 1e-9), 'Не покрыто всего = Неограниченный − Отгружено');
  assert.ok(close(b.dem, b.sal + b.unm, 1e-9), 'Ограниченный = Отгружено + Дефицит плана');
});

test('упущенная маржа по непокрытому спросу = объём × средневзвешенная ставка дефицита плана', async (t) => {
  const ctx = await loadApp({ [LM_BASE_KEY]: 'unc' });
  t.after(ctx.close);

  const r = JSON.parse(ctx.ev(`(function(){
    const D = fOrders(), B = covBasis(D), T = lmTotals(B, D);
    return JSON.stringify({lmPlan:T.lmPlan, lmUnc:T.lmUnc, lm:T.lm, k:T.k, rate:T.rate,
      base:T.base, gapPlan:B.gapPlan, gapTotal:B.gapTotal, rateSrc:T.rateSrc});
  })()`) );

  assert.equal(r.base, 'unc', 'база «Непокрытый спрос» активна');
  assert.ok(r.gapTotal > r.gapPlan, 'непокрытый спрос больше дефицита плана — иначе нечего масштабировать');
  assert.ok(close(r.k, r.gapTotal / r.gapPlan, 1e-9), 'масштаб k = непокрытый спрос / дефицит плана');
  assert.ok(close(r.rate, r.lmPlan / r.gapPlan, 1e-9), 'ставка = упущенная маржа плана / дефицит плана, ₽/т');
  assert.ok(close(r.lmUnc, r.gapTotal * r.rate, 1e-6), 'LM = непокрытый объём × ставка');
  assert.ok(r.lmUnc > r.lmPlan, 'по непокрытому спросу потери больше, чем только по дефициту плана');
  assert.equal(r.lm, r.lmUnc, 'в KPI идёт значение активной базы');
  assert.match(r.rateSrc, /дефицит/, 'источник ставки объяснён');
});

test('нет demand_coverage или активны фильтры — возврат к дефициту плана (прежнее поведение)', async (t) => {
  const ctx = await loadApp({ [LM_BASE_KEY]: 'unc' });
  t.after(ctx.close);

  // 1) фильтры: агрегат по всей схеме неприменим
  const filtered = JSON.parse(ctx.ev(`(function(){
    setF('p', '0');
    const D = fOrders(), B = covBasis(D), T = lmTotals(B, D);
    return JSON.stringify({useUnc:B.useUnc, base:T.base, k:T.k, lm:T.lm, lmPlan:T.lmPlan,
      gapTotal:B.gapTotal, unm:B.unm, why:B.uncWhy});
  })()`));
  assert.equal(filtered.useUnc, false, 'под фильтрами неограниченный спрос не применяется');
  assert.equal(filtered.base, 'plan', 'база автоматически вернулась к дефициту плана');
  assert.equal(filtered.k, 1, 'масштаб не применяется');
  assert.ok(close(filtered.lm, filtered.lmPlan, 1e-9), 'LM = сумма по заказам, как раньше');
  assert.ok(close(filtered.gapTotal, filtered.unm, 1e-9), 'непокрытый объём = дефицит плана');
  assert.match(filtered.why, /фильтр/i, 'причина недоступности объяснена');

  // 2) demand_coverage отсутствует вовсе
  const noDC = JSON.parse(ctx.ev(`(function(){
    clearF();
    const keepAgg = DS.agg; DS.agg = null;
    const D = fOrders(), B = covBasis(D), T = lmTotals(B, D);
    DS.agg = keepAgg;
    return JSON.stringify({hasDC:B.hasDC, useUnc:B.useUnc, base:T.base, k:T.k, lm:T.lm, lmPlan:T.lmPlan});
  })()`));
  assert.equal(noDC.hasDC, false, 'без demand_coverage базы неограниченного спроса нет');
  assert.equal(noDC.base, 'plan', 'действует дефицит плана');
  assert.ok(close(noDC.lm, noDC.lmPlan, 1e-9), 'значение прежнее');

  // 3) неограниченный спрос нулевой
  const zero = JSON.parse(ctx.ev(`(function(){
    const keep = JSON.stringify(DS.agg);
    DS.agg.totals.cov = {demUnc:0, ff:0, uf:0, late:0}; DS.agg.dims.coverage = [];
    const D = fOrders(), B = covBasis(D), T = lmTotals(B, D);
    DS.agg = JSON.parse(keep);
    return JSON.stringify({useUnc:B.useUnc, base:T.base, k:T.k});
  })()`));
  assert.equal(zero.useUnc, false, 'нулевой неограниченный спрос не применяется');
  assert.equal(zero.base, 'plan', 'возврат к дефициту плана');
  assert.equal(zero.k, 1, 'без масштабирования');
});

test('разрезы (периоды, продукты, заказы) сходятся с итогом активной базы', async (t) => {
  const ctx = await loadApp({ [LM_BASE_KEY]: 'unc' });
  t.after(ctx.close);

  const r = JSON.parse(ctx.ev(`(function(){
    const D = fOrders(), {B, T} = lmState(D);
    const byPer = grp(D, o=>o.p, v=>({lm:S(v, lmS)}));
    const byProd = grp(D, o=>o.prod, v=>({lm:S(v, lmS)}));
    const byCell = grp(D, o=>o.p+'|'+o.prod, v=>({lm:S(v, lmS)}));
    return JSON.stringify({lm:T.lm, unattr:T.unattr,
      per:S(byPer,x=>x.lm), prod:S(byProd,x=>x.lm), cell:S(byCell,x=>x.lm)});
  })()`));

  assert.ok(close(r.per, r.lm - r.unattr, 1e-6), 'сумма по периодам = итог KPI');
  assert.ok(close(r.prod, r.lm - r.unattr, 1e-6), 'сумма по продуктам = итог KPI');
  assert.ok(close(r.cell, r.lm - r.unattr, 1e-6), 'сумма по «период × продукт» = итог KPI');
});

/* ─────────────────────── 2. Карточки и свод спроса ─────────────────────── */

test('карточка «Неограниченный спрос» подписана количеством заказов, а не demand_coverage', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev("go('dm')");
  await ctx.tick();

  const card = ctx.kpi('Неограниченный спрос');
  assert.ok(card, 'карточка «Неограниченный спрос» есть');
  const sub = card.querySelector('.s').textContent;
  assert.match(sub, /заказ/, 'в подписи — количество заказов');
  assert.ok(!/demand_coverage, вся схема/.test(sub), 'техническая подпись убрана из карточки');
  /* Подсказка живёт на значке «?», а не на карточке: наведение на карточку
     больше не показывает пояснение (задача владельца 2026-09-16) */
  const q = card.querySelector('.kpi-q');
  assert.ok(q, 'у карточки есть значок «?»');
  assert.ok(/demand_coverage/i.test(q.getAttribute('data-help') || ''),
    'источник переехал в подсказку значка «?»');
  assert.equal(card.getAttribute('data-help'), null, 'на самой карточке подсказки нет');
  assert.ok(parseNum(card.querySelector('.v').textContent) > 0, 'значение в тоннах показано');
});

test('свод спроса: все тождества сходятся и показаны числами', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev("go('dm')");
  await ctx.tick();

  const rec = ctx.document.querySelector('#main table.rec');
  assert.ok(rec, 'карточка-сверка «Свод спроса» отрисована');
  const rows = [...rec.querySelectorAll('tbody tr')];
  assert.ok(rows.length >= 3, `тождеств не меньше трёх (факт: ${rows.length})`);
  assert.equal(rec.querySelectorAll('tbody tr.bad').length, 0, 'расхождений нет');

  const texts = rows.map((r) => r.textContent.replace(/\s+/g, ' ')).join(' | ');
  assert.match(texts, /Неограниченный спрос = Ограниченный спрос \+ Не принято в план/);
  assert.match(texts, /Ограниченный спрос = Отгружено \+ Дефицит плана/);
  assert.match(texts, /Неограниченный спрос = Отгружено \+ Не покрыто всего/);

  // объёмные тождества (в тоннах) обязаны быть равенствами; денежная строка —
  // независимая сверка с lostrevenue источника, она вправе расходиться
  const volRows = rows.filter((r) => /\sт$/.test(r.querySelectorAll('td')[1]?.textContent.trim() || ''));
  assert.ok(volRows.length >= 3, `объёмных тождеств не меньше трёх (факт: ${volRows.length})`);
  volRows.forEach((r) => {
    const cells = [...r.querySelectorAll('td')];
    const left = parseNum(cells[1].textContent), right = parseNum(cells[2].textContent);
    assert.ok(close(left, right, 0.005), `тождество не сходится: ${left} против ${right}`);
    assert.match(cells[3].textContent, /сходится/, 'статус тождества — «сходится»');
  });
  const moneyRow = rows.find((r) => /lostrevenue/i.test(r.textContent));
  assert.ok(moneyRow, 'денежная сверка с lostrevenue показана');
  assert.ok(parseBn(moneyRow.querySelectorAll('td')[1].textContent) > 0,
    'в демо-наборе денежная сверка ненулевая');

  const cards = ['Неограниченный спрос', 'Не принято в план', 'Ограниченный спрос (план)',
    'Отгружено', 'Дефицит плана', 'Не покрыто всего'];
  cards.forEach((c) => assert.ok(ctx.kpi(c), `карточка «${c}» присутствует`));
  const unc = parseNum(ctx.kpi('Неограниченный спрос').querySelector('.v').textContent);
  const lim = parseNum(ctx.kpi('Ограниченный спрос (план)').querySelector('.v').textContent);
  const notPlan = parseNum(ctx.kpi('Не принято в план').querySelector('.v').textContent);
  const gap = parseNum(ctx.kpi('Не покрыто всего').querySelector('.v').textContent);
  const ship = parseNum(ctx.kpi('Отгружено').querySelector('.v').textContent);
  assert.ok(close(unc, lim + notPlan, 0.005), 'Неограниченный = Ограниченный + Не принято в план (карточки)');
  assert.ok(close(unc, ship + gap, 0.005), 'Неограниченный = Отгружено + Не покрыто всего (карточки)');
});

test('обе базы упущенной маржи видны одновременно, переключатель работает и сохраняется', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev("go('dm')");
  await ctx.tick();

  const seg = ctx.document.getElementById('lmBaseSeg');
  assert.ok(seg, 'переключатель базы есть');
  const btns = [...seg.querySelectorAll('button')];
  assert.equal(btns.length, 2, 'две базы: дефицит плана и непокрытый спрос');
  assert.equal(btns.filter((b) => b.disabled).length, 0, 'на демо-наборе обе базы доступны');

  const lmCard = () => ctx.kpi('Упущенная маржа');
  const planVal = parseBn(lmCard().querySelector('.v').textContent);
  assert.match(lmCard().querySelector('.s').innerHTML, /база: дефицит плана/, 'по умолчанию база — дефицит плана');
  assert.match(lmCard().querySelector('.s').textContent, /по непокрытому спросу/,
    'в подписи сразу видно значение второй базы');

  const uncBtn = btns.find((b) => b.dataset.lmb === 'unc');
  uncBtn.click();
  await ctx.tick(60);

  assert.equal(ctx.window.localStorage.getItem(LM_BASE_KEY), 'unc', 'выбор базы сохранён');
  const uncVal = parseBn(lmCard().querySelector('.v').textContent);
  assert.match(lmCard().querySelector('.s').innerHTML, /база: непокрытый спрос/, 'база переключилась');
  assert.match(lmCard().querySelector('.s').textContent, /по дефициту плана/, 'вторая база осталась видна');
  assert.ok(uncVal > planVal, `по непокрытому спросу потери больше: ${uncVal} > ${planVal}`);

  const expected = JSON.parse(ctx.ev(`(function(){
    const D=fOrders(), B=covBasis(D), T=lmTotals(B,D);
    return JSON.stringify({lmUnc:T.lmUnc, lmPlan:T.lmPlan});
  })()`));
  assert.ok(close(uncVal, expected.lmUnc, 0.01), 'значение KPI = расчёт по непокрытому спросу');
  assert.ok(close(planVal, expected.lmPlan, 0.01), 'значение по второй базе = расчёт по дефициту плана');
});

test('под фильтрами база «Непокрытый спрос» отключается с объяснением причины', async (t) => {
  const ctx = await loadApp({ [LM_BASE_KEY]: 'unc' });
  t.after(ctx.close);
  ctx.ev("go('dm')");
  await ctx.tick();

  ctx.ev("setF('p','0')");
  await ctx.tick(60);

  const uncBtn = [...ctx.document.querySelectorAll('#lmBaseSeg button')].find((b) => b.dataset.lmb === 'unc');
  assert.ok(uncBtn.disabled, 'кнопка «Непокрытый спрос» недоступна под фильтрами');
  assert.match(uncBtn.getAttribute('title') || '', /фильтр/i, 'причина показана в подсказке кнопки');
  const active = [...ctx.document.querySelectorAll('#lmBaseSeg button')].find((b) => b.classList.contains('p'));
  assert.equal(active.dataset.lmb, 'plan', 'активна база «Дефицит плана»');
});

/* ─────────────────────── 3. График в блоке «Общий» ─────────────────────── */

test('в блоке «Общий» есть график упущенной маржи с тремя разрезами', async (t) => {
  const ctx = await loadApp({ [LM_BASE_KEY]: 'unc' });
  t.after(ctx.close);
  ctx.ev("go('ov')");
  await ctx.tick(60);

  const seg = ctx.document.getElementById('o8dim');
  assert.ok(seg, 'переключатель разреза есть');
  const btns = [...seg.querySelectorAll('button')];
  assert.deepEqual(btns.map((b) => b.dataset.lmdim), ['period', 'prod', 'pp'],
    'разрезы: период, продукт, период × продукт');
  assert.equal(btns[0].getAttribute('aria-pressed'), 'true', 'по умолчанию активен разрез «Периоды»');

  const canvas = ctx.document.getElementById('o8');
  assert.ok(canvas, 'канвас графика есть');
  assert.equal(canvas.getAttribute('role'), 'img', 'канвас помечен для скринридера');
  assert.ok(canvas.getAttribute('aria-label'), 'у канваса есть текстовая альтернатива');

  const note = ctx.document.getElementById('o8note');
  assert.ok(note && note.textContent.length > 20, 'под графиком объяснена база расчёта');
  assert.match(note.textContent, /Непокрытый спрос|непокрытому спросу/, 'база названа');

  // переключение разреза — без полной перерисовки блока
  btns[1].click();
  await ctx.tick(30);
  assert.equal(btns[1].getAttribute('aria-pressed'), 'true', 'разрез «Продукты» активен');
  assert.equal(btns[0].getAttribute('aria-pressed'), 'false', 'прежний разрез снят');
  assert.match(ctx.document.getElementById('o8sub').textContent, /продукт/i, 'подпись соответствует разрезу');
  assert.ok(ctx.document.getElementById('o8'), 'канвас не потерялся после переключения');

  btns[2].click();
  await ctx.tick(30);
  assert.equal(btns[2].getAttribute('pressed') || btns[2].getAttribute('aria-pressed'), 'true',
    'разрез «Период × продукт» активен');
  assert.match(ctx.document.getElementById('o8sub').textContent, /период/i, 'подпись комбинированного разреза');
});

test('упущенная маржа одна и та же в блоках «Общий» и «Спрос и покрытие»', async (t) => {
  const ctx = await loadApp({ [LM_BASE_KEY]: 'unc', [LM_MODE_KEY]: 'prod' });
  t.after(ctx.close);

  const read = async (tab) => {
    ctx.ev(`go('${tab}')`);
    await ctx.tick(40);
    return parseBn(ctx.kpi('Упущенная маржа').querySelector('.v').textContent);
  };
  const ov = await read('ov');
  const dm = await read('dm');
  assert.ok(ov > 0, 'упущенная маржа ненулевая');
  assert.ok(close(ov, dm, 0.01), `Общий (${ov}) = Спрос и покрытие (${dm})`);
});

/* Проверки цепочки заказа и режима «Фокус» — в tests/tree-focus.test.mjs:
   там canvas подменён записывающим стабом, поэтому проверяется факт отрисовки
   карточек, а не только логика отбора. */
test('сохранённая версия хранит непокрытый спрос, а «Версии» показывают его в сравнении', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.window.alert = () => {};              // saveVer() сообщает об успехе через alert
  ctx.window.confirm = () => true;

  ctx.document.getElementById('bSave').click();
  await ctx.tick(60);
  const vers = JSON.parse(ctx.window.localStorage.getItem('sop_vers') || '[]');
  assert.ok(vers.length >= 1, 'версия сохранена');
  const v = vers[0];
  assert.ok(v.demUnc > 0, `в снапшоте сохранён неограниченный спрос (${v.demUnc})`);
  assert.ok(v.gap >= v.unm - 1e-6, `непокрытый спрос (${v.gap}) не меньше дефицита плана (${v.unm})`);
  assert.ok(close(v.gap, v.unm + v.notPlanned, 1e-9),
    'непокрытый спрос = дефицит плана + не принято в план (в снапшоте тоже)');
  assert.equal(v.lmBase, 'unc-available', 'в снапшоте отмечено, что demand_coverage был доступен');

  ctx.ev("go('vs')");
  await ctx.tick(60);
  /* Подпись о замороженной базе — тонкая пояснительная строка вкладки
     (раньше жила в служебной строке таблицы .dt-info) */
  const note = [...ctx.document.querySelectorAll('#main .thin-note, #main .dt-info')]
    .map((el) => el.textContent).join(' ');
  assert.match(note, /базе «Дефицит плана»/,
    'в сравнении версий прямо сказано, по какой базе заморожена упущенная маржа');
  const tbl = ctx.document.getElementById('v3');
  assert.ok(tbl, 'вкладка «Версии» отрисовала сравнение сохранённых снапшотов '
    + '(регрессия: CHX.tabVS перехватывала вкладку без CH-схем)');
  assert.match(tbl.textContent, /Не покрыто всего/, 'в таблице отличий есть «Не покрыто всего, т»');
  assert.match(tbl.textContent, /Не принято в план/, 'в таблице отличий есть «Не принято в план, т»');
  assert.match(tbl.textContent, /Упущенная маржа по непокрытому спросу/,
    'в сравнении версий видна полная цена отказа, а не только дефицит плана');

  /* полная цена отказа версии = сохранённый непокрытый объём × замороженная ставка
     (ставка = lm/unm — восстанавливается из самого снапшота, пересчёт истории не
     нужен). Проверяем по числу, которое реально показано в таблице отличий. */
  const expect = v.gap * (v.lm / v.unm);
  assert.ok(expect > v.lm, 'полная цена отказа больше LM по дефициту плана');
  const row = [...ctx.document.querySelectorAll('#v3 tr')]
    .find((r) => /Упущенная маржа по непокрытому спросу/.test(r.textContent));
  assert.ok(row, 'строка полной цены отказа есть в таблице отличий');
  const cells = [...row.querySelectorAll('td')].map((td) => parseBn(td.textContent));
  assert.ok(cells.some((c) => isFinite(c) && close(c, expect, 2e-3)),
    `в строке показано значение ${expect / 1e9} млрд ₽ (ячейки: ${cells.join(', ')})`);

  const kpis = [...ctx.document.querySelectorAll('#main .kpi')].map((k) => k.querySelector('.t').textContent);
  assert.ok(kpis.some((x) => /полной цены отказа/i.test(x)),
    'в KPI сравнения версий есть «Изменение полной цены отказа»');
});

test('«Качество данных» проверяет demand_coverage: инварианты, разрез против итога, спрос вне плана', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev("go('dq')");
  await ctx.tick(60);

  const checks = JSON.parse(ctx.ev(`(function(){
    return JSON.stringify([...document.querySelectorAll('#main .dq')].map(el => ({
      sev: el.className,
      txt: el.textContent.replace(/\\s+/g, ' ').trim(),
    })));
  })()`));
  const find = (re) => checks.find((c) => re.test(c.txt));

  const inv = find(/Неограниченный спрос: инварианты/);
  assert.ok(inv, 'чек инвариантов неограниченного спроса есть');
  assert.match(inv.txt, /Инварианты соблюдены/, 'на демо-наборе инварианты соблюдены');
  assert.match(inv.txt, /414\s?400/, 'в чеке назван неограниченный спрос');
  assert.match(inv.txt, /44\s?400/, 'в чеке назван объём вне плана');
  assert.ok(!/\be\b/.test(inv.sev.replace(/dq/g, '')), 'чек не в статусе ошибки');

  const out = find(/Спрос вне плана/);
  assert.ok(out, 'чек «Спрос вне плана» есть');
  assert.match(out.txt, /не принято в план/, 'объяснено, что это спрос, не дошедший до плана');
  assert.match(out.txt, /раза больше|полная цена отказа/, 'сказано, во сколько раз полная цена отказа больше дефицита плана');

  const lr = find(/Упущенная маржа против lostrevenue/);
  assert.ok(lr, 'денежная сверка с lostrevenue продублирована в качестве данных');

  const demo = find(/Демо-агрегат покрытия/);
  assert.ok(demo, 'в демо-наборе честно сказано, что агрегат покрытия синтезирован');
  assert.match(demo.txt, /условн/, 'тонны названы условными');

  // ошибок (severity 'e') среди чеков покрытия быть не должно
  const covErrs = checks.filter((c) => /Неограниченный спрос|Спрос вне плана|lostrevenue/.test(c.txt)
    && /(^|\s)e(\s|$)/.test(c.sev));
  assert.deepEqual(covErrs.map((c) => c.txt.slice(0, 60)), [], 'чеки покрытия без ошибок на корректных данных');
});

test('нет demand_coverage — в «Качестве данных» предупреждение, а не тишина', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  // убираем агрегат покрытия: так выглядит реальная выгрузка без demand_coverage
  ctx.ev(`DS.agg.totals.cov = {}; DS.agg.dims.coverage = []; render()`);
  await ctx.tick(60);
  ctx.ev("go('dq')");
  await ctx.tick(60);

  const txt = ctx.document.querySelector('#main').textContent.replace(/\s+/g, ' ');
  assert.match(txt, /Неограниченный спрос/, 'чек про неограниченный спрос есть и без данных');
  assert.match(txt, /отсутствует или нулевой/, 'сказано, что агрегата нет');
  assert.match(txt, /полная цена отказа занижена|занижена/, 'объяснено последствие для упущенной маржи');
  assert.match(txt, /demand_coverage/, 'назван источник, который нужно добавить в выгрузку');
});

test('денежная сверка с lostrevenue одна и та же в «Спросе» и в «Качестве данных»', async (t) => {
  /* covMoneyCheck() — единственная точка формулы и допуска (25%), поэтому две
     вкладки обязаны показывать одинаковое расхождение и одинаковый вердикт.
     Раньше в DQ был свой порог «3×», и вкладки могли спорить друг с другом. */
  const ctx = await loadApp();
  t.after(ctx.close);

  ctx.ev("go('dm')");
  await ctx.tick(60);
  const dmRow = [...ctx.document.querySelectorAll('#main table.rec tr')]
    .find((r) => /lostrevenue/.test(r.textContent));
  assert.ok(dmRow, 'в своде спроса есть денежная сверка с lostrevenue');
  const dmTxt = dmRow.textContent.replace(/\s+/g, ' ').trim();
  const dmPct = parseNum((dmTxt.match(/расхождение\s+([\d,]+)/) || [, 'NaN'])[1]);
  const dmOk = /✓/.test(dmTxt);
  assert.ok(isFinite(dmPct), `в сверке названо расхождение в процентах (${dmTxt})`);

  ctx.ev("go('dq')");
  await ctx.tick(60);
  const dq = [...ctx.document.querySelectorAll('#main .dq')]
    .find((el) => /Упущенная маржа против lostrevenue/.test(el.textContent));
  assert.ok(dq, 'в «Качестве данных» есть та же сверка');
  const dqTxt = dq.textContent.replace(/\s+/g, ' ').trim();
  const dqPct = parseNum((dqTxt.match(/расхождение\s+([\d,]+)/) || [, 'NaN'])[1]);
  const dqOk = !/\bw\b/.test(dq.className);
  assert.ok(isFinite(dqPct), `в чеке названо то же расхождение (${dqTxt})`);

  assert.ok(Math.abs(dmPct - dqPct) < 0.05,
    `расхождение одинаковое: «Спрос» ${dmPct}% против «Качество данных» ${dqPct}%`);
  assert.equal(dmOk, dqOk, 'вердикт совпадает: обе вкладки либо принимают сверку, либо нет');
  assert.equal(dmOk, dmPct <= 25, 'допуск 25% применён честно');
  assert.match(dqTxt, /lostrevenue\s*×\s*маржинальность|×\s*\d/, 'в чеке показана формула оценки');
});
