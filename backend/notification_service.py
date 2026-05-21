# notification_service.py
# จัดการการแจ้งเตือนผ่าน LINE Messaging API สำหรับ PostureGuard AI
#
# หน้าที่หลัก:
# - อ่านค่า LINE จาก backend/.env
# - ส่ง LINE push message
# - รับและตรวจสอบ webhook signature
# - ดึง LINE userId จาก webhook event
# - บันทึก LINE_USER_ID กลับลง .env
# - ป้องกันการส่งแจ้งเตือนซ้ำถี่เกินไป
#
# หมายเหตุ:
# - ไฟล์นี้ไม่ยุ่งกับ logic CVA/FSA
# - ไฟล์นี้ไม่เรียกใช้งาน MediaPipe/OpenCV
# - ไฟล์นี้ออกแบบให้เรียกจาก thread แยกได้
# - ถ้าส่ง LINE ล้มเหลว จะคืนค่า error แต่ไม่ crash backend

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


try:
    import config
except Exception:
    config = None


# ========================
# Constants
# ========================

ENV_PATH = Path(__file__).resolve().parent / ".env"
LINE_PUSH_MESSAGE_URL = "https://api.line.me/v2/bot/message/push"

DEFAULT_ALERT_REPEAT_INTERVAL = 180.0
DEFAULT_HTTP_TIMEOUT_SECONDS = 5.0


# ========================
# Result Model
# ========================

@dataclass
class NotificationResult:
    """ผลลัพธ์จากการส่ง notification"""

    success: bool
    skipped: bool
    message: str
    status_code: Optional[int] = None
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "skipped": self.skipped,
            "message": self.message,
            "status_code": self.status_code,
            "detail": self.detail,
        }


# ========================
# LINE Notification Service
# ========================

