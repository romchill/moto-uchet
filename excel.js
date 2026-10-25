/* Выгрузка и загрузка Excel. Библиотека SheetJS лежит рядом (vendor/) и грузится, только когда нужна. */
(function (root) {
  "use strict";

  const C = typeof module !== "undefined" && module.exports ? require("./core.js") : root.Core;
  const XLSX_SRC = "vendor/xlsx.full.min.js";
  const TEMPLATE_FILENAME = "Шаблон_для_загрузки.xlsx";
  const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const MONEY_FMT = '#,##0 "₽"';
  const DATE_FMT = "DD.MM.YYYY";
  const TIME_FMT = "[h]:mm";
  const MAX_ROWS = 10000;
  const MAX_COLUMNS = 50;

  let loading = null;
  function loadXlsx() {
    if (root.XLSX) return Promise.resolve(root.XLSX);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = XLSX_SRC;
        script.onload = () => (root.XLSX ? resolve(root.XLSX) : reject(new Error("SheetJS не загрузился")));
        script.onerror = () => {
          loading = null;
          reject(new C.InputError("Не получилось загрузить модуль Excel — проверь интернет и попробуй ещё раз."));
        };
        document.head.append(script);
      });
    }
    return loading;
  }

  const monthFilename = (y, m) => `Учет_ремонтов_${y}_${C.pad(m)}.xlsx`;
  const serial = (iso) => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000;

  function cell(value, format) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return format ? { t: "n", v: value, z: format } : { t: "n", v: value };
    return { t: "s", v: String(value) }; // строки — всегда текст, «=…» не станет формулой
  }

  function sheetFrom(XLSX, rows, widths) {
    const ws = {};
    let maxCol = 0;
    rows.forEach((row, r) => row.forEach((value, c) => {
      const isCell = value && typeof value === "object";
      const content = isCell ? value : cell(value);
      if (!content) return;
      ws[XLSX.utils.encode_cell({ r, c })] = content;
      maxCol = Math.max(maxCol, c);
    }));
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: maxCol } });
    ws["!cols"] = widths.map((wch) => ({ wch }));
    return ws;
  }

  function moneyCells(t) {
    const hourly = C.perHour(t.net, t.minutes);
    return [cell(t.total, MONEY_FMT), cell(t.parts, MONEY_FMT), cell(t.net, MONEY_FMT),
      cell(t.minutes / 1440, TIME_FMT), hourly === null ? null : cell(Math.round(hourly), MONEY_FMT)];
  }

  /** Таблица учёта за месяц: лист «По дням» (все числа месяца) и лист «Ремонты». */
  function buildMonthBook(XLSX, repairs, y, m) {
    const title = `Учёт ремонтов — ${C.monthTitle(y, m)}`;
    const total = C.totals(repairs);
    const wb = XLSX.utils.book_new();

    const dayRows = [[title], [], ["Дата", "День", "Ремонтов", "Общая сумма", "Запчасти", "Чистый доход", "Время", "Доход в час"]];
    for (const d of C.monthByDays(repairs, y, m)) {
      const row = [cell(serial(d.day), DATE_FMT), C.WEEKDAYS[C.weekdayOf(d.day)]];
      dayRows.push(d.totals ? [...row, d.totals.count, ...moneyCells(d.totals)] : row);
    }
    dayRows.push(["ИТОГО", null, total.count, ...moneyCells(total)]);
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, dayRows, [12, 6, 10, 14, 13, 15, 10, 13]), "По дням");

    const repairRows = [[title], [], ["№", "Дата", "Что ремонтировал", "Общая сумма", "Запчасти", "Чистый доход", "Время", "Доход в час"]];
    repairs.forEach((r, i) => repairRows.push([i + 1, cell(serial(r.day), DATE_FMT), C.titleOrDefault(r.title),
      ...moneyCells(C.totals([r]))]));
    repairRows.push([null, "ИТОГО", `${total.count} рем.`, ...moneyCells(total)]);
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, repairRows, [5, 12, 36, 14, 13, 15, 10, 13]), "Ремонты");
    return wb;
  }

  function buildTemplateBook(XLSX) {
    const wb = XLSX.utils.book_new();
    const rows = [
      ["Заполни строки ниже и загрузи файл на сайт: «Ещё» → «Загрузить из Excel»"],
      ["Дата — 23.10.2026 · Время — 2:30 или 2.5 (часа) · Если запчастей не было — оставь пустым"],
      ["Дата", "Что ремонтировал", "Общая сумма", "Запчасти", "Время"],
    ];
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, rows, [12, 36, 14, 13, 10]), "Ремонты");
    return wb;
  }

  function toCell(XLSX, c) {
    if (!c || c.v === undefined || c.v === null || c.t === "z" || c.t === "e") return { kind: "empty" };
    if (c.t === "n") return { kind: "number", value: c.v, dateFormat: Boolean(c.z) && XLSX.SSF.is_date(c.z) };
    if (c.t === "b") return { kind: "bool", value: c.v };
    if (c.t === "d") { // на всякий случай: дата, уже превращённая в объект
      const d = c.v instanceof Date ? c.v : new Date(c.v);
      return { kind: "string", value: C.toIso(d) };
    }
    return { kind: "string", value: String(c.v) };
  }

  /** Лист Excel → сетка ячеек для core.rowsFromGrid (строка 0 сетки — первая строка листа). */
  function gridFromSheet(XLSX, ws) {
    if (!ws || !ws["!ref"]) return [];
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const lastRow = Math.min(range.e.r, MAX_ROWS);
    const lastCol = Math.min(range.e.c, MAX_COLUMNS);
    const grid = [];
    for (let r = 0; r <= lastRow; r++) {
      const row = [];
      for (let c = 0; c <= lastCol; c++) row.push(toCell(XLSX, ws[XLSX.utils.encode_cell({ r, c })]));
      grid.push(row);
    }
    return grid;
  }

  /** Ремонты из книги Excel: сначала лист «Ремонты», потом первый лист, где нашлись заголовки. */
  function rowsFromBook(XLSX, wb, today) {
    const names = [...wb.SheetNames].sort((a, b) =>
      (a.trim().toLowerCase() === "ремонты" ? 0 : 1) - (b.trim().toLowerCase() === "ремонты" ? 0 : 1));
    for (const name of names) {
      const grid = gridFromSheet(XLSX, wb.Sheets[name]);
      if (C.findHeader(grid)) return C.rowsFromGrid(grid, today);
    }
    return C.rowsFromGrid([], today); // выбросит понятную подсказку про заголовки
  }

  /** CSV из русского Excel обычно в кодировке Windows-1251 и с «;» вместо запятых. */
  function decodeCsv(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      text = new TextDecoder("windows-1251").decode(bytes);
    }
    text = text.replace(/^﻿/, "");
    const firstLine = text.split(/\r?\n/, 1)[0];
    const count = (ch) => firstLine.split(ch).length - 1;
    const separator = [";", "\t", ","].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ",");
    return { text, separator };
  }

  function readBook(XLSX, buffer, filename = "") {
    const options = { cellNF: true, cellDates: false, sheetRows: MAX_ROWS + 1 };
    try {
      if (/\.(csv|txt)$/i.test(filename)) {
        const { text, separator } = decodeCsv(buffer);
        return XLSX.read(text, { ...options, type: "string", FS: separator, raw: false });
      }
      return XLSX.read(buffer, { ...options, type: "array" });
    } catch (e) {
      throw new C.InputError("Не получилось открыть файл. Нужна таблица Excel (.xlsx или .xls) или CSV.");
    }
  }

  const toBlob = (XLSX, wb) => new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: XLSX_TYPE });

  const api = {
    TEMPLATE_FILENAME, monthFilename, buildMonthBook, buildTemplateBook, gridFromSheet, rowsFromBook, readBook,
    async exportMonth(repairs, y, m) {
      const XLSX = await loadXlsx();
      return toBlob(XLSX, buildMonthBook(XLSX, repairs, y, m));
    },
    async template() {
      const XLSX = await loadXlsx();
      return toBlob(XLSX, buildTemplateBook(XLSX));
    },
    async importFile(file, today) {
      const XLSX = await loadXlsx();
      return rowsFromBook(XLSX, readBook(XLSX, await file.arrayBuffer(), file.name), today);
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ExcelIO = api;
})(typeof self !== "undefined" ? self : this);
