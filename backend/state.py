# state.py
# จัดการ state ทั้งหมดของระบบ (in-memory)
#
# เวอร์ชันใหม่:
# - ใช้ CVA สำหรับภาวะคอยื่น
# - ใช้ FSA สำหรับภาวะไหล่ห่อ
# - ลบ logic หลังคร่อม / hunched back ออกจาก state หลัก
# - ไม่ใช้ hip landmark เป็นเงื่อนไขหลัก
# - นับเวลา "ท่าทางเหมาะสม" ต่อไปจนกว่าปัญหาจะถูกแจ้งเตือนจริง
# - แยก timer/alert active ของคอยื่น และไหล่ห่อ
# - นับจำนวนแจ้งเตือนแยกประเภท: คอยื่น / ไหล่ห่อ
# - ไม่มี warning แล้ว
# - ส่ง LINE notification เฉพาะจังหวะ alert จริง ไม่ส่งทุก frame

import time
import threading
from typing import Optional, Dict, Any, List, Tuple

import cv2
import numpy as np

import config
import database as db
from detector import PoseDetector, DetectionResult
from classifier import PostureClassifier, ClassificationResult, Status

try:
    from notification_service import send_posture_line_notification
except Exception as err:
    send_posture_line_notification = None
    print(f"[LINE] notification_service import failed: {err}")


# ========================
# 1. Calibration State
# ========================

class CalibrationState:
    """เก็บ baseline posture ของ user"""

    def __init__(self) -> None:
        self.baseline_cva: Optional[float] = None
        self.baseline_fsa: Optional[float] = None

    def set(self, cva: Optional[float], fsa: Optional[float]) -> bool:
        """
        บันทึก baseline จากท่านั่งที่ผู้ใช้ถือว่าเป็นท่าที่ถูกต้อง

        ต้องมีทั้ง:
        - cva = มุมคอยื่น
        - fsa = มุมไหล่ห่อ
        """
        if cva is None or fsa is None:
            return False

        self.baseline_cva = cva
        self.baseline_fsa = fsa
        return True

    def clear(self) -> None:
        self.baseline_cva = None
        self.baseline_fsa = None

    def as_dict(self) -> Optional[Dict[str, float]]:
        if self.baseline_cva is None and self.baseline_fsa is None:
            return None

        return {
            "cva_angle": self.baseline_cva,
            "fsa_angle": self.baseline_fsa,
        }


# ========================
# 2. Session State
# ========================

