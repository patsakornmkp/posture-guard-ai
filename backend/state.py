# state.py
# จัดการ state ทั้งหมดของระบบ (in-memory)
#
# เวอร์ชันนี้:
# - ใช้ CVA สำหรับภาวะคอยื่น
# - ใช้ FSA สำหรับภาวะไหล่ห่อ
# - ไม่ใช้ Calibration / Baseline แล้ว
# - ลบ logic หลังคร่อม / hunched back ออกจาก state หลัก
# - ไม่ใช้ hip landmark เป็นเงื่อนไขหลัก
# - นับเวลา "ท่าทางเหมาะสม" ต่อไปจนกว่าปัญหาจะถูกแจ้งเตือนจริง
# - แยก timer/alert active ของคอยื่น และไหล่ห่อ
# - นับจำนวนแจ้งเตือนแยกประเภท: คอยื่น / ไหล่ห่อ
# - ใช้ bad_seconds เป็นเวลาท่าผิดรวมจริง ไม่เอา forward+rounded มาบวกเป็นเวลารวม
# - ไม่มี warning แล้ว
# - ส่ง LINE notification เฉพาะจังหวะ alert จริง ไม่ส่งทุก frame
# - ส่ง LINE ตาม user_id ของ session ปัจจุบัน เพื่อรองรับ multi-user

from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

import config
import database as db
from classifier import ClassificationResult, PostureClassifier, Status
from detector import DetectionResult, PoseDetector

try:
    from notification_service import send_posture_line_notification
except Exception as err:
    send_posture_line_notification = None
    print(f"[LINE] notification_service import failed: {err}")


# ========================
# 1. Session State
# ========================

