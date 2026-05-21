document.addEventListener('DOMContentLoaded', async () => {
    const canUseSetup = await utils.requireNoActiveMonitoring();
    if (!canUseSetup) return;

    const user = utils.getCurrentUser();
    if (!user) return;

    const startBtn = document.getElementById('startBtn');

    if (!startBtn) {
        console.error('setup.js: startBtn ไม่พบในหน้า setup.html');
        return;
    }

    // โหมด realtime = ไม่จำกัดเวลา
    // ตั้งเป็น 0 เพื่อกันไฟล์อื่นอ่านค่า plannedMinutes ค้างจาก session ก่อนหน้า
    localStorage.setItem('plannedMinutes', '0');

    startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        startBtn.textContent = 'กำลังเริ่ม...';

        try {
            // เคลียร์ session เก่า ถ้ามีค้างอยู่
            try {
                await api.stopSession();
            } catch (_) {}

            // เคลียร์กล้องเก่า ถ้ามีค้างอยู่
            try {
                await api.stopCamera();
            } catch (_) {}

            // เริ่มกล้อง
            await api.startCamera();

            // ส่ง 0 = ไม่จำกัดเวลา / realtime mode
            const result = await api.startSession(user.id, 0);

            utils.markMonitoringSessionStarted(result.session_id);

            // ใช้ replace เพื่อไม่ให้ browser back กลับมาหน้า setup ระหว่าง monitoring active
            utils.redirectTo('monitoring.html', { replace: true });
        } catch (err) {
            // ถ้าเปิดกล้องสำเร็จแล้ว แต่เริ่ม session ไม่สำเร็จ ให้พยายามปิดกล้องกันค้าง
            try {
                await api.stopCamera();
            } catch (_) {}

            utils.clearSessionFlowState({ keepLast: true });

            alert('ไม่สามารถเริ่ม session ได้: ' + err.message);

            startBtn.disabled = false;
            startBtn.textContent = '▶ เริ่มใช้งาน';
        }
    });
});