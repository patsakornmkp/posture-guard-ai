document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const fullName = document.getElementById('fullName').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const msg = document.getElementById('message');
    const btn = document.getElementById('submitBtn');

    msg.hidden = true;
    msg.classList.remove('success');

    btn.disabled = true;
    btn.textContent = 'กำลังสมัคร...';

    try {
        await api.register(username, password, fullName);

        msg.hidden = false;
        msg.textContent = 'สมัครสมาชิกสำเร็จ กำลังไปหน้าเข้าสู่ระบบ...';
        msg.classList.add('success');

        setTimeout(() => {
            window.location.href = 'login.html';
        }, 1000);
    } catch (err) {
        msg.hidden = false;
        msg.classList.remove('success');
        msg.textContent = err.message || 'สมัครไม่สำเร็จ';

        btn.disabled = false;
        btn.textContent = 'สมัครสมาชิก';
    }
});