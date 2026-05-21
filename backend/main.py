# main.py
# FastAPI application — รวมทุก endpoint ของระบบ PostureGuard
#
# รันด้วย:
#   uvicorn main:app --reload --host 0.0.0.0 --port 8000
#
# เปิดเอกสาร API ที่: http://localhost:8000/docs
#
# เวอร์ชันนี้:
# - ใช้ CVA สำหรับภาวะคอยื่น
# - ใช้ FSA สำหรับภาวะไหล่ห่อ
# - ไม่ใช้ Calibration / Baseline แล้ว
# - ไม่ใช้ hunched back / kyphosis เป็น logic หลัก
# - realtime session mode: ไม่กำหนดเวลาล่วงหน้า
# - เวลาแจ้งเตือนเมื่อผิดท่าต่อเนื่องอยู่ใน config.py
# - ส่งค่า timer/alert แยกคอยื่นและไหล่ห่อออกไปที่ /posture/current
# - เพิ่มจำนวนแจ้งเตือนแยกตามสาเหตุ:
#   forward_head_alert_count
#   rounded_shoulder_alert_count
#   alert_count
# - เพิ่ม LINE webhook/status/test endpoint

import json
import sqlite3
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

import config
import database as db
import schemas
from detector import PoseDetector
from classifier import PostureClassifier, Status
from state import CameraThread, SessionState
from notification_service import (
    get_line_notification_status,
    handle_line_webhook,
    send_test_line_notification,
)


# ========================
# Lifespan — สร้าง/ทำลาย resource
# ========================

