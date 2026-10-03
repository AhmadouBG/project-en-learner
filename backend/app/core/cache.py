# backend/app/core/cache.py
"""
SQLite-backed cache using aiosqlite.

Schema:
    cache(key TEXT PK, value TEXT, created INTEGER, ttl INTEGER)

All operations are async. The connection is opened once in lifespan and shared
via a module-level handle. Heavy callers (Phase 2+) just call get/set/delete.
"""
from __future__ import annotations

import json
import time
from typing import Any

import aiosqlite
import structlog

logger = structlog.get_logger(__name__)

# Module-level connection — set by open_cache() called from lifespan
_db: aiosqlite.Connection | None = None


async def open_cache(db_path: str) -> None:
    """Open the SQLite connection and create the schema.  Call from lifespan."""
    global _db
    _db = await aiosqlite.connect(db_path)
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA journal_mode=WAL")
    await _db.execute("PRAGMA synchronous=NORMAL")
    await _db.executescript(
        """
        CREATE TABLE IF NOT EXISTS cache (
            key     TEXT PRIMARY KEY,
            value   TEXT NOT NULL,
            created INTEGER NOT NULL,
            ttl     INTEGER NOT NULL DEFAULT 86400
        );
        CREATE INDEX IF NOT EXISTS idx_cache_created ON cache(created);
        """
    )
    await _db.commit()
    logger.info("cache.open", db=db_path)


async def close_cache() -> None:
    """Close the SQLite connection.  Call from lifespan teardown."""
    global _db
    if _db is not None:
        await _db.close()
        _db = None
        logger.info("cache.close")


async def cache_get(key: str) -> Any | None:
    """
    Return the cached value for *key* or None if missing / expired.
    Value is deserialized from JSON.
    """
    if _db is None:
        return None
    now = int(time.time())
    async with _db.execute(
        "SELECT value, created, ttl FROM cache WHERE key = ?", (key,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    if now - row["created"] > row["ttl"]:
        await cache_delete(key)
        return None
    return json.loads(row["value"])


async def cache_set(key: str, value: Any, ttl: int = 86400) -> None:
    """Store *value* (JSON-serialized) under *key* with the given TTL in seconds."""
    if _db is None:
        return
    await _db.execute(
        "INSERT OR REPLACE INTO cache(key, value, created, ttl) VALUES (?,?,?,?)",
        (key, json.dumps(value, default=str), int(time.time()), ttl),
    )
    await _db.commit()


async def cache_delete(key: str) -> None:
    """Remove a single key from the cache."""
    if _db is None:
        return
    await _db.execute("DELETE FROM cache WHERE key = ?", (key,))
    await _db.commit()


async def cache_stats() -> dict[str, int]:
    """Return row count and approximate byte size of the cache table."""
    if _db is None:
        return {"rows": 0, "bytes": 0}
    async with _db.execute("SELECT COUNT(*) AS n, SUM(LENGTH(value)) AS b FROM cache") as cur:
        row = await cur.fetchone()
    return {"rows": row["n"] or 0, "bytes": row["b"] or 0}
