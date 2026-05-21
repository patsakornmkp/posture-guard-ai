const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
    const canViewSummary = await utils.requireSummaryAccess();
    if (!canViewSummary) return;

    const cachedSummary = utils.getLastSessionSummary();

    if (cachedSummary) {
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
        alert("โหลดสรุปผลไม่สำเร็จ: " + err.message);
    }
});

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

    const issuePct = summary.bad_posture_ratio != null
        ? Number(summary.bad_posture_ratio) * 100
        : percent(bad, effective);

    const score = calculateScore({
        totalSeconds: total,
        effectiveSeconds: effective,
        alerts,
    });

    renderDate();
    renderScore(score);

    renderOverview({
        effective,
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
    });
}

function calculateScore({ totalSeconds, effectiveSeconds, alerts }) {
    /*
       สูตรคะแนน:

       จำนวนแจ้งเตือนสูงสุด = เวลาที่ใช้งานจริง / 180 วินาที
       คะแนน = 100 - ((จำนวนแจ้งเตือนจริง / จำนวนแจ้งเตือนสูงสุด) * 60)
       คะแนนสุดท้าย = max(40, คะแนน)

       หมายเหตุ:
       - ใช้ effectiveSeconds ก่อน เพื่อให้คะแนนอิงเฉพาะเวลาที่ผู้ใช้อยู่ในกล้องจริง
       - ถ้า effectiveSeconds ไม่มีค่า จะ fallback ไปใช้ totalSeconds
       - 180 วินาที = 3 นาที
       - 60 คือคะแนนหักสูงสุด
       - ถ้านั่งผิดตลอดทั้ง session คะแนนจะลดจาก 100 เหลือ 40
    */

    const durationSeconds = Number(effectiveSeconds || totalSeconds || 0);
    const alertCount = Number(alerts || 0);

    if (durationSeconds <= 0) {
        return 100;
    }

    const maxAlertCount = durationSeconds / 180;

    if (maxAlertCount <= 0) {
        return 100;
    }

    const alertRatio = Math.min(alertCount / maxAlertCount, 1);
    const rawScore = 100 - (alertRatio * 60);
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
    issuePct,
    alerts,
    forwardAlerts,
    roundedAlerts,
    riskLevel,
}) {
    setText("sumEffective", formatTime(effective));
    setText("sumIssueRatio", `${issuePct.toFixed(0)}%`);

    setText("sumAlerts", `${alerts} ครั้ง`);
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
    setText("sumGood", formatTime(good));

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
        msg = "นั่งอยู่ในท่าปกติเป็นส่วนใหญ่ มีการแจ้งเตือนน้อยมากหรือไม่มีเลย";
    } else if (score >= 70) {
        grade = "พอใช้";
        color = "#2F8F7B";
        msg = "มีบางช่วงที่นั่งผิดท่า แต่ยังไม่รุนแรงมาก";
    } else if (score >= 50) {
        grade = "ควรปรับปรุง";
        color = "#D4A017";
        msg = "มีการนั่งผิดท่าหลายช่วง ควรปรับหน้าจอ เก้าอี้ และท่านั่ง";
    } else {
        grade = "อันตราย";
        color = "#C73E3E";
        msg = "นั่งผิดท่าต่อเนื่องหรือมีการแจ้งเตือนบ่อย ควรพักและปรับท่าทางทันที";
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
        desc.textContent = "ไม่พบการแจ้งเตือนในรอบนี้ และค่ามุมส่วนใหญ่ยังอยู่ในเกณฑ์ปกติ";
        return;
    }

    if (forwardAlerts > roundedAlerts && forwardAlerts > 0) {
        title.textContent = "แจ้งเตือนคอยื่นเป็นหลัก";
        desc.textContent = `ระบบแจ้งเตือนคอยื่น ${forwardAlerts} ครั้ง โดยค่ามุมคอไม่อยู่ในเกณฑ์ปกติประมาณ ${forwardPct.toFixed(0)}% ของเวลาที่ใช้งานจริง ควรปรับหน้าจอให้อยู่ระดับสายตาและดึงคางกลับเป็นระยะ`;
        return;
    }

    if (roundedAlerts > forwardAlerts && roundedAlerts > 0) {
        title.textContent = "แจ้งเตือนไหล่ห่อเป็นหลัก";
        desc.textContent = `ระบบแจ้งเตือนไหล่ห่อ ${roundedAlerts} ครั้ง โดยค่ามุมไหล่ไม่อยู่ในเกณฑ์ปกติประมาณ ${roundedPct.toFixed(0)}% ของเวลาที่ใช้งานจริง ควรดึงหัวไหล่กลับ เปิดอก และจัดตำแหน่งไหล่ให้เหมาะสม`;
        return;
    }

    if (forwardAlerts > 0 || roundedAlerts > 0) {
        title.textContent = "มีการแจ้งเตือนมากกว่า 1 ประเภท";
        desc.textContent = `รอบนี้มีการแจ้งเตือนรวม ${alerts} ครั้ง แบ่งเป็นคอยื่น ${forwardAlerts} ครั้ง และไหล่ห่อ ${roundedAlerts} ครั้ง ควรตรวจตำแหน่งหน้าจอ เก้าอี้ และท่านั่งระหว่างใช้งาน`;
        return;
    }

    if (forward > rounded * 1.2) {
        title.textContent = "พบค่ามุมคอไม่อยู่ในเกณฑ์ปกติเป็นหลัก";
        desc.textContent = `ค่ามุมคอไม่อยู่ในเกณฑ์ปกติประมาณ ${forwardPct.toFixed(0)}% ของเวลาที่ใช้งานจริง แต่ยังไม่มีการแจ้งเตือน อาจเป็นเพราะยังไม่ผิดท่าต่อเนื่องครบเวลาที่กำหนด`;
        return;
    }

    if (rounded > forward * 1.2) {
        title.textContent = "พบค่ามุมไหล่ไม่อยู่ในเกณฑ์ปกติเป็นหลัก";
        desc.textContent = `ค่ามุมไหล่ไม่อยู่ในเกณฑ์ปกติประมาณ ${roundedPct.toFixed(0)}% ของเวลาที่ใช้งานจริง แต่ยังไม่มีการแจ้งเตือน อาจเป็นเพราะยังไม่ผิดท่าต่อเนื่องครบเวลาที่กำหนด`;
        return;
    }

    title.textContent = "พบค่ามุมไม่อยู่ในเกณฑ์ปกติ";
    desc.textContent = "ระบบพบช่วงเวลาที่ค่ามุมคอหรือค่ามุมไหล่ไม่อยู่ในเกณฑ์ปกติ ควรปรับท่านั่งและพักยืดเหยียดเป็นระยะ";
}