class SessionState:
    """เก็บข้อมูล session ที่กำลังทำงาน"""

    def __init__(self) -> None:
        self.session_id: Optional[int] = None
        self.user_id: Optional[int] = None
        self.planned_minutes: Optional[int] = None
        self.start_time: Optional[float] = None

        self.good_seconds: float = 0.0
        self.bad_seconds: float = 0.0

        self.forward_head_seconds: float = 0.0
        self.rounded_shoulder_seconds: float = 0.0

        self.forward_head_alert_count: int = 0
        self.rounded_shoulder_alert_count: int = 0

        self.effective_seconds: float = 0.0
        self.alert_count: int = 0

        self._last_tick_time: Optional[float] = None
        self.current_status: Status = Status.NO_PERSON

    def start(self, user_id: int, planned_minutes: int) -> int:
        """เริ่ม session ใหม่"""
        session_id = db.create_session(user_id, planned_minutes)

        self.session_id = session_id
        self.user_id = user_id
        self.planned_minutes = planned_minutes
        self.start_time = time.time()

        self.good_seconds = 0.0
        self.bad_seconds = 0.0

        self.forward_head_seconds = 0.0
        self.rounded_shoulder_seconds = 0.0

        self.forward_head_alert_count = 0
        self.rounded_shoulder_alert_count = 0

        self.effective_seconds = 0.0
        self.alert_count = 0

        self._last_tick_time = None
        self.current_status = Status.NO_PERSON

        return session_id

    def stop(self) -> Optional[Dict[str, Any]]:
        """จบ session และคืน summary"""
        if self.session_id is None:
            return None

        summary = self.get_summary()

        db.close_session(
            session_id=self.session_id,
            good_seconds=self.good_seconds,
            bad_seconds=self.bad_seconds,
            effective_seated_seconds=self.effective_seconds,
            forward_head_seconds=self.forward_head_seconds,
            rounded_shoulder_seconds=self.rounded_shoulder_seconds,
            alert_count=self.alert_count,
            risk_level=summary["risk_level"],
            forward_head_alert_count=self.forward_head_alert_count,
            rounded_shoulder_alert_count=self.rounded_shoulder_alert_count,
        )

        self.session_id = None
        self.user_id = None
        self.planned_minutes = None
        self.start_time = None
        self._last_tick_time = None

        return summary

    def tick(
        self,
        status: Status,
        alerted: bool,
        is_forward_head: bool = False,
        is_rounded_shoulder: bool = False,
        forward_head_alert: bool = False,
        rounded_shoulder_alert: bool = False,
        forward_head_alert_active: bool = False,
        rounded_shoulder_alert_active: bool = False,
    ) -> None:
        """
        อัปเดตเวลาสะสมของ session

        Logic:
        - ถ้ามุมเริ่มผิด แต่ยังไม่ครบเวลาที่กำหนด → ยังนับเป็นท่าทางเหมาะสม
        - ถ้าครบเวลาและมี alert_active → หยุดนับท่าทางเหมาะสม
        - นับ forward_head_seconds เฉพาะเมื่อคอยื่น active แล้ว
        - นับ rounded_shoulder_seconds เฉพาะเมื่อไหล่ห่อ active แล้ว
        - นับ alert แยกตาม forward_head_alert / rounded_shoulder_alert
        """
        if self.session_id is None:
            return

        now = time.time()
        self.current_status = status

        if self._last_tick_time is None:
            self._last_tick_time = now
            return

        delta = now - self._last_tick_time
        self._last_tick_time = now

        if status in [Status.NO_PERSON, Status.PAUSED]:
            return

        self.effective_seconds += delta

        has_active_issue = (
            forward_head_alert_active
            or rounded_shoulder_alert_active
        )

        if not has_active_issue:
            self.good_seconds += delta
        else:
            self.bad_seconds += delta

            if forward_head_alert_active:
                self.forward_head_seconds += delta

            if rounded_shoulder_alert_active:
                self.rounded_shoulder_seconds += delta

        if forward_head_alert:
            self.forward_head_alert_count += 1
            self.alert_count += 1

        if rounded_shoulder_alert:
            self.rounded_shoulder_alert_count += 1
            self.alert_count += 1

        if (
            alerted
            and not forward_head_alert
            and not rounded_shoulder_alert
        ):
            self.alert_count += 1

            if is_forward_head:
                self.forward_head_alert_count += 1

            if is_rounded_shoulder:
                self.rounded_shoulder_alert_count += 1

    def _calculate_risk(self) -> str:
        """คำนวณระดับความเสี่ยงจากเวลาท่าผิดรวมจริง

        ห้ามใช้ forward_head_seconds + rounded_shoulder_seconds เป็นเวลารวม
        เพราะถ้าคอยื่นและไหล่ห่อเกิดพร้อมกัน จะทำให้เวลาถูกนับซ้ำ
        """
        if self.effective_seconds <= 0:
            return "low"

        ratio = self.bad_seconds / self.effective_seconds

        if ratio < config.RISK_LOW_THRESHOLD:
            return "low"

        if ratio < config.RISK_MEDIUM_THRESHOLD:
            return "medium"

        return "high"

    def get_summary(self) -> Dict[str, Any]:
        """คืนข้อมูลสรุป session"""
        active = self.session_id is not None

        actual_duration = (
            time.time() - self.start_time
            if self.start_time
            else 0.0
        )

        bad_ratio = (
            self.bad_seconds / self.effective_seconds
            if self.effective_seconds > 0
            else 0.0
        )

        return {
            "session_active": active,
            "planned_duration_minutes": self.planned_minutes,
            "actual_duration_seconds": round(actual_duration, 1),
            "effective_seated_seconds": round(self.effective_seconds, 1),

            "good_posture_seconds": round(self.good_seconds, 1),
            "bad_posture_seconds": round(self.bad_seconds, 1),

            "forward_head_seconds": round(self.forward_head_seconds, 1),
            "rounded_shoulder_seconds": round(
                self.rounded_shoulder_seconds,
                1,
            ),

            "forward_head_alert_count": self.forward_head_alert_count,
            "rounded_shoulder_alert_count": self.rounded_shoulder_alert_count,
            "alert_count": self.alert_count,

            "bad_posture_ratio": round(bad_ratio, 3),
            "current_status": self.current_status.value,
            "risk_level": self._calculate_risk(),
        }


# ========================
# 2. Camera Thread
# ========================

