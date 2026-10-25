/* Интерфейс учёта ремонтов. Данные хранятся в браузере (localStorage) — только на этом устройстве. */
(function () {
  "use strict";

  const C = window.Core;
  const STORAGE_KEY = "moto-uchet:v1";
  const BACKUP_REMIND_DAYS = 14;
  const PAST_BOOKINGS_DAYS = 30;
  const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024;

  const $ = (selector) => document.querySelector(selector);
  const field = (form, name) => form.elements.namedItem(name);

  // ------------------------------------------------------------ данные

  let storageOk = true;

  const emptyData = () => ({ version: 1, nextId: 1, repairs: [], bookings: [], lastBackup: "" });
  const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    C.validDate(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)));
  const isMoney = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= C.MAX_MONEY;
  const isMinutes = (v) => Number.isInteger(v) && v >= 0 && v <= C.MAX_MINUTES;
  const isClock = (s) => s === "" || (typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s));

  /** Проверяет данные (из памяти браузера или из резервной копии) и отбрасывает испорченные записи. */
  function normalize(raw) {
    const data = emptyData();
    if (!raw || typeof raw !== "object") return data;
    let maxId = 0;
    const repairIds = new Set();
    for (const r of Array.isArray(raw.repairs) ? raw.repairs : []) {
      if (!r || !Number.isInteger(r.id) || repairIds.has(r.id) || !isDay(r.day) || !isMoney(r.total) ||
        !isMoney(r.parts) || !isMinutes(r.minutes)) continue;
      repairIds.add(r.id);
      data.repairs.push({ id: r.id, day: r.day, title: String(r.title || "").slice(0, 200), total: r.total,
        parts: r.parts, minutes: r.minutes, created: String(r.created || "") });
      maxId = Math.max(maxId, r.id);
    }
    const bookingIds = new Set();
    for (const b of Array.isArray(raw.bookings) ? raw.bookings : []) {
      const text = b && typeof b.text === "string" ? b.text.trim().slice(0, 300) : "";
      if (!b || !Number.isInteger(b.id) || bookingIds.has(b.id) || !isDay(b.day) || !isClock(b.clock) || !text) continue;
      bookingIds.add(b.id);
      data.bookings.push({ id: b.id, day: b.day, clock: b.clock, text, created: String(b.created || "") });
      maxId = Math.max(maxId, b.id);
    }
    data.nextId = Math.max(maxId + 1, Number.isInteger(raw.nextId) ? raw.nextId : 1);
    data.lastBackup = isDay(raw.lastBackup) ? raw.lastBackup : "";
    return data;
  }

  function load() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageOk = false; // браузер запрещает хранить данные (например, частный режим)
      return emptyData();
    }
    if (!raw) return emptyData();
    try {
      return normalize(JSON.parse(raw));
    } catch (e) {
      // Испорченные данные не затираем, а откладываем в сторону — их можно будет достать.
      try { localStorage.setItem(`${STORAGE_KEY}:broken:${Date.now()}`, raw); } catch (e2) { /* места нет */ }
      return emptyData();
    }
  }

  let data = load();
  let persistAsked = false;

  function save() {
    if (!storageOk) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      toast("Не получилось сохранить — память браузера переполнена. Сохрани резервную копию в «Ещё».", true);
      return false;
    }
    if (!persistAsked && navigator.storage && navigator.storage.persist) {
      persistAsked = true; // просим браузер не удалять наши данные при нехватке места
      navigator.storage.persist().catch(() => {});
    }
    return true;
  }

  const stamp = () => new Date().toISOString();

  function addRepair(fields) {
    const repair = { id: data.nextId++, created: stamp(), ...fields };
    data.repairs.push(repair);
    save();
    return repair;
  }

  function addRepairs(rows) {
    for (const row of rows) data.repairs.push({ id: data.nextId++, created: stamp(), ...row });
    save();
  }

  function updateRepair(id, fields) {
    const repair = data.repairs.find((r) => r.id === id);
    if (repair) Object.assign(repair, fields);
    save();
    return repair;
  }

  function deleteRepair(id) {
    data.repairs = data.repairs.filter((r) => r.id !== id);
    save();
  }

  const repairsBetween = (start, end) => data.repairs.filter((r) => r.day >= start && r.day < end).sort(C.byDayThenId);
  const repairsOfDay = (day) => repairsBetween(day, C.addDays(day, 1));
  function repairsOfMonth(y, m) {
    const [ny, nm] = C.shiftMonth(y, m, 1);
    return repairsBetween(C.isoDay(y, m, 1), C.isoDay(ny, nm, 1));
  }

  function addBooking(fields) {
    const booking = { id: data.nextId++, created: stamp(), ...fields };
    data.bookings.push(booking);
    save();
    return booking;
  }

  function updateBooking(id, fields) {
    const booking = data.bookings.find((b) => b.id === id);
    if (booking) Object.assign(booking, fields);
    save();
    return booking;
  }

  function deleteBooking(id) {
    data.bookings = data.bookings.filter((b) => b.id !== id);
    save();
  }

  const bookingsBetween = (start, end) => C.sortBookings(data.bookings.filter((b) => b.day >= start && b.day < end));

  // ------------------------------------------------------------ мелочи интерфейса

  /** Создаёт элемент. Текст всегда вставляется как текст, а не как HTML — чужой ввод не исполнится. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") el.className = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else if (key === "value") el.value = value;
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const card = (attrs, ...children) => h("section", { ...attrs, class: "card" + (attrs && attrs.class ? " " + attrs.class : "") }, ...children);

  let toastTimer = null;
  function toast(text, bad = false) {
    const el = $("#toast");
    el.textContent = text;
    el.className = "show" + (bad ? " bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ""; }, bad ? 7000 : 3500);
  }

  function confirmBox(text, yesLabel = "Да") {
    return new Promise((resolve) => {
      const dialog = $("#confirmDialog");
      $("#confirmText").textContent = text;
      $("#confirmYes").textContent = yesLabel;
      dialog.returnValue = "";
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true });
      dialog.showModal();
    });
  }

  function downloadFile(content, filename, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = h("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = $("#fileInput");
      input.value = "";
      input.accept = accept;
      input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
      input.click();
    });
  }

  /** Запускает действие и показывает человеку понятную ошибку, а не молчит. */
  async function safely(action) {
    try {
      await action();
    } catch (e) {
      console.error(e);
      toast(e instanceof C.InputError ? e.message : "Что-то пошло не так. Попробуй ещё раз.", true);
    }
  }

  // ------------------------------------------------------------ ремонт: форма-калькулятор

  const repairDialog = $("#repairDialog");
  const repairForm = $("#repairForm");
  let repairContext = {};

  function openRepair(context = {}, preset = {}) {
    repairContext = context;
    const repair = context.id ? data.repairs.find((r) => r.id === context.id) : null;
    $("#repairHeading").textContent = repair ? "Изменить ремонт" : "Новый ремонт";
    field(repairForm, "title").value = repair ? repair.title : preset.title || "";
    field(repairForm, "total").value = repair ? String(repair.total) : "";
    field(repairForm, "parts").value = repair && repair.parts ? String(repair.parts) : "";
    field(repairForm, "time").value = repair && repair.minutes ? C.fmtHm(repair.minutes) : "";
    field(repairForm, "day").value = repair ? repair.day : preset.day || C.todayIso();
    $("#repairDelete").hidden = !repair;
    $("#repairError").textContent = "";
    updateCalc();
    repairDialog.showModal();
    (preset.title ? field(repairForm, "total") : field(repairForm, "title")).focus();
  }

  function readRepairForm() {
    const totalText = field(repairForm, "total").value.trim();
    if (!totalText) throw new C.InputError("Напиши общую сумму — сколько взял за ремонт.");
    const partsText = field(repairForm, "parts").value.trim();
    const timeText = field(repairForm, "time").value.trim();
    const day = field(repairForm, "day").value;
    if (!isDay(day)) throw new C.InputError("Выбери дату ремонта.");
    return {
      day,
      title: field(repairForm, "title").value.trim().slice(0, 200),
      total: C.parseMoney(totalText),
      parts: partsText ? C.parseMoney(partsText) : 0,
      minutes: timeText ? C.parseMinutes(timeText) : 0,
    };
  }

  function updateCalc() {
    const box = $("#repairCalc");
    let r;
    try {
      r = readRepairForm();
    } catch (e) {
      box.replaceChildren();
      return;
    }
    const net = r.total - r.parts;
    const hourly = C.perHour(net, r.minutes);
    box.replaceChildren(...[
      h("div", { class: "line" }, h("span", {}, "Чистый доход"), h("span", { class: "big" + (net < 0 ? " neg" : "") }, C.rub(net))),
      hourly !== null ? h("div", { class: "line muted" }, h("span", {}, `За ${C.fmtDuration(r.minutes)}`),
        h("span", {}, `${C.rub(Math.round(hourly))} в час`)) : null,
      net < 0 ? h("div", { class: "line", style: "color: var(--bad)" }, "⚠️ Запчасти дороже суммы — ремонт в минус.") : null,
    ].filter(Boolean));
  }

  repairForm.addEventListener("input", updateCalc);
  repairForm.querySelector('.chips[data-target="time"]').addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    field(repairForm, "time").value = e.target.textContent;
    updateCalc();
  });

  repairForm.addEventListener("submit", (e) => {
    e.preventDefault();
    let fields;
    try {
      fields = readRepairForm();
    } catch (err) {
      if (!(err instanceof C.InputError)) throw err;
      $("#repairError").textContent = err.message;
      return;
    }
    if (repairContext.id) {
      updateRepair(repairContext.id, fields);
      toast("✅ Сохранил");
    } else {
      addRepair(fields);
      if (repairContext.bookingId) deleteBooking(repairContext.bookingId);
      toast(`✅ Записал: чистыми ${C.rub(fields.total - fields.parts)}` + (repairContext.bookingId ? ". Запись клиента закрыта." : ""));
    }
    repairDialog.close();
    render();
  });

  $("#repairDelete").addEventListener("click", async () => {
    const repair = data.repairs.find((r) => r.id === repairContext.id);
    if (!repair) return;
    repairDialog.close();
    if (await confirmBox(`Удалить ремонт «${C.titleOrDefault(repair.title)}» за ${C.fmtShortDate(repair.day)} на ${C.rub(repair.total)}?`, "Удалить")) {
      deleteRepair(repair.id);
      toast("🗑 Удалено");
      render();
    }
  });

  // ------------------------------------------------------------ запись клиента: форма

  const bookingDialog = $("#bookingDialog");
  const bookingForm = $("#bookingForm");
  let bookingContext = {};

  function markChips(container, value) {
    for (const chip of container.querySelectorAll("button")) {
      chip.classList.toggle("on", (chip.dataset.value ?? chip.textContent) === value);
    }
  }

  function openBooking(context = {}) {
    bookingContext = context;
    const booking = context.id ? data.bookings.find((b) => b.id === context.id) : null;
    const today = C.todayIso();
    $("#bookingHeading").textContent = booking ? "Перенести запись" : "Новая запись клиента";
    const dayChips = $("#bookingDayChips");
    dayChips.replaceChildren(...[0, 1, 2, 3, 4, 5, 6].map((i) => {
      const day = C.addDays(today, i);
      const label = i === 0 ? "Сегодня" : i === 1 ? "Завтра" : C.fmtButtonDay(day);
      return h("button", { type: "button", "data-value": day }, label);
    }));
    field(bookingForm, "day").value = booking ? booking.day : today;
    field(bookingForm, "clock").value = booking ? booking.clock : "";
    field(bookingForm, "text").value = booking ? booking.text : "";
    markChips(dayChips, field(bookingForm, "day").value);
    markChips($("#bookingClockChips"), field(bookingForm, "clock").value);
    $("#bookingError").textContent = "";
    bookingDialog.showModal();
  }

  $("#bookingDayChips").addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    field(bookingForm, "day").value = e.target.dataset.value;
    markChips(e.currentTarget, e.target.dataset.value);
  });
  $("#bookingClockChips").addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    const value = e.target.dataset.value ?? e.target.textContent;
    field(bookingForm, "clock").value = value;
    markChips(e.currentTarget, value);
  });
  field(bookingForm, "day").addEventListener("input", (e) => markChips($("#bookingDayChips"), e.target.value));
  field(bookingForm, "clock").addEventListener("input", (e) => markChips($("#bookingClockChips"), e.target.value.slice(0, 5)));

  bookingForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const error = $("#bookingError");
    const day = field(bookingForm, "day").value;
    const clock = field(bookingForm, "clock").value.slice(0, 5);
    const text = field(bookingForm, "text").value.trim().slice(0, 300);
    const old = bookingContext.id ? data.bookings.find((b) => b.id === bookingContext.id) : null;
    if (!isDay(day)) { error.textContent = "Выбери день."; return; }
    if (day < C.todayIso() && !(old && old.day === day)) { error.textContent = "Этот день уже прошёл — выбери будущий."; return; }
    if (!isClock(clock)) { error.textContent = "Время записи — в формате 10:00."; return; }
    if (!text) { error.textContent = "Напиши, кто записался и что делать."; return; }
    if (old) updateBooking(old.id, { day, clock, text });
    else addBooking({ day, clock, text });
    toast(`✅ ${old ? "Перенёс" : "Записал"}: ${C.fmtDayShort(day)}${clock ? ", " + clock : ""}`);
    bookingDialog.close();
    render();
  });

  for (const button of document.querySelectorAll("dialog [data-close]")) {
    button.addEventListener("click", () => button.closest("dialog").close());
  }

  function doneBooking(booking) {
    const today = C.todayIso();
    openRepair({ bookingId: booking.id }, { title: booking.text.slice(0, 200), day: booking.day < today ? booking.day : today });
  }

  async function cancelBooking(booking) {
    if (await confirmBox(`Отменить запись: ${C.fmtDayShort(booking.day)} ${booking.clock} — ${booking.text}?`, "Отменить запись")) {
      deleteBooking(booking.id);
      toast("🗑 Запись отменена");
      render();
    }
  }

  function toCalendar(bookings) {
    if (!bookings.length) {
      toast("Нет записей, которые можно добавить в календарь.");
      return;
    }
    const name = bookings.length === 1 ? `zapis-${bookings[0].day}.ics` : "zapisi-klientov.ics";
    downloadFile(C.makeIcs(bookings), name, "text/calendar;charset=utf-8");
    toast("📆 Открой скачанный файл — телефон предложит добавить в календарь.");
  }

  // ------------------------------------------------------------ куски экранов

  function statsBlock(t) {
    const hourly = C.perHour(t.net, t.minutes);
    const tiles = [
      ["Чистый доход", C.rub(t.net), "main", t.net < 0],
      ["Общая сумма", C.rub(t.total)],
      ["Запчасти", C.rub(t.parts)],
      ["Время", C.fmtDuration(t.minutes)],
      ["Ремонтов", String(t.count)],
    ];
    if (hourly !== null) tiles.push(["В час", C.rub(Math.round(hourly))]);
    if (t.count > 1) tiles.push(["Средний чек", C.rub(Math.round(t.total / t.count))]);
    return h("div", { class: "stats" }, tiles.map(([label, value, cls, negative]) =>
      h("div", { class: "stat" + (cls ? " " + cls : "") },
        h("div", { class: "label" }, label),
        h("div", { class: "value" + (negative ? " neg" : "") }, value))));
  }

  function clickable(el, action) {
    el.addEventListener("click", action);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); action(); }
    });
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    return el;
  }

  function repairList(repairs) {
    return h("ul", { class: "list" }, repairs.map((r) => {
      const net = r.total - r.parts;
      return clickable(h("li", { class: "item tap" },
        h("div", { class: "main" },
          h("div", {}, C.titleOrDefault(r.title)),
          h("div", { class: "muted small" }, `${C.fmtNum(r.total)} − ${C.fmtNum(r.parts)} · ⏱ ${C.fmtHm(r.minutes)}`)),
        h("div", { class: "side" }, h("div", { class: "net" + (net < 0 ? " neg" : "") }, C.rub(net)))),
      () => openRepair({ id: r.id }));
    }));
  }

  function dayLabel(day) {
    const today = C.todayIso();
    const tag = day === today ? "сегодня" : day === C.addDays(today, 1) ? "завтра" : null;
    return h("h3", {}, C.fmtDayShort(day), tag ? h("span", { class: "tag" }, tag) : null);
  }

  function bookingItem(booking, withActions = true) {
    return h("li", {},
      h("div", { class: "item" }, h("div", { class: "main" },
        h("span", { class: "clock" }, booking.clock || "без времени"), booking.text)),
      withActions ? h("div", { class: "booking-actions" },
        h("button", { type: "button", onclick: () => doneBooking(booking) }, "✅ Сделано"),
        h("button", { type: "button", onclick: () => openBooking({ id: booking.id }) }, "📅 Перенести"),
        h("button", { type: "button", onclick: () => toCalendar([booking]) }, "📆 В календарь"),
        h("button", { type: "button", class: "danger", "aria-label": "Отменить запись", title: "Отменить запись",
          onclick: () => cancelBooking(booking) }, "🗑")) : null);
  }

  function bookingGroups(bookings, withActions = true) {
    return C.groupByDay(bookings).map((group) => [
      dayLabel(group.day),
      h("ul", { class: "list" }, group.items.map((b) => bookingItem(b, withActions))),
    ]);
  }

  function backupReminder() {
    // Напоминаем, если копии не было две недели — считая от первой записи, а не с первой же минуты.
    const created = [...data.repairs, ...data.bookings].map((x) => x.created.slice(0, 10)).filter(isDay).sort();
    if (!created.length) return null;
    const last = data.lastBackup;
    if ((last || created[0]) >= C.addDays(C.todayIso(), -BACKUP_REMIND_DAYS)) return null;
    return card({ class: "warn" },
      h("p", {}, last ? `💾 Резервную копию последний раз сохранял ${C.fmtShortDate(last)}.`
        : "💾 Записи хранятся только на этом устройстве. Сохрани резервную копию, чтобы не потерять их."),
      h("div", { class: "buttons" }, h("button", { type: "button", onclick: saveBackup }, "Сохранить копию")));
  }

  // ------------------------------------------------------------ экран «Сегодня»

  function quickCard() {
    const input = h("input", { placeholder: "5000 1200 2:30 Yamaha R6 цепь", autocomplete: "off",
      enterkeyhint: "done", "aria-label": "Быстрая запись ремонта одной строкой" });
    const hint = "Сумма, запчасти, время и что делал — одной строкой";
    const preview = h("div", { class: "preview muted" }, hint);
    const parse = () => (input.value.trim() ? C.parseQuick(input.value, C.todayIso()) : null);

    function showPreview() {
      try {
        const q = parse();
        if (!input.value.trim()) {
          preview.textContent = hint;
          preview.className = "preview muted";
        } else if (!q) {
          preview.textContent = "Начни с суммы, например: 5000 1200 2:30 Yamaha R6 цепь";
          preview.className = "preview err";
        } else {
          const net = q.total - q.parts;
          preview.textContent = `${C.fmtDayShort(q.day)} · ${C.titleOrDefault(q.title)} · чистыми ${C.rub(net)} · ${C.fmtDuration(q.minutes)}`;
          preview.className = "preview ok";
        }
      } catch (e) {
        if (!(e instanceof C.InputError)) throw e;
        preview.textContent = e.message;
        preview.className = "preview err";
      }
    }

    function submit(e) {
      e.preventDefault();
      try {
        const q = parse();
        if (!q) throw new C.InputError(C.QUICK_HINT);
        addRepair(q);
        toast(`✅ Записал: чистыми ${C.rub(q.total - q.parts)}`);
        render();
      } catch (err) {
        if (!(err instanceof C.InputError)) throw err;
        preview.textContent = err.message;
        preview.className = "preview err";
      }
    }

    input.addEventListener("input", showPreview);
    return card({}, h("h2", {}, "⚡ Быстрая запись"),
      h("form", { class: "quick", onsubmit: submit }, input, h("button", { type: "submit", class: "primary" }, "Записать")),
      preview);
  }

  function weekCard(today) {
    const monday = C.addDays(today, -C.weekdayOf(today));
    const repairs = repairsBetween(monday, C.addDays(today, 1));
    const t = C.totals(repairs);
    const next = bookingsBetween(C.addDays(today, 1), C.addDays(today, 8));
    return card({},
      h("h2", {}, "🗓 Эта неделя"),
      repairs.length
        ? h("p", {}, `${t.count} рем. · чистыми `, h("b", {}, C.rub(t.net)), ` · ${C.fmtDuration(t.minutes)}`)
        : h("p", { class: "empty" }, "На этой неделе ремонтов пока нет."),
      next.length ? [h("h3", {}, `Записи на 7 дней вперёд: ${next.length}`), bookingGroups(next, false)] : null);
  }

  function renderToday() {
    const today = C.todayIso();
    const repairs = repairsOfDay(today);
    const todaysBookings = bookingsBetween(today, C.addDays(today, 1));
    return [
      storageOk ? null : card({ class: "warn" }, h("p", {},
        "⚠️ Браузер не даёт сохранять данные (возможно, включён частный режим). Записи пропадут после закрытия страницы.")),
      backupReminder(),
      todaysBookings.length ? card({ class: "alert" }, h("h2", {}, `📝 Сегодня записаны: ${todaysBookings.length}`),
        h("ul", { class: "list" }, todaysBookings.map((b) => bookingItem(b)))) : null,
      quickCard(),
      h("button", { type: "button", class: "primary big", onclick: () => openRepair() }, "➕ Новый ремонт"),
      card({}, h("h2", {}, "Ремонты за сегодня"),
        repairs.length ? [repairList(repairs), statsBlock(C.totals(repairs))]
          : h("p", { class: "empty" }, "Пока ремонтов нет. Запиши первый кнопкой выше или одной строкой.")),
      weekCard(today),
    ];
  }

  // ------------------------------------------------------------ экран «Месяц»

  const now = new Date();
  let monthCursor = [now.getFullYear(), now.getMonth() + 1];
  let openDay = null;
  let showAllDays = false;

  function renderMonth() {
    const [y, m] = monthCursor;
    const repairs = repairsOfMonth(y, m);
    const go = (delta) => () => {
      monthCursor = C.shiftMonth(y, m, delta);
      openDay = null;
      render();
    };
    const nav = h("div", { class: "month-nav" },
      h("button", { type: "button", onclick: go(-1), "aria-label": "Предыдущий месяц" }, "◀"),
      h("h2", {}, C.monthTitle(y, m)),
      h("button", { type: "button", onclick: go(1), "aria-label": "Следующий месяц" }, "▶"));
    if (!repairs.length) return [nav, card({}, h("p", { class: "empty" }, "За этот месяц ремонтов нет."))];

    const t = C.totals(repairs);
    const rows = [];
    for (const d of C.monthByDays(repairs, y, m)) {
      if (!d.totals && !showAllDays) continue;
      const weekday = C.weekdayOf(d.day);
      const cells = d.totals
        ? [C.fmtNum(Math.round(d.totals.total)), C.fmtNum(Math.round(d.totals.parts)),
          C.fmtNum(Math.round(d.totals.net)), C.fmtHm(d.totals.minutes)]
        : ["", "", "", ""];
      const tr = h("tr", { class: ["day", weekday >= 5 ? "weekend" : "", d.totals ? "" : "nodata"].join(" ") },
        h("td", {}, `${Number(d.day.slice(8))} ${C.WEEKDAYS[weekday]}`),
        cells.map((value, i) => h("td", { class: i === 2 && d.totals && d.totals.net < 0 ? "neg" : "" }, value)));
      if (d.totals) {
        clickable(tr, () => {
          openDay = openDay === d.day ? null : d.day;
          render();
        });
        tr.setAttribute("aria-expanded", String(openDay === d.day));
      }
      rows.push(tr);
      if (openDay === d.day) rows.push(h("tr", { class: "detail" }, h("td", { colspan: "5" }, repairList(d.items))));
    }

    return [
      nav,
      card({}, statsBlock(t)),
      card({},
        h("h2", {}, "По числам"),
        h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, ["Число", "Сумма", "Запч.", "Чистые", "Время"].map((c) => h("th", {}, c)))),
          h("tbody", {}, rows),
          h("tfoot", {}, h("tr", {}, h("td", {}, "Итого"), h("td", {}, C.fmtNum(Math.round(t.total))),
            h("td", {}, C.fmtNum(Math.round(t.parts))), h("td", {}, C.fmtNum(Math.round(t.net))),
            h("td", {}, C.fmtHm(t.minutes)))))),
        h("label", { class: "toggle" },
          h("input", { type: "checkbox", checked: showAllDays, onchange: (e) => { showAllDays = e.target.checked; render(); } }),
          "Показать все дни месяца"),
        h("p", { class: "muted small" }, "Нажми на день, чтобы увидеть и исправить его ремонты.")),
      h("button", { type: "button", class: "big", onclick: () => exportMonth(y, m) }, `📤 Скачать Excel за ${C.MONTHS[m - 1]}`),
    ];
  }

  // ------------------------------------------------------------ экран «Записи»

  function renderBookings() {
    const today = C.todayIso();
    const upcoming = C.sortBookings(data.bookings.filter((b) => b.day >= today));
    const past = C.sortBookings(data.bookings.filter((b) => b.day < today && b.day >= C.addDays(today, -PAST_BOOKINGS_DAYS)));
    return [
      h("button", { type: "button", class: "primary big", onclick: () => openBooking() }, "📝 Создать запись"),
      card({},
        h("h2", {}, "Записи клиентов"),
        upcoming.length ? [
          bookingGroups(upcoming),
          h("div", { class: "buttons", style: "margin-top: 12px" },
            h("button", { type: "button", onclick: () => toCalendar(upcoming) }, "📆 Все записи в календарь")),
          h("p", { class: "muted small" }, "Добавь записи в календарь телефона — он сам напомнит за час до клиента."),
        ] : h("p", { class: "empty" }, "Пока никто не записан.")),
      past.length ? card({ class: "warn" },
        h("h2", {}, "Прошедшие — не отмечены"),
        h("p", { class: "small" }, "Отметь «Сделано», чтобы ремонт попал в учёт, или отмени запись."),
        bookingGroups(past)) : null,
    ];
  }

  // ------------------------------------------------------------ экран «Ещё»: Excel, копия, напоминания

  async function exportMonth(y, m) {
    await safely(async () => {
      const repairs = repairsOfMonth(y, m);
      if (!repairs.length) throw new C.InputError(`За ${C.MONTHS[m - 1]} ${y} ремонтов нет — выгружать нечего.`);
      toast("Готовлю файл…");
      const blob = await window.ExcelIO.exportMonth(repairs, y, m);
      downloadFile(blob, window.ExcelIO.monthFilename(y, m));
      toast(`📤 Готово: ${C.plural(repairs.length, C.REPAIRS_WORDS)} за ${C.MONTHS[m - 1]}`);
    });
  }

  async function exportTemplate() {
    await safely(async () => {
      downloadFile(await window.ExcelIO.template(), window.ExcelIO.TEMPLATE_FILENAME);
      toast("📄 Заполни шаблон и загрузи его кнопкой «Загрузить из Excel».");
    });
  }

  async function importExcel() {
    const file = await pickFile(".xlsx,.xlsm,.xls,.ods,.csv");
    if (!file) return;
    await safely(async () => {
      if (file.size > MAX_IMPORT_FILE_SIZE) throw new C.InputError("Файл больше 10 МБ — пришли таблицу поменьше.");
      toast("Читаю файл…");
      const { rows, badRows } = await window.ExcelIO.importFile(file, C.todayIso());
      const { fresh, skipped } = C.newRowsOnly(data.repairs, rows);
      addRepairs(fresh);
      const parts = [fresh.length ? `✅ Загрузил ${C.plural(fresh.length, C.REPAIRS_WORDS)}.` : "Новых ремонтов в файле нет."];
      if (skipped) parts.push(`Пропустил ${skipped} — они уже есть.`);
      if (badRows.length) {
        const shown = badRows.slice(0, 10).join(", ") + (badRows.length > 10 ? "…" : "");
        parts.push(`Не разобрал ${badRows.length === 1 ? "строку" : "строки"} ${shown} — проверь там дату и сумму.`);
      }
      toast(parts.join(" "), !fresh.length && badRows.length > 0);
      render();
    });
  }

  function saveBackup() {
    const backup = { app: "moto-uchet", version: 1, exported: stamp(), repairs: data.repairs, bookings: data.bookings,
      nextId: data.nextId };
    downloadFile(JSON.stringify(backup, null, 1), `uchet-kopiya-${C.todayIso()}.json`, "application/json");
    data.lastBackup = C.todayIso();
    save();
    toast("💾 Копия сохранена в «Загрузки». Перешли её себе в Telegram или на почту.");
    render();
  }

  async function restoreBackup() {
    const file = await pickFile(".json,application/json");
    if (!file) return;
    await safely(async () => {
      let raw;
      try {
        raw = JSON.parse(await file.text());
      } catch (e) {
        throw new C.InputError("Это не файл резервной копии.");
      }
      if (!raw || raw.app !== "moto-uchet") throw new C.InputError("Это не файл резервной копии учёта.");
      const restored = normalize(raw);
      const exported = new Date(raw.exported);
      const when = Number.isNaN(exported.getTime()) ? "неизвестной даты" : C.fmtShortDate(C.toIso(exported));
      const ok = await confirmBox(`Заменить все данные на копию от ${when}? В копии: ` +
        `${C.plural(restored.repairs.length, C.REPAIRS_WORDS)} и ${C.plural(restored.bookings.length, C.BOOKINGS_WORDS)}. ` +
        `Сейчас: ${C.plural(data.repairs.length, C.REPAIRS_WORDS)} и ${C.plural(data.bookings.length, C.BOOKINGS_WORDS)}.`, "Заменить");
      if (!ok) return;
      restored.lastBackup = C.todayIso();
      data = restored;
      save();
      toast("♻️ Данные восстановлены из копии.");
      render();
    });
  }

  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    if (currentTab === "more") render();
  });

  function renderMore() {
    const today = new Date();
    const months = [];
    for (let i = 0; i < 12; i++) months.push(C.shiftMonth(today.getFullYear(), today.getMonth() + 1, -i));
    const select = h("select", { "aria-label": "Месяц для выгрузки" },
      months.map(([y, m]) => h("option", { value: `${y}-${m}` }, C.monthTitle(y, m))));
    const upcoming = C.sortBookings(data.bookings.filter((b) => b.day >= C.todayIso()));
    return [
      card({},
        h("h2", {}, "📗 Excel"),
        h("p", { class: "small muted" }, "Выгрузи таблицу за месяц или загрузи ремонты из своего файла — повторы не добавятся."),
        select,
        h("div", { class: "buttons", style: "margin-top: 8px" },
          h("button", { type: "button", onclick: () => {
            const [y, m] = select.value.split("-").map(Number);
            exportMonth(y, m);
          } }, "📤 Выгрузить"),
          h("button", { type: "button", onclick: importExcel }, "📥 Загрузить из Excel"),
          h("button", { type: "button", onclick: exportTemplate }, "📄 Пустой шаблон"))),
      card({},
        h("h2", {}, "💾 Резервная копия"),
        h("p", { class: "small" }, "Все записи хранятся только в этом браузере на этом устройстве. Сохраняй копию, " +
          "чтобы не потерять их при смене телефона или очистке браузера, и перешли её себе."),
        h("p", { class: "small muted" }, `Сейчас: ${C.plural(data.repairs.length, C.REPAIRS_WORDS)}, ` +
          `${C.plural(data.bookings.length, C.BOOKINGS_WORDS)}. ` +
          (data.lastBackup ? `Последняя копия: ${C.fmtShortDate(data.lastBackup)}.` : "Копию ещё не сохранял.")),
        h("div", { class: "buttons" },
          h("button", { type: "button", onclick: saveBackup }, "💾 Сохранить копию"),
          h("button", { type: "button", onclick: restoreBackup }, "♻️ Восстановить из копии"))),
      card({},
        h("h2", {}, "🔔 Напоминания"),
        h("p", { class: "small" }, "Сайт не может сам присылать уведомления, когда он закрыт. Поэтому напоминает календарь " +
          "телефона: нажми «📆 В календарь» у записи — телефон напомнит за час, а о записи без времени — в 9 утра."),
        h("p", { class: "small" }, "А когда открываешь сайт, сверху сразу видно, кто записан на сегодня."),
        h("div", { class: "buttons" }, h("button", { type: "button", onclick: () => toCalendar(upcoming) },
          `📆 Все записи в календарь (${upcoming.length})`))),
      card({},
        h("h2", {}, "📲 Как приложение"),
        installPrompt ? h("div", { class: "buttons" }, h("button", { type: "button", class: "primary", onclick: async () => {
          installPrompt.prompt();
          await installPrompt.userChoice.catch(() => null);
          installPrompt = null;
          render();
        } }, "Установить на телефон")) : null,
        h("p", { class: "small" }, "Android (Chrome): меню ⋮ → «Добавить на главный экран»."),
        h("p", { class: "small" }, "iPhone (Safari): кнопка «Поделиться» → «На экран Домой»."),
        h("p", { class: "small muted" }, "После этого учёт открывается с иконки, как обычное приложение, и работает без интернета.")),
      card({},
        h("h2", {}, "❓ Подсказки"),
        h("p", { class: "small" }, "Быстрая запись: сумма, запчасти, время, что делал — «5000 1200 2:30 Yamaha R6 цепь». " +
          "За прошлый день — дату вперёд: «23.10 5000 1200 2»."),
        h("p", { class: "small" }, "Время: 2 (часа), 1.5, 2:30, 40м, 1ч20м. Суммы: 5000, 5к, 2.5к; без запчастей — 0."),
        h("p", { class: "small" }, "Нажми на любой ремонт в списке, чтобы исправить или удалить его.")),
    ];
  }

  // ------------------------------------------------------------ переключение экранов

  const views = { today: renderToday, month: renderMonth, bookings: renderBookings, more: renderMore };
  let currentTab = "today";

  function render() {
    $("#todayLabel").textContent = C.fmtDate(C.todayIso());
    for (const tab of document.querySelectorAll(".tabs button")) {
      const active = tab.dataset.tab === currentTab;
      tab.classList.toggle("active", active);
      if (active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    $("#view").replaceChildren(h("div", {}, views[currentTab]()));
  }

  for (const tab of document.querySelectorAll(".tabs button")) {
    tab.addEventListener("click", () => {
      currentTab = tab.dataset.tab;
      render();
      window.scrollTo({ top: 0 });
    });
  }

  // Открыли сайт в другой вкладке и что-то поменяли — подхватываем.
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      data = load();
      render();
    }
  });
  // Вернулись к сайту на следующий день — обновляем «сегодня».
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !document.querySelector("dialog[open]")) render();
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.addEventListener("error", () => toast("Что-то пошло не так. Обнови страницу.", true));

  render();
})();
