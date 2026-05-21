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
# - รองรับการเลือก landmark ตามฝั่งกล้อง
# - แจ้งเตือนเมื่อผิดท่าต่อเนื่องครบ 3 นาที
# - หากยังผิดท่าต่อเนื่อง ให้แจ้งเตือนซ้ำทุก 3 นาที

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
DRAW_FULL_BODY_SKELETON: bool = False

# ฝั่งกล้องที่ใช้ถ่ายด้านข้างของผู้ใช้
#
# ค่าที่ใช้ได้:
# - "right" = กล้องอยู่ด้านขวาของผู้ใช้ ใช้ RIGHT_EAR / RIGHT_SHOULDER เป็นหลัก
# - "left"  = กล้องอยู่ด้านซ้ายของผู้ใช้ ใช้ LEFT_EAR / LEFT_SHOULDER เป็นหลัก
# - "auto"  = ให้ detector เลือกฝั่งจาก visibility อัตโนมัติ
#
# ตอนนี้ตั้งเป็น "right" เพราะด้านขวาจับจุดเสถียรกว่าในการทดสอบ
CAMERA_SIDE: str = "left"
# ทิศทางด้านหน้าของผู้ใช้ในภาพ
# 1  = ด้านหน้าอยู่ทางขวาของภาพ
# -1 = ด้านหน้าอยู่ทางซ้ายของภาพ
CAMERA_FORWARD_DIRECTION: int = -1

# ========================
# CVA — Forward Head Posture / คอยื่น
# ========================
#
# CVA = Craniovertebral Angle
#
# เกณฑ์ใหม่:
# - ปกติ    : CVA >= 50 องศา
# - อันตราย : CVA < 50 องศา
#
# ไม่มีระดับเฝ้าระวังแล้ว

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
# เกณฑ์ใหม่:
# - ปกติ    : FSA >= 54 องศา
# - อันตราย : FSA < 54 องศา
#
# ไม่มีระดับเฝ้าระวังแล้ว

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
# ถ้าเปิด marker สีเขียว ระบบจะใช้ marker กกหูแทนค่านี้

TRAGUS_FORWARD_OFFSET_RATIO: float = 0.018

# ========================
# Green Marker Detection
# ========================
#
# ตอนนี้ใช้ marker สีเขียวเฉพาะจุดกกหู / tragus เท่านั้น
# ไม่ใช้ marker C7 และ shoulder เพื่อลดปัญหาจุดสลับกัน

ENABLE_GREEN_MARKER_DETECTION: bool = True

# สีเขียว
#GREEN_HSV_LOWER: tuple[int, int, int] = (35, 80, 80)
#GREEN_HSV_UPPER: tuple[int, int, int] = (85, 255, 255)

# ถ้าเปลี่ยนไปใช้สีเหลือง ให้ใช้ประมาณนี้แทน
GREEN_HSV_LOWER: tuple[int, int, int] = (20, 80, 80)
GREEN_HSV_UPPER: tuple[int, int, int] = (35, 255, 255)

GREEN_MARKER_MIN_AREA: int = 40
GREEN_MARKER_MAX_AREA: int = 10000

# ========================
# Alert Timing
# ========================
#
# แจ้งเตือนเมื่อผู้ใช้นั่งผิดท่าต่อเนื่องเกิน 3 นาที
# 3 นาที = 180 วินาที
#
# Logic ใหม่:
# - คอยื่นมี timer แยก
# - ไหล่ห่อมี timer แยก
# - ก่อนครบ 3 นาที ยังนับเป็นท่าทางเหมาะสม
# - ครบ 3 นาทีแล้วจึง alert
# - ถ้ายังผิดท่าต่อ ให้แจ้งเตือนซ้ำทุก 3 นาที
# - ถ้ากลับมาปกติ reset timer ของปัญหานั้นทันที

# ระยะเวลาที่ต้องผิดท่าต่อเนื่องก่อนแจ้งเตือน
ISSUE_ALERT_DURATION: float = 10.0

# ระยะเวลาแจ้งเตือนซ้ำ หากยังผิดท่าต่อเนื่อง
ISSUE_REPEAT_ALERT_INTERVAL: float = 10.0

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
# ตั้งเป็น 180 เพื่อให้ตรงกับ ISSUE_REPEAT_ALERT_INTERVAL
ALERT_COOLDOWN: float = ISSUE_REPEAT_ALERT_INTERVAL

# ========================
# Session Risk Level
# ========================

RISK_LOW_THRESHOLD: float = 0.2
RISK_MEDIUM_THRESHOLD: float = 0.5