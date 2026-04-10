# GUI for check_httpv2
# Copyright (C) 2026 Mirco lang
# See COPYING file for more

import os
import sys
import shlex
import csv
import json
import time
import threading
import subprocess
import re
from datetime import datetime
from flask import Flask, request, jsonify, send_file

import csv
import os
from datetime import datetime, timezone, timedelta

CSV_PATH = "results.csv"

CSV_FIELDS = [
    "timestamp",
    "profile",
    "status",
    "exit_code",
    "response_time",
    "url",
    "method",
    "timeout",
    "interval",
    "tls_version",
    "min_tls_version",
    "onredirect",
    "force_ip_version",
    "auth_user",
    "proxy_url",
    "certificate_levels",
    "document_age_levels",
    "page_size_option",
    "response_time_levels",
    "status_code",
    "body_string",
    "body_regex",
    "page_age",
    "page_size_bytes",
    "certificate_days_valid",
    "user_agent",
    "http_version",
    "server",
    "max_redirs",
    "content_type",
    "disable_cert",
    "ignore_proxy_env",
    "without_body",
    "debug_headers",
    "debug_content",
    "header_strings",
    "header_regexes",
    "header_regexes_invert",
    "body_regex_invert",
    "headers",
]

def _ensure_csv_header(path: str) -> None:
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
            w.writeheader()

def _normalize_csv_value(v):
    # keep Grafana happy: avoid Python True/False strings if you want
    if isinstance(v, bool):
        return "1" if v else "0"
    if v is None:
        return ""
    # lists -> comma-joined
    if isinstance(v, (list, tuple)):
        return ",".join(str(x) for x in v)
    return str(v)

