/* ═══════════════ In.Plan: общие утилиты (index.html + chain.html) ═══════════════
   Подключается обычным <script src="assets/inplan-common.js"> ДО основного скрипта
   страницы. Здесь живут функции, которые раньше дублировались в обоих файлах:
   экранирование, санитизация, формат чисел, русское склонение, тема, полифиллы.
   Устранение дублей — см. CODE_REVIEW.md, п.26: любой фикс теперь делается один раз. */

/* Полифилл roundRect: в Safari < 16 его нет, и весь граф не отрисовывался */
if (window.CanvasRenderingContext2D && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(typeof r === 'number' ? r : 4, w / 2, h / 2);
    if (w <= 0 || h <= 0) { this.rect(x, y, w, h); return this; }
    this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath(); return this;
  };
}

/* HTML-экранирование для точек вывода (включая одинарную кавычку — для атрибутов) */
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Санитизация входных данных из XLSX: срез угловых скобок, без порчи &, кавычек и текста.
   Данные в модели хранятся чистыми — esc() применяется только при выводе. */
const sany = v => String(v == null ? '' : v).replace(/[<>]/g, '');

/* Строка с обрезкой пробелов */
const xstr = v => v === undefined || v === null ? '' : String(v).trim();

/* Число из ячейки XLSX: пробелы (вкл. неразрывные) — разделители групп и удаляются.
   Запятая — десятичный разделитель, только если она одна и после неё 1-2 цифры;
   несколько запятых или 3+ цифры после запятой — разделители групп (1,234,567 -> 1234567). */
const num = v => {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[\s\u00A0\u202F]/g, '');
  if (!s) return 0;
  const hasComma = s.includes(','), hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Оба разделителя: последний встреченный — десятичный
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) { s = s.replace(/\./g, '').replace(',', '.'); }
    else { s = s.replace(/,/g, ''); }
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) { s = parts[0] + '.' + parts[1]; }
    else { s = s.replace(/,/g, ''); }
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
};

/* Целое из значения вида «P11», « 42 », 11 — буквы и мусор отбрасываются ('P11' -> 11) */
const pnum = v => {
  const s = String(v == null ? '' : v).replace(/\D/g, '');
  return s ? parseInt(s, 10) : 0;
};

/* Русское склонение: plural(3,['вариант','варианта','вариантов']) */
const plural = (n, f) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2];
};

/* ═══════════════ Приоритет заказа (колонка demandtype) ═══════════════
   Приоритет заказа определяется колонкой demandtype — в marking_demand
   (в ClickHouse она же demand_demandtype) или в demand_coverage. Раньше в
   XLSX-ветке приоритет читался из margin_per_hour, из-за чего в фильтре
   «Приоритет» оказывались миллионы ₽/ч, а проверка «приоритет 1 обслужен»
   теряла смысл (см. CODE_AUDIT.md, B1).

   Значение demandtype бывает числовым (1, 2, …) и строковым (метка типа
   спроса), поэтому нормализуем его в набор полей:
     dt      — demandtype как пришёл (число, если числовой, иначе строка);
     pr      — числовой приоритет: demandtype, если он числовой и > 0; иначе
               запасная колонка demand_demandtypepriority; иначе 0 = «не задан»;
     dtl     — метка для вывода;
     pk      — ключ для фильтров, группировок и таблиц (всегда строка);
     src     — откуда взят приоритет: 'demandtype' | 'demandtypepriority' | ''.
   Порядок для чисел прежний: 1 важнее 2. Для строк порядка нет — его не
   выдумываем, а показываем метки как есть (см. prioKeySort). */
const PRIO_NUM_RE = /^-?\d+([.,]\d+)?$/;
function prioFields(dtRaw, altRaw) {
  const dtStr = xstr(dtRaw).replace(/[\s\u00A0\u202F]/g, ''), altStr = xstr(altRaw);
  const isNum = PRIO_NUM_RE.test(dtStr);
  const dtNum = isNum ? num(dtStr) : 0;
  const altNum = num(altStr);
  const useDt = isNum && dtNum > 0;
  const useAlt = !useDt && altNum > 0;
  const pr = useDt ? dtNum : (useAlt ? altNum : 0);
  const dtl = dtStr || (pr > 0 ? nf(pr) : '');
  return {
    dt: isNum ? dtNum : sany(dtStr),
    pr,
    dtl: dtl || '—',
    pk: pr > 0 ? String(pr) : (sany(dtStr) || '—'),
    src: useDt ? 'demandtype' : (useAlt ? 'demandtypepriority' : ''),
  };
}

/* Сортировка ключей приоритета: сначала числовые по возрастанию (1 важнее 2),
   затем строковые метки по алфавиту. Числовой порядок внутри строк соблюдается
   (numeric:true), поэтому «2» идёт раньше «10». */
function prioKeySort(a, b) {
  const na = parseFloat(String(a).replace(',', '.')), nb = parseFloat(String(b).replace(',', '.'));
  const an = isFinite(na) && String(na) === String(a).replace(',', '.');
  const bn2 = isFinite(nb) && String(nb) === String(b).replace(',', '.');
  if (an && bn2) return na - nb;
  if (an !== bn2) return an ? -1 : 1;
  return String(a).localeCompare(String(b), 'ru', { numeric: true });
}

/* Числовой формат ru-RU */
const nf = (v, d = 0) => (isFinite(v) ? v : 0).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });

/* Тема: единый ключ и точка записи для обеих страниц */
const IP_THEME_KEY = 'inplan_theme';
function ipGetTheme() {
  try { return localStorage.getItem(IP_THEME_KEY) || 'light'; } catch (e) { return 'light'; }
}
function ipSetTheme(t) {
  try { localStorage.setItem(IP_THEME_KEY, t); } catch (e) { /* приватный режим */ }
  document.documentElement.setAttribute('data-theme', t);
}

/* Debounce: откладывает вызов до паузы в событиях (resize и т.п.) */
function ipDebounce(fn, ms) {
  let t;
  return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}
