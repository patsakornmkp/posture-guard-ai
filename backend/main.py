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
# - เพิ่มจำนวนแจ้งเตือนแยกตามสาเหตุ
# - เพิ่ม LINE binding แบบ multi-user
# - LINE notification ส่งตาม user_id เจ้าของ session ไม่ใช้ LINE_USER_ID global เป็นหลัก

import json
import sqlite3
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

import config
import database as db
import schemas
from classifier import PostureClassifier, Status
from detector import PoseDetector
from notification_service import (
    create_line_link_code,
    get_line_notification_status,
    handle_line_webhook,
    send_test_line_notification,
    set_line_notification_enabled,
)
from state import CameraThread, SessionState


# ========================
# Lifespan — สร้าง/ทำลาย resource
# ========================

detector: Optional[PoseDetector] = None
classifier: Optional[PostureClassifier] = None
session_state: Optional[SessionState] = None
camera_thread: Optional[CameraThread] = None


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
        camera_active=bool(camera_thread and camera_thread.is_running()),
        session_active=bool(session_state and session_state.session_id is not None),
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
    if camera_thread is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Camera thread is not ready",
        )

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
    if camera_thread is not None:
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
    if camera_thread is None or not camera_thread.is_running():
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
    """ส่ง JPEG frame ล่าสุดให้ frontend"""
    if camera_thread is None or not camera_thread.is_running():
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
    if session_state is None or classifier is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session system is not ready",
        )

    user_id = payload.get("user_id")
    planned = payload.get("planned_duration_minutes", 0)

    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="user_id is required",
        )

    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="user_id must be integer",
        )

    if db.get_user_by_id(user_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
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

    classifier.reset()

    return {
        "success": True,
        "session_id": session_id,
        "message": "Session started",
    }


@app.post("/session/stop", response_model=schemas.SessionSummaryResponse)
def stop_session():
    """จบ session และคืน summary"""
    if session_state is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session system is not ready",
        )

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
    if session_state is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session system is not ready",
        )

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
def get_line_status(user_id: Optional[int] = None):
    """
    ตรวจสอบสถานะ LINE Messaging API

    Query:
    - user_id=1  ดูสถานะ LINE ของ user นั้น
    - ไม่ส่ง user_id จะคืนสถานะแบบ global fallback เพื่อรองรับ endpoint เดิม
    """
    try:
        line_status = get_line_notification_status(user_id=user_id)

        return {
            "success": True,
            "line": line_status,
            "message": "LINE notification status loaded",
        }

    except Exception as err:
        return {
            "success": False,
            "line": None,
            "message": "Cannot load LINE notification status",
            "detail": str(err),
        }


@app.post("/notification/line/link-code", response_model=dict)
def create_line_binding_code(payload: dict):
    """
    สร้างรหัสผูกบัญชี LINE ให้ user ปัจจุบัน

    payload:
    {
        "user_id": 1
    }

    Flow:
    - frontend ส่ง user_id ที่ login อยู่มา
    - backend สร้าง code เช่น PG-482913
    - backend คืน line_open_url / qr_payload ให้ frontend เอาไปสร้าง QR
    - user สแกน QR แล้วกดส่งรหัสใน LINE Official Account
    - /line/webhook จะรับ source.userId แล้วบันทึกลง users.line_user_id
    """
    user_id = payload.get("user_id")

    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="user_id is required",
        )

    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="user_id must be integer",
        )

    if db.get_user_by_id(user_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    try:
        result = create_line_link_code(user_id=user_id)
        line = result.get("line") or {}

        return {
            "success": bool(result.get("success")),
            "line": line,
            "line_link_code": result.get("line_link_code") or line.get("line_link_code"),
            "line_link_code_expires_at": (
                result.get("line_link_code_expires_at")
                or line.get("line_link_code_expires_at")
            ),
            "line_open_url": result.get("line_open_url") or line.get("line_open_url"),
            "qr_payload": result.get("qr_payload") or line.get("qr_payload"),
            "message": result.get("message", "LINE link code created"),
        }

    except Exception as err:
        return {
            "success": False,
            "line": None,
            "line_link_code": None,
            "line_link_code_expires_at": None,
            "line_open_url": None,
            "qr_payload": None,
            "message": "Cannot create LINE link code",
            "detail": str(err),
        }


@app.post("/notification/line/enabled", response_model=dict)
def set_line_enabled(payload: dict):
    """
    เปิด/ปิด LINE notification

    payload แบบใหม่:
    {
        "user_id": 1,
        "enabled": true
    }

    payload แบบเก่า:
    {
        "enabled": true
    }

    ถ้ามี user_id จะเปิด/ปิดเฉพาะ user นั้น
    ถ้าไม่มี user_id จะ fallback เป็นระบบ global เดิม
    """
    if "enabled" not in payload or not isinstance(payload.get("enabled"), bool):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="enabled must be boolean",
        )

    raw_user_id = payload.get("user_id")
    user_id: Optional[int] = None

    if raw_user_id is not None:
        try:
            user_id = int(raw_user_id)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="user_id must be integer",
            )

        if db.get_user_by_id(user_id) is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )

    try:
        line_status = set_line_notification_enabled(
            enabled=payload["enabled"],
            user_id=user_id,
        )

        return {
            "success": True,
            "line": line_status,
            "message": "LINE notification enabled updated",
        }

    except Exception as err:
        return {
            "success": False,
            "line": None,
            "message": "Cannot update LINE notification enabled flag",
            "detail": str(err),
        }


@app.post("/notification/test-line", response_model=dict)
def test_line_notification(payload: Optional[dict] = None):
    """
    ส่งข้อความทดสอบ LINE แบบ manual

    payload แบบใหม่:
    {
        "user_id": 1
    }

    ถ้ามี user_id จะส่งหา LINE ของ user นั้นเท่านั้น
    ถ้าไม่มี user_id จะ fallback endpoint เดิม
    """
    payload = payload or {}
    raw_user_id = payload.get("user_id")
    user_id: Optional[int] = None

    if raw_user_id is not None:
        try:
            user_id = int(raw_user_id)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="user_id must be integer",
            )

        if db.get_user_by_id(user_id) is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )

    try:
        result = send_test_line_notification(user_id=user_id)

        return {
            "success": bool(result.get("success")),
            "result": result,
            "message": result.get("message", "LINE test completed"),
        }

    except Exception as err:
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
    - อ่านข้อความที่ผู้ใช้ส่งเข้ามา
    - ถ้าข้อความตรงกับ users.line_link_code ที่ยังไม่หมดอายุ
      จะบันทึก source.userId ลง users.line_user_id ของ user นั้น
    - ตอบกลับ LINE ว่าผูกบัญชีสำเร็จ หรือรหัสผิด/หมดอายุ
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
        return {
            "success": False,
            "signature_valid": None,
            "events_processed": 0,
            "linked_users": [],
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