class LineNotificationService:
    """
    Service สำหรับส่ง LINE notification

    ใช้แนวคิด:
    - classifier.py เป็นตัวตัดสินว่า alert ควรเกิดเมื่อไร
    - service นี้ทำหน้าที่ส่งข้อความและกัน duplicate spam อีกชั้น
    """

    def __init__(self, env_path: Path = ENV_PATH) -> None:
        self.env_path = env_path
        self._lock = threading.Lock()

        # key เช่น:
        # session:12:forward_head
        # session:12:rounded_shoulder
        # session:12:multiple
        self._last_sent_at: dict[str, float] = {}

        self.line_enabled: bool = False
        self.channel_access_token: str = ""
        self.channel_secret: str = ""
        self.line_user_id: str = ""

        self.reload()

    # ========================
    # Environment
    # ========================

    def reload(self) -> None:
        """โหลดค่า config ใหม่จาก .env และ environment variables"""

        env = self._load_env_file()

        self.line_enabled = self._to_bool(
            self._get_env_value(env, "LINE_ENABLED", "false")
        )

        self.channel_access_token = self._get_env_value(
            env,
            "LINE_CHANNEL_ACCESS_TOKEN",
            "",
        )

        self.channel_secret = self._get_env_value(
            env,
            "LINE_CHANNEL_SECRET",
            "",
        )

        self.line_user_id = self._get_env_value(
            env,
            "LINE_USER_ID",
            "",
        )

    def _load_env_file(self) -> dict[str, str]:
        """
        อ่าน backend/.env แบบไม่ต้องติดตั้ง python-dotenv เพิ่ม

        รูปแบบที่รองรับ:
        LINE_ENABLED=true
        LINE_CHANNEL_ACCESS_TOKEN=...
        LINE_CHANNEL_SECRET=...
        LINE_USER_ID=...
        """

        env: dict[str, str] = {}

        if not self.env_path.exists():
            return env

        try:
            for raw_line in self.env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()

                if not line or line.startswith("#"):
                    continue

                if "=" not in line:
                    continue

                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")

                if key:
                    env[key] = value

        except Exception as err:
            print(f"[LINE] Cannot read .env: {err}")

        return env

    def _get_env_value(
        self,
        env: dict[str, str],
        key: str,
        default: str = "",
    ) -> str:
        """
        ลำดับการอ่านค่า:
        1. environment variable จริงของระบบ
        2. backend/.env
        3. default
        """

        return os.getenv(key) or env.get(key, default)

    @staticmethod
    def _to_bool(value: str) -> bool:
        return str(value).strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
            "on",
        }

    def _get_repeat_interval(self) -> float:
        """
        ดึง repeat interval จาก config.py

        รองรับทั้งชื่อใหม่และชื่อเดิม:
        - ALERT_REPEAT_INTERVAL
        - ISSUE_REPEAT_ALERT_INTERVAL
        - ALERT_COOLDOWN
        """

        if config is None:
            return DEFAULT_ALERT_REPEAT_INTERVAL

        return float(
            getattr(
                config,
                "ALERT_REPEAT_INTERVAL",
                getattr(
                    config,
                    "ISSUE_REPEAT_ALERT_INTERVAL",
                    getattr(
                        config,
                        "ALERT_COOLDOWN",
                        DEFAULT_ALERT_REPEAT_INTERVAL,
                    ),
                ),
            )
        )

    # ========================
    # Validation
    # ========================

    def is_ready(self) -> bool:
        """พร้อมส่ง LINE หรือไม่"""

        return (
            self.line_enabled
            and bool(self.channel_access_token)
            and bool(self.line_user_id)
        )

    def get_status(self) -> dict[str, Any]:
        """คืนสถานะ config สำหรับ debug โดยไม่เปิดเผย token เต็ม"""

        return {
            "line_enabled": self.line_enabled,
            "has_channel_access_token": bool(self.channel_access_token),
            "has_channel_secret": bool(self.channel_secret),
            "has_line_user_id": bool(self.line_user_id),
            "line_user_id": self.line_user_id or None,
            "repeat_interval_seconds": self._get_repeat_interval(),
        }

    # ========================
    # Message Builder
    # ========================

    def build_posture_message(self, issues: list[str]) -> str:
        """
        สร้างข้อความแจ้งเตือน LINE เป็นภาษาไทยตาม issue

        issues ที่รองรับ:
        - forward_head
        - rounded_shoulder
        """

        normalized = self._normalize_issues(issues)

        if (
            "forward_head" in normalized
            and "rounded_shoulder" in normalized
        ):
            return (
                "PostureGuard AI\n"
                "⚠️ ท่านั่งของคุณมีแนวโน้มไม่เหมาะสมหลายจุด\n"
                "กรุณาปรับศีรษะ ไหล่ และหลังให้อยู่ในท่าที่เหมาะสม"
            )

        if "forward_head" in normalized:
            return (
                "PostureGuard AI\n"
                "⚠️ ท่านั่งของคุณมีแนวโน้มคอยื่น\n"
                "กรุณาปรับศีรษะให้ตรงและผ่อนคลายช่วงคอ"
            )

        if "rounded_shoulder" in normalized:
            return (
                "PostureGuard AI\n"
                "⚠️ ท่านั่งของคุณมีแนวโน้มไหล่ห่อ\n"
                "กรุณายืดไหล่ เปิดอก และปรับท่านั่งให้เหมาะสม"
            )

        return (
            "PostureGuard AI\n"
            "⚠️ ท่านั่งของคุณมีแนวโน้มไม่เหมาะสม\n"
            "กรุณาปรับท่านั่งให้อยู่ในท่าที่เหมาะสม"
        )
    @staticmethod
    def _normalize_issues(issues: list[str] | tuple[str, ...] | set[str]) -> list[str]:
        allowed = {"forward_head", "rounded_shoulder"}
        result: list[str] = []

        for issue in issues:
            item = str(issue).strip().lower()

            if item in allowed and item not in result:
                result.append(item)

        return result

    @staticmethod
    def _make_issue_key(
        issues: list[str],
        session_id: Optional[int] = None,
    ) -> str:
        """
        สร้าง key สำหรับกันส่งซ้ำ

        ถ้าแจ้งเตือนทั้งสองอย่างพร้อมกัน ใช้ key = multiple
        เพื่อให้ไม่ส่งซ้ำทุก frame
        """

        normalized = sorted(issues)

        if (
            "forward_head" in normalized
            and "rounded_shoulder" in normalized
        ):
            issue_key = "multiple"
        elif normalized:
            issue_key = normalized[0]
        else:
            issue_key = "unknown"

        if session_id is None:
            return f"global:{issue_key}"

        return f"session:{session_id}:{issue_key}"

    # ========================
    # Send LINE Push
    # ========================

    def send_posture_alert(
        self,
        issues: list[str] | tuple[str, ...] | set[str],
        session_id: Optional[int] = None,
        force: bool = False,
    ) -> NotificationResult:
        """
        ส่ง LINE แจ้งเตือน posture

        กติกาป้องกัน spam:
        - ส่งเมื่อถูกเรียกจากจังหวะ alert จริงเท่านั้น
        - ถ้า key เดิมถูกส่งไปแล้ว จะไม่ส่งซ้ำจนกว่าจะครบ repeat interval
        - force=True ใช้สำหรับ test endpoint
        """

        normalized = self._normalize_issues(issues)

        if not normalized:
            return NotificationResult(
                success=False,
                skipped=True,
                message="No supported posture issue to notify",
            )

        self.reload()

        if not self.line_enabled:
            return NotificationResult(
                success=False,
                skipped=True,
                message="LINE notification is disabled",
            )

        if not self.channel_access_token:
            return NotificationResult(
                success=False,
                skipped=True,
                message="LINE_CHANNEL_ACCESS_TOKEN is missing",
            )

        if not self.line_user_id:
            return NotificationResult(
                success=False,
                skipped=True,
                message="LINE_USER_ID is missing",
            )

        notification_key = self._make_issue_key(
            issues=normalized,
            session_id=session_id,
        )

        now = time.time()
        repeat_interval = self._get_repeat_interval()

        with self._lock:
            last_sent = self._last_sent_at.get(notification_key)

            if (
                not force
                and last_sent is not None
                and now - last_sent < repeat_interval
            ):
                remaining = round(repeat_interval - (now - last_sent), 1)

                return NotificationResult(
                    success=False,
                    skipped=True,
                    message=(
                        "Duplicate LINE notification skipped "
                        f"({remaining}s remaining)"
                    ),
                )

        text = self.build_posture_message(normalized)
        result = self._send_text_message(text)

        if result.success:
            with self._lock:
                self._last_sent_at[notification_key] = now

        return result

    def send_test_message(self) -> NotificationResult:
        """ส่งข้อความทดสอบ LINE แบบ manual"""

        self.reload()

        result = self.send_posture_alert(
            issues=("forward_head",),
            session_id=None,
            force=True,
        )

        if result.success:
            result.message = "LINE test notification sent"

        return result

    def _send_text_message(self, text: str) -> NotificationResult:
        """ส่งข้อความ text ไปยัง LINE user"""

        payload = {
            "to": self.line_user_id,
            "messages": [
                {
                    "type": "text",
                    "text": text,
                }
            ],
        }

        body = json.dumps(payload).encode("utf-8")

        request = urllib.request.Request(
            LINE_PUSH_MESSAGE_URL,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.channel_access_token}",
            },
        )

        try:
            with urllib.request.urlopen(
                request,
                timeout=DEFAULT_HTTP_TIMEOUT_SECONDS,
            ) as response:
                status_code = response.getcode()
                response_body = response.read().decode("utf-8", errors="replace")

            if 200 <= status_code < 300:
                return NotificationResult(
                    success=True,
                    skipped=False,
                    message="LINE notification sent",
                    status_code=status_code,
                    detail=response_body,
                )

            return NotificationResult(
                success=False,
                skipped=False,
                message="LINE notification failed",
                status_code=status_code,
                detail=response_body,
            )

        except urllib.error.HTTPError as err:
            error_body = err.read().decode("utf-8", errors="replace")

            print(f"[LINE] HTTPError {err.code}: {error_body}")

            return NotificationResult(
                success=False,
                skipped=False,
                message="LINE notification HTTP error",
                status_code=err.code,
                detail=error_body,
            )

        except urllib.error.URLError as err:
            print(f"[LINE] URLError: {err}")

            return NotificationResult(
                success=False,
                skipped=False,
                message="LINE notification network error",
                detail=str(err),
            )

        except Exception as err:
            print(f"[LINE] Unexpected error: {err}")

            return NotificationResult(
                success=False,
                skipped=False,
                message="LINE notification unexpected error",
                detail=str(err),
            )

    # ========================
    # Webhook
    # ========================

    def verify_webhook_signature(
        self,
        raw_body: bytes,
        signature: str,
    ) -> bool:
        """
        ตรวจสอบ x-line-signature

        LINE ใช้ HMAC-SHA256 ด้วย channel secret แล้ว base64 encode
        """

        self.reload()

        if not self.channel_secret:
            print("[LINE] LINE_CHANNEL_SECRET is missing")
            return False

        if not signature:
            print("[LINE] x-line-signature header is missing")
            return False

        digest = hmac.new(
            self.channel_secret.encode("utf-8"),
            raw_body,
            hashlib.sha256,
        ).digest()

        expected_signature = base64.b64encode(digest).decode("utf-8")

        return hmac.compare_digest(expected_signature, signature)

    def handle_webhook_payload(
        self,
        payload: dict[str, Any],
        raw_body: bytes,
        signature: str = "",
        verify_signature: bool = True,
    ) -> dict[str, Any]:
        """
        ประมวลผล webhook payload จาก LINE

        สิ่งที่ทำ:
        - ตรวจ signature ถ้าเปิด verify_signature
        - ดึง source.userId จาก event
        - save LINE_USER_ID ลง .env
        """

        signature_valid: Optional[bool] = None

        if verify_signature:
            signature_valid = self.verify_webhook_signature(
                raw_body=raw_body,
                signature=signature,
            )

            if not signature_valid:
                return {
                    "success": False,
                    "signature_valid": False,
                    "user_ids": [],
                    "saved_user_id": None,
                    "message": "Invalid LINE webhook signature",
                }

        user_ids = self.extract_user_ids(payload)

        saved_user_id = None

        if user_ids:
            saved_user_id = user_ids[0]
            self.save_line_user_id(saved_user_id)
            print(f"[LINE] LINE_USER_ID detected: {saved_user_id}")

        return {
            "success": True,
            "signature_valid": signature_valid,
            "user_ids": user_ids,
            "saved_user_id": saved_user_id,
            "message": "LINE webhook received",
        }

    @staticmethod
    def extract_user_ids(payload: dict[str, Any]) -> list[str]:
        """ดึง LINE userId จาก webhook events"""

        user_ids: list[str] = []

        events = payload.get("events", [])

        if not isinstance(events, list):
            return user_ids

        for event in events:
            if not isinstance(event, dict):
                continue

            source = event.get("source", {})

            if not isinstance(source, dict):
                continue

            user_id = source.get("userId")

            if user_id and user_id not in user_ids:
                user_ids.append(user_id)

        return user_ids

    # ========================
    # Save LINE_USER_ID
    # ========================

    def save_line_user_id(self, user_id: str) -> None:
        """บันทึก LINE_USER_ID ลง backend/.env"""

        user_id = str(user_id).strip()

        if not user_id:
            return

        with self._lock:
            self._write_env_value("LINE_USER_ID", user_id)
            self.line_user_id = user_id

    def _write_env_value(self, key: str, value: str) -> None:
        """เขียนหรืออัปเดต key ใน .env"""

        self.env_path.parent.mkdir(parents=True, exist_ok=True)

        lines: list[str] = []

        if self.env_path.exists():
            try:
                lines = self.env_path.read_text(encoding="utf-8").splitlines()
            except Exception as err:
                print(f"[LINE] Cannot read .env before update: {err}")
                lines = []

        updated = False
        new_lines: list[str] = []

        for line in lines:
            stripped = line.strip()

            if not stripped or stripped.startswith("#") or "=" not in line:
                new_lines.append(line)
                continue

            current_key, _ = line.split("=", 1)

            if current_key.strip() == key:
                new_lines.append(f"{key}={value}")
                updated = True
            else:
                new_lines.append(line)

        if not updated:
            if new_lines and new_lines[-1].strip():
                new_lines.append("")
            new_lines.append(f"{key}={value}")

        try:
            self.env_path.write_text(
                "\n".join(new_lines) + "\n",
                encoding="utf-8",
            )
        except Exception as err:
            print(f"[LINE] Cannot update .env: {err}")


