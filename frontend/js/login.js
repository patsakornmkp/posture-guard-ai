/* =========================================
   Login Page
   File: frontend/js/login.js

   UX minimal-change:
   1) กันผู้ใช้ที่ login แล้วกลับมาหน้า login
   2) กัน submit ซ้ำ
   3) ตรวจ input ก่อนเรียก backend
   4) แสดง loading/error ใน message เดิม
   5) login สำเร็จแล้ว redirect ด้วย replace
   6) ถ้ามี active monitoring session จะกลับ monitoring
========================================= */

(function () {
    "use strict";

    document.addEventListener("DOMContentLoaded", async () => {
        if (!window.api || !window.utils) {
            alert("ระบบ frontend โหลดไม่ครบ กรุณาตรวจสอบการเรียกไฟล์ app.js");
            window.location.replace("login.html");
            return;
        }

        const canStayOnLogin = await utils.redirectAuthenticatedAwayFromAuthPage();

        if (!canStayOnLogin) {
            return;
        }

        const loginForm = document.getElementById("loginForm");
        const usernameInput = document.getElementById("username");
        const passwordInput = document.getElementById("password");
        const msg = document.getElementById("message");
        const submitBtn = document.getElementById("submitBtn");

        if (!loginForm || !usernameInput || !passwordInput || !msg || !submitBtn) {
            console.error("login.js: login form elements ไม่ครบ");
            return;
        }

        let isSubmitting = false;
        const defaultButtonText = submitBtn.textContent || "เข้าสู่ระบบ";

        loginForm.addEventListener("submit", async (event) => {
            event.preventDefault();

            if (isSubmitting) {
                return;
            }

            const username = usernameInput.value.trim();
            const password = passwordInput.value;

            const validationMessage = validateLoginForm(username, password);

            if (validationMessage) {
                showMessage(validationMessage, "error");
                focusInvalidInput(username, password);
                return;
            }

            isSubmitting = true;
            setFormLoading(true, "กำลังเข้าสู่ระบบ...");

            try {
                const user = await api.login(username, password);

                if (!user || !user.id) {
                    throw new Error("ข้อมูลผู้ใช้จาก backend ไม่ถูกต้อง");
                }

                localStorage.setItem("currentUser", JSON.stringify(user));

                showMessage("เข้าสู่ระบบสำเร็จ กำลังตรวจสอบ session...", "success");

                const session = await utils.getBackendSessionStatus();

                if (session.status === "active") {
                    utils.markMonitoringSessionStarted();
                    utils.redirectTo("monitoring.html", { replace: true });
                    return;
                }

                utils.clearSessionFlowState({ keepLast: false });
                utils.redirectTo("setup.html", { replace: true });
            } catch (err) {
                showMessage(
                    err.message || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง",
                    "error"
                );

                isSubmitting = false;
                setFormLoading(false);
            }
        });

        function validateLoginForm(username, password) {
            if (!username) {
                return "กรุณากรอก Username";
            }

            if (!password) {
                return "กรุณากรอก Password";
            }

            return "";
        }

        function focusInvalidInput(username, password) {
            if (!username) {
                usernameInput.focus();
                return;
            }

            if (!password) {
                passwordInput.focus();
            }
        }

        function showMessage(text, type = "error") {
            msg.hidden = false;
            msg.textContent = text;

            if (type === "success") {
                msg.classList.add("success");
            } else {
                msg.classList.remove("success");
            }
        }

        function hideMessage() {
            msg.hidden = true;
            msg.textContent = "";
            msg.classList.remove("success");
        }

        function setFormLoading(isLoading, loadingText = "กำลังเข้าสู่ระบบ...") {
            submitBtn.disabled = isLoading;
            submitBtn.textContent = isLoading ? loadingText : defaultButtonText;

            usernameInput.disabled = isLoading;
            passwordInput.disabled = isLoading;

            if (isLoading) {
                hideMessage();
            }
        }
    });
})();