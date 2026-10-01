# Brain bot, Part A: second-brain HTTP MCP and read-only SQL (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the second-brain MCP tools over loopback HTTP behind a bearer token, and add read-only `sql_query` and `sql_schema` tools, so the Telegram brain bot (Part B) can reach the whole store from one long-lived process.

**Architecture:** `src/store/sql_readonly.py` holds the read-only SQL layer (read-only connection, SQLite authorizer, time budget, size caps). `src/mcp_server.py` registers two thin tools over it and gains a `main()` whose `--http HOST:PORT` flag serves the existing `MCPServer` through `src/mcp_http.py` (bearer middleware plus loopback rule) on uvicorn. stdio stays the default and is unchanged. A wrapper in `scripts/wrappers/systemd/` and a unit documented in `docs/DEPLOY.md` run it on the producer.

**Tech Stack:** Python 3.12+, `mcp` 2.2.0 (`MCPServer.streamable_http_app`), Starlette and uvicorn (already installed as `mcp` dependencies), sqlite3, pytest, ruff 0.16.8, mypy 2.3.1.

**Spec:** `docs/superpowers/specs/2026-10-01-brain-bot-design.md` in the `telegram-bot` repo (sections 4.1, 6.3, 9, 10, 11.1). Part B: `docs/superpowers/plans/2026-10-01-brain-bot-b-telegram.md`.

**Where to work:** a worktree of `plessas-second-brain` on a new branch `feat/brain-mcp-http`, based on `origin/master`: from the main checkout, `git worktree add -b feat/brain-mcp-http .claude/worktrees/brain-mcp origin/master`, then `uv sync --frozen --extra dev` inside it (never symlink `.venv`: editable installs bake absolute paths). All paths below are relative to that worktree.

## Global Constraints

- `python -m src.mcp_server` with no arguments behaves exactly as today (stdio).
- HTTP mode: loopback hosts only (`127.0.0.1`, `localhost`, `::1`); every HTTP request needs `Authorization: Bearer <token>`; the token comes from the file named by `BRAIN_MCP_TOKEN_FILE`, mode 0600 (no group or other bits), at least 32 characters. Missing or wrong token: HTTP 401. The server refuses to start otherwise.
- `sql_query`: SELECT only, one statement per call, 10 s budget, at most 200 rows, each cell cut to 4,000 characters, at most 100,000 characters per answer, `truncated` flag when anything was left out.
- `sql_query` opens `mode=ro`, plus `immutable=1` only when `~/.second-brain/db-pull.stamp` exists (`REPLICA_STAMP`). Never decide this from `BRAIN_ROLE`.
- No new runtime dependency. No change to any existing tool's behaviour.
- Tests open no sockets and create no event loop: `tests/conftest.py` blocks `socket.socket`, and an asyncio loop needs a socketpair, so Starlette's `TestClient` cannot run here. ASGI code is tested by stepping coroutines by hand.
- Public repo: no employer, colleague or host-specific names in code, tests or docs (`scripts/pii-gauntlet.sh` must pass).
- Checks that must stay green: `uv run --frozen pytest`, `uvx ruff@0.16.8 check .`, `uvx ruff@0.16.8 format --check .`, `uv run --frozen --with mypy==2.3.1 --with types-requests==2.33.0.20260906 mypy --ignore-missing-imports --show-error-codes src/ scripts/`, `bash scripts/pii-gauntlet.sh`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Pushing, opening the PR and merging wait for the owner's go: the repo is public.

## Review Focus

1. A query that returns huge cells or many wide rows (full attachment text) must come back bounded by the cell, row and total caps, never as megabytes in the caller's context. Pinned in Task A1 (`test_cell_cut`, `test_total_size_cap`).
2. A runaway query (an unbounded recursive CTE, a cartesian join) must stop at the time budget with a clear error, leaving the server responsive. Pinned in Task A1 (`test_runaway_query_stops_at_the_budget`).
3. Greek search terms with accents and capitals must match through `sb_fold` inside `sql_query`. Pinned in Task A1 (`test_sb_fold_matches_greek_without_accents`).
4. Full-text search through `sql_query` (FTS5 `MATCH`) must work, although FTS5 reads `PRAGMA data_version` on every match and the authorizer denies pragmas by default. Pinned in Task A1 (`test_fts_match_works_through_the_authorizer`).
5. A token file others can read, a short token, or a public bind address must stop the server at start-up, not serve the store openly. Pinned in Task A3 (`test_token_readable_by_others`, `test_token_too_short`, `test_http_on_a_public_host_refuses`).

---

### Task A1: Read-only SQL layer

**Files:**

- Create: `src/store/sql_readonly.py`
- Test: `tests/test_sql_readonly.py`

**Interfaces:**

- Consumes: `src.config.DEFAULT_DB`, `src.config.REPLICA_STAMP`, `src.store.greek.register_sql_functions(conn)`.
- Produces:
  - `connect_read_only(db_path: Path | None = None) -> sqlite3.Connection`
  - `run_query(sql: str, limit: int = MAX_ROWS, db_path: Path | None = None) -> dict` returning `{"columns": list[str], "rows": list[list], "row_count": int, "truncated": bool}` or `{"error": str}`
  - `describe(table: str | None = None, db_path: Path | None = None) -> dict` returning `{"tables": [{"table": str, "rows": int | None}]}`, or `{"table": str, "columns": [...], "indexes": [...]}`, or `{"error": str}`
  - module constants `MAX_ROWS = 200`, `CELL_CHARS = 4000`, `TOTAL_CHARS = 100_000`, `BUDGET_SECONDS = 10.0`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_sql_readonly.py`:

```python
"""Tests for the read-only SQL layer behind the sql_query and sql_schema tools."""

import sqlite3
from pathlib import Path

import pytest

from src.store import sql_readonly


