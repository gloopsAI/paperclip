#!/usr/bin/env python3
"""Network-free proof that /v1/runs cancellation contains run-owned work."""

from __future__ import annotations

import argparse
import asyncio
import threading
from types import SimpleNamespace


def check_exact_worker_kill() -> None:
    from tools.interrupt import register_interrupt_killer, set_interrupt

    ready = threading.Event()
    release = threading.Event()
    killed = threading.Event()
    target_tid: list[int] = []

    def worker() -> None:
        target_tid.append(threading.current_thread().ident or 0)
        with register_interrupt_killer(killed.set):
            ready.set()
            release.wait(timeout=3)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    assert ready.wait(timeout=1), "worker did not register its process killer"
    try:
        set_interrupt(True, target_tid[0])
        assert killed.wait(timeout=0.1), "hard interrupt returned before exact process kill"
    finally:
        set_interrupt(False, target_tid[0])
        release.set()
        thread.join(timeout=1)
    assert not thread.is_alive(), "worker did not drain"


def check_repeated_stop_reuses_reaper() -> None:
    import gateway.run as gateway_run
    from gateway.platforms.api_server import _reap_disconnected_agent_processes

    started = threading.Event()
    release = threading.Event()
    calls: list[bool] = []
    agent = SimpleNamespace(
        _gateway_turn_process_task_id="containment-repeat-stop",
        _gateway_turn_process_baseline=set(),
    )

    def blocked_reap(*_args: object, **_kwargs: object) -> None:
        calls.append(True)
        started.set()
        release.wait(timeout=3)

    original = gateway_run._reap_gateway_turn_processes
    gateway_run._reap_gateway_turn_processes = blocked_reap
    first = None
    try:
        first = _reap_disconnected_agent_processes(agent)
        assert first is not None
        assert started.wait(timeout=1), "first process reaper did not start"
        second = _reap_disconnected_agent_processes(agent)
        assert second is first, "repeated stop replaced the live process reaper"
        assert len(calls) == 1, "repeated stop spawned duplicate process reapers"
    finally:
        release.set()
        if first is not None:
            first.join(timeout=1)
        gateway_run._reap_gateway_turn_processes = original
    assert first is not None and not first.is_alive(), "process reaper did not drain"


async def check_api_terminal_waits_for_worker() -> None:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter

    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    app = web.Application()
    app.router.add_post("/v1/runs", adapter._handle_runs)
    app.router.add_get("/v1/runs/{run_id}", adapter._handle_get_run)
    app.router.add_post("/v1/runs/{run_id}/stop", adapter._handle_stop_run)

    run_started = threading.Event()
    interrupted = threading.Event()
    worker_started = threading.Event()
    worker_can_finish = threading.Event()

    class Agent:
        def __init__(self) -> None:
            self._tool_worker_threads: set[int] = set()
            self._tool_worker_threads_lock = threading.Lock()
            self.session_prompt_tokens = 0
            self.session_completion_tokens = 0
            self.session_total_tokens = 0
            self._gloops_run_evidence = None

        def interrupt(self, _message: str | None = None) -> None:
            interrupted.set()

        def run_conversation(self, **_kwargs: object) -> dict[str, str]:
            run_started.set()
            interrupted.wait(timeout=10)

            def abandoned_worker() -> None:
                tid = threading.current_thread().ident or 0
                with self._tool_worker_threads_lock:
                    self._tool_worker_threads.add(tid)
                worker_started.set()
                worker_can_finish.wait(timeout=10)
                with self._tool_worker_threads_lock:
                    self._tool_worker_threads.discard(tid)

            threading.Thread(target=abandoned_worker, daemon=True).start()
            assert worker_started.wait(timeout=3)
            return {"final_response": "wrapper returned before tool worker"}

    agent = Agent()
    adapter._create_agent = lambda **_kwargs: agent  # type: ignore[method-assign]

    async with TestClient(TestServer(app)) as client:
        response = await client.post("/v1/runs", json={"input": "contain me"})
        assert response.status == 202
        run_id = (await response.json())["run_id"]
        assert run_started.wait(timeout=3), "run did not start"

        stop = await client.post(f"/v1/runs/{run_id}/stop")
        assert stop.status == 200
        assert worker_started.wait(timeout=3), "abandoned worker was not created"
        await asyncio.sleep(0.1)

        status = adapter._run_statuses[run_id]["status"]
        assert status == "stopping", f"false terminal status while worker live: {status}"
        assert run_id in adapter._active_run_tasks, "run ownership cleared before worker exit"

        worker_can_finish.set()
        for _ in range(40):
            if run_id not in adapter._active_run_tasks:
                break
            await asyncio.sleep(0.05)
        assert run_id not in adapter._active_run_tasks, "run did not settle after worker exit"
        assert adapter._run_statuses[run_id]["status"] == "cancelled"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=("interrupt", "api", "all"), default="all")
    args = parser.parse_args()
    if args.case in {"interrupt", "all"}:
        check_exact_worker_kill()
    if args.case in {"api", "all"}:
        asyncio.run(check_api_terminal_waits_for_worker())
        check_repeated_stop_reuses_reaper()
    print("hermes cancellation containment: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
