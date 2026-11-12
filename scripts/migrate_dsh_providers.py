#!/usr/bin/env python3
"""Inventory a DeepSeek Harness (DSH) install and stage a migration into QwenPaw.

Read-only over ``~/.dsh``: it never writes to DSH and never prints a secret
value. It answers one practical question — *what would it take to get the model
providers wired up in DSH (dsh-connect-qoder / -trae / -workbuddy / opencode)
into QwenPaw's model selector?*

Two kinds of material live in ``~/.dsh``:

* **Catalog + capability metadata** (model ids, names, context windows, credit
  multipliers, image/tool/reasoning support) — fully migratable.
* **Credentials** — but these are *private-protocol* logins (Qoder PAT/cosy,
  Trae ``accessToken``, WorkBuddy vault tokens), **not** OpenAI-compatible
  ``base_url`` + ``api_key``. The upstreams expose no OpenAI endpoint; DSH
  reaches them through in-process protocol adapters on an ephemeral
  random-port loopback shim that is not stored on disk.

So a straight config copy yields selectable-looking entries but **zero working
models** in QwenPaw, because QwenPaw has no cosy / Trae / WorkBuddy transport.
This script therefore emits a *staged* migration: the migratable catalog plus a
QwenPaw custom-provider skeleton per provider, ready to fill in the moment an
adapter exposes a stable ``base_url``.

Usage::

    python3 scripts/migrate_dsh_providers.py            # report to stdout
    python3 scripts/migrate_dsh_providers.py --json out.json
"""
from __future__ import annotations

import argparse
import datetime as _dt
import glob
import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover - PyYAML is a hard dep of this repo
    sys.exit("PyYAML is required (it ships with qwenpaw). pip install pyyaml")

# Tolerate cordis' ``!!js`` tags — we only read data, so collapse them to None.
class _LenientLoader(yaml.SafeLoader):
    pass


def _unknown_tag(loader: _LenientLoader, suffix: str, node: yaml.Node) -> Any:
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)


_LenientLoader.add_multi_constructor("tag:yaml.org,2002:js/", _unknown_tag)
_LenientLoader.add_multi_constructor("!js", _unknown_tag)


# provider id -> how DSH actually talks to it. None of these are OpenAI
# compatible; ``protocol`` names the reverse-engineered client a QwenPaw
# adapter would have to reproduce to make the models callable.
CONNECTORS: dict[str, dict[str, str]] = {
    "dsh-connect-qoder": {"provider": "qoder", "protocol": "cosy"},
    "dsh-connect-trae": {"provider": "trae", "protocol": "trae-account"},
    "dsh-connect-workbuddy": {"provider": "workbuddy", "protocol": "workbuddy"},
    "opencode2dsh": {"provider": "opencode", "protocol": "opencode"},
}

# credential files (relative to DSH home) per provider; ``{r}`` -> region token.
CREDENTIAL_GLOBS: dict[str, list[str]] = {
    "qoder": [".qoder-accounts.{r}.json", ".qoder-local-logins.{r}.json"],
    "trae": [".trae-auth.{r}.json"],
    "workbuddy": ["workbuddy-vault/{r}/*.json"],
    "opencode": [".opencode-auth.{r}.json"],
}

REGIONS = ("cn", "ai", "global")


def dsh_home() -> Path:
    env = os.environ.get("DSH_HOME")
    return Path(env).expanduser() if env else Path.home() / ".dsh"


def load_patch_files(home: Path) -> list[tuple[str, list[dict]]]:
    """Return (profile, parsed entries) for every DSH profile on disk."""
    out: list[tuple[str, list[dict]]] = []
    for path in sorted(home.glob("profiles/*/cordis*.yml")):
        try:
            data = yaml.load(path.read_text(encoding="utf-8"), Loader=_LenientLoader)
        except Exception as exc:  # noqa: BLE001 - never abort the whole scan on one file
            print(f"  ! could not parse {path}: {exc}", file=sys.stderr)
            continue
        if isinstance(data, list):
            out.append((path.parent.name, data))
    return out


def connector_configs(profiles: list[tuple[str, list[dict]]]) -> dict[str, dict]:
    """Merge the ``config`` block of each connector across profiles (last wins)."""
    merged: dict[str, dict] = {}
    for _profile, entries in profiles:
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            cid = entry.get("id")
            if cid in CONNECTORS and isinstance(entry.get("config"), dict):
                merged[cid] = entry["config"]
    return merged


def detect_credentials(home: Path, provider: str) -> list[dict]:
    """Report which credential files exist for a provider — paths only, never values."""
    found: list[dict] = []
    for pattern in CREDENTIAL_GLOBS.get(provider, []):
        for region in REGIONS:
            rel = pattern.format(r=region)
            for hit in sorted(glob.glob(str(home / rel))):
                found.append(
                    {
                        "path": str(Path(hit).relative_to(home)),
                        "size_bytes": Path(hit).stat().st_size,
                        "secret_in_file": True,  # presence only; value never read
                    }
                )
    return found


