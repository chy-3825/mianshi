#!/usr/bin/env python3
"""Audit and apply the final CC Switch/Codex acceptance migration.

The default mode is strictly read-only.  ``--apply`` is intentionally guarded:
CC Switch and Codex writers must be stopped, both SQLite databases are backed up
through SQLite's online-backup API, and every mutable input is revalidated before
any write.

This utility never logs provider settings, account identifiers, credentials,
thread identifiers, or model/provider values.  Its output is limited to paths,
counts, and pass/pending/blocked state.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional


EXPECTED_MANAGED_PROVIDER_IDS = frozenset(
    {"codex-official", "codex-official-account-1fc18b24"}
)
EXPECTED_CURRENT_PROVIDER_ID = "codex-official-account-1fc18b24"
EXPECTED_LEDGER_VERSION = 1
EXPECTED_LEDGER_THREADS = 122
EXPECTED_LEDGER_SHA256 = (
    "b42a043f4864d34feedb1dc965dc4873b84e67c862bf1184cee6f9b1c0b8a36b"
)
HISTORY_MIGRATED_MODEL = "gpt-5.6-sol"
ALLOWED_HISTORY_PROVIDERS = frozenset({"cc-switch-official", "custom"})
MIGRATION_MANIFEST_VERSION = 1

CURRENT_CONFIG = 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n'
OTHER_CONFIG = 'model = "gpt-5.6-luna"\n'

MODEL_CATALOG: dict[str, Any] = {
    "models": [
        {
            "model": "gpt-6-astra",
            "displayName": "GPT-6 Astra",
            "contextWindow": 272000,
            "supportsParallelToolCalls": True,
            "inputModalities": ["text", "image"],
            "reasoningLevels": ["low", "medium", "high", "xhigh", "max", "ultra"],
            "defaultReasoningLevel": "low",
        },
        {
            "model": "gpt-5.6-sol",
            "displayName": "GPT-5.6 Sol",
            "contextWindow": 272000,
            "supportsParallelToolCalls": True,
            "inputModalities": ["text", "image"],
            "reasoningLevels": ["low", "medium", "high", "xhigh", "max", "ultra"],
            "defaultReasoningLevel": "low",
        },
        {
            "model": "gpt-5.6-terra",
            "displayName": "GPT-5.6 Terra",
            "contextWindow": 272000,
            "supportsParallelToolCalls": True,
            "inputModalities": ["text", "image"],
            "reasoningLevels": ["low", "medium", "high", "xhigh", "max", "ultra"],
            "defaultReasoningLevel": "medium",
        },
        {
            "model": "gpt-5.6-luna",
            "displayName": "GPT-5.6 Luna",
            "contextWindow": 272000,
            "supportsParallelToolCalls": True,
            "inputModalities": ["text", "image"],
            "reasoningLevels": ["low", "medium", "high", "xhigh", "max"],
            "defaultReasoningLevel": "medium",
        },
        {
            "model": "gpt-5.5",
            "displayName": "GPT-5.5",
            "contextWindow": 272000,
            "supportsParallelToolCalls": True,
            "inputModalities": ["text", "image"],
            "reasoningLevels": ["low", "medium", "high", "xhigh"],
            "defaultReasoningLevel": "medium",
        },
    ]
}

ROOT_REASONING_RE = re.compile(
    r'^\s*model_reasoning_effort\s*=\s*"(?P<value>[^"]+)"\s*(?:#.*)?$'
)
TABLE_HEADER_RE = re.compile(r"^\s*\[")


class MigrationError(RuntimeError):
    """A deliberately sanitized migration error."""


@dataclass(frozen=True)
class Paths:
    home: Path
    cc_dir: Path
    app_db: Path
    settings_json: Path
    oauth_store: Path
    codex_dir: Path
    state_db: Path
    ledger_dir: Path
    ledger_json: Path
    backup_root: Path
    backup_dir: Path
    manifest_json: Path


@dataclass(frozen=True)
class CardState:
    provider_id: str
    is_current: bool
    settings_raw: str
    meta_raw: str
    sql_provider_type: Optional[str]
    account_id: str
    settings: dict[str, Any]


@dataclass(frozen=True)
class AppDbState:
    cards: Mapping[str, CardState]
    common_raw: str
    common_target: str
    current_provider_count: int

    def fingerprint(self) -> tuple[Any, ...]:
        cards = tuple(
            (
                provider_id,
                card.is_current,
                card.settings_raw,
                card.meta_raw,
                card.sql_provider_type,
            )
            for provider_id, card in sorted(self.cards.items())
        )
        return cards, self.common_raw, self.current_provider_count


@dataclass(frozen=True)
class FileState:
    raw: bytes
    digest: str
    mode: int


@dataclass(frozen=True)
class BackupArtifact:
    path: Path
    digest: str
    size: int


@dataclass(frozen=True)
class AuditSnapshot:
    app: AppDbState
    settings_file: FileState
    settings_object: Mapping[str, Any]
    oauth_file: FileState
    oauth_account_ids: frozenset[str]
    ledger_file: FileState
    ledger_targets: Mapping[str, Optional[str]]
    state_rows: Mapping[str, tuple[Optional[str], str]]
    settings_pending: bool
    card_updates_pending: int
    history_updates_pending: int
    permission_updates_pending: int
    running_cc_switch: int
    running_codex: int
    external_db_writers: int

    def stability_fingerprint(self) -> tuple[Any, ...]:
        return (
            self.app.fingerprint(),
            self.settings_file.digest,
            self.oauth_file.digest,
            self.ledger_file.digest,
            tuple(sorted(self.state_rows.items())),
        )


def fail(message: str) -> None:
    raise MigrationError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path, label: str) -> tuple[str, int]:
    info = ensure_regular_file(path, label)
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
    except OSError as exc:
        fail(f"unable to hash {label}: {exc.__class__.__name__}")
    if size != info.st_size:
        fail(f"{label} changed while it was being hashed")
    return digest.hexdigest(), size


def ensure_regular_file(path: Path, label: str) -> os.stat_result:
    try:
        info = path.lstat()
    except FileNotFoundError:
        fail(f"missing required {label}")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        fail(f"{label} must be a regular, non-symlink file")
    if info.st_uid != os.geteuid():
        fail(f"{label} must be owned by the current user")
    return info


def ensure_directory(path: Path, label: str) -> os.stat_result:
    try:
        info = path.lstat()
    except FileNotFoundError:
        fail(f"missing required {label}")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail(f"{label} must be a directory, not a symlink")
    if info.st_uid != os.geteuid():
        fail(f"{label} must be owned by the current user")
    return info


def read_file_state(path: Path, label: str) -> FileState:
    info = ensure_regular_file(path, label)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        fail(f"unable to read {label}: {exc.__class__.__name__}")
    return FileState(raw=raw, digest=sha256_bytes(raw), mode=stat.S_IMODE(info.st_mode))


def parse_json_bytes(raw: bytes, label: str) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"invalid UTF-8 JSON in {label}: {exc.__class__.__name__}")


def readonly_sqlite(path: Path, label: str) -> sqlite3.Connection:
    ensure_regular_file(path, label)
    try:
        connection = sqlite3.connect(
            path.resolve().as_uri() + "?mode=ro",
            uri=True,
            timeout=30.0,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        return connection
    except sqlite3.Error as exc:
        fail(f"unable to open {label}: {exc.__class__.__name__}")


def writable_sqlite(path: Path, label: str) -> sqlite3.Connection:
    ensure_regular_file(path, label)
    try:
        connection = sqlite3.connect(
            str(path), timeout=30.0, isolation_level=None
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection
    except sqlite3.Error as exc:
        fail(f"unable to open writable {label}: {exc.__class__.__name__}")


def quick_check(connection: sqlite3.Connection, label: str) -> None:
    try:
        rows = connection.execute("PRAGMA quick_check").fetchall()
    except sqlite3.Error as exc:
        fail(f"quick_check failed for {label}: {exc.__class__.__name__}")
    if len(rows) != 1 or rows[0][0] != "ok":
        fail(f"quick_check reported corruption for {label}")


def require_columns(
    connection: sqlite3.Connection, table: str, required: Iterable[str], label: str
) -> None:
    try:
        rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error as exc:
        fail(f"unable to inspect {label} schema: {exc.__class__.__name__}")
    columns = {row[1] for row in rows}
    missing = set(required) - columns
    if missing:
        fail(f"unexpected {label} schema (missing {len(missing)} required columns)")


def target_common_config(raw: str) -> str:
    lines = raw.splitlines(keepends=True)
    in_root = True
    removed = 0
    output: list[str] = []

    for line in lines:
        logical = line.rstrip("\r\n")
        if in_root and TABLE_HEADER_RE.match(logical):
            in_root = False
        match = ROOT_REASONING_RE.match(logical) if in_root else None
        if match:
            if match.group("value") != "max":
                fail("common_config_codex has an unexpected root reasoning effort")
            removed += 1
            continue
        output.append(line)

    if removed > 1:
        fail("common_config_codex has duplicate root reasoning effort entries")
    return "".join(output)


def decode_object(raw: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {label}: {exc.__class__.__name__}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def read_app_db_state(connection: sqlite3.Connection) -> AppDbState:
    quick_check(connection, "CC Switch database")
    require_columns(
        connection,
        "providers",
        (
            "id",
            "app_type",
            "settings_config",
            "meta",
            "is_current",
            "provider_type",
        ),
        "providers",
    )
    require_columns(connection, "settings", ("key", "value"), "settings")

    try:
        rows = connection.execute(
            """
            SELECT id, settings_config, meta, is_current, provider_type
              FROM providers
             WHERE app_type = 'codex'
             ORDER BY id
            """
        ).fetchall()
    except sqlite3.Error as exc:
        fail(f"unable to inspect Codex providers: {exc.__class__.__name__}")

    current_rows = sum(1 for row in rows if int(row["is_current"]) == 1)
    if current_rows != 1:
        fail("Codex providers must have exactly one current row")

    candidates: dict[str, tuple[sqlite3.Row, dict[str, Any]]] = {}
    for row in rows:
        meta = decode_object(row["meta"], "Codex provider metadata")
        binding = meta.get("authBinding")
        marked = (
            row["id"] in EXPECTED_MANAGED_PROVIDER_IDS
            or row["provider_type"] == "codex_oauth"
            or meta.get("providerType") == "codex_oauth"
            or (
                isinstance(binding, dict)
                and binding.get("authProvider") == "codex_oauth"
            )
        )
        if marked:
            candidates[row["id"]] = (row, meta)

    if set(candidates) != set(EXPECTED_MANAGED_PROVIDER_IDS):
        fail("managed Codex provider set does not match the acceptance baseline")

    cards: dict[str, CardState] = {}
    account_ids: set[str] = set()
    for provider_id, (row, meta) in candidates.items():
        if row["provider_type"] not in (None, "codex_oauth"):
            fail("managed Codex provider has an unexpected SQL provider type")
        if meta.get("providerType") != "codex_oauth":
            fail("managed Codex provider metadata type is invalid")
        binding = meta.get("authBinding")
        if not isinstance(binding, dict) or set(binding) != {
            "source",
            "authProvider",
            "accountId",
        }:
            fail("managed Codex provider has an invalid auth binding shape")
        if binding.get("source") != "managed_account":
            fail("managed Codex provider binding source is invalid")
        if binding.get("authProvider") != "codex_oauth":
            fail("managed Codex provider binding type is invalid")
        account_id = binding.get("accountId")
        if not isinstance(account_id, str) or not account_id.strip():
            fail("managed Codex provider binding lacks an account")
        account_id = account_id.strip()
        if account_id in account_ids:
            fail("managed Codex providers must bind distinct accounts")
        account_ids.add(account_id)

        settings_raw = row["settings_config"]
        settings = decode_object(settings_raw, "managed Codex provider settings")
        allowed_keys = {"auth", "config", "modelCatalog"}
        if set(settings) not in ({"auth", "config"}, allowed_keys):
            fail("managed Codex provider settings contain unexpected fields")
        if settings.get("auth") != {}:
            fail("managed Codex provider auth must be an empty object")
        is_current = int(row["is_current"]) == 1
        config = settings.get("config")
        allowed_config = (
            {CURRENT_CONFIG, OTHER_CONFIG} if is_current else {OTHER_CONFIG}
        )
        if not isinstance(config, str) or config not in allowed_config:
            fail("managed Codex provider config is outside the migration baseline")
        if "modelCatalog" in settings and settings["modelCatalog"] != MODEL_CATALOG:
            fail("managed Codex provider has an unexpected existing model catalog")

        cards[provider_id] = CardState(
            provider_id=provider_id,
            is_current=is_current,
            settings_raw=settings_raw,
            meta_raw=row["meta"],
            sql_provider_type=row["provider_type"],
            account_id=account_id,
            settings=settings,
        )

    current_cards = [card for card in cards.values() if card.is_current]
    if len(current_cards) != 1:
        fail("managed Codex cards must have exactly one current card")
    if current_cards[0].provider_id != EXPECTED_CURRENT_PROVIDER_ID:
        fail("the unexpected managed Codex card is current")
    if not current_cards[0].account_id.startswith("1fc18b24-"):
        fail("the current managed Codex card is bound to the wrong account")

    try:
        common_rows = connection.execute(
            "SELECT value FROM settings WHERE key = 'common_config_codex'"
        ).fetchall()
    except sqlite3.Error as exc:
        fail(f"unable to inspect common Codex config: {exc.__class__.__name__}")
    if len(common_rows) != 1 or not isinstance(common_rows[0][0], str):
        fail("common_config_codex must exist exactly once")
    common_raw = common_rows[0][0]

    return AppDbState(
        cards=cards,
        common_raw=common_raw,
        common_target=target_common_config(common_raw),
        current_provider_count=current_rows,
    )


def validate_oauth_store(
    state: FileState,
    bound_account_ids: frozenset[str],
    expected_default_account_id: str,
) -> frozenset[str]:
    store = parse_json_bytes(state.raw, "managed Codex OAuth store")
    if not isinstance(store, dict):
        fail("managed Codex OAuth store must be an object")
    if store.get("version") != 2 or not isinstance(store.get("accounts"), dict):
        fail("managed Codex OAuth store has an unexpected schema")
    accounts: dict[str, Any] = store["accounts"]
    if len(accounts) != 2 or set(accounts) != set(bound_account_ids):
        fail("managed Codex bindings do not exactly match stored accounts")
    default_account = store.get("default_account_id")
    if default_account not in accounts:
        fail("managed Codex OAuth default account is invalid")
    if default_account != expected_default_account_id:
        fail("managed Codex OAuth default account does not match the current card")

    for account_id, account in accounts.items():
        if not isinstance(account, dict):
            fail("managed Codex OAuth account record is invalid")
        if account.get("account_id") != account_id:
            fail("managed Codex OAuth account identity is inconsistent")
        for field in ("refresh_token", "chatgpt_account_id", "id_token"):
            value = account.get(field)
            if not isinstance(value, str) or not value.strip():
                fail("managed Codex OAuth account requires reauthentication")
        if account.get("refresh_invalid", False) is not False:
            fail("managed Codex OAuth account requires reauthentication")
        if not isinstance(account.get("authenticated_at"), int):
            fail("managed Codex OAuth account timestamp is invalid")
        if not isinstance(account.get("token_updated_at_ms"), int):
            fail("managed Codex OAuth token timestamp is invalid")
    return frozenset(accounts)


def validate_settings(
    state: FileState, expected_current_provider: str
) -> tuple[dict[str, Any], bool]:
    settings = parse_json_bytes(state.raw, "CC Switch settings")
    if not isinstance(settings, dict):
        fail("CC Switch settings must be an object")
    if settings.get("currentProviderCodex") != expected_current_provider:
        fail("CC Switch settings and database disagree on the current Codex card")

    expected = {
        "preserveCodexOfficialAuthOnSwitch": False,
        "unifyCodexSessionHistory": True,
        "unifyCodexMigrateExisting": True,
    }
    for key in expected:
        if key in settings and not isinstance(settings[key], bool):
            fail("CC Switch acceptance setting has an invalid type")
    pending = any(settings.get(key) is not value for key, value in expected.items())
    return settings, pending


def read_ledger(state: FileState) -> dict[str, Optional[str]]:
    if state.digest != EXPECTED_LEDGER_SHA256:
        fail("history model ledger does not match the reviewed acceptance snapshot")
    ledger = parse_json_bytes(state.raw, "history model ledger")
    if not isinstance(ledger, dict) or ledger.get("version") != EXPECTED_LEDGER_VERSION:
        fail("history model ledger version is invalid")
    entries = ledger.get("originalThreads")
    if not isinstance(entries, dict) or len(entries) != EXPECTED_LEDGER_THREADS:
        fail("history model ledger must contain exactly 122 original threads")

    expected_fields = {"model", "modelProvider", "headerModelProvider", "rolloutPath"}
    targets: dict[str, Optional[str]] = {}
    for thread_id, entry in entries.items():
        if not isinstance(thread_id, str) or not thread_id:
            fail("history model ledger contains an invalid thread identity")
        if not isinstance(entry, dict) or set(entry) != expected_fields:
            fail("history model ledger contains an invalid entry shape")
        model = entry.get("model")
        if model is not None and not isinstance(model, str):
            fail("history model ledger contains an invalid original model")
        for field in ("modelProvider", "headerModelProvider", "rolloutPath"):
            if not isinstance(entry.get(field), str) or not entry[field]:
                fail("history model ledger contains incomplete provenance")
        targets[thread_id] = model
    return targets


def read_state_rows(
    connection: sqlite3.Connection, targets: Mapping[str, Optional[str]]
) -> dict[str, tuple[Optional[str], str]]:
    quick_check(connection, "Codex state database")
    require_columns(
        connection, "threads", ("id", "model", "model_provider"), "Codex threads"
    )
    identifiers = list(targets)
    placeholders = ",".join("?" for _ in identifiers)
    try:
        rows = connection.execute(
            f"SELECT id, model, model_provider FROM threads WHERE id IN ({placeholders})",
            identifiers,
        ).fetchall()
    except sqlite3.Error as exc:
        fail(f"unable to inspect Codex thread models: {exc.__class__.__name__}")
    if len(rows) != len(identifiers):
        fail("Codex state database does not contain every ledger thread")
    result: dict[str, tuple[Optional[str], str]] = {}
    for row in rows:
        provider = row["model_provider"]
        if not isinstance(provider, str) or not provider:
            fail("Codex state contains an invalid model provider")
        if provider not in ALLOWED_HISTORY_PROVIDERS:
            fail("Codex state ledger row has an unexpected model provider")
        model = row["model"]
        if model is not None and not isinstance(model, str):
            fail("Codex state contains an invalid model")
        expected_model = targets[row["id"]]
        if model not in (HISTORY_MIGRATED_MODEL, expected_model):
            fail("Codex state ledger row has an unexpected current model")
        result[row["id"]] = (model, provider)
    if set(result) != set(targets):
        fail("Codex state ledger lookup is inconsistent")
    return result


def process_names(entry: Path) -> set[str]:
    names: set[str] = set()
    try:
        names.add((entry / "comm").read_text(errors="replace").strip())
    except OSError:
        pass
    try:
        names.add((entry / "exe").resolve(strict=True).name)
    except OSError:
        pass
    try:
        argv = (entry / "cmdline").read_bytes().split(b"\0")
        if argv and argv[0]:
            names.add(Path(os.fsdecode(argv[0])).name)
    except OSError:
        pass
    return {name for name in names if name}


def is_named_process(names: Iterable[str], base: str) -> bool:
    return any(
        name == base or name.startswith(f"{base}-") or name.startswith(f"{base}.")
        for name in names
    )


def fd_is_writable(fdinfo: Path) -> bool:
    try:
        lines = fdinfo.read_text(errors="replace").splitlines()
    except FileNotFoundError:
        return False
    except PermissionError:
        return False
    except OSError as exc:
        fail(f"unable to inspect process file-descriptor flags: {exc.__class__.__name__}")
    for line in lines:
        if line.startswith("flags:"):
            try:
                flags = int(line.split(":", 1)[1].strip(), 8)
            except ValueError:
                fail("process file-descriptor flags are invalid")
            return flags & os.O_ACCMODE != os.O_RDONLY
    fail("process file-descriptor flags are unavailable")


def process_gate_counts(paths: Paths) -> tuple[int, int, int]:
    proc = Path("/proc")
    if not proc.is_dir():
        fail("process inspection is unavailable")
    tracked_db_paths = {
        str(path)
        for database in (paths.app_db, paths.state_db)
        for path in (
            database,
            Path(f"{database}-wal"),
            Path(f"{database}-shm"),
            Path(f"{database}-journal"),
        )
    }
    cc_switch_matches = 0
    codex_matches = 0
    writer_pids: set[int] = set()
    for entry in proc.iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            owner = entry.stat().st_uid
        except FileNotFoundError:
            continue
        except OSError as exc:
            fail(f"unable to inspect process ownership: {exc.__class__.__name__}")

        names = process_names(entry)
        if is_named_process(names, "cc-switch"):
            cc_switch_matches += 1
        if is_named_process(names, "codex"):
            codex_matches += 1

        if owner != os.geteuid():
            continue
        fd_dir = entry / "fd"
        try:
            descriptors = list(fd_dir.iterdir())
        except FileNotFoundError:
            continue
        except PermissionError:
            continue
        except OSError as exc:
            fail(f"unable to inspect same-user process descriptors: {exc.__class__.__name__}")
        for descriptor in descriptors:
            try:
                target = os.readlink(descriptor)
            except FileNotFoundError:
                continue
            except PermissionError:
                continue
            except OSError as exc:
                fail(f"unable to inspect same-user process descriptor: {exc.__class__.__name__}")
            if target.endswith(" (deleted)"):
                target = target[: -len(" (deleted)")]
            if target in tracked_db_paths and fd_is_writable(
                entry / "fdinfo" / descriptor.name
            ):
                writer_pids.add(int(entry.name))
                break
    return cc_switch_matches, codex_matches, len(writer_pids)


def require_process_gate_clear(paths: Paths, phase: str) -> None:
    cc_switch, codex, writers = process_gate_counts(paths)
    if cc_switch or codex or writers:
        fail(
            f"apply refused because managed processes or database writers are active during {phase}"
        )


def sqlite_family(database: Path) -> tuple[Path, ...]:
    return (
        database,
        Path(f"{database}-wal"),
        Path(f"{database}-shm"),
        Path(f"{database}-journal"),
    )


def is_sqlite_sidecar(path: Path) -> bool:
    return path.name.endswith(("-wal", "-shm", "-journal"))


def permission_targets(
    paths: Paths, backup_files: Iterable[Path] = ()
) -> dict[Path, int]:
    targets: dict[Path, int] = {}
    for directory in (
        paths.cc_dir,
        paths.backup_root,
        paths.cc_dir / "logs",
        paths.codex_dir,
        paths.ledger_dir,
        paths.ledger_dir / "backups",
    ):
        if directory.exists():
            info = directory.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                fail("sensitive directory is not a real directory")
            if info.st_uid != os.geteuid():
                fail("sensitive directory must be owned by the current user")
            targets[directory] = 0o700

    sensitive_files = {
        paths.settings_json,
        paths.oauth_store,
        paths.cc_dir / "codex_managed_oauth_live_auth.json",
        paths.cc_dir / "crash.log",
        paths.cc_dir / "model-pricing.json",
        paths.codex_dir / "auth.json",
        paths.codex_dir / "config.toml",
        paths.codex_dir / "cc-switch-model-catalog.json",
        paths.codex_dir / "models_cache.json",
        paths.codex_dir / "session_index.jsonl",
        paths.codex_dir / "installation_id",
        paths.ledger_json,
        paths.ledger_dir / "sync.log",
        *sqlite_family(paths.app_db),
        *sqlite_family(paths.state_db),
    }
    try:
        codex_sqlite_files = tuple(paths.codex_dir.glob("*.sqlite*"))
    except OSError as exc:
        fail(f"unable to enumerate Codex databases: {exc.__class__.__name__}")
    sensitive_files.update(codex_sqlite_files)

    for file_path in sensitive_files:
        try:
            info = file_path.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            fail(f"unable to inspect sensitive file: {exc.__class__.__name__}")
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            fail("sensitive file must be a regular, non-symlink file")
        if info.st_uid != os.geteuid():
            fail("sensitive file must be owned by the current user")
        targets[file_path] = 0o600

    backup_files = tuple(backup_files)
    if backup_files:
        info = ensure_directory(paths.backup_dir, "dedicated migration backup directory")
        targets[paths.backup_dir] = 0o700
        for file_path in backup_files:
            if file_path.parent != paths.backup_dir:
                fail("backup permission target is outside the dedicated backup directory")
            ensure_regular_file(file_path, "migration backup artifact")
            targets[file_path] = 0o600
    return targets


def count_permission_drift(targets: Mapping[Path, int]) -> int:
    pending = 0
    for path, expected in targets.items():
        try:
            actual = stat.S_IMODE(path.lstat().st_mode)
        except FileNotFoundError:
            if is_sqlite_sidecar(path):
                continue
            fail("sensitive permission target disappeared")
        except OSError as exc:
            fail(f"unable to inspect sensitive permissions: {exc.__class__.__name__}")
        if actual != expected:
            pending += 1
    return pending


def build_paths(backup_dir: Path) -> Paths:
    home = Path.home()
    cc_dir = home / ".cc-switch"
    codex_dir = home / ".codex"
    ledger_dir = home / ".local" / "state" / "codex-history-model-sync"
    ensure_directory(cc_dir, "CC Switch data directory")
    ensure_directory(codex_dir, "Codex data directory")
    ensure_directory(ledger_dir, "history model ledger directory")
    backup_root = cc_dir / "backups"
    ensure_directory(backup_root, "CC Switch backup root")
    candidate = Path(os.path.abspath(os.fspath(backup_dir.expanduser())))
    if candidate.parent != backup_root:
        fail("backup directory must be a new direct child of the CC Switch backup root")
    try:
        candidate.lstat()
    except FileNotFoundError:
        pass
    except OSError as exc:
        fail(f"unable to inspect requested backup directory: {exc.__class__.__name__}")
    else:
        fail("backup directory must not already exist")
    return Paths(
        home=home,
        cc_dir=cc_dir,
        app_db=cc_dir / "cc-switch.db",
        settings_json=cc_dir / "settings.json",
        oauth_store=cc_dir / "codex_oauth_auth.json",
        codex_dir=codex_dir,
        state_db=codex_dir / "state_5.sqlite",
        ledger_dir=ledger_dir,
        ledger_json=ledger_dir / "ledger.json",
        backup_root=backup_root,
        backup_dir=candidate,
        manifest_json=candidate / "migration-state.json",
    )


def audit(paths: Paths) -> AuditSnapshot:
    settings_file = read_file_state(paths.settings_json, "CC Switch settings")
    oauth_file = read_file_state(paths.oauth_store, "managed Codex OAuth store")
    ledger_file = read_file_state(paths.ledger_json, "history model ledger")

    app_connection = readonly_sqlite(paths.app_db, "CC Switch database")
    try:
        app = read_app_db_state(app_connection)
    finally:
        app_connection.close()

    bound_ids = frozenset(card.account_id for card in app.cards.values())
    oauth_account_ids = validate_oauth_store(
        oauth_file,
        bound_ids,
        app.cards[EXPECTED_CURRENT_PROVIDER_ID].account_id,
    )
    settings_object, settings_pending = validate_settings(
        settings_file, EXPECTED_CURRENT_PROVIDER_ID
    )
    ledger_targets = read_ledger(ledger_file)

    state_connection = readonly_sqlite(paths.state_db, "Codex state database")
    try:
        state_rows = read_state_rows(state_connection, ledger_targets)
    finally:
        state_connection.close()

    card_updates_pending = sum(
        card.settings.get("config")
        != (CURRENT_CONFIG if card.is_current else OTHER_CONFIG)
        or card.settings.get("modelCatalog") != MODEL_CATALOG
        for card in app.cards.values()
    )
    history_updates_pending = sum(
        state_rows[thread_id][0] != target_model
        for thread_id, target_model in ledger_targets.items()
    )
    permission_updates_pending = count_permission_drift(
        permission_targets(paths)
    )
    running_cc_switch, running_codex, external_db_writers = process_gate_counts(paths)

    return AuditSnapshot(
        app=app,
        settings_file=settings_file,
        settings_object=settings_object,
        oauth_file=oauth_file,
        oauth_account_ids=oauth_account_ids,
        ledger_file=ledger_file,
        ledger_targets=ledger_targets,
        state_rows=state_rows,
        settings_pending=settings_pending,
        card_updates_pending=card_updates_pending,
        history_updates_pending=history_updates_pending,
        permission_updates_pending=permission_updates_pending,
        running_cc_switch=running_cc_switch,
        running_codex=running_codex,
        external_db_writers=external_db_writers,
    )


def print_audit(snapshot: AuditSnapshot, paths: Paths) -> None:
    common_pending = snapshot.app.common_raw != snapshot.app.common_target
    total_data_pending = (
        snapshot.card_updates_pending
        + snapshot.history_updates_pending
        + int(snapshot.settings_pending)
        + int(common_pending)
    )
    print("AUDIT OK")
    print("mode=audit")
    print(f"managed_cards={len(snapshot.app.cards)}")
    print(f"managed_bindings={len(snapshot.oauth_account_ids)}")
    print(f"current_managed_cards={sum(card.is_current for card in snapshot.app.cards.values())}")
    print(f"ledger_threads={len(snapshot.ledger_targets)}")
    print(f"provider_cards_pending={snapshot.card_updates_pending}")
    print(f"common_config_pending={'yes' if common_pending else 'no'}")
    print(f"settings_pending={'yes' if snapshot.settings_pending else 'no'}")
    print(f"history_models_pending={snapshot.history_updates_pending}")
    print("history_providers_planned=0")
    print(f"permission_entries_pending={snapshot.permission_updates_pending}")
    print(f"data_changes_pending={total_data_pending}")
    print(f"cc_switch_processes={snapshot.running_cc_switch}")
    print(f"codex_processes={snapshot.running_codex}")
    print(f"external_db_writer_processes={snapshot.external_db_writers}")
    apply_allowed = not (
        snapshot.running_cc_switch
        or snapshot.running_codex
        or snapshot.external_db_writers
    )
    print(f"apply_allowed={'yes' if apply_allowed else 'no'}")
    print(f"backup_dir={paths.backup_dir}")


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def prepare_backup_dir(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        fail("backup directory must remain absent until apply creates it")
    except OSError as exc:
        fail(f"unable to create backup directory: {exc.__class__.__name__}")
    try:
        os.chmod(path, 0o700, follow_symlinks=False)
        fsync_directory(path.parent)
    except OSError as exc:
        fail(f"unable to secure backup directory: {exc.__class__.__name__}")


def remove_temporary_sqlite_sidecars(database: Path) -> None:
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(f"{database}{suffix}")
        try:
            info = sidecar.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            fail(f"unable to inspect temporary SQLite sidecar: {exc.__class__.__name__}")
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            fail("temporary SQLite sidecar is not a regular file")
        if info.st_uid != os.geteuid():
            fail("temporary SQLite sidecar is not owned by the current user")
        try:
            sidecar.unlink()
        except OSError as exc:
            fail(f"unable to remove temporary SQLite sidecar: {exc.__class__.__name__}")


def sqlite_backup(source: Path, destination: Path, label: str) -> BackupArtifact:
    if destination.exists() or destination.is_symlink():
        fail(f"refusing to overwrite existing {label} backup")
    partial = destination.with_name(f".{destination.name}.partial")
    if partial.exists() or partial.is_symlink():
        fail(f"refusing to overwrite existing partial {label} backup")
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    flags |= getattr(os, "O_NOFOLLOW", 0)
    source_connection: Optional[sqlite3.Connection] = None
    destination_connection: Optional[sqlite3.Connection] = None
    descriptor: Optional[int] = None
    partial_created = False
    published = False
    try:
        descriptor = os.open(partial, flags, 0o600)
        partial_created = True
        os.close(descriptor)
        descriptor = None
        os.chmod(partial, 0o600, follow_symlinks=False)

        source_connection = readonly_sqlite(source, label)
        quick_check(source_connection, label)
        destination_connection = sqlite3.connect(str(partial), timeout=30.0)
        source_connection.backup(destination_connection)
        destination_connection.commit()
        try:
            journal_mode = destination_connection.execute(
                "PRAGMA journal_mode"
            ).fetchone()[0]
            if str(journal_mode).lower() == "wal":
                destination_connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            journal_mode = destination_connection.execute(
                "PRAGMA journal_mode = DELETE"
            ).fetchone()[0]
        except sqlite3.Error as exc:
            fail(f"unable to finalize {label} backup journal: {exc.__class__.__name__}")
        if str(journal_mode).lower() != "delete":
            fail(f"unable to make {label} backup self-contained")
        quick_check(destination_connection, f"{label} backup")
        destination_connection.close()
        destination_connection = None
        source_connection.close()
        source_connection = None
        remove_temporary_sqlite_sidecars(partial)
        os.chmod(partial, 0o600, follow_symlinks=False)
        descriptor = os.open(
            partial, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
            descriptor = None
        os.replace(partial, destination)
        published = True
        fsync_directory(destination.parent)
        digest, size = sha256_file(destination, f"{label} backup")
        return BackupArtifact(path=destination, digest=digest, size=size)
    except BaseException as exc:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if destination_connection is not None:
            try:
                destination_connection.close()
            except sqlite3.Error:
                pass
        if source_connection is not None:
            try:
                source_connection.close()
            except sqlite3.Error:
                pass
        if partial_created and not published:
            try:
                partial.unlink(missing_ok=True)
                for suffix in ("-wal", "-shm", "-journal"):
                    Path(f"{partial}{suffix}").unlink(missing_ok=True)
                fsync_directory(destination.parent)
            except OSError:
                pass
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        if isinstance(exc, MigrationError):
            raise
        if isinstance(exc, (OSError, sqlite3.Error)):
            fail(f"unable to back up {label}: {exc.__class__.__name__}")
        raise


def atomic_write(
    path: Path,
    content: bytes,
    mode: int = 0o600,
    label: str = "file",
) -> None:
    parent = path.parent
    temporary = parent / f".{path.name}.final-acceptance.{os.getpid()}.{time.time_ns()}"
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor: Optional[int] = None
    try:
        descriptor = os.open(temporary, flags, mode)
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short write")
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, path)
        os.chmod(path, mode, follow_symlinks=False)
        fsync_directory(parent)
    except BaseException as exc:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        if isinstance(exc, OSError):
            fail(f"atomic {label} write failed: {exc.__class__.__name__}")
        raise


def target_settings_bytes(settings: Mapping[str, Any]) -> bytes:
    updated = dict(settings)
    updated["preserveCodexOfficialAuthOnSwitch"] = False
    updated["unifyCodexSessionHistory"] = True
    updated["unifyCodexMigrateExisting"] = True
    return (json.dumps(updated, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def target_card_raw(card: CardState) -> str:
    wanted_config = CURRENT_CONFIG if card.is_current else OTHER_CONFIG
    if (
        card.settings.get("config") == wanted_config
        and card.settings.get("modelCatalog") == MODEL_CATALOG
    ):
        return card.settings_raw
    settings = copy.deepcopy(card.settings)
    settings["config"] = wanted_config
    settings["modelCatalog"] = copy.deepcopy(MODEL_CATALOG)
    return json.dumps(settings, ensure_ascii=False, separators=(",", ":"))


def new_migration_manifest(snapshot: AuditSnapshot) -> dict[str, Any]:
    return {
        "version": MIGRATION_MANIFEST_VERSION,
        "phase": "prepared",
        "complete": False,
        "created_at_unix_ns": time.time_ns(),
        "inputs": {
            "settings_sha256": snapshot.settings_file.digest,
            "oauth_store_sha256": snapshot.oauth_file.digest,
            "ledger_sha256": snapshot.ledger_file.digest,
            "managed_cards": len(snapshot.app.cards),
            "ledger_threads": len(snapshot.ledger_targets),
        },
        "backups": {},
        "rollback_failures": [],
    }


def persist_manifest(
    path: Path,
    manifest: dict[str, Any],
    phase: str,
    *,
    complete: bool = False,
) -> tuple[str, int]:
    manifest["phase"] = phase
    manifest["complete"] = complete
    content = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode(
        "utf-8"
    )
    atomic_write(path, content, 0o600, "migration manifest")
    return sha256_bytes(content), len(content)


def record_backup(
    manifest: dict[str, Any], name: str, artifact: BackupArtifact
) -> None:
    backups = manifest.get("backups")
    if not isinstance(backups, dict):
        fail("migration manifest backup state is invalid")
    backups[name] = {
        "file": artifact.path.name,
        "sha256": artifact.digest,
        "size": artifact.size,
        "quick_check": "ok",
    }


def verify_stable_files(snapshot: AuditSnapshot, paths: Paths) -> None:
    checks = (
        (paths.settings_json, "CC Switch settings", snapshot.settings_file.digest),
        (paths.oauth_store, "managed Codex OAuth store", snapshot.oauth_file.digest),
        (paths.ledger_json, "history model ledger", snapshot.ledger_file.digest),
    )
    for path, label, expected_digest in checks:
        if read_file_state(path, label).digest != expected_digest:
            fail(f"{label} changed during migration preflight")


def begin_immediate(connection: sqlite3.Connection, label: str) -> None:
    try:
        connection.execute("BEGIN IMMEDIATE")
    except sqlite3.Error as exc:
        fail(f"unable to lock {label}: {exc.__class__.__name__}")


def update_app_transaction(
    connection: sqlite3.Connection,
    before: AppDbState,
    card_targets: Mapping[str, str],
) -> None:
    for provider_id, target_raw in card_targets.items():
        old_raw = before.cards[provider_id].settings_raw
        if target_raw == old_raw:
            continue
        cursor = connection.execute(
            """
            UPDATE providers
               SET settings_config = ?
             WHERE id = ? AND app_type = 'codex' AND settings_config = ?
            """,
            (target_raw, provider_id, old_raw),
        )
        if cursor.rowcount != 1:
            fail("managed Codex card changed during transactional update")

    if before.common_target != before.common_raw:
        cursor = connection.execute(
            """
            UPDATE settings SET value = ?
             WHERE key = 'common_config_codex' AND value = ?
            """,
            (before.common_target, before.common_raw),
        )
        if cursor.rowcount != 1:
            fail("common Codex config changed during transactional update")


def update_state_transaction(
    connection: sqlite3.Connection,
    before_rows: Mapping[str, tuple[Optional[str], str]],
    targets: Mapping[str, Optional[str]],
) -> int:
    changed = 0
    for thread_id, target_model in targets.items():
        old_model, old_provider = before_rows[thread_id]
        if old_model == target_model:
            continue
        cursor = connection.execute(
            """
            UPDATE threads SET model = ?
             WHERE id = ? AND model IS ? AND model_provider = ?
            """,
            (target_model, thread_id, old_model, old_provider),
        )
        if cursor.rowcount != 1:
            fail("Codex thread state changed during transactional update")
        changed += 1
    return changed


def verify_transaction_targets(
    app_connection: sqlite3.Connection,
    state_connection: sqlite3.Connection,
    app_before: AppDbState,
    card_targets: Mapping[str, str],
    state_targets: Mapping[str, Optional[str]],
    state_before: Mapping[str, tuple[Optional[str], str]],
) -> None:
    for provider_id, expected_raw in card_targets.items():
        row = app_connection.execute(
            "SELECT settings_config FROM providers WHERE id = ? AND app_type = 'codex'",
            (provider_id,),
        ).fetchone()
        if row is None or row[0] != expected_raw:
            fail("managed Codex card verification failed")
    row = app_connection.execute(
        "SELECT value FROM settings WHERE key = 'common_config_codex'"
    ).fetchone()
    if row is None or row[0] != app_before.common_target:
        fail("common Codex config verification failed")

    verified = read_state_rows(state_connection, state_targets)
    for thread_id, target_model in state_targets.items():
        model, provider = verified[thread_id]
        if model != target_model or provider != state_before[thread_id][1]:
            fail("Codex history restore verification failed")


def compensate_app(
    paths: Paths,
    before: AppDbState,
    card_targets: Mapping[str, str],
) -> None:
    connection = writable_sqlite(paths.app_db, "CC Switch database")
    try:
        begin_immediate(connection, "CC Switch database rollback")
        for provider_id, target_raw in card_targets.items():
            original = before.cards[provider_id].settings_raw
            row = connection.execute(
                "SELECT settings_config FROM providers WHERE id = ? AND app_type = 'codex'",
                (provider_id,),
            ).fetchone()
            if row is None or row[0] not in (original, target_raw):
                fail("CC Switch database rollback guard rejected concurrent changes")
            if row[0] == target_raw and target_raw != original:
                cursor = connection.execute(
                    """
                    UPDATE providers SET settings_config = ?
                     WHERE id = ? AND app_type = 'codex' AND settings_config = ?
                    """,
                    (original, provider_id, target_raw),
                )
                if cursor.rowcount != 1:
                    fail("CC Switch database rollback was incomplete")

        row = connection.execute(
            "SELECT value FROM settings WHERE key = 'common_config_codex'"
        ).fetchone()
        if row is None or row[0] not in (before.common_raw, before.common_target):
            fail("common config rollback guard rejected concurrent changes")
        if row[0] == before.common_target and before.common_target != before.common_raw:
            cursor = connection.execute(
                "UPDATE settings SET value = ? WHERE key = 'common_config_codex' AND value = ?",
                (before.common_raw, before.common_target),
            )
            if cursor.rowcount != 1:
                fail("common config rollback was incomplete")
        connection.commit()
    except Exception:
        try:
            connection.rollback()
        except sqlite3.Error:
            pass
        raise
    finally:
        connection.close()


def compensate_state(
    paths: Paths,
    before_rows: Mapping[str, tuple[Optional[str], str]],
    targets: Mapping[str, Optional[str]],
) -> None:
    connection = writable_sqlite(paths.state_db, "Codex state database")
    try:
        begin_immediate(connection, "Codex state database rollback")
        for thread_id, (original_model, original_provider) in before_rows.items():
            target_model = targets[thread_id]
            if original_model == target_model:
                continue
            row = connection.execute(
                "SELECT model, model_provider FROM threads WHERE id = ?", (thread_id,)
            ).fetchone()
            if row is None or row[1] != original_provider:
                fail("Codex state rollback guard rejected concurrent provider changes")
            if row[0] not in (original_model, target_model):
                fail("Codex state rollback guard rejected concurrent model changes")
            if row[0] == target_model:
                cursor = connection.execute(
                    """
                    UPDATE threads SET model = ?
                     WHERE id = ? AND model IS ? AND model_provider = ?
                    """,
                    (original_model, thread_id, target_model, original_provider),
                )
                if cursor.rowcount != 1:
                    fail("Codex state rollback was incomplete")
        connection.commit()
    except Exception:
        try:
            connection.rollback()
        except sqlite3.Error:
            pass
        raise
    finally:
        connection.close()


def compensate_settings(
    paths: Paths, before: FileState, expected_after: bytes
) -> None:
    current = read_file_state(paths.settings_json, "CC Switch settings")
    if current.raw == before.raw:
        return
    if current.raw != expected_after:
        fail("settings rollback guard rejected concurrent changes")
    atomic_write(paths.settings_json, before.raw, before.mode)


def capture_modes(targets: Mapping[Path, int]) -> dict[Path, int]:
    modes: dict[Path, int] = {}
    for path in targets:
        try:
            modes[path] = stat.S_IMODE(path.lstat().st_mode)
        except FileNotFoundError:
            if is_sqlite_sidecar(path):
                continue
            fail("permission target disappeared before capture")
        except OSError as exc:
            fail(f"unable to capture permissions: {exc.__class__.__name__}")
    return modes


def apply_permissions(targets: Mapping[Path, int]) -> None:
    for path, expected in targets.items():
        try:
            os.chmod(path, expected, follow_symlinks=False)
        except FileNotFoundError:
            if is_sqlite_sidecar(path):
                continue
            fail("sensitive permission target disappeared")
        except OSError as exc:
            fail(f"unable to harden sensitive permissions: {exc.__class__.__name__}")


def restore_modes(modes: Mapping[Path, int], backup_dir: Path) -> None:
    failures = 0
    for path, original in modes.items():
        try:
            path.relative_to(backup_dir)
            continue
        except ValueError:
            pass
        try:
            if path.exists() and not path.is_symlink():
                os.chmod(path, original, follow_symlinks=False)
        except OSError:
            failures += 1
    if failures:
        fail("permission rollback was incomplete")


def safe_rollback(
    paths: Paths,
    snapshot: AuditSnapshot,
    card_targets: Mapping[str, str],
    settings_after: bytes,
    modes_before: Mapping[Path, int],
) -> list[str]:
    failures: list[str] = []
    for label, operation in (
        (
            "app-db",
            lambda: compensate_app(paths, snapshot.app, card_targets),
        ),
        (
            "state-db",
            lambda: compensate_state(
                paths, snapshot.state_rows, snapshot.ledger_targets
            ),
        ),
        (
            "settings",
            lambda: compensate_settings(
                paths, snapshot.settings_file, settings_after
            ),
        ),
        ("permissions", lambda: restore_modes(modes_before, paths.backup_dir)),
    ):
        try:
            operation()
        except BaseException:
            failures.append(label)
    return failures


def apply_migration(
    paths: Paths, initial: AuditSnapshot
) -> tuple[BackupArtifact, BackupArtifact, str, int]:
    if (
        initial.running_cc_switch
        or initial.running_codex
        or initial.external_db_writers
    ):
        fail("apply refused because managed processes or database writers are active")
    require_process_gate_clear(paths, "initial preflight")

    prepare_backup_dir(paths.backup_dir)
    manifest = new_migration_manifest(initial)
    persist_manifest(paths.manifest_json, manifest, "prepared")
    app_backup = paths.backup_dir / "cc-switch.db.pre-final-acceptance.sqlite3"
    state_backup = paths.backup_dir / "state_5.sqlite.pre-final-acceptance.sqlite3"
    try:
        app_artifact = sqlite_backup(paths.app_db, app_backup, "CC Switch database")
        record_backup(manifest, "cc_switch_db", app_artifact)
        persist_manifest(paths.manifest_json, manifest, "app_backup_complete")
        state_artifact = sqlite_backup(
            paths.state_db, state_backup, "Codex state database"
        )
        record_backup(manifest, "codex_state_db", state_artifact)
        persist_manifest(paths.manifest_json, manifest, "backups_complete")
    except BaseException:
        try:
            persist_manifest(paths.manifest_json, manifest, "backup_failed")
        except BaseException:
            pass
        raise

    try:
        require_process_gate_clear(paths, "post-backup preflight")
        stable = audit(paths)
        if (
            stable.running_cc_switch
            or stable.running_codex
            or stable.external_db_writers
        ):
            fail("apply refused because a managed process or database writer started")
        if stable.stability_fingerprint() != initial.stability_fingerprint():
            fail("migration inputs changed while backups were running")

        card_targets = {
            provider_id: target_card_raw(card)
            for provider_id, card in stable.app.cards.items()
        }
        settings_after = target_settings_bytes(stable.settings_object)
        permission_plan = permission_targets(
            paths,
            backup_files=(paths.manifest_json, app_artifact.path, state_artifact.path),
        )
        modes_before = capture_modes(permission_plan)
        persist_manifest(paths.manifest_json, manifest, "preflight_complete")
    except BaseException:
        try:
            persist_manifest(paths.manifest_json, manifest, "preflight_failed")
        except BaseException:
            pass
        raise

    app_connection: Optional[sqlite3.Connection] = None
    state_connection: Optional[sqlite3.Connection] = None
    mutation_started = False
    settings_written = False
    history_changed = 0

    try:
        app_connection = writable_sqlite(paths.app_db, "CC Switch database")
        state_connection = writable_sqlite(paths.state_db, "Codex state database")
        begin_immediate(app_connection, "CC Switch database")
        begin_immediate(state_connection, "Codex state database")

        locked_app = read_app_db_state(app_connection)
        locked_state = read_state_rows(state_connection, stable.ledger_targets)
        if locked_app.fingerprint() != stable.app.fingerprint():
            fail("CC Switch database changed before its transaction acquired the lock")
        if locked_state != stable.state_rows:
            fail("Codex thread state changed before its transaction acquired the lock")
        verify_stable_files(stable, paths)
        require_process_gate_clear(paths, "locked mutation preflight")
        persist_manifest(paths.manifest_json, manifest, "transactions_locked")

        mutation_started = True
        update_app_transaction(app_connection, stable.app, card_targets)
        history_changed = update_state_transaction(
            state_connection, stable.state_rows, stable.ledger_targets
        )
        verify_transaction_targets(
            app_connection,
            state_connection,
            stable.app,
            card_targets,
            stable.ledger_targets,
            stable.state_rows,
        )

        current_settings = read_file_state(paths.settings_json, "CC Switch settings")
        if current_settings.digest != stable.settings_file.digest:
            fail("CC Switch settings changed before atomic update")
        if stable.settings_pending:
            atomic_write(paths.settings_json, settings_after, 0o600, "settings")
            settings_written = True
        persist_manifest(paths.manifest_json, manifest, "changes_staged")

        persist_manifest(paths.manifest_json, manifest, "commit_started")
        state_connection.commit()
        persist_manifest(paths.manifest_json, manifest, "state_committed")
        app_connection.commit()
        persist_manifest(paths.manifest_json, manifest, "databases_committed")
        state_connection.close()
        state_connection = None
        app_connection.close()
        app_connection = None

        apply_permissions(permission_plan)
        persist_manifest(paths.manifest_json, manifest, "permissions_hardened")
        final = audit(paths)
        if final.running_cc_switch or final.running_codex or final.external_db_writers:
            fail("a managed process or database writer started before verification")
        if (
            final.card_updates_pending
            or final.settings_pending
            or final.history_updates_pending
            or final.app.common_raw != final.app.common_target
            or final.permission_updates_pending
        ):
            fail("post-migration verification found incomplete acceptance state")
        if count_permission_drift(permission_plan):
            fail("post-migration verification found insecure artifact permissions")
        manifest_digest, _ = persist_manifest(
            paths.manifest_json, manifest, "complete", complete=True
        )
        return app_artifact, state_artifact, manifest_digest, history_changed
    except BaseException as exc:
        if state_connection is not None:
            try:
                state_connection.rollback()
            except sqlite3.Error:
                pass
            state_connection.close()
        if app_connection is not None:
            try:
                app_connection.rollback()
            except sqlite3.Error:
                pass
            app_connection.close()

        rollback_failures: list[str] = []
        if mutation_started or settings_written:
            rollback_failures = safe_rollback(
                paths, stable, card_targets, settings_after, modes_before
            )
        manifest["rollback_failures"] = sorted(rollback_failures)
        failure_phase = (
            "rollback_incomplete" if rollback_failures else "rolled_back"
        )
        try:
            persist_manifest(paths.manifest_json, manifest, failure_phase)
        except BaseException:
            if "manifest" not in rollback_failures:
                rollback_failures.append("manifest")
        detail = (
            "none" if not rollback_failures else ",".join(sorted(rollback_failures))
        )
        if isinstance(exc, MigrationError):
            reason = str(exc)
        else:
            reason = exc.__class__.__name__
        if isinstance(exc, KeyboardInterrupt) and not rollback_failures:
            raise
        raise MigrationError(
            f"migration failed ({reason}); SQL backups retained; rollback_failures={detail}"
        ) from None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit or apply the final CC Switch/Codex acceptance migration."
    )
    parser.add_argument(
        "--backup-dir",
        required=True,
        type=Path,
        help=(
            "New direct child of ~/.cc-switch/backups for the pre-migration "
            "SQLite backups and durable phase manifest."
        ),
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply the migration. Without this flag the command is read-only.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        paths = build_paths(args.backup_dir)
        snapshot = audit(paths)
        if not args.apply:
            print_audit(snapshot, paths)
            return 0

        app_backup, state_backup, manifest_digest, history_changed = apply_migration(
            paths, snapshot
        )
        print("APPLY OK")
        print("mode=apply")
        print(f"managed_cards={len(snapshot.app.cards)}")
        print(f"ledger_threads={len(snapshot.ledger_targets)}")
        print(f"history_models_changed={history_changed}")
        print("history_providers_changed=0")
        print(f"app_db_backup={app_backup.path}")
        print(f"app_db_backup_sha256={app_backup.digest}")
        print(f"app_db_backup_size={app_backup.size}")
        print(f"state_db_backup={state_backup.path}")
        print(f"state_db_backup_sha256={state_backup.digest}")
        print(f"state_db_backup_size={state_backup.size}")
        print(f"migration_manifest={paths.manifest_json}")
        print(f"migration_manifest_sha256={manifest_digest}")
        return 0
    except MigrationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("ERROR: interrupted; inspect retained SQL backups before retrying", file=sys.stderr)
        return 130
    except Exception as exc:
        print(
            f"ERROR: internal validation failure ({exc.__class__.__name__})",
            file=sys.stderr,
        )
        return 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
