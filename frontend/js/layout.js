/* =========================================
   PostureGuard Layout Loader
   File: frontend/js/layout.js
========================================= */

(function () {
    "use strict";

    async function loadComponent(id, path) {
        const el = document.getElementById(id);
        if (!el) return;

        try {
            const res = await fetch(path);

            if (!res.ok) {
                throw new Error(`โหลด component ไม่สำเร็จ: ${path}`);
            }

            el.innerHTML = await res.text();
        } catch (err) {
            console.error(err);
            el.innerHTML = "";
        }
    }

    function initUserArea() {
        const userName = document.getElementById("userName");
        const logoutBtn = document.getElementById("logoutBtn");
        const userRaw = localStorage.getItem("currentUser");

        if (userName && userRaw) {
            try {
                const user = JSON.parse(userRaw);
                userName.textContent = `สวัสดี, ${user.full_name || user.username || "ผู้ใช้งาน"}`;
            } catch (err) {
                userName.textContent = "ผู้ใช้งาน";
            }
        }

        if (logoutBtn) {
            logoutBtn.addEventListener("click", () => {
                const isMonitoringPage = document.body.classList.contains("app-monitoring");

                if (isMonitoringPage) {
                    alert("กรุณากดปุ่มหยุดการใช้งานก่อนออกจากระบบ เพื่อให้ระบบบันทึกและสรุปผลได้ถูกต้อง");
                    return;
                }

                localStorage.removeItem("currentUser");
                localStorage.removeItem("currentSessionId");
                localStorage.removeItem("lastSessionId");
                localStorage.removeItem("plannedMinutes");

                window.location.href = "login.html";
            });
        }
    }

    function setActiveNav() {
        const currentPage = window.location.pathname.split("/").pop();
        const links = document.querySelectorAll(".topbar-link");

        links.forEach((link) => {
            const href = link.getAttribute("href");

            if (href === currentPage) {
                link.classList.add("active");
            } else {
                link.classList.remove("active");
            }
        });
    }

    function lockNavigationDuringMonitoring() {
        const isMonitoringPage = document.body.classList.contains("app-monitoring");
        if (!isMonitoringPage) return;

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
            logo.style.cursor = "default";
        }
    }

    function simplifySummaryHeader() {
        const isSummaryPage = document.body.classList.contains("app-summary");
        if (!isSummaryPage) return;

        const setupLink = document.querySelector('.topbar-link[href="setup.html"]');

        if (setupLink) {
            setupLink.style.display = "none";
        }
    }

    document.addEventListener("DOMContentLoaded", async () => {
        await loadComponent("header", "../components/header.html");
        await loadComponent("footer", "../components/footer.html");

        initUserArea();
        setActiveNav();
        lockNavigationDuringMonitoring();
        simplifySummaryHeader();
    });
})();