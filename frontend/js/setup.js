document.addEventListener('DOMContentLoaded', async () => {
    const startBtn = document.getElementById('startBtn');

    if (!startBtn) {
        console.error('setup.js: startBtn ไม่พบในหน้า setup.html');
        return;
    }

    let isStarting = false;
    const defaultButtonText = '▶ เริ่มใช้งาน';

    function setStartButtonLoading(isLoading, text = 'กำลังเตรียมระบบ...') {
        startBtn.disabled = isLoading;
        startBtn.textContent = isLoading ? text : defaultButtonText;
    }

    function showStartError(message) {
        alert(message);
    }

    // ล็อกปุ่มไว้ก่อน ระหว่างตรวจสอบ flow
    setStartButtonLoading(true, 'กำลังตรวจสอบสถานะ...');

    const canUseSetup = await utils.requireNoActiveMonitoring();

    if (!canUseSetup) {
        return;
    }

    const user = utils.getCurrentUser();

    if (!user) {
        utils.redirectTo('login.html', { replace: true });
        return;
    }

    // โหมด realtime = ไม่จำกัดเวลา
    // ตั้งเป็น 0 เพื่อกันค่า plannedMinutes ค้างจาก session ก่อนหน้า
    localStorage.setItem('plannedMinutes', '0');

    setStartButtonLoading(false);

    startBtn.addEventListener('click', async () => {
        if (isStarting) {
            return;
        }

        isStarting = true;
        setStartButtonLoading(true, 'กำลังเริ่มระบบ...');

        try {
            // เคลียร์ session เก่าที่อาจค้างใน backend
            // ถ้าไม่มี session อยู่แล้ว ให้ข้าม error ได้
            setStartButtonLoading(true, 'กำลังตรวจสอบ session เดิม...');

            try {
                await api.stopSession();
            } catch (_) {
                // ไม่มี session เก่า หรือ backend แจ้งว่าไม่มี session ให้ข้ามได้
            }

            // เคลียร์กล้องเก่าที่อาจค้างอยู่
            setStartButtonLoading(true, 'กำลังเตรียมกล้อง...');

            try {
                await api.stopCamera();
            } catch (_) {
                // ไม่มีกล้องค้างอยู่ ให้ข้ามได้
            }

            // เริ่มกล้อง
            await api.startCamera();

            // เริ่ม session แบบ realtime
            // planned_duration_minutes = 0 หมายถึงผู้ใช้กดหยุดเอง
            setStartButtonLoading(true, 'กำลังเริ่มการตรวจจับ...');

            const result = await api.startSession(user.id, 0);

            if (!result || result.session_id === undefined || result.session_id === null) {
                throw new Error('backend ไม่ได้ส่ง session_id กลับมา');
            }

            utils.markMonitoringSessionStarted(result.session_id);

            // ใช้ replace เพื่อไม่ให้ browser back กลับมาหน้า setup ระหว่าง monitoring
            utils.redirectTo('monitoring.html', { replace: true });
        } catch (err) {
            // ถ้าเปิดกล้องสำเร็จบางส่วน แต่เริ่ม session ไม่สำเร็จ ให้พยายามปิดกล้องกันค้าง
            try {
                await api.stopCamera();
            } catch (_) {
                // ถ้าปิดกล้องไม่สำเร็จ ไม่ควรทำให้หน้า setup crash
            }

            utils.clearSessionFlowState({ keepLast: true });

            showStartError(
                'ไม่สามารถเริ่มการตรวจจับได้\n\n' +
                'สาเหตุ: ' + err.message + '\n\n' +
                'กรุณาตรวจสอบว่า backend เปิดอยู่ และกล้องพร้อมใช้งาน'
            );

            isStarting = false;
            setStartButtonLoading(false);
        }
    });
});