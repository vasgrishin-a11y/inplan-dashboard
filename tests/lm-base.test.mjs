/* ─────────────────────────────────────────────────────────────────────────────
   Упущенная маржа: база «непокрытый спрос неограниченного спроса» и свод спроса.

   Что проверяется (задача владельца дашборда от 2026-09-15):

   1. Упущенная маржа считается по непокрытому спросу ОТ ОБЩЕГО НЕОГРАНИЧЕННОГО
      СПРОСА: непокрытый объём = неограниченный спрос − отгружено
      = «не принято в план» + «дефицит плана»; ставка — средневзвешенная ₽/т
      дефицита плана под активным методом. Если demand_coverage нет/нулевой или
      активны фильтры — автоматический возврат к прежнему варианту (дефицит плана).
   2. Обе базы видны одновременно (задача 2026-10-06): активная — в значении
      KPI, вторая — в подсказке «?» карточки. Переключателя базы НЕТ — выбор
      отменён владельцем; база автоматическая: «Непокрытый спрос», когда
      неограниченный спрос доступен, иначе возврат к дефициту плана.
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

test('упущенная маржа по непокрытому спросу считается по стадии заказа: частично покрыто — своя маржа, 100% не покрыто — вариант', async (t) => {
  /* 2026-10-05 (владелец): база «Непокрытый спрос» больше не масштабирует
     единую ставку дефицита плана на весь объём. Дефицит делится на две
     экономически разные группы (orderStageOf): «частично покрыто» (есть своя
     отгруженная часть — берём её маржу) и «100% не покрыто» (нет ни одной
     поставленной тонны — заказы плана с нулевой отгрузкой и весь спрос вне
     плана; оценивается выбранным вариантом LM_UNC_METHODS). См. lmTotals(). */
  const ctx = await loadApp({ [LM_BASE_KEY]: 'unc' });
  t.after(ctx.close);

  const r = JSON.parse(ctx.ev(`(function(){
    const D = fOrders(), B = covBasis(D), T = lmTotals(B, D);
    return JSON.stringify({lmPlan:T.lmPlan, lmUnc:T.lmUnc, lm:T.lm, rate:T.rate,
      base:T.base, gapPlan:B.gapPlan, gapTotal:B.gapTotal, notPlanned:B.notPlanned,
      rateSrc:T.rateSrc, partTons:T.partTons, fullTons:T.fullTons,
      ratePart:T.ratePart, rateFull:T.rateFull, uncMethod:T.uncMethod});
  })()`) );

  assert.equal(r.base, 'unc', 'база «Непокрытый спрос» активна');
  assert.equal(r.uncMethod, 'cost', 'по умолчанию активен вариант «Ставка минус себестоимость»');
  assert.ok(r.gapTotal > r.gapPlan, 'непокрытый спрос больше дефицита плана — иначе нечего делить на группы');
  assert.ok(close(r.partTons + r.fullTons, r.gapTotal, 1e-6),
    'частично покрыто + 100% не покрыто = непокрытый спрос всего (без потерь и двойного счёта)');
  assert.ok(r.fullTons >= r.notPlanned - 1e-6, '100%-группа включает как минимум весь спрос вне плана (он всегда 100% не покрыт)');
  assert.ok(r.partTons <= r.gapPlan + 1e-6, 'частично покрытая группа не может быть больше дефицита плана');
  assert.ok(close(r.lmUnc, r.partTons * r.ratePart + r.fullTons * r.rateFull, 1e-6),
    'LM = частично покрыто × своя ставка + 100% не покрыто × ставка варианта');
  assert.ok(close(r.rate, r.lmUnc / r.gapTotal, 1e-9), 'итоговая (блендированная) ставка = lmUnc / непокрытый спрос всего');
  assert.ok(r.lmUnc > r.lmPlan, 'по непокрытому спросу потери больше, чем только по дефициту плана');
  assert.equal(r.lm, r.lmUnc, 'в KPI идёт значение активной базы');
  assert.match(r.rateSrc, /100% не покрыто/, 'источник ставки объясняет обе группы, а не одну общую');
});

