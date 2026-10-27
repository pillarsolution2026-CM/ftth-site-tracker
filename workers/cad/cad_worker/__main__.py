"""Entry point: `python -m cad_worker [--health]`."""

from __future__ import annotations

import argparse
import json
import signal
import sys
from types import FrameType

from cad_worker.adapters.queue import RedisJobQueue
from cad_worker.adapters.settings import Settings
from cad_worker.application.consumer import run_loop
from cad_worker.application.health import check_health


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cad_worker")
    parser.add_argument("--health", action="store_true", help="print health JSON and exit")
    args = parser.parse_args(argv)

    if args.health:
        print(json.dumps(check_health().to_dict()))
        return 0

    queue = RedisJobQueue.from_url(Settings().redis_url)
    stop = False

    def _stop(_signum: int, _frame: FrameType | None) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    run_loop(queue, lambda: stop)
    return 0


if __name__ == "__main__":
    sys.exit(main())
