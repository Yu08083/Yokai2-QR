"use strict";

const QRUsage = (() => {
  const SERIAL_LIMIT = 36 ** 4;
  const STORAGE_KEY = "yw2-qr-usage-v1";
  const PROFILE_IDS = ["save1", "save2", "save3"];
  const validKey = /^(yw2:[0-9A-Z]{3}|yw1-jp:[0-9A-Z]{2}):[0-9A-Z]{4}$/;

  function keyFor(result) {
    if (!result || result.details?.checksum_valid !== true) return null;
    const key = `${result.format}:${result.fields?.qr_type}:${result.fields?.serial}`;
    return validKey.test(key) ? key : null;
  }

  function emptyStore() {
    return { application: "yw2-qr-usage", version: 1, profiles: { save1: {}, save2: {}, save3: {} } };
  }

  function normalizeStore(value) {
    if (!value || value.application !== "yw2-qr-usage" || value.version !== 1 || !value.profiles || typeof value.profiles !== "object") {
      throw new Error("使用メモのJSONファイルを選択してください。");
    }
    const store = emptyStore();
    let count = 0;
    for (const profile of PROFILE_IDS) {
      const records = value.profiles[profile] || {};
      if (typeof records !== "object" || Array.isArray(records)) throw new Error("使用メモの形式が不正です。");
      for (const [key, timestamp] of Object.entries(records)) {
        if (!validKey.test(key) || typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) throw new Error("使用メモに不正なQRの記録があります。");
        if (++count > 100000) throw new Error("使用メモは10万件以下にしてください。");
        store.profiles[profile][key] = timestamp;
      }
    }
    return store;
  }

  function shiftedSerial(serial, delta) {
    if (!/^[0-9A-Z]{4}$/.test(serial) || !Number.isInteger(delta)) throw new Error("個体番号は4桁の36進数で入力してください。");
    const value = parseInt(serial, 36) + delta;
    if (value < 0 || value >= SERIAL_LIMIT) return null;
    return value.toString(36).toUpperCase().padStart(4, "0");
  }

  function nextUnrecorded(format, type, serial, records) {
    let next = shiftedSerial(serial, 1);
    while (next) {
      if (format === "yw1-jp" && type === "P1" && next === "ZZZZ") return null;
      if (!Object.hasOwn(records, `${format}:${type}:${next}`)) return next;
      next = shiftedSerial(next, 1);
    }
    return null;
  }

  function groupRewards(rows, profile) {
    const groups = new Map();
    rows.forEach((row, index) => {
      if (row.profile !== profile) return;
      if (!groups.has(row.item_id)) groups.set(row.item_id, { ...row, index, ranges: [] });
      groups.get(row.item_id).ranges.push([row.start, row.end]);
    });
    return [...groups.values()];
  }

  return { STORAGE_KEY, PROFILE_IDS, SERIAL_LIMIT, keyFor, emptyStore, normalizeStore, shiftedSerial, nextUnrecorded, groupRewards };
})();

if (typeof module !== "undefined" && module.exports) module.exports = QRUsage;
