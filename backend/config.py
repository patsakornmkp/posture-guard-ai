# config.py
# ค่าคงที่ทั้งหมดของระบบ PostureGuard Backend
#
# เวอร์ชันปัจจุบัน:
# - ตรวจภาวะคอยื่นด้วย CVA
# - ตรวจภาวะไหล่ห่อด้วย FSA
# - ตัดระดับเฝ้าระวังออก เหลือแค่ ปกติ / อันตราย
# - ไม่ใช้ hunched back / kyphosis
# - ไม่ใช้ hip landmark เป็นเงื่อนไขหลักของระบบ
# - ใช้ marker สีเขียว/เหลืองเฉพาะจุดกกหู / tragus เป็นตัวช่วย
# - แยกเวลาจับคอยื่นและไหล่ห่อ
# - รองรับการเลือก landmark ตามฝั่งกล้อง
# - แจ้งเตือนเมื่อผิดท่าต่อเนื่องครบ 3 นาที
# - หากยังผิดท่าต่อเนื่อง ให้แจ้งเตือนซ้ำทุก 3 นาที
#
# หมายเหตุ:
# - ไฟล์นี้ไม่ควรใส่ token จริงลง source code
# - LINE token / secret / userId ให้ใส่ใน backend/.env เท่านั้น

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
    """
    อ่าน backend/.env แบบ lightweight
    เพื่อเลี่ยงการเพิ่ม dependency ใหม่ เช่น python-dotenv

    รองรับรูปแบบ:
    KEY=value
    """

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
    """
    ลำดับการอ่านค่า:
    1. environment variable ของระบบ
    2. backend/.env
    3. default
    """

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

# ให้ MediaPipe ประมวลผลทุกกี่เฟรม
# 1 = แม่น/สดสุด แต่หนักสุด
# 2 = แนะนำ ตรวจจับได้ดีและเบาลง
# 3 = เบาขึ้นอีก แต่ค่าจะอัปเดตช้ากว่า
PROCESS_EVERY_N_FRAMES: int = 2

# cache JPEG เพื่อลดการ encode ภาพซ้ำถี่เกินไป
JPEG_CACHE_SECONDS: float = 0.20


# ========================
# MediaPipe Pose
# ========================

# ความมั่นใจขั้นต่ำของ MediaPipe
MP_MIN_DETECTION_CONFIDENCE: float = 0.70
MP_MIN_TRACKING_CONFIDENCE: float = 0.70

# visibility ขั้นต่ำของ landmark ที่จะนำมาใช้
MIN_VISIBILITY: float = 0.65

# Smoothing สำหรับ landmark
# 0.25 = นิ่งมาก แต่หน่วงกว่า
# 0.30 = แนะนำ จุดนิ่งขึ้น เหมาะกับการวัดมุม
# 0.45 = สมดุล แต่จุดอาจสั่นกว่า
# 0.60 = ไวกว่าแต่สั่นกว่า
LANDMARK_SMOOTHING_ALPHA: float = 0.30

# วาดเฉพาะจุดที่ใช้จริง ไม่วาด skeleton ทั้งตัว
DRAW_FULL_BODY_SKELETON: bool = False

# ฝั่งกล้องที่ใช้ถ่ายด้านข้างของผู้ใช้
#
# ค่าที่ใช้ได้:
# - "right" = กล้องอยู่ด้านขวาของผู้ใช้ ใช้ RIGHT_EAR / RIGHT_SHOULDER เป็นหลัก
# - "left"  = กล้องอยู่ด้านซ้ายของผู้ใช้ ใช้ LEFT_EAR / LEFT_SHOULDER เป็นหลัก
# - "auto"  = ให้ detector เลือกฝั่งจาก visibility อัตโนมัติ
CAMERA_SIDE: str = "right"

# ทิศทางด้านหน้าของผู้ใช้ในภาพ
# 1  = ด้านหน้าอยู่ทางขวาของภาพ
# -1 = ด้านหน้าอยู่ทางซ้ายของภาพ
CAMERA_FORWARD_DIRECTION: int = 1


# ========================
# CVA — Forward Head Posture / คอยื่น
# ========================
#
# CVA = Craniovertebral Angle
#
# เกณฑ์:
# - ปกติ    : CVA >= 50 องศา
# - อันตราย : CVA < 50 องศา
#
# ไม่มีระดับเฝ้าระวัง

FORWARD_HEAD_GOOD_THRESHOLD: float = 50.0

# เก็บไว้เพื่อรองรับโค้ดเดิม แต่ใช้ค่าเดียวกับ GOOD_THRESHOLD
FORWARD_HEAD_BAD_THRESHOLD: float = 50.0
FORWARD_HEAD_SEVERE_THRESHOLD: float = 50.0


# ========================
# FSA — Rounded Shoulder Posture / ไหล่ห่อ
# ========================
#
# FSA = Forward Shoulder Angle
#
# เกณฑ์:
# - ปกติ    : FSA >= 54 องศา
# - อันตราย : FSA < 54 องศา
#
# ไม่มีระดับเฝ้าระวัง

ROUNDED_SHOULDER_GOOD_THRESHOLD: float = 54.0

# เก็บไว้เพื่อรองรับโค้ดเดิม แต่ใช้ค่าเดียวกับ GOOD_THRESHOLD
ROUNDED_SHOULDER_BAD_THRESHOLD: float = 54.0
ROUNDED_SHOULDER_SEVERE_THRESHOLD: float = 54.0


