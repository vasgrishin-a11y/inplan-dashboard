/* ─────────────────────────────────────────────────────────────────────────────
   Цепочка заказа → «Мощности цехов» → режим «Фокус»: почему карточек с
   критическими ограничениями было меньше, чем узких мест по факту.

   Разобрано на четыре причины, каждая закрыта проверкой:

   1. ОТБОР. В цепочку заказа попадают (а) ресурсы операций самого заказа и
      (б) «соседние» ограничения справочника, совпавшие с заказом по категории
      ресурса, периоду, продуктам BOM и направлению, с загрузкой ≥CHAIN_UTIL_MIN
      (85%) либо заблокированные. Вкладка «Мощности» при этом смотрит на ВЕСЬ
      реестр схемы — поэтому там узких мест больше, и это нормально: числа
      объяснены прямо на канвасе («во всём реестре схемы таких ограничений N»).
   2. ПОРОГИ. Раньше 0.90 / 0.999 / 0.85 были зашиты числами в пяти местах,
      теперь это BN_UTIL / CRIT_UTIL / CHAIN_UTIL_MIN — одна точка определения,
      флаги цепочки согласованы с флагами реестра.
   3. ОТРИСОВКА. Режим «Фокус» рисовал максимум 4 карточки в одну строку
      (numCols ≤ 4, высота канваса — константа 190): остальные критические
      ограничения молча терялись. Теперь рисуются ВСЕ (до FOCUS_MAX), с переносом
      в несколько строк, а высота канваса считается той же функцией focusLayout(),
      что и раскладка.
   4. ДАННЫЕ. Строки capacity без поля cat (демо-набор, часть XLSX-выгрузок)
      не проходили фильтр категории и не попадали в цепочку вовсе. build() теперь
      проставляет категорию и единицу измерения по умолчанию.

   Canvas в jsdom отсутствует, поэтому 2D-контекст подменяется записывающим
   стабом: проверка идёт по настоящим точкам регистрации (reg → canvas._h),
   то есть по факту нарисованных и кликабельных карточек, а не по пересказу кода.

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

/** Записывающий 2D-контекст: все вызовы — пустышки, свойства запоминаются. */
function installCanvasStub(window) {
  /* jsdom не считает раскладку: clientWidth всегда 0, и канвас получался шириной
     260 px — в одну колонку. Задаём реалистичную ширину, чтобы проверки шли по
     той же сетке, что в браузере (4 колонки в «Фокусе»). */
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      const w = this.ownerDocument && this.ownerDocument.defaultView;
      return Number(this.dataset.testWidth) || Number(w && w.__CANVAS_W) || 1240;
    },
  });
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (this.__ctx) return this.__ctx;
    const canvasEl = this;
    const state = {};
    const base = {
      canvas: this,
      /* записываем тексты: шапка «Фокуса» рисуется на канвасе, и проверить её
         иначе нельзя — а именно там объясняется отбор критических ограничений */
      fillText(t) { (canvasEl.__texts = canvasEl.__texts || []).push(String(t == null ? '' : t)); },
      measureText: (t) => ({ width: String(t == null ? '' : t).length * 6.2 }),
      getLineDash: () => [],
      createLinearGradient: () => ({ addColorStop() {} }),
      createPattern: () => null,
      isPointInPath: () => false,
    };
    this.__ctx = new Proxy(base, {
      get(t, k) {
        if (k in t) return t[k];
        if (k in state) return state[k];
        const noop = () => {};
        state[k] = noop;
        return noop;
      },
      set(t, k, v) { state[k] = v; return true; },
      has(t, k) { return k in t || k in state; },
    });
    return this.__ctx;
  };
}

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
      installCanvasStub(window);
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
    tick: (ms = 40) => new Promise((r) => setTimeout(r, ms)),
    ev: (code) => window.eval(code),
    /** открыть «Цепочку заказа» → «Мощности цехов» → нужный режим раскладки (кликами по настоящим кнопкам) */
    async openFocus(layout = 'focus', orderId = null) {
      window.eval(`go('tree')`);
      await new Promise((r) => setTimeout(r, 60));
      if (orderId != null) window.eval(`SELECTED_ORDER_ID=${Number(orderId)};render()`);
      window.document.getElementById('vmProdRes').click();
      await new Promise((r) => setTimeout(r, 60));
      /* режим «Сетка» удалён из приложения (задача владельца 2026-09-16) */
      const btn = layout === 'focus' ? 'rlFocus' : 'rlPlants';
      window.document.getElementById(btn).click();
      await new Promise((r) => setTimeout(r, 80));
    },
    /** факт отрисовки: точки регистрации канваса (reg) + ожидаемые узлы */
    drawn() {
      return JSON.parse(window.eval(`(function(){
        const ord = DS.orders.find(o=>o.id===SELECTED_ORDER_ID) || DS.orders[0];
        const ops = DS.ops.filter(o=>o.o===ord.id);
        const cn = chainNodesFor(ops, ord, false);
        const c = document.getElementById('treeCanvas');
        const hs = c && c._h ? c._h : [];
        const cards = hs.filter(r=>r.h===FOCUS_CARD_H);
        const grid = hs.filter(r=>r.h===58);
        return JSON.stringify({
          orderId: ord.id, nodes: cn.nodes.length, bn: cn.bn.length,
          bnTitles: cn.bn.map(n=>n.title), bnCrit: cn.bn.filter(n=>n.isCrit||n.isBlocked).length,
          focusMax: FOCUS_MAX,
          cardHits: cards.length, cardTips: cards.map(r=>r.html),
          cardBottom: cards.length ? Math.max.apply(null, cards.map(r=>r.y+r.h)) : 0,
          gridHits: grid.length,
          gridBottom: grid.length ? Math.max.apply(null, grid.map(r=>r.y+r.h)) : 0,
          pipeHits: hs.filter(r=>r.h===14).length,
          cssH: c && c.style.height ? parseFloat(c.style.height) : 0,
          canvasH: c ? c.height : 0,
          registryBn: DS.capacity.filter(c2=>c2.isBottleneck||c2.isCrit).length
        });
      })()`));
    },
    close() { try { dom.window.close(); } catch { /* jsdom: не суть */ } },
  };
}