# ========================
# Module-level Service
# ========================

notification_service = LineNotificationService()


# ========================
# Convenience Functions
# ========================

def send_posture_line_notification(
    issues: list[str] | tuple[str, ...] | set[str],
    session_id: Optional[int] = None,
    force: bool = False,
) -> dict:
    """
    function กลางสำหรับเรียกจาก state.py

    คืนค่า dict เพื่อให้ log/debug ง่าย
    """

    result = notification_service.send_posture_alert(
        issues=issues,
        session_id=session_id,
        force=force,
    )

    return result.to_dict()


def send_test_line_notification() -> dict:
    """function สำหรับเรียกจาก endpoint /notification/test-line"""

    result = notification_service.send_test_message()
    return result.to_dict()


def handle_line_webhook(
    payload: dict[str, Any],
    raw_body: bytes,
    signature: str = "",
    verify_signature: bool = True,
) -> dict:
    """function สำหรับเรียกจาก endpoint /line/webhook"""

    return notification_service.handle_webhook_payload(
        payload=payload,
        raw_body=raw_body,
        signature=signature,
        verify_signature=verify_signature,
    )


def get_line_notification_status() -> dict:
    """ดูสถานะ LINE config แบบไม่เปิดเผย token"""

    notification_service.reload()
    return notification_service.get_status()