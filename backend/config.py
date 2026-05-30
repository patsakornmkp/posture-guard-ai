# config.py
# ค่าคงที่ทั้งหมดของระบบ PostureGuard Backend
#
# เวอร์ชันใหม่:
# - ตรวจภาวะคอยื่นด้วย CVA
# - ตรวจภาวะไหล่ห่อด้วย FSA
# - ตัดระดับเฝ้าระวังออก เหลือแค่ ปกติ / อันตราย
# - ไม่ใช้ท่าคอยื่นร่วมกับไหล่ห่อเป็นประเภทแยก
# - ไม่ใช้ hip landmark เป็นเงื่อนไขหลักของระบบ
# - ใช้ marker สีเขียวเฉพาะจุดกกหู / tragus เป็นตัวช่วย
# - แยกเวลาจับคอยื่นและไหล่ห่อ
# - แจ้งเตือนเมื่อผิดท่าต่อเนื่องครบเวลาที่กำหนด
# - หากยังผิดท่าต่อเนื่อง ให้แจ้งเตือนซ้ำตาม repeat interval
# - เพิ่ม config สำหรับ LINE binding แบบ multi-user

import os
from pathlib import Path


# ========================
# Paths
# ========================

BASE_DIR: Path = Path(__file__).resolve().parent.parent
DATABASE_PATH: Path = BASE_DIR / "database" / "posture.db"


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
DRAW_FULL_BODY_SKELETON: bool = True

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
# เกณฑ์ใหม่:
# - ปกติ    : CVA >= 45 องศา
# - อันตราย : CVA < 45 องศา
#
# ไม่มีระดับเฝ้าระวังแล้ว

FORWARD_HEAD_GOOD_THRESHOLD: float = 45.0

# เก็บไว้เพื่อรองรับโค้ดเดิม แต่ใช้ค่าเดียวกับ GOOD_THRESHOLD
FORWARD_HEAD_BAD_THRESHOLD: float = 45.0
FORWARD_HEAD_SEVERE_THRESHOLD: float = 45.0


# ========================
# FSA — Rounded Shoulder Posture / ไหล่ห่อ
# ========================
#
# FSA = Forward Shoulder Angle
#
# เกณฑ์ใหม่:
# - ปกติ    : FSA >= 52 องศา
# - อันตราย : FSA < 52 องศา
#
# ไม่มีระดับเฝ้าระวังแล้ว

ROUNDED_SHOULDER_GOOD_THRESHOLD: float = 52.0

# เก็บไว้เพื่อรองรับโค้ดเดิม แต่ใช้ค่าเดียวกับ GOOD_THRESHOLD
ROUNDED_SHOULDER_BAD_THRESHOLD: float = 52.0
ROUNDED_SHOULDER_SEVERE_THRESHOLD: float = 52.0


# ========================
# C7 Estimation
# ========================
#
# MediaPipe ไม่มี landmark C7 โดยตรง
# ค่านี้ใช้ช่วยประมาณตำแหน่ง C7 จากตำแหน่งหัวไหล่
#
# ตอนนี้แนะนำให้ใช้ marker เฉพาะกกหู / tragus
# ส่วน C7 ยังใช้ค่าประมาณจาก MediaPipe เพื่อลดปัญหา marker C7/ไหล่สลับกัน

# ใช้หัวไหล่ฝั่งที่เห็นชัดเป็นฐานในการประมาณ C7
# เหมาะกับกล้องด้านข้าง เพราะ opposite shoulder มักหลุด/แกว่งจาก MediaPipe
C7_USE_VISIBLE_SHOULDER_ONLY: bool = True

C7_UP_OFFSET_RATIO: float = 0.08
C7_BACK_OFFSET_RATIO: float = 0.04


# ========================
# Tragus Estimation
# ========================
#
# MediaPipe ear landmark มักอยู่กลาง/หลังใบหู
# จึงขยับไปด้านหน้าตาม CAMERA_FORWARD_DIRECTION เล็กน้อย
# ถ้าเปิด marker สีเขียว ระบบจะใช้ marker กกหูแทนค่านี้

TRAGUS_FORWARD_OFFSET_RATIO: float = 0.018


# ========================
# Green Marker Detection
# ========================
#
# ค่าแนะนำสำหรับ demo: ปิดไว้ก่อน เพื่อไม่ให้สีเขียวอื่นในฉากหลังถูกเข้าใจผิดเป็น marker
# ถ้าจะใช้สติกเกอร์ marker จริง ให้เปิดเป็น True และติดเฉพาะจุดกกหู / tragus เท่านั้น
# ระบบจะไม่ใช้ marker แทน C7/Shoulder เพราะมีโอกาสสลับจุดสูงในมุมกล้องด้านข้าง

ENABLE_GREEN_MARKER_DETECTION: bool = True

# ผู้ใช้ติด sticker 3 จุดจริง: Tragus / C7 / Shoulder
# True = ถ้าเจอ marker ครบและ assign ได้ จะใช้ marker ทั้ง 3 จุดแทน MediaPipe
# False = ใช้ marker เฉพาะ Tragus แล้วใช้ MediaPipe/estimate สำหรับ C7/Shoulder
USE_GREEN_MARKER_THREE_POINT_MODE: bool = True

# วาดวงกลมเล็กสีม่วงบน sticker ที่ระบบตรวจพบดิบ ๆ
# ใช้ debug ว่าระบบมองเห็น sticker หรือไม่
DRAW_DETECTED_GREEN_MARKERS: bool = True

# สีเขียว
GREEN_HSV_LOWER: tuple[int, int, int] = (35, 45, 45)
GREEN_HSV_UPPER: tuple[int, int, int] = (90, 255, 255)

