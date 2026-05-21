/* =========================================
   PostureGuard Layout Loader
   File: frontend/js/layout.js

   ใช้โหลด header/footer และจัดการเมนูหลักของระบบ

   UX minimal-change:
   1) ไม่ redesign UI
   2) ไม่เปลี่ยนโครงสร้าง header/footer เดิม
   3) กัน logout ระหว่าง active monitoring
   4) กันคลิก navigation ไป setup/history ระหว่าง active monitoring
   5) ใช้ session guard จาก app.js เป็นหลัก
========================================= */

(function () {
    "use strict";

    async function loadComponent(id, path) {
        const el = document.getElementById(id);

        if (!el) {
            return;
        }

        try {
            const res = await fetch(path, {
                cache: "no-store",
            });

            if (!res.ok) {
                throw new Error(`โหลด component ไม่สำเร็จ: ${path}`);
            }

            el.innerHTML = await res.text();
        } catch (err) {
            console.error(err);

            // ไม่ให้หน้า crash ถ้า header/footer โหลดไม่ได้
            el.innerHTML = "";
        }
    }

    function getCurrentUserSafe() {
        if (window.utils && typeof window.utils.getCurrentUser === "function") {
            return window.utils.getCurrentUser();
        }

        const userRaw = localStorage.getItem("currentUser");

        if (!userRaw) {
            return null;
        }

        try {
            return JSON.parse(userRaw);
        } catch (err) {
            localStorage.removeItem("currentUser");
            return null;
        }
    }

    function initUserArea() {
        const userName = document.getElementById("userName");
        const logoutBtn = document.getElementById("logoutBtn");

        const user = getCurrentUserSafe();

        if (userName) {
            userName.textContent = user
                ? `สวัสดี, ${user.full_name || user.username || "ผู้ใช้งาน"}`
                : "ผู้ใช้งาน";
        }

        if (logoutBtn) {
            logoutBtn.addEventListener("click", handleLogoutClick);
        }
    }

    async function handleLogoutClick() {
        const logoutBtn = document.getElementById("logoutBtn");

        if (!logoutBtn) {
            return;
        }

        const originalText = logoutBtn.textContent;

        logoutBtn.disabled = true;
        logoutBtn.textContent = "กำลังตรวจสอบ...";

        try {
            const isMonitoringPage = document.body.classList.contains("app-monitoring");
            const hasLocalActiveSession =
                window.utils &&
                typeof window.utils.isMonitoringSessionActive === "function" &&
                window.utils.isMonitoringSessionActive();

            if (isMonitoringPage || hasLocalActiveSession) {
                alert(
                    "กรุณากดปุ่มหยุดการใช้งานก่อนออกจากระบบ เพื่อให้ระบบบันทึกและสรุปผลได้ถูกต้อง"
                );

                if (window.utils && typeof window.utils.redirectTo === "function") {
                    window.utils.redirectTo("monitoring.html", { replace: true });
                }

                return;
            }

            if (
                window.utils &&
                typeof window.utils.getBackendSessionStatus === "function"
            ) {
                const session = await window.utils.getBackendSessionStatus();

                if (session.status === "active") {
                    alert(
                        "ระบบยังมี session ที่กำลังทำงานอยู่ กรุณาหยุดการใช้งานก่อนออกจากระบบ"
                    );

                    window.utils.redirectTo("monitoring.html", { replace: true });
                    return;
                }
            }

            if (window.utils && typeof window.utils.logout === "function") {
                window.utils.logout();
                return;
            }

            fallbackLogout();
        } catch (err) {
            console.error("logout error:", err);

            alert(
                "ไม่สามารถตรวจสอบสถานะ session ได้\n\n" +
                "กรุณาตรวจสอบว่า backend เปิดอยู่ หรือกลับไปหยุดการใช้งานก่อนออกจากระบบ"
            );
        } finally {
            logoutBtn.disabled = false;
            logoutBtn.textContent = originalText;
        }
    }

    function fallbackLogout() {
        localStorage.removeItem("currentUser");
        localStorage.removeItem("currentSessionId");
        localStorage.removeItem("lastSessionId");
        localStorage.removeItem("lastSessionSummary");
        localStorage.removeItem("plannedMinutes");
        localStorage.removeItem("monitoringSessionActive");

        window.location.replace("login.html");
    }

    function setActiveNav() {
        const currentPage = window.location.pathname.split("/").pop();
        const links = document.querySelectorAll(".topbar-link");

        links.forEach((link) => {
            const href = link.getAttribute("href");

            if (href === currentPage) {
                link.classList.add("active");
                link.setAttribute("aria-current", "page");
            } else {
                link.classList.remove("active");
                link.removeAttribute("aria-current");
            }
        });
    }

    function initNavigationGuard() {
        const links = document.querySelectorAll(".topbar-link, .topbar-brand");

        links.forEach((link) => {
            link.addEventListener("click", handleNavigationClick);
        });
    }

    function handleNavigationClick(event) {
        const link = event.currentTarget;
        const href = link.getAttribute("href");

        if (!href) {
            event.preventDefault();
            return;
        }

        const currentPage = window.location.pathname.split("/").pop();

        if (href === currentPage) {
            event.preventDefault();
            return;
        }

        const hasLocalActiveSession =
            window.utils &&
            typeof window.utils.isMonitoringSessionActive === "function" &&
            window.utils.isMonitoringSessionActive();

        const isMonitoringPage = document.body.classList.contains("app-monitoring");

        if (hasLocalActiveSession || isMonitoringPage) {
            event.preventDefault();

            alert(
                "ขณะกำลังตรวจจับท่าทาง กรุณากดปุ่มหยุดการใช้งานก่อนเปลี่ยนหน้า"
            );

            if (window.utils && typeof window.utils.redirectTo === "function") {
                window.utils.redirectTo("monitoring.html", { replace: true });
            }

            return;
        }

        // ให้ browser ทำ navigation ปกติ เพื่อไม่กระทบ UI/flow เดิม
    }

    function lockNavigationDuringMonitoring() {
        const isMonitoringPage = document.body.classList.contains("app-monitoring");

        const hasLocalActiveSession =
            window.utils &&
            typeof window.utils.isMonitoringSessionActive === "function" &&
            window.utils.isMonitoringSessionActive();

        if (!isMonitoringPage && !hasLocalActiveSession) {
            return;
        }

        const nav = document.querySelector(".topbar-nav");

        if (nav) {
            nav.innerHTML = `
                <span class="session-badge">
                    <span class="session-dot"></span>
                    กำลังตรวจจับท่าทาง
                </span>
            `;
        }

        const logo = document.querySelector(".topbar-brand");

        if (logo) {
            logo.removeAttribute("href");
            logo.setAttribute("aria-disabled", "true");
            logo.style.cursor = "default";
        }
    }

    function simplifySummaryHeader() {
        const isSummaryPage = document.body.classList.contains("app-summary");

        if (!isSummaryPage) {
            return;
        }

        const setupLink = document.querySelector('.topbar-link[href="setup.html"]');

        if (setupLink) {
            setupLink.style.display = "none";
        }
    }

    function markLayoutReady() {
        document.body.classList.add("layout-ready");
    }

    document.addEventListener("DOMContentLoaded", async () => {
        await loadComponent("header", "../components/header.html");
        await loadComponent("footer", "../components/footer.html");

        initUserArea();
        setActiveNav();
        initNavigationGuard();
        lockNavigationDuringMonitoring();
        simplifySummaryHeader();
        markLayoutReady();
    });
})();