def models_of_region(region_cfg: dict) -> list[dict]:
    catalog = region_cfg.get("lastCatalog") or []
    out: list[dict] = []
    for m in catalog:
        if not isinstance(m, dict) or not m.get("id"):
            continue
        out.append(
            {
                "id": m.get("id"),
                "name": m.get("name") or m.get("id"),
                "context_window": m.get("contextWindow"),
                "max_output": m.get("maxTokens"),
                "credit_multiplier": m.get("creditMultiplier"),
                "supports_images": m.get("supportsImages"),
                "supports_tool_call": m.get("supportsToolCall"),
                "reasoning": bool((m.get("reasoning") or {}).get("supportedEfforts")),
            }
        )
    return out


def build_plan(home: Path) -> dict:
    profiles = load_patch_files(home)
    cfgs = connector_configs(profiles)
    providers: list[dict] = []
    for cid, meta in CONNECTORS.items():
        cfg = cfgs.get(cid)
        if cfg is None:
            continue  # connector not installed in this DSH home
        provider = meta["provider"]
        regions: list[dict] = []
        region_cfgs = cfg.get("regions") or {}
        # some connectors (opencode) may store catalog at top level
        if not region_cfgs and (cfg.get("lastCatalog") or cfg.get("enabledModelIds")):
            region_cfgs = {"default": cfg}
        for rname, rcfg in region_cfgs.items():
            if not isinstance(rcfg, dict):
                continue
            models = models_of_region(rcfg)
            regions.append(
                {
                    "region": rname,
                    "enabled": rcfg.get("enabled", True),
                    "enabled_model_ids": rcfg.get("enabledModelIds") or [],
                    "model_count": len(models),
                    "models": models,
                }
            )
        creds = detect_credentials(home, provider)
        providers.append(
            {
                "connector_id": cid,
                "provider": provider,
                "protocol": meta["protocol"],
                # the crux: catalog migrates, transport does not.
                "migratable_now": False,
                "reason": (
                    f"{provider} reaches upstream via the reverse-engineered "
                    f"'{meta['protocol']}' protocol; QwenPaw has no such adapter "
                    "and the upstream exposes no OpenAI-compatible endpoint."
                ),
                "credential_files": creds,
                "regions": regions,
                # ready to POST once an adapter gives a stable base_url:
                "qwenpaw_provider_skeleton": {
                    "id": f"dsh-{provider}",
                    "name": f"DSH · {provider.title()}",
                    "protocol": "openai-compatible",
                    "base_url": "<STAGED: fill with local adapter /v1 once ported>",
                    "api_key": "<STAGED: adapter's loopback secret, not upstream token>",
                    "model_ids": sorted(
                        {mid for r in regions for mid in r["enabled_model_ids"]}
                    ),
                },
            }
        )
    return {
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "dsh_home": str(home),
        "profiles_scanned": sorted({name for name, _ in profiles}),
        "providers": providers,
    }


def print_report(plan: dict) -> None:
    print(f"DSH home        : {plan['dsh_home']}")
    print(f"Profiles scanned: {', '.join(plan['profiles_scanned']) or '(none)'}")
    print()
    if not plan["providers"]:
        print("No dsh-connect-* providers found in this DSH home.")
        return
    for p in plan["providers"]:
        n_models = sum(r["model_count"] for r in p["regions"])
        n_enabled = len(p["qwenpaw_provider_skeleton"]["model_ids"])
        creds = ", ".join(c["path"] for c in p["credential_files"]) or "(none on disk)"
        print(f"● {p['provider']}  [{p['connector_id']}]  protocol={p['protocol']}")
        print(f"    regions   : {', '.join(r['region'] + ('(on)' if r['enabled'] else '(off)') for r in p['regions']) or '(none)'}")
        print(f"    catalog   : {n_models} models discovered, {n_enabled} currently enabled")
        print(f"    creds     : {creds}")
        print(f"    migratable: {p['migratable_now']}  ->  {p['reason']}")
        print()
    print("Bottom line: catalog + credentials are present, but none of these are")
    print("OpenAI-compatible. Importing them as-is yields entries with no working")
    print("transport. To make them callable in QwenPaw you still need the")
    print("private-protocol adapter (route B) — this plan pre-stages its payload.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsh-home", default=None, help="override DSH home (default $DSH_HOME or ~/.dsh)")
    ap.add_argument("--json", default=None, help="also write the machine-readable staged migration plan here")
    args = ap.parse_args(argv)

    home = Path(args.dsh_home).expanduser() if args.dsh_home else dsh_home()
    if not home.is_dir():
        print(f"DSH home not found: {home}", file=sys.stderr)
        return 2

    plan = build_plan(home)
    print_report(plan)
    if args.json:
        Path(args.json).expanduser().write_text(
            json.dumps(plan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"\nWrote staged migration plan -> {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
