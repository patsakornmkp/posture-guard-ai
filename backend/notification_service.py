# notification_service.py
# จัดการการแจ้งเตือนผ่าน LINE Messaging API สำหรับ PostureGuard AI
#
# เวอร์ชันนี้:
# - อ่าน Channel Access Token / Channel Secret จาก backend/.env
# - อ่าน LINE_OFFICIAL_ACCOUNT_ID จาก backend/.env สำหรับสร้าง URL ผูกบัญชีด้วย QR
# - ผูก LINE userId กับ users แต่ละคนใน SQLite
# - ไม่ใช้ LINE_USER_ID จาก .env เป็นปลายทางหลักในระบบ multi-user
# - ส่ง LINE เฉพาะเจ้าของ session ตาม user_id
# - ป้องกัน duplicate/repeat spam แยกตาม user_id + session_id + issue type
# - ถ้า LINE ล้มเหลว จะ log error และ return fail โดยไม่ crash backend

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import database as db

try:
    import config
except Exception:
    config = None


# ========================
# Constants
# ========================

ENV_PATH = Path(__file__).resolve().parent / ".env"

LINE_PUSH_MESSAGE_URL = "https://api.line.me/v2/bot/message/push"
LINE_REPLY_MESSAGE_URL = "https://api.line.me/v2/bot/message/reply"

