import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api/v1';

const DEFAULT_LOGO = '/church-logo.jpg';
const CHURCH_NAME = 'SOLUTIONS FAITH MINISTRY INTERNATIONAL';
const DEFAULT_TAGLINE = 'Raising Champions, Transforming Lives Through Faith';

// Default Weekly Services
const DEFAULT_SERVICES_CONFIG = [
  {
    key: 'wednesday',
    day: 'Wednesday',
    name: 'Time with the Lord',
    time: '6:00 PM – 8:00 PM',
    type: 'Midweek Word, Prayer & Miracle Service',
    image: '/wednesday-service.jpg',
    scripture: 'Psalm 27:4 — "One thing I have desired of the Lord, that will I seek after: to behold the beauty of the Lord."'
  },
  {
    key: 'friday',
    day: 'Friday',
    name: 'Prophetic Healing & Deliverance',
    time: '6:00 PM – 8:00 PM',
    type: 'Deliverance, Spiritual Warfare & Anointing Vigil',
    image: '/friday-service.jpg',
    scripture: 'Obadiah 1:17 — "Upon Mount Zion shall be deliverance, and there shall be holiness; and the house of Jacob shall possess their possessions."'
  },
  {
    key: 'sunday',
    day: 'Sunday',
    name: 'Family & Friends Service',
    time: '7:00 AM – 11:00 AM',
    type: 'Glorious Worship, Word & Family Celebration',
    image: '/wednesday-service.jpg',
    scripture: 'Joshua 24:15 — "As for me and my house, we will serve the Lord."'
  }
];

const DEFAULT_EVENTS = [
  {
    id: 'ev1',
    title: 'Supernatural Miracle & Prophetic Convention',
    date: 'November 15 – 18, 2026',
    time: '6:00 PM Nightly',
    image: '/friday-service.jpg',
    desc: 'Join us for 4 power-packed nights of explosive miracles, prophetic declarations, and deliverance.'
  },
  {
    id: 'ev2',
    title: 'Night of Total Breakthrough Vigil',
    date: 'Friday, October 30, 2026',
    time: '10:00 PM – 4:00 AM',
    image: '/wednesday-service.jpg',
    desc: 'All-night prayer marathon breaking every barrier to release your season of supernatural enlargement.'
  },
  {
    id: 'ev3',
    title: 'Family & Couples Love Banquet',
    date: 'Saturday, December 12, 2026',
    time: '5:00 PM',
    image: '/wednesday-service.jpg',
    desc: 'An evening of celebration, divine blessings over marriages, and joy for all church families.'
  }
];

const BLESSINGS = [
  {
    verse: 'The Lord bless you and keep you; the Lord make his face shine upon you and be gracious to you; the Lord turn his face toward you and give you peace.',
    ref: 'Numbers 6:24-26'
  },
  {
    verse: 'I was glad when they said unto me, Let us go into the house of the Lord.',
    ref: 'Psalm 122:1'
  },
  {
    verse: 'The blessing of the Lord, it maketh rich, and he addeth no sorrow with it.',
    ref: 'Proverbs 10:22'
  },
  {
    verse: 'Surely goodness and mercy shall follow you all the days of your life, and you shall dwell in the house of the Lord forever.',
    ref: 'Psalm 23:6'
  }
];

