/*
GUI for check_httpv2
Copyright (C) 2026 Mirco lang
See COPYING file for more
*/

// Wrap everything to avoid leaking globals and to survive partial DOM
(() => {
  // --------------------------
  // Helpers: DOM & storage
  // --------------------------
  const form = document.getElementById("checkForm");
  const statusDiv = document.getElementById("status");
  const output = document.getElementById("output");
  const tableBody = document.querySelector("#summaryTable tbody");
  const advToggle = document.getElementById("toggleAdvanced");
  const profileSelect = document.getElementById("profileSelect"); // quick-load dropdown (if present)

  // expose a few helpers for inline HTML scripts (profile preview etc.)
  window.getProfiles = getProfiles;
  window.saveProfiles = saveProfiles;
  window.syncProfilesToServer = syncProfilesToServer;
  window.syncProfileDropdown = syncProfileDropdown;
  window.form = form;

  // Safe query helper
  const hasEl = (id) => !!document.getElementById(id);

  // JSON -> application/x-www-form-urlencoded (flat object)
  function jsonToFormEncoded(jsonStr) {
    const obj = JSON.parse(jsonStr);
    if (obj === null || Array.isArray(obj) || typeof obj !== "object") {
      throw new Error('JSON body must be an object like {"a":1}');
    }
    return Object.entries(obj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
  }

  // Advanced toggle
  function setAdvancedVisible(visible) {
    document.querySelectorAll(".adv").forEach((el) =>
      el.classList.toggle("d-none", !visible)
    );
    localStorage.setItem("showAdvanced", visible ? "1" : "0");
  }
  if (advToggle) {
    advToggle.addEventListener("change", () =>
      setAdvancedVisible(advToggle.checked)
    );
    const show = localStorage.getItem("showAdvanced") === "1";
    advToggle.checked = show;
    setAdvancedVisible(show);
  }

  // Persist last form
  if (form) {
    form.addEventListener("change", () => {
      const data = Object.fromEntries(new FormData(form).entries());
      localStorage.setItem("lastForm", JSON.stringify(data));
    });
    // Restore
    try {
      const raw = localStorage.getItem("lastForm");
      if (raw) {
        const data = JSON.parse(raw);
        for (const [k, v] of Object.entries(data)) {
          const el = form.elements[k];
          if (!el) continue;
          if (el.type === "checkbox")
            el.checked = v === "on" || v === true || v === "true";
          else el.value = v;
        }
      }
    } catch {}
  }

  // Content tab visibility (show only for POST/PUT/PATCH)
  function updateContentTabVisibility() {
    const methodEl = document.getElementById("methodSelect") || form?.elements["method"];
    const tabLi = document.getElementById("content-tab-li");
    const pane = document.getElementById("content");
    if (!methodEl || !tabLi || !pane) return;

    const m = String(methodEl.value || "").trim().toUpperCase();
    const show = (m === "POST" || m === "PUT" || m === "PATCH");

    tabLi.classList.toggle("d-none", !show);
    pane.classList.toggle("d-none", !show);

    // If we hide while active, jump back to Basic tab (if present)
    if (!show) {
      const contentBtn = document.getElementById("content-tab");
      if (contentBtn && contentBtn.classList.contains("active")) {
        const basicBtn =
          document.getElementById("basic-tab") ||
          document.querySelector('[data-bs-target="#basic"]');
        if (basicBtn && window.bootstrap) {
          bootstrap.Tab.getOrCreateInstance(basicBtn).show();
        }
      }
    }
  }
  if (form) {
    const methodEl = document.getElementById("methodSelect") || form.elements["method"];
    if (methodEl) methodEl.addEventListener("change", updateContentTabVisibility);
    updateContentTabVisibility();
  }

  // --------------------------
  // Profiles: LS <-> server
  // --------------------------
  function getProfiles() {
    try {
      return JSON.parse(localStorage.getItem("profiles")) || {};
    } catch {
      return {};
    }
  }

  function saveProfiles(obj) {
    localStorage.setItem("profiles", JSON.stringify(obj));
    syncProfilesToServer();
    syncProfileDropdown();
  }

  function syncProfilesToServer() {
    const profiles = getProfiles();
    fetch("/export-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profiles),
    }).catch((err) => console.error("Profile sync failed:", err));
  }

  function syncProfileDropdown() {
    if (!profileSelect) return;
    const profiles = getProfiles();
    const current = localStorage.getItem("currentProfile") || "";
    profileSelect.innerHTML = `<option value="">Load Profile...</option>`;
    Object.keys(profiles)
      .sort()
      .forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        if (name === current) opt.selected = true;
        profileSelect.appendChild(opt);
      });
  }
  
  async function syncProfilesFromServer() {
    try {
      const res = await fetch("/profiles", { cache: "no-store" });
      if (!res.ok) return;
  
      const serverProfiles = await res.json();
  
      // Merge: server -> local (local wins on conflicts)
      const local = getProfiles();
      const merged = { ...local, ...serverProfiles }; // server wins
  
      // Only write + re-export if something changed
      const before = JSON.stringify(local);
      const after = JSON.stringify(merged);
      if (before !== after) {
        localStorage.setItem("profiles", after);
        // optional: keep server in sync with the merged set
        syncProfilesToServer();
      }
  
      syncProfileDropdown();
    } catch (e) {
      console.error("Profile import failed:", e);
    }
  }

  // initial
  syncProfileDropdown();
  // initial
  syncProfileDropdown();
  syncProfilesFromServer();

  // Quick-load change
  if (profileSelect) {
    profileSelect.addEventListener("change", () => {
      const name = profileSelect.value;
      if (!name) return;
      const profiles = getProfiles();
      const p = profiles[name];
      if (!p || !form) return;

      for (const [k, v] of Object.entries(p)) {
        const el = form.elements[k];
        if (!el) continue;
        if (el.type === "checkbox")
          el.checked = v === "on" || v === true || v === "true";
        else el.value = v;
      }
      localStorage.setItem("currentProfile", name);
      // update content tab visibility (if present)
      updateContentTabVisibility();
    });
  }

  // Buttons: Save / Update / Delete profile
  const btnSave = document.getElementById("saveProfile");
  const btnUpdate = document.getElementById("updateProfile");
  const btnDelete = document.getElementById("deleteProfile");

  function currentFormAsProfile() {
    if (!form) return {};
    const fd = new FormData(form);
    const data = Object.fromEntries(fd.entries());
    // normalize checkbox values
    ["ignore_proxy_env", "disable_cert", "without_body", "header_regexes_invert", "body_regex_invert", "debug_headers", "debug_content"].forEach((name) => {
      const el = form.elements[name];
      if (!el) return;
      data[name] = !!el.checked;
    });
    return data;
  }

  if (btnSave) {
    btnSave.addEventListener("click", () => {
      if (!form) return;
      const url = (form.elements["url"]?.value || "").trim();
      const suggested = url ? url.replace(/^https?:\/\//i, "").replace(/[^\w.-]+/g, "_") : "profile";
      const name = prompt("Profile name:", suggested);
      if (!name) return;

      const profiles = getProfiles();
      profiles[name] = currentFormAsProfile();
      saveProfiles(profiles);
      localStorage.setItem("currentProfile", name);
      syncProfileDropdown();
      alert(`Saved profile: ${name}`);
    });
  }

  if (btnUpdate) {
    btnUpdate.addEventListener("click", () => {
      const name =
        (profileSelect?.value || "").trim() ||
        (localStorage.getItem("currentProfile") || "").trim();
      if (!name) {
        alert("No profile selected to update.");
        return;
      }
      const profiles = getProfiles();
      if (!profiles[name]) {
        alert(`Profile "${name}" not found.`);
        return;
      }
      profiles[name] = currentFormAsProfile();
      saveProfiles(profiles);
      alert(`Updated profile: ${name}`);
    });
  }

  if (btnDelete) {
    btnDelete.addEventListener("click", () => {
      const name =
        (profileSelect?.value || "").trim() ||
        (localStorage.getItem("currentProfile") || "").trim();
      if (!name) return;
      if (!confirm(`Delete profile "${name}"?`)) return;
      const profiles = getProfiles();
      delete profiles[name];
      saveProfiles(profiles);
      if (profileSelect) profileSelect.value = "";
      localStorage.removeItem("currentProfile");
      alert(`Deleted: ${name}`);
    });
  }

  // --------------------------
  // Collect payload for /run
  // --------------------------
  function collectPayload() {
    const fd = new FormData(form);
    const data = Object.fromEntries(fd.entries());

    // normalize checkboxes
    [
      "ignore_proxy_env",
      "disable_cert",
      "without_body",
      "header_regexes_invert",
      "body_regex_invert",
      "debug_headers",
      "debug_content",
    ].forEach((name) => {
      const el = form.elements[name];
      if (el && el.type === "checkbox") data[name] = !!el.checked;
      else if (name in data && data[name] === "on") data[name] = true;
    });

    const mls = (name) => {
      const el = form.elements[name];
      if (!el || !el.value) return undefined;
      return el.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    };

    const headers = mls("headers");
    const header_strings = mls("header_strings");
    const header_regexes = mls("header_regexes");
    const body_string = mls("body_string");
    const body_regex = mls("body_regex");

    // status_code: accept lines or commas
    const sc_raw = form.elements["status_code"]?.value || "";
    const status_code = sc_raw
      .split(/\r?\n/)
      .join(",")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (headers) data.headers = headers;
    if (header_strings) data.header_strings = header_strings;
    if (header_regexes) data.header_regexes = header_regexes;
    if (status_code.length) data.status_code = status_code;
    if (body_string) data.body_string = body_string;
    if (body_regex) data.body_regex = body_regex;

    // Optional: Convert JSON body to x-www-form-urlencoded
    const jsonToForm = document.getElementById("jsonToForm");
    if (jsonToForm && jsonToForm.checked && data.body && String(data.body).trim()) {
      const raw = String(data.body).trim();
      if (raw.startsWith("{") || raw.startsWith("[")) {
        data.body = jsonToFormEncoded(raw);
        if (!data.content_type || !String(data.content_type).trim()) {
          data.content_type = "application/x-www-form-urlencoded";
        }
      }
    }

    return data;
  }

  // --------------------------
  // Summary parsing & table
  // --------------------------
  function parseStdout(stdout, userInput = {}) {
    const m = {};
    const pick = (re) => {
      const mm = stdout.match(re);
      return mm ? mm[1] : "";
    };
    m.statusCode = pick(/Status:\s+(\d+\s+\w+)/);
    m.responseTime = pick(/Response time:\s+([\d.]+)\s+seconds/);
    m.pageSize = pick(/Page size:\s+(\d+)\s+Bytes/);
    m.pageAge = pick(/Page age:\s+(\d+)\s+seconds/);
    m.certDays = pick(/Server certificate validity:\s+(\d+)\s+days/);

    m.bodyString = (() => {
      const mm = stdout.match(/Expected string in body:\s+(.+)/);
      if (!mm) return "";
      // strip perfdata if present in same line
      return mm[1].replace(/\s*\|\s*response_time=.*$/i, "").trim();
    })();

    m.expected = {
      statusCode: arrOrCsv(userInput.status_code),
      responseTime: userInput.response_time_levels || "",
      pageSize: userInput.page_size || "",
      bodyString: arrOrCsv(userInput.body_string),
    };
    return m;

    function arrOrCsv(v) {
      if (!v) return "";
      if (Array.isArray(v)) return v.join(",");
      return String(v);
    }
  }

  function badgeHtml(text, kind) {
  const map = { ok: "bg-success", warn: "bg-warning text-dark", crit: "bg-danger", muted: "bg-secondary" };
  return `<span class="badge ${map[kind] || "bg-secondary"}">${text}</span>`;
}

function parseWarnCrit(levelStr) {
  // "0.1,0.2" -> {warn:0.1, crit:0.2}
  if (!levelStr) return { warn: null, crit: null };
  const parts = String(levelStr).trim().split(/[,\s;]+/).filter(Boolean);
  const w = Number(parts[0]), c = Number(parts[1]);
  return {
    warn: Number.isFinite(w) ? w : null,
    crit: Number.isFinite(c) ? c : null,
  };
}

function parseMinMax(str) {
  // "1,1000" -> {min:1, max:1000}
  if (!str) return { min: null, max: null };
  const parts = String(str).trim().split(/[,\s;]+/).filter(Boolean);
  const mn = Number(parts[0]), mx = Number(parts[1]);
  return {
    min: Number.isFinite(mn) ? mn : null,
    max: Number.isFinite(mx) ? mx : null,
  };
}

  function fillSummaryTable(parsed, userInput = {}) {
  if (!tableBody) return;
  tableBody.innerHTML = "";

  const addRow = (metric, value, expected, state) => {
    const tr = document.createElement("tr");
    const v = value ?? "";
    const e = expected ?? "";
    const s = state ?? "";
    tr.innerHTML = `
      <td>${metric}</td>
      <td>${v}</td>
      <td>${e}</td>
      <td>${s}</td>
    `;
    tableBody.appendChild(tr);
  };

  // --- helpers (local) ---
  const toNum = (x) => {
    const m = String(x ?? "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  };

  const parseWarnCrit = (levelStr) => {
    if (!levelStr) return { warn: null, crit: null };
    const parts = String(levelStr).trim().split(/[,\s;]+/).filter(Boolean);
    const w = Number(parts[0]);
    const c = Number(parts[1]);
    return {
      warn: Number.isFinite(w) ? w : null,
      crit: Number.isFinite(c) ? c : null,
    };
  };

  const parseMinMax = (str) => {
    if (!str) return { min: null, max: null };
    const parts = String(str).trim().split(/[,\s;]+/).filter(Boolean);
    const mn = Number(parts[0]);
    const mx = Number(parts[1]);
    return {
      min: Number.isFinite(mn) ? mn : null,
      max: Number.isFinite(mx) ? mx : null,
    };
  };

  const hasExpectation = (x) => {
    if (x === undefined || x === null) return false;
    if (Array.isArray(x)) return x.length > 0;
    return String(x).trim().length > 0;
  };

  // --- badges ---
  // HTTP status
  let httpBadge = "";
  if (hasExpectation(parsed.expected?.statusCode) && parsed.statusCode) {
    const got = String(parsed.statusCode).match(/^(\d+)/)?.[1];
    const exp = String(parsed.expected.statusCode).split(/[,\s]+/).filter(Boolean);
    if (got && exp.length) httpBadge = exp.includes(got) ? badgeHtml("OK", "ok") : badgeHtml("CRIT", "crit");
    else httpBadge = badgeHtml("OK", "info");
  }

  // Response time
  let rtBadge = "";
  if (hasExpectation(userInput.response_time_levels) && parsed.responseTime) {
    const rt = toNum(parsed.responseTime);
    const lv = parseWarnCrit(userInput.response_time_levels);
    if (Number.isFinite(rt) && (lv.warn != null || lv.crit != null)) {
      if (lv.crit != null && rt >= lv.crit) rtBadge = badgeHtml("CRIT", "crit");
      else if (lv.warn != null && rt >= lv.warn) rtBadge = badgeHtml("WARN", "warn");
      else rtBadge = badgeHtml("OK", "ok");
    }
  }

  // Page size
  let psBadge = "";
  if (hasExpectation(userInput.page_size) && parsed.pageSize) {
    const ps = toNum(parsed.pageSize);
    const mm = parseMinMax(userInput.page_size);
    if (Number.isFinite(ps) && (mm.min != null || mm.max != null)) {
      if (mm.min != null && ps < mm.min) psBadge = badgeHtml("CRIT", "crit");
      else if (mm.max != null && ps > mm.max) psBadge = badgeHtml("CRIT", "crit");
      else psBadge = badgeHtml("OK", "ok");
    }
  }

  // Body match (string)
  let bodyBadge = "";
  if (hasExpectation(userInput.body_string)) {
    const txt = String(parsed.bodyString || "");
    if (/\(found\)/i.test(txt)) bodyBadge = badgeHtml("OK", "ok");
    else if (/\(not found\)/i.test(txt)) bodyBadge = badgeHtml("CRIT", "crit");
  }

  // Certificate validity (lower is worse)
  let certBadge = "";
  if (hasExpectation(userInput.certificate_levels) && parsed.certDays) {
    const days = toNum(parsed.certDays);
    const lv = parseWarnCrit(userInput.certificate_levels);
    if (Number.isFinite(days) && (lv.warn != null || lv.crit != null)) {
      if (lv.crit != null && days <= lv.crit) certBadge = badgeHtml("CRIT", "crit");
      else if (lv.warn != null && days <= lv.warn) certBadge = badgeHtml("WARN", "warn");
      else certBadge = badgeHtml("OK", "ok");
    }
  }

  // Page age (WARN only)
  let ageBadge = "";
  if (hasExpectation(userInput.document_age_levels) && parsed.pageAge) {
    const age = toNum(parsed.pageAge);
    const warn = toNum(userInput.document_age_levels);
    if (Number.isFinite(age) && Number.isFinite(warn)) {
      ageBadge = age >= warn ? badgeHtml("WARN", "warn") : badgeHtml("OK", "ok");
    }
  }

  // Known metrics
  addRow("HTTP status", parsed.statusCode || "-", parsed.expected?.statusCode || "-", httpBadge);
  addRow("Response time (s)", parsed.responseTime || "-", userInput.response_time_levels || "-", rtBadge);
  addRow("Page size (Bytes)", parsed.pageSize || "-", userInput.page_size || "-", psBadge);
  addRow("Body match", parsed.bodyString || "-", hasExpectation(userInput.body_string) ? (Array.isArray(userInput.body_string) ? userInput.body_string.join(", ") : userInput.body_string) : "-", bodyBadge);
  addRow("Certificate validity (days)", parsed.certDays || "-", userInput.certificate_levels || "-", certBadge);
  addRow("Page age (s)", parsed.pageAge || "-", userInput.document_age_levels || "-", ageBadge);

  // Extra: show explicitly set options
  const extra = [
    "method","timeout","interval","http_version","server","min_tls_version","tls_version",
    "onredirect","max_redirs","force_ip_version","auth_user","proxy_url","ignore_proxy_env",
    "disable_cert","without_body","debug_headers","debug_content",
  ];
  extra.forEach((k) => {
    const v = userInput[k];
    if (v === undefined || v === null) return;
    const sv = String(v).trim();
    if (!sv) return;
    addRow(`Option: ${k}`, sv, "", badgeHtml("set", "muted"));
  });
}

  // --------------------------
  // Run check
  // --------------------------
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (statusDiv) statusDiv.textContent = "Running...";
      if (output) output.textContent = "";

      const payload = collectPayload();

      try {
        const res = await fetch("/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (output) {
          output.textContent =
            `Command:\n${data.command}\n\n` +
            `Exit code: ${data.exit_code}\n\n` +
            `--- STDOUT ---\n${data.stdout || ""}\n\n` +
            `--- STDERR ---\n${data.stderr || ""}\n`;
        }

        if (statusDiv) {
          const status = data.status || "UNKNOWN";

statusDiv.className = "status";   // reset

if (status === "OK") {
  statusDiv.classList.add("status-ok");
}
else if (status === "WARNING") {
  statusDiv.classList.add("status-warn");
}
else if (status === "CRITICAL") {
  statusDiv.classList.add("status-crit");
}
else {
  statusDiv.classList.add("status-unknown");
}

statusDiv.textContent = `${status} (exit ${data.exit_code})`;
        }

        // parse stdout to summary
        const parsed = parseStdout(data.stdout || "", payload);
        fillSummaryTable(parsed, payload);

        // persist "last result" for current profile name if selected
        const currentProfile =
          (profileSelect?.value || "").trim() ||
          (localStorage.getItem("currentProfile") || "").trim();
        if (currentProfile) {
          localStorage.setItem("lastProfileRun", currentProfile);
        }
      } catch (err) {
        console.error(err);
        if (statusDiv) statusDiv.textContent = "Error (see console)";
      }
    });
  }

  // --------------------------
  // Profile Manager modal: build table + preview
  // --------------------------
  function renderProfilePreview(name) {
    const preview = document.getElementById("profilePreview");
    if (!preview) return;

    const profiles = getProfiles();
    const p = profiles[name];
    if (!p) {
      preview.innerHTML = `<em class="text-muted">Select a profile to view details.</em>`;
      return;
    }

    const rows = [
      ["URL", p.url || ""],
      ["Method", p.method || "(auto)"],
      ["Timeout", p.timeout || ""],
      ["Interval", p.interval || ""],
      ["User-Agent", p.user_agent || ""],
      ["HTTP Version", p.http_version || ""],
      ["Min TLS", p.min_tls_version || ""],
      ["TLS", p.tls_version || ""],
      ["On Redirect", p.onredirect || ""],
      ["Max Redirects", p.max_redirs || ""],
      ["Force IP", p.force_ip_version || ""],
      ["Proxy URL", p.proxy_url || ""],
      ["Auth User", p.auth_user || ""],
      ["Content-Type", p.content_type || ""],
      ["Has body", p.body && String(p.body).trim() ? "yes" : "no"],
      ["Body strings", Array.isArray(p.body_string) ? p.body_string.join(", ") : (p.body_string || "")],
    ];

    preview.innerHTML =
      `<table class="table table-sm table-borderless mb-0"><tbody>` +
      rows
        .filter(([_, v]) => v && String(v).trim().length)
        .map(([k, v]) => `<tr><th class="text-nowrap">${k}</th><td>${String(v)}</td></tr>`)
        .join("") +
      `</tbody></table>` +
      `<div class="mt-3">
         <label class="form-label mb-1">CSV retention (days)</label>
         <div class="input-group input-group-sm">
           <input id="retentionDaysInput" type="number" min="0" step="1" class="form-control" value="${(p.csv_retention_days ?? "")}" placeholder="0 = keep all" />
           <button id="saveRetentionBtn" class="btn btn-outline-secondary" type="button">Save</button>
         </div>
         <div class="form-text">Set to 0 (or empty) to keep all CSV rows for this profile.</div>
       </div>`;

    // Retention editor
    const retentionInput = document.getElementById("retentionDaysInput");
    const saveRetentionBtn = document.getElementById("saveRetentionBtn");
    if (saveRetentionBtn && retentionInput) {
      saveRetentionBtn.addEventListener("click", async () => {
        const profilesNow = getProfiles();
        const raw = (retentionInput.value || "").trim();
        const v = raw === "" ? 0 : Math.max(0, parseInt(raw, 10) || 0);
        if (!profilesNow[name]) return;

        profilesNow[name].csv_retention_days = v;
        saveProfiles(profilesNow);
        await syncProfilesToServer(profilesNow);
        refreshProfilesTable(name);
        renderProfilePreview(name);
      });
    }

  }

  function refreshProfilesTable(selectedName = null) {
    const tbody = document.getElementById("profilesTableBody");
    const count = document.getElementById("profileCount");
    if (!tbody) return;

    const profiles = getProfiles();
    const keys = Object.keys(profiles).sort();

    if (count) count.textContent = `${keys.length} profile${keys.length !== 1 ? "s" : ""}`;
    tbody.innerHTML = "";

    if (!keys.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-muted">No saved profiles</td></tr>`;
      renderProfilePreview(null);
      return;
    }

    keys.forEach((name) => {
      const url = profiles[name].url || "";
      const tr = document.createElement("tr");
      tr.dataset.name = name;
      const retention = profiles[name].csv_retention_days ?? "";
      const retentionLabel = (retention === 0 || retention === "0" || retention === "" || retention === null) ? "∞" : `${retention}d`;
      tr.innerHTML = `
        <td>${name}</td>
        <td>${url}</td>
        <td class="text-nowrap"><span class="badge text-bg-secondary">${retentionLabel}</span></td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-primary me-1" data-act="load">Load</button>
          <button class="btn btn-sm btn-outline-secondary me-1" data-act="update">Update</button>
          <button class="btn btn-sm btn-outline-danger" data-act="delete">Delete</button>
        </td>
      `;
      if (selectedName && name === selectedName) tr.classList.add("table-active");
      tbody.appendChild(tr);
    });

    if (selectedName) renderProfilePreview(selectedName);
  }

  window.renderProfilePreview = renderProfilePreview;
  window.refreshProfilesTable = refreshProfilesTable;

  // Single init for Profile Manager modal open + actions
  if (hasEl("profileModal") && window.bootstrap) {
    const modalEl = document.getElementById("profileModal");
    const profileModal = new bootstrap.Modal(modalEl);
    const manageProfilesBtn = document.getElementById("manageProfiles");

    if (manageProfilesBtn) {
      manageProfilesBtn.addEventListener("click", () => {
        const current =
          (document.getElementById("profileSelect")?.value || "").trim() ||
          (localStorage.getItem("currentProfile") || "").trim() ||
          null;

        refreshProfilesTable(current);
        if (current) renderProfilePreview(current);
        profileModal.show();
      });
    }

    const tbody = document.getElementById("profilesTableBody");
    if (tbody) {
      tbody.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-act]");
        const tr = e.target.closest("tr[data-name]");
        const name = tr?.dataset?.name;

        if (tr && !btn) {
          // row clicked -> highlight + preview
          tbody.querySelectorAll("tr").forEach((r) => r.classList.remove("table-active"));
          tr.classList.add("table-active");
          renderProfilePreview(name);
          return;
        }

        if (!btn || !name) return;
        const act = btn.dataset.act;
        const profiles = getProfiles();
        const p = profiles[name];
        if (!p) return;

        if (act === "load") {
          if (!form) return;
          for (const [k, v] of Object.entries(p)) {
            const el = form.elements[k];
            if (!el) continue;
            if (el.type === "checkbox") el.checked = v === true || v === "true" || v === "on";
            else el.value = v;
          }
          localStorage.setItem("currentProfile", name);
          if (profileSelect) profileSelect.value = name;
          syncProfileDropdown();
          updateContentTabVisibility();
          renderProfilePreview(name);
          alert(`Loaded profile: ${name}`);
          return;
        }

        if (act === "update") {
          profiles[name] = currentFormAsProfile();
          saveProfiles(profiles);
          refreshProfilesTable(name);
          renderProfilePreview(name);
          alert(`Updated profile: ${name}`);
          return;
        }

        if (act === "delete") {
          if (!confirm(`Delete profile "${name}"?`)) return;
          delete profiles[name];
          saveProfiles(profiles);
          refreshProfilesTable(null);
          renderProfilePreview(null);
          return;
        }
      });
    }
  }

  // Fix lingering grey backdrop after closing any modal
  document.addEventListener("hidden.bs.modal", () => {
    document.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
    document.body.classList.remove("modal-open");
    document.body.style.removeProperty("padding-right");
    document.documentElement.style.overflow = "";
  });

  // --------------------------
  // Scheduler Manager
  // --------------------------
  async function refreshSchedulerTable() {
    const tbody = document.getElementById("schedulerTableBody");
    if (!tbody) return;

    let sched = {};
    try {
      const res = await fetch("/scheduler/status");
      sched = await res.json();
    } catch (e) {
      console.error("scheduler/status failed", e);
      sched = {};
    }

    const profiles = getProfiles();
    const names = Object.keys(profiles).sort();
    tbody.innerHTML = "";

    if (!names.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-muted">No profiles</td></tr>`;
      return;
    }

    names.forEach((name) => {
      const interval = profiles[name].interval || "";
      const running = sched[name] === "running";

      const tr = document.createElement("tr");
      tr.dataset.name = name;
      tr.innerHTML = `
        <td>${name}</td>
        <td style="max-width:140px;">
          <input class="form-control form-control-sm" data-field="interval" value="${interval}" placeholder="seconds">
        </td>
        <td>${running ? badgeHtml("running", "ok") : badgeHtml("stopped", "muted")}</td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-success me-1" data-act="start">Start</button>
          <button class="btn btn-sm btn-outline-danger" data-act="stop">Stop</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  if (hasEl("schedulerModal") && window.bootstrap) {
    const schedulerModal = new bootstrap.Modal(document.getElementById("schedulerModal"));
    const btn = document.getElementById("manageScheduler");

    if (btn) {
      btn.addEventListener("click", async () => {
        await refreshSchedulerTable();
        schedulerModal.show();
      });
    }

    const tbody = document.getElementById("schedulerTableBody");
    if (tbody) {
      tbody.addEventListener("click", async (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;

        const tr = e.target.closest("tr[data-name]");
        const name = tr?.dataset?.name;
        if (!name) return;

        const act = btn.dataset.act;
        const profiles = getProfiles();

        if (act === "start") {
          const intervalEl = tr.querySelector('input[data-field="interval"]');
          const interval = intervalEl ? String(intervalEl.value || "").trim() : "";

          // store interval back into profile
          if (interval) {
            profiles[name] = profiles[name] || {};
            profiles[name].interval = interval;
            saveProfiles(profiles);
          }

          if (act === "start") {

  const intervalEl = tr.querySelector('input[data-field="interval"]');
  const interval = intervalEl ? String(intervalEl.value || "").trim() : "";

  // immediately update UI
  tr.querySelector("td:nth-child(3)").innerHTML = badgeHtml("running", "ok");

  await fetch(`/scheduler/start/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ interval })
  }).catch(err => console.error("scheduler start failed", err));

  refreshSchedulerTable();
}
          return;
        }

        if (act === "stop") {
          if (act === "stop") {

  // immediately update UI
  tr.querySelector("td:nth-child(3)").innerHTML = badgeHtml("stopped", "muted");

  await fetch(`/scheduler/stop/${encodeURIComponent(name)}`, {
    method: "POST"
  }).catch(err => console.error("scheduler stop failed", err));

  refreshSchedulerTable();
}
          return;
        }
      });
    }
  }

  // --------------------------
  // Poll last-result for currently selected profile
  // (explains the GET /last-result/... every 10s)
  // --------------------------
  async function pollLastResult() {
    const current =
      (profileSelect?.value || "").trim() ||
      (localStorage.getItem("currentProfile") || "").trim();
    if (!current) return;

    try {
      const res = await fetch(`/last-result/${encodeURIComponent(current)}`);
      if (!res.ok) return;
      const data = await res.json();

      // If backend returns stdout, update summary
      if (data && data.stdout && form) {
        const payload = collectPayload();
        const parsed = parseStdout(String(data.stdout), payload);
        fillSummaryTable(parsed, payload);
      }
    } catch {}
  }

  // keep it as-is (10s)
  setInterval(pollLastResult, 10000);
})();