@pytest.fixture
def db(tmp_path: Path) -> Path:
    """A real store built by create_database, with three emails to read."""
    from src.store.schema import create_database

    path = tmp_path / "brain.db"
    conn = create_database(str(path))
    conn.executescript(
        """
        INSERT INTO emails (id, message_id, date_received, subject, summary, sender_name,
                            sender_address, mailbox_name, content) VALUES
            (1, 1, '2026-03-01T10:00:00', 'Budget plan', 'first', 'Alice', 'a@example.com',
             'Inbox', 'short body'),
            (2, 2, '2026-03-02T10:00:00', 'Προϋπολογισμός 2027', 'second', 'Bob',
             'b@example.com', 'Inbox', 'x'),
            (3, 3, '2026-03-03T10:00:00', 'Third', 'third', 'Carol', 'c@example.com',
             'Inbox', 'y');
        """
    )
    conn.commit()
    conn.close()
    return path


def _email_count(db: Path) -> int:
    check = sqlite3.connect(db)
    try:
        return check.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
    finally:
        check.close()


def test_select_returns_columns_and_rows(db):
    out = sql_readonly.run_query("SELECT id, subject FROM emails ORDER BY id", db_path=db)
    assert out["columns"] == ["id", "subject"]
    assert out["rows"][0] == [1, "Budget plan"]
    assert out["row_count"] == 3
    assert out["truncated"] is False


def test_row_cap_sets_truncated(db):
    out = sql_readonly.run_query("SELECT id FROM emails ORDER BY id", limit=2, db_path=db)
    assert out["rows"] == [[1], [2]]
    assert out["truncated"] is True


def test_limit_is_clamped_to_one_and_two_hundred(db):
    low = sql_readonly.run_query("SELECT id FROM emails ORDER BY id", limit=-5, db_path=db)
    assert low["row_count"] == 1
    high = sql_readonly.run_query("SELECT id FROM emails", limit=10_000, db_path=db)
    assert high["row_count"] == 3


def test_cell_cut(db):
    out = sql_readonly.run_query("SELECT printf('%.5000c', 'x') AS big", db_path=db)
    cell = out["rows"][0][0]
    assert cell.startswith("x" * sql_readonly.CELL_CHARS)
    assert "cut, 5000 chars" in cell


def test_total_size_cap(db, monkeypatch):
    monkeypatch.setattr(sql_readonly, "TOTAL_CHARS", 10)
    out = sql_readonly.run_query("SELECT subject FROM emails ORDER BY id", db_path=db)
    assert out["row_count"] == 1  # the first row always fits
    assert out["truncated"] is True


def test_blob_cells_are_described_not_dumped(db):
    out = sql_readonly.run_query("SELECT zeroblob(16) AS b", db_path=db)
    assert out["rows"] == [["<16 bytes>"]]


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO emails (id, message_id, subject, mailbox_name) VALUES (9, 9, 'x', 'Inbox')",
        "UPDATE emails SET subject = 'x'",
        "DELETE FROM emails",
        "CREATE TABLE t (x)",
        "DROP TABLE emails",
        "ATTACH DATABASE ':memory:' AS other",
        "PRAGMA journal_mode = DELETE",
        "PRAGMA query_only = OFF",
        "SELECT 1; DELETE FROM emails",
        "VACUUM",
    ],
)
def test_anything_but_reading_is_refused(db, sql):
    out = sql_readonly.run_query(sql, db_path=db)
    assert "error" in out
    assert _email_count(db) == 3


def test_fts_match_works_through_the_authorizer(db):
    out = sql_readonly.run_query(
        "SELECT rowid FROM emails_fts WHERE emails_fts MATCH 'budget'", db_path=db
    )
    assert "error" not in out, out
    assert out["rows"] == [[1]]


def test_sb_fold_matches_greek_without_accents(db):
    out = sql_readonly.run_query(
        "SELECT id FROM emails WHERE sb_fold(subject) LIKE '%' || sb_fold('ΠΡΟΥΠΟΛΟΓΙΣΜΟΣ') || '%'",
        db_path=db,
    )
    assert out["rows"] == [[2]]


def test_runaway_query_stops_at_the_budget(db, monkeypatch):
    monkeypatch.setattr(sql_readonly, "BUDGET_SECONDS", 0.0)
    out = sql_readonly.run_query(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n",
        db_path=db,
    )
    assert "budget" in out["error"]


def test_missing_database_is_an_error_not_a_crash(tmp_path):
    out = sql_readonly.run_query("SELECT 1", db_path=tmp_path / "absent.db")
    assert "not found" in out["error"]


def _capture_uris(monkeypatch) -> list[str]:
    seen: list[str] = []
    real = sqlite3.connect

    def spy(database, *args, **kwargs):
        seen.append(database)
        return real(database, *args, **kwargs)

    monkeypatch.setattr(sql_readonly.sqlite3, "connect", spy)
    return seen


def test_replica_opens_immutable(db, tmp_path, monkeypatch):
    stamp = tmp_path / "db-pull.stamp"
    stamp.write_text("pulled")
    monkeypatch.setattr(sql_readonly, "REPLICA_STAMP", stamp)
    seen = _capture_uris(monkeypatch)
    sql_readonly.connect_read_only(db).close()
    assert seen[0].endswith("?mode=ro&immutable=1")


def test_producer_opens_plain_read_only(db, tmp_path, monkeypatch):
    monkeypatch.setattr(sql_readonly, "REPLICA_STAMP", tmp_path / "absent.stamp")
    seen = _capture_uris(monkeypatch)
    sql_readonly.connect_read_only(db).close()
    assert seen[0].endswith("?mode=ro")


def test_describe_lists_tables_without_fts_shadows(db):
    out = sql_readonly.describe(db_path=db)
    names = {t["table"] for t in out["tables"]}
    assert {"emails", "emails_fts"} <= names
    assert not any(n.endswith(("_fts_data", "_fts_idx", "_fts_docsize", "_fts_config")) for n in names)
    emails = next(t for t in out["tables"] if t["table"] == "emails")
    assert emails["rows"] == 3


def test_describe_one_table(db):
    out = sql_readonly.describe("emails", db_path=db)
    columns = {c["name"] for c in out["columns"]}
    assert {"id", "subject", "content"} <= columns
    assert isinstance(out["indexes"], list)


