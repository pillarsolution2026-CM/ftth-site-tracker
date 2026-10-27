"""Drawing extents accumulated from extracted entities (not from the DXF header)."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from cad_worker.domain.model import Xyz


@dataclass(frozen=True, slots=True)
class Extents:
    min_x: float
    min_y: float
    max_x: float
    max_y: float


class ExtentsAccumulator:
    def __init__(self) -> None:
        self._min_x = self._min_y = float("inf")
        self._max_x = self._max_y = float("-inf")

    def add(self, x: float, y: float) -> None:
        self._min_x = min(self._min_x, x)
        self._min_y = min(self._min_y, y)
        self._max_x = max(self._max_x, x)
        self._max_y = max(self._max_y, y)

    def add_points(self, points: Iterable[Xyz]) -> None:
        for x, y, _ in points:
            self.add(x, y)

    def result(self) -> Extents | None:
        if self._min_x > self._max_x:
            return None
        return Extents(self._min_x, self._min_y, self._max_x, self._max_y)
