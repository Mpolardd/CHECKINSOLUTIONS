    // Purge legacy offline finance caches
    ['sfmi_service_finances', 'sfmi_fin_reconciliation_entries'].forEach(k => {
      try { localStorage.removeItem(k); } catch(e) {}
    });

    const API_BASE = (() => {
      const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      return isLocal ? 'http://localhost:4000/api/v1' : '/api/v1';
    })();

    document.addEventListener('DOMContentLoaded', () => {
      initInactivityListeners();
      checkFinAuth();
    });

    /* ── 12-HOUR EXTENDED INACTIVITY AUTO-LOGOUT SYSTEM ── */
    const INACTIVITY_LIMIT_MS = 12 * 60 * 60 * 1000; // 12 hours (extended working shift)
    let inactivityTimer = null;

    function resetInactivityTimer() {
      const isAuth = localStorage.getItem('sfmi_fin_auth') === 'true';
      if (!isAuth) {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        return;
      }

      const now = Date.now();
      const lastActive = parseInt(localStorage.getItem('sfmi_fin_last_active') || '0', 10);

      // Check if already inactive past limit across tabs or refresh
      if (lastActive > 0 && (now - lastActive) > INACTIVITY_LIMIT_MS) {
        triggerAutoLogout();
        return;
      }

      localStorage.setItem('sfmi_fin_last_active', now.toString());

      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        triggerAutoLogout();
      }, INACTIVITY_LIMIT_MS);
    }

    function purgeFinAuthSession() {
      sessionStorage.removeItem('sfmi_fin_token');
      sessionStorage.removeItem('sfmi_fin_user');
      sessionStorage.removeItem('sfmi_fin_last_active');
      localStorage.removeItem('sfmi_fin_token');
      localStorage.removeItem('sfmi_fin_auth');
      localStorage.removeItem('sfmi_fin_last_active');
    }

    function triggerAutoLogout() {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      purgeFinAuthSession();
      showFinLogin();
      showToast('You were automatically logged out due to extended inactivity (12 hours).', 'warning', 'Session Timeout');
    }

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

      setInterval(() => {
        const token = sessionStorage.getItem('sfmi_fin_token') || localStorage.getItem('sfmi_fin_token');
        if (!token) return;
        const lastActive = parseInt(localStorage.getItem('sfmi_fin_last_active') || '0', 10);
        if (lastActive > 0 && (Date.now() - lastActive) > INACTIVITY_LIMIT_MS) {
          triggerAutoLogout();
        }
      }, 60000);
    }

    async function getValidFinanceToken() {
      let token = sessionStorage.getItem('sfmi_fin_token') || localStorage.getItem('sfmi_fin_token') || sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');

      const isInvalidOrOffline = !token || token.startsWith('sfmi_fin_offline_session_');

      let isExpired = false;
      if (token && !isInvalidOrOffline && token.includes('.')) {
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          const nowSec = Math.floor(Date.now() / 1000);
          if (payload.exp && payload.exp < nowSec + 60) {
            isExpired = true;
          }
        } catch(e) {}
      }

      return token || '';
    }

    async function checkFinAuth() {
      let token = sessionStorage.getItem('sfmi_fin_token') || localStorage.getItem('sfmi_fin_token') || sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');

      // 1. If offline Treasury session, try to upgrade it to a real live token
      if (token && token.startsWith('sfmi_fin_offline_session_')) {
        token = await getValidFinanceToken();
      }

      // 2. If no token at all or still offline, immediately show login
      if (!token || token.startsWith('sfmi_fin_offline_session_')) {
        purgeFinAuthSession();
        showFinLogin();
        document.documentElement.style.visibility = ''; // Make visible if showing login
        return;
      }

      // 3. Verify token with backend API before showing dashboard
      try {
        const res = await fetch(`${API_BASE}/auth/verify`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (res.ok) {
          const data = await res.json();
          const role = (data.user && data.user.role) ? data.user.role : '';

          if (!['FINANCE', 'SUPER_ADMIN', 'ADMIN'].includes(role)) {
            purgeFinAuthSession();
            showFinLogin();
            document.documentElement.style.visibility = '';
            showToast('Access Denied: The Treasury Portal (/finance) is strictly reserved for Treasury Officers and Administrators.', 'error', 'Access Denied');
            return;
          }

          sessionStorage.setItem('sfmi_fin_token', token);
          sessionStorage.setItem('sfmi_fin_user', JSON.stringify(data.user));

          resetInactivityTimer();
          showFinDashboard();
          document.documentElement.style.visibility = ''; // Finally make visible
        } else if (res.status === 401 || res.status === 403) {
          const freshToken = await getValidFinanceToken();
          if (freshToken && !freshToken.startsWith('sfmi_fin_offline_session_')) {
            sessionStorage.setItem('sfmi_fin_token', freshToken);
            localStorage.setItem('sfmi_fin_token', freshToken);
            // Retry check with fresh token
            checkFinAuth();
          } else {
            purgeFinAuthSession();
            showFinLogin();
            document.documentElement.style.visibility = '';
            showToast('Your session has expired. Please log in again.', 'warning', 'Session Expired');
          }
        }
      } catch (err) {
        console.warn('Backend session verification unavailable, using local active session:', err);
        // Fail-closed policy: if we can't verify and have no local user cache, force login
        if (sessionStorage.getItem('sfmi_fin_user') || localStorage.getItem('sfmi_fin_user')) {
           resetInactivityTimer();
           showFinDashboard();
           document.documentElement.style.visibility = '';
        } else {
           showFinLogin();
           document.documentElement.style.visibility = '';
        }
      }
    }

    function showFinLogin() {
      document.getElementById('finLoginScreen').style.display = 'block';
      document.getElementById('finDashboardContent').style.display = 'none';
      const wrap = document.getElementById('finLogoutWrap');
      if (wrap) wrap.style.display = 'none';
      const btn = document.getElementById('btnFinLogout');
      if (btn) btn.style.display = 'none';
    }

    function formatLocalDate(d = new Date()) {
      const dateObj = typeof d === 'string' ? new Date(d) : d;
      if (!dateObj || isNaN(dateObj.getTime())) return '';
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    function showFinDashboard() {
      document.getElementById('finLoginScreen').style.display = 'none';
      document.getElementById('finDashboardContent').style.display = 'block';
      const wrap = document.getElementById('finLogoutWrap');
      if (wrap) wrap.style.display = 'block';
      const btn = document.getElementById('btnFinLogout');
      if (btn) btn.style.display = 'inline-flex';

      try {
        const u = JSON.parse(sessionStorage.getItem('sfmi_fin_user') || localStorage.getItem('sfmi_fin_user') || '{}');
        const badge = document.getElementById('finNavUserBadge');
        if (badge && (u.name || u.email)) {
          badge.innerText = u.name || u.email.split('@')[0];
        }
      } catch (e) {}

      loadBranding();
      document.getElementById('finServiceDate').value = formatLocalDate(new Date());
      document.getElementById('liveDateDisplay').innerText = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
    }

    async function handleFinLoginSubmit(e) {
      e.preventDefault();
      const email = document.getElementById('finLoginEmail').value.trim();
      const password = document.getElementById('finLoginPassword').value.trim();
      const errorMsg = document.getElementById('finLoginErrorMsg');
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
          if (data.user && !['FINANCE', 'SUPER_ADMIN', 'ADMIN'].includes(data.user.role)) {
            purgeFinAuthSession();
            errorMsg.style.display = 'block';
            errorMsg.innerText = 'Access Denied: The Treasury Portal (/finance) is strictly reserved for Treasury & Finance Officers. Administrators please sign in at /admin.';
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Sign In to Treasury Portal'; }
            return;
          }
          sessionStorage.setItem('sfmi_fin_token', data.accessToken);
          localStorage.setItem('sfmi_fin_token', data.accessToken);
          sessionStorage.setItem('sfmi_fin_user', JSON.stringify(data.user));
          resetInactivityTimer();
          showFinDashboard();
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Sign In to Treasury Portal'; }
          return;
        } else {
          const errData = await res.json().catch(() => ({}));
          purgeFinAuthSession();
          errorMsg.style.display = 'block';
          errorMsg.innerText = errData.message || 'Invalid credentials. Please check your email and password and try again.';
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Sign In to Treasury Portal'; }
          return;
        }
      } catch (err) {
        purgeFinAuthSession();
        errorMsg.style.display = 'block';
        errorMsg.innerText = 'Unable to connect to authentication server. Please check your connection and try again.';
      }

      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Sign In to Treasury Portal'; }
    }

    function handleFinLogout() {
      showConfirmModal(
        'Confirm Log Out',
        'Are you sure you want to log out from the Treasury Portal?',
        async () => {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          const token = sessionStorage.getItem('sfmi_fin_token') || localStorage.getItem('sfmi_fin_token');
          if (token && !token.startsWith('sfmi_fin_offline_session_')) {
            try {
              await fetch(`${API_BASE}/auth/logout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
              });
            } catch (err) {}
          }
          purgeFinAuthSession();
          showFinLogin();
          showToast('You have been securely logged out.', 'info', 'Logged Out');
        },
        'fas fa-sign-out-alt',
        'Log Out',
        '#c5221f'
      );
    }

    let _confirmCallback = null;
    function showConfirmModal(title, text, callback, iconClass = 'fas fa-sign-out-alt', btnText = 'Log Out', btnColor = '#c5221f') {
      document.getElementById('confirmModalTitle').innerText = title;
      const textEl = document.getElementById('confirmModalText');
      if (textEl) {
        if (typeof text === 'string' && text.includes('<') && text.includes('>')) {
          textEl.innerHTML = text;
        } else {
          textEl.innerText = text || '';
        }
      }
      const okBtn = document.getElementById('confirmModalOkBtn');
      if (okBtn) {
        okBtn.innerText = btnText;
        okBtn.style.background = btnColor;
      }
      const icon = document.getElementById('confirmModalIcon');
      if (icon) icon.className = iconClass;
      _confirmCallback = callback;
      document.getElementById('customConfirmModal').style.display = 'flex';
    }

    function closeCustomConfirmModal(confirmed) {
      document.getElementById('customConfirmModal').style.display = 'none';
      if (confirmed && typeof _confirmCallback === 'function') {
        _confirmCallback();
      }
      _confirmCallback = null;
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

    /* ── PROFILE & SETTINGS SYSTEM (FINANCE) ── */
    function openFinProfileSettingsModal() {
      let user = null;
      try {
        user = JSON.parse(sessionStorage.getItem('sfmi_fin_user') || localStorage.getItem('sfmi_fin_user') || '{}');
      } catch (e) {
        user = {};
      }

      const email = user.email || 'finance@solutionsfaith.com';
      const name = user.name || (email.split('@')[0].toUpperCase());
      const role = (user.role || 'FINANCE').replace(/_/g, ' ');

      const avatarEl = document.getElementById('finProfileAvatarText');
      if (avatarEl) avatarEl.innerText = (name.charAt(0) || 'F').toUpperCase();

      const nameEl = document.getElementById('finProfileName');
      if (nameEl) nameEl.innerText = name;

      const emailEl = document.getElementById('finProfileEmail');
      if (emailEl) emailEl.innerText = email;

      const badgeEl = document.getElementById('finProfileRoleBadge');
      if (badgeEl) badgeEl.innerText = role;

      const cur = document.getElementById('finCurrentPassword');
      if (cur) cur.value = '';
      const np = document.getElementById('finNewPassword');
      if (np) np.value = '';
      const cp = document.getElementById('finConfirmPassword');
      if (cp) cp.value = '';

      const err = document.getElementById('finPasswordErrorMsg');
      if (err) {
        err.style.display = 'none';
        err.innerText = '';
      }

      const modal = document.getElementById('finProfileSettingsModal');
      if (modal) modal.style.display = 'flex';
    }

    function closeFinProfileSettingsModal() {
      const modal = document.getElementById('finProfileSettingsModal');
      if (modal) modal.style.display = 'none';
    }

    async function handleFinChangePasswordSubmit(e) {
      e.preventDefault();
      const currentPassword = document.getElementById('finCurrentPassword').value;
      const newPassword = document.getElementById('finNewPassword').value;
      const confirmPassword = document.getElementById('finConfirmPassword').value;
      const errorMsg = document.getElementById('finPasswordErrorMsg');
      const submitBtn = document.getElementById('btnFinSavePassword');

      errorMsg.style.display = 'none';
      errorMsg.innerText = '';

      if (!currentPassword) {
        errorMsg.innerText = 'Current password is required.';
        errorMsg.style.display = 'block';
        return;
      }
      if (!newPassword || newPassword.length < 6) {
        errorMsg.innerText = 'New password must be at least 6 characters.';
        errorMsg.style.display = 'block';
        return;
      }
      if (newPassword !== confirmPassword) {
        errorMsg.innerText = 'New passwords do not match.';
        errorMsg.style.display = 'block';
        return;
      }

      const token = sessionStorage.getItem('sfmi_fin_token') || localStorage.getItem('sfmi_fin_token');
      if (!token || token.startsWith('sfmi_fin_offline_session_')) {
        errorMsg.innerText = 'Cannot update password in offline fallback mode. Please ensure the backend server is reachable.';
        errorMsg.style.display = 'block';
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
      }

      try {
        const res = await fetch(`${API_BASE}/auth/change-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
        });

        const data = await res.json();
        if (!res.ok) {
          errorMsg.innerText = data.error || 'Failed to update password. Check your current password.';
          errorMsg.style.display = 'block';
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-shield-halved"></i> Save New Password';
          }
          return;
        }

        closeFinProfileSettingsModal();
        showToast('Password updated successfully! Please keep your new password secure.', 'success', 'Password Changed');
      } catch (err) {
        errorMsg.innerText = 'Network error: could not connect to server.';
        errorMsg.style.display = 'block';
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fas fa-shield-halved"></i> Save New Password';
        }
      }
    }

    function loadBranding() {
      const logo = localStorage.getItem('sfmi_logo_url');
      const name = localStorage.getItem('sfmi_church_name');
      if (logo) document.getElementById('finNavLogo').src = logo;
      if (name) document.getElementById('finChurchName').innerText = name;
    }

    /* ── SAVING SERVICE FINANCE FIGURES ── */
    function computeGrandTotal() {
      const tithes = parseFloat(document.getElementById('inTithes').value) || 0;
      const offering = parseFloat(document.getElementById('inOffering').value) || 0;
      const building = parseFloat(document.getElementById('inBuilding').value) || 0;
      const seed = parseFloat(document.getElementById('inSeed').value) || 0;
      const thanksgiving = parseFloat(document.getElementById('inThanksgiving').value) || 0;
      const other = parseFloat(document.getElementById('inOther').value) || 0;

      const total = tithes + offering + building + seed + thanksgiving + other;
      document.getElementById('displayGrandTotal').innerText = `GHS ${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      return total;
    }

    async function handleSaveServiceFinance(e) {
      e.preventDefault();
      const serviceName = document.getElementById('finServiceSelect').value;
      const serviceDate = document.getElementById('finServiceDate').value;
      const tithes = parseFloat(document.getElementById('inTithes').value) || 0;
      const offering = parseFloat(document.getElementById('inOffering').value) || 0;
      const buildingFund = parseFloat(document.getElementById('inBuilding').value) || 0;
      const specialSeed = parseFloat(document.getElementById('inSeed').value) || 0;
      const thanksgiving = parseFloat(document.getElementById('inThanksgiving').value) || 0;
      const other = parseFloat(document.getElementById('inOther').value) || 0;

      const cashAmount = parseFloat(document.getElementById('inCash').value) || 0;
      const momoAmount = parseFloat(document.getElementById('inMomo').value) || 0;
      const bankAmount = parseFloat(document.getElementById('inBank').value) || 0;
      const posAmount = parseFloat(document.getElementById('inPos').value) || 0;

      const recordedBy = document.getElementById('finRecordedBy').value.trim();
      const notes = document.getElementById('finNotes').value.trim();

      const totalAmount = tithes + offering + buildingFund + specialSeed + thanksgiving + other;

      if (totalAmount <= 0) {
        showToast('Please enter at least one financial figure before saving.', 'warning', 'Figures Required');
        return;
      }

      const payload = {
        serviceName, serviceDate,
        tithes, offering, buildingFund, specialSeed, thanksgiving, other,
        cashAmount, momoAmount, bankAmount, posAmount,
        recordedBy, notes
      };

      const btn = e.target.querySelector('button[type="submit"]');
      const origBtnHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving to Database…';
      }

      try {
        let token = await getValidFinanceToken();
        let res = await fetch(`${API_BASE}/finance/service-entry`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify(payload)
        });

        // If rejected due to auth error / expired token
        if (res.status === 401 || res.status === 403) {
          purgeFinAuthSession();
          showFinLogin();
          showToast('Your session has expired. Please sign in again to save this financial entry.', 'warning', 'Session Expired');
          return;
        }

        if (res.ok) {
          showToast(`Financial collections for <strong>${escapeHtml(serviceName)}</strong> (GHS ${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}) recorded in Supabase database!`, 'success', 'Treasury Entry Saved');
          showSuccessNotification(`Figures for ${serviceName} (GHS ${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}) saved directly to Supabase!`);
          try {
            e.target.reset();
            document.getElementById('finServiceDate').value = formatLocalDate(new Date());
            computeGrandTotal();
          } catch(reErr) {}
          return;
        } else {
          const err = await res.json().catch(() => ({ error: 'Could not save to the database' }));
          showToast(err.error || err.message || 'Could not save to the database.', 'error', 'Save Failed');
        }
      } catch (err) {
        console.error('handleSaveServiceFinance error:', err);
        showToast(err.message || 'Network error saving financial figures to Supabase.', 'error', 'Save Failed');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = origBtnHtml;
        }
      }
    }

    function showSuccessNotification(msg) {
      const banner = document.getElementById('successBanner');
      const text = document.getElementById('successMsgText');
      if (banner && text) {
        text.innerText = msg;
        banner.style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => {
          banner.style.display = 'none';
        }, 6000);
      }
    }

    /* ── PARTNERSHIP & MONTHLY PLEDGES FUNCTIONS ── */
    let cachedPartnersList = [];
    let cachedMembersList = [];

    function switchFinPortalTab(tab) {
      const btnSvc = document.getElementById('tabBtnServiceFinance');
      const btnPart = document.getElementById('tabBtnPartnership');
      const viewSvc = document.getElementById('viewServiceFinance');
      const viewPart = document.getElementById('viewPartnership');

      if (tab === 'serviceFinance') {
        btnSvc.classList.add('active');
        btnPart.classList.remove('active');
        viewSvc.style.display = 'block';
        viewPart.style.display = 'none';
      } else {
        btnPart.classList.add('active');
        btnSvc.classList.remove('active');
        viewPart.style.display = 'block';
        viewSvc.style.display = 'none';

        // Initialize target month to current YYYY-MM
        const now = new Date();
        const curMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const targetInput = document.getElementById('payTargetMonth');
        if (targetInput && !targetInput.value) targetInput.value = curMonthStr;

        const dateInput = document.getElementById('payPaymentDate');
        if (dateInput && !dateInput.value) dateInput.value = formatLocalDate(now);

        // Pre-fill officer name if known
        let officerName = '';
        try {
          const u = JSON.parse(sessionStorage.getItem('sfmi_fin_user') || '{}');
          if (u.name) officerName = u.name;
        } catch(e) {}
        const offInput = document.getElementById('payRecordedBy');
        if (offInput && !offInput.value) offInput.value = officerName || 'Treasury Officer';

        loadPartnersAndMembers();
        loadRecentPartnershipPayments();
      }
    }

    async function loadPartnersAndMembers() {
      try {
        const token = sessionStorage.getItem('sfmi_fin_token') || localStorage.getItem('sfmi_fin_token') || sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

        const [partnerRes, memberRes] = await Promise.all([
          fetch(`${API_BASE}/finance/partners`, { headers }).catch(() => null),
          fetch(`${API_BASE}/members`, { headers }).catch(() => null)
        ]);

        if (partnerRes && partnerRes.ok) {
          cachedPartnersList = await partnerRes.json();
        }
        if (memberRes && memberRes.ok) {
          const mData = await memberRes.json();
          cachedMembersList = Array.isArray(mData) ? mData : (mData.members || []);
        }
      } catch (err) {}
    }

    function handlePartnerSearchInput(query) {
      const suggestBox = document.getElementById('partnerSuggestBox');
      const q = query.trim().toLowerCase();
      if (!q) {
        suggestBox.style.display = 'none';
        return;
      }

      // First search registered partners, then members
      const matchingPartners = (cachedPartnersList || []).filter(p => 
        (p.memberName && p.memberName.toLowerCase().includes(q)) || 
        (p.phone && p.phone.includes(q))
      );

      const matchingMembers = (cachedMembersList || []).filter(m => {
        const fullName = `${m.firstName || ''} ${m.lastName || ''}`.trim().toLowerCase();
        const phone = (m.phone || '').toLowerCase();
        return (fullName.includes(q) || phone.includes(q)) && !matchingPartners.some(p => p.memberId === m.id || p.memberName.toLowerCase() === fullName);
      }).slice(0, 5);

      if (matchingPartners.length === 0 && matchingMembers.length === 0) {
        suggestBox.innerHTML = `
          <div style="padding: 12px 14px; color: var(--muted); font-size: 13px; text-align: center;">
            No member found matching "<strong>${escapeHtml(query)}</strong>".<br/>
            <button type="button" class="btn-main" style="margin-top: 8px; padding: 6px 12px; font-size: 12px; background: var(--emerald-dark);" onclick="openRegisterPartnerModalWithName('${escapeHtml(query)}')">
              <i class="fas fa-user-plus"></i> Register as New Partner
            </button>
          </div>`;
        suggestBox.style.display = 'block';
        return;
      }

      let html = '';
      if (matchingPartners.length > 0) {
        html += `<div style="padding: 6px 12px; font-size: 11px; font-weight: 800; color: var(--muted); background: #f8fafc; border-bottom: 1px solid var(--line); text-transform: uppercase;">Registered Partners</div>`;
        matchingPartners.forEach(p => {
          html += `
            <div class="partner-suggest-item" onclick="selectPartner('${escapeHtml(p.id)}', '${escapeHtml(p.memberName)}', '${escapeHtml(p.phone || '')}', ${Number(p.pledgeAmount) || 0})">
              <div>
                <strong>${escapeHtml(p.memberName)}</strong>
                <div style="font-size: 12px; color: var(--muted);"><i class="fas fa-phone"></i> ${escapeHtml(p.phone || 'No phone')}</div>
              </div>
              <div style="text-align: right;">
                <span class="badge-present" style="background:#fef3c7; color:#92400e; font-weight:800; font-size:12px; padding:3px 8px; border-radius:4px;">
                  GHS ${(Number(p.pledgeAmount) || 0).toFixed(2)}/mo
                </span>
              </div>
            </div>`;
        });
      }

      if (matchingMembers.length > 0) {
        html += `<div style="padding: 6px 12px; font-size: 11px; font-weight: 800; color: var(--muted); background: #f8fafc; border-bottom: 1px solid var(--line); text-transform: uppercase;">Church Members Directory (Click to Register)</div>`;
        matchingMembers.forEach(m => {
          const fullName = `${m.firstName || ''} ${m.lastName || ''}`.trim();
          html += `
            <div class="partner-suggest-item" onclick="openRegisterPartnerModalWithMember('${escapeHtml(m.id)}', '${escapeHtml(fullName)}', '${escapeHtml(m.phone || '')}')">
              <div>
                <strong>${escapeHtml(fullName)}</strong>
                <div style="font-size: 12px; color: var(--muted);">${m.category || 'Member'} · ${m.phone || 'No phone'}</div>
              </div>
              <div>
                <span style="font-size: 11.5px; color: var(--emerald-dark); font-weight: 700;">+ Set Pledge</span>
              </div>
            </div>`;
        });
      }

      suggestBox.innerHTML = html;
      suggestBox.style.display = 'block';
    }

    function selectPartner(id, name, phone, pledgeAmount) {
      document.getElementById('selectedPartnerId').value = id;
      document.getElementById('selectedPartnerName').value = name;
      document.getElementById('selectedPartnerPhone').value = phone;
      document.getElementById('selectedPartnerPledge').value = pledgeAmount;

      document.getElementById('partnerSearchInput').value = name;
      document.getElementById('partnerSuggestBox').style.display = 'none';

      document.getElementById('partnerCardName').innerText = name;
      document.getElementById('partnerCardPhone').innerHTML = `<i class="fas fa-phone"></i> ${phone || 'No phone recorded'}`;
      document.getElementById('partnerCardPledge').innerText = `GHS ${Number(pledgeAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })} / month`;
      document.getElementById('partnerSelectedBox').style.display = 'block';

      // Auto-fill amount to registered pledge
      const amtInput = document.getElementById('payAmount');
      if (amtInput && pledgeAmount > 0) {
        amtInput.value = pledgeAmount;
      }
    }

    function applyQuickAmount(val) {
      const amtInput = document.getElementById('payAmount');
      if (!amtInput) return;
      if (val === 'pledge') {
        const pledge = Number(document.getElementById('selectedPartnerPledge').value) || 0;
        if (pledge > 0) amtInput.value = pledge;
      } else {
        amtInput.value = Number(val);
      }
    }

    function resetPartnershipPaymentForm() {
      document.getElementById('selectedPartnerId').value = '';
      document.getElementById('selectedPartnerName').value = '';
      document.getElementById('selectedPartnerPhone').value = '';
      document.getElementById('selectedPartnerPledge').value = '';
      document.getElementById('partnerSearchInput').value = '';
      document.getElementById('partnerSuggestBox').style.display = 'none';
      document.getElementById('partnerSelectedBox').style.display = 'none';
      document.getElementById('payAmount').value = '';
      document.getElementById('payNotes').value = '';
    }

    async function handleSavePartnershipPayment(e) {
      e.preventDefault();
      const partnerId = document.getElementById('selectedPartnerId').value;
      const memberName = document.getElementById('selectedPartnerName').value || document.getElementById('partnerSearchInput').value.trim();
      const targetMonth = document.getElementById('payTargetMonth').value;
      const amount = parseFloat(document.getElementById('payAmount').value) || 0;
      const paymentMethod = document.getElementById('payPaymentMethod').value;
      const paymentDate = document.getElementById('payPaymentDate').value;
      const recordedBy = document.getElementById('payRecordedBy').value.trim();
      const notes = document.getElementById('payNotes').value.trim();

      if (!partnerId) {
        showToast('Please search and select a registered partner first.', 'error', 'Partner Required');
        return;
      }
      if (amount <= 0) {
        showToast('Please enter a valid payment amount.', 'error', 'Invalid Amount');
        return;
      }
      if (!targetMonth) {
        showToast('Please select which month this payment applies to.', 'error', 'Month Required');
        return;
      }

      const btn = document.getElementById('btnSavePartnerPay');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Recording payment…'; }

      try {
        const token = await getValidFinanceToken();
        const res = await fetch(`${API_BASE}/finance/partnerships/payments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({
            partnerId, memberName, amount, targetMonth, paymentDate, paymentMethod, recordedBy, notes
          })
        });

        if (res.ok) {
          const result = await res.json();
          showToast(`Partnership payment of <strong>GHS ${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong> for <strong>${escapeHtml(memberName)}</strong> (${targetMonth}) recorded!`, 'success', 'Payment Recorded');
          resetPartnershipPaymentForm();
          loadRecentPartnershipPayments();
        } else {
          const err = await res.json();
          showToast(err.error || 'Failed to record partnership payment.', 'error', 'Payment Failed');
        }
      } catch (err) {
        showToast('Network error recording partnership payment.', 'error', 'Network Error');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-handshake"></i> Record Partnership Payment'; }
      }
    }

    async function loadRecentPartnershipPayments() {
      const tbody = document.getElementById('recentPartnerPaymentsTable');
      if (!tbody) return;

      try {
        const token = sessionStorage.getItem('sfmi_fin_token') || localStorage.getItem('sfmi_fin_token') || sessionStorage.getItem('sfmi_token') || localStorage.getItem('sfmi_token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/finance/partnerships/payments`, { headers });
        if (res.ok) {
          const payments = await res.json();
          if (Array.isArray(payments) && payments.length > 0) {
            tbody.innerHTML = payments.slice(0, 15).map(p => `
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 10px 14px; color: var(--muted);">${p.paymentDate || '—'}</td>
                <td style="padding: 10px 14px;"><strong>${escapeHtml(p.memberName || 'Partner')}</strong></td>
                <td style="padding: 10px 14px;"><span style="background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 12px;">${p.targetMonth || '—'}</span></td>
                <td style="padding: 10px 14px;"><strong style="color: var(--emerald-dark);">GHS ${(Number(p.amount) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></td>
                <td style="padding: 10px 14px;"><span style="font-size: 11.5px; text-transform: uppercase; font-weight: 700;">${p.paymentMethod || 'CASH'}</span></td>
                <td style="padding: 10px 14px; font-size: 12.5px; color: var(--muted);">${escapeHtml(p.recordedBy || 'Treasury')}</td>
              </tr>
            `).join('');
            return;
          }
        }
      } catch (e) {}

      tbody.innerHTML = `<tr><td colspan="6" style="padding: 24px; text-align: center; color: var(--muted);">No partnership payments recorded yet.</td></tr>`;
    }

    function openRegisterPartnerModal() {
      document.getElementById('regPartnerMemberName').value = '';
      document.getElementById('regPartnerPhone').value = '';
      document.getElementById('regPartnerPledge').value = '';
      document.getElementById('regPartnerStartDate').value = formatLocalDate(new Date());
      document.getElementById('regPartnerNotes').value = '';
      document.getElementById('registerPartnerModal').style.display = 'flex';
      document.getElementById('regPartnerMemberName').focus();
    }

    function openRegisterPartnerModalWithName(name) {
      openRegisterPartnerModal();
      document.getElementById('regPartnerMemberName').value = name;
      document.getElementById('regPartnerPledge').focus();
    }

    function openRegisterPartnerModalWithMember(id, name, phone) {
      openRegisterPartnerModal();
      document.getElementById('regPartnerMemberName').value = name;
      document.getElementById('regPartnerPhone').value = phone;
      document.getElementById('regPartnerPledge').focus();
    }

    function closeRegisterPartnerModal() {
      document.getElementById('registerPartnerModal').style.display = 'none';
    }

    async function handleSaveNewPartnerSubmit(e) {
      e.preventDefault();
      const memberName = document.getElementById('regPartnerMemberName').value.trim();
      const phone = document.getElementById('regPartnerPhone').value.trim();
      const pledgeAmount = parseFloat(document.getElementById('regPartnerPledge').value) || 0;
      const startDate = document.getElementById('regPartnerStartDate').value;
      const notes = document.getElementById('regPartnerNotes').value.trim();

      if (!memberName || pledgeAmount <= 0) {
        showToast('Please enter member name and a valid monthly pledge amount.', 'error', 'Invalid Input');
        return;
      }

      const btn = document.getElementById('btnSubmitRegPartner');
      if (btn) { btn.disabled = true; btn.innerText = 'Registering partner…'; }

      try {
        const token = await getValidFinanceToken();
        const res = await fetch(`${API_BASE}/finance/partners`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ memberName, phone, pledgeAmount, startDate, notes })
        });

        if (res.ok) {
          const partner = await res.json();
          cachedPartnersList.unshift(partner);
          closeRegisterPartnerModal();
          selectPartner(partner.id, partner.memberName, partner.phone, partner.pledgeAmount);
          showToast(`Partner <strong>${escapeHtml(memberName)}</strong> (GHS ${pledgeAmount.toFixed(2)}/mo) registered in Supabase!`, 'success', 'Partner Registered');
        } else {
          const err = await res.json();
          showToast(err.error || 'Failed to register partner.', 'error', 'Registration Failed');
        }
      } catch (err) {
        showToast('Network error registering partner.', 'error', 'Network Error');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-handshake"></i> Save &amp; Register Partner'; }
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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