def test_describe_unknown_table(db):
    assert "no table" in sql_readonly.describe("nope", db_path=db)["error"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run --frozen pytest tests/test_sql_readonly.py -q`
Expected: collection error, `ImportError: cannot import name 'sql_readonly' from 'src.store'`.

- [ ] **Step 3: Write the implementation**

Create `src/store/sql_readonly.py`:

```python
"""Read-only SQL over brain.db, for the sql_query and sql_schema MCP tools.

Every other tool returns summaries and snippets. This is how an agent counts
something the curated tools cannot express, or reads a full body. It must never
write: the connection opens read-only with query_only on, and an authorizer
allows nothing but reading. One statement per call, a time budget, and caps on
rows, cells and the whole answer keep a careless query from flooding the
caller's context.
"""

import sqlite3
import time
from pathlib import Path

from src.config import DEFAULT_DB, REPLICA_STAMP
from src.store.greek import register_sql_functions

MAX_ROWS = 200
CELL_CHARS = 4000
TOTAL_CHARS = 100_000
BUDGET_SECONDS = 10.0
_PROGRESS_STEPS = 10_000

_READ_ACTIONS = frozenset(
    {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}
)
# Pragmas that only describe the schema. FTS5 reads data_version on every MATCH,
# so denying it would break full-text search through this tool.
_READ_ONLY_PRAGMAS = frozenset(
    {
        "data_version",
        "table_info",
        "table_xinfo",
        "index_list",
        "index_info",
        "index_xinfo",
        "foreign_key_list",
    }
)
_FTS5_SHADOW_SUFFIXES = ("data", "idx", "content", "docsize", "config")


def _authorize(
    action: int, arg1: str | None, arg2: str | None, db: str | None, source: str | None
) -> int:
    if action in _READ_ACTIONS:
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_PRAGMA and arg1 in _READ_ONLY_PRAGMAS:
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def connect_read_only(db_path: Path | None = None) -> sqlite3.Connection:
    """A read-only connection with the store's SQL functions and query_only on."""
    path = Path(db_path or DEFAULT_DB)
    if not path.exists():
        raise FileNotFoundError(f"Database not found: {path}")
    uri = f"{path.resolve().as_uri()}?mode=ro"
    if REPLICA_STAMP.exists():
        # A pulled replica: nothing writes here, and a plain read-only open
        # fails with SQLITE_CANTOPEN (14). The producer must never take this
        # branch: immutable=1 skips locking on a database that is being written.
        uri += "&immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    register_sql_functions(conn)
    conn.execute("PRAGMA query_only = ON")
    return conn


def _arm_budget(conn: sqlite3.Connection) -> None:
    deadline = time.monotonic() + BUDGET_SECONDS
    conn.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, _PROGRESS_STEPS)


def _cell(value: object) -> object:
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, str) and len(value) > CELL_CHARS:
        return f"{value[:CELL_CHARS]}… [cut, {len(value)} chars]"
    return value


def run_query(sql: str, limit: int = MAX_ROWS, db_path: Path | None = None) -> dict:
    """Run one read-only statement; rows and cells capped, writes refused."""
    limit = max(1, min(int(limit), MAX_ROWS))
    try:
        conn = connect_read_only(db_path)
    except FileNotFoundError as exc:
        return {"error": str(exc)}
    _arm_budget(conn)
    conn.set_authorizer(_authorize)
    try:
        cur = conn.execute(sql)
        columns = [d[0] for d in cur.description or ()]
        fetched = cur.fetchmany(limit + 1)
    except sqlite3.OperationalError as exc:
        if str(exc) == "interrupted":
            return {
                "error": f"query exceeded the {BUDGET_SECONDS:.0f} s budget; narrow it or add a LIMIT"
            }
        return {"error": f"SQLite: {exc}"}
    except (sqlite3.DatabaseError, sqlite3.Warning) as exc:
        return {"error": f"refused: {exc}. One read-only SELECT per call."}
    finally:
        conn.close()

    truncated = len(fetched) > limit
    rows: list[list[object]] = []
    total = 0
    for raw in fetched[:limit]:
        row = [_cell(v) for v in tuple(raw)]
        size = sum(len(str(v)) for v in row)
        if rows and total + size > TOTAL_CHARS:
            truncated = True
            break
        rows.append(row)
        total += size
    return {"columns": columns, "rows": rows, "row_count": len(rows), "truncated": truncated}


def describe(table: str | None = None, db_path: Path | None = None) -> dict:
    """Every table and view with its row count, or one table's columns and indexes."""
    try:
        conn = connect_read_only(db_path)
    except FileNotFoundError as exc:
        return {"error": str(exc)}
    try:
        if table is not None:
            found = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
                (table,),
            ).fetchone()
            if found is None:
                return {"error": f"no table or view named {table!r}; call sql_schema() for the list"}
            columns = [
                dict(r)
                for r in conn.execute(
                    'SELECT name, type, "notnull" AS not_null, pk FROM pragma_table_info(?)',
                    (table,),
                )
            ]
            indexes = [
                dict(r)
                for r in conn.execute('SELECT name, "unique" FROM pragma_index_list(?)', (table,))
            ]
            return {"table": table, "columns": columns, "indexes": indexes}

        entries = conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'view') "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        virtual = [e["name"] for e in entries if (e["sql"] or "").startswith("CREATE VIRTUAL TABLE")]
        shadows = {f"{v}_{suffix}" for v in virtual for suffix in _FTS5_SHADOW_SUFFIXES}
        _arm_budget(conn)
        tables: list[dict] = []
        for entry in entries:
            name = entry["name"]
            if name in shadows:
                continue
            quoted = name.replace('"', '""')
            try:
                rows: int | None = conn.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0]
            except sqlite3.OperationalError:
                rows = None  # budget spent, or a view that cannot be counted
            tables.append({"table": name, "rows": rows})
        return {"tables": tables}
    finally:
        conn.close()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run --frozen pytest tests/test_sql_readonly.py -q`
Expected: all tests pass (25 passed, counting the 10 parametrized cases).

- [ ] **Step 5: Lint, format and type-check the new module**

Run: `uvx ruff@0.16.8 check src/store/sql_readonly.py tests/test_sql_readonly.py && uvx ruff@0.16.8 format --check src/store/sql_readonly.py tests/test_sql_readonly.py && uv run --frozen --with mypy==2.3.1 mypy --ignore-missing-imports src/store/sql_readonly.py`
Expected: `All checks passed!`, `2 files already formatted`, `Success: no issues found in 1 source file`. If ruff format reports changes, run `uvx ruff@0.16.8 format` on the two files and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/store/sql_readonly.py tests/test_sql_readonly.py
git commit -m "feat(store): read-only SQL layer with authorizer, budget and size caps

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: `sql_query` and `sql_schema` MCP tools

**Files:**

- Modify: `src/mcp_server.py` (two tools, inserted just before `if __name__ == "__main__":` at the end of the file)
- Modify: `README.md` (new subsection after `### Stats` under `## MCP tools`)
- Test: `tests/test_sql_readonly.py` (append)