def append_csv_row(row: dict) -> None:
    _ensure_csv_header(CSV_PATH)

    # Fill missing fields with empty string, ignore unknown keys
    fixed = {k: "" for k in CSV_FIELDS}
    for k, v in row.items():
        if k in fixed:
            fixed[k] = _normalize_csv_value(v)

    with open(CSV_PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        w.writerow(fixed)

# ---------------------------
# Paths & Flask
# ---------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_LOG_PATH = os.path.join(BASE_DIR, "results.csv")
PROFILES_PATH = os.path.join(BASE_DIR, "profiles.json")

app = Flask(__name__, static_folder="static")


def _bin_path():
    base = os.path.join(BASE_DIR, "bin")
    exe = "check-http.exe" if sys.platform.startswith("win") else "check-http"
    return os.path.join(base, exe)


def _sanitize(name: str) -> str:
    return name.replace("/", "_").replace(":", "_").replace("\\", "_")


def pick_metric(text: str, regex: str) -> str:
    m = re.search(regex, text)
    return m.group(1) if m else ""


# ---------------------------
# Routes
# ---------------------------
@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/run", methods=["POST"])
def run_check():
    data = request.get_json(force=True) or {}
    args = build_command(data)
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=60,
        )
        status_map = {0: "OK", 1: "WARNING", 2: "CRITICAL"}
        return jsonify(
            {
                "command": " ".join(shlex.quote(a) for a in args),
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exit_code": result.returncode,
                "status": status_map.get(result.returncode, f"UNKNOWN ({result.returncode})"),
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/export-profiles", methods=["POST"])
def export_profiles():
    data = request.get_json(force=True) or {}
    with open(PROFILES_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return jsonify({"status": "ok", "count": len(data)})


@app.route("/last-result/<path:name>")
def last_result(name):
    safe = _sanitize(name)
    path = os.path.join(BASE_DIR, f"last_{safe}.json")
    if not os.path.exists(path):
        return jsonify({"status": "no data"})
    with open(path, "r", encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.route("/results.csv")
def serve_results_csv():
    if not os.path.exists(CSV_LOG_PATH):
        return "No results.csv file yet", 404
    return send_file(CSV_LOG_PATH, mimetype="text/csv")

@app.route("/profiles", methods=["GET"])
def get_profiles():
    if not os.path.exists(PROFILES_PATH):
        return jsonify({})
    try:
        with open(PROFILES_PATH, "r", encoding="utf-8") as f:
            return jsonify(json.load(f) or {})
    except Exception:
        return jsonify({})


def _parse_ts_utc(ts: str):
    if not ts:
        return None
    try:
        s = ts.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _prune_csv_for_profile(profile_name, retention_days):
    if not retention_days or retention_days <= 0:
        return

    if not os.path.exists(CSV_FILE):
        return

    cutoff = datetime.utcnow() - timedelta(days=int(retention_days))

    rows = []
    kept = 0

    with open(CSV_FILE, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames

        for row in reader:
            # only apply retention to this profile
            if row.get("profile") != profile_name:
                rows.append(row)
                continue

            dt = _parse_ts_utc(row.get("timestamp", ""))

            if dt is None or dt >= cutoff:
                rows.append(row)
                kept += 1

    with open(CSV_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

# ---------------------------
# Per-profile scheduler
# ---------------------------
profile_threads = {}  # name -> Thread
profile_running = {}  # name -> bool


@app.route("/scheduler/start/<path:name>", methods=["POST"])
def scheduler_start_profile(name):
    if not os.path.exists(PROFILES_PATH):
        return jsonify({"error": "profiles.json not found"}), 400
    with open(PROFILES_PATH, "r", encoding="utf-8") as f:
        profiles = json.load(f)

    if name not in profiles:
        return jsonify({"error": f"profile '{name}' not found"}), 404
    if profile_running.get(name):
        return jsonify({"status": "already running", "profile": name})

    pdata = profiles[name]
    profile_running[name] = True

    def loop():
        try:
            interval = int(pdata.get("interval", 300))
        except Exception:
            interval = 300

        print(f"[SCHED] Thread for '{name}' started (interval {interval}s)")
        while profile_running.get(name):
            try:
                run_profile(name, pdata)
            except Exception as e:
                print(f"[SCHED] Error in '{name}': {e}")

            for _ in range(interval):
                if not profile_running.get(name):
                    break
                time.sleep(1)

        print(f"[SCHED] Thread for '{name}' stopped.")

    t = threading.Thread(target=loop, daemon=True)
    t.start()
    profile_threads[name] = t
    return jsonify({"status": "started", "profile": name})


@app.route("/scheduler/stop/<path:name>", methods=["POST"])
def scheduler_stop_profile(name):
    if not profile_running.get(name):
        return jsonify({"status": "not running", "profile": name})
    profile_running[name] = False
    print(f"[SCHED] Stopping thread for '{name}'...")
    return jsonify({"status": "stopping", "profile": name})


@app.route("/scheduler/status")
def scheduler_status():
    names = []
    if os.path.exists(PROFILES_PATH):
        try:
            with open(PROFILES_PATH, "r", encoding="utf-8") as f:
                names = list(json.load(f).keys())
        except Exception:
            pass
    if not names:
        names = list(profile_running.keys())
    return jsonify({n: ("running" if profile_running.get(n) else "stopped") for n in names})


# ---------------------------
# Execution & logging
# ---------------------------
def run_profile(name: str, profile_data: dict):
    args = build_command(profile_data)
    start_time = datetime.utcnow().isoformat() + "Z"

    try:
        res = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=60,
        )
        exit_code = res.returncode
        stdout = (res.stdout or "").strip()
        status = {0: "OK", 1: "WARNING", 2: "CRITICAL"}.get(exit_code, f"UNKNOWN ({exit_code})")
    except Exception as e:
        exit_code = -1
        stdout = str(e)
        status = "ERROR"

    response_time = pick_metric(stdout, r"response_time=([\d.]+)s")
    page_age = pick_metric(stdout, r"Page age:\s+(\d+)\s+seconds")
    page_size = pick_metric(stdout, r"Page size:\s+(\d+)\s+Bytes")
    cert_days = pick_metric(stdout, r"Server certificate validity:\s+(\d+)\s+days")

    # Stable CSV schema (do NOT log "body" to avoid secrets/size; do log content_type)
    row = {
        "timestamp": start_time,
        "profile": name,
        "status": status,
        "exit_code": exit_code,
        "response_time": response_time,
        "url": profile_data.get("url", ""),
        "method": profile_data.get("method", ""),
        "timeout": profile_data.get("timeout", ""),
        "interval": profile_data.get("interval", ""),
        "http_version": profile_data.get("http_version", ""),
        "server": profile_data.get("server", ""),
        "user_agent": profile_data.get("user_agent", ""),
        "disable_cert": str(bool(profile_data.get("disable_cert", False))),
        "tls_version": profile_data.get("tls_version", ""),
        "min_tls_version": profile_data.get("min_tls_version", ""),
        "onredirect": profile_data.get("onredirect", ""),
        "max_redirs": profile_data.get("max_redirs", ""),
        "force_ip_version": profile_data.get("force_ip_version", ""),
        "ignore_proxy_env": str(bool(profile_data.get("ignore_proxy_env", False))),
        "proxy_url": profile_data.get("proxy_url", ""),
        "proxy_user": profile_data.get("proxy_user", ""),
        "auth_user": profile_data.get("auth_user", ""),
        "token_header": profile_data.get("token_header", ""),
        "content_type": profile_data.get("content_type", ""),
        "headers": ",".join(profile_data.get("headers", [])) if isinstance(profile_data.get("headers"), list) else (profile_data.get("headers") or ""),
        "header_strings": ",".join(profile_data.get("header_strings", [])) if isinstance(profile_data.get("header_strings"), list) else (profile_data.get("header_strings") or ""),
        "header_regexes": ",".join(profile_data.get("header_regexes", [])) if isinstance(profile_data.get("header_regexes"), list) else (profile_data.get("header_regexes") or ""),
        "header_regexes_invert": str(bool(profile_data.get("header_regexes_invert", False))),
        "body_string": ",".join(profile_data.get("body_string", [])) if isinstance(profile_data.get("body_string"), list) else (profile_data.get("body_string") or ""),
        "body_regex": ",".join(profile_data.get("body_regex", [])) if isinstance(profile_data.get("body_regex"), list) else (profile_data.get("body_regex") or ""),
        "body_regex_invert": str(bool(profile_data.get("body_regex_invert", False))),
        "status_code": ",".join(profile_data.get("status_code", [])) if isinstance(profile_data.get("status_code"), list) else (profile_data.get("status_code") or ""),
        "response_time_levels": profile_data.get("response_time_levels", ""),
        "document_age_levels": profile_data.get("document_age_levels", ""),
        "certificate_levels": profile_data.get("certificate_levels", ""),
        "page_size_option": profile_data.get("page_size", ""),
        "without_body": str(bool(profile_data.get("without_body", False))),
        "debug_headers": str(bool(profile_data.get("debug_headers", False))),
        "debug_content": str(bool(profile_data.get("debug_content", False))),
        "verbose_level": profile_data.get("verbose_level", ""),
        # runtime
        "page_age": page_age,
        "page_size_bytes": page_size,
        "certificate_days_valid": cert_days,
    }

    # Write CSV with stable header
    try:
        new_file = not os.path.exists(CSV_LOG_PATH) or os.path.getsize(CSV_LOG_PATH) == 0
        with open(CSV_LOG_PATH, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(row.keys()))
            if new_file:
                writer.writeheader()
            writer.writerow(row)
    except Exception as e:
        print(f"[LOG] CSV write failed for '{name}': {e}")

    # Write last result JSON for UI live update
    try:
        safe = _sanitize(name)
        with open(os.path.join(BASE_DIR, f"last_{safe}.json"), "w", encoding="utf-8") as jf:
            json.dump(
                {
                    **row,
                    "stdout": stdout[:200000],
                },
                jf,
                indent=2,
            )
    except Exception as e:
        print(f"[SCHED] Could not write last result for '{name}': {e}")


# ---------------------------
# Command builder (maps GUI payload → CLI)
# ---------------------------
def _add_multi(cmd, flag, values):
    if not values:
        return
    if isinstance(values, str):
        items = [v.strip() for v in values.split(",") if v.strip()]
    else:
        items = [str(v).strip() for v in values if str(v).strip()]
    for v in items:
        cmd += [flag, v]


def build_command(d: dict):
    cmd = [_bin_path()]

    if d.get("url"):
        cmd += ["--url", d["url"]]

    if d.get("method"):
        cmd += ["--method", d["method"]]

    if d.get("timeout"):
        cmd += ["--timeout", str(d["timeout"])]

    ua = d.get("user_agent") or "check_httpv2_agent"
    cmd += ["--user-agent", ua]

    if d.get("http_version"):
        cmd += ["--http-version", d["http_version"]]

    if d.get("server"):
        cmd += ["--server", d["server"]]

    if d.get("onredirect"):
        cmd += ["--onredirect", d["onredirect"]]

    if d.get("max_redirs"):
        cmd += ["--max-redirs", str(d["max_redirs"])]

    if d.get("force_ip_version"):
        cmd += ["--force-ip-version", d["force_ip_version"]]

    _add_multi(cmd, "--header", d.get("headers"))

    if d.get("auth_user"):
        cmd += ["--auth-user", d["auth_user"]]
    if d.get("auth_pw_plain"):
        cmd += ["--auth-pw-plain", d["auth_pw_plain"]]

    if d.get("token_header"):
        cmd += ["--token-header", d["token_header"]]
    if d.get("token_key_plain"):
        cmd += ["--token-key-plain", d["token_key_plain"]]

    if d.get("ignore_proxy_env"):
        cmd += ["--ignore-proxy-env"]
    if d.get("proxy_url"):
        cmd += ["--proxy-url", d["proxy_url"]]
    if d.get("proxy_user"):
        cmd += ["--proxy-user", d["proxy_user"]]
    if d.get("proxy_pw_plain"):
        cmd += ["--proxy-pw-plain", d["proxy_pw_plain"]]

    if d.get("disable_cert"):
        cmd += ["--disable-cert"]

    if d.get("tls_version"):
        cmd += ["--tls-version", d["tls_version"]]
    if d.get("min_tls_version"):
        cmd += ["--min-tls-version", d["min_tls_version"]]
    if d.get("certificate_levels"):
        cmd += ["--certificate-levels", d["certificate_levels"]]

    if d.get("without_body"):
        cmd += ["--without-body"]

    # RAW body support
    if d.get("body"):
        cmd += ["--body", d["body"]]
        if d.get("content_type"):
            cmd += ["--content-type", d["content_type"]]

    _add_multi(cmd, "--body-string", d.get("body_string"))
    _add_multi(cmd, "--body-regex", d.get("body_regex"))
    if d.get("body_regex_invert"):
        cmd += ["--body-regex-invert"]

    _add_multi(cmd, "--header-strings", d.get("header_strings"))
    _add_multi(cmd, "--header-regexes", d.get("header_regexes"))
    if d.get("header_regexes_invert"):
        cmd += ["--header-regexes-invert"]

    _add_multi(cmd, "--status-code", d.get("status_code"))

    if d.get("response_time_levels"):
        cmd += ["--response-time-levels", d["response_time_levels"]]
    if d.get("document_age_levels"):
        cmd += ["--document-age-levels", d["document_age_levels"]]
    if d.get("page_size"):
        cmd += ["--page-size", d["page_size"]]

    if d.get("debug_headers"):
        cmd += ["--debug-headers"]
    if d.get("debug_content"):
        cmd += ["--debug-content"]

    vv = int(d.get("verbose_level") or 0)
    vv = max(0, min(vv, 3))
    cmd += ["-v"] * vv

    return cmd


if __name__ == "__main__":
    print("[INFO] Working dir:", os.getcwd())
    app.run(host="0.0.0.0", port=5000, debug=True)