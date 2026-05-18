# PostureGuard Backend

ระบบตรวจจับและแจ้งเตือนท่าทางส่วนบนที่ไม่เหมาะสมขณะใช้งานคอมพิวเตอร์เพื่อลดความเสี่ยงออฟฟิศซินโดรม

## ฟีเจอร์หลัก

- ตรวจจับ **คอยื่น (Forward Head Posture)** ด้วย Craniovertebral Angle
- ตรวจจับ **หลังคร่อม (Hunched Back)** ด้วย shoulder-hip vertical angle
- แจ้งเตือนเมื่อท่าทางผิดปกติต่อเนื่องเกิน 5 วินาที
- บันทึกประวัติ session ลง SQLite database
- รองรับ multi-user พร้อมระบบ login
- ส่ง video feed พร้อม skeleton overlay ไปยัง frontend

## Tech Stack

- Python 3.9+
- FastAPI
- MediaPipe Pose
- OpenCV
- SQLite

---

## โครงสร้างไฟล์

```
posture-guard/
├── backend/
│   ├── main.py              FastAPI app + endpoints
│   ├── config.py            ค่าคงที่ทั้งหมด
│   ├── schemas.py           Pydantic models
│   ├── detector.py          MediaPipe + คำนวณมุม
│   ├── classifier.py        ตัดสิน status + temporal filter
│   ├── state.py             camera thread + session + calibration
│   ├── database.py          SQLite + queries
│   ├── requirements.txt
│   └── README.md
└── database/
    └── posture.db           (สร้างอัตโนมัติตอนรันครั้งแรก)
```

---

## 1. การติดตั้ง

### สร้าง virtual environment

```bash
cd backend
python -m venv venv
```

### Activate virtual environment

**Windows (PowerShell):**
```powershell
venv\Scripts\Activate.ps1
```

**macOS / Linux:**
```bash
source venv/bin/activate
```

### ติดตั้ง dependencies

```bash
pip install -r requirements.txt
```

**หมายเหตุสำหรับ Raspberry Pi 5:** อาจต้องติดตั้ง system package เพิ่ม

```bash
sudo apt-get update
sudo apt-get install python3-opencv libatlas-base-dev
```

---

## 2. การรัน Backend

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

**flag ที่สำคัญ**

| flag | ความหมาย |
|------|----------|
| `--reload` | รีโหลดอัตโนมัติเมื่อแก้โค้ด (ตัด flag นี้ตอน production) |
| `--host 0.0.0.0` | ให้เครื่องอื่นใน network เรียกได้ |
| `--port 8000` | เปลี่ยนเป็นเลขอื่นได้ถ้า port นี้ถูกใช้ |

### เช็คว่ารันสำเร็จ

เปิด browser ไปที่ `http://localhost:8000` ควรเห็น JSON

```json
{
  "message": "Posture detection backend is running",
  "camera_active": false,
  "session_active": false
}
```

---

## 3. การทดสอบ API

### วิธีที่ 1: FastAPI Swagger UI (แนะนำ)

เปิด `http://localhost:8000/docs` จะเห็นหน้าเอกสาร API ที่ทดสอบได้จาก browser โดยตรง

### วิธีที่ 2: Postman / curl

**สมัคร user**
```bash
curl -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"somchai","password":"pass1234","full_name":"สมชาย"}'
```

**Login**
```bash
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"somchai","password":"pass1234"}'
```

**เปิดกล้อง**
```bash
curl -X POST http://localhost:8000/camera/start
```

**เริ่ม session**
```bash
curl -X POST http://localhost:8000/session/start \
  -H "Content-Type: application/json" \
  -d '{"user_id":1,"planned_duration_minutes":30}'
```

**ดึง posture ปัจจุบัน**
```bash
curl http://localhost:8000/posture/current
```

**Calibrate (ต้องนั่งท่าเหมาะสมก่อนเรียก)**
```bash
curl -X POST http://localhost:8000/calibrate
```

**จบ session**
```bash
curl -X POST http://localhost:8000/session/stop
```

---

## 4. API Endpoints ทั้งหมด

| Method | Endpoint | หน้าที่ |
|--------|----------|---------|
| GET | `/` | เช็คสถานะ backend |
| POST | `/auth/register` | สมัคร user |
| POST | `/auth/login` | Login |
| POST | `/camera/start` | เปิดกล้อง |
| POST | `/camera/stop` | ปิดกล้อง |
| GET | `/posture/current` | ดึงผลล่าสุด (frontend polling) |
| GET | `/video/frame` | ดึง JPEG ล่าสุด (frontend refresh) |
| POST | `/calibrate` | บันทึก baseline |
| POST | `/session/start` | เริ่ม session |
| POST | `/session/stop` | จบ session |
| GET | `/session/summary` | ดู summary ปัจจุบัน |
| GET | `/history/sessions/{user_id}` | ประวัติ session ทั้งหมด |
| GET | `/history/session/{session_id}/logs` | logs ของ session เดียว |

---

## 5. การใช้งานจริง

**Flow การใช้งาน**

1. User สมัคร / login → ได้ `user_id`
2. Frontend เรียก `POST /camera/start` → เปิดกล้อง
3. User นั่งท่าเหมาะสม → เรียก `POST /calibrate` → บันทึก baseline
4. เริ่มทำงาน → เรียก `POST /session/start` ด้วย `user_id`
5. Frontend polling `GET /posture/current` ทุกวินาทีเพื่อ update UI
6. Frontend refresh `GET /video/frame` ทุก 200ms เพื่อแสดงภาพ
7. จบการทำงาน → เรียก `POST /session/stop` → ได้ summary
8. ดูประวัติย้อนหลัง → เรียก `GET /history/sessions/{user_id}`

