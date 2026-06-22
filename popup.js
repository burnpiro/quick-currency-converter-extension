const DEFAULT_CODES = ["USD", "EUR", "GBP"];
const STORAGE_KEYS = {
  selected: "selectedCurrencies",
  names: "currencyNames",
  lastBase: "lastBaseCurrency",
  values: "currencyValues"
};

const PRIMARY_ENDPOINTS = {
  currencies: [
    "https://api.exchangerate.fun/currencies",
    "https://api.exchangerate.fun/v1/currencies",
    "https://exchangerate.fun/currencies",
    "https://exchangerate.fun/api/currencies"
  ],
  latest: [
    (base) => `https://api.exchangerate.fun/latest?base=${encodeURIComponent(base)}`,
    (base) => `https://api.exchangerate.fun/v1/latest?base=${encodeURIComponent(base)}`,
    (base) => `https://exchangerate.fun/latest?base=${encodeURIComponent(base)}`,
    (base) => `https://exchangerate.fun/api/latest?base=${encodeURIComponent(base)}`
  ]
};

const FALLBACK_ENDPOINTS = {
  currencies: ["https://api.frankfurter.dev/v1/currencies"],
  latest: [(base) => `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}`]
};

const USE_FALLBACK_ONLY = false;
const DEBOUNCE_MS = 350;

const state = {
  currencies: {},
  selected: [...DEFAULT_CODES],
  rates: null,
  base: "USD",
  provider: "",
  savedNames: {},
  values: {},
  activeInput: null,
  debounceTimer: null
};

const els = {
  addButton: document.querySelector("#add-button"),
  currencyList: document.querySelector("#currency-list"),
  datalist: document.querySelector("#currency-options"),
  rateMeta: document.querySelector("#rate-meta"),
  refreshButton: document.querySelector("#refresh-button"),
  search: document.querySelector("#currency-search"),
  status: document.querySelector("#status"),
  template: document.querySelector("#currency-row-template")
};

document.addEventListener("DOMContentLoaded", init);
els.addButton.addEventListener("click", addCurrencyFromSearch);
els.refreshButton.addEventListener("click", () => refreshRates(state.base, { force: true }));
els.search.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addCurrencyFromSearch();
  }
});

async function init() {
  renderRows();
  setStatus("Loading currencies...");

  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  state.selected = normalizeSelected(stored[STORAGE_KEYS.selected]);
  state.savedNames = normalizeSavedNames(stored[STORAGE_KEYS.names]);
  state.currencies = { ...state.savedNames };
  state.base = normalizeCode(stored[STORAGE_KEYS.lastBase]) || state.selected[0] || "USD";
  state.values = stored[STORAGE_KEYS.values] && typeof stored[STORAGE_KEYS.values] === "object"
    ? stored[STORAGE_KEYS.values]
    : {};

  renderRows();

  try {
    state.currencies = {
      ...state.savedNames,
      ...await getCurrencies()
    };
    ensureSelectedCurrenciesHaveNames();
    syncSavedNames();
    renderCurrencyOptions();
    updateRows();
    await refreshRates(state.base, { force: true });
  } catch (error) {
    setStatus(`Could not load rates: ${error.message}`, "error");
    els.rateMeta.textContent = "Rates unavailable";
  }
}

function normalizeSelected(value) {
  if (!Array.isArray(value)) {
    return [...DEFAULT_CODES];
  }

  const unique = [...new Set(value.map(normalizeCode).filter(Boolean))];
  return unique.length ? unique : [...DEFAULT_CODES];
}

function normalizeSavedNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([code, name]) => [normalizeCode(code), String(name || "").trim()])
      .filter(([code, name]) => /^[A-Z]{3}$/.test(code) && name)
  );
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

async function getCurrencies() {
  const response = await fetchFirstJson([
    ...getPrimaryCurrencyRequests(),
    ...FALLBACK_ENDPOINTS.currencies.map((url) => ({ url, provider: "frankfurter.dev" }))
  ]);

  state.provider = response.provider;
  return normalizeCurrencyMap(response.data);
}

async function refreshRates(base, options = {}) {
  const nextBase = normalizeCode(base) || state.selected[0] || "USD";
  if (!options.force && state.rates && state.base === nextBase) {
    convertFromBase(nextBase);
    return;
  }

  state.base = nextBase;
  state.activeInput = nextBase;
  els.refreshButton.disabled = true;
  els.rateMeta.textContent = `Refreshing ${nextBase} rates...`;

  try {
    const response = await fetchFirstJson([
      ...getPrimaryLatestRequests(nextBase),
      ...FALLBACK_ENDPOINTS.latest.map((buildUrl) => ({ url: buildUrl(nextBase), provider: "frankfurter.dev" }))
    ]);

    state.provider = response.provider;
    state.rates = normalizeRates(response.data, nextBase);
    convertFromBase(nextBase);
    await persistState();
    const date = getRateDateLabel(response.data, response.provider);
    els.rateMeta.textContent = `${nextBase} rates${date}`;
    setStatus("");
  } catch (error) {
    setStatus(`Could not refresh rates: ${error.message}`, "error");
    els.rateMeta.textContent = "Rates unavailable";
  } finally {
    els.refreshButton.disabled = false;
  }
}