class SessionState:
    """เก็บข้อมูล session ที่กำลังทำงาน"""

    def __init__(self) -> None:
        self.session_id: Optional[int] = None
        self.user_id: Optional[int] = None
        self.planned_minutes: Optional[int] = None
        self.start_time: Optional[float] = None

        # เวลาสะสมตามสถานะรวม
        self.good_seconds: float = 0.0
        self.bad_seconds: float = 0.0

        # เวลาสะสมตามสาเหตุจริง
        # จะเริ่มนับเฉพาะหลังจาก issue นั้น active แล้ว
        # เช่น คอยื่นต่อเนื่องครบเวลาที่กำหนดแล้ว
        self.forward_head_seconds: float = 0.0
        self.rounded_shoulder_seconds: float = 0.0

        # จำนวนแจ้งเตือนแยกตามสาเหตุ
        self.forward_head_alert_count: int = 0
        self.rounded_shoulder_alert_count: int = 0

        # เวลาที่ตรวจเจอคนนั่งจริง
        self.effective_seconds: float = 0.0

        # จำนวนแจ้งเตือนรวม
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

        # ถ้าไม่เจอคนหรือหยุดชั่วคราว ไม่ต้องนับเวลา
        if status in [Status.NO_PERSON, Status.PAUSED]:
            return

        # เวลาที่ตรวจเจอคนนั่งจริง
        self.effective_seconds += delta

        has_active_issue = (
            forward_head_alert_active
            or rounded_shoulder_alert_active
        )

        # ถ้ายังไม่ครบเวลาแจ้งเตือน ยังนับเป็นท่าทางเหมาะสม
        if not has_active_issue:
            self.good_seconds += delta
        else:
            self.bad_seconds += delta

            if forward_head_alert_active:
                self.forward_head_seconds += delta

            if rounded_shoulder_alert_active:
                self.rounded_shoulder_seconds += delta

        # นับจำนวนแจ้งเตือนแยกประเภท
        if forward_head_alert:
            self.forward_head_alert_count += 1
            self.alert_count += 1

        if rounded_shoulder_alert:
            self.rounded_shoulder_alert_count += 1
            self.alert_count += 1

        # fallback เผื่อมีโค้ดเก่าที่ส่ง alerted=True
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
        """คำนวณระดับความเสี่ยง"""

        if self.effective_seconds <= 0:
            return "low"

        issue_seconds = (
            self.forward_head_seconds
            + self.rounded_shoulder_seconds
        )

        ratio = issue_seconds / self.effective_seconds

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

        issue_seconds = (
            self.forward_head_seconds
            + self.rounded_shoulder_seconds
        )

        bad_ratio = (
            issue_seconds / self.effective_seconds
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
# 3. Camera Thread
# ========================

class CameraThread:
    """อ่านภาพจากกล้อง ประมวลผล และเก็บผลล่าสุด"""

    def __init__(
        self,
        detector: PoseDetector,
        classifier: PostureClassifier,
        session: SessionState,
        calibration: CalibrationState,
    ) -> None:
        self._detector = detector
        self._classifier = classifier
        self._session = session
        self._calibration = calibration

        self._cap: Optional[cv2.VideoCapture] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.Lock()

        self._latest_detection: Optional[DetectionResult] = None
        self._latest_classification: Optional[ClassificationResult] = None
        self._latest_frame: Optional[np.ndarray] = None

        # Performance
        self._frame_count = 0

        # JPEG cache ลดภาระ cv2.imencode ซ้ำ ๆ
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

        # ลด buffer กล้อง เพื่อลดอาการภาพดีเลย์
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

            # ไม่ต้องให้ MediaPipe ทำงานทุกเฟรม
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

            # สำคัญ: อย่าบันทึก database บน camera loop โดยตรง
            # เพราะตอน alert จะทำให้วิดีโอกระตุก
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

                # frame เปลี่ยนแล้ว cache JPEG เดิมถือว่าเก่า
                self._latest_jpeg = None
                self._encoded_frame_version = -1

            # กัน loop กิน CPU เต็มเกินไป
            time.sleep(0.001)

    def _save_alert_async(
        self,
        detection: DetectionResult,
        classification: ClassificationResult,
    ) -> None:
        """บันทึก alert แยก thread เพื่อลดอาการวิดีโอกระตุกตอนแจ้งเตือน"""

        thread = threading.Thread(
            target=self._save_alert,
            args=(detection, classification),
            daemon=True,
        )
        thread.start()

    def _save_alert(
        self,
        detection: DetectionResult,
        classification: ClassificationResult,
    ) -> None:
        """บันทึก alert และ posture log แยกตามประเภท"""

        session_id = self._session.session_id

        if session_id is None:
            return

        alert_items = []

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

        # fallback เผื่อโค้ดเก่ามีแค่ classification.alert
        if not alert_items and classification.alert:
            issue_type = self._issue_type_of(classification)

            alert_items.append((
                issue_type,
                classification.message,
                classification.bad_posture_duration,
            ))

        # ส่ง LINE notification หนึ่งครั้งต่อหนึ่งจังหวะ alert
        # ถ้าคอยื่นและไหล่ห่อ alert พร้อมกัน จะส่งข้อความแบบ multiple posture issues
        self._send_line_notification(alert_items=alert_items)

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
        alert_items: List[Tuple[str, str, float]],
    ) -> None:
        """ส่ง LINE notification จาก alert_items โดยไม่ให้ backend crash ถ้าส่งล้มเหลว"""

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
                session_id=self._session.session_id,
                force=False,
            )

            if not result.get("success") and not result.get("skipped"):
                print(f"[LINE] notification failed: {result}")

        except Exception as err:
            # Fallback สำคัญ: ห้ามให้ LINE error ทำให้ camera/backend crash
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

    def calibrate(self) -> bool:
        """บันทึก baseline จากผลล่าสุด"""

        detection = self.get_latest_detection()

        if detection is None or not detection.person_detected:
            return False

        return self._calibration.set(
            cva=detection.cva_angle,
            fsa=detection.fsa_angle,
        )