---

## 6. การปรับค่า Threshold

แก้ไขในไฟล์ `config.py`

### คอยื่น (CVA)

```python
FORWARD_HEAD_GOOD_THRESHOLD = 50.0    # >= 50 = good
FORWARD_HEAD_BAD_THRESHOLD = 48.0     # < 48 = bad
FORWARD_HEAD_SEVERE_THRESHOLD = 45.0  # < 45 = severe
```

ยิ่งค่าน้อย = ยอมให้คอยื่นได้มากขึ้น (ผ่อนปรน)

### หลังคร่อม

```python
HUNCHED_BACK_WARNING_THRESHOLD = 10.0  # > 10 = warning
HUNCHED_BACK_BAD_THRESHOLD = 20.0      # > 20 = bad
```

ยิ่งค่ามาก = ยอมให้หลังโค้งได้มากขึ้น

### Temporal Filter

```python
BAD_POSTURE_DURATION = 5.0  # วินาทีก่อนจะ alert
GRACE_PERIOD = 2.0          # ยอมให้กลับมาดีชั่วคราว
ALERT_COOLDOWN = 10.0       # รอระหว่าง alert
```

---

## 7. การเปลี่ยน Camera

แก้ไขในไฟล์ `config.py`

```python
CAMERA_INDEX = 0        # 0 = กล้องแรก, 1 = กล้องที่สอง
CAMERA_WIDTH = 640
CAMERA_HEIGHT = 480
CAMERA_FPS = 30
```

**วิธีหา index ของกล้อง (Linux/macOS)**
```bash
ls /dev/video*
```

**ทดสอบกล้องตรง ๆ**
```python
import cv2
cap = cv2.VideoCapture(0)   # ลองเปลี่ยน 0 → 1, 2, ...
ret, frame = cap.read()
print("OK" if ret else "FAIL")
cap.release()
```

---

## 8. ตำแหน่งกล้องที่แนะนำ

เพื่อให้ระบบตรวจจับได้ดีที่สุด ให้วางกล้องตามนี้

- **ระยะ** 60-100 ซม. จากตัว
- **มุม** ด้านข้าง (ถ่ายจากซ้าย/ขวา) เพื่อให้เห็นทั้งคอและหลังชัดเจน
- **ความสูง** ประมาณระดับไหล่
- **แสง** สว่างเพียงพอ ไม่ย้อน

ถ้าวางกล้องตรงหน้า (frontal view) จะยังใช้งานได้ แต่การวัด CVA และ hunched angle จะแม่นยำน้อยลงเพราะ MediaPipe ประมาณความลึกจากภาพ 2D

---

## 9. ข้อจำกัดของระบบ

1. **ไม่ใช่เครื่องมือทางการแพทย์** — ไม่สามารถใช้วินิจฉัย kyphosis หรือ forward head posture ทางคลินิก ใช้เพื่อสร้างความตระหนักในการใช้งานคอมพิวเตอร์เท่านั้น

2. **Hunched back เป็น proxy** — ระบบวัด shoulder-hip vertical angle ซึ่งสะท้อน trunk flexion ไม่ใช่ thoracic kyphosis โดยตรง (ต้องใช้ X-ray หา Cobb angle)

3. **ต้องการแสงเพียงพอ** — MediaPipe ต้องการภาพที่ contrast ดี ถ้าแสงน้อยเกินไปจะตรวจจับ landmark ไม่แม่น

4. **วัด 2D** — ระบบใช้ภาพ 2D ความแม่นยำของมุมขึ้นกับมุมกล้อง ไม่ใช่การวัดแบบ 3D จริง

5. **Single user per session** — ระบบออกแบบสำหรับ 1 คนต่อ session ถ้ามีหลายคนในเฟรมจะใช้คนที่ชัดที่สุด

6. **เก็บข้อมูลในเครื่อง** — ฐานข้อมูล SQLite อยู่ในเครื่องที่รัน backend ไม่ได้ backup อัตโนมัติ

---

## 10. Troubleshooting

**ปัญหา: "Cannot open camera"**
- เช็คว่ากล้องเสียบอยู่จริง `ls /dev/video*`
- ลองเปลี่ยน `CAMERA_INDEX` ใน config.py
- ตรวจสอบว่าไม่มีโปรแกรมอื่นใช้กล้องอยู่

**ปัญหา: MediaPipe ตรวจจับไม่เจอคน**
- เช็คแสงในห้อง
- ขยับให้เห็นตัวชัดขึ้น (ไหล่ + ศีรษะต้องอยู่ในเฟรม)
- ลดค่า `MP_MIN_DETECTION_CONFIDENCE` ใน config.py

**ปัญหา: ช้าเมื่อรันบน Raspberry Pi 5**
- ลด `CAMERA_WIDTH` / `CAMERA_HEIGHT` เหลือ 320x240
- ลด `CAMERA_FPS` เหลือ 15

**ปัญหา: `ImportError: numpy.core.multiarray failed`**
- ติดตั้ง numpy version ที่ compatible กับ mediapipe
- `pip install numpy==1.26.4 --force-reinstall`

---

## License

โปรเจกต์นักศึกษา — สร้างเพื่อการศึกษา ไม่ใช่การใช้งานเชิงพาณิชย์