test('строки мощностей без категории не выпадают из отбора цепочки', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const r = JSON.parse(ctx.ev(`JSON.stringify({
    total: DS.capacity.length,
    noCat: DS.capacity.filter(c=>!c.cat).length,
    noUnit: DS.capacity.filter(c=>!c.unit).length,
    prod: DS.capacity.filter(c=>c.cat==='production').length
  })`));
  assert.ok(r.total > 0, 'в демо-наборе есть мощности');
  assert.equal(r.noCat, 0, 'категория проставлена всем строкам (без неё «соседние» ограничения терялись)');
  assert.equal(r.noUnit, 0, 'единица измерения проставлена — карточки не пишут «т» вместо часов');
  assert.equal(r.prod, r.total, 'демо-мощности — производственные');
});

test('пороги цепочки совпадают с порогами вкладки «Мощности»', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  const r = JSON.parse(ctx.ev(`(function(){
    const ord = DS.orders[0];
    const ops = DS.ops.filter(o=>o.o===ord.id);
    const cn = chainNodesFor(ops, ord, false);
    return JSON.stringify({
      BN_UTIL, CRIT_UTIL, CHAIN_UTIL_MIN,
      chainBn: cn.bn.length,
      chainAllCritical: cn.bn.every(n=>n.isBlocked || n.util >= BN_UTIL),
      registry: DS.capacity.filter(c=>c.isBottleneck).length,
      flagsMatch: cn.bn.every(n=>{
        const c = DS.capacity.find(x=>x.rs===n.rs);
        return !c || c.isBottleneck || c.isCrit || n.isBlocked;
      })
    });
  })()`) );

  assert.equal(r.BN_UTIL, 0.9, 'порог узкого места 90%');
  assert.equal(r.CRIT_UTIL, 0.999, 'порог перегруза ~100%');
  assert.ok(r.CHAIN_UTIL_MIN < r.BN_UTIL, 'порог включения в цепочку ниже порога узкого места');
  assert.equal(r.chainAllCritical, true, 'красными считаются только ≥90% и блокировки');
  assert.equal(r.flagsMatch, true, 'флаги цепочки согласованы с флагами реестра мощностей');
});

