from __future__ import annotations

from typing import Any

from tracer._tracer import Database, IpcRecord


def patch_message_queue(db: Database) -> None:
    try:
        from vllm.distributed.device_communicators.shm_broadcast import (
            MessageQueue,
        )
    except ImportError:
        return

    original_init = MessageQueue.__init__

    def _traced_init(self_obj: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self_obj, *args, **kwargs)
        buffer = getattr(self_obj, "buffer", None)
        if buffer is None:
            return
        shm = getattr(buffer, "shared_memory", None)
        if shm is None:
            return
        name = shm.name

        obj_idx = getattr(self_obj, "__tr_idx", -1)
        db.add_ipc(IpcRecord(name=name, obj_idx=obj_idx))

    MessageQueue.__init__ = _traced_init
