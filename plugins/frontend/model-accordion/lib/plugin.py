# -*- coding: utf-8 -*-
"""Model Accordion — backend half: local OpenAI-compatible gateway discovery.

The frontend bundle cannot probe other loopback ports itself (a browser fetch
from the QwenPaw console origin to ``http://127.0.0.1:<other port>`` is
cross-origin, and a 401 answer to a no-cors request is opaque). This tiny
server-side route does that probe — where there is no CORS — and returns a
plain classification the card renders.

Import is intentionally *not* done here: the frontend registers a discovered
gateway through QwenPaw's own, already-authenticated
``/api/models/custom-providers`` endpoints. This module only reads.

Security: the host is hard-coded to ``127.0.0.1`` and only numeric ports are
probed, so this route cannot be used to reach an arbitrary URL (no SSRF).
"""

import json
import logging
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Query

from qwenpaw.plugins.api import PluginApi

logger = logging.getLogger("qwenpaw.model_accordion")

# Gateways verified on the reference machine; DaddySuite re-exposes each tool as
# a local OpenAI-compatible server. ``ollama`` is the well-known local runtime.
DEFAULT_CANDIDATES = {
    "workbuddy": 57891,
    "trae": 7864,
    "raccoon": 57898,
    "ollama": 11434,
}

_PROBE_TIMEOUT = 1.5
_MAX_SCAN_PORTS = 32
_HOST = "127.0.0.1"


def _classify(port):
    """Probe ``http://127.0.0.1:<port>/v1/models`` -> (status, model_count).

    status is one of ``open`` (200 + a list), ``needs_key`` (401/403, gateway
    alive but gated) or ``down`` (refused, timeout, other status).
    """
    base = f"http://{_HOST}:{port}/v1"
    req = urllib.request.Request(f"{base}/models", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=_PROBE_TIMEOUT) as resp:
            payload = json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return ("needs_key" if exc.code in (401, 403) else "down"), 0
    except Exception:  # noqa: BLE001 - unreachable/timeout are normal outcomes
        return "down", 0
    data = payload.get("data") or payload.get("models") or []
    count = len(data) if isinstance(data, list) else 0
    return "open", count


def _parse_extra_ports(raw):
    ports = []
    if raw:
        for part in str(raw).split(","):
            part = part.strip()
            if part.isdigit() and 0 < int(part) <= 65535:
                ports.append(int(part))
    return ports[:_MAX_SCAN_PORTS]


class ModelAccordionBackend:
    """Mount the discovery route; the frontend does the rest."""

    def register(self, api: PluginApi):
        logger.info("Registering Model Accordion backend routes")
        api.register_http_router(
            self._build_router(),
            prefix="/model-accordion",
            tags=["model-accordion"],
        )

    @staticmethod
    def _build_router():
        router = APIRouter()

        @router.get("/gateways")
        def gateways(ports: str | None = Query(None)):
            """Discover local OpenAI-compatible gateways (loopback only).

            ``ports`` optionally adds numeric loopback ports to scan alongside
            the built-in candidates (deduplicated).
            """
            candidates = dict(DEFAULT_CANDIDATES)
            for extra in _parse_extra_ports(ports):
                candidates.setdefault(f"port-{extra}", extra)

            with ThreadPoolExecutor(max_workers=min(8, len(candidates))) as pool:
                results = list(pool.map(lambda item: (item[0], item[1], _classify(item[1])), candidates.items()))

            gateways_out = []
            for label, port, (status, count) in results:
                gateways_out.append(
                    {
                        "key": label,
                        "label": label,
                        "port": port,
                        "baseUrl": f"http://{_HOST}:{port}/v1",
                        "status": status,
                        "modelCount": count,
                    }
                )
            gateways_out.sort(key=lambda g: (g["status"] != "open", g["status"] != "needs_key", g["label"]))
            return {"ok": True, "gateways": gateways_out}

        return router


plugin = ModelAccordionBackend()
