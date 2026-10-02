"use strict";

const $ = (id) => document.getElementById(id);
const game = document.documentElement.dataset.game || "yw2";
const state = { catalog: null, format: null, tableVersion: "update", result: null, resultValid: false, series: null, usage: QRUsage.emptyStore(game), usageProfile: QRUsage.profileIds(game)[0], storageAvailable: true, template: null, templateFormat: null, sequence: 0, debounce: null, toastTimer: null, importing: false };

async function api(path, data = {}) { return QRLocal.request(path, { ...data, game }); }

function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  $("status-message").textContent = message;
  $("status-message").classList.toggle("error", error);
  $("status-message").hidden = false;
  state.toastTimer = setTimeout(() => { $("status-message").hidden = true; }, error ? 9000 : 3500);
}

function getFormat() { return state.catalog?.formats?.find((format) => format.id === state.format); }
function activeRewards() { return state.catalog ? QRLocal.rewardTable(state.catalog, state.tableVersion).rewards : []; }

function usageRecords() { return state.usage.profiles[state.usageProfile]; }

function loadUsage() {
  try {
    const saved = localStorage.getItem(QRUsage.storageKey(game));
    if (saved) state.usage = QRUsage.normalizeStore(JSON.parse(saved), game);
    const profile = localStorage.getItem(`${game}-qr-usage-profile`);
    if (QRUsage.profileIds(game).includes(profile)) state.usageProfile = profile;
  } catch (_) { state.storageAvailable = false; }
  $("usage-profile").replaceChildren(...QRUsage.profileIds(game).map(profile => new Option(QRUsage.profileLabel(game, profile), profile)));
  $("usage-profile").value = state.usageProfile;
}

function saveUsage() {
  try {
    localStorage.setItem(QRUsage.storageKey(game), JSON.stringify(state.usage));
    localStorage.setItem(`${game}-qr-usage-profile`, state.usageProfile);
  } catch (_) {
    state.storageAvailable = false;
    toast("このブラウザーにはメモを保存できません。JSONで保存してください。", true);
  }
}

function matchUsageEdition(version) {
  if (game !== "busters2") return;
  const edition = version.split("-")[0];
  const profile = edition + state.usageProfile.slice(-1);
  if (!QRUsage.profileIds(game).includes(profile) || profile === state.usageProfile) return;
  state.usageProfile = profile;
  $("usage-profile").value = profile;
  saveUsage();
}

function saveSession() {
  if (!state.resultValid) return;
  try {
    localStorage.setItem(`${game}-qr-session-v1`, JSON.stringify({ application: `${game}-qr-editor`, game, version: 1, hex: state.result.hex, ecc: $("ecc-select").value, table_version: state.tableVersion, series: state.series }));
  } catch (_) {  }
}

function restoreSeries(series) {
  const result = state.result;
  if (QRUsage.keyFor(result) && series?.format === result.format && series.type === result.fields.qr_type && Number.isInteger(series.start) && series.start >= 0 && series.start <= parseInt(result.fields.serial, 36)) {
    state.series = { format: series.format, type: series.type, start: series.start };
    renderPager();
  }
}

function renderUsage() {
  const key = state.resultValid ? QRUsage.keyFor(state.result) : null;
  const recorded = key && Object.hasOwn(usageRecords(), key);
  $("used-badge").textContent = !key ? "未生成" : recorded ? "使用済み（メモ）" : "未記録";
  $("used-badge").classList.toggle("recorded", Boolean(recorded));
  $("scan-used").textContent = $("used-badge").textContent;
  $("scan-used").classList.toggle("recorded", Boolean(recorded));
  $("scan-usage-profile").textContent = $("usage-profile").selectedOptions[0].textContent;
  $("toggle-used").textContent = recorded ? "この記録を取り消す" : "使用済みを記録";
  $("toggle-used").setAttribute("aria-pressed", String(Boolean(recorded)));
  $("toggle-used").disabled = !key;
  const next = nextSerial(false);
  $("mark-next").hidden = !next;
  for (const id of ["mark-next", "scan-mark-next"]) $(id).disabled = !key;
  $("mark-next").textContent = next ? "使用済みを記録して次へ" : "使用済みを記録";
  $("scan-mark-next").textContent = $("mark-next").textContent;
  $("next-unrecorded").disabled = !key || !next;
  renderHistory();
}

function markUsed(used = true) {
  const key = state.resultValid ? QRUsage.keyFor(state.result) : null;
  if (!key) return;
  if (used) { if (!Object.hasOwn(usageRecords(), key)) usageRecords()[key] = new Date().toISOString(); }
  else delete usageRecords()[key];
  saveUsage();
  renderUsage();
}