function renderRecommendations({
    score,
    forwardPct,
    roundedPct,
    issuePct,
    alerts,
    forwardAlerts,
    roundedAlerts,
}) {
    const recs = [];

    if (score >= 85) {
        recs.push("ท่าทางโดยรวมอยู่ในเกณฑ์ปกติ ควรรักษาระดับสายตาและตำแหน่งศีรษะกับไหล่ให้เหมาะสม");
    } else if (score >= 70) {
        recs.push("ควรพักสายตาและยืดเหยียดคอ ไหล่ และสะบักทุก 30-45 นาที");
    } else if (score >= 50) {
        recs.push("ควรปรับระดับหน้าจอให้อยู่ใกล้ระดับสายตา และจัดหัวไหล่ให้อยู่ในแนวผ่อนคลาย");
    } else {
        recs.push("ควรหยุดพักชั่วคราว ปรับเก้าอี้ หน้าจอ และท่านั่งก่อนเริ่มใช้งานต่อ");
    }

    if (forwardAlerts > 0 || forwardPct >= 15) {
        recs.push("พบค่ามุมคอไม่อยู่ในเกณฑ์ปกติ ควรดึงคางกลับเล็กน้อยและหลีกเลี่ยงการยื่นหน้าเข้าใกล้หน้าจอ");
    }

    if (roundedAlerts > 0 || roundedPct >= 15) {
        recs.push("พบค่ามุมไหล่ไม่อยู่ในเกณฑ์ปกติ ควรดึงหัวไหล่กลับ เปิดอก และผ่อนคลายกล้ามเนื้อไหล่เป็นระยะ");
    }

    if (alerts >= 5) {
        recs.push("มีการแจ้งเตือนหลายครั้ง ควรลดระยะเวลานั่งต่อเนื่องและเพิ่มช่วงพักสั้น ๆ");
    }

    if (issuePct >= 40 && alerts === 0) {
        recs.push("มีช่วงเวลาที่ค่ามุมไม่อยู่ในเกณฑ์ปกติค่อนข้างมาก แต่ยังไม่มีการแจ้งเตือน อาจเกิดจากยังไม่ผิดท่าต่อเนื่องครบเวลาที่กำหนด");
    }

    setHTML("recList", recs.slice(0, 3).map((r) => `<li>${r}</li>`).join(""));
}

function percent(value, total) {
    if (!total || total <= 0) return 0;
    return (Number(value) / Number(total)) * 100;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function formatTime(totalSeconds) {
    const s = Math.floor(Number(totalSeconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    if (h > 0) {
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }

    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function setText(id, value) {
    const el = $(id);
    if (!el) return;
    el.textContent = value;
}

function setHTML(id, value) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = value;
}

function setWidth(id, value) {
    const el = $(id);
    if (!el) return;
    el.style.width = value;
}