test('вариант оценки 100%-непокрытого объёма: переключатель в интерфейсе, выбор сохраняется и меняет ставку', async (t) => {
  const ctx = await loadApp({ [LM_BASE_KEY]: 'unc' });
  t.after(ctx.close);
  ctx.ev("go('dm')");
  await ctx.tick();

  /* «Метод» (5 кнопок) относится только к базе «Дефицит плана» — под базой
     «Непокрытый спрос» он не показывается, иначе выглядел бы рабочим, хотя
     ни на что не влияет; вместо него — «Вариант» (2 кнопки). */
  assert.equal(ctx.document.getElementById('lmSeg'), null, '«Метод» скрыт под базой «Непокрытый спрос»');
  const seg = ctx.document.getElementById('lmVarSeg');
  assert.ok(seg, 'переключатель варианта есть');
  const btns = [...seg.querySelectorAll('button')];
  assert.deepEqual(btns.map((b) => b.dataset.lmu), ['cost', 'prod'], 'два варианта: ставка минус себестоимость, средняя маржа по продукту');
  assert.equal(btns.find((b) => b.classList.contains('p')).dataset.lmu, 'cost', 'по умолчанию активен первый вариант (задача владельца)');

  /* подкладываем ставку несостоявшейся поставки для первого же продукта с
     дефицитом — без справочника demand_cost вариант «cost» тихо вырождается
     в «prod» (см. lmCostMinusAvgRate), и переключатель было бы нечем проверить */
  const probe = JSON.parse(ctx.ev(`(function(){
    const D=fOrders(), o=D.find(x=>orderStageOf(x)==='fullUnc')||D.find(x=>x.unm>0.01);
    DS.penaltyFlat=[{item:o.prod, loc:o.loc, nonDel:999999, lateRate:0, latePeriods:0}];
    LM_REF=null;
    const T=lmTotals(covBasis(D),D);
    return JSON.stringify({rateFull:T.rateFull, lmUnc:T.lmUnc});
  })()`));

  const uncBtn = btns.find((b) => b.dataset.lmu === 'prod');
  uncBtn.click();
  await ctx.tick(60);
  assert.equal(ctx.window.localStorage.getItem('inplan_lm_unc_method'), 'prod', 'выбор варианта сохранён');

  const afterSwitch = JSON.parse(ctx.ev(`(function(){
    const D=fOrders(), T=lmTotals(covBasis(D),D);
    return JSON.stringify({rateFull:T.rateFull, lmUnc:T.lmUnc, uncMethod:T.uncMethod});
  })()`));
  assert.equal(afterSwitch.uncMethod, 'prod', 'активный вариант переключился');
  assert.notEqual(afterSwitch.rateFull, probe.rateFull,
    `с подложенной высокой ставкой непоставки варианты обязаны давать разные ставки 100%-группы (cost=${probe.rateFull}, prod=${afterSwitch.rateFull})`);
  assert.notEqual(afterSwitch.lmUnc, probe.lmUnc, 'и, следовательно, разную упущенную маржу по непокрытому спросу');

  ctx.ev(`DS.penaltyFlat=[]; LM_REF=null;`);
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
  /* 2026-10-05: тождества счёта заказов (demand_coverage) — тоже равенства.
     Единица — правильная форма множественного числа (41 заказ, 22 заказа, 37 заказов). */
  const ordRowsN = rows.filter((r) => /заказ[аов]*$/.test(r.querySelectorAll('td')[1]?.textContent.trim() || ''));
  assert.ok(ordRowsN.length >= 3, `тождеств по заказам не меньше трёх (факт: ${ordRowsN.length})`);
  ordRowsN.forEach((r) => {
    const cells = [...r.querySelectorAll('td')];
    const left = parseNum(cells[1].textContent), right = parseNum(cells[2].textContent);
    assert.ok(close(left, right, 0.005), `тождество заказов не сходится: ${left} против ${right}`);
    assert.match(cells[3].textContent, /сходится/, 'статус тождества заказов — «сходится»');
  });
  assert.match(rows.map((r) => r.textContent).join(' | '), /Всего заказов \([^)]*\) = полностью \+ частично \+ 100% не покрыто/,
    'тождество разбиения заказов показано с фактическим источником счётчика');
  const moneyRow = rows.find((r) => /lostrevenue/i.test(r.textContent));
  assert.ok(moneyRow, 'денежная сверка с lostrevenue показана');
  assert.ok(parseBn(moneyRow.querySelectorAll('td')[1].textContent) > 0,
    'в демо-наборе денежная сверка ненулевая');

  /* 2026-10-05: карточки «Не принято в план», «Ограниченный спрос (план)»,
     «Дефицит плана» убраны из ряда; «Отгружено» → «План продаж» */
  const cards = ['Неограниченный спрос', 'План продаж', 'Не покрыто всего',
    'Маржинальность продаж', 'Упущенная маржа'];
  cards.forEach((c) => assert.ok(ctx.kpi(c), `карточка «${c}» присутствует`));
  for (const gone of ['Не принято в план', 'Ограниченный спрос (план)', 'Дефицит плана', 'Фактически отгружено с опозданием'])
    assert.equal(ctx.kpi(gone), undefined, `карточки «${gone}» больше нет`);
  const unc = parseNum(ctx.kpi('Неограниченный спрос').querySelector('.v').textContent);
  const gap = parseNum(ctx.kpi('Не покрыто всего').querySelector('.v').textContent);
  const ship = parseNum(ctx.kpi('План продаж').querySelector('.v').textContent);
  const V = JSON.parse(ctx.ev('(function(){const b=covBasis(fOrders());'
    + 'return JSON.stringify({lim:b.dem,np:b.notPlanned})})()'));
  assert.ok(close(unc, V.lim + V.np, 0.005), 'Неограниченный = Ограниченный + Не принято в план (covBasis)');
  assert.ok(close(unc, ship + gap, 0.005), 'Неограниченный = Отгружено + Не покрыто всего (карточки)');
});

