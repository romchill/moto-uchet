/* Учёт ремонтов: разбор ввода, расчёты, отчёты, разбор Excel и календарь.
   Здесь нет работы со страницей — файл проверяется тестами в Node. */
(function (root) {
  "use strict";

  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  const NBSP = "\u00a0";

  const MAX_MONEY = 100000000;
  const MAX_MINUTES = 999 * 60;
  const MAX_NUMBER_TEXT = 30; // длиннее — точно опечатка

  const MONEY_ERROR = "Не понял сумму. Напиши числом, например: 5000, 1500.50 или 5к";
  const TIME_ERROR = "Не понял время. Можно так: 2 (часа), 1.5, 2:30, 40м, 1ч 20м";
  const DATE_ERROR = "Не понял дату. Напиши так: 23, 23.10, 23.10.2026 или «вчера»";
  const FUTURE_DATE_ERROR = "Не понял день. Напиши: завтра, пятница, 27 или 27.10";
  const CLOCK_ERROR = "Не понял время. Напиши так: 10, 10:00 или 14.30";
  const NO_SUCH_DATE = "Такой даты нет — проверь число и месяц.";
  const QUICK_HINT = "Для быстрой записи нужно три числа: сумма, запчасти, время. Например: 5000 1200 2:30 Yamaha R6 цепь";
  const IMPORT_FORMAT_HINT = "В файле не нашёл таблицу с ремонтами. Нужна строка с заголовками «Дата» и «Общая сумма» " +
    "(и по желанию «Что ремонтировал», «Запчасти», «Время»). Проще всего взять пустой шаблон или файл, который выгрузил сайт.";

  class InputError extends Error {}

  // ------------------------------------------------------------ даты
  // Дни храним строкой «ГГГГ-ММ-ДД» в местном времени — так нет путаницы с часовыми поясами.

  const pad = (n) => String(n).padStart(2, "0");
  const isoDay = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const toIso = (date) => isoDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
  function fromIso(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const todayIso = () => toIso(new Date());
  function addDays(iso, n) {
    const d = fromIso(iso);
    d.setDate(d.getDate() + n);
    return toIso(d);
  }
  const weekdayOf = (iso) => (fromIso(iso).getDay() + 6) % 7; // 0 — понедельник
  function validDate(y, m, d) {
    if (!(y >= 1900 && y <= 2200) || m < 1 || m > 12 || d < 1) return false;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  function shiftMonth(y, m, delta) {
    const index = y * 12 + (m - 1) + delta;
    return [Math.floor(index / 12), (index % 12 + 12) % 12 + 1];
  }
  const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
  const monthOf = (iso) => iso.slice(0, 7);

  // ------------------------------------------------------------ разбор ввода

  const MONEY_RE = /^(\d+(?:[.,]\d+)?)(к|k|тыс|т)?\.?(р|руб|рублей|рубля|rub|₽)?\.?$/;
  const HOURS = "(?:часов|часа|час|ч|h)";
  const MINS = "(?:минуты|минута|минут|мин|м|min|m)";
  const CLOCK_RE = /^(\d{1,3}):(\d{1,2})$/;
  const DOT_CLOCK_RE = /^(\d{1,3})\.(\d{2})$/;
  const NUMBER_RE = /^\d+(?:\.\d+)?$/;
  const WITH_HOURS_RE = new RegExp(`^(\\d+(?:\\.\\d+)?)${HOURS}\\.?(?:(\\d+)${MINS}?\\.?)?$`);
  const ONLY_MINUTES_RE = new RegExp(`^(\\d+)${MINS}\\.?$`);
  const TIME_TAIL_RE = new RegExp(`^\\d*(?:${HOURS}|${MINS})\\.?$`);
  const UNIT_MINUTES_RE = new RegExp(`^${MINS}\\.?$`);
  const DATE_RE = /^(\d{1,2})(?:[./-](\d{1,2})(?:[./-](\d{4}|\d{2}))?)?$/;
  const DATE_TOKEN_RE = /^\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?$/;
  const CLOCK_TEXT_RE = /^(\d{1,2})(?:[:.\-\s](\d{2}))?$/;
  const ZERO_WORDS = new Set(["-", "—", "нет", "без", "ноль"]);
  const WEEKDAY_NAMES = new Map(Object.entries({
    "пн": 0, "понедельник": 0, "вт": 1, "вторник": 1, "ср": 2, "среда": 2, "среду": 2,
    "чт": 3, "четверг": 3, "пт": 4, "пятница": 4, "пятницу": 4,
    "сб": 5, "суббота": 5, "субботу": 5, "вс": 6, "воскресенье": 6,
  }));

  function checkMoney(value) {
    if (!Number.isFinite(value) || value < 0) throw new InputError(MONEY_ERROR);
    if (value > MAX_MONEY) throw new InputError("Слишком большая сумма — проверь, нет ли лишних нулей.");
    return Math.round(value * 100) / 100;
  }

  function checkMinutes(value) {
    if (!Number.isFinite(value) || value < 0) throw new InputError(TIME_ERROR);
    if (value > MAX_MINUTES) throw new InputError("Слишком много времени — проверь ввод.");
    return Math.round(value);
  }

  function parseMoney(text) {
    const s = String(text).toLowerCase().replace(/\s+/g, "");
    if (ZERO_WORDS.has(s)) return 0;
    const m = s.length <= MAX_NUMBER_TEXT ? MONEY_RE.exec(s) : null;
    if (!m) throw new InputError(MONEY_ERROR);
    let value = parseFloat(m[1].replace(",", "."));
    if (m[2]) value *= 1000;
    return checkMoney(value);
  }

  /** Время ремонта в минутах. Голое число — часы; 2:30 и 2.30 — часы и минуты. */
  function parseMinutes(text) {
    const s = String(text).toLowerCase().replace(/\s+/g, "").replace(/,/g, ".");
    if (s.length > MAX_NUMBER_TEXT) throw new InputError(TIME_ERROR);
    let m = CLOCK_RE.exec(s) || DOT_CLOCK_RE.exec(s);
    let minutes;
    if (m && Number(m[2]) < 60) minutes = Number(m[1]) * 60 + Number(m[2]);
    else if (m && s.includes(":")) throw new InputError("В часе 60 минут — проверь время.");
    else if (NUMBER_RE.test(s)) minutes = Math.round(parseFloat(s) * 60);
    else if ((m = WITH_HOURS_RE.exec(s))) minutes = Math.round(parseFloat(m[1]) * 60) + Number(m[2] || 0);
    else if ((m = ONLY_MINUTES_RE.exec(s))) minutes = Number(m[1]);
    else throw new InputError(TIME_ERROR);
    return checkMinutes(minutes);
  }

  /** Дата ремонта. Без месяца или года берётся ближайшая прошедшая такая дата. */
  function parseDay(text, today) {
    const s = String(text).trim().toLowerCase();
    const relative = new Map([["сегодня", 0], ["вчера", 1], ["позавчера", 2]]);
    if (relative.has(s)) return addDays(today, -relative.get(s));
    const m = DATE_RE.exec(s);
    if (!m) throw new InputError(DATE_ERROR);
    const t = fromIso(today);
    const day = Number(m[1]);
    let month = m[2] ? Number(m[2]) : t.getMonth() + 1;
    let year = m[3] ? Number(m[3]) : t.getFullYear();
    if (year < 100) year += 2000;
    if (!validDate(year, month, day)) throw new InputError(NO_SUCH_DATE);
    let result = isoDay(year, month, day);
    if (!m[2] && result > today) {
      [year, month] = shiftMonth(year, month, -1);
      if (!validDate(year, month, day)) throw new InputError(NO_SUCH_DATE);
      result = isoDay(year, month, day);
    } else if (m[2] && !m[3] && result > today) {
      if (!validDate(year - 1, month, day)) throw new InputError(NO_SUCH_DATE);
      result = isoDay(year - 1, month, day);
    }
    return result;
  }

  /** День записи клиента. Без месяца или года берётся ближайшая будущая такая дата. */
  function parseFutureDay(text, today) {
    let s = String(text).trim().toLowerCase().replace(/^(?:в|во)\s+/, "");
    const relative = new Map([["сегодня", 0], ["завтра", 1], ["послезавтра", 2]]);
    if (relative.has(s)) return addDays(today, relative.get(s));
    if (WEEKDAY_NAMES.has(s)) return addDays(today, (WEEKDAY_NAMES.get(s) - weekdayOf(today) + 7) % 7);
    const tokens = s.split(/\s+/);
    if (tokens.length === 2 && WEEKDAY_NAMES.has(tokens[0].replace(/,$/, ""))) s = tokens[1]; // «Пн 27.10»
    const m = DATE_RE.exec(s);
    if (!m) throw new InputError(FUTURE_DATE_ERROR);
    const t = fromIso(today);
    const day = Number(m[1]);
    let month = m[2] ? Number(m[2]) : t.getMonth() + 1;
    let year = m[3] ? Number(m[3]) : t.getFullYear();
    if (year < 100) year += 2000;
    if (!validDate(year, month, day)) throw new InputError(NO_SUCH_DATE);
    let result = isoDay(year, month, day);
    if (result < today && !m[3]) {
      if (m[2]) year += 1;
      else [year, month] = shiftMonth(year, month, 1);
      if (!validDate(year, month, day)) throw new InputError(NO_SUCH_DATE);
      result = isoDay(year, month, day);
    }
    if (result < today) throw new InputError("Эта дата уже прошла — напиши будущую.");
    return result;
  }

  /** Время записи клиента: «10», «10:00», «14.30» → «10:00». */
  function parseClock(text) {
    const s = String(text).trim().toLowerCase().replace(/^(?:в|к)\s*/, "");
    const m = CLOCK_TEXT_RE.exec(s);
    if (!m || Number(m[1]) > 23 || Number(m[2] || 0) > 59) throw new InputError(CLOCK_ERROR);
    return `${pad(Number(m[1]))}:${pad(Number(m[2] || 0))}`;
  }

  /** Быстрая запись одной строкой: «[дата] сумма запчасти время [что делал]». null — строка не похожа на запись. */
  function parseQuick(text, today) {
    const tokens = String(text).trim().split(/\s+/).filter(Boolean);
    let day = today;
    if (tokens.length && DATE_TOKEN_RE.test(tokens[0])) day = parseDay(tokens.shift(), today);
    if (!tokens.length) return null;
    let total;
    try {
      total = parseMoney(tokens[0]);
    } catch (e) {
      if (e instanceof InputError) return null;
      throw e;
    }
    if (tokens.length < 3) throw new InputError(QUICK_HINT);
    let parts;
    try {
      parts = parseMoney(tokens[1]);
    } catch (e) {
      throw new InputError(`Не понял, сколько ушло на запчасти: «${tokens[1]}». ${QUICK_HINT}`);
    }
    // Время может быть записано через пробел: «1ч 30м», «2 ч», «1 ч 30 мин».
    const timeTokens = [tokens[2]];
    const rest = tokens.slice(3);
    while (rest.length && timeTokens.length < 4) {
      const word = rest[0].toLowerCase();
      const unitFollows = rest.length > 1 && UNIT_MINUTES_RE.test(rest[1].toLowerCase());
      if (TIME_TAIL_RE.test(word) || (/^\d+$/.test(word) && unitFollows)) timeTokens.push(rest.shift());
      else break;
    }
    const minutes = parseMinutes(timeTokens.join(""));
    return { day, title: rest.join(" ").slice(0, 200), total, parts, minutes };
  }

  // ------------------------------------------------------------ форматирование

  function groupDigits(n) {
    const sign = n < 0 ? "-" : "";
    return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  }

  function fmtNum(value) {
    const rounded = Math.round(value);
    if (Math.abs(value - rounded) < 0.005) return groupDigits(rounded === 0 ? 0 : rounded);
    const [int, frac] = Math.abs(value).toFixed(2).split(".");
    return (value < 0 ? "-" : "") + groupDigits(Number(int)) + "," + frac;
  }

  const rub = (value) => `${fmtNum(value)}${NBSP}₽`;

  function fmtDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return `${h}${NBSP}ч ${m}${NBSP}мин`;
    if (h) return `${h}${NBSP}ч`;
    return `${m}${NBSP}мин`;
  }

  const fmtHm = (minutes) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;
  function fmtDate(iso) {
    const d = fromIso(iso);
    return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}, ${WEEKDAYS[weekdayOf(iso)]}`;
  }
  function fmtDayShort(iso) {
    const d = fromIso(iso);
    const wd = WEEKDAYS[weekdayOf(iso)];
    return `${wd[0].toUpperCase()}${wd.slice(1)}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  }
  function fmtButtonDay(iso) {
    const wd = WEEKDAYS[weekdayOf(iso)];
    return `${wd[0].toUpperCase()}${wd.slice(1)} ${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  }
  const fmtShortDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  const monthName = (m) => MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1);
  const monthTitle = (y, m) => `${monthName(m)} ${y}`;
  const titleOrDefault = (title) => title || "Ремонт";

  /** «1 ремонт», «3 ремонта», «5 ремонтов». */
  function plural(n, [one, few, many]) {
    const tens = n % 100;
    const units = n % 10;
    const word = tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
    return `${n} ${word}`;
  }
  const REPAIRS_WORDS = ["ремонт", "ремонта", "ремонтов"];
  const BOOKINGS_WORDS = ["запись клиента", "записи клиентов", "записей клиентов"];

  // ------------------------------------------------------------ расчёты

  function totals(repairs) {
    const t = { count: 0, total: 0, parts: 0, minutes: 0 };
    for (const r of repairs) {
      t.count += 1;
      t.total += r.total;
      t.parts += r.parts;
      t.minutes += r.minutes;
    }
    t.net = t.total - t.parts;
    return t;
  }

  const perHour = (net, minutes) => (minutes ? net / (minutes / 60) : null);

  const byDayThenId = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id - b.id);

  function sortBookings(list) {
    return [...list].sort((a, b) => {
      if (a.day !== b.day) return a.day < b.day ? -1 : 1;
      if (!a.clock !== !b.clock) return a.clock ? -1 : 1; // без времени — в конце дня
      if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
      return a.id - b.id;
    });
  }

  function groupByDay(items) {
    const groups = [];
    for (const item of items) {
      const last = groups[groups.length - 1];
      if (last && last.day === item.day) last.items.push(item);
      else groups.push({ day: item.day, items: [item] });
    }
    return groups;
  }

  /** Разбивка месяца по дням: для каждого числа — итоги или null, если ремонтов не было. */
  function monthByDays(repairs, y, m) {
    const prefix = `${y}-${pad(m)}-`;
    const days = [];
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      const iso = prefix + pad(d);
      const items = repairs.filter((r) => r.day === iso);
      days.push({ day: iso, totals: items.length ? totals(items) : null, items });
    }
    return days;
  }

  /** Ремонты из файла, которых ещё нет в учёте (дубли пропускаются, даже если повторяются). */
  function newRowsOnly(existing, rows) {
    const key = (r) => [r.day, titleOrDefault(r.title), Math.round(r.total * 100), Math.round(r.parts * 100), r.minutes].join("|");
    const counts = new Map();
    for (const r of existing) counts.set(key(r), (counts.get(key(r)) || 0) + 1);
    const fresh = [];
    for (const row of rows) {
      const k = key(row);
      if (counts.get(k)) counts.set(k, counts.get(k) - 1);
      else fresh.push(row);
    }
    return { fresh, skipped: rows.length - fresh.length };
  }

  // ------------------------------------------------------------ разбор таблицы Excel
  // Ячейка: { kind: "number" | "string" | "bool" | "empty", value, dateFormat } — её готовит excel.js.

  const HEADER_RULES = [ // порядок важен: «Сумма запчастей» — это запчасти, а не сумма
    ["day", (h) => h.startsWith("дата") || h === "число"],
    ["parts", (h) => h.includes("запчаст") || h.includes("детал") || h.includes("расход")],
    ["total", (h) => ["сумма", "цена", "стоимость", "оплата", "взял"].some((w) => h.includes(w)) && !h.includes("чист")],
    ["minutes", (h) => h.startsWith("время") || ["часы", "часов", "ч"].includes(h)],
    ["title", (h) => h.startsWith("что") || ["описан", "работ", "название", "наименован"].some((w) => h.includes(w)) ||
      ["ремонт", "техника", "мото", "клиент"].includes(h)],
  ];

  function findHeader(grid) {
    for (let index = 0; index < Math.min(grid.length, 20); index++) {
      const columns = {};
      grid[index].forEach((cell, col) => {
        if (!cell || cell.kind !== "string") return;
        const header = cell.value.trim().toLowerCase();
        for (const [field, matches] of HEADER_RULES) {
          if (!(field in columns) && matches(header)) {
            columns[field] = col;
            break;
          }
        }
      });
      if ("day" in columns && "total" in columns) return { index, columns };
    }
    return null;
  }

  function serialToIso(serial) { // номер дня Excel → дата
    const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
    const d = new Date(ms);
    return isoDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  function cellDay(cell, today) {
    let result;
    if (cell.kind === "number" && cell.value > 20000 && cell.value < 80000) {
      result = serialToIso(cell.value);
    } else if (cell.kind === "string" && cell.value.trim()) {
      const s = cell.value.trim();
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      const m = DATE_RE.exec(s);
      if (iso && validDate(+iso[1], +iso[2], +iso[3])) result = isoDay(+iso[1], +iso[2], +iso[3]);
      else if (m && m[2]) {
        let year = m[3] ? Number(m[3]) : fromIso(today).getFullYear();
        if (year < 100) year += 2000;
        if (!validDate(year, Number(m[2]), Number(m[1]))) throw new InputError("дата");
        result = isoDay(year, Number(m[2]), Number(m[1]));
      } else throw new InputError("дата");
    } else throw new InputError("дата");
    const year = Number(result.slice(0, 4));
    if (year < 2000 || year > 2100) throw new InputError("дата");
    return result;
  }

  function cellMoney(cell, required) {
    if (cell.kind === "empty" || (cell.kind === "string" && !cell.value.trim())) {
      if (required) throw new InputError("сумма");
      return 0;
    }
    if (cell.kind === "number") return checkMoney(cell.value);
    if (cell.kind === "string") return parseMoney(cell.value);
    throw new InputError("сумма");
  }

  function cellMinutes(cell) {
    if (cell.kind === "empty" || (cell.kind === "string" && !cell.value.trim())) return 0;
    if (cell.kind === "number") return checkMinutes(cell.value * (cell.dateFormat ? 1440 : 60));
    if (cell.kind === "string") return parseMinutes(cell.value);
    throw new InputError("время");
  }

  /** Ремонты из таблицы: { rows, badRows } — badRows — номера строк Excel, которые не удалось разобрать. */
  function rowsFromGrid(grid, today) {
    const found = findHeader(grid);
    if (!found) throw new InputError(IMPORT_FORMAT_HINT);
    const { index, columns } = found;
    const empty = { kind: "empty" };
    const rows = [];
    const badRows = [];
    for (let i = index + 1; i < grid.length; i++) {
      const row = grid[i] || [];
      const cell = (field) => (field in columns && row[columns[field]]) || empty;
      const filled = row.filter((c) => c && c.kind !== "empty" && String(c.value).trim());
      if (!filled.length) continue;
      if (/^(итого|всего)/i.test(String(filled[0].value).trim())) continue;
      try {
        const title = cell("title").kind === "empty" ? "" : String(cell("title").value).trim().slice(0, 200);
        rows.push({
          day: cellDay(cell("day"), today),
          title,
          total: cellMoney(cell("total"), true),
          parts: cellMoney(cell("parts"), false),
          minutes: cellMinutes(cell("minutes")),
        });
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        badRows.push(i + 1);
      }
    }
    return { rows, badRows };
  }

  // ------------------------------------------------------------ календарь (.ics)
  // Напоминания о записях берёт на себя календарь телефона — он работает и без интернета, и без сайта.

  function icsText(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }

  function foldLine(line) { // строки в .ics не длиннее 75 байт
    const encoder = new TextEncoder();
    const out = [];
    let current = "";
    let bytes = 0;
    for (const ch of line) {
      const size = encoder.encode(ch).length;
      if (bytes + size > 73) {
        out.push(current);
        current = " ";
        bytes = 1;
      }
      current += ch;
      bytes += size;
    }
    out.push(current);
    return out.join("\r\n");
  }

  function makeIcs(bookings, now = new Date()) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//moto-uchet//RU", "CALSCALE:GREGORIAN"];
    for (const b of bookings) {
      const day = b.day.replace(/-/g, "");
      lines.push("BEGIN:VEVENT", `UID:booking-${b.id}-${b.created || day}@moto-uchet`, `DTSTAMP:${stamp}`);
      if (b.clock) {
        lines.push(`DTSTART:${day}T${b.clock.replace(":", "")}00`, "DURATION:PT1H");
      } else {
        lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${addDays(b.day, 1).replace(/-/g, "")}`);
      }
      lines.push(`SUMMARY:${icsText("🏍 " + b.text)}`, "BEGIN:VALARM", "ACTION:DISPLAY",
        `DESCRIPTION:${icsText("Запись: " + b.text)}`,
        b.clock ? "TRIGGER:-PT1H" : "TRIGGER:PT9H", // за час до записи; без времени — в 9 утра
        "END:VALARM", "END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }

  const api = {
    MONTHS, MONTHS_GEN, WEEKDAYS, NBSP, MAX_MONEY, MAX_MINUTES, QUICK_HINT,
    InputError, pad, isoDay, toIso, fromIso, todayIso, addDays, weekdayOf, validDate, shiftMonth, daysInMonth, monthOf,
    parseMoney, parseMinutes, parseDay, parseFutureDay, parseClock, parseQuick,
    fmtNum, rub, fmtDuration, fmtHm, fmtDate, fmtDayShort, fmtButtonDay, fmtShortDate, monthName, monthTitle,
    titleOrDefault, plural, REPAIRS_WORDS, BOOKINGS_WORDS, totals, perHour, byDayThenId, sortBookings, groupByDay, monthByDays, newRowsOnly,
    findHeader, rowsFromGrid, serialToIso, makeIcs,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Core = api;
})(typeof self !== "undefined" ? self : this);
