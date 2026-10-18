"""Read-only Hermes backend bridge for the native Waystation Monitor.

The Hermes desktop renderer imports only its Plugin SDK and React. This router
is mounted by the supported Hermes dashboard plugin API and invokes the
existing Waystation CLI/core read adapters with a server-configured ledger root.
No request can select a root or command.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter()

_TIMEOUT_SECONDS = 10
_MAX_OUTPUT_BYTES = 1024 * 1024
_TASK_ID_RE = re.compile(r"^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]*$")


def _configuration() -> tuple[Path, Path, Path, Path]:
    """Read fixed server-side paths; callers never supply any of them."""
    values = {
        "WAYSTATION_ROOT": os.environ.get("WAYSTATION_ROOT"),
        "WAYSTATION_REPO": os.environ.get("WAYSTATION_REPO"),
        "WAYSTATION_BUN": os.environ.get("WAYSTATION_BUN"),
    }
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"Waystation Monitor backend is not configured: {', '.join(missing)}",
        )

    root = Path(values["WAYSTATION_ROOT"]).expanduser().resolve()
    repo = Path(values["WAYSTATION_REPO"]).expanduser().resolve()
    bun = Path(values["WAYSTATION_BUN"]).expanduser().resolve()
    cli = repo / "src" / "cli" / "index.ts"
    claims_read = repo / "integrations" / "hermes" / "desktop" / "claims-read.ts"

    if not root.is_dir():
        raise HTTPException(status_code=503, detail="Configured Waystation ledger root is unavailable")
    if not cli.is_file() or not claims_read.is_file() or not bun.is_file():
        raise HTTPException(status_code=503, detail="Waystation CLI runtime is unavailable")
    return root, repo, bun, cli


def _run_json(label: str, args: list[str], *, array_envelope: bool = True) -> Any:
    root, repo, bun, cli = _configuration()
    command = [str(bun), "run", *args]
    try:
        process = subprocess.Popen(
            command,
            cwd=str(repo),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        raise HTTPException(status_code=502, detail=f"Waystation {label} reader could not start") from exc

    output: dict[str, bytearray] = {"stdout": bytearray(), "stderr": bytearray()}
    oversized = threading.Event()

    def drain(name: str, stream: Any) -> None:
        while chunk := stream.read(64 * 1024):
            if len(output[name]) + len(chunk) > _MAX_OUTPUT_BYTES:
                oversized.set()
                try:
                    process.kill()
                except OSError:
                    pass
                continue
            output[name].extend(chunk)

    readers = [
        threading.Thread(target=drain, args=("stdout", process.stdout), daemon=True),
        threading.Thread(target=drain, args=("stderr", process.stderr), daemon=True),
    ]
    for reader in readers:
        reader.start()
    try:
        returncode = process.wait(timeout=_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        try:
            process.kill()
        except OSError:
            pass
        process.wait()
        for reader in readers:
            reader.join()
        raise HTTPException(status_code=504, detail=f"Waystation {label} read timed out") from exc
    for reader in readers:
        reader.join()

    if oversized.is_set():
        raise HTTPException(status_code=502, detail=f"Waystation {label} output exceeds 1 MB")
    stdout = bytes(output["stdout"])
    stderr = bytes(output["stderr"])
    if returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()[:500]
        raise HTTPException(status_code=502, detail=f"Waystation {label} read failed: {detail or 'unknown error'}")

    try:
        value = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail=f"Waystation {label} returned invalid JSON") from exc

    if array_envelope:
        if not isinstance(value, dict) or value.get("ok") is not True or not isinstance(value.get("data"), list):
            raise HTTPException(status_code=502, detail=f"Waystation {label} returned an invalid result")
        return value["data"]
    if not isinstance(value, list):
        raise HTTPException(status_code=502, detail=f"Waystation {label} returned an invalid result")
    return value


@router.get("/snapshot")
def read_snapshot() -> dict[str, Any]:
    """Read the configured project's tasks and claims through core-backed adapters."""
    root, repo, bun, cli = _configuration()
    claims_read = repo / "integrations" / "hermes" / "desktop" / "claims-read.ts"
    tasks = _run_json(
        "task list",
        [str(cli), "task", "list", "--root", str(root), "--json"],
    )
    claims = _run_json(
        "claim list",
        [str(claims_read), "--root", str(root)],
    )
    return {"projectRoot": str(root), "tasks": tasks, "claims": claims}


@router.get("/tasks/{task_id}/messages")
def read_task_messages(task_id: str) -> list[dict[str, Any]]:
    """Read one canonical task thread; the path parameter cannot select a root."""
    if not _TASK_ID_RE.fullmatch(task_id):
        raise HTTPException(status_code=400, detail="Invalid Waystation task id")
    root, repo, bun, cli = _configuration()
    return _run_json(
        "message list",
        [str(cli), "message", "list", "--thread", task_id, "--root", str(root), "--json"],
        array_envelope=False,
    )
