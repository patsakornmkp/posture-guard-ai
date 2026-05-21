# PostureGuard AI Backend

ระบบตรวจจับท่านั่งส่วนบนแบบ realtime เพื่อลดความเสี่ยง Office Syndrome โดยใช้กล้องร่วมกับ MediaPipe Pose และ FastAPI

ระบบนี้เน้นตรวจ 2 ปัญหาหลักเท่านั้น:

- **คอยื่น (Forward Head Posture)** ด้วยค่า **CVA — Craniovertebral Angle**
- **ไหล่ห่อ (Rounded Shoulder Posture)** ด้วยค่า **FSA — Forward Shoulder Angle**

> เวอร์ชันปัจจุบันไม่ใช้ hunched back / kyphosis เป็น logic หลักของระบบแล้ว

---

## ฟีเจอร์หลัก

- ตรวจจับท่านั่งแบบ realtime ผ่านกล้อง
- ใช้ MediaPipe Pose ตรวจ landmark ของร่างกายส่วนบน
- คำนวณมุม CVA และ FSA เพื่อประเมินคอยื่นและไหล่ห่อ
- มีระบบ Calibration เพื่อบันทึก baseline จากท่านั่งที่ถูกต้องของผู้ใช้
- แจ้งเตือนเมื่อผู้ใช้นั่งผิดท่าต่อเนื่องครบเวลาที่กำหนดใน `config.py`
- แยก timer และจำนวนแจ้งเตือนของคอยื่น / ไหล่ห่อ
- ส่ง alert ไปยัง frontend เพื่อแสดง browser alert/sound
- ส่ง LINE Messaging API เฉพาะตอน alert trigger จริง หรือครบ repeat interval เท่านั้น
- ถ้า LINE ส่งไม่สำเร็จ backend จะไม่ crash และ browser alert/sound ยังทำงานต่อ
- บันทึก session, posture logs และ alert history ลง SQLite
- รองรับระบบ login/register แบบ local user
- ดู summary และ history ย้อนหลังได้

---

## Tech Stack

- Python 3.9+
- FastAPI
- MediaPipe Pose
- OpenCV
- SQLite
- Pydantic
- HTML / CSS / JavaScript frontend เรียก API ด้วย `fetch`
- LINE Messaging API สำหรับแจ้งเตือนมือถือ

---

## โครงสร้างไฟล์หลัก

```text
posture-guard-ai-main/
├── backend/
│   ├── main.py                  FastAPI app และ endpoints หลัก
│   ├── config.py                ค่าคงที่ เช่น camera, threshold, alert duration, LINE config
│   ├── detector.py              MediaPipe Pose, landmark detection, CVA/FSA calculation
│   ├── classifier.py            ตัดสินสถานะ good/bad และจัดการ timer/alert
│   ├── state.py                 camera thread, session state, calibration state, LINE trigger
│   ├── database.py              SQLite tables, users, sessions, logs, alerts
│   ├── schemas.py               Pydantic request/response models
│   ├── notification_service.py  LINE push message, duplicate guard, webhook/userId
│   ├── requirements.txt
│   └── README.md
├── frontend/
│   ├── pages/                   login, register, setup, monitoring, summary, history
│   ├── js/                      frontend logic แยกตามหน้า
│   └── css/                     stylesheet แยกตามหน้า
└── database/
    └── posture.db               สร้างอัตโนมัติเมื่อรัน backend ครั้งแรก