function nextSerial(skipRecorded) {
  const result = state.result;
  if (!state.resultValid || !QRUsage.keyFor(result) || result.format === "raw") return null;
  const { qr_type: type, serial } = result.fields;
  if (QRUsage.isSpecial(result.format, type, serial, game)) return null;
  const next = skipRecorded ? QRUsage.nextUnrecorded(result.format, type, serial, usageRecords(), game) : QRUsage.shiftedSerial(serial, 1);
  return QRUsage.isSpecial(result.format, type, next, game) ? null : next;
}

function renderPager() {
  const valid = state.resultValid && QRUsage.keyFor(state.result) && state.series;
  const page = valid ? parseInt(state.result.fields.serial, 36) - state.series.start + 1 : 1;
  $("page-number").textContent = `${page.toLocaleString()}枚目`;
  $("scan-page").textContent = $("page-number").textContent;
  for (const id of ["previous-qr", "scan-previous"]) $(id).disabled = !valid || page <= 1;
  for (const id of ["next-qr", "scan-next"]) $(id).disabled = !nextSerial(false);
}

async function navigateQR(direction = 1, skipRecorded = false) {
  if (!state.resultValid || !state.series) return;
  const current = state.result;
  const serial = direction < 0 ? QRUsage.shiftedSerial(current.fields.serial, -1) : nextSerial(skipRecorded);
  if (!serial || parseInt(serial, 36) < state.series.start) return;
  state.format = current.format;
  $("format-select").value = state.format;
  $("field-qr_type").value = current.fields.qr_type;
  $("field-serial").value = serial;
  invalidateResult();
  await generate({ quiet: true, preserveSeries: true });
}

async function markAndNext() {
  if (!state.resultValid) return;
  markUsed(true);
  if (nextSerial(true)) await navigateQR(1, true);
  else toast("使用済みとして記録しました。この種類番号の後続に未記録のQRはありません。");
}

function renderHistory() {
  const allCount = QRUsage.profileIds(game).reduce((sum, profile) => sum + Object.keys(state.usage.profiles[profile]).length, 0);
  const rows = Object.entries(usageRecords()).sort((a, b) => b[1].localeCompare(a[1]));
  $("history-summary").textContent = `${$("usage-profile").selectedOptions[0].textContent}：${rows.length.toLocaleString()}件の使用メモ（全セーブ合計 ${allCount.toLocaleString()}件）`;
  $("history-list").replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.textContent = "使用メモはまだありません。QRを読み取ったら「使用済みを記録」を押してください。";
    $("history-list").append(empty);
  }
  rows.slice(0, 20).forEach(([key, timestamp]) => {
    const [profile, type, serial] = key.split(":");
    const reward = activeRewards().find(row => row.profile === profile && row.start <= parseInt(type, 36) && row.end >= parseInt(type, 36));
    const item = document.createElement("li");
    const label = document.createElement("strong");
    const special = state.catalog?.special_qrs?.find(row => row.serial === serial && row.qr_type === type && row.profile === profile);
    label.textContent = QRUsage.isSpecial(profile, type, serial, game) ? special?.label || "特殊QR" : reward ? QRLocal.rewardLabel(reward, state.catalog, state.tableVersion) : "ランダム報酬";
    const code = document.createElement("span");
    code.className = "mono";
    code.textContent = `${profile === "yw2" ? "3桁形式" : "2桁形式"} · ${type} / ${serial}`;
    const date = document.createElement("time");
    date.textContent = new Date(timestamp).toLocaleString("ja-JP");
    item.append(label, code, date);
    $("history-list").append(item);
  });
}

function showHistory() {
  setMainView(false);
  renderHistory();
  $("history-section").hidden = false;
  $("history-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function importUsage(file) {
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("使用メモは10MB以下にしてください。");
    const input = JSON.parse(await file.text());
    if (input?.application && input.application !== `${game}-qr-usage`) throw new Error("別の作品の使用メモです。対応する作品のエディターで開いてください。");
    const incoming = QRUsage.normalizeStore(input, game);
    const merged = QRUsage.normalizeStore(state.usage, game);
    for (const profile of QRUsage.profileIds(game)) Object.assign(merged.profiles[profile], incoming.profiles[profile]);
    state.usage = QRUsage.normalizeStore(merged, game);
    saveUsage();
    renderUsage();
    showHistory();
    toast("使用メモを読み込みました。既存の記録と合わせて保存しました。");
  } catch (error) { toast(error instanceof SyntaxError ? "JSONファイルを読み取れませんでした。" : error.message, true); }
  finally { $("history-file-input").value = ""; }
}

