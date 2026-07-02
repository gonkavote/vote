"""Async ClickHouse client — adapted from gonka tracker/backend/src/backend/ch.py.

Backend writes (proposals, comments, users) and reads (everything). Indexer also
writes (votes, vote_snapshots) but uses the native protocol on a different port.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional, Sequence

import clickhouse_connect
from clickhouse_connect.driver.asyncclient import AsyncClient

logger = logging.getLogger(__name__)


class CHClient:
    def __init__(
        self,
        host: str,
        port: int = 8123,
        database: str = "gonka_vote",
        username: str = "default",
        password: str = "",
    ):
        self._host = host
        self._port = port
        self._database = database
        self._username = username
        self._password = password
        self._client: Optional[AsyncClient] = None
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        if self._client is not None:
            return
        async with self._lock:
            if self._client is not None:
                return
            self._client = await clickhouse_connect.get_async_client(
                host=self._host,
                port=self._port,
                database=self._database,
                username=self._username,
                password=self._password,
                compress=True,
            )
            logger.info(
                f"Connected to ClickHouse at {self._host}:{self._port}/{self._database}"
            )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None

    async def _ensure(self) -> AsyncClient:
        if self._client is None:
            await self.connect()
        assert self._client is not None
        return self._client

    async def query_rows(
        self, sql: str, parameters: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        client = await self._ensure()
        result = await client.query(sql, parameters=parameters)
        cols = result.column_names
        return [dict(zip(cols, row)) for row in result.result_rows]

    async def query_one(
        self, sql: str, parameters: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        rows = await self.query_rows(sql, parameters)
        return rows[0] if rows else None

    async def query_scalar(
        self, sql: str, parameters: Optional[Dict[str, Any]] = None
    ) -> Any:
        client = await self._ensure()
        result = await client.query(sql, parameters=parameters)
        if not result.result_rows:
            return None
        return result.result_rows[0][0]

    async def insert(
        self,
        table: str,
        column_names: Sequence[str],
        data: Sequence[Sequence[Any]],
    ) -> None:
        client = await self._ensure()
        await client.insert(table, list(data), column_names=list(column_names))

    async def command(
        self, sql: str, parameters: Optional[Dict[str, Any]] = None
    ) -> None:
        """Execute a non-query statement (e.g. ALTER ... UPDATE mutation)."""
        client = await self._ensure()
        await client.command(sql, parameters=parameters)

    async def ping(self) -> bool:
        try:
            client = await self._ensure()
            await client.query("SELECT 1")
            return True
        except Exception as e:
            logger.error(f"CH ping failed: {e}")
            return False
