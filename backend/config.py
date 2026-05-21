# backend/config.py
# ค่าคงที่ทั้งหมดของระบบ PostureGuard Backend
#
# เกณฑ์ที่ใช้:
# - CVA > 50°  = ปกติ
# - CVA <= 50° = คอยื่น
# - FSA > 54°  = ปกติ
# - FSA <= 54° = ไหล่ห่อ / ไหล่งุ้ม
#
# โหมดกล้อง:
# - วางกล้องด้านขวาของผู้ใช้
# - detector.py ใช้ RIGHT_EAR / RIGHT_SHOULDER เป็นตำแหน่งคาดเดาเริ่มต้น
#
# Marker:
# - marker สีเหลืองจุดที่ 1 = หู / tragus
# - marker สีเหลืองจุดที่ 2 = ไหล่ / shoulder
# - C7 คำนวณจาก shoulder หลังเลือก marker แล้ว

from __future__ import annotations

import os
from pathlib import Path


# ========================
# Paths
# ========================

BASE_DIR: Path = Path(__file__).resolve().parent.parent
BACKEND_DIR: Path = Path(__file__).resolve().parent
DATABASE_PATH: Path = BASE_DIR / "database" / "posture.db"
ENV_PATH: Path = BACKEND_DIR / ".env"


# ========================
# Simple .env Reader
# ========================

def _load_env_file() -> dict[str, str]:
    env: dict[str, str] = {}

    if not ENV_PATH.exists():
        return env

    try:
        for raw_line in ENV_PATH.read_text(encoding="utf-8").splitlines():
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
        print(f"[CONFIG] Cannot read .env: {err}")

    return env


_ENV_FILE_VALUES = _load_env_file()


def _env(key: str, default: str = "") -> str:
    return os.getenv(key) or _ENV_FILE_VALUES.get(key, default)


def _env_bool(key: str, default: bool = False) -> bool:
    raw = _env(key, str(default)).strip().lower()
    return raw in {"1", "true", "yes", "y", "on"}


# ========================
# Camera
# ========================

CAMERA_INDEX: int = 0
CAMERA_WIDTH: int = 640
CAMERA_HEIGHT: int = 480
CAMERA_FPS: int = 15
JPEG_QUALITY: int = 60


# ========================
# Performance
# ========================

PROCESS_EVERY_N_FRAMES: int = 2
JPEG_CACHE_SECONDS: float = 0.20


# ========================
# MediaPipe Pose
# ========================

MP_MIN_DETECTION_CONFIDENCE: float = 0.55
MP_MIN_TRACKING_CONFIDENCE: float = 0.55

MIN_VISIBILITY: float = 0.35

LANDMARK_SMOOTHING_ALPHA: float = 0.25

DRAW_FULL_BODY_SKELETON: bool = False


# ========================
# Fixed Camera Direction
# ========================

# 1 = ด้านหน้าผู้ใช้อยู่ทางขวาของภาพ
# -1 = ด้านหน้าผู้ใช้อยู่ทางซ้ายของภาพ
CAMERA_FORWARD_DIRECTION: int = 1


# ========================
# CVA — Forward Head Posture / คอยื่น
# ========================

# ปกติ: CVA > 50
# คอยื่น: CVA <= 50
CVA_FORWARD_HEAD_THRESHOLD: float = 50.0

# ชื่อเดิม เก็บไว้รองรับ classifier.py / โค้ดเดิม
FORWARD_HEAD_GOOD_THRESHOLD: float = CVA_FORWARD_HEAD_THRESHOLD
FORWARD_HEAD_BAD_THRESHOLD: float = CVA_FORWARD_HEAD_THRESHOLD
FORWARD_HEAD_SEVERE_THRESHOLD: float = CVA_FORWARD_HEAD_THRESHOLD


# ========================
# FSA — Rounded Shoulder Posture / ไหล่ห่อ
# ========================

# ปกติ: FSA > 54
# ไหล่ห่อ: FSA <= 54
FSA_ROUNDED_SHOULDER_THRESHOLD: float = 54.0

# ชื่อเดิม เก็บไว้รองรับ classifier.py / โค้ดเดิม
ROUNDED_SHOULDER_GOOD_THRESHOLD: float = FSA_ROUNDED_SHOULDER_THRESHOLD
ROUNDED_SHOULDER_BAD_THRESHOLD: float = FSA_ROUNDED_SHOULDER_THRESHOLD
ROUNDED_SHOULDER_SEVERE_THRESHOLD: float = FSA_ROUNDED_SHOULDER_THRESHOLD