function normalizeHex(value) {
  const text = String(value ?? "").replace(/\s/g, "");
  if (/[^0-9a-f]/i.test(text)) throw new Error("16進数には 0–9 と A–F を入力してください。");
  if (text.length % 2) throw new Error("16進数は1バイトにつき2桁で入力してください。");
  if (!text.length) throw new Error("生成するデータを入力してください。");
  return text.toUpperCase();
}

function formatHex(value) {
  const bytes = String(value || "").replace(/\s/g, "").toUpperCase().match(/.{1,2}/g) || [];
  return Array.from({ length: Math.ceil(bytes.length / 16) }, (_, i) => bytes.slice(i * 16, i * 16 + 16).join(" ")).join("\n");
}

function makeField(field, values) {
  const wrapper = document.createElement("div");
  wrapper.className = "field" + (field.type === "hex" || field.wide || (field.type === "text" && !field.options && !["qr_type", "serial"].includes(field.name)) ? " field-wide" : "");
  const label = document.createElement("label");
  const id = `field-${field.name}`;
  label.htmlFor = id;
  label.textContent = field.label || field.name;
  wrapper.append(label);
  let input;
  if (field.options?.length) {
    input = document.createElement("select");
    field.options.forEach((option) => {
      const node = document.createElement("option");
      node.value = String(option.value);
      node.textContent = option.label;
      input.append(node);
    });
  } else {
    input = document.createElement("input");
    input.type = field.type === "number" ? "number" : "text";
    if (field.type === "number") {
      input.step = String(field.step ?? 1);
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
    }
    if (field.type === "hex") { input.classList.add("mono"); input.spellcheck = false; }
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.maxLength) input.maxLength = field.maxLength;
  }
  input.id = id;
  input.dataset.field = field.name;
  if (["serial", "qr_type"].includes(field.name) && input.tagName === "INPUT") {
    input.classList.add("mono");
    input.spellcheck = false;
    input.autocapitalize = "characters";
    input.addEventListener("input", () => { const start = input.selectionStart; input.value = input.value.toUpperCase(); if (start !== null) input.setSelectionRange(start, start); });
  }
  input.value = values?.[field.name] ?? field.default ?? "";
  if (field.readonly || field.readOnly) input.disabled = true;
  if (field.options?.length && input.value === "" && values?.[field.name] !== undefined) {
    const unknown = document.createElement("option");
    unknown.value = String(values[field.name]);
    unknown.textContent = `未登録の値 (${values[field.name]})`;
    input.append(unknown);
    input.value = unknown.value;
  }
  input.addEventListener("input", markEdited);
  input.addEventListener("change", markEdited);
  wrapper.append(input);
  if (field.name === "serial") {
    const controls = document.createElement("div");
    controls.className = "serial-controls";
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "番号を +1";
    next.addEventListener("click", () => { if (!/^[0-9A-Z]{4}$/.test(input.value)) { toast("個体番号を4桁の36進数で入力してください。", true); return; } input.value = ((parseInt(input.value, 36) + 1) % 1679616).toString(36).toUpperCase().padStart(4, "0"); markEdited(); });
    const random = document.createElement("button");
    random.type = "button";
    random.textContent = "ランダム";
    random.title = "未使用の番号であることは保証されません";
    random.addEventListener("click", () => { const number = crypto.getRandomValues(new Uint32Array(1))[0] % 1679616; input.value = number.toString(36).toUpperCase().padStart(4, "0"); markEdited(); });
    controls.append(next, random);
    wrapper.append(controls);
  }
  if (field.help) {
    const help = document.createElement("p");
    help.className = "field-help";
    help.id = `${id}-help`;
    help.textContent = field.help;
    input.setAttribute("aria-describedby", help.id);
    wrapper.append(help);
  }
  return wrapper;
}

function renderFields(values) {
  const format = getFormat();
  $("dynamic-fields").replaceChildren();
  $("format-description").textContent = format?.description || "";
  (format?.fields || []).forEach((field) => $("dynamic-fields").append(makeField(field, values)));
  $("template-note").hidden = !(state.template && state.templateFormat === state.format);
  $("reward-search").value = "";
  renderRewards();
  if (game === "busters2" && !values && !profileRewards().length) {
    const preset = state.catalog.special_qrs?.find(row => row.profile === state.format && row.version_effects?.[state.tableVersion]);
    if (preset) {
      $("field-qr_type").value = preset.qr_type;
      $("field-serial").value = preset.serial;
    }
  }
}

function profileRewards() {
  return QRUsage.groupRewards(activeRewards(), state.format);
}