test('режим «Фокус» рисует ВСЕ критические ограничения, а не первые четыре', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.openFocus('focus');

  const d = ctx.drawn();
  assert.ok(d.nodes > 0, 'цепочка заказа содержит узлы');
  assert.ok(d.bn > 4, `в демо-наборе критических ограничений больше четырёх (факт: ${d.bn}) — на этом и ломалась старая отрисовка`);

  const expected = Math.min(d.bn, d.focusMax);
  assert.equal(d.cardHits, expected,
    `нарисовано карточек: ${d.cardHits}, ожидалось ${expected} (REGRESSION: раньше рисовалось максимум 4)`);
  assert.equal(d.pipeHits, d.nodes, 'полоса цепочки показывает все узлы, а не только критические');

  // каждая критическая мощность реально присутствует среди нарисованных карточек
  const tips = d.cardTips.join('\n');
  d.bnTitles.slice(0, d.focusMax).forEach((title) => {
    assert.ok(tips.includes(String(title).slice(0, 12)),
      `критическое ограничение «${title}» не нарисовано в режиме «Фокус»`);
  });
});

test('карточки «Фокуса» не обрезаются: высота канваса считается по той же раскладке', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.openFocus('focus');

  const d = ctx.drawn();
  assert.ok(d.cssH > 0, 'высота канваса задана');
  assert.ok(d.cardBottom <= d.cssH,
    `последняя карточка уходит за канвас: низ ${d.cardBottom} px при высоте ${d.cssH} px`);
  // высота растёт с числом строк (старая константа 190 px вмещала одну строку)
  const rows = Math.ceil(Math.min(d.bn, d.focusMax) / ctx.ev('focusLayout(canvasW("#treeCanvas"),1).numCols'));
  assert.ok(d.cssH >= 100 + rows * 62,
    `высота ${d.cssH} px мала для ${rows} стр(ок/и) карточек`);
  assert.ok(rows > 1, 'проверка осмысленна только при переносе в несколько строк');
});

test('режим «Площадки» не обрезает карточки, а режим «Сетка» удалён', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  /* «Сетка» удалена целиком: ни кнопки, ни ветки отрисовки, ни оценки высоты */
  assert.equal(ctx.document.getElementById('rlGrid'), null,
    'кнопки «Сетка» больше нет');
  assert.ok(!/'grid'/.test(ctx.ev(`String(typeof RES_LAYOUT_MODE !== 'undefined' ? RES_LAYOUT_MODE : '')`)),
    'текущий режим раскладки — не «Сетка»');
  const src = ctx.ev(`document.documentElement.innerHTML`);
  assert.ok(!/id="rlGrid"/.test(src), 'в разметке нет #rlGrid');

  for (const layout of ['plants']) {
    await ctx.openFocus(layout);
    const d = ctx.drawn();
    assert.equal(d.gridHits, d.nodes,
      `«${layout}»: нарисовано ${d.gridHits} карточек из ${d.nodes} узлов`);
    assert.ok(d.gridBottom <= d.cssH,
      `«${layout}»: карточки уходят за канвас (${d.gridBottom} > ${d.cssH})`);
  }
});