export default function App() {
  // Navigation: kiosk | schedule | events
  const [activeTab, setActiveTab] = useState('kiosk');

  // Church Branding State
  const [churchName, setChurchName] = useState(() => localStorage.getItem('sfmi_church_name') || CHURCH_NAME);
  const [tagline, setTagline] = useState(() => localStorage.getItem('sfmi_tagline') || DEFAULT_TAGLINE);
  const [logoUrl, setLogoUrl] = useState(() => localStorage.getItem('sfmi_logo_url') || DEFAULT_LOGO);

  // Service Photo Config
  const [serviceImages, setServiceImages] = useState(() => {
    return {
      wednesday: localStorage.getItem('sfmi_svc_img_wed') || '/wednesday-service.jpg',
      friday: localStorage.getItem('sfmi_svc_img_fri') || '/friday-service.jpg',
      sunday: localStorage.getItem('sfmi_svc_img_sun') || '/wednesday-service.jpg'
    };
  });

  // Events State
  const [events, setEvents] = useState(() => {
    const saved = localStorage.getItem('sfmi_events_data');
    return saved ? JSON.parse(saved) : DEFAULT_EVENTS;
  });

  // Time & Clock
  const [currentTime, setCurrentTime] = useState(new Date());

  // Services State
  const [services, setServices] = useState([]);
  const [selectedService, setSelectedService] = useState(null);

  // Kiosk Search & Checkin State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedMember, setSelectedMember] = useState(null);
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [checkedInResult, setCheckedInResult] = useState(null);
  const [countdown, setCountdown] = useState(6);
  const countdownRef = useRef(null);

  // Modals
  const [showVisitorModal, setShowVisitorModal] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminTab, setAdminTab] = useState('branding'); // branding | services | events

  const [regForm, setRegForm] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [newEventForm, setNewEventForm] = useState({ title: '', date: '', time: '', desc: '', image: '/friday-service.jpg' });

  // Clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch Services from backend
  const fetchServices = async () => {
    try {
      const curRes = await fetch(`${API_BASE}/attendance/services/current`);
      const curData = await curRes.json();

      const allRes = await fetch(`${API_BASE}/attendance/services`);
      const allData = await allRes.json();

      if (Array.isArray(allData) && allData.length > 0) {
        setServices(allData);
        setSelectedService(curData || allData[0]);
      } else if (curData) {
        setServices([curData]);
        setSelectedService(curData);
      }
    } catch (e) {
      console.error('Failed to load services:', e);
    }
  };

  useEffect(() => {
    fetchServices();
  }, []);

  // Search Members with debounce
  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const delay = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/attendance/search?q=${encodeURIComponent(searchQuery.trim())}`);
        const data = await res.json();
        setSearchResults(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error('Search error:', e);
      }
    }, 180);
    return () => clearTimeout(delay);
  }, [searchQuery]);

  // Reset Timer on Post Checkin
  useEffect(() => {
    if (checkedInResult) {
      setCountdown(6);
      countdownRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(countdownRef.current);
            resetCheckinFlow();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(countdownRef.current);
    }
  }, [checkedInResult]);

  const resetCheckinFlow = () => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setCheckedInResult(null);
    setSelectedMember(null);
    setSearchQuery('');
    setSearchResults([]);
  };

  // Perform Check In
  const handleCheckin = async (member) => {
    if (!member || !selectedService) return;
    setIsCheckingIn(true);

    try {
      const res = await fetch(`${API_BASE}/attendance/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberId: member.id,
          serviceId: selectedService.id,
          method: 'KIOSK'
        })
      });

      const data = await res.json();
      const randomBlessing = BLESSINGS[Math.floor(Math.random() * BLESSINGS.length)];

      setCheckedInResult({
        member,
        service: selectedService,
        attendance: data.attendance,
        alreadyChecked: res.status === 409,
        checkinTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        blessing: randomBlessing,
        code: `SFMI-${Math.floor(1000 + Math.random() * 9000)}`
      });
    } catch (e) {
      console.error(e);
      alert('Network error connecting to church server.');
    } finally {
      setIsCheckingIn(false);
    }
  };

  // Quick Register New Visitor
  const handleVisitorRegister = async (e) => {
    e.preventDefault();
    if (!regForm.firstName.trim() || !regForm.lastName.trim() || !selectedService) return;

    try {
      const res = await fetch(`${API_BASE}/attendance/quick-register-checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: regForm.firstName.trim(),
          lastName: regForm.lastName.trim(),
          phone: regForm.phone.trim() || undefined,
          email: regForm.email.trim() || undefined,
          serviceId: selectedService.id
        })
      });

      const data = await res.json();
      if (res.ok) {
        setShowVisitorModal(false);
        setRegForm({ firstName: '', lastName: '', phone: '', email: '' });
        const randomBlessing = BLESSINGS[0];
        setCheckedInResult({
          member: data.member,
          service: selectedService,
          attendance: data.attendance,
          checkinTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          blessing: randomBlessing,
          code: `SFMI-${Math.floor(1000 + Math.random() * 9000)}`
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Admin: Update Service Image
  const handleServicePhotoUpload = (e, serviceKey) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const base64 = evt.target?.result;
      if (base64) {
        const updated = { ...serviceImages, [serviceKey]: base64 };
        setServiceImages(updated);
        localStorage.setItem(`sfmi_svc_img_${serviceKey}`, base64);
        alert(`${serviceKey.toUpperCase()} service banner photo updated!`);
      }
    };
    reader.readAsDataURL(file);
  };

  // Admin: Add Event
  const handleAddEvent = (e) => {
    e.preventDefault();
    if (!newEventForm.title || !newEventForm.date) return;
    const newEv = {
      id: 'ev_' + Date.now(),
      ...newEventForm
    };
    const updated = [newEv, ...events];
    setEvents(updated);
    localStorage.setItem('sfmi_events_data', JSON.stringify(updated));
    setNewEventForm({ title: '', date: '', time: '', desc: '', image: '/friday-service.jpg' });
    setShowAdminModal(false);
    setActiveTab('events');
    alert('Event published successfully!');
  };

  return (
    <div className="app-container">
      {/* HEADER & BRANDING */}
      <header className="church-header">
        <div className="church-brand-wrapper">
          <div className="church-brand-left">
            <div className="logo-frame">
              <img src={logoUrl} alt="Church Logo" onError={(e) => { e.target.src = DEFAULT_LOGO; }} />
            </div>
            <div className="church-title-group">
              <h1 className="church-name">{churchName}</h1>
              <p className="church-tagline">{tagline}</p>
            </div>
          </div>

          <div className="church-datetime">
            <span className="live-badge">
              <span className="pulse-dot"></span> LIVE KIOSK
            </span>
            <span>{currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      </header>

      {/* NAVIGATION BAR (Clean & Public) */}
      <div className="nav-bar-container">
        <nav className="nav-bar">
          <button
            className={`nav-btn ${activeTab === 'kiosk' ? 'active' : ''}`}
            onClick={() => { setActiveTab('kiosk'); resetCheckinFlow(); }}
          >
            ✦ Kiosk Check-In
          </button>
          <button
            className={`nav-btn ${activeTab === 'schedule' ? 'active' : ''}`}
            onClick={() => setActiveTab('schedule')}
          >
            📅 Weekly Services
          </button>
          <button
            className={`nav-btn ${activeTab === 'events' ? 'active' : ''}`}
            onClick={() => setActiveTab('events')}
          >
            🌟 Upcoming Events
          </button>
        </nav>

        {/* Discrete Admin Access for Church Staff */}
        <button className="btn-admin-access" onClick={() => setShowAdminModal(true)}>
          🔐 Church Admin Portal
        </button>
      </div>

      {/* MAIN KIOSK SURFACE */}
      <main className="kiosk-card">
        {/* =========================================================================
            TAB 1: KIOSK CHECK-IN
            ========================================================================= */}
        {activeTab === 'kiosk' && (
          <div>
            {/* A. SUCCESS POST CHECK-IN */}
            {checkedInResult ? (
              <div className="success-screen">
                <div className="success-icon-badge">✓</div>
                <h2 className="success-main-title">Thank You for Coming!</h2>
                <h3 className="success-subtitle">Enjoy the Service & Be Blessed!</h3>

                <div className="checkin-slip-card">
                  <div className="slip-church-header">
                    <h5>{churchName}</h5>
                    <span className="slip-badge">
                      {checkedInResult.alreadyChecked ? 'CHECK-IN CONFIRMED' : 'ATTENDANCE VERIFIED'}
                    </span>
                  </div>

                  <h3 className="slip-attendee-name">
                    {checkedInResult.member.firstName} {checkedInResult.member.lastName}
                  </h3>

                  <div className="slip-grid">
                    <div className="slip-item">
                      Service:
                      <strong>{checkedInResult.service?.serviceType?.name || 'Worship Service'}</strong>
                    </div>
                    <div className="slip-item">
                      Time:
                      <strong>{checkedInResult.checkinTime}</strong>
                    </div>
                    <div className="slip-item">
                      Pass Code:
                      <strong>{checkedInResult.code}</strong>
                    </div>
                    <div className="slip-item">
                      Status:
                      <strong style={{ color: '#10B981' }}>Checked In</strong>
                    </div>
                  </div>

                  <div className="blessing-box">
                    <p className="blessing-scripture">"{checkedInResult.blessing.verse}"</p>
                    <span className="blessing-reference">— {checkedInResult.blessing.ref}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '14px', justifyContent: 'center', marginTop: '20px' }}>
                  <button className="btn-primary" onClick={() => window.print()}>
                    🖨️ Print Pass
                  </button>
                  <button className="btn-secondary" onClick={resetCheckinFlow}>
                    Next Check-In ➔
                  </button>
                </div>

                <div className="countdown-bar-wrapper">
                  <div className="countdown-text">Resetting for next person in {countdown}s...</div>
                  <div className="countdown-progress-track">
                    <div
                      className="countdown-progress-fill"
                      style={{ width: `${(countdown / 6) * 100}%` }}
                    ></div>
                  </div>
                </div>
              </div>
            ) : selectedMember ? (
              /* B. CONFIRMATION VIEW */
              <div style={{ textAlign: 'center', maxWidth: '540px', margin: '0 auto' }}>
                <div className="member-avatar" style={{ width: '84px', height: '84px', fontSize: '32px', margin: '0 auto 16px', border: '3px solid #D4AF37' }}>
                  {selectedMember.firstName[0]}{selectedMember.lastName[0]}
                </div>
                <h2 style={{ fontFamily: 'Cinzel, serif', fontSize: '26px', color: '#0A2518' }}>Confirm Your Details</h2>
                <p style={{ color: '#4A6356', fontSize: '15px', marginTop: '4px' }}>Please verify your details before checking in</p>

                <div style={{ background: '#F8FAF9', border: '1px solid #E2EBE5', borderRadius: '16px', padding: '22px 24px', margin: '20px 0 26px', textAlign: 'left' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px dashed #E2EBE5', fontSize: '15px' }}>
                    <span style={{ color: '#4A6356' }}>Full Name:</span>
                    <span style={{ color: '#0A2518', fontWeight: 700 }}>{selectedMember.firstName} {selectedMember.lastName}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px dashed #E2EBE5', fontSize: '15px' }}>
                    <span style={{ color: '#4A6356' }}>Phone:</span>
                    <span style={{ color: '#0A2518', fontWeight: 700 }}>{selectedMember.phone || 'Not provided'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontSize: '15px' }}>
                    <span style={{ color: '#4A6356' }}>Service:</span>
                    <span style={{ color: '#0A2518', fontWeight: 700 }}>{selectedService?.serviceType?.name || 'Current Service'}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '14px', justifyContent: 'center' }}>
                  <button className="btn-primary" disabled={isCheckingIn} onClick={() => handleCheckin(selectedMember)}>
                    {isCheckingIn ? 'Checking in...' : '✓ YES, CHECK ME IN'}
                  </button>
                  <button className="btn-secondary" onClick={() => setSelectedMember(null)}>
                    Back
                  </button>
                </div>
              </div>
            ) : (
              /* C. DEFAULT SEARCH & SERVICE SELECTOR VIEW */
              <>
                {/* Photo Service Selector */}
                <span className="service-selector-label">
                  <i className="fas fa-church"></i> Active Service Today:
                </span>
                <div className="service-selector-grid">
                  {DEFAULT_SERVICES_CONFIG.map((s) => {
                    const matchedService = services.find((svc) =>
                      svc.serviceType?.name?.toLowerCase().includes(s.day.toLowerCase()) ||
                      svc.serviceType?.name?.toLowerCase().includes(s.name.toLowerCase())
                    ) || selectedService;

                    const isSelected = selectedService?.serviceType?.name?.toLowerCase().includes(s.day.toLowerCase()) ||
                      selectedService?.serviceType?.name?.toLowerCase().includes(s.name.toLowerCase());

                    const bannerImg = serviceImages[s.key] || s.image;

                    return (
                      <div
                        key={s.key}
                        className={`service-photo-card ${isSelected ? 'active' : ''}`}
                        onClick={() => {
                          if (matchedService) setSelectedService(matchedService);
                        }}
                      >
                        {isSelected && <span className="service-active-pill">✓ ACTIVE</span>}
                        <div className="service-photo-banner">
                          <img src={bannerImg} alt={s.name} />
                          <div className="service-banner-overlay">
                            <span style={{ color: '#FDE074', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>
                              {s.day} Service
                            </span>
                          </div>
                        </div>
                        <div className="service-card-info">
                          <strong style={{ fontSize: '15px', color: '#0A2518', lineHeight: 1.25 }}>{s.name}</strong>
                          <span style={{ fontSize: '12px', color: '#4A6356', fontWeight: 600 }}>🕒 {s.time}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="kiosk-header">
                  <h2>Welcome to Church</h2>
                  <p>Type your name or phone number below to check in</p>
                </div>

                {/* Search Bar */}
                <div className="search-wrapper">
                  <span className="search-input-icon">🔍</span>
                  <input
                    type="text"
                    className="kiosk-search-input"
                    placeholder="Search by first name, last name, or phone number..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    autoFocus
                  />
                  {searchQuery && (
                    <button className="search-clear-btn" onClick={() => setSearchQuery('')}>
                      ✕
                    </button>
                  )}
                </div>

                {/* Toolbar */}
                <div className="kiosk-quick-actions">
                  <span style={{ fontSize: '13.5px', color: '#4A6356', fontWeight: 600 }}>
                    ⚡ 1-Click Instant Member Check-In
                  </span>
                  <button className="quick-action-link" onClick={() => setShowVisitorModal(true)}>
                    ➕ New Visitor? Register Here
                  </button>
                </div>

                {/* Search Results */}
                {searchResults.length > 0 ? (
                  <div className="search-results-grid">
                    {searchResults.map((member) => (
                      <div
                        key={member.id}
                        className="member-result-card"
                        onClick={() => setSelectedMember(member)}
                      >
                        <div className="member-card-left">
                          <div className="member-avatar">
                            {member.firstName[0]}{member.lastName[0]}
                          </div>
                          <div className="member-info">
                            <h4>{member.firstName} {member.lastName}</h4>
                            <p>{member.phone || 'Member'}</p>
                          </div>
                        </div>
                        <span className="checkin-tag">Check In ➔</span>
                      </div>
                    ))}
                  </div>
                ) : searchQuery.length > 1 ? (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: '#4A6356' }}>
                    <h3>No member found for "{searchQuery}"</h3>
                    <p style={{ marginTop: '4px' }}>First time attending? Click below to register and check in:</p>
                    <button
                      className="btn-primary"
                      style={{ marginTop: '16px' }}
                      onClick={() => {
                        const parts = searchQuery.trim().split(' ');
                        setRegForm({
                          firstName: parts[0] || '',
                          lastName: parts.slice(1).join(' ') || '',
                          phone: /^\+?[0-9\-() ]+$/.test(searchQuery) ? searchQuery : '',
                          email: ''
                        });
                        setShowVisitorModal(true);
                      }}
                    >
                      ➕ Quick Register & Check In
                    </button>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: '#4A6356' }}>
                    <div style={{ fontSize: '42px', color: '#D4AF37', marginBottom: '8px' }}>✨</div>
                    <h3>Start typing to find your name</h3>
                    <p>Enter at least 2 characters to search our member directory</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* =========================================================================
            TAB 2: WEEKLY SERVICES (WITH PHOTO BANNERS)
            ========================================================================= */}
        {activeTab === 'schedule' && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: '28px' }}>
              <h2 style={{ fontFamily: 'Cinzel, serif', fontSize: '28px', color: '#0A2518' }}>
                Weekly Services & Gatherings
              </h2>
              <p style={{ color: '#4A6356', marginTop: '4px' }}>
                Join us each week for powerful prayer, prophetic revelation, and supernatural fellowship.
              </p>
            </div>

            <div className="service-selector-grid" style={{ gap: '20px' }}>
              {DEFAULT_SERVICES_CONFIG.map((s) => {
                const bannerImg = serviceImages[s.key] || s.image;
                return (
                  <div key={s.key} className="service-photo-card" style={{ cursor: 'default' }}>
                    <div className="service-photo-banner" style={{ height: '180px' }}>
                      <img src={bannerImg} alt={s.name} />
                      <div className="service-banner-overlay">
                        <span style={{ color: '#FDE074', fontSize: '13px', fontWeight: 800, textTransform: 'uppercase' }}>
                          {s.day} Service
                        </span>
                      </div>
                    </div>
                    <div className="service-card-info" style={{ padding: '20px' }}>
                      <h3 style={{ fontSize: '18px', color: '#0A2518', fontFamily: 'Cinzel, serif' }}>{s.name}</h3>
                      <span style={{ fontSize: '13.5px', color: '#B8860B', fontWeight: 700, margin: '6px 0 10px' }}>
                        🕒 {s.time}
                      </span>
                      <p style={{ fontSize: '13.5px', color: '#4A6356', lineHeight: 1.45 }}>{s.type}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* =========================================================================
            TAB 3: UPCOMING EVENTS
            ========================================================================= */}
        {activeTab === 'events' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '10px' }}>
              <div>
                <h2 style={{ fontFamily: 'Cinzel, serif', fontSize: '28px', color: '#0A2518' }}>
                  Upcoming Church Events
                </h2>
                <p style={{ color: '#4A6356', marginTop: '2px' }}>
                  Special conferences, conventions, and fellowship gatherings at {churchName}.
                </p>
              </div>
              <button className="quick-action-link" onClick={() => { setAdminTab('events'); setShowAdminModal(true); }}>
                ➕ Add Event (Admin)
              </button>
            </div>

            <div className="events-cards-grid">
              {events.map((ev) => (
                <div key={ev.id} className="event-card">
                  <div className="event-card-banner">
                    <img src={ev.image || '/friday-service.jpg'} alt={ev.title} />
                    <span className="event-date-badge">{ev.date}</span>
                  </div>
                  <div className="event-card-body">
                    <div>
                      <h3 className="event-card-title">{ev.title}</h3>
                      <div className="event-card-meta">
                        🕒 {ev.time}
                      </div>
                      <p className="event-card-desc">{ev.desc}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* VISITOR REGISTRATION MODAL */}
      {showVisitorModal && (
        <div className="modal-backdrop" onClick={() => setShowVisitorModal(false)}>
          <div className="modal-card" style={{ maxWidth: '520px' }} onClick={(e) => e.stopPropagation()}>
            <button className="modal-close-btn" onClick={() => setShowVisitorModal(false)}>✕</button>
            <h3 style={{ fontFamily: 'Cinzel, serif', fontSize: '22px', color: '#0A2518', marginBottom: '4px' }}>
              Welcome New Visitor!
            </h3>
            <p style={{ fontSize: '14px', color: '#4A6356', marginBottom: '20px' }}>
              Register your details to check in immediately for today's service.
            </p>

            <form onSubmit={handleVisitorRegister}>
              <div className="form-group">
                <label>First Name *</label>
                <input
                  type="text"
                  required
                  className="form-input"
                  placeholder="e.g. Emmanuel"
                  value={regForm.firstName}
                  onChange={(e) => setRegForm({ ...regForm, firstName: e.target.value })}
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label>Last Name *</label>
                <input
                  type="text"
                  required
                  className="form-input"
                  placeholder="e.g. Mensah"
                  value={regForm.lastName}
                  onChange={(e) => setRegForm({ ...regForm, lastName: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Phone Number (Optional)</label>
                <input
                  type="tel"
                  className="form-input"
                  placeholder="e.g. +1 (555) 234-5678"
                  value={regForm.phone}
                  onChange={(e) => setRegForm({ ...regForm, phone: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Email Address (Optional)</label>
                <input
                  type="email"
                  className="form-input"
                  placeholder="e.g. name@example.com"
                  value={regForm.email}
                  onChange={(e) => setRegForm({ ...regForm, email: e.target.value })}
                />
              </div>

              <button type="submit" className="btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }}>
                ✓ Register & Check In Now
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ADMIN MODAL (Logo, Service Images, Events) */}
      {showAdminModal && (
        <div className="modal-backdrop" onClick={() => setShowAdminModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close-btn" onClick={() => setShowAdminModal(false)}>✕</button>
            <h3 style={{ fontFamily: 'Cinzel, serif', fontSize: '24px', color: '#0A2518', marginBottom: '4px' }}>
              Church Administration Portal
            </h3>
            <p style={{ fontSize: '14px', color: '#4A6356', marginBottom: '20px' }}>
              Manage church identity, weekly service images, and upcoming events.
            </p>

            {/* Admin Tabs */}
            <div style={{ display: 'flex', gap: '8px', borderBottom: '2px solid #E2EBE5', paddingBottom: '12px', marginBottom: '20px' }}>
              <button
                className={adminTab === 'branding' ? 'btn-primary' : 'btn-secondary'}
                style={{ padding: '8px 16px', fontSize: '13px' }}
                onClick={() => setAdminTab('branding')}
              >
                Logo & Motto
              </button>
              <button
                className={adminTab === 'services' ? 'btn-primary' : 'btn-secondary'}
                style={{ padding: '8px 16px', fontSize: '13px' }}
                onClick={() => setAdminTab('services')}
              >
                Service Images
              </button>
              <button
                className={adminTab === 'events' ? 'btn-primary' : 'btn-secondary'}
                style={{ padding: '8px 16px', fontSize: '13px' }}
                onClick={() => setAdminTab('events')}
              >
                Manage Events
              </button>
            </div>

            {/* TAB 1: LOGO & BRANDING */}
            {adminTab === 'branding' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '18px', padding: '16px', background: '#F8FAF9', borderRadius: '14px', marginBottom: '18px', border: '1px solid #E2EBE5' }}>
                  <img src={logoUrl} alt="Logo" style={{ width: '68px', height: '68px', borderRadius: '50%', objectFit: 'cover', border: '2px solid #D4AF37' }} />
                  <div>
                    <strong style={{ color: '#0A2518' }}>Official Church Logo</strong>
                    <p style={{ fontSize: '12.5px', color: '#4A6356' }}>Displayed on Kiosk, header, and print passes</p>
                    <button
                      className="btn-secondary"
                      style={{ padding: '4px 12px', fontSize: '12px', marginTop: '6px' }}
                      onClick={() => {
                        setLogoUrl(DEFAULT_LOGO);
                        localStorage.removeItem('sfmi_logo_url');
                      }}
                    >
                      Reset to Default Emblem
                    </button>
                  </div>
                </div>

                <label style={{ display: 'block', border: '2px dashed #CBDAD1', borderRadius: '14px', padding: '18px', textAlign: 'center', cursor: 'pointer', background: '#FFFDF8', marginBottom: '16px' }}>
                  <span style={{ fontSize: '28px', display: 'block', marginBottom: '4px' }}>📁</span>
                  <strong style={{ color: '#0A2518' }}>Click to Upload Church Logo File</strong>
                  <span style={{ display: 'block', fontSize: '12px', color: '#4A6356', marginTop: '2px' }}>Supports PNG, JPG, SVG from your computer</span>
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = (evt) => {
                        const base64 = evt.target?.result;
                        if (base64) {
                          setLogoUrl(base64);
                          localStorage.setItem('sfmi_logo_url', base64);
                        }
                      };
                      reader.readAsDataURL(file);
                    }}
                  />
                </label>

                <div className="form-group">
                  <label>Church Name</label>
                  <input
                    type="text"
                    className="form-input"
                    value={churchName}
                    onChange={(e) => {
                      setChurchName(e.target.value);
                      localStorage.setItem('sfmi_church_name', e.target.value);
                    }}
                  />
                </div>

                <div className="form-group">
                  <label>Church Tagline / Motto</label>
                  <input
                    type="text"
                    className="form-input"
                    value={tagline}
                    onChange={(e) => {
                      setTagline(e.target.value);
                      localStorage.setItem('sfmi_tagline', e.target.value);
                    }}
                  />
                </div>

                <button
                  className="btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => {
                    alert('Church branding settings saved!');
                    setShowAdminModal(false);
                  }}
                >
                  ✓ Save Settings
                </button>
              </div>
            )}

            {/* TAB 2: SERVICE BANNER IMAGES */}
            {adminTab === 'services' && (
              <div>
                <h4 style={{ fontSize: '16px', color: '#0A2518', marginBottom: '12px' }}>Upload Custom Photos for Weekly Services</h4>

                {/* Wednesday */}
                <div style={{ border: '1px solid #E2EBE5', borderRadius: '12px', padding: '14px', marginBottom: '14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <strong style={{ color: '#0A2518' }}>Wednesday: Time with the Lord</strong>
                    <label className="btn-secondary" style={{ padding: '4px 12px', fontSize: '12px', cursor: 'pointer' }}>
                      Upload Photo
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleServicePhotoUpload(e, 'wednesday')} />
                    </label>
                  </div>
                  <input
                    type="text"
                    className="form-input"
                    style={{ marginBottom: 0 }}
                    placeholder="Or paste image URL"
                    value={serviceImages.wednesday.startsWith('data:') ? '' : serviceImages.wednesday}
                    onChange={(e) => {
                      const updated = { ...serviceImages, wednesday: e.target.value };
                      setServiceImages(updated);
                      localStorage.setItem('sfmi_svc_img_wed', e.target.value);
                    }}
                  />
                </div>

                {/* Friday */}
                <div style={{ border: '1px solid #E2EBE5', borderRadius: '12px', padding: '14px', marginBottom: '14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <strong style={{ color: '#0A2518' }}>Friday: Prophetic Healing & Deliverance</strong>
                    <label className="btn-secondary" style={{ padding: '4px 12px', fontSize: '12px', cursor: 'pointer' }}>
                      Upload Photo
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleServicePhotoUpload(e, 'friday')} />
                    </label>
                  </div>
                  <input
                    type="text"
                    className="form-input"
                    style={{ marginBottom: 0 }}
                    placeholder="Or paste image URL"
                    value={serviceImages.friday.startsWith('data:') ? '' : serviceImages.friday}
                    onChange={(e) => {
                      const updated = { ...serviceImages, friday: e.target.value };
                      setServiceImages(updated);
                      localStorage.setItem('sfmi_svc_img_friday', e.target.value);
                    }}
                  />
                </div>

                {/* Sunday */}
                <div style={{ border: '1px solid #E2EBE5', borderRadius: '12px', padding: '14px', marginBottom: '14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <strong style={{ color: '#0A2518' }}>Sunday: Family & Friends Service</strong>
                    <label className="btn-secondary" style={{ padding: '4px 12px', fontSize: '12px', cursor: 'pointer' }}>
                      Upload Photo
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleServicePhotoUpload(e, 'sunday')} />
                    </label>
                  </div>
                  <input
                    type="text"
                    className="form-input"
                    style={{ marginBottom: 0 }}
                    placeholder="Or paste image URL"
                    value={serviceImages.sunday.startsWith('data:') ? '' : serviceImages.sunday}
                    onChange={(e) => {
                      const updated = { ...serviceImages, sunday: e.target.value };
                      setServiceImages(updated);
                      localStorage.setItem('sfmi_svc_img_sunday', e.target.value);
                    }}
                  />
                </div>

                <button className="btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }} onClick={() => setShowAdminModal(false)}>
                  ✓ Done Managing Images
                </button>
              </div>
            )}

            {/* TAB 3: MANAGE EVENTS */}
            {adminTab === 'events' && (
              <div>
                <h4 style={{ fontSize: '16px', color: '#0A2518', marginBottom: '12px' }}>Publish New Upcoming Event</h4>

                <form onSubmit={handleAddEvent}>
                  <div className="form-group">
                    <label>Event Title *</label>
                    <input
                      type="text"
                      required
                      className="form-input"
                      placeholder="e.g. Annual Miracle & Anointing Convention"
                      value={newEventForm.title}
                      onChange={(e) => setNewEventForm({ ...newEventForm, title: e.target.value })}
                    />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div className="form-group">
                      <label>Event Date *</label>
                      <input
                        type="text"
                        required
                        className="form-input"
                        placeholder="e.g. Nov 15 - 18, 2026"
                        value={newEventForm.date}
                        onChange={(e) => setNewEventForm({ ...newEventForm, date: e.target.value })}
                      />
                    </div>
                    <div className="form-group">
                      <label>Event Time *</label>
                      <input
                        type="text"
                        required
                        className="form-input"
                        placeholder="e.g. 6:00 PM Nightly"
                        value={newEventForm.time}
                        onChange={(e) => setNewEventForm({ ...newEventForm, time: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Banner Image (File Upload or URL)</label>
                    <input
                      type="file"
                      accept="image/*"
                      className="form-input"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = (evt) => {
                          if (evt.target?.result) setNewEventForm({ ...newEventForm, image: evt.target.result });
                        };
                        reader.readAsDataURL(file);
                      }}
                    />
                  </div>

                  <div className="form-group">
                    <label>Event Description *</label>
                    <textarea
                      required
                      rows={3}
                      className="form-input"
                      placeholder="Brief event overview..."
                      value={newEventForm.desc}
                      onChange={(e) => setNewEventForm({ ...newEventForm, desc: e.target.value })}
                    ></textarea>
                  </div>

                  <button type="submit" className="btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                    Publish Event to Kiosk
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