function renderRewards() {
  const rewards = profileRewards();
  const labels = new Map();
  for (const reward of rewards) {
    const label = QRLocal.rewardLabel(reward, state.catalog, state.tableVersion);
    labels.set(label, (labels.get(label) || 0) + 1);
  }
  $("reward-picker").hidden = !rewards.length;
  const search = $("reward-search").value.trim().normalize("NFKC").toLocaleLowerCase();
  const filtered = rewards.filter((reward) => [reward.label, reward.qr_type, reward.start, reward.end, reward.item_id].some((value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase().includes(search)));
  $("reward-count").textContent = `${filtered.length} / ${rewards.length} 種類`;
  $("reward-select").replaceChildren(new Option(filtered.length ? "一覧から選択" : "一致する候補がありません", ""));
  filtered.forEach((reward) => {
    const label = QRLocal.rewardLabel(reward, state.catalog, state.tableVersion);
    const choiceLabel = game === "busters2" && labels.get(label) > 1 ? `${label}（種類 ${reward.qr_type}）` : label;
    $("reward-select").append(new Option(choiceLabel, String(reward.index)));
  });
}

function selectReward() {
  if ($("reward-select").value === "") return;
  const reward = profileRewards().find(row => row.index === Number($("reward-select").value));
  const input = document.getElementById("field-qr_type");
  if (!reward || !input) return;
  input.value = reward.qr_type ?? reward.start;
  $("field-serial").value = "0000";
  state.template = null;
  state.templateFormat = null;
  $("template-note").hidden = true;
  markEdited();
  generate({ quiet: true });
}

function applySpecialPreset(preset) {
  state.format = preset.profile;
  state.template = null;
  state.templateFormat = null;
  $("format-select").value = state.format;
  renderFields({ qr_type: preset.qr_type, serial: preset.serial });
  generate({ quiet: true });
}

function initSpecialPresets() {
  $("special-presets").replaceChildren();
  for (const preset of state.catalog.special_qrs || []) {
    const row = document.createElement("div");
    row.className = "special-picker";
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = preset.label;
    const description = document.createElement("p");
    description.textContent = preset.description;
    const button = document.createElement("button");
    button.className = "button secondary";
    button.id = preset.serial === "ZZZZ" ? "panda-preset" : "zzzy-preset";
    button.type = "button";
    button.textContent = "表示";
    button.addEventListener("click", () => applySpecialPreset(preset));
    text.append(title, description);
    row.append(text, button);
    $("special-presets").append(row);
  }
}

function collectFields() {
  const values = {};
  for (const field of getFormat()?.fields || []) {
    const input = document.getElementById(`field-${field.name}`);
    if (!input) continue;
    if (field.type === "number") {
      if (input.value === "" || !Number.isFinite(Number(input.value))) throw new Error(`${field.label || field.name} を入力してください。`);
      const value = Number(input.value);
      if (!Number.isInteger(value) && field.step !== "any") throw new Error(`${field.label || field.name} は整数で入力してください。`);
      if (field.min !== undefined && value < field.min) throw new Error(`${field.label || field.name} は ${field.min} 以上で入力してください。`);
      if (field.max !== undefined && value > field.max) throw new Error(`${field.label || field.name} は ${field.max} 以下で入力してください。`);
      values[field.name] = value;
    } else values[field.name] = input.value;
  }
  return values;
}

function invalidateResult() {
  clearTimeout(state.debounce);
  state.sequence++;
  state.resultValid = false;
  document.querySelector(".preview-card").classList.remove("loading");
  $("generate-button").disabled = !state.catalog;
  for (const id of ["download-png", "download-svg", "download-project", "open-scan"]) $(id).disabled = true;
  if (state.result) {
    $("preview-caption").textContent = "編集内容を生成すると更新されます";
    $("preview-dot").classList.remove("ready");
    $("edit-state").textContent = "未生成の変更あり";
  }
  renderPager();
  renderUsage();
}

function markEdited() { state.series = null; invalidateResult(); }

function renderResult(result) {
  state.result = result;
  state.resultValid = true;
  if (QRUsage.keyFor(result) && (!state.series || state.series.format !== result.format || state.series.type !== result.fields.qr_type)) state.series = { format: result.format, type: result.fields.qr_type, start: parseInt(result.fields.serial, 36) };
  if (result.png) {
    $("qr-image").src = result.png;
    $("qr-image").hidden = false;
    $("empty-preview").hidden = true;
  } else { $("qr-image").hidden = true; $("empty-preview").hidden = false; }
  $("preview-dot").classList.add("ready");
  $("preview-caption").textContent = `誤り訂正 ${$("ecc-select").value}`;
  $("edit-state").textContent = "生成済み";
  const warnings = (result.warnings || []).filter(warning => warning && warning !== "実機での読取・受取は未検証です。");
  $("warnings").replaceChildren();
  warnings.forEach((warning) => { const p = document.createElement("p"); p.textContent = typeof warning === "string" ? warning : JSON.stringify(warning); $("warnings").append(p); });
  $("warnings").hidden = !warnings.length;
  $("download-png").disabled = !result.png;
  $("download-svg").disabled = !result.svg;
  $("download-project").disabled = false;
  $("open-scan").disabled = !result.png;
  $("reward-name").textContent = result.details?.["表示名"] || result.details?.["報酬"] || "自由なバイト列";
  const matchedReward = activeRewards().find(row => row.profile === result.format && row.start <= parseInt(result.fields?.qr_type, 36) && row.end >= parseInt(result.fields?.qr_type, 36));
  const selected = matchedReward && profileRewards().find(row => (row.reward_group ?? row.item_id) === (matchedReward.reward_group ?? matchedReward.item_id));
  $("reward-select").value = !result.details?.["特殊処理（認証成功時）"] && selected ? String(selected.index) : "";
  $("qr-identity").textContent = result.fields?.serial ? `種類 ${result.fields.qr_type} / 個体番号 ${result.fields.serial}` : `${result.length} bytes`;
  $("scan-title").textContent = $("reward-name").textContent;
  $("scan-image").src = result.png || "";
  $("scan-caption").textContent = $("qr-identity").textContent;
  renderPager();
  renderUsage();
  saveSession();
}

async function generate({ quiet = false, preserveSeries = false } = {}) {
  if (!state.catalog) return;
  const sequence = ++state.sequence;
  try {
    const request = { format: state.format, fields: collectFields(), ecc: $("ecc-select").value, table_version: state.tableVersion };
    if (state.template && state.templateFormat === state.format) request.template_hex = state.template;
    if (!preserveSeries) state.series = null;
    state.resultValid = false;
    renderPager();
    renderUsage();
    $("generate-button").disabled = true;
    document.querySelector(".preview-card").classList.add("loading");
    const result = await api("/api/generate", request);
    if (sequence !== state.sequence) return;
    renderResult(result);
    if (!quiet) toast("QRコードを生成しました。");
    return result;
  } catch (error) {
    if (sequence !== state.sequence) return;
    state.resultValid = false;
    renderPager();
    renderUsage();
    $("preview-caption").textContent = "生成できませんでした。入力を確認してください";
    $("preview-dot").classList.remove("ready");
    for (const id of ["download-png", "download-svg", "download-project"]) $(id).disabled = true;
    toast(error.message, true);
  } finally {
    if (sequence === state.sequence) { $("generate-button").disabled = false; document.querySelector(".preview-card").classList.remove("loading"); }
  }
}

async function applyDecoded(decoded, ecc) {
  const format = state.catalog.formats.find(item => item.id === decoded.format);
  if (!format || format.id === "raw") throw new Error("対応するゲーム用QRではありません。");
  if (!decoded.hex) throw new Error("QRデータを読み取れませんでした。");
  if (Object.hasOwn(state.catalog.versions, decoded.table_version)) {
    const changed = state.tableVersion !== decoded.table_version;
    state.tableVersion = decoded.table_version;
    if (changed) matchUsageEdition(state.tableVersion);
    $("version-select").value = state.tableVersion;
    $("password-version").value = state.tableVersion;
    renderPasswordRewards();
  }
  state.template = normalizeHex(decoded.hex);
  state.series = null;
  state.templateFormat = decoded.format;
  const correction = ecc ?? decoded.ecc;
  if (["L", "M", "Q", "H"].includes(correction)) $("ecc-select").value = correction;
  state.format = format.id;
  $("format-select").value = state.format;
  renderFields(decoded.fields);
  renderResult(decoded);
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("ファイルを読み取れませんでした。")); reader.readAsDataURL(file); });
}

