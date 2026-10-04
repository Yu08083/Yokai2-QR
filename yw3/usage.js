"use strict";

const QRUsage = (() => {
  const SERIAL_LIMIT = 36 ** 4;
  const STORAGE_KEY = "yw2-qr-usage-v1";
  const PROFILE_IDS = ["save1", "save2", "save3"];
  const validKey = /^(yw2:[0-9A-Z]{3}|yw1-jp:[0-9A-Z]{2}):[0-9A-Z]{4}$/;

  function profileIds(game = "yw2") { return game === "busters2" ? ["sword1", "sword2", "magnum1", "magnum2"] : game === "busters" ? ["red1", "red2", "red3", "white1", "white2", "white3"] : game === "yw3" ? PROFILE_IDS.slice(0, 2) : PROFILE_IDS; }
  function profileLabel(game, profile) { return game === "busters2" ? `${profile.startsWith("sword") ? "ソード" : "マグナム"}・セーブ${profile.slice(-1)}` : game === "busters" ? `${profile.startsWith("red") ? "赤猫団" : "白犬隊"}・セーブ${profile.slice(-1)}` : `セーブ${profile.slice(-1)}`; }
  function storageKey(game = "yw2") { return game === "yw2" ? STORAGE_KEY : `${game}-qr-usage-v1`; }

  function keyFor(result, game = result?.game || "yw2") {
    if (!result || result.details?.checksum_valid !== true) return null;
    if (isBlocked(result.format, result.fields?.qr_type, result.fields?.serial, game)) return null;
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
        if (isBlocked(...key.split(":"), game)) continue;
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
    return ["yw2", "yw3", "busters", "busters2"].includes(game) && format === "yw1-jp" && type === "P1" && (serial === "ZZZZ" || game !== "yw2" && serial === "ZZZY");
  }

  function isBlocked(format, type, serial, game = "yw2") {
    return game === "yw2" && format === "yw1-jp" && String(type).toUpperCase() === "P1" && String(serial).toUpperCase() === "ZZZY";
  }

  function nextUnrecorded(format, type, serial, records, game = "yw2") {
    if (isSpecial(format, type, serial, game) || isBlocked(format, type, serial, game)) return null;
    let next = shiftedSerial(serial, 1);
    while (next) {
      if (isBlocked(format, type, next, game)) { next = shiftedSerial(next, 1); continue; }
      if (isSpecial(format, type, next, game)) return null;
      if (!Object.hasOwn(records, `${format}:${type}:${next}`)) return next;
      next = shiftedSerial(next, 1);
    }
    return null;
  }

  function groupRewards(rows, profile) {
    const groups = new Map();
    let covered = [];
    rows.forEach((row, index) => {
      if (row.profile !== profile || row.start > row.end) return;
      const ranges = [];
      let cursor = row.start;
      for (const [start, end] of covered) {
        if (end < cursor) continue;
        if (start > row.end) break;
        if (start > cursor) ranges.push([cursor, Math.min(row.end, start - 1)]);
        cursor = Math.max(cursor, end + 1);
        if (cursor > row.end) break;
      }
      if (cursor <= row.end) ranges.push([cursor, row.end]);
      const merged = [];
      for (const range of [...covered, [row.start, row.end]].sort((a, b) => a[0] - b[0])) {
        const previous = merged[merged.length - 1];
        if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
        else merged.push([...range]);
      }
      covered = merged;
      if (!ranges.length || row.selectable === false) return;
      const key = row.reward_group ?? row.item_id;
      if (!groups.has(key)) {
        const start = ranges[0][0];
        groups.set(key, { ...row, start, qr_type: start.toString(36).toUpperCase().padStart(profile === "yw2" ? 3 : 2, "0"), index, ranges: [] });
      }
      groups.get(key).ranges.push(...ranges);
    });
    return [...groups.values()];
  }

  return { STORAGE_KEY, PROFILE_IDS, SERIAL_LIMIT, profileIds, profileLabel, storageKey, keyFor, emptyStore, normalizeStore, shiftedSerial, isSpecial, isBlocked, nextUnrecorded, groupRewards };
})();

if (typeof module !== "undefined" && module.exports) module.exports = QRUsage;