DEFAULT_ALERT_REPEAT_INTERVAL = 180.0
DEFAULT_HTTP_TIMEOUT_SECONDS = 5.0
DEFAULT_LINE_LINK_CODE_TTL_MINUTES = 10


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
    Service สำหรับ LINE notification

    หลักการ multi-user:
    - .env เก็บเฉพาะ channel token / secret และ optional system LINE_ENABLED
    - LINE_OFFICIAL_ACCOUNT_ID ใช้สร้าง QR/link สำหรับให้ user กดส่งรหัสใน LINE
    - users.line_user_id คือปลายทางของ user แต่ละคน
    - users.line_notify_enabled คือ toggle ของ user คนนั้น
    - LINE_USER_ID จาก .env ใช้เป็น fallback เฉพาะ backward compatibility เท่านั้น
    """

    def __init__(self, env_path: Path = ENV_PATH) -> None:
        self.env_path = env_path
        self._lock = threading.Lock()

        # key เช่น:
        # user:4:session:12:forward_head
        # user:4:session:12:rounded_shoulder
        # user:4:session:12:multiple
        self._last_sent_at: dict[str, float] = {}

        self.system_line_enabled: bool = False
        self.channel_access_token: str = ""
        self.channel_secret: str = ""

        # ใช้สร้าง QR/link เปิด LINE OA พร้อมข้อความรหัสผูกบัญชี
        # ตัวอย่างใน .env:
        # LINE_OFFICIAL_ACCOUNT_ID=@postureguardai
        self.line_official_account_id: str = ""

        # fallback สำหรับระบบเก่าเท่านั้น ไม่ใช้เป็น destination หลักของ multi-user
        self.global_line_user_id: str = ""

        self.reload()

    # ========================
    # Environment
    # ========================

    def reload(self) -> None:
        """โหลดค่า config ใหม่จาก .env และ environment variables"""
        env = self._load_env_file()

        raw_line_enabled = env.get(
            "LINE_ENABLED",
            os.getenv("LINE_ENABLED", "true"),
        )

        self.system_line_enabled = self._to_bool(raw_line_enabled)

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

        self.line_official_account_id = self._get_env_value(
            env,
            "LINE_OFFICIAL_ACCOUNT_ID",
            "",
        )

        self.global_line_user_id = self._get_env_value(
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
        LINE_OFFICIAL_ACCOUNT_ID=@your_oa_id
        LINE_USER_ID=...  # fallback เท่านั้น ไม่เหมาะกับ multi-user
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
        อ่านค่าตามลำดับ:
        1. environment variable จริง
        2. backend/.env
        3. config.py ถ้ามี
        4. default
        """
        value = os.getenv(key)

        if value is not None:
            return value.strip()

        if key in env:
            return str(env.get(key, "")).strip()

        if config is not None:
            config_value = getattr(config, key, None)

            if config_value is not None:
                return str(config_value).strip()

        return default

    @staticmethod
    def _to_bool(value: Any) -> bool:
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

        try:
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
        except Exception:
            return DEFAULT_ALERT_REPEAT_INTERVAL

    def _get_line_link_code_ttl_minutes(self) -> int:
        if config is None:
            return DEFAULT_LINE_LINK_CODE_TTL_MINUTES

        try:
            return int(
                getattr(
                    config,
                    "LINE_LINK_CODE_TTL_MINUTES",
                    DEFAULT_LINE_LINK_CODE_TTL_MINUTES,
                )
            )
        except Exception:
            return DEFAULT_LINE_LINK_CODE_TTL_MINUTES

    # ========================
    # LINE Link URL / QR Payload
    # ========================

    def build_line_open_url(self, link_code: str) -> Optional[str]:
        """
        สร้าง URL สำหรับเปิด LINE Official Account พร้อมข้อความรหัสผูกบัญชี

        ตัวอย่างผลลัพธ์:
        https://line.me/R/oaMessage/%40postureguardai/?PG-482913

        หมายเหตุ:
        - ไม่ hardcode OA ID ใน source code
        - ต้องตั้งค่า LINE_OFFICIAL_ACCOUNT_ID ใน .env
        - frontend สามารถเอา URL นี้ไป encode เป็น QR ได้เลย
        """
        code = str(link_code or "").strip().upper()
        oa_id = str(self.line_official_account_id or "").strip()

        if not code or not oa_id:
            return None

        encoded_oa_id = urllib.parse.quote(oa_id, safe="")
        encoded_text = urllib.parse.quote(code, safe="")

        return f"https://line.me/R/oaMessage/{encoded_oa_id}/?{encoded_text}"

    def _mask_line_user_id(self, line_user_id: Optional[str]) -> Optional[str]:
        """ซ่อน LINE userId จริง แต่ยังให้ผู้ใช้เห็นว่าผูกกับปลายทางใดอยู่"""
        value = str(line_user_id or "").strip()

        if not value:
            return None

        if len(value) <= 10:
            return value[:2] + "***"

        return f"{value[:6]}...{value[-4:]}"

    # ========================
    # Status / User settings
    # ========================

    def _base_status(self) -> dict[str, Any]:
        return {
            "system_line_enabled": self.system_line_enabled,
            "has_channel_access_token": bool(self.channel_access_token),
            "has_channel_secret": bool(self.channel_secret),
            "has_line_official_account_id": bool(self.line_official_account_id),
            "has_global_line_user_id": bool(self.global_line_user_id),
            "repeat_interval_seconds": self._get_repeat_interval(),
        }

    def get_status(self, user_id: Optional[int] = None) -> dict[str, Any]:
        """
        คืนสถานะ LINE โดยไม่เปิดเผย token

        สำหรับ frontend:
        - is_linked: user ผูก LINE แล้วหรือยัง
        - line_notify_enabled: toggle ของ user
        - can_send_line: พร้อมส่งจริงหรือไม่
        - system_ready: ระบบตั้งค่า token + OA ID พร้อมหรือไม่
        """
        self.reload()
        status = self._base_status()

        system_ready = (
            self.system_line_enabled
            and bool(self.channel_access_token)
            and bool(self.channel_secret)
        )

        # สำคัญ: ในระบบ multi-user ห้ามใช้ LINE_USER_ID จาก .env
        # มาตัดสินว่า user ปัจจุบัน "ผูกบัญชีแล้ว"
        # เพราะจะทำให้หน้าเว็บขึ้นว่าผูกแล้วทั้งที่ user ยังไม่ได้สแกน QR
        # ถ้า frontend ไม่ส่ง user_id ให้คืนเฉพาะสถานะระบบ ไม่คืนสถานะผูกบัญชี
        if user_id is None:
            status.update({
                "user_id": None,
                "line_enabled": False,
                "line_notify_enabled": False,
                "has_line_user_id": False,
                "line_user_id": None,
                "is_linked": False,
                "line_link_code": None,
                "line_link_code_expires_at": None,
                "line_link_code_active": False,
                "system_ready": system_ready,
                "can_create_link_code": bool(self.line_official_account_id),
                "can_send_line": False,
                "mode": "system_only_no_user",
            })
            return status

        user_line = db.get_user_line_status(user_id)

        if not user_line:
            status.update({
                "user_id": user_id,
                "line_enabled": False,
                "line_notify_enabled": False,
                "has_line_user_id": False,
                "line_user_id": None,
                "is_linked": False,
                "line_link_code": None,
                "line_link_code_expires_at": None,
                "line_link_code_active": False,
                "system_ready": system_ready,
                "can_create_link_code": bool(self.line_official_account_id),
                "can_send_line": False,
                "mode": "user_not_found",
            })
            return status

        linked = bool(user_line.get("line_user_id"))
        user_enabled = bool(user_line.get("line_notify_enabled"))
        active_code = bool(user_line.get("line_link_code_active"))

        line_link_code = (
            user_line.get("line_link_code")
            if active_code
            else None
        )

        line_open_url = self.build_line_open_url(line_link_code) if line_link_code else None

        status.update({
            "user_id": user_id,
            "line_enabled": user_enabled,
            "line_notify_enabled": user_enabled,
            "has_line_user_id": linked,

            # ไม่จำเป็นต้องโชว์ LINE userId จริงใน UI
            # แต่คง field ไว้เพื่อ backward compatibility
            "line_user_id": user_line.get("line_user_id") if linked else None,
            "line_user_id_masked": self._mask_line_user_id(user_line.get("line_user_id")) if linked else None,
            "linked_summary": (
                f"LINE User ID: {self._mask_line_user_id(user_line.get('line_user_id'))}"
                if linked
                else None
            ),

            "is_linked": linked,
            "line_link_code": line_link_code,
            "line_link_code_expires_at": (
                user_line.get("line_link_code_expires_at")
                if active_code
                else None
            ),
            "line_link_code_active": active_code,
            "line_open_url": line_open_url,
            "qr_payload": line_open_url,
            "system_ready": system_ready,
            "can_create_link_code": bool(self.line_official_account_id),
            "can_send_line": (
                system_ready
                and linked
                and user_enabled
            ),
            "mode": "per_user",
        })

        return status

    def create_user_link_code(self, user_id: int) -> dict[str, Any]:
        """
        สร้างรหัสผูกบัญชี LINE ให้ user

        response ที่ frontend ต้องใช้:
        - line.line_link_code
        - line.line_link_code_expires_at
        - line.line_open_url
        - line.qr_payload
        """
        self.reload()

        ttl = self._get_line_link_code_ttl_minutes()
        user_line = db.create_line_link_code(user_id=user_id, ttl_minutes=ttl)

        if not user_line:
            return {
                "success": False,
                "message": "User not found",
                "line": self.get_status(user_id),
            }

        line_status = self.get_status(user_id)
        line_code = line_status.get("line_link_code")
        line_open_url = self.build_line_open_url(line_code)

        line_status["line_open_url"] = line_open_url
        line_status["qr_payload"] = line_open_url

        return {
            "success": True,
            "message": "LINE link code created",
            "line": line_status,
            "line_link_code": line_code,
            "line_link_code_expires_at": line_status.get("line_link_code_expires_at"),
            "line_open_url": line_open_url,
            "qr_payload": line_open_url,
        }

    def unlink_user_account(self, user_id: int) -> dict[str, Any]:
        """ยกเลิกการผูกบัญชี LINE ของ user ปัจจุบัน"""
        user_line = db.unlink_line_user(user_id)

        if not user_line:
            return {
                **self.get_status(user_id),
                "success": False,
                "message": "User not found",
            }

        status = self.get_status(user_id)
        status["success"] = True
        status["message"] = "LINE account unlinked"
        return status

    def set_enabled(
        self,
        enabled: bool,
        user_id: Optional[int] = None,
    ) -> dict[str, Any]:
        """
        เปิด/ปิด LINE notification

        - ถ้ามี user_id: อัปเดต users.line_notify_enabled ของ user นั้น
        - ถ้าไม่มี user_id: fallback ระบบเก่า อัปเดต LINE_ENABLED ใน .env
        """
        enabled_bool = bool(enabled)

        if user_id is not None:
            user_line = db.set_user_line_notify_enabled(user_id, enabled_bool)

            if not user_line:
                return self.get_status(user_id)

            return self.get_status(user_id)

        # ระบบปัจจุบันเป็น per-user เท่านั้น
        # ไม่อนุญาตให้เปิด/ปิด LINE แบบ global จากหน้าเว็บ
        # เพื่อป้องกันกรณี toggle เปิดได้ทั้งที่ user ยังไม่ได้ผูกบัญชี
        return self.get_status(None)

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
    def _normalize_issues(
        issues: list[str] | tuple[str, ...] | set[str],
    ) -> list[str]:
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
        user_id: Optional[int] = None,
        line_user_id: Optional[str] = None,
    ) -> str:
        """สร้าง key สำหรับกันส่งซ้ำ แยกตาม user/session/issue"""
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

        if user_id is not None:
            owner_key = f"user:{user_id}"
        elif line_user_id:
            owner_key = f"line:{line_user_id}"
        else:
            owner_key = "global"

        session_key = f"session:{session_id}" if session_id is not None else "manual"
        return f"{owner_key}:{session_key}:{issue_key}"

    # ========================
    # Send LINE Push
    # ========================

    def send_posture_alert(
        self,
        issues: list[str] | tuple[str, ...] | set[str],
        session_id: Optional[int] = None,
        user_id: Optional[int] = None,
        line_user_id: Optional[str] = None,
        force: bool = False,
    ) -> NotificationResult:
        """
        ส่ง LINE แจ้งเตือน posture

        กติกา:
        - caller ต้องเรียกเฉพาะจังหวะ alert จริงหรือครบ repeat interval เท่านั้น
        - service นี้มี duplicate guard อีกชั้น แยกตาม user_id + issue type
        - ถ้า user ยังไม่ผูก LINE หรือปิด toggle จะ skip แบบไม่ crash
        """
        normalized = self._normalize_issues(issues)

        if not normalized:
            return NotificationResult(
                success=False,
                skipped=True,
                message="No supported posture issue to notify",
            )

        self.reload()

        if not self.system_line_enabled:
            return NotificationResult(
                success=False,
                skipped=True,
                message="LINE notification system is disabled",
            )

        if not self.channel_access_token:
            return NotificationResult(
                success=False,
                skipped=True,
                message="LINE_CHANNEL_ACCESS_TOKEN is missing",
            )

        target_line_user_id = str(line_user_id or "").strip()
        owner_user_id = user_id

        if owner_user_id is not None:
            user_line = db.get_user_line_status(owner_user_id)

            if not user_line:
                return NotificationResult(
                    success=False,
                    skipped=True,
                    message="User not found for LINE notification",
                )

            if not bool(user_line.get("line_notify_enabled")):
                return NotificationResult(
                    success=False,
                    skipped=True,
                    message="User LINE notification is disabled",
                )

            target_line_user_id = str(user_line.get("line_user_id") or "").strip()

            if not target_line_user_id:
                return NotificationResult(
                    success=False,
                    skipped=True,
                    message="User has not linked LINE account",
                )

        # Backward compatibility เฉพาะ caller เก่าที่ไม่ได้ส่ง user_id
        if not target_line_user_id:
            target_line_user_id = self.global_line_user_id.strip()

        if not target_line_user_id:
            return NotificationResult(
                success=False,
                skipped=True,
                message="LINE userId is missing",
            )

        notification_key = self._make_issue_key(
            issues=normalized,
            session_id=session_id,
            user_id=owner_user_id,
            line_user_id=target_line_user_id,
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
        result = self._send_text_message(
            text=text,
            line_user_id=target_line_user_id,
        )

        if result.success:
            with self._lock:
                self._last_sent_at[notification_key] = now

        return result

    def send_test_message(self, user_id: Optional[int] = None) -> NotificationResult:
        """ส่งข้อความทดสอบ LINE แบบ manual"""
        self.reload()

        result = self.send_posture_alert(
            issues=("forward_head",),
            session_id=None,
            user_id=user_id,
            force=True,
        )

        if result.success:
            result.message = "LINE test notification sent"

        return result

    def _send_text_message(
        self,
        text: str,
        line_user_id: str,
    ) -> NotificationResult:
        """ส่งข้อความ text ไปยัง LINE userId ที่ระบุ"""
        payload = {
            "to": line_user_id,
            "messages": [
                {
                    "type": "text",
                    "text": text,
                }
            ],
        }

        return self._post_line_api(
            url=LINE_PUSH_MESSAGE_URL,
            payload=payload,
            success_message="LINE notification sent",
            fail_message="LINE notification failed",
        )

    def _reply_text_message(
        self,
        reply_token: str,
        text: str,
    ) -> NotificationResult:
        """ตอบกลับข้อความใน LINE webhook"""
        if not reply_token:
            return NotificationResult(
                success=False,
                skipped=True,
                message="LINE reply token is missing",
            )

        payload = {
            "replyToken": reply_token,
            "messages": [
                {
                    "type": "text",
                    "text": text,
                }
            ],
        }

        return self._post_line_api(
            url=LINE_REPLY_MESSAGE_URL,
            payload=payload,
            success_message="LINE reply sent",
            fail_message="LINE reply failed",
        )

    def _post_line_api(
        self,
        url: str,
        payload: dict[str, Any],
        success_message: str,
        fail_message: str,
    ) -> NotificationResult:
        if not self.channel_access_token:
            return NotificationResult(
                success=False,
                skipped=True,
                message="LINE_CHANNEL_ACCESS_TOKEN is missing",
            )

        body = json.dumps(payload).encode("utf-8")

        request = urllib.request.Request(
            url,
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
                    message=success_message,
                    status_code=status_code,
                    detail=response_body,
                )

            return NotificationResult(
                success=False,
                skipped=False,
                message=fail_message,
                status_code=status_code,
                detail=response_body,
            )

        except urllib.error.HTTPError as err:
            error_body = err.read().decode("utf-8", errors="replace")
            print(f"[LINE] HTTPError {err.code}: {error_body}")

            return NotificationResult(
                success=False,
                skipped=False,
                message="LINE HTTP error",
                status_code=err.code,
                detail=error_body,
            )

        except urllib.error.URLError as err:
            print(f"[LINE] URLError: {err}")

            return NotificationResult(
                success=False,
                skipped=False,
                message="LINE network error",
                detail=str(err),
            )

        except Exception as err:
            print(f"[LINE] Unexpected error: {err}")

            return NotificationResult(
                success=False,
                skipped=False,
                message="LINE unexpected error",
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
        - อ่านข้อความที่ user ส่งมา
        - ถ้าข้อความตรงกับ users.line_link_code ที่ยังไม่หมดอายุ
          จะบันทึก source.userId ลง users.line_user_id
        - ตอบกลับ LINE ว่าผูกสำเร็จ หรือรหัสผิด/หมดอายุ
        """
        self.reload()
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
                    "events_processed": 0,
                    "linked_users": [],
                    "message": "Invalid LINE webhook signature",
                }

        events = payload.get("events", [])
        linked_users: list[dict[str, Any]] = []
        replies: list[dict[str, Any]] = []
        processed = 0

        if not isinstance(events, list):
            events = []

        for event in events:
            if not isinstance(event, dict):
                continue

            processed += 1
            result = self._handle_single_webhook_event(event)

            if result.get("linked_user"):
                linked_users.append(result["linked_user"])

            if result.get("reply"):
                replies.append(result["reply"])

        return {
            "success": True,
            "signature_valid": signature_valid,
            "events_processed": processed,
            "linked_users": linked_users,
            "replies": replies,
            "message": "LINE webhook received",
        }

    def _handle_single_webhook_event(self, event: dict[str, Any]) -> dict[str, Any]:
        source = event.get("source", {})
        message = event.get("message", {})
        reply_token = event.get("replyToken", "")

        if not isinstance(source, dict) or not isinstance(message, dict):
            return {"linked_user": None, "reply": None}

        line_user_id = str(source.get("userId") or "").strip()
        message_type = message.get("type")
        text = str(message.get("text") or "").strip().upper()

        if not line_user_id or message_type != "text" or not text:
            return {"linked_user": None, "reply": None}

        # ถ้ารหัสเคยมีแต่หมดอายุแล้ว ให้ล้างรหัสเก่าออก
        db.clear_expired_line_link_code(text)

        linked_user = db.bind_line_user_by_code(
            code=text,
            line_user_id=line_user_id,
        )

        if linked_user:
            username = linked_user.get("username") or "ผู้ใช้งาน"
            reply_text = (
                "PostureGuard AI\n"
                f"✅ ผูกบัญชี LINE สำเร็จกับผู้ใช้ {username}\n"
                "คุณจะได้รับแจ้งเตือนเมื่อเกิด alert ตามการตั้งค่าของบัญชีนี้"
            )

            reply_result = self._reply_text_message(
                reply_token=reply_token,
                text=reply_text,
            )

            safe_user = {
                "user_id": linked_user.get("id"),
                "username": linked_user.get("username"),
                "line_notify_enabled": bool(linked_user.get("line_notify_enabled")),
            }

            return {
                "linked_user": safe_user,
                "reply": reply_result.to_dict(),
            }

        reply_text = (
            "PostureGuard AI\n"
            "ไม่พบรหัสผูกบัญชี หรือรหัสหมดอายุแล้ว\n"
            "กรุณากลับไปที่หน้า Monitoring แล้วกดสร้างรหัสผูก LINE ใหม่"
        )

        reply_result = self._reply_text_message(
            reply_token=reply_token,
            text=reply_text,
        )

        return {
            "linked_user": None,
            "reply": reply_result.to_dict(),
        }

    @staticmethod
    def extract_user_ids(payload: dict[str, Any]) -> list[str]:
        """ดึง LINE userId จาก webhook events — เก็บไว้รองรับ debug/โค้ดเก่า"""
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
    # Save / Write .env for backward compatibility
    # ========================

    def _write_env_value(self, key: str, value: str) -> None:
        """เขียนหรืออัปเดต key ใน .env เฉพาะค่า global/system"""
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
    user_id: Optional[int] = None,
    line_user_id: Optional[str] = None,
    force: bool = False,
) -> dict:
    """
    function กลางสำหรับเรียกจาก state.py

    ในระบบ multi-user ควรส่ง user_id ของเจ้าของ session ทุกครั้ง
    """
    result = notification_service.send_posture_alert(
        issues=issues,
        session_id=session_id,
        user_id=user_id,
        line_user_id=line_user_id,
        force=force,
    )

    return result.to_dict()


def send_test_line_notification(user_id: Optional[int] = None) -> dict:
    """function สำหรับเรียกจาก endpoint /notification/test-line"""
    result = notification_service.send_test_message(user_id=user_id)
    return result.to_dict()


def create_line_link_code(user_id: int) -> dict:
    """สร้างรหัสผูกบัญชี LINE ให้ user"""
    return notification_service.create_user_link_code(user_id=user_id)


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


def set_line_notification_enabled(
    enabled: bool,
    user_id: Optional[int] = None,
) -> dict:
    """เปิด/ปิด LINE notification จาก frontend settings panel"""
    return notification_service.set_enabled(
        enabled=enabled,
        user_id=user_id,
    )


def get_line_notification_status(user_id: Optional[int] = None) -> dict:
    """ดูสถานะ LINE config แบบไม่เปิดเผย token"""
    notification_service.reload()
    return notification_service.get_status(user_id=user_id)

def unlink_line_account(user_id: int) -> dict:
    """
    ยกเลิกการผูกบัญชี LINE ของ user

    function นี้เป็น wrapper ให้ main.py เรียกใช้
    เพื่อไม่ให้ backend import error ตอนเริ่ม uvicorn
    """
    return notification_service.unlink_user_account(user_id=user_id)

