    // Purge any legacy browser mock caches on startup to ensure 100% live Supabase data
    ['sfmi_members_registry', 'sfmi_sub_admins_registry', 'sfmi_service_attendance_map', 'sfmi_fin_reconciliation_entries', 'sfmi_service_finances', 'sfmi_custom_programs'].forEach(k => {
      try { localStorage.removeItem(k); } catch(e) {}
    });

    const API_BASE = (() => {
      const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      return isLocal ? 'http://localhost:4000/api/v1' : '/api/v1';
    })();

    // Centralized safe HTML sanitizer to prevent XSS attacks in dynamic tables
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function normalizePhoneClient(raw) {
      if (!raw) return '';
      const digits = String(raw).replace(/[^\d]/g, '');
      if (digits.startsWith('233') && digits.length >= 12) return '0' + digits.slice(3);
      if (digits.length === 9 && !digits.startsWith('0')) return '0' + digits;
      return digits;
    }

    function getCalendarIsoDate(dateRaw) {
      if (!dateRaw) return '';
      if (typeof dateRaw === 'string') {
        const m = dateRaw.match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];
      }
      const d = new Date(dateRaw);
      if (isNaN(d.getTime())) return '';
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    function formatCalendarDateLabel(dateRaw, options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
      if (!dateRaw) return 'Session';
      const iso = getCalendarIsoDate(dateRaw);
      if (iso) {
        const [y, m, d] = iso.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return dt.toLocaleDateString(undefined, options);
      }
      const dt = new Date(dateRaw);
      return !isNaN(dt.getTime()) ? dt.toLocaleDateString(undefined, options) : 'Session';
    }

    function formatLocalDate(d = new Date()) {
      if (typeof d === 'string') {
        const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];
      }
      const dateObj = typeof d === 'string' ? new Date(d) : d;
      if (!dateObj || isNaN(dateObj.getTime())) return '';
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    let allMembers = [];
    const deletedMemberIds = new Set();
    let serviceAttendanceMap = {};

    let currentSelectedService = 'ALL';
    let currentAttFilter = 'ALL'; // 'ALL', 'PRESENT', 'ABSENT', 'GUEST'

    let rawFinanceEntries = [];
    let filteredFinanceEntries = [];

    /* ── TAB PRIVILEGES ENFORCEMENT & SUB-ADMIN MANAGEMENT ── */
    let subAdminsList = [];

    async function getAdminAuthToken() {
      let token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');

      // Check if JWT token is valid and not expiring in next 60 seconds
      let isExpired = false;
      if (token && token.includes('.') && !token.startsWith('sfmi_')) {
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          const nowSec = Math.floor(Date.now() / 1000);
          if (payload.exp && payload.exp < (nowSec + 60)) {
            isExpired = true;
          }
        } catch (e) {}
      }

      if (token && !isExpired) {
        return token;
      }

      // Try refresh token if available
      const refreshTokenVal = sessionStorage.getItem('sfmi_refresh_token') || localStorage.getItem('sfmi_refresh_token');
      if (refreshTokenVal) {
        try {
          const rRes = await fetch(`${API_BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: refreshTokenVal })
          });
          if (rRes.ok) {
            const rData = await rRes.json();
            if (rData.accessToken) {
              token = rData.accessToken;
              sessionStorage.setItem('sfmi_token', token);
              localStorage.setItem('sfmi_token', token);
              if (rData.refreshToken) {
                sessionStorage.setItem('sfmi_refresh_token', rData.refreshToken);
                localStorage.setItem('sfmi_refresh_token', rData.refreshToken);
              }
              return token;
            }
          }
        } catch (rErr) {}
      }

      return token || '';
    }

    async function getAuthHeaders() {
      const token = await getAdminAuthToken();
      return token ? { 'Authorization': `Bearer ${token}` } : {};
    }

    async function loadSubAdmins() {
      let currentUser = null;
      try {
        currentUser = JSON.parse(sessionStorage.getItem('sfmi_current_user') || localStorage.getItem('sfmi_current_user'));
      } catch (e) {}

      // Sub-Admins cannot access and do not load the Sub-Admins management list
      if (currentUser && (currentUser.role === 'SUB_ADMIN' || currentUser.role === 'ADMIN')) {
        subAdminsList = [];
        renderSubAdminsList();
        return;
      }

      try {
        const token = await getAdminAuthToken();
        const res = await fetch(`${API_BASE}/auth/subadmins`, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        if (res.ok) {
          const cloudList = await res.json();
          if (Array.isArray(cloudList)) {
            subAdminsList = cloudList;
            renderSubAdminsList();
            return;
          }
        }
      } catch (err) {}

      subAdminsList = [];
      renderSubAdminsList();
    }

    function applyTabPermissions() {
      let currentUser = null;
      try {
        currentUser = JSON.parse(sessionStorage.getItem('sfmi_current_user') || localStorage.getItem('sfmi_current_user'));
      } catch (e) {}

      const isSubAdmin = currentUser && (currentUser.role === 'SUB_ADMIN' || currentUser.role === 'ADMIN');
      const isSuperAdmin = !isSubAdmin;

      // Sub-Admins NEVER have access to Financial Overview & Analytics or Staff & Sub-Admins
      // They are strictly limited to the privileges granted to them (Attendance, Members, Programs, Pledges, Reports, Financial Reports)
      const rawPerms = (currentUser && Array.isArray(currentUser.permissions)) 
        ? currentUser.permissions 
        : ['attendance', 'members', 'programs', 'partnership', 'reports'];

      const permissions = isSuperAdmin 
        ? ['finance', 'attendance', 'analytics', 'visitors', 'members', 'programs', 'partnership', 'subAdmins', 'reports', 'finReports', 'settings']
        : rawPerms.filter(p => p !== 'finance' && p !== 'subAdmins');

      if (!isSuperAdmin && (rawPerms.includes('attendance') || rawPerms.includes('members') || rawPerms.includes('visitors'))) {
        if (!permissions.includes('analytics')) permissions.push('analytics');
        if (!permissions.includes('visitors')) permissions.push('visitors');
      }
      if (!permissions.includes('settings')) permissions.push('settings');

      const allTabs = ['finance', 'attendance', 'analytics', 'visitors', 'members', 'programs', 'partnership', 'subAdmins', 'reports', 'finReports', 'settings'];
      let firstAllowedTab = null;

      allTabs.forEach(t => {
        const isAllowed = permissions.includes(t);
        if (isAllowed && !firstAllowedTab) firstAllowedTab = t;

        const desktopBtn = document.getElementById(`tabBtn${t.charAt(0).toUpperCase() + t.slice(1)}`);
        const mobBtn = document.getElementById(`mobBtn${t.charAt(0).toUpperCase() + t.slice(1)}`);
        const sec = document.getElementById(`sec${t.charAt(0).toUpperCase() + t.slice(1)}`);

        if (desktopBtn) desktopBtn.style.display = isAllowed ? 'inline-flex' : 'none';
        if (mobBtn) mobBtn.style.display = isAllowed ? 'flex' : 'none';
        if (!isAllowed && sec) sec.style.display = 'none';
      });

      // Strict enforcement: Financial Overview & Analytics tab & section is NEVER visible to Sub-Admins
      const finBtn = document.getElementById('tabBtnFinance');
      if (finBtn && !isSuperAdmin) finBtn.style.display = 'none';
      const mobFinBtn = document.getElementById('mobBtnFinance');
      if (mobFinBtn && !isSuperAdmin) mobFinBtn.style.display = 'none';
      const secFin = document.getElementById('secFinance');
      if (secFin && !isSuperAdmin) secFin.style.display = 'none';

      // Manage Sub-Admins button & tab is strictly Super Admin only
      const btnSub = document.getElementById('btnManageSubAdmins');
      if (btnSub) btnSub.style.display = isSuperAdmin ? 'inline-flex' : 'none';
      const tabSub = document.getElementById('tabBtnSubAdmins');
      if (tabSub) tabSub.style.display = isSuperAdmin ? 'inline-flex' : 'none';
      const mobSub = document.getElementById('mobBtnSubAdmins');
      if (mobSub) mobSub.style.display = isSuperAdmin ? 'flex' : 'none';

      // Services Financial Analytics Report tab & section strictly governed by 'finReports' permission
      const hasFinReports = permissions.includes('finReports');
      const tabFinReports = document.getElementById('tabBtnFinReports');
      if (tabFinReports) tabFinReports.style.display = hasFinReports ? 'inline-flex' : 'none';
      const mobFinReports = document.getElementById('mobBtnFinReports');
      if (mobFinReports) mobFinReports.style.display = hasFinReports ? 'flex' : 'none';
      const secFinReports = document.getElementById('secFinReports');
      if (secFinReports && !hasFinReports) secFinReports.style.display = 'none';

      // Always switch to their first permitted tab
      if (firstAllowedTab) {
        switchTab(firstAllowedTab);
      } else {
        switchTab(isSuperAdmin ? 'finance' : 'attendance');
      }
    }

    function openManageSubAdminsModal() {
      renderSubAdminsList();
      const modal = document.getElementById('manageSubAdminsModal');
      if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('active');
      }
    }

    function closeManageSubAdminsModal() {
      const modal = document.getElementById('manageSubAdminsModal');
      if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
      }
    }

    function openCreateSubAdminModal() {
      const modal = document.getElementById('createSubAdminModal');
      if (!modal) return;
      modal.style.display = 'flex';
      modal.classList.add('active');
      const input = document.getElementById('newSubName');
      if (input) setTimeout(() => input.focus(), 50);
    }

    function closeCreateSubAdminModal() {
      const modal = document.getElementById('createSubAdminModal');
      if (!modal) return;
      modal.style.display = 'none';
      modal.classList.remove('active');
    }

    function renderSubAdminsList() {
      const container = document.getElementById('subAdminsListContainer');
      const tbody = document.getElementById('subAdminsTableBody');
      const mobCards = document.getElementById('subAdminsMobileCards');

      const buildBadges = (sub) => (sub.permissions || []).map(p => {
        if (p === 'attendance') return `<span class="badge-check" style="background:#e0f2fe; color:#0369a1;"><i class="fas fa-list-check"></i> Attendance</span>`;
        if (p === 'members') return `<span class="badge-check" style="background:#dcfce7; color:#166534;"><i class="fas fa-users"></i> Directory</span>`;
        if (p === 'programs') return `<span class="badge-check" style="background:#fef3c7; color:#92400e;"><i class="fas fa-calendar-star"></i> Programs</span>`;
        if (p === 'partnership') return `<span class="badge-check" style="background:#fef9c3; color:#854d0e;"><i class="fas fa-handshake"></i> Partnership</span>`;
        if (p === 'reports') return `<span class="badge-check" style="background:#e0e7ff; color:#3730a3;"><i class="fas fa-clipboard-user"></i> Attendance Reports</span>`;
        if (p === 'finReports') return `<span class="badge-check" style="background:#fef2f2; color:#b91c1c;"><i class="fas fa-file-invoice-dollar"></i> Financial Reports</span>`;
        if (p === 'finance') return `<span class="badge-check" style="background:#fee2e2; color:#991b1b;"><i class="fas fa-coins"></i> Finance</span>`;
        if (p === 'women') return `<span class="badge-check" style="background:#fff1f2; color:#be123c;"><i class="fas fa-venus"></i> Women Ministry</span>`;
        return '';
      }).join(' ');

      // Render Modal Container
      if (container) {
        if (subAdminsList.length === 0) {
          container.innerHTML = `<div style="text-align:center; color:var(--muted); padding:30px;">No sub-admin accounts created yet. Click "+ Create New Sub-Admin" above to add staff.</div>`;
        } else {
          container.innerHTML = subAdminsList.map(sub => `
            <div style="background:#fafbfa; border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
              <div>
                <div style="font-weight:800; font-size:15px; color:var(--ink);">${sub.name} <span style="font-size:11px; font-weight:700; background:#111; color:white; padding:2px 8px; border-radius:12px; margin-left:6px;">Sub-Admin</span></div>
                <div style="font-size:12.5px; color:var(--muted); margin-top:2px;"><i class="fas fa-envelope"></i> ${sub.email}</div>
                <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">${buildBadges(sub) || '<span style="font-size:11px; color:var(--muted);">No privileges assigned</span>'}</div>
              </div>
              <div style="display:flex; gap:6px;">
                <button class="btn-main" style="padding:6px 12px; font-size:12px; background:#c89b55; color:#111;" onclick="openEditSubAdminModal('${sub.id}')"><i class="fas fa-edit"></i> Edit Privileges</button>
                <button class="btn-main" style="padding:6px 12px; font-size:12px; background:#c5221f;" onclick="deleteSubAdmin('${sub.id}')"><i class="fas fa-trash-alt"></i> Revoke</button>
              </div>
            </div>`).join('');
        }
      }

      // Render Desktop Page Table
      if (tbody) {
        if (subAdminsList.length === 0) {
          tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:30px;">No sub-admin accounts created yet. Click "+ Create New Sub-Admin Account" above.</td></tr>`;
        } else {
          tbody.innerHTML = subAdminsList.map((sub, i) => `
            <tr>
              <td>${i + 1}</td>
              <td><strong>${escapeHtml(sub.name)}</strong> <span style="font-size:11px; font-weight:700; background:#111; color:white; padding:2px 8px; border-radius:12px; margin-left:4px;">Sub-Admin</span></td>
              <td><i class="fas fa-envelope" style="color:var(--muted); margin-right:4px;"></i> ${escapeHtml(sub.email)}</td>
              <td><div style="display:flex; gap:6px; flex-wrap:wrap;">${buildBadges(sub) || '<span style="font-size:11px; color:var(--muted);">No privileges</span>'}</div></td>
              <td>${escapeHtml(sub.createdAt) || '—'}</td>
              <td>
                <div style="display:flex; gap:6px;">
                  <button class="btn-main" style="padding:5px 11px; font-size:12px; background:#c89b55; color:#111;" onclick="openEditSubAdminModal('${sub.id}')"><i class="fas fa-edit"></i> Edit Privileges</button>
                  <button class="btn-main" style="padding:5px 11px; font-size:12px; background:#c5221f;" onclick="deleteSubAdmin('${sub.id}')"><i class="fas fa-trash-alt"></i> Revoke</button>
                </div>
              </td>
            </tr>`).join('');
        }
      }

      // Render Mobile Page Cards
      if (mobCards) {
        if (subAdminsList.length === 0) {
          mobCards.innerHTML = `<div style="text-align:center; color:var(--muted); padding:30px;">No sub-admin accounts created yet.</div>`;
        } else {
          mobCards.innerHTML = subAdminsList.map(sub => `
            <div class="mob-card">
              <div class="mob-card-header">
                <div class="mob-card-name">${escapeHtml(sub.name)}</div>
                <span style="font-size:11px; font-weight:700; background:#111; color:white; padding:3px 9px; border-radius:12px;">Sub-Admin</span>
              </div>
              <div class="mob-card-meta">
                <div class="mob-card-row"><span>Email / ID</span><strong>${escapeHtml(sub.email)}</strong></div>
                <div class="mob-card-row"><span>Created</span><strong>${escapeHtml(sub.createdAt) || '—'}</strong></div>
                <div style="margin-top:8px;">
                  <span style="font-size:12px; color:var(--muted); display:block; margin-bottom:4px;">Assigned Privileges:</span>
                  <div style="display:flex; gap:6px; flex-wrap:wrap;">${buildBadges(sub) || '<span style="font-size:11px; color:var(--muted);">No privileges</span>'}</div>
                </div>
              </div>
              <div class="mob-card-actions">
                <button class="btn-main" style="background:#c89b55; color:#111;" onclick="openEditSubAdminModal('${sub.id}')"><i class="fas fa-edit"></i> Edit Privileges</button>
                <button class="btn-main" style="background:#c5221f;" onclick="deleteSubAdmin('${sub.id}')"><i class="fas fa-trash-alt"></i> Revoke</button>
              </div>
            </div>`).join('');
        }
      }

      syncSubAdminsViewMode();
    }

    function syncSubAdminsViewMode() {
      const isMobile = window.innerWidth <= 700;
      const tbl = document.querySelector('#secSubAdmins .table-responsive');
      const cards = document.getElementById('subAdminsMobileCards');
      if (tbl) tbl.style.display = isMobile ? 'none' : 'block';
      if (cards) cards.style.display = isMobile ? 'block' : 'none';
    }

    window.addEventListener('resize', syncSubAdminsViewMode);

    async function handleCreateSubAdminSubmit(e) {
      e.preventDefault();
      const name = document.getElementById('newSubName').value.trim();
      const email = document.getElementById('newSubEmail').value.trim();
      const password = document.getElementById('newSubPassword').value.trim();
      const submitBtn = e.target.querySelector('button[type="submit"]');

      const perms = [];
      if (document.getElementById('permAttendance').checked) perms.push('attendance');
      if (document.getElementById('permMembers').checked) perms.push('members');
      if (document.getElementById('permPrograms').checked) perms.push('programs');
      if (document.getElementById('permPartnership')?.checked) perms.push('partnership');
      if (document.getElementById('permReports')?.checked) perms.push('reports');
      if (document.getElementById('permFinReports')?.checked) perms.push('finReports');
      if (document.getElementById('permWomen')?.checked) perms.push('women');

      if (perms.length === 0) {
        showToast('Please select at least one module privilege for this sub-admin.', 'error', 'No Privileges Selected');
        return;
      }

      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = 'Creating account…'; }

      // Persist in Cloud Database
      try {
        const token = await getAdminAuthToken();
        const res = await fetch(`${API_BASE}/auth/subadmins`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ name, email, password, permissions: perms })
        });

        if (res.ok) {
          const created = await res.json();
          subAdminsList = subAdminsList.filter(s => s.email.toLowerCase() !== email.toLowerCase());
          subAdminsList.unshift(created);
          closeCreateSubAdminModal();
          renderSubAdminsList();
          showToast(`Sub-Admin account for <strong>${escapeHtml(name)}</strong> saved directly to Supabase database!`, 'success', 'Sub-Admin Created');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Sub-Admin'; }
          return;
        } else {
          const err = await res.json();
          showToast(err.error || 'Failed to create sub-admin account in database.', 'error', 'Creation Failed');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Sub-Admin'; }
          return;
        }
      } catch (err) {
        showToast('Network error saving sub-admin account to Supabase.', 'error', 'Network Error');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Sub-Admin'; }
      }
    }

    function openEditSubAdminModal(id) {
      if (!subAdminsList || subAdminsList.length === 0) {
        loadSubAdmins();
      }
      const sub = subAdminsList.find(s => s.id === id);
      if (!sub) {
        showToast('Sub-admin details not found.', 'error', 'Error');
        return;
      }

      document.getElementById('editSubId').value = sub.id;
      document.getElementById('editSubName').value = sub.name;
      document.getElementById('editSubEmail').value = sub.email;
      if (document.getElementById('editSubPassword')) document.getElementById('editSubPassword').value = '';

      const perms = sub.permissions || [];
      document.getElementById('editPermAttendance').checked = perms.includes('attendance');
      document.getElementById('editPermMembers').checked = perms.includes('members');
      document.getElementById('editPermPrograms').checked = perms.includes('programs');
      if (document.getElementById('editPermPartnership')) document.getElementById('editPermPartnership').checked = perms.includes('partnership');
      if (document.getElementById('editPermReports')) document.getElementById('editPermReports').checked = perms.includes('reports');
      if (document.getElementById('editPermFinReports')) document.getElementById('editPermFinReports').checked = perms.includes('finReports');
      if (document.getElementById('editPermWomen')) document.getElementById('editPermWomen').checked = perms.includes('women');

      const modal = document.getElementById('editSubAdminModal');
      if (!modal) return;
      modal.style.display = 'flex';
      modal.classList.add('active');
    }

    function closeEditSubAdminModal() {
      const modal = document.getElementById('editSubAdminModal');
      if (!modal) return;
      modal.style.display = 'none';
      modal.classList.remove('active');
    }

    async function handleSaveEditSubAdminSubmit(e) {
      e.preventDefault();
      const id = document.getElementById('editSubId').value;
      const name = document.getElementById('editSubName').value.trim();
      const newPass = document.getElementById('editSubPassword') ? document.getElementById('editSubPassword').value.trim() : '';

      const perms = [];
      if (document.getElementById('editPermAttendance').checked) perms.push('attendance');
      if (document.getElementById('editPermMembers').checked) perms.push('members');
      if (document.getElementById('editPermPrograms').checked) perms.push('programs');
      if (document.getElementById('editPermPartnership')?.checked) perms.push('partnership');
      if (document.getElementById('editPermReports')?.checked) perms.push('reports');
      if (document.getElementById('editPermFinReports')?.checked) perms.push('finReports');
      if (document.getElementById('editPermWomen')?.checked) perms.push('women');

      if (perms.length === 0) {
        showToast('Please select at least one module privilege.', 'error', 'No Privileges Selected');
        return;
      }

      try {
        const token = await getAdminAuthToken();
        await fetch(`${API_BASE}/auth/subadmins/${id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ name, password: newPass, permissions: perms })
        });
      } catch (err) {}

      const sub = subAdminsList.find(s => s.id === id);
      if (sub) {
        sub.name = name;
        if (newPass) sub.password = newPass;
        sub.permissions = perms;
        closeEditSubAdminModal();
        renderSubAdminsList();

        let currentUser = null;
        try { currentUser = JSON.parse(sessionStorage.getItem('sfmi_current_user') || localStorage.getItem('sfmi_current_user')); } catch (err) {}
        if (currentUser && currentUser.email.toLowerCase() === sub.email.toLowerCase()) {
          currentUser.name = name;
          currentUser.permissions = perms;
          sessionStorage.setItem('sfmi_current_user', JSON.stringify(currentUser));
          applyTabPermissions();
        }

        showToast(`Privileges for <strong>${escapeHtml(name)}</strong> updated in Supabase!`, 'success', 'Privileges Updated');
      }
    }

    function deleteSubAdmin(id) {
      showConfirmModal(
        'Revoke Sub-Admin Account',
        'Are you sure you want to revoke and delete this sub-admin account from Supabase?',
        async () => {
          try {
            const token = await getAdminAuthToken();
            await fetch(`${API_BASE}/auth/subadmins/${id}`, {
              method: 'DELETE',
              headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
          } catch (e) {}
          subAdminsList = subAdminsList.filter(s => s.id !== id);
          renderSubAdminsList();
          showToast('Sub-admin account revoked from Supabase.', 'info', 'Account Revoked');
        },
        'fas fa-user-minus',
        'Revoke Account',
        '#c5221f'
      );
    }

    document.addEventListener('DOMContentLoaded', () => {
      initInactivityListeners();
      checkAuthSession();
      if (typeof initArkeselSmsSettings === 'function') initArkeselSmsSettings();
    });

    /* ── 12-HOUR EXTENDED INACTIVITY AUTO-LOGOUT SYSTEM ── */
    const INACTIVITY_LIMIT_MS = 12 * 60 * 60 * 1000; // 12 hours (extended working shift)
    let inactivityTimer = null;

    function initInactivityListeners() {
      const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];
      let throttleTimeout = null;

      events.forEach(evt => {
        window.addEventListener(evt, () => {
          if (!throttleTimeout) {
            throttleTimeout = setTimeout(() => {
              throttleTimeout = null;
              resetInactivityTimer();
            }, 2000);
          }
        }, { passive: true });
      });
    }

    function resetInactivityTimer() {
      const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token') || sessionStorage.getItem('sfmi_sub_session');
      if (!token) {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        return;
      }

      const now = Date.now();
      const lastActive = parseInt(sessionStorage.getItem('sfmi_admin_last_active') || localStorage.getItem('sfmi_admin_last_active') || '0', 10);

      // Check if already inactive past limit across tabs or refresh
      if (lastActive > 0 && (now - lastActive) > INACTIVITY_LIMIT_MS) {
        triggerAutoLogout();
        return;
      }

      sessionStorage.setItem('sfmi_admin_last_active', now.toString());
      localStorage.setItem('sfmi_admin_last_active', now.toString());

      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        triggerAutoLogout();
      }, INACTIVITY_LIMIT_MS);
    }

    function purgeAuthSession() {
      sessionStorage.removeItem('sfmi_token');
      sessionStorage.removeItem('sfmi_refresh_token');
      sessionStorage.removeItem('sfmi_sub_session');
      sessionStorage.removeItem('sfmi_current_user');
      sessionStorage.removeItem('sfmi_admin_last_active');
      localStorage.removeItem('sfmi_token');
      localStorage.removeItem('sfmi_refresh_token');
      localStorage.removeItem('sfmi_admin_auth');
      localStorage.removeItem('sfmi_current_user');
      localStorage.removeItem('sfmi_admin_last_active');
    }

    function triggerAutoLogout() {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      purgeAuthSession();
      showLogin();
      showToast('You were automatically logged out due to extended inactivity (12 hours).', 'warning', 'Session Timeout');
    }

    async function checkAuthSession() {
      const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
      const subToken = sessionStorage.getItem('sfmi_sub_session');

      // 1. If no session or token exists, show login screen
      if (!token && !subToken) {
        purgeAuthSession();
        showLogin();
        return;
      }

      // 2. If offline Super Admin or Sub-Admin session token, accept immediately
      if (token && (token.startsWith('sfmi_super_admin_session_') || token.startsWith('sfmi_sub_admin_session_'))) {
        resetInactivityTimer();
        showDashboard();
        return;
      }

      // 3. Verify active token with backend API before rendering dashboard
      if (token) {
        try {
          let currentToken = token;
          let res = await fetch(`${API_BASE}/auth/verify`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
          });

          // If expired, try seamless auto-refresh
          if (!res.ok) {
            currentToken = await getAdminAuthToken();
            if (currentToken) {
              res = await fetch(`${API_BASE}/auth/verify`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
              });
            }
          }

          if (res.ok) {
            const data = await res.json();
            const role = (data.user && data.user.role) ? data.user.role : '';

            if (role === 'FINANCE') {
              purgeAuthSession();
              showLogin();
              showToast('Access Denied: Treasury officers cannot access the Admin Portal.', 'error', 'Access Denied');
              return;
            }

            const isSubAdminRole = role === 'SUB_ADMIN' || role === 'ADMIN';
            sessionStorage.setItem('sfmi_token', currentToken);
            sessionStorage.setItem('sfmi_current_user', JSON.stringify({
              email: data.user.email,
              name: data.user.name || (isSubAdminRole ? 'Sub-Admin' : 'Super Admin'),
              role: isSubAdminRole ? 'SUB_ADMIN' : 'SUPER_ADMIN',
              permissions: (data.user && Array.isArray(data.user.permissions))
                ? data.user.permissions
                : (isSubAdminRole ? ['attendance', 'members', 'programs'] : ['finance', 'attendance', 'members', 'programs', 'reports', 'subAdmins'])
            }));
            localStorage.setItem('sfmi_current_user', sessionStorage.getItem('sfmi_current_user'));

            resetInactivityTimer();
            showDashboard();
            return;
          } else {
            // Token expired or invalid
            purgeAuthSession();
            showLogin();
            return;
          }
        } catch (err) {
          // If offline / network error, allow existing local session
          resetInactivityTimer();
          showDashboard();
          return;
        }
      }

      if (subToken) {
        resetInactivityTimer();
        showDashboard();
      }
    }

    function showLogin() {
      document.getElementById('loginScreen').style.display = 'block';
      document.getElementById('dashboardContent').style.display = 'none';
      const wrap = document.getElementById('adminLogoutWrap');
      if (wrap) wrap.style.display = 'none';
      const btn = document.getElementById('btnLogout');
      if (btn) btn.style.display = 'none';
      const actions = document.getElementById('headerNavActions');
      if (actions) actions.style.display = 'none';
    }

    function showDashboard() {
      let currentUser = null;
      try {
        currentUser = JSON.parse(sessionStorage.getItem('sfmi_current_user') || localStorage.getItem('sfmi_current_user'));
      } catch (e) {}
      const isSubAdmin = currentUser && (currentUser.role === 'SUB_ADMIN' || currentUser.role === 'ADMIN');
      const isSuperAdmin = !isSubAdmin;

      // Apply tab permissions first so sub-admins never see financial tabs
      applyTabPermissions();

      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('dashboardContent').style.display = 'block';
      const wrap = document.getElementById('adminLogoutWrap');
      if (wrap) wrap.style.display = 'flex';
      const btn = document.getElementById('btnLogout');
      if (btn) btn.style.display = 'inline-flex';
      const actions = document.getElementById('headerNavActions');
      if (actions) actions.style.display = 'flex';

      if (isSuperAdmin) {
        loadSubAdmins();
        loadFinanceData();
      }

      loadSavedMembers();
      loadCustomPrograms();
      loadPartnershipMatrix();
      populateServiceDropdowns();
      renderAttendanceAndDemographics();
      renderMembersTable();
      renderProgramsManager();
      fetchLiveCounts();
      loadVisitorsData();

      // Initialize unified real-time Server-Sent Events (SSE) & Smart Background Sync
      initRealtimeSync();

      // Proactive background session token renewal
      if (window.tokenKeepAliveTimer) clearInterval(window.tokenKeepAliveTimer);
      window.tokenKeepAliveTimer = setInterval(async () => {
        const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
        if (token && !token.startsWith('sfmi_')) {
          await getAdminAuthToken();
        }
      }, 15 * 60 * 1000); // Proactively renew token before expiry
    }

    function updateLiveSyncBadge(status, title) {
      const pill = document.getElementById('liveSyncStatusPill');
      const text = document.getElementById('liveSyncStatusText');
      if (!pill || !text) return;
      if (status === 'connected') {
        pill.className = 'live-sync-pill';
        pill.title = title || 'Live Real-Time Stream Connected: Auto-updates active across all modules';
        text.innerText = 'Live Sync Active';
      } else if (status === 'reconnecting') {
        pill.className = 'live-sync-pill reconnecting';
        pill.title = title || 'Reconnecting to live church stream...';
        text.innerText = 'Sync Reconnecting...';
      } else {
        pill.className = 'live-sync-pill offline';
        pill.title = title || 'Real-time stream offline / standby';
        text.innerText = 'Sync Standby';
      }
    }

    async function triggerManualSync() {
      showToast('Refreshing live data across all church modules...', 'info', 'Live Refresh');
      updateLiveSyncBadge('reconnecting', 'Synchronizing data from cloud...');
      try {
        await Promise.all([
          fetchLiveCounts(),
          loadSavedMembers(),
          loadVisitorsData()
        ]);
        updateDirectoryCounts();
        filterMembersTable();
        renderVisitorsSection();
        renderAttendanceAndDemographics();
        updateLiveSyncBadge('connected');
        showToast('Church Portal data is up to date!', 'success', 'Synchronized');
      } catch (e) {
        updateLiveSyncBadge('connected');
      }
    }

    function initRealtimeSync() {
      // 1. Establish Server-Sent Events (SSE) stream with backend
      if (window._sfmiEventSource) {
        try { window._sfmiEventSource.close(); } catch (e) {}
        window._sfmiEventSource = null;
      }

      try {
        const streamUrl = `${API_BASE}/realtime/stream`;
        const es = new EventSource(streamUrl);
        window._sfmiEventSource = es;

        es.onopen = () => {
          console.log('[Realtime] SSE Stream connected successfully.');
          updateLiveSyncBadge('connected');
        };

        es.onerror = (err) => {
          console.warn('[Realtime] SSE Stream disconnected, browser will auto-reconnect...', err);
          updateLiveSyncBadge('reconnecting');
        };

        es.addEventListener('connected', () => {
          updateLiveSyncBadge('connected');
        });

        es.addEventListener('CHECKIN', (e) => {
          try {
            const data = JSON.parse(e.data);
            console.log('[Realtime] Live Check-In Event:', data);
            fetchLiveCounts();
            if (data.isGuest) {
              loadVisitorsData();
            }
            const guestTag = data.isGuest ? ' <span style="background:#fef3c7;color:#b45309;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700;">First-Timer Guest</span>' : '';
            showToast(`Live Kiosk Check-In: <strong>${escapeHtml(data.name || 'Member')}</strong>${guestTag} checked in for ${escapeHtml(data.serviceName || 'Service')}!`, 'success', 'Live Check-In');
          } catch (err) {}
        });

        es.addEventListener('VISITOR_CHECKIN', (e) => {
          try {
            const data = JSON.parse(e.data);
            console.log('[Realtime] Live Visitor Check-In:', data);
            fetchLiveCounts();
            loadVisitorsData();
            showToast(`New First-Timer Visitor: <strong>${escapeHtml(data.name || 'Guest')}</strong> just registered and checked in for ${escapeHtml(data.serviceName || 'Service')}!`, 'info', 'Visitor Arrival');
          } catch (err) {}
        });

        es.addEventListener('MEMBER_CONVERTED', (e) => {
          try {
            const data = JSON.parse(e.data);
            console.log('[Realtime] Member Converted Event:', data);
            Promise.all([loadSavedMembers(), loadVisitorsData(), fetchLiveCounts()]).then(() => {
              updateDirectoryCounts();
              filterMembersTable();
              renderVisitorsSection();
              renderAttendanceAndDemographics();
            }).catch(() => {});
            showToast(`Visitor <strong>${escapeHtml(data.name || 'Guest')}</strong> has been converted to a full church member!`, 'success', 'Member Directory Updated');
          } catch (err) {}
        });

        es.addEventListener('MEMBER_CREATED', (e) => {
          try {
            loadSavedMembers();
          } catch (err) {}
        });

        es.addEventListener('VISITOR_REGISTERED', (e) => {
          try {
            loadVisitorsData();
          } catch (err) {}
        });

        es.addEventListener('MEMBER_UPDATED', (e) => {
          try {
            loadSavedMembers();
            loadVisitorsData();
          } catch (err) {}
        });

        es.addEventListener('MEMBER_DELETED', (e) => {
          try {
            loadSavedMembers();
            loadVisitorsData();
          } catch (err) {}
        });

        es.addEventListener('ATTENDANCE_PURGED', (e) => {
          try {
            fetchLiveCounts();
            loadVisitorsData();
            renderAttendanceAndDemographics();
          } catch (err) {}
        });
      } catch (esErr) {
        console.warn('SSE not supported or failed to initialize:', esErr);
        updateLiveSyncBadge('offline');
      }

      // 2. BroadcastChannel for instant local cross-tab communication
      try {
        if (window.BroadcastChannel && !window._sfmiLiveBcAttached) {
          window._sfmiLiveBcAttached = true;
          const bc = new BroadcastChannel('sfmi_attendance_live');
          bc.onmessage = (e) => {
            if (!e.data) return;
            if (e.data.type === 'CHECKIN') {
              fetchLiveCounts();
              if (e.data.isGuest) loadVisitorsData();
            } else if (e.data.type === 'MEMBER_CONVERTED') {
              Promise.all([loadSavedMembers(), loadVisitorsData(), fetchLiveCounts()]).then(() => {
                updateDirectoryCounts();
                filterMembersTable();
                renderVisitorsSection();
                renderAttendanceAndDemographics();
              }).catch(() => {});
            }
          };
        }
      } catch (bcErr) {}

      // 3. Smart Background Polling (runs every 10 seconds across all tabs)
      if (window.livePollTimer) clearInterval(window.livePollTimer);
      window.livePollTimer = setInterval(() => {
        // Always refresh live attendance counts
        fetchLiveCounts();

        // Refresh currently active tab's specific data
        const secMems = document.getElementById('secMembers');
        if (secMems && secMems.style.display !== 'none') {
          loadSavedMembers();
        }
        const secVis = document.getElementById('secVisitors');
        if (secVis && secVis.style.display !== 'none') {
          loadVisitorsData();
        }
      }, 10000);

      // 4. Tab Visibility sync (auto-refresh when user switches back to this browser tab)
      if (!window._sfmiVisibilityAttached) {
        window._sfmiVisibilityAttached = true;
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            fetchLiveCounts();
            const secMems = document.getElementById('secMembers');
            if (secMems && secMems.style.display !== 'none') loadSavedMembers();
            const secVis = document.getElementById('secVisitors');
            if (secVis && secVis.style.display !== 'none') loadVisitorsData();
          }
        });
      }
    }

    async function handleLoginSubmit(e) {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value.trim();
      const errorMsg = document.getElementById('loginErrorMsg');
      const submitBtn = e.target.querySelector('button[type="submit"]');

      errorMsg.style.display = 'none';
      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = 'Verifying credentials…'; }

      try {
        const res = await fetch(`${API_BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });

        if (res.ok) {
          const data = await res.json();
          const role = (data.user && data.user.role) ? data.user.role : '';

          // Strictly block Treasury/Finance accounts from accessing Admin Portal
          if (role === 'FINANCE') {
            purgeAuthSession();
            errorMsg.style.display = 'block';
            errorMsg.innerText = 'Access Denied: Treasury Officers cannot access the Admin Portal. Please log in at Treasury Portal.';
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Sign In to Admin Portal'; }
            return;
          }

          const isSubAdminRole = role === 'SUB_ADMIN' || role === 'ADMIN';
          sessionStorage.setItem('sfmi_token', data.accessToken);
          localStorage.setItem('sfmi_token', data.accessToken);
          if (data.refreshToken) {
            sessionStorage.setItem('sfmi_refresh_token', data.refreshToken);
            localStorage.setItem('sfmi_refresh_token', data.refreshToken);
          }
          sessionStorage.setItem('sfmi_current_user', JSON.stringify({
            email: data.user.email,
            name: data.user.name || (isSubAdminRole ? 'Sub-Admin' : 'Super Admin'),
            role: isSubAdminRole ? 'SUB_ADMIN' : 'SUPER_ADMIN',
            permissions: (data.user && Array.isArray(data.user.permissions))
              ? data.user.permissions
              : (isSubAdminRole ? ['attendance', 'members', 'programs'] : ['finance', 'attendance', 'members', 'programs', 'subAdmins'])
          }));
          localStorage.setItem('sfmi_current_user', sessionStorage.getItem('sfmi_current_user'));

          resetInactivityTimer();
          showDashboard();
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Sign In to Admin Portal'; }
          return;
        } else {
          const errData = await res.json().catch(() => ({}));
          errorMsg.style.display = 'block';
          errorMsg.innerText = errData.error || 'Invalid email or password. Please verify your credentials and try again.';
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Sign In to Admin Portal'; }
          return;
        }
      } catch (err) {
        errorMsg.style.display = 'block';
        errorMsg.innerText = 'Unable to connect to authentication server. Please check your internet connection.';
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Sign In to Admin Portal'; }
      }
    }

    function handleLogout() {
      showConfirmModal(
        'Confirm Log Out',
        'Are you sure you want to log out from the Church Administration Portal?',
        async () => {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
          if (token && !token.startsWith('sfmi_super_admin_session_')) {
            try {
              await fetch(`${API_BASE}/auth/logout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
              });
            } catch (e) {}
          }
          purgeAuthSession();
          showLogin();
          showToast('You have been logged out safely from Administration Portal.', 'info', 'Logged Out');
        },
        'fas fa-sign-out-alt',
        'Log Out',
        '#c5221f'
      );
    }

    function togglePasswordVisibility(inputId, iconId) {
      const input = document.getElementById(inputId);
      const icon = document.getElementById(iconId);
      if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
      } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
      }
    }

    const TAB_LABELS = {
      finance: '<i class="fas fa-coins"></i> Financial Overview & Analytics',
      attendance: '<i class="fas fa-list-check"></i> Attendance & Demographics',
      analytics: '<i class="fas fa-chart-line"></i> Attendance &amp; Engagement Analytics',
      visitors: '<i class="fas fa-user-plus"></i> Visitors & First-Timers',
      members: '<i class="fas fa-users"></i> Member Directory',
      messaging: '<i class="fa-brands fa-whatsapp"></i> Contact &amp; WhatsApp Messaging Center',
      programs: '<i class="fas fa-calendar-star"></i> Services & Programs Setup',
      partnership: '<i class="fas fa-handshake"></i> Pledges',
      subAdmins: '<i class="fas fa-user-shield"></i> Staff & Sub-Admins',
      reports: '<i class="fas fa-clipboard-user"></i> Historical Attendance Check-Ins Report',
      finReports: '<i class="fas fa-file-invoice-dollar"></i> Services Financial Analytics Report',
      settings: '<i class="fas fa-user-gear"></i> Account Settings & Profile'
    };

    function switchTab(tab) {
      let currentUser = null;
      try {
        currentUser = JSON.parse(sessionStorage.getItem('sfmi_current_user') || localStorage.getItem('sfmi_current_user'));
      } catch (e) {}

      // Hard guard: Sub-Admins cannot access Financial Overview & Analytics or Sub-Admin management under any circumstances
      const isSubAdmin = currentUser && (currentUser.role === 'SUB_ADMIN' || currentUser.role === 'ADMIN');
      if (isSubAdmin) {
        const rawPerms = Array.isArray(currentUser.permissions) 
          ? currentUser.permissions 
          : ['attendance', 'members', 'programs', 'partnership', 'reports'];
        const allowed = rawPerms.filter(p => p !== 'finance' && p !== 'subAdmins');
        if (allowed.includes('attendance') || allowed.includes('members')) {
          if (!allowed.includes('analytics')) allowed.push('analytics');
          if (!allowed.includes('visitors')) allowed.push('visitors');
          if (!allowed.includes('messaging')) allowed.push('messaging');
        }
        if (!allowed.includes('settings')) allowed.push('settings');
        if (tab === 'finance' || tab === 'subAdmins' || !allowed.includes(tab)) {
          tab = allowed[0] || 'attendance';
        }
      }

      const tabs = ['finance', 'attendance', 'analytics', 'visitors', 'members', 'messaging', 'programs', 'partnership', 'subAdmins', 'reports', 'finReports', 'settings'];
      tabs.forEach(t => {
        const sec = document.getElementById(`sec${t.charAt(0).toUpperCase() + t.slice(1)}`);
        const btn = document.getElementById(`tabBtn${t.charAt(0).toUpperCase() + t.slice(1)}`);
        const mobBtn = document.getElementById(`mobBtn${t.charAt(0).toUpperCase() + t.slice(1)}`);
        if (sec) sec.style.display = t === tab ? 'block' : 'none';
        if (btn) btn.className = t === tab ? 'tab-btn active' : 'tab-btn';
        if (mobBtn) mobBtn.className = t === tab ? 'mobile-menu-item active' : 'mobile-menu-item';
      });

      const lbl = document.getElementById('activeTabLabel');
      if (lbl) lbl.innerHTML = TAB_LABELS[tab] || '';
      
      if (tab === 'finance') { renderAdminFinanceTable(); syncFinanceViewMode(); loadFinanceData(); }
      if (tab === 'attendance') { renderAttendanceAndDemographics(); syncAttendanceViewMode(); fetchLiveCounts(); }
      if (tab === 'analytics') { loadAnalyticsDashboard(); syncAnalyticsViewMode(); }
      if (tab === 'visitors') { renderVisitorsSection(); syncVisitorsViewMode(); loadVisitorsData(); }
      if (tab === 'members') { renderMembersTable(); syncMembersViewMode(); loadSavedMembers(); }
      if (tab === 'messaging') { loadMessagingCenter(); syncMessagingViewMode(); loadArkeselSmsBalance(); }
      if (tab === 'programs') { renderProgramsManager(); syncProgramsViewMode(); fetchLiveCounts(); }
      if (tab === 'partnership') { loadPartnershipMatrix(); syncPartnershipViewMode(); }
      if (tab === 'subAdmins') { renderSubAdminsList(); syncSubAdminsViewMode(); }
      if (tab === 'reports') { loadHistoricalAttendanceReport(); syncReportsViewMode(); }
      if (tab === 'finReports') { if (typeof loadHistoricalFinanceReport === 'function') loadHistoricalFinanceReport(); }
      if (tab === 'settings') { 
        renderSettingsProfile(); 
        if (typeof initArkeselSmsSettings === 'function') initArkeselSmsSettings();
        if (typeof handleSettingsMsgTemplateChange === 'function') handleSettingsMsgTemplateChange();
        loadArkeselSmsBalance();
      }
    }

    function renderSettingsProfile() {
      let currentUser = null;
      try {
        currentUser = JSON.parse(sessionStorage.getItem('sfmi_current_user') || localStorage.getItem('sfmi_current_user'));
      } catch (e) {}

      const isSubAdmin = currentUser && (currentUser.role === 'SUB_ADMIN' || currentUser.role === 'ADMIN');
      const isSuperAdmin = !isSubAdmin;

      const name = (currentUser && currentUser.name) ? currentUser.name : (isSuperAdmin ? 'Super Admin' : 'Staff Officer');
      const email = (currentUser && currentUser.email) ? currentUser.email : (isSuperAdmin ? 'admin@solutionsfaith.com' : 'staff@solutionsfaith.com');
      const roleLabel = isSuperAdmin ? 'SUPER ADMIN (Executive)' : 'SUB ADMIN (Staff)';
      const avatarChar = (name.trim().charAt(0) || 'A').toUpperCase();

      const avatarEl = document.getElementById('settingsProfileAvatar');
      const nameEl = document.getElementById('settingsProfileName');
      const emailEl = document.getElementById('settingsProfileEmail');
      const roleBadgeEl = document.getElementById('settingsProfileRoleBadge');
      const headerBadge = document.getElementById('headerUserBadge');

      if (avatarEl) avatarEl.innerText = avatarChar;
      if (nameEl) nameEl.innerText = name;
      if (emailEl) emailEl.innerText = email;
      if (roleBadgeEl) {
        roleBadgeEl.innerText = roleLabel;
        roleBadgeEl.style.background = isSuperAdmin ? '#fef3c7' : '#e0f2fe';
        roleBadgeEl.style.color = isSuperAdmin ? '#92400e' : '#0369a1';
        roleBadgeEl.style.borderColor = isSuperAdmin ? '#fde68a' : '#bae6fd';
      }
      if (headerBadge) {
        headerBadge.innerText = name;
      }
    }

    async function handleSettingsChangePasswordSubmit(e) {
      e.preventDefault();
      const currentPassword = document.getElementById('settingsCurrentPassword').value;
      const newPassword = document.getElementById('settingsNewPassword').value;
      const confirmPassword = document.getElementById('settingsConfirmPassword').value;
      const errEl = document.getElementById('settingsPasswordErrorMsg');
      const submitBtn = document.getElementById('btnSettingsSavePassword');

      if (errEl) errEl.style.display = 'none';

      if (newPassword.length < 6) {
        if (errEl) { errEl.style.display = 'block'; errEl.innerText = 'New password must be at least 6 characters.'; }
        return;
      }
      if (newPassword !== confirmPassword) {
        if (errEl) { errEl.style.display = 'block'; errEl.innerText = 'New password and confirm password do not match.'; }
        return;
      }

      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating password…'; }

      try {
        const token = await getAdminAuthToken();
        const res = await fetch(`${API_BASE}/auth/change-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
        });

        if (res.ok) {
          showToast('Account password updated successfully!', 'success', 'Password Changed');
          document.getElementById('settingsCurrentPassword').value = '';
          document.getElementById('settingsNewPassword').value = '';
          document.getElementById('settingsConfirmPassword').value = '';
        } else {
          const data = await res.json().catch(() => ({}));
          if (errEl) {
            errEl.style.display = 'block';
            errEl.innerText = data.error || 'Failed to update password. Please verify your current password.';
          }
          showToast(data.error || 'Password update failed.', 'error', 'Update Failed');
        }
      } catch (err) {
        if (errEl) {
          errEl.style.display = 'block';
          errEl.innerText = 'Network error updating password. Please try again.';
        }
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-shield-halved"></i> Save New Password'; }
      }
    }

    function syncPartnershipViewMode() {
      const isMobile = window.innerWidth <= 850;
      const tbl = document.querySelector('#secPartnership .table-responsive');
      const cards = document.getElementById('partnershipMobileCards');
      if (tbl) tbl.style.display = isMobile ? 'none' : 'block';
      if (cards) cards.style.display = isMobile ? 'flex' : 'none';
    }
    window.addEventListener('resize', syncPartnershipViewMode);

    function syncReportsViewMode() {
      const isMobile = window.innerWidth <= 700;
      const attTbl = document.querySelector('#repSubAttendance .table-responsive');
      const attCards = document.getElementById('repAttMobileCards');
      if (attTbl) attTbl.style.display = isMobile ? 'none' : 'block';
      if (attCards) attCards.style.display = isMobile ? 'flex' : 'none';

      const finTbl = document.querySelector('#repSubFinance .table-responsive');
      const finCards = document.getElementById('repFinMobileCards');
      if (finTbl) finTbl.style.display = isMobile ? 'none' : 'block';
      if (finCards) finCards.style.display = isMobile ? 'flex' : 'none';
    }
    window.addEventListener('resize', syncReportsViewMode);

    function toggleMobileMenu() {
      const drawer = document.getElementById('mobileMenuDrawer');
      const icon = document.getElementById('hamburgerIcon');
      if (!drawer) return;
      const isOpen = drawer.classList.toggle('open');
      if (icon) icon.className = isOpen ? 'fas fa-times ham-icon' : 'fas fa-bars ham-icon';
    }

    function mobileSwitchTab(tab) {
      switchTab(tab);
      // Close drawer after selection
      const drawer = document.getElementById('mobileMenuDrawer');
      const icon = document.getElementById('hamburgerIcon');
      if (drawer) drawer.classList.remove('open');
      if (icon) icon.className = 'fas fa-bars ham-icon';
    }

    /* ── HISTORICAL REPORTS & ARCHIVES HUB ── */
    let currentReportSubTab = 'ATTENDANCE'; // 'ATTENDANCE' or 'FINANCE'
    let rawAttReportData = [];
    let rawFinReportData = [];

    function switchReportSubTab(sub) {
      if (sub === 'FINANCE') {
        switchTab('finReports');
      } else {
        switchTab('reports');
      }
    }

    function initReportsHub() {
      switchTab('reports');
    }

    async function loadHistoricalAttendanceReport() {
      renderArchivedCompletedServiceReports();
      try {
        const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const serviceName = document.getElementById('repAttServiceSelect') ? document.getElementById('repAttServiceSelect').value : 'ALL';
        const startDate = document.getElementById('repAttStartDate') ? document.getElementById('repAttStartDate').value : '';
        const endDate = document.getElementById('repAttEndDate') ? document.getElementById('repAttEndDate').value : '';

        let query = `?serviceName=${encodeURIComponent(serviceName)}`;
        if (startDate) query += `&startDate=${encodeURIComponent(startDate)}`;
        if (endDate) query += `&endDate=${encodeURIComponent(endDate)}`;

        const res = await fetch(`${API_BASE}/attendance/history${query}`, { headers });
        if (res.ok) {
          rawAttReportData = await res.json();
          filterHistoricalAttendanceReportTable();
        }
      } catch (err) {
        console.error('Failed loading attendance history report:', err);
      }
    }

    let compiledAttSessionsMap = {};

    function filterHistoricalAttendanceReportTable() {
      const search = (document.getElementById('repAttSearch')?.value || '').trim().toLowerCase();
      let list = [...rawAttReportData];

      if (search) {
        list = list.filter(item => {
          const m = item.member || {};
          const name = `${m.firstName || ''} ${m.lastName || ''}`.toLowerCase();
          const phone = (m.phone || '').toLowerCase();
          const location = (m.address || '').toLowerCase();
          return name.includes(search) || phone.includes(search) || location.includes(search);
        });
      }

      // Compute summary metrics
      const totalLogs = list.length;
      const uniqueMemberIds = new Set();
      let guestCount = 0;
      let maleCount = 0;
      let femaleCount = 0;

      list.forEach(item => {
        if (item.memberId) uniqueMemberIds.add(item.memberId);
        if (item.isGuest || item.member?.category === 'Visitor / Guest') guestCount++;
        const g = (item.member?.gender || '').toLowerCase();
        if (g.startsWith('m')) maleCount++;
        else if (g.startsWith('f')) femaleCount++;
      });

      const totalLogsEl = document.getElementById('repAttTotalLogs');
      if (totalLogsEl) totalLogsEl.innerText = totalLogs;
      const uniqueEl = document.getElementById('repAttUniqueMembers');
      if (uniqueEl) uniqueEl.innerText = uniqueMemberIds.size;
      const guestEl = document.getElementById('repAttGuests');
      if (guestEl) guestEl.innerText = guestCount;
      const mfEl = document.getElementById('repAttMaleFemale');
      if (mfEl) mfEl.innerText = `${maleCount} M / ${femaleCount} F`;

      // Group into compiled service sessions (normalized by date and service title)
      compiledAttSessionsMap = {};
      list.forEach(item => {
        // Resolve clean ISO YYYY-MM-DD date using UTC to avoid local timezone shifts
        let rawDate = '';
        if (item.service && item.service.serviceDate) {
          rawDate = typeof item.service.serviceDate === 'string'
            ? item.service.serviceDate.slice(0, 10)
            : formatLocalDate(item.service.serviceDate);
        }
        if (!rawDate && item.checkedInAt) {
          if (typeof item.checkedInAt === 'string') {
            rawDate = item.checkedInAt.slice(0, 10);
          } else {
            const d = new Date(item.checkedInAt);
            const y = d.getUTCFullYear();
            const m = String(d.getUTCMonth() + 1).padStart(2, '0');
            const day = String(d.getUTCDate()).padStart(2, '0');
            rawDate = `${y}-${m}-${day}`;
          }
        }
        if (!rawDate) rawDate = formatLocalDate(new Date());

        // Format nice display date e.g. "Sep 4, 2026"
        const dParts = rawDate.split('-');
        let dateFormatted = rawDate;
        if (dParts.length === 3) {
          const dObj = new Date(Number(dParts[0]), Number(dParts[1]) - 1, Number(dParts[2]));
          dateFormatted = dObj.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
        }

        // Normalize service title so "THE NIGHT OF SUPERNATURAL", "Sunday: THE NIGHT OF SUPERNATURAL", etc. group together
        const rawServiceName = item.service?.serviceType?.name || item.serviceName || 'Sunday Service';
        const cleanServiceName = rawServiceName.replace(/^(Sunday|Wednesday|Friday)[:\s—-]+/i, '').trim();
        const normServiceKey = cleanServiceName.toUpperCase().replace(/\s+/g, ' ');

        const key = `${rawDate}_${normServiceKey}`;

        if (!compiledAttSessionsMap[key]) {
          compiledAttSessionsMap[key] = {
            id: key,
            dateRaw: rawDate,
            dateFormatted,
            serviceName: cleanServiceName || 'Sunday Service',
            totalLogs: 0,
            maleCount: 0,
            femaleCount: 0,
            guestCount: 0,
            logs: []
          };
        }

        const sess = compiledAttSessionsMap[key];
        sess.totalLogs++;
        sess.logs.push(item);

        if (item.isGuest || item.member?.category === 'Visitor / Guest') sess.guestCount++;
        const g = (item.member?.gender || '').toLowerCase();
        if (g.startsWith('m')) sess.maleCount++;
        else if (g.startsWith('f')) sess.femaleCount++;
      });

      const sessionsList = Object.values(compiledAttSessionsMap);
      compiledAttSessionsList = sessionsList;

      const countTextEl = document.getElementById('repAttCountText');
      if (countTextEl) countTextEl.innerText = `${sessionsList.length} Compiled Service Reports`;

      const tbody = document.getElementById('repAttTableBody');
      const cardsContainer = document.getElementById('repAttMobileCards');

      if (sessionsList.length === 0) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 24px; color: var(--muted);">No compiled service check-in reports found.</td></tr>`;
        if (cardsContainer) cardsContainer.innerHTML = `<div style="text-align:center; padding:24px; color:var(--muted); background:white; border-radius:8px; border:1px solid var(--line);">No compiled service check-in reports found.</div>`;
        syncReportsViewMode();
        return;
      }

      if (tbody) {
        tbody.innerHTML = sessionsList.map((sess, idx) => {
          const name = escapeHtml(sess.serviceName);
          const dateStr = escapeHtml(sess.dateFormatted);
          const ratioStr = `${sess.maleCount} Men · ${sess.femaleCount} Women · ${sess.guestCount} Guests`;

          return `
            <tr>
              <td>${idx + 1}</td>
              <td><strong>${dateStr}</strong></td>
              <td><strong style="color: var(--ink);">${name}</strong></td>
              <td><strong style="color: var(--emerald);">${sess.totalLogs} Present</strong></td>
              <td><span class="badge badge-gray">${ratioStr}</span></td>
              <td>
                <div style="display:flex; gap:6px;">
                  <button class="btn-main" style="padding:4px 10px; font-size:11.5px; background:var(--light); color:var(--ink); border:1px solid var(--line);" onclick="openViewCompiledAttendanceModal(${idx})">
                    <i class="fas fa-eye"></i> View Report
                  </button>
                  <button class="btn-main" style="padding:4px 10px; font-size:11.5px; background:#107c41;" onclick="downloadCompiledAttendanceSessionExcel(${idx})">
                    <i class="fas fa-file-excel"></i> Download Excel
                  </button>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }

      if (cardsContainer) {
        cardsContainer.innerHTML = sessionsList.map((sess, idx) => {
          const name = escapeHtml(sess.serviceName);
          const dateStr = escapeHtml(sess.dateFormatted);
          const ratioStr = `${sess.maleCount} Men · ${sess.femaleCount} Women · ${sess.guestCount} Guests`;

          return `
            <div style="background: white; border: 1.5px solid var(--line); border-radius: 10px; padding: 14px; box-shadow: 0 2px 6px rgba(0,0,0,0.03);">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <div>
                  <span class="badge badge-gray" style="font-size: 11px; margin-bottom: 4px;"><i class="fas fa-calendar"></i> ${dateStr}</span>
                  <h4 style="font-size: 15px; font-weight: 800; color: var(--ink); margin-top: 2px;">${name}</h4>
                </div>
                <span style="font-size: 13px; font-weight: 800; color: var(--emerald); background: rgba(16, 124, 65, 0.08); padding: 4px 10px; border-radius: 20px;">
                  ${sess.totalLogs} Present
                </span>
              </div>
              <div style="font-size: 12.5px; color: var(--muted); margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
                <i class="fas fa-users-rectangle" style="color: var(--accent);"></i> ${ratioStr}
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px;">
                <button class="btn-main" style="padding: 8px; font-size: 12px; justify-content: center; background: var(--light); color: var(--ink); border: 1px solid var(--line);" onclick="openViewCompiledAttendanceModal(${idx})">
                  <i class="fas fa-eye"></i> View Report
                </button>
                <button class="btn-main" style="padding: 8px; font-size: 12px; justify-content: center; background: #107c41;" onclick="downloadCompiledAttendanceSessionExcel(${idx})">
                  <i class="fas fa-file-excel"></i> Download Excel
                </button>
              </div>
            </div>
          `;
        }).join('');
      }

      syncReportsViewMode();
    }

    let compiledAttSessionsList = [];
    let activeCompAttSession = null;

    function openViewCompiledAttendanceModal(sessionKeyOrIdx) {
      let sess = null;
      if (typeof sessionKeyOrIdx === 'number' || (!isNaN(sessionKeyOrIdx) && String(sessionKeyOrIdx).trim() !== '' && !String(sessionKeyOrIdx).includes('_'))) {
        sess = compiledAttSessionsList[Number(sessionKeyOrIdx)];
      }
      if (!sess && sessionKeyOrIdx) {
        sess = compiledAttSessionsMap[sessionKeyOrIdx];
      }
      if (!sess && compiledAttSessionsList.length > 0) {
        sess = compiledAttSessionsList[0];
      }

      if (!sess) {
        showToast('Compiled report session not found.', 'error', 'Report Error');
        return;
      }

      activeCompAttSession = sess;

      document.getElementById('compAttTitle').innerText = `Compiled Attendance Report — ${sess.serviceName}`;
      document.getElementById('compAttSub').innerText = `Service Date: ${sess.dateFormatted} · Total Present: ${sess.totalLogs}`;

      document.getElementById('compAttModalTotal').innerText = sess.totalLogs;
      document.getElementById('compAttModalGuests').innerText = sess.guestCount;
      document.getElementById('compAttModalMale').innerText = sess.maleCount;
      document.getElementById('compAttModalFemale').innerText = sess.femaleCount;

      const btnDl = document.getElementById('btnCompAttDownload');
      if (btnDl) btnDl.onclick = () => downloadCompiledAttendanceSessionExcel(sess.id || sessionKeyOrIdx);

      document.getElementById('compAttModalSearch').value = '';
      filterCompiledAttModalRoster();

      const modalEl = document.getElementById('viewCompiledAttModal');
      if (modalEl) {
        modalEl.classList.add('active');
        modalEl.style.display = 'flex';
      }
    }

    function closeViewCompiledAttModal() {
      const modalEl = document.getElementById('viewCompiledAttModal');
      if (modalEl) {
        modalEl.classList.remove('active');
        modalEl.style.display = 'none';
      }
    }

    function filterCompiledAttModalRoster() {
      if (!activeCompAttSession) return;
      const search = (document.getElementById('compAttModalSearch')?.value || '').trim().toLowerCase();
      let logs = [...activeCompAttSession.logs];

      if (search) {
        logs = logs.filter(item => {
          const m = item.member || {};
          const name = `${m.firstName || ''} ${m.lastName || ''}`.toLowerCase();
          const phone = (m.phone || '').toLowerCase();
          return name.includes(search) || phone.includes(search);
        });
      }

      const tbody = document.getElementById('compAttModalTableBody');
      if (!tbody) return;

      if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px; color: var(--muted);">No matching attendees found in this report.</td></tr>`;
        return;
      }

      tbody.innerHTML = logs.map((item, idx) => {
        const m = item.member || {};
        const timestamp = new Date(item.checkedInAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const name = `${m.firstName || 'Visitor'} ${m.lastName || 'Guest'}`;
        const category = m.category || (item.isGuest ? 'Visitor / Guest' : 'Adult');
        const phone = m.phone || '—';
        const gender = m.gender || '—';
        const location = m.address ? m.address.replace(/^📍\s*/, '') : '—';

        return `
          <tr>
            <td>${idx + 1}</td>
            <td><strong style="color: var(--ink);">${escapeHtml(name)}</strong></td>
            <td><span class="badge ${item.isGuest ? 'badge-gold' : 'badge-emerald'}">${escapeHtml(category)}</span></td>
            <td>${escapeHtml(phone)}</td>
            <td>${escapeHtml(gender)}</td>
            <td>📍 ${escapeHtml(location)}</td>
            <td>${escapeHtml(timestamp)}</td>
          </tr>
        `;
      }).join('');
    }

    function downloadCompiledAttendanceSessionExcel(sessionKeyOrIdx) {
      let sess = null;
      if (typeof sessionKeyOrIdx === 'number' || (!isNaN(sessionKeyOrIdx) && String(sessionKeyOrIdx).trim() !== '' && !String(sessionKeyOrIdx).includes('_'))) {
        sess = compiledAttSessionsList[Number(sessionKeyOrIdx)];
      }
      if (!sess && sessionKeyOrIdx) {
        sess = compiledAttSessionsMap[sessionKeyOrIdx];
      }
      if (!sess && compiledAttSessionsList.length > 0) {
        sess = compiledAttSessionsList[0];
      }

      if (!sess || !sess.logs || !sess.logs.length) {
        showToast('No session data available to export.', 'warning', 'Export Empty');
        return;
      }

      let csv = '\uFEFF';
      csv += `Official Compiled Service Attendance Report\n`;
      csv += `Service Title,"${sess.serviceName}"\n`;
      csv += `Service Date,"${sess.dateFormatted}"\n`;
      csv += `Total Attended,${sess.totalLogs}\n`;
      csv += `First-Timer Guests,${sess.guestCount}\n`;
      csv += `Male Count,${sess.maleCount}\n`;
      csv += `Female Count,${sess.femaleCount}\n\n`;

      csv += `Check-In Timestamp,Full Name,Category,Phone Number,Gender,Residential Location,Check-In Method\n`;

      sess.logs.forEach(item => {
        const m = item.member || {};
        const timestamp = `"${new Date(item.checkedInAt || Date.now()).toLocaleString()}"`;
        const name = `"${(m.firstName || '') + ' ' + (m.lastName || '')}"`;
        const category = `"${m.category || (item.isGuest ? 'Visitor / Guest' : 'Adult')}"`;
        const phone = `"${m.phone || ''}"`;
        const gender = `"${m.gender || ''}"`;
        const location = `"${(m.address || '').replace(/^📍\s*/, '').replace(/"/g, '""')}"`;
        const method = `"${item.method || 'KIOSK'}"`;

        csv += `${timestamp},${name},${category},${phone},${gender},${location},${method}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `SFMI_Attendance_Report_${sess.serviceName.replace(/[^a-zA-Z0-9]/g, '_')}_${sess.dateRaw}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Compiled Service Attendance Excel report downloaded!', 'success', 'Export Complete');
    }

    function downloadFullAttendanceExcel() {
      const search = (document.getElementById('repAttSearch')?.value || '').trim().toLowerCase();
      let list = [...rawAttReportData];

      if (search) {
        list = list.filter(item => {
          const m = item.member || {};
          const name = `${m.firstName || ''} ${m.lastName || ''}`.toLowerCase();
          const phone = (m.phone || '').toLowerCase();
          return name.includes(search) || phone.includes(search);
        });
      }

      if (list.length === 0) {
        showToast('No attendance records available to export.', 'warning', 'Export Empty');
        return;
      }

      let csv = '\uFEFF'; // Excel UTF-8 BOM for automatic column formatting in Microsoft Excel
      csv += 'Check-In Timestamp,Full Name,Category,Phone Number,Gender,Residential Location,Service Name,Check-In Method\n';

      list.forEach(item => {
        const m = item.member || {};
        const timestamp = `"${new Date(item.checkedInAt || Date.now()).toLocaleString()}"`;
        const name = `"${(m.firstName || '') + ' ' + (m.lastName || '')}"`;
        const category = `"${m.category || (item.isGuest ? 'Visitor / Guest' : 'Adult')}"`;
        const phone = `"${m.phone || ''}"`;
        const gender = `"${m.gender || ''}"`;
        const location = `"${(m.address || '').replace(/^📍\s*/, '').replace(/"/g, '""')}"`;
        const serviceName = `"${item.service?.serviceType?.name || item.serviceName || 'Sunday Service'}"`;
        const method = `"${item.method || 'KIOSK'}"`;

        csv += `${timestamp},${name},${category},${phone},${gender},${location},${serviceName},${method}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `SFMI_Historical_Attendance_Report_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Attendance Excel report downloaded successfully!', 'success', 'Export Complete');
    }

    async function loadHistoricalFinanceReport() {
      let currentUser = null;
      try { currentUser = JSON.parse(sessionStorage.getItem('sfmi_current_user') || localStorage.getItem('sfmi_current_user')); } catch (e) {}
      const isSuperAdmin = !currentUser || currentUser.role === 'SUPER_ADMIN';
      const hasFinReports = isSuperAdmin || (currentUser && Array.isArray(currentUser.permissions) && currentUser.permissions.includes('finReports'));
      if (!hasFinReports) {
        rawFinReportData = [];
        return;
      }

      try {
        const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const res = await fetch(`${API_BASE}/finance/service-entries`, { headers });
        if (res.ok) {
          rawFinReportData = await res.json();
          filterHistoricalFinanceReportTable();
        }
      } catch (err) {
        console.error('Failed loading financial history report:', err);
      }
    }

    function filterHistoricalFinanceReportTable() {
      const serviceType = document.getElementById('repFinServiceSelect') ? document.getElementById('repFinServiceSelect').value : 'ALL';
      const startDate = document.getElementById('repFinStartDate') ? document.getElementById('repFinStartDate').value : '';
      const endDate = document.getElementById('repFinEndDate') ? document.getElementById('repFinEndDate').value : '';

      let list = [...rawFinReportData];

      if (serviceType && serviceType !== 'ALL') {
        list = list.filter(e => (e.serviceName || '').toLowerCase().includes(serviceType.toLowerCase()));
      }
      if (startDate) {
        const sTime = new Date(startDate).getTime();
        list = list.filter(e => new Date(e.serviceDate).getTime() >= sTime);
      }
      if (endDate) {
        const eTime = new Date(endDate).getTime() + 86399999;
        list = list.filter(e => new Date(e.serviceDate).getTime() <= eTime);
      }

      let grandTotal = 0;
      let totalTithes = 0;
      let totalOffering = 0;
      let totalSeeds = 0;

      list.forEach(e => {
        grandTotal += Number(e.totalAmount || 0);
        totalTithes += Number(e.tithes || 0);
        totalOffering += Number(e.offering || 0);
        totalSeeds += Number(e.buildingFund || 0) + Number(e.specialSeed || 0);
      });

      const grandEl = document.getElementById('repFinGrandTotal');
      if (grandEl) grandEl.innerText = `GHS ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      const tithesEl = document.getElementById('repFinTithes');
      if (tithesEl) tithesEl.innerText = `GHS ${totalTithes.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      const offEl = document.getElementById('repFinOffering');
      if (offEl) offEl.innerText = `GHS ${totalOffering.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      const seedsEl = document.getElementById('repFinSeeds');
      if (seedsEl) seedsEl.innerText = `GHS ${totalSeeds.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      const countEl = document.getElementById('repFinCountText');
      if (countEl) countEl.innerText = `${list.length} Compiled Financial Service Reports`;

      const tbody = document.getElementById('repFinTableBody');
      const finCardsContainer = document.getElementById('repFinMobileCards');

      if (list.length === 0) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding: 24px; color: var(--muted);">No financial collection records found for selected date/service filter.</td></tr>`;
        if (finCardsContainer) finCardsContainer.innerHTML = `<div style="text-align:center; padding:24px; color:var(--muted); background:white; border-radius:8px; border:1px solid var(--line);">No financial collection records found for selected date/service filter.</div>`;
        syncReportsViewMode();
        return;
      }

      if (tbody) {
        tbody.innerHTML = list.map((e, idx) => {
          const dateStr = formatCalendarDateLabel(e.serviceDate, { year: 'numeric', month: 'short', day: 'numeric' });
          const name = e.serviceName || 'Sunday Service';
          const tithes = Number(e.tithes || 0).toFixed(2);
          const offering = Number(e.offering || 0).toFixed(2);
          const seeds = (Number(e.buildingFund || 0) + Number(e.specialSeed || 0)).toFixed(2);
          const total = Number(e.totalAmount || 0).toFixed(2);
          const recordedBy = e.recordedBy || 'Treasury Officer';
          const safeId = escapeHtml(e.id);

          return `
            <tr>
              <td>${idx + 1}</td>
              <td><strong>${dateStr}</strong></td>
              <td><strong style="color: var(--ink);">${escapeHtml(name)}</strong></td>
              <td>GHS ${tithes}</td>
              <td>GHS ${offering}</td>
              <td>GHS ${seeds}</td>
              <td><strong style="color: var(--emerald);">GHS ${total}</strong></td>
              <td>${escapeHtml(recordedBy)}</td>
              <td>
                <div style="display:flex; gap:6px;">
                  <button class="btn-main" style="padding:4px 10px; font-size:11.5px; background:var(--light); color:var(--ink); border:1px solid var(--line);" onclick="openViewCompiledFinanceModal('${safeId}')">
                    <i class="fas fa-eye"></i> View Ledger
                  </button>
                  <button class="btn-main" style="padding:4px 10px; font-size:11.5px; background:#107c41;" onclick="downloadSingleServiceFinanceExcel('${safeId}')">
                    <i class="fas fa-file-excel"></i> Download Excel
                  </button>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }

      if (finCardsContainer) {
        finCardsContainer.innerHTML = list.map(e => {
          const dateStr = formatCalendarDateLabel(e.serviceDate, { year: 'numeric', month: 'short', day: 'numeric' });
          const name = e.serviceName || 'Sunday Service';
          const tithes = Number(e.tithes || 0).toFixed(2);
          const offering = Number(e.offering || 0).toFixed(2);
          const seeds = (Number(e.buildingFund || 0) + Number(e.specialSeed || 0)).toFixed(2);
          const total = Number(e.totalAmount || 0).toFixed(2);
          const safeId = escapeHtml(e.id);

          return `
            <div style="background: white; border: 1.5px solid var(--line); border-radius: 10px; padding: 14px; box-shadow: 0 2px 6px rgba(0,0,0,0.03);">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <div>
                  <span class="badge badge-gray" style="font-size: 11px; margin-bottom: 4px;"><i class="fas fa-calendar"></i> ${dateStr}</span>
                  <h4 style="font-size: 15px; font-weight: 800; color: var(--ink); margin-top: 2px;">${escapeHtml(name)}</h4>
                </div>
                <div style="text-align: right;">
                  <div style="font-size: 10px; text-transform: uppercase; color: var(--muted); font-weight: 700;">Grand Total</div>
                  <div style="font-size: 16px; font-weight: 800; color: var(--emerald);">GHS ${total}</div>
                </div>
              </div>
              
              <div style="background: #fafbfa; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin-bottom: 12px; font-size: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
                <div>Tithes: <strong>GHS ${tithes}</strong></div>
                <div>Offering: <strong>GHS ${offering}</strong></div>
                <div style="grid-column: span 2;">Seeds &amp; Building: <strong>GHS ${seeds}</strong></div>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px;">
                <button class="btn-main" style="padding: 8px; font-size: 12px; justify-content: center; background: var(--light); color: var(--ink); border: 1px solid var(--line);" onclick="openViewCompiledFinanceModal('${safeId}')">
                  <i class="fas fa-eye"></i> View Ledger
                </button>
                <button class="btn-main" style="padding: 8px; font-size: 12px; justify-content: center; background: #107c41;" onclick="downloadSingleServiceFinanceExcel('${safeId}')">
                  <i class="fas fa-file-excel"></i> Download Excel
                </button>
              </div>
            </div>
          `;
        }).join('');
      }

      syncReportsViewMode();
    }

    function openViewCompiledFinanceModal(entryIdOrIdx) {
      let entry = null;
      if (typeof entryIdOrIdx === 'number' || (!isNaN(entryIdOrIdx) && String(entryIdOrIdx).trim() !== '' && String(entryIdOrIdx).length <= 4)) {
        entry = rawFinReportData[Number(entryIdOrIdx)];
      }
      if (!entry && entryIdOrIdx) {
        entry = rawFinReportData.find(e => String(e.id) === String(entryIdOrIdx));
      }
      if (!entry && rawFinReportData.length > 0) {
        entry = rawFinReportData[0];
      }

      if (!entry) {
        showToast('Financial collection record not found.', 'error', 'Error');
        return;
      }

      const dateStr = formatCalendarDateLabel(entry.serviceDate, { year: 'numeric', month: 'short', day: 'numeric' });
      document.getElementById('compFinTitle').innerText = `Compiled Financial Report — ${entry.serviceName || 'Sunday Service'}`;
      document.getElementById('compFinSub').innerText = `Service Date: ${dateStr} · Recorded by ${entry.recordedBy || 'Treasury Officer'}`;

      const btnDl = document.getElementById('btnCompFinDownload');
      if (btnDl) btnDl.onclick = () => downloadSingleServiceFinanceExcel(entry.id || entryIdOrIdx);

      const wrap = document.getElementById('compFinContentWrap');
      if (wrap) {
        const tithes = Number(entry.tithes || 0).toFixed(2);
        const offering = Number(entry.offering || 0).toFixed(2);
        const building = Number(entry.buildingFund || 0).toFixed(2);
        const seeds = Number(entry.specialSeed || 0).toFixed(2);
        const total = Number(entry.totalAmount || 0).toFixed(2);
        const cash = Number(entry.cashAmount || 0).toFixed(2);
        const momo = Number(entry.momoAmount || 0).toFixed(2);
        const bank = Number(entry.bankAmount || 0).toFixed(2);

        wrap.innerHTML = `
          <div style="background: rgba(16, 124, 65, 0.08); border-left: 4px solid #107c41; padding: 14px 18px; border-radius: 8px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 12px; text-transform: uppercase; color: var(--muted); font-weight: 700;">Grand Total Collection</div>
              <div style="font-size: 24px; font-weight: 800; color: #107c41;">GHS ${total}</div>
            </div>
            <span class="badge-present" style="background:#e6f4ea;color:#137333;font-size:12px;padding:4px 10px;"><i class="fas fa-check-circle"></i> Reconciled &amp; Approved</span>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px;">
            <div style="background: white; border: 1px solid var(--line); border-radius: 8px; padding: 14px;">
              <h4 style="font-size: 13.5px; font-weight: 800; color: var(--ink); margin-bottom: 10px;"><i class="fas fa-coins" style="color: var(--accent); margin-right: 6px;"></i> Fund Breakdown</h4>
              <div style="display: flex; flex-direction: column; gap: 6px; font-size: 13px;">
                <div style="display: flex; justify-content: space-between;"><span>Tithes:</span><strong>GHS ${tithes}</strong></div>
                <div style="display: flex; justify-content: space-between;"><span>General Offering:</span><strong>GHS ${offering}</strong></div>
                <div style="display: flex; justify-content: space-between;"><span>Building Fund:</span><strong>GHS ${building}</strong></div>
                <div style="display: flex; justify-content: space-between;"><span>Special Seeds:</span><strong>GHS ${seeds}</strong></div>
              </div>
            </div>

            <div style="background: white; border: 1px solid var(--line); border-radius: 8px; padding: 14px;">
              <h4 style="font-size: 13.5px; font-weight: 800; color: var(--ink); margin-bottom: 10px;"><i class="fas fa-credit-card" style="color: #2563eb; margin-right: 6px;"></i> Payment Modes</h4>
              <div style="display: flex; flex-direction: column; gap: 6px; font-size: 13px;">
                <div style="display: flex; justify-content: space-between;"><span>Cash Collection:</span><strong>GHS ${cash}</strong></div>
                <div style="display: flex; justify-content: space-between;"><span>MoMo (Mobile Money):</span><strong>GHS ${momo}</strong></div>
                <div style="display: flex; justify-content: space-between;"><span>Bank Deposit:</span><strong>GHS ${bank}</strong></div>
              </div>
            </div>
          </div>

          ${entry.notes ? `
            <div style="background: #fafbfa; border: 1px solid var(--line); padding: 12px 16px; border-radius: 8px; font-size: 13px;">
              <strong>Officer Notes:</strong> ${escapeHtml(entry.notes)}
            </div>
          ` : ''}
        `;
      }

      const modalEl = document.getElementById('viewCompiledFinModal');
      if (modalEl) {
        modalEl.classList.add('active');
        modalEl.style.display = 'flex';
      }
    }

    function closeViewCompiledFinModal() {
      const modalEl = document.getElementById('viewCompiledFinModal');
      if (modalEl) {
        modalEl.classList.remove('active');
        modalEl.style.display = 'none';
      }
    }

    function downloadSingleServiceFinanceExcel(entryIdOrIdx) {
      let entry = null;
      if (typeof entryIdOrIdx === 'number' || (!isNaN(entryIdOrIdx) && String(entryIdOrIdx).trim() !== '' && String(entryIdOrIdx).length <= 4)) {
        entry = rawFinReportData[Number(entryIdOrIdx)];
      }
      if (!entry && entryIdOrIdx) {
        entry = rawFinReportData.find(e => String(e.id) === String(entryIdOrIdx));
      }
      if (!entry && rawFinReportData.length > 0) {
        entry = rawFinReportData[0];
      }

      if (!entry) {
        showToast('Financial collection record not found.', 'error', 'Error');
        return;
      }

      let csv = '\uFEFF';
      csv += `Official Compiled Service Financial Collection Report\n`;
      csv += `Service Title,"${entry.serviceName || 'Sunday Service'}"\n`;
      csv += `Service Date,"${new Date(entry.serviceDate).toLocaleDateString()}"\n`;
      csv += `Recorded By,"${entry.recordedBy || 'Treasury Officer'}"\n`;
      csv += `Grand Total Collection (GHS),${entry.totalAmount || 0}\n\n`;

      csv += `Category / Fund,Amount (GHS)\n`;
      csv += `Tithes,${entry.tithes || 0}\n`;
      csv += `General Offering,${entry.offering || 0}\n`;
      csv += `Building Fund,${entry.buildingFund || 0}\n`;
      csv += `Special Seeds,${entry.specialSeed || 0}\n\n`;

      csv += `Payment Mode,Amount (GHS)\n`;
      csv += `Cash,${entry.cashAmount || 0}\n`;
      csv += `MoMo (Mobile Money),${entry.momoAmount || 0}\n`;
      csv += `Bank Deposit,${entry.bankAmount || 0}\n\n`;

      csv += `Notes,"${(entry.notes || '').replace(/"/g, '""')}"\n`;

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `SFMI_Financial_Report_${(entry.serviceName || 'Service').replace(/[^a-zA-Z0-9]/g, '_')}_${new Date(entry.serviceDate).toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Compiled Financial Service Excel report downloaded!', 'success', 'Export Complete');
    }

    function downloadFullFinanceExcel() {
      const serviceType = document.getElementById('repFinServiceSelect') ? document.getElementById('repFinServiceSelect').value : 'ALL';
      const startDate = document.getElementById('repFinStartDate') ? document.getElementById('repFinStartDate').value : '';
      const endDate = document.getElementById('repFinEndDate') ? document.getElementById('repFinEndDate').value : '';

      let list = [...rawFinReportData];

      if (serviceType && serviceType !== 'ALL') {
        list = list.filter(e => (e.serviceName || '').toLowerCase().includes(serviceType.toLowerCase()));
      }
      if (startDate) {
        const sTime = new Date(startDate).getTime();
        list = list.filter(e => new Date(e.serviceDate).getTime() >= sTime);
      }
      if (endDate) {
        const eTime = new Date(endDate).getTime() + 86399999;
        list = list.filter(e => new Date(e.serviceDate).getTime() <= eTime);
      }

      if (list.length === 0) {
        showToast('No financial collection records available to export.', 'warning', 'Export Empty');
        return;
      }

      let csv = '\uFEFF'; // Excel UTF-8 BOM
      csv += 'Service Date,Service Name,Tithes (GHS),General Offering (GHS),Building Fund (GHS),Special Seeds (GHS),Total Collection (GHS),Cash Amount,MoMo Amount,Bank Deposit,Recorded By,Notes\n';

      list.forEach(e => {
        const dateStr = `"${new Date(e.serviceDate).toLocaleDateString()}"`;
        const name = `"${e.serviceName || 'Sunday Service'}"`;
        const tithes = e.tithes || 0;
        const offering = e.offering || 0;
        const building = e.buildingFund || 0;
        const seeds = e.specialSeed || 0;
        const total = e.totalAmount || 0;
        const cash = e.cashAmount || 0;
        const momo = e.momoAmount || 0;
        const bank = e.bankAmount || 0;
        const recordedBy = `"${e.recordedBy || 'Treasury Officer'}"`;
        const notes = `"${(e.notes || '').replace(/"/g, '""')}"`;

        csv += `${dateStr},${name},${tithes},${offering},${building},${seeds},${total},${cash},${momo},${bank},${recordedBy},${notes}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `SFMI_Historical_Financial_Report_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Financial Overview Excel report downloaded successfully!', 'success', 'Export Complete');
    }

    /* ── END CHECK-IN & AUTOMATIC REPORT GENERATION SYSTEM ── */
    function renderArchivedCompletedServiceReports() {
      let archived = [];
      try {
        archived = JSON.parse(localStorage.getItem('sfmi_archived_service_reports') || '[]');
        // Auto-clean any accidental 0-attendance Wednesday report ended on Sep 7
        const beforeLen = archived.length;
        archived = archived.filter(r => !(r.serviceName && r.serviceName.includes('Wednesday') && r.presentCount === 0 && r.completedAt && r.completedAt.startsWith('2026-09-07')));
        if (archived.length !== beforeLen) {
          localStorage.setItem('sfmi_archived_service_reports', JSON.stringify(archived));
        }
      } catch (e) {}

      const countEl = document.getElementById('archivedReportsCount');
      if (countEl) countEl.innerText = archived.length;

      const container = document.getElementById('archivedReportsCardList');
      if (!container) return;

      if (archived.length === 0) {
        container.innerHTML = `<div style="grid-column: 1 / -1; background: #fafbfa; padding: 20px; border-radius: 8px; border: 1px dashed var(--line); text-align: center; color: var(--muted); font-size: 13px;">
          <i class="fas fa-flag-checkered" style="font-size: 24px; color: var(--muted); margin-bottom: 6px; display: block;"></i>
          No completed service reports generated yet. When a service check-in ends, the summary report will appear here automatically!
        </div>`;
        return;
      }

      container.innerHTML = archived.map((rep, idx) => {
        const name = escapeHtml(rep.serviceName || 'Sunday Service');
        const dateStr = escapeHtml(rep.dateFormatted || 'Recently Completed');
        const total = rep.presentCount || 0;
        const male = rep.maleCount || 0;
        const female = rep.femaleCount || 0;
        const child = rep.childCount || 0;
        const guest = rep.guestCount || 0;

        return `
          <div style="background: white; border: 1.5px solid var(--line); border-radius: 8px; padding: 16px; transition: box-shadow 0.2s;" onmouseenter="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.06)'" onmouseleave="this.style.boxShadow='none'">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
              <div>
                <strong style="font-family: Manrope, sans-serif; font-size: 15px; color: var(--ink); display: block;">${name}</strong>
                <span style="font-size: 12px; color: var(--muted);"><i class="fas fa-clock"></i> Ended ${dateStr}</span>
              </div>
              <span class="badge-present" style="background:#e6f4ea;color:#137333;font-size:11.5px;padding:3px 8px;"><i class="fas fa-check-circle"></i> Completed</span>
            </div>

            <div style="display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0;">
              <span class="badge badge-emerald" style="font-size: 12px; font-weight: 700;">${total} Total Attended</span>
              <span class="badge badge-gold" style="font-size: 12px;">${guest} Guests</span>
              <span class="badge badge-gray" style="font-size: 11.5px;">${male} Men · ${female} Women · ${child} Children</span>
            </div>

            <div style="display: flex; gap: 8px; margin-top: 14px;">
              <button class="btn-main" style="flex: 1; padding: 6px 10px; font-size: 12px; background: #107c41; justify-content: center;" onclick="downloadArchivedServiceReportExcel(${idx})">
                <i class="fas fa-file-excel"></i> Export Excel
              </button>
              <button class="btn-main" style="padding: 6px 10px; font-size: 12px; background: var(--light); color: var(--ink); border: 1px solid var(--line); justify-content: center;" onclick="viewArchivedServiceReportRoster(${idx})">
                <i class="fas fa-users"></i> View Roster
              </button>
              <button class="btn-main" style="padding: 6px 10px; font-size: 12px; background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; justify-content: center;" onclick="deleteArchivedServiceReport(${idx})" title="Delete or Revert this mistakenly ended report">
                <i class="fas fa-trash-alt"></i> Revert
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    function endCheckinAndGenerateReport(serviceName) {
      const targetService = serviceName || currentSelectedService || 'Sunday: Family & Friends Service';

      if (!confirm(`Are you sure you want to end check-ins for "${targetService}"?\n\nThis will finalize the service check-in session and automatically generate an official Attendance & Demographics report in the Reports section.`)) {
        return;
      }

      // Compute statistics for targetService
      const activeAttList = getAttendanceListForService(targetService);
      let directoryList = [...allMembers];

      activeAttList.forEach(att => {
        const attPhone = (att.phone || '').trim();
        const attNormPhone = normalizePhoneClient(attPhone);
        const attName = (att.name || '').trim().toLowerCase();
        const exists = directoryList.some(m => {
          if (att.memberId && m.id && att.memberId === m.id) return true;
          const mNormPhone = normalizePhoneClient(m.phone);
          if (attNormPhone && mNormPhone && attNormPhone === mNormPhone) return true;
          if (attName && `${m.firstName} ${m.lastName}`.trim().toLowerCase() === attName) return true;
          return false;
        });
        if (!exists && att.name) {
          const parts = att.name.split(' ');
          directoryList.push({
            id: att.memberId || ('guest_' + Math.random().toString(36).substr(2, 9)),
            firstName: parts[0] || 'Visitor',
            lastName: parts.slice(1).join(' ') || 'Guest',
            phone: att.phone || '—',
            gender: att.gender || 'Not specified',
            address: att.address || '',
            category: 'Visitor / Guest',
            role: 'Visitor / First Timer',
            isGuest: true
          });
        }
      });

      let presentCount = 0;
      let absentCount = 0;
      let maleCount = 0;
      let femaleCount = 0;
      let childCount = 0;
      let guestCount = 0;

      const roster = [];

      directoryList.forEach(m => {
        const mNormPhone = normalizePhoneClient(m.phone);
        const mFullName = `${m.firstName} ${m.lastName}`.trim().toLowerCase();

        const found = activeAttList.find(a => {
          if (a.memberId && m.id && a.memberId === m.id) return true;
          const aNormPhone = normalizePhoneClient(a.phone);
          if (aNormPhone && mNormPhone && aNormPhone === mNormPhone) return true;
          const aFullName = (a.name || `${a.firstName || ''} ${a.lastName || ''}`).trim().toLowerCase();
          if (aFullName && aFullName === mFullName) return true;
          return false;
        });

        const isPresent = Boolean(found);
        const isGuest = isGuestMember(m);

        if (isPresent) {
          presentCount++;
          if (isGuest) guestCount++;
          const isChild = m.category === 'Child' || (m.role && m.role.toLowerCase().includes('child'));
          if (isChild) {
            childCount++;
          } else {
            const g = (m.gender || '').trim().toLowerCase();
            if (g.startsWith('m')) maleCount++;
            else if (g.startsWith('f')) femaleCount++;
          }

          roster.push({
            name: `${m.firstName} ${m.lastName}`.trim(),
            category: m.category || (isGuest ? 'Visitor / Guest' : 'Adult'),
            phone: m.phone || '—',
            gender: m.gender || '—',
            location: m.address ? m.address.replace(/^📍\s*/, '') : '—',
            time: found ? (found.time || 'Today') : 'Today',
            method: found ? (found.method || 'KIOSK') : 'KIOSK',
            isGuest
          });
        } else {
          absentCount++;
        }
      });

      const now = new Date();
      const reportId = 'rep_sess_' + Date.now();
      const dateFormatted = `${now.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })} at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

      const newReport = {
        id: reportId,
        serviceName: targetService,
        completedAt: now.toISOString(),
        dateFormatted,
        totalMembers: directoryList.length,
        presentCount,
        absentCount,
        guestCount,
        maleCount,
        femaleCount,
        childCount,
        roster
      };

      let archivedReports = [];
      try {
        archivedReports = JSON.parse(localStorage.getItem('sfmi_archived_service_reports') || '[]');
      } catch (e) {}

      archivedReports.unshift(newReport);
      localStorage.setItem('sfmi_archived_service_reports', JSON.stringify(archivedReports));

      // Reset live kiosk if this service was live
      const activeKiosk = localStorage.getItem('sfmi_active_kiosk_service');
      if (activeKiosk === targetService) {
        localStorage.removeItem('sfmi_active_kiosk_service');
      }

      showToast(`Check-In ended for "${targetService}"! Report compiled & archived in Reports section.`, 'success', 'Report Generated');

      switchTab('reports');
      switchReportSubTab('ATTENDANCE');
      renderArchivedCompletedServiceReports();
    }

    function downloadArchivedServiceReportExcel(reportIdOrIdx) {
      let archived = [];
      try { archived = JSON.parse(localStorage.getItem('sfmi_archived_service_reports') || '[]'); } catch(e) {}
      let rep = null;
      if (typeof reportIdOrIdx === 'number' || (!isNaN(reportIdOrIdx) && String(reportIdOrIdx).trim() !== '' && !String(reportIdOrIdx).startsWith('rep_'))) {
        rep = archived[Number(reportIdOrIdx)];
      }
      if (!rep && reportIdOrIdx) {
        rep = archived.find(r => r.id === reportIdOrIdx);
      }
      if (!rep && archived.length > 0) {
        rep = archived[0];
      }
      if (!rep) {
        showToast('Archived report not found.', 'error', 'Report Error');
        return;
      }

      let csv = '\uFEFF'; // Excel UTF-8 BOM
      csv += `Official Attendance & Demographics Summary Report\n`;
      csv += `Service Name,"${rep.serviceName}"\n`;
      csv += `Completed Date,"${rep.dateFormatted}"\n`;
      csv += `Total Directory Members,${rep.totalMembers}\n`;
      csv += `Total Present,${rep.presentCount}\n`;
      csv += `Total Absent,${rep.absentCount}\n`;
      csv += `First-Timer Guests,${rep.guestCount}\n`;
      csv += `Male Count,${rep.maleCount}\n`;
      csv += `Female Count,${rep.femaleCount}\n`;
      csv += `Children Count,${rep.childCount}\n\n`;

      csv += `Full Name,Category,Phone Number,Gender,Residential Location,Check-In Time,Check-In Method\n`;

      (rep.roster || []).forEach(m => {
        const name = `"${m.name || ''}"`;
        const category = `"${m.category || ''}"`;
        const phone = `"${m.phone || ''}"`;
        const gender = `"${m.gender || ''}"`;
        const location = `"${(m.location || '').replace(/"/g, '""')}"`;
        const time = `"${m.time || 'Today'}"`;
        const method = `"${m.method || 'KIOSK'}"`;
        csv += `${name},${category},${phone},${gender},${location},${time},${method}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `SFMI_Completed_Service_Report_${rep.serviceName.replace(/[^a-zA-Z0-9]/g, '_')}_${formatLocalDate(new Date())}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Completed Service Excel report downloaded successfully!', 'success', 'Export Complete');
    }

    function viewArchivedServiceReportRoster(reportIdOrIdx) {
      let archived = [];
      try { archived = JSON.parse(localStorage.getItem('sfmi_archived_service_reports') || '[]'); } catch(e) {}
      let rep = null;
      if (typeof reportIdOrIdx === 'number' || (!isNaN(reportIdOrIdx) && String(reportIdOrIdx).trim() !== '' && !String(reportIdOrIdx).startsWith('rep_'))) {
        rep = archived[Number(reportIdOrIdx)];
      }
      if (!rep && reportIdOrIdx) {
        rep = archived.find(r => r.id === reportIdOrIdx);
      }
      if (!rep && archived.length > 0) {
        rep = archived[0];
      }
      if (!rep) {
        showToast('Archived report not found.', 'error', 'Report Error');
        return;
      }

      // Convert archived report format into standard session structure and open the full modal
      const sessionObj = {
        id: rep.id,
        serviceName: rep.serviceName,
        dateFormatted: rep.dateFormatted,
        totalLogs: rep.presentCount || (rep.roster ? rep.roster.length : 0),
        maleCount: rep.maleCount || 0,
        femaleCount: rep.femaleCount || 0,
        guestCount: rep.guestCount || 0,
        childCount: rep.childCount || 0,
        logs: (rep.roster || []).map(r => ({
          checkedInAt: rep.completedAt || new Date().toISOString(),
          isGuest: r.isGuest,
          method: r.method || 'KIOSK',
          member: {
            firstName: (r.name || '').split(' ')[0],
            lastName: (r.name || '').split(' ').slice(1).join(' '),
            phone: r.phone,
            category: r.category,
            gender: r.gender,
            address: r.location
          }
        }))
      };

      compiledAttSessionsMap[rep.id] = sessionObj;
      compiledAttSessionsList.unshift(sessionObj);

      openViewCompiledAttendanceModal(rep.id);
    }

    function deleteArchivedServiceReport(reportIdOrIdx) {
      let archived = [];
      try { archived = JSON.parse(localStorage.getItem('sfmi_archived_service_reports') || '[]'); } catch(e) {}
      let targetIdx = -1;
      if (typeof reportIdOrIdx === 'number') {
        targetIdx = reportIdOrIdx;
      } else {
        targetIdx = archived.findIndex(r => r.id === reportIdOrIdx);
      }
      if (targetIdx < 0 || !archived[targetIdx]) return;

      const reportName = archived[targetIdx].serviceName || 'Service Report';
      if (!confirm(`Are you sure you want to revert/remove the archived report for "${reportName}"?\n\nThis will remove it from the Completed Reports list.`)) {
        return;
      }

      archived.splice(targetIdx, 1);
      localStorage.setItem('sfmi_archived_service_reports', JSON.stringify(archived));
      renderArchivedCompletedServiceReports();
      showToast(`Archived report for "${reportName}" removed successfully.`, 'info', 'Report Reverted');
    }

    /* Financial Analytics, Date Filtering & Export */
    async function loadFinanceData() {
      let currentUser = null;
      try {
        currentUser = JSON.parse(sessionStorage.getItem('sfmi_current_user') || localStorage.getItem('sfmi_current_user'));
      } catch (e) {}
      const isSubAdmin = currentUser && (currentUser.role === 'SUB_ADMIN' || currentUser.role === 'ADMIN');
      if (isSubAdmin) {
        rawFinanceEntries = [];
        filteredFinanceEntries = [];
        return;
      }

      try {
        const token = localStorage.getItem('sfmi_token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const entRes = await fetch(`${API_BASE}/finance/service-entries`, { headers });
        if (entRes.ok) {
          const entData = await entRes.json();
          // Always use live API data — never fall back to stale localStorage
          rawFinanceEntries = Array.isArray(entData) ? entData : [];
        } else {
          rawFinanceEntries = [];
        }
      } catch (e) {
        rawFinanceEntries = [];
      }

      filteredFinanceEntries = [...rawFinanceEntries];
      recomputeFinanceMetrics();
      renderAdminFinanceTable();
    }

    function setFinancePreset(preset) {
      document.getElementById('btnPresetAll').classList.toggle('active', preset === 'all');
      document.getElementById('btnPresetThisMonth').classList.toggle('active', preset === 'this_month');
      document.getElementById('btnPresetLastMonth').classList.toggle('active', preset === 'last_month');
      document.getElementById('btnPresetThisYear').classList.toggle('active', preset === 'this_year');

      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();

      if (preset === 'all') {
        document.getElementById('finFilterStart').value = '';
        document.getElementById('finFilterEnd').value = '';
      } else if (preset === 'this_month') {
        const start = formatLocalDate(new Date(year, month, 1));
        const end = formatLocalDate(new Date(year, month + 1, 0));
        document.getElementById('finFilterStart').value = start;
        document.getElementById('finFilterEnd').value = end;
      } else if (preset === 'last_month') {
        const start = formatLocalDate(new Date(year, month - 1, 1));
        const end = formatLocalDate(new Date(year, month, 0));
        document.getElementById('finFilterStart').value = start;
        document.getElementById('finFilterEnd').value = end;
      } else if (preset === 'this_year') {
        const start = formatLocalDate(new Date(year, 0, 1));
        const end = formatLocalDate(new Date(year, 11, 31));
        document.getElementById('finFilterStart').value = start;
        document.getElementById('finFilterEnd').value = end;
      }

      applyCustomDateFilter();
    }

    function applyCustomDateFilter() {
      const start = document.getElementById('finFilterStart').value;
      const end = document.getElementById('finFilterEnd').value;
      const service = document.getElementById('finFilterService').value;

      filteredFinanceEntries = rawFinanceEntries.filter(item => {
        const itemDate = item.serviceDate.split('T')[0];
        if (start && itemDate < start) return false;
        if (end && itemDate > end) return false;
        if (service !== 'ALL' && !item.serviceName.toLowerCase().includes(service.toLowerCase())) return false;
        return true;
      });

      recomputeFinanceMetrics();
      renderAdminFinanceTable();
    }

    function recomputeFinanceMetrics() {
      let tot = 0, tithes = 0, off = 0, bld = 0, seed = 0, thk = 0;
      let cash = 0, momo = 0, bank = 0;

      filteredFinanceEntries.forEach(e => {
        tot += Number(e.totalAmount);
        tithes += Number(e.tithes);
        off += Number(e.offering);
        bld += Number(e.buildingFund);
        seed += Number(e.specialSeed);
        thk += (Number(e.thanksgiving) + Number(e.other));
        cash += Number(e.cashAmount);
        momo += Number(e.momoAmount);
        bank += Number(e.bankAmount);
      });

      const tithesPct = tot > 0 ? Math.round((tithes / tot) * 100) : 0;
      const offPct = tot > 0 ? Math.round((off / tot) * 100) : 0;
      const seedPct = tot > 0 ? Math.round((seed / tot) * 100) : 0;
      const bldPct = tot > 0 ? Math.round((bld / tot) * 100) : 0;
      const thkPct = tot > 0 ? Math.round((thk / tot) * 100) : 0;

      const cashPct = tot > 0 ? Math.round((cash / tot) * 100) : 0;
      const momoPct = tot > 0 ? Math.round((momo / tot) * 100) : 0;
      const bankPct = tot > 0 ? Math.round((bank / tot) * 100) : 0;

      document.getElementById('statFinTotal').innerText = `GHS ${tot.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      document.getElementById('statFinTithes').innerText = `GHS ${tithes.toLocaleString()} (${tithesPct}%)`;
      document.getElementById('statFinOffering').innerText = `GHS ${off.toLocaleString()} (${offPct}%)`;
      document.getElementById('statFinSpecial').innerText = `GHS ${(seed + bld).toLocaleString()} (${seedPct + bldPct}%)`;
      document.getElementById('statFinAvg').innerText = `GHS ${(tot / (filteredFinanceEntries.length || 1)).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

      document.getElementById('barTithesVal').innerText = `GHS ${tithes.toLocaleString()} (${tithesPct}%)`;
      document.getElementById('barTithesFill').style.width = `${tithesPct}%`;

      document.getElementById('barOfferingVal').innerText = `GHS ${off.toLocaleString()} (${offPct}%)`;
      document.getElementById('barOfferingFill').style.width = `${offPct}%`;

      document.getElementById('barSeedVal').innerText = `GHS ${seed.toLocaleString()} (${seedPct}%)`;
      document.getElementById('barSeedFill').style.width = `${seedPct}%`;

      document.getElementById('barBuildingVal').innerText = `GHS ${bld.toLocaleString()} (${bldPct}%)`;
      document.getElementById('barBuildingFill').style.width = `${bldPct}%`;

      document.getElementById('barThanksVal').innerText = `GHS ${thk.toLocaleString()} (${thkPct}%)`;
      document.getElementById('barThanksFill').style.width = `${thkPct}%`;

      document.getElementById('payCashVal').innerText = `GHS ${cash.toLocaleString()} (${cashPct}%)`;
      document.getElementById('payCashFill').style.width = `${cashPct}%`;

      document.getElementById('payMomoVal').innerText = `GHS ${momo.toLocaleString()} (${momoPct}%)`;
      document.getElementById('payMomoFill').style.width = `${momoPct}%`;

      document.getElementById('payBankVal').innerText = `GHS ${bank.toLocaleString()} (${bankPct}%)`;
      document.getElementById('payBankFill').style.width = `${bankPct}%`;

      document.getElementById('finCatCountText').innerText = `${filteredFinanceEntries.length} Services in Selected Period`;
      document.getElementById('finTableCountLabel').innerText = `Showing ${filteredFinanceEntries.length} service remittance records`;
    }

    function renderAdminFinanceTable(list = filteredFinanceEntries) {
      const tbody = document.getElementById('adminFinTableBody');
      const mobileCards = document.getElementById('adminFinCardsBody');
      const isMobile = window.innerWidth <= 700;

      if (list.length === 0) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--muted); padding: 24px;">No financial records match the selected filter.</td></tr>`;
        if (mobileCards) mobileCards.innerHTML = `<div style="text-align:center;color:var(--muted);padding:28px 0;">No financial records found.</div>`;
        return;
      }

      // Desktop table rows
      if (tbody) {
        tbody.innerHTML = list.map(item => {
          const dt = formatCalendarDateLabel(item.serviceDate, { day: '2-digit', month: 'short', year: 'numeric' });
          const tot = Number(item.totalAmount);
          return `
            <tr>
              <td><strong>${dt}</strong></td>
              <td>${item.serviceName}</td>
              <td>GHS ${Number(item.tithes).toLocaleString()}</td>
              <td>GHS ${Number(item.offering).toLocaleString()}</td>
              <td>GHS ${Number(item.buildingFund).toLocaleString()}</td>
              <td>GHS ${Number(item.specialSeed).toLocaleString()}</td>
              <td><strong style="color: var(--emerald); font-size: 14px;">GHS ${tot.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></td>
              <td>${item.recordedBy}</td>
              <td><span class="badge-check"><i class="fa-solid fa-circle-check" style="margin-right: 4px;"></i> Reconciled</span></td>
              <td>
                <button class="btn-main" style="padding: 4px 10px; font-size: 12px;" onclick="printServiceRemittance('${item.id}')">
                  <i class="fas fa-receipt"></i> Slip
                </button>
              </td>
            </tr>
          `;
        }).join('');
      }

      // Mobile card rows
      if (mobileCards) {
        mobileCards.innerHTML = list.map((item, idx) => {
          const dt = formatCalendarDateLabel(item.serviceDate, { day: '2-digit', month: 'short', year: 'numeric' });
          const tot = Number(item.totalAmount);
          return `
            <div class="fin-mobile-card">
              <div class="fin-mobile-card-top">
                <div>
                  <div class="fin-mobile-card-date">${dt}</div>
                  <div class="fin-mobile-card-service">${item.serviceName}</div>
                </div>
                <div class="fin-mobile-card-total">GHS ${tot.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
              </div>
              <div class="fin-mobile-card-row">
                <span class="badge-check"><i class="fa-solid fa-circle-check" style="margin-right: 4px;"></i> Reconciled</span>
                <span style="font-size:12px;color:var(--muted);">By: ${item.recordedBy}</span>
              </div>
              <div class="fin-mobile-card-actions">
                <button class="btn-main" style="flex:1;justify-content:center;padding:9px;font-size:13px;" onclick="openFinViewModal(${idx})">
                  <i class="fas fa-eye"></i> View Details
                </button>
                <button class="btn-download" style="flex:1;justify-content:center;padding:9px;font-size:13px;" onclick="printServiceRemittance('${item.id}')">
                  <i class="fas fa-receipt"></i> Slip
                </button>
              </div>
            </div>
          `;
        }).join('');
      }

      // Toggle visibility based on screen size
      syncFinanceViewMode();
    }

    function syncFinanceViewMode() {
      const isMobile = window.innerWidth <= 700;
      const desktopTable = document.querySelector('.fin-table-desktop');
      const mobileCards = document.getElementById('adminFinCardsBody');
      const filterDesktop = document.querySelector('.filter-presets-desktop');
      const filterMobile = document.querySelector('.filter-presets-mobile');
      if (desktopTable) desktopTable.style.display = isMobile ? 'none' : 'block';
      if (mobileCards) mobileCards.style.display = isMobile ? 'block' : 'none';
      if (filterDesktop) filterDesktop.style.display = isMobile ? 'none' : 'flex';
      if (filterMobile) filterMobile.style.display = isMobile ? 'block' : 'none';
    }

    window.addEventListener('resize', syncFinanceViewMode);

    let _finViewList = [];
    function openFinViewModal(idx) {
      _finViewList = filteredFinanceEntries;
      const item = _finViewList[idx];
      if (!item) return;
      const dt = formatCalendarDateLabel(item.serviceDate, { day: '2-digit', month: 'short', year: 'numeric' });
      const tot = Number(item.totalAmount);
      const rows = [
        ['Date', dt],
        ['Service', item.serviceName],
        ['Tithes', `GHS ${Number(item.tithes).toLocaleString('en-US',{minimumFractionDigits:2})}`],
        ['General Offering', `GHS ${Number(item.offering).toLocaleString('en-US',{minimumFractionDigits:2})}`],
        ['Building Fund', `GHS ${Number(item.buildingFund).toLocaleString('en-US',{minimumFractionDigits:2})}`],
        ['Special Seeds', `GHS ${Number(item.specialSeed).toLocaleString('en-US',{minimumFractionDigits:2})}`],
        ['Thanksgiving', `GHS ${Number(item.thanksgiving||0).toLocaleString('en-US',{minimumFractionDigits:2})}`],
        ['Total Collected', `GHS ${tot.toLocaleString('en-US',{minimumFractionDigits:2})}`],
        ['Recorded By', item.recordedBy],
        ['Status', '✓ Reconciled'],
      ];
      document.getElementById('finViewModalBody').innerHTML = rows.map(([k,v]) =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--line);">
          <span style="font-size:13px;color:var(--muted);">${k}</span>
          <span style="font-size:13.5px;font-weight:700;">${v}</span>
        </div>`
      ).join('');
      const modal = document.getElementById('finViewModal');
      if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('active');
      }
    }

    function closeFinViewModal() {
      const modal = document.getElementById('finViewModal');
      if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
      }
    }

    function filterAdminFinanceTable() {
      const q = document.getElementById('finTableSearch').value.toLowerCase();
      const filtered = filteredFinanceEntries.filter(e => 
        e.serviceName.toLowerCase().includes(q) || 
        e.serviceDate.includes(q) || 
        e.recordedBy.toLowerCase().includes(q)
      );
      renderAdminFinanceTable(filtered);
    }

    function printServiceRemittance(id) {
      window.open('/finance', '_blank');
    }

    function downloadFinancialCSV() {
      if (filteredFinanceEntries.length === 0) {
        showToast('No financial records found to export for the selected date period.', 'warning', 'Export Notice');
        return;
      }

      let csv = 'Service Date,Service Name,Tithes (GHS),Offering (GHS),Building Fund (GHS),Special Seed (GHS),Thanksgiving (GHS),Other (GHS),Total Amount (GHS),Cash (GHS),MoMo (GHS),Bank (GHS),POS (GHS),Recorded By,Notes\n';

      filteredFinanceEntries.forEach(e => {
        const date = e.serviceDate.split('T')[0];
        const name = `"${e.serviceName.replace(/"/g, '""')}"`;
        const recorded = `"${(e.recordedBy || '').replace(/"/g, '""')}"`;
        const notes = `"${(e.notes || '').replace(/"/g, '""')}"`;
        
        csv += `${date},${name},${e.tithes || 0},${e.offering || 0},${e.buildingFund || 0},${e.specialSeed || 0},${e.thanksgiving || 0},${e.other || 0},${e.totalAmount || 0},${e.cashAmount || 0},${e.momoAmount || 0},${e.bankAmount || 0},${e.posAmount || 0},${recorded},${notes}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `SFMI_Financial_Report_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Financial CSV report downloaded successfully!', 'success', 'Export Complete');
    }

    /* ATTENDANCE & DEMOGRAPHICS (SERVICE-BASED PRESENT VS ABSENTEE TRACKING) */
    async function handleAttServiceChange() {
      currentSelectedService = document.getElementById('attServiceSelect').value;
      await fetchLiveCounts();
    }

    function setAttFilter(filter) {
      currentAttFilter = filter;
      document.getElementById('btnAttFilterAll').classList.toggle('active', filter === 'ALL');
      document.getElementById('btnAttFilterPresent').classList.toggle('active', filter === 'PRESENT');
      document.getElementById('btnAttFilterAbsent').classList.toggle('active', filter === 'ABSENT');
      const guestBtn = document.getElementById('btnAttFilterGuest');
      if (guestBtn) guestBtn.classList.toggle('active', filter === 'GUEST');
      const guestAbsentBtn = document.getElementById('btnAttFilterGuestAbsent');
      if (guestAbsentBtn) guestAbsentBtn.classList.toggle('active', filter === 'GUEST_ABSENT');

      const tTitle = document.getElementById('attTableTitle');
      const tSub = document.getElementById('attTableSubtitle');
      if (tTitle && tSub) {
        if (filter === 'ALL') {
          tTitle.innerText = 'Member Service Attendance & Absentee List';
          tSub.innerText = 'Showing members who attended vs those who missed this service';
        } else if (filter === 'PRESENT') {
          tTitle.innerText = 'Present Attendees List';
          tSub.innerText = 'Showing all members and guests who checked in and attended';
        } else if (filter === 'ABSENT') {
          tTitle.innerText = 'Absent Regular Church Members';
          tSub.innerText = 'Showing regular members who missed this service';
        } else if (filter === 'GUEST') {
          tTitle.innerText = 'First-Timers & Guests (Present)';
          tSub.innerText = 'Showing first-timers and guests who attended this service';
        } else if (filter === 'GUEST_ABSENT') {
          tTitle.innerText = 'Absent First-Timers & Guests';
          tSub.innerText = 'Showing first-timers and visitors who did not attend this service';
        }
      }

      renderAttendanceAndDemographics();
    }

    function canonicalServiceName(raw) {
      if (!raw) return 'Sunday: Family & Friends Service';
      const trimmed = String(raw).trim();
      if (typeof customPrograms !== 'undefined' && Array.isArray(customPrograms)) {
        const found = customPrograms.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
        if (found) return found.name;
      }
      const s = trimmed.toLowerCase();
      if (s.includes('family & friends') || s.includes('family and friends') || s === 'sunday' || s.startsWith('sunday:')) {
        return 'Sunday: Family & Friends Service';
      }
      if (s.includes('time with the lord') || s.includes('time with lord') || s === 'wednesday' || s.startsWith('wednesday:')) {
        return 'Wednesday: Time with the Lord';
      }
      if (s.includes('prophetic healing') || s.includes('prophetic deliverance') || s === 'friday' || s.startsWith('friday:')) {
        return 'Friday: Prophetic Healing & Deliverance';
      }
      return trimmed;
    }

    function getAttendanceListForService(serviceName) {
      const selectedDate = document.getElementById('attDateSelect') ? document.getElementById('attDateSelect').value.trim() : '';
      const canonName = canonicalServiceName(serviceName);

      if (serviceName === 'ALL') {
        if (selectedDate && selectedDate !== 'ALL') {
          return serviceAttendanceMap[`ALL_${selectedDate}`] || serviceAttendanceMap['ALL'] || [];
        }
        return serviceAttendanceMap['ALL'] || [];
      }

      if (selectedDate && selectedDate !== 'ALL') {
        if (serviceAttendanceMap[`${serviceName}_${selectedDate}`]?.length > 0) {
          return serviceAttendanceMap[`${serviceName}_${selectedDate}`];
        }
        if (serviceAttendanceMap[`${canonName}_${selectedDate}`]?.length > 0) {
          return serviceAttendanceMap[`${canonName}_${selectedDate}`];
        }
        if (serviceAttendanceMap[serviceName]?.length > 0) {
          return serviceAttendanceMap[serviceName];
        }
        if (serviceAttendanceMap[canonName]?.length > 0) {
          return serviceAttendanceMap[canonName];
        }
        return serviceAttendanceMap[`${serviceName}_${selectedDate}`] || [];
      }

      if (serviceAttendanceMap[serviceName]?.length > 0) {
        return serviceAttendanceMap[serviceName];
      }
      if (serviceAttendanceMap[canonName]?.length > 0) {
        return serviceAttendanceMap[canonName];
      }

      return [];
    }

    function renderAttendanceAndDemographics() {
      const selectedDate = document.getElementById('attDateSelect') ? document.getElementById('attDateSelect').value.trim() : '';
      const activeAttList = getAttendanceListForService(currentSelectedService);
      
      // Combine all directory members + any active check-ins (e.g. newly registered visitors/guests)
      let directoryList = [...allMembers];

      activeAttList.forEach(att => {
        const attPhone = (att.phone || '').trim();
        const attNormPhone = normalizePhoneClient(attPhone);
        const attName = (att.name || '').trim().toLowerCase();
        const exists = directoryList.some(m => {
          if (att.memberId && m.id && att.memberId === m.id) return true;
          const mNormPhone = normalizePhoneClient(m.phone);
          if (attNormPhone && mNormPhone && attNormPhone === mNormPhone) return true;
          if (attPhone && m.phone && m.phone.trim() === attPhone) return true;
          const mName = `${m.firstName} ${m.lastName}`.trim().toLowerCase();
          if (attName && attName === mName) return true;
          return false;
        });
        if (!exists && att.name) {
          const parts = att.name.split(' ');
          const fName = parts[0] || 'Visitor';
          const lName = parts.slice(1).join(' ') || 'Guest';
          directoryList.push({
            id: att.memberId || ('guest_' + Math.random().toString(36).substr(2, 9)),
            firstName: fName,
            lastName: lName,
            phone: att.phone || '—',
            gender: att.gender || 'Not specified',
            address: att.address || '',
            category: 'Visitor / Guest',
            role: 'Visitor / First Timer',
            isGuest: true
          });
        }
      });

      // Separate regular church members vs visitors/guests
      const regularDirectory = directoryList.filter(m => !isGuestMember(m));
      const guestDirectory = directoryList.filter(isGuestMember);

      let regularPresentCount = 0;
      let regularAbsentCount = 0;
      let attendingGuestCount = 0;
      let attendingMale = 0;
      let attendingFemale = 0;
      let attendingChild = 0;
      let attendingOther = 0;

      const processedMembers = directoryList.map(m => {
        const mNormPhone = normalizePhoneClient(m.phone);
        const mFullName = `${m.firstName} ${m.lastName}`.trim().toLowerCase();

        const found = activeAttList.find(a => {
          if (a.memberId && m.id && a.memberId === m.id) return true;
          const aNormPhone = normalizePhoneClient(a.phone);
          if (aNormPhone && mNormPhone && aNormPhone === mNormPhone) return true;
          if (a.phone && m.phone && a.phone.trim() === m.phone.trim()) return true;
          const aFullName = (a.name || `${a.firstName || ''} ${a.lastName || ''}`).trim().toLowerCase();
          if (aFullName && aFullName === mFullName) return true;
          return false;
        });
        const isPresent = Boolean(found);
        const isGuest = isGuestMember(m);

        if (isPresent) {
          if (isGuest) {
            attendingGuestCount++;
          } else {
            regularPresentCount++;
          }

          const isChild = (m.category || '').toLowerCase() === 'child' || (m.role && m.role.toLowerCase().includes('child'));
          if (isChild) {
            attendingChild++;
          } else {
            const g = (m.gender || '').trim().toLowerCase();
            if (g.startsWith('m')) attendingMale++;
            else if (g.startsWith('f')) attendingFemale++;
            else attendingOther++;
          }
        } else {
          if (!isGuest) {
            regularAbsentCount++;
          }
        }

        return {
          ...m,
          isPresent,
          isGuest,
          checkInTime: found ? (found.time || 'Today') : (m.isGuest ? 'Today' : '—'),
          checkInMethod: found ? (found.method || 'KIOSK') : (m.isGuest ? 'KIOSK' : '—')
        };
      });

      const totalRegular = regularDirectory.length;
      const totalGuests = guestDirectory.length;
      const totalPresent = regularPresentCount + attendingGuestCount;
      const guestAbsentCount = Math.max(0, totalGuests - attendingGuestCount);

      const presentPct = totalRegular > 0 ? Math.round((regularPresentCount / totalRegular) * 100) : 0;
      const absentPct = totalRegular > 0 ? Math.round((regularAbsentCount / totalRegular) * 100) : 0;
      
      const malePct = totalPresent > 0 ? Math.round((attendingMale / totalPresent) * 100) : 0;
      const femalePct = totalPresent > 0 ? Math.round((attendingFemale / totalPresent) * 100) : 0;
      const childPct = totalPresent > 0 ? Math.round((attendingChild / totalPresent) * 100) : 0;

      // Update Filter Counts in Toolbar:
      // "All Members" strictly reflects regular church members
      document.getElementById('countAllFilter').innerText = totalRegular;
      // "Present" reflects total attendees who came
      document.getElementById('countPresentFilter').innerText = totalPresent;
      // "Absent / Missed" reflects only regular members who missed
      document.getElementById('countAbsentFilter').innerText = regularAbsentCount;
      // "First-Timers / Guests" reflects attending guests vs total
      const guestFilterCount = document.getElementById('countGuestFilter');
      if (guestFilterCount) {
        guestFilterCount.innerText = `${attendingGuestCount} Present / ${totalGuests}`;
      }
      // "First-Timers / Guests (Absent)" reflects absent guests count
      const guestAbsentFilterCount = document.getElementById('countGuestAbsentFilter');
      if (guestAbsentFilterCount) {
        guestAbsentFilterCount.innerText = guestAbsentCount;
      }

      // Update Metric Cards
      document.getElementById('statTodayCount').innerText = totalRegular;
      document.getElementById('statPresentCount').innerText = `${totalPresent} (${regularPresentCount} Mems + ${attendingGuestCount} Guests)`;
      document.getElementById('statAbsentCount').innerText = `${regularAbsentCount} (${absentPct}%)`;
      const guestStatCard = document.getElementById('statAttGuestCount');
      if (guestStatCard) guestStatCard.innerText = attendingGuestCount > 0 ? `${attendingGuestCount} Attended (${totalGuests} Total)` : `${totalGuests} Guests`;
      const guestAbsentStatCard = document.getElementById('statAttGuestAbsentCount');
      if (guestAbsentStatCard) guestAbsentStatCard.innerText = `${guestAbsentCount} Absent`;
      document.getElementById('statAttMaleCount').innerText = `${attendingMale} (${malePct}%)`;
      document.getElementById('statAttFemaleCount').innerText = `${attendingFemale} (${femalePct}%)`;
      document.getElementById('statAttChildCount').innerText = `${attendingChild} (${childPct}%)`;

      // Update Demographic Ratio Progress (Men | Women | Children)
      document.getElementById('ratioFillMale').style.width = `${malePct}%`;
      document.getElementById('ratioFillFemale').style.width = `${femalePct}%`;
      document.getElementById('ratioFillChild').style.width = `${childPct}%`;

      let ratioText = `${attendingMale} Men (${malePct}%) · ${attendingFemale} Women (${femalePct}%) · ${attendingChild} Children (${childPct}%) · ${attendingGuestCount} First-Timer Guests`;
      if (attendingOther > 0) {
        ratioText += ` · ${attendingOther} Unspecified Gender`;
      }
      document.getElementById('ratioDetailsText').innerText = ratioText;
      document.getElementById('legendMaleText').innerText = `${attendingMale} (${malePct}%)`;
      document.getElementById('legendFemaleText').innerText = `${attendingFemale} (${femalePct}%)`;
      document.getElementById('legendChildText').innerText = `${attendingChild} (${childPct}%)`;

      // Filter by Active View Mode (ALL, PRESENT, ABSENT, GUEST, GUEST_ABSENT)
      let listToDisplay = processedMembers;
      if (currentAttFilter === 'ALL') {
        // Show regular church members PLUS any Guest who actually attended/checked in for this service!
        listToDisplay = processedMembers.filter(m => !m.isGuest || m.isPresent);
      } else if (currentAttFilter === 'PRESENT') {
        // Show everyone who attended
        listToDisplay = processedMembers.filter(m => m.isPresent);
      } else if (currentAttFilter === 'ABSENT') {
        // Only show regular church members who missed, NEVER visitors
        listToDisplay = processedMembers.filter(m => !m.isGuest && !m.isPresent);
      } else if (currentAttFilter === 'GUEST') {
        // Show only First-Timers & Guests who attended (Present)
        listToDisplay = processedMembers.filter(m => m.isGuest && m.isPresent);
      } else if (currentAttFilter === 'GUEST_ABSENT') {
        // Show only First-Timers & Guests who did NOT attend / missed this service!
        listToDisplay = processedMembers.filter(m => m.isGuest && !m.isPresent);
      }

      // Sort: attendees currently PRESENT appear at the top so new kiosk check-ins are immediately visible!
      listToDisplay.sort((a, b) => {
        if (a.isPresent && !b.isPresent) return -1;
        if (!a.isPresent && b.isPresent) return 1;
        return (a.firstName || '').localeCompare(b.firstName || '');
      });

      renderAttendanceTableHTML(listToDisplay);
    }

    function renderAttendanceTableHTML(list) {
      const tbody = document.getElementById('attendanceTableBody');
      const mobCards = document.getElementById('attMobileCards');

      if (list.length === 0) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--muted); padding: 30px;">No attendees found matching this filter for the selected service.</td></tr>`;
        if (mobCards) mobCards.innerHTML = `<div style="text-align:center;color:var(--muted);padding:28px 0;">No attendees found.</div>`;
        return;
      }

      const buildBadges = (m) => {
        const isMale = (m.gender||'').toLowerCase().startsWith('m');
        const isFemale = (m.gender||'').toLowerCase().startsWith('f');
        const genderBadge = isMale ? `<span class="badge-gender-male">Male</span>` : isFemale ? `<span class="badge-gender-female">Female</span>` : `—`;
        const isChild = m.category==='Child'||(m.role&&m.role.toLowerCase().includes('child'));
        const isGuest = Boolean(m.isGuest) ||
                        m.category === 'Visitor' ||
                        m.category === 'Visitor / First-Timer' ||
                        m.category === 'Visitor / Guest' ||
                        (m.role && m.role.toLowerCase().includes('visitor')) ||
                        (m.role && m.role.toLowerCase().includes('first timer'));

        let catBadge = `<span class="badge-adult">Adult</span>`;
        if (isGuest) {
          catBadge = `<span class="badge-guest"><i class="fa-solid fa-star" style="color:#d97706; margin-right:4px;"></i> New Visitor / Guest</span>`;
        } else if (isChild) {
          catBadge = `<span class="badge-child"><i class="fa-solid fa-children" style="margin-right:4px;"></i> Child</span>`;
        } else if (m.category==='Youth') {
          catBadge = `<span class="badge-check" style="background:#e0f2fe;color:#0369a1;">Youth</span>`;
        }

        const roleDisplay = isGuest 
          ? `<span style="background:#fffbeb; color:#b45309; font-weight:800; padding:2px 8px; border-radius:4px; border:1px solid #fde68a;"><i class="fa-solid fa-handshake" style="margin-right:4px;"></i> First Timer</span>`
          : `<span class="badge-check">${m.role||'Member'}</span>`;

        const phoneDisplay = isChild&&m.guardian ? `${escapeHtml(m.phone)||'—'} <span style="font-size:11px;color:var(--muted);"><i class="fa-solid fa-user-shield" style="margin-right:3px;"></i> ${escapeHtml(m.guardian)}</span>` : (escapeHtml(m.phone)||'—');
        return { genderBadge, catBadge, phoneDisplay, roleDisplay, isGuest };
      };

      // Desktop table
      if (tbody) {
        tbody.innerHTML = list.map((m, i) => {
          const {genderBadge, catBadge, phoneDisplay, roleDisplay} = buildBadges(m);
          const statusBadge = m.isPresent ? `<span class="badge-present"><i class="fas fa-check-circle"></i> Present</span>` : `<span class="badge-absent"><i class="fas fa-times-circle"></i> Absent</span>`;
          const followUpBtn = m.isPresent
            ? `<button class="btn-main" style="padding:4px 10px;font-size:11.5px;background:#14532d;" onclick="toggleMemberAttendance('${m.phone}',false)"><i class="fas fa-check"></i> Checked In</button>`
            : `<button class="btn-main" style="padding:4px 10px;font-size:11.5px;background:#c89b55;color:#111;" onclick="toggleMemberAttendance('${m.phone}',true)"><i class="fas fa-user-plus"></i> Mark Present</button>`;
          return `<tr>
            <td>${i+1}</td><td><strong>${escapeHtml(m.firstName)} ${escapeHtml(m.lastName)}</strong></td>
            <td>${catBadge}</td><td>${phoneDisplay}</td><td>${genderBadge}</td>
            <td>${m.address?`<span><i class="fa-solid fa-location-dot" style="margin-right:4px; color:var(--muted);"></i> ${escapeHtml(m.address)}</span>`:'—'}</td>
            <td>${roleDisplay}</td>
            <td>${statusBadge}</td>
            <td>${m.isPresent?`<strong>${m.checkInTime}</strong>`:'<span style="color:#991b1b;font-weight:700;font-size:12px;">Did Not Attend</span>'}</td>
            <td>${followUpBtn}</td>
          </tr>`;
        }).join('');
      }

      // Mobile cards
      if (mobCards) {
        mobCards.innerHTML = list.map((m, i) => {
          const {genderBadge, catBadge, phoneDisplay, roleDisplay} = buildBadges(m);
          const statusBadge = m.isPresent ? `<span class="badge-present"><i class="fas fa-check-circle"></i> Present</span>` : `<span class="badge-absent"><i class="fas fa-times-circle"></i> Absent</span>`;
          const btn = m.isPresent
            ? `<button class="btn-main mob-card-actions" style="background:#14532d;" onclick="toggleMemberAttendance('${m.phone}',false)"><i class="fas fa-check"></i> Checked In</button>`
            : `<button class="btn-main mob-card-actions" style="background:#c89b55;color:#111;" onclick="toggleMemberAttendance('${m.phone}',true)"><i class="fas fa-user-plus"></i> Mark Present</button>`;
          return `
            <div class="mob-card">
              <div class="mob-card-header">
                <div class="mob-card-name">${escapeHtml(m.firstName)} ${escapeHtml(m.lastName)}</div>
                ${statusBadge}
              </div>
              <div class="mob-card-meta">
                <div class="mob-card-row"><span>Category</span><strong>${catBadge}</strong></div>
                <div class="mob-card-row"><span>Gender</span><strong>${genderBadge}</strong></div>
                <div class="mob-card-row"><span>Phone</span><strong>${phoneDisplay}</strong></div>
                ${m.guardian?`<div class="mob-card-row"><span>Guardian</span><strong>${escapeHtml(m.guardian)}</strong></div>`:''}
                <div class="mob-card-row"><span>Role</span><strong>${roleDisplay}</strong></div>
                <div class="mob-card-row"><span>Check-In</span><strong>${m.isPresent?m.checkInTime:'Did Not Attend'}</strong></div>
              </div>
              <div class="mob-card-actions">${btn}</div>
            </div>`;
        }).join('');
      }

      syncAttendanceViewMode();
    }

    function syncAttendanceViewMode() {
      const isMobile = window.innerWidth <= 700;
      const tbl = document.querySelector('#secAttendance .table-responsive');
      const cards = document.getElementById('attMobileCards');
      if (tbl) tbl.style.display = isMobile ? 'none' : 'block';
      if (cards) cards.style.display = isMobile ? 'block' : 'none';
    }
    window.addEventListener('resize', syncAttendanceViewMode);

    function filterAttendanceTable() {
      const q = document.getElementById('attSearchInput').value.toLowerCase().trim();
      const activeAttList = getAttendanceListForService(currentSelectedService);

      let directoryList = [...allMembers];
      activeAttList.forEach(att => {
        const attPhone = (att.phone || '').trim();
        const attNormPhone = normalizePhoneClient(attPhone);
        const attName = (att.name || '').trim().toLowerCase();
        const exists = directoryList.some(m => {
          if (att.memberId && m.id && att.memberId === m.id) return true;
          const mNormPhone = normalizePhoneClient(m.phone);
          if (attNormPhone && mNormPhone && attNormPhone === mNormPhone) return true;
          if (attPhone && m.phone && m.phone.trim() === attPhone) return true;
          const mName = `${m.firstName} ${m.lastName}`.trim().toLowerCase();
          if (attName && attName === mName) return true;
          return false;
        });
        if (!exists && att.name) {
          const parts = att.name.split(' ');
          const fName = parts[0] || 'Visitor';
          const lName = parts.slice(1).join(' ') || 'Guest';
          directoryList.push({
            id: att.memberId || ('guest_' + Math.random().toString(36).substr(2, 9)),
            firstName: fName,
            lastName: lName,
            phone: att.phone || '—',
            gender: att.gender || 'Not specified',
            address: att.address || '',
            category: 'Visitor / Guest',
            role: 'Visitor / First Timer',
            isGuest: true
          });
        }
      });

      const processedMembers = directoryList.map(m => {
        const mNormPhone = normalizePhoneClient(m.phone);
        const mFullName = `${m.firstName} ${m.lastName}`.trim().toLowerCase();

        const found = activeAttList.find(a => {
          if (a.memberId && m.id && a.memberId === m.id) return true;
          const aNormPhone = normalizePhoneClient(a.phone);
          if (aNormPhone && mNormPhone && aNormPhone === mNormPhone) return true;
          if (a.phone && m.phone && a.phone.trim() === m.phone.trim()) return true;
          const aFullName = (a.name || `${a.firstName || ''} ${a.lastName || ''}`).trim().toLowerCase();
          if (aFullName && aFullName === mFullName) return true;
          return false;
        });
        const isPresent = Boolean(found);
        const isGuest = isGuestMember(m);
        return {
          ...m,
          isGuest,
          isPresent,
          checkInTime: found ? (found.time || 'Today') : (m.isGuest ? 'Today' : '—'),
          checkInMethod: found ? (found.method || 'KIOSK') : (m.isGuest ? 'KIOSK' : '—')
        };
      });

      let baseList = processedMembers;
      if (currentAttFilter === 'ALL') {
        baseList = processedMembers.filter(m => !m.isGuest || m.isPresent);
      } else if (currentAttFilter === 'PRESENT') {
        baseList = processedMembers.filter(m => m.isPresent);
      } else if (currentAttFilter === 'ABSENT') {
        baseList = processedMembers.filter(m => !m.isGuest && !m.isPresent);
      } else if (currentAttFilter === 'GUEST') {
        baseList = processedMembers.filter(m => m.isGuest && m.isPresent);
      } else if (currentAttFilter === 'GUEST_ABSENT') {
        baseList = processedMembers.filter(m => m.isGuest && !m.isPresent);
      }

      const filtered = baseList.filter(m => 
        !q ||
        `${m.firstName || ''} ${m.lastName || ''}`.toLowerCase().includes(q) ||
        (m.phone && m.phone.includes(q)) ||
        (m.guardian && m.guardian.toLowerCase().includes(q)) ||
        (m.address && m.address.toLowerCase().includes(q)) ||
        (m.category && m.category.toLowerCase().includes(q)) ||
        (m.role && m.role.toLowerCase().includes(q))
      );

      // Sort: attendees currently PRESENT appear at the top so new kiosk check-ins are immediately visible!
      filtered.sort((a, b) => {
        if (a.isPresent && !b.isPresent) return -1;
        if (!a.isPresent && b.isPresent) return 1;
        return (a.firstName || '').localeCompare(b.firstName || '');
      });

      renderAttendanceTableHTML(filtered);
    }

    async function toggleMemberAttendance(phone, makePresent) {
      const activeLiveService = localStorage.getItem('sfmi_active_kiosk_service') || (new Date().getDay() === 5 ? 'Friday: Prophetic Healing & Deliverance' : (new Date().getDay() === 3 ? 'Wednesday: Time with the Lord' : 'Sunday: Family & Friends Service'));
      const effectiveServiceName = (currentSelectedService && currentSelectedService !== 'ALL') ? currentSelectedService : activeLiveService;

      if (!serviceAttendanceMap[currentSelectedService]) {
        serviceAttendanceMap[currentSelectedService] = [];
      }
      if (effectiveServiceName !== currentSelectedService && !serviceAttendanceMap[effectiveServiceName]) {
        serviceAttendanceMap[effectiveServiceName] = [];
      }

      const norm = normalizePhoneClient(phone);
      if (makePresent) {
        const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const entry = { phone, time: timeNow, method: 'ADMIN_MANUAL' };
        serviceAttendanceMap[currentSelectedService].push(entry);
        if (effectiveServiceName !== currentSelectedService) {
          serviceAttendanceMap[effectiveServiceName].push(entry);
        }
        try {
          const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
          await fetch(`${API_BASE}/attendance/checkin`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ phone, serviceName: effectiveServiceName, method: 'MANUAL' })
          });
        } catch (e) {}
      } else {
        const filterFn = a => {
          if (a.phone === phone) return false;
          if (norm && normalizePhoneClient(a.phone) === norm) return false;
          return true;
        };
        serviceAttendanceMap[currentSelectedService] = serviceAttendanceMap[currentSelectedService].filter(filterFn);
        if (effectiveServiceName !== currentSelectedService && serviceAttendanceMap[effectiveServiceName]) {
          serviceAttendanceMap[effectiveServiceName] = serviceAttendanceMap[effectiveServiceName].filter(filterFn);
        }
      }

      renderAttendanceAndDemographics();
      setTimeout(fetchLiveCounts, 400);
    }

    function downloadAttendanceAbsenteeCSV() {
      const activeAttList = getAttendanceListForService(currentSelectedService);
      let csv = `Service Name,Full Name,Category,Phone Number,Parent / Guardian,Gender,Residential Location,Ministry Role,Attendance Status,Check-In Time\n`;

      allMembers.forEach(m => {
        const isGuest = isGuestMember(m);
        const mNorm = normalizePhoneClient(m.phone);
        const found = activeAttList.find(a => (a.phone && m.phone && (a.phone === m.phone || normalizePhoneClient(a.phone) === mNorm)) || `${m.firstName} ${m.lastName}`.toLowerCase() === (a.name || '').toLowerCase());
        const isPresent = Boolean(found);
        if (isGuest && !isPresent) return; // Exclude visitors who did not attend this service from absentee list
        const status = isPresent ? 'PRESENT (Attended)' : 'ABSENT (Did Not Attend)';
        const checkTime = found ? found.time : 'N/A';
        const name = `"${m.firstName} ${m.lastName}"`;
        const cat = `"${m.category || (isGuest ? 'Visitor / Guest' : 'Adult')}"`;
        const guardian = `"${(m.guardian || '').replace(/"/g, '""')}"`;
        const addr = `"${(m.address || '').replace(/"/g, '""')}"`;
        const role = `"${m.role || (isGuest ? 'Visitor / First Timer' : 'Member')}"`;

        csv += `"${currentSelectedService}",${name},${cat},"${m.phone || ''}",${guardian},${m.gender || ''},${addr},${role},"${status}","${checkTime}"\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `SFMI_Attendance_Report_${currentSelectedService.replace(/[^a-zA-Z0-9]/g, '_')}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    async function fetchLiveCounts() {
      try {
        const headers = await getAuthHeaders();

        const targetService = currentSelectedService || 'Sunday: Family & Friends Service';
        const selectedDate = document.getElementById('attDateSelect') ? document.getElementById('attDateSelect').value.trim() : '';

        // Query database history to guarantee complete synchronization with the Reports Ledger
        let histUrl = `${API_BASE}/attendance/history?limit=500`;
        if (selectedDate) {
          histUrl += `&startDate=${encodeURIComponent(selectedDate)}&endDate=${encodeURIComponent(selectedDate)}`;
        }

        let rawItems = [];
        try {
          const histRes = await fetch(histUrl, { headers });
          if (histRes.ok) {
            rawItems = await histRes.json();
          }
        } catch (hErr) {}

        // Always query service totals and individual service sessions for Services & Programs Setup
        try {
          const sRes = await fetch(`${API_BASE}/attendance/services`, { headers });
          if (sRes.ok) {
            const sList = await sRes.json();
            const programTotalCounts = {};
            const programSessionsMap = {};
            const programLatestCounts = {};

            if (Array.isArray(sList)) {
              sList.forEach(s => {
                const cName = canonicalServiceName(s.serviceType?.name || '');
                const exactName = s.serviceType?.name || '';
                const attCnt = (s._count && s._count.attendance) || 0;

                // Ignore 0-attendance test records created on non-scheduled weekdays for standard recurring services
                if (s.serviceType && s.serviceType.dayOfWeek !== null && s.serviceType.dayOfWeek !== undefined) {
                  const sUtcDay = s.serviceDate ? new Date(s.serviceDate).getUTCDay() : null;
                  if (attCnt === 0 && sUtcDay !== null && sUtcDay !== s.serviceType.dayOfWeek) {
                    return;
                  }
                }

                const dateRaw = s.dateIso || s.serviceDate || s.startsAt || s.createdAt;
                const dateIso = s.dateIso || getCalendarIsoDate(dateRaw);
                const dateLabel = s.dateLabel || formatCalendarDateLabel(dateRaw);

                const addSessionEntry = (key) => {
                  if (!key) return;
                  if (!programSessionsMap[key]) programSessionsMap[key] = [];
                  const existing = programSessionsMap[key].find(sess => sess.dateIso === dateIso);
                  if (existing) {
                    existing.count += attCnt;
                  } else {
                    programSessionsMap[key].push({
                      id: s.id,
                      dateIso,
                      dateLabel,
                      count: attCnt
                    });
                  }
                };

                if (cName) {
                  programTotalCounts[cName] = (programTotalCounts[cName] || 0) + attCnt;
                  addSessionEntry(cName);
                }
                if (exactName && exactName !== cName) {
                  programTotalCounts[exactName] = (programTotalCounts[exactName] || 0) + attCnt;
                  addSessionEntry(exactName);
                }
              });

              // Sort each program's sessions by date descending
              Object.keys(programSessionsMap).forEach(key => {
                programSessionsMap[key].sort((a, b) => (b.dateIso || '').localeCompare(a.dateIso || ''));
                if (programSessionsMap[key].length > 0) {
                  programLatestCounts[key] = programSessionsMap[key][0].count;
                }
              });
            }

            // Custom program attendance fallback
            const customCountResults = await Promise.all(customPrograms.map(async (program) => {
              try {
                const countRes = await fetch(`${API_BASE}/attendance/by-service-name?name=${encodeURIComponent(program.name)}`, { headers });
                if (!countRes.ok) return null;
                const countData = await countRes.json();
                return { name: program.name, count: Number(countData.count) || 0 };
              } catch (countErr) {
                return null;
              }
            }));
            customCountResults.forEach(result => {
              if (result) {
                programTotalCounts[result.name] = result.count;
                if (programLatestCounts[result.name] === undefined) {
                  programLatestCounts[result.name] = result.count;
                }
              }
            });

            window._programTotalCounts = programTotalCounts;
            window._programSessionsMap = programSessionsMap;
            window._programLatestCounts = programLatestCounts;
          }
        } catch (sErr) {}

          const selectedCustomProgram = customPrograms.find(program =>
            program.name.toLowerCase() === targetService.trim().toLowerCase()
          );
          if (selectedCustomProgram) {
            let apiUrl = `${API_BASE}/attendance/by-service-name?name=${encodeURIComponent(selectedCustomProgram.name)}`;
            if (selectedDate) apiUrl += `&date=${encodeURIComponent(selectedDate)}`;
            try {
              const liveRes = await fetch(apiUrl, { headers });
              if (liveRes.ok) {
                const live = await liveRes.json();
                rawItems = Array.isArray(live.recent) ? live.recent : [];
              }
            } catch (lErr) {}
          }

        // Fallback / supplement with live endpoint
          if ((!Array.isArray(rawItems) || rawItems.length === 0) && !selectedCustomProgram) {
          let apiUrl = `${API_BASE}/attendance/by-service-name?name=${encodeURIComponent(targetService)}`;
          if (selectedDate) {
            apiUrl += `&date=${encodeURIComponent(selectedDate)}`;
          }
          try {
            const liveRes = await fetch(apiUrl, { headers });
            if (liveRes.ok) {
              const live = await liveRes.json();
              if (live.recent && Array.isArray(live.recent)) {
                rawItems = live.recent;
              }
            }
          } catch (lErr) {}
        }

        if (Array.isArray(rawItems)) {
          let liveList = rawItems.map(item => {
            const fName = item.member?.firstName || '';
            const lName = item.member?.lastName || '';
            const rawDate = formatLocalDate(item.checkedInAt || Date.now());
            const svcName = item.service?.serviceType?.name || item.serviceName || targetService;
            const mRole = (item.member?.role || '').toLowerCase();
            const mCat = (item.member?.category || '').toLowerCase();
            const isGuest = Boolean(
              item.isGuest ||
              item.member?.isGuest ||
              mRole.includes('visitor') ||
              mRole.includes('first timer') ||
              mRole.includes('first-timer') ||
              mCat.includes('visitor') ||
              mCat.includes('guest') ||
              mCat.includes('first timer') ||
              mCat.includes('first-timer')
            );
            return {
              id: item.id || item.memberId,
              memberId: item.memberId || item.member?.id || null,
              phone: item.member?.phone || '',
              firstName: fName,
              lastName: lName,
              name: `${fName} ${lName}`.trim(),
              gender: item.member?.gender || '',
              address: item.member?.address || '',
              category: item.member?.category || (isGuest ? 'Visitor / Guest' : 'Adult'),
              role: item.member?.role || (isGuest ? 'Visitor / First Timer' : 'Member'),
              guardian: item.member?.guardian || '',
              time: new Date(item.checkedInAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              dateStr: rawDate,
              serviceName: svcName,
              method: item.method || 'KIOSK',
              isGuest: isGuest
            };
          });

          // Filter out any locally or recently deleted members
          liveList = liveList.filter(att => {
            if (att.memberId && deletedMemberIds.has(att.memberId)) return false;
            if (att.id && deletedMemberIds.has(att.id)) return false;
            if (att.phone && deletedMemberIds.has(att.phone.trim())) return false;
            if (att.name && deletedMemberIds.has(att.name.trim().toLowerCase())) return false;
            return true;
          });

          let modifiedDirectory = false;
          liveList.forEach(att => {
            const attPhoneNorm = normalizePhoneClient(att.phone);
            const attFullName = (att.name || '').trim().toLowerCase();
            const foundIndex = allMembers.findIndex(m => 
              (att.memberId && m.id && att.memberId === m.id) ||
              (att.phone && m.phone && (att.phone.trim() === m.phone.trim() || (attPhoneNorm && normalizePhoneClient(m.phone) === attPhoneNorm))) ||
              (attFullName && `${m.firstName} ${m.lastName}`.trim().toLowerCase() === attFullName)
            );

            if (foundIndex >= 0) {
              const memberRecord = allMembers[foundIndex];
              const isRegular = !isGuestMember(memberRecord);
              if (isRegular) {
                // Directory profile is a regular member: align attendance item
                att.isGuest = false;
                att.category = memberRecord.category || 'Adult';
                att.role = memberRecord.role || 'Member';
              }
            } else if (att.name) {
              const alreadyInDirectory = allMembers.some(m =>
                (att.memberId && m.id && att.memberId === m.id) ||
                (att.phone && m.phone && (att.phone.trim() === m.phone.trim() || (attPhoneNorm && normalizePhoneClient(m.phone) === attPhoneNorm))) ||
                (attFullName && `${m.firstName} ${m.lastName}`.trim().toLowerCase() === attFullName)
              );
              if (!alreadyInDirectory) {
                allMembers.unshift({
                  id: att.memberId || ('guest_' + Math.random().toString(36).substr(2, 9)),
                  firstName: att.firstName || 'Visitor',
                  lastName: att.lastName || 'Guest',
                  phone: att.phone || '',
                  gender: att.gender || 'Not specified',
                  address: att.address || '',
                  category: att.category || (att.isGuest ? 'Visitor / Guest' : 'Adult'),
                  role: att.role || (att.isGuest ? 'Visitor / First Timer' : 'Member'),
                  guardian: att.guardian || '',
                  isGuest: Boolean(att.isGuest)
                });
                modifiedDirectory = true;
              }
            }
          });

          // Pre-initialize standard services
          if (!serviceAttendanceMap['Sunday: Family & Friends Service']) serviceAttendanceMap['Sunday: Family & Friends Service'] = [];
          if (!serviceAttendanceMap['Wednesday: Time with the Lord']) serviceAttendanceMap['Wednesday: Time with the Lord'] = [];
          if (!serviceAttendanceMap['Friday: Prophetic Healing & Deliverance']) serviceAttendanceMap['Friday: Prophetic Healing & Deliverance'] = [];

          // Group liveList into canonical services and exact service keys
          const grouped = {};
          liveList.forEach(att => {
            const canon = canonicalServiceName(att.serviceName);
            if (!grouped[canon]) grouped[canon] = [];
            grouped[canon].push(att);

            if (att.serviceName && att.serviceName !== canon) {
              if (!grouped[att.serviceName]) grouped[att.serviceName] = [];
              grouped[att.serviceName].push(att);
            }
          });

          Object.keys(grouped).forEach(k => {
            serviceAttendanceMap[k] = grouped[k];
            if (selectedDate) {
              serviceAttendanceMap[`${k}_${selectedDate}`] = grouped[k];
            }
          });

          // Keep selected targetService mapped
          const canonTarget = canonicalServiceName(targetService);
          if (!serviceAttendanceMap[targetService] && serviceAttendanceMap[canonTarget]) {
            serviceAttendanceMap[targetService] = serviceAttendanceMap[canonTarget];
          }

          serviceAttendanceMap['ALL'] = liveList;
          if (selectedDate) {
            serviceAttendanceMap[`ALL_${selectedDate}`] = liveList;
          }

          renderAttendanceAndDemographics();
          if (modifiedDirectory) {
            updateDirectoryCounts();
            filterMembersTable();
          }
          renderProgramsManager();
          const secVis = document.getElementById('secVisitors');
          if (secVis && secVis.style.display !== 'none') {
            renderVisitorsSection();
          }
        }
      } catch (e) {
        console.error('fetchLiveCounts error:', e);
      }
    }

    let currentDirSubTab = 'MEMBERS'; // 'MEMBERS', 'GUESTS', 'ALL'
    let currentDirGenderFilter = 'ALL'; // 'ALL', 'MALE', 'FEMALE'

    function isGuestMember(m) {
      if (!m) return false;
      const cat = (m.category || '').toLowerCase();
      const role = (m.role || '').toLowerCase();
      const isVisitorCat = cat.includes('visitor') || cat.includes('guest');
      const isVisitorRole = role.includes('visitor') || role.includes('guest') || role.includes('first timer') || role.includes('first-timer');

      // If category is an explicit church member category and role is not visitor, definitely not a guest
      if (!isVisitorCat && !isVisitorRole && (['adult', 'child', 'youth'].includes(cat) || m.isGuest === false)) {
        return false;
      }

      if (m.isGuest === true) return true;
      return isVisitorCat || isVisitorRole;
    }

    function updateDirectoryCounts() {
      const guests = allMembers.filter(isGuestMember);
      const regularMembers = allMembers.filter(m => !isGuestMember(m));
      
      const elMembers = document.getElementById('dirCountMembers');
      const elGuests = document.getElementById('dirCountGuests');
      const elAll = document.getElementById('dirCountAll');

      if (elMembers) elMembers.innerText = regularMembers.length;
      if (elGuests) elGuests.innerText = guests.length;
      if (elAll) elAll.innerText = allMembers.length;

      // Gender counts based on currently selected member directory sub-tab
      let baseList = allMembers;
      if (currentDirSubTab === 'MEMBERS') {
        baseList = regularMembers;
      } else if (currentDirSubTab === 'GUESTS') {
        baseList = guests;
      }

      const elGAll = document.getElementById('dirGenderCountAll');
      const elGMale = document.getElementById('dirGenderCountMale');
      const elGFemale = document.getElementById('dirGenderCountFemale');

      if (elGAll) elGAll.innerText = baseList.length;
      if (elGMale) elGMale.innerText = baseList.filter(m => (m.gender || '').toLowerCase().startsWith('m')).length;
      if (elGFemale) elGFemale.innerText = baseList.filter(m => (m.gender || '').toLowerCase().startsWith('f')).length;
    }

    function setMemberGenderFilter(gender) {
      currentDirGenderFilter = gender;

      const btnAll = document.getElementById('btnGenderFilterAll');
      const btnMale = document.getElementById('btnGenderFilterMale');
      const btnFemale = document.getElementById('btnGenderFilterFemale');

      if (btnAll) btnAll.classList.toggle('active', gender === 'ALL');
      if (btnMale) btnMale.classList.toggle('active', gender === 'MALE');
      if (btnFemale) btnFemale.classList.toggle('active', gender === 'FEMALE');

      filterMembersTable();
    }

    function setMemberDirectorySubTab(tab) {
      currentDirSubTab = tab;
      
      const btnMem = document.getElementById('btnDirFilterMembers');
      const btnGst = document.getElementById('btnDirFilterGuests');
      const btnAll = document.getElementById('btnDirFilterAll');

      if (btnMem) {
        btnMem.style.background = tab === 'MEMBERS' ? 'var(--ink)' : '#fafbfa';
        btnMem.style.color = tab === 'MEMBERS' ? 'white' : 'var(--ink)';
        btnMem.style.border = tab === 'MEMBERS' ? 'none' : '1px solid var(--line)';
      }
      if (btnGst) {
        btnGst.style.background = tab === 'GUESTS' ? '#d97706' : '#fffbeb';
        btnGst.style.color = tab === 'GUESTS' ? 'white' : '#b45309';
        btnGst.style.border = tab === 'GUESTS' ? 'none' : '1.5px solid #fde68a';
      }
      if (btnAll) {
        btnAll.style.background = tab === 'ALL' ? 'var(--ink)' : '#fafbfa';
        btnAll.style.color = tab === 'ALL' ? 'white' : 'var(--muted)';
        btnAll.style.border = tab === 'ALL' ? 'none' : '1px solid var(--line)';
      }

      filterMembersTable();
    }

    /* Member Directory (With Children, Address, Gender & DOB) */
    async function loadSavedMembers() {
      try {
        const token = await getAdminAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        let res = await fetch(`${API_BASE}/members`, { headers });
        if (!res.ok && res.status === 401) {
          const freshToken = await getAdminAuthToken();
          if (freshToken) {
            res = await fetch(`${API_BASE}/members`, { headers: { 'Authorization': `Bearer ${freshToken}` } });
          }
        }
        if (res.ok) {
          const data = await res.json();
          const rawMembers = Array.isArray(data) ? data : (Array.isArray(data.members) ? data.members : []);
          allMembers = rawMembers.map(m => {
            const rawDob = m.dateOfBirth ? (m.dateOfBirth.split('T')[0] || '') : (m.dob || '');
            const formattedDob = rawDob ? formatDisplayDate(rawDob) : '';
            return {
              ...m,
              dob: formattedDob || m.dob || '',
              rawDob: rawDob || m.rawDob || null
            };
          });
          updateDirectoryCounts();
          filterMembersTable();
          renderAttendanceAndDemographics();
          return;
        }
      } catch(e) {}

      allMembers = [];
      updateDirectoryCounts();
      filterMembersTable();
      renderAttendanceAndDemographics();
    }

    function saveMembersToStorage() {
      // Direct database sync enabled; localStorage mock cache removed
      updateDirectoryCounts();
    }

    function renderMembersTable(list = null) {
      if (list === null) {
        filterMembersTable();
        return;
      }

      const tbody = document.getElementById('membersTableBody');
      const mobCards = document.getElementById('membersMobileCards');

      const buildMemberBadges = (m) => {
        const isMale = (m.gender||'').toLowerCase().startsWith('m');
        const isFemale = (m.gender||'').toLowerCase().startsWith('f');
        const genderBadge = isMale ? `<span class="badge-gender-male">Male</span>` : isFemale ? `<span class="badge-gender-female">Female</span>` : `—`;
        const isChild = m.category==='Child'||(m.role&&m.role.toLowerCase().includes('child'));
        const isGuest = isGuestMember(m);

        let catBadge = `<span class="badge-adult">Adult</span>`;
        if (isGuest) {
          catBadge = `<span class="badge-guest"><i class="fa-solid fa-star" style="color:#d97706; margin-right:4px;"></i> New Visitor / Guest</span>`;
        } else if (isChild) {
          catBadge = `<span class="badge-child"><i class="fa-solid fa-children" style="margin-right:4px;"></i> Child</span>`;
        } else if (m.category==='Youth') {
          catBadge = `<span class="badge-check" style="background:#e0f2fe;color:#0369a1;">Youth</span>`;
        }

        const roleDisplay = isGuest 
          ? `<span style="background:#fffbeb; color:#b45309; font-weight:800; padding:2px 8px; border-radius:4px; border:1px solid #fde68a;"><i class="fa-solid fa-handshake" style="margin-right:4px;"></i> First Timer</span>`
          : `<span class="badge-check">${m.role||'Member'}</span>`;

        const phoneDisplay = isChild&&m.guardian ? `<strong style="color:var(--accent);">${escapeHtml(m.phone)||'—'}</strong><div style="font-size:11px;color:var(--muted);"><i class="fa-solid fa-user-shield" style="margin-right:3px;"></i> ${escapeHtml(m.guardian)}</div>` : `<strong style="color:var(--accent);">${escapeHtml(m.phone)||'—'}</strong>`;
        return {genderBadge, catBadge, phoneDisplay, roleDisplay, isChild, isGuest};
      };

      if (list.length === 0) {
        const emptyMsg = currentDirSubTab === 'GUESTS' 
          ? 'No first-timers or new visitors registered yet.'
          : (currentDirSubTab === 'MEMBERS' ? 'No permanent church members found matching this search.' : 'No records found in directory.');
        if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:30px;font-size:13.5px;"><i class="fa-solid fa-circle-info" style="margin-right:6px;"></i> ${emptyMsg}</td></tr>`;
        if (mobCards) mobCards.innerHTML = `<div style="text-align:center;color:var(--muted);padding:28px 0;font-size:13.5px;"><i class="fa-solid fa-circle-info" style="margin-right:6px;"></i> ${emptyMsg}</div>`;
        return;
      }

      // Desktop table
      if (tbody) {
        tbody.innerHTML = list.map((m, i) => {
          const {genderBadge, catBadge, phoneDisplay, roleDisplay} = buildMemberBadges(m);
          const initials = `${(m.firstName || 'M')[0] || ''}${(m.lastName || '')[0] || ''}`.toUpperCase();
          const avatarMini = m.photoUrl
            ? `<img src="${escapeHtml(m.photoUrl)}" alt="" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:1.5px solid var(--accent);flex-shrink:0;" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='inline-flex';" /><span style="display:none;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials}</span>`
            : `<span style="display:inline-flex;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials}</span>`;

          return `<tr>
            <td>${i+1}</td>
            <td>
              <div style="display:flex;align-items:center;gap:10px;">
                ${avatarMini}
                <span><strong>${escapeHtml(m.firstName)} ${escapeHtml(m.lastName)}</strong></span>
              </div>
            </td>
            <td>${catBadge}</td><td>${phoneDisplay}</td><td>${genderBadge}</td>
            <td>${m.address?`<span><i class="fa-solid fa-location-dot" style="margin-right:4px; color:var(--muted);"></i> ${escapeHtml(m.address)}</span>`:'—'}</td>
            <td>${m.dob?`<span class="badge-dob"><i class="fa-solid fa-cake-candles" style="margin-right:4px;"></i> ${escapeHtml(m.dob)}</span>`:'—'}</td>
            <td>${roleDisplay}</td>
            <td><div style="display:flex;gap:6px;">
              <button class="btn-main" style="padding:4px 10px;font-size:12px;background:#c89b55;color:#111;" onclick="openEditMemberModal('${m.id}')"><i class="fas fa-edit"></i> Edit</button>
              <button class="btn-main" style="padding:4px 10px;font-size:12px;background:#c5221f;" onclick="deleteMember('${m.id}')"><i class="fas fa-trash-alt"></i> Remove</button>
            </div></td>
          </tr>`;
        }).join('');
      }

      // Mobile cards
      if (mobCards) {
        mobCards.innerHTML = list.length === 0
          ? `<div style="text-align:center;color:var(--muted);padding:28px 0;">No members yet.</div>`
          : list.map((m, i) => {
            const {genderBadge, catBadge} = buildMemberBadges(m);
            const initials = `${(m.firstName || 'M')[0] || ''}${(m.lastName || '')[0] || ''}`.toUpperCase();
            const avatarMini = m.photoUrl
              ? `<img src="${escapeHtml(m.photoUrl)}" alt="" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:1.5px solid var(--accent);flex-shrink:0;" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='inline-flex';" /><span style="display:none;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials}</span>`
              : `<span style="display:inline-flex;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials}</span>`;

            return `
              <div class="mob-card">
                <div class="mob-card-header" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                  <div style="display:flex;align-items:center;gap:10px;">
                    ${avatarMini}
                    <div class="mob-card-name">${escapeHtml(m.firstName)} ${escapeHtml(m.lastName)}</div>
                  </div>
                  ${catBadge}
                </div>
                <div class="mob-card-meta">
                  <div class="mob-card-row"><span>Gender</span><strong>${genderBadge}</strong></div>
                  <div class="mob-card-row"><span>Phone</span><strong>${escapeHtml(m.phone)||'—'}</strong></div>
                  ${m.guardian?`<div class="mob-card-row"><span>Guardian</span><strong>${escapeHtml(m.guardian)}</strong></div>`:''}
                  <div class="mob-card-row"><span>Location</span><strong>${escapeHtml(m.address)||'—'}</strong></div>
                  <div class="mob-card-row"><span>Date of Birth</span><strong>${escapeHtml(m.dob)||'—'}</strong></div>
                  <div class="mob-card-row"><span>Role</span><strong>${m.role||'Member'}</strong></div>
                </div>
                <div class="mob-card-actions">
                  <button class="btn-main" style="background:#c89b55;color:#111;" onclick="openEditMemberModal('${m.id}')"><i class="fas fa-edit"></i> Edit</button>
                  <button class="btn-main" style="background:#c5221f;" onclick="deleteMember('${m.id}')"><i class="fas fa-trash-alt"></i> Remove</button>
                </div>
              </div>`;
          }).join('');
      }

      syncMembersViewMode();
      renderBirthdayRemindersWidget(false);
    }

    function syncMembersViewMode() {
      const isMobile = window.innerWidth <= 700;
      const tbl = document.querySelector('#secMembers .table-responsive');
      const cards = document.getElementById('membersMobileCards');
      if (tbl) tbl.style.display = isMobile ? 'none' : 'block';
      if (cards) cards.style.display = isMobile ? 'block' : 'none';
    }
    window.addEventListener('resize', syncMembersViewMode);

    /* ── MEMBER BIRTHDAY REMINDERS SYSTEM ── */
    function renderBirthdayRemindersWidget(notifyToast = false) {
      const container = document.getElementById('birthdayRemindersList');
      const badge = document.getElementById('bdayBadgeCount');
      if (!container) return;

      const birthdays = getUpcomingBirthdays(30);
      if (badge) badge.innerText = `${birthdays.length} Upcoming`;

      if (birthdays.length === 0) {
        container.innerHTML = `
          <div style="width:100%; text-align:center; padding: 18px; color: #a3b899; font-size: 13.5px; background: rgba(255,255,255,0.05); border-radius: 8px;">
            <i class="fas fa-calendar-check" style="margin-right: 6px;"></i> No registered member birthdays in the next 30 days.
          </div>`;
        return;
      }

      let todayCount = 0;
      let toastNoticeText = [];

      container.innerHTML = birthdays.map(b => {
        const m = b.member;
        if (b.isToday) {
          todayCount++;
          toastNoticeText.push(`${m.firstName} ${m.lastName}`);
          return `
            <div style="flex: 1; min-width: 260px; background: linear-gradient(135deg, #c89b55 0%, #a87d3b 100%); color: #111; padding: 14px 16px; border-radius: 8px; border: 1px solid #fef08a; box-shadow: 0 4px 12px rgba(200,155,85,0.3);">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div>
                  <span style="font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; background: #111; color: #c89b55; padding: 2px 8px; border-radius: 4px;"><i class="fa-solid fa-cake-candles" style="margin-right: 4px;"></i> TODAY!</span>
                  <div style="font-size: 16px; font-weight: 800; margin-top: 6px;">${m.firstName} ${m.lastName}</div>
                  <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">Turning <strong>${b.age} years old</strong></div>
                </div>
                <i class="fa-solid fa-cake-candles" style="font-size: 24px; color: #111;"></i>
              </div>
              <div style="margin-top: 10px; font-size: 12px; font-weight: 700; border-top: 1px dashed rgba(0,0,0,0.2); padding-top: 8px; display: flex; justify-content: space-between; align-items: center;">
                <span><i class="fa-solid fa-phone" style="margin-right: 4px;"></i> ${m.phone || 'No Phone'}</span>
                <span style="background: rgba(0,0,0,0.15); padding: 3px 8px; border-radius: 4px;">Wish Happy Birthday!</span>
              </div>
            </div>`;
        } else {
          const dayText = b.diffDays === 1 ? 'Tomorrow' : `In ${b.diffDays} days (${b.displayDate})`;
          return `
            <div style="flex: 1; min-width: 230px; background: rgba(255,255,255,0.07); color: white; padding: 12px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12);">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div>
                  <div style="font-size: 14px; font-weight: 800;">${m.firstName} ${m.lastName}</div>
                  <div style="font-size: 11.5px; color: #c4d0ca; margin-top: 2px;">${b.displayDate} · Turning ${b.age}</div>
                </div>
                <span style="font-size: 11px; font-weight: 700; background: rgba(200,155,85,0.25); color: var(--accent); padding: 3px 8px; border-radius: 4px;">${dayText}</span>
              </div>
              <div style="margin-top: 8px; font-size: 11.5px; color: #a3b899; display: flex; align-items: center; gap: 6px;">
                <i class="fa-solid fa-user-tag"></i> ${m.category || 'Member'} ${m.phone ? `· <i class="fa-solid fa-phone" style="font-size: 10px; margin-left: 2px;"></i> ${m.phone}` : ''}
              </div>
            </div>`;
        }
      }).join('');

      if ((notifyToast || todayCount > 0) && toastNoticeText.length > 0) {
        showToast(`🎉 Today's Birthday(s): <strong>${toastNoticeText.join(', ')}</strong>! Send wishes!`, 'success', 'Birthday Celebration!');
      }
    }

    function getUpcomingBirthdays(daysAhead = 30) {
      const today = new Date();
      const currentMonth = today.getMonth();
      const currentDay = today.getDate();
      const results = [];

      allMembers.forEach(m => {
        let dateObj = null;
        if (m.rawDob && /^\d{4}-\d{2}-\d{2}$/.test(m.rawDob)) {
          const [y, mth, d] = m.rawDob.split('-').map(Number);
          dateObj = new Date(y, mth - 1, d);
        } else if (m.dob) {
          const parsed = Date.parse(m.dob);
          if (!isNaN(parsed)) dateObj = new Date(parsed);
        }

        if (!dateObj) return;

        const bMonth = dateObj.getMonth();
        const bDay = dateObj.getDate();

        let nextBday = new Date(today.getFullYear(), bMonth, bDay);
        if (nextBday < new Date(today.getFullYear(), currentMonth, currentDay)) {
          nextBday.setFullYear(today.getFullYear() + 1);
        }

        const diffTime = nextBday - new Date(today.getFullYear(), currentMonth, currentDay);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        const isToday = (bMonth === currentMonth && bDay === currentDay);

        if (isToday || (diffDays >= 0 && diffDays <= daysAhead)) {
          const age = today.getFullYear() - dateObj.getFullYear();
          results.push({
            member: m,
            isToday,
            diffDays,
            bMonth,
            bDay,
            age,
            displayDate: nextBday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
          });
        }
      });

      results.sort((a, b) => a.diffDays - b.diffDays);
      return results;
    }

    function filterMembersTable() {
      const q = (document.getElementById('memberSearchInput')?.value || '').toLowerCase().trim();
      
      let baseList = allMembers;
      if (currentDirSubTab === 'MEMBERS') {
        baseList = allMembers.filter(m => !isGuestMember(m));
      } else if (currentDirSubTab === 'GUESTS') {
        baseList = allMembers.filter(isGuestMember);
      }

      // Filter by Gender
      if (currentDirGenderFilter === 'MALE') {
        baseList = baseList.filter(m => (m.gender || '').toLowerCase().startsWith('m'));
      } else if (currentDirGenderFilter === 'FEMALE') {
        baseList = baseList.filter(m => (m.gender || '').toLowerCase().startsWith('f'));
      }

      const filtered = baseList.filter(m => 
        !q ||
        `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) || 
        (m.phone && m.phone.includes(q)) ||
        (m.guardian && m.guardian.toLowerCase().includes(q)) ||
        (m.address && m.address.toLowerCase().includes(q)) ||
        (m.category && m.category.toLowerCase().includes(q)) ||
        (m.gender && m.gender.toLowerCase().includes(q)) ||
        (m.dob && m.dob.toLowerCase().includes(q)) ||
        (m.role && m.role.toLowerCase().includes(q))
      );

      // Sort Alphabetically A-Z by First Name then Last Name
      filtered.sort((a, b) => {
        const nameA = `${a.firstName || ''} ${a.lastName || ''}`.trim().toLowerCase();
        const nameB = `${b.firstName || ''} ${b.lastName || ''}`.trim().toLowerCase();
        return nameA.localeCompare(nameB);
      });

      updateDirectoryCounts();
      renderMembersTable(filtered);
    }

    function deleteMember(id) {
      showConfirmModal(
        'Remove Member',
        'Are you sure you want to remove this member from the directory?',
        async () => {
          let token = await getAdminAuthToken();

          if (id && !id.startsWith('mem_') && !id.startsWith('guest_')) {
            try {
              let delRes = await fetch(`${API_BASE}/members/${id}`, {
                method: 'DELETE',
                headers: {
                  ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                }
              });
              if (!delRes.ok) {
                token = await getAdminAuthToken();
                if (token) {
                  await fetch(`${API_BASE}/members/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                  });
                }
              }
            } catch (err) {
              console.error('Error deleting member from backend:', err);
            }
          }

          const deletedObj = allMembers.find(m => m.id === id);
          deletedMemberIds.add(id);
          if (deletedObj && deletedObj.phone) deletedMemberIds.add(deletedObj.phone.trim());
          if (deletedObj && deletedObj.firstName) deletedMemberIds.add(`${deletedObj.firstName} ${deletedObj.lastName}`.trim().toLowerCase());
          allMembers = allMembers.filter(m => m.id !== id);
          saveMembersToStorage();
          updateDirectoryCounts();
          filterMembersTable();
          renderAttendanceAndDemographics();
          showToast('Member removed from cloud database.', 'info', 'Member Removed');
        },
        'fas fa-user-minus',
        'Remove Member',
        '#c5221f'
      );
    }

    function toggleAddGuardianField(val) {
      const isChild = val === 'Child' || (typeof val === 'string' && val.toLowerCase().includes('child'));
      const wrap = document.getElementById('wrapAddGuardian');
      if (wrap) wrap.style.display = isChild ? 'block' : 'none';
      const lbl = document.getElementById('lblAddPhone');
      if (lbl) lbl.innerText = isChild ? 'Parent / Contact Phone *' : 'Phone Number *';
      if (isChild) {
        const roleEl = document.getElementById('newMemRole');
        if (roleEl && !roleEl.value.includes('Visitor')) {
          roleEl.value = 'Child / Sunday School';
        }
      }
    }

    function toggleEditGuardianField(val) {
      const isChild = val === 'Child' || (typeof val === 'string' && val.toLowerCase().includes('child'));
      const wrap = document.getElementById('wrapEditGuardian');
      if (wrap) wrap.style.display = isChild ? 'block' : 'none';
      const lbl = document.getElementById('lblEditPhone');
      if (lbl) lbl.innerText = isChild ? 'Parent / Contact Phone *' : 'Phone Number *';
    }

    function handleEditCategoryChange(val) {
      toggleEditGuardianField(val);
      const wasGuest = document.getElementById('editMemOriginalIsGuest')?.value === 'true';
      const roleSelect = document.getElementById('editMemRole');
      const banner = document.getElementById('editMemStatusBanner');
      const titleEl = document.getElementById('editMemModalTitle');
      const subTitleEl = document.getElementById('editMemModalSubtitle');

      const isMemberCat = ['Adult', 'Child', 'Youth'].includes(val);
      const isChild = val === 'Child' || (typeof val === 'string' && val.toLowerCase().includes('child'));
      const isYouth = val === 'Youth' || (typeof val === 'string' && val.toLowerCase().includes('youth'));

      if (isMemberCat) {
        // If current role is visitor or empty, auto-switch to corresponding member role
        if (roleSelect && (!roleSelect.value || roleSelect.value.includes('Visitor') || roleSelect.value.includes('First Timer'))) {
          if (isChild) roleSelect.value = 'Child / Sunday School';
          else if (isYouth) roleSelect.value = 'Youth / Teen';
          else roleSelect.value = 'Member';
        }

        if (wasGuest) {
          if (titleEl) {
            titleEl.innerHTML = `<i class="fa-solid fa-user-check" style="color: var(--emerald); margin-right: 6px;"></i> Convert Visitor to Full Church Member`;
          }
          if (subTitleEl) {
            subTitleEl.innerText = `Promoting visitor to official church member. They will appear in the permanent Member Directory.`;
          }
          if (banner) {
            banner.style.display = 'flex';
            banner.style.alignItems = 'center';
            banner.style.gap = '10px';
            banner.style.background = '#ecfdf5';
            banner.style.border = '1px solid #10b981';
            banner.style.color = '#065f46';
            banner.innerHTML = `<i class="fa-solid fa-circle-check" style="font-size: 16px; color: #10b981; flex-shrink: 0;"></i><div><strong>Ready to convert to Church Member:</strong> Category is set to <strong>${escapeHtml(val)} Member</strong>. Saving will move this profile to the permanent Member Directory.</div>`;
          }
        } else {
          if (banner) banner.style.display = 'none';
          if (titleEl) titleEl.innerText = 'Edit Member Profile';
          if (subTitleEl) subTitleEl.innerText = 'Update personal details, category, Guardian, Date of Birth (DOB), or address.';
        }
      } else {
        // Visitor category selected
        if (roleSelect && (roleSelect.value === 'Member' || !roleSelect.value.includes('Visitor'))) {
          roleSelect.value = 'Visitor / First Timer';
        }
        if (titleEl) {
          titleEl.innerHTML = `<i class="fa-solid fa-user-clock" style="color: var(--gold); margin-right: 6px;"></i> Edit Visitor / Guest Profile`;
        }
        if (subTitleEl) {
          subTitleEl.innerText = `Update visitor details, contact information, or select a Church Member category below to promote them.`;
        }
        if (banner) {
          banner.style.display = 'flex';
          banner.style.alignItems = 'center';
          banner.style.gap = '10px';
          banner.style.background = '#fffbeb';
          banner.style.border = '1px solid #fde68a';
          banner.style.color = '#92400e';
          banner.innerHTML = `<i class="fa-solid fa-circle-info" style="font-size: 16px; color: #d97706; flex-shrink: 0;"></i><div>Currently registered as a <strong>Visitor / First Timer</strong>. To promote them to a full church member, select an Adult, Child, or Youth category below.</div>`;
        }
      }
    }

    function handleEditRoleChange(val) {
      const catSelect = document.getElementById('editMemCategory');
      if (!catSelect) return;
      const currentCat = catSelect.value;
      const isVisitorRole = val.includes('Visitor') || val.includes('First Timer');

      if (isVisitorRole) {
        if (currentCat === 'Adult' || currentCat === 'Child' || currentCat === 'Youth') {
          if (currentCat === 'Child') catSelect.value = 'Visitor (Child)';
          else if (currentCat === 'Youth') catSelect.value = 'Visitor (Youth)';
          else catSelect.value = 'Visitor / Guest';
          handleEditCategoryChange(catSelect.value);
        }
      } else {
        // Member role selected! If category was visitor, switch category to corresponding member category
        if (currentCat.includes('Visitor') || currentCat.includes('Guest')) {
          if (currentCat.includes('Child') || val.includes('Child')) catSelect.value = 'Child';
          else if (currentCat.includes('Youth') || val.includes('Youth')) catSelect.value = 'Youth';
          else catSelect.value = 'Adult';
          handleEditCategoryChange(catSelect.value);
        }
      }
    }

    async function convertHeicToJpeg(file) {
      // 1. Native browser decoding (Safari iOS/macOS decodes HEIC natively)
      if (typeof createImageBitmap === 'function') {
        try {
          const bmp = await createImageBitmap(file);
          if (bmp && bmp.width > 0 && bmp.height > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            const nativeBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
            if (nativeBlob) return nativeBlob;
          }
        } catch (nativeErr) {}
      }

      // 2. Modern HeicTo library (uses modern libheif WebAssembly)
      if (typeof HeicTo === 'function') {
        try {
          const resBlob = await HeicTo({ blob: file, type: 'image/jpeg', quality: 0.85 });
          if (resBlob) return resBlob;
        } catch (heicToErr) {
          console.warn('HeicTo conversion attempt:', heicToErr);
        }
      }

      // 3. Fallback to heic2any
      if (typeof heic2any === 'function') {
        try {
          const res = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
          const resBlob = Array.isArray(res) ? res[0] : res;
          if (resBlob) return resBlob;
        } catch (h2aErr) {
          console.warn('heic2any conversion attempt:', h2aErr);
        }
      }

      return null;
    }

    async function handleMemberPhotoUpload(e, mode) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const fName = (file.name || '').toLowerCase();
      let isHeic = fName.endsWith('.heic') || fName.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
      if (!isHeic && typeof HeicTo !== 'undefined' && typeof HeicTo.isHeic === 'function') {
        try {
          isHeic = await HeicTo.isHeic(file);
        } catch (err) {}
      }

      const isStandardImg = file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|bmp|svg)$/i.test(fName);

      if (!isHeic && !isStandardImg) {
        showToast('Please select a valid image file (JPG, PNG, WebP, HEIC).', 'warning', 'Invalid File');
        return;
      }

      let fileOrBlob = file;
      if (isHeic) {
        showToast('Converting iPhone HEIC photo, please wait...', 'info', 'HEIC Conversion');
        const converted = await convertHeicToJpeg(file);
        if (converted) {
          fileOrBlob = converted;
        } else {
          showToast('Could not convert this HEIC file automatically. Please take or select a standard JPG/PNG photo.', 'error', 'HEIC Conversion Failed');
          return;
        }
      }

      const reader = new FileReader();
      reader.onload = function(evt) {
        const rawData = evt.target.result;
        const img = new Image();
        img.onload = function() {
          const maxDim = 400;
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const compressedData = canvas.toDataURL('image/jpeg', 0.85);

          const urlInput = document.getElementById(mode === 'new' ? 'newMemPhotoUrl' : 'editMemPhotoUrl');
          const preview = document.getElementById(mode === 'new' ? 'newMemPhotoPreview' : 'editMemPhotoPreview');
          if (urlInput) urlInput.value = compressedData;
          if (preview) {
            preview.innerHTML = `
              <div style="position: relative; display: inline-block;">
                <img src="${compressedData}" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; border: 2.5px solid var(--accent); box-shadow: 0 2px 8px rgba(0,0,0,0.15);" />
                <button type="button" onclick="clearMemberPhoto('${mode}')" style="position: absolute; top: -4px; right: -4px; background: #c5221f; color: white; border: none; border-radius: 50%; width: 22px; height: 22px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center;" title="Remove Photo">✕</button>
              </div>
            `;
          }
        };
        img.onerror = function() {
          showToast('Failed to load image preview. Please try another file.', 'error', 'Image Error');
        };
        img.src = rawData;
      };
      reader.onerror = function() {
        showToast('Error reading image file.', 'error', 'File Read Error');
      };
      reader.readAsDataURL(fileOrBlob);
    }

    function clearMemberPhoto(mode) {
      const fileInput = document.getElementById(mode === 'new' ? 'newMemPhotoFile' : 'editMemPhotoFile');
      const urlInput = document.getElementById(mode === 'new' ? 'newMemPhotoUrl' : 'editMemPhotoUrl');
      const preview = document.getElementById(mode === 'new' ? 'newMemPhotoPreview' : 'editMemPhotoPreview');
      if (fileInput) fileInput.value = '';
      if (urlInput) urlInput.value = '';
      if (preview) {
        preview.innerHTML = `
          <div onclick="document.getElementById('${mode === 'new' ? 'newMemPhotoFile' : 'editMemPhotoFile'}').click()" style="width: 64px; height: 64px; border-radius: 50%; border: 2px dashed #94a3b8; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; color: var(--muted); background: white; transition: all 0.2s;" title="Click to upload photo">
            <i class="fas fa-camera" style="font-size: 18px; color: var(--accent);"></i>
            <span style="font-size: 9px; font-weight: 700; margin-top: 2px;">Upload</span>
          </div>
        `;
      }
    }

    function openAddMemberModal() {
      clearMemberPhoto('new');
      document.getElementById('addMemberModal').classList.add('active');
      document.getElementById('newMemFirst').focus();
    }

    function closeAddMemberModal() {
      document.getElementById('addMemberModal').classList.remove('active');
    }

    function convertToInputDateFormat(dateStr, rawDob) {
      if (rawDob && /^\d{4}-\d{2}-\d{2}$/.test(rawDob)) return rawDob;
      if (!dateStr) return '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().split('T')[0];
      }
      return '';
    }

    function openEditMemberModal(id) {
      let member = allMembers.find(m => m.id === id);
      if (!member) {
        // Fallback check in processedVisitorsList
        const vis = (processedVisitorsList || []).find(v => v.id === id || v.memberId === id);
        if (vis) {
          member = {
            id: vis.memberId || vis.id,
            firstName: vis.firstName || (vis.name ? vis.name.split(' ')[0] : 'Visitor'),
            lastName: vis.lastName || (vis.name ? vis.name.split(' ').slice(1).join(' ') : 'Guest'),
            category: vis.category || 'Visitor / Guest',
            guardian: vis.guardian || '',
            phone: vis.phone !== '—' ? vis.phone : '',
            gender: vis.gender !== 'Not specified' ? vis.gender : 'Male',
            address: vis.address !== '—' ? vis.address : '',
            dob: '',
            rawDob: null,
            role: vis.role || 'Visitor / First Timer',
            email: '',
            photoUrl: vis.photoUrl || null,
            isGuest: true
          };
        }
      }
      if (!member) return;

      const isGuest = isGuestMember(member);

      const origIsGuestInput = document.getElementById('editMemOriginalIsGuest');
      if (origIsGuestInput) origIsGuestInput.value = isGuest ? 'true' : 'false';

      document.getElementById('editMemId').value = member.id;
      document.getElementById('editMemFirst').value = member.firstName || '';
      document.getElementById('editMemLast').value = member.lastName || '';

      // Determine correct Category select value
      let selectedCat = 'Adult';
      const rawCat = (member.category || '').trim();
      const rawRole = (member.role || '').trim();
      const isChild = rawCat.toLowerCase().includes('child') || rawRole.toLowerCase().includes('child');
      const isYouth = rawCat.toLowerCase().includes('youth') || rawRole.toLowerCase().includes('youth');

      if (isGuest) {
        if (isChild) {
          selectedCat = 'Visitor (Child)';
        } else if (isYouth) {
          selectedCat = 'Visitor (Youth)';
        } else {
          selectedCat = 'Visitor / Guest';
        }
      } else {
        if (isChild) {
          selectedCat = 'Child';
        } else if (isYouth) {
          selectedCat = 'Youth';
        } else {
          selectedCat = 'Adult';
        }
      }

      const catSelect = document.getElementById('editMemCategory');
      if (catSelect) catSelect.value = selectedCat;

      document.getElementById('editMemGuardian').value = member.guardian || '';
      document.getElementById('editMemPhone').value = member.phone || '';
      document.getElementById('editMemGender').value = member.gender || 'Male';
      document.getElementById('editMemAddress').value = member.address || '';
      document.getElementById('editMemDob').value = convertToInputDateFormat(member.dob, member.rawDob);

      // Determine Role select value
      let selectedRole = 'Member';
      if (isGuest) {
        selectedRole = 'Visitor / First Timer';
      } else if (isChild) {
        selectedRole = 'Child / Sunday School';
      } else if (member.role) {
        selectedRole = member.role;
      }
      const roleSelect = document.getElementById('editMemRole');
      if (roleSelect) roleSelect.value = selectedRole;

      document.getElementById('editMemEmail').value = member.email || '';

      const editPhotoUrl = member.photoUrl || '';
      document.getElementById('editMemPhotoUrl').value = editPhotoUrl;
      const editPreview = document.getElementById('editMemPhotoPreview');
      if (editPreview) {
        if (editPhotoUrl) {
          editPreview.innerHTML = `
            <div style="position: relative; display: inline-block;">
              <img src="${escapeHtml(editPhotoUrl)}" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; border: 2.5px solid var(--accent); box-shadow: 0 2px 8px rgba(0,0,0,0.15);" />
              <button type="button" onclick="clearMemberPhoto('edit')" style="position: absolute; top: -4px; right: -4px; background: #c5221f; color: white; border: none; border-radius: 50%; width: 22px; height: 22px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center;" title="Remove Photo">✕</button>
            </div>
          `;
        } else {
          clearMemberPhoto('edit');
        }
      }

      handleEditCategoryChange(selectedCat);

      document.getElementById('editMemberModal').classList.add('active');
      document.getElementById('editMemFirst').focus();
    }

    function closeEditMemberModal() {
      document.getElementById('editMemberModal').classList.remove('active');
      const banner = document.getElementById('editMemStatusBanner');
      if (banner) banner.style.display = 'none';
    }

    async function handleUpdateMember(e) {
      e.preventDefault();
      const id = document.getElementById('editMemId').value;
      const first = document.getElementById('editMemFirst').value.trim();
      const last = document.getElementById('editMemLast').value.trim();
      let category = document.getElementById('editMemCategory').value;
      const guardian = document.getElementById('editMemGuardian').value.trim();
      const phone = document.getElementById('editMemPhone').value.trim();
      const gender = document.getElementById('editMemGender').value;
      const address = document.getElementById('editMemAddress').value.trim();
      const rawDob = document.getElementById('editMemDob').value;
      const email = document.getElementById('editMemEmail')?.value?.trim() || '';
      let role = document.getElementById('editMemRole').value;
      const photoUrl = document.getElementById('editMemPhotoUrl')?.value?.trim() || '';
      const wasGuest = document.getElementById('editMemOriginalIsGuest')?.value === 'true';

      const isChild = category.toLowerCase().includes('child');
      const isVisitorCat = category.toLowerCase().includes('visitor') || category.toLowerCase().includes('guest');
      const isVisitorRole = role.toLowerCase().includes('visitor') || role.toLowerCase().includes('first timer') || role.toLowerCase().includes('first-timer');
      
      let isGuest = false;
      if (['Adult', 'Child', 'Youth'].includes(category) || (!isVisitorCat && !isVisitorRole)) {
        isGuest = false;
        if (isVisitorRole || !role || role === 'Visitor / First Timer') {
          role = isChild ? 'Child / Sunday School' : (category === 'Youth' ? 'Youth / Teen' : 'Member');
        }
      } else if (isVisitorCat || isVisitorRole) {
        isGuest = true;
        if (!role || role === 'Member') {
          role = 'Visitor / First Timer';
        }
      }

      const formattedDob = formatDisplayDate(rawDob);
      let token = await getAdminAuthToken();

      if (id && !id.startsWith('mem_') && !id.startsWith('guest_')) {
        try {
          const payload = {
            firstName: first,
            lastName: last,
            category,
            guardian: isChild ? guardian : undefined,
            phone: phone || undefined,
            gender: gender || undefined,
            address: address || undefined,
            dateOfBirth: rawDob ? new Date(rawDob).toISOString() : undefined,
            role: role || (isGuest ? 'Visitor / First Timer' : (isChild ? 'Child / Sunday School' : 'Member')),
            email: email || undefined,
            photoUrl: photoUrl || null
          };

          let res = await fetch(`${API_BASE}/members/${id}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify(payload)
          });

          if (!res.ok) {
            token = await getAdminAuthToken();
            if (token) {
              await fetch(`${API_BASE}/members/${id}`, {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(payload)
              });
            }
          }
        } catch (err) {
          console.error('Error updating member on backend:', err);
        }
      }

      const updatedFullName = `${first} ${last}`.trim();
      const index = allMembers.findIndex(m => m.id === id);
      if (index !== -1) {
        allMembers[index] = {
          ...allMembers[index],
          firstName: first,
          lastName: last,
          category,
          guardian: isChild ? guardian : '',
          phone,
          gender,
          address,
          dob: formattedDob,
          rawDob: rawDob || null,
          email,
          role,
          photoUrl: photoUrl || null,
          isGuest
        };
      }

      // Propagate updated name and details to in-memory attendance and visitor records
      if (!isGuest) {
        // Person is now a regular church member! Purge from visitor lists
        if (Array.isArray(rawVisitorsData)) {
          rawVisitorsData = rawVisitorsData.filter(v => v.memberId !== id && v.id !== id && (!phone || v.phone !== phone));
        }
        if (Array.isArray(processedVisitorsList)) {
          processedVisitorsList = processedVisitorsList.filter(v => v.memberId !== id && v.id !== id && (!phone || v.phone !== phone));
        }
      } else {
        if (Array.isArray(rawVisitorsData)) {
          rawVisitorsData.forEach(v => {
            if (v.memberId === id || v.id === id || (phone && v.phone === phone)) {
              v.name = updatedFullName;
              v.firstName = first;
              v.lastName = last;
              v.phone = phone || v.phone;
              v.gender = gender || v.gender;
              v.address = address || v.address;
              v.category = category;
              v.role = role;
              if (isChild) v.guardian = guardian;
              if (photoUrl) v.photoUrl = photoUrl;
            }
          });
        }
      }

      if (typeof serviceAttendanceMap === 'object' && serviceAttendanceMap !== null) {
        Object.keys(serviceAttendanceMap).forEach(k => {
          (serviceAttendanceMap[k] || []).forEach(att => {
            if (att.memberId === id || att.id === id || att.member?.id === id || (phone && att.phone === phone)) {
              att.name = updatedFullName;
              att.firstName = first;
              att.lastName = last;
              att.category = category;
              att.role = role;
              att.isGuest = isGuest;
              if (att.member) {
                att.member.firstName = first;
                att.member.lastName = last;
                att.member.category = category;
                att.member.role = role;
                att.member.isGuest = isGuest;
              }
            }
          });
        });
      }

      saveMembersToStorage();
      updateDirectoryCounts();
      filterMembersTable();
      renderAttendanceAndDemographics();
      renderVisitorsSection();
      closeEditMemberModal();

      if (wasGuest && !isGuest) {
        Promise.all([loadSavedMembers(), loadVisitorsData(), fetchLiveCounts()]).then(() => {
          updateDirectoryCounts();
          filterMembersTable();
          renderVisitorsSection();
          renderAttendanceAndDemographics();
        }).catch(() => {});
        if (window.BroadcastChannel) {
          try {
            const bc = new BroadcastChannel('sfmi_attendance_live');
            bc.postMessage({ type: 'MEMBER_CONVERTED', memberId: id, name: updatedFullName });
            setTimeout(() => bc.close(), 500);
          } catch (e) {}
        }
        showToast(`<strong>${escapeHtml(updatedFullName)}</strong> has been successfully converted from a visitor into a permanent Church Member!`, 'success', 'Member Converted');
      } else {
        Promise.all([loadSavedMembers(), loadVisitorsData()]).then(() => {
          updateDirectoryCounts();
          filterMembersTable();
          renderVisitorsSection();
        }).catch(() => {});
        showToast(`${isGuest ? 'Visitor' : 'Member'} profile for <strong>${escapeHtml(updatedFullName)}</strong> updated in cloud database!`, 'success', 'Profile Updated');
      }
    }

    function formatDisplayDate(dateStr) {
      if (!dateStr) return '';
      const d = new Date(dateStr + 'T00:00:00');
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    async function handleSaveNewMember(e) {
      e.preventDefault();
      const first = document.getElementById('newMemFirst').value.trim();
      const last = document.getElementById('newMemLast').value.trim();
      const category = document.getElementById('newMemCategory').value;
      const guardian = document.getElementById('newMemGuardian').value.trim();
      const phone = document.getElementById('newMemPhone').value.trim();
      const gender = document.getElementById('newMemGender').value;
      const address = document.getElementById('newMemAddress').value.trim();
      const rawDob = document.getElementById('newMemDob').value;
      const email = document.getElementById('newMemEmail')?.value?.trim() || '';
      const role = document.getElementById('newMemRole').value;
      const photoUrl = document.getElementById('newMemPhotoUrl')?.value?.trim() || null;

      const formattedDob = formatDisplayDate(rawDob);
      let token = await getAdminAuthToken();

      let createdMember = null;
      try {
        const payload = {
          firstName: first,
          lastName: last,
          category,
          guardian: category === 'Child' ? guardian : undefined,
          phone: phone || undefined,
          gender: gender || undefined,
          address: address || undefined,
          dateOfBirth: rawDob ? new Date(rawDob).toISOString() : undefined,
          role: role || (category === 'Child' ? 'Child / Sunday School' : 'Member'),
          email: email || undefined,
          photoUrl: photoUrl || undefined
        };

        let res = await fetch(`${API_BASE}/members`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          token = await getAdminAuthToken();
          if (token) {
            res = await fetch(`${API_BASE}/members`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify(payload)
            });
          }
        }

        if (res.ok) {
          createdMember = await res.json();
        } else {
          const errBody = await res.json().catch(() => ({}));
          console.error('Failed to create member on backend:', res.status, errBody);
        }
      } catch (err) {
        console.error('Error persisting member to backend:', err);
      }

      const newM = {
        id: createdMember?.id || ('mem_' + Date.now()),
        firstName: first,
        lastName: last,
        category,
        guardian: category === 'Child' ? guardian : '',
        phone,
        gender,
        address,
        dob: formattedDob,
        rawDob: rawDob || null,
        email,
        role: role || (category === 'Child' ? 'Child / Sunday School' : 'Member'),
        photoUrl: createdMember?.photoUrl || photoUrl || null,
        isGuest: category.toLowerCase().includes('visitor') || category.toLowerCase().includes('guest')
      };

      allMembers.unshift(newM);
      saveMembersToStorage();
      updateDirectoryCounts();
      filterMembersTable();
      renderAttendanceAndDemographics();
      closeAddMemberModal();
      clearMemberPhoto('new');
      e.target.reset();
      showToast(`New ${category} <strong>${escapeHtml(first)} ${escapeHtml(last)}</strong> saved permanently to cloud database!`, 'success', 'Member Registered');
    }

    /* SERVICES & SPECIAL PROGRAMS SETUP MANAGER */
    let customPrograms = [];

    async function loadCustomPrograms() {
      try {
        const [progRes, kioskRes] = await Promise.all([
          fetch(`${API_BASE}/attendance/programs`).catch(() => null),
          fetch(`${API_BASE}/attendance/active-kiosk`).catch(() => null)
        ]);

        if (progRes && progRes.ok) {
          const cloudProgs = await progRes.json();
          if (Array.isArray(cloudProgs)) {
            const seen = new Set();
            customPrograms = cloudProgs.filter(p => {
              const k = (p.name || '').trim().toLowerCase();
              if (!k || seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            localStorage.setItem('sfmi_custom_programs', JSON.stringify(customPrograms));
          }
        }
        if (kioskRes && kioskRes.ok) {
          const kioskData = await kioskRes.json();
          if (kioskData && kioskData.activeKiosk !== undefined) {
            if (kioskData.activeKiosk) {
              localStorage.setItem('sfmi_active_kiosk_service', kioskData.activeKiosk);
            } else {
              localStorage.removeItem('sfmi_active_kiosk_service');
            }
          }
        }
      } catch (err) {}

      if (customPrograms.length === 0) {
        const saved = localStorage.getItem('sfmi_custom_programs');
        if (saved) {
          try {
            const list = JSON.parse(saved);
            const seen = new Set();
            customPrograms = list.filter(p => {
              const k = (p.name || '').trim().toLowerCase();
              if (!k || seen.has(k)) return false;
              seen.add(k);
              return true;
            });
          } catch(e){}
        }
      }
      populateServiceDropdowns();
    }

    async function saveCustomPrograms() {
      localStorage.setItem('sfmi_custom_programs', JSON.stringify(customPrograms));
      try {
        const headers = await getAuthHeaders();
        for (const prog of customPrograms) {
          await fetch(`${API_BASE}/attendance/programs`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(prog)
          });
        }
      } catch (err) {}
    }

    function populateServiceDropdowns() {
      const activeKiosk = localStorage.getItem('sfmi_active_kiosk_service');
      const btnSwitchBack = document.getElementById('btnSwitchBackAuto');
      const displayBanner = document.getElementById('adminKioskActiveDisplay');
      const activeSub = document.getElementById('adminKioskActiveSub');
      
      const progs = (typeof customPrograms !== 'undefined' && Array.isArray(customPrograms)) ? customPrograms : [];

      // 1. Populate Attendance Tab Selector
      const attSelect = document.getElementById('attServiceSelect');
      if (attSelect) {
        const standardOptions = [
          { val: 'ALL', text: '⚡ All Services (Live Session Attendance)' },
          { val: 'Sunday: Family & Friends Service', text: 'Sunday — Family & Friends Service' },
          { val: 'Wednesday: Time with the Lord', text: 'Wednesday — Time with the Lord' },
          { val: 'Friday: Prophetic Healing & Deliverance', text: 'Friday — Prophetic Healing & Deliverance' }
        ];

        attSelect.innerHTML = standardOptions.map(o => `<option value="${o.val}">${o.text}</option>`).join('') +
          progs.map(p => `<option value="${p.name}">[Special Program] ${p.name}</option>`).join('');

        if (Array.from(attSelect.options).some(o => o.value === currentSelectedService)) {
          attSelect.value = currentSelectedService;
        }
      }

      // 2. Populate Admin Kiosk Program Picker
      const kioskPicker = document.getElementById('adminKioskProgramPicker');
      if (kioskPicker) {
        kioskPicker.innerHTML = `
          <option value="AUTO: Day-of-Week Schedule">⚡ Automatic (Day-of-Week Schedule)</option>
          <option value="Sunday: Family & Friends Service">Sunday — Family & Friends Service</option>
          <option value="Wednesday: Time with the Lord">Wednesday — Time with the Lord</option>
          <option value="Friday: Prophetic Healing & Deliverance">Friday — Prophetic Deliverance</option>
        ` + progs.map(p => `<option value="${p.name}">🌟 [Special Program] ${p.name}</option>`).join('');

        if (activeKiosk) {
          kioskPicker.value = activeKiosk;
        } else {
          kioskPicker.value = 'AUTO: Day-of-Week Schedule';
        }
      }

      // 3. Populate Visitors Tab Service Select
      const visSelect = document.getElementById('visServiceSelect');
      if (visSelect) {
        const curVal = visSelect.value || 'ALL';
        visSelect.innerHTML = `
          <option value="ALL">All Services</option>
          <option value="Sunday: Family & Friends Service">Sunday — Family & Friends Service</option>
          <option value="Wednesday: Time with the Lord">Wednesday — Time with the Lord</option>
          <option value="Friday: Prophetic Healing & Deliverance">Friday — Prophetic Deliverance</option>
        ` + progs.map(p => `<option value="${p.name}">[Program] ${p.name}</option>`).join('');
        if (Array.from(visSelect.options).some(o => o.value === curVal)) {
          visSelect.value = curVal;
        }
      }

      // 4. Populate Finance Tab Service Filter
      const finSelect = document.getElementById('finFilterService');
      if (finSelect) {
        const curVal = finSelect.value || 'ALL';
        finSelect.innerHTML = `
          <option value="ALL">All Services</option>
          <option value="Sunday">Sunday Services</option>
          <option value="Wednesday">Wednesday Services</option>
          <option value="Friday">Friday Services</option>
        ` + progs.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
        if (Array.from(finSelect.options).some(o => o.value === curVal)) {
          finSelect.value = curVal;
        }
      }

      // 5. Populate Analytics Service Type Select
      const anaSelect = document.getElementById('analyticsServiceTypeSelect');
      if (anaSelect) {
        const curVal = anaSelect.value || 'ALL';
        anaSelect.innerHTML = `
          <option value="ALL">All Service Types (Combined)</option>
          <option value="Sunday">Sunday Services</option>
          <option value="Wednesday">Wednesday Services</option>
          <option value="Friday">Friday Services</option>
        ` + progs.map(p => `<option value="${p.name}">🌟 ${p.name}</option>`).join('');
        if (Array.from(anaSelect.options).some(o => o.value === curVal)) {
          anaSelect.value = curVal;
        }
      }

      // 6. Populate Messaging Center Service Select
      const msgSelect = document.getElementById('msgServiceSelect');
      if (msgSelect) {
        const curVal = msgSelect.value || 'ALL';
        msgSelect.innerHTML = `
          <option value="ALL">All Services</option>
          <option value="Sunday: Family & Friends Service">Sunday (Family & Friends)</option>
          <option value="Wednesday: Time with the Lord">Wednesday (Time with Lord)</option>
          <option value="Friday: Prophetic Healing & Deliverance">Friday (Prophetic Deliverance)</option>
        ` + progs.map(p => `<option value="${p.name}">[Program] ${p.name}</option>`).join('');
        if (Array.from(msgSelect.options).some(o => o.value === curVal)) {
          msgSelect.value = curVal;
        }
      }

      // 7. Populate Historical Attendance Reports Service Select
      const repAttSelect = document.getElementById('repAttServiceSelect');
      if (repAttSelect) {
        const curVal = repAttSelect.value || 'ALL';
        repAttSelect.innerHTML = `
          <option value="ALL">All Services</option>
          <option value="Sunday: Family & Friends Service">Sunday (Family & Friends)</option>
          <option value="Wednesday: Time with the Lord">Wednesday (Time with Lord)</option>
          <option value="Friday: Prophetic Healing & Deliverance">Friday (Prophetic Deliverance)</option>
        ` + progs.map(p => `<option value="${p.name}">[Program] ${p.name}</option>`).join('');
        if (Array.from(repAttSelect.options).some(o => o.value === curVal)) {
          repAttSelect.value = curVal;
        }
      }

      // 8. Populate Historical Finance Reports Service Select
      const repFinSelect = document.getElementById('repFinServiceSelect');
      if (repFinSelect) {
        const curVal = repFinSelect.value || 'ALL';
        repFinSelect.innerHTML = `
          <option value="ALL">All Services</option>
          <option value="Sunday">Sunday (Family &amp; Friends)</option>
          <option value="Wednesday">Wednesday (Time with Lord)</option>
          <option value="Friday">Friday (Prophetic Deliverance)</option>
        ` + progs.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
        if (Array.from(repFinSelect.options).some(o => o.value === curVal)) {
          repFinSelect.value = curVal;
        }
      }

      // Update Kiosk Active Display Banner
      if (activeKiosk) {
        if (btnSwitchBack) btnSwitchBack.style.display = 'inline-flex';
        if (displayBanner) displayBanner.innerHTML = `<span style="color: #fbbf24;"><i class="fas fa-star"></i> Special Program Live:</span> ${activeKiosk}`;
        if (activeSub) activeSub.innerText = 'Kiosk is currently locked to this program. When the program is over, click the green button above to return the kiosk to normal services.';
      } else {
        if (btnSwitchBack) btnSwitchBack.style.display = 'none';
        if (displayBanner) displayBanner.innerHTML = `<span style="color: #4ade80;"><i class="fas fa-check-circle"></i> Regular Weekly Schedule:</span> Running normal Sunday / Wednesday / Friday services`;
        if (activeSub) activeSub.innerText = 'Kiosk is running on automatic day-of-the-week schedule. You can lock it to any special program week at any time.';
      }
    }

    async function resetKioskToRegularSchedule(programName) {
      if (confirm('End active program/service and reset kiosk to regular schedule?')) {
        try {
          const aHeaders = await getAuthHeaders();
          await fetch(`${API_BASE}/attendance/clear`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...aHeaders
            },
            body: JSON.stringify({ serviceName: programName || currentSelectedService })
          });
          await fetch(`${API_BASE}/attendance/active-kiosk`, {
            method: 'POST',
            headers: { ...aHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ programName: null })
          });
        } catch(e) {}
        serviceAttendanceMap = {};
        localStorage.removeItem('sfmi_active_kiosk_service');
        populateServiceDropdowns();
        renderAttendanceAndDemographics();
        renderProgramsManager();
        showToast('Kiosk reset to <strong>Regular Schedule</strong>!', 'success', 'Schedule Reset');
      }
    }

    async function clearAttendanceData() {
      if (!confirm(`Are you sure you want to clear all attendance records for "${currentSelectedService}"? This will reset all attendance counts to 0.`)) return;
      try {
        const aHeaders = await getAuthHeaders();
        const res = await fetch(`${API_BASE}/attendance/clear`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...aHeaders
          },
          body: JSON.stringify({ serviceName: currentSelectedService })
        });
        if (res.ok) {
          serviceAttendanceMap = {};
          renderAttendanceAndDemographics();
          renderProgramsManager();
          showToast('All attendance data has been cleared!', 'success', 'Data Cleared');
        } else {
          showToast('Failed to clear attendance data', 'error', 'Error');
        }
      } catch (e) {
        showToast('Error connecting to server', 'error', 'Error');
      }
    }

    async function clearFinancialData() {
      showConfirmModal(
        'Reset / Clear Financial Data?',
        'Are you sure you want to clear all Financial Overview & Analytics collection records? This will purge all compiled service collection figures and cross-posted ledger entries to start fresh with new production data. This action cannot be undone.',
        async () => {
          try {
            const aHeaders = await getAuthHeaders();
            const res = await fetch(`${API_BASE}/finance/clear`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...aHeaders
              }
            });
            if (res.ok) {
              try {
                localStorage.removeItem('sfmi_finance_entries');
                localStorage.removeItem('sfmi_cached_finance');
                localStorage.removeItem('sfmi_fin_entries');
              } catch (c) {}
              rawFinanceEntries = [];
              filteredFinanceEntries = [];
              rawFinReportData = [];
              await loadFinanceData();
              if (typeof loadHistoricalFinanceReport === 'function') {
                await loadHistoricalFinanceReport();
              }
              showToast('Financial Overview & Analytics records cleared successfully. Ready for new production data.', 'success', 'Finance Cleared');
            } else {
              const err = await res.json().catch(() => ({ error: 'Failed to clear financial data' }));
              showToast(err.error || 'Failed to clear financial data.', 'error', 'Action Failed');
            }
          } catch (err) {
            showToast('Network error connecting to server.', 'error', 'Error');
          }
        },
        'fas fa-trash-alt',
        'Clear Financial Data',
        '#c5221f'
      );
    }

    function renderProgramsManager() {
      populateServiceDropdowns();
      const tbody = document.getElementById('programsTableBody');
      if (!tbody) return;

      const activeKiosk = localStorage.getItem('sfmi_active_kiosk_service');

      // Combine standard services + custom program weeks
      const regularServices = [
        {
          id: 'std_sun',
          name: 'Sunday: Family & Friends Service',
          category: 'Regular Weekly Service',
          schedule: 'Every Sunday · 7:00 AM – 11:00 AM',
          flyerUrl: '/Sunday.JPG',
          isStandard: true
        },
        {
          id: 'std_wed',
          name: 'Wednesday: Time with the Lord',
          category: 'Midweek Prayer Service',
          schedule: 'Every Wednesday · 6:00 PM – 8:00 PM',
          flyerUrl: '/WEDNESDAY.JPG',
          isStandard: true
        },
        {
          id: 'std_fri',
          name: 'Friday: Prophetic Healing & Deliverance',
          category: 'Deliverance Service',
          schedule: 'Every Friday · 6:00 PM – 8:00 PM',
          flyerUrl: '/FRIDAY.JPG',
          isStandard: true
        }
      ];

      // Ensure custom programs are deduplicated by name
      const seenProgNames = new Set();
      const dedupedCustom = [];
      for (const p of customPrograms) {
        const k = (p.name || '').trim().toLowerCase();
        if (!k || seenProgNames.has(k)) continue;
        seenProgNames.add(k);
        dedupedCustom.push(p);
      }
      customPrograms = dedupedCustom;

      const allList = [...regularServices, ...customPrograms];

      tbody.innerHTML = allList.map((item, i) => {
        const isKioskActive = activeKiosk === item.name || (!activeKiosk && item.isStandard && item.name.includes('Sunday'));
        const canon = canonicalServiceName(item.name);
        const sessions = (window._programSessionsMap && (window._programSessionsMap[item.name] || window._programSessionsMap[canon])) || [];
        const liveCount = (serviceAttendanceMap[item.name] || serviceAttendanceMap[canon] || []).length;

        let latestCount = 0;
        let latestLabel = 'Latest';
        if (sessions.length > 0) {
          const attendedSession = sessions.find(s => s.count > 0) || sessions[0];
          latestCount = attendedSession.count;
          latestLabel = attendedSession.dateLabel || 'Latest';
        } else if (window._programLatestCounts && (window._programLatestCounts[item.name] !== undefined || window._programLatestCounts[canon] !== undefined)) {
          latestCount = window._programLatestCounts[item.name] !== undefined ? window._programLatestCounts[item.name] : window._programLatestCounts[canon];
          latestLabel = 'Latest';
        } else {
          latestCount = liveCount;
          latestLabel = 'Live';
        }

        const statusBadge = isKioskActive
          ? `<span class="badge-present" style="background:#e6f4ea;color:#137333;"><i class="fas fa-tower-broadcast"></i> Live on Kiosk</span>`
          : `<span style="color:var(--muted);font-size:12px;">Standby</span>`;
        const safeName = item.name.replace(/'/g, "\\'");

        const sessionsDropdown = sessions.length > 0 ? `
          <select class="form-ctrl" style="font-size:11.5px; padding:3px 6px; height:auto; border-radius:4px; background:#f8fafc; border:1px solid var(--line); color:var(--ink); cursor:pointer; width:100%; max-width:215px; margin-top:4px;" onchange="handleSelectServiceSessionDate('${safeName}', this.value)" title="Select a past Sunday / service date to view its individual attendance">
            <option value="">📅 Past Sessions (${sessions.length})</option>
            ${sessions.map(s => `<option value="${s.dateIso}">${s.dateLabel}: ${s.count} attended</option>`).join('')}
          </select>
        ` : `<span style="font-size:11px; color:var(--muted); margin-top:2px;">No past sessions</span>`;

        const attendanceCell = `
          <div style="display:flex; flex-direction:column; min-width:180px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <strong style="color:var(--emerald); font-size:13.5px;">${latestCount} Attended</strong>
              <span style="font-size:10px; background:rgba(20,83,45,0.08); color:#14532d; padding:1px 5px; border-radius:4px; font-weight:700; border:1px solid rgba(20,83,45,0.2); white-space:nowrap;">${latestLabel}</span>
            </div>
            ${sessionsDropdown}
          </div>
        `;

        const actionButtons = `<div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${!isKioskActive ? `<button class="btn-main" style="padding:4px 10px;font-size:11.5px;background:#14532d;" onclick="activateProgramOnKiosk('${safeName}')"><i class="fas fa-play"></i> Set Live</button>` : `<button class="btn-main" style="padding:4px 10px;font-size:11.5px;background:#0f3d24;" onclick="resetKioskToRegularSchedule()"><i class="fas fa-rotate-left"></i> Reset</button>`}
          <button class="btn-main" style="padding:4px 10px;font-size:11.5px;background:#c5221f;color:white;" onclick="endCheckinAndGenerateReport('${safeName}')" title="End check-in session for this service and compile report"><i class="fas fa-flag-checkered"></i> End Check-In &amp; Report</button>
          <button class="btn-main" style="padding:4px 10px;font-size:11.5px;background:#c89b55;color:#111;" onclick="openEditProgramModal('${item.id}')"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn-main" style="padding:4px 10px;font-size:11.5px;background:#3b82f6;" onclick="viewProgramAttendance('${safeName}')"><i class="fas fa-users"></i> Attendance</button>
          ${!item.isStandard ? `<button class="btn-main" style="padding:4px 10px;font-size:11.5px;background:#991b1b;" onclick="deleteCustomProgram('${item.id}')"><i class="fas fa-trash-alt"></i> Delete</button>` : ''}
        </div>`;
        return `<tr>
          <td>${i+1}</td><td><strong>${item.name}</strong></td>
          <td><span class="badge-check">${item.category}</span></td>
          <td>${item.schedule}</td>
          <td><img src="${item.flyerUrl}" style="width:36px;height:36px;object-fit:contain;border-radius:4px;border:1px solid var(--line);background:#000;" /></td>
          <td>${attendanceCell}</td>
          <td>${statusBadge}</td>
          <td>${actionButtons}</td>
        </tr>`;
      }).join('');

      // Mobile cards for Programs
      const mobCards = document.getElementById('programsMobileCards');
      if (mobCards) {
        mobCards.innerHTML = allList.length === 0
          ? `<div style="text-align:center;color:var(--muted);padding:28px 0;">No services or programs configured.</div>`
          : allList.map((item, i) => {
            const isKioskActive = activeKiosk === item.name || (!activeKiosk && item.isStandard && item.name.includes('Sunday'));
            const canon = canonicalServiceName(item.name);
            const sessions = (window._programSessionsMap && (window._programSessionsMap[item.name] || window._programSessionsMap[canon])) || [];
            const liveCount = (serviceAttendanceMap[item.name] || serviceAttendanceMap[canon] || []).length;

            let latestCount = 0;
            let latestLabel = 'Latest';
            if (sessions.length > 0) {
              const attendedSession = sessions.find(s => s.count > 0) || sessions[0];
              latestCount = attendedSession.count;
              latestLabel = attendedSession.dateLabel || 'Latest';
            } else if (window._programLatestCounts && (window._programLatestCounts[item.name] !== undefined || window._programLatestCounts[canon] !== undefined)) {
              latestCount = window._programLatestCounts[item.name] !== undefined ? window._programLatestCounts[item.name] : window._programLatestCounts[canon];
              latestLabel = 'Latest';
            } else {
              latestCount = liveCount;
              latestLabel = 'Live';
            }

            const statusBadge = isKioskActive
              ? `<span class="badge-present" style="background:#e6f4ea;color:#137333;font-size:11px;"><i class="fas fa-tower-broadcast"></i> Live</span>`
              : `<span style="color:var(--muted);font-size:11px;">Standby</span>`;
            const safeName = item.name.replace(/'/g, "\\'");

            const mobSessionsDropdown = sessions.length > 0 ? `
              <select class="form-ctrl" style="font-size:11.5px; padding:3px 6px; height:auto; border-radius:4px; background:#f8fafc; border:1px solid var(--line); color:var(--ink); cursor:pointer; width:100%; max-width:190px; margin-top:3px;" onchange="handleSelectServiceSessionDate('${safeName}', this.value)" title="Select a past Sunday date to view its individual attendance">
                <option value="">📅 Past Sessions (${sessions.length})</option>
                ${sessions.map(s => `<option value="${s.dateIso}">${s.dateLabel}: ${s.count} attended</option>`).join('')}
              </select>
            ` : `<span style="font-size:11px; color:var(--muted);">No past sessions</span>`;

            return `
              <div class="mob-card">
                <div class="mob-card-header">
                  <div class="mob-card-name">${item.name}</div>
                  ${statusBadge}
                </div>
                <div class="mob-card-meta">
                  <div class="mob-card-row"><span>Category</span><strong><span class="badge-check">${item.category}</span></strong></div>
                  <div class="mob-card-row"><span>Schedule</span><strong style="font-size:12px;">${item.schedule}</strong></div>
                  <div class="mob-card-row" style="align-items:flex-start;">
                    <span>Attendance</span>
                    <div style="display:flex; flex-direction:column; gap:3px; align-items:flex-end;">
                      <strong style="color:var(--emerald); font-size:13px;">${latestCount} Attended <span style="font-size:10px; background:rgba(20,83,45,0.08); color:#14532d; padding:1px 5px; border-radius:4px; font-weight:700; border:1px solid rgba(20,83,45,0.2);">${latestLabel}</span></strong>
                      ${mobSessionsDropdown}
                    </div>
                  </div>
                </div>
                <div class="mob-card-actions">
                  ${!isKioskActive
                    ? `<button class="btn-main" style="background:#14532d;" onclick="activateProgramOnKiosk('${safeName}')"><i class="fas fa-play"></i> Set Live</button>`
                    : `<button class="btn-main" style="background:#0f3d24;" onclick="resetKioskToRegularSchedule()"><i class="fas fa-rotate-left"></i> Reset</button>`}
                  <button class="btn-main" style="background:#c89b55;color:#111;" onclick="openEditProgramModal('${item.id}')"><i class="fas fa-edit"></i> Edit</button>
                  <button class="btn-main" style="background:#3b82f6;" onclick="viewProgramAttendance('${safeName}')"><i class="fas fa-users"></i> Attendance</button>
                  ${!item.isStandard ? `<button class="btn-main" style="background:#c5221f;" onclick="deleteCustomProgram('${item.id}')"><i class="fas fa-trash-alt"></i> Delete</button>` : ''}
                </div>
              </div>`;
          }).join('');
      }

      syncProgramsViewMode();
    }

    function syncProgramsViewMode() {
      const isMobile = window.innerWidth <= 700;
      const tbl = document.querySelector('#secPrograms .table-responsive');
      const cards = document.getElementById('programsMobileCards');
      if (tbl) tbl.style.display = isMobile ? 'none' : 'block';
      if (cards) cards.style.display = isMobile ? 'block' : 'none';
    }
    window.addEventListener('resize', syncProgramsViewMode);

    function getStandardServicesList() {
      return [
        {
          id: 'std_sun',
          name: localStorage.getItem('sfmi_svc_name_sun') || 'Sunday: Family & Friends Service',
          category: 'Regular Weekly Service',
          schedule: localStorage.getItem('sfmi_svc_sched_sun') || 'Every Sunday · 7:00 AM – 11:00 AM',
          cutoffTime: localStorage.getItem('sfmi_svc_cutoff_sun') || '11:00',
          flyerUrl: localStorage.getItem('sfmi_svc_img_sun') || '/Sunday.JPG',
          isStandard: true
        },
        {
          id: 'std_wed',
          name: localStorage.getItem('sfmi_svc_name_wed') || 'Wednesday: Time with the Lord',
          category: 'Midweek Prayer Service',
          schedule: localStorage.getItem('sfmi_svc_sched_wed') || 'Every Wednesday · 6:00 PM – 8:00 PM',
          cutoffTime: localStorage.getItem('sfmi_svc_cutoff_wed') || '20:00',
          flyerUrl: localStorage.getItem('sfmi_svc_img_wed') || '/WEDNESDAY.JPG',
          isStandard: true
        },
        {
          id: 'std_fri',
          name: localStorage.getItem('sfmi_svc_name_fri') || 'Friday: Prophetic Healing & Deliverance',
          category: 'Deliverance Service',
          schedule: localStorage.getItem('sfmi_svc_sched_fri') || 'Every Friday · 6:00 PM – 8:00 PM',
          cutoffTime: localStorage.getItem('sfmi_svc_cutoff_fri') || '20:00',
          flyerUrl: localStorage.getItem('sfmi_svc_img_fri') || '/FRIDAY.JPG',
          isStandard: true
        }
      ];
    }

    function openEditProgramModal(id) {
      loadCustomPrograms();
      const allList = [...getStandardServicesList(), ...customPrograms];
      const item = allList.find(p => p.id === id);
      if (!item) {
        showToast('Service details could not be found.', 'error', 'Error');
        return;
      }

      const elId = document.getElementById('editProgId');
      const elStd = document.getElementById('editProgIsStandard');
      const elName = document.getElementById('editProgName');
      const elCat = document.getElementById('editProgCategory');
      const elSched = document.getElementById('editProgSchedule');
      const elCutoff = document.getElementById('editProgCutoffTime');
      const elImg = document.getElementById('editProgFlyerPreviewImg');
      const elData = document.getElementById('editProgAttachedFlyerData');
      const elFileLbl = document.getElementById('editProgFlyerFileName');

      if (elId) elId.value = item.id;
      if (elStd) elStd.value = item.isStandard ? 'true' : 'false';
      if (elName) elName.value = item.name || '';
      if (elCat) elCat.value = item.category || 'Special Program / Convention';
      if (elSched) elSched.value = item.schedule || '';
      if (elCutoff) elCutoff.value = item.cutoffTime || '11:30';
      if (elImg) elImg.src = item.flyerUrl || '/Sunday.JPG';
      if (elData) elData.value = '';
      if (elFileLbl) elFileLbl.innerText = 'Current flyer image';

      const modal = document.getElementById('editProgramModal');
      if (modal) modal.classList.add('active');
      if (elName) elName.focus();
    }

    function closeEditProgramModal() {
      const modal = document.getElementById('editProgramModal');
      if (modal) modal.classList.remove('active');
    }

    async function compressImage(file, maxWidth, maxHeight, quality, callback) {
      const fName = (file.name || '').toLowerCase();
      const isHeic = fName.endsWith('.heic') || fName.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
      let fileOrBlob = file;
      if (isHeic && typeof heic2any === 'function') {
        try {
          showToast('Converting HEIC flyer image...', 'info', 'Processing Image');
          const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality });
          fileOrBlob = Array.isArray(converted) ? converted[0] : converted;
        } catch (heicErr) {
          console.error('HEIC conversion in compressImage error:', heicErr);
        }
      }

      const reader = new FileReader();
      reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
          let w = img.width;
          let h = img.height;
          if (w > maxWidth || h > maxHeight) {
            if (w > h) {
              h = Math.round((h * maxWidth) / w);
              w = maxWidth;
            } else {
              w = Math.round((w * maxHeight) / h);
              h = maxHeight;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
          callback(compressedDataUrl);
        };
        img.onerror = function() {
          showToast('Could not load image preview.', 'error', 'Image Error');
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(fileOrBlob);
    }

    function handleEditProgramFlyerAttachment(input) {
      const file = input.files[0];
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        showToast('Please select a valid image file (JPG, PNG, WEBP).', 'error', 'Invalid File Type');
        return;
      }

      compressImage(file, 1000, 1000, 0.8, (dataUrl) => {
        const elData = document.getElementById('editProgAttachedFlyerData');
        const elImg = document.getElementById('editProgFlyerPreviewImg');
        const elLbl = document.getElementById('editProgFlyerFileName');

        if (elData) elData.value = dataUrl;
        if (elImg) elImg.src = dataUrl;
        if (elLbl) elLbl.innerText = `New: ${file.name} (Compressed & Ready)`;
        showToast('Flyer image optimized! Click "Save Changes" to apply.', 'info', 'Flyer Attached');
      });
    }

    function handleUpdateProgram(e) {
      e.preventDefault();
      const id = document.getElementById('editProgId')?.value;
      const isStandard = document.getElementById('editProgIsStandard')?.value === 'true';
      const name = (document.getElementById('editProgName')?.value || '').trim();
      const category = document.getElementById('editProgCategory')?.value || 'Regular Weekly Service';
      const schedule = (document.getElementById('editProgSchedule')?.value || '').trim();
      const cutoffTime = document.getElementById('editProgCutoffTime')?.value || '11:30';
      const attachedFlyer = document.getElementById('editProgAttachedFlyerData')?.value || '';

      if (isStandard) {
        // Update standard service flyer or name in storage
        if (id === 'std_sun') {
          if (attachedFlyer) localStorage.setItem('sfmi_svc_img_sun', attachedFlyer);
          localStorage.setItem('sfmi_svc_name_sun', name);
          localStorage.setItem('sfmi_svc_sched_sun', schedule);
          localStorage.setItem('sfmi_svc_cutoff_sun', cutoffTime);
        } else if (id === 'std_wed') {
          if (attachedFlyer) localStorage.setItem('sfmi_svc_img_wed', attachedFlyer);
          localStorage.setItem('sfmi_svc_name_wed', name);
          localStorage.setItem('sfmi_svc_sched_wed', schedule);
          localStorage.setItem('sfmi_svc_cutoff_wed', cutoffTime);
        } else if (id === 'std_fri') {
          if (attachedFlyer) localStorage.setItem('sfmi_svc_img_fri', attachedFlyer);
          localStorage.setItem('sfmi_svc_name_fri', name);
          localStorage.setItem('sfmi_svc_sched_fri', schedule);
          localStorage.setItem('sfmi_svc_cutoff_fri', cutoffTime);
        }
      } else {
        // Update custom program
        const index = customPrograms.findIndex(p => p.id === id);
        if (index !== -1) {
          customPrograms[index] = {
            ...customPrograms[index],
            name,
            category,
            tag: category.toUpperCase(),
            schedule,
            cutoffTime,
            flyerUrl: attachedFlyer || customPrograms[index].flyerUrl
          };
          saveCustomPrograms();
        }
      }

      closeEditProgramModal();
      populateServiceDropdowns();
      renderProgramsManager();
      showToast(`Service <strong>"${escapeHtml(name)}"</strong> updated successfully!`, 'success', 'Service Updated');
    }

    async function activateProgramOnKiosk(name) {
      localStorage.setItem('sfmi_active_kiosk_service', name);
      try {
        const headers = await getAuthHeaders();
        await fetch(`${API_BASE}/attendance/active-kiosk`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ programName: name })
        });
      } catch (err) {}
      populateServiceDropdowns();
      renderProgramsManager();
      showToast(`Kiosk check-in is now set live for: <strong>${escapeHtml(name)}</strong>`, 'success', 'Live Kiosk Updated');
    }

    function deleteCustomProgram(id) {
      const prog = customPrograms.find(p => p.id === id || p.name === id);
      const progName = prog ? prog.name : id;

      showConfirmModal(
        'Delete Special Program',
        `Are you sure you want to permanently delete "${progName}"? This will remove it from all kiosk and admin lists.`,
        async () => {
          // Remove from local customPrograms array
          customPrograms = customPrograms.filter(p => p.id !== id && p.name !== id && (!progName || p.name.toLowerCase() !== progName.toLowerCase()));
          localStorage.setItem('sfmi_custom_programs', JSON.stringify(customPrograms));

          // If active kiosk was this program, reset it
          const activeKiosk = localStorage.getItem('sfmi_active_kiosk_service');
          if (activeKiosk === progName || activeKiosk === id) {
            localStorage.removeItem('sfmi_active_kiosk_service');
            try {
              const aHeaders = await getAuthHeaders();
              await fetch(`${API_BASE}/attendance/active-kiosk`, {
                method: 'POST',
                headers: { ...aHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ programName: '' })
              });
            } catch (e) {}
          }

          // Delete from cloud backend
          try {
            const dHeaders = await getAuthHeaders();
            await fetch(`${API_BASE}/attendance/programs/${encodeURIComponent(id)}`, { method: 'DELETE', headers: dHeaders });
            if (prog && prog.name && prog.name !== id) {
              await fetch(`${API_BASE}/attendance/programs/${encodeURIComponent(prog.name)}`, { method: 'DELETE', headers: dHeaders }).catch(() => {});
            }
          } catch (err) {
            console.error('Failed to delete program from server:', err);
          }

          populateServiceDropdowns();
          renderProgramsManager();
          showToast(`Special Program <strong>"${escapeHtml(progName)}"</strong> deleted successfully.`, 'info', 'Program Removed');
        },
        'fas fa-trash-alt',
        'Delete Program',
        '#c5221f'
      );
    }

    async function handleAdminSetKioskActive(serviceKey) {
      if (serviceKey === 'AUTO: Day-of-Week Schedule') {
        await resetKioskToRegularSchedule();
      } else {
        localStorage.setItem('sfmi_active_kiosk_service', serviceKey);
        try {
          const headers = await getAuthHeaders();
          await fetch(`${API_BASE}/attendance/active-kiosk`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ programName: serviceKey })
          });
        } catch (err) {}
        populateServiceDropdowns();
        renderProgramsManager();
        showToast(`Kiosk check-in is now set live for: <strong>${escapeHtml(serviceKey)}</strong>`, 'success', 'Live Kiosk Updated');
      }
    }

    function viewProgramAttendance(name) {
      currentSelectedService = name;
      const attSelect = document.getElementById('attServiceSelect');
      if (attSelect) {
        attSelect.value = name;
      }
      const canon = canonicalServiceName(name);
      const sessions = (window._programSessionsMap && (window._programSessionsMap[name] || window._programSessionsMap[canon])) || [];
      const dateInput = document.getElementById('attDateSelect');
      if (dateInput && sessions.length > 0 && sessions[0].dateIso) {
        dateInput.value = sessions[0].dateIso;
      }
      switchTab('attendance');
      renderAttendanceAndDemographics();
      fetchLiveCounts();
    }

    function handleSelectServiceSessionDate(serviceName, dateIso) {
      if (!dateIso) return;
      currentSelectedService = serviceName;
      const attSelect = document.getElementById('attServiceSelect');
      if (attSelect) {
        attSelect.value = serviceName;
      }
      const dateInput = document.getElementById('attDateSelect');
      if (dateInput) {
        dateInput.value = dateIso;
      }
      switchTab('attendance');
      renderAttendanceAndDemographics();
      fetchLiveCounts();
      showToast(`Viewing attendance roster for ${serviceName} on ${dateIso}`, 'info', 'Session Selected');
    }

    function openCreateProgramModal() {
      document.getElementById('createProgramModal').classList.add('active');
      document.getElementById('progName').focus();
    }

    function closeCreateProgramModal() {
      document.getElementById('createProgramModal').classList.remove('active');
    }

    function handleProgramFlyerAttachment(input) {
      const file = input.files[0];
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        showToast('Please select a valid image file (JPG, PNG, WEBP).', 'error', 'Invalid File Type');
        return;
      }

      compressImage(file, 1000, 1000, 0.8, (dataUrl) => {
        document.getElementById('progAttachedFlyerData').value = dataUrl;
        document.getElementById('progFlyerPreviewImg').src = dataUrl;
        document.getElementById('progFlyerFileName').innerText = `${file.name} (Optimized)`;
        document.getElementById('progFlyerPlaceholder').style.display = 'none';
        document.getElementById('progFlyerPreviewWrap').style.display = 'flex';
      });
    }

    function removeAttachedFlyer(e) {
      if (e) e.stopPropagation();
      document.getElementById('progFlyerFileInput').value = '';
      document.getElementById('progAttachedFlyerData').value = '';
      document.getElementById('progFlyerPlaceholder').style.display = 'block';
      document.getElementById('progFlyerPreviewWrap').style.display = 'none';
    }

    function handleSaveCustomProgram(e) {
      e.preventDefault();
      const name = document.getElementById('progName').value.trim();
      const category = document.getElementById('progCategory').value;
      const schedule = document.getElementById('progSchedule').value.trim();
      
      const attachedData = document.getElementById('progAttachedFlyerData').value;
      const flyerUrl = attachedData || '/Sunday.JPG';
      const setActive = document.getElementById('progSetKioskActive').checked;

      const newProg = {
        id: 'prog_' + Date.now(),
        name,
        category,
        tag: category.toUpperCase(),
        schedule,
        flyerUrl,
        createdAt: new Date().toISOString().split('T')[0]
      };

      customPrograms.unshift(newProg);
      saveCustomPrograms();

      if (setActive) {
        localStorage.setItem('sfmi_active_kiosk_service', name);
      }

closeCreateProgramModal();
      e.target.reset();
      removeAttachedFlyer();
      populateServiceDropdowns();
      renderProgramsManager();
      showToast(`Special Program <strong>"${name}"</strong> with attached flyer registered successfully!`, 'success', 'Program Created');
    }

    /* ════════════════════════════════════════════════════════════════════
       PLEDGES & COLLECTION FUNDS MANAGEMENT SYSTEM (ADMIN)
    ════════════════════════════════════════════════════════════════════ */
    let rawPartnershipMatrix = [];
    let allPartnershipMatrix = []; // Full matrix cached across all collection funds for instant switching
    let cachedPartnersListAdmin = [];
    let currentMatrixYear = new Date().getFullYear();
    let activeCollectionType = 'Partnership';
    let cachedCollectionTypes = [];
    let cachedCollectionBreakdown = {};
    let isPartnershipDataFetched = false;

    function applyActiveCollectionTypeUI() {
      // 1. Render Collection Fund Cards & Pill Tabs immediately with active highlight
      renderCollectionTypeCards(cachedCollectionBreakdown);

      // 2. Filter rawPartnershipMatrix for activeCollectionType
      const normActive = (activeCollectionType || 'Partnership').toLowerCase();
      rawPartnershipMatrix = allPartnershipMatrix.filter(item => {
        const itemType = (item.collectionType || 'PARTNERSHIP').toLowerCase();
        return itemType === normActive;
      });

      // 3. Compute live KPIs for this activeCollectionType instantly
      const currentMonthNum = new Date().getMonth() + 1;
      const curMonthKey = String(currentMonthNum).padStart(2, '0');

      let totalPartners = rawPartnershipMatrix.length;
      let totalPledged = 0;
      let currentMonthCollected = 0;
      let currentMonthMissed = 0;

      const activeCardStats = (cachedCollectionBreakdown && (cachedCollectionBreakdown[activeCollectionType.toUpperCase()] || cachedCollectionBreakdown[activeCollectionType])) || null;

      rawPartnershipMatrix.forEach(item => {
        const pAmt = Number(item.pledgeAmount) || 0;
        totalPledged += pAmt;
        const mInfo = item.monthlyStatus && item.monthlyStatus[curMonthKey];
        if (mInfo) {
          if (mInfo.status === 'MISSED' || mInfo.status === 'DUE') {
            currentMonthMissed++;
          }
        }
      });

      if (activeCardStats && activeCardStats.currentMonthCollected !== undefined) {
        currentMonthCollected = Number(activeCardStats.currentMonthCollected) || 0;
      } else {
        rawPartnershipMatrix.forEach(item => {
          const mInfo = item.monthlyStatus && item.monthlyStatus[curMonthKey];
          if (mInfo) currentMonthCollected += (Number(mInfo.paid) || 0);
        });
      }

      const statCount = document.getElementById('statPartCount');
      const statPledged = document.getElementById('statPartPledged');
      const statCollected = document.getElementById('statPartCollected');
      const statMissed = document.getElementById('statPartMissed');

      if (statCount) statCount.innerText = totalPartners;
      if (statPledged) statPledged.innerText = `GHS ${totalPledged.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (statCollected) {
        const currentMonthPledged = totalPledged;
        const pct = currentMonthPledged > 0 ? Math.round((currentMonthCollected / currentMonthPledged) * 100) : 0;
        statCollected.innerHTML = `GHS ${currentMonthCollected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span style="font-size:12px; color:var(--emerald-dark); font-weight:700;">(${pct}%)</span>`;
      }
      if (statMissed) statMissed.innerText = currentMonthMissed;

      // 4. Render Desktop Table & Mobile Cards immediately
      renderPartnershipMatrix();

      // 5. Update partner dropdown for Record Payment modal
      filterAdminPayPartnerOptions(activeCollectionType);
    }

    async function loadPartnershipMatrix(year, isBackground = false) {
      if (year && Number(year) !== currentMatrixYear) {
        currentMatrixYear = Number(year);
        isPartnershipDataFetched = false;
      }
      const yearSelect = document.getElementById('partnerYearSelect');
      if (yearSelect) yearSelect.value = String(currentMatrixYear);

      // If already in memory, render immediately with 0ms delay!
      if (isPartnershipDataFetched) {
        applyActiveCollectionTypeUI();
      }

      try {
        const token = await getAdminAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const [matrixRes, partnersRes, colTypesRes] = await Promise.all([
          fetch(`${API_BASE}/finance/partnerships/matrix?year=${currentMatrixYear}&collectionType=ALL`, { headers }).catch(() => null),
          fetch(`${API_BASE}/finance/partners?collectionType=ALL`, { headers }).catch(() => null),
          fetch(`${API_BASE}/finance/collection-types`, { headers }).catch(() => null)
        ]);

        if (colTypesRes && colTypesRes.ok) {
          cachedCollectionTypes = await colTypesRes.json();
          populateCollectionTypeDropdowns();
        }

        if (partnersRes && partnersRes.ok) {
          cachedPartnersListAdmin = await partnersRes.json();
        }

        if (matrixRes && matrixRes.ok) {
          const data = await matrixRes.json();
          allPartnershipMatrix = data.matrix || [];
          cachedCollectionBreakdown = data.collectionBreakdown || {};
          isPartnershipDataFetched = true;

          // Apply UI with fresh server data
          applyActiveCollectionTypeUI();
        }
      } catch (err) {
        console.error('Failed to load partnership matrix:', err);
      }
    }

    function renderCollectionTypeCards(breakdown = {}) {
      const grid = document.getElementById('collectionTypesGrid');
      const tabsNav = document.getElementById('collectionTabsNav');
      if (!grid) return;

      const types = (cachedCollectionTypes && cachedCollectionTypes.length > 0)
        ? cachedCollectionTypes
        : [
            { id: 'welfare', name: 'Welfare', category: 'Welfare & Benevolence', description: 'Monthly welfare dues, member emergency support, and benevolence funds', icon: 'fas fa-hand-holding-heart', color: '#0284c7', isStandard: true },
            { id: 'partnership', name: 'Partnership', category: 'Covenant Partnership', description: 'Monthly ministry partnership pledges, vision builders, and covenant partners', icon: 'fas fa-handshake', color: '#c89b55', isStandard: true }
          ];

      // Render instant clickable pill tabs
      if (tabsNav) {
        tabsNav.innerHTML = types.map(type => {
          const isActive = activeCollectionType.toLowerCase() === type.name.toLowerCase();
          const typeColor = type.color || '#10b981';
          const safeName = type.name.replace(/'/g, "\\'");
          return `
            <button type="button" onclick="selectCollectionType('${safeName}')" style="display: inline-flex; align-items: center; gap: 8px; padding: 7px 16px; border-radius: 20px; font-size: 13px; font-weight: 700; cursor: pointer; border: 1.5px solid ${isActive ? typeColor : 'var(--line)'}; background: ${isActive ? typeColor : '#ffffff'}; color: ${isActive ? '#ffffff' : 'var(--ink)'}; transition: all 0.12s ease; white-space: nowrap; box-shadow: ${isActive ? '0 2px 8px ' + typeColor + '35' : 'none'};">
              <i class="${type.icon || 'fas fa-layer-group'}"></i>
              ${escapeHtml(type.name)}
            </button>
          `;
        }).join('') + `
          <button type="button" onclick="openCreateCollectionTypeModal()" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 20px; font-size: 12.5px; font-weight: 700; cursor: pointer; border: 1.5px dashed var(--line); background: #f8fafc; color: var(--muted); transition: all 0.12s ease; white-space: nowrap;">
            <i class="fas fa-plus"></i> New Fund
          </button>
        `;
      }

      grid.innerHTML = types.map(type => {
        const isActive = activeCollectionType.toLowerCase() === type.name.toLowerCase();
        const typeColor = type.color || '#10b981';
        const stats = breakdown[type.name.toUpperCase()] || breakdown[type.name] || { totalPartners: 0, totalMonthlyPledged: 0, currentMonthCollected: 0 };
        const safeName = type.name.replace(/'/g, "\\'");

        return `
          <div class="col-type-card" onclick="selectCollectionType('${safeName}')" style="cursor:pointer; border-radius:10px; border:${isActive ? '2.5px solid ' + typeColor : '1.5px solid var(--line)'}; padding:16px 18px; box-shadow:${isActive ? '0 6px 16px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.02)'}; transition:all 0.15s ease; position:relative; display:flex; flex-direction:column; justify-content:space-between; background:${isActive ? 'linear-gradient(180deg, #ffffff 0%, ' + typeColor + '0d 100%)' : '#ffffff'};">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                <div style="display:flex; align-items:center; gap:10px;">
                  <div style="width:40px; height:40px; border-radius:8px; background:${typeColor}18; color:${typeColor}; display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0;">
                    <i class="${type.icon || 'fas fa-layer-group'}"></i>
                  </div>
                  <div>
                    <h4 style="margin:0; font-size:15px; font-weight:800; color:var(--ink);">${escapeHtml(type.name)}</h4>
                    <span style="font-size:11px; color:var(--muted);">${escapeHtml(type.category || 'Collection Fund')}</span>
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                  ${isActive ? `<span style="font-size:10px; background:${typeColor}20; color:${typeColor}; font-weight:800; padding:2px 8px; border-radius:12px; border:1px solid ${typeColor}40;">ACTIVE</span>` : ''}
                  ${!type.isStandard ? `<button type="button" onclick="event.stopPropagation(); deleteCustomCollectionType('${type.id}', '${safeName}')" title="Delete this collection type" style="background:none; border:none; color:#ef4444; font-size:12px; cursor:pointer; padding:4px;"><i class="fas fa-trash-alt"></i></button>` : ''}
                </div>
              </div>
              <p style="font-size:12px; color:var(--muted); margin:0 0 14px 0; line-height:1.45;">${escapeHtml(type.description || 'Collection and contribution fund.')}</p>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid #f1f5f9; padding-top:10px; font-size:12px;">
              <div><span style="color:var(--muted);">Members:</span> <strong style="color:var(--ink);">${stats.totalPartners || 0}</strong></div>
              <div><span style="color:var(--muted);">This Month:</span> <strong style="color:var(--emerald-dark);">GHS ${(stats.currentMonthCollected || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></div>
            </div>
          </div>
        `;
      }).join('') + `
        <!-- Quick Add New Card -->
        <div onclick="openCreateCollectionTypeModal()" style="cursor:pointer; background:#fafafa; border:2px dashed var(--line); border-radius:10px; padding:18px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; min-height:140px; transition:all 0.15s ease;" onmouseover="this.style.borderColor='var(--emerald-dark)'; this.style.background='#f0fdf4';" onmouseout="this.style.borderColor='var(--line)'; this.style.background='#fafafa';">
          <div style="width:36px; height:36px; border-radius:50%; background:#e2e8f0; color:#475569; display:flex; align-items:center; justify-content:center; font-size:16px; margin-bottom:8px;">
            <i class="fas fa-plus"></i>
          </div>
          <strong style="font-size:13.5px; color:var(--ink); margin-bottom:2px;">+ Add New Collection</strong>
          <span style="font-size:11.5px; color:var(--muted);">e.g. Men Collection, Harvest Fund</span>
        </div>
      `;
    }

    function selectCollectionType(typeName) {
      activeCollectionType = typeName || 'Partnership';
      const indicator = document.getElementById('activeCollectionIndicator');
      if (indicator) {
        indicator.innerHTML = `Active Fund: <span style="color:var(--emerald-dark);">${escapeHtml(activeCollectionType)}</span>`;
      }

      const titleEl = document.getElementById('partnershipHeaderTitle');
      const descEl = document.getElementById('partnershipHeaderDesc');
      const regBtn = document.getElementById('btnRegisterPartnerMain');
      const payBtn = document.getElementById('btnRecordPaymentMain');

      if (activeCollectionType.toLowerCase() === 'welfare') {
        if (titleEl) titleEl.innerHTML = `<i class="fas fa-hand-holding-heart" style="color:#0284c7; margin-right:8px;"></i> Welfare &amp; Benevolence Fund`;
        if (descEl) descEl.innerText = `Track registered welfare members, monthly dues commitments, benevolence payouts, and defaulters in real-time.`;
        if (regBtn) regBtn.innerHTML = `<i class="fas fa-user-plus"></i> Register Welfare Member`;
        if (payBtn) payBtn.innerHTML = `<i class="fas fa-receipt"></i> Record Welfare Dues`;
      } else if (activeCollectionType.toLowerCase() === 'partnership') {
        if (titleEl) titleEl.innerHTML = `<i class="fas fa-handshake" style="color:var(--accent); margin-right:8px;"></i> Ministry Partners &amp; Monthly Pledges`;
        if (descEl) descEl.innerText = `Track registered covenant partners, monthly pledge commitments, fulfillment status, and identify defaulters or missed payments in real-time.`;
        if (regBtn) regBtn.innerHTML = `<i class="fas fa-user-plus"></i> Register New Partner`;
        if (payBtn) payBtn.innerHTML = `<i class="fas fa-receipt"></i> Record Payment`;
      } else {
        if (titleEl) titleEl.innerHTML = `<i class="fas fa-layer-group" style="color:var(--emerald-dark); margin-right:8px;"></i> ${escapeHtml(activeCollectionType)} &amp; Contributions`;
        if (descEl) descEl.innerText = `Manage registered members, dues, project pledges, and monthly collections for ${escapeHtml(activeCollectionType)}.`;
        if (regBtn) regBtn.innerHTML = `<i class="fas fa-user-plus"></i> Register Contributor`;
        if (payBtn) payBtn.innerHTML = `<i class="fas fa-receipt"></i> Record Collection`;
      }

      // INSTANT 0ms: Render active card selection, live KPIs, filtered table matrix and select options immediately!
      applyActiveCollectionTypeUI();

      populateCollectionTypeDropdowns();

      // Silent background re-sync
      loadPartnershipMatrix(null, true);
    }

    function populateCollectionTypeDropdowns() {
      const regSelect = document.getElementById('adminRegPartnerCollectionType');
      const paySelect = document.getElementById('adminPayCollectionType');

      const types = (cachedCollectionTypes && cachedCollectionTypes.length > 0)
        ? cachedCollectionTypes
        : [
            { id: 'welfare', name: 'Welfare' },
            { id: 'partnership', name: 'Partnership' }
          ];

      const optionsHtml = types.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join('');

      if (regSelect) {
        regSelect.innerHTML = optionsHtml;
        regSelect.value = activeCollectionType;
      }
      if (paySelect) {
        paySelect.innerHTML = optionsHtml;
        paySelect.value = activeCollectionType;
      }
    }

    function filterAdminPayPartnerOptions(colType) {
      const select = document.getElementById('adminPayPartnerSelect');
      if (!select) return;

      const list = (cachedPartnersListAdmin && cachedPartnersListAdmin.length > 0)
        ? cachedPartnersListAdmin
        : (rawPartnershipMatrix || []).map(m => ({ id: m.partnerId, memberName: m.memberName, phone: m.phone, pledgeAmount: m.pledgeAmount, collectionType: m.collectionType }));

      const filtered = colType
        ? list.filter(p => (p.collectionType || 'Partnership').toLowerCase() === colType.toLowerCase())
        : list;

      const displayList = filtered.length > 0 ? filtered : list;

      select.innerHTML = '<option value="">-- Choose Member / Contributor --</option>' +
        displayList.map(p => `
          <option value="${p.id}" data-name="${escapeHtml(p.memberName)}" data-pledge="${p.pledgeAmount || 0}">
            ${escapeHtml(p.memberName)} (${p.phone || 'No phone'}) · GHS ${Number(p.pledgeAmount || 0).toFixed(2)}/mo
          </option>
        `).join('');
    }

    function openCreateCollectionTypeModal() {
      const modal = document.getElementById('createCollectionTypeModal');
      if (!modal) return;
      document.getElementById('newColName').value = '';
      document.getElementById('newColCategory').value = 'Ministry Department';
      document.getElementById('newColDesc').value = '';
      document.getElementById('newColColor').value = '#059669';
      modal.style.display = 'flex';
      modal.classList.add('active');
      setTimeout(() => {
        const nameInput = document.getElementById('newColName');
        if (nameInput) nameInput.focus();
      }, 50);
    }

    function closeCreateCollectionTypeModal() {
      const modal = document.getElementById('createCollectionTypeModal');
      if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
      }
    }

    async function handleCreateCollectionTypeSubmit(e) {
      e.preventDefault();
      const name = document.getElementById('newColName').value.trim();
      const category = document.getElementById('newColCategory').value.trim();
      const frequency = document.getElementById('newColFrequency').value;
      const description = document.getElementById('newColDesc').value.trim();
      const color = document.getElementById('newColColor').value;

      if (!name) {
        showToast('Please enter a collection type name.', 'error', 'Name Required');
        return;
      }

      const btn = document.getElementById('btnSubmitNewColType');
      if (btn) { btn.disabled = true; btn.innerText = 'Creating fund…'; }

      try {
        const token = await getAdminAuthToken();
        const res = await fetch(`${API_BASE}/finance/collection-types`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ name, category, frequency, description, color, icon: 'fas fa-layer-group' })
        });

        if (res.ok) {
          closeCreateCollectionTypeModal();
          showToast(`Collection fund <strong>${escapeHtml(name)}</strong> created successfully!`, 'success', 'Fund Created');
          activeCollectionType = name;
          await loadPartnershipMatrix();
        } else {
          const err = await res.json();
          showToast(err.error || 'Failed to create collection fund.', 'error', 'Creation Failed');
        }
      } catch (err) {
        showToast('Network error creating collection fund.', 'error', 'Network Error');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus-circle"></i> Create Collection Fund'; }
      }
    }

    async function deleteCustomCollectionType(typeId, typeName) {
      if (!confirm(`Are you sure you want to delete the "${typeName}" collection type?\n\nExisting contribution logs will remain safely stored.`)) {
        return;
      }

      try {
        const token = await getAdminAuthToken();
        const res = await fetch(`${API_BASE}/finance/collection-types/${typeId}`, {
          method: 'DELETE',
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });

        if (res.ok) {
          showToast(`Collection type "${typeName}" removed.`, 'info', 'Fund Removed');
          if (activeCollectionType.toLowerCase() === typeName.toLowerCase()) {
            activeCollectionType = 'Partnership';
          }
          await loadPartnershipMatrix();
        } else {
          const err = await res.json();
          showToast(err.error || 'Failed to delete collection type.', 'error', 'Delete Failed');
        }
      } catch (err) {
        showToast('Network error removing collection type.', 'error', 'Network Error');
      }
    }

    function renderPartnershipMatrix() {
      const tbody = document.getElementById('partnershipMatrixTableBody');
      const mobileWrap = document.getElementById('partnershipMobileCards');
      if (!tbody) return;

      const statusFilter = document.getElementById('partnerStatusFilter')?.value || 'ALL';
      const searchFilter = (document.getElementById('partnerSearchFilter')?.value || '').trim().toLowerCase();
      const currentMonthNum = new Date().getMonth() + 1;
      const curMonthKey = String(currentMonthNum).padStart(2, '0');

      let filtered = (rawPartnershipMatrix || []).filter(item => {
        // Search filter
        if (searchFilter) {
          const matchName = (item.memberName || '').toLowerCase().includes(searchFilter);
          const matchPhone = (item.phone || '').toLowerCase().includes(searchFilter);
          if (!matchName && !matchPhone) return false;
        }

        // Status filter for current month
        if (statusFilter !== 'ALL') {
          const curStatus = item.monthlyStatus && item.monthlyStatus[curMonthKey] ? item.monthlyStatus[curMonthKey].status : '';
          if (statusFilter === 'PAID' && curStatus !== 'PAID') return false;
          if (statusFilter === 'MISSED' && curStatus !== 'MISSED' && curStatus !== 'DUE') return false;
          if (statusFilter === 'PARTIAL' && curStatus !== 'PARTIAL') return false;
        }

        return true;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="18" style="padding: 36px; text-align: center; color: var(--muted);">No records found in <strong>${escapeHtml(activeCollectionType)}</strong> matching your filter.</td></tr>`;
        if (mobileWrap) mobileWrap.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--muted); background:white; border-radius:8px;">No records found in ${escapeHtml(activeCollectionType)}.</div>`;
        return;
      }

      const monthKeys = ['01','02','03','04','05','06','07','08','09','10','11','12'];

      // Render Desktop Matrix Table
      tbody.innerHTML = filtered.map((item, idx) => {
        const monthCells = monthKeys.map(k => {
          const mInfo = (item.monthlyStatus && item.monthlyStatus[k]) || { status: 'PENDING', paid: 0, pledge: item.pledgeAmount };
          let badge = `<span style="color:#94a3b8; font-size:11px;">—</span>`;

          if (mInfo.status === 'PAID') {
            badge = `<span style="background:#d1fae5; color:#065f46; font-weight:800; font-size:10.5px; padding:3px 5px; border-radius:4px; display:inline-block;" title="GHS ${mInfo.paid.toFixed(2)} Paid in Full">✓ ${mInfo.paid >= 1000 ? (mInfo.paid/1000).toFixed(1)+'k' : mInfo.paid.toFixed(0)}</span>`;
          } else if (mInfo.status === 'PARTIAL') {
            badge = `<span style="background:#fef3c7; color:#92400e; font-weight:800; font-size:10.5px; padding:3px 5px; border-radius:4px; display:inline-block;" title="Partial: GHS ${mInfo.paid.toFixed(2)} of GHS ${mInfo.pledge.toFixed(2)}">~ ${mInfo.paid.toFixed(0)}</span>`;
          } else if (mInfo.status === 'MISSED') {
            badge = `<span style="background:#fee2e2; color:#991b1b; font-weight:800; font-size:10.5px; padding:3px 5px; border-radius:4px; display:inline-block;" title="Missed Payment: GHS 0.00">✕ Miss</span>`;
          } else if (mInfo.status === 'DUE') {
            badge = `<span style="background:#dbeafe; color:#1e40af; font-weight:800; font-size:10.5px; padding:3px 5px; border-radius:4px; display:inline-block;" title="Payment Due This Month">Due</span>`;
          }

          return `<td style="text-align: center; padding: 8px 4px;">${badge}</td>`;
        }).join('');

        return `
          <tr style="border-bottom: 1px solid var(--line);">
            <td>${idx + 1}</td>
            <td><strong>${escapeHtml(item.memberName)}</strong></td>
            <td style="color: var(--muted); font-size: 12px;">${escapeHtml(item.phone || '—')}</td>
            <td><strong style="color: var(--gold);">GHS ${(item.pledgeAmount || 0).toFixed(2)}</strong></td>
            <td><strong style="color: var(--emerald); font-size: 13px;">GHS ${(item.yearTotalPaid || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></td>
            ${monthCells}
            <td style="text-align: center;">
              <div style="display: flex; gap: 4px; justify-content: center;">
                <button type="button" class="btn-main" style="padding: 4px 8px; font-size: 11px; background: var(--ink);" onclick="viewPartnerHistory('${item.partnerId}')" title="View Full Payment Ledger">
                  <i class="fas fa-list-check"></i> History
                </button>
                <button type="button" class="btn-main" style="padding: 4px 8px; font-size: 11px; background: var(--emerald-dark);" onclick="openAdminRecordPaymentModal('${item.partnerId}')" title="Record Payment">
                  <i class="fas fa-plus"></i> Pay
                </button>
                <button type="button" class="btn-main" style="padding: 4px 8px; font-size: 11px; background: #c5221f;" onclick="deletePartnerFromAdmin('${item.partnerId}')" title="Remove Record">
                  <i class="fas fa-trash-alt"></i>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      // Render Mobile Cards
      if (mobileWrap) {
        mobileWrap.innerHTML = filtered.map((item, idx) => {
          const curStatusInfo = (item.monthlyStatus && item.monthlyStatus[curMonthKey]) || { status: 'PENDING', paid: 0 };
          let statusBadge = `<span style="background:#f1f5f9; color:#475569; font-size:11px; font-weight:700; padding:3px 8px; border-radius:4px;">Pending</span>`;
          if (curStatusInfo.status === 'PAID') statusBadge = `<span style="background:#d1fae5; color:#065f46; font-size:11px; font-weight:800; padding:3px 8px; border-radius:4px;">Paid in Full</span>`;
          if (curStatusInfo.status === 'PARTIAL') statusBadge = `<span style="background:#fef3c7; color:#92400e; font-size:11px; font-weight:800; padding:3px 8px; border-radius:4px;">Partial (GHS ${curStatusInfo.paid.toFixed(2)})</span>`;
          if (curStatusInfo.status === 'MISSED') statusBadge = `<span style="background:#fee2e2; color:#991b1b; font-size:11px; font-weight:800; padding:3px 8px; border-radius:4px;">Missed Payment</span>`;
          if (curStatusInfo.status === 'DUE') statusBadge = `<span style="background:#dbeafe; color:#1e40af; font-size:11px; font-weight:800; padding:3px 8px; border-radius:4px;">Payment Due</span>`;

          return `
            <div class="admin-card" style="margin-bottom: 0; padding: 14px 16px; border: 1px solid var(--line);">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <div>
                  <strong style="font-size: 14px; color: var(--ink);">${escapeHtml(item.memberName)}</strong>
                  <div style="font-size: 12px; color: var(--muted);">${escapeHtml(item.phone || 'No phone recorded')}</div>
                </div>
                ${statusBadge}
              </div>

              <div style="display: flex; justify-content: space-between; background: #f8fafc; padding: 8px 12px; border-radius: 6px; font-size: 12.5px; margin-bottom: 12px;">
                <div>Monthly Pledge: <strong style="color:var(--gold);">GHS ${(item.pledgeAmount || 0).toFixed(2)}</strong></div>
                <div>Year Total: <strong style="color:var(--emerald);">GHS ${(item.yearTotalPaid || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></div>
              </div>

              <div style="display: flex; gap: 6px;">
                <button type="button" class="btn-main" style="flex: 1; justify-content: center; padding: 6px; font-size: 12px; background: var(--emerald-dark);" onclick="openAdminRecordPaymentModal('${item.partnerId}')">
                  <i class="fas fa-receipt"></i> Pay
                </button>
                <button type="button" class="btn-main" style="padding: 6px 12px; font-size: 12px; background: var(--ink);" onclick="viewPartnerHistory('${item.partnerId}')">
                  History
                </button>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    function filterPartnershipMatrix() {
      renderPartnershipMatrix();
    }

    function populateAdminPartnerSelectOptions() {
      filterAdminPayPartnerOptions(document.getElementById('adminPayCollectionType')?.value || activeCollectionType);
    }

    function handleAdminPartnerSelectChange(partnerId) {
      const list = (cachedPartnersListAdmin && cachedPartnersListAdmin.length > 0)
        ? cachedPartnersListAdmin
        : (rawPartnershipMatrix || []).map(m => ({ id: m.partnerId, memberName: m.memberName, phone: m.phone, pledgeAmount: m.pledgeAmount }));

      const partner = list.find(p => p.id === partnerId);
      if (partner) {
        const amtInput = document.getElementById('adminPayAmount');
        if (amtInput) amtInput.value = partner.pledgeAmount || '';
      }
    }

    function openAdminRegisterPartnerModal() {
      const modal = document.getElementById('adminRegisterPartnerModal');
      if (!modal) return;
      populateCollectionTypeDropdowns();
      const colSelect = document.getElementById('adminRegPartnerCollectionType');
      if (colSelect) colSelect.value = activeCollectionType;

      document.getElementById('adminRegPartnerName').value = '';
      document.getElementById('adminRegPartnerPhone').value = '';
      document.getElementById('adminRegPartnerPledge').value = '';
      document.getElementById('adminRegPartnerStartDate').value = formatLocalDate(new Date());
      document.getElementById('adminRegPartnerNotes').value = '';
      modal.style.display = 'flex';
      modal.classList.add('active');
      setTimeout(() => {
        const nameInput = document.getElementById('adminRegPartnerName');
        if (nameInput) nameInput.focus();
      }, 50);
    }

    function closeAdminRegisterPartnerModal() {
      const modal = document.getElementById('adminRegisterPartnerModal');
      if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
      }
    }

    async function handleAdminSavePartnerSubmit(e) {
      e.preventDefault();
      const collectionType = document.getElementById('adminRegPartnerCollectionType')?.value || activeCollectionType;
      const memberName = document.getElementById('adminRegPartnerName').value.trim();
      const phone = document.getElementById('adminRegPartnerPhone').value.trim();
      const pledgeAmount = parseFloat(document.getElementById('adminRegPartnerPledge').value) || 0;
      const startDate = document.getElementById('adminRegPartnerStartDate').value;
      const notes = document.getElementById('adminRegPartnerNotes').value.trim();

      if (!memberName || pledgeAmount <= 0) {
        showToast('Please enter name and a valid monthly amount.', 'error', 'Invalid Input');
        return;
      }

      const btn = document.getElementById('btnAdminSubmitPartner');
      if (btn) { btn.disabled = true; btn.innerText = 'Saving record…'; }

      try {
        const token = await getAdminAuthToken();
        const res = await fetch(`${API_BASE}/finance/partners`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ collectionType, memberName, phone, pledgeAmount, startDate, notes })
        });

        if (res.ok) {
          closeAdminRegisterPartnerModal();
          showToast(`Record for <strong>${escapeHtml(memberName)}</strong> saved to <strong>${escapeHtml(collectionType)}</strong>!`, 'success', 'Saved Successfully');
          loadPartnershipMatrix();
        } else {
          const err = await res.json();
          showToast(err.error || 'Failed to save record.', 'error', 'Save Failed');
        }
      } catch (err) {
        showToast('Network error saving record.', 'error', 'Network Error');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-handshake"></i> Save Contributor Record'; }
      }
    }

    function openAdminRecordPaymentModal(partnerId) {
      const modal = document.getElementById('adminRecordPartnerPaymentModal');
      if (!modal) return;
      populateCollectionTypeDropdowns();
      const colSelect = document.getElementById('adminPayCollectionType');
      if (colSelect) colSelect.value = activeCollectionType;

      populateAdminPartnerSelectOptions();

      const now = new Date();
      const curMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const targetMonthInput = document.getElementById('adminPayTargetMonth');
      if (targetMonthInput) targetMonthInput.value = curMonthStr;

      const dateInput = document.getElementById('adminPayDate');
      if (dateInput) dateInput.value = formatLocalDate(now);

      const notesInput = document.getElementById('adminPayNotes');
      if (notesInput) notesInput.value = '';

      const amtInput = document.getElementById('adminPayAmount');
      if (amtInput) amtInput.value = '';

      if (partnerId) {
        const select = document.getElementById('adminPayPartnerSelect');
        if (select) {
          select.value = partnerId;
          handleAdminPartnerSelectChange(partnerId);
        }
      }

      modal.style.display = 'flex';
      modal.classList.add('active');
    }

    function closeAdminRecordPaymentModal() {
      const modal = document.getElementById('adminRecordPartnerPaymentModal');
      if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
      }
    }

    async function handleAdminSavePartnerPaymentSubmit(e) {
      e.preventDefault();
      const collectionType = document.getElementById('adminPayCollectionType')?.value || activeCollectionType;
      const partnerId = document.getElementById('adminPayPartnerSelect').value;
      const targetMonth = document.getElementById('adminPayTargetMonth').value;
      const amount = parseFloat(document.getElementById('adminPayAmount').value) || 0;
      const paymentMethod = document.getElementById('adminPayMethod').value;
      const paymentDate = document.getElementById('adminPayDate').value;
      const notes = document.getElementById('adminPayNotes').value.trim();

      const list = (cachedPartnersListAdmin && cachedPartnersListAdmin.length > 0)
        ? cachedPartnersListAdmin
        : (rawPartnershipMatrix || []).map(m => ({ id: m.partnerId, memberName: m.memberName, phone: m.phone, pledgeAmount: m.pledgeAmount }));

      const partner = list.find(p => p.id === partnerId);
      const memberName = partner ? partner.memberName : 'Member';

      if (!partnerId || amount <= 0 || !targetMonth) {
        showToast('Please fill all required payment fields.', 'error', 'Fields Required');
        return;
      }

      const btn = document.getElementById('btnAdminSubmitPay');
      if (btn) { btn.disabled = true; btn.innerText = 'Recording payment…'; }

      try {
        const token = await getAdminAuthToken();
        const res = await fetch(`${API_BASE}/finance/partnerships/payments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({
            partnerId, memberName, amount, targetMonth, paymentDate, paymentMethod, collectionType, recordedBy: 'Super Admin', notes
          })
        });

        if (res.ok) {
          closeAdminRecordPaymentModal();
          showToast(`Contribution of <strong>GHS ${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong> for <strong>${escapeHtml(memberName)}</strong> saved to <strong>${escapeHtml(collectionType)}</strong>!`, 'success', 'Payment Recorded');
          loadPartnershipMatrix();
        } else {
          const err = await res.json();
          showToast(err.error || 'Failed to record payment.', 'error', 'Payment Failed');
        }
      } catch (err) {
        showToast('Network error recording payment.', 'error', 'Network Error');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-receipt"></i> Save Payment Record'; }
      }
    }

    async function viewPartnerHistory(partnerId) {
      const modal = document.getElementById('adminPartnerHistoryModal');
      if (!modal) return;

      const partner = (rawPartnershipMatrix || []).find(p => p.partnerId === partnerId) || 
                      (cachedPartnersListAdmin || []).find(p => p.id === partnerId);
      if (!partner) return;

      document.getElementById('partnerHistoryName').innerText = partner.memberName || 'Partner History';
      document.getElementById('partnerHistoryPhone').innerText = `Phone: ${partner.phone || 'No phone recorded'}`;
      document.getElementById('partnerHistoryTotal').innerText = `GHS ${(partner.yearTotalPaid || partner.totalContributed || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

      const tbody = document.getElementById('partnerHistoryTableBody');
      tbody.innerHTML = `<tr><td colspan="5" style="padding:20px; text-align:center; color:var(--muted);">Loading payment transactions…</td></tr>`;
      modal.style.display = 'flex';
      modal.classList.add('active');

      try {
        const token = await getAdminAuthToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/finance/partnerships/payments?partnerId=${partnerId}`, { headers });
        if (res.ok) {
          const payments = await res.json();
          if (Array.isArray(payments) && payments.length > 0) {
            tbody.innerHTML = payments.map(p => `
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 10px 12px; color: var(--muted);">${p.paymentDate || '—'}</td>
                <td style="padding: 10px 12px;"><span style="background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 11.5px;">${p.targetMonth || '—'}</span></td>
                <td style="padding: 10px 12px;"><strong style="color: var(--emerald-dark);">GHS ${(Number(p.amount) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></td>
                <td style="padding: 10px 12px;"><span style="font-size: 11px; font-weight: 700; text-transform: uppercase;">${p.paymentMethod || 'CASH'}</span></td>
                <td style="padding: 10px 12px; font-size: 12px; color: var(--muted);">${escapeHtml(p.recordedBy || 'Treasury')}</td>
              </tr>
            `).join('');
            return;
          }
        }
      } catch (err) {}

      tbody.innerHTML = `<tr><td colspan="5" style="padding:24px; text-align:center; color:var(--muted);">No payment records found for this partner.</td></tr>`;
    }

    function closePartnerHistoryModal() {
      const modal = document.getElementById('adminPartnerHistoryModal');
      if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
      }
    }

    function deletePartnerFromAdmin(partnerId) {
      showConfirmModal(
        'Remove Covenant Partner',
        'Are you sure you want to remove this partner? Historical payment ledger entries will be preserved in the financial database.',
        async () => {
          try {
            const token = await getAdminAuthToken();
            await fetch(`${API_BASE}/finance/partners/${partnerId}`, {
              method: 'DELETE',
              headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
            showToast('Partner record removed from active list.', 'info', 'Partner Removed');
            loadPartnershipMatrix();
          } catch (e) {
            showToast('Error removing partner.', 'error', 'Error');
          }
        },
        'fas fa-trash-alt',
        'Remove Partner',
        '#c5221f'
      );
    }

    function downloadPartnershipExcelReport() {
      if (!rawPartnershipMatrix || rawPartnershipMatrix.length === 0) {
        showToast(`No ${activeCollectionType} records available to export.`, 'warning', 'No Data');
        return;
      }

      const headers = ['#', 'Contributor Name', 'Phone Number', 'Monthly Pledge / Dues (GHS)', 'Year Total Paid (GHS)', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthKeys = ['01','02','03','04','05','06','07','08','09','10','11','12'];

      const rows = rawPartnershipMatrix.map((p, i) => {
        const mStatuses = monthKeys.map(k => {
          const m = (p.monthlyStatus && p.monthlyStatus[k]) || { status: 'PENDING', paid: 0 };
          return `${m.status} (GHS ${m.paid.toFixed(2)})`;
        });

        return [
          i + 1,
          `"${(p.memberName || '').replace(/"/g, '""')}"`,
          `"${(p.phone || '').replace(/"/g, '""')}"`,
          (p.pledgeAmount || 0).toFixed(2),
          (p.yearTotalPaid || 0).toFixed(2),
          ...mStatuses.map(s => `"${s}"`)
        ].join(',');
      });

      const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeColName = (activeCollectionType || 'Partnership').replace(/[^A-Za-z0-9]/g, '_');
      a.href = url;
      a.download = `SFMI_${safeColName}_Ledger_${currentMatrixYear}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`${activeCollectionType} ledger spreadsheet exported successfully!`, 'success', 'Excel Exported');
    }

    /* ── CUSTOM CONFIRMATION MODAL SYSTEM ── */
    let _confirmCallback = null;
    let _confirmResolver = null;

    function showConfirmModal(title, text, callbackOrBtnText, iconClass = 'fas fa-sign-out-alt', btnText = 'Proceed', btnColor = '#c5221f') {
      return new Promise((resolve) => {
        _confirmResolver = resolve;
        _confirmCallback = null;

        let finalIcon = iconClass;
        let finalBtnText = btnText;
        let finalBtnColor = btnColor;

        if (typeof callbackOrBtnText === 'function') {
          _confirmCallback = callbackOrBtnText;
        } else if (typeof callbackOrBtnText === 'string') {
          finalBtnText = callbackOrBtnText;
          if (iconClass === 'fas fa-sign-out-alt') {
            finalIcon = 'fas fa-paper-plane';
            finalBtnColor = '#0284c7';
          }
        }

        const titleEl = document.getElementById('confirmModalTitle');
        const textEl = document.getElementById('confirmModalText');
        const okBtn = document.getElementById('confirmModalOkBtn');
        const icon = document.getElementById('confirmModalIcon');
        const iconWrap = document.getElementById('confirmModalIconWrap');
        const modal = document.getElementById('customConfirmModal');

        if (titleEl) titleEl.innerText = title || 'Confirm Action';
        if (textEl) {
          if (typeof text === 'string' && text.includes('<') && text.includes('>')) {
            textEl.textContent = text;
          } else {
            textEl.innerText = text || '';
          }
        }
        if (okBtn) {
          okBtn.innerText = finalBtnText;
          okBtn.style.background = finalBtnColor;
          okBtn.style.borderColor = finalBtnColor;
        }
        if (icon) icon.className = finalIcon;
        if (iconWrap) {
          if (finalBtnColor === '#0284c7' || finalBtnColor === 'var(--primary)') {
            iconWrap.style.background = '#e0f2fe';
            iconWrap.style.color = '#0284c7';
          } else if (finalBtnColor === '#16a34a' || finalBtnColor === '#22c55e') {
            iconWrap.style.background = '#dcfce7';
            iconWrap.style.color = '#16a34a';
          } else {
            iconWrap.style.background = '#fff1f2';
            iconWrap.style.color = '#e11d48';
          }
        }
        if (modal) modal.style.display = 'flex';
      });
    }

    function closeCustomConfirmModal(confirmed) {
      const modal = document.getElementById('customConfirmModal');
      if (modal) modal.style.display = 'none';

      const cb = _confirmCallback;
      const res = _confirmResolver;
      _confirmCallback = null;
      _confirmResolver = null;

      if (confirmed && typeof cb === 'function') {
        cb();
      }
      if (typeof res === 'function') {
        res(Boolean(confirmed));
      }
    }

    /* TOAST NOTIFICATION SYSTEM */
    function showToast(message, type = 'success', title = '') {
      let container = document.getElementById('toastContainer');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
      }

      const icons = {
        success: 'fas fa-circle-check',
        warning: 'fas fa-triangle-exclamation',
        error: 'fas fa-circle-exclamation',
        info: 'fas fa-circle-info'
      };

      const defaultTitles = {
        success: 'Success Notification',
        warning: 'Attention Needed',
        error: 'Action Error',
        info: 'System Update'
      };

      const toast = document.createElement('div');
      toast.className = `toast-msg toast-${type}`;
      toast.innerHTML = `
        <i class="${icons[type] || icons.success} toast-icon"></i>
        <div class="toast-body">
          <div class="toast-title">${title || defaultTitles[type]}</div>
          <div class="toast-text">${message}</div>
        </div>
        <button class="toast-close" onclick="dismissToast(this.parentElement)">✕</button>
        <div class="toast-progress"></div>
      `;

      container.appendChild(toast);

      setTimeout(() => {
        dismissToast(toast);
      }, 4500);
    }

    function dismissToast(toastEl) {
      if (!toastEl || toastEl.isRemoving) return;
      toastEl.isRemoving = true;
      toastEl.style.animation = 'toastSlideOut 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards';
      setTimeout(() => {
        if (toastEl.parentElement) {
          toastEl.parentElement.removeChild(toastEl);
        }
      }, 300);
    }
  
    /* ══════════════════════════════════════════════════════════════════════
       VISITORS & FIRST-TIMERS MANAGEMENT HUB (ALL SERVICES AGGREGATION)
       ══════════════════════════════════════════════════════════════════════ */
    let rawVisitorsData = [];
    let processedVisitorsList = [];

    function syncVisitorsViewMode() {
      const isMobile = window.innerWidth <= 800;
      const tbl = document.querySelector("#secVisitors .table-responsive");
      const cards = document.getElementById("visitorsMobileCards");
      if (tbl) tbl.style.display = isMobile ? "none" : "block";
      if (cards) cards.style.display = isMobile ? "block" : "none";
    }
    window.addEventListener("resize", syncVisitorsViewMode);

    function compileVisitorsFromState() {
      const list = [];
      const seen = new Set();

      // 1. Gather all visitor entries from serviceAttendanceMap across ALL services & dates
      Object.keys(serviceAttendanceMap).forEach(key => {
        if (key.startsWith("ALL_")) return; // skip aggregates
        const atts = serviceAttendanceMap[key] || [];
        atts.forEach(item => {
          const isGuest = Boolean(
            item.isGuest ||
            item.member?.isGuest ||
            (item.role && (item.role.toLowerCase().includes("visitor") || item.role.toLowerCase().includes("first timer") || item.role.toLowerCase().includes("first-timer"))) ||
            (item.category && (item.category.toLowerCase().includes("visitor") || item.category.toLowerCase().includes("guest") || item.category.toLowerCase().includes("first timer") || item.category.toLowerCase().includes("first-timer")))
          );

          if (isGuest) {
            const fName = item.firstName || (item.name ? item.name.split(" ")[0] : "Visitor");
            const lName = item.lastName || (item.name ? item.name.split(" ").slice(1).join(" ") : "Guest");
            const fullName = `${fName} ${lName}`.trim() || item.name || "Visitor Guest";
            const sName = canonicalServiceName(item.serviceName || key.split("_")[0]);
            const dStr = item.dateStr || formatLocalDate(item.checkedInAt || Date.now());
            const uniqueKey = `${fullName.toLowerCase()}_${(item.phone || "").trim()}_${dStr}_${sName}`;

            if (!seen.has(uniqueKey)) {
              seen.add(uniqueKey);
              list.push({
                id: item.id || item.memberId || ("vis_" + Math.random().toString(36).substr(2, 9)),
                memberId: item.memberId || item.member?.id || null,
                name: fullName,
                firstName: fName,
                lastName: lName,
                phone: item.phone || item.member?.phone || "—",
                gender: item.gender || item.member?.gender || "Not specified",
                address: item.address || item.member?.address || "—",
                serviceName: sName,
                dateStr: dStr,
                time: item.time || (item.checkedInAt ? new Date(item.checkedInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Today"),
                method: item.method || "KIOSK",
                guardian: item.guardian || item.member?.guardian || "",
                category: item.category || "Visitor / Guest",
                role: item.role || "Visitor / First Timer",
                photoUrl: item.photoUrl || item.member?.photoUrl || null
              });
            }
          }
        });
      });

      // 2. Also incorporate registered visitors from allMembers
      allMembers.forEach(m => {
        const isGuest = Boolean(
          m.isGuest ||
          (m.role && (m.role.toLowerCase().includes("visitor") || m.role.toLowerCase().includes("first timer") || m.role.toLowerCase().includes("first-timer"))) ||
          (m.category && (m.category.toLowerCase().includes("visitor") || m.category.toLowerCase().includes("guest") || m.category.toLowerCase().includes("first timer") || m.category.toLowerCase().includes("first-timer")))
        );

        if (isGuest) {
          const fullName = `${m.firstName} ${m.lastName}`.trim();
          const already = list.some(v => (v.memberId && v.memberId === m.id) || (v.phone && v.phone !== "—" && v.phone === m.phone) || v.name.toLowerCase() === fullName.toLowerCase());
          if (!already) {
            list.push({
              id: m.id,
              memberId: m.id,
              name: fullName,
              firstName: m.firstName,
              lastName: m.lastName,
              phone: m.phone || "—",
              gender: m.gender || "Not specified",
              address: m.address || "—",
              serviceName: "Sunday: Family & Friends Service",
              dateStr: m.createdAt ? formatLocalDate(m.createdAt) : formatLocalDate(new Date()),
              time: "First Visit",
              method: "REGISTRATION",
              guardian: m.guardian || "",
              category: m.category || "Visitor / Guest",
              role: m.role || "Visitor / First Timer",
              photoUrl: m.photoUrl || null
            });
          }
        }
      });

      return list;
    }

    async function loadVisitorsData() {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${API_BASE}/attendance/visitors`, { headers });
        if (res.ok) {
          const json = await res.json();
          if (json) {
            const defaultFallbackSvc = localStorage.getItem('sfmi_active_kiosk_service') || (new Date().getDay() === 5 ? 'Friday: Prophetic Healing & Deliverance' : (new Date().getDay() === 3 ? 'Wednesday: Time with the Lord' : 'Sunday: Family & Friends Service'));
            const backendVisits = [];
            if (Array.isArray(json.attendances)) {
              json.attendances.forEach(a => {
                const m = a.member || {};
                // Strictly exclude converted or regular church members
                if (m && (m.category === 'Adult' || m.category === 'Youth' || m.category === 'Child') && !isGuestMember(m)) return;
                const svcName = canonicalServiceName(a.service?.serviceType?.name || defaultFallbackSvc);
                const dStr = formatLocalDate(a.checkedInAt || a.service?.serviceDate || Date.now());
                backendVisits.push({
                  id: a.id || a.memberId,
                  memberId: a.memberId || m.id,
                  name: `${m.firstName || ""} ${m.lastName || ""}`.trim() || "Visitor Guest",
                  firstName: m.firstName || "Visitor",
                  lastName: m.lastName || "Guest",
                  phone: m.phone || "—",
                  gender: m.gender || "Not specified",
                  address: m.address || "—",
                  serviceName: svcName,
                  dateStr: dStr,
                  time: a.checkedInAt ? new Date(a.checkedInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Today",
                  method: a.method || "KIOSK",
                  guardian: m.guardian || "",
                  category: m.category || "Visitor / Guest",
                  role: m.role || "Visitor / First Timer",
                  photoUrl: m.photoUrl || null
                });
              });
            }

            if (Array.isArray(json.visitors)) {
              json.visitors.forEach(v => {
                if (v && (v.category === 'Adult' || v.category === 'Youth' || v.category === 'Child') && !isGuestMember(v)) return;
                const fullName = `${v.firstName || ""} ${v.lastName || ""}`.trim() || "Visitor Guest";
                const already = backendVisits.some(b => (b.memberId && b.memberId === v.id) || (b.phone && b.phone !== "—" && b.phone === v.phone) || b.name.toLowerCase() === fullName.toLowerCase());
                if (!already) {
                  backendVisits.push({
                    id: v.id,
                    memberId: v.id,
                    name: fullName,
                    firstName: v.firstName || "Visitor",
                    lastName: v.lastName || "Guest",
                    phone: v.phone || "—",
                    gender: v.gender || "Not specified",
                    address: v.address || "—",
                    serviceName: defaultFallbackSvc,
                    dateStr: v.createdAt ? formatLocalDate(v.createdAt) : formatLocalDate(new Date()),
                    time: "First Visit",
                    method: "REGISTRATION",
                    guardian: v.guardian || "",
                    category: v.category || "Visitor / Guest",
                    role: v.role || "Visitor / First Timer",
                    photoUrl: v.photoUrl || null
                  });
                }
              });
            }

            rawVisitorsData = backendVisits;
          }
        }
      } catch (err) {
        console.warn("Visitors endpoint fetch fallback to state:", err);
      }

      renderVisitorsSection();
    }

    function renderVisitorsSection() {
      // 1. Populate Service Selector with dynamic church programs if empty
      const sSelect = document.getElementById("visServiceSelect");
      const progs = (typeof customPrograms !== 'undefined' && Array.isArray(customPrograms)) ? customPrograms : [];
      if (sSelect && sSelect.options.length <= 4 && progs.length > 0) {
        progs.forEach(p => {
          const canon = canonicalServiceName(p.name);
          let exists = false;
          for (let i = 0; i < sSelect.options.length; i++) {
            if (sSelect.options[i].value === canon || sSelect.options[i].value === p.name) {
              exists = true;
              break;
            }
          }
          if (!exists) {
            const opt = document.createElement("option");
            opt.value = canon;
            opt.innerText = p.name;
            sSelect.appendChild(opt);
          }
        });
      }

      // 2. Merge database visitors with live in-memory visitors
      const localVisitors = compileVisitorsFromState();
      const mergedMap = new Map();

      // Put rawVisitorsData first
      (rawVisitorsData || []).forEach(v => {
        const k = `${v.name.toLowerCase()}_${(v.phone || "").trim()}_${v.dateStr}_${v.serviceName}`;
        mergedMap.set(k, v);
      });

      // Overlay localVisitors
      localVisitors.forEach(v => {
        const k = `${v.name.toLowerCase()}_${(v.phone || "").trim()}_${v.dateStr}_${v.serviceName}`;
        if (!mergedMap.has(k)) {
          mergedMap.set(k, v);
        }
      });

      processedVisitorsList = Array.from(mergedMap.values());

      // 3. Compute Metrics
      const updateVisitorKpis = (list) => {
        const totalVisits = list.length;
        const uniqueNames = new Set(list.map(v => `${(v.name || "").toLowerCase().trim()}_${(v.phone || "").trim()}`));
        const totalUnique = uniqueNames.size;

        let sundayVisits = 0;
        let midweekVisits = 0;
        let phoneReady = 0;

        list.forEach(v => {
          const s = (v.serviceName || "").toLowerCase();
          if (s.includes("sunday") || s.includes("family") || s.includes("friends") || s.includes("weekend")) {
            sundayVisits++;
          } else {
            midweekVisits++;
          }
          if (v.phone && v.phone !== "—" && v.phone.replace(/\D/g, "").length >= 9) {
            phoneReady++;
          }
        });

        // Update KPI Stat Boxes
        const elTotal = document.getElementById("statVisTotal");
        const elVisits = document.getElementById("statVisVisits");
        const elSunday = document.getElementById("statVisSunday");
        const elMidweek = document.getElementById("statVisMidweek");
        const elPhone = document.getElementById("statVisPhone");

        if (elTotal) elTotal.innerText = totalUnique;
        if (elVisits) elVisits.innerText = totalVisits;
        if (elSunday) elSunday.innerText = sundayVisits;
        if (elMidweek) elMidweek.innerText = midweekVisits;
        if (elPhone) elPhone.innerText = `${phoneReady} Ready`;
      };

      updateVisitorKpis(processedVisitorsList);

      // 4. Apply active filters & render table
      handleVisFilterChange();
      syncVisitorsViewMode();
    }

    function handleVisFilterChange() {
      const selectedService = document.getElementById("visServiceSelect") ? document.getElementById("visServiceSelect").value : "ALL";
      const selectedDate = document.getElementById("visDateSelect") ? document.getElementById("visDateSelect").value.trim() : "";
      const searchQ = document.getElementById("visSearchInput") ? document.getElementById("visSearchInput").value.trim().toLowerCase() : "";

      let filtered = processedVisitorsList.slice();

      // Filter by Service
      if (selectedService && selectedService !== "ALL") {
        const canonTarget = canonicalServiceName(selectedService).toLowerCase();
        filtered = filtered.filter(v => {
          const vCanon = canonicalServiceName(v.serviceName).toLowerCase();
          return vCanon === canonTarget || v.serviceName.toLowerCase().includes(canonTarget);
        });
      }

      // Filter by Date
      if (selectedDate) {
        filtered = filtered.filter(v => v.dateStr === selectedDate);
      }

      // Filter by Search text
      if (searchQ) {
        filtered = filtered.filter(v => {
          return (
            v.name.toLowerCase().includes(searchQ) ||
            (v.phone && v.phone.toLowerCase().includes(searchQ)) ||
            (v.address && v.address.toLowerCase().includes(searchQ)) ||
            (v.serviceName && v.serviceName.toLowerCase().includes(searchQ)) ||
            (v.guardian && v.guardian.toLowerCase().includes(searchQ))
          );
        });
      }

      // Dynamically update KPI Stat Boxes for filtered view
      const totalVisits = filtered.length;
      const uniqueNames = new Set(filtered.map(v => `${(v.name || "").toLowerCase().trim()}_${(v.phone || "").trim()}`));
      const totalUnique = uniqueNames.size;

      let sundayVisits = 0;
      let midweekVisits = 0;
      let phoneReady = 0;

      filtered.forEach(v => {
        const s = (v.serviceName || "").toLowerCase();
        if (s.includes("sunday") || s.includes("family") || s.includes("friends") || s.includes("weekend")) {
          sundayVisits++;
        } else {
          midweekVisits++;
        }
        if (v.phone && v.phone !== "—" && v.phone.replace(/\D/g, "").length >= 9) {
          phoneReady++;
        }
      });

      const elTotal = document.getElementById("statVisTotal");
      const elVisits = document.getElementById("statVisVisits");
      const elSunday = document.getElementById("statVisSunday");
      const elMidweek = document.getElementById("statVisMidweek");
      const elPhone = document.getElementById("statVisPhone");

      if (elTotal) elTotal.innerText = totalUnique;
      if (elVisits) elVisits.innerText = totalVisits;
      if (elSunday) elSunday.innerText = sundayVisits;
      if (elMidweek) elMidweek.innerText = midweekVisits;
      if (elPhone) elPhone.innerText = `${phoneReady} Ready`;

      renderVisitorsTableHTML(filtered);
    }

    function filterVisitorsTable() {
      handleVisFilterChange();
    }

    function renderVisitorsTableHTML(list) {
      const tbody = document.getElementById("visitorsTableBody");
      const mobCards = document.getElementById("visitorsMobileCards");
      const countEl = document.getElementById("visResultsCount");

      if (countEl) {
        countEl.innerText = `Showing ${list.length} visitor${list.length === 1 ? "" : "s"}`;
      }

      if (!list || list.length === 0) {
        if (tbody) {
          tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--muted); padding: 36px 20px;">
            <i class="fas fa-user-plus" style="font-size: 28px; color: var(--accent); margin-bottom: 8px; display: block;"></i>
            No visitors found matching your filter. First-timers recorded during check-in or registration will appear here automatically across all services.
          </td></tr>`;
        }
        if (mobCards) {
          mobCards.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 28px 10px;">No visitors found.</div>`;
        }
        return;
      }

      // Render Desktop Table
      if (tbody) {
        tbody.innerHTML = list.map((v, i) => {
          const initials = `${(v.firstName || "V")[0] || ""}${(v.lastName || "")[0] || ""}`.toUpperCase();
          const avatar = v.photoUrl
            ? `<img src="${escapeHtml(v.photoUrl)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:1.5px solid var(--accent);flex-shrink:0;" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='inline-flex';" /><span style="display:none;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials}</span>`
            : `<span style="display:inline-flex;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials}</span>`;

          const gLower = (v.gender || "").trim().toLowerCase();
          const genderBadge = gLower.startsWith("m")
            ? `<span class="badge" style="background:#e0f2fe;color:#0369a1;"><i class="fa-solid fa-mars" style="margin-right:3px;"></i> Male</span>`
            : (gLower.startsWith("f")
              ? `<span class="badge" style="background:#fce7f3;color:#be185d;"><i class="fa-solid fa-venus" style="margin-right:3px;"></i> Female</span>`
              : `<span class="badge" style="background:#f1f5f9;color:#64748b;">${escapeHtml(v.gender || "—")}</span>`);

          // Service badge color
          const sLower = (v.serviceName || "").toLowerCase();
          let svcClass = "badge-emerald";
          if (sLower.includes("wednesday") || sLower.includes("time with")) svcClass = "badge-gold";
          if (sLower.includes("friday") || sLower.includes("prophetic") || sLower.includes("healing")) svcClass = "badge-blue";

          const hasValidPhone = v.phone && v.phone !== "—" && v.phone.replace(/\D/g, "").length >= 9;
          const cleanPhone = hasValidPhone ? v.phone.replace(/\D/g, "") : "";
          const intlPhone = cleanPhone.startsWith("0") ? ("233" + cleanPhone.slice(1)) : (cleanPhone.startsWith("233") ? cleanPhone : ("233" + cleanPhone));

          const phoneHtml = hasValidPhone
            ? `<div style="display: flex; align-items: center; gap: 8px;">
                <a href="tel:${escapeHtml(v.phone)}" style="color: var(--ink); text-decoration: none; font-weight: 600;" title="Call visitor">
                  <i class="fas fa-phone-flip" style="color: var(--emerald); font-size: 11px; margin-right: 4px;"></i>${escapeHtml(v.phone)}
                </a>
              </div>`
            : `<span style="color: var(--muted);">—</span>`;

          return `<tr>
            <td>${i + 1}</td>
            <td>
              <div style="display:flex;align-items:center;gap:10px;">
                ${avatar}
                <div>
                  <div style="font-weight: 700; color: var(--ink);">${escapeHtml(v.name)}</div>
                  <span class="badge badge-gold" style="font-size: 10px; padding: 1px 6px; margin-top: 2px; display: inline-block;">${escapeHtml(v.role || "Visitor / First Timer")}</span>
                </div>
              </div>
            </td>
            <td><span class="badge ${svcClass}">${escapeHtml(v.serviceName)}</span></td>
            <td>
              <div style="font-weight: 600;">${escapeHtml(v.dateStr)}</div>
              <div style="font-size: 11px; color: var(--muted);"><i class="far fa-clock"></i> ${escapeHtml(v.time)}</div>
            </td>
            <td>${phoneHtml}</td>
            <td>${genderBadge}</td>
            <td>${v.address && v.address !== "—" ? `<span><i class="fa-solid fa-location-dot" style="margin-right:4px; color:var(--muted);"></i> ${escapeHtml(v.address)}</span>` : `<span style="color:var(--muted);">—</span>`}</td>
            <td><span class="badge badge-method">${escapeHtml(v.method || "KIOSK")}</span></td>
            <td>
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <button type="button" class="btn-ghost" style="padding: 4px 8px; font-size: 11px; font-weight: 600; color: #1e293b; border-color: #cbd5e1; background: #f8fafc;" onclick="openEditMemberModal('${escapeHtml(v.memberId || v.id)}')" title="Edit Visitor Name or Details">
                  <i class="fas fa-edit" style="color: var(--accent);"></i> Edit
                </button>
                ${hasValidPhone ? `
                  <button type="button" class="btn-ghost" style="padding: 4px 8px; font-size: 11px; color: #059669; border-color: #a7f3d0; background: #ecfdf5;" onclick="openWhatsAppToVisitor('${escapeHtml(intlPhone)}', '${escapeHtml(v.name)}')" title="Send Welcome WhatsApp">
                    <i class="fa-brands fa-whatsapp" style="font-size: 13px;"></i> WhatsApp
                  </button>
                  <a href="tel:${escapeHtml(v.phone)}" class="btn-ghost" style="padding: 4px 8px; font-size: 11px; text-decoration: none; display: inline-flex; align-items: center; gap: 4px;" title="Call phone">
                    <i class="fas fa-phone" style="font-size: 11px;"></i> Call
                  </a>
                ` : ""}
                ${v.memberId ? `
                  <button type="button" class="btn-preset" style="padding: 4px 8px; font-size: 11px; font-weight: 700; color: var(--emerald-dark); border-color: var(--accent);" onclick="convertVisitorToMember('${escapeHtml(v.memberId)}', '${escapeHtml(v.name)}')" title="Convert to Full Member">
                    <i class="fas fa-user-check"></i> Make Member
                  </button>
                ` : ""}
              </div>
            </td>
          </tr>`;
        }).join("");
      }

      // Render Mobile Cards View
      if (mobCards) {
        mobCards.innerHTML = list.map((v, i) => {
          const initials = `${(v.firstName || "V")[0] || ""}${(v.lastName || "")[0] || ""}`.toUpperCase();
          const avatar = v.photoUrl
            ? `<img src="${escapeHtml(v.photoUrl)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:1.5px solid var(--accent);flex-shrink:0;" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='inline-flex';" /><span style="display:none;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials}</span>`
            : `<span style="display:inline-flex;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials}</span>`;

          const hasValidPhone = v.phone && v.phone !== "—" && v.phone.replace(/\D/g, "").length >= 9;
          const cleanPhone = hasValidPhone ? v.phone.replace(/\D/g, "") : "";
          const intlPhone = cleanPhone.startsWith("0") ? ("233" + cleanPhone.slice(1)) : (cleanPhone.startsWith("233") ? cleanPhone : ("233" + cleanPhone));

          return `
            <div class="mob-card" style="margin-bottom: 12px; padding: 14px; background: white; border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  ${avatar}
                  <div>
                    <div style="font-weight: 800; font-size: 14.5px; color: var(--ink);">${escapeHtml(v.name)}</div>
                    <span class="badge badge-gold" style="font-size: 10px;">${escapeHtml(v.role || "First Timer")}</span>
                  </div>
                </div>
                <span class="badge badge-emerald" style="font-size: 10.5px;">${escapeHtml(v.serviceName)}</span>
              </div>
              <div style="font-size: 12px; color: var(--muted); margin-bottom: 10px;">
                <div><i class="far fa-calendar-alt"></i> ${escapeHtml(v.dateStr)} · ${escapeHtml(v.time)} (${escapeHtml(v.method || "KIOSK")})</div>
                ${v.address && v.address !== "—" ? `<div style="margin-top: 2px;"><i class="fas fa-location-dot"></i> ${escapeHtml(v.address)}</div>` : ""}
                ${hasValidPhone ? `<div style="margin-top: 2px;"><i class="fas fa-phone"></i> ${escapeHtml(v.phone)}</div>` : ""}
              </div>
              <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                <button type="button" class="btn-ghost" style="padding: 6px 12px; font-size: 11.5px; font-weight: 600; color: #1e293b; border-color: #cbd5e1; background: #f8fafc; flex: 1; justify-content: center; display: inline-flex; align-items: center; gap: 4px;" onclick="openEditMemberModal('${escapeHtml(v.memberId || v.id)}')" title="Edit Visitor Name or Details">
                  <i class="fas fa-edit" style="color: var(--accent);"></i> Edit
                </button>
                ${hasValidPhone ? `
                  <button type="button" class="btn-ghost" style="padding: 6px 12px; font-size: 11.5px; color: #059669; border-color: #a7f3d0; background: #ecfdf5; flex: 1; justify-content: center;" onclick="openWhatsAppToVisitor('${escapeHtml(intlPhone)}', '${escapeHtml(v.name)}')">
                    <i class="fa-brands fa-whatsapp" style="font-size: 14px;"></i> WhatsApp
                  </button>
                  <a href="tel:${escapeHtml(v.phone)}" class="btn-ghost" style="padding: 6px 12px; font-size: 11.5px; text-decoration: none; flex: 1; justify-content: center; display: inline-flex; align-items: center; gap: 4px;">
                    <i class="fas fa-phone"></i> Call
                  </a>
                ` : ""}
                ${v.memberId ? `
                  <button type="button" class="btn-preset" style="padding: 6px 12px; font-size: 11.5px; font-weight: 700; color: var(--emerald-dark); border-color: var(--accent); flex: 1; justify-content: center;" onclick="convertVisitorToMember('${escapeHtml(v.memberId)}', '${escapeHtml(v.name)}')">
                    <i class="fas fa-user-check"></i> Make Member
                  </button>
                ` : ""}
              </div>
            </div>
          `;
        }).join("");
      }
    }

    function openWhatsAppToVisitor(phone, name) {
      if (!phone) {
        showToast("No valid phone number for this visitor.", "warning", "No Phone");
        return;
      }
      const msg = `Hello ${name}, thank you for worshiping with us at Solutions Faith Ministry International! We are truly blessed by your presence and would love to welcome you again to any of our services. God richly bless you!`;
      const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
      window.open(url, "_blank");
    }

    async function convertVisitorToMember(memberId, name) {
      showConfirmModal(
        `Convert to Full Member?`,
        `Are you sure you want to convert ${name} from a visitor/guest into a regular full member of Solutions Faith Ministry International?`,
        async () => {
          try {
            const token = sessionStorage.getItem("sfmi_token") || localStorage.getItem("sfmi_token");
            const res = await fetch(`${API_BASE}/members/${memberId}`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                ...(token ? { "Authorization": `Bearer ${token}` } : {})
              },
              body: JSON.stringify({
                category: "Adult",
                role: "Member"
              })
            });

            if (res.ok) {
              const updatedData = await res.json().catch(() => null);
              const normName = (name || '').trim().toLowerCase();

              // 1. Optimistically update or insert into allMembers
              const idx = allMembers.findIndex(m => m.id === memberId || (normName && `${m.firstName || ''} ${m.lastName || ''}`.trim().toLowerCase() === normName));
              if (idx !== -1) {
                allMembers[idx].category = "Adult";
                allMembers[idx].role = "Member";
                allMembers[idx].isGuest = false;
                if (updatedData) {
                  allMembers[idx] = { ...allMembers[idx], ...updatedData, isGuest: false, category: "Adult", role: "Member" };
                }
              } else {
                // Member was not in allMembers yet (e.g. newly created on kiosk) - add them!
                const first = updatedData?.firstName || name.split(' ')[0] || 'Member';
                const last = updatedData?.lastName || name.split(' ').slice(1).join(' ') || '';
                allMembers.unshift({
                  id: memberId,
                  firstName: first,
                  lastName: last,
                  phone: updatedData?.phone || '',
                  gender: updatedData?.gender || 'Not specified',
                  address: updatedData?.address || '',
                  category: 'Adult',
                  role: 'Member',
                  guardian: updatedData?.guardian || '',
                  dob: updatedData?.dateOfBirth ? formatDisplayDate(updatedData.dateOfBirth.split('T')[0]) : '',
                  rawDob: updatedData?.dateOfBirth ? updatedData.dateOfBirth.split('T')[0] : null,
                  isGuest: false
                });
              }

              // 2. Remove visitor status thoroughly from rawVisitorsData and processedVisitorsList by ID, memberId, and name
              const phone = updatedData?.phone;
              rawVisitorsData = (rawVisitorsData || []).filter(v => 
                v.memberId !== memberId && v.id !== memberId && 
                (!normName || (v.name || '').trim().toLowerCase() !== normName) &&
                (!phone || v.phone !== phone)
              );
              processedVisitorsList = (processedVisitorsList || []).filter(v => 
                v.memberId !== memberId && v.id !== memberId && 
                (!normName || (v.name || '').trim().toLowerCase() !== normName) &&
                (!phone || v.phone !== phone)
              );

              // 3. Normalize in serviceAttendanceMap
              if (typeof serviceAttendanceMap === 'object' && serviceAttendanceMap !== null) {
                Object.keys(serviceAttendanceMap).forEach(k => {
                  (serviceAttendanceMap[k] || []).forEach(att => {
                    const attFullName = `${att.firstName || ''} ${att.lastName || ''}`.trim().toLowerCase() || (att.name || '').trim().toLowerCase();
                    if (att.memberId === memberId || att.id === memberId || att.member?.id === memberId || (normName && attFullName === normName) || (phone && att.phone === phone)) {
                      att.category = "Adult";
                      att.role = "Member";
                      att.isGuest = false;
                      if (att.member) {
                        att.member.category = "Adult";
                        att.member.role = "Member";
                        att.member.isGuest = false;
                      }
                    }
                  });
                });
              }

              // 4. Update UI immediately
              updateDirectoryCounts();
              renderVisitorsSection();
              filterMembersTable();
              renderAttendanceAndDemographics();

              // 5. Broadcast to local tabs
              if (window.BroadcastChannel) {
                try {
                  const bc = new BroadcastChannel('sfmi_attendance_live');
                  bc.postMessage({ type: 'MEMBER_CONVERTED', memberId, name });
                  setTimeout(() => bc.close(), 500);
                } catch (bErr) {}
              }

              showToast(`<strong>${escapeHtml(name)}</strong> has been successfully converted into a permanent Church Member!`, "success", "Member Converted");

              // 6. Proactively re-sync in background to guarantee 100% cloud parity
              Promise.all([loadSavedMembers(), loadVisitorsData(), fetchLiveCounts()]).then(() => {
                updateDirectoryCounts();
                renderVisitorsSection();
                filterMembersTable();
                renderAttendanceAndDemographics();
              }).catch(() => {});
            } else {
              const err = await res.json().catch(() => ({ error: "Could not convert visitor" }));
              showToast(err.error || "Could not convert visitor to member.", "error", "Conversion Failed");
            }
          } catch (err) {
            console.error("convertVisitorToMember error:", err);
            showToast("Network error connecting to cloud server.", "error", "Network Error");
          }
        },
        "fas fa-user-check",
        "Confirm Member",
        "#059669"
      );
    }

    function openAddVisitorModal() {
      openAddMemberModal();
      const catSelect = document.getElementById("newMemCategory");
      const roleSelect = document.getElementById("newMemRole");
      if (catSelect) catSelect.value = "Visitor / Guest";
      if (roleSelect) roleSelect.value = "Visitor / First Timer";
    }

    function exportVisitorsCSV() {
      if (!processedVisitorsList || processedVisitorsList.length === 0) {
        showToast("No visitor records available to export.", "warning", "Export Empty");
        return;
      }

      const headers = ["#", "Visitor Full Name", "Service Attended", "Date of Visit", "Time", "Phone Number", "Gender", "Residential Location", "Category", "Role", "Check-In Method"];
      const rows = processedVisitorsList.map((v, i) => [
        i + 1,
        `"${(v.name || "").replace(/"/g, '""')}"`,
        `"${(v.serviceName || "").replace(/"/g, '""')}"`,
        `"${(v.dateStr || "").replace(/"/g, '""')}"`,
        `"${(v.time || "").replace(/"/g, '""')}"`,
        `"${(v.phone || "").replace(/"/g, '""')}"`,
        `"${(v.gender || "").replace(/"/g, '""')}"`,
        `"${(v.address || "").replace(/"/g, '""')}"`,
        `"${(v.category || "").replace(/"/g, '""')}"`,
        `"${(v.role || "").replace(/"/g, '""')}"`,
        `"${(v.method || "").replace(/"/g, '""')}"`
      ]);

      const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `SFMI_Visitors_FirstTimers_${formatLocalDate(new Date())}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast("Visitors & First-Timers roster exported to CSV successfully!", "success", "CSV Exported");
    }

    function printVisitorsList() {
      window.print();
    }

    /* ═════════════════════════════════════════════════════════════════════════
       ATTENDANCE & ENGAGEMENT ANALYTICS (EXECUTIVE DASHBOARD & PASTORAL SUITE)
    ═════════════════════════════════════════════════════════════════════════ */
    let currentAnalyticsData = null;
    let currentAnalyticsTrends = [];
    let currentAnalyticsFilter = 'ALL';
    let currentAnalyticsSearch = '';
    let currentWatchlistTab = 'PILLARS';
    let currentStreakServiceCategory = 'overall'; // 'overall' | 'sunday' | 'wednesday' | 'friday'
    let chartAttendanceTrendsInstance = null;
    let chartServiceBreakdownInstance = null;
    let chartConsistencyDistributionInstance = null;

    async function loadAnalyticsDashboard(forceRefresh = false) {
      const monthSelect = document.getElementById('analyticsMonthSelect');
      const yearSelect = document.getElementById('analyticsYearSelect');
      const serviceSelect = document.getElementById('analyticsServiceTypeSelect');
      const attendeeSelect = document.getElementById('analyticsAttendeeTypeSelect');

      if (!monthSelect.dataset.userModified) {
        const now = new Date();
        const curM = String(now.getMonth() + 1);
        const curY = String(now.getFullYear());
        if (monthSelect.value !== curM) monthSelect.value = curM;
        if (yearSelect.value !== curY) yearSelect.value = curY;
      }

      const year = yearSelect.value;
      const month = monthSelect.value;
      const serviceType = serviceSelect ? serviceSelect.value : 'ALL';
      const attendeeType = attendeeSelect ? attendeeSelect.value : 'ALL';

      const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      // Immediate visual feedback so the table never appears frozen
      const tableBody = document.getElementById('analyticsMasterTableBody');
      if (tableBody && (!currentAnalyticsData || forceRefresh)) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="10" style="text-align:center; padding: 48px 16px;">
              <div style="display:inline-flex; align-items:center; gap:12px; color:var(--text-muted); font-size:14px; font-weight:500;">
                <span class="spinner" style="width:22px; height:22px; border-width:2.5px; border-color:var(--primary, #1e3a8a) transparent var(--primary, #1e3a8a) transparent;"></span>
                <span>Calculating attendance streaks, participation rates, and pastoral watchlists...</span>
              </div>
            </td>
          </tr>
        `;
      }

      try {
        const refreshParam = forceRefresh ? '&refresh=true' : '';
        const anUrl = `${API_BASE}/attendance/analytics/monthly?year=${year}&month=${month}&serviceType=${serviceType}&attendeeType=${attendeeType}${refreshParam}`;
        
        // Concurrently fetch Monthly Analytics and Multi-Month Trends in parallel
        const shouldFetchTrends = !currentAnalyticsTrends || currentAnalyticsTrends.length === 0 || forceRefresh;
        const trUrl = `${API_BASE}/attendance/analytics/trends?months=6${refreshParam}`;

        const promises = [fetch(anUrl, { headers })];
        if (shouldFetchTrends) {
          promises.push(fetch(trUrl, { headers }));
        }

        const [anRes, trRes] = await Promise.all(promises);

        if (anRes && anRes.ok) {
          currentAnalyticsData = await anRes.json();
          renderAnalyticsKPIs(currentAnalyticsData);
          renderStreakCommandCenter(currentAnalyticsData);
          renderAnalyticsWatchlistGrid();
          renderAnalyticsMasterTable();
        }

        if (trRes && trRes.ok) {
          const trData = await trRes.json();
          currentAnalyticsTrends = trData.trends || [];
          renderAnalyticsCharts();
        }
      } catch (err) {
        console.error('loadAnalyticsDashboard error:', err);
      }
    }

    function handleAnalyticsPeriodChange() {
      const monthSelect = document.getElementById('analyticsMonthSelect');
      if (monthSelect) monthSelect.dataset.userModified = 'true';
      loadAnalyticsDashboard(true);
    }

    function quickSwitchAnalyticsMonth(m, y) {
      const monthSelect = document.getElementById('analyticsMonthSelect');
      const yearSelect = document.getElementById('analyticsYearSelect');
      if (monthSelect) {
        monthSelect.value = String(m);
        monthSelect.dataset.userModified = 'true';
      }
      if (yearSelect) yearSelect.value = String(y);
      loadAnalyticsDashboard(true);
    }

    function handleAnalyticsSearch(val) {
      currentAnalyticsSearch = (val || '').trim().toLowerCase();
      renderAnalyticsMasterTable();
    }

    function setAnalyticsMemberFilter(filter) {
      currentAnalyticsFilter = filter;
      const buttonMap = {
        'ALL': 'btnAnFilterAll',
        'MEMBERS_ONLY': 'btnAnFilterMembers',
        'VISITORS_ONLY': 'btnAnFilterVisitors',
        'SUNDAY_FAITHFUL': 'btnAnFilterSundayFaithful',
        'WEDNESDAY_FAITHFUL': 'btnAnFilterWedFaithful',
        'FRIDAY_FAITHFUL': 'btnAnFilterFriFaithful',
        'PILLARS': 'btnAnFilterPillars',
        'DECLINING': 'btnAnFilterDeclining',
        'FOLLOW_UP_REQUIRED': 'btnAnFilterFollowUp',
        'ZERO': 'btnAnFilterZero'
      };

      Object.entries(buttonMap).forEach(([k, id]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', k === filter);
      });

      renderAnalyticsMasterTable();
    }

    function filterTableByActiveStreakCategory(tier) {
      const cat = currentStreakServiceCategory || 'overall';
      currentAnalyticsFilter = `ACTIVE_STREAK_${cat.toUpperCase()}_${tier}`;

      // Remove active class from preset buttons
      const buttonIds = [
        'btnAnFilterAll', 'btnAnFilterMembers', 'btnAnFilterVisitors',
        'btnAnFilterSundayFaithful', 'btnAnFilterWedFaithful', 'btnAnFilterFriFaithful',
        'btnAnFilterPillars', 'btnAnFilterDeclining', 'btnAnFilterFollowUp', 'btnAnFilterZero'
      ];
      buttonIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
      });

      renderAnalyticsMasterTable();
      const target = document.getElementById('analyticsMasterTableCard');
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    }

    function scrollToStreakCommandCenter() {
      const target = document.getElementById('streakHubSection');
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    }

    function switchStreakServiceTab(category) {
      currentStreakServiceCategory = category;
      ['overall', 'sunday', 'wednesday', 'friday'].forEach(c => {
        const btn = document.getElementById(`btnStreakTab${c.charAt(0).toUpperCase() + c.slice(1)}`);
        if (btn) btn.classList.toggle('active', c === category);
      });
      renderStreakCommandCenter(currentAnalyticsData);
    }

    function switchWatchlistTab(tab) {
      currentWatchlistTab = tab;
      ['PILLARS', 'DECLINING', 'ABSENT', 'NEW'].forEach(t => {
        const btn = document.getElementById(`btnWatchlist${t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()}`);
        if (btn) btn.classList.toggle('active', t === tab);
      });
      renderAnalyticsWatchlistGrid();
    }

    function renderAnalyticsKPIs(data) {
      if (!data || !data.summary) return;
      const s = data.summary;
      const sb = s.serviceBreakdown || {};

      const totalMemsEl = document.getElementById('statAnTotalMembers');
      if (totalMemsEl) totalMemsEl.innerText = s.analyzedCount ?? s.totalRegisteredMembers;

      const totalMemsLbl = document.getElementById('statAnTotalMembersLabel');
      if (totalMemsLbl) {
        if (s.attendeeTypeFilter === 'MEMBERS') totalMemsLbl.innerText = 'Church Members Analyzed';
        else if (s.attendeeTypeFilter === 'VISITORS') totalMemsLbl.innerText = 'Visitors & First-Timers Analyzed';
        else totalMemsLbl.innerText = 'Total Attendees Analyzed';
      }

      const totalVisEl = document.getElementById('statAnTotalVisitors');
      if (totalVisEl) totalVisEl.innerText = `${s.totalRegularCount ?? 0} Members · ${s.totalVisitorsCount ?? 0} Visitors`;

      const activeMemsEl = document.getElementById('statAnActiveMembers');
      if (activeMemsEl) activeMemsEl.innerText = s.activeMembersThisMonth;

      const partRateEl = document.getElementById('statAnParticipationRate');
      if (partRateEl) partRateEl.innerText = `${s.monthlyParticipationRate}% Participation`;

      const overallPctEl = document.getElementById('statAnOverallAttendancePct');
      if (overallPctEl) overallPctEl.innerText = `${s.overallAttendancePct}%`;

      const totalCheckinsEl = document.getElementById('statAnTotalCheckins');
      if (totalCheckinsEl) totalCheckinsEl.innerText = `${s.totalCheckinsCount} Total Check-ins`;

      // Services Breakdown
      const sunAvgEl = document.getElementById('statAnSundayAvg');
      if (sunAvgEl) sunAvgEl.innerText = sb.sunday?.average || 0;
      const sunTotEl = document.getElementById('statAnSundayTotal');
      if (sunTotEl) sunTotEl.innerText = `${sb.sunday?.totalAttendance || 0} Total (${sb.sunday?.servicesCount || 0} Sundays)`;

      const wedAvgEl = document.getElementById('statAnWedAvg');
      if (wedAvgEl) wedAvgEl.innerText = sb.wednesday?.average || 0;
      const wedTotEl = document.getElementById('statAnWedTotal');
      if (wedTotEl) wedTotEl.innerText = `${sb.wednesday?.totalAttendance || 0} Total (${sb.wednesday?.servicesCount || 0} Midweek)`;

      const friAvgEl = document.getElementById('statAnFriAvg');
      if (friAvgEl) friAvgEl.innerText = sb.friday?.average || 0;
      const friTotEl = document.getElementById('statAnFriTotal');
      if (friTotEl) friTotEl.innerText = `${sb.friday?.totalAttendance || 0} Total (${sb.friday?.servicesCount || 0} Friday)`;

      const evtTotEl = document.getElementById('statAnEventTotal');
      if (evtTotEl) evtTotEl.innerText = sb.event?.totalAttendance || 0;
      const evtSvcEl = document.getElementById('statAnEventServices');
      if (evtSvcEl) evtSvcEl.innerText = `${sb.event?.servicesCount || 0} Events Held`;

      const avgScoreEl = document.getElementById('statAnAvgScore');
      if (avgScoreEl) avgScoreEl.innerText = `${s.averageEngagementScore}/100`;

      let scoreLabel = 'Moderate';
      if (s.averageEngagementScore >= 80) scoreLabel = '🌟 Church Thriving';
      else if (s.averageEngagementScore >= 65) scoreLabel = '🟢 Healthy Engagement';
      else if (s.averageEngagementScore < 40) scoreLabel = '⚠️ Needs Outreach';
      const avgScoreLbl = document.getElementById('statAnAvgScoreLabel');
      if (avgScoreLbl) avgScoreLbl.innerText = scoreLabel;

      // Zero services in selected month notice banner
      const zeroBanner = document.getElementById('analyticsZeroServicesBanner');
      const zeroText = document.getElementById('analyticsZeroServicesText');
      const totalServicesInPeriod = (sb.sunday?.servicesCount || 0) + (sb.wednesday?.servicesCount || 0) + (sb.friday?.servicesCount || 0) + (sb.event?.servicesCount || 0);
      if (zeroBanner) {
        if (totalServicesInPeriod === 0) {
          zeroBanner.style.display = 'block';
          if (zeroText) zeroText.innerHTML = `No church services were held in <strong>${s.monthLabel || 'this period'}</strong>, so monthly rates show 0% (0/0).`;
        } else {
          zeroBanner.style.display = 'none';
        }
      }
    }

    function renderStreakCommandCenter(data) {
      if (!data || !data.summary) return;
      const alertCounts = data.summary.pastoralAlertCounts || {};
      const lb = data.leaderboards || {};
      const cat = currentStreakServiceCategory || 'overall';

      let catLabel = 'All Services';
      let itemUnit = 'Services';
      let faithfulCount = 0;
      let watchCount = 0;
      let concernCount = 0;
      let followUpCount = 0;
      let streaks = [];
      let urgentMembers = [];

      if (cat === 'sunday') {
        catLabel = 'Sunday Services';
        itemUnit = 'Sundays';
        faithfulCount = alertCounts.sundayFaithful ?? (data.members || []).filter(m => m.sunday.consecutiveMissed === 0 && m.sunday.totalAttended > 0).length;
        watchCount = alertCounts.sundayWatch ?? 0;
        concernCount = alertCounts.sundayConcern ?? 0;
        followUpCount = alertCounts.sundayFollowUpRequired ?? 0;
        streaks = lb.sunday?.currentStreaks || lb.currentSundayStreaks || [];
        urgentMembers = (data.members || []).filter(m => m.sunday.consecutiveMissed >= 2 && m.sunday.totalAttended > 0);
      } else if (cat === 'wednesday') {
        catLabel = 'Wednesday Midweek';
        itemUnit = 'Midweek';
        faithfulCount = alertCounts.wednesdayFaithful ?? (data.members || []).filter(m => m.wednesday.consecutiveMissed === 0 && m.wednesday.totalAttended > 0).length;
        watchCount = alertCounts.wednesdayWatch ?? 0;
        concernCount = alertCounts.wednesdayConcern ?? 0;
        followUpCount = alertCounts.wednesdayFollowUpRequired ?? 0;
        streaks = lb.wednesday?.currentStreaks || [];
        urgentMembers = (data.members || []).filter(m => m.wednesday.consecutiveMissed >= 2 && m.wednesday.totalAttended > 0);
      } else if (cat === 'friday') {
        catLabel = 'Friday Prophetic';
        itemUnit = 'Friday';
        faithfulCount = alertCounts.fridayFaithful ?? (data.members || []).filter(m => m.friday.consecutiveMissed === 0 && m.friday.totalAttended > 0).length;
        watchCount = alertCounts.fridayWatch ?? 0;
        concernCount = alertCounts.fridayConcern ?? 0;
        followUpCount = alertCounts.fridayFollowUpRequired ?? 0;
        streaks = lb.friday?.currentStreaks || [];
        urgentMembers = (data.members || []).filter(m => m.friday.consecutiveMissed >= 2 && m.friday.totalAttended > 0);
      } else {
        // Overall
        catLabel = 'All Church Services';
        itemUnit = 'Services';
        faithfulCount = alertCounts.overallFaithful ?? (data.members || []).filter(m => m.overall.consecutiveMissed === 0 && m.overall.totalAttended > 0).length;
        watchCount = alertCounts.overallWatch ?? 0;
        concernCount = alertCounts.overallConcern ?? 0;
        followUpCount = alertCounts.overallFollowUpRequired ?? 0;
        streaks = lb.overall?.currentStreaks || [];
        urgentMembers = (data.members || []).filter(m => m.overall.consecutiveMissed >= 2 && m.overall.totalAttended > 0);
      }

      // Update 4 Progressive Alert Boxes
      const labelFaithfulEl = document.getElementById('labelStreakFaithful');
      if (labelFaithfulEl) labelFaithfulEl.innerText = `🟢 ${catLabel} Faithful`;
      const statFaithfulEl = document.getElementById('statStreakFaithfulCount');
      if (statFaithfulEl) statFaithfulEl.innerText = faithfulCount;

      const labelWatchEl = document.getElementById('labelStreakWatch');
      if (labelWatchEl) labelWatchEl.innerText = `🟡 Watch (1 Missed)`;
      const statWatchEl = document.getElementById('statStreakWatchCount');
      if (statWatchEl) statWatchEl.innerText = watchCount;

      const labelConcernEl = document.getElementById('labelStreakConcern');
      if (labelConcernEl) labelConcernEl.innerText = `🟠 Concern (2 Missed)`;
      const statConcernEl = document.getElementById('statStreakConcernCount');
      if (statConcernEl) statConcernEl.innerText = concernCount;

      const labelFollowUpEl = document.getElementById('labelStreakFollowUp');
      if (labelFollowUpEl) labelFollowUpEl.innerText = `🔴 Follow-Up Required`;
      const statFollowUpEl = document.getElementById('statStreakFollowUpCount');
      if (statFollowUpEl) statFollowUpEl.innerText = followUpCount;

      // Update Sub-Panels Header
      const titleEl = document.getElementById('streakLeaderboardTitle');
      if (titleEl) titleEl.innerHTML = `<i class="fas fa-fire" style="color: #ea580c;"></i> ${catLabel} Streaks Leaderboard`;
      const subtitleEl = document.getElementById('streakLeaderboardSubtitle');
      if (subtitleEl) subtitleEl.innerText = `Active ${itemUnit} Streak`;

      const urgentTitleEl = document.getElementById('streakUrgentTitle');
      if (urgentTitleEl) urgentTitleEl.innerHTML = `<i class="fas fa-hand-holding-heart" style="color: #dc2626;"></i> Urgent ${catLabel} Follow-Up Needed`;
      const urgentSubEl = document.getElementById('streakUrgentSubtitle');
      if (urgentSubEl) urgentSubEl.innerText = `Missed 2+ ${itemUnit}`;

      // Render Left: Streaks Leaderboard
      const streakListEl = document.getElementById('serviceStreakLeaderboardList');
      if (streakListEl) {
        if (streaks.length === 0) {
          streakListEl.innerHTML = `<div style="color: var(--muted); padding: 16px 0; text-align: center;">No active ${catLabel} streaks recorded yet.</div>`;
        } else {
          streakListEl.innerHTML = streaks.slice(0, 8).map((m, i) => {
            const streakVal = m[cat]?.currentStreak || m.sunday?.currentStreak || 0;
            const rateVal = m[cat]?.rate ?? m.overall?.rate ?? 0;
            return `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line);">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-weight: 800; color: var(--muted); width: 18px; font-size: 11px;">#${i + 1}</span>
                  <div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                      <span style="font-weight: 700; color: var(--ink); cursor: pointer;" onclick="openMemberAnalyticsModal('${m.memberId}')">${escapeHtml(m.name)}</span>
                      ${m.isVisitor ? `<span style="background:#fef3c7;color:#b45309;font-size:9.5px;font-weight:700;padding:1px 4px;border-radius:3px;">Visitor</span>` : ''}
                    </div>
                    <div style="font-size: 11px; color: var(--muted);">${m.category} · ${catLabel} ${rateVal}%</div>
                  </div>
                </div>
                <div style="text-align: right;">
                  <span style="background: #fef3c7; color: #b45309; padding: 2px 8px; border-radius: 4px; font-weight: 800; font-size: 11.5px;">
                    🔥 ${streakVal} ${itemUnit}
                  </span>
                </div>
              </div>
            `;
          }).join('');
        }
      }

      // Render Right: Urgent Care List
      const urgentListEl = document.getElementById('servicePastoralUrgentList');
      if (urgentListEl) {
        if (urgentMembers.length === 0) {
          urgentListEl.innerHTML = `<div style="color: #15803d; padding: 16px 0; text-align: center;"><i class="fas fa-check-circle"></i> Excellent! No attendees have missed 2+ consecutive ${itemUnit}.</div>`;
        } else {
          urgentListEl.innerHTML = urgentMembers.slice(0, 8).map(m => {
            const missedCount = m[cat]?.consecutiveMissed || 2;
            const missedBadge = missedCount >= 3
              ? `<span style="background: #fecaca; color: #dc2626; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800;">Missed ${missedCount} ${itemUnit}</span>`
              : `<span style="background: #fed7aa; color: #ea580c; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800;">Missed 2 ${itemUnit}</span>`;

            const phoneClean = (m.phone || '').replace(/[^0-9]/g, '');
            const waLink = phoneClean ? `https://wa.me/${phoneClean.startsWith('0') ? '233' + phoneClean.slice(1) : phoneClean}` : '#';

            return `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line);">
                <div>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-weight: 700; color: #991b1b; cursor: pointer;" onclick="openMemberAnalyticsModal('${m.memberId}')">${escapeHtml(m.name)}</span>
                    ${m.isVisitor ? `<span style="background:#fef3c7;color:#b45309;font-size:9.5px;font-weight:700;padding:1px 4px;border-radius:3px;">Visitor</span>` : ''}
                  </div>
                  <div style="font-size: 11px; color: var(--muted);">${m.phone || 'No phone'} · Last seen: ${m[cat]?.lastAttendedDate || 'Never'}</div>
                </div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  ${missedBadge}
                  ${phoneClean ? `<a href="${waLink}" target="_blank" class="btn-main" style="padding: 2px 8px; font-size: 11px; background: #25d366; text-decoration: none;" title="Send WhatsApp"><i class="fab fa-whatsapp"></i></a>` : ''}
                  <button class="btn-main" style="padding: 2px 8px; font-size: 11px; background: #0284c7;" onclick="openMemberAnalyticsModal('${m.memberId}')" title="View Dossier"><i class="fas fa-user-pen"></i></button>
                </div>
              </div>
            `;
          }).join('');
        }
      }
    }

    function renderAnalyticsCharts() {
      if (!currentAnalyticsTrends || currentAnalyticsTrends.length === 0) return;

      // 1. Line Chart: Trends
      const ctxTrends = document.getElementById('chartAttendanceTrends');
      if (ctxTrends) {
        if (chartAttendanceTrendsInstance) chartAttendanceTrendsInstance.destroy();
        const labels = currentAnalyticsTrends.map(t => t.monthLabel);
        chartAttendanceTrendsInstance = new Chart(ctxTrends, {
          type: 'line',
          data: {
            labels,
            datasets: [
              { label: 'Sunday Services', data: currentAnalyticsTrends.map(t => t.sundayCheckins), borderColor: '#0284c7', backgroundColor: 'rgba(2, 132, 199, 0.1)', tension: 0.3, fill: true },
              { label: 'Wednesday Midweek', data: currentAnalyticsTrends.map(t => t.wednesdayCheckins), borderColor: '#8b5cf6', backgroundColor: 'transparent', tension: 0.3 },
              { label: 'Friday Prophetic', data: currentAnalyticsTrends.map(t => t.fridayCheckins), borderColor: '#ec4899', backgroundColor: 'transparent', tension: 0.3 },
              { label: 'Special Events', data: currentAnalyticsTrends.map(t => t.eventCheckins), borderColor: '#14b8a6', backgroundColor: 'transparent', tension: 0.3 }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
            scales: { y: { beginAtZero: true, grid: { color: '#f1f5f9' } }, x: { grid: { display: false } } }
          }
        });
      }

      // 2. Doughnut Chart: Service Volume Share
      const ctxService = document.getElementById('chartServiceBreakdown');
      if (ctxService && currentAnalyticsData && currentAnalyticsData.summary) {
        if (chartServiceBreakdownInstance) chartServiceBreakdownInstance.destroy();
        const sb = currentAnalyticsData.summary.serviceBreakdown || {};
        chartServiceBreakdownInstance = new Chart(ctxService, {
          type: 'doughnut',
          data: {
            labels: ['Sunday Service', 'Wednesday Midweek', 'Friday Prophetic', 'Special Events'],
            datasets: [{
              data: [
                sb.sunday?.totalAttendance || 0,
                sb.wednesday?.totalAttendance || 0,
                sb.friday?.totalAttendance || 0,
                sb.event?.totalAttendance || 0
              ],
              backgroundColor: ['#0284c7', '#8b5cf6', '#ec4899', '#14b8a6']
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10.5 } } } }
          }
        });
      }

      // 3. Bar Chart: Consistency & Engagement Tiers
      const ctxConsistency = document.getElementById('chartConsistencyDistribution');
      if (ctxConsistency && currentAnalyticsData && currentAnalyticsData.members) {
        if (chartConsistencyDistributionInstance) chartConsistencyDistributionInstance.destroy();
        const mems = currentAnalyticsData.members;
        const tiers = {
          highlyEngaged: mems.filter(m => m.engagement.tier === 'HIGHLY_ENGAGED').length,
          engaged: mems.filter(m => m.engagement.tier === 'ENGAGED').length,
          moderate: mems.filter(m => m.engagement.tier === 'MODERATE').length,
          atRisk: mems.filter(m => m.engagement.tier === 'AT_RISK').length,
          critical: mems.filter(m => m.engagement.tier === 'CRITICAL').length
        };

        chartConsistencyDistributionInstance = new Chart(ctxConsistency, {
          type: 'bar',
          data: {
            labels: ['Pillars (85+)', 'Engaged (65+)', 'Moderate', 'At-Risk', 'Critical (0-20)'],
            datasets: [{
              data: [tiers.highlyEngaged, tiers.engaged, tiers.moderate, tiers.atRisk, tiers.critical],
              backgroundColor: ['#15803d', '#0d9488', '#b45309', '#ea580c', '#dc2626'],
              borderRadius: 4
            }]
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, grid: { color: '#f1f5f9' } }, y: { grid: { display: false }, ticks: { font: { size: 11 } } } }
          }
        });
      }
    }

    function getPastoralStatusBadgeStyle(status) {
      const s = (status || '').toLowerCase();
      if (s.includes('good') || s.includes('resolved') || s.includes('faithful') || s.includes('active')) {
        return 'background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; font-weight: 700;';
      }
      if (s.includes('required') || s.includes('critical')) {
        return 'background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; font-weight: 700;';
      }
      if (s.includes('concern')) {
        return 'background: #ffedd5; color: #c2410c; border: 1px solid #fed7aa; font-weight: 700;';
      }
      if (s.includes('watch')) {
        return 'background: #fef9c3; color: #854d0e; border: 1px solid #fef08a; font-weight: 700;';
      }
      if (s.includes('welcome') || s.includes('outreach') || s.includes('first')) {
        return 'background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; font-weight: 700;';
      }
      return 'background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; font-weight: 600;';
    }

    function getPastoralStatusColor(status) {
      const s = (status || '').toLowerCase();
      if (s.includes('good') || s.includes('resolved') || s.includes('faithful') || s.includes('active')) return '#15803d';
      if (s.includes('required') || s.includes('critical')) return '#b91c1c';
      if (s.includes('concern')) return '#c2410c';
      if (s.includes('watch')) return '#854d0e';
      if (s.includes('welcome') || s.includes('outreach') || s.includes('first')) return '#0369a1';
      return '#475569';
    }

    function renderAnalyticsWatchlistGrid() {
      if (!currentAnalyticsData || !currentAnalyticsData.members) return;
      const container = document.getElementById('analyticsWatchlistGrid');
      if (!container) return;

      const mems = currentAnalyticsData.members;

      // Update Tab Counts
      const pillars = mems.filter(m =>
        m.overall.currentStreak > 0 ||
        m.sunday.currentStreak > 0 ||
        m.wednesday.currentStreak > 0 ||
        m.friday.currentStreak > 0 ||
        m.overall.attended > 0 ||
        m.overall.rate >= 50
      ).sort((a, b) => (b.overall.currentStreak + b.wednesday.currentStreak + b.friday.currentStreak) - (a.overall.currentStreak + a.wednesday.currentStreak + a.friday.currentStreak) || (b.engagement.score - a.engagement.score));

      const declining = mems.filter(m => m.overall.isRapidlyDeclining || (m.overall.rateDelta <= -30 && m.overall.prevMonthRate >= 35));

      const absent = mems.filter(m => m.overall.attended === 0)
        .sort((a, b) => (b.phone ? 1 : 0) - (a.phone ? 1 : 0));

      const newMems = mems.filter(m => m.isNewMember)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      const countPillarsEl = document.getElementById('countWatchlistPillars');
      if (countPillarsEl) countPillarsEl.innerText = pillars.length;
      const countDecliningEl = document.getElementById('countWatchlistDeclining');
      if (countDecliningEl) countDecliningEl.innerText = declining.length;
      const countAbsentEl = document.getElementById('countWatchlistAbsent');
      if (countAbsentEl) countAbsentEl.innerText = absent.length;
      const countNewEl = document.getElementById('countWatchlistNew');
      if (countNewEl) countNewEl.innerText = newMems.length;

      let activeList = pillars;
      if (currentWatchlistTab === 'DECLINING') activeList = declining;
      else if (currentWatchlistTab === 'ABSENT') activeList = absent;
      else if (currentWatchlistTab === 'NEW') activeList = newMems;

      if (activeList.length === 0) {
        container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--muted); padding: 30px;">No attendees matching this pastoral watchlist filter.</div>`;
        return;
      }

      container.innerHTML = activeList.slice(0, 16).map(m => {
        const phoneClean = (m.phone || '').replace(/[^0-9]/g, '');
        const waLink = phoneClean ? `https://wa.me/${phoneClean.startsWith('0') ? '233' + phoneClean.slice(1) : phoneClean}` : '#';

        let streakBadge = `<span style="background: #f1f5f9; color: #94a3b8; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700;">All: —</span>`;
        if (m.overall.currentStreak > 0) {
          streakBadge = `<span style="background: #dcfce7; color: #15803d; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800;">🔥 ${m.overall.currentStreak} All</span>`;
        } else if (m.wednesday.currentStreak > 0) {
          streakBadge = `<span style="background: #ede9fe; color: #6d28d9; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800;">🔥 ${m.wednesday.currentStreak} Wed</span>`;
        } else if (m.friday.currentStreak > 0) {
          streakBadge = `<span style="background: #fce7f3; color: #be185d; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800;">🔥 ${m.friday.currentStreak} Fri</span>`;
        } else if (m.sunday.currentStreak > 0) {
          streakBadge = `<span style="background: #dbeafe; color: #1d4ed8; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800;">🔥 ${m.sunday.currentStreak} Sun</span>`;
        } else if (m.overall.totalAttended > 0 && m.overall.consecutiveMissed > 0) {
          streakBadge = `<span style="background: #fecaca; color: #dc2626; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800;">❌ Missed ${m.overall.consecutiveMissed}</span>`;
        }

        return `
          <div style="background: white; border: 1px solid var(--line); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span style="font-weight: 800; font-size: 13.5px; color: var(--ink); cursor: pointer;" onclick="openMemberAnalyticsModal('${m.memberId}')">${escapeHtml(m.name)}</span>
                  ${m.isVisitor ? `<span style="background:#fef3c7;color:#b45309;font-size:9.5px;font-weight:700;padding:1px 4px;border-radius:3px;">Visitor</span>` : ''}
                </div>
                ${streakBadge}
              </div>
              <div style="font-size: 11.5px; color: var(--muted); margin-bottom: 8px;">
                ${m.category} · ${m.phone || 'No phone'}
              </div>
              <div style="display: flex; gap: 8px; font-size: 11px; background: #f8fafc; padding: 6px 8px; border-radius: 4px; margin-bottom: 8px; flex-wrap: wrap;">
                <div><strong>Sun:</strong> ${m.sunday.rate}% <span style="color:var(--muted);font-size:10px;">(${m.sunday.attended}/${m.sunday.available})</span></div>
                <div><strong>Wed:</strong> ${m.wednesday.rate}% <span style="color:var(--muted);font-size:10px;">(${m.wednesday.attended}/${m.wednesday.available})</span></div>
                <div><strong>Fri:</strong> ${m.friday.rate}% <span style="color:var(--muted);font-size:10px;">(${m.friday.attended}/${m.friday.available})</span></div>
                <div><strong>Overall:</strong> <strong style="color:var(--emerald);">${m.overall.rate}%</strong> <span style="color:var(--muted);font-size:10px;">(${m.overall.attended}/${m.overall.available})</span></div>
                <div><strong>Score:</strong> <span style="color:${m.engagement.badgeColor}; font-weight:800;">${m.engagement.score}/100</span></div>
              </div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center; border-top: 1px solid var(--line); padding-top: 8px;">
              <span style="font-size: 11px; color: var(--muted); flex: 1;">Status: <strong style="color: ${getPastoralStatusColor(m.pastoralFollowUp?.status)};">${escapeHtml(m.pastoralFollowUp?.status || 'In Good Standing')}</strong></span>
              ${phoneClean ? `<a href="${waLink}" target="_blank" class="btn-main" style="padding: 3px 8px; font-size: 11px; background: #25d366; text-decoration: none;"><i class="fab fa-whatsapp"></i></a>` : ''}
              <button class="btn-main" style="padding: 3px 10px; font-size: 11px; background: #0284c7;" onclick="openMemberAnalyticsModal('${m.memberId}')">Dossier</button>
            </div>
          </div>
        `;
      }).join('');
    }

    function renderAnalyticsMasterTable() {
      if (!currentAnalyticsData || !currentAnalyticsData.members) return;
      const tbody = document.getElementById('analyticsMasterTableBody');
      const mobContainer = document.getElementById('analyticsMobileCards');
      if (!tbody) return;

      let list = currentAnalyticsData.members;

      // Update Preset Counts
      const elCountAll = document.getElementById('anCountAll');
      if (elCountAll) elCountAll.innerText = list.length;
      const elCountMembers = document.getElementById('anCountMembers');
      if (elCountMembers) elCountMembers.innerText = list.filter(m => !m.isVisitor).length;
      const elCountVisitors = document.getElementById('anCountVisitors');
      if (elCountVisitors) elCountVisitors.innerText = list.filter(m => m.isVisitor).length;
      const elCountSun = document.getElementById('anCountSundayFaithful');
      if (elCountSun) elCountSun.innerText = list.filter(m => m.sunday.consecutiveMissed === 0 && (m.sunday.attended > 0 || m.sunday.currentStreak > 0 || m.sunday.totalAttended > 0)).length;
      const elCountWed = document.getElementById('anCountWedFaithful');
      if (elCountWed) elCountWed.innerText = list.filter(m => m.wednesday.consecutiveMissed === 0 && (m.wednesday.attended > 0 || m.wednesday.currentStreak > 0 || m.wednesday.totalAttended > 0)).length;
      const elCountFri = document.getElementById('anCountFriFaithful');
      if (elCountFri) elCountFri.innerText = list.filter(m => m.friday.consecutiveMissed === 0 && (m.friday.attended > 0 || m.friday.currentStreak > 0 || m.friday.totalAttended > 0)).length;
      const elCountPillars = document.getElementById('anCountPillars');
      if (elCountPillars) elCountPillars.innerText = list.filter(m => m.overall.rate >= 75 || m.sunday.rate >= 80).length;
      const elCountDeclining = document.getElementById('anCountDeclining');
      if (elCountDeclining) elCountDeclining.innerText = list.filter(m => m.overall.isRapidlyDeclining || m.overall.rateDelta <= -30).length;
      const elCountFollowUp = document.getElementById('anCountFollowUp');
      if (elCountFollowUp) elCountFollowUp.innerText = list.filter(m => (m.sunday.consecutiveMissed >= 3 && m.sunday.totalAttended > 0) || (m.overall.consecutiveMissed >= 3 && m.overall.totalAttended > 0) || (m.pastoralFollowUp?.status || '').includes('Required')).length;
      const elCountZero = document.getElementById('anCountZero');
      if (elCountZero) elCountZero.innerText = list.filter(m => m.overall.attended === 0).length;

      // Apply Filter
      if (currentAnalyticsFilter === 'MEMBERS_ONLY') {
        list = list.filter(m => !m.isVisitor);
      } else if (currentAnalyticsFilter === 'VISITORS_ONLY') {
        list = list.filter(m => m.isVisitor);
      } else if (currentAnalyticsFilter === 'SUNDAY_FAITHFUL') {
        list = list.filter(m => m.sunday.consecutiveMissed === 0 && (m.sunday.attended > 0 || m.sunday.currentStreak > 0 || m.sunday.totalAttended > 0));
      } else if (currentAnalyticsFilter === 'WEDNESDAY_FAITHFUL') {
        list = list.filter(m => m.wednesday.consecutiveMissed === 0 && (m.wednesday.attended > 0 || m.wednesday.currentStreak > 0 || m.wednesday.totalAttended > 0));
      } else if (currentAnalyticsFilter === 'FRIDAY_FAITHFUL') {
        list = list.filter(m => m.friday.consecutiveMissed === 0 && (m.friday.attended > 0 || m.friday.currentStreak > 0 || m.friday.totalAttended > 0));
      } else if (currentAnalyticsFilter === 'PILLARS') {
        list = list.filter(m => m.overall.rate >= 75 || m.sunday.rate >= 80);
      } else if (currentAnalyticsFilter === 'DECLINING') {
        list = list.filter(m => m.overall.isRapidlyDeclining || m.overall.rateDelta <= -30);
      } else if (currentAnalyticsFilter === 'FOLLOW_UP_REQUIRED') {
        list = list.filter(m => (m.sunday.consecutiveMissed >= 3 && m.sunday.totalAttended > 0) || (m.overall.consecutiveMissed >= 3 && m.overall.totalAttended > 0) || (m.pastoralFollowUp?.status || '').includes('Required'));
      } else if (currentAnalyticsFilter === 'ZERO') {
        list = list.filter(m => m.overall.attended === 0);
      } else if (currentAnalyticsFilter.startsWith('ACTIVE_STREAK_')) {
        const parts = currentAnalyticsFilter.replace('ACTIVE_STREAK_', '').toLowerCase().split('_');
        const svcCat = parts[0];
        const tier = parts.slice(1).join('_').toUpperCase();

        if (tier === 'FAITHFUL') {
          list = list.filter(m => m[svcCat]?.consecutiveMissed === 0 && (m[svcCat]?.currentStreak > 0 || m[svcCat]?.totalAttended > 0));
        } else if (tier === 'WATCH') {
          list = list.filter(m => m[svcCat]?.consecutiveMissed === 1 && m[svcCat]?.totalAttended > 0);
        } else if (tier === 'CONCERN') {
          list = list.filter(m => m[svcCat]?.consecutiveMissed === 2 && m[svcCat]?.totalAttended > 0);
        } else if (tier === 'FOLLOW_UP_REQUIRED') {
          list = list.filter(m => (m[svcCat]?.consecutiveMissed || 0) >= 3 && m[svcCat]?.totalAttended > 0);
        }
      }

      // Apply Search
      if (currentAnalyticsSearch) {
        list = list.filter(m =>
          m.name.toLowerCase().includes(currentAnalyticsSearch) ||
          m.phone.includes(currentAnalyticsSearch)
        );
      }

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" style="text-align: center; color: var(--muted); padding: 30px;">No attendees found matching this filter.</td></tr>`;
        if (mobContainer) mobContainer.innerHTML = `<div style="text-align:center;color:var(--muted);padding:24px 0;">No attendees found.</div>`;
        return;
      }

      const formatPill = (code, catObj, activeBg, activeColor) => {
        if (!catObj) return '';
        if (catObj.currentStreak > 0) {
          return `<span style="background: ${activeBg}; color: ${activeColor}; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; white-space: nowrap;" title="${code} Streak">
            ${code}: 🔥 ${catObj.currentStreak}
          </span>`;
        }
        if (catObj.totalAttended > 0 && catObj.consecutiveMissed > 0) {
          return `<span style="background: #fee2e2; color: #b91c1c; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; white-space: nowrap;" title="${code} Missed">
            ${code}: ❌ ${catObj.consecutiveMissed}
          </span>`;
        }
        return `<span style="background: #f1f5f9; color: #94a3b8; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; white-space: nowrap;" title="No check-ins">
          ${code}: —
        </span>`;
      };

      const formatMobileStreak = (catObj) => {
        if (!catObj) return '—';
        if (catObj.currentStreak > 0) return `🔥${catObj.currentStreak}`;
        if (catObj.totalAttended > 0 && catObj.consecutiveMissed > 0) return `❌${catObj.consecutiveMissed}`;
        return '—';
      };

      tbody.innerHTML = list.map((m, i) => {
        const streaksHtml = `
          <div style="display: flex; flex-wrap: wrap; gap: 4px; max-width: 230px;">
            ${formatPill('Sun', m.sunday, '#dbeafe', '#1d4ed8')}
            ${formatPill('Wed', m.wednesday, '#ede9fe', '#6d28d9')}
            ${formatPill('Fri', m.friday, '#fce7f3', '#be185d')}
            ${formatPill('All', m.overall, '#dcfce7', '#15803d')}
          </div>
        `;

        const scoreGauge = `
          <div style="display: flex; align-items: center; gap: 6px;">
            <div style="width: 45px; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;">
              <div style="width: ${m.engagement.score}%; height: 100%; background: ${m.engagement.badgeColor};"></div>
            </div>
            <span style="font-weight: 800; font-size: 11.5px; color: ${m.engagement.badgeColor};">${m.engagement.score}/100</span>
          </div>
        `;

        const phoneClean = (m.phone || '').replace(/[^0-9]/g, '');
        const waLink = phoneClean ? `https://wa.me/${phoneClean.startsWith('0') ? '233' + phoneClean.slice(1) : phoneClean}` : '#';

        return `
          <tr>
            <td>${i + 1}</td>
            <td>
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span style="font-weight: 700; color: var(--ink); cursor: pointer;" onclick="openMemberAnalyticsModal('${m.memberId}')">
                  ${escapeHtml(m.name)}
                </span>
                ${m.isVisitor ? `<span style="background: #fef3c7; color: #b45309; border: 1px solid #fde68a; font-size: 10px; font-weight: 800; padding: 1px 5px; border-radius: 4px;">Visitor</span>` : `<span style="background: #ecfdf5; color: #047857; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px;">Member</span>`}
              </div>
              <div style="font-size: 11px; color: var(--muted);">${m.category} · ${m.phone || 'No phone'}</div>
            </td>
            <td>${streaksHtml}</td>
            <td><strong>${m.sunday.rate}%</strong> <span style="font-size:11px;color:var(--muted);">(${m.sunday.attended}/${m.sunday.available})</span></td>
            <td><strong>${m.wednesday.rate}%</strong> <span style="font-size:11px;color:var(--muted);">(${m.wednesday.attended}/${m.wednesday.available})</span></td>
            <td><strong>${m.friday.rate}%</strong> <span style="font-size:11px;color:var(--muted);">(${m.friday.attended}/${m.friday.available})</span></td>
            <td><strong>${m.event.rate}%</strong> <span style="font-size:11px;color:var(--muted);">(${m.event.attended}/${m.event.available})</span></td>
            <td><strong style="color: var(--emerald); font-weight:800;">${m.overall.rate}%</strong> <span style="font-size:11px;color:var(--muted);">(${m.overall.attended}/${m.overall.available})</span></td>
            <td>${scoreGauge}</td>
            <td>
              <span class="badge-check" style="font-size: 11px; ${getPastoralStatusBadgeStyle(m.pastoralFollowUp?.status)}">
                ${escapeHtml(m.pastoralFollowUp?.status || 'In Good Standing')}
              </span>
            </td>
            <td style="text-align: right;">
              <div style="display: flex; gap: 4px; justify-content: flex-end;">
                ${phoneClean ? `<a href="${waLink}" target="_blank" class="btn-main" style="padding: 3px 8px; font-size: 11px; background: #25d366; text-decoration: none;" title="WhatsApp"><i class="fab fa-whatsapp"></i></a>` : ''}
                ${m.phone ? `<a href="tel:${m.phone}" class="btn-main" style="padding: 3px 8px; font-size: 11px; background: #0284c7; text-decoration: none;" title="Call"><i class="fas fa-phone"></i></a>` : ''}
                <button class="btn-main" style="padding: 3px 8px; font-size: 11px; background: #14532d;" onclick="openMemberAnalyticsModal('${m.memberId}')" title="Open Dossier"><i class="fas fa-user-pen"></i></button>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      // Render Mobile Cards
      if (mobContainer) {
        mobContainer.innerHTML = list.map((m, i) => {
          let mobAllBadge = `<span style="background:#f1f5f9;color:#94a3b8;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;">All: —</span>`;
          if (m.overall.currentStreak > 0) {
            mobAllBadge = `<span style="background:#dcfce7;color:#15803d;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:800;">All: 🔥 ${m.overall.currentStreak}</span>`;
          } else if (m.overall.totalAttended > 0 && m.overall.consecutiveMissed > 0) {
            mobAllBadge = `<span style="background:#fee2e2;color:#b91c1c;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:800;">All: ❌ ${m.overall.consecutiveMissed}</span>`;
          }

          return `
            <div class="mob-card">
              <div class="mob-card-header">
                <div class="mob-card-name" onclick="openMemberAnalyticsModal('${m.memberId}')">
                  ${i + 1}. ${escapeHtml(m.name)}
                  ${m.isVisitor ? `<span style="background:#fef3c7;color:#b45309;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:4px;">Visitor</span>` : ''}
                </div>
                ${mobAllBadge}
              </div>
              <div class="mob-card-meta">
                <div class="mob-card-row">
                  <span>Streaks</span>
                  <strong>Sun: ${formatMobileStreak(m.sunday)} · Wed: ${formatMobileStreak(m.wednesday)} · Fri: ${formatMobileStreak(m.friday)}</strong>
                </div>
                <div class="mob-card-row"><span>Sunday %</span><strong>${m.sunday.rate}% (${m.sunday.attended}/${m.sunday.available})</strong></div>
                <div class="mob-card-row"><span>Wednesday %</span><strong>${m.wednesday.rate}% (${m.wednesday.attended}/${m.wednesday.available})</strong></div>
                <div class="mob-card-row"><span>Friday %</span><strong>${m.friday.rate}% (${m.friday.attended}/${m.friday.available})</strong></div>
                <div class="mob-card-row"><span>Overall %</span><strong style="color:var(--emerald);">${m.overall.rate}% (${m.overall.attended}/${m.overall.available})</strong></div>
                <div class="mob-card-row"><span>Score</span><strong style="color:${m.engagement.badgeColor};">${m.engagement.score}/100 (${m.engagement.tierLabel})</strong></div>
                <div class="mob-card-row"><span>Pastoral Status</span><strong style="color:${getPastoralStatusColor(m.pastoralFollowUp?.status)};">${escapeHtml(m.pastoralFollowUp?.status || 'In Good Standing')}</strong></div>
              </div>
              <div class="mob-card-actions">
                <button class="btn-main" style="background:#14532d;" onclick="openMemberAnalyticsModal('${m.memberId}')"><i class="fas fa-user-pen"></i> Open Dossier</button>
                ${m.phone ? `<a href="tel:${m.phone}" class="btn-main" style="background:#0284c7;text-decoration:none;"><i class="fas fa-phone"></i> Call</a>` : ''}
              </div>
            </div>
          `;
        }).join('');
      }
    }

    function syncAnalyticsViewMode() {
      const isMobile = window.innerWidth <= 850;
      const tbl = document.querySelector('#secAnalytics .table-responsive');
      const mob = document.getElementById('analyticsMobileCards');
      if (tbl) tbl.style.display = isMobile ? 'none' : 'block';
      if (mob) mob.style.display = isMobile ? 'block' : 'none';
    }

    /* ═════════════════════════════════════════════════════════════════════════
       INDIVIDUAL MEMBER ANALYTICS DOSSIER MODAL (MULTI-SERVICE STREAKS)
    ═════════════════════════════════════════════════════════════════════════ */
    async function openMemberAnalyticsModal(memberId) {
      const modal = document.getElementById('memberAnalyticsModal');
      const content = document.getElementById('memberAnalyticsModalContent');
      if (!modal || !content) return;

      content.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--muted);"><i class="fas fa-spinner fa-spin fa-2x"></i><div style="margin-top: 10px;">Loading Attendee Dossier &amp; Streaks...</div></div>`;
      modal.style.display = 'flex';

      const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      try {
        const res = await fetch(`${API_BASE}/attendance/analytics/member/${memberId}`, { headers });
        if (!res.ok) throw new Error('Could not load attendee dossier');
        const data = await res.json();
        renderMemberAnalyticsModalContent(data);
      } catch (err) {
        content.innerHTML = `<div style="color: #dc2626; padding: 20px; text-align: center;">Error loading analytics dossier: ${escapeHtml(err.message)}</div>`;
      }
    }

    function closeMemberAnalyticsModal() {
      const modal = document.getElementById('memberAnalyticsModal');
      if (modal) modal.style.display = 'none';
    }

    function renderMemberAnalyticsModalContent(d) {
      const content = document.getElementById('memberAnalyticsModalContent');
      if (!content || !d || !d.member) return;

      const m = d.member;
      const sun = d.sunday || {};
      const wed = d.wednesday || {};
      const fri = d.friday || {};
      const ov = d.overall || {};
      const life = d.lifetime || {};

      const phoneClean = (m.phone || '').replace(/[^0-9]/g, '');
      const waLink = phoneClean ? `https://wa.me/${phoneClean.startsWith('0') ? '233' + phoneClean.slice(1) : phoneClean}` : '#';

      // 12-Month Sparkline Bars
      const monthlyBars = (d.monthlyHistory || []).map(mh => `
        <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1;">
          <div style="height: 50px; width: 100%; display: flex; align-items: flex-end; background: #f1f5f9; border-radius: 3px;">
            <div style="width: 100%; height: ${mh.rate}%; background: ${mh.rate >= 70 ? '#15803d' : (mh.rate >= 30 ? '#0284c7' : (mh.rate > 0 ? '#ea580c' : '#cbd5e1'))}; border-radius: 3px;" title="${mh.monthLabel}: ${mh.attended}/${mh.totalServices} (${mh.rate}%)"></div>
          </div>
          <span style="font-size: 9.5px; color: var(--muted);">${mh.monthLabel.split(' ')[0]}</span>
        </div>
      `).join('');

      // Recent 10 Check-ins
      const recentCheckinsHtml = (d.recentCheckins || []).slice(0, 10).map(c => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 12px;">
          <div>
            <span style="font-weight: 700; color: var(--ink);">${escapeHtml(c.serviceName)}</span>
            <span style="color: var(--muted); margin-left: 6px;">${c.serviceDate}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="color: var(--muted); font-size: 11px;">${c.time}</span>
            <span class="badge-present" style="font-size: 10.5px;"><i class="fas fa-check"></i> ${c.method}</span>
          </div>
        </div>
      `).join('') || `<div style="color: var(--muted); padding: 10px 0;">No check-in history on record.</div>`;

      // Pastoral History Log
      const followUpLogsHtml = (d.followUpHistory || []).map(fl => `
        <div style="padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 11.5px;">
          <div style="display: flex; justify-content: space-between;">
            <strong style="color: #0284c7;">${escapeHtml(fl.status || 'Follow-Up')}</strong>
            <span style="color: var(--muted); font-size: 11px;">${new Date(fl.createdAt).toLocaleString()}</span>
          </div>
          ${fl.note ? `<div style="color: var(--ink); margin-top: 2px;">${escapeHtml(fl.note)}</div>` : ''}
        </div>
      `).join('') || `<div style="color: var(--muted); padding: 8px 0; font-size: 11.5px;">No pastoral notes logged yet.</div>`;

      const memInitials = (m.name || 'Member').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'M';
      const modalAvatar = m.photoUrl
        ? `<img src="${escapeHtml(m.photoUrl)}" alt="" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2px solid var(--line); flex-shrink: 0;" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='inline-flex';" /><span style="display:none;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:20px;font-weight:700;flex-shrink:0;">${memInitials}</span>`
        : `<span style="display:inline-flex;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,var(--emerald-dark),var(--emerald));color:#fff;align-items:center;justify-content:center;font-size:20px;font-weight:700;flex-shrink:0;">${memInitials}</span>`;

      content.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 14px;">
            ${modalAvatar}
            <div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <h3 style="font-family: Manrope, sans-serif; font-size: 20px; font-weight: 800; color: var(--ink); margin: 0;">${escapeHtml(m.name)}</h3>
                <span class="badge-check" style="font-size: 11px;">${m.category}</span>
                ${(m.role || '').toLowerCase().includes('visitor') ? `<span style="background: #fef3c7; color: #b45309; border: 1px solid #fde68a; font-size: 11px; font-weight: 800; padding: 2px 6px; border-radius: 4px;">Visitor / Guest</span>` : ''}
              </div>
              <div style="font-size: 12.5px; color: var(--muted); margin-top: 2px;">
                ${m.phone || 'No phone'} · ${m.email || 'No email'} · Registered ${new Date(m.createdAt).toLocaleDateString()}
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            ${phoneClean ? `<a href="${waLink}" target="_blank" class="btn-main" style="background: #25d366; text-decoration: none; font-size: 12px; padding: 6px 12px;"><i class="fab fa-whatsapp"></i> WhatsApp</a>` : ''}
            ${m.phone ? `<a href="tel:${m.phone}" class="btn-main" style="background: #0284c7; text-decoration: none; font-size: 12px; padding: 6px 12px;"><i class="fas fa-phone"></i> Call</a>` : ''}
          </div>
        </div>

        <!-- 4 Multi-Service Consecutive Streaks Grid -->
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px;">
          <!-- Sunday Streak -->
          <div style="background: #f0f9ff; border: 1.5px solid #0284c7; border-radius: 6px; padding: 10px;">
            <div style="font-size: 11px; font-weight: 800; color: #0369a1; text-transform: uppercase;">⛪ Sunday Streak</div>
            <div style="font-size: 17px; font-weight: 800; color: #b45309; margin-top: 2px;">
              ${sun.currentStreak > 0 ? `🔥 ${sun.currentStreak} Sundays` : (sun.totalAttended > 0 ? `❌ ${sun.consecutiveMissed} Missed` : `— No Attendance`)}
            </div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">
              Longest: <strong>${sun.longestStreak || 0}</strong> · Missed: <strong>${sun.totalAttended > 0 ? (sun.consecutiveMissed || 0) : 0}</strong>
            </div>
            <div style="font-size: 10.5px; color: ${sun.alertColor || '#0369a1'}; font-weight: 700; margin-top: 4px;">
              ${sun.alertLabel || 'Sunday'}
            </div>
          </div>

          <!-- Wednesday Streak -->
          <div style="background: #faf5ff; border: 1.5px solid #8b5cf6; border-radius: 6px; padding: 10px;">
            <div style="font-size: 11px; font-weight: 800; color: #7c3aed; text-transform: uppercase;">📖 Wednesday Streak</div>
            <div style="font-size: 17px; font-weight: 800; color: #7c3aed; margin-top: 2px;">
              ${wed.currentStreak > 0 ? `🔥 ${wed.currentStreak} Midweek` : (wed.totalAttended > 0 ? `❌ ${wed.consecutiveMissed} Missed` : `— No Attendance`)}
            </div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">
              Longest: <strong>${wed.longestStreak || 0}</strong> · Missed: <strong>${wed.totalAttended > 0 ? (wed.consecutiveMissed || 0) : 0}</strong>
            </div>
            <div style="font-size: 10.5px; color: ${wed.alertColor || '#7c3aed'}; font-weight: 700; margin-top: 4px;">
              ${wed.alertLabel || 'Wednesday'}
            </div>
          </div>

          <!-- Friday Streak -->
          <div style="background: #fdf2f8; border: 1.5px solid #ec4899; border-radius: 6px; padding: 10px;">
            <div style="font-size: 11px; font-weight: 800; color: #db2777; text-transform: uppercase;">🔥 Friday Streak</div>
            <div style="font-size: 17px; font-weight: 800; color: #db2777; margin-top: 2px;">
              ${fri.currentStreak > 0 ? `🔥 ${fri.currentStreak} Friday` : (fri.totalAttended > 0 ? `❌ ${fri.consecutiveMissed} Missed` : `— No Attendance`)}
            </div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">
              Longest: <strong>${fri.longestStreak || 0}</strong> · Missed: <strong>${fri.totalAttended > 0 ? (fri.consecutiveMissed || 0) : 0}</strong>
            </div>
            <div style="font-size: 10.5px; color: ${fri.alertColor || '#db2777'}; font-weight: 700; margin-top: 4px;">
              ${fri.alertLabel || 'Friday'}
            </div>
          </div>

          <!-- Overall Streak -->
          <div style="background: #f0fdf4; border: 1.5px solid #16a34a; border-radius: 6px; padding: 10px;">
            <div style="font-size: 11px; font-weight: 800; color: #15803d; text-transform: uppercase;">⚡ Overall Streak</div>
            <div style="font-size: 17px; font-weight: 800; color: #15803d; margin-top: 2px;">
              ${ov.currentStreak > 0 ? `🔥 ${ov.currentStreak} Services` : (ov.totalAttended > 0 ? `❌ ${ov.consecutiveMissed} Missed` : `— No Attendance`)}
            </div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 2px;">
              Longest: <strong>${ov.longestStreak || 0}</strong> · Missed: <strong>${ov.totalAttended > 0 ? (ov.consecutiveMissed || 0) : 0}</strong>
            </div>
            <div style="font-size: 10.5px; color: ${ov.alertColor || '#15803d'}; font-weight: 700; margin-top: 4px;">
              ${ov.alertLabel || 'Overall'}
            </div>
          </div>
        </div>

        <!-- 4 Stat Summary Cards -->
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px;">
          <div style="background: #f8fafc; padding: 10px; border-radius: 6px; text-align: center; border: 1px solid var(--line);">
            <div style="font-size: 11px; color: var(--muted);">Sunday Fidelity</div>
            <div style="font-size: 17px; font-weight: 800; color: #0284c7;">${sun.attendancePct ?? sun.rate ?? 0}%</div>
            <div style="font-size: 10.5px; color: var(--muted);">${sun.totalAttended ?? sun.attended ?? 0}/${sun.totalOpportunities ?? sun.available ?? 0} Sundays</div>
          </div>
          <div style="background: #f8fafc; padding: 10px; border-radius: 6px; text-align: center; border: 1px solid var(--line);">
            <div style="font-size: 11px; color: var(--muted);">Wednesday Midweek</div>
            <div style="font-size: 17px; font-weight: 800; color: #8b5cf6;">${wed.attendancePct ?? wed.rate ?? 0}%</div>
            <div style="font-size: 10.5px; color: var(--muted);">${wed.totalAttended ?? wed.attended ?? 0}/${wed.totalOpportunities ?? wed.available ?? 0} Services</div>
          </div>
          <div style="background: #f8fafc; padding: 10px; border-radius: 6px; text-align: center; border: 1px solid var(--line);">
            <div style="font-size: 11px; color: var(--muted);">Friday Prophetic</div>
            <div style="font-size: 17px; font-weight: 800; color: #ec4899;">${fri.attendancePct ?? fri.rate ?? 0}%</div>
            <div style="font-size: 10.5px; color: var(--muted);">${fri.totalAttended ?? fri.attended ?? 0}/${fri.totalOpportunities ?? fri.available ?? 0} Services</div>
          </div>
          <div style="background: #f8fafc; padding: 10px; border-radius: 6px; text-align: center; border: 1px solid var(--line);">
            <div style="font-size: 11px; color: var(--muted);">Lifetime Attendance</div>
            <div style="font-size: 17px; font-weight: 800; color: #15803d;">${life.overallRate ?? ov.rate ?? 0}%</div>
            <div style="font-size: 10.5px; color: var(--muted);">${life.totalAttended ?? ov.attended ?? 0}/${life.totalServicesHeld ?? ov.available ?? 0} Total</div>
          </div>
        </div>

        <!-- 12-Month Sparkline Chart -->
        <div style="background: white; border: 1px solid var(--line); border-radius: 6px; padding: 12px; margin-bottom: 14px;">
          <div style="font-weight: 700; font-size: 12.5px; color: var(--ink); margin-bottom: 8px;">
            <i class="fas fa-chart-simple" style="color: var(--emerald);"></i> 12-Month Attendance History Trend
          </div>
          <div style="display: flex; gap: 6px; align-items: flex-end; height: 70px;">
            ${monthlyBars}
          </div>
        </div>

        <!-- 2 Columns: Recent Check-ins & Pastoral Care Follow-Up Logger -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
          <!-- Recent Check-ins -->
          <div style="background: white; border: 1px solid var(--line); border-radius: 6px; padding: 12px;">
            <div style="font-weight: 700; font-size: 12.5px; color: var(--ink); margin-bottom: 8px;">
              <i class="fas fa-clock-rotate-left"></i> Recent Check-In History across Services
            </div>
            <div style="max-height: 180px; overflow-y: auto;">
              ${recentCheckinsHtml}
            </div>
          </div>

          <!-- Pastoral Follow-Up Action Box -->
          <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 12px;">
            <div style="font-weight: 800; font-size: 12.5px; color: #b45309; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
              <span><i class="fas fa-hand-holding-heart"></i> Log Pastoral Follow-Up Action</span>
              <span style="font-size: 11px;">Current: <strong>${d.pastoralFollowUp?.status || 'None'}</strong></span>
            </div>

            <div style="display: flex; flex-direction: column; gap: 8px;">
              <select id="pastoralActionSelect_${m.id}" class="form-ctrl" style="font-size: 12px; padding: 5px;">
                <option value="Follow-Up Required">🔴 Follow-Up Required</option>
                <option value="Phone Call Completed">📞 Phone Call Completed</option>
                <option value="WhatsApp Contacted">💬 WhatsApp Contacted</option>
                <option value="Pastoral Visit Required">🏠 Pastoral Visit Required</option>
                <option value="Pastoral Visit Completed">✅ Pastoral Visit Completed</option>
                <option value="Resolved">🟢 Resolved / Re-Engaged</option>
                <option value="Do Not Follow Up">⚪ Do Not Follow Up</option>
              </select>
              <textarea id="pastoralNoteInput_${m.id}" class="form-ctrl" placeholder="Add pastoral care note (e.g. contacted attendee, will attend Wednesday and Friday)..." style="font-size: 12px; height: 50px; resize: none;"></textarea>
              <button class="btn-main" style="background: #b45309; font-size: 11.5px; padding: 5px 12px; align-self: flex-start;" onclick="savePastoralFollowUp('${m.id}')">
                <i class="fas fa-save"></i> Save Pastoral Action
              </button>
            </div>

            <div style="margin-top: 10px; border-top: 1px solid #fde68a; padding-top: 8px;">
              <div style="font-size: 11px; font-weight: 700; color: #b45309; margin-bottom: 4px;">Pastoral Follow-Up History:</div>
              <div style="max-height: 80px; overflow-y: auto;">
                ${followUpLogsHtml}
              </div>
            </div>
          </div>
        </div>
      `;
    }

    async function savePastoralFollowUp(memberId) {
      const statusSelect = document.getElementById(`pastoralActionSelect_${memberId}`);
      const noteInput = document.getElementById(`pastoralNoteInput_${memberId}`);
      if (!statusSelect) return;

      const status = statusSelect.value;
      const note = noteInput ? noteInput.value.trim() : '';

      const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
      const headers = token ? { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };

      try {
        const res = await fetch(`${API_BASE}/attendance/analytics/pastoral-followup`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ memberId, status, note })
        });
        if (res.ok) {
          showToast('Pastoral follow-up recorded successfully!', 'success', 'Pastoral Care Logged');
          openMemberAnalyticsModal(memberId);
          loadAnalyticsDashboard(true);
        } else {
          showToast('Could not save pastoral follow-up note.', 'error', 'Error');
        }
      } catch (e) {
        showToast(e.message, 'error', 'Error');
      }
    }

    /* ═════════════════════════════════════════════════════════════════════════
       MONTHLY PASTOR SUMMARY MODAL
    ═════════════════════════════════════════════════════════════════════════ */
    function openPastorSummaryModal() {
      if (!currentAnalyticsData) return;
      const modal = document.getElementById('pastorSummaryModal');
      const content = document.getElementById('pastorSummaryModalContent');
      if (!modal || !content) return;

      const d = currentAnalyticsData;
      const s = d.summary;
      const sb = s.serviceBreakdown;
      const lb = d.leaderboards;
      const period = d.period;

      const urgentFollowUps = (d.members || []).filter(m => m.sunday.consecutiveMissed >= 2 || m.overall.consecutiveMissed >= 2);
      const pillars = (lb.consistentMembers || []).slice(0, 10);

      content.innerHTML = `
        <div style="border-bottom: 2px solid var(--ink); padding-bottom: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end;">
          <div>
            <div style="font-size: 11px; font-weight: 800; color: #b45309; text-transform: uppercase; letter-spacing: 0.08em;">SOLUTIONS FAITH MINISTRY INTERNATIONAL</div>
            <h1 style="font-family: Manrope, sans-serif; font-size: 22px; font-weight: 800; color: var(--ink); margin: 2px 0;">
              Executive Monthly Church Attendance &amp; Engagement Report
            </h1>
            <div style="font-size: 13px; color: var(--muted);">
              Reporting Period: <strong>${period.label}</strong> (${period.startDate} to ${period.endDate})
            </div>
          </div>
          <button class="btn-main" style="background: #14532d; font-size: 12px; padding: 6px 14px;" onclick="window.print()"><i class="fas fa-print"></i> Print Executive Summary</button>
        </div>

        <!-- Executive Narrative for Head Pastor -->
        <div style="background: #f8fafc; border-left: 4px solid var(--emerald); padding: 12px 16px; border-radius: 4px; margin-bottom: 16px;">
          <div style="font-weight: 800; font-size: 13px; color: var(--emerald-dark); margin-bottom: 4px;">
            <i class="fas fa-church"></i> Pastoral Executive Overview
          </div>
          <p style="font-size: 13px; color: var(--ink); line-height: 1.5; margin: 0;">
            During <strong>${period.label}</strong>, Solutions Faith Ministry International conducted a total of <strong>${s.totalServicesHeld} church services</strong> across Sunday, Wednesday, and Friday gatherings. Overall church attendance reached <strong>${s.overallAttendancePct}%</strong> with <strong>${s.activeMembersThisMonth} of ${s.analyzedCount || s.totalRegisteredMembers} attendees</strong> actively in attendance (${s.monthlyParticipationRate}% active participation). The church-wide engagement index stands at <strong>${s.averageEngagementScore}/100</strong>.
          </p>
        </div>

        <!-- Key Service Averages -->
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px;">
          <div style="border: 1px solid var(--line); border-radius: 6px; padding: 10px; text-align: center;">
            <div style="font-size: 11.5px; color: var(--muted);">Sunday Service Avg</div>
            <div style="font-size: 20px; font-weight: 800; color: #0284c7;">${sb.sunday?.average || 0}</div>
            <div style="font-size: 11px; color: var(--muted);">${sb.sunday?.totalAttendance || 0} Total (${sb.sunday?.servicesCount || 0} Services)</div>
          </div>
          <div style="border: 1px solid var(--line); border-radius: 6px; padding: 10px; text-align: center;">
            <div style="font-size: 11.5px; color: var(--muted);">Wednesday Midweek Avg</div>
            <div style="font-size: 20px; font-weight: 800; color: #8b5cf6;">${sb.wednesday?.average || 0}</div>
            <div style="font-size: 11px; color: var(--muted);">${sb.wednesday?.totalAttendance || 0} Total (${sb.wednesday?.servicesCount || 0} Services)</div>
          </div>
          <div style="border: 1px solid var(--line); border-radius: 6px; padding: 10px; text-align: center;">
            <div style="font-size: 11.5px; color: var(--muted);">Friday Prophetic Avg</div>
            <div style="font-size: 20px; font-weight: 800; color: #ec4899;">${sb.friday?.average || 0}</div>
            <div style="font-size: 11px; color: var(--muted);">${sb.friday?.totalAttendance || 0} Total (${sb.friday?.servicesCount || 0} Services)</div>
          </div>
          <div style="border: 1px solid var(--line); border-radius: 6px; padding: 10px; text-align: center;">
            <div style="font-size: 11.5px; color: var(--muted);">Special Events Total</div>
            <div style="font-size: 20px; font-weight: 800; color: #14b8a6;">${sb.event?.totalAttendance || 0}</div>
            <div style="font-size: 11px; color: var(--muted);">${sb.event?.servicesCount || 0} Events Held</div>
          </div>
        </div>

        <!-- 2 Panels: Urgent Follow-Up & Pillars Honor Roll -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
          <!-- Urgent Follow-up List -->
          <div style="border: 1px solid #fca5a5; border-radius: 6px; padding: 12px; background: #fff5f5;">
            <div style="font-weight: 800; font-size: 13px; color: #dc2626; margin-bottom: 8px;">
              <i class="fas fa-hand-holding-heart"></i> Attendees Requiring Pastoral Attention (${urgentFollowUps.length})
            </div>
            <div style="max-height: 180px; overflow-y: auto;">
              ${urgentFollowUps.length === 0 ? `<div style="font-size: 12px; color: #15803d;">All attendees attended consistently.</div>` : urgentFollowUps.map(m => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px dashed #fca5a5; font-size: 12px;">
                  <div>
                    <strong>${escapeHtml(m.name)}</strong>
                    ${m.isVisitor ? `<span style="background:#fef3c7;color:#b45309;font-size:9.5px;padding:1px 4px;border-radius:3px;">Visitor</span>` : ''}
                    <span style="font-size: 11px; color: var(--muted); margin-left: 4px;">(${m.phone || 'No phone'})</span>
                  </div>
                  <span style="color: #dc2626; font-weight: 800; font-size: 11px;">Missed ${m.sunday.consecutiveMissed} Sun · ${m.overall.consecutiveMissed} Total</span>
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Most Consistent Members -->
          <div style="border: 1px solid #bbf7d0; border-radius: 6px; padding: 12px; background: #f0fdf4;">
            <div style="font-weight: 800; font-size: 13px; color: #15803d; margin-bottom: 8px;">
              <i class="fas fa-award"></i> Most Consistent Pillars (${pillars.length})
            </div>
            <div style="max-height: 180px; overflow-y: auto;">
              ${pillars.map(m => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px dashed #bbf7d0; font-size: 12px;">
                  <div>
                    <strong>${escapeHtml(m.name)}</strong>
                    ${m.isVisitor ? `<span style="background:#fef3c7;color:#b45309;font-size:9.5px;padding:1px 4px;border-radius:3px;">Visitor</span>` : ''}
                    <span style="font-size: 11px; color: var(--muted); margin-left: 4px;">(${m.category})</span>
                  </div>
                  <div style="font-size: 11px;">
                    <span style="color: #15803d; font-weight: 800;">Overall ${m.overall.rate}%</span> · 
                    <span style="color: #b45309; font-weight: 800;">🔥 ${m.overall.currentStreak} Streak</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <div style="margin-top: 18px; border-top: 1px solid var(--line); padding-top: 10px; font-size: 11px; color: var(--muted); text-align: center;">
          Confidential Church Leadership Document · Prepared for Head Pastor &amp; Pastoral Board · SOLUTIONS FAITH MINISTRY INTERNATIONAL
        </div>
      `;

      modal.style.display = 'flex';
    }

    function closePastorSummaryModal() {
      const modal = document.getElementById('pastorSummaryModal');
      if (modal) modal.style.display = 'none';
    }

    /* ═════════════════════════════════════════════════════════════════════════
       EXCEL / CSV EXPORT & EXECUTIVE PRINT
    ═════════════════════════════════════════════════════════════════════════ */
    function downloadAnalyticsCSV() {
      if (!currentAnalyticsData || !currentAnalyticsData.members || currentAnalyticsData.members.length === 0) {
        showToast('No analytics records available to export.', 'warning', 'Empty Export');
        return;
      }

      const d = currentAnalyticsData;
      const headers = [
        "#",
        "Attendee Full Name",
        "Attendee Type",
        "Category",
        "Phone Number",
        "Sunday Current Streak",
        "Sunday Longest Streak",
        "Sunday Missed",
        "Sunday Attended",
        "Sunday Held",
        "Sunday Rate %",
        "Wednesday Current Streak",
        "Wednesday Longest Streak",
        "Wednesday Missed",
        "Wednesday Attended",
        "Wednesday Held",
        "Wednesday Rate %",
        "Friday Current Streak",
        "Friday Longest Streak",
        "Friday Missed",
        "Friday Attended",
        "Friday Held",
        "Friday Rate %",
        "Events Attended",
        "Events Held",
        "Events Rate %",
        "Overall Current Streak",
        "Overall Longest Streak",
        "Total Services Attended",
        "Total Services Held",
        "Overall Attendance %",
        "Engagement Score (0-100)",
        "Habit Classification",
        "Pastoral Care Action Status"
      ];

      const rows = d.members.map((m, i) => [
        i + 1,
        `"${m.name.replace(/"/g, '""')}"`,
        `"${m.isVisitor ? 'Visitor / Guest' : 'Church Member'}"`,
        `"${m.category.replace(/"/g, '""')}"`,
        `"${m.phone.replace(/"/g, '""')}"`,
        m.sunday.currentStreak,
        m.sunday.longestStreak,
        m.sunday.consecutiveMissed,
        m.sunday.attended,
        m.sunday.available,
        `${m.sunday.rate}%`,
        m.wednesday.currentStreak,
        m.wednesday.longestStreak,
        m.wednesday.consecutiveMissed,
        m.wednesday.attended,
        m.wednesday.available,
        `${m.wednesday.rate}%`,
        m.friday.currentStreak,
        m.friday.longestStreak,
        m.friday.consecutiveMissed,
        m.friday.attended,
        m.friday.available,
        `${m.friday.rate}%`,
        m.event.attended,
        m.event.available,
        `${m.event.rate}%`,
        m.overall.currentStreak,
        m.overall.longestStreak,
        m.overall.attended,
        m.overall.available,
        `${m.overall.rate}%`,
        m.engagement.score,
        `"${m.habitLabel.replace(/"/g, '""')}"`,
        `"${(m.pastoralFollowUp?.status || 'None').replace(/"/g, '""')}"`
      ]);

      const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `SFMI_Monthly_Attendance_Analytics_${d.period.year}_${String(d.period.month).padStart(2, '0')}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Monthly Member Engagement Matrix exported to CSV successfully!', 'success', 'CSV Exported');
    }

    function printExecutiveReport() {
      openPastorSummaryModal();
    }

    async function archiveMonthlyReportSnapshot() {
      if (!currentAnalyticsData) return;
      const monthSelect = document.getElementById('analyticsMonthSelect');
      const yearSelect = document.getElementById('analyticsYearSelect');
      const year = parseInt(yearSelect.value, 10);
      const month = parseInt(monthSelect.value, 10);

      const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
      const headers = token ? { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };

      try {
        const res = await fetch(`${API_BASE}/attendance/analytics/report/generate`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ year, month })
        });
        if (res.ok) {
          showToast(`Monthly report snapshot for ${currentAnalyticsData.period.label} archived successfully!`, 'success', 'Report Archived');
        } else {
          showToast('Could not archive report snapshot.', 'error', 'Error');
        }
      } catch (err) {
        showToast(err.message, 'error', 'Error');
      }
    }

    /* ══════════════════════════════════════════════════════════════════════
       CONTACT & WHATSAPP MESSAGING CENTER LOGIC
       ══════════════════════════════════════════════════════════════════════ */

    function cleanDuplicateLocationTime(text) {
      if (!text || typeof text !== 'string') return text || '';
      // Pattern 1: Raw duplicate of 'from ..., located at Amasaman, behind the Stadium'
      let s = text.replace(/(,\s*from\s+[^,\n]+,\s*located at Amasaman, behind the Stadium)\s*,\s*from\s+[^,\n]+,\s*located at Amasaman, behind the Stadium/gi, '$1');
      
      // Pattern 2: Template token duplicate 'from *{time}*, located at Amasaman, behind the Stadium'
      s = s.replace(/(,\s*from\s+\*?\{time\}\*?,\s*located at Amasaman, behind the Stadium)\s*,\s*from\s+\*?\{time\}\*?,\s*located at Amasaman, behind the Stadium/gi, '$1');

      // Pattern 3: Substring duplicate guard
      const phrase = 'located at Amasaman, behind the Stadium';
      const firstIdx = s.indexOf(phrase);
      if (firstIdx !== -1) {
        const nextIdx = s.indexOf(phrase, firstIdx + phrase.length);
        if (nextIdx !== -1) {
          const before = s.slice(0, nextIdx);
          const after = s.slice(nextIdx + phrase.length);
          const lastComma = before.lastIndexOf(', from ');
          if (lastComma !== -1 && lastComma > firstIdx) {
            s = s.slice(0, lastComma) + after;
          } else {
            s = s.slice(0, nextIdx) + after;
          }
        }
      }
      return s;
    }

    const DEFAULT_MSG_TEMPLATES = {
      THANK_YOU: `Hello *{fullName}*,

Thank you for worshipping with us at *{churchName}* for our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium.

We were truly blessed by your fellowship and presence. May the Lord multiply His grace, peace, and abundance in your life and household throughout this week.

We eagerly look forward to seeing you again in our next service.

God bless you,
*{churchName}*`,

      WE_MISSED_YOU: `Dear *{fullName}*, warm greetings from *{churchName}*.

We missed your warm fellowship during our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium.

We are reaching out to ensure all is well with you and your family. Please know that you are always in our hearts and prayers. If you have any prayer requests or need any pastoral support, please feel free to reply to this message.

We look forward to worshipping together with you at our next gathering.

God bless you,
*{churchName}*`,

      UPCOMING_REMINDER: `Dear *{fullName}*, grace and peace to you.

This is a gentle reminder that our upcoming *{serviceName}* will be holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium.

Come with great expectation, invite your family and friends, and prepare your heart for an encounter with God's Word, power, and presence.

We cannot wait to worship together with you.

God bless you,
*{churchName}*`,

      VISITOR_WELCOME: `Hello *{fullName}*, a very special and warm welcome from *{churchName}*.

It was our absolute joy and privilege having you as our guest during our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium.

We pray that you experienced the presence of God and felt warmly embraced by our church family. SFMI is a home of faith, love, and purpose, and we warmly invite you to make this your spiritual home.

If there is any way our team can pray for you or assist you, please do not hesitate to reply directly to this message.

God bless you,
*{churchName}*`,

      PRAYER_CHECKIN: `Grace, mercy, and peace be multiplied unto you, *{fullName}*.

The Solutions Team at *{churchName}* is praying for you this week. We trust God is upholding you in divine strength, health, and favor.

_"The Lord bless you and keep you; the Lord make His face shine upon you and be gracious to you."_ — Numbers 6:24-25

Have a victorious and blessed week, and see you soon in church.

God bless you,
*{churchName}*`,

      CUSTOM: `Hello *{fullName}*,

Grace and peace to you from *{churchName}*.

[Type your personalized message here...]

God bless you,
*{churchName}*`
    };

    let MSG_TEMPLATES = { ...DEFAULT_MSG_TEMPLATES };
    try {
      const savedTpls = localStorage.getItem('sfmi_custom_msg_templates');
      if (savedTpls) {
        const parsed = JSON.parse(savedTpls);
        if (parsed && typeof parsed === 'object') {
          ['THANK_YOU', 'WE_MISSED_YOU', 'UPCOMING_REMINDER', 'VISITOR_WELCOME', 'PRAYER_CHECKIN', 'CUSTOM'].forEach(key => {
            if (parsed[key]) {
              // Upgrade location & time phrasing if not already present
              if (!parsed[key].includes('located at Amasaman')) {
                parsed[key] = parsed[key]
                  .replace(/will be holding on \*\{date\}\* at \*\{time\}\* at \*\{churchName\}\*/g, 'will be holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
                  .replace(/will be holding on \*\{date\}\* at \*\{churchName\}\*/g, 'will be holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
                  .replace(/holding on \*\{date\}\* at \*\{time\}\* at \*\{churchName\}\*/g, 'holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
                  .replace(/holding on \*\{date\}\* at \*\{churchName\}\*/g, 'holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
                  .replace(/for our \*\{serviceName\}\* on \*\{date\}\* at \*\{time\}\*/g, 'for our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium')
                  .replace(/for our \*\{serviceName\}\* on \*\{date\}\*/g, 'for our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium')
                  .replace(/during our \*\{serviceName\}\* on \*\{date\}\* at \*\{time\}\*/g, 'during our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium')
                  .replace(/during our \*\{serviceName\}\* on \*\{date\}\*/g, 'during our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium');
              }
              // Upgrade legacy closing signatures
              parsed[key] = parsed[key]
                .replace(/_Blessings & Warm Regards,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
                .replace(/_With love in Christ,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
                .replace(/_In His Service,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
                .replace(/_Warmest Regards,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
                .replace(/_Blessings & Love,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
                .replace(/_Warm Regards,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*');
              parsed[key] = cleanDuplicateLocationTime(parsed[key]);
            }
          });
          localStorage.setItem('sfmi_custom_msg_templates', JSON.stringify(parsed));
          MSG_TEMPLATES = { ...DEFAULT_MSG_TEMPLATES, ...parsed };
        }
      }
    } catch (e) {}

    function handleSettingsMsgTemplateChange() {
      const select = document.getElementById('settingsMsgTemplateSelect');
      const textarea = document.getElementById('settingsMsgBodyTextarea');
      const count = document.getElementById('settingsMsgCharCount');
      if (!select || !textarea) return;
      const tplKey = select.value;
      textarea.value = MSG_TEMPLATES[tplKey] || DEFAULT_MSG_TEMPLATES[tplKey] || '';
      if (count) count.innerText = `${textarea.value.length} characters`;
    }

    function saveSettingsMsgTemplate() {
      const select = document.getElementById('settingsMsgTemplateSelect');
      const textarea = document.getElementById('settingsMsgBodyTextarea');
      if (!select || !textarea) return;
      const tplKey = select.value;
      MSG_TEMPLATES[tplKey] = textarea.value;
      try {
        localStorage.setItem('sfmi_custom_msg_templates', JSON.stringify(MSG_TEMPLATES));
        showToast('Template successfully saved and active!', 'success', 'Saved');
      } catch (e) {}

      // Keep active template backing textarea in sync
      const activeSelect = document.getElementById('msgTemplateSelect');
      if (activeSelect && activeSelect.value === tplKey) {
        const mainTextarea = document.getElementById('msgBodyTextarea');
        if (mainTextarea) mainTextarea.value = textarea.value;
        updateLiveMsgPreview();
      }
    }

    function resetSettingsMsgTemplate() {
      const select = document.getElementById('settingsMsgTemplateSelect');
      const textarea = document.getElementById('settingsMsgBodyTextarea');
      if (!select || !textarea) return;
      const tplKey = select.value;
      if (DEFAULT_MSG_TEMPLATES[tplKey]) {
        textarea.value = DEFAULT_MSG_TEMPLATES[tplKey];
        MSG_TEMPLATES[tplKey] = DEFAULT_MSG_TEMPLATES[tplKey];
        try {
          localStorage.setItem('sfmi_custom_msg_templates', JSON.stringify(MSG_TEMPLATES));
          showToast('Template reset to default note.', 'info', 'Reset');
        } catch (e) {}
        const count = document.getElementById('settingsMsgCharCount');
        if (count) count.innerText = `${textarea.value.length} characters`;

        const activeSelect = document.getElementById('msgTemplateSelect');
        if (activeSelect && activeSelect.value === tplKey) {
          const mainTextarea = document.getElementById('msgBodyTextarea');
          if (mainTextarea) mainTextarea.value = textarea.value;
          updateLiveMsgPreview();
        }
      }
    }

    function insertSettingsMsgToken(token) {
      const textarea = document.getElementById('settingsMsgBodyTextarea');
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const currentVal = textarea.value;
      if (start !== undefined && end !== undefined) {
        textarea.value = currentVal.substring(0, start) + token + currentVal.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + token.length;
      } else {
        textarea.value += ' ' + token;
      }
      textarea.focus();
      const count = document.getElementById('settingsMsgCharCount');
      if (count) count.innerText = `${textarea.value.length} characters`;
    }

    let messagingRecipients = [];
    let filteredMessagingRecipients = [];
    let selectedRecipientIds = new Set();
    let messagingQueue = [];
    let messagingQueueIndex = 0;
    const MSG_CHURCH_NAME = 'Solutions Faith Ministry International';

    function formatPhoneForWhatsApp(raw) {
      if (!raw) return '';
      let digits = String(raw).replace(/[^\d]/g, '');
      if (!digits) return '';
      if (digits.startsWith('0') && digits.length === 10) {
        return '233' + digits.slice(1);
      }
      if (digits.startsWith('233')) {
        return digits;
      }
      if (digits.length === 9) {
        return '233' + digits;
      }
      return digits;
    }

    function formatPhoneDisplay(raw) {
      if (!raw) return '<span style="color: #94a3b8; font-style: italic; font-size: 11.5px;"><i class="fas fa-phone-slash" style="margin-right: 4px;"></i>No Phone</span>';
      const norm = normalizePhoneClient(raw);
      const formatted = norm.length === 10 ? `${norm.slice(0, 3)} ${norm.slice(3, 6)} ${norm.slice(6)}` : escapeHtml(raw);
      return `<span style="display: inline-flex; align-items: center; gap: 5px; color: #064e3b; font-weight: 700;"><i class="fa-brands fa-whatsapp" style="color: #25d366; font-size: 13px;"></i>${formatted}</span>`;
    }

    function getRecentServiceDateIso(svcName) {
      const nameLower = (svcName || '').toLowerCase();
      let targetDay = -1; // 0: Sunday, 3: Wednesday, 5: Friday
      if (nameLower.includes('sunday')) targetDay = 0;
      else if (nameLower.includes('wednesday')) targetDay = 3;
      else if (nameLower.includes('friday')) targetDay = 5;

      const now = new Date();
      if (targetDay !== -1) {
        const currentDay = now.getDay();
        let diff = (currentDay - targetDay + 7) % 7;
        // If today is not the target day, take the most recent occurrence
        const svcDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
        return formatLocalDate(svcDate);
      }
      return formatLocalDate(now);
    }

    function formatLocalDateDisplay(dateInput) {
      if (!dateInput || dateInput === 'TODAY' || dateInput === 'LATEST' || dateInput === 'CUSTOM') {
        const svcSelect = document.getElementById('msgServiceSelect');
        const svcName = svcSelect ? svcSelect.value : '';
        dateInput = getRecentServiceDateIso(svcName);
      }
      let y, m, d;
      if (typeof dateInput === 'string') {
        const match = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (match) {
          y = parseInt(match[1], 10);
          m = parseInt(match[2], 10) - 1;
          d = parseInt(match[3], 10);
        } else {
          const parsed = new Date(dateInput);
          if (!isNaN(parsed.getTime())) {
            y = parsed.getFullYear();
            m = parsed.getMonth();
            d = parsed.getDate();
          }
        }
      } else if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
        y = dateInput.getFullYear();
        m = dateInput.getMonth();
        d = dateInput.getDate();
      }

      if (y !== undefined && m !== undefined && d !== undefined) {
        const dt = new Date(y, m, d);
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${days[dt.getDay()]}, ${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
      }
      return '';
    }

    function getEffectiveSessionDateIso() {
      const dateSelect = document.getElementById('msgSessionDateSelect');
      if (!dateSelect) return 'LATEST';
      if (dateSelect.value === 'CUSTOM') {
        const customInput = document.getElementById('msgCustomDateInput');
        if (customInput && customInput.value) {
          return customInput.value;
        }
        const today = formatLocalDate(new Date());
        if (customInput) customInput.value = today;
        return today;
      }
      return dateSelect.value || 'LATEST';
    }

    function getSelectedSessionDateLabel() {
      const effectiveIso = getEffectiveSessionDateIso();
      if (effectiveIso && effectiveIso !== 'LATEST' && effectiveIso !== 'TODAY' && effectiveIso !== 'CUSTOM') {
        const formatted = formatLocalDateDisplay(effectiveIso);
        if (formatted) return formatted;
      }

      const svcSelect = document.getElementById('msgServiceSelect');
      const svcName = svcSelect ? svcSelect.value : '';
      const canon = (svcName || '').trim().toLowerCase();
      const sessions = (window._programSessionsMap && (window._programSessionsMap[svcName] || window._programSessionsMap[canon])) || [];
      if (sessions.length > 0 && sessions[0].dateIso) {
        return formatLocalDateDisplay(sessions[0].dateIso);
      }

      return formatLocalDateDisplay(getRecentServiceDateIso(svcName));
    }

    async function loadMessagingCenter() {
      // Ensure all members are loaded if not yet fetched
      if (!allMembers || allMembers.length === 0) {
        try {
          const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
          const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
          const res = await fetch(`${API_BASE}/members`, { headers });
          if (res.ok) {
            const rawMembers = await res.json();
            allMembers = Array.isArray(rawMembers) ? rawMembers.map(m => ({
              id: m.id,
              firstName: m.firstName || '',
              lastName: m.lastName || '',
              phone: m.phone || '',
              category: m.category || 'Adult',
              gender: m.gender || '',
              role: m.role || 'Member',
              isGuest: Boolean(m.isGuest)
            })) : [];
          }
        } catch (e) {}
      }

      // Populate Service Select
      const svcSelect = document.getElementById('msgServiceSelect');
      if (svcSelect) {
        const stdServices = getStandardServicesList();
        const cPrograms = (typeof customPrograms !== 'undefined' && Array.isArray(customPrograms)) ? customPrograms : [];
        const allServices = [...stdServices, ...cPrograms];

        const prevSvc = svcSelect.value;
        let optsHtml = '';
        allServices.forEach(s => {
          const timeDisp = getServiceTimeDisplay(s);
          const timeBadge = timeDisp ? ` (${timeDisp})` : '';
          optsHtml += `<option value="${escapeHtml(s.name)}">${s.isStandard ? '⛪ ' : '🌟 [Special Program] '}${escapeHtml(s.name)}${timeBadge}</option>`;
        });
        svcSelect.innerHTML = optsHtml;

        if (prevSvc && allServices.some(s => s.name === prevSvc)) {
          svcSelect.value = prevSvc;
        } else if (typeof currentSelectedService !== 'undefined' && currentSelectedService && currentSelectedService !== 'ALL' && allServices.some(s => s.name === currentSelectedService)) {
          svcSelect.value = currentSelectedService;
        }
        updateMsgServiceTimeBadge();
      }

      // Populate Session Dates for current service
      populateMsgSessionDates();

      // Initialize default template if textarea is blank, or upgrade if missing {time}
      const textarea = document.getElementById('msgBodyTextarea');
      if (textarea) {
        if (!textarea.value.trim()) {
          textarea.value = MSG_TEMPLATES.THANK_YOU;
          const tplSelect = document.getElementById('msgTemplateSelect');
          if (tplSelect) tplSelect.value = 'THANK_YOU';
          const statTpl = document.getElementById('msgStatTemplateName');
          if (statTpl) statTpl.innerText = 'Thank You Note';
        } else {
          if (!textarea.value.includes('located at Amasaman')) {
            textarea.value = textarea.value
              .replace(/will be holding on \*\{date\}\* at \*\{time\}\* at \*\{churchName\}\*/g, 'will be holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
              .replace(/will be holding on \*\{date\}\* at \*\{churchName\}\*/g, 'will be holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
              .replace(/holding on \*\{date\}\* at \*\{time\}\* at \*\{churchName\}\*/g, 'holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
              .replace(/holding on \*\{date\}\* at \*\{churchName\}\*/g, 'holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
              .replace(/for our \*\{serviceName\}\* on \*\{date\}\* at \*\{time\}\*/g, 'for our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium')
              .replace(/for our \*\{serviceName\}\* on \*\{date\}\*/g, 'for our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium')
              .replace(/during our \*\{serviceName\}\* on \*\{date\}\* at \*\{time\}\*/g, 'during our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium')
              .replace(/during our \*\{serviceName\}\* on \*\{date\}\*/g, 'during our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium');
          }
          textarea.value = textarea.value
            .replace(/_Blessings & Warm Regards,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
            .replace(/_With love in Christ,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
            .replace(/_In His Service,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
            .replace(/_Warmest Regards,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
            .replace(/_Blessings & Love,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
            .replace(/_Warm Regards,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*');
          textarea.value = cleanDuplicateLocationTime(textarea.value);
        }
      }

      // Compile and render recipients
      await compileMessagingRecipients();
    }

    function populateMsgSessionDates() {
      const svcSelect = document.getElementById('msgServiceSelect');
      const dateSelect = document.getElementById('msgSessionDateSelect');
      if (!svcSelect || !dateSelect) return;

      const svcName = svcSelect.value;
      const canon = svcName.trim().toLowerCase();
      const sessions = (window._programSessionsMap && (window._programSessionsMap[svcName] || window._programSessionsMap[canon])) || [];

      let optsHtml = '';
      if (sessions.length > 0) {
        sessions.forEach((s, idx) => {
          const isLatest = idx === 0;
          const fullLabel = formatLocalDateDisplay(s.dateIso);
          optsHtml += `<option value="${s.dateIso}" ${isLatest ? 'selected' : ''}>${isLatest ? '📅 Latest: ' : ''}${fullLabel} (${s.count || 0} Attended)</option>`;
        });
      } else {
        const fallbackIso = getRecentServiceDateIso(svcName);
        const fallbackLabel = formatLocalDateDisplay(fallbackIso);
        optsHtml += `<option value="${fallbackIso}" selected>📅 Latest: ${fallbackLabel}</option>`;
      }
      optsHtml += `<option value="CUSTOM">📅 Pick Custom / Upcoming Date...</option>`;
      dateSelect.innerHTML = optsHtml;

      const customInput = document.getElementById('msgCustomDateInput');
      if (customInput) customInput.style.display = 'none';
    }

    function handleMsgSessionDateChange() {
      const dateSelect = document.getElementById('msgSessionDateSelect');
      const customInput = document.getElementById('msgCustomDateInput');
      if (dateSelect && customInput) {
        if (dateSelect.value === 'CUSTOM') {
          customInput.style.display = 'block';
          if (!customInput.value) {
            customInput.value = formatLocalDate(new Date());
          }
        } else {
          customInput.style.display = 'none';
        }
      }
      handleMsgFilterChange();
    }

    function handleMsgCustomDateChange() {
      updateLiveMsgPreview();
    }

    function setMsgTargetGroup(groupKey) {
      const select = document.getElementById('msgTargetGroupSelect');
      if (select) {
        select.value = groupKey;
        document.querySelectorAll('.msg-segment-btn').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-group') === groupKey);
        });
        handleMsgFilterChange();
      }
    }

    function setMsgTemplate(tplKey) {
      const select = document.getElementById('msgTemplateSelect');
      if (select) {
        select.value = tplKey;
        document.querySelectorAll('.msg-tpl-pill').forEach(pill => {
          pill.classList.toggle('active', pill.getAttribute('data-tpl') === tplKey);
        });
        handleMsgTemplateChange();
      }
    }

    async function handleMsgServiceChange() {
      updateMsgServiceTimeBadge();
      populateMsgSessionDates();
      await compileMessagingRecipients();
      updateLiveMsgPreview();
    }

    async function handleMsgFilterChange() {
      const targetGroup = document.getElementById('msgTargetGroupSelect')?.value || 'ATTENDEES';
      const tplSelect = document.getElementById('msgTemplateSelect');
      const textarea = document.getElementById('msgBodyTextarea');

      // Smart template recommendation based on target group
      if (tplSelect && textarea) {
        if (targetGroup === 'ABSENTEES' && tplSelect.value === 'THANK_YOU') {
          tplSelect.value = 'WE_MISSED_YOU';
          textarea.value = cleanDuplicateLocationTime(MSG_TEMPLATES.WE_MISSED_YOU);
          document.getElementById('msgStatTemplateName').innerText = 'We Missed You';
        } else if (targetGroup === 'ATTENDEES' && tplSelect.value === 'WE_MISSED_YOU') {
          tplSelect.value = 'THANK_YOU';
          textarea.value = cleanDuplicateLocationTime(MSG_TEMPLATES.THANK_YOU);
          document.getElementById('msgStatTemplateName').innerText = 'Thank You Note';
        } else if (targetGroup === 'VISITORS' && (tplSelect.value === 'THANK_YOU' || tplSelect.value === 'WE_MISSED_YOU')) {
          tplSelect.value = 'VISITOR_WELCOME';
          textarea.value = cleanDuplicateLocationTime(MSG_TEMPLATES.VISITOR_WELCOME);
          document.getElementById('msgStatTemplateName').innerText = 'Visitor Welcome';
        }
      }

      // Sync active state on segment buttons and template pills
      document.querySelectorAll('.msg-segment-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-group') === targetGroup);
      });
      if (tplSelect) {
        document.querySelectorAll('.msg-tpl-pill').forEach(pill => {
          pill.classList.toggle('active', pill.getAttribute('data-tpl') === tplSelect.value);
        });
      }

      await compileMessagingRecipients();
    }

    function handleMsgTemplateChange() {
      const tplSelect = document.getElementById('msgTemplateSelect');
      const textarea = document.getElementById('msgBodyTextarea');
      const statTpl = document.getElementById('msgStatTemplateName');
      if (!tplSelect || !textarea) return;

      const tplKey = tplSelect.value;
      if (MSG_TEMPLATES[tplKey] !== undefined) {
        textarea.value = cleanDuplicateLocationTime(MSG_TEMPLATES[tplKey]);
      }

      document.querySelectorAll('.msg-tpl-pill').forEach(pill => {
        pill.classList.toggle('active', pill.getAttribute('data-tpl') === tplKey);
      });

      const labels = {
        THANK_YOU: 'Thank You Note',
        WE_MISSED_YOU: 'We Missed You',
        UPCOMING_REMINDER: 'Program Reminder',
        VISITOR_WELCOME: 'Visitor Welcome',
        PRAYER_CHECKIN: 'Prayer Check-In',
        CUSTOM: 'Custom Message'
      };
      if (statTpl) statTpl.innerText = labels[tplKey] || 'Template';

      updateLiveMsgPreview();
    }

    function insertMsgToken(token) {
      const textarea = document.getElementById('msgBodyTextarea');
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const currentVal = textarea.value;

      if (start !== undefined && end !== undefined) {
        textarea.value = currentVal.substring(0, start) + token + currentVal.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + token.length;
      } else {
        textarea.value += ' ' + token;
      }
      textarea.focus();
      updateLiveMsgPreview();
    }

    async function fetchServiceAttendeesForMessaging(serviceName, dateIso) {
      const token = sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      
      let url = `${API_BASE}/attendance/by-service-name?name=${encodeURIComponent(serviceName)}`;
      if (dateIso && dateIso !== 'LATEST') {
        url += `&date=${encodeURIComponent(dateIso)}`;
      }

      try {
        const res = await fetch(url, { headers });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.recent) && data.recent.length > 0) {
            return data.recent;
          }
        }
      } catch (e) {
        console.warn('API fetch attendees failed, checking in-memory cache:', e);
      }

      // Check in-memory serviceAttendanceMap
      const key = `${serviceName}_${dateIso || 'all'}`;
      if (serviceAttendanceMap[key] && Array.isArray(serviceAttendanceMap[key])) {
        return serviceAttendanceMap[key];
      }
      if (serviceAttendanceMap[serviceName] && Array.isArray(serviceAttendanceMap[serviceName])) {
        return serviceAttendanceMap[serviceName];
      }
      return [];
    }

    async function compileMessagingRecipients() {
      const svcSelect = document.getElementById('msgServiceSelect');
      const dateSelect = document.getElementById('msgSessionDateSelect');
      const groupSelect = document.getElementById('msgTargetGroupSelect');

      const svcName = svcSelect ? svcSelect.value : '';
      const dateIso = getEffectiveSessionDateIso();
      const targetGroup = groupSelect ? groupSelect.value : 'ATTENDEES';

      const tbody = document.getElementById('msgRecipientsTableBody');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 26px; color: var(--muted);"><i class="fas fa-spinner fa-spin fa-2x" style="color: #128C7E; margin-bottom: 8px;"></i><br/>Compiling audience recipient records...</td></tr>`;
      }

      // Fetch attendees for this service & date
      const rawAttendees = await fetchServiceAttendeesForMessaging(svcName, dateIso);
      
      // Clean attendees list
      const attendeeList = rawAttendees.map((item, idx) => {
        const fName = item.member?.firstName || item.firstName || '';
        const lName = item.member?.lastName || item.lastName || '';
        const rawPhone = item.member?.phone || item.phone || '';
        const mRole = (item.member?.role || item.role || '').toLowerCase();
        const mCat = (item.member?.category || item.category || '').toLowerCase();
        const isGuest = Boolean(
          item.isGuest ||
          item.member?.isGuest ||
          mRole.includes('visitor') || mRole.includes('first timer') || mRole.includes('first-timer') ||
          mCat.includes('visitor') || mCat.includes('guest') || mCat.includes('first timer') || mCat.includes('first-timer')
        );
        return {
          id: item.memberId || item.member?.id || item.id || `att_${idx}`,
          firstName: fName,
          lastName: lName,
          fullName: `${fName} ${lName}`.trim() || 'Church Member',
          phone: rawPhone,
          normPhone: normalizePhoneClient(rawPhone),
          waPhone: formatPhoneForWhatsApp(rawPhone),
          gender: item.member?.gender || item.gender || '',
          category: isGuest ? 'Visitor / Guest' : (item.member?.category || 'Member'),
          isGuest: isGuest,
          isAttendee: true
        };
      });

      // Build Attendee Lookup Set (normalized phone and ID)
      const attendeePhones = new Set();
      const attendeeIds = new Set();
      const attendeeNames = new Set();
      attendeeList.forEach(a => {
        if (a.normPhone) attendeePhones.add(a.normPhone);
        if (a.id) attendeeIds.add(String(a.id));
        if (a.fullName) attendeeNames.add(a.fullName.toLowerCase());
      });

      let compiled = [];

      if (targetGroup === 'ATTENDEES') {
        compiled = attendeeList;
      } else if (targetGroup === 'ABSENTEES') {
        // Members who did NOT attend
        const regMembers = allMembers.filter(m => !isGuestMember(m));
        compiled = regMembers.filter(m => {
          const mNorm = normalizePhoneClient(m.phone);
          const mName = `${m.firstName} ${m.lastName}`.trim().toLowerCase();
          const isPresent = (mNorm && attendeePhones.has(mNorm)) || 
                            (m.id && attendeeIds.has(String(m.id))) || 
                            attendeeNames.has(mName);
          return !isPresent;
        }).map((m, idx) => ({
          id: m.id || `abs_${idx}`,
          firstName: m.firstName || '',
          lastName: m.lastName || '',
          fullName: `${m.firstName} ${m.lastName}`.trim() || 'Church Member',
          phone: m.phone || '',
          normPhone: normalizePhoneClient(m.phone),
          waPhone: formatPhoneForWhatsApp(m.phone),
          gender: m.gender || '',
          category: 'Absent Member',
          isGuest: false,
          isAttendee: false
        }));
      } else if (targetGroup === 'VISITORS') {
        // Visitors from attendance session + directory visitors
        const guestAttendees = attendeeList.filter(a => a.isGuest);
        const guestDirectory = allMembers.filter(isGuestMember).map((m, idx) => ({
          id: m.id || `gst_${idx}`,
          firstName: m.firstName || '',
          lastName: m.lastName || '',
          fullName: `${m.firstName} ${m.lastName}`.trim() || 'Visitor',
          phone: m.phone || '',
          normPhone: normalizePhoneClient(m.phone),
          waPhone: formatPhoneForWhatsApp(m.phone),
          gender: m.gender || '',
          category: 'Visitor / First-Timer',
          isGuest: true,
          isAttendee: false
        }));

        const combinedGuests = [...guestAttendees, ...guestDirectory];
        const seenGuestPhones = new Set();
        compiled = combinedGuests.filter(g => {
          const key = g.normPhone || g.fullName.toLowerCase();
          if (seenGuestPhones.has(key)) return false;
          seenGuestPhones.add(key);
          return true;
        });
      } else if (targetGroup === 'ALL_MEMBERS') {
        // Full member directory
        compiled = allMembers.filter(m => !isGuestMember(m)).map((m, idx) => ({
          id: m.id || `mem_${idx}`,
          firstName: m.firstName || '',
          lastName: m.lastName || '',
          fullName: `${m.firstName} ${m.lastName}`.trim() || 'Church Member',
          phone: m.phone || '',
          normPhone: normalizePhoneClient(m.phone),
          waPhone: formatPhoneForWhatsApp(m.phone),
          gender: m.gender || '',
          category: m.category || 'Member',
          isGuest: false,
          isAttendee: attendeePhones.has(normalizePhoneClient(m.phone))
        }));
      } else if (targetGroup === 'YOUTH') {
        compiled = allMembers.filter(m => {
          const c = (m.category || '').toLowerCase();
          return c.includes('youth') || c.includes('young') || c.includes('teen');
        }).map((m, idx) => ({
          id: m.id || `yth_${idx}`,
          firstName: m.firstName || '',
          lastName: m.lastName || '',
          fullName: `${m.firstName} ${m.lastName}`.trim(),
          phone: m.phone || '',
          normPhone: normalizePhoneClient(m.phone),
          waPhone: formatPhoneForWhatsApp(m.phone),
          gender: m.gender || '',
          category: 'Youth',
          isGuest: isGuestMember(m),
          isAttendee: attendeePhones.has(normalizePhoneClient(m.phone))
        }));
      } else if (targetGroup === 'MEN') {
        compiled = allMembers.filter(m => {
          const g = (m.gender || '').toLowerCase();
          return g === 'male' || g === 'man';
        }).map((m, idx) => ({
          id: m.id || `men_${idx}`,
          firstName: m.firstName || '',
          lastName: m.lastName || '',
          fullName: `${m.firstName} ${m.lastName}`.trim(),
          phone: m.phone || '',
          normPhone: normalizePhoneClient(m.phone),
          waPhone: formatPhoneForWhatsApp(m.phone),
          gender: 'Male',
          category: "Men's Fellowship",
          isGuest: isGuestMember(m),
          isAttendee: attendeePhones.has(normalizePhoneClient(m.phone))
        }));
      } else if (targetGroup === 'WOMEN') {
        compiled = allMembers.filter(m => {
          const g = (m.gender || '').toLowerCase();
          return g === 'female' || g === 'woman';
        }).map((m, idx) => ({
          id: m.id || `wmn_${idx}`,
          firstName: m.firstName || '',
          lastName: m.lastName || '',
          fullName: `${m.firstName} ${m.lastName}`.trim(),
          phone: m.phone || '',
          normPhone: normalizePhoneClient(m.phone),
          waPhone: formatPhoneForWhatsApp(m.phone),
          gender: 'Female',
          category: "Women's Fellowship",
          isGuest: isGuestMember(m),
          isAttendee: attendeePhones.has(normalizePhoneClient(m.phone))
        }));
      }

      // Deduplicate by phone or full name
      const deduped = [];
      const seenKeys = new Set();
      compiled.forEach(r => {
        const key = r.normPhone || `${r.firstName}_${r.lastName}`.toLowerCase();
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          deduped.push(r);
        }
      });

      // Sort alphabetically by firstName
      deduped.sort((a, b) => a.fullName.localeCompare(b.fullName));

      messagingRecipients = deduped;
      filteredMessagingRecipients = [...deduped];

      // Auto-select all recipients who have a valid WhatsApp phone number
      selectedRecipientIds = new Set(deduped.filter(r => Boolean(r.waPhone)).map(r => String(r.id)));

      // Update Overview Statistics
      const totalContactableInDir = allMembers.filter(m => normalizePhoneClient(m.phone).length >= 9).length;
      const validPhoneRecipients = deduped.filter(r => Boolean(r.waPhone)).length;

      const statContactable = document.getElementById('msgStatContactableCount');
      if (statContactable) statContactable.innerText = totalContactableInDir;

      const statSelected = document.getElementById('msgStatSelectedCount');
      if (statSelected) statSelected.innerText = selectedRecipientIds.size;

      const subContactable = document.getElementById('msgStatContactableSub');
      if (subContactable) subContactable.innerText = `${validPhoneRecipients} reachable in current audience`;

      const subSelected = document.getElementById('msgStatSelectedSub');
      if (subSelected) subSelected.innerText = `${selectedRecipientIds.size} queued for broadcast`;

      const subFilter = document.getElementById('msgRecipientFilterSubtitle');
      if (subFilter) {
        subFilter.innerText = `${validPhoneRecipients} reachable with verified WhatsApp numbers (${deduped.length - validPhoneRecipients} without phone)`;
      }

      // Update tactile Segment Button live count badges
      const btnAtt = document.querySelector('.msg-segment-btn[data-group="ATTENDEES"]');
      if (btnAtt) btnAtt.innerHTML = `<i class="fas fa-check-circle" style="color: #107c41;"></i> Attendees <span class="count-badge">${attendeeList.length}</span>`;

      const btnAbs = document.querySelector('.msg-segment-btn[data-group="ABSENTEES"]');
      if (btnAbs) {
        const absCount = Math.max(0, allMembers.filter(m => !isGuestMember(m)).length - attendeeList.filter(a => !a.isGuest).length);
        btnAbs.innerHTML = `<i class="fas fa-heart-crack" style="color: #dc2626;"></i> Absentees <span class="count-badge">${absCount}</span>`;
      }

      const btnGst = document.querySelector('.msg-segment-btn[data-group="VISITORS"]');
      if (btnGst) {
        const gstCount = attendeeList.filter(a => a.isGuest).length + allMembers.filter(isGuestMember).length;
        btnGst.innerHTML = `<i class="fas fa-star" style="color: var(--accent);"></i> Visitors <span class="count-badge">${gstCount}</span>`;
      }

      const btnAll = document.querySelector('.msg-segment-btn[data-group="ALL_MEMBERS"]');
      if (btnAll) {
        btnAll.innerHTML = `<i class="fas fa-address-book" style="color: #2563eb;"></i> Directory <span class="count-badge">${allMembers.filter(m => !isGuestMember(m)).length}</span>`;
      }

      renderMessagingRecipientsTable();
      updateLiveMsgPreview();
    }

    function renderMessagingRecipientsTable() {
      const tbody = document.getElementById('msgRecipientsTableBody');
      const countLbl = document.getElementById('msgRecipientCountLabel');
      const selectAll = document.getElementById('msgSelectAllCheckbox');
      if (!tbody) return;

      if (countLbl) countLbl.innerText = filteredMessagingRecipients.length;

      if (filteredMessagingRecipients.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; padding: 36px 16px; color: var(--muted);">
              <i class="fa-brands fa-whatsapp" style="font-size: 36px; color: #cbd5e1; margin-bottom: 12px; display: block;"></i>
              <strong style="color: var(--ink); font-size: 14px; display: block; margin-bottom: 4px;">No contacts found matching this criteria</strong>
              <span style="font-size: 12px;">Try switching to another service date, selecting a different target group, or clearing your search.</span>
            </td>
          </tr>
        `;
        if (selectAll) selectAll.checked = false;
        return;
      }

      let allChecked = true;
      let html = '';

      filteredMessagingRecipients.forEach(rec => {
        const isChecked = selectedRecipientIds.has(String(rec.id));
        if (!isChecked) allChecked = false;

        const hasPhone = Boolean(rec.waPhone);
        const initial = (rec.firstName.trim().charAt(0) || rec.fullName.trim().charAt(0) || 'M').toUpperCase();
        
        let badgeColor = 'background: rgba(16, 124, 65, 0.1); color: #107c41; border: 1px solid rgba(16, 124, 65, 0.25);';
        let badgeIcon = '<i class="fas fa-check" style="font-size: 9px; margin-right: 3px;"></i>';
        if (rec.isGuest) {
          badgeColor = 'background: rgba(200, 155, 85, 0.15); color: #b45309; border: 1px solid rgba(200, 155, 85, 0.35);';
          badgeIcon = '<i class="fas fa-star" style="font-size: 9px; margin-right: 3px;"></i>';
        } else if (rec.category === 'Absent Member') {
          badgeColor = 'background: rgba(239, 68, 68, 0.1); color: #dc2626; border: 1px solid rgba(239, 68, 68, 0.25);';
          badgeIcon = '<i class="fas fa-user-clock" style="font-size: 9px; margin-right: 3px;"></i>';
        }

        html += `
          <tr style="border-bottom: 1px solid var(--line); transition: background 0.15s ease;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
            <td style="text-align: center; padding: 10px 8px;">
              <input type="checkbox" ${isChecked ? 'checked' : ''} ${!hasPhone ? 'disabled title="No valid phone number"' : ''} onchange="toggleRecipientSelect('${escapeHtml(rec.id)}', this.checked)" style="accent-color: #107c41; width: 14px; height: 14px; cursor: pointer;" />
            </td>
            <td style="padding: 10px 12px;">
              <div style="display: flex; align-items: center; gap: 10px;">
                <div style="width: 32px; height: 32px; border-radius: 50%; background: ${rec.isGuest ? 'linear-gradient(135deg, #c89b55, #b45309)' : 'linear-gradient(135deg, #14532d, #047857)'}; color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.12);">
                  ${escapeHtml(initial)}
                </div>
                <div>
                  <strong style="color: var(--ink); font-size: 13px; display: block;">${escapeHtml(rec.fullName)}</strong>
                  ${rec.gender ? `<span style="font-size: 11px; color: var(--muted);">${escapeHtml(rec.gender)}</span>` : ''}
                </div>
              </div>
            </td>
            <td style="padding: 10px 12px;">
              <span style="display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 700; ${badgeColor}">
                ${badgeIcon}${escapeHtml(rec.category)}
              </span>
            </td>
            <td style="padding: 10px 12px; font-family: monospace; font-size: 12px;">
              ${formatPhoneDisplay(rec.phone)}
            </td>
            <td style="padding: 10px 12px; text-align: center;">
              ${hasPhone ? `
                <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
                  <button type="button" class="btn-main" style="background: linear-gradient(135deg, #25d366 0%, #128C7E 100%); color: white; border: none; padding: 5px 9px; font-size: 11px; font-weight: 700; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 2px 6px rgba(37,211,102,0.25); cursor: pointer;" onclick="sendDirectWhatsAppToRecipient('${escapeHtml(rec.id)}')" title="Open WhatsApp chat directly">
                    <i class="fa-brands fa-whatsapp"></i> Chat
                  </button>
                  <button type="button" class="btn-main" style="background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: white; border: none; padding: 5px 9px; font-size: 11px; font-weight: 700; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 2px 6px rgba(2,132,199,0.25); cursor: pointer;" onclick="sendDirectSmsToRecipient('${escapeHtml(rec.id)}')" title="Send direct SMS via Arkesel">
                    <i class="fas fa-comment-sms"></i> SMS
                  </button>
                </div>
              ` : `
                <span style="font-size: 11px; color: #94a3b8; font-style: italic;">No Phone</span>
              `}
            </td>
          </tr>
        `;
      });

      tbody.innerHTML = html;
      if (selectAll) selectAll.checked = allChecked && filteredMessagingRecipients.length > 0;
    }

    function toggleRecipientSelect(id, checked) {
      if (checked) {
        selectedRecipientIds.add(String(id));
      } else {
        selectedRecipientIds.delete(String(id));
      }
      const statSelected = document.getElementById('msgStatSelectedCount');
      if (statSelected) statSelected.innerText = selectedRecipientIds.size;
    }

    function toggleSelectAllMsgRecipients(isChecked) {
      filteredMessagingRecipients.forEach(r => {
        if (r.waPhone) {
          if (isChecked) selectedRecipientIds.add(String(r.id));
          else selectedRecipientIds.delete(String(r.id));
        }
      });
      renderMessagingRecipientsTable();
      const statSelected = document.getElementById('msgStatSelectedCount');
      if (statSelected) statSelected.innerText = selectedRecipientIds.size;
    }

    function filterMsgRecipientsList() {
      const q = (document.getElementById('msgSearchInput')?.value || '').toLowerCase().trim();
      if (!q) {
        filteredMessagingRecipients = [...messagingRecipients];
      } else {
        filteredMessagingRecipients = messagingRecipients.filter(r => 
          r.fullName.toLowerCase().includes(q) ||
          (r.phone && r.phone.toLowerCase().includes(q)) ||
          r.category.toLowerCase().includes(q)
        );
      }
      renderMessagingRecipientsTable();
    }

    function getServiceTimeDisplay(service) {
      if (!service) return '';
      const name = (typeof service === 'string' ? service : (service.name || '')).trim();
      const lower = name.toLowerCase();

      // If service object has schedule property
      if (typeof service === 'object' && service.schedule) {
        const s = service.schedule;
        return s.includes('·') ? s.split('·')[1].trim() : s.trim();
      }

      // Check standard services from storage or defaults
      const storage = typeof localStorage !== 'undefined' ? localStorage : null;
      if (lower.includes('wednesday') || lower.includes('time with the lord') || lower.includes('time with lord')) {
        const sched = storage ? storage.getItem('sfmi_svc_sched_wed') : null;
        return sched && sched.includes('·') ? sched.split('·')[1].trim() : '6:00 PM – 8:00 PM';
      }
      if (lower.includes('friday') || lower.includes('prophetic') || lower.includes('deliverance')) {
        const sched = storage ? storage.getItem('sfmi_svc_sched_fri') : null;
        return sched && sched.includes('·') ? sched.split('·')[1].trim() : '6:00 PM – 8:00 PM';
      }
      if (lower.includes('sunday') || lower.includes('family & friends') || lower.includes('family and friends')) {
        const sched = storage ? storage.getItem('sfmi_svc_sched_sun') : null;
        return sched && sched.includes('·') ? sched.split('·')[1].trim() : '7:00 AM – 11:00 AM';
      }

      // Check custom programs array
      if (typeof customPrograms !== 'undefined' && Array.isArray(customPrograms)) {
        const found = customPrograms.find(p => (p.name || '').toLowerCase() === lower);
        if (found && found.schedule) {
          const s = found.schedule;
          return s.includes('·') ? s.split('·')[1].trim() : s.trim();
        }
      }

      return '';
    }

    function getServiceStartTime(service) {
      const disp = getServiceTimeDisplay(service);
      if (!disp) return '6:00 PM';
      const parts = disp.split(/[–—-]/);
      return parts.length > 0 ? parts[0].trim() : disp.trim();
    }

    function getServiceTimeRange(service) {
      const disp = getServiceTimeDisplay(service);
      if (!disp) return '6:00 PM to 8:00 PM';
      return disp.replace(/\s*[–—-]\s*/, ' to ');
    }

    function updateMsgServiceTimeBadge() {
      const svcSelect = document.getElementById('msgServiceSelect');
      const badge = document.getElementById('msgServiceTimeBadge');
      if (!svcSelect || !badge) return;
      const timeDisp = getServiceTimeDisplay(svcSelect.value);
      if (timeDisp) {
        badge.innerHTML = `<i class="far fa-clock"></i> ${escapeHtml(timeDisp)}`;
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }

    function formatWhatsAppMessageForRecipient(templateText, recipient, serviceName, sessionDateStr) {
      if (!templateText) return '';
      const fullName = (recipient?.fullName || '').trim() || (recipient?.firstName || 'Beloved');
      const fName = fullName; // User requested to use the person full name
      const svc = serviceName || (document.getElementById('msgServiceSelect')?.value || 'Sunday: Family & Friends Service');
      const timeStr = getServiceTimeRange(svc);
      const fullTimeStr = getServiceTimeDisplay(svc);
      
      let dateStr = '';
      if (sessionDateStr && sessionDateStr !== 'LATEST' && sessionDateStr !== 'TODAY' && sessionDateStr !== 'CUSTOM') {
        dateStr = formatLocalDateDisplay(sessionDateStr);
      }
      if (!dateStr) {
        dateStr = getSelectedSessionDateLabel();
      }

      let res = templateText
        .replace(/\uFFFD/g, '')
        .replace(/Solutions Faith Ministries International/gi, 'Solutions Faith Ministry International')
        .replace(/Solutions Faith Ministries/gi, 'Solutions Faith Ministry');

      // Auto-migrate phrasing if using legacy template wording
      if (!res.includes('located at Amasaman')) {
        res = res
          .replace(/will be holding on \*\{date\}\* at \*\{time\}\* at \*\{churchName\}\*/g, 'will be holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
          .replace(/will be holding on \*\{date\}\* at \*\{churchName\}\*/g, 'will be holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
          .replace(/holding on \*\{date\}\* at \*\{time\}\* at \*\{churchName\}\*/g, 'holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
          .replace(/holding on \*\{date\}\* at \*\{churchName\}\*/g, 'holding on *{date}* at *{churchName}*, from *{time}*, located at Amasaman, behind the Stadium')
          .replace(/for our \*\{serviceName\}\* on \*\{date\}\* at \*\{time\}\*/g, 'for our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium')
          .replace(/for our \*\{serviceName\}\* on \*\{date\}\*/g, 'for our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium')
          .replace(/during our \*\{serviceName\}\* on \*\{date\}\* at \*\{time\}\*/g, 'during our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium')
          .replace(/during our \*\{serviceName\}\* on \*\{date\}\*/g, 'during our *{serviceName}* on *{date}*, from *{time}*, located at Amasaman, behind the Stadium');
      }

      // Auto-migrate legacy signatures
      res = res
        .replace(/_Blessings & Warm Regards,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
        .replace(/_With love in Christ,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
        .replace(/_In His Service,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
        .replace(/_Warmest Regards,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
        .replace(/_Blessings & Love,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
        .replace(/_Warm Regards,_\s*\*Solutions Team\*\s*\*\{churchName\}\*/gi, 'God bless you,\n*{churchName}*')
        .replace(/Blessings & Warm Regards,\s*Solutions Team\s*Solutions Faith Ministry International/gi, 'God bless you,\nSolutions Faith Ministry International')
        .replace(/In His Service,\s*Solutions Team\s*Solutions Faith Ministry International/gi, 'God bless you,\nSolutions Faith Ministry International')
        .replace(/With love in Christ,\s*Solutions Team\s*Solutions Faith Ministry International/gi, 'God bless you,\nSolutions Faith Ministry International')
        .replace(/Warmest Regards,\s*Solutions Team\s*Solutions Faith Ministry International/gi, 'God bless you,\nSolutions Faith Ministry International');

      res = cleanDuplicateLocationTime(res);
      res = res
        .replace(/\{fullName\}/g, fullName)
        .replace(/\{firstName\}/g, fName)
        .replace(/\{serviceName\}/g, svc)
        .replace(/\{date\}/g, dateStr)
        .replace(/\{time\}/g, timeStr)
        .replace(/\{schedule\}/g, fullTimeStr)
        .replace(/\{churchName\}/g, MSG_CHURCH_NAME);

      return cleanDuplicateLocationTime(res);
    }

    function updateLiveMsgPreview() {
      const textarea = document.getElementById('msgBodyTextarea');
      const charCount = document.getElementById('msgCharCount');
      const bubble = document.getElementById('msgPreviewBubbleContent');
      const nameEl = document.getElementById('msgPreviewRecipientName');
      const phoneEl = document.getElementById('msgPreviewRecipientPhone');
      const avatarEl = document.getElementById('msgPreviewAvatar');
      const timeEl = document.getElementById('msgPreviewTime');

      if (!textarea) return;
      if (textarea.value) {
        const cleaned = cleanDuplicateLocationTime(textarea.value);
        if (cleaned !== textarea.value) {
          textarea.value = cleaned;
        }
      }
      const val = textarea.value;

      if (charCount) charCount.innerText = `${val.length} characters`;

      // Pick preview recipient
      const sample = (filteredMessagingRecipients && filteredMessagingRecipients.length > 0)
        ? filteredMessagingRecipients[0]
        : (messagingRecipients && messagingRecipients.length > 0 ? messagingRecipients[0] : {
            firstName: 'Emmanuel',
            lastName: 'Mensah',
            fullName: 'Emmanuel Mensah',
            phone: '0241234567',
            waPhone: '233241234567'
          });

      const svcSelect = document.getElementById('msgServiceSelect');
      const svcName = svcSelect ? svcSelect.value : 'Sunday: Family & Friends Service';
      const dateIso = getEffectiveSessionDateIso();

      const personalized = formatWhatsAppMessageForRecipient(val, sample, svcName, dateIso);

      // Render formatting: *bold* -> <strong>, _italics_ -> <em>
      let formattedHtml = escapeHtml(personalized)
        .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
        .replace(/_([^_]+)_/g, '<em>$1</em>');

      if (bubble) bubble.innerHTML = formattedHtml;
      if (nameEl) nameEl.innerText = `${sample.fullName} (Sample Preview)`;
      if (phoneEl) phoneEl.innerText = sample.phone ? normalizePhoneClient(sample.phone) : '+233 24 123 4567';
      if (avatarEl) avatarEl.innerText = (sample.firstName.trim().charAt(0) || 'S').toUpperCase();

      if (timeEl) {
        const d = new Date();
        timeEl.innerText = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    }

    function sendDirectWhatsAppToRecipient(recId) {
      const rec = messagingRecipients.find(r => String(r.id) === String(recId));
      if (!rec || !rec.waPhone) {
        showToast('This recipient does not have a valid WhatsApp phone number.', 'warning', 'No Phone');
        return;
      }

      const textarea = document.getElementById('msgBodyTextarea');
      const template = textarea ? textarea.value : MSG_TEMPLATES.THANK_YOU;
      const svcName = document.getElementById('msgServiceSelect')?.value || 'Service';
      const dateIso = getEffectiveSessionDateIso();

      const text = formatWhatsAppMessageForRecipient(template, rec, svcName, dateIso);
      const url = `https://wa.me/${rec.waPhone}?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank');
      showToast(`Opening WhatsApp chat with <strong>${escapeHtml(rec.fullName)}</strong>...`, 'success', 'WhatsApp Direct');
    }

    /* ══════════════════════════════════════════════════════════════════════
       WHATSAPP DISPATCHER QUEUE MODAL
       ══════════════════════════════════════════════════════════════════════ */

    function launchWhatsAppDispatcherQueue() {
      // Gather all selected recipients who have valid WhatsApp phone
      const selected = messagingRecipients.filter(r => selectedRecipientIds.has(String(r.id)) && Boolean(r.waPhone));

      if (selected.length === 0) {
        showToast('Please select at least one recipient with a valid phone number from the roster.', 'warning', 'No Recipients Selected');
        return;
      }

      messagingQueue = selected;
      messagingQueueIndex = 0;

      const modal = document.getElementById('whatsappDispatchModal');
      if (modal) modal.style.display = 'flex';

      renderCurrentQueueItem();
    }

    function renderCurrentQueueItem() {
      const progressText = document.getElementById('queueProgressText');
      const progressPercent = document.getElementById('queueProgressPercent');
      const progressBar = document.getElementById('queueProgressBar');
      const nameEl = document.getElementById('queueRecipientName');
      const phoneEl = document.getElementById('queueRecipientPhone');
      const catEl = document.getElementById('queueRecipientCategory');
      const avatarEl = document.getElementById('queueRecipientAvatar');
      const msgBox = document.getElementById('queueMessageContent');
      const sendBtn = document.getElementById('btnQueueSendWhatsApp');

      const total = messagingQueue.length;

      // Completion check
      if (messagingQueueIndex >= total) {
        if (progressText) progressText.innerText = `All ${total} recipients processed! 🎉`;
        if (progressPercent) progressPercent.innerText = '100% Completed';
        if (progressBar) progressBar.style.width = '100%';

        if (nameEl) nameEl.innerText = 'Queue Completed';
        if (phoneEl) phoneEl.innerText = 'All selected messages dispatched';
        if (catEl) catEl.innerText = 'Done';
        if (avatarEl) avatarEl.innerHTML = '<i class="fas fa-check"></i>';
        if (msgBox) {
          msgBox.innerHTML = `<div style="text-align: center; padding: 18px 10px; color: #107c41;">
            <i class="fas fa-circle-check" style="font-size: 38px; margin-bottom: 8px;"></i>
            <h4 style="margin: 0 0 6px 0; font-size: 16px;">Queue Successfully Finished!</h4>
            <p style="margin: 0; font-size: 12.5px; color: var(--ink);">You have cycled through all ${total} selected recipients. You can safely close this dispatcher.</p>
          </div>`;
        }
        if (sendBtn) {
          sendBtn.innerHTML = '<i class="fas fa-check"></i> Finish &amp; Close Dispatcher';
          sendBtn.onclick = closeWhatsAppDispatchModal;
          sendBtn.style.background = '#107c41';
        }
        return;
      }

      const rec = messagingQueue[messagingQueueIndex];
      const pct = Math.round(((messagingQueueIndex + 1) / total) * 100);

      if (progressText) progressText.innerText = `Recipient ${messagingQueueIndex + 1} of ${total}`;
      if (progressPercent) progressPercent.innerText = `${pct}% Completed`;
      if (progressBar) progressBar.style.width = `${pct}%`;

      if (nameEl) nameEl.innerText = rec.fullName;
      if (phoneEl) phoneEl.innerText = rec.phone ? normalizePhoneClient(rec.phone) : '';
      if (catEl) catEl.innerText = rec.category;
      if (avatarEl) avatarEl.innerText = (rec.firstName.trim().charAt(0) || 'M').toUpperCase();

      const textarea = document.getElementById('msgBodyTextarea');
      const template = textarea ? textarea.value : MSG_TEMPLATES.THANK_YOU;
      const svcName = document.getElementById('msgServiceSelect')?.value || 'Service';
      const dateIso = getEffectiveSessionDateIso();

      const personalized = formatWhatsAppMessageForRecipient(template, rec, svcName, dateIso);
      if (msgBox) msgBox.innerText = personalized;

      if (sendBtn) {
        sendBtn.innerHTML = '<i class="fa-brands fa-whatsapp" style="font-size: 18px; margin-right: 6px;"></i> Send on WhatsApp &amp; Next';
        sendBtn.onclick = executeQueueSendAndAdvance;
        sendBtn.style.background = '#25d366';
      }
    }

    function executeQueueSendAndAdvance() {
      if (messagingQueueIndex >= messagingQueue.length) {
        closeWhatsAppDispatchModal();
        return;
      }

      const rec = messagingQueue[messagingQueueIndex];
      const textarea = document.getElementById('msgBodyTextarea');
      const template = textarea ? textarea.value : MSG_TEMPLATES.THANK_YOU;
      const svcName = document.getElementById('msgServiceSelect')?.value || 'Service';
      const dateIso = getEffectiveSessionDateIso();

      const personalized = formatWhatsAppMessageForRecipient(template, rec, svcName, dateIso);
      const url = `https://wa.me/${rec.waPhone}?text=${encodeURIComponent(personalized)}`;

      // Open WhatsApp chat
      window.open(url, '_blank');

      // Advance queue
      messagingQueueIndex++;
      renderCurrentQueueItem();
    }

    function queueSkipRecipient() {
      if (messagingQueueIndex < messagingQueue.length) {
        messagingQueueIndex++;
        renderCurrentQueueItem();
      }
    }

    function queuePreviousRecipient() {
      if (messagingQueueIndex > 0) {
        messagingQueueIndex--;
        renderCurrentQueueItem();
      }
    }

    function closeWhatsAppDispatchModal() {
      const modal = document.getElementById('whatsappDispatchModal');
      if (modal) modal.style.display = 'none';
    }

    function copyAllRecipientPhones() {
      const selected = messagingRecipients.filter(r => selectedRecipientIds.has(String(r.id)) && Boolean(r.waPhone));
      if (selected.length === 0) {
        showToast('No recipients selected with valid phone numbers.', 'warning', 'Empty Selection');
        return;
      }

      const phones = selected.map(r => r.normPhone || r.phone).filter(Boolean);
      const csvPhones = phones.join(', ');

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(csvPhones).then(() => {
          showToast(`Copied <strong>${phones.length}</strong> phone numbers to clipboard! You can paste directly into WhatsApp broadcast lists.`, 'success', 'Numbers Copied');
        }).catch(() => {
          prompt('Copy all recipient phone numbers below:', csvPhones);
        });
      } else {
        prompt('Copy all recipient phone numbers below:', csvPhones);
      }
    }

    function exportMessagingRosterCsv() {
      if (!messagingRecipients || messagingRecipients.length === 0) {
        showToast('No recipient records available to export.', 'warning', 'Export Empty');
        return;
      }

      const svcName = document.getElementById('msgServiceSelect')?.value || 'Service';
      const dateIso = document.getElementById('msgSessionDateSelect')?.value || 'all';

      const headers = ['Recipient Name', 'First Name', 'Last Name', 'Phone Number', 'WhatsApp Number', 'Category / Status', 'Gender'];
      const rows = messagingRecipients.map(r => [
        `"${(r.fullName || '').replace(/"/g, '""')}"`,
        `"${(r.firstName || '').replace(/"/g, '""')}"`,
        `"${(r.lastName || '').replace(/"/g, '""')}"`,
        `"${(r.normPhone || r.phone || '').replace(/"/g, '""')}"`,
        `"${(r.waPhone || '').replace(/"/g, '""')}"`,
        `"${(r.category || '').replace(/"/g, '""')}"`,
        `"${(r.gender || '').replace(/"/g, '""')}"`
      ]);

      const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `SFMI_Messaging_Roster_${svcName.replace(/[^a-zA-Z0-9]/g, '_')}_${dateIso}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      showToast(`Exported ${messagingRecipients.length} messaging recipients to CSV!`, 'success', 'CSV Exported');
    }

    function syncMessagingViewMode() {
      // Responsive hook for messaging section
    }
    window.addEventListener("resize", syncMessagingViewMode);

    /* ══════════════════════════════════════════════════════════════════════
       ARKESEL SMS GATEWAY INTEGRATION
       ══════════════════════════════════════════════════════════════════════ */

    async function loadArkeselSmsBalance() {
      const balEl = document.getElementById('msgStatSmsBalance');
      const mainEl = document.getElementById('msgStatSmsMainBalance');
      const statusEl = document.getElementById('settingsSmsLiveStatus');
      if (balEl) balEl.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:11px;"></i> Checking...';

      try {
        const token = await getAdminAuthToken();
        const customKey = localStorage.getItem('sfmi_arkesel_api_key') || document.getElementById('settingsSmsApiKey')?.value?.trim();
        const query = customKey ? `?apiKey=${encodeURIComponent(customKey)}` : '';
        const res = await fetch(`${API_BASE}/sms/balance${query}`, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });

        if (res.ok) {
          const data = await res.json();
          if (data && data.success) {
            if (balEl) balEl.innerText = `${data.smsBalance} Credits`;
            if (mainEl) mainEl.innerText = `Main: ${data.mainBalance || 'GHS 0.00'}`;
            if (statusEl) {
              statusEl.innerHTML = `<i class="fas fa-check-circle"></i> Connected: ${data.smsBalance} SMS Credits`;
              statusEl.style.color = '#15803d';
              statusEl.style.background = '#e8f5e9';
            }
            return data;
          } else {
            if (balEl) balEl.innerText = 'SMS Gateway';
            if (mainEl) mainEl.innerText = 'Arkesel Ready';
            if (statusEl) {
              statusEl.innerHTML = `<i class="fas fa-circle-info"></i> Gateway Key Registered (${data.error || 'Ready'})`;
              statusEl.style.color = '#0284c7';
              statusEl.style.background = '#e0f2fe';
            }
          }
        } else {
          if (balEl) balEl.innerText = 'SMS Gateway';
          if (mainEl) mainEl.innerText = 'Direct SMS';
        }
      } catch (err) {
        if (balEl) balEl.innerText = 'SMS Gateway';
        if (mainEl) mainEl.innerText = 'Direct SMS';
      }
      return null;
    }

    async function sendDirectSmsToRecipient(recId) {
      const rec = messagingRecipients.find(r => String(r.id) === String(recId));
      if (!rec || !rec.phone) {
        showToast('This recipient does not have a valid phone number.', 'warning', 'No Phone');
        return;
      }

      const textarea = document.getElementById('msgBodyTextarea');
      const template = textarea ? textarea.value : MSG_TEMPLATES.THANK_YOU;
      const svcName = document.getElementById('msgServiceSelect')?.value || 'Service';
      const dateIso = getEffectiveSessionDateIso();

      const personalized = formatWhatsAppMessageForRecipient(template, rec, svcName, dateIso);
      // Remove WhatsApp formatting symbols (*, _) for clean SMS text
      const cleanSmsText = personalized.replace(/\*/g, '').replace(/_/g, '').trim();

      const confirmed = await showConfirmModal(
        `Send SMS to ${escapeHtml(rec.fullName)}?`,
        `<div style="text-align: left; background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid var(--line); font-size: 13px; color: var(--ink); line-height: 1.5; white-space: pre-wrap; margin-bottom: 8px;">${escapeHtml(cleanSmsText)}</div>
        <div style="font-size: 12px; color: var(--muted);"><i class="fas fa-phone" style="color: #0284c7;"></i> Phone: <strong>${escapeHtml(rec.phone)}</strong> · ~${Math.ceil(cleanSmsText.length / 160)} SMS page(s)</div>`,
        'Send SMS Now'
      );
      if (!confirmed) return;

      try {
        const token = await getAdminAuthToken();
        const senderId = document.getElementById('settingsSmsSenderId')?.value?.trim() || localStorage.getItem('sfmi_arkesel_sender_id') || 'SFMI';
        const customKey = (document.getElementById('settingsSmsApiKey')?.value?.trim() || localStorage.getItem('sfmi_arkesel_api_key') || '').trim();

        const payload = {
          recipients: [rec.phone],
          message: cleanSmsText,
          sender: senderId
        };
        if (customKey && customKey !== 'undefined' && customKey !== 'null') payload.apiKey = customKey;

        const res = await fetch(`${API_BASE}/sms/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify(payload)
        });

        const resData = await res.json().catch(() => ({}));
        if (res.ok && resData.success) {
          showToast(`SMS successfully sent to <strong>${escapeHtml(rec.fullName)}</strong> via Arkesel!`, 'success', 'SMS Delivered');
          loadArkeselSmsBalance();
        } else {
          showToast(resData.error || resData.message || 'Failed to dispatch SMS through Arkesel gateway.', 'error', 'SMS Failed');
        }
      } catch (err) {
        showToast('Network error sending SMS.', 'error', 'Network Error');
      }
    }

    async function sendBulkSmsToSelectedRecipients() {
      const selected = messagingRecipients.filter(r => selectedRecipientIds.has(String(r.id)) && Boolean(r.phone));

      if (selected.length === 0) {
        showToast('Please select at least one recipient with a valid phone number from the roster.', 'warning', 'No Selection');
        return;
      }

      const textarea = document.getElementById('msgBodyTextarea');
      const template = textarea ? textarea.value : MSG_TEMPLATES.THANK_YOU;
      const svcName = document.getElementById('msgServiceSelect')?.value || 'Service';
      const dateIso = getEffectiveSessionDateIso();
      const senderId = document.getElementById('settingsSmsSenderId')?.value?.trim() || localStorage.getItem('sfmi_arkesel_sender_id') || 'SFMI';

      // Preview sample
      const sampleText = formatWhatsAppMessageForRecipient(template, selected[0], svcName, dateIso)
        .replace(/\*/g, '').replace(/_/g, '').trim();

      const confirmed = await showConfirmModal(
        `Send Arkesel Bulk SMS to ${selected.length} Recipient(s)?`,
        `<div style="font-size: 13px; margin-bottom: 10px;">You are about to dispatch personalized SMS to <strong>${selected.length} recipient(s)</strong> using Sender ID: <strong style="color: #0284c7;">${escapeHtml(senderId)}</strong>.</div>
        <div style="text-align: left; background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid var(--line); font-size: 12.5px; color: var(--ink); line-height: 1.5; white-space: pre-wrap; max-height: 140px; overflow-y: auto;"><strong>Sample Preview:</strong>\n${escapeHtml(sampleText)}</div>`,
        `Send ${selected.length} Bulk SMS`
      );
      if (!confirmed) return;

      const contactMessages = selected.map(rec => {
        const text = formatWhatsAppMessageForRecipient(template, rec, svcName, dateIso)
          .replace(/\*/g, '').replace(/_/g, '').trim();
        return {
          phone: rec.phone,
          name: rec.fullName,
          message: text
        };
      });

      showToast(`Dispatching ${selected.length} SMS via Arkesel Gateway...`, 'info', 'Sending Bulk SMS');

      try {
        const token = await getAdminAuthToken();
        const customKey = (document.getElementById('settingsSmsApiKey')?.value?.trim() || localStorage.getItem('sfmi_arkesel_api_key') || '').trim();

        const payload = {
          messages: contactMessages,
          sender: senderId
        };
        if (customKey && customKey !== 'undefined' && customKey !== 'null') payload.apiKey = customKey;

        const res = await fetch(`${API_BASE}/sms/send-bulk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          const sent = data.results?.sent || 0;
          const failed = data.results?.failed || 0;
          showToast(`Bulk SMS completed: <strong>${sent}</strong> delivered successfully${failed > 0 ? `, ${failed} failed` : ''}.`, 'success', 'Bulk Dispatch Complete');
          loadArkeselSmsBalance();
        } else {
          showToast(data.error || 'Failed to complete bulk SMS dispatch.', 'error', 'Dispatch Error');
        }
      } catch (err) {
        showToast('Network error during bulk SMS dispatch.', 'error', 'Network Error');
      }
    }

    async function testArkeselSmsConnection() {
      showToast('Testing connection to Arkesel SMS Gateway...', 'info', 'Connecting');
      const data = await loadArkeselSmsBalance();
      if (data && data.success) {
        showToast(`Connected to Arkesel! SMS Balance: <strong>${data.smsBalance} credits</strong> (${data.mainBalance || 'GHS 0.00'})`, 'success', 'Arkesel Connected');
      } else {
        showToast('Arkesel Gateway configured. Ready for live delivery.', 'info', 'Gateway Configured');
      }
    }

    function saveArkeselSmsSettings() {
      const apiKey = document.getElementById('settingsSmsApiKey')?.value?.trim();
      const senderId = document.getElementById('settingsSmsSenderId')?.value?.trim() || 'SFMI';

      if (apiKey) {
        localStorage.setItem('sfmi_arkesel_api_key', apiKey);
      } else {
        localStorage.removeItem('sfmi_arkesel_api_key');
      }
      localStorage.setItem('sfmi_arkesel_sender_id', senderId);

      showToast(`Arkesel SMS configuration saved (Sender ID: <strong>${escapeHtml(senderId)}</strong>)!`, 'success', 'Settings Saved');
      testArkeselSmsConnection();
    }

    function initArkeselSmsSettings() {
      const savedKey = localStorage.getItem('sfmi_arkesel_api_key');
      let savedSender = localStorage.getItem('sfmi_arkesel_sender_id');
      if (savedSender === 'SMFI') {
        savedSender = 'SFMI';
        localStorage.setItem('sfmi_arkesel_sender_id', 'SFMI');
      }
      if (savedKey) {
        const keyEl = document.getElementById('settingsSmsApiKey');
        if (keyEl) keyEl.value = savedKey;
      }
      const senderEl = document.getElementById('settingsSmsSenderId');
      if (senderEl) {
        senderEl.value = savedSender || 'SFMI';
      }
    }

