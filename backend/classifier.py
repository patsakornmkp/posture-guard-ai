# classifier.py
# ตัดสินสถานะท่าทาง (good/bad) และกรองด้วย temporal filter
#
# เวอร์ชันใหม่:
# - ตรวจคอยื่นด้วย CVA
# - ตรวจไหล่ห่อด้วย FSA
# - ไม่ใช้ท่าคอยื่นร่วมกับไหล่ห่อเป็นประเภทแยก
# - แยก timer คอยื่น และ timer ไหล่ห่อ ออกจากกัน
# - แจ้งเตือนเมื่อปัญหานั้น ๆ ผิดท่าต่อเนื่องครบ 3 นาที
# - ถ้ายังผิดอยู่ จะเตือนซ้ำทุก 3 นาที แยกตามแต่ละปัญหา
# - ถ้ากลับมาปกติ จะ reset timer ของปัญหานั้นทันที

import time
from typing import Optional
from dataclasses import dataclass
from enum import Enum

import config


class Status(str, Enum):
    GOOD = "good"
    BAD = "bad"
    PAUSED = "paused"
    NO_PERSON = "no_person_detected"


@dataclass
class ClassificationResult:
    status: Status

    # ค่านี้หมายถึง “มุมปัจจุบันผิดเกณฑ์หรือไม่”
    # ใช้สำหรับแสดงผลหน้า monitoring
    is_forward_head: bool
    is_rounded_shoulder: bool

    # ระยะเวลาที่ผิดท่าต่อเนื่องมากที่สุดในรอบนี้
    bad_posture_duration: float

    # alert รวม ใช้กับระบบแจ้งเตือนเดิม
    alert: bool

    message: str

    # ========================
    # New fields: แยกคอยื่น / ไหล่ห่อ
    # ========================

    # ระยะเวลาที่คอยื่นต่อเนื่อง
    forward_head_duration: float = 0.0

    # ระยะเวลาที่ไหล่ห่อต่อเนื่อง
    rounded_shoulder_duration: float = 0.0

    # true เฉพาะรอบที่ต้องแจ้งเตือนคอยื่น
    forward_head_alert: bool = False

    # true เฉพาะรอบที่ต้องแจ้งเตือนไหล่ห่อ
    rounded_shoulder_alert: bool = False

    # true เมื่อคอยื่นเกิน 3 นาทีแล้ว และยังไม่กลับมาปกติ
    forward_head_alert_active: bool = False

    # true เมื่อไหล่ห่อเกิน 3 นาทีแล้ว และยังไม่กลับมาปกติ
    rounded_shoulder_alert_active: bool = False


def _get_config_value(name: str, default: float) -> float:
    """ดึงค่าจาก config.py แบบปลอดภัย"""
    return getattr(config, name, default)


def _get_alert_duration() -> float:
    """
    เวลาที่ต้องผิดท่าต่อเนื่องก่อนแจ้งเตือน

    ถ้า config.py มี ISSUE_ALERT_DURATION จะใช้ค่านั้น
    ถ้าไม่มี จะใช้ BAD_POSTURE_DURATION
    """
    return _get_config_value(
        "ISSUE_ALERT_DURATION",
        _get_config_value("BAD_POSTURE_DURATION", 180.0),
    )


def _get_repeat_alert_interval() -> float:
    """
    ระยะเวลาเตือนซ้ำ

    ตั้งใจให้เตือนซ้ำทุก 3 นาที
    ถ้า config.py มี ISSUE_REPEAT_ALERT_INTERVAL จะใช้ค่านั้น
    ถ้าไม่มี จะใช้ BAD_POSTURE_DURATION แทน
    """
    return _get_config_value(
        "ISSUE_REPEAT_ALERT_INTERVAL",
        _get_config_value("BAD_POSTURE_DURATION", 180.0),
    )


def classify_cva(cva_angle: Optional[float]) -> str:
    """
    จำแนกภาวะคอยื่นจากมุม CVA

    เกณฑ์ใหม่:
    - CVA >= 45 องศา = good
    - CVA < 45 องศา = bad
    """
    if cva_angle is None:
        return "unknown"

    good_threshold = _get_config_value(
        "FORWARD_HEAD_GOOD_THRESHOLD",
        45.0,
    )

    if cva_angle >= good_threshold:
        return "good"

    return "bad"