# ========================
# C7 Estimation
# ========================

C7_UP_OFFSET_RATIO: float = 0.095
C7_BACK_OFFSET_RATIO: float = 0.050


# ========================
# Tragus Estimation
# ========================

TRAGUS_FORWARD_OFFSET_RATIO: float = 0.010


# ========================
# Yellow Marker Detection
# ========================

ENABLE_GREEN_MARKER_DETECTION: bool = True

# HSV สำหรับ marker สีเหลือง
# ช่วงนี้กว้างขึ้นเพื่อให้จับ marker ที่แสงไม่เท่ากันได้
GREEN_HSV_LOWER: tuple[int, int, int] = (18, 45, 45)
GREEN_HSV_UPPER: tuple[int, int, int] = (45, 255, 255)

GREEN_MARKER_MIN_AREA: int = 10
GREEN_MARKER_MAX_AREA: int = 2500
GREEN_MARKER_KERNEL_SIZE: int = 5
GREEN_MARKER_MIN_CIRCULARITY: float = 0.12


# ========================
# Ear Marker ROI
# ========================

MARKER_ROI_ENABLED: bool = True

MARKER_ROI_HEAD_MARGIN_X: int = 120
MARKER_ROI_HEAD_MARGIN_Y: int = 105

MARKER_MAX_DISTANCE_FROM_HEAD: int = 145


# ========================
# Shoulder Marker ROI
# ========================

ENABLE_SHOULDER_MARKER_DETECTION: bool = True

SHOULDER_MARKER_ROI_MARGIN_X: int = 190
SHOULDER_MARKER_ROI_MARGIN_Y: int = 160

SHOULDER_MARKER_MAX_DISTANCE: int = 190

# กันไม่ให้ shoulder ROI ไปเลือก marker หู
SHOULDER_MARKER_MIN_DISTANCE_FROM_EAR: int = 85


# ========================
# Marker Smoothing / Sticky Tracking
# ========================

# ยิ่งน้อยยิ่งนิ่ง แต่ตอบสนองช้าลง
MARKER_SMOOTHING_ALPHA: float = 0.18

# ถ้า marker หายชั่วคราว ให้ใช้ตำแหน่งล่าสุดต่ออีกกี่ frame
MARKER_HOLD_FRAMES: int = 8


# ========================
# Debug / Tuning
# ========================

DEBUG_DRAW_VALUES: bool = True
DEBUG_DRAW_LANDMARK_SOURCE: bool = True


# ========================
# Alert Timing
# ========================

ISSUE_ALERT_DURATION: float = 180.0
ALERT_REPEAT_INTERVAL: float = 180.0

ISSUE_REPEAT_ALERT_INTERVAL: float = ALERT_REPEAT_INTERVAL

BAD_POSTURE_DURATION_MILD: float = ISSUE_ALERT_DURATION
BAD_POSTURE_DURATION_MODERATE: float = ISSUE_ALERT_DURATION
BAD_POSTURE_DURATION_SEVERE: float = ISSUE_ALERT_DURATION
MULTI_ISSUE_ALERT_DURATION: float = ISSUE_ALERT_DURATION
BAD_POSTURE_DURATION: float = ISSUE_ALERT_DURATION

GRACE_PERIOD: float = 0.0
ALERT_COOLDOWN: float = ALERT_REPEAT_INTERVAL


# ========================
# LINE Messaging API
# ========================

LINE_ENABLED: bool = _env_bool("LINE_ENABLED", False)
LINE_CHANNEL_ACCESS_TOKEN: str = _env("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET: str = _env("LINE_CHANNEL_SECRET", "")
LINE_USER_ID: str = _env("LINE_USER_ID", "")

LINE_HTTP_TIMEOUT_SECONDS: float = 5.0

LINE_VERIFY_WEBHOOK_SIGNATURE: bool = _env_bool(
    "LINE_VERIFY_WEBHOOK_SIGNATURE",
    True,
)


# ========================
# Session Risk Level
# ========================

RISK_LOW_THRESHOLD: float = 0.2
RISK_MEDIUM_THRESHOLD: float = 0.5