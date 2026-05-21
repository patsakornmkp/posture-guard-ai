# backend/detector.py
# ใช้ MediaPipe Pose ตรวจจับ landmark และคำนวณมุม CVA + FSA
#
# เวอร์ชันนี้:
# - ล็อกใช้กล้องด้านขวาของผู้ใช้เท่านั้น
# - ใช้ RIGHT_EAR / RIGHT_SHOULDER เป็นตำแหน่งคาดเดาเริ่มต้น
# - ใช้ marker สีเหลือง 2 จุด:
#   1) marker หู / tragus
#   2) marker ไหล่ / shoulder
# - แยก ROI หู และ ROI ไหล่ เพื่อไม่ให้ไปจับตู้หรือฉากหลัง
# - เพิ่ม marker smoothing / sticky tracking ลดอาการจุดดิ้น
# - ถ้า marker หายชั่วคราว จะ hold ตำแหน่งล่าสุดไว้ก่อน
# - C7 คำนวณจากจุดไหล่หลังเลือก marker แล้ว
# - ไม่มี Calibration / Baseline
# - ไม่มี hunched back / kyphosis

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import cv2
import mediapipe as mp
import numpy as np

try:
    from . import config
except ImportError:
    import config


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


class PoseDetector:
    """MediaPipe Pose Detector สำหรับ PostureGuard"""

    NOSE = 0
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

        self._smoothed_points: dict[str, Point] = {}

        self._last_ear_source: str = "MEDIAPIPE"
        self._last_shoulder_source: str = "MEDIAPIPE"

        self._smoothed_ear_marker: Optional[Point] = None
        self._smoothed_shoulder_marker: Optional[Point] = None
        self._ear_marker_missing_frames: int = 0
        self._shoulder_marker_missing_frames: int = 0

    def close(self) -> None:
        """ปิด MediaPipe resources"""
        self.pose.close()

    def process(self, frame: np.ndarray) -> DetectionResult:
        """ประมวลผล 1 frame แล้วคืน DetectionResult"""

        if frame is None:
            return DetectionResult(
                person_detected=False,
                annotated_frame=None,
            )

        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb_frame.flags.writeable = False
        results = self.pose.process(rgb_frame)
        rgb_frame.flags.writeable = True

        annotated = frame.copy()

        if not results.pose_landmarks:
            self._smoothed_points.clear()
            self._smoothed_ear_marker = None
            self._smoothed_shoulder_marker = None
            self._ear_marker_missing_frames = 0
            self._shoulder_marker_missing_frames = 0
            self._last_ear_source = "NO_POSE"
            self._last_shoulder_source = "NO_POSE"

            return DetectionResult(
                person_detected=False,
                annotated_frame=annotated,
            )

        height, width = frame.shape[:2]
        landmarks = results.pose_landmarks.landmark

        points = self._extract_points(landmarks, width, height)

        if not self._is_right_side_usable(points):
            self._draw_debug_status(
                frame=annotated,
                text="RIGHT SIDE NOT READY",
                y=30,
                color=(0, 0, 255),
            )

            return DetectionResult(
                person_detected=True,
                cva_angle=None,
                fsa_angle=None,
                annotated_frame=annotated,
            )

        side_points = self._get_right_side_points(points)
        side_points = self._smooth_points(side_points)

        reference_points = self._build_reference_points(
            frame=frame,
            side_points=side_points,
            width=width,
            height=height,
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

        if getattr(config, "DEBUG_DRAW_VALUES", False):
            self._draw_debug_info(
                frame=annotated,
                cva_angle=cva,
                fsa_angle=fsa,
                shoulder=reference_points["shoulder"],
            )

        return DetectionResult(
            person_detected=True,
            cva_angle=cva,
            fsa_angle=fsa,
            annotated_frame=annotated,
        )

    def _extract_points(self, landmarks, width: int, height: int) -> dict[str, Point]:
        """แปลง MediaPipe landmark normalized 0-1 เป็น pixel coordinate"""

        def to_point(lm) -> Point:
            return Point(
                x=float(lm.x * width),
                y=float(lm.y * height),
                visibility=float(lm.visibility),
            )

        return {
            "nose": to_point(landmarks[self.NOSE]),
            "left_ear": to_point(landmarks[self.LEFT_EAR]),
            "right_ear": to_point(landmarks[self.RIGHT_EAR]),
            "left_shoulder": to_point(landmarks[self.LEFT_SHOULDER]),
            "right_shoulder": to_point(landmarks[self.RIGHT_SHOULDER]),
        }

    def _is_right_side_usable(self, points: dict[str, Point]) -> bool:
        """
        ตรวจว่าฝั่งขวาพอใช้งานได้หรือไม่

        หูและไหล่มี marker สีเหลืองช่วยได้
        จึงไม่บังคับ visibility สูงเกินไป
        """

        right_ear = points["right_ear"]
        right_shoulder = points["right_shoulder"]

        shoulder_min_visibility = min(
            float(getattr(config, "MIN_VISIBILITY", 0.35)),
            0.25,
        )

        ear_min_visibility = 0.10

        if right_shoulder.visibility < shoulder_min_visibility:
            return False

        if right_ear.visibility < ear_min_visibility:
            return False

        return True

    def _get_right_side_points(self, points: dict[str, Point]) -> dict[str, Point]:
        """ล็อกใช้ landmark ฝั่งขวาเท่านั้น"""

        return {
            "nose": points["nose"],
            "ear": points["right_ear"],
            "shoulder": points["right_shoulder"],
            "opposite_shoulder": points["left_shoulder"],
        }

    def _smooth_points(self, points: dict[str, Point]) -> dict[str, Point]:
        """ทำ EMA smoothing เพื่อลดจุด MediaPipe กระตุก"""

        alpha = float(getattr(config, "LANDMARK_SMOOTHING_ALPHA", 0.25))

        smoothed: dict[str, Point] = {}

        for key, current in points.items():
            smooth_key = f"right_{key}"
            prev = self._smoothed_points.get(smooth_key)

            if prev is None:
                smoothed_point = current
            else:
                smoothed_point = Point(
                    x=(alpha * current.x) + ((1.0 - alpha) * prev.x),
                    y=(alpha * current.y) + ((1.0 - alpha) * prev.y),
                    visibility=current.visibility,
                )

            self._smoothed_points[smooth_key] = smoothed_point
            smoothed[key] = smoothed_point

        return smoothed

    def _build_reference_points(
        self,
        frame: np.ndarray,
        side_points: dict[str, Point],
        width: int,
        height: int,
    ) -> dict[str, Point]:
        """
        สร้างจุดอ้างอิงสำหรับคำนวณ CVA/FSA

        - หูใช้ marker สีเหลืองใน head ROI + smoothing
        - ไหล่ใช้ marker สีเหลืองใน shoulder ROI + smoothing
        - ถ้า marker หายชั่วคราว จะ hold ตำแหน่งล่าสุดไว้ก่อน
        - ถ้าหา marker ไม่เจอนานเกินไป fallback ไป MediaPipe
        """

        self._last_ear_source = "MEDIAPIPE"
        self._last_shoulder_source = "MEDIAPIPE"

        ear = self._estimate_tragus_from_ear(
            ear=side_points["ear"],
            width=width,
        )

        shoulder = side_points["shoulder"]

        raw_ear_marker = self._detect_yellow_tragus_marker(
            frame=frame,
            side_points=side_points,
            expected_ear=ear,
            width=width,
            height=height,
        )

        ear_marker = self._smooth_marker_point(
            raw_marker=raw_ear_marker,
            previous_marker_attr="_smoothed_ear_marker",
            missing_counter_attr="_ear_marker_missing_frames",
        )

        if ear_marker is not None:
            ear = ear_marker
            self._last_ear_source = "MARKER"

        raw_shoulder_marker = self._detect_yellow_shoulder_marker(
            frame=frame,
            expected_shoulder=shoulder,
            expected_ear=ear,
            width=width,
            height=height,
        )

        shoulder_marker = self._smooth_marker_point(
            raw_marker=raw_shoulder_marker,
            previous_marker_attr="_smoothed_shoulder_marker",
            missing_counter_attr="_shoulder_marker_missing_frames",
        )

        if shoulder_marker is not None:
            shoulder = shoulder_marker
            self._last_shoulder_source = "MARKER"

        c7 = self._estimate_c7(
            shoulder=shoulder,
            width=width,
            height=height,
        )

        return {
            "ear": ear,
            "shoulder": shoulder,
            "c7": c7,
        }

    def _smooth_marker_point(
        self,
        raw_marker: Optional[Point],
        previous_marker_attr: str,
        missing_counter_attr: str,
    ) -> Optional[Point]:
        """
        ทำให้ marker นิ่งขึ้น

        - ถ้าเจอ marker ใหม่ ใช้ EMA smoothing
        - ถ้า marker หายชั่วคราว ใช้ตำแหน่งล่าสุดต่ออีกไม่กี่ frame
        - ถ้าหายเกิน MARKER_HOLD_FRAMES จะ fallback เป็น None
        """

        alpha = float(getattr(config, "MARKER_SMOOTHING_ALPHA", 0.18))
        hold_frames = int(getattr(config, "MARKER_HOLD_FRAMES", 8))

        previous_marker = getattr(self, previous_marker_attr, None)
        missing_frames = getattr(self, missing_counter_attr, 0)

        if raw_marker is None:
            missing_frames += 1
            setattr(self, missing_counter_attr, missing_frames)

            if previous_marker is not None and missing_frames <= hold_frames:
                return previous_marker

            setattr(self, previous_marker_attr, None)
            return None

        setattr(self, missing_counter_attr, 0)

        if previous_marker is None:
            smoothed = raw_marker
        else:
            smoothed = Point(
                x=(alpha * raw_marker.x) + ((1.0 - alpha) * previous_marker.x),
                y=(alpha * raw_marker.y) + ((1.0 - alpha) * previous_marker.y),
                visibility=1.0,
            )

        setattr(self, previous_marker_attr, smoothed)

        return smoothed

    def _estimate_tragus_from_ear(
        self,
        ear: Point,
        width: int,
    ) -> Point:
        """ประมาณ tragus จาก MediaPipe ear landmark เฉพาะตอน fallback"""

        forward_direction = int(getattr(config, "CAMERA_FORWARD_DIRECTION", 1))
        offset_ratio = float(getattr(config, "TRAGUS_FORWARD_OFFSET_RATIO", 0.010))

        return Point(
            x=ear.x + (forward_direction * offset_ratio * width),
            y=ear.y,
            visibility=ear.visibility,
        )

    def _estimate_c7(
        self,
        shoulder: Point,
        width: int,
        height: int,
    ) -> Point:
        """ประมาณตำแหน่ง C7 จาก shoulder"""

        up_offset = float(getattr(config, "C7_UP_OFFSET_RATIO", 0.095)) * height
        back_offset = float(getattr(config, "C7_BACK_OFFSET_RATIO", 0.050)) * width

        forward_direction = int(getattr(config, "CAMERA_FORWARD_DIRECTION", 1))

        c7_x = shoulder.x - (forward_direction * back_offset)
        c7_y = shoulder.y - up_offset

        return Point(
            x=c7_x,
            y=c7_y,
            visibility=shoulder.visibility,
        )

    def _detect_yellow_tragus_marker(
        self,
        frame: np.ndarray,
        side_points: dict[str, Point],
        expected_ear: Point,
        width: int,
        height: int,
    ) -> Optional[Point]:
        """ตรวจ marker สีเหลืองเฉพาะบริเวณหู"""

        if not bool(getattr(config, "ENABLE_GREEN_MARKER_DETECTION", False)):
            return None

        roi = self._build_head_roi(
            side_points=side_points,
            expected_ear=expected_ear,
            width=width,
            height=height,
        )

        return self._detect_yellow_marker_in_roi(
            frame=frame,
            roi=roi,
            expected_point=expected_ear,
            max_distance=float(getattr(config, "MARKER_MAX_DISTANCE_FROM_HEAD", 145)),
            reject_point=None,
        )

    def _detect_yellow_shoulder_marker(
        self,
        frame: np.ndarray,
        expected_shoulder: Point,
        expected_ear: Point,
        width: int,
        height: int,
    ) -> Optional[Point]:
        """ตรวจ marker สีเหลืองเฉพาะบริเวณไหล่"""

        if not bool(getattr(config, "ENABLE_SHOULDER_MARKER_DETECTION", True)):
            return None

        roi = self._build_shoulder_roi(
            expected_shoulder=expected_shoulder,
            width=width,
            height=height,
        )

        return self._detect_yellow_marker_in_roi(
            frame=frame,
            roi=roi,
            expected_point=expected_shoulder,
            max_distance=float(getattr(config, "SHOULDER_MARKER_MAX_DISTANCE", 190)),
            reject_point=expected_ear,
        )

    def _detect_yellow_marker_in_roi(
        self,
        frame: np.ndarray,
        roi: Optional[tuple[int, int, int, int]],
        expected_point: Point,
        max_distance: float,
        reject_point: Optional[Point] = None,
    ) -> Optional[Point]:
        """
        ตรวจ marker สีเหลืองใน ROI ที่กำหนด

        ปรับให้ robust ขึ้น:
        - จับ marker เบลอได้
        - ไม่ต้อง circular เป๊ะ
        - ให้คะแนนจากระยะใกล้ expected point เป็นหลัก
        """

        if frame is None or roi is None or expected_point is None:
            return None

        x1, y1, x2, y2 = roi

        if x2 <= x1 or y2 <= y1:
            return None

        roi_frame = frame[y1:y2, x1:x2]

        if roi_frame.size == 0:
            return None

        roi_frame = cv2.GaussianBlur(roi_frame, (5, 5), 0)
        hsv = cv2.cvtColor(roi_frame, cv2.COLOR_BGR2HSV)

        lower = np.array(
            getattr(config, "GREEN_HSV_LOWER", (18, 45, 45)),
            dtype=np.uint8,
        )
        upper = np.array(
            getattr(config, "GREEN_HSV_UPPER", (45, 255, 255)),
            dtype=np.uint8,
        )

        mask = cv2.inRange(hsv, lower, upper)

        kernel_size = int(getattr(config, "GREEN_MARKER_KERNEL_SIZE", 5))
        kernel_size = max(3, kernel_size)

        kernel = np.ones((kernel_size, kernel_size), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

        contours, _ = cv2.findContours(
            mask,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )

        if not contours:
            return None

        min_area = float(getattr(config, "GREEN_MARKER_MIN_AREA", 10))
        max_area = float(getattr(config, "GREEN_MARKER_MAX_AREA", 2500))
        min_circularity = float(getattr(config, "GREEN_MARKER_MIN_CIRCULARITY", 0.12))

        candidates: list[tuple[float, Point]] = []

        for contour in contours:
            area = cv2.contourArea(contour)

            if area < min_area or area > max_area:
                continue

            perimeter = cv2.arcLength(contour, True)

            if perimeter <= 0:
                continue

            circularity = 4.0 * math.pi * area / (perimeter * perimeter)

            if circularity < min_circularity:
                continue

            moments = cv2.moments(contour)

            if moments["m00"] == 0:
                continue

            cx = float(moments["m10"] / moments["m00"]) + x1
            cy = float(moments["m01"] / moments["m00"]) + y1

            marker = Point(
                x=cx,
                y=cy,
                visibility=1.0,
            )

            distance = self._distance(marker, expected_point)

            if distance > max_distance:
                continue

            if reject_point is not None:
                reject_distance = self._distance(marker, reject_point)
                min_reject_distance = float(
                    getattr(config, "SHOULDER_MARKER_MIN_DISTANCE_FROM_EAR", 85)
                )

                if reject_distance < min_reject_distance:
                    continue

            score = (
                distance
                - (circularity * 5.0)
                - min(area * 0.006, 8.0)
            )

            candidates.append((score, marker))

        if not candidates:
            return None

        candidates.sort(key=lambda item: item[0])

        return candidates[0][1]

    def _build_head_roi(
        self,
        side_points: dict[str, Point],
        expected_ear: Point,
        width: int,
        height: int,
    ) -> Optional[tuple[int, int, int, int]]:
        """สร้าง ROI เฉพาะบริเวณหู"""

        points: list[Point] = []

        if expected_ear is not None:
            points.append(expected_ear)

        ear = side_points.get("ear")
        nose = side_points.get("nose")

        if ear is not None:
            points.append(ear)

        if nose is not None:
            points.append(nose)

        if not points:
            return None

        margin_x = int(getattr(config, "MARKER_ROI_HEAD_MARGIN_X", 120))
        margin_y = int(getattr(config, "MARKER_ROI_HEAD_MARGIN_Y", 105))

        min_x = min(point.x for point in points) - margin_x
        max_x = max(point.x for point in points) + margin_x
        min_y = min(point.y for point in points) - margin_y
        max_y = max(point.y for point in points) + margin_y

        x1 = max(0, int(min_x))
        x2 = min(width, int(max_x))
        y1 = max(0, int(min_y))
        y2 = min(height, int(max_y))

        return x1, y1, x2, y2

    def _build_shoulder_roi(
        self,
        expected_shoulder: Point,
        width: int,
        height: int,
    ) -> Optional[tuple[int, int, int, int]]:
        """สร้าง ROI เฉพาะบริเวณไหล่"""

        if expected_shoulder is None:
            return None

        margin_x = int(getattr(config, "SHOULDER_MARKER_ROI_MARGIN_X", 190))
        margin_y = int(getattr(config, "SHOULDER_MARKER_ROI_MARGIN_Y", 160))

        x1 = max(0, int(expected_shoulder.x - margin_x))
        x2 = min(width, int(expected_shoulder.x + margin_x))
        y1 = max(0, int(expected_shoulder.y - margin_y))
        y2 = min(height, int(expected_shoulder.y + margin_y))

        return x1, y1, x2, y2

    def _calculate_cva(self, ear: Point, c7: Point) -> Optional[float]:
        """
        CVA = มุมระหว่างเส้น C7 -> EAR กับเส้นแนวนอนผ่าน C7

        ค่ายิ่งน้อย = คอยื่นมากขึ้น
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

        ค่ายิ่งน้อย = ไหล่ห่อมากขึ้น
        """

        dx = c7.x - shoulder.x
        dy = shoulder.y - c7.y

        if abs(dx) < 1 and abs(dy) < 1:
            return None

        angle_rad = math.atan2(abs(dy), abs(dx))
        angle_deg = math.degrees(angle_rad)

        return round(angle_deg, 1)

    def _draw_posture_overlay(
        self,
        frame: np.ndarray,
        reference_points: dict[str, Point],
        cva_angle: Optional[float] = None,
        fsa_angle: Optional[float] = None,
    ) -> None:
        """วาด overlay สำหรับอธิบายการวัดมุม"""

        ear = reference_points["ear"]
        c7 = reference_points["c7"]
        shoulder = reference_points["shoulder"]

        ear_color = (0, 220, 80)
        c7_color = (0, 0, 255)
        shoulder_color = (255, 120, 0)

        diagonal_line_color = (255, 255, 255)
        reference_color = (0, 220, 255)

        ref_left = 120
        ref_right = 160

        self._draw_line(
            frame,
            Point(x=c7.x - ref_left, y=c7.y),
            Point(x=c7.x + ref_right, y=c7.y),
            reference_color,
            thickness=1,
        )

        self._draw_line(
            frame,
            c7,
            ear,
            diagonal_line_color,
            thickness=2,
        )

        self._draw_line(
            frame,
            Point(x=shoulder.x - ref_left, y=shoulder.y),
            Point(x=shoulder.x + ref_right, y=shoulder.y),
            reference_color,
            thickness=1,
        )

        self._draw_line(
            frame,
            shoulder,
            c7,
            diagonal_line_color,
            thickness=2,
        )

        self._draw_point(frame, ear, ear_color, radius=6)
        self._draw_point(frame, c7, c7_color, radius=6)
        self._draw_point(frame, shoulder, shoulder_color, radius=6)

    def _draw_debug_info(
        self,
        frame: np.ndarray,
        cva_angle: Optional[float],
        fsa_angle: Optional[float],
        shoulder: Point,
    ) -> None:
        """วาด debug text สำหรับ fine tune"""

        if not getattr(config, "DEBUG_DRAW_VALUES", False):
            return

        cva_text = "CVA: -" if cva_angle is None else f"CVA: {cva_angle:.1f}"
        fsa_text = "FSA: -" if fsa_angle is None else f"FSA: {fsa_angle:.1f}"
        ear_text = f"EAR: {self._last_ear_source}"
        shoulder_text = f"SHOULDER: {self._last_shoulder_source}"
        shoulder_vis_text = f"R_SHOULDER VIS: {shoulder.visibility:.2f}"

        self._draw_debug_status(frame, cva_text, y=26)
        self._draw_debug_status(frame, fsa_text, y=50)
        self._draw_debug_status(frame, ear_text, y=74)
        self._draw_debug_status(frame, shoulder_text, y=98)
        self._draw_debug_status(frame, shoulder_vis_text, y=122)

    def _draw_debug_status(
        self,
        frame: np.ndarray,
        text: str,
        y: int = 30,
        color: tuple[int, int, int] = (255, 255, 255),
    ) -> None:
        """วาดข้อความ debug"""

        cv2.putText(
            frame,
            text,
            (14, y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (0, 0, 0),
            4,
            cv2.LINE_AA,
        )

        cv2.putText(
            frame,
            text,
            (14, y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            color,
            1,
            cv2.LINE_AA,
        )

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

    @staticmethod
    def _distance(p1: Point, p2: Point) -> float:
        dx = p1.x - p2.x
        dy = p1.y - p2.y
        return math.sqrt((dx * dx) + (dy * dy))