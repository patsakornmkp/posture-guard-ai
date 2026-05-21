# detector.py
# ใช้ MediaPipe Pose ตรวจจับ landmark และคำนวณมุม CVA + FSA
#
# เวอร์ชันใหม่:
# - CVA ใช้ประเมินภาวะคอยื่น
# - FSA ใช้ประเมินภาวะไหล่ห่อ
# - ไม่ใช้ hip landmark เป็นเงื่อนไขหลัก
# - ไม่ตรวจหลังคร่อม / hunched back แล้ว
# - รองรับ marker สีเขียวเป็นจุดหลักสำหรับ Tragus, C7, Shoulder
# - ถ้า marker ไม่ครบ จะ fallback กลับไปใช้ MediaPipe + estimated C7
# - เลือก landmark ตามฝั่งกล้องจาก config.CAMERA_SIDE
# - วาด overlay ให้เห็นเส้นอ้างอิง:
#   CVA = เส้นแนวนอนผ่าน C7 + เส้น C7 -> Tragus
#   FSA = เส้นแนวนอนผ่านหัวไหล่ + เส้น Shoulder -> C7
# - เส้นแนวนอนอ้างอิงทั้ง 2 เส้นเป็นสีเหลือง เส้นบาง
# - ไม่แสดงตัวเลขมุมบนภาพ เพื่อลดความรกของหน้าจอ

import math
from typing import Optional
from dataclasses import dataclass

import cv2
import numpy as np
import mediapipe as mp

try:
    from . import config
except ImportError:
    import config


# ========================
# Data classes
# ========================

@dataclass
class Point:
    """จุดบนภาพในหน่วย pixel"""
    x: float
    y: float
    visibility: float = 1.0


@dataclass
class DetectionResult:
    """ผลการตรวจจับจาก 1 frame"""
    person_detected: bool
    cva_angle: Optional[float] = None
    fsa_angle: Optional[float] = None
    annotated_frame: Optional[np.ndarray] = None


# ========================
# Pose Detector
# ========================