class CameraThread:
    """อ่านภาพจากกล้อง ประมวลผล และเก็บผลล่าสุด"""

    def __init__(
        self,
        detector: PoseDetector,
        classifier: PostureClassifier,
        session: SessionState,
    ) -> None:
        self._detector = detector
        self._classifier = classifier
        self._session = session

        self._cap: Optional[cv2.VideoCapture] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.Lock()

        self._latest_detection: Optional[DetectionResult] = None
        self._latest_classification: Optional[ClassificationResult] = None
        self._latest_frame: Optional[np.ndarray] = None

        self._frame_count = 0

        self._latest_jpeg: Optional[bytes] = None
        self._latest_jpeg_time: float = 0.0
        self._frame_version: int = 0
        self._encoded_frame_version: int = -1

    def start(self) -> bool:
        """เปิดกล้องและเริ่ม thread"""
        if self._running:
            return True

        cap = cv2.VideoCapture(config.CAMERA_INDEX)

        if not cap.isOpened():
            cap.release()
            return False

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)
        cap.set(cv2.CAP_PROP_FPS, config.CAMERA_FPS)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        self._cap = cap
        self._running = True
        self._frame_count = 0

        self._thread = threading.Thread(
            target=self._loop,
            daemon=True,
        )
        self._thread.start()

        return True

    def stop(self) -> None:
        """หยุดกล้องและ thread"""
        self._running = False

        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

        if self._cap is not None:
            self._cap.release()
            self._cap = None

        with self._lock:
            self._latest_detection = None
            self._latest_classification = None
            self._latest_frame = None

            self._latest_jpeg = None
            self._latest_jpeg_time = 0.0
            self._frame_version = 0
            self._encoded_frame_version = -1

    def is_running(self) -> bool:
        return self._running

    def _loop(self) -> None:
        """loop อ่านภาพจากกล้อง"""
        process_every = max(
            1,
            int(getattr(config, "PROCESS_EVERY_N_FRAMES", 2)),
        )

        while self._running and self._cap is not None:
            ret, frame = self._cap.read()

            if not ret:
                time.sleep(0.01)
                continue

            self._frame_count += 1

            if self._frame_count % process_every != 0:
                continue

            detection = self._detector.process(frame)

            classification = self._classifier.classify(
                person_detected=detection.person_detected,
                cva_angle=detection.cva_angle,
                fsa_angle=detection.fsa_angle,
            )

            self._session.tick(
                status=classification.status,
                alerted=classification.alert,
                is_forward_head=classification.is_forward_head,
                is_rounded_shoulder=classification.is_rounded_shoulder,
                forward_head_alert=getattr(
                    classification,
                    "forward_head_alert",
                    False,
                ),
                rounded_shoulder_alert=getattr(
                    classification,
                    "rounded_shoulder_alert",
                    False,
                ),
                forward_head_alert_active=getattr(
                    classification,
                    "forward_head_alert_active",
                    False,
                ),
                rounded_shoulder_alert_active=getattr(
                    classification,
                    "rounded_shoulder_alert_active",
                    False,
                ),
            )

            if classification.alert and self._session.session_id is not None:
                self._save_alert_async(detection, classification)

            output_frame = (
                detection.annotated_frame
                if detection.annotated_frame is not None
                else frame
            )

            with self._lock:
                self._latest_detection = detection
                self._latest_classification = classification
                self._latest_frame = output_frame
                self._frame_version += 1

                self._latest_jpeg = None
                self._encoded_frame_version = -1

            time.sleep(0.001)

    def _save_alert_async(
        self,
        detection: DetectionResult,
        classification: ClassificationResult,
    ) -> None:
        """
        บันทึก alert แยก thread เพื่อลดอาการวิดีโอกระตุกตอนแจ้งเตือน

        สำคัญ:
        - จับ session_id และ user_id ณ ตอนเกิด alert ทันที
        - ป้องกันกรณี user กด stop session ระหว่าง thread กำลังทำงาน
        """
        session_id = self._session.session_id
        user_id = self._session.user_id

        if session_id is None or user_id is None:
            return

        thread = threading.Thread(
            target=self._save_alert,
            args=(session_id, user_id, detection, classification),
            daemon=True,
        )
        thread.start()

    def _save_alert(
        self,
        session_id: int,
        user_id: int,
        detection: DetectionResult,
        classification: ClassificationResult,
    ) -> None:
        """บันทึก alert และ posture log แยกตามประเภท"""
        alert_items: List[Tuple[str, str, float]] = []

        if getattr(classification, "forward_head_alert", False):
            alert_items.append((
                "forward_head",
                "แจ้งเตือนคอยื่น",
                getattr(classification, "forward_head_duration", 0.0),
            ))

        if getattr(classification, "rounded_shoulder_alert", False):
            alert_items.append((
                "rounded_shoulder",
                "แจ้งเตือนไหล่ห่อ",
                getattr(classification, "rounded_shoulder_duration", 0.0),
            ))

        if not alert_items and classification.alert:
            issue_type = self._issue_type_of(classification)

            alert_items.append((
                issue_type,
                classification.message,
                classification.bad_posture_duration,
            ))

        self._send_line_notification(
            session_id=session_id,
            user_id=user_id,
            alert_items=alert_items,
        )

        for issue_type, message, duration in alert_items:
            db.log_alert(
                session_id=session_id,
                alert_type=issue_type,
                message=message,
            )

            db.log_posture_issue(
                session_id=session_id,
                issue_type=issue_type,
                cva_angle=detection.cva_angle,
                fsa_angle=detection.fsa_angle,
                duration=duration,
            )

    def _send_line_notification(
        self,
        session_id: int,
        user_id: int,
        alert_items: List[Tuple[str, str, float]],
    ) -> None:
        """
        ส่ง LINE notification จาก alert_items

        สำคัญ:
        - ส่ง user_id ของ session ปัจจุบันเข้า notification_service
        - notification_service จะไปดึง users.line_user_id เอง
        - ถ้า user ยังไม่ผูก LINE หรือปิด toggle จะ skip เฉพาะ LINE
        - ถ้าส่ง LINE ล้มเหลว backend ต้องไม่ crash
        """
        if not alert_items:
            return

        if send_posture_line_notification is None:
            return

        issues: List[str] = []

        for issue_type, _message, _duration in alert_items:
            if issue_type in ["forward_head", "rounded_shoulder"]:
                if issue_type not in issues:
                    issues.append(issue_type)

        if not issues:
            return

        try:
            result = send_posture_line_notification(
                issues=issues,
                session_id=session_id,
                user_id=user_id,
                force=False,
            )

            if not result.get("success") and not result.get("skipped"):
                print(f"[LINE] notification failed: {result}")

        except Exception as err:
            print(f"[LINE] notification error ignored: {err}")

    @staticmethod
    def _issue_type_of(c: ClassificationResult) -> str:
        """แปลง classification เป็น issue_type แบบไม่ใช้ประเภทท่าร่วม"""
        if getattr(c, "forward_head_alert", False):
            return "forward_head"

        if getattr(c, "rounded_shoulder_alert", False):
            return "rounded_shoulder"

        if c.is_forward_head:
            return "forward_head"

        if c.is_rounded_shoulder:
            return "rounded_shoulder"

        return "unknown"

    def get_latest_classification(self) -> Optional[ClassificationResult]:
        with self._lock:
            return self._latest_classification

    def get_latest_detection(self) -> Optional[DetectionResult]:
        with self._lock:
            return self._latest_detection

    def get_latest_frame_jpeg(self) -> Optional[bytes]:
        """คืนภาพล่าสุดเป็น JPEG bytes"""
        now = time.time()
        cache_seconds = float(getattr(config, "JPEG_CACHE_SECONDS", 0.20))

        with self._lock:
            frame = self._latest_frame
            frame_version = self._frame_version

            if (
                self._latest_jpeg is not None
                and self._encoded_frame_version == frame_version
                and now - self._latest_jpeg_time < cache_seconds
            ):
                return self._latest_jpeg

            if frame is None:
                return None

            frame_to_encode = frame.copy()

        success, buffer = cv2.imencode(
            ".jpg",
            frame_to_encode,
            [int(cv2.IMWRITE_JPEG_QUALITY), config.JPEG_QUALITY],
        )

        if not success:
            return None

        jpeg_bytes = buffer.tobytes()

        with self._lock:
            self._latest_jpeg = jpeg_bytes
            self._latest_jpeg_time = now
            self._encoded_frame_version = frame_version

        return jpeg_bytes