# ถ้าเปลี่ยนไปใช้สีเหลือง ให้ใช้ประมาณนี้แทน
# GREEN_HSV_LOWER: tuple[int, int, int] = (20, 80, 80)
# GREEN_HSV_UPPER: tuple[int, int, int] = (35, 255, 255)

GREEN_MARKER_MIN_AREA: int = 18
GREEN_MARKER_MAX_AREA: int = 10000


# ========================
# Marker Assignment Scoring
# ========================
#
# พารามิเตอร์สำหรับการ assign marker -> (tragus, C7, humerus)
# ใช้ anatomical scoring เพื่อกัน C7/Humerus สลับกัน

# คะแนน cost สูงสุดที่ยอมรับ ถ้าเกินจะ fallback ไปใช้ MediaPipe
# ต่ำ = เข้มงวด ตรวจไม่เจอจะ fallback ง่าย
# สูง = ผ่อนปรน ใช้ marker แม้คะแนนไม่ดี
MARKER_ASSIGNMENT_MAX_COST: float = 4.5

# น้ำหนัก temporal consistency
# 0 = ไม่สนเฟรมก่อนเลย เปลี่ยนทันที
# 0.6 = แนะนำ ช่วยลดอาการสลับกะพริบ
# 1.0+ = เกาะติดเฟรมก่อน อาจหน่วงตอนผู้ใช้ขยับ
MARKER_TEMPORAL_WEIGHT: float = 0.6


# ========================
# Alert Timing
# ========================
#
# Logic:
# - คอยื่นมี timer แยก
# - ไหล่ห่อมี timer แยก
# - ก่อนครบเวลาที่กำหนด ยังนับเป็นท่าทางเหมาะสม
# - ครบเวลาแล้วจึง alert
# - ถ้ายังผิดท่าต่อ ให้แจ้งเตือนซ้ำตาม repeat interval
# - ถ้ากลับมาปกติ reset timer ของปัญหานั้นทันที
#
# หมายเหตุ:
# - ตอนทดสอบอาจตั้งเป็น 10 วินาทีได้
# - ตอนใช้งานจริงแนะนำ 180 วินาที

# ระยะเวลาที่ต้องผิดท่าต่อเนื่องก่อนแจ้งเตือน
ISSUE_ALERT_DURATION: float = 180.0

# ระยะเวลาแจ้งเตือนซ้ำ หากยังผิดท่าต่อเนื่อง
ISSUE_REPEAT_ALERT_INTERVAL: float = 180.0

# ให้ notification_service ใช้ชื่อกลางนี้ได้
# เพื่อรักษา duplicate guard ให้ตรงกับ repeat interval ของระบบหลัก
ALERT_REPEAT_INTERVAL: float = ISSUE_REPEAT_ALERT_INTERVAL

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
ALERT_COOLDOWN: float = ISSUE_REPEAT_ALERT_INTERVAL


# ========================
# LINE Messaging API
# ========================
#
# ค่า token จริงต้องอยู่ใน backend/.env เท่านั้น
#
# .env ตัวอย่าง:
# LINE_ENABLED=true
# LINE_CHANNEL_ACCESS_TOKEN=ใส่_token_จริง_ในเครื่องตัวเอง
# LINE_CHANNEL_SECRET=ใส่_channel_secret_จริง_ในเครื่องตัวเอง
# LINE_OFFICIAL_ACCOUNT_ID=@your_oa_id
#
# ไม่ควรใช้ LINE_USER_ID เป็นปลายทางหลักในระบบ multi-user แล้ว
# เพราะ user แต่ละคนจะมี users.line_user_id ของตัวเองใน SQLite
#
# หมายเหตุ:
# - ตัวแปรด้านล่างอ่านจาก environment variable
# - notification_service.py ยังอ่าน backend/.env เองได้ด้วย
# - ห้ามใส่ token จริงใน source code

LINE_ENABLED: bool = os.getenv("LINE_ENABLED", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "y",
    "on",
}

LINE_CHANNEL_ACCESS_TOKEN: str = os.getenv(
    "LINE_CHANNEL_ACCESS_TOKEN",
    "",
).strip()

LINE_CHANNEL_SECRET: str = os.getenv(
    "LINE_CHANNEL_SECRET",
    "",
).strip()

# ใช้สร้าง QR / link เปิด LINE Official Account พร้อมรหัส PG-xxxxxx
# ตัวอย่าง: @postureguardai
LINE_OFFICIAL_ACCOUNT_ID: str = os.getenv(
    "LINE_OFFICIAL_ACCOUNT_ID",
    "",
).strip()

# เก็บไว้เพื่อ backward compatibility เท่านั้น
# ระบบ multi-user ไม่ควรใช้เป็นปลายทางหลัก
LINE_USER_ID: str = os.getenv(
    "LINE_USER_ID",
    "",
).strip()

# อายุรหัสผูกบัญชี LINE เช่น PG-482913
LINE_LINK_CODE_TTL_MINUTES: int = int(
    os.getenv("LINE_LINK_CODE_TTL_MINUTES", "10")
)

# Production ควรเป็น True เสมอ
# ถ้าทดสอบ webhook ด้วย payload ปลอมใน local อาจตั้ง False ชั่วคราวได้
LINE_VERIFY_WEBHOOK_SIGNATURE: bool = os.getenv(
    "LINE_VERIFY_WEBHOOK_SIGNATURE",
    "true",
).strip().lower() in {
    "1",
    "true",
    "yes",
    "y",
    "on",
}


# ========================
# Session Risk Level
# ========================

RISK_LOW_THRESHOLD: float = 0.2
RISK_MEDIUM_THRESHOLD: float = 0.5