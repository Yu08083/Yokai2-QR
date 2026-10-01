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

  function describe(payload, catalog, tableVersion = "update") {
    if (!["base", "update"].includes(tableVersion)) throw new Error("報酬表のバージョンが不正です。");
    const parsed = decode(payload);
    const warnings = [];
    const details = { payload: [...payload].map(byte => byte < 128 ? String.fromCharCode(byte) : "\\x" + byte.toString(16).padStart(2, "0")).join(""), "報酬表": tableVersion === "update" ? "更新版 v3.4.0" : "本体版 v0.1.0" };
    if (!parsed) return { format: "raw", fields: {}, warnings: ["対応するゲーム用QRの形式ではありません。"], details };
    const fields = { qr_type: parsed.qr_type, serial: parsed.serial };
    details.checksum_valid = parsed.checksum_valid;
    details["検証文字列"] = parsed.checksum_valid ? "一致" : "不一致";
    if (!parsed.checksum_valid) warnings.push("検証文字列が一致しません。生成し直すと再計算します。");
    if (!parsed.has_separator) warnings.push("URLの区切りがありません。ゲーム用には生成し直してください。");
    if (parsed.profile === "yw1-jp" && fields.qr_type + fields.serial === "P1ZZZZ") {
      details["特殊処理（認証成功時）"] = "ツチノコパンダのすれちがい送信開始フラグを設定";
      details["報酬"] = "アイテム付与なし（専用分岐）";
      warnings.push("読み取り後、さすらい荘で登録・更新し、別の3DSとすれちがってください。「使用済み」と表示されても送信準備が進む処理です。受信側での出現報告があります。");
      return { format: parsed.profile, fields, warnings, details };
    }
    const rows = tableVersion === "update" ? catalog.rewards : catalog.base_rewards;
    const number = parseInt(fields.qr_type, 36);
    const reward = rows.find(row => row.profile === parsed.profile && row.start <= number && number <= row.end);
    if (reward) {
      details["報酬"] = reward.label || reward.name;
      details["アイテムID"] = "0x" + reward.item_id.toString(16).toUpperCase().padStart(8, "0");
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

  function render(payload, catalog, ecc = "M", tableVersion = "update") {
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
    return { ...result, hex: [...payload].map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase(), length: payload.length, png: canvas.toDataURL("image/png"), svg, ecc, table_version: tableVersion };
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

  async function request(route, data) {
    catalogPromise ||= fetch(new URL("./catalog.json", document.baseURI)).then(response => { if (!response.ok) throw new Error("アイテム一覧を読み込めませんでした。"); return response.json(); }).catch(error => { catalogPromise = null; throw error; });
    const catalog = await catalogPromise;
    if (route === "/api/catalog") return catalog;
    let payload;
    if (route === "/api/generate") {
      payload = data.format === "raw" ? parseHex(data.hex) : encode(data.format, data.fields?.qr_type, data.fields?.serial);
      if (data.template_hex && data.format !== "raw") {
        const template = decode(parseHex(data.template_hex));
        if (template?.profile === data.format && template.has_separator) payload = Uint8Array.from(template.uri_prefix + String.fromCharCode(...payload).split("/").pop(), char => char.charCodeAt(0));
      }
    } else if (route === "/api/decode") payload = data.hex !== undefined ? parseHex(data.hex) : await readImage(data.image);
    else throw new Error("対応していない操作です。");
    return render(payload, catalog, data.ecc || "M", data.table_version || "update");
  }

  return { encode, decode, checksum, parseHex, describe, makeQR, readImage, request };
})();

if (typeof module === "object" && module.exports) module.exports = QRLocal;
