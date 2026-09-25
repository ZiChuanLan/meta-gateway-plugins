#!/usr/bin/env python3
"""Validate registry.json against the artifacts it serves.

Why this exists: a `direct` entry pins a URL plus sha256 and size, and the
gateway verifies those at install time — but only for the platform it happens to
be installing on, and only after somebody clicks install. A renamed, rebuilt, or
deleted zip therefore fails on a user's gateway instead of in CI.

This check runs for every artifact on every push. `github-release` entries are
deliberately NOT fetched: their assets live in a GitHub Release (external,
mutable state), and `checksums.txt` is the gateway's mechanism for those.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys

REPO = "ZiChuanLan/meta-gateway-plugins"
ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "registry.json"

# Mirrors marketPluginIDPattern in the gateway (internal/plugins/market.go).
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
RAW_URL = re.compile(
    r"^https://raw\.githubusercontent\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?P<ref>[^/]+)/(?P<path>.+)$"
)

failures: list[str] = []
notes: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def local_path_for(url: str) -> pathlib.Path | None:
    """Map a raw.githubusercontent URL onto a file in this checkout."""
    match = RAW_URL.match(url)
    if not match:
        return None
    slug = f"{match.group('owner')}/{match.group('repo')}"
    if slug != REPO:
        notes.append(f"{url}: served by {slug}, not checked here")
        return None
    return ROOT / match.group("path")


def check_artifact(entry_id: str, artifact: dict) -> None:
    url = artifact.get("url", "")
    goos, goarch = artifact.get("goos", ""), artifact.get("goarch", "")
    label = f"{entry_id} {goos}/{goarch}".strip()

    if not url:
        fail(f"{label}: direct artifact without a url")
        return
    path = local_path_for(url)
    if path is None:
        return
    if not path.is_file():
        fail(f"{label}: {url} does not exist at {path.relative_to(ROOT)}")
        return

    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest().lower()
    size = len(data)

    before = len(failures)
    declared_digest = str(artifact.get("sha256", "")).lower()
    declared_size = artifact.get("size")
    if declared_digest and declared_digest != digest:
        fail(f"{label}: sha256 mismatch for {path.name} (registry {declared_digest}, file {digest})")
    if isinstance(declared_size, int) and declared_size != size:
        fail(f"{label}: size mismatch for {path.name} (registry {declared_size}, file {size})")
    if not declared_digest or not isinstance(declared_size, int):
        fail(f"{label}: {path.name} needs both sha256 and size in registry.json")
    if len(failures) == before:
        notes.append(f"{label}: {path.name} {size} bytes {digest}")


def check_plan(entry_id: str, plan: dict | None) -> None:
    if not plan:
        return
    if plan.get("type", "") != "direct":
        notes.append(f"{entry_id}: install type {plan.get('type')!r} resolves remotely, not checked here")
        return
    artifacts = plan.get("artifacts") or []
    if not artifacts:
        fail(f"{entry_id}: direct install without artifacts")
    for artifact in artifacts:
        check_artifact(entry_id, artifact)


def main() -> int:
    try:
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        print(f"::error::registry.json is unreadable: {err}")
        return 1

    if registry.get("schema_version") != 2:
        fail(f"schema_version = {registry.get('schema_version')!r}, want 2")

    plugins = registry.get("plugins")
    if not isinstance(plugins, list) or not plugins:
        fail("plugins must be a non-empty list")
        plugins = []

    seen: set[str] = set()
    for entry in plugins:
        entry_id = str(entry.get("id", ""))
        if not ID_PATTERN.match(entry_id):
            fail(f"{entry_id!r}: id must match {ID_PATTERN.pattern}")
        if entry_id in seen:
            fail(f"{entry_id!r}: duplicate id")
        seen.add(entry_id)

        has_url = bool(str(entry.get("url", "")).strip())
        has_install = bool(entry.get("install"))
        if has_url and has_install:
            # InstallType() prefers install.type, so a URL alongside an install
            # block is dead weight that reads like a sidecar entry.
            fail(f"{entry_id}: has both url and install; a sidecar entry must not carry an install block")
        if not has_url and not has_install and not entry.get("repository"):
            fail(f"{entry_id}: neither url, install, nor repository — the gateway cannot install it")

        check_plan(entry_id, entry.get("install"))
        if not has_url and not entry.get("install") and entry.get("repository"):
            tag = f"v{entry.get('version')}" if entry.get("version") else "(latest)"
            notes.append(
                f"{entry_id}: github-release from {entry['repository']} at {tag}; "
                "assets are release state, not checked here"
            )
        for version in entry.get("versions") or []:
            check_plan(f"{entry_id}@{version.get('version')}", version.get("install"))

    for note in notes:
        print(f"ok    {note}")
    for failure in failures:
        print(f"::error::{failure}")

    if failures:
        print(f"\n{len(failures)} problem(s) in registry.json")
        return 1
    print(f"\nregistry.json: {len(plugins)} plugin(s) consistent with the artifacts it serves")
    return 0


if __name__ == "__main__":
    sys.exit(main())