test('обе базы упущенной маржи видны одновременно: активная — в KPI, вторая — в подсказке «?»', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev("go('dm')");
  await ctx.tick();

  /* 2026-10-06: выбор базы отменён владельцем — переключателя нет, база
     автоматическая. На демо-наборе без фильтров активна «Непокрытый спрос»;
     значение по второй базе видно в подсказке «?» карточки. */
  assert.equal(ctx.document.getElementById('lmBaseSeg'), null, 'переключателя базы нет (выбор отменён владельцем 2026-10-06)');
  assert.equal(ctx.document.getElementById('lmSeg'), null, 'переключателя пяти методов тоже нет');
  const lmCard = () => ctx.kpi('Упущенная маржа');
  const lmHelp = () => (lmCard().querySelector('.kpi-q') || {}).getAttribute('data-help') || '';
  const uncVal = parseBn(lmCard().querySelector('.v').textContent);
  assert.match(lmCard().querySelector('.s').innerHTML, /база: непокрытый спрос/,
    'активная база — непокрытый спрос (автоматически, без переключателя)');
  assert.match(lmHelp(), /по дефициту плана/, 'вторая база видна в подсказке «?»');

  const expected = JSON.parse(ctx.ev(`(function(){
    const D=fOrders(), B=covBasis(D), T=lmTotals(B,D);
    return JSON.stringify({lmUnc:T.lmUnc, lmPlan:T.lmPlan});
  })()`));
  assert.ok(close(uncVal, expected.lmUnc, 0.01), 'значение KPI = расчёт по непокрытому спросу');
  assert.ok(expected.lmUnc > expected.lmPlan, `по непокрытому спросу потери больше: ${expected.lmUnc} > ${expected.lmPlan}`);
});

test('под фильтрами расчёт автоматически возвращается к дефициту плана с объяснением причины', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  ctx.ev("go('dm')");
  await ctx.tick();

  ctx.ev("setF('p','0')");
  await ctx.tick(60);

  /* 2026-10-06: без переключателя — автоматический возврат, а не тихий ноль */
  const lmCard = () => ctx.kpi('Упущенная маржа');
  assert.match(lmCard().querySelector('.s').innerHTML, /база: дефицит плана/,
    'под фильтрами активна база «Дефицит плана» — автоматически');
  const help = (lmCard().querySelector('.kpi-q') || {}).getAttribute('data-help') || '';
  assert.match(help, /Вторая база недоступна/, 'подсказка «?» объясняет, почему непокрытый спрос недоступен');
  assert.match(help, /фильтр/i, 'причина названа: активны фильтры');
  assert.ok(ctx.document.getElementById('lmVarSeg'), 'строка «Метод» остаётся на месте');
  const expected = JSON.parse(ctx.ev(`(function(){
    const D=fOrders(), T=lmTotals(covBasis(D), D);
    return JSON.stringify({lm:T.lm, lmPlan:T.lmPlan});
  })()`));
  assert.equal(expected.lm, expected.lmPlan, 'расчёт вернулся к дефициту плана');
  assert.ok(close(parseBn(lmCard().querySelector('.v').textContent), expected.lm, 0.01),
    'значение KPI = дефицит плана, а не тихий ноль');
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

test('упущенная маржа и выручка одинаковы в блоках «Общий» и «Спрос и покрытие»', async (t) => {
  const ctx = await loadApp({ [LM_BASE_KEY]: 'unc', [LM_MODE_KEY]: 'prod' });
  t.after(ctx.close);

  const read = async (tab) => {
    ctx.ev(`go('${tab}')`);
    await ctx.tick(40);
    /* 2026-10-05: в «Общем» карточка объединена — «Упущенная маржа и выручка» */
    const k = ctx.kpi('Упущенная маржа') || ctx.kpi('Упущенная маржа и выручка');
    const sub=k.querySelector('.s').textContent;
    return {lm:parseBn(k.querySelector('.v').textContent),lost:(sub.match(/упущенная выручка\s+([^\n]+)/i)||[])[1]||''};
  };
  const ov = await read('ov');
  const dm = await read('dm');
  assert.ok(ov.lm > 0, 'упущенная маржа ненулевая');
  assert.ok(close(ov.lm, dm.lm, 0.01), `Общий (${ov.lm}) = Спрос и покрытие (${dm.lm})`);
  assert.equal(ov.lost,dm.lost,'упущенная выручка в подписях карточек тоже идентична');
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
