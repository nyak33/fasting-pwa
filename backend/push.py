# Version History
# v1.0 - Web Push send helper with automatic cleanup of expired subscriptions.

from __future__ import annotations

import json

from pywebpush import WebPushException, webpush

from db import remove_subscription


def send_push_batch(subscriptions: list[dict], payload: dict, settings) -> dict:
    success = 0
    failed = 0

    for item in subscriptions:
        subscription_info = {
            "endpoint": item["endpoint"],
            "keys": {
                "p256dh": item["p256dh"],
                "auth": item["auth"],
            },
        }

        try:
            webpush(
                subscription_info=subscription_info,
                data=json.dumps(payload),
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": settings.vapid_subject},
                ttl=300,
            )
            success += 1
        except WebPushException as exc:
            failed += 1
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):
                remove_subscription(item["endpoint"])

    return {"success": success, "failed": failed}
