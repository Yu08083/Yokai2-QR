"use strict";

const QRUsage = (() => {
  const SERIAL_LIMIT = 36 ** 4;
  const STORAGE_KEY = "yw2-qr-usage-v1";
  const PROFILE_IDS = ["save1", "save2", "save3"];
  const validKey = /^(yw2:[0-9A-Z]{3}|yw1-jp:[0-9A-Z]{2}):[0-9A-Z]{4}$/;

  function profileIds(game = "yw2") { return game === "yw3" ? PROFILE_IDS.slice(0, 2) : PROFILE_IDS; }
  function storageKey(game = "yw2") { return game === "yw3" ? "yw3-qr-usage-v1" : STORAGE_KEY; }

  function keyFor(result) {
    if (!result || result.details?.checksum_valid !== true) return null;
    const key = `${result.format}:${result.fields?.qr_type}:${result.fields?.serial}`;
    return validKey.test(key) ? key : null;
  }

  function emptyStore(game = "yw2") {
    return { application: `${game}-qr-usage`, version: 1, profiles: Object.fromEntries(profileIds(game).map(profile => [profile, {}])) };
  }

  function normalizeStore(value, game = "yw2") {
    if (!value || value.application !== `${game}-qr-usage` || value.version !== 1 || !value.profiles || typeof value.profiles !== "object") {
      throw new Error("使用メモのJSONファイルを選択してください。");
    }
    const store = emptyStore(game);
    let count = 0;
    for (const profile of profileIds(game)) {
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

  function isSpecial(format, type, serial, game = "yw2") {
    return format === "yw1-jp" && type === "P1" && (serial === "ZZZZ" || (game === "yw3" && serial === "ZZZY"));
  }

  function nextUnrecorded(format, type, serial, records, game = "yw2") {
    if (isSpecial(format, type, serial, game)) return null;
    let next = shiftedSerial(serial, 1);
    while (next) {
      if (isSpecial(format, type, next, game)) return null;
      if (!Object.hasOwn(records, `${format}:${type}:${next}`)) return next;
      next = shiftedSerial(next, 1);
    }
    return null;
  }

  function groupRewards(rows, profile) {
    const groups = new Map();
    rows.forEach((row, index) => {
      if (row.profile !== profile || row.start > row.end) return;
      const key = row.reward_group ?? row.item_id;
      if (!groups.has(key)) groups.set(key, { ...row, index, ranges: [] });
      groups.get(key).ranges.push([row.start, row.end]);
    });
    return [...groups.values()];
  }

  return { STORAGE_KEY, PROFILE_IDS, SERIAL_LIMIT, profileIds, storageKey, keyFor, emptyStore, normalizeStore, shiftedSerial, isSpecial, nextUnrecorded, groupRewards };
})();

if (typeof module !== "undefined" && module.exports) module.exports = QRUsage;
