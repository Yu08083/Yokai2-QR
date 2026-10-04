"use strict";

const QRLocal = (() => {
  const vendor = typeof module === "object" && module.exports ? { md5: require("blueimp-md5"), qrcode: require("qrcode-generator"), jsQR: require("jsqr") } : QRVendor;
  const prefix = "http://YW.B-BOYS.JP/";
  const alphabet = "GN5BH8QJSAC0MFR6P4VET1O7K9U2LD3I";
  const profiles = { "yw1-jp": { width: 2, keys: ["A14+BDM71D", "QK35+NI8WV"] }, yw2: { width: 3, keys: ["OYD78+MIP3", "N+Q09V7LI5"] } };
  let catalogPromise;

  function checksum(profile, pattern) {
    const spec = profiles[profile];
    if (!spec) throw new Error("対応していないQR形式です。");
    const digest = vendor.md5(vendor.md5(pattern, spec.keys[0]), spec.keys[1]);
    const bits = digest.match(/../g).map(byte => parseInt(byte, 16).toString(2).padStart(8, "0")).join("");
    let result = "";
    for (let start = 0; start < 128; start += 5) result += alphabet[parseInt(bits.slice(start, start + 5), 2)];
    return result;
  }

  function encode(profile, type, serial) {
    const spec = profiles[profile];
    if (!spec) throw new Error("対応していないQR形式です。");
    if (typeof type !== "string" || !new RegExp(`^[0-9A-Z]{${spec.width}}$`).test(type)) throw new Error(`種類番号は0–9 / A–Zの${spec.width}桁で入力してください。`);
    if (typeof serial !== "string" || !/^[0-9A-Z]{4}$/.test(serial)) throw new Error("個体番号は0–9 / A–Zの4桁で入力してください。");
    return Uint8Array.from(prefix + type + serial + checksum(profile, type + serial), char => char.charCodeAt(0));
  }

  function decode(payload) {
    if (!(payload instanceof Uint8Array) || [...payload].some(byte => byte < 32 || byte > 126)) return null;
    const text = String.fromCharCode(...payload);
    const separator = text.lastIndexOf("/");
    const code = text.slice(separator + 1);
    const profile = { 32: "yw1-jp", 33: "yw2" }[code.length];
    if (!profile || !/^[0-9A-Z]+$/.test(code)) return null;
    const width = profiles[profile].width;
    const qr_type = code.slice(0, width);
    const serial = code.slice(width, width + 4);
    const expected_checksum = checksum(profile, qr_type + serial);
    return { profile, qr_type, serial, checksum: code.slice(width + 4), expected_checksum, checksum_valid: code.slice(width + 4) === expected_checksum, uri_prefix: text.slice(0, separator + 1), has_separator: separator >= 0, canonical_uri: text.slice(0, separator + 1) === prefix, text };
  }

  function parseHex(value) {
    if (typeof value !== "string") throw new Error("QRデータの形式が不正です。");
    const compact = value.replace(/\s/g, "");
    if (!compact.length || compact.length % 2 || !/^[0-9a-f]+$/i.test(compact)) throw new Error("QRデータは00–FFの2桁単位で入力してください。");
    if (compact.length > 4000) throw new Error("QRデータは2000バイトまでです。");
    return Uint8Array.from(compact.match(/../g), byte => parseInt(byte, 16));
  }

  function assertAllowed(payload, catalog) {
    if ((catalog.game_id || "yw2") !== "yw2") return;
    const text = String.fromCharCode(...payload);
    const code = text.slice(text.lastIndexOf("/") + 1);
    if (code.length === 32 && code.slice(0, 6).toUpperCase() === "P1ZZZY") throw new Error("このQRは妖怪ウォッチ2では表示・生成できません。");
  }

  function rewardLabel(reward, catalog, tableVersion = catalog.default_version || "update") {
    const pools = rewardTable(catalog, tableVersion).named_random_pools;
    const pool = pools?.[reward.random_table] || [];
    const family = pool[0]?.name?.split("・")[0];
    if (["超", "極"].includes(family) && pool.length === 8 && pool.every(item => item.name.startsWith(family + "・"))) return `${family}コイン（8色から抽選）`;
    return reward.label || reward.name || "名称未確認";
  }

  function rewardTable(catalog, tableVersion = catalog.default_version || "update") {
    const version = catalog.version_tables?.[tableVersion] || tableVersion;
    if (version === "update") return { rewards: catalog.rewards, named_random_pools: catalog.named_random_pools, random_pools: catalog.random_pools };
    if (version === "base") return { rewards: catalog.base_rewards, named_random_pools: catalog.base_named_random_pools, random_pools: catalog.random_pools };
    const table = catalog.extra_tables?.[version];
    if (!table) throw new Error("報酬表のバージョンが不正です。");
    return table;
  }

  function describe(payload, catalog, tableVersion = catalog.default_version || "update") {
    assertAllowed(payload, catalog);
    const table = rewardTable(catalog, tableVersion);
    const parsed = decode(payload);
    const warnings = [];
    const details = { payload: [...payload].map(byte => byte < 128 ? String.fromCharCode(byte) : "\\x" + byte.toString(16).padStart(2, "0")).join(""), "報酬表": catalog.versions?.[tableVersion] || (tableVersion === "update" ? "更新版" : "本体版") };
    if (!parsed) return { format: "raw", fields: {}, warnings: ["対応するゲーム用QRの形式ではありません。"], details };
    if (catalog.game_id === "yw1" && !catalog.formats.some(format => format.id === parsed.profile)) return { format: "raw", fields: {}, warnings: ["妖怪ウォッチ（初代）用のQR形式ではありません。"], details };
    const fields = { qr_type: parsed.qr_type, serial: parsed.serial };
    details.checksum_valid = parsed.checksum_valid;
    details["検証文字列"] = parsed.checksum_valid ? "一致" : "不一致";
    if (!parsed.checksum_valid) warnings.push("検証文字列が一致しません。生成し直すと再計算します。");
    if (!parsed.has_separator) warnings.push("URLの区切りがありません。ゲーム用には生成し直してください。");
    if (["yw1", "busters2"].includes(catalog.game_id)) {
      const special = catalog.special_qrs?.find(row => row.profile === parsed.profile && row.qr_type === fields.qr_type && row.serial === fields.serial);
      if (special) {
        const effect = special.version_effects?.[tableVersion];
        details["表示名"] = special.label;
        details["特殊処理（認証成功時）"] = effect || "この版の特殊処理は未確認";
        details["報酬"] = effect ? "アイテム付与なし（専用分岐）" : "特殊QR（受け取り内容未確認）";
        warnings.push(effect ? "アイテムや妖怪を直接受け取るQRではありません。" : "この版での特殊QRの効果は未確認です。");
        return { format: parsed.profile, fields, warnings, details };
      }
    }
    if (catalog.game_id === "busters" && parsed.profile === "yw1-jp" && fields.qr_type === "P1" && ["ZZZZ", "ZZZY"].includes(fields.serial)) {
      const special = catalog.special_qrs.find(row => row.serial === fields.serial);
      details["表示名"] = special.label;
      if (fields.serial === "ZZZZ" || ["update", "white-update"].includes(catalog.version_tables?.[tableVersion] || tableVersion)) {
        details["特殊処理（認証成功時）"] = fields.serial === "ZZZZ" ? "専用フラグを設定" : "セーブ内の状態ビットと管理値を解除";
        details["報酬"] = "アイテム付与なし（専用分岐）";
        warnings.push("読み取り後は「使用済み」と表示される専用処理です。アイテムや妖怪を直接受け取るQRではありません。");
        return { format: parsed.profile, fields, warnings, details };
      }
      warnings.push("この本体版にはP1ZZZYの専用処理がありません。通常の報酬判定に進みます。");
    }
    if (["yw2", "yw3"].includes(catalog.game_id) && parsed.profile === "yw1-jp" && fields.qr_type + fields.serial === "P1ZZZZ") {
      details["特殊処理（認証成功時）"] = "ツチノコパンダのすれちがい送信開始フラグを設定";
      details["表示名"] = "ツチノコパンダ";
      details["報酬"] = "アイテム付与なし（専用分岐）";
      warnings.push(catalog.game_id === "yw3" ? "読み取り後、さすらい荘で登録・更新し、別の3DSとすれちがってください。QRを読んだ本体へ直接出現させるものではありません。" : "読み取り後、さすらい荘で登録・更新し、別の3DSとすれちがってください。「使用済み」と表示されても送信準備が進む処理です。受信側での出現報告があります。");
      return { format: parsed.profile, fields, warnings, details };
    }
    if (catalog.game_id === "yw3" && parsed.profile === "yw1-jp" && fields.qr_type + fields.serial === "P1ZZZY") {
      details["表示名"] = "引き継ぎ回数リセット";
      details["特殊処理（認証成功時）"] = tableVersion === "update" ? "引き継ぎ済み状態を解除" : tableVersion === "base" ? "専用分岐あり・状態変更なし" : "この版の特殊処理は未確認";
      details["報酬"] = "アイテム付与なし（専用分岐）";
      warnings.push("アイテムや妖怪を受け取るQRではありません。");
      return { format: parsed.profile, fields, warnings, details };
    }
    const rows = table.rewards;
    const number = parseInt(fields.qr_type, 36);
    const reward = rows.find(row => row.profile === parsed.profile && row.start <= number && number <= row.end);
    if (reward) {
      if (reward.selectable === false) {
        details["表示名"] = "受取対象外（旧データ）";
        details["報酬"] = "受取対象外（旧データ）";
        details["受け取り可否"] = "受け取り不可";
        warnings.push(reward.unsupported_reason || "このQRの報酬は、このゲームの受け取り対象ではありません。");
        return { format: parsed.profile, fields, warnings, details };
      }
      details["報酬"] = reward.label || reward.name;
      details["表示名"] = rewardLabel(reward, catalog, tableVersion);
      details["アイテムID"] = "0x" + reward.item_id.toString(16).toUpperCase().padStart(8, "0");
      if (reward.grants) details.grants = reward.grants;
      if (["busters", "busters2"].includes(catalog.game_id) && reward.grants?.length === 0 && !reward.random_table) {
        details.random_pool = table.random_pools?.[parsed.profile] || [];
        warnings.push("このQRの受け取り内容はゲーム内で抽選されます。");
      }
      if (reward.random_table) {
        const pools = table.named_random_pools;
        details.random_pool = pools?.[reward.random_table] || [];
        warnings.push("このQRの受け取り内容はゲーム内で抽選されます。");
      }
      if (catalog.items.find(item => item.item_id === reward.item_id)?.item_kind === "ITEM_IMPORTANT") warnings.push("大事なものです。受け取り・使用条件はゲームの所持状況や進行で決まります。");
    } else {
      details["報酬"] = "ランダム報酬";
      warnings.push("この種類番号の報酬はゲーム内の抽選で決まります。");
    }
    return { format: parsed.profile, fields, warnings, details };
  }

  function makeQR(payload, ecc = "M") {
    if (!payload.length || payload.length > 2000) throw new Error("QRデータは1–2000バイトまでです。");
    if (!["L", "M", "Q", "H"].includes(ecc)) throw new Error("誤り訂正の設定が不正です。");
    const qr = vendor.qrcode(0, ecc);
    qr.addData(String.fromCharCode(...payload), "Byte");
    try { qr.make(); } catch (_) { throw new Error("データが大きすぎます。誤り訂正の設定を変更してください。"); }
    return qr;
  }

  function render(payload, catalog, ecc = "M", tableVersion = catalog.default_version || "update") {
    assertAllowed(payload, catalog);
    const qr = makeQR(payload, ecc);
    const count = qr.getModuleCount();
    const size = (count + 8) * 8;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#000";
    let path = "";
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) {
      context.fillRect((col + 4) * 8, (row + 4) * 8, 8, 8);
      path += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${count + 8} ${count + 8}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`;
    const result = describe(payload, catalog, tableVersion);
    result.details["QRバージョン"] = (count - 17) / 4;
    return { ...result, game: catalog.game_id || "yw2", hex: [...payload].map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase(), length: payload.length, png: canvas.toDataURL("image/png"), svg, ecc, table_version: tableVersion };
  }

  async function readImage(value) {
    if (typeof value !== "string" || value.length > 14 * 1024 * 1024) throw new Error("画像は10MB以下にしてください。");
    const source = value.startsWith("data:image/") ? value : "data:image/png;base64," + value;
    const image = new Image();
    const ready = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("画像を読み込めませんでした。")); });
    image.src = source;
    await ready;
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 20_000_000) throw new Error("画像は2000万画素以下にしてください。");
    const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const find = () => vendor.jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    const result = find();
    if (!result) throw new Error("QRが見つかりません。");
    const points = [result.location.topLeftCorner, result.location.topRightCorner, result.location.bottomRightCorner, result.location.bottomLeftCorner];
    const center = { x: points.reduce((sum, point) => sum + point.x, 0) / 4, y: points.reduce((sum, point) => sum + point.y, 0) / 4 };
    context.fillStyle = "#fff";
    context.beginPath();
    points.forEach((point, index) => context[index ? "lineTo" : "moveTo"](center.x + (point.x - center.x) * 1.1, center.y + (point.y - center.y) * 1.1));
    context.closePath();
    context.fill();
    if (find()) throw new Error("QRを1つだけ含む画像を選択してください。");
    return Uint8Array.from(result.binaryData);
  }

  async function request(route, data = {}) {
    catalogPromise ||= fetch(new URL("./catalog.json?v=20261005-2", document.baseURI)).then(response => { if (!response.ok) throw new Error("アイテム一覧を読み込めませんでした。"); return response.json(); }).catch(error => { catalogPromise = null; throw error; });
    const rootCatalog = await catalogPromise;
    const game = data.game || "yw2";
    if (!["yw1", "yw2", "yw3", "busters", "busters2"].includes(game)) throw new Error("対応していない作品です。");
    const catalog = rootCatalog.game_id === game || !rootCatalog.game_id && game === "yw2" ? rootCatalog : rootCatalog.games?.[game];
    if (!catalog) throw new Error("作品のアイテム一覧を読み込めませんでした。");
    if (route === "/api/catalog") return catalog;
    let payload;
    if (route === "/api/generate") {
      if (game === "yw1" && data.format !== "raw" && !catalog.formats.some(format => format.id === data.format)) throw new Error("妖怪ウォッチ（初代）用のQR形式ではありません。");
      payload = data.format === "raw" ? parseHex(data.hex) : encode(data.format, data.fields?.qr_type, data.fields?.serial);
      if (data.template_hex && data.format !== "raw") {
        const template = decode(parseHex(data.template_hex));
        if (template?.profile === data.format && template.has_separator) payload = Uint8Array.from(template.uri_prefix + String.fromCharCode(...payload).split("/").pop(), char => char.charCodeAt(0));
      }
    } else if (route === "/api/decode") payload = data.hex !== undefined ? parseHex(data.hex) : await readImage(data.image);
    else throw new Error("対応していない操作です。");
    return render(payload, catalog, data.ecc || "M", data.table_version || catalog.default_version || "update");
  }

  return { encode, decode, checksum, parseHex, assertAllowed, rewardTable, rewardLabel, describe, makeQR, readImage, request };
})();

if (typeof module === "object" && module.exports) module.exports = QRLocal;