# ========================
# C7 Estimation
# ========================
#
# MediaPipe ไม่มี landmark C7 โดยตรง
# ค่านี้ใช้ช่วยประมาณตำแหน่ง C7 จากตำแหน่งหัวไหล่
#
# ตอนนี้แนะนำให้ใช้ marker เฉพาะกกหู / tragus
# ส่วน C7 ยังใช้ค่าประมาณจาก MediaPipe เพื่อลดปัญหา marker C7/ไหล่สลับกัน

C7_UP_OFFSET_RATIO: float = 0.08
C7_BACK_OFFSET_RATIO: float = 0.04


# ========================
# Tragus Estimation
# ========================
#
# MediaPipe ear landmark มักอยู่กลาง/หลังใบหู
# จึงขยับไปด้านหน้าตาม CAMERA_FORWARD_DIRECTION เล็กน้อย
# ถ้าเปิด marker สีเขียว/เหลือง ระบบจะใช้ marker กกหูแทนค่านี้

TRAGUS_FORWARD_OFFSET_RATIO: float = 0.018


# ========================
# Marker Detection
# ========================
#
# ใช้ marker เฉพาะจุดกกหู / tragus เท่านั้น
# ไม่ใช้ marker C7 และ shoulder เพื่อลดปัญหาจุดสลับกัน

ENABLE_GREEN_MARKER_DETECTION: bool = True

# ถ้าใช้ marker สีเขียว ให้ใช้ค่านี้
# GREEN_HSV_LOWER: tuple[int, int, int] = (35, 80, 80)
# GREEN_HSV_UPPER: tuple[int, int, int] = (85, 255, 255)

# ตอนนี้ตั้งเป็นช่วงสีเหลืองตามการทดสอบล่าสุด
GREEN_HSV_LOWER: tuple[int, int, int] = (20, 80, 80)
GREEN_HSV_UPPER: tuple[int, int, int] = (35, 255, 255)

GREEN_MARKER_MIN_AREA: int = 40
GREEN_MARKER_MAX_AREA: int = 10000


# ========================
# Alert Timing
# ========================
#
# Requirement:
# - แจ้งเตือนเมื่อผู้ใช้นั่งผิดท่าต่อเนื่องครบ 3 นาที
# - 3 นาที = 180 วินาที
# - ถ้ายังผิดท่าต่อเนื่อง ให้แจ้งเตือนซ้ำทุก 3 นาที
#
# Logic:
# - คอยื่นมี timer แยก
# - ไหล่ห่อมี timer แยก
# - ก่อนครบ 3 นาที ยังไม่ถือว่า alert active
# - ครบ 3 นาทีแล้วจึง alert
# - ถ้ายังผิดท่าต่อ ให้แจ้งเตือนซ้ำทุก 3 นาที
# - ถ้ากลับมาปกติ reset timer ของปัญหานั้นทันที

# ระยะเวลาที่ต้องผิดท่าต่อเนื่องก่อนแจ้งเตือนครั้งแรก
ISSUE_ALERT_DURATION: float = 180.0

# ระยะเวลาแจ้งเตือนซ้ำ หากยังผิดท่าต่อเนื่อง
ALERT_REPEAT_INTERVAL: float = 180.0

# ชื่อเดิม เก็บไว้เพื่อรองรับ classifier.py / โค้ดเดิม
ISSUE_REPEAT_ALERT_INTERVAL: float = ALERT_REPEAT_INTERVAL

# ค่าเก่า เก็บไว้รองรับโค้ดเดิม
BAD_POSTURE_DURATION_MILD: float = ISSUE_ALERT_DURATION
BAD_POSTURE_DURATION_MODERATE: float = ISSUE_ALERT_DURATION
BAD_POSTURE_DURATION_SEVERE: float = ISSUE_ALERT_DURATION

# เก็บไว้รองรับโค้ดเดิม
MULTI_ISSUE_ALERT_DURATION: float = ISSUE_ALERT_DURATION

# ค่า default ของเวลารอก่อนแจ้งเตือน
BAD_POSTURE_DURATION: float = ISSUE_ALERT_DURATION

# ถ้ากลับมาดี จะ reset timer ทันทีใน classifier.py
GRACE_PERIOD: float = 0.0

# หลังจากแจ้งเตือนแล้ว ถ้ายังผิดอยู่ จะเตือนซ้ำทุกกี่วินาที
# ชื่อเก่า เก็บไว้เพื่อรองรับโค้ดเดิม
ALERT_COOLDOWN: float = ALERT_REPEAT_INTERVAL


# ========================
# LINE Messaging API
# ========================
#
# ตัวแปรจริงให้อยู่ใน backend/.env
#
# backend/.env:
# LINE_ENABLED=true
# LINE_CHANNEL_ACCESS_TOKEN=...
# LINE_CHANNEL_SECRET=...
# LINE_USER_ID=...
#
# หมายเหตุ:
# - ห้าม commit .env ขึ้น GitHub
# - ถ้า token หลุด ให้สร้าง token ใหม่ใน LINE Developers ทันที

LINE_ENABLED: bool = _env_bool("LINE_ENABLED", False)
LINE_CHANNEL_ACCESS_TOKEN: str = _env("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET: str = _env("LINE_CHANNEL_SECRET", "")
LINE_USER_ID: str = _env("LINE_USER_ID", "")

# timeout สำหรับส่ง LINE push message
LINE_HTTP_TIMEOUT_SECONDS: float = 5.0

# เปิด/ปิดการตรวจ signature ของ LINE webhook
# production ควรเป็น True
LINE_VERIFY_WEBHOOK_SIGNATURE: bool = _env_bool(
    "LINE_VERIFY_WEBHOOK_SIGNATURE",
    True,
)


# ========================
# Session Risk Level
# ========================

RISK_LOW_THRESHOLD: float = 0.2
RISK_MEDIUM_THRESHOLD: float = 0.5