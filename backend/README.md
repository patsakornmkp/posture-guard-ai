# PostureGuard AI Backend

Backend ของระบบ **PostureGuard AI** สำหรับตรวจจับท่านั่งด้านข้างแบบ realtime ด้วยกล้องและ MediaPipe Pose

ระบบนี้ใช้สำหรับตรวจจับความเสี่ยงหลัก 2 ประเภท:

1. **Forward Head Posture** — ภาวะคอยื่น  
   ตรวจจากค่า **CVA (Craniovertebral Angle)**

2. **Rounded Shoulder Posture** — ภาวะไหล่ห่อ  
   ตรวจจากค่า **FSA (Forward Shoulder Angle)**

> เวอร์ชันปัจจุบันไม่ใช้ Calibration / Baseline แล้ว  
> ไม่มี endpoint `/calibrate`  
> ไม่ใช้ hunched back / kyphosis เป็น logic หลักของระบบ

---

## Tech Stack

- Python
- FastAPI
- MediaPipe Pose
- OpenCV
- SQLite
- LINE Messaging API

---

## โครงสร้าง Backend หลัก

```txt
backend/
├── main.py                  # FastAPI routes / endpoints
├── config.py                # ค่าคอนฟิกของระบบ
├── detector.py              # ตรวจจับ landmark และคำนวณ CVA / FSA
├── classifier.py            # แยกสถานะ good / bad / paused / no_person
├── state.py                 # Camera thread และ session state
├── database.py              # SQLite schema และ query helper
├── schemas.py               # Pydantic response schema
├── notification_service.py  # LINE Messaging API
├── requirements.txt
├── .env.example
└── posture_guard.db