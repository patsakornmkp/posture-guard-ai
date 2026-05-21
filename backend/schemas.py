# schemas.py
# Pydantic models สำหรับ request และ response ของทุก API endpoint
#
# เวอร์ชันนี้:
# - ใช้ CVA สำหรับภาวะคอยื่น
# - ใช้ FSA สำหรับภาวะไหล่ห่อ
# - ไม่ใช้ Calibration / Baseline แล้ว
# - ลบ field ที่เกี่ยวกับหลังคร่อม / kyphosis / hunched back ออก
# - เพิ่มจำนวนแจ้งเตือนแยกตามสาเหตุ: คอยื่น / ไหล่ห่อ
# - เพิ่ม timer/alert แยกคอยื่นและไหล่ห่อใน /posture/current
# - รองรับสถานะ marker_not_detected เผื่อใช้สติกเกอร์สีเขียวในอนาคต

from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum


# ========================
# Enums
# ========================

class PostureStatus(str, Enum):
    GOOD = "good"
    BAD = "bad"
    PAUSED = "paused"
    NO_PERSON_DETECTED = "no_person_detected"
    MARKER_NOT_DETECTED = "marker_not_detected"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


# ========================
# GET /posture/current
# ========================

class PostureResponse(BaseModel):
    status: PostureStatus = Field(
        ...,
        description="สถานะท่าทางปัจจุบัน"
    )

    cva_angle: Optional[float] = Field(
        None,
        description="มุม CVA ปัจจุบันสำหรับประเมินภาวะคอยื่น (องศา)"
    )

    fsa_angle: Optional[float] = Field(
        None,
        description="มุม FSA ปัจจุบันสำหรับประเมินภาวะไหล่ห่อ (องศา)"
    )

    is_forward_head: bool = Field(
        False,
        description="มุม CVA ปัจจุบันอยู่ในเกณฑ์คอยื่นหรือไม่"
    )

    is_rounded_shoulder: bool = Field(
        False,
        description="มุม FSA ปัจจุบันอยู่ในเกณฑ์ไหล่ห่อหรือไม่"
    )

    bad_posture_duration: float = Field(
        0.0,
        description="เวลาผิดท่าต่อเนื่องที่มากที่สุดระหว่างคอยื่นและไหล่ห่อ (วินาที)"
    )

    alert: bool = Field(
        False,
        description="มีการแจ้งเตือนในรอบนี้หรือไม่"
    )

    message: str = Field(
        ...,
        description="ข้อความอธิบายสถานะ"
    )

    # ========================
    # Per-issue timer
    # ========================

    forward_head_duration: float = Field(
        0.0,
        description="เวลาที่คอยื่นต่อเนื่องในรอบปัจจุบัน (วินาที)"
    )

    rounded_shoulder_duration: float = Field(
        0.0,
        description="เวลาที่ไหล่ห่อต่อเนื่องในรอบปัจจุบัน (วินาที)"
    )

    # ========================
    # Per-issue alert event
    # ========================

    forward_head_alert: bool = Field(
        False,
        description="รอบนี้มีการแจ้งเตือนคอยื่นหรือไม่"
    )

    rounded_shoulder_alert: bool = Field(
        False,
        description="รอบนี้มีการแจ้งเตือนไหล่ห่อหรือไม่"
    )

    # ========================
    # Per-issue active state
    # ========================

    forward_head_alert_active: bool = Field(
        False,
        description="คอยื่นต่อเนื่องเกินเวลาที่กำหนดแล้ว และยังไม่กลับมาปกติ"
    )

    rounded_shoulder_alert_active: bool = Field(
        False,
        description="ไหล่ห่อต่อเนื่องเกินเวลาที่กำหนดแล้ว และยังไม่กลับมาปกติ"
    )


# ========================
# POST /session/start
# ========================

class SessionStartRequest(BaseModel):
    planned_duration_minutes: int = Field(
        0,
        ge=0,
        le=480,
        description="ระยะเวลาที่วางแผนจะนั่ง (นาที), 0 หมายถึง realtime mode / ไม่จำกัดเวลา"
    )


# ========================
# GET /session/summary
# POST /session/stop
# ========================

class SessionSummaryResponse(BaseModel):
    session_active: bool = Field(
        ...,
        description="session กำลังทำงานอยู่หรือไม่"
    )

    planned_duration_minutes: Optional[int] = Field(
        None,
        description="ระยะเวลาที่วางแผน (นาที), 0 หมายถึง realtime mode"
    )

    actual_duration_seconds: float = Field(
        0.0,
        description="ระยะเวลาจริงทั้งหมด (วินาที)"
    )

    effective_seated_seconds: float = Field(
        0.0,
        description="เวลาที่ระบบตรวจเจอคน (วินาที)"
    )

    good_posture_seconds: float = Field(
        0.0,
        description="เวลาที่นับเป็นท่าทางเหมาะสม (วินาที)"
    )

    bad_posture_seconds: float = Field(
        0.0,
        description="เวลาที่ท่าทางผิดปกติหลังมี alert active แล้ว (วินาที)"
    )

    forward_head_seconds: float = Field(
        0.0,
        description="เวลาคอยื่นสะสมหลังคอยื่นเกินเวลาที่กำหนดแล้ว (วินาที)"
    )

    rounded_shoulder_seconds: float = Field(
        0.0,
        description="เวลาไหล่ห่อสะสมหลังไหล่ห่อเกินเวลาที่กำหนดแล้ว (วินาที)"
    )

    forward_head_alert_count: int = Field(
        0,
        description="จำนวนครั้งที่แจ้งเตือนภาวะคอยื่น"
    )

    rounded_shoulder_alert_count: int = Field(
        0,
        description="จำนวนครั้งที่แจ้งเตือนภาวะไหล่ห่อ"
    )

    bad_posture_ratio: float = Field(
        0.0,
        description="สัดส่วนเวลาท่าทางผิดปกติหลังมี alert active แล้ว (0.0 - 1.0)"
    )

    alert_count: int = Field(
        0,
        description="จำนวนครั้งที่แจ้งเตือนรวม"
    )

    current_status: PostureStatus = Field(
        ...,
        description="สถานะท่าทางล่าสุด"
    )

    risk_level: RiskLevel = Field(
        ...,
        description="ระดับความเสี่ยงของ session นี้"
    )


# ========================
# POST /camera/start
# POST /camera/stop
# ========================

class CameraStatusResponse(BaseModel):
    success: bool = Field(
        ...,
        description="คำสั่งสำเร็จหรือไม่"
    )

    message: str = Field(
        ...,
        description="ข้อความอธิบายผล"
    )

    camera_active: bool = Field(
        ...,
        description="กล้องทำงานอยู่หรือไม่"
    )


# ========================
# GET /
# ========================

class HealthResponse(BaseModel):
    message: str = Field(
        ...,
        description="สถานะของ backend"
    )

    camera_active: bool = Field(
        ...,
        description="กล้องทำงานอยู่หรือไม่"
    )

    session_active: bool = Field(
        ...,
        description="session ทำงานอยู่หรือไม่"
    )