**Interfaces:**

- Consumes: `sql_readonly.run_query`, `sql_readonly.describe` from Task A1; `_cap(limit, hi=200)` already in `src/mcp_server.py`.
- Produces: MCP tools `sql_query(sql: str, limit: int = 200) -> dict` and `sql_schema(table: str | None = None) -> dict`, named exactly so; Part B allowlists `mcp__second-brain__sql_query` and `mcp__second-brain__sql_schema`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_sql_readonly.py`:

```python
def test_sql_query_tool_reads_the_store(db, monkeypatch):
    from src import mcp_server

    monkeypatch.setattr(sql_readonly, "DEFAULT_DB", db)
    out = mcp_server.sql_query("SELECT COUNT(*) AS n FROM emails")
    assert out["columns"] == ["n"]
    assert out["rows"] == [[3]]


def test_sql_query_tool_clamps_limit(db, monkeypatch):
    from src import mcp_server

    monkeypatch.setattr(sql_readonly, "DEFAULT_DB", db)
    out = mcp_server.sql_query("SELECT id FROM emails ORDER BY id", limit=0)
    assert out["row_count"] == 1
    assert out["truncated"] is True


def test_sql_query_tool_refuses_writes(db, monkeypatch):
    from src import mcp_server

    monkeypatch.setattr(sql_readonly, "DEFAULT_DB", db)
    assert "error" in mcp_server.sql_query("DELETE FROM emails")
    assert _email_count(db) == 3


