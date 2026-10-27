"""Aggregates CadWarnings by (code, params)."""

from __future__ import annotations

from cad_worker.domain.model import CadWarning, WarningCode

Param = str | int | float


class WarningCollector:
    def __init__(self) -> None:
        self._items: dict[tuple[str, tuple[tuple[str, Param], ...]], CadWarning] = {}

    def add(self, code: WarningCode, count: int = 1, **params: Param) -> None:
        key = (code, tuple(sorted(params.items())))
        current = self._items.get(key)
        total = (current.count if current else 0) + count
        self._items[key] = CadWarning(code, total, dict(params) or None)

    def result(self) -> list[CadWarning]:
        return sorted(self._items.values(), key=lambda w: (w.code, str(w.params)))
