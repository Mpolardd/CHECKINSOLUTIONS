    // Purge legacy mock data caches
    ['sfmi_members_registry', 'sfmi_service_attendance_map', 'sfmi_custom_programs'].forEach(k => {
      try { localStorage.removeItem(k); } catch(e) {}
    });

    const API_BASE = (() => {
      const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      return isLocal ? 'http://localhost:4000/api/v1' : '/api/v1';
    })();

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    let currentDay = 'Sunday';
    let currentServiceName = 'Family & Friends Service';
    let currentServiceTime = '7:00 AM – 11:00 AM';
    let selectedMember = null;
    let autoResetTimer = null;
    let countdownInterval = null;
    let countdownSecondsLeft = 7;

    let mockMembers = [];
    let currentSearchMatches = [];
    let searchDebounceTimer = null;
    let searchAbortController = null;

    const OFFLINE_QUEUE_KEY = 'sfmi_kiosk_offline_queue';

    const SCRIPTURES = [
      { text: "The Lord bless you and keep you; the Lord make his face shine upon you and be gracious to you.", ref: "Numbers 6:24-25" },
      { text: "I was glad when they said unto me, Let us go into the house of the Lord.", ref: "Psalm 122:1" },
      { text: "For where two or three gather in my name, there am I with them.", ref: "Matthew 18:20" },
      { text: "Blessed are those who dwell in your house; they are ever praising you.", ref: "Psalm 84:4" }
    ];

    document.addEventListener('DOMContentLoaded', () => {
      loadCustomPrograms();
      determineActiveService();
      loadBranding();
      updateNetworkStatusUI();
      flushOfflineQueue();

      // Feature 2: Periodic background sync for active programs & flyers (every 25s)
      setInterval(() => {
        loadCustomPrograms();
      }, 25000);

      // Feature 6: Periodic background queue flusher when back online
      setInterval(() => {
        if (navigator.onLine) {
          flushOfflineQueue();
        }
      }, 12000);
    });

    // Offline & Online Network Listeners
    window.addEventListener('online', () => {
      updateNetworkStatusUI();
      flushOfflineQueue();
      showToast('Network connection restored. Kiosk is online.', 'success', 'Cloud Connected');
    });

    window.addEventListener('offline', () => {
      updateNetworkStatusUI();
      showToast('Internet connection dropped. Kiosk is running in Offline Mode with local queueing.', 'warning', 'Offline Queue Active');
    });

    // Feature 3: Keyboard shortcuts to quickly reset queue on pass screen
    window.addEventListener('keydown', (e) => {
      const passView = document.getElementById('viewPass');
      if (passView && passView.style.display !== 'none') {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
          e.preventDefault();
          finishCheckIn();
        }
      }
    });

    /* ============================================================
       OFFLINE QUEUEING ENGINE (Feature 6)
       ============================================================ */
    function getOfflineQueue() {
      try {
        const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    }

    function saveToOfflineQueue(item) {
      try {
        const queue = getOfflineQueue();
        queue.push(item);
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
        updateNetworkStatusUI();
      } catch (e) {
        console.error('Failed to save item to offline queue:', e);
      }
    }

    function removeFromOfflineQueue(itemId) {
      try {
        let queue = getOfflineQueue();
        queue = queue.filter(q => q.id !== itemId);
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
        updateNetworkStatusUI();
      } catch (e) {}
    }

    function updateNetworkStatusUI() {
      const pill = document.getElementById('kioskNetworkStatusPill');
      const dot = document.getElementById('kioskStatusDot');
      const text = document.getElementById('kioskStatusText');
      if (!pill || !dot || !text) return;

      const isOnline = navigator.onLine;
      const queue = getOfflineQueue();
      const count = queue.length;

      if (!isOnline) {
        dot.style.background = '#ef4444';
        text.innerText = count > 0 ? `Offline (${count} Queued)` : 'Offline Mode';
        pill.style.background = 'rgba(239, 68, 68, 0.22)';
        pill.style.borderColor = 'rgba(239, 68, 68, 0.55)';
      } else if (count > 0) {
        dot.style.background = '#f59e0b';
        text.innerText = `Syncing (${count} Queued)...`;
        pill.style.background = 'rgba(245, 158, 11, 0.22)';
        pill.style.borderColor = 'rgba(245, 158, 11, 0.55)';
      } else {
        dot.style.background = '#22c55e';
        text.innerText = 'Live Cloud Sync';
        pill.style.background = 'rgba(255, 255, 255, 0.12)';
        pill.style.borderColor = 'rgba(255, 255, 255, 0.22)';
      }
    }

    let isFlushingQueue = false;
    async function flushOfflineQueue() {
      if (isFlushingQueue || !navigator.onLine) return;
      const queue = getOfflineQueue();
      if (queue.length === 0) {
        updateNetworkStatusUI();
        return;
      }

      isFlushingQueue = true;
      updateNetworkStatusUI();

      let syncedCount = 0;
      for (const item of queue) {
        try {
          const endpoint = item.type === 'VISITOR' 
            ? `${API_BASE}/attendance/quick-register-checkin` 
            : `${API_BASE}/attendance/checkin`;

          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item.payload)
          });

          if (res.ok || res.status === 409) {
            removeFromOfflineQueue(item.id);
            syncedCount++;
          }
        } catch (err) {
          console.warn('Network sync paused during offline queue flush:', err);
          break;
        }
      }

      isFlushingQueue = false;
      updateNetworkStatusUI();

      if (syncedCount > 0) {
        showToast(`Synced <strong>${syncedCount}</strong> offline check-in${syncedCount > 1 ? 's' : ''} to church cloud database.`, 'success', 'Sync Successful');
      }
    }

    function loadBranding() {
      const logo = localStorage.getItem('sfmi_logo_url');
      const name = localStorage.getItem('sfmi_church_name');
      if (logo) document.getElementById('navLogoImg').src = logo;
      if (name) document.getElementById('navChurchName').innerText = name;
    }

    /* ============================================================
       KIOSK AUTO-SWITCHING & CUSTOM PROGRAMS (Feature 2)
       ============================================================ */
    async function loadCustomPrograms() {
      try {
        const [progRes, kioskRes] = await Promise.all([
          fetch(`${API_BASE}/attendance/programs`).catch(() => null),
          fetch(`${API_BASE}/attendance/active-kiosk`).catch(() => null)
        ]);

        if (progRes && progRes.ok) {
          const progs = await progRes.json();
          if (Array.isArray(progs) && progs.length > 0) {
            localStorage.setItem('sfmi_custom_programs', JSON.stringify(progs));
          }
        }

        if (kioskRes && kioskRes.ok) {
          const kData = await kioskRes.json();
          if (kData && kData.activeKiosk !== undefined) {
            const previousKiosk = localStorage.getItem('sfmi_active_kiosk_service');
            if (kData.activeKiosk) {
              localStorage.setItem('sfmi_active_kiosk_service', kData.activeKiosk);
            } else {
              localStorage.removeItem('sfmi_active_kiosk_service');
            }
            // Auto-switch in real time if admin updated active kiosk program
            if (previousKiosk !== (kData.activeKiosk || null) && !selectedMember) {
              determineActiveService();
            }
          }
        }
      } catch (e) {}

      const savedPrograms = localStorage.getItem('sfmi_custom_programs');
      if (savedPrograms) {
        try {
          const list = JSON.parse(savedPrograms);
          const select = document.getElementById('kioskServiceSelector');
          list.forEach(p => {
            if (!Array.from(select.options).some(o => o.value === p.name)) {
              const opt = document.createElement('option');
              opt.value = p.name;
              opt.innerText = `${p.name} (${p.schedule || 'Special Program'})`;
              select.appendChild(opt);
            }
          });
        } catch(e) {}
      }

      if (!selectedMember) {
        determineActiveService();
      }
    }

    function determineActiveService() {
      const forcedService = localStorage.getItem('sfmi_active_kiosk_service');
      if (forcedService) {
        const selector = document.getElementById('kioskServiceSelector');
        if (selector) selector.value = forcedService;
        applySelectedService(forcedService);
        return;
      }

      const d = new Date().getDay();
      let serviceKey = 'Sunday: Family & Friends Service';
      if (d === 3) serviceKey = 'Wednesday: Time with the Lord';
      else if (d === 5) serviceKey = 'Friday: Prophetic Healing & Deliverance';

      const selector = document.getElementById('kioskServiceSelector');
      if (selector) selector.value = serviceKey;
      applySelectedService(serviceKey);
    }

    function applySelectedService(serviceKey) {
      let dayName = 'Sunday';
      let title = 'Family & Friends Service';
      let hours = '7:00 AM – 11:00 AM';
      let img = '/Sunday.JPG';

      // 1. Check if serviceKey matches a configured custom program first
      const savedPrograms = localStorage.getItem('sfmi_custom_programs');
      let customProg = null;
      if (savedPrograms) {
        try {
          const list = JSON.parse(savedPrograms);
          customProg = list.find(p => p.name.trim().toLowerCase() === String(serviceKey).trim().toLowerCase());
        } catch(e) {}
      }

      if (customProg) {
        dayName = customProg.tag || customProg.category || 'SPECIAL PROGRAM';
        title = customProg.name;
        hours = customProg.schedule || 'Active Program · Main Sanctuary';
        img = customProg.flyerUrl || '/Sunday.JPG';
      } else {
        const lower = String(serviceKey).toLowerCase().trim();
        if (lower.includes('time with the lord') || lower.includes('time with lord') || lower === 'wednesday' || lower.startsWith('wednesday:')) {
          dayName = 'Wednesday';
          title = localStorage.getItem('sfmi_svc_name_wed') || 'Wednesday: Time with the Lord';
          hours = localStorage.getItem('sfmi_svc_sched_wed') || '6:00 PM – 8:00 PM';
          img = localStorage.getItem('sfmi_svc_img_wed') || '/WEDNESDAY.JPG';
        } else if (lower.includes('prophetic healing') || lower.includes('prophetic deliverance') || lower === 'friday' || lower.startsWith('friday:')) {
          dayName = 'Friday';
          title = localStorage.getItem('sfmi_svc_name_fri') || 'Friday: Prophetic Healing & Deliverance';
          hours = localStorage.getItem('sfmi_svc_sched_fri') || '6:00 PM – 8:00 PM';
          img = localStorage.getItem('sfmi_svc_img_fri') || '/FRIDAY.JPG';
        } else if (lower.includes('family & friends') || lower.includes('family and friends') || lower === 'sunday' || lower.startsWith('sunday:')) {
          dayName = 'Sunday';
          title = localStorage.getItem('sfmi_svc_name_sun') || 'Sunday: Family & Friends Service';
          hours = localStorage.getItem('sfmi_svc_sched_sun') || '7:00 AM – 11:00 AM';
          img = localStorage.getItem('sfmi_svc_img_sun') || '/Sunday.JPG';
        } else {
          title = serviceKey;
          dayName = 'SPECIAL PROGRAM';
          hours = 'Active Program · Main Sanctuary';
          img = '/Sunday.JPG';
        }
      }

      currentDay = dayName;
      currentServiceName = title;
      currentServiceTime = hours;

      document.getElementById('heroServiceDay').innerText = `${dayName.toUpperCase()} SERVICE`;
      document.getElementById('heroServiceName').innerText = title;
      document.getElementById('heroServiceHours').innerText = `${hours} · Main Sanctuary`;
      document.getElementById('serviceHeroImg').src = img;
    }

    /* ============================================================
       DEBOUNCED SEARCH & CANCEL (Feature 1)
       ============================================================ */
    function onSearchInput(val) {
      const q = val.trim();
      const spinner = document.getElementById('searchSpinner');
      const grid = document.getElementById('resultsGrid');
      const noRes = document.getElementById('noResultsBox');

      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
      }

      if (searchAbortController) {
        searchAbortController.abort();
        searchAbortController = null;
      }

      if (q.length < 2) {
        if (spinner) spinner.style.display = 'none';
        if (grid) grid.style.display = 'none';
        if (noRes) noRes.style.display = 'none';
        return;
      }

      if (spinner) spinner.style.display = 'block';

      // 180ms debounce for responsive multi-device query throttling
      searchDebounceTimer = setTimeout(() => {
        handleSearch(q);
      }, 180);
    }

    async function handleSearch(query) {
      const q = query.trim().toLowerCase();
      const grid = document.getElementById('resultsGrid');
      const noRes = document.getElementById('noResultsBox');
      const spinner = document.getElementById('searchSpinner');

      if (q.length < 2) {
        if (grid) grid.style.display = 'none';
        if (noRes) noRes.style.display = 'none';
        if (spinner) spinner.style.display = 'none';
        return;
      }

      if (searchAbortController) {
        searchAbortController.abort();
      }
      searchAbortController = new AbortController();
      const signal = searchAbortController.signal;

      let matches = [];

      try {
        const res = await fetch(`${API_BASE}/attendance/search?q=${encodeURIComponent(q)}`, { signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            matches = data;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          return;
        }
        console.warn('Kiosk search query error (offline fallback):', err);
      } finally {
        if (spinner) spinner.style.display = 'none';
      }

      if (matches.length === 0) {
        grid.style.display = 'none';
        noRes.style.display = 'block';
      } else {
        noRes.style.display = 'none';
        grid.style.display = 'grid';
        currentSearchMatches = matches;
        grid.innerHTML = matches.map((m, idx) => {
          const isMale = (m.gender || '').toLowerCase().startsWith('m');
          const isFemale = (m.gender || '').toLowerCase().startsWith('f');
          const genderBadge = isMale 
            ? `<span class="badge-male">Male</span>` 
            : isFemale 
            ? `<span class="badge-female">Female</span>` 
            : '';

          const initials = `${(m.firstName || 'M')[0] || ''}${(m.lastName || '')[0] || ''}`.toUpperCase();
          const avatarHtml = m.photoUrl 
            ? `<img src="${escapeHtml(m.photoUrl)}" alt="${escapeHtml(m.firstName)}" class="member-card-photo" onerror="this.onerror=null; this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div class="member-card-avatar" style="display: none;">${initials}</div>`
            : `<div class="member-card-avatar">${initials}</div>`;

          return `
            <div class="member-card" onclick="selectMemberByIndex(${idx})">
              <div style="display: flex; align-items: center; gap: 14px;">
                ${avatarHtml}
                <div style="flex: 1; min-width: 0;">
                  <div class="member-name">${escapeHtml(m.firstName)} ${escapeHtml(m.lastName)}</div>
                  <div class="member-phone"><i class="fas fa-phone-alt" style="font-size: 11px; margin-right: 4px;"></i>${escapeHtml(m.phone || 'No phone')}</div>
                  ${m.address ? `<div style="font-size: 12px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><i class="fa-solid fa-location-dot" style="margin-right: 4px; font-size: 11px;"></i>${escapeHtml(m.address)}</div>` : ''}
                </div>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px; padding-top: 8px; border-top: 1px solid #f1f5f9;">
                <span class="member-meta"><i class="fas fa-check-circle"></i> Click to check in</span>
                ${genderBadge}
              </div>
            </div>
          `;
        }).join('');
      }
    }

    function selectMemberByIndex(index) {
      const member = currentSearchMatches[index];
      if (member) {
        selectMemberForCheckin(member);
      }
    }

    function selectMemberForCheckin(member) {
      selectedMember = member;
      document.getElementById('viewSearch').style.display = 'none';
      document.getElementById('viewConfirm').style.display = 'block';

      const fullName = `${member.firstName} ${member.lastName}`;
      document.getElementById('confirmMemberName').innerText = fullName;
      document.getElementById('confirmServiceName').innerText = currentServiceName;
      document.getElementById('confirmPhone').innerText = member.phone || 'Not provided';
      document.getElementById('confirmGender').innerText = member.gender || 'Not specified';
      document.getElementById('confirmAddress').innerText = member.address || 'Not specified';
      document.getElementById('confirmTime').innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ` (${currentDay})`;

      const initials = `${(member.firstName || 'M')[0] || ''}${(member.lastName || '')[0] || ''}`.toUpperCase();
      const photoWrap = document.getElementById('confirmPhotoWrap');
      if (photoWrap) {
        if (member.photoUrl) {
          photoWrap.innerHTML = `
            <img src="${escapeHtml(member.photoUrl)}" alt="${escapeHtml(member.firstName)}" style="width: 120px; height: 120px; border-radius: 50%; object-fit: cover; border: 4px solid var(--accent); box-shadow: 0 8px 24px rgba(0,0,0,0.18);" onerror="this.onerror=null; this.style.display='none'; this.nextElementSibling.style.display='flex';" />
            <div style="display: none; width: 120px; height: 120px; border-radius: 50%; background: linear-gradient(135deg, var(--emerald-dark), var(--emerald)); color: #fff; align-items: center; justify-content: center; font-size: 42px; font-weight: 800; border: 4px solid var(--accent); box-shadow: 0 8px 24px rgba(0,0,0,0.18);">${initials}</div>
          `;
        } else {
          photoWrap.innerHTML = `
            <div style="width: 120px; height: 120px; border-radius: 50%; background: linear-gradient(135deg, var(--emerald-dark), var(--emerald)); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 42px; font-weight: 800; border: 4px solid var(--accent); box-shadow: 0 8px 24px rgba(0,0,0,0.18);">${initials}</div>
          `;
        }
      }
    }

    function cancelConfirm() {
      selectedMember = null;
      document.getElementById('viewConfirm').style.display = 'none';
      document.getElementById('viewSearch').style.display = 'block';
      const input = document.getElementById('searchInput');
      if (input) {
        input.value = '';
        input.focus();
      }
      document.getElementById('resultsGrid').style.display = 'none';
      document.getElementById('noResultsBox').style.display = 'none';
      const spinner = document.getElementById('searchSpinner');
      if (spinner) spinner.style.display = 'none';
    }

    function proceedCheckIn() {
      return handleConfirmCheckIn();
    }

    async function handleConfirmCheckIn() {
      if (!selectedMember) return;

      const payload = {
        memberId: selectedMember.id,
        phone: selectedMember.phone,
        serviceName: currentServiceName,
        gender: selectedMember.gender,
        address: selectedMember.address,
        method: 'KIOSK'
      };

      let networkFailed = false;

      if (!navigator.onLine) {
        networkFailed = true;
      } else {
        try {
          const checkinRes = await fetch(`${API_BASE}/attendance/checkin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (checkinRes.ok) {
            const checkinData = await checkinRes.json();
            if (checkinData.member) {
              selectedMember = { ...selectedMember, ...checkinData.member };
            }
            if (checkinData.alreadyCheckedIn) {
              showToast(`Notice: <strong>${escapeHtml(selectedMember.firstName)} ${escapeHtml(selectedMember.lastName)}</strong> is ALREADY checked in for today's service!`, 'warning', 'Already Checked In');
              setTimeout(() => { cancelConfirm(); }, 2500);
              return;
            }

            try {
              if (window.BroadcastChannel) {
                const bc = new BroadcastChannel('sfmi_attendance_live');
                bc.postMessage({
                  type: 'CHECKIN',
                  name: `${selectedMember.firstName} ${selectedMember.lastName}`,
                  isGuest: Boolean(selectedMember.isGuest),
                  time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  service: currentServiceName
                });
                setTimeout(() => bc.close(), 500);
              }
            } catch (bErr) {}
          } else {
            networkFailed = true;
          }
        } catch (err) {
          networkFailed = true;
        }
      }

      if (networkFailed) {
        saveToOfflineQueue({
          id: 'queue_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          type: 'MEMBER',
          name: `${selectedMember.firstName} ${selectedMember.lastName}`,
          payload: payload,
          timestamp: new Date().toISOString()
        });
        showToast(`Offline Mode: Check-in saved locally on device. Will auto-sync when Wi-Fi reconnects.`, 'info', 'Saved to Offline Queue');
      }

      showPassScreen(selectedMember, false, null);
    }

    /* ============================================================
       STEP 3: FAST QUEUE RESET WITH COUNTDOWN (Feature 3)
       ============================================================ */
    function showPassScreen(member, isDuplicate = false, checkedInTime = null) {
      document.getElementById('viewConfirm').style.display = 'none';
      document.getElementById('viewPass').style.display = 'block';

      const isChild = member.category === 'Child' || (member.role && member.role.toLowerCase().includes('child'));
      const fullName = `${escapeHtml(member.firstName)} ${escapeHtml(member.lastName)}`;
      const timeStr = checkedInTime || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

      let passHeader = isChild 
        ? `${fullName} <span style="font-size: 13px; background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 4px; font-weight: 700; margin-left: 6px;"><i class="fa-solid fa-children" style="margin-right: 4px;"></i>Child / Sunday School</span>`
        : fullName;

      if (isDuplicate) {
        passHeader += ` <span style="font-size: 12px; background: #fffbeb; color: #b45309; border: 1.5px solid #fde68a; padding: 3px 9px; border-radius: 20px; font-weight: 800; margin-left: 8px; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-clock-rotate-left"></i> Already Checked In (${timeStr})</span>`;
      }

      document.getElementById('passName').innerHTML = passHeader;
      document.getElementById('passDetails').innerText = `${currentServiceName} · ${dateStr}, ${timeStr}${isDuplicate ? ' (First Checked In)' : ''}`;
      
      let locText = `Gender: ${member.gender || 'Not specified'}`;
      if (member.address) locText += ` · Location: ${member.address}`;
      if (isChild && member.guardian) locText += ` · Guardian: ${member.guardian}`;
      document.getElementById('passLocation').innerText = locText;

      const randomScrip = SCRIPTURES[Math.floor(Math.random() * SCRIPTURES.length)];
      document.getElementById('passScripture').innerText = `"${randomScrip.text}" — ${randomScrip.ref}`;

      // Reset fast 7s visual countdown timer
      if (autoResetTimer) clearTimeout(autoResetTimer);
      if (countdownInterval) clearInterval(countdownInterval);

      countdownSecondsLeft = 7;
      const countBar = document.getElementById('passCountdownBar');
      const countText = document.getElementById('passCountdownText');

      if (countBar) countBar.style.width = '100%';
      if (countText) countText.innerText = `Screen resetting in ${countdownSecondsLeft}s...`;

      countdownInterval = setInterval(() => {
        countdownSecondsLeft -= 1;
        if (countText) countText.innerText = `Screen resetting in ${Math.max(0, countdownSecondsLeft)}s...`;
        if (countBar) {
          const pct = Math.max(0, (countdownSecondsLeft / 7) * 100);
          countBar.style.width = `${pct}%`;
        }
        if (countdownSecondsLeft <= 0) {
          clearInterval(countdownInterval);
          countdownInterval = null;
          finishCheckIn();
        }
      }, 1000);
    }

    function printPassTicket() {
      window.print();
    }

    function finishCheckIn() {
      if (autoResetTimer) {
        clearTimeout(autoResetTimer);
        autoResetTimer = null;
      }
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      selectedMember = null;
      document.getElementById('viewPass').style.display = 'none';
      document.getElementById('viewConfirm').style.display = 'none';
      document.getElementById('viewSearch').style.display = 'block';

      const searchInput = document.getElementById('searchInput');
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }

      const spinner = document.getElementById('searchSpinner');
      if (spinner) spinner.style.display = 'none';

      document.getElementById('resultsGrid').style.display = 'none';
      document.getElementById('noResultsBox').style.display = 'none';
    }

    function toggleRegGuardian(val) {
      const isChild = val === 'Child';
      const guardianInput = document.getElementById('regGuardian');
      guardianInput.style.display = isChild ? 'block' : 'none';
      guardianInput.required = isChild;
    }

    function openRegisterModal() {
      document.getElementById('registerModal').classList.add('active');
      document.getElementById('regFirstName').focus();
    }

    function closeRegisterModal() {
      document.getElementById('registerModal').classList.remove('active');
    }

    async function handleRegisterSubmit(e) {
      e.preventDefault();
      const firstName = document.getElementById('regFirstName').value.trim();
      const lastName = document.getElementById('regLastName').value.trim();
      const category = document.getElementById('regCategory').value;
      const guardian = document.getElementById('regGuardian').value.trim();
      const phone = document.getElementById('regPhone').value.trim();
      const gender = document.getElementById('regGender').value;
      const address = document.getElementById('regAddress').value.trim();
      const email = document.getElementById('regEmail').value.trim();

      const newMember = {
        id: 'mem_' + Date.now(),
        firstName,
        lastName,
        category: category ? `Visitor (${category})` : 'Visitor / Guest',
        guardian: category === 'Child' ? guardian : '',
        phone,
        gender,
        address,
        email,
        role: category === 'Child' ? 'Child / Sunday School' : 'Visitor / First Timer',
        isGuest: true
      };

      const payload = {
        firstName, lastName, category, guardian, phone, gender, address, email,
        serviceName: currentServiceName
      };

      let networkFailed = false;

      if (!navigator.onLine) {
        networkFailed = true;
      } else {
        try {
          const regRes = await fetch(`${API_BASE}/attendance/quick-register-checkin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (regRes.ok) {
            const regData = await regRes.json();
            if (regData.member && regData.member.id) {
              newMember.id = regData.member.id;
            }

            try {
              if (window.BroadcastChannel) {
                const bc = new BroadcastChannel('sfmi_attendance_live');
                bc.postMessage({
                  type: 'CHECKIN',
                  name: `${firstName} ${lastName}`,
                  isGuest: true,
                  time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  service: currentServiceName
                });
                setTimeout(() => bc.close(), 500);
              }
            } catch (bErr) {}
          } else {
            networkFailed = true;
          }
        } catch (err) {
          networkFailed = true;
        }
      }

      if (networkFailed) {
        saveToOfflineQueue({
          id: 'queue_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          type: 'VISITOR',
          name: `${firstName} ${lastName}`,
          payload: payload,
          timestamp: new Date().toISOString()
        });
        showToast(`Offline Mode: Visitor check-in stored on device. Will auto-sync when online.`, 'info', 'Saved to Offline Queue');
      }

      closeRegisterModal();
      e.target.reset();
      selectedMember = newMember;
      document.getElementById('viewSearch').style.display = 'none';
      document.getElementById('viewConfirm').style.display = 'none';
      showToast(`Welcome <strong>${escapeHtml(firstName)} ${escapeHtml(lastName)}</strong> (${category})! You are checked in.`, 'success', 'Visitor Check-In Complete');
      showPassScreen(newMember, false, null);
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
        success: 'Check-In Complete',
        warning: 'Notice',
        error: 'Action Error',
        info: 'Kiosk Update'
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
