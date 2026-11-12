#!/usr/bin/env python3
"""Discover local OpenAI-compatible gateways and import them into QwenPaw.

This is the *transport-free* way to get WorkBuddy / Trae / raccoon models into
QwenPaw's model selector. Those tools are re-exposed on this machine by their
DaddySuite daemons as **local OpenAI-compatible gateways** (``/v1/models`` +
``/v1/chat/completions`` on ``127.0.0.1:<port>``). QwenPaw already speaks to any
OpenAI-compatible endpoint as a *custom provider*, so no protocol reverse
engineering — no cosy / no 11128 channel-fingerprint arms race / no upstream
credit spend from this tool — is required.

Two phases:

* **discover** (default, read-only, free): probe each candidate endpoint's
  ``/v1/models``. ``200`` = open, ready to import. ``401``/``403`` = gateway is
  running but wants a bearer key (paste it once). anything else = down/skip.
* **import** (``--apply``, mutates QwenPaw provider config): for every live
  gateway, ``POST /api/models/custom-providers`` with its ``base_url`` (+ key if
  given). QwenPaw then auto-discovers that gateway's models and they show up in
  the selector, where the ``model-accordion`` plugin decorates them.

Gateway keys are DaddySuite-minted, not the upstream login token; this script
never reads a secret off disk — you supply keys with ``--key LABEL=VALUE`` or a
JSON file. A needs-key gateway imported without a key still appears in
QwenPaw's *Settings → Models*; open its provider and paste the key once.

Examples::

    python3 scripts/import_local_gateways.py                 # discover only
    python3 scripts/import_local_gateways.py --apply
    python3 scripts/import_local_gateways.py --apply \
        --key workbuddy=ds_...  --key trae=ds_...

Loopback calls to QwenPaw need no token (verified: ``GET /api/models`` -> 200
from 127.0.0.1).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Gateways verified live on this machine, plus the pi-model-accordion defaults.
# label -> port; base_url becomes http://127.0.0.1:<port>/v1
DEFAULT_GATEWAYS: "dict[str, int]" = {
    "workbuddy": 57891,  # WorkDaddyEX — regions cn+global (DaddySuite gateway)
    "trae": 7864,        # trae-gateway
    "raccoon": 57898,    # raccoon-gateway
    "ollama": 11434,     # local Ollama (keyless; QwenPaw has a native provider)
}
# Extra ports to scan when --scan is passed (OpenAI-style /v1 servers).
SCAN_PORTS: list[int] = [
    1234, 3000, 5000, 7864, 8000, 8080, 8081, 8787, 8788, 8789, 8790,
    9000, 11434, 57860, 57861, 57891, 57892, 57893, 57894, 57895, 57898, 57899,
]
PROBE_TIMEOUT = 2.5


def qwenpaw_base() -> str:
    port_file = Path(os.environ.get("QWENPAW_WORKING_DIR", "~/.qwenpaw")).expanduser() / "desktop_port"
    try:
        port = port_file.read_text().strip()
    except OSError:
        sys.exit(f"cannot read QwenPaw port from {port_file}")
    if not port.isdigit():
        sys.exit(f"unexpected QwenPaw port value in {port_file}: {port!r}")
    return f"http://127.0.0.1:{port}"


def http_json(url: str, *, method: str = "GET", body: dict | None = None,
              headers: dict | None = None, timeout: float = 5.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.getcode(), (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read() if exc.fp else b""
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = raw[:200].decode("utf-8", "replace")
        return exc.code, parsed
    except Exception as exc:  # noqa: BLE001 - unreachable is a normal outcome
        return None, str(exc)


def probe_gateway(base: str, key: str | None):
    """Return (status, model_ids) where status in {open, needs_key, down}.

    ``base`` already ends in ``/v1`` (QwenPaw's ``base_url`` convention), so the
    model list lives at ``<base>/models``.
    """
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    code, payload = http_json(f"{base.rstrip('/')}/models", headers=headers, timeout=PROBE_TIMEOUT)
    if code == 200:
        arr = (payload or {}).get("data") or payload.get("models") or payload or []
        ids = [m.get("id") for m in arr if isinstance(m, dict) and m.get("id")] if isinstance(arr, list) else []
        return "open", ids
    if code in (401, 403):
        return "needs_key", []
    return "down", []


def discover(gateways: dict[str, str], keys: dict[str, str]) -> dict[str, tuple]:
    out: dict[str, tuple] = {}
    for label, base in gateways.items():
        out[label] = probe_gateway(base, keys.get(label))
    return out


def existing_provider_ids() -> set[str]:
    code, payload = http_json(f"{qwenpaw_base()}/api/models", timeout=5)
    if code != 200 or not isinstance(payload, list):
        return set()
    return {p.get("id") for p in payload if isinstance(p, dict)}


def import_gateway(label: str, base: str, key: str | None) -> tuple[bool, str]:
    pid = f"gw-{label}"
    body = {
        "id": pid,
        "name": f"{label.title()} (local)",
        "default_base_url": base,
        "api_key": key or "",
        "models": [],
    }
    code, payload = http_json(f"{qwenpaw_base()}/api/models/custom-providers",
                              method="POST", body=body, timeout=10)
    if code in (200, 201):
        return True, f"registered {pid} -> {base}"
    detail = (payload or {}).get("detail") if isinstance(payload, dict) else payload
    return False, f"HTTP {code}: {detail}"


def pull_and_enable(pid: str) -> str:
    """Ask QwenPaw to discover the gateway's models, then enable them all.

    Returns a short human status. Discovery needs a valid bearer key, so a
    gateway imported without one reports 'needs key' and is left for the user to
    finish in Settings -> Models.
    """
    code, payload = http_json(f"{qwenpaw_base()}/api/models/{pid}/discover?save=true",
                              method="POST", timeout=25)
    if code != 200 or not isinstance(payload, dict):
        return f"discover failed (HTTP {code})"
    count = payload.get("discovered_count") or 0
    if not count:
        return "0 models (gateway needs its bearer key — add it in Settings → Models, then re-run)"
    http_json(f"{qwenpaw_base()}/api/models/{pid}/pool/selection",
              method="PUT", body={"selected": True}, timeout=10)
    return f"{count} models discovered & enabled"


def parse_keys(pairs: list[str]) -> dict[str, str]:
    keys: dict[str, str] = {}
    for item in pairs:
        if "=" not in item:
            sys.exit(f"--key expects LABEL=VALUE, got {item!r}")
        label, value = item.split("=", 1)
        keys[label.strip().lower()] = value.strip()
    return keys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="register live gateways into QwenPaw (default: discover only)")
    ap.add_argument("--key", action="append", default=[], metavar="LABEL=VALUE", help="bearer key for a needs-key gateway")
    ap.add_argument("--gateway", action="append", default=[], metavar="LABEL=URL", help="add/override a gateway endpoint (URL incl. /v1)")
    ap.add_argument("--scan", action="store_true", help="also scan common loopback ports for /v1 servers")
    ap.add_argument("--port", action="append", default=[], type=int, help="scan a specific port (repeatable), with --scan")
    args = ap.parse_args(argv)

    keys = parse_keys(args.key)
    gateways: dict[str, str] = {lbl: f"http://127.0.0.1:{p}/v1" for lbl, p in DEFAULT_GATEWAYS.items()}
    for item in args.gateway:
        if "=" not in item:
            sys.exit(f"--gateway expects LABEL=URL, got {item!r}")
        label, url = item.split("=", 1)
        gateways[label.strip().lower()] = url.strip().rstrip("/")

    if args.scan:
        from urllib.parse import urlparse
        taken = {str(urlparse(base).port) for base in gateways.values()}
        for port in (args.port or SCAN_PORTS):
            if str(port) in taken:
                continue
            gateways.setdefault(f"port-{port}", f"http://127.0.0.1:{port}/v1")

    print(f"QwenPaw: {qwenpaw_base()}\n")
    found = discover(gateways, keys)

    print("Discovery (read-only):")
    present = []
    for label, (status, ids) in sorted(found.items()):
        base = gateways[label]
        if status == "open":
            note = f"{len(ids)} models"
            present.append(label)
        elif status == "needs_key":
            note = "running, needs bearer key"
            present.append(label)
        else:
            note = "down"
        print(f"  {label:<14} {base:<34} {status:<10} {note}")

    if not present:
        print("\nNo live gateway found. Is DaddySuite running? Add one with --gateway LABEL=http://127.0.0.1:PORT/v1")
        return 0

    if not args.apply:
        print("\nDry run. Re-run with --apply to register these into QwenPaw.")
        needs = [l for l in present if found[l][0] == "needs_key" and l not in keys]
        if needs:
            print(f"Without keys these import with an empty key and you paste it once in Settings → Models: {', '.join(sorted(needs))}")
        return 0

    existing = existing_provider_ids()
    print("\nImporting:")
    for label in sorted(present):
        pid = f"gw-{label}"
        if pid in existing:
            print(f"  {label:<14} exists in QwenPaw, refreshing models")
        else:
            ok, msg = import_gateway(label, gateways[label], keys.get(label))
            print(f"  {label:<14} {'OK  ' if ok else 'FAIL'} {msg}")
            if not ok:
                continue
        print(f"  {label:<14} -> {pull_and_enable(pid)}")
    print("\nLive gateways are now custom providers in QwenPaw; the model-accordion decorates them in the selector.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
