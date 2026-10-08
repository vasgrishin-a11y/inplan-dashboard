/* Полноэкранные графики производства должны показывать все категории,
   а не только компактный top-N для карточки в сетке. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole, requestInterceptor } = jsdomPkg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.INPLAN_HTML ? path.resolve(process.env.INPLAN_HTML) : path.join(ROOT, 'index.html');
const BASE = 'http://localhost:8080';
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const localResources = requestInterceptor((request) => {
  const u = new URL(request.url);
  if (u.origin === BASE) {
    const file = path.join(ROOT, u.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile())
      return new Response(fs.readFileSync(file), { headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' } });
  }
  return new Response('', { headers: { 'Content-Type': 'text/css' } });
});

function installCanvasStub(window) {
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true, get() { return 1240; },
  });
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (this.__ctx) return this.__ctx;
    const state = {};
    const base = {
      canvas: this,
      measureText: (text) => ({ width: String(text == null ? '' : text).length * 6.2 }),
      getLineDash: () => [],
      createLinearGradient: () => ({ addColorStop() {} }),
    };
    this.__ctx = new Proxy(base, {
      get(target, key) {
        if (key in target) return target[key];
        if (key in state) return state[key];
        const noop = () => {};
        state[key] = noop;
        return noop;
      },
      set(target, key, value) { state[key] = value; return true; },
    });
    return this.__ctx;
  };
}

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadApp() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole, resources: { interceptors: [localResources] },
    beforeParse: installCanvasStub,
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await tick(120);
  return {
    window: dom.window,
    document: dom.window.document,
    ev: (code) => dom.window.eval(code),
    async go(tab) { dom.window.eval(`go(${JSON.stringify(tab)})`); await tick(); },
    async fullscreen(id) {
      const button = dom.window.document.querySelector(`[data-fs="${id}"]`);
      assert.ok(button, `у графика #${id} есть кнопка разворота`);
      button.click();
      await tick();
      return dom.window.document.getElementById(id);
    },
    close() { try { dom.window.close(); } catch { /* jsdom */ } },
  };
}

test('графики «Производства» сохраняют top-N в сетке и показывают весь набор в fullscreen', async (t) => {
  const ctx = await loadApp();
  t.after(ctx.close);

  /* Добавляем объекты сверх обычных ограничений графиков, чтобы тест проверял
     полноту серий, а не зависел от числа площадок в демо-наборе. */
  ctx.ev(`(()=>{
    const orderId=DS.orders[0].id, source=DS.ops.find(o=>o.type==='production');
    for(let i=1;i<=16;i++)DS.ops.push({...source,o:orderId,type:'production',t:'pd',
      pl:'Plant_full_'+i,pr:'Product_full_'+i,rs:'Resource_full_'+i,rt:'Route_full_'+i,
      v:100+i,r:1000+i,cost:(1000+i)*(100+i),rc:20+i,dp:10+i,stub:false});
    const cap=DS.capacity[0];
    for(let i=1;i<=14;i++)DS.capacity.push({...cap,pl:'Capacity_plant_'+i,
      rs:'Capacity_resource_'+i,rsName:'Capacity resource '+i,util:.5+i/100,
      norm:1000,avail:1000,load:500+i,free:500-i});
    DS.hasCap=true;
  })()`);
  await ctx.go('pd');

  const expected = JSON.parse(ctx.ev(`(()=>{
    const O=fOps().filter(r=>r.type==='production');
    return JSON.stringify({
      plants:new Set(O.map(r=>r.pl)).size,
      routes:new Set(O.map(r=>r.rt).filter(Boolean)).size,
      products:new Set(O.map(r=>r.pr)).size,
      capacities:DS.capacity.length,
      capPlants:new Set(DS.capacity.map(c=>c.pl)).size
    });
  })()`));
  assert.ok(expected.plants > 9 && expected.routes > 10 && expected.products > 8,
    'фикстура превышает top-N по заводам, маршрутам и продуктам');
  assert.ok(expected.capacities > 10 && expected.capPlants > 8,
    'фикстура превышает top-N по мощностям');

  const hits = (id) => ctx.document.getElementById(id)._h.length;
  assert.equal(hits('p1'), 9, 'в сетке «Затраты по заводам» остаётся top-9');
  assert.equal(hits('p2'), 10, 'в сетке «Узкие места» остаётся top-10');
  assert.equal(hits('p3'), 10, 'в сетке «Себестоимость передела» остаётся top-10');
  assert.equal(hits('p5'), 7 * 8, 'в сетке теплокарта остаётся 7 × 8');
  assert.equal(hits('p6'), 8, 'в сетке «Баланс мощностей» остаётся top-8 площадок');

  let canvas = await ctx.fullscreen('p1');
  assert.equal(hits('p1'), expected.plants, 'fullscreen p1 включает все заводы');
  assert.ok(canvas.height >= expected.plants * 30, 'высота p1 позволяет читать каждый ряд');

  canvas = await ctx.fullscreen('p2');
  assert.equal(hits('p2'), expected.capacities, 'fullscreen p2 включает все записи мощностей');

  canvas = await ctx.fullscreen('p3');
  assert.equal(hits('p3'), expected.routes, 'fullscreen p3 включает все рецепты и маршруты');
  assert.ok(canvas.height >= expected.routes * 30, 'в fullscreen p3 маршруты идут отдельными читаемыми рядами');

  canvas = await ctx.fullscreen('p5');
  assert.equal(hits('p5'), expected.plants * expected.products,
    'fullscreen p5 включает каждую комбинацию завода и продукта');
  assert.match(canvas.style.width, /px$/, 'широкая теплокарта доступна через горизонтальную прокрутку');
  assert.ok(canvas.height >= expected.plants * 28, 'высота теплокарты рассчитана по полному списку заводов');

  await ctx.fullscreen('p6');
  assert.equal(hits('p6'), expected.capPlants, 'fullscreen p6 включает все площадки');
});