function getPrimaryCurrencyRequests() {
  if (USE_FALLBACK_ONLY) {
    return [];
  }

  return PRIMARY_ENDPOINTS.currencies.map((url) => ({ url, provider: "exchangerate.fun" }));
}

function getPrimaryLatestRequests(base) {
  if (USE_FALLBACK_ONLY) {
    return [];
  }

  return PRIMARY_ENDPOINTS.latest.map((buildUrl) => ({ url: buildUrl(base), provider: "exchangerate.fun" }));
}

async function fetchFirstJson(requests) {
  const errors = [];

  for (const request of requests) {
    try {
      const response = await fetch(request.url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`.trim());
      }

      return {
        data: await response.json(),
        provider: request.provider
      };
    } catch (error) {
      errors.push(`${request.provider}: ${error.message}`);
    }
  }

  throw new Error(errors.join("; ") || "all providers failed");
}

function normalizeCurrencyMap(payload) {
  const source = payload && typeof payload === "object" && payload.currencies ? payload.currencies : payload;
  const entries = Object.entries(source || {})
    .map(([code, name]) => [normalizeCode(code), typeof name === "string" ? name : name?.name])
    .filter(([code, name]) => /^[A-Z]{3}$/.test(code) && name);

  if (!entries.length) {
    throw new Error("currency list response was empty");
  }

  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeRates(payload, base) {
  const rates = payload && typeof payload === "object" ? payload.rates : null;
  if (!rates || typeof rates !== "object") {
    throw new Error("rate response did not include rates");
  }

  const normalized = Object.fromEntries(
    Object.entries(rates)
      .map(([code, rate]) => [normalizeCode(code), Number(rate)])
      .filter(([, rate]) => Number.isFinite(rate) && rate > 0)
  );

  normalized[base] = 1;
  return normalized;
}

function getRateDateLabel(payload, provider) {
  if (payload?.date) {
    return ` · ${payload.date}`;
  }

  if (Number.isFinite(payload?.timestamp)) {
    const date = new Date(payload.timestamp * 1000);
    const dateLabel = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });

    if (provider === "exchangerate.fun") {
      return ` · ${dateLabel}, ${date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit"
      })}`;
    }

    return ` · ${dateLabel}`;
  }

  return "";
}

async function addCurrencyFromSearch() {
  const code = parseCurrencySearch(els.search.value);
  if (!code) {
    setStatus("Choose a valid currency code.", "error");
    return;
  }

  if (!state.currencies[code]) {
    setStatus(`${code} is not available from the loaded currency list.`, "error");
    return;
  }

  if (state.selected.includes(code)) {
    setStatus(`${code} is already in the list.`);
    els.search.value = "";
    return;
  }

  state.selected.push(code);
  state.savedNames[code] = state.currencies[code];
  state.values[code] = "";
  els.search.value = "";
  renderRows();
  await persistState();

  if (parseAmount(state.values[state.base]) !== null) {
    setStatus(`${code} added. Updating rates...`);
    await refreshRates(state.base, { force: true });
  } else {
    setStatus(`${code} added.`);
  }
}

function parseCurrencySearch(value) {
  const raw = normalizeCode(value);
  const code = raw.match(/[A-Z]{3}/)?.[0];
  return code && state.currencies[code] ? code : "";
}

function removeCurrency(code) {
  if (state.selected.length <= 1) {
    setStatus("Keep at least one currency in the list.", "error");
    return;
  }

  state.selected = state.selected.filter((item) => item !== code);
  delete state.savedNames[code];
  delete state.values[code];
  if (state.base === code) {
    state.base = state.selected[0];
    state.rates = null;
    refreshRates(state.base, { force: true });
  }

  renderRows();
  persistState();
}

async function moveCurrencyToPosition(draggedCode, targetCode, placeAfter = false) {
  if (!draggedCode || !targetCode || draggedCode === targetCode) {
    return;
  }

  const nextSelected = state.selected.filter((code) => code !== draggedCode);
  let targetIndex = nextSelected.indexOf(targetCode);
  if (targetIndex < 0) {
    return;
  }

  if (placeAfter) {
    targetIndex += 1;
  }

  nextSelected.splice(targetIndex, 0, draggedCode);
  state.selected = nextSelected;

  renderRows();
  await persistState();
  setStatus(`${draggedCode} moved.`);
}

function renderCurrencyOptions() {
  els.datalist.replaceChildren(
    ...Object.entries(state.currencies).map(([code, name]) => {
      const option = document.createElement("option");
      option.value = `${code} - ${name}`;
      return option;
    })
  );
}

function renderRows() {
  const rows = state.selected.map((code) => {
    const row = els.template.content.firstElementChild.cloneNode(true);
    const input = row.querySelector(".currency-input");
    const dragHandle = row.querySelector(".drag-handle");
    const removeButton = row.querySelector(".remove-button");

    row.dataset.code = code;
    row.draggable = false;
    row.querySelector(".currency-code").textContent = code;
    row.querySelector(".currency-name").textContent = getCurrencyName(code);
    input.value = state.values[code] ?? "";
    input.setAttribute("aria-label", `${code} amount`);
    input.addEventListener("input", () => handleAmountInput(code, input.value));
    dragHandle.setAttribute("aria-label", `Drag ${code} to reorder`);
    dragHandle.addEventListener("pointerdown", () => {
      row.draggable = true;
    });
    dragHandle.addEventListener("pointerup", () => {
      row.draggable = false;
    });
    row.addEventListener("dragstart", (event) => handleDragStart(event, code, row));
    row.addEventListener("dragover", handleDragOver);
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (event) => handleDrop(event, code, row));
    row.addEventListener("dragend", () => handleDragEnd(row));
    removeButton.setAttribute("aria-label", `Remove ${code}`);
    removeButton.addEventListener("click", () => removeCurrency(code));

    return row;
  });

  els.currencyList.replaceChildren(...rows);
}

function handleDragStart(event, code, row) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", code);
  row.classList.add("dragging");
}

function handleDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add("drag-over");
  event.dataTransfer.dropEffect = "move";
}

function handleDrop(event, targetCode, row) {
  event.preventDefault();
  row.classList.remove("drag-over");
  const rect = row.getBoundingClientRect();
  const placeAfter = event.clientY > rect.top + rect.height / 2;
  moveCurrencyToPosition(event.dataTransfer.getData("text/plain"), targetCode, placeAfter);
}

function handleDragEnd(row) {
  row.draggable = false;
  for (const item of els.currencyList.querySelectorAll(".currency-row")) {
    item.classList.remove("dragging", "drag-over");
  }
}

function handleAmountInput(code, rawValue) {
  state.activeInput = code;
  state.values[code] = rawValue;
  window.clearTimeout(state.debounceTimer);

  state.debounceTimer = window.setTimeout(async () => {
    const amount = parseAmount(rawValue);
    if (amount === null) {
      clearConvertedValuesExcept(code);
      await persistState();
      return;
    }

    await refreshRates(code, { force: true });
  }, DEBOUNCE_MS);
}

function convertFromBase(base) {
  const amount = parseAmount(state.values[base]);
  if (amount === null || !state.rates) {
    return;
  }

  for (const code of state.selected) {
    if (code === base) {
      continue;
    }

    const rate = state.rates[code];
    state.values[code] = Number.isFinite(rate) ? formatAmount(amount * rate) : "";
  }

  updateInputValues({ skipCode: base });
}

function clearConvertedValuesExcept(code) {
  for (const selectedCode of state.selected) {
    if (selectedCode !== code) {
      state.values[selectedCode] = "";
    }
  }
  updateInputValues({ skipCode: code });
}

function updateRows() {
  for (const row of els.currencyList.querySelectorAll(".currency-row")) {
    const code = row.dataset.code;
    row.querySelector(".currency-name").textContent = getCurrencyName(code);
  }

  updateInputValues();
}

function updateInputValues(options = {}) {
  const focusedElement = document.activeElement;

  for (const row of els.currencyList.querySelectorAll(".currency-row")) {
    const code = row.dataset.code;
    const input = row.querySelector(".currency-input");

    if (code === options.skipCode || input === focusedElement) {
      continue;
    }

    const nextValue = state.values[code] ?? "";
    if (input.value !== nextValue) {
      input.value = nextValue;
    }
  }
}

function parseAmount(value) {
  const normalized = String(value || "").replace(",", ".").trim();
  if (!normalized) {
    return null;
  }

  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function formatAmount(value) {
  if (!Number.isFinite(value)) {
    return "";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1 ? 2 : 6,
    useGrouping: false
  }).format(value);
}

function ensureSelectedCurrenciesHaveNames() {
  for (const code of state.selected) {
    if (!state.currencies[code]) {
      state.currencies[code] = code;
    }
  }
}

function syncSavedNames() {
  for (const code of state.selected) {
    state.savedNames[code] = getCurrencyName(code);
  }
}

function getCurrencyName(code) {
  return state.currencies[code] || state.savedNames[code] || code;
}

function setStatus(message, tone = "") {
  els.status.textContent = message;
  if (tone) {
    els.status.dataset.tone = tone;
  } else {
    delete els.status.dataset.tone;
  }
}

async function persistState() {
  syncSavedNames();
  await chrome.storage.local.set({
    [STORAGE_KEYS.selected]: state.selected,
    [STORAGE_KEYS.names]: state.savedNames,
    [STORAGE_KEYS.lastBase]: state.base,
    [STORAGE_KEYS.values]: state.values
  });
}
