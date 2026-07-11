// ==UserScript==
// @name         NILAM SQLite Assistant
// @namespace    https://github.com/cscLearn/nilam-sqlite-assistant
// @version      0.1.0
// @description  NILAM assistant with separate verified-real and AI-generated SQLite book pools.
// @author       cscLearn
// @match        https://ains.moe.gov.my/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      nilam-book.cscflow.com
// @connect      ains-api.moe.gov.my
// @connect      *
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js
// @updateURL    https://raw.githubusercontent.com/cscLearn/nilam-sqlite-assistant/main/nilam-sqlite.user.js
// @downloadURL  https://raw.githubusercontent.com/cscLearn/nilam-sqlite-assistant/main/nilam-sqlite.user.js
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "nilam-sqlite-assistant";
  const STORE_KEY = "nilam_sqlite_assistant_state_v1";
  const PANEL_X_KEY = "nilam_sqlite_panel_x";
  const PANEL_Y_KEY = "nilam_sqlite_panel_y";
  const SCRIPT_VERSION = "0.1.0";
  const API_BASE_URL = "https://nilam-book.cscflow.com";
  const API_TOKEN = "sk-nilambooks-fc62df67e2d7d8a9";
  const REFRESH_BOOK_COUNT = 30;
  const PROVIDER_SECRET = "OypAJ9vA==,OJEpNYuu2h";
  const PROVIDER_ENTRY_ORDER = [
    "user",
    "type",
    "date",
    "title",
    "category",
    "author",
    "publisher",
    "language",
    "summary",
    "review"
  ];

  // Books will be fetched from cloud API
  const BOOKS_DATABASE = [];


  const state = {
    books: BOOKS_DATABASE,
    filtered: [],
    selectedKey: "",
    selectedDate: todayIsoDate(),
    filters: { category: "all", language: "bm" },
    apiTemplate: null,
    userId: null,
    tokenExpiresAt: null,
    submittedTitles: [], // Stores lowercase array of titles to prevent duplicates locally
    submittedIsbns: [],  // Stores clean hyphenless ISBNs to prevent duplicates locally
    totalHistoryCount: 0, // Stores total records count from the API
    dashboardRecordCount: 0,
    todaySubmitCount: 0,  // Stores true real-world submits for today
    lastSubmitTime: null, // Stores timestamp (ms) of the last successful submission
    collapsed: true,
    studentName: "",
    studentGrade: "",
    sourceType: "real",
    ...GM_getValue(STORE_KEY, {})
  };

  if (!state.books || state.books.length === 0) {
    state.books = BOOKS_DATABASE;
  }

  if (state.studentName === "FAQ") {
    state.studentName = "";
  }

  let panelReady = false;

  function saveState() {
    GM_setValue(STORE_KEY, {
      books: state.books,
      selectedKey: state.selectedKey,
      selectedDate: state.selectedDate,
      filters: state.filters,
      apiTemplate: state.apiTemplate,
      userId: state.userId,
      tokenExpiresAt: state.tokenExpiresAt,
      submittedTitles: state.submittedTitles,
      submittedIsbns: state.submittedIsbns,
      totalHistoryCount: state.totalHistoryCount,
      dashboardRecordCount: state.dashboardRecordCount,
      todaySubmitCount: state.todaySubmitCount,
      lastSubmitTime: state.lastSubmitTime,
      collapsed: state.collapsed,
      studentName: state.studentName,
      studentGrade: state.studentGrade,
      sourceType: state.sourceType
    });
  }

  function todayIsoDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function normalizeIsoDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return todayIsoDate();
    const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (d.getFullYear() !== Number(match[1]) || d.getMonth() !== Number(match[2]) - 1 || d.getDate() !== Number(match[3])) {
      return todayIsoDate();
    }
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  function bookKey(book) {
    return String(book?.id || `${book?.title || ""}|${book?.author || ""}|${book?.isbn || ""}`);
  }

  function currentBook() {
    return state.filtered.find((book) => bookKey(book) === state.selectedKey) || state.filtered[0] || null;
  }

  function formatIsbn(isbn) {
    const compact = String(isbn ?? "").replaceAll("-", "");
    if (!/^978\d{10}$/.test(compact)) return String(isbn ?? "");
    if (compact.startsWith("978967")) return `${compact.slice(0, 3)}-${compact.slice(3, 6)}-${compact.slice(6, 9)}-${compact.slice(9, 12)}-${compact.slice(12)}`;
    if (compact.startsWith("9780")) return `${compact.slice(0, 3)}-${compact.slice(3, 4)}-${compact.slice(4, 7)}-${compact.slice(7, 12)}-${compact.slice(12)}`;
    if (compact.startsWith("9787")) return `${compact.slice(0, 3)}-${compact.slice(3, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12)}`;
    return `${compact.slice(0, 3)}-${compact.slice(3, 6)}-${compact.slice(6, 9)}-${compact.slice(9, 12)}-${compact.slice(12)}`;
  }

  function bookForApi(book) {
    if (!book) return null;
    const lang = book.language || "bm";
    return {
      date: normalizeIsoDate(state.selectedDate),
      title: book.title || "",
      pages: Number(book.pages || 0),
      isbn: formatIsbn(book.isbn),
      author: book.author || "",
      publisher: book.publisher || "",
      year: Number(book.year || new Date().getFullYear()),
      category: book.category || "Fiksyen",
      language: lang,
      rumusan: book.rumusan,
      lesson: book.lesson,
      rating: 5,
      type: "physical"
    };
  }

  function apiCategory(category) {
    return String(category || "").toLowerCase().includes("bukan") ? "nonFiction" : "fiction";
  }

  function apiLanguage(language) {
    if (language === "bm") return "my";
    if (language === "en") return "en";
    return "others";
  }

  function applyFilters() {
    const submittedTitlesSet = new Set((state.submittedTitles || []).map(t => String(t).trim().toLowerCase()));
    const submittedIsbnsSet = new Set((state.submittedIsbns || []).map(i => String(i).replaceAll("-", "").replaceAll(" ", "").trim().toLowerCase()));

    state.filtered = state.books.filter((book) => {
      if (state.filters.category !== "all" && book.category !== state.filters.category) return false;
      if (state.filters.language !== "all" && book.language !== state.filters.language) return false;
      
      const titleLower = String(book.title || "").trim().toLowerCase();
      const isbnClean = String(book.isbn || "").replaceAll("-", "").replaceAll(" ", "").trim().toLowerCase();
      // Keep duplicates in the filtered list so they can be rendered with the 🔴 [已读] indicator
      
      return true;
    });

    if (state.filtered.length > 0 && !state.filtered.some((book) => bookKey(book) === state.selectedKey)) {
      state.selectedKey = bookKey(state.filtered[0]);
    } else if (state.filtered.length === 0) {
      state.selectedKey = "";
    }
  }

  function renderFilterControls() {
    const category = document.querySelector("#nia-category");
    if (category) category.value = state.filters.category;
    const language = document.querySelector("#nia-language");
    if (language) language.value = state.filters.language;
  }

  function headersToObject(headers) {
    const result = {};
    new Headers(headers || {}).forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!["content-length", "host", "origin", "referer", "user-agent"].includes(lower)) {
        result[lower] = value;
      }
    });
    return result;
  }

  function bodyToTemplateBody(body) {
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      try {
        return JSON.stringify(Object.fromEntries(body.entries()));
      } catch (e) {
        return "";
      }
    }
    return "";
  }

  function cleanIsbn(isbn) {
    return String(isbn || "").replaceAll("-", "").replaceAll(" ", "").trim().toLowerCase();
  }

  function fetchNextBooks() {
    return new Promise((resolve, reject) => {
      const usedTitles = Array.from(new Set((state.submittedTitles || []).map(t => String(t).trim().toLowerCase())));
      const usedIsbns = Array.from(new Set((state.submittedIsbns || []).map(cleanIsbn)));
      
      const payload = {
        userId: String(state.userId || "unknown"),
        sourceType: state.sourceType,
        usedTitles: usedTitles,
        usedIsbns: usedIsbns,
        counts: { zh: 10, bm: 10, en: 10 }
      };

      GM_xmlhttpRequest({
        method: "POST",
        url: `${API_BASE_URL}/api/books/next`,
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_TOKEN}`
        },
        data: JSON.stringify(payload),
        onload: (response) => {
          try {
            if (response.status >= 400) {
              reject(new Error(`API Error ${response.status}: ${response.responseText}`));
              return;
            }
            const data = JSON.parse(response.responseText);
            if (!data || !data.books || data.books.length === 0) {
              reject(new Error("no books returned from server"));
              return;
            }
            resolve(data.books);
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error("API request failed")),
        ontimeout: () => reject(new Error("API request timed out"))
      });
    });
  }

  function advanceCursor(language) {
    if (!state.userId) return;
    GM_xmlhttpRequest({
      method: "POST",
      url: `${API_BASE_URL}/api/books/advance`,
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_TOKEN}`
      },
      data: JSON.stringify({ userId: String(state.userId), sourceType: state.sourceType, language: language })
    });
  }

  function rejectDuplicate(bookId, language) {
    if (!state.userId) return;
    GM_xmlhttpRequest({
      method: "POST",
      url: `${API_BASE_URL}/api/books/reject`,
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_TOKEN}`
      },
      data: JSON.stringify({ userId: String(state.userId), sourceType: state.sourceType, bookId: bookId, reason: "duplicate", language: language })
    });
  }

  function looksLikeNilamPost(url, bodyText) {
    const urlStr = String(url || "");
    if (!urlStr.includes("ains-api") && !urlStr.includes("/api/")) return false;
    if (!bodyText || bodyText.length > 20000) return false;
    return /title|judul|isbn|author|publisher|summary|rumusan|review|ulasan|tarikh|date/i.test(bodyText);
  }

  function parseJwtPayload(authHeader) {
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]));
  }

  function tokenStatus() {
    if (!state.apiTemplate?.headers?.authorization) {
      return { ok: false, label: "无登录凭证" };
    }
    if (!state.tokenExpiresAt) {
      return { ok: true, label: "已捕获凭证" };
    }

    const msLeft = Number(state.tokenExpiresAt) - Date.now();
    if (msLeft <= 0) return { ok: false, label: "凭证已过期" };
    const minutes = Math.floor(msLeft / 60000);
    if (minutes < 5) return { ok: true, label: `凭证将在 ${minutes} 分钟内过期` };
    return { ok: true, label: `凭证有效 (剩 ${minutes} 分钟)` };
  }

  function ensureUsableToken(action) {
    const status = tokenStatus();
    if (status.ok) return true;
    setStatus(`${action} 拦截：${status.label}。请在 AINS 手动提交一次以更新凭证。`);
    return false;
  }

  function updateCapturedToken(authHeader) {
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const payload = parseJwtPayload(authHeader);
        if (payload && payload.id) {
          const previousUserId = state.userId;
          state.userId = payload.id;
          state.tokenExpiresAt = payload.exp ? Number(payload.exp) * 1000 : null;
          if (previousUserId && String(previousUserId) !== String(state.userId)) {
            state.submittedTitles = [];
            state.submittedIsbns = [];
            state.totalHistoryCount = 0;
            state.dashboardRecordCount = 0;
            state.todaySubmitCount = 0;
            setStatus(`检测到账号切换：${previousUserId} -> ${state.userId}。请同步历史记录。`);
          }
          console.log("NILAM API Assistant: Synced User ID ->", state.userId);
        }
      } catch (e) {
        console.error("NILAM API Assistant: Failed to parse User ID from JWT", e);
      }

      if (state.apiTemplate) {
        state.apiTemplate.headers["authorization"] = authHeader;
        console.log("NILAM API Assistant: Automatically updated Bearer Token in background.");
      }
      saveState();
      renderApiStatus();
    }
  }

  function captureTemplate(url, method, headers, body) {
    const headersObj = headersToObject(headers);
    let auth = headersObj["authorization"];
    updateCapturedToken(auth);

    if (String(method || "GET").toUpperCase() !== "POST") return;
    const bodyText = bodyToTemplateBody(body);
    if (!looksLikeNilamPost(url, bodyText)) return;

    state.apiTemplate = {
      url: String(url),
      headers: headersObj,
      bodyText: bodyText,
      payload: parseJsonOrNull(bodyText),
      capturedAt: new Date().toISOString()
    };
    saveState();
    setStatus("API 凭证捕获成功。可以开始提交。");
    renderApiStatus();
    fetchHistory(); // Attempt background history sync once token is captured
  }

  function parseJsonOrNull(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function capturedDataTemplate() {
    const payload = state.apiTemplate?.payload || parseJsonOrNull(state.apiTemplate?.bodyText || "");
    return payload?.data && typeof payload.data === "object" ? payload.data : {};
  }

  function providerPayload(data) {
    const payload = {};
    for (const key of PROVIDER_ENTRY_ORDER) {
      payload[key] = key === "user" ? Number(data[key]) : data[key];
    }
    return payload;
  }

  function buildAinsPayload(book) {
    const base = capturedDataTemplate();
    const data = {
      ...base,
      user: Number(state.userId || base.user),
      type: base.type || "book",
      date: book.date,
      title: book.title,
      bookType: base.bookType || "physical",
      category: apiCategory(book.category),
      noOfPage: Number(book.pages),
      isbn: book.isbn,
      author: book.author,
      publisher: book.publisher,
      publishedYear: String(book.year),
      language: apiLanguage(book.language),
      summary: book.rumusan,
      review: book.lesson,
      rating: Number(book.rating || base.rating || 5),
      reviewIsVideo: Boolean(base.reviewIsVideo)
    };

    data.provider = CryptoJS.AES.encrypt(
      JSON.stringify(providerPayload(data)),
      PROVIDER_SECRET
    ).toString();

    return { data };
  }

  function decryptProvider(provider) {
    const bytes = CryptoJS.AES.decrypt(provider, PROVIDER_SECRET);
    const text = bytes.toString(CryptoJS.enc.Utf8);
    return text ? JSON.parse(text) : null;
  }

  function normalizeComparable(value) {
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return String(value ?? "").trim();
  }

  function validatePayloadLocally(payload) {
    if (!payload?.data || typeof payload.data !== "object") {
      return { ok: false, message: "payload.data missing" };
    }
    if (!payload.data.provider) {
      return { ok: false, message: "provider missing" };
    }

    let provider;
    try {
      provider = decryptProvider(payload.data.provider);
    } catch (error) {
      return { ok: false, message: `provider decrypt failed: ${error.message}` };
    }
    if (!provider) {
      return { ok: false, message: "provider decrypt returned empty payload" };
    }

    for (let index = 0; index < PROVIDER_ENTRY_ORDER.length; index += 1) {
      const key = PROVIDER_ENTRY_ORDER[index];
      const bodyValue = normalizeComparable(payload.data[key]);
      const providerValue = normalizeComparable(provider[key]);
      if (bodyValue !== providerValue) {
        return { ok: false, message: `entry ${index}: ${key} mismatch`, key, bodyValue, providerValue };
      }
    }

    return { ok: true, message: "preflight OK" };
  }

  function setDiagnostics(result) {
    const el = document.querySelector("#nia-diagnostics");
    if (!el) return;
    if (!result) {
      el.textContent = "";
      return;
    }
    el.textContent = result.ok
      ? result.message
      : `${result.message}${result.key ? ` | body=${result.bodyValue} provider=${result.providerValue}` : ""}`;
  }

  function extractTitlesAndIsbnsFromJson(obj, titleSet = new Set(), isbnSet = new Set()) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        extractTitlesAndIsbnsFromJson(item, titleSet, isbnSet);
      }
    } else {
      for (const key in obj) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === "title" && typeof obj[key] === "string") {
          titleSet.add(obj[key].trim().toLowerCase());
          titleSet.add(normalizeTitle(obj[key]));
        } else if (lowerKey === "isbn" && typeof obj[key] === "string") {
          const clean = obj[key].replaceAll("-", "").replaceAll(" ", "").trim().toLowerCase();
          if (clean) isbnSet.add(clean);
        } else {
          extractTitlesAndIsbnsFromJson(obj[key], titleSet, isbnSet);
        }
      }
    }
  }

  let loggedRecordSample = false;

  function countTodaySubmissions(obj, todayStr, counts = { realWorld: 0, readDate: 0 }) {
    if (!obj || typeof obj !== "object") return counts;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        countTodaySubmissions(item, todayStr, counts);
      }
    } else {
      // Print sample record structure to console once
      if (!loggedRecordSample && (obj.title || obj.attributes?.title || obj.isbn || obj.attributes?.isbn)) {
        console.log("NILAM API Assistant: Traversed record object keys ->", Object.keys(obj), "attributes keys ->", obj.attributes ? Object.keys(obj.attributes) : "none", "values ->", obj);
        loggedRecordSample = true;
      }

      const dateVal = obj.date || obj.attributes?.date;

      // Fallback through all typical creation date keys
      const createdVal = obj.createdAt || obj.attributes?.createdAt || 
                         obj.created_at || obj.attributes?.created_at ||
                         obj.publishedAt || obj.attributes?.publishedAt ||
                         obj.published_at || obj.attributes?.published_at ||
                         obj.updatedAt || obj.attributes?.updatedAt;

      if (dateVal || createdVal) {
        if (dateVal === todayStr) {
          counts.readDate++;
        }
        if (createdVal) {
          const dateObj = new Date(createdVal);
          if (!isNaN(dateObj.getTime())) {
            const localIso = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")}`;
            if (localIso === todayStr) {
              counts.realWorld++;
            }
          }
        }
      }
      for (const key in obj) {
        if (key !== "user" && key !== "school" && key !== "class" && typeof obj[key] === "object") {
          countTodaySubmissions(obj[key], todayStr, counts);
        }
      }
    }
    return counts;
  }

  function extractTodayCountFromCounter(obj) {
    if (!obj || typeof obj !== "object") return null;

    const keysToCheck = ["today", "todaycount", "today_count", "readtoday", "read_today", "counter", "count"];
    for (const key in obj) {
      const lower = key.toLowerCase();
      if (keysToCheck.includes(lower) && typeof obj[key] === "number") {
        return obj[key];
      }
    }

    for (const key in obj) {
      if (typeof obj[key] === "object") {
        const res = extractTodayCountFromCounter(obj[key]);
        if (res !== null) return res;
      }
    }
    return null;
  }

  function requestHeaders(extra = {}) {
    const headers = {
      ...(state.apiTemplate?.headers || {}),
      ...extra
    };
    const auth = headers.authorization || headers.Authorization;
    delete headers.Authorization;
    if (auth) headers.authorization = auth;
    return headers;
  }

  async function fetchHistory(renderAfter = true) {
    if (!state.apiTemplate || !state.userId) {
      setStatus("同步失败：暂无登录凭证。");
      return;
    }
    if (!ensureUsableToken("同步历史记录")) return;
    setStatus("正在同步阅读历史记录...");
    const url = `https://ains-api.moe.gov.my/api/nilam-records?filters[user][id]=${state.userId}&pagination[limit]=1000`;

    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: requestHeaders({ accept: "application/json" })
      });
      const text = await response.text();

      if (response.status === 401) {
        console.error("NILAM API Assistant: History sync unauthorized", text);
        state.tokenExpiresAt = 0;
        saveState();
        renderApiStatus();
        setStatus("同步失败：登录凭证已过期。请刷新页面或重新提交。");
        return;
      }

      if (!response.ok) {
        console.error("NILAM API Assistant: History sync HTTP error", response.status, text);
        setStatus(`同步失败：服务器返回错误 HTTP ${response.status}。`);
        return;
      }

      const data = JSON.parse(text);
      const totalRaw = Array.isArray(data.data) ? data.data.length : (data.meta?.pagination?.total || 0);
      const currentTotal = state.totalHistoryCount || 0;
      if (totalRaw >= currentTotal || currentTotal - totalRaw > 5) {
        state.totalHistoryCount = totalRaw;
      }

      const titleSet = new Set(state.submittedTitles || []);
      const isbnSet = new Set(state.submittedIsbns || []);
      extractTitlesAndIsbnsFromJson(data, titleSet, isbnSet);
      state.submittedTitles = Array.from(titleSet);
      state.submittedIsbns = Array.from(isbnSet);

      const todayStr = todayIsoDate();
      const counts = countTodaySubmissions(data, todayStr);
      state.todaySubmitCount = Math.max(state.todaySubmitCount || 0, counts.realWorld);

      saveState();

      // Fetch official student information counter for today's submissions count
      const counterUrl = "https://ains-api.moe.gov.my/api/student-informations/info/counter";
      try {
        const res = await fetch(counterUrl, {
          method: "GET",
          credentials: "include",
          headers: requestHeaders({ accept: "application/json" })
        });
        if (res.ok) {
          const resText = await res.text();
          const counterData = JSON.parse(resText);
          console.log("NILAM API Assistant: Direct synced counter response ->", counterData);
          const count = extractTodayCountFromCounter(counterData);
          if (count !== null) {
            state.todaySubmitCount = count;
            saveState();
          }
        }
      } catch (err) {
        console.error("Failed to fetch today counter during sync", err);
      }

      console.log("NILAM API Assistant: Synced Titles ->", state.submittedTitles);
      console.log("NILAM API Assistant: Synced ISBNs ->", state.submittedIsbns);

      setStatus(`成功同步历史记录，共 ${state.totalHistoryCount} 条数据，去重已读 ${state.submittedTitles.length} 本。`);
      if (renderAfter) {
        renderApiStatus();
        renderBookSelect();
      }
    } catch (e) {
      console.error("NILAM API Assistant: History sync failed", e);
      setStatus(`同步失败：${e.message}`);
    }
  }

  async function replayCapturedApi() {
    if (!state.apiTemplate?.bodyText) {
      setStatus("重放失败：未捕获到原始数据。");
      return;
    }

    const capturedPayload = parseJsonOrNull(state.apiTemplate.bodyText);
    const preflight = validatePayloadLocally(capturedPayload);
    setDiagnostics(preflight);
    if (!preflight.ok) {
      setStatus("重放失败：本地预校验未通过。");
      return;
    }
    if (!ensureUsableToken("单步测试提交")) return;

    try {
      setStatus("正在测试提交捕获的数据...");
      const response = await fetch(state.apiTemplate.url, {
        method: "POST",
        credentials: "include",
        headers: requestHeaders({ "content-type": "application/json" }),
        body: state.apiTemplate.bodyText
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
      setStatus("测试提交成功。捕获的 API 数据有效。");
    } catch (error) {
      setStatus(`测试提交失败：${error.message}`);
    }
  }

  function isCurrentBookDuplicate() {
    const book = currentBook();
    if (!book) return false;

    const titleLower = String(book.title || "").trim().toLowerCase();
    const isbnClean = String(book.isbn || "").replaceAll("-", "").replaceAll(" ", "").trim().toLowerCase();

    const submittedTitlesSet = new Set((state.submittedTitles || []).map(t => String(t).trim().toLowerCase()));
    const submittedIsbnsSet = new Set((state.submittedIsbns || []).map(i => String(i).replaceAll("-", "").replaceAll(" ", "").trim().toLowerCase()));

    return submittedTitlesSet.has(titleLower) || (isbnClean && submittedIsbnsSet.has(isbnClean));
  }

  function patchFetch() {
    const originalFetch = window.fetch;
    window.fetch = async function (input, init = {}) {
      const request = input instanceof Request ? input.clone() : null;
      const url = typeof input === "string" ? input : input.url;
      const method = init.method || request?.method || "GET";

      if (url.includes("/api/") || url.includes("moe.gov.my")) {
        console.log(`NILAM API Assistant: Intercepted Fetch -> [${method}] ${url}`);
      }

      const mergedHeaders = {};
      if (request?.headers) {
        new Headers(request.headers).forEach((v, k) => {
          mergedHeaders[k.toLowerCase()] = v;
        });
      }
      if (init.headers) {
        new Headers(init.headers).forEach((v, k) => {
          mergedHeaders[k.toLowerCase()] = v;
        });
      }

      let body = init.body;
      if (body === undefined && request && String(method).toUpperCase() === "POST") {
        body = await request.text();
      }

      let auth = mergedHeaders["authorization"];
      updateCapturedToken(auth);

      const response = await originalFetch.apply(this, arguments);
      if (response.ok) {
        captureTemplate(url, method, mergedHeaders, body);

        // Capture/Intercept history GET requests dynamically to update local duplicates
        if (url.includes("nilam-records") && String(method).toUpperCase() === "GET") {
          try {
            const clone = response.clone();
            const data = await clone.json();
            const totalRaw = Array.isArray(data.data) ? data.data.length : (data.meta?.pagination?.total || 0);
            const currentTotal = state.totalHistoryCount || 0;
            if (totalRaw >= currentTotal || currentTotal - totalRaw > 5) {
              state.totalHistoryCount = totalRaw;
            }

            const titleSet = new Set(state.submittedTitles || []);
            const isbnSet = new Set(state.submittedIsbns || []);
            extractTitlesAndIsbnsFromJson(data, titleSet, isbnSet);
            state.submittedTitles = Array.from(titleSet);
            state.submittedIsbns = Array.from(isbnSet);

            const todayStr = todayIsoDate();
            const counts = countTodaySubmissions(data, todayStr);
            state.todaySubmitCount = Math.max(state.todaySubmitCount || 0, counts.realWorld);

            saveState();
            console.log("NILAM API Assistant: Intercepted and synced records ->", state.submittedTitles.length, "total ->", state.totalHistoryCount, "today ->", state.todaySubmitCount);
            renderApiStatus();
            renderBookSelect();
          } catch (e) {
            console.error("Failed to parse intercepted history GET response", e);
          }
        }

        if (url.includes("info/counter") && String(method).toUpperCase() === "GET") {
          try {
            const clone = response.clone();
            const data = await clone.json();
            console.log("NILAM API Assistant: Intercepted info/counter response ->", data);
            const count = extractTodayCountFromCounter(data);
            if (count !== null) {
              state.todaySubmitCount = count;
              saveState();
              renderApiStatus();
            }
          } catch (e) {
            console.error("Failed to parse intercepted info/counter response", e);
          }
        }
      }
      return response;
    };
  }

  function patchXhr() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__nilamApi = { method, url, headers: {} };
      if (url.includes("/api/") || url.includes("moe.gov.my")) {
        console.log(`NILAM API Assistant: Intercepted XHR -> [${method}] ${url}`);
      }
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
      if (this.__nilamApi) this.__nilamApi.headers[key] = value;
      const lower = String(key).toLowerCase();
      if (lower === "authorization") {
        updateCapturedToken(value);
      }
      return originalSetHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      this.addEventListener("load", () => {
        if (this.status >= 200 && this.status < 300 && this.__nilamApi) {
          const url = new URL(this.__nilamApi.url, location.href).href;
          const method = this.__nilamApi.method;
          captureTemplate(url, method, this.__nilamApi.headers, body);

          // Capture/Intercept XHR history GET requests
          if (url.includes("nilam-records") && String(method).toUpperCase() === "GET") {
            try {
              const data = JSON.parse(this.responseText);
              const totalRaw = Array.isArray(data.data) ? data.data.length : (data.meta?.pagination?.total || 0);
              const currentTotal = state.totalHistoryCount || 0;
              if (totalRaw >= currentTotal || currentTotal - totalRaw > 5) {
                state.totalHistoryCount = totalRaw;
              }

              const titleSet = new Set(state.submittedTitles || []);
              const isbnSet = new Set(state.submittedIsbns || []);
              extractTitlesAndIsbnsFromJson(data, titleSet, isbnSet);
              state.submittedTitles = Array.from(titleSet);
              state.submittedIsbns = Array.from(isbnSet);

              const todayStr = todayIsoDate();
              const counts = countTodaySubmissions(data, todayStr);
              state.todaySubmitCount = Math.max(state.todaySubmitCount || 0, counts.realWorld);

              saveState();
              console.log("NILAM API Assistant: Intercepted and synced XHR records ->", state.submittedTitles.length, "total ->", state.totalHistoryCount, "today ->", state.todaySubmitCount);
              renderApiStatus();
              renderBookSelect();
            } catch (e) {
              console.error("Failed to parse intercepted XHR history response", e);
            }
          }

          if (url.includes("info/counter") && String(method).toUpperCase() === "GET") {
            try {
              const data = JSON.parse(this.responseText);
              console.log("NILAM API Assistant: Intercepted XHR info/counter response ->", data);
              const count = extractTodayCountFromCounter(data);
              if (count !== null) {
                state.todaySubmitCount = count;
                saveState();
                renderApiStatus();
              }
            } catch (e) {
              console.error("Failed to parse intercepted XHR info/counter response", e);
            }
          }
        }
      });
      return originalSend.apply(this, arguments);
    };
  }

  function shiftSelectedDate(offsetDays) {
    const current = new Date(normalizeIsoDate(state.selectedDate));
    if (isNaN(current.getTime())) return;
    current.setDate(current.getDate() + offsetDays);
    state.selectedDate = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
    saveState();

    const dateInput = document.querySelector("#nia-date");
    if (dateInput) {
      dateInput.value = state.selectedDate;
    }
    renderPreview();
  }

  async function submitApi() {
    const todayCount = state.todaySubmitCount || 0;
    if (todayCount >= 30) {
      setStatus("拦截：今日提交已达安全上限（30本），防止封号风险！");
      return;
    }

    if (state.lastSubmitTime) {
      const elapsed = Date.now() - Number(state.lastSubmitTime);
      if (elapsed < 10000) {
        const remaining = Math.ceil((10000 - elapsed) / 1000);
        setStatus(`冷却拦截：为了模拟真人录入，请等待 ${remaining} 秒冷却时间。`);
        return;
      }
    }

    const book = bookForApi(currentBook());
    if (!book) {
      setStatus("请先选择一本图书。");
      return;
    }
    if (isCurrentBookDuplicate()) {
      setStatus("提交拦截：该书已被阅读，已通知云端跳过。");
      rejectDuplicate(book.id, book.language);
      return;
    }
    if (!state.apiTemplate) {
      setStatus("未捕获凭证：请先在 AINS 网页上手动提交一次 NILAM 以捕获 API 凭证。");
      return;
    }
    if (!ensureUsableToken("提交")) return;

    if (!state.userId) {
      let auth = state.apiTemplate.headers["Authorization"] || state.apiTemplate.headers["authorization"];
      updateCapturedToken(auth);
      if (!state.userId) {
        setStatus("用户 ID 缺失。请尝试重新登录。");
        return;
      }
    }

    try {
      setStatus("正在提交至 AINS 服务器...");
      const bodyPayload = buildAinsPayload(book);
      const preflight = validatePayloadLocally(bodyPayload);
      setDiagnostics(preflight);
      if (!preflight.ok) {
        setStatus(`提交拦截：本地预校验未通过 (${preflight.message})`);
        return;
      }

      const headers = {
        ...requestHeaders({ "content-type": "application/json" })
      };

      console.log("NILAM API Assistant: Request URL ->", state.apiTemplate.url);
      console.log("NILAM API Assistant: Request Headers ->", headers);
      console.log("NILAM API Assistant: Request Payload ->", bodyPayload);

      const response = await fetch(state.apiTemplate.url, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(bodyPayload)
      });

      const text = await response.text();
      if (response.status === 401) {
        state.tokenExpiresAt = 0;
        saveState();
        renderApiStatus();
      }
      if (!response.ok) {
        console.error("NILAM API Assistant: Response Error Detail ->", text);
        setDiagnostics({ ok: false, message: text.slice(0, 260) });
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
      }

      setStatus(`提交成功：${book.title}`);
      
      // Advance cloud cursor
      advanceCursor(book.language);

      // Update local submitted titles and ISBNs array immediately to avoid reloading requirement
      const newTitles = new Set(state.submittedTitles || []);
      newTitles.add(String(book.title).trim().toLowerCase());
      state.submittedTitles = Array.from(newTitles);

      const newIsbns = new Set(state.submittedIsbns || []);
      const isbnClean = String(book.isbn || "").replaceAll("-", "").replaceAll(" ", "").trim().toLowerCase();
      if (isbnClean) newIsbns.add(isbnClean);
      state.submittedIsbns = Array.from(newIsbns);

      // Increment real-world calendar day submits count
      state.todaySubmitCount = (state.todaySubmitCount || 0) + 1;
      state.totalHistoryCount = (state.totalHistoryCount || 0) + 1;
      state.dashboardRecordCount = (state.dashboardRecordCount || 0) + 1;
      state.lastSubmitTime = Date.now();

      // Update AINS dashboard DOM directly without refresh
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue;
        const prevCount = String(state.dashboardRecordCount - 1);
        if (text.includes(prevCount) && node.parentElement && node.parentElement.innerText && node.parentElement.innerText.includes("Rekod")) {
           node.nodeValue = text.replace(prevCount, String(state.dashboardRecordCount));
           break;
        }
      }

      saveState();
      renderApiStatus();

      // Automatically shift selected date to the next day
      shiftSelectedDate(1);

      const currentIndex = state.filtered.findIndex((b) => bookKey(b) === state.selectedKey);
      let isLastBook = false;
      // Advance to the next unread book
      let foundNext = false;
      for (let i = currentIndex + 1; i < state.filtered.length; i++) {
        state.selectedKey = bookKey(state.filtered[i]);
        if (!isCurrentBookDuplicate()) {
          foundNext = true;
          break;
        }
      }
      
      if (foundNext) {
        saveState();
        renderBookSelect();
      } else {
        isLastBook = true;
        renderBookSelect(); // Re-render to disable button on last duplicate book
      }

      // Automatically fetch updated history and refresh book list if needed
      fetchHistory(true).then(() => {
         if (isLastBook) {
           refreshBooks(); // Automatically load new books when exhausted
         }
      }).catch(err => console.error("Auto-sync failed:", err));
    } catch (error) {
      setStatus(`提交失败：${error.message}`);
    }
  }

  function setStatus(text) {
    const el = document.querySelector("#nia-status");
    if (el) el.textContent = text;
    else console.log("NILAM API Assistant:", text);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderApiStatus() {
    const el = document.querySelector("#nia-api-status");
    const status = tokenStatus();
    if (el) {
      el.innerHTML = state.apiTemplate
        ? `凭证捕获：<span style="color:#10b981;font-weight:700;">成功</span><br><span style="font-size:10px;color:#6b7280;">User ID: ${state.userId || "等待中"} | ${status.label} | v${SCRIPT_VERSION}</span>`
        : `<span style="color:#ef4444;font-weight:700;">未捕获凭证</span><br><span style="font-size:10px;color:#6b7280;">请在 AINS 手动提交一次以捕获。 | v${SCRIPT_VERSION}</span>`;
    }
    const countEl = document.querySelector("#nia-history-count");
    if (countEl) {
      countEl.textContent = String(state.dashboardRecordCount || state.totalHistoryCount || 0);
    }
    const todayCountEl = document.querySelector("#nia-today-count");
    if (todayCountEl) {
      if (state.lastSubmitTime && new Date(Number(state.lastSubmitTime)).toDateString() !== new Date().toDateString()) {
        state.todaySubmitCount = 0;
      }
      const todayCount = state.todaySubmitCount || 0;
      todayCountEl.textContent = todayCount;
      if (todayCount >= 30) {
        todayCountEl.style.color = "#ef4444";
        todayCountEl.style.fontWeight = "900";
      } else {
        todayCountEl.style.color = "#10b981";
      }
    }
    const debugEl = document.querySelector("#nia-debug-template");
    if (debugEl) {
      debugEl.value = state.apiTemplate
        ? (typeof state.apiTemplate.bodyText === "string" ? state.apiTemplate.bodyText : JSON.stringify(state.apiTemplate, null, 2))
        : "暂无捕获的 API 负载。";
    }
    updateCooldownUI();
  }

  function updateCooldownUI() {
    const submitBtn = document.querySelector("#nia-submit");
    if (!submitBtn) return;

    if (isCurrentBookDuplicate()) {
      return; 
    }

    if (!state.lastSubmitTime) {
      submitBtn.disabled = false;
      submitBtn.style.opacity = "1";
      submitBtn.style.cursor = "pointer";
      submitBtn.textContent = "点击提交至 AINS (API)";
      return;
    }

    const elapsedMs = Date.now() - Number(state.lastSubmitTime);
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const cooldownSec = 10; // 10 seconds cooldown to behave like human

    if (elapsedSec < cooldownSec) {
      const remaining = cooldownSec - elapsedSec;
      submitBtn.disabled = true;
      submitBtn.style.opacity = "0.6";
      submitBtn.style.cursor = "not-allowed";
      submitBtn.textContent = `冷却中 (${remaining}秒)`;
    } else {
      submitBtn.disabled = false;
      submitBtn.style.opacity = "1";
      submitBtn.style.cursor = "pointer";
      submitBtn.textContent = "点击提交至 AINS (API)";
    }

    const timerEl = document.querySelector("#nia-timer-label");
    if (timerEl) {
      if (elapsedSec < 10) {
        timerEl.textContent = `上次提交：${elapsedSec}秒前`;
      } else if (elapsedSec < 3600) {
        const min = Math.floor(elapsedSec / 60);
        const sec = elapsedSec % 60;
        timerEl.textContent = `上次提交：${min}分${sec}秒前`;
      } else {
        timerEl.textContent = `上次提交：> 1小时前`;
      }
    }
  }

  function renderBookSelect() {
    const select = document.querySelector("#nia-book");
    if (!select) return;

    const submittedTitlesSet = new Set((state.submittedTitles || []).map(t => String(t).trim().toLowerCase()));
    const submittedIsbnsSet = new Set((state.submittedIsbns || []).map(i => String(i).replaceAll("-", "").replaceAll(" ", "").trim().toLowerCase()));

    select.innerHTML = state.filtered.map((book) => {
      const key = bookKey(book);
      const titleLower = String(book.title || "").trim().toLowerCase();
      const isbnClean = String(book.isbn || "").replaceAll("-", "").replaceAll(" ", "").trim().toLowerCase();

      const isDup = submittedTitlesSet.has(titleLower) || (isbnClean && submittedIsbnsSet.has(isbnClean));

      const prefix = isDup ? "🔴 [已读] " : "🟢 [未读] ";
      const displayTitle = `${prefix}${book.title || "Untitled"} - ${book.author || ""}`.trim();
      return `<option value="${escapeHtml(key)}" ${isDup ? 'style="color:#ef4444;"' : 'style="color:#10b981;"'}>${escapeHtml(displayTitle)}</option>`;
    }).join("");
    select.value = state.selectedKey || bookKey(state.filtered[0]);
    renderSourceInfo();
    renderPreview();
  }

  function renderSourceInfo() {
    const el = document.querySelector("#nia-source-info");
    if (!el) return;
    const book = currentBook();
    el.replaceChildren();
    if (state.sourceType === "generated") {
      el.textContent = "AI 仿真书：并非已核验出版物。";
      el.style.color = "#b45309";
      return;
    }
    el.style.color = "#047857";
    el.append("真实书来源：");
    if (book?.sourceUrl) {
      const link = document.createElement("a");
      link.href = book.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = book.sourceName || "查看来源";
      el.append(link);
    } else {
      el.append(book?.sourceName || "可追溯书目");
    }
  }

  function renderPreview() {
    const el = document.querySelector("#nia-preview");
    if (!el) return;
    const book = bookForApi(currentBook());
    if (!book) {
      el.value = "";
      return;
    }
    if (state.apiTemplate && state.userId && typeof CryptoJS !== "undefined") {
      el.value = JSON.stringify(buildAinsPayload(book), null, 2);
    } else {
      el.value = JSON.stringify(book, null, 2);
    }

    const submitBtn = document.querySelector("#nia-submit");
    if (submitBtn) {
      if (isCurrentBookDuplicate()) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = "0.5";
        submitBtn.style.cursor = "not-allowed";
        submitBtn.textContent = "Duplicate (Blocked)";
      } else {
        updateCooldownUI();
      }
    }
    saveState();
  }

  async function refreshBooks() {
    setStatus(`正在载入${state.sourceType === "real" ? "真实" : "AI 仿真"}书籍...`);
    try {
      if (state.apiTemplate && state.userId && tokenStatus().ok) {
        await fetchHistory(false);
      } else if (!(state.submittedTitles || []).length && !(state.submittedIsbns || []).length) {
        throw new Error("sync history first so used books can be excluded");
      }

      const batch = await fetchNextBooks();
      if (batch.length === 0) {
        throw new Error("no unused books available from cloud API");
      }

      state.books = batch;
      state.filters = { category: "all", language: "all" };
      state.selectedKey = bookKey(state.books[0]);
      applyFilters();
      renderFilterControls();
      renderBookSelect();
      renderApiStatus();
      setStatus(`已载入 ${state.books.length} 本${state.sourceType === "real" ? "真实" : "AI 仿真"}书籍。`);
    } catch (error) {
      setStatus(`Refresh unused books failed: ${error.message}`);
    }
  }

  let isDragging = false;
  let startX = 0, startY = 0;
  let panelLeft = 0, panelTop = 0;

  function initDrag(header, panel) {
    header.style.cursor = "move";

    function startDrag(clientX, clientY, e) {
      if (e.target.closest("button") || e.target.closest("select") || e.target.closest("input")) return;
      isDragging = true;
      startX = clientX;
      startY = clientY;
      const rect = panel.getBoundingClientRect();
      panelLeft = rect.left;
      panelTop = rect.top;

      if (e.type.startsWith("touch")) {
        document.addEventListener("touchmove", onTouchMove, { passive: false });
        document.addEventListener("touchend", onTouchEnd);
      } else {
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      }
      e.preventDefault();
    }

    header.addEventListener("mousedown", (e) => {
      startDrag(e.clientX, e.clientY, e);
    });

    header.addEventListener("touchstart", (e) => {
      const touch = e.touches[0];
      startDrag(touch.clientX, touch.clientY, e);
    }, { passive: false });

    function onMouseMove(e) {
      moveDrag(e.clientX, e.clientY);
    }

    function onTouchMove(e) {
      const touch = e.touches[0];
      moveDrag(touch.clientX, touch.clientY);
      e.preventDefault(); // Prevent scrolling page while dragging panel
    }

    function moveDrag(clientX, clientY) {
      if (!isDragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;

      let newLeft = panelLeft + dx;
      let newTop = panelTop + dy;

      const panelWidth = panel.offsetWidth || 320;
      const panelHeight = panel.offsetHeight || 300;
      const minGap = 10;

      const maxLeft = window.innerWidth - panelWidth - minGap;
      const maxTop = window.innerHeight - panelHeight - minGap;

      newLeft = Math.max(minGap, Math.min(newLeft, maxLeft));
      newTop = Math.max(minGap, Math.min(newTop, maxTop));

      panel.style.left = `${newLeft}px`;
      panel.style.top = `${newTop}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    }

    function onMouseUp() {
      endDrag();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    function onTouchEnd() {
      endDrag();
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    }

    function endDrag() {
      isDragging = false;
      localStorage.setItem(PANEL_X_KEY, panel.style.left);
      localStorage.setItem(PANEL_Y_KEY, panel.style.top);
    }
  }

  function adjustPanelToViewport() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const minGap = 10;
    const panelWidth = rect.width || 320;
    const panelHeight = rect.height || 200;

    let x = Number.isFinite(rect.left) ? rect.left : window.innerWidth - panelWidth - minGap;
    let y = Number.isFinite(rect.top) ? rect.top : minGap;
    let changed = false;

    if (rect.width < 80 || rect.height < 40) {
      x = window.innerWidth - panelWidth - minGap;
      y = minGap;
      changed = true;
    }

    if (x < minGap) { x = minGap; changed = true; }
    if (y < minGap) { y = minGap; changed = true; }
    if (x + panelWidth > window.innerWidth - minGap) {
      x = window.innerWidth - panelWidth - minGap;
      changed = true;
    }
    if (y + panelHeight > window.innerHeight - minGap) {
      y = window.innerHeight - panelHeight - minGap;
      changed = true;
    }

    if (y < minGap) {
      y = minGap;
      changed = true;
    }

    if (x < minGap || x > window.innerWidth - minGap || y < minGap || y > window.innerHeight - minGap) {
      x = Math.max(minGap, window.innerWidth - panelWidth - minGap);
      y = minGap;
      changed = true;
    }

    if (changed) {
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      localStorage.setItem(PANEL_X_KEY, panel.style.left);
      localStorage.setItem(PANEL_Y_KEY, panel.style.top);
    }
  }

  function toggleCollapse() {
    state.collapsed = !state.collapsed;
    saveState();
    const body = document.querySelector("#nia-body");
    const toggle = document.querySelector("#nia-toggle");
    if (body && toggle) {
      body.style.display = state.collapsed ? "none" : "block";
      toggle.textContent = state.collapsed ? "＋" : "－";
    }
    adjustPanelToViewport();
  }

  let autoSubmitTimer = null;

  function toggleAutoSubmit() {
    const btn = document.querySelector("#nia-auto-submit");
    if (!btn) return;
    
    if (autoSubmitTimer) {
      clearInterval(autoSubmitTimer);
      autoSubmitTimer = null;
      btn.textContent = "🚀 自动提交 (1分钟/次)";
      btn.classList.remove("nia-submit");
      btn.classList.add("nia-secondary");
      setStatus("自动提交已停止。");
    } else {
      if (!ensureUsableToken("自动提交")) return;
      if ((state.todaySubmitCount || 0) >= 30) {
        setStatus("今日额度已满，无法开启自动提交。");
        return;
      }
      btn.textContent = "🛑 停止自动提交 (运行中...)";
      btn.classList.remove("nia-secondary");
      btn.classList.add("nia-submit");
      setStatus("已开启自动提交。正在执行...");

      const executeAutoSubmit = async () => {
        // Skip duplicate books automatically
        if (isCurrentBookDuplicate()) {
          const currentIndex = state.filtered.findIndex((b) => bookKey(b) === state.selectedKey);
          let foundNext = false;
          for (let i = currentIndex + 1; i < state.filtered.length; i++) {
            state.selectedKey = bookKey(state.filtered[i]);
            if (!isCurrentBookDuplicate()) {
              foundNext = true;
              break;
            }
          }
          if (foundNext) {
            saveState();
            renderBookSelect();
          } else {
            toggleAutoSubmit();
            setStatus("没有更多未读图书，自动提交已停止。请刷新题库。");
            return;
          }
        }

        const currentBook = document.querySelector("#nia-book")?.value;
        if (!currentBook) {
          toggleAutoSubmit();
          setStatus("没有可用图书，自动提交已停止。请刷新题库。");
          return;
        }
        if ((state.todaySubmitCount || 0) >= 30) {
          toggleAutoSubmit();
          setStatus("今日额度已满，自动提交已停止。");
          alert("🎉 NILAM 自动挂机已完成：\n\n今日 30 本提交额度已满，为了防止封号风险，自动提交已停止。");
          return;
        }
        if (!state.apiTemplate) {
          toggleAutoSubmit();
          setStatus("API 凭证丢失，自动提交已停止。");
          return;
        }
        await submitApi();
        if (autoSubmitTimer) {
          setStatus("自动提交等待中... 下一本书将在 1 分钟后提交。");
        }
      };

      executeAutoSubmit();
      autoSubmitTimer = setInterval(executeAutoSubmit, 61000);
    }
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    try {
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <style>
        #${PANEL_ID} {
          position: fixed;
          z-index: 999999;
          width: 320px;
          max-width: calc(100vw - 24px);
          border: 1px solid rgba(139, 92, 246, 0.3);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          color: #1f2937;
          box-shadow: 0 20px 40px rgba(0,0,0,0.15);
          font: 13px/1.4 system-ui, -apple-system, sans-serif;
          overflow: hidden;
          transition: border-color 0.2s;
        }
        .nia-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: #fff;
          user-select: none;
        }
        .nia-header h2 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: 0.5px; }
        .nia-header button {
          background: transparent;
          border: 0;
          color: #fff;
          font-size: 16px;
          cursor: pointer;
          padding: 0 4px;
        }
        .nia-body { padding: 12px; }
        #${PANEL_ID} label { display: grid; gap: 4px; margin: 8px 0; font-size: 11px; font-weight: 600; color: #4b5563; }
        #${PANEL_ID} select, #${PANEL_ID} input, #${PANEL_ID} textarea {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          padding: 6px 8px;
          background: #f9fafb;
          color: #111827;
          font-size: 12px;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        #${PANEL_ID} select:focus, #${PANEL_ID} input:focus {
          border-color: #8b5cf6;
          box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.2);
          outline: none;
        }
        #${PANEL_ID} textarea { height: 100px; resize: vertical; font-family: Consolas, monospace; font-size: 10px; background: #f3f4f6; }
        .nia-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .nia-date-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
        .nia-date-btn {
          background: #e5e7eb;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          color: #374151;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
          user-select: none;
          transition: background 0.1s;
        }
        .nia-date-btn:hover { background: #d1d5db; }
        .nia-date-btn:active { background: #9ca3af; }
        .nia-actions-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 12px; }
        .nia-btn {
          min-height: 32px;
          border: 0;
          border-radius: 6px;
          color: #fff;
          font-weight: 700;
          font-size: 11px;
          cursor: pointer;
          transition: opacity 0.15s, transform 0.1s;
        }
        .nia-btn:active { transform: scale(0.97); }
        .nia-submit { background: linear-gradient(135deg, #8b5cf6, #7c3aed); }
        .nia-secondary { background: #6b7280; }
        .nia-line { margin: 8px 0; font-size: 11px; color: #4b5563; line-height: 1.5; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
        #nia-status { margin-top: 8px; font-weight: 700; color: #7c3aed; min-height: 18px; text-align: center; }
        .nia-debug-details { margin-top: 8px; }
        .nia-debug-details summary { cursor: pointer; font-size: 10px; font-weight: 600; color: #4b5563; user-select: none; }
        .nia-debug-textarea { height: 80px !important; font-family: monospace; font-size: 9px !important; margin-top: 4px; background: #f9fafb !important; }
        #nia-diagnostics { margin-top: 6px; font-size: 10px; color: #7c2d12; overflow-wrap: anywhere; }
      </style>
      <div class="nia-header" id="nia-drag-header">
        <div>
          <h2>NILAM 助手 <span style="font-size:10px;font-weight:600;opacity:.8;">v${SCRIPT_VERSION}</span></h2>
          <div id="nia-header-profile" style="font-size:10px;color:rgba(255,255,255,0.85);font-weight:600;margin-top:2px;"></div>
        </div>
        <button id="nia-toggle" type="button">－</button>
      </div>
      <div class="nia-body" id="nia-body" style="display: ${state.collapsed ? "none" : "block"};">
        <div class="nia-row">
          <select id="nia-source-type">
            <option value="real">真实书（默认）</option>
            <option value="generated">AI 仿真书</option>
          </select>
          <select id="nia-category">
            <option value="all">所有分类</option>
            <option value="Fiksyen">虚构类 (Fiksyen)</option>
            <option value="Bukan Fiksyen">非虚构类 (Bukan Fiksyen)</option>
          </select>
          <select id="nia-language">
            <option value="bm">马来文 (BM)</option>
            <option value="en">英文 (EN)</option>
            <option value="zh">中文 (ZH)</option>
            <option value="all">所有语言</option>
          </select>
        </div>
        <div class="nia-date-row">
          <button id="nia-date-prev" type="button" class="nia-date-btn">◀</button>
          <label style="flex: 1; display: grid; gap: 4px; margin: 0; font-size: 11px; font-weight: 600; color: #4b5563;">提交日期 <input id="nia-date" type="date" style="margin: 0;"></label>
          <button id="nia-date-next" type="button" class="nia-date-btn">▶</button>
        </div>
        <label>选择图书 <select id="nia-book"></select></label>
        <div id="nia-source-info" class="nia-line"></div>
        <div class="nia-line">AINS API 凭证状态：<br><span id="nia-api-status">未捕获</span><br><span style="font-size:10px;color:#4b5563;">已同步：<span id="nia-history-count" style="font-weight:700;">0</span> 本 | 今日已交：<span id="nia-today-count" style="font-weight:700;">0</span>/30</span><br><span id="nia-timer-label" style="font-size:10px;color:#6b7280;font-weight:600;">上次提交：无</span></div>
        <button id="nia-refresh-books" type="button" class="nia-btn nia-secondary" style="width:100%;margin-top:8px;">Refresh Unused Books</button>
        <details class="nia-debug-details">
          <summary>显示提交负载预览</summary>
          <textarea id="nia-preview" readonly style="margin-top: 4px;"></textarea>
        </details>
        <div class="nia-actions-3">
          <button id="nia-submit" type="button" class="nia-btn nia-submit">点击提交至 AINS (API)</button>
          <button id="nia-replay-api" type="button" class="nia-btn nia-secondary">单步测试</button>
          <button id="nia-sync-api" type="button" class="nia-btn nia-secondary">同步记录</button>
        </div>
        <button id="nia-auto-submit" type="button" class="nia-btn nia-secondary" style="width:100%;margin-top:8px;">🚀 自动提交 (1分钟/次)</button>
        <button id="nia-clear-api" type="button" class="nia-btn nia-secondary" style="width:100%;margin-top:8px;">清除登录凭证</button>
        <details class="nia-debug-details">
          <summary>显示捕获的 API 负载</summary>
          <textarea id="nia-debug-template" class="nia-debug-textarea" readonly></textarea>
        </details>
        <div id="nia-diagnostics"></div>
        <div id="nia-status">正在加载书籍数据库...</div>
      </div>
    `;
    document.body.append(panel);

    const savedX = localStorage.getItem(PANEL_X_KEY);
    const savedY = localStorage.getItem(PANEL_Y_KEY);
    const minGap = 10;
    const panelWidth = 320;

    if (savedX && savedY) {
      let x = parseFloat(savedX);
      let y = parseFloat(savedY);
      if (isNaN(x)) x = window.innerWidth - panelWidth - minGap;
      if (isNaN(y)) y = minGap;

      x = Math.max(minGap, Math.min(x, window.innerWidth - panelWidth - minGap));
      y = Math.max(minGap, Math.min(y, window.innerHeight - 300));

      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    } else {
      panel.style.right = `${minGap}px`;
      panel.style.bottom = `${minGap}px`;
    }

    initDrag(document.getElementById("nia-drag-header"), panel);
    adjustPanelToViewport();

    document.querySelector("#nia-category").value = state.filters.category;
    document.querySelector("#nia-language").value = state.filters.language;
    document.querySelector("#nia-source-type").value = state.sourceType;
    document.querySelector("#nia-date").value = normalizeIsoDate(state.selectedDate);

    panel.addEventListener("change", async (event) => {
      if (event.target.id === "nia-date") state.selectedDate = normalizeIsoDate(event.target.value);
      if (event.target.id === "nia-book") state.selectedKey = event.target.value;
      if (event.target.id === "nia-category") state.filters.category = event.target.value;
      if (event.target.id === "nia-language") state.filters.language = event.target.value;
      if (event.target.id === "nia-source-type") {
        state.sourceType = event.target.value === "generated" ? "generated" : "real";
        state.books = [];
        state.selectedKey = "";
        saveState();
        await refreshBooks();
        return;
      }
      applyFilters();
      renderBookSelect();
    });

    panel.addEventListener("click", async (event) => {
      if (event.target.id === "nia-toggle") toggleCollapse();
      const button = event.target.closest("button");
      if (!button) return;
      if (button.id === "nia-date-prev" || button.id === "nia-date-next") {
        shiftSelectedDate(button.id === "nia-date-next" ? 1 : -1);
      }
      if (button.id === "nia-submit") await submitApi();
      if (button.id === "nia-auto-submit") toggleAutoSubmit();
      if (button.id === "nia-refresh-books") await refreshBooks();
      if (button.id === "nia-replay-api") await replayCapturedApi();
      if (button.id === "nia-sync-api") await fetchHistory();
      if (button.id === "nia-clear-api") {
        if (state.apiTemplate) {
          delete state.apiTemplate.headers.authorization;
        }
        state.userId = null;
        state.tokenExpiresAt = null;
        state.submittedTitles = [];
        state.submittedIsbns = [];
        state.totalHistoryCount = 0;
        state.dashboardRecordCount = 0;
        state.todaySubmitCount = 0;
        state.lastSubmitTime = null;
        state.sourceType = "real";
        const sourceSelect = document.querySelector("#nia-source-type");
        if (sourceSelect) sourceSelect.value = "real";
        saveState();
        renderApiStatus();
        renderBookSelect();
        setStatus("登录凭证已清除。请在 AINS 手动操作一次以重新捕获。");
      }
    });

    panelReady = true;
    renderApiStatus();
    } catch (error) {
      console.error("NILAM API Assistant: createPanel failed", error);
      document.getElementById(PANEL_ID)?.remove();
      panelReady = false;
    }
  }

  // === Student Profile DOM Scraper (read-only, safe) ===
  function scrapeProfileFromPage() {
    if (state.studentName && state.studentGrade) return; // Already have both, skip

    const BLACKLIST = /^(FAQ|ERROR|UNAUTHORIZED|FORBIDDEN|HOME|MENU|LOGIN|LOGOUT|AINS|NILAM|DASHBOARD|SETTINGS)$/i;

    try {
      // Strategy: find all text nodes containing the @moe email, then look at the parent container
      const allElements = document.querySelectorAll("*");
      for (const el of allElements) {
        const text = (el.textContent || "").trim();
        if (!text.includes("@moe")) continue;

        // Split container text into lines
        const lines = text.split(/\n|\r\n?/).map(l => l.trim()).filter(l => l.length > 0);
        const emailIdx = lines.findIndex(l => l.includes("@moe"));
        if (emailIdx < 0) continue;

        // Name is typically the line before the email
        if (!state.studentName && emailIdx > 0) {
          const candidate = lines[emailIdx - 1];
          if (candidate.length >= 4 && candidate.length <= 50 && /^[A-Z\s'.@-]+$/.test(candidate) && !BLACKLIST.test(candidate)) {
            state.studentName = candidate;
          }
        }

        // Grade is typically a line like "1 A" or "2B" nearby
        if (!state.studentGrade) {
          for (let i = 0; i < lines.length; i++) {
            if (/^\d\s?[A-Z]$/.test(lines[i].trim())) {
              state.studentGrade = lines[i].trim();
              break;
            }
          }
        }

        if (state.studentName || state.studentGrade) {
          saveState();
          renderHeaderProfile();
          break;
        }
      }
    } catch (e) {
      // Silently ignore DOM scraping errors
    }
  }

  function renderHeaderProfile() {
    const el = document.querySelector("#nia-header-profile");
    if (!el) return;
    const parts = [];
    if (state.studentName) parts.push(state.studentName);
    if (state.studentGrade) parts.push(`(${state.studentGrade})`);
    el.textContent = parts.join(" ") || "";
  }

  function scrapeDashboardRecordCount() {
    const text = document.body?.innerText || "";
    const match = text.match(/\b(\d{1,5})\s+Rekod\b/i);
    if (!match) return;
    const count = Number(match[1]);
    if (Number.isFinite(count) && count >= 0) {
      const current = state.dashboardRecordCount || 0;
      if (count >= current || current - count > 5) {
        state.dashboardRecordCount = count;
        saveState();
        renderApiStatus();
      }
    }
  }

  async function main() {
    patchFetch();
    patchXhr();
    window.addEventListener("resize", adjustPanelToViewport);

    const tryCreatePanel = () => {
      if (!document.getElementById(PANEL_ID) && document.body) {
        createPanel();
      }
    };

    setInterval(() => {
      tryCreatePanel();
      if (panelReady) {
        updateCooldownUI();
        scrapeProfileFromPage();
        scrapeDashboardRecordCount();
        renderHeaderProfile();
      }
    }, 1000);

    try {
      state.selectedDate = normalizeIsoDate(state.selectedDate);
      applyFilters();
      tryCreatePanel();

      setTimeout(() => {
        tryCreatePanel();
        renderBookSelect();
        setStatus(`本地书籍数据库已就绪：共 30 本。`);
        if (state.apiTemplate && state.userId) {
          fetchHistory(); // Sync history on load if credentials exist
        }
      }, 500);
    } catch (error) {
      console.error("NILAM API Assistant: Init failed:", error);
      setStatus(`Init failed: ${error.message}`);
    }
  }

  main().catch((error) => {
    if (panelReady) setStatus(`Error: ${error.message}`);
    else console.error(error);
  });
})();

