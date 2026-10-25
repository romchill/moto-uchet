/* Работа внутри Telegram (сайт открыт кнопкой меню бота):
   облако Telegram для данных, календарь через Google, передача данных в браузер для скачивания файлов.
   Вне Telegram модуль ничего не делает. */
(function (root) {
  "use strict";

  const TELEGRAM_SCRIPT = "https://telegram.org/js/telegram-web-app.js";
  const CHUNK = 4000;          // в облаке Telegram значение — не длиннее 4096 символов
  const MAX_KEYS = 1000;       // всего ключей — не больше 1024
  const BATCH = 50;
  const SAVE_DELAY = 1500;
  const RETRY_DELAY = 30000;
  const MAX_URL_DATA = 400000; // столько символов данных ещё нормально передаётся ссылкой в браузер

  /** Открыт ли сайт из Telegram: Telegram добавляет к адресу #tgWebAppData=… (и помнит его при перезагрузке). */
  function openedFromTelegram() {
    if (/tgWebAppData=/.test(root.location ? root.location.hash : "")) return true;
    try {
      return /tgWebAppData/.test(root.sessionStorage.getItem("__telegram__initParams") || "");
    } catch (e) {
      return false;
    }
  }

  /** Подключает Telegram WebApp. null — сайт открыт не в Telegram. */
  function load() {
    const ready = () => {
      const app = root.Telegram && root.Telegram.WebApp;
      return app && app.initData ? app : null;
    };
    if (ready()) return Promise.resolve(ready());
    if (!openedFromTelegram()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = TELEGRAM_SCRIPT;
      script.onload = () => resolve(ready());
      script.onerror = () => resolve(null); // нет интернета — работаем с данными на телефоне
      document.head.append(script);
    });
  }

  /** Телефон внутри Telegram не умеет скачивать файлы, которые сайт создаёт сам. */
  const filesBlocked = (app) => Boolean(app) && ["android", "android_x", "ios"].includes(app.platform);

  // ------------------------------------------------------------ облако Telegram

  /**
   * Хранит данные в CloudStorage Telegram: они не пропадут при очистке телефона и одинаковы на всех устройствах.
   * Пишем по очереди в два «слота» (a и b) и только потом переключаем meta — оборванная запись не портит данные.
   */
  function cloud(storage) {
    const call = (method, ...args) => new Promise((resolve, reject) => {
      storage[method](...args, (error, result) => (error ? reject(new Error(String(error))) : resolve(result)));
    });
    const readMeta = async () => {
      const raw = await call("getItem", "meta");
      if (!raw) return null;
      const meta = JSON.parse(raw);
      return meta && (meta.slot === "a" || meta.slot === "b") && Number.isInteger(meta.count) ? meta : null;
    };

    async function read() {
      const meta = await readMeta();
      if (!meta) return null;
      const keys = Array.from({ length: meta.count }, (_, i) => meta.slot + i);
      let text = "";
      for (let i = 0; i < keys.length; i += BATCH) {
        const part = keys.slice(i, i + BATCH);
        const values = await call("getItems", part);
        for (const key of part) {
          if (typeof values[key] !== "string") throw new Error(`В облаке нет части данных: ${key}`);
          text += values[key];
        }
      }
      return { data: JSON.parse(text), updatedAt: Number(meta.updatedAt) || 0 };
    }

    async function write(json, updatedAt) {
      const meta = await readMeta();
      const slot = meta && meta.slot === "a" ? "b" : "a";
      const chunks = [];
      for (let i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
      if (chunks.length * 2 + 1 > MAX_KEYS) throw new Error("Данных слишком много для облака Telegram");
      for (let i = 0; i < chunks.length; i++) await call("setItem", slot + i, chunks[i]);
      await call("setItem", "meta", JSON.stringify({ slot, count: chunks.length, updatedAt }));
      // Хвост этого слота от прошлых, более длинных записей больше не нужен.
      const keys = await call("getKeys");
      const stale = keys.filter((key) => key.startsWith(slot) && Number(key.slice(1)) >= chunks.length);
      if (stale.length) await call("removeItems", stale);
    }

    // Сохранение с задержкой: частые правки подряд уходят в облако одной записью.
    // Не получилось (нет интернета) — пробуем ещё раз через полминуты.
    let timer = null;
    let running = null;
    let pending = null;
    let onState = () => {};

    async function flush() {
      clearTimeout(timer);
      timer = null;
      while (pending) {
        if (running) {
          await running;
          continue;
        }
        const getSnapshot = pending;
        pending = null;
        const snapshot = getSnapshot();
        running = write(snapshot.json, snapshot.updatedAt)
          .then(() => onState("saved"), (error) => {
            onState("error", error);
            if (!pending) {
              pending = getSnapshot;
              timer = setTimeout(flush, RETRY_DELAY);
            }
          })
          .finally(() => { running = null; });
        await running;
        if (timer) return; // ждём повтора
      }
    }

    function saveSoon(getSnapshot) {
      pending = getSnapshot;
      clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY);
    }

    return { read, write, saveSoon, flush, onStateChange: (fn) => { onState = fn; } };
  }

  // ------------------------------------------------------------ передача данных в браузер

  const toBase64Url = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const fromBase64Url = (text) => {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  };
  const streamBytes = async (bytes, transform) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer());

  /** Упаковывает текст для адреса ссылки: сжатый (z…) или как есть (u…), если сжатие не поддерживается. */
  async function packForUrl(text) {
    const bytes = new TextEncoder().encode(text);
    if (typeof CompressionStream === "function") {
      return "z" + toBase64Url(await streamBytes(bytes, new CompressionStream("deflate-raw")));
    }
    return "u" + toBase64Url(bytes);
  }

  async function unpackFromUrl(packed) {
    const bytes = fromBase64Url(packed.slice(1));
    if (packed[0] === "u") return new TextDecoder().decode(bytes);
    if (packed[0] !== "z") throw new Error("Неизвестный формат данных");
    if (typeof DecompressionStream !== "function") throw new Error("Браузер слишком старый — обнови его");
    return new TextDecoder().decode(await streamBytes(bytes, new DecompressionStream("deflate-raw")));
  }

  // ------------------------------------------------------------ календарь

  const compact = (iso) => iso.replace(/-/g, "");

  /** Ссылка «добавить событие» в Google Календарь — работает и из Telegram, где файлы не скачиваются. */
  function googleCalendarUrl(booking, addDays, timeZone) {
    let dates;
    if (booking.clock) {
      const [h, m] = booking.clock.split(":").map(Number);
      const endHour = h + 1;
      const endDay = endHour >= 24 ? addDays(booking.day, 1) : booking.day;
      const pad = (n) => String(n).padStart(2, "0");
      dates = `${compact(booking.day)}T${pad(h)}${pad(m)}00/${compact(endDay)}T${pad(endHour % 24)}${pad(m)}00`;
    } else {
      dates = `${compact(booking.day)}/${compact(addDays(booking.day, 1))}`;
    }
    const params = new URLSearchParams({ action: "TEMPLATE", text: "🏍 " + booking.text, dates, details: "Запись клиента" });
    if (timeZone) params.set("ctz", timeZone);
    return "https://calendar.google.com/calendar/render?" + params.toString();
  }

  const api = { openedFromTelegram, load, filesBlocked, cloud, packForUrl, unpackFromUrl, googleCalendarUrl, MAX_URL_DATA };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Tg = api;
})(typeof self !== "undefined" ? self : this);
