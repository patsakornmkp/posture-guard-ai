/* =========================================
   Summary Page
   File: frontend/js/summary.js

   ใช้แสดง dashboard หลังจบ session
   - แสดง score / risk / KPI
   - แยกคอยื่นและไหล่ห่อ
   - ไม่มี Calibration / Baseline
   - ปรับ UX แบบ minimal-change:
     1) กันเข้า summary ระหว่าง active monitoring
     2) รองรับ refresh หลังจบ session
     3) ใช้ cached summary จาก monitoring ถ้ามี
     4) ถ้า backend โหลดไม่ได้ จะแสดง error ในหน้าแทนหน้าขาว
     5) ปุ่มเริ่มใหม่ตรวจ session flow ก่อนกลับ setup
========================================= */

(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);

    const ALERT_DURATION_SECONDS = 180;

    document.addEventListener("DOMContentLoaded", async () => {
        if (!window.api || !window.utils) {
            renderFatalError(
                "ระบบ frontend โหลดไม่ครบ",
                "กรุณาตรวจสอบว่าไฟล์ app.js ถูกเรียกก่อน summary.js"
            );

            window.setTimeout(() => {
                window.location.replace("login.html");
            }, 1200);

            return;
        }

        renderLoadingState();
        setupActions();

        const canViewSummary = await utils.requireSummaryAccess();

        if (!canViewSummary) {
            return;
        }

        await loadSummary();
    });

    async function loadSummary() {
        const cachedSummary = utils.getLastSessionSummary();

        if (cachedSummary && cachedSummary.session_active !== true) {
            renderSummary(cachedSummary);
            return;
        }

        try {
            const summary = await api.getSessionSummary();

            if (summary?.session_active === true) {
                utils.redirectTo("monitoring.html", { replace: true });
                return;
            }

            renderSummary(summary || {});
        } catch (err) {
            renderFatalError(
                "โหลดสรุปผลไม่สำเร็จ",
                "กรุณาตรวจสอบว่า backend เปิดอยู่ แล้วลอง refresh หน้าอีกครั้ง"
            );

            renderRecommendations({
                score: 100,
                forwardPct: 0,
                roundedPct: 0,
                issuePct: 0,
                alerts: 0,
                forwardAlerts: 0,
                roundedAlerts: 0,
                effective: 0,
            });

            console.error("summary loading error:", err);
        }
    }

    function setupActions() {
        const printBtn = $("printReportBtn");

        if (printBtn) {
            printBtn.addEventListener("click", () => window.print());
        }

        setupStartNewSessionButton();
    }

    function setupStartNewSessionButton() {
        const startNewBtn = document.querySelector(".summary-primary-btn");

        if (!startNewBtn) {
            return;
        }

        startNewBtn.addEventListener("click", async (event) => {
            event.preventDefault();

            startNewBtn.setAttribute("aria-disabled", "true");
            startNewBtn.style.pointerEvents = "none";

            const originalText = startNewBtn.textContent;
            startNewBtn.textContent = "กำลังตรวจสอบ...";

            try {
                const canGoSetup = await utils.requireNoActiveMonitoring();

                if (!canGoSetup) {
                    return;
                }

                utils.redirectTo("setup.html", { replace: true });
            } catch (err) {
                console.error("start new session error:", err);

                startNewBtn.textContent = originalText;
                startNewBtn.style.pointerEvents = "";
                startNewBtn.removeAttribute("aria-disabled");

                renderFatalError(
                    "ไม่สามารถเริ่มใหม่ได้",
                    "กรุณาตรวจสอบ backend แล้วลองอีกครั้ง"
                );
            }
        });
    }

    function renderLoadingState() {
        renderDate();

        setText("scoreValue", "0");
        setText("scoreGrade", "กำลังโหลด");
        setText("scoreMessage", "ระบบกำลังโหลดข้อมูลสรุปผลการใช้งาน");

        setText("sumRisk", "—");
        setText("sumEffective", "—");
        setText("sumGood", "—");
        setText("sumGoodRatio", "—");
        setText("sumIssueRatio", "—");
        setText("sumIssueTime", "—");

        setText("sumAlerts", "—");
        setText("sumAlertsInline", "—");
        setText("sumForwardAlerts", "—");
        setText("sumRoundedAlerts", "—");

        setText("sumGoodTimeInline", "—");
        setText("sumForwardAlertCount", "0 ครั้ง");
        setText("sumRoundedAlertCount", "0 ครั้ง");

        setText("sumGoodPct", "—");
        setText("sumForwardPct", "—");
        setText("sumRoundedPct", "—");

        setWidth("goodBar", "0%");
        setWidth("forwardBar", "0%");
        setWidth("roundedBar", "0%");

        setText("mainIssueTitle", "กำลังวิเคราะห์");
        setText("mainIssueDesc", "ระบบกำลังประมวลผลข้อมูลจาก session นี้");

        renderList("recList", ["กำลังประมวลผล..."]);
    }

    function renderFatalError(title, message) {
        renderDate();

        setText("scoreValue", "0");
        setText("scoreGrade", title);
        setText("scoreMessage", message);

        setText("sumRisk", "—");
        setText("sumEffective", "—");
        setText("sumGood", "—");
        setText("sumIssueRatio", "—");
        setText("sumAlerts", "—");
        setText("sumForwardAlerts", "—");
        setText("sumRoundedAlerts", "—");

        setText("mainIssueTitle", title);
        setText("mainIssueDesc", message);

        setWidth("goodBar", "0%");
        setWidth("forwardBar", "0%");
        setWidth("roundedBar", "0%");

        renderList("recList", [
            "ตรวจสอบว่า backend ทำงานอยู่",
            "หากเพิ่งหยุด session ให้ลอง refresh หน้า summary อีกครั้ง",
            "หากยังไม่พบข้อมูล ให้กลับไปเริ่ม session ใหม่",
        ]);
    }

    function renderSummary(summary) {
        const total = Number(summary.actual_duration_seconds || 0);
        const effective = Number(summary.effective_seated_seconds || 0);

        const good = Number(summary.good_posture_seconds || 0);
        const bad = Number(summary.bad_posture_seconds || 0);

        const forward = Number(summary.forward_head_seconds || 0);
        const rounded = Number(summary.rounded_shoulder_seconds || 0);

        const alerts = Number(summary.alert_count || 0);
        const forwardAlerts = Number(summary.forward_head_alert_count || 0);
        const roundedAlerts = Number(summary.rounded_shoulder_alert_count || 0);

        const goodPct = percent(good, effective);
        const forwardPct = percent(forward, effective);
        const roundedPct = percent(rounded, effective);

        const issueSeconds = forward + rounded || bad;

        const issuePct = summary.bad_posture_ratio != null
            ? Number(summary.bad_posture_ratio) * 100
            : percent(issueSeconds, effective);

        const score = calculateScore({
            totalSeconds: total,
            effectiveSeconds: effective,
            issuePct,
            alerts,
        });

        renderDate();
        renderScore(score);

        renderOverview({
            effective,
            good,
            goodPct,
            issueSeconds,
            issuePct,
            alerts,
            forwardAlerts,
            roundedAlerts,
            riskLevel: summary.risk_level,
        });

        renderPostureAnalysis({
            good,
            goodPct,
            forwardPct,
            roundedPct,
            forwardAlerts,
            roundedAlerts,
        });

        renderInsight({
            forward,
            rounded,
            forwardPct,
            roundedPct,
            issuePct,
            forwardAlerts,
            roundedAlerts,
            alerts,
        });

        renderRecommendations({
            score,
            forwardPct,
            roundedPct,
            issuePct,
            alerts,
            forwardAlerts,
            roundedAlerts,
            effective,
        });
    }

    function calculateScore({ totalSeconds, effectiveSeconds, issuePct, alerts }) {
        const durationSeconds = Number(effectiveSeconds || totalSeconds || 0);
        const alertCount = Number(alerts || 0);
        const issueRatio = Math.min(Number(issuePct || 0) / 100, 1);

        if (durationSeconds <= 0) {
            return 100;
        }

        const maxAlertCount = Math.max(durationSeconds / ALERT_DURATION_SECONDS, 1);
        const alertRatio = Math.min(alertCount / maxAlertCount, 1);

        const rawScore = 100 - (alertRatio * 45) - (issueRatio * 25);
        const finalScore = Math.max(40, rawScore);

        return Math.round(finalScore);
    }

    function renderDate() {
        setText("summaryDate", new Date().toLocaleString("th-TH", {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        }));
    }

    function renderOverview({
        effective,
        good,
        goodPct,
        issueSeconds,
        issuePct,
        alerts,
        forwardAlerts,
        roundedAlerts,
        riskLevel,
    }) {
        setText("sumEffective", formatTime(effective));
        setText("sumGood", formatTime(good));
        setText("sumGoodRatio", `${goodPct.toFixed(0)}%`);
        setText("sumIssueRatio", `${issuePct.toFixed(0)}%`);
        setText("sumIssueTime", formatTime(issueSeconds));

        setText("sumAlerts", `${alerts} ครั้ง`);
        setText("sumAlertsInline", `${alerts} ครั้ง`);
        setText("sumForwardAlerts", `${forwardAlerts} ครั้ง`);
        setText("sumRoundedAlerts", `${roundedAlerts} ครั้ง`);

        const riskMap = {
            low: { label: "ต่ำ", klass: "risk-low" },
            medium: { label: "ปานกลาง", klass: "risk-medium" },
            high: { label: "สูง", klass: "risk-high" },
        };

        const risk = riskMap[riskLevel] || riskMap.low;

        setText("sumRisk", risk.label);

        const riskPill = $("riskPill");

        if (riskPill) {
            riskPill.className = `risk-pill ${risk.klass}`;
        }
    }

    function renderPostureAnalysis({
        good,
        goodPct,
        forwardPct,
        roundedPct,
        forwardAlerts,
        roundedAlerts,
    }) {
        setText("sumGoodTimeInline", formatTime(good));

        setText("sumForwardAlertCount", `${forwardAlerts} ครั้ง`);
        setText("sumRoundedAlertCount", `${roundedAlerts} ครั้ง`);

        setText("sumGoodPct", `${goodPct.toFixed(0)}%`);
        setText("sumForwardPct", `${forwardPct.toFixed(0)}%`);
        setText("sumRoundedPct", `${roundedPct.toFixed(0)}%`);

        setWidth("goodBar", `${clamp(goodPct, 0, 100)}%`);
        setWidth("forwardBar", `${clamp(forwardPct, 0, 100)}%`);
        setWidth("roundedBar", `${clamp(roundedPct, 0, 100)}%`);
    }

    function renderScore(score) {
        setText("scoreValue", score);

        const scoreCircleFg = $("scoreCircleFg");
        const scoreValue = $("scoreValue");

        const circumference = 326.7;
        const offset = circumference - (score / 100) * circumference;

        if (scoreCircleFg) {
            scoreCircleFg.style.strokeDashoffset = offset;
        }

        let grade;
        let msg;
        let color;

        if (score >= 85) {
            grade = "ดีมาก";
            color = "#1D9E75";
            msg = "ท่าทางโดยรวมอยู่ในเกณฑ์ดี มีการแจ้งเตือนน้อย เหมาะสำหรับแสดงผลว่า session นี้มีความเสี่ยงต่ำ";
        } else if (score >= 70) {
            grade = "พอใช้";
            color = "#2F8F7B";
            msg = "มีบางช่วงที่ค่ามุมไม่อยู่ในเกณฑ์ แต่ยังไม่รุนแรงมาก ควรปรับท่านั่งเป็นระยะ";
        } else if (score >= 50) {
            grade = "ควรปรับปรุง";
            color = "#D4A017";
            msg = "มีการแจ้งเตือนหรือช่วงผิดท่าหลายครั้ง ควรปรับหน้าจอ เก้าอี้ และตำแหน่งไหล่";
        } else {
            grade = "เสี่ยงสูง";
            color = "#C73E3E";
            msg = "พบความเสี่ยงค่อนข้างสูง ควรพักและปรับสภาพแวดล้อมก่อนเริ่มใช้งานต่อ";
        }

        setText("scoreGrade", grade);
        setText("scoreMessage", msg);

        if (scoreCircleFg) {
            scoreCircleFg.style.stroke = color;
        }

        if (scoreValue) {
            scoreValue.style.color = color;
        }
    }

    function renderInsight({
        forward,
        rounded,
        forwardPct,
        roundedPct,
        issuePct,
        forwardAlerts,
        roundedAlerts,
        alerts,
    }) {
        const title = $("mainIssueTitle");
        const desc = $("mainIssueDesc");

        if (!title || !desc) return;

        if (issuePct < 10 && alerts === 0) {
            title.textContent = "ท่าทางโดยรวมอยู่ในเกณฑ์ปกติ";
            desc.textContent = "ไม่พบการแจ้งเตือนในรอบนี้ และเวลาส่วนใหญ่ถูกจัดอยู่ในสถานะท่าทางเหมาะสม";
            return;
        }

        if (forwardAlerts > roundedAlerts && forwardAlerts > 0) {
            title.textContent = "ปัญหาหลักคือคอยื่น";
            desc.textContent = `ระบบแจ้งเตือนคอยื่น ${forwardAlerts} ครั้ง และพบเวลาคอยื่นประมาณ ${forwardPct.toFixed(0)}% ของเวลาที่ใช้งานจริง ควรปรับจอให้อยู่ระดับสายตาและดึงคางกลับเป็นระยะ`;
            return;
        }

        if (roundedAlerts > forwardAlerts && roundedAlerts > 0) {
            title.textContent = "ปัญหาหลักคือไหล่ห่อ";
            desc.textContent = `ระบบแจ้งเตือนไหล่ห่อ ${roundedAlerts} ครั้ง และพบเวลาไหล่ห่อประมาณ ${roundedPct.toFixed(0)}% ของเวลาที่ใช้งานจริง ควรเปิดอก ดึงหัวไหล่กลับ และจัดโต๊ะให้อยู่ในระยะเหมาะสม`;
            return;
        }

        if (forwardAlerts > 0 || roundedAlerts > 0) {
            title.textContent = "พบการแจ้งเตือนมากกว่า 1 ประเภท";
            desc.textContent = `รอบนี้มีการแจ้งเตือนรวม ${alerts} ครั้ง แบ่งเป็นคอยื่น ${forwardAlerts} ครั้ง และไหล่ห่อ ${roundedAlerts} ครั้ง แสดงว่าควรปรับทั้งตำแหน่งศีรษะและหัวไหล่`;
            return;
        }

        if (forward > rounded * 1.2) {
            title.textContent = "พบค่ามุมคอผิดปกติเป็นหลัก";
            desc.textContent = `ค่ามุม CVA ไม่อยู่ในเกณฑ์ประมาณ ${forwardPct.toFixed(0)}% ของเวลาที่ใช้งานจริง แต่ยังอาจไม่ต่อเนื่องครบเวลาที่กำหนดสำหรับ alert`;
            return;
        }

        if (rounded > forward * 1.2) {
            title.textContent = "พบค่ามุมไหล่ผิดปกติเป็นหลัก";
            desc.textContent = `ค่ามุม FSA ไม่อยู่ในเกณฑ์ประมาณ ${roundedPct.toFixed(0)}% ของเวลาที่ใช้งานจริง แต่ยังอาจไม่ต่อเนื่องครบเวลาที่กำหนดสำหรับ alert`;
            return;
        }

        title.textContent = "พบค่ามุมไม่อยู่ในเกณฑ์ปกติ";
        desc.textContent = "ระบบพบช่วงเวลาที่ CVA หรือ FSA ต่ำกว่า threshold ควรปรับท่านั่งและพักยืดเหยียดเป็นระยะ";
    }

    function renderRecommendations({
        score,
        forwardPct,
        roundedPct,
        issuePct,
        alerts,
        forwardAlerts,
        roundedAlerts,
        effective,
    }) {
        const recs = [];

        if (effective <= 0) {
            recs.push("ไม่พบเวลาที่ระบบตรวจจับผู้ใช้งานได้ชัดเจน ควรตรวจตำแหน่งกล้องและแสงก่อนเริ่มใช้งานใหม่");
        } else if (score >= 85) {
            recs.push("ท่าทางโดยรวมอยู่ในเกณฑ์ดี ควรรักษาระดับสายตาและตำแหน่งศีรษะกับไหล่ให้เหมาะสมต่อเนื่อง");
        } else if (score >= 70) {
            recs.push("ควรพักสายตาและยืดเหยียดคอ ไหล่ และสะบักทุก 30–45 นาที");
        } else if (score >= 50) {
            recs.push("ควรปรับระดับหน้าจอให้อยู่ใกล้ระดับสายตา และจัดหัวไหล่ให้อยู่ในแนวผ่อนคลาย");
        } else {
            recs.push("ควรหยุดพัก ปรับเก้าอี้ หน้าจอ และตำแหน่งกล้องก่อนเริ่ม session ใหม่");
        }

        if (forwardAlerts > 0 || forwardPct >= 20) {
            recs.push("สำหรับคอยื่น: ปรับจอให้อยู่ระดับสายตา ลดการก้มมอง และดึงคางกลับเล็กน้อยเป็นระยะ");
        }

        if (roundedAlerts > 0 || roundedPct >= 20) {
            recs.push("สำหรับไหล่ห่อ: เปิดอก ดึงสะบักเบา ๆ และวางคีย์บอร์ด/เมาส์ให้อยู่ใกล้ตัวมากขึ้น");
        }

        if (alerts > 0) {
            recs.push("เมื่อมี LINE หรือ browser alert ควรปรับท่าทางทันที ไม่ควรรอจนจบ session");
        }

        if (issuePct >= 50) {
            recs.push("สัดส่วนท่าทางเสี่ยงสูง ควรลดเวลานั่งต่อเนื่องและเพิ่มช่วงพักสั้น ๆ ระหว่างทำงาน");
        }

        renderList("recList", recs);
    }

    function renderList(id, items) {
        const list = $(id);

        if (!list) return;

        list.innerHTML = "";

        items.forEach((text) => {
            const li = document.createElement("li");
            li.textContent = text;
            list.appendChild(li);
        });
    }

    function percent(value, total) {
        const n = Number(value || 0);
        const t = Number(total || 0);

        if (t <= 0) return 0;

        return (n / t) * 100;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function formatTime(totalSeconds) {
        const s = Math.max(0, Math.floor(Number(totalSeconds || 0)));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;

        if (h > 0) {
            return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
        }

        return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }

    function setWidth(id, width) {
        const el = $(id);

        if (el) {
            el.style.width = width;
        }
    }

    function setText(id, value) {
        const el = $(id);

        if (!el) return;

        const text = String(value);

        if (el.textContent !== text) {
            el.textContent = text;
        }
    }
})();