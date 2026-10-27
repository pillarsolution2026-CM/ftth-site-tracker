"""Entry point: `python -m cad_worker [--health]`."""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
from types import FrameType

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.adapters.libredwg_converter import LibreDwgWasmConverter, default_script
from cad_worker.adapters.postgres_repo import PostgresCadRepository
from cad_worker.adapters.queue import RedisJobBroker
from cad_worker.adapters.settings import Settings
from cad_worker.adapters.storage import build_storage
from cad_worker.application.consumer import Consumer
from cad_worker.application.health import check_health
from cad_worker.application.import_job import ImportDeps


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cad_worker")
    parser.add_argument("--health", action="store_true", help="print health JSON and exit")
    args = parser.parse_args(argv)

    if args.health:
        print(json.dumps(check_health().to_dict()))
        return 0

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings()
    deps = ImportDeps(
        repo=PostgresCadRepository(settings.database_url),
        storage=build_storage(settings),
        converter=LibreDwgWasmConverter(
            default_script(),
            timeout_s=settings.converter_timeout_s,
            max_old_space_mb=settings.converter_max_old_space_mb,
        ),
        reader=EzdxfReader(),
    )
    broker = RedisJobBroker.from_url(settings.redis_url, settings.worker_id)
    stop = False

    def _stop(_signum: int, _frame: FrameType | None) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    Consumer(broker, deps, settings.worker_id).run(lambda: stop)
    return 0


if __name__ == "__main__":
    sys.exit(main())