def test_sql_schema_tool(db, monkeypatch):
    from src import mcp_server

    monkeypatch.setattr(sql_readonly, "DEFAULT_DB", db)
    assert any(t["table"] == "emails" for t in mcp_server.sql_schema()["tables"])
    assert {c["name"] for c in mcp_server.sql_schema("emails")["columns"]} >= {"id", "subject"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run --frozen pytest tests/test_sql_readonly.py -q -k tool`
Expected: FAIL with `AttributeError: module 'src.mcp_server' has no attribute 'sql_query'`.

- [ ] **Step 3: Add the two tools**

In `src/mcp_server.py`, insert directly above the final `if __name__ == "__main__":` block:

```python
@mcp.tool()
def sql_query(sql: str, limit: int = 200) -> dict:
    """Run ONE read-only SELECT against brain.db and return the rows.

    For counts, trends and aggregates the other tools cannot express, and for the
    full text they only summarise: emails.content, teams_messages.content_text,
    attachment_content.extracted_text (join attachments.id =
    attachment_content.attachment_id) and conversation_turns.content. Call
    sql_schema first for table and column names. sb_fold(text) lowercases and
    strips Greek accents, so `WHERE sb_fold(subject) LIKE '%term%'` matches every
    spelling.

    Read-only by construction: anything but reading is refused. One statement per
    call (WITH ... SELECT is fine), a 10 s budget, at most `limit` rows (cap 200),
    each cell cut to 4,000 characters and the whole answer to 100,000;
    `truncated` says when something was left out.

    Args:
        sql: A single SELECT. Inline the literals; there are no parameters.
        limit: Maximum rows to return, 1 to 200 (default 200).
    """
    from src.store.sql_readonly import run_query

    return run_query(sql, limit=_cap(limit))


@mcp.tool()
def sql_schema(table: str | None = None) -> dict:
    """Tables of brain.db for sql_query: every table and view with its row count, or one table's columns and indexes.

    Full-text index shadow tables are left out of the list.

    Args:
        table: A table or view name for its columns and indexes; omit for the list.
    """
    from src.store.sql_readonly import describe

    return describe(table)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run --frozen pytest tests/test_sql_readonly.py tests/test_mcp_server.py -q`
Expected: all pass.

- [ ] **Step 5: Document the tools in the README**

In `README.md`, insert after the `### Stats` subsection (before `## WhatsApp`):

```markdown
### SQL (read-only)

- `sql_schema(table=None)`. Without a table, every table and view with its row count (full-text shadow tables left out); with one, its columns and indexes.
- `sql_query(sql, limit=200)`. One read-only `SELECT` (or `WITH ... SELECT`) against `brain.db`, for counts, trends and aggregates the curated tools cannot express, and for the full text they only summarise: `emails.content`, `teams_messages.content_text`, `attachment_content.extracted_text`, `conversation_turns.content`. `sb_fold(text)` folds case and Greek accents for matching.

  It cannot write: the connection is read-only with `query_only` on, and a SQLite authorizer allows nothing but reading. One statement per call, a 10 s budget, at most 200 rows, 4,000 characters per cell and 100,000 per answer; `truncated` says when something was left out. On a replica (the pull stamp exists) it opens with `immutable=1`, the only read-only open that works on a pulled copy.
```

- [ ] **Step 6: Commit**

```bash
git add src/mcp_server.py tests/test_sql_readonly.py README.md
git commit -m "feat(mcp): sql_query and sql_schema, read-only SQL over the store

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: HTTP serving mode

**Files:**

- Create: `src/mcp_http.py`
- Modify: `src/mcp_server.py` (imports at the top; replace the final `if __name__ == "__main__": mcp.run()` block)
- Modify: `README.md` (`### Run the MCP server`)
- Test: `tests/test_mcp_http.py`

**Interfaces:**

- Consumes: the module-level `mcp = MCPServer(...)` in `src/mcp_server.py`; `MCPServer.streamable_http_app(host=...)` from `mcp` 2.2.0, which turns on Host and Origin checks for loopback hosts and serves at `/mcp`.
- Produces:
  - `src/mcp_http.py`: `load_token(path: str) -> str`, `class BearerAuth(app, token)`, `build_http_app(server, token: str, host: str = "127.0.0.1") -> BearerAuth`, `LOOPBACK_HOSTS`, `MIN_TOKEN_CHARS = 32`
  - `src/mcp_server.py`: `main(argv: list[str] | None = None) -> int`
  - Command line: `python -m src.mcp_server --http 127.0.0.1:8765`, endpoint `http://127.0.0.1:8765/mcp`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_mcp_http.py`:

```python
"""Tests for the HTTP serving mode: token file, bearer middleware, loopback rule, CLI entry."""

from unittest.mock import patch

import pytest

from src import mcp_http, mcp_server

TOKEN = "t" * 40


def _drive(coro) -> None:
    """Run an ASGI call to completion without an event loop.

    The suite blocks sockets and an asyncio loop needs a socketpair, so these
    tests step the coroutine by hand. The fakes below never suspend.
    """
    try:
        coro.send(None)
    except StopIteration:
        return
    raise AssertionError("the ASGI call suspended; a fake awaited something real")


async def _receive() -> dict:
    return {"type": "http.request", "body": b"", "more_body": False}


class _Inner:
    """Stands in for the Starlette app: records the scopes that reach it."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, scope, receive, send) -> None:
        self.calls.append(scope["type"])
        if scope["type"] == "http":
            await send({"type": "http.response.start", "status": 200, "headers": []})


def _http(app, headers: list[tuple[bytes, bytes]]) -> list[dict]:
    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    _drive(app({"type": "http", "method": "POST", "path": "/mcp", "headers": headers}, _receive, send))
    return sent


def test_missing_header_gets_401():
    inner = _Inner()
    sent = _http(mcp_http.BearerAuth(inner, TOKEN), [])
    assert sent[0]["status"] == 401
    assert inner.calls == []


def test_wrong_token_gets_401():
    inner = _Inner()
    sent = _http(mcp_http.BearerAuth(inner, TOKEN), [(b"authorization", b"Bearer nope")])
    assert sent[0]["status"] == 401
    assert inner.calls == []


def test_right_token_reaches_the_app():
    inner = _Inner()
    sent = _http(mcp_http.BearerAuth(inner, TOKEN), [(b"authorization", f"Bearer {TOKEN}".encode())])
    assert inner.calls == ["http"]
    assert sent[0]["status"] == 200


def test_lifespan_passes_through_without_a_token():
    inner = _Inner()

    async def send(message: dict) -> None:
        return None

    _drive(mcp_http.BearerAuth(inner, TOKEN)({"type": "lifespan"}, _receive, send))
    assert inner.calls == ["lifespan"]


def _token_file(tmp_path, text: str, mode: int = 0o600) -> str:
    path = tmp_path / "mcp-token"
    path.write_text(text)
    path.chmod(mode)
    return str(path)


def test_token_unset():
    with pytest.raises(ValueError, match="BRAIN_MCP_TOKEN_FILE"):
        mcp_http.load_token("")


def test_token_missing_file(tmp_path):
    with pytest.raises(ValueError, match="cannot read"):
        mcp_http.load_token(str(tmp_path / "absent"))


def test_token_readable_by_others(tmp_path):
    with pytest.raises(ValueError, match="chmod 600"):
        mcp_http.load_token(_token_file(tmp_path, "a" * 64, mode=0o644))


def test_token_too_short(tmp_path):
    with pytest.raises(ValueError, match="openssl rand"):
        mcp_http.load_token(_token_file(tmp_path, "abc"))


def test_token_ok(tmp_path):
    assert mcp_http.load_token(_token_file(tmp_path, "a" * 64 + "\n")) == "a" * 64


def test_build_refuses_a_public_host():
    with pytest.raises(ValueError, match="loopback"):
        mcp_http.build_http_app(object(), TOKEN, host="0.0.0.0")


def test_build_wraps_the_streamable_app():
    app = mcp_http.build_http_app(mcp_server.mcp, TOKEN)
    assert isinstance(app, mcp_http.BearerAuth)
    assert type(app.app).__name__ == "Starlette"


def test_no_arguments_serves_stdio_as_before():
    with patch.object(mcp_server.mcp, "run") as run:
        assert mcp_server.main([]) == 0
    run.assert_called_once_with()


def test_http_without_token_file_refuses(monkeypatch, capsys):
    monkeypatch.delenv("BRAIN_MCP_TOKEN_FILE", raising=False)
    with patch("uvicorn.run") as run:
        assert mcp_server.main(["--http", "127.0.0.1:8765"]) == 2
    run.assert_not_called()
    assert "BRAIN_MCP_TOKEN_FILE" in capsys.readouterr().err


def test_http_on_a_public_host_refuses(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_MCP_TOKEN_FILE", _token_file(tmp_path, "a" * 64))
    with patch("uvicorn.run") as run:
        assert mcp_server.main(["--http", "0.0.0.0:8765"]) == 2
    run.assert_not_called()


def test_http_serves_on_loopback(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_MCP_TOKEN_FILE", _token_file(tmp_path, "a" * 64))
    with (
        patch("src.mcp_http.build_http_app", return_value="APP") as build,
        patch("uvicorn.run") as run,
    ):
        assert mcp_server.main(["--http", "127.0.0.1:8765"]) == 0
    build.assert_called_once_with(mcp_server.mcp, "a" * 64, host="127.0.0.1")
    run.assert_called_once_with("APP", host="127.0.0.1", port=8765, log_level="warning")


def test_http_accepts_bracketed_ipv6(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_MCP_TOKEN_FILE", _token_file(tmp_path, "a" * 64))
    with patch("src.mcp_http.build_http_app", return_value="APP"), patch("uvicorn.run") as run:
        assert mcp_server.main(["--http", "[::1]:8765"]) == 0
    assert run.call_args.kwargs["host"] == "::1"


@pytest.mark.parametrize("bad", ["8765", "127.0.0.1:", "127.0.0.1:http", "127.0.0.1:70000"])
def test_http_rejects_a_malformed_address(bad):
    with pytest.raises(SystemExit):
        mcp_server.main(["--http", bad])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run --frozen pytest tests/test_mcp_http.py -q`
Expected: collection error, `ImportError: cannot import name 'mcp_http' from 'src'`.

- [ ] **Step 3: Write `src/mcp_http.py`**

```python
"""Streamable-HTTP serving for the MCP server: bearer auth and the app factory.

stdio stays the default (`python -m src.mcp_server`). `--http HOST:PORT` serves
the same tools to a client that cannot spawn the server itself, such as a bot
that would otherwise load the embedding index (about 1.6 GB) once per message.
Loopback only, and every request must carry the bearer token: anything else on
the host could otherwise read the whole store.
"""

from __future__ import annotations

import hmac
import stat
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mcp.server import MCPServer
    from starlette.types import ASGIApp, Receive, Scope, Send

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
MIN_TOKEN_CHARS = 32


def load_token(path: str) -> str:
    """The bearer token from `path`: owner-only permissions, at least 32 characters."""
    if not path:
        raise ValueError("BRAIN_MCP_TOKEN_FILE is not set; --http needs a bearer token file")
    token_file = Path(path).expanduser()
    try:
        mode = token_file.stat().st_mode
        token = token_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ValueError(f"cannot read the token file {token_file}: {exc.strerror}") from exc
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise ValueError(f"{token_file} is readable by others; chmod 600 it")
    if len(token) < MIN_TOKEN_CHARS:
        raise ValueError(
            f"{token_file} holds {len(token)} characters, fewer than {MIN_TOKEN_CHARS}; "
            "write a new one with: openssl rand -hex 32"
        )
    return token


def _header(scope: Scope, name: bytes) -> bytes:
    for key, value in scope.get("headers", []):
        if key == name:
            return bytes(value)
    return b""


class BearerAuth:
    """ASGI middleware: an HTTP request without `Authorization: Bearer <token>` gets 401.

    Lifespan messages pass straight through, so the wrapped app still starts its
    session manager.
    """

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self._expected = f"Bearer {token}".encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and not hmac.compare_digest(
            _header(scope, b"authorization"), self._expected
        ):
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"text/plain; charset=utf-8"),
                        (b"www-authenticate", b"Bearer"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": b"unauthorized\n"})
            return
        await self.app(scope, receive, send)


def build_http_app(server: MCPServer, token: str, host: str = "127.0.0.1") -> BearerAuth:
    """The streamable-HTTP app for `server`, behind bearer auth, for a loopback host."""
    if host not in LOOPBACK_HOSTS:
        raise ValueError(f"refusing to serve on {host!r}: HTTP mode binds loopback only")
    # A loopback host also turns on the SDK's DNS-rebinding protection (Host and
    # Origin checks) in streamable_http_app.
    return BearerAuth(server.streamable_http_app(host=host), token)
```

- [ ] **Step 4: Add `main()` to `src/mcp_server.py`**

Change the imports at the top of `src/mcp_server.py` from:

```python
import re
from datetime import UTC
```

to:

```python
import argparse
import os
import re
import sys
from datetime import UTC
```

Replace the final block:

```python
if __name__ == "__main__":
    mcp.run()
```

with:

```python
def _host_port(value: str) -> tuple[str, int]:
    """argparse type for --http: HOST:PORT, with an IPv6 host in brackets ([::1]:8765)."""
    host, sep, port = value.rpartition(":")
    host = host.strip("[]")
    if not sep or not host or not port.isdigit() or not 0 < int(port) < 65536:
        raise argparse.ArgumentTypeError(f"expected HOST:PORT, got {value!r}")
    return host, int(port)


def main(argv: list[str] | None = None) -> int:
    """stdio by default, exactly as before; --http HOST:PORT serves streamable HTTP."""
    parser = argparse.ArgumentParser(prog="python -m src.mcp_server")
    parser.add_argument(
        "--http",
        type=_host_port,
        metavar="HOST:PORT",
        help="serve streamable HTTP on a loopback HOST:PORT instead of stdio; "
        "needs BRAIN_MCP_TOKEN_FILE",
    )
    args = parser.parse_args(argv)
    if args.http is None:
        mcp.run()
        return 0

    from src.mcp_http import build_http_app, load_token

    host, port = args.http
    try:
        token = load_token(os.environ.get("BRAIN_MCP_TOKEN_FILE", ""))
        app = build_http_app(mcp, token, host=host)
    except ValueError as exc:
        print(f"second-brain MCP: {exc}", file=sys.stderr)
        return 2

    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run --frozen pytest tests/test_mcp_http.py tests/test_mcp_server.py tests/test_sql_readonly.py -q`
Expected: all pass.

- [ ] **Step 6: Prove stdio still starts**

Run: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' | timeout 20 uv run --frozen python -m src.mcp_server | head -c 300`
Expected: a JSON-RPC line containing `"serverInfo"` and `"second-brain"`. On macOS without GNU `timeout`, use `gtimeout`, or end the command with Ctrl-C once the line appears.

- [ ] **Step 7: Document HTTP mode in the README**

In `README.md`, under `### Run the MCP server`, after the paragraph that starts with "`run_mcp.sh` auto-detects the venv", add:

````markdown
To serve it over HTTP instead, for a client that cannot spawn it (one process then holds the embedding index for every request):

```bash
umask 077 && openssl rand -hex 32 > ~/.config/second-brain/mcp-token
BRAIN_MCP_TOKEN_FILE=~/.config/second-brain/mcp-token python -m src.mcp_server --http 127.0.0.1:8765
```

The endpoint is `http://127.0.0.1:8765/mcp`. Loopback only, and every request needs `Authorization: Bearer <token>`: the server refuses to start with a non-loopback host, a token file others can read, or a token under 32 characters. On the producer, run it with `BRAIN_ROLE=replica` so the one MCP write path (the `sharepoint_index` refetch) stays off; `docs/DEPLOY.md` section 9 has the systemd setup.
````

- [ ] **Step 8: Lint, format, type-check**

Run: `uvx ruff@0.16.8 check . && uvx ruff@0.16.8 format --check . && uv run --frozen --with mypy==2.3.1 --with types-requests==2.33.0.20260906 mypy --ignore-missing-imports --show-error-codes src/ scripts/`
Expected: no findings. Fix any finding in the files this task touched before committing.

- [ ] **Step 9: Commit**

```bash
git add src/mcp_http.py src/mcp_server.py tests/test_mcp_http.py README.md
git commit -m "feat(mcp): --http serves the tools on loopback behind a bearer token

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task A4: Producer wrapper and deployment docs

**Files:**

- Create: `scripts/wrappers/systemd/sb-mcp.sh`
- Modify: `scripts/wrappers/README.md` (Layout table count: `14` to `15`)
- Modify: `docs/DEPLOY.md` (section 9: new subsection at its end)

**Interfaces:**

- Consumes: `python -m src.mcp_server --http` from Task A3.
- Produces: the wrapper `~/.local/bin/sb-mcp.sh` on the producer (installed in Task A5); env knobs `BRAIN_MCP_TOKEN_FILE` (default `~/.config/second-brain/mcp-token`) and `SB_MCP_LISTEN` (default `127.0.0.1:8765`); systemd unit name `sb-mcp.service`.

The repo archives wrappers, not unit files or shims (`scripts/wrappers/README.md`, "What is deliberately absent"). The spec's "unit file archived at scripts/wrappers/systemd/sb-mcp.service" is realised the repo's way: the wrapper is archived and the unit text lives in `docs/DEPLOY.md`.

- [ ] **Step 1: Write the wrapper**

Create `scripts/wrappers/systemd/sb-mcp.sh`:

```bash
#!/bin/bash
# second-brain MCP over streamable HTTP, for clients that cannot spawn the stdio
# server themselves (the Telegram brain bot). Long-running: systemd keeps it up
# (Restart=always), so this wrapper only sets the scene and execs.
#
# Loopback only, bearer token required: src/mcp_http.py refuses anything else.
# BRAIN_ROLE=replica turns off the one MCP write path (the sharepoint_index
# refetch), although the master database sits next to this process.

set -uo pipefail

[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null || true

PROJECT="$HOME/SourceCode/plessas-second-brain"
PYTHON="$HOME/.venvs/second-brain/bin/python"
export BRAIN_ROLE=replica
export BRAIN_MCP_TOKEN_FILE="${BRAIN_MCP_TOKEN_FILE:-$HOME/.config/second-brain/mcp-token}"

cd "$PROJECT" || exit 1
exec "$PYTHON" -m src.mcp_server --http "${SB_MCP_LISTEN:-127.0.0.1:8765}"
```

Then: `chmod +x scripts/wrappers/systemd/sb-mcp.sh`

- [ ] **Step 2: Syntax-check it the way CI does**

Run: `bash -n scripts/wrappers/systemd/sb-mcp.sh && echo ok`
Expected: `ok`

- [ ] **Step 3: Update the wrappers README count**

In `scripts/wrappers/README.md`, in the Layout table, change the `systemd/` row's count from `14` to `15`:

```markdown
| `systemd/` | VPS | `systemctl --user` timers | 15 |
```

- [ ] **Step 4: Document the producer setup**

In `docs/DEPLOY.md`, at the end of `## 9. Serve to Claude Code` (before `## 10. Files are inputs`), add:

````markdown
### Over HTTP: one process for every client

Each stdio client spawns its own server, and each server loads the embedding
index (about 1.6 GB) on its first semantic query. A client that cannot spawn the
server, or would spawn it per request, should use the HTTP mode instead.

```bash
# 1. A token only the owner can read
umask 077 && mkdir -p ~/.config/second-brain && openssl rand -hex 32 > ~/.config/second-brain/mcp-token

# 2. The wrapper (archived at scripts/wrappers/systemd/sb-mcp.sh)
install -m 755 scripts/wrappers/systemd/sb-mcp.sh ~/.local/bin/sb-mcp.sh
```

`~/scripts/run-sb-mcp.sh` is the host-local shim, like the other `run-sb-*.sh`:
it sets `PATH`, sources the Vertex environment file (query embeddings need it),
and execs `~/.local/bin/sb-mcp.sh`.

```ini
# ~/.config/systemd/user/sb-mcp.service
[Unit]
Description=second-brain MCP over HTTP (loopback, bearer token)
After=network-online.target
OnFailure=notify-failure@%n.service

[Service]
Type=simple
ExecStart=%h/scripts/run-sb-mcp.sh
Restart=always
RestartSec=10
# One index is about 1.6 GB; a reload after embeddings.npz changes briefly holds two.
MemoryMax=4G
NoNewPrivileges=yes

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now sb-mcp.service
# Without the token: 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8765/mcp
```

A client authenticates with `Authorization: Bearer <token>`; for Claude Code,
an `http` entry with that header in its MCP configuration.
````

- [ ] **Step 5: Run the CI wrapper parse and the PII gauntlet**

Run: `for f in scripts/wrappers/*/*.sh; do bash -n "$f" || echo "FAIL $f"; done; bash scripts/pii-gauntlet.sh | tail -2`
Expected: no `FAIL` line, then `=== GAUNTLET PASS ===`.

- [ ] **Step 6: Commit**

```bash
git add scripts/wrappers/systemd/sb-mcp.sh scripts/wrappers/README.md docs/DEPLOY.md
git commit -m "ops: sb-mcp wrapper and the producer setup for HTTP mode

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task A5: Ship and deploy on the producer

**Files:** none in the repo. Host changes on the VPS: `~/.config/second-brain/mcp-token`, `~/.local/bin/sb-mcp.sh`, `~/scripts/run-sb-mcp.sh`, `~/.config/systemd/user/sb-mcp.service`.

**Interfaces:**

- Consumes: Tasks A1 to A4 merged to `master`.
- Produces: `http://127.0.0.1:8765/mcp` on the VPS, live, with the token at `~/.config/second-brain/mcp-token`. Part B's `BRIDGE_BRAIN_MCP_URL` and `BRAIN_MCP_TOKEN_FILE` point here.

- [ ] **Step 1: Full local gate**

Run: `uv run --frozen pytest -q && uvx ruff@0.16.8 check . && uvx ruff@0.16.8 format --check . && uv run --frozen --with mypy==2.3.1 --with types-requests==2.33.0.20260906 mypy --ignore-missing-imports --show-error-codes src/ scripts/ && bash scripts/pii-gauntlet.sh | tail -1`
Expected: every suite green, `=== GAUNTLET PASS ===`.

- [ ] **Step 2: Owner go, then push and open the PR**

Stop and ask the owner to approve publishing (public repo). Then push and open the PR. If SSH to GitHub is refused, push over HTTPS with the `gh` credential helper:

```bash
gh auth setup-git
git push -u https://github.com/weirdapps/plessas-second-brain.git feat/brain-mcp-http
gh pr create --repo weirdapps/plessas-second-brain --base master --head feat/brain-mcp-http \
  --title "feat(mcp): HTTP mode behind a bearer token, read-only sql_query and sql_schema" \
  --body "Part A of the brain-bot plan. Loopback HTTP mode for the MCP server (bearer token, 401 otherwise), read-only SQL tools (authorizer, 10 s budget, row, cell and total caps), and the sb-mcp wrapper with its DEPLOY.md setup. stdio unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Wait for the five CI jobs (`lint`, `test`, `types`, `pii-gauntlet`, `wrappers`) to pass, then merge with the owner's go.

- [ ] **Step 3: Bring the producer up to date**

The hourly repo auto-update pulls merged code. To deploy now instead:

Run: `ssh vps 'cd ~/SourceCode/plessas-second-brain && git status --short | head -3; git pull --ff-only && git log --oneline -1'`
Expected: a clean tree before the pull, then the merge commit at HEAD. If the tree is dirty, stop and find out why before pulling.

- [ ] **Step 4: Token, wrapper, shim, unit**

```bash
ssh vps 'bash -s' <<'EOF'
set -e
umask 077
mkdir -p ~/.config/second-brain
[ -s ~/.config/second-brain/mcp-token ] || openssl rand -hex 32 > ~/.config/second-brain/mcp-token
install -m 755 ~/SourceCode/plessas-second-brain/scripts/wrappers/systemd/sb-mcp.sh ~/.local/bin/sb-mcp.sh
# Shim: the documented pattern (README, WhatsApp "Deploy"): a copy of an existing
# sb-* shim, so PATH (outlook-cli for outlook_live_search) and the sourced
# environment files (Vertex for query embeddings) match what already works.
sed 's|sb-teams-sync\.sh|sb-mcp.sh|g' ~/scripts/run-sb-teams-sync.sh > ~/scripts/run-sb-mcp.sh
chmod 755 ~/scripts/run-sb-mcp.sh
# Structure only, never the whole file (shims hold addresses): one exec of the
# new wrapper, and no timeout or flock that would end a long-running server.
grep -nE '^[[:space:]]*(exec|timeout|flock)' ~/scripts/run-sb-mcp.sh
cat > ~/.config/systemd/user/sb-mcp.service <<'UNIT'
[Unit]
Description=second-brain MCP over HTTP (loopback, bearer token)
After=network-online.target
OnFailure=notify-failure@%n.service

[Service]
Type=simple
ExecStart=%h/scripts/run-sb-mcp.sh
Restart=always
RestartSec=10
MemoryMax=4G
NoNewPrivileges=yes

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now sb-mcp.service
sleep 5
systemctl --user is-active sb-mcp.service
stat -c '%a %s' ~/.config/second-brain/mcp-token
EOF
```

Expected: the `grep` prints exactly one line, an `exec` of `sb-mcp.sh` (if it also prints a `timeout` or `flock` line, remove that line from the host-local shim before going on), then `active`, then `600 65` (64 hex characters and a newline).

- [ ] **Step 5: Probe without and with the token**

```bash
ssh vps 'bash -s' <<'EOF'
echo "no token: $(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8765/mcp)"
cd ~/SourceCode/plessas-second-brain && ~/.venvs/second-brain/bin/python - <<'PY'
import asyncio, pathlib, time
from mcp import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

TOKEN = pathlib.Path("~/.config/second-brain/mcp-token").expanduser().read_text().strip()

async def main():
    async with create_mcp_http_client(headers={"Authorization": f"Bearer {TOKEN}"}) as http:
        async with streamable_http_client("http://127.0.0.1:8765/mcp", http_client=http) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                tools = sorted(t.name for t in (await s.list_tools()).tools)
                print("tools:", len(tools), "sql_query" in tools, "sql_schema" in tools)
                t0 = time.monotonic()
                res = await s.call_tool(
                    "search_emails", {"query": "budget", "search_type": "semantic", "limit": 3}
                )
                print("semantic call ok:", not res.isError, f"{time.monotonic() - t0:.1f}s")
                res = await s.call_tool("sql_query", {"sql": "SELECT COUNT(*) AS n FROM emails"})
                print("sql ok:", not res.isError)
                res = await s.call_tool("outlook_live_search", {"since_minutes": 30})
                text = " ".join(getattr(c, "text", "") for c in res.content)
                print("outlook-cli found:", "OUTLOOK_CLI_PATH" not in text)

asyncio.run(main())
PY
systemctl --user show sb-mcp.service -p MemoryCurrent
EOF
```

Expected: `no token: 401`, then `tools: 27 True True`, `semantic call ok: True` (the first semantic call loads the index and can take tens of seconds), `sql ok: True`, `outlook-cli found: True` (an authentication error from Microsoft 365 is acceptable here: it proves the CLI ran; the not-found message names `OUTLOOK_CLI_PATH`), and `MemoryCurrent` around 1.7 to 2.0 GB. The client calls are the `mcp` 2.2.0 API (`create_mcp_http_client` carries the header, `streamable_http_client` yields a read and a write stream); if the producer's venv pins another `mcp`, check `dir(mcp.client.streamable_http)` there first.

- [ ] **Step 6: Record the result**

Report to the owner: the PR link, the merge commit, the probe output above, and the service's memory. Note in the report that the estate page shows a new unit only after about two collector passes.