def classify_fsa(fsa_angle: Optional[float]) -> str:
    """
    จำแนกภาวะไหล่ห่อจากมุม FSA

    เกณฑ์ใหม่:
    - FSA >= 52 องศา = good
    - FSA < 52 องศา = bad
    """
    if fsa_angle is None:
        return "unknown"

    good_threshold = _get_config_value(
        "ROUNDED_SHOULDER_GOOD_THRESHOLD",
        52.0,
    )

    if fsa_angle >= good_threshold:
        return "good"

    return "bad"


def combine_status(cva_status: str, fsa_status: str) -> Status:
    """
    รวมสถานะจาก CVA และ FSA

    หลักการใหม่:
    - ถ้า CVA หรือ FSA อย่างใดอย่างหนึ่ง bad → BAD
    - ถ้าทั้งคู่ไม่ bad → GOOD
    - ไม่มี WARNING แล้ว
    """
    if "bad" in (cva_status, fsa_status):
        return Status.BAD

    return Status.GOOD


class PostureClassifier:
    def __init__(self) -> None:
        # Timer แยกของคอยื่น
        self._forward_head_start_time: Optional[float] = None
        self._last_forward_head_alert_time: Optional[float] = None

        # Timer แยกของไหล่ห่อ
        self._rounded_shoulder_start_time: Optional[float] = None
        self._last_rounded_shoulder_alert_time: Optional[float] = None

    def reset(self) -> None:
        self._forward_head_start_time = None
        self._last_forward_head_alert_time = None

        self._rounded_shoulder_start_time = None
        self._last_rounded_shoulder_alert_time = None

    def classify(
        self,
        person_detected: bool,
        cva_angle: Optional[float],
        fsa_angle: Optional[float],
    ) -> ClassificationResult:
        now = time.time()

        if not person_detected:
            self.reset()

            return ClassificationResult(
                status=Status.NO_PERSON,
                is_forward_head=False,
                is_rounded_shoulder=False,
                bad_posture_duration=0.0,
                alert=False,
                message="ไม่พบผู้ใช้งานหน้ากล้อง",
            )

        cva_status = classify_cva(cva_angle)
        fsa_status = classify_fsa(fsa_angle)

        # raw issue = มุมปัจจุบันผิดเกณฑ์หรือไม่
        is_forward_head = cva_status == "bad"
        is_rounded_shoulder = fsa_status == "bad"

        raw_status = combine_status(cva_status, fsa_status)

        # อัปเดต timer แยกกัน
        forward_result = self._update_forward_head_timer(
            now=now,
            is_issue=is_forward_head,
        )

        rounded_result = self._update_rounded_shoulder_timer(
            now=now,
            is_issue=is_rounded_shoulder,
        )

        forward_duration = forward_result["duration"]
        rounded_duration = rounded_result["duration"]

        forward_alert = forward_result["alert"]
        rounded_alert = rounded_result["alert"]

        forward_active = forward_result["active"]
        rounded_active = rounded_result["active"]

        any_alert = forward_alert or rounded_alert
        bad_duration = max(forward_duration, rounded_duration)

        if raw_status == Status.GOOD:
            return ClassificationResult(
                status=Status.GOOD,
                is_forward_head=False,
                is_rounded_shoulder=False,
                bad_posture_duration=0.0,
                alert=False,
                message="ท่าทางถูกต้อง",
                forward_head_duration=0.0,
                rounded_shoulder_duration=0.0,
                forward_head_alert=False,
                rounded_shoulder_alert=False,
                forward_head_alert_active=False,
                rounded_shoulder_alert_active=False,
            )

        message = self._build_message(
            status=Status.BAD,
            is_forward_head=is_forward_head,
            is_rounded_shoulder=is_rounded_shoulder,
            forward_active=forward_active,
            rounded_active=rounded_active,
        )

        return ClassificationResult(
            status=Status.BAD,
            is_forward_head=is_forward_head,
            is_rounded_shoulder=is_rounded_shoulder,
            bad_posture_duration=round(bad_duration, 1),
            alert=any_alert,
            message=message,
            forward_head_duration=round(forward_duration, 1),
            rounded_shoulder_duration=round(rounded_duration, 1),
            forward_head_alert=forward_alert,
            rounded_shoulder_alert=rounded_alert,
            forward_head_alert_active=forward_active,
            rounded_shoulder_alert_active=rounded_active,
        )

    def _update_forward_head_timer(
        self,
        now: float,
        is_issue: bool,
    ) -> dict:
        """
        จัดการ timer ของคอยื่น

        ถ้า CVA < 45:
        - เริ่มจับเวลา
        - ครบ 3 นาที → forward_head_alert = True
        - ถ้ายังคอยื่นต่อ → เตือนซ้ำทุก 3 นาที

        ถ้า CVA >= 45:
        - reset timer คอยื่นทันที
        """
        if not is_issue:
            self._forward_head_start_time = None
            self._last_forward_head_alert_time = None

            return {
                "duration": 0.0,
                "active": False,
                "alert": False,
            }

        if self._forward_head_start_time is None:
            self._forward_head_start_time = now

        duration = now - self._forward_head_start_time
        active = duration >= _get_alert_duration()

        should_alert = False

        if active:
            should_alert = self._check_issue_alert_due(
                now=now,
                last_alert_time=self._last_forward_head_alert_time,
            )

            if should_alert:
                self._last_forward_head_alert_time = now

        return {
            "duration": duration,
            "active": active,
            "alert": should_alert,
        }

    def _update_rounded_shoulder_timer(
        self,
        now: float,
        is_issue: bool,
    ) -> dict:
        """
        จัดการ timer ของไหล่ห่อ

        ถ้า FSA < 52:
        - เริ่มจับเวลา
        - ครบ 3 นาที → rounded_shoulder_alert = True
        - ถ้ายังไหล่ห่อต่อ → เตือนซ้ำทุก 3 นาที

        ถ้า FSA >= 52:
        - reset timer ไหล่ห่อทันที
        """
        if not is_issue:
            self._rounded_shoulder_start_time = None
            self._last_rounded_shoulder_alert_time = None

            return {
                "duration": 0.0,
                "active": False,
                "alert": False,
            }

        if self._rounded_shoulder_start_time is None:
            self._rounded_shoulder_start_time = now

        duration = now - self._rounded_shoulder_start_time
        active = duration >= _get_alert_duration()

        should_alert = False

        if active:
            should_alert = self._check_issue_alert_due(
                now=now,
                last_alert_time=self._last_rounded_shoulder_alert_time,
            )

            if should_alert:
                self._last_rounded_shoulder_alert_time = now

        return {
            "duration": duration,
            "active": active,
            "alert": should_alert,
        }

    def _check_issue_alert_due(
        self,
        now: float,
        last_alert_time: Optional[float],
    ) -> bool:
        """
        ตรวจว่า issue นี้ควรแจ้งเตือนหรือยัง

        - ถ้ายังไม่เคยแจ้ง → แจ้งทันทีเมื่อครบ 3 นาที
        - ถ้าเคยแจ้งแล้ว → แจ้งซ้ำทุก 3 นาที
        """
        if last_alert_time is None:
            return True

        elapsed = now - last_alert_time
        return elapsed >= _get_repeat_alert_interval()

    def _build_message(
        self,
        status: Status,
        is_forward_head: bool,
        is_rounded_shoulder: bool,
        forward_active: bool = False,
        rounded_active: bool = False,
    ) -> str:
        if status == Status.NO_PERSON:
            return "ไม่พบผู้ใช้งานหน้ากล้อง"

        if status == Status.GOOD:
            return "ท่าทางถูกต้อง"

        issues = []

        if is_forward_head:
            if forward_active:
                issues.append(
                    "คอยื่น: นั่งคอยื่นต่อเนื่องเกินเวลาที่กำหนด กรุณาดึงคางกลับ และปรับหน้าจอให้อยู่ระดับสายตา"
                )
            else:
                issues.append(
                    "คอยื่น: ค่ามุมคอไม่อยู่ในเกณฑ์ปกติ ระบบกำลังจับเวลาต่อเนื่อง"
                )

        if is_rounded_shoulder:
            if rounded_active:
                issues.append(
                    "ไหล่ห่อ: นั่งไหล่ห่อต่อเนื่องเกินเวลาที่กำหนด กรุณาดึงหัวไหล่กลับ เปิดอก และจัดตำแหน่งไหล่ให้เหมาะสม"
                )
            else:
                issues.append(
                    "ไหล่ห่อ: ค่ามุมไหล่ไม่อยู่ในเกณฑ์ปกติ ระบบกำลังจับเวลาต่อเนื่อง"
                )

        if issues:
            return " | ".join(issues)

        return "ตรวจพบท่าทางไม่เหมาะสม กรุณาปรับท่านั่ง"