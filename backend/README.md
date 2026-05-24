# PostureGuard AI Backend

Backend สำหรับระบบ PostureGuard AI

- Framework: FastAPI
- Pose Detection: MediaPipe Pose
- Image Processing: OpenCV
- Database: SQLite
- Notification: Browser Notification, Sound Alert, LINE Messaging API
- Posture Logic:
  - CVA สำหรับตรวจภาวะคอยื่น
  - FSA สำหรับตรวจภาวะไหล่ห่อ
  - ไม่มี Calibration / Baseline
  - ไม่มี hunched back / kyphosis

---

## 1. การรัน Backend

```bash
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000