class PoseDetector:
    """MediaPipe Pose Detector สำหรับ PostureGuard"""

    # MediaPipe Pose landmark index
    LEFT_EAR = 7
    RIGHT_EAR = 8
    LEFT_SHOULDER = 11
    RIGHT_SHOULDER = 12

    def __init__(self) -> None:
        self.mp_pose = mp.solutions.pose

        self.pose = self.mp_pose.Pose(
            static_image_mode=False,
            model_complexity=1,
            smooth_landmarks=True,
            enable_segmentation=False,
            min_detection_confidence=config.MP_MIN_DETECTION_CONFIDENCE,
            min_tracking_confidence=config.MP_MIN_TRACKING_CONFIDENCE,
        )

        # เก็บจุดที่ smooth แล้ว
        self._smoothed_points: dict[str, Point] = {}

        # เก็บ side ล่าสุด เพื่อกัน smoothing ซ้าย/ขวาปนกัน
        self._last_side: Optional[str] = None

    def close(self) -> None:
        """ปิด MediaPipe resources"""
        self.pose.close()

    def process(self, frame: np.ndarray) -> DetectionResult:
        """
        ประมวลผล 1 frame แล้วคืน DetectionResult
        """
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb_frame.flags.writeable = False
        results = self.pose.process(rgb_frame)
        rgb_frame.flags.writeable = True

        annotated = frame.copy()

        if not results.pose_landmarks:
            self._smoothed_points.clear()
            self._last_side = None

            return DetectionResult(
                person_detected=False,
                annotated_frame=annotated,
            )

        h, w = frame.shape[:2]
        landmarks = results.pose_landmarks.landmark

        points = self._extract_points(landmarks, w, h)
        side = self._pick_visible_side_set(points)

        if side is None:
            self._smoothed_points.clear()
            self._last_side = None

            return DetectionResult(
                person_detected=True,
                cva_angle=None,
                fsa_angle=None,
                annotated_frame=annotated,
            )

        side_points = self._get_side_points(points, side)
        side_points = self._smooth_side_points(side_points, side)

        reference_points = self._build_reference_points(
            frame=frame,
            side_points=side_points,
            width=w,
            height=h,
        )

        cva = self._calculate_cva(
            ear=reference_points["ear"],
            c7=reference_points["c7"],
        )

        fsa = self._calculate_fsa(
            shoulder=reference_points["shoulder"],
            c7=reference_points["c7"],
        )

        self._draw_posture_overlay(
            frame=annotated,
            reference_points=reference_points,
            cva_angle=cva,
            fsa_angle=fsa,
        )

        return DetectionResult(
            person_detected=True,
            cva_angle=cva,
            fsa_angle=fsa,
            annotated_frame=annotated,
        )

    # ========================
    # Extract landmarks
    # ========================

    def _extract_points(self, landmarks, width: int, height: int) -> dict[str, Point]:
        """แปลง MediaPipe landmark normalized 0-1 เป็น pixel coordinate"""

        def to_point(lm) -> Point:
            return Point(
                x=float(lm.x * width),
                y=float(lm.y * height),
                visibility=float(lm.visibility),
            )

        return {
            "left_ear": to_point(landmarks[self.LEFT_EAR]),
            "right_ear": to_point(landmarks[self.RIGHT_EAR]),
            "left_shoulder": to_point(landmarks[self.LEFT_SHOULDER]),
            "right_shoulder": to_point(landmarks[self.RIGHT_SHOULDER]),
        }

    # ========================
    # Side selection
    # ========================

    def _pick_visible_side_set(self, p: dict[str, Point]) -> Optional[str]:
        """
        เลือกฝั่ง landmark ที่ใช้คำนวณ CVA/FSA

        ใช้ config.CAMERA_SIDE เป็นหลัก:
        - "left"  = ใช้ LEFT_EAR / LEFT_SHOULDER ก่อน
        - "right" = ใช้ RIGHT_EAR / RIGHT_SHOULDER ก่อน
        - "auto"  = เลือกฝั่งที่ visibility ดีกว่าแบบเดิม

        หากตั้ง left/right แต่ visibility ไม่ผ่านเกณฑ์
        จะ fallback ไปใช้ auto เพื่อให้ระบบยังทำงานต่อได้
        """

        left_points = [
            p["left_ear"],
            p["left_shoulder"],
        ]

        right_points = [
            p["right_ear"],
            p["right_shoulder"],
        ]

        camera_side = str(
            getattr(config, "CAMERA_SIDE", "auto")
        ).strip().lower()

        if camera_side in ["left", "right"]:
            selected_points = left_points if camera_side == "left" else right_points

            if self._is_side_usable(selected_points):
                return camera_side

            # ถ้าฝั่งที่กำหนดไว้ไม่ผ่าน visibility
            # ให้ fallback ไป auto แทนการ return None ทันที
            # เพื่อกันภาพหลุดเมื่อ landmark ฝั่งนั้นหายชั่วคราว

        left_score = self._side_visibility_score(left_points)
        right_score = self._side_visibility_score(right_points)

        best_side = "left" if left_score >= right_score else "right"
        selected = left_points if best_side == "left" else right_points

        if not self._is_side_usable(selected):
            return None

        return best_side

    def _is_side_usable(self, points: list[Point]) -> bool:
        """
        ตรวจว่าฝั่ง landmark ที่เลือกใช้งานได้หรือไม่

        ใช้เฉพาะ:
        - ear
        - shoulder

        ไม่ใช้ hip เพราะระบบตรวจเฉพาะครึ่งตัวบน
        """

        if len(points) < 2:
            return False

        ear, shoulder = points

        min_visibility = config.MIN_VISIBILITY
        ear_min_visibility = max(0.45, min_visibility - 0.1)

        if shoulder.visibility < min_visibility:
            return False

        if ear.visibility < ear_min_visibility:
            return False

        side_score = self._side_visibility_score(points)

        if side_score < min_visibility:
            return False

        return True

    def _side_visibility_score(self, points: list[Point]) -> float:
        return sum(point.visibility for point in points) / len(points)

    def _get_side_points(self, p: dict[str, Point], side: str) -> dict[str, Point]:
        """
        ดึงจุดของฝั่งที่เลือก

        มี opposite_shoulder ไว้ช่วยประมาณตำแหน่ง C7
        เพราะ MediaPipe ไม่มี landmark C7 โดยตรง
        """

        if side == "left":
            return {
                "ear": p["left_ear"],
                "shoulder": p["left_shoulder"],
                "opposite_shoulder": p["right_shoulder"],
            }

        return {
            "ear": p["right_ear"],
            "shoulder": p["right_shoulder"],
            "opposite_shoulder": p["left_shoulder"],
        }

    # ========================
    # Smoothing
    # ========================

    def _smooth_side_points(
        self,
        points: dict[str, Point],
        side: str,
    ) -> dict[str, Point]:
        """
        ทำ EMA smoothing เพื่อลดจุดกระตุก
        และป้องกันไม่ให้จุดฝั่งซ้าย/ขวาถูก smooth ปนกัน
        """

        alpha = getattr(config, "LANDMARK_SMOOTHING_ALPHA", 0.45)

        if self._last_side is not None and self._last_side != side:
            self._smoothed_points.clear()

        self._last_side = side

        smoothed: dict[str, Point] = {}

        for key, current in points.items():
            smooth_key = f"{side}_{key}"

            prev = self._smoothed_points.get(smooth_key)

            if prev is None:
                smoothed_point = current
            else:
                smoothed_point = Point(
                    x=(alpha * current.x) + ((1 - alpha) * prev.x),
                    y=(alpha * current.y) + ((1 - alpha) * prev.y),
                    visibility=current.visibility,
                )

            self._smoothed_points[smooth_key] = smoothed_point
            smoothed[key] = smoothed_point

        return smoothed

    # ========================
    # Reference points
    # ========================

    def _build_reference_points(
        self,
        frame: np.ndarray,
        side_points: dict[str, Point],
        width: int,
        height: int,
    ) -> dict[str, Point]:
        """
        สร้างจุดอ้างอิงที่ใช้คำนวณ CVA/FSA

        ถ้าเปิด green marker และเจอ marker อย่างน้อย 3 จุด:
        - จุดบนสุด = tragus / ear
        - จุดกลาง = C7
        - จุดล่างสุด = shoulder

        ถ้า marker ไม่ครบ:
        - fallback ไปใช้ MediaPipe ear/shoulder + estimated C7
        """

        # fallback เริ่มต้นจาก MediaPipe
        ear = self._estimate_tragus_from_ear(
            ear=side_points["ear"],
            width=width,
        )

        shoulder = side_points["shoulder"]

        c7 = self._estimate_c7(
            side_points=side_points,
            width=width,
            height=height,
        )

        markers = self._detect_green_markers(frame)

        marker_refs = self._assign_green_markers_by_vertical_order(
            markers=markers,
            side_points=side_points,
            width=width,
            height=height,
        )

        if marker_refs is not None:
            return marker_refs

        # ถ้า marker ไม่ครบ ใช้ fallback แบบเดิม แต่พยายาม snap เฉพาะจุดที่ใกล้จริง
        if not markers:
            return {
                "ear": ear,
                "shoulder": shoulder,
                "c7": c7,
            }

        used_indices: set[int] = set()

        marker_ear = self._nearest_marker(
            markers=markers,
            target=ear,
            used_indices=used_indices,
            max_distance=max(width, height) * 0.16,
        )

        if marker_ear is not None:
            ear, marker_index = marker_ear
            used_indices.add(marker_index)

        marker_shoulder = self._nearest_marker(
            markers=markers,
            target=shoulder,
            used_indices=used_indices,
            max_distance=max(width, height) * 0.18,
        )

        if marker_shoulder is not None:
            shoulder, marker_index = marker_shoulder
            used_indices.add(marker_index)

        marker_c7 = self._nearest_marker(
            markers=markers,
            target=c7,
            used_indices=used_indices,
            max_distance=max(width, height) * 0.20,
        )

        if marker_c7 is not None:
            c7, marker_index = marker_c7
            used_indices.add(marker_index)

        return {
            "ear": ear,
            "shoulder": shoulder,
            "c7": c7,
        }

    def _assign_green_markers_by_vertical_order(
        self,
        markers: list[Point],
        side_points: dict[str, Point],
        width: int,
        height: int,
    ) -> Optional[dict[str, Point]]:
        """
        ใช้ marker สีเขียวเป็นจุดหลัก เมื่อเจอ marker อย่างน้อย 3 จุด

        หลักการสำหรับภาพด้านข้างครึ่งตัวบน:
        - tragus / ear อยู่สูงสุด
        - C7 อยู่กลางระหว่างหูกับไหล่
        - shoulder อยู่ต่ำสุด

        เหมาะกับการติด marker 3 จุด:
        1. tragus / หน้ารูหู
        2. C7 / โคนคอด้านหลัง
        3. shoulder / หัวไหล่
        """

        if len(markers) < 3:
            return None

        candidates = self._filter_body_markers(
            markers=markers,
            side_points=side_points,
            width=width,
            height=height,
        )

        if len(candidates) < 3:
            candidates = markers

        # เรียงจากบนลงล่าง
        sorted_markers = sorted(candidates, key=lambda p: p.y)

        ear = sorted_markers[0]
        shoulder = sorted_markers[-1]

        middle_markers = sorted_markers[1:-1]

        if not middle_markers:
            return None

        # ถ้ามี marker ตรงกลางมากกว่า 1 จุด ให้เลือกจุดที่อยู่ด้านหลังมากกว่าเป็น C7
        forward_direction = getattr(config, "CAMERA_FORWARD_DIRECTION", 1)

        c7 = min(
            middle_markers,
            key=lambda p: forward_direction * p.x,
        )

        return {
            "ear": ear,
            "c7": c7,
            "shoulder": shoulder,
        }

    def _filter_body_markers(
        self,
        markers: list[Point],
        side_points: dict[str, Point],
        width: int,
        height: int,
    ) -> list[Point]:
        """
        กรอง marker ที่อยู่บริเวณร่างกายครึ่งบน
        เพื่อกันสีเขียวอื่นในฉากหลังหลุดเข้ามา
        """

        ear = side_points["ear"]
        shoulder = side_points["shoulder"]
        c7 = self._estimate_c7(
            side_points=side_points,
            width=width,
            height=height,
        )

        min_x = min(ear.x, shoulder.x, c7.x) - (width * 0.35)
        max_x = max(ear.x, shoulder.x, c7.x) + (width * 0.35)

        min_y = min(ear.y, shoulder.y, c7.y) - (height * 0.30)
        max_y = max(ear.y, shoulder.y, c7.y) + (height * 0.45)

        return [
            marker
            for marker in markers
            if min_x <= marker.x <= max_x and min_y <= marker.y <= max_y
        ]

    def _estimate_tragus_from_ear(
        self,
        ear: Point,
        width: int,
    ) -> Point:
        """
        ประมาณ tragus จาก MediaPipe ear landmark

        MediaPipe ear มักอยู่กลาง/หลังใบหู
        แต่ tragus อยู่ด้านหน้ารูหู
        จึงขยับ ear ไปด้านหน้าเล็กน้อยตาม CAMERA_FORWARD_DIRECTION
        """

        forward_direction = getattr(config, "CAMERA_FORWARD_DIRECTION", 1)
        offset_ratio = getattr(config, "TRAGUS_FORWARD_OFFSET_RATIO", 0.018)

        return Point(
            x=ear.x + (forward_direction * offset_ratio * width),
            y=ear.y,
            visibility=ear.visibility,
        )

    def _estimate_c7(
        self,
        side_points: dict[str, Point],
        width: int,
        height: int,
    ) -> Point:
        """
        ประมาณตำแหน่ง C7

        MediaPipe ไม่มีจุด C7 โดยตรง
        จึงประมาณจากแนวหัวไหล่ แล้วขยับขึ้นและถอยไปด้านหลังเล็กน้อย

        หากต้องการความแม่นขึ้น ควรใช้ marker สีเขียวติดที่ C7
        แล้วเปิด ENABLE_GREEN_MARKER_DETECTION ใน config.py
        """

        shoulder = side_points["shoulder"]
        opposite_shoulder = side_points["opposite_shoulder"]

        mid_x = (shoulder.x + opposite_shoulder.x) / 2
        mid_y = (shoulder.y + opposite_shoulder.y) / 2

        up_offset = getattr(config, "C7_UP_OFFSET_RATIO", 0.08) * height
        back_offset = getattr(config, "C7_BACK_OFFSET_RATIO", 0.04) * width

        forward_direction = getattr(config, "CAMERA_FORWARD_DIRECTION", 1)

        c7_x = mid_x - (forward_direction * back_offset)
        c7_y = mid_y - up_offset

        visibility = min(
            shoulder.visibility,
            opposite_shoulder.visibility,
        )

        return Point(
            x=c7_x,
            y=c7_y,
            visibility=visibility,
        )

    # ========================
    # Green marker detection
    # ========================

    def _detect_green_markers(self, frame: np.ndarray) -> list[Point]:
        """
        ตรวจจับ marker สีเขียวจากภาพด้วย HSV threshold

        ใช้เมื่อ:
        ENABLE_GREEN_MARKER_DETECTION = True
        """

        if not getattr(config, "ENABLE_GREEN_MARKER_DETECTION", False):
            return []

        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

        lower = np.array(
            getattr(config, "GREEN_HSV_LOWER", (35, 80, 80)),
            dtype=np.uint8,
        )
        upper = np.array(
            getattr(config, "GREEN_HSV_UPPER", (85, 255, 255)),
            dtype=np.uint8,
        )

        mask = cv2.inRange(hsv, lower, upper)

        kernel = np.ones((5, 5), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

        contours, _ = cv2.findContours(
            mask,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )

        min_area = getattr(config, "GREEN_MARKER_MIN_AREA", 40)
        max_area = getattr(config, "GREEN_MARKER_MAX_AREA", 3000)

        markers: list[Point] = []

        for contour in contours:
            area = cv2.contourArea(contour)

            if area < min_area or area > max_area:
                continue

            moments = cv2.moments(contour)

            if moments["m00"] == 0:
                continue

            cx = moments["m10"] / moments["m00"]
            cy = moments["m01"] / moments["m00"]

            markers.append(
                Point(
                    x=float(cx),
                    y=float(cy),
                    visibility=1.0,
                )
            )

        return markers

    def _nearest_marker(
        self,
        markers: list[Point],
        target: Point,
        used_indices: set[int],
        max_distance: float,
    ) -> Optional[tuple[Point, int]]:
        """หา marker ที่อยู่ใกล้ target ที่สุด"""

        best_index: Optional[int] = None
        best_distance: float = float("inf")

        for index, marker in enumerate(markers):
            if index in used_indices:
                continue

            distance = self._distance(marker, target)

            if distance < best_distance:
                best_distance = distance
                best_index = index

        if best_index is None:
            return None

        if best_distance > max_distance:
            return None

        return markers[best_index], best_index

    @staticmethod
    def _distance(p1: Point, p2: Point) -> float:
        dx = p1.x - p2.x
        dy = p1.y - p2.y
        return math.sqrt((dx * dx) + (dy * dy))

    # ========================
    # Angle calculation
    # ========================

    def _calculate_cva(self, ear: Point, c7: Point) -> Optional[float]:
        """
        CVA = มุมระหว่างเส้น C7 -> EAR กับเส้นแนวนอนผ่าน C7

        จุดยอดของมุมคือ:
        - C7

        เส้นที่ใช้วัด:
        - เส้นแนวนอนผ่าน C7
        - เส้นจาก C7 ไปยังกกหู / Tragus

        ค่ายิ่งน้อย = มีแนวโน้มคอยื่นมากขึ้น
        """

        dx = ear.x - c7.x
        dy = c7.y - ear.y

        if abs(dx) < 1 and abs(dy) < 1:
            return None

        angle_rad = math.atan2(dy, abs(dx))
        angle_deg = math.degrees(angle_rad)

        return round(angle_deg, 1)

    def _calculate_fsa(self, shoulder: Point, c7: Point) -> Optional[float]:
        """
        FSA = มุมระหว่างเส้น SHOULDER -> C7 กับเส้นแนวนอนผ่านหัวไหล่

        จุดยอดของมุมคือ:
        - shoulder / หัวไหล่

        เส้นที่ใช้วัด:
        - เส้นแนวนอนผ่านหัวไหล่
        - เส้นจากหัวไหล่ไปยัง C7

        ค่ายิ่งน้อย = มีแนวโน้มไหล่ห่อมากขึ้น
        """

        dx = c7.x - shoulder.x
        dy = shoulder.y - c7.y  # กลับแกน y เพราะภาพ y เพิ่มลงล่าง

        if abs(dx) < 1 and abs(dy) < 1:
            return None

        angle_rad = math.atan2(abs(dy), abs(dx))
        angle_deg = math.degrees(angle_rad)

        return round(angle_deg, 1)

    # ========================
    # Drawing
    # ========================

    def _draw_posture_overlay(
        self,
        frame: np.ndarray,
        reference_points: dict[str, Point],
        cva_angle: Optional[float] = None,
        fsa_angle: Optional[float] = None,
    ) -> None:
        """
        วาด overlay สำหรับอธิบายการวัดมุม:

        CVA:
        - เส้นแนวนอนผ่าน C7 สีเหลือง
        - เส้นจาก C7 ไปกกหู

        FSA:
        - เส้นแนวนอนผ่านหัวไหล่ สีเหลือง
        - เส้นจากหัวไหล่ไป C7

        หมายเหตุ:
        - ไม่แสดงตัวเลขมุมบนภาพ เพื่อลดความรกของหน้าจอ
        """

        ear = reference_points["ear"]
        c7 = reference_points["c7"]
        shoulder = reference_points["shoulder"]

        # สี BGR ของ OpenCV
        ear_color = (0, 220, 80)          # เขียว = กกหู / Tragus
        c7_color = (0, 0, 255)            # แดง = C7
        shoulder_color = (255, 120, 0)    # ฟ้า/น้ำเงิน = หัวไหล่

        diagonal_line_color = (255, 255, 255)  # ขาว = เส้นวัดมุม
        reference_color = (0, 220, 255)        # เหลือง = เส้นแนวนอนอ้างอิง

        # ความยาวเส้นแนวนอน
        ref_left = 120
        ref_right = 160

        # ========================
        # CVA: เส้นแนวนอนผ่าน C7
        # ========================

        c7_horizontal_left = Point(x=c7.x - ref_left, y=c7.y)
        c7_horizontal_right = Point(x=c7.x + ref_right, y=c7.y)

        self._draw_line(
            frame,
            c7_horizontal_left,
            c7_horizontal_right,
            reference_color,
            thickness=1,
        )

        # เส้นจาก C7 ไปกกหู
        self._draw_line(
            frame,
            c7,
            ear,
            diagonal_line_color,
            thickness=2,
        )

        # ========================
        # FSA: เส้นแนวนอนผ่านหัวไหล่
        # ========================

        shoulder_horizontal_left = Point(
            x=shoulder.x - ref_left,
            y=shoulder.y,
        )
        shoulder_horizontal_right = Point(
            x=shoulder.x + ref_right,
            y=shoulder.y,
        )

        self._draw_line(
            frame,
            shoulder_horizontal_left,
            shoulder_horizontal_right,
            reference_color,
            thickness=1,
        )

        # เส้นจากหัวไหล่ไป C7
        self._draw_line(
            frame,
            shoulder,
            c7,
            diagonal_line_color,
            thickness=2,
        )

        # ========================
        # จุด landmark
        # ========================

        self._draw_point(frame, ear, ear_color, radius=6)
        self._draw_point(frame, c7, c7_color, radius=6)
        self._draw_point(frame, shoulder, shoulder_color, radius=6)

    def _draw_point(
        self,
        frame: np.ndarray,
        point: Point,
        color: tuple[int, int, int],
        radius: int = 5,
    ) -> None:
        """วาดจุดพร้อมขอบสีขาวให้มองเห็นชัด"""

        cv2.circle(
            frame,
            (int(point.x), int(point.y)),
            radius + 2,
            (255, 255, 255),
            -1,
            cv2.LINE_AA,
        )

        cv2.circle(
            frame,
            (int(point.x), int(point.y)),
            radius,
            color,
            -1,
            cv2.LINE_AA,
        )

    def _draw_line(
        self,
        frame: np.ndarray,
        p1: Point,
        p2: Point,
        color: tuple[int, int, int],
        thickness: int = 2,
    ) -> None:
        """วาดเส้นระหว่าง 2 จุด"""

        cv2.line(
            frame,
            (int(p1.x), int(p1.y)),
            (int(p2.x), int(p2.y)),
            color,
            thickness,
            cv2.LINE_AA,
        )