async function importFile(file) {
  if (!file || state.importing) return;
  state.importing = true;
  $("import-error").hidden = true;
  $("drop-zone").setAttribute("aria-busy", "true");
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("10 MB以下のファイルを選択してください。");
    let decoded;
    let ecc;
    let savedSeries;
    if (/\.json$/i.test(file.name) || file.type === "application/json") {
      let project;
      try { project = JSON.parse(await file.text()); } catch (_) { throw new Error("JSONファイルの形式を読み取れませんでした。"); }
      if (!project || typeof project !== "object" || Array.isArray(project)) throw new Error("有効なプロジェクトファイルではありません。");
      const projectGame = project.game || /^(yw[23]|busters2?)-qr-editor$/.exec(project.application || "")?.[1];
      if (projectGame && projectGame !== game) throw new Error("別の作品のQRデータです。対応する作品のエディターで開いてください。");
      ecc = ["L", "M", "Q", "H"].includes(project.ecc) ? project.ecc : $("ecc-select").value;
      const tableVersion = Object.hasOwn(state.catalog.versions, project.table_version) ? project.table_version : state.tableVersion;
      savedSeries = project.series;
      if (project.hex) decoded = await api("/api/decode", { hex: normalizeHex(project.hex), ecc, table_version: tableVersion });
      else if (project.format && project.fields && typeof project.fields === "object") decoded = await api("/api/generate", { format: project.format, fields: project.fields, ecc, table_version: tableVersion, ...(project.template_hex ? { template_hex: project.template_hex } : {}) });
      else throw new Error("QRのバイト列または編集データを含むJSONを選択してください。");
    } else {
      if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) throw new Error("QR画像またはJSONプロジェクトを選択してください。");
      decoded = await api("/api/decode", { image: await readAsDataURL(file), ecc: $("ecc-select").value, table_version: state.tableVersion });
    }
    await applyDecoded(decoded, ecc);
    restoreSeries(savedSeries);
    saveSession();
    $("import-dialog").close();
    toast(`「${file.name}」を読み込みました。`);
  } catch (error) { $("import-error").textContent = error.message; $("import-error").hidden = false; }
  finally { state.importing = false; $("drop-zone").removeAttribute("aria-busy"); $("file-input").value = ""; }
}

function download(blob, extension, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || `${game}-qr-${state.result?.format || "raw"}-${state.result?.fields?.qr_type || "data"}-${state.result?.fields?.serial || "binary"}.${extension}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadPNG() {
  if (!state.result?.png) return;
  try { const response = await fetch(state.result.png); download(await response.blob(), "png"); }
  catch (_) { toast("PNG画像を保存できませんでした。", true); }
}

function saveProject() {
  if (!state.result) return;
  const project = { application: `${game}-qr-editor`, game, version: 1, format: state.result.format || state.format, table_version: state.tableVersion, fields: state.result.fields || {}, hex: state.result.hex, ecc: $("ecc-select").value, series: state.series, ...(state.template ? { template_hex: state.template } : {}) };
  download(new Blob([JSON.stringify(project, null, 2) + "\n"], { type: "application/json;charset=utf-8" }), "json");
}

function setMainView(passwords, updateHash = true) {
  document.querySelector(".workspace").hidden = passwords;
  $("password-section").hidden = !passwords;
  for (const [id, selected] of [["nav-editor", !passwords], ["nav-passwords", passwords]]) {
    $(id).classList.toggle("selected", selected);
    $(id).setAttribute("aria-pressed", String(selected));
  }
  if (passwords) { $("history-section").hidden = true; $("notes-section").hidden = true; }
  if (updateHash) {
    const url = new URL(location.href);
    if (passwords) url.hash = "passwords";
    else if (url.hash === "#passwords") url.hash = "";
    history.replaceState(null, "", url);
  }
}

function passwordRows() {
  const version = $("password-version").value;
  const rows = state.catalog?.passwords?.[version] || [];
  return $("password-aliases").checked ? rows.concat(state.catalog?.password_aliases?.[version] || []) : rows;
}

function renderPasswordRewards() {
  const selected = $("password-reward").value;
  const rewards = [...new Set(passwordRows().map(row => row.reward))];
  $("password-reward").replaceChildren(new Option("すべて", ""), ...rewards.map(reward => new Option(reward, reward)));
  $("password-reward").value = rewards.includes(selected) ? selected : "";
  renderPasswords();
}

function renderPasswords() {
  const normalize = text => String(text).normalize("NFKC").toLocaleLowerCase("ja").replace(/\s/g, "");
  const query = normalize($("password-search").value);
  const reward = $("password-reward").value;
  const all = passwordRows();
  const rows = all.filter(row => (!reward || row.reward === reward) && (!query || normalize(row.password).includes(query) || normalize(row.reward).includes(query)));
  $("password-count").textContent = rows.length === all.length ? `${all.length}件` : `${rows.length} / ${all.length}件`;
  $("password-list").replaceChildren(...rows.map(row => {
    const tr = document.createElement("tr");
    const password = document.createElement("td");
    password.className = "password-value";
    password.textContent = row.password;
    if (row.generated) {
      const badge = document.createElement("span");
      badge.className = "password-kind";
      badge.textContent = "解析";
      password.append(badge);
    }
    const item = document.createElement("td");
    item.className = "password-item";
    item.textContent = row.reward + (row.quantity > 1 ? ` ×${row.quantity}` : "");
    const action = document.createElement("td");
    action.className = "password-action";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "text-button";
    copy.textContent = "コピー";
    copy.setAttribute("aria-label", `「${row.password}」をコピー`);
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(row.password); toast("パスワードをコピーしました。"); }
      catch (_) { toast("コピーできませんでした。表示された文字列を選択してコピーしてください。", true); }
    });
    action.append(copy);
    tr.append(password, item, action);
    return tr;
  }));
  $("password-empty").hidden = rows.length > 0;
  $("password-note").textContent = state.catalog?.password_notes?.[$("password-version").value] || "";
}

function initPasswords() {
  $("password-version").replaceChildren(...Object.entries(state.catalog.versions).map(([version, label]) => new Option(label, version)));
  $("password-alias-option").hidden = !Object.values(state.catalog.password_aliases || {}).some(rows => rows.length);
  const sources = state.catalog.password_sources || [];
  $("password-sources").replaceChildren();
  $("password-sources").hidden = !sources.length;
  if (sources.length) {
    $("password-sources").append("入力文字列の参照元：");
    sources.forEach((source, index) => {
      const link = document.createElement("a");
      link.href = source.url;
      link.textContent = source.title;
      if (index) $("password-sources").append(" / ");
      $("password-sources").append(link);
    });
  }
  renderPasswordRewards();
  setMainView(location.hash === "#passwords", false);
}

function changeTableVersion(version) {
  const changed = state.tableVersion !== version;
  state.tableVersion = version;
  if (changed) matchUsageEdition(version);
  $("version-select").value = version;
  $("password-version").value = version;
  renderRewards();
  renderPasswordRewards();
  invalidateResult();
  generate({ quiet: true, preserveSeries: true });
}

function openImport() { setMainView(false); $("import-error").hidden = true; $("import-dialog").showModal(); }
function showNotes() { setMainView(false); $("notes-section").hidden = false; $("notes-section").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }); }

function bindEvents() {
  loadUsage();
  $("previous-qr").addEventListener("click", () => navigateQR(-1));
  $("next-qr").addEventListener("click", () => navigateQR(1));
  $("scan-previous").addEventListener("click", () => navigateQR(-1));
  $("scan-next").addEventListener("click", () => navigateQR(1));
  $("next-unrecorded").addEventListener("click", () => navigateQR(1, true));
  $("toggle-used").addEventListener("click", () => { const key = QRUsage.keyFor(state.result); if (key) markUsed(!Object.hasOwn(usageRecords(), key)); });
  $("mark-next").addEventListener("click", markAndNext);
  $("scan-mark-next").addEventListener("click", markAndNext);
  $("usage-profile").addEventListener("change", () => { state.usageProfile = $("usage-profile").value; saveUsage(); renderUsage(); });
  $("nav-history").addEventListener("click", showHistory);
  $("close-history").addEventListener("click", () => { $("history-section").hidden = true; });
  $("download-history").addEventListener("click", () => download(new Blob([JSON.stringify(state.usage, null, 2) + "\n"], { type: "application/json" }), "json", `${game}-usage-memo.json`));
  $("import-history").addEventListener("click", () => $("history-file-input").click());
  $("history-file-input").addEventListener("change", event => importUsage(event.target.files[0]));
  $("open-scan").addEventListener("click", () => $("scan-dialog").showModal());
  $("close-scan").addEventListener("click", () => $("scan-dialog").close());
  document.addEventListener("keydown", event => {
    if (event.ctrlKey || event.altKey || event.metaKey || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName) || $("import-dialog").open || !$("password-section").hidden) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); navigateQR(event.key === "ArrowRight" ? 1 : -1); }
  });
  $("drop-zone").tabIndex = 0;
  $("drop-zone").setAttribute("role", "button");
  $("file-input").tabIndex = -1;
  $("drop-zone").addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); $("file-input").click(); } });
  $("format-select").addEventListener("change", () => { state.format = $("format-select").value; state.template = null; state.templateFormat = null; renderFields(); invalidateResult(); if (game === "busters2" && !profileRewards().length && state.catalog.special_qrs?.some(row => row.profile === state.format && row.qr_type === $("field-qr_type").value && row.serial === $("field-serial").value && row.version_effects?.[state.tableVersion])) generate({ quiet: true }); });
  $("version-select").addEventListener("change", () => changeTableVersion($("version-select").value));
  $("reward-search").addEventListener("input", renderRewards);
  $("reward-select").addEventListener("change", selectReward);
  $("ecc-select").addEventListener("change", markEdited);
  $("generate-button").addEventListener("click", () => generate());
  $("nav-import").addEventListener("click", openImport);
  $("close-import").addEventListener("click", () => $("import-dialog").close());
  $("import-dialog").addEventListener("click", (event) => { if (event.target === $("import-dialog")) { const bounds = $("import-dialog").getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $("import-dialog").close(); } });
  $("file-input").addEventListener("change", (event) => importFile(event.target.files[0]));
  for (const name of ["dragenter", "dragover"]) $("drop-zone").addEventListener(name, (event) => { event.preventDefault(); $("drop-zone").classList.add("dragover"); });
  for (const name of ["dragleave", "drop"]) $("drop-zone").addEventListener(name, (event) => { event.preventDefault(); $("drop-zone").classList.remove("dragover"); });
  $("drop-zone").addEventListener("drop", (event) => importFile(event.dataTransfer.files[0]));
  $("nav-notes").addEventListener("click", showNotes);
  $("close-notes").addEventListener("click", () => { $("notes-section").hidden = true; });
  $("nav-editor").addEventListener("click", () => { setMainView(false); document.querySelector(".workspace").scrollIntoView({ behavior: "smooth" }); });
  $("nav-passwords").addEventListener("click", () => { setMainView(true); $("password-section").scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("password-search").addEventListener("input", renderPasswords);
  $("password-reward").addEventListener("change", renderPasswords);
  $("password-version").addEventListener("change", () => changeTableVersion($("password-version").value));
  $("password-aliases").addEventListener("change", renderPasswordRewards);
  window.addEventListener("hashchange", () => setMainView(location.hash === "#passwords", false));
  $("download-png").addEventListener("click", downloadPNG);
  $("download-svg").addEventListener("click", () => state.result?.svg && download(new Blob([state.result.svg], { type: "image/svg+xml;charset=utf-8" }), "svg"));
  $("download-project").addEventListener("click", saveProject);
}

async function init() {
  bindEvents();
  $("generate-button").disabled = true;
  try {
    state.catalog = await api("/api/catalog");
    state.tableVersion = state.catalog.default_version || (Object.hasOwn(state.catalog.versions, "update") ? "update" : Object.keys(state.catalog.versions)[0]);
    initSpecialPresets();
    initPasswords();
    $("version-select").replaceChildren(...Object.entries(state.catalog.versions).map(([version, label]) => new Option(label, version)));
    $("version-select").value = state.tableVersion;
    $("password-version").value = state.tableVersion;
    renderPasswordRewards();
    const formats = (state.catalog.formats || []).filter((format) => format.id !== "raw");
    $("format-select").replaceChildren();
    formats.forEach((format) => { const option = document.createElement("option"); option.value = format.id; option.textContent = format.label || format.id; $("format-select").append(option); });
    $("format-select").disabled = !formats.length;
    const notes = state.catalog.notes || [];
    $("catalog-notes").replaceChildren();
    const list = document.createElement("ul");
    (Array.isArray(notes) ? notes : [notes]).forEach((note) => { const item = document.createElement("li"); item.textContent = typeof note === "string" ? note : JSON.stringify(note); list.append(item); });
    $("catalog-notes").append(list);
    $("generate-button").disabled = false;
    if (formats.length) {
      state.format = formats[0].id;
      renderFields();
      if (game === "busters2") {
        const first = profileRewards()[0];
        if (first) $("field-qr_type").value = first.qr_type;
      }
      let session;
      try { session = JSON.parse(localStorage.getItem(`${game}-qr-session-v1`)); } catch (_) {  }
      if (session?.application === `${game}-qr-editor` && session.version === 1 && typeof session.hex === "string") {
        try {
          const decoded = await api("/api/decode", { hex: session.hex, ecc: session.ecc, table_version: session.table_version });
          await applyDecoded(decoded, session.ecc);
          restoreSeries(session.series);
          saveSession();
          $("edit-state").textContent = "前回の続き";
        } catch (_) { await generate({ quiet: true }); }
      } else await generate({ quiet: true });
    }
    else throw new Error("アイテム一覧を読み込めませんでした。");
  } catch (error) {
    $("format-select").replaceChildren(new Option("形式を読み込めませんでした", ""));
    $("empty-preview").querySelector("strong").textContent = "読み込みに失敗しました";
    $("empty-preview").querySelector("span").textContent = "ページを再読み込みしてください";
    toast(error.message, true);
  }
}

init();
