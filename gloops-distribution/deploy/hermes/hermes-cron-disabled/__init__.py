"""Inert cron provider for the bounded Paperclip execution profile.

The profile is event-driven.  It must expose Hermes' API boundary without
starting the built-in 60-second cron ticker.  This provider deliberately has
no firing or reconciliation implementation; it waits only for the gateway's
shutdown event.
"""

from cron.scheduler_provider import CronScheduler


class DisabledCronScheduler(CronScheduler):
    @property
    def name(self) -> str:
        return "disabled"

    def start(self, stop_event, *, adapters=None, loop=None, interval=60) -> None:
        del adapters, loop, interval
        stop_event.wait()