test('числа на канвасе объясняют разницу с реестром вкладки «Мощности»', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);
  await ctx.openFocus('focus');

  // текст шапки рисуется на канвасе — читаем его из записывающего стаба
  const texts = JSON.parse(ctx.ev(`(function(){
    const c = document.getElementById('treeCanvas');
    return JSON.stringify(c.__texts || []);
  })()`));
  const d = ctx.drawn();
  const sub = ctx.document.querySelector('#main .card .sub').textContent;
  const header = texts.join(' | ');

  assert.match(sub, /Критическими считаются загрузка ≥90%/,
    'в подписи блока назван порог критичности');
  assert.match(sub, /вкладка «Мощности»|реестр/i,
    'в подписи объяснено отличие от реестра всей схемы');
  assert.match(header, /критических\s+\d+/, 'в шапке канваса — число критических узлов цепочки');
  assert.match(header, /Во всём реестре схемы таких ограничений\s+\d+/,
    'в шапке канваса — сколько критических ограничений во всём реестре (ответ на «почему здесь меньше»)');
  assert.match(header, /заказ/, 'в шапке назван заказ, к которому привязана цепочка');
  assert.ok(d.registryBn >= d.bn,
    `в реестре всей схемы узких мест не меньше (${d.registryBn} ≥ ${d.bn}) — разница объясняется привязкой к заказу`);
});

test('если карточек больше, чем влезает в канвас, это сказано вслух, а не молча обрезано', async (t) => {
  /* Инвариант: ЛИБО высота канваса не меньше нарисованного, ЛИБО показан
     #treeClipWarn с числами. Молчаливая обрезка (как было с потолком 1200 px)
     недопустима. Раздуваем реестр мощностей — «соседние» ограничения с загрузкой
     ≥BN_UTIL попадают в цепочку, и в узком канвасе (одна колонка) карточки
     заведомо не влезают. */
  const ctx = await loadApp();
  t.after(ctx.close);

  const origN = ctx.ev(`DS.capacity.length`);
  const total = ctx.ev(`(function(){
    const base = DS.capacity.slice(0, 6);
    for (let i = 0; i < 40; i++)
      base.forEach((c, j) => DS.capacity.push(Object.assign({}, c, {
        rs: c.rs + '_dup' + i + '_' + j,
        name: c.name + ' (копия ' + (i + 1) + ')',
        util: Math.max(c.util || 0, 0.95), isBottleneck: true,
      })));
    return DS.capacity.length;
  })()`);
  assert.ok(total > 200, `реестр мощностей раздут до ${total} строк`);

  ctx.window.__CANVAS_W = 60;        // узкий канвас → одна колонка → много строк
  await ctx.openFocus('plants');
  const d = ctx.drawn();
  const warn = ctx.document.getElementById('treeClipWarn');
  assert.ok(warn, 'в блоке есть место для предупреждения об обрезке');
  assert.ok(d.gridHits > 40, `карточек нарисовано много (${d.gridHits})`);

  const clipped = d.gridBottom > d.cssH + 1;
  const warnShown = warn.style.display !== 'none';
  assert.equal(warnShown, clipped,
    `предупреждение видимо ровно тогда, когда карточки не влезли (обрезка=${clipped}, показано=${warnShown}, ` +
    `низ карточек=${d.gridBottom}, высота канваса=${d.cssH})`);
  if (clipped) {
    assert.match(warn.textContent, /Не всё поместилось/, 'предупреждение названо по-человечески');
    assert.match(warn.textContent, /px/, 'в предупреждении есть числа высот');
    assert.match(warn.textContent, /Фокус/, 'предложен способ увидеть всё — режим «Фокус»');
  }

  // и наоборот: на обычном широком канвасе демо-набора ничего не обрезано
  ctx.window.__CANVAS_W = 1240;
  ctx.ev(`DS.capacity = DS.capacity.slice(0, ${origN}); render()`);   // возвращаем реестр
  await ctx.openFocus('plants');
  const d2 = ctx.drawn();
  assert.ok(d2.gridBottom <= d2.cssH + 1,
    `на нормальной ширине все карточки влезли (${d2.gridBottom} ≤ ${d2.cssH})`);
  assert.equal(ctx.document.getElementById('treeClipWarn').style.display, 'none',
    'предупреждение скрыто, когда всё поместилось');
});