detector: PoseDetector = None
classifier: PostureClassifier = None
session_state: SessionState = None
camera_thread: CameraThread = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    ทำงานตอน startup และ shutdown

    startup:
    - สร้าง database
    - สร้าง detector
    - สร้าง classifier
    - สร้าง session state
    - สร้าง camera thread

    shutdown:
    - ปิดกล้อง
    - ปิด MediaPipe
    """
    global detector, classifier, session_state, camera_thread

    # Startup
    db.init_database()

    detector = PoseDetector()
    classifier = PostureClassifier()
    session_state = SessionState()

    camera_thread = CameraThread(
        detector=detector,
        classifier=classifier,
        session=session_state,
    )

    print("✓ PostureGuard backend started")

    yield

    # Shutdown
    if camera_thread is not None:
        camera_thread.stop()

    if detector is not None:
        detector.close()

    print("✓ PostureGuard backend stopped")


# ========================
# FastAPI app
# ========================

app = FastAPI(
    title="PostureGuard API",
    description=(
        "ระบบตรวจจับและแจ้งเตือนภาวะคอยื่นและไหล่ห่อ"
        "ขณะใช้งานคอมพิวเตอร์"
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# เปิด CORS ให้ frontend เรียก API ได้ใน development mode
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========================
# Health check
# ========================

@app.get("/", response_model=schemas.HealthResponse)
def health_check():
    """ตรวจสอบว่า backend ทำงานอยู่"""
    return schemas.HealthResponse(
        message="Posture detection backend is running",
        camera_active=camera_thread.is_running(),
        session_active=session_state.session_id is not None,
    )


# ========================
# Auth endpoints
# ========================

@app.post("/auth/register", response_model=dict)
def register(payload: dict):
    """
    สมัคร user ใหม่

    payload:
    {
        "username": "...",
        "password": "...",
        "full_name": "..."
    }
    """
    username = payload.get("username", "").strip()
    password = payload.get("password", "")
    full_name = payload.get("full_name", "").strip()

    if not username or not password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username and password are required",
        )

    try:
        user_id = db.create_user(username, password, full_name)

        return {
            "success": True,
            "user_id": user_id,
            "message": f"User '{username}' created successfully",
        }

    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already exists",
        )


@app.post("/auth/login", response_model=dict)
def login(payload: dict):
    """
    เข้าสู่ระบบ

    payload:
    {
        "username": "...",
        "password": "..."
    }
    """
    username = payload.get("username", "").strip()
    password = payload.get("password", "")

    user = db.authenticate(username, password)

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    return {
        "success": True,
        "user": user,
    }


# ========================
# Camera endpoints
# ========================

@app.post("/camera/start", response_model=schemas.CameraStatusResponse)
def start_camera():
    """เริ่มเปิดกล้องและเริ่ม thread ประมวลผล"""
    success = camera_thread.start()

    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Cannot open camera (index={config.CAMERA_INDEX})",
        )

    return schemas.CameraStatusResponse(
        success=True,
        message="Camera started",
        camera_active=True,
    )


@app.post("/camera/stop", response_model=schemas.CameraStatusResponse)
def stop_camera():
    """หยุดกล้อง"""
    camera_thread.stop()

    return schemas.CameraStatusResponse(
        success=True,
        message="Camera stopped",
        camera_active=False,
    )


# ========================
# Posture / Video endpoints
# ========================

@app.get("/posture/current", response_model=schemas.PostureResponse)
def get_current_posture():
    """
    ดึงผล posture ล่าสุด

    frontend จะ polling endpoint นี้เป็นระยะ
    เพื่อเอาค่า CVA/FSA, สถานะ posture,
    timer แยกคอยื่น/ไหล่ห่อ และสถานะ alert ไปแสดงผล
    """
    if not camera_thread.is_running():
        return schemas.PostureResponse(
            status=schemas.PostureStatus.NO_PERSON_DETECTED,
            cva_angle=None,
            fsa_angle=None,
            is_forward_head=False,
            is_rounded_shoulder=False,
            bad_posture_duration=0.0,
            alert=False,
            message="Camera is not active",

            forward_head_duration=0.0,
            rounded_shoulder_duration=0.0,
            forward_head_alert=False,
            rounded_shoulder_alert=False,
            forward_head_alert_active=False,
            rounded_shoulder_alert_active=False,
        )

    classification = camera_thread.get_latest_classification()
    detection = camera_thread.get_latest_detection()

    # ยังไม่มีผลเลย เช่น กล้องเพิ่งเปิดและยังไม่ process frame แรก
    if classification is None or detection is None:
        return schemas.PostureResponse(
            status=schemas.PostureStatus.NO_PERSON_DETECTED,
            cva_angle=None,
            fsa_angle=None,
            is_forward_head=False,
            is_rounded_shoulder=False,
            bad_posture_duration=0.0,
            alert=False,
            message="Initializing...",

            forward_head_duration=0.0,
            rounded_shoulder_duration=0.0,
            forward_head_alert=False,
            rounded_shoulder_alert=False,
            forward_head_alert_active=False,
            rounded_shoulder_alert_active=False,
        )

    status_mapping = {
        Status.GOOD: schemas.PostureStatus.GOOD,
        Status.BAD: schemas.PostureStatus.BAD,
        Status.PAUSED: schemas.PostureStatus.PAUSED,
        Status.NO_PERSON: schemas.PostureStatus.NO_PERSON_DETECTED,
    }

    return schemas.PostureResponse(
        status=status_mapping.get(
            classification.status,
            schemas.PostureStatus.NO_PERSON_DETECTED,
        ),
        cva_angle=detection.cva_angle,
        fsa_angle=detection.fsa_angle,

        is_forward_head=classification.is_forward_head,
        is_rounded_shoulder=classification.is_rounded_shoulder,

        bad_posture_duration=classification.bad_posture_duration,
        alert=classification.alert,
        message=classification.message,

        forward_head_duration=getattr(
            classification,
            "forward_head_duration",
            0.0,
        ),
        rounded_shoulder_duration=getattr(
            classification,
            "rounded_shoulder_duration",
            0.0,
        ),

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


@app.get("/video/frame")
def get_video_frame():
    """
    ส่ง JPEG frame ล่าสุดให้ frontend

    frontend สามารถเรียก endpoint นี้ซ้ำ ๆ
    เพื่อ refresh ภาพจากกล้อง
    """
    if not camera_thread.is_running():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Camera is not active",
        )

    jpeg_bytes = camera_thread.get_latest_frame_jpeg()

    if jpeg_bytes is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No frame available yet",
        )

    return Response(
        content=jpeg_bytes,
        media_type="image/jpeg",
    )


# ========================
# Session endpoints
# ========================

@app.post("/session/start", response_model=dict)
def start_session(payload: dict):
    """
    เริ่ม session ใหม่

    payload:
    {
        "user_id": 1,
        "planned_duration_minutes": 0
    }
    """
    user_id = payload.get("user_id")
    planned = payload.get("planned_duration_minutes", 0)

    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="user_id is required",
        )

    if session_state.session_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A session is already active. Stop it first.",
        )

    session_id = session_state.start(
        user_id=user_id,
        planned_minutes=planned,
    )

    # reset temporal filter ให้เริ่มนับใหม่ทุก session
    classifier.reset()

    return {
        "success": True,
        "session_id": session_id,
        "message": "Session started",
    }


@app.post("/session/stop", response_model=schemas.SessionSummaryResponse)
def stop_session():
    """จบ session และคืน summary"""
    if session_state.session_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No active session",
        )

    summary = session_state.stop()

    return _summary_to_response(
        summary,
        session_active=False,
    )


@app.get("/session/summary", response_model=schemas.SessionSummaryResponse)
def get_session_summary():
    """ดู summary ปัจจุบันของ session ที่กำลังทำงาน"""
    summary = session_state.get_summary()

    return _summary_to_response(
        summary,
        session_active=summary["session_active"],
    )


# ========================
# History endpoints
# ========================

@app.get("/history/sessions/{user_id}")
def get_user_history(user_id: int, limit: int = 50):
    """ดึงประวัติ session ของ user"""
    sessions = db.get_user_sessions(user_id, limit)

    return {
        "sessions": sessions,
    }


@app.get("/history/session/{session_id}/logs")
def get_session_logs(session_id: int):
    """ดึง posture logs และ alerts ของ session เดียว"""
    logs = db.get_session_logs(session_id)
    alerts = db.get_session_alerts(session_id)

    return {
        "logs": logs,
        "alerts": alerts,
    }


# ========================
# LINE notification endpoints
# ========================

@app.get("/notification/line/status", response_model=dict)
def get_line_status():
    """
    ตรวจสอบสถานะ LINE Messaging API

    ใช้สำหรับเช็คว่า backend อ่านค่า LINE จาก backend/.env ได้ครบหรือไม่
    โดยไม่เปิดเผย channel access token / channel secret ออกไปใน response
    """
    try:
        line_status = get_line_notification_status()

        return {
            "success": True,
            "line": line_status,
            "message": "LINE notification status loaded",
        }

    except Exception as err:
        # ห้ามให้ปัญหา LINE ทำให้ backend หลักล้ม
        return {
            "success": False,
            "line": None,
            "message": "Cannot load LINE notification status",
            "detail": str(err),
        }


@app.post("/notification/test-line", response_model=dict)
def test_line_notification():
    """
    ส่งข้อความทดสอบ LINE แบบ manual

    endpoint นี้ใช้ force=True ภายใน notification_service
    เพื่อทดสอบว่าส่ง push message ได้จริงหรือไม่
    โดยไม่เกี่ยวกับ timer ของ classifier และไม่บันทึกเป็น posture alert
    """
    try:
        result = send_test_line_notification()

        return {
            "success": bool(result.get("success")),
            "result": result,
            "message": result.get("message", "LINE test completed"),
        }

    except Exception as err:
        # LINE ล้มเหลวต้องไม่ทำให้ browser/backend crash
        return {
            "success": False,
            "result": None,
            "message": "LINE test notification failed",
            "detail": str(err),
        }


@app.post("/line/webhook", response_model=dict)
async def line_webhook(
    request: Request,
    x_line_signature: str = Header(default="", alias="x-line-signature"),
):
    """
    รับ webhook จาก LINE Messaging API

    ใช้สำหรับ:
    - ตรวจสอบ signature จาก LINE ถ้า LINE_VERIFY_WEBHOOK_SIGNATURE=true
    - ดึง source.userId จาก event
    - บันทึก LINE_USER_ID ลง backend/.env อัตโนมัติ

    หมายเหตุ:
    - ต้องใช้ raw body เดิมในการตรวจ signature
    - ถ้า LINE webhook ผิดพลาด จะตอบ error แบบควบคุมได้ ไม่ปล่อยให้ backend crash
    """
    raw_body = await request.body()

    try:
        payload = json.loads(raw_body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid JSON payload from LINE webhook",
        )

    verify_signature = bool(
        getattr(config, "LINE_VERIFY_WEBHOOK_SIGNATURE", True)
    )

    try:
        result = handle_line_webhook(
            payload=payload,
            raw_body=raw_body,
            signature=x_line_signature,
            verify_signature=verify_signature,
        )
    except Exception as err:
        # กันไม่ให้ webhook ทำ backend หลัก crash
        return {
            "success": False,
            "signature_valid": None,
            "user_ids": [],
            "saved_user_id": None,
            "message": "LINE webhook handling failed",
            "detail": str(err),
        }

    if verify_signature and not result.get("success"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=result,
        )

    return result


# ========================
# Helper
# ========================

def _summary_to_response(
    summary: dict,
    session_active: bool,
) -> schemas.SessionSummaryResponse:
    """แปลง dict summary เป็น Pydantic response"""

    status_mapping = {
        "good": schemas.PostureStatus.GOOD,
        "bad": schemas.PostureStatus.BAD,
        "paused": schemas.PostureStatus.PAUSED,
        "no_person_detected": schemas.PostureStatus.NO_PERSON_DETECTED,
        "marker_not_detected": schemas.PostureStatus.MARKER_NOT_DETECTED,
    }

    risk_mapping = {
        "low": schemas.RiskLevel.LOW,
        "medium": schemas.RiskLevel.MEDIUM,
        "high": schemas.RiskLevel.HIGH,
    }

    return schemas.SessionSummaryResponse(
        session_active=session_active,
        planned_duration_minutes=summary.get("planned_duration_minutes"),
        actual_duration_seconds=summary["actual_duration_seconds"],
        effective_seated_seconds=summary["effective_seated_seconds"],

        good_posture_seconds=summary["good_posture_seconds"],
        bad_posture_seconds=summary["bad_posture_seconds"],

        forward_head_seconds=summary["forward_head_seconds"],
        rounded_shoulder_seconds=summary["rounded_shoulder_seconds"],

        forward_head_alert_count=summary.get(
            "forward_head_alert_count",
            0,
        ),
        rounded_shoulder_alert_count=summary.get(
            "rounded_shoulder_alert_count",
            0,
        ),

        alert_count=summary["alert_count"],
        bad_posture_ratio=summary["bad_posture_ratio"],

        current_status=status_mapping.get(
            summary["current_status"],
            schemas.PostureStatus.NO_PERSON_DETECTED,
        ),
        risk_level=risk_mapping.get(
            summary["risk_level"],
            schemas.RiskLevel.LOW,
        ),
    )