const prisma = require('../../config/prisma');

/**
 * Helper: Classify a service into standard church categories:
 * - 'SUNDAY': Sunday Services
 * - 'WEDNESDAY': Midweek Services / Time with the Lord
 * - 'FRIDAY': Friday Prophetic / Miracle / Deliverance Services
 * - 'EVENT': Special Programs, Conventions, Vigils, Revivals
 */
function classifyServiceCategory(serviceName = '', serviceTypeName = '') {
  const combined = `${serviceName} ${serviceTypeName}`.toLowerCase();
  if (combined.includes('sunday') || combined.includes('family & friends')) {
    return 'SUNDAY';
  }
  if (combined.includes('wednesday') || combined.includes('mid-week') || combined.includes('midweek') || combined.includes('time with the lord')) {
    return 'WEDNESDAY';
  }
  if (combined.includes('friday') || combined.includes('prophetic') || combined.includes('miracle') || combined.includes('deliverance')) {
    return 'FRIDAY';
  }
  return 'EVENT';
}

/**
 * 🔴 Multi-Service Consecutive Attendance Engine
 *
 * Chronologically evaluates services held across church history.
 * Tracks continuous streaks across calendar months and years without monthly resets.
 * Preserves streaks through excused absences.
 *
 * @param {Array} targetServices Chronologically ordered services of the target category (oldest to newest)
 * @param {Array} allAttendances All attendance records across church history
 * @param {Map} excusedMap Map of memberId -> Array of excused absence ranges or dates
 * @param {Array} targetMemberIds Target members to evaluate
 * @param {string} serviceTypeLabel Label (e.g. 'Sunday', 'Wednesday', 'Friday', 'Overall')
 * @returns {Map} memberId -> streak profile
 */
function calculateConsecutiveStreaks(targetServices = [], allAttendances = [], excusedMap = new Map(), targetMemberIds = [], serviceTypeLabel = 'Sunday') {
  const profiles = new Map();

  // Sort services chronologically (oldest to newest)
  const sortedServices = [...targetServices].sort((a, b) => {
    const da = new Date(a.serviceDate || a.startsAt);
    const db = new Date(b.serviceDate || b.startsAt);
    return da - db;
  });

  // Pre-index attendances by serviceId -> Set of memberIds
  const attendanceByServiceId = new Map();
  allAttendances.forEach(att => {
    if (!attendanceByServiceId.has(att.serviceId)) {
      attendanceByServiceId.set(att.serviceId, new Set());
    }
    attendanceByServiceId.get(att.serviceId).add(att.memberId);
  });

  // Pre-index all unique memberIds present in church + target registered members
  const allMemberIds = new Set(targetMemberIds);
  allAttendances.forEach(att => allMemberIds.add(att.memberId));
  for (const [mId] of excusedMap) {
    allMemberIds.add(mId);
  }

  for (const memberId of allMemberIds) {
    let currentStreak = 0;
    let longestStreak = 0;
    let runningStreak = 0;
    let consecutiveMissed = 0;
    let totalAttended = 0;
    let totalMissed = 0;
    let totalExcused = 0;
    let lastAttendedDate = null;
    let streakStartDate = null;
    let currentStreakStartedAt = null;

    const memberExcusedRanges = excusedMap.get(memberId) || [];

    for (let i = 0; i < sortedServices.length; i++) {
      const svc = sortedServices[i];
      const svcDate = new Date(svc.serviceDate || svc.startsAt);
      const isAttended = attendanceByServiceId.get(svc.id)?.has(memberId) || false;

      const isExcused = !isAttended && memberExcusedRanges.some(range => {
        const start = new Date(range.startsAt || range.startDate);
        const end = new Date(range.endsAt || range.endDate || range.startsAt);
        end.setHours(23, 59, 59, 999);
        return svcDate >= start && svcDate <= end;
      });

      if (isAttended) {
        totalAttended++;
        consecutiveMissed = 0;
        if (runningStreak === 0) {
          currentStreakStartedAt = svcDate.toISOString().slice(0, 10);
        }
        runningStreak++;
        if (runningStreak > longestStreak) {
          longestStreak = runningStreak;
        }
        lastAttendedDate = svcDate.toISOString().slice(0, 10);
      } else if (isExcused) {
        totalExcused++;
      } else {
        totalMissed++;
        runningStreak = 0;
        currentStreakStartedAt = null;
        // Only count consecutive missed if the member has attended church in this category before
        if (totalAttended > 0) {
          consecutiveMissed++;
        }
      }
    }

    currentStreak = runningStreak;
    streakStartDate = currentStreakStartedAt;

    let alertStatus = 'FAITHFUL';
    let alertLabel = `${serviceTypeLabel} Faithful`;
    let alertColor = '#137333';

    if (totalAttended === 0) {
      alertStatus = 'NOT_ATTENDED';
      alertLabel = `No ${serviceTypeLabel} Check-ins`;
      alertColor = '#94a3b8';
      consecutiveMissed = 0;
    } else if (consecutiveMissed >= 8) {
      alertStatus = 'INACTIVE';
      alertLabel = `${serviceTypeLabel} Inactive`;
      alertColor = '#475569';
    } else if (consecutiveMissed >= 3) {
      alertStatus = 'FOLLOW_UP_REQUIRED';
      alertLabel = `Follow-Up Required (${consecutiveMissed} Missed)`;
      alertColor = '#dc2626';
    } else if (consecutiveMissed === 2) {
      alertStatus = 'CONCERN';
      alertLabel = `${serviceTypeLabel} Concern (2 Missed)`;
      alertColor = '#ea580c';
    } else if (consecutiveMissed === 1) {
      alertStatus = 'WATCH';
      alertLabel = `${serviceTypeLabel} Watch (1 Missed)`;
      alertColor = '#d97706';
    } else {
      alertStatus = 'FAITHFUL';
      alertLabel = currentStreak >= 3 ? `${serviceTypeLabel} Faithful (🔥 ${currentStreak} Streak)` : `${serviceTypeLabel} Faithful`;
      alertColor = '#137333';
    }

    const totalOpportunities = sortedServices.length;
    const attendancePct = totalOpportunities > 0
      ? Math.round((totalAttended / totalOpportunities) * 100)
      : 0;

    profiles.set(memberId, {
      memberId,
      currentStreak,
      longestStreak,
      consecutiveMissed,
      totalAttended,
      totalMissed,
      totalExcused,
      totalOpportunities,
      attendancePct,
      lastAttendedDate,
      streakStartDate,
      alertStatus,
      alertLabel,
      alertColor,
      // Backward compatibility aliases
      currentSundayStreak: currentStreak,
      longestSundayStreak: longestStreak,
      consecutiveSundaysMissed: consecutiveMissed,
      totalSundaysAttended: totalAttended,
      totalSundaysMissed: totalMissed,
      totalSundaysExcused: totalExcused,
      totalSundayOpportunities: totalOpportunities,
      sundayAttendancePct: attendancePct,
      lastSundayAttendedDate: lastAttendedDate,
      sundayAlertStatus: alertStatus
    });
  }

  return profiles;
}

function calculateSundayConsecutiveStreaks(allSundayServices = [], allAttendances = [], excusedMap = new Map(), targetMemberIds = []) {
  return calculateConsecutiveStreaks(allSundayServices, allAttendances, excusedMap, targetMemberIds, 'Sunday');
}

/**
 * Helper: Calculate Member Engagement Score (0 to 100)
 */
function calculateEngagementScore({
  overallRate = 0,
  sundayRate = 0,
  currentSundayStreak = 0,
  consecutiveSundaysMissed = 0,
  wednesdayCount = 0,
  fridayCount = 0,
  eventCount = 0,
  rateDelta = 0,
  isNewMember = false
}) {
  let score = 0;

  // 1. Overall frequency (0-35)
  score += Math.round((Math.min(100, overallRate) / 100) * 35);

  // 2. Sunday fidelity (0-20)
  score += Math.round((Math.min(100, sundayRate) / 100) * 20);
  if (currentSundayStreak >= 4) score += 10;
  else if (currentSundayStreak >= 2) score += 5;

  // Penalize consecutive missed Sundays
  if (consecutiveSundaysMissed >= 3) score -= 15;
  else if (consecutiveSundaysMissed === 2) score -= 8;
  else if (consecutiveSundaysMissed === 1) score -= 3;

  // 3. Midweek & Friday participation (0-25)
  const wedScore = wednesdayCount > 0 ? (wednesdayCount >= 2 ? 15 : 10) : 0;
  const friScore = fridayCount > 0 ? (fridayCount >= 2 ? 10 : 7) : 0;
  score += (wedScore + friScore);

  // 4. Recency & Trajectory (0-15)
  if (rateDelta >= 15) score += 15;
  else if (rateDelta >= 0) score += 10;
  else if (rateDelta >= -20) score += 5;
  if (rateDelta <= -35) score -= 10;

  if (isNewMember) {
    score = Math.max(score, Math.round(overallRate * 0.9));
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let tier = 'MODERATE';
  let tierLabel = 'Moderate Engagement';
  let badgeColor = '#d97706';

  if (score >= 85) {
    tier = 'HIGHLY_ENGAGED';
    tierLabel = 'Highly Engaged (Pillar)';
    badgeColor = '#15803d';
  } else if (score >= 65) {
    tier = 'ENGAGED';
    tierLabel = 'Engaged Member';
    badgeColor = '#0d9488';
  } else if (score >= 40) {
    tier = 'MODERATE';
    tierLabel = 'Moderate / Occasional';
    badgeColor = '#b45309';
  } else if (score >= 20) {
    tier = 'AT_RISK';
    tierLabel = 'At-Risk (Declining)';
    badgeColor = '#ea580c';
  } else {
    tier = 'CRITICAL';
    tierLabel = 'Disengaged / Critical';
    badgeColor = '#dc2626';
  }

  return { score, tier, tierLabel, badgeColor };
}

function createDefaultProfile(label) {
  return {
    currentStreak: 0,
    longestStreak: 0,
    consecutiveMissed: 0,
    totalAttended: 0,
    totalMissed: 0,
    totalExcused: 0,
    totalOpportunities: 0,
    attendancePct: 0,
    lastAttendedDate: null,
    streakStartDate: null,
    alertStatus: 'NOT_ATTENDED',
    alertLabel: `No ${label} Check-ins`,
    alertColor: '#94a3b8',
    currentSundayStreak: 0,
    longestSundayStreak: 0,
    consecutiveSundaysMissed: 0,
    totalSundaysAttended: 0,
    totalSundaysMissed: 0,
    totalSundaysExcused: 0,
    totalSundayOpportunities: 0,
    sundayAttendancePct: 0,
    lastSundayAttendedDate: null,
    sundayAlertStatus: 'WATCH'
  };
}

// Lightweight in-memory cache for analytics queries (60s TTL)
const analyticsCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function getCachedAnalytics(key) {
  const item = analyticsCache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL_MS) {
    analyticsCache.delete(key);
    return null;
  }
  return item.data;
}

function setCachedAnalytics(key, data) {
  analyticsCache.set(key, { data, timestamp: Date.now() });
  if (analyticsCache.size > 100) {
    const oldestKey = analyticsCache.keys().next().value;
    analyticsCache.delete(oldestKey);
  }
}

function invalidateAnalyticsCache() {
  analyticsCache.clear();
}

/**
 * Main Monthly Attendance Analytics Engine
 */
async function getMonthlyAttendanceAnalytics({ year, month, serviceTypeFilter = 'ALL', attendeeType = 'ALL', forceRefresh = false } = {}) {
  const now = new Date();
  const currentYear = year ? parseInt(year, 10) : now.getUTCFullYear();
  const currentMonth = month ? parseInt(month, 10) : now.getUTCMonth() + 1;

  const cacheKey = `monthly_${currentYear}_${currentMonth}_${serviceTypeFilter}_${attendeeType}`;
  if (!forceRefresh) {
    const cached = getCachedAnalytics(cacheKey);
    if (cached) return cached;
  }

  // Month date ranges
  const startOfMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1, 0, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(currentYear, currentMonth, 0, 23, 59, 59, 999));

  // Previous Month (M-1)
  const prevMonthDate = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
  const startOfPrevMonth = new Date(Date.UTC(prevMonthDate.getUTCFullYear(), prevMonthDate.getUTCMonth(), 1, 0, 0, 0, 0));
  const endOfPrevMonth = new Date(Date.UTC(prevMonthDate.getUTCFullYear(), prevMonthDate.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  // Two Months Ago (M-2)
  const twoMonthsAgoDate = new Date(Date.UTC(currentYear, currentMonth - 3, 1));
  const startOfTwoMonthsAgo = new Date(Date.UTC(twoMonthsAgoDate.getUTCFullYear(), twoMonthsAgoDate.getUTCMonth(), 1, 0, 0, 0, 0));
  const endOfTwoMonthsAgo = new Date(Date.UTC(twoMonthsAgoDate.getUTCFullYear(), twoMonthsAgoDate.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  // 1. Fetch 5 core data requirements in parallel via Promise.all (zero sequential waterfalls)
  const [
    allMembers,
    allHistoricalServices,
    allHistoricalAttendances,
    outOfTownRecords,
    pastoralFollowUpLogs
  ] = await Promise.all([
    // Active Registered Members
    prisma.member.findMany({
      where: { active: true, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        gender: true,
        category: true,
        role: true,
        photoUrl: true,
        createdAt: true
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
    }),

    // All Historical Services categorized for Multi-Service Streaks
    prisma.service.findMany({
      where: { active: true },
      include: { serviceType: true },
      orderBy: { serviceDate: 'asc' }
    }),

    // All Attendance Records across History for Streak Calculations
    prisma.attendance.findMany({
      where: { member: { active: true, deletedAt: null } },
      select: { id: true, memberId: true, serviceId: true, checkedInAt: true, method: true }
    }),

    // OutOfTown / Excused Absences
    prisma.outOfTown.findMany({
      select: { memberId: true, startsAt: true, endsAt: true, note: true }
    }),

    // Pastoral Follow-Up History from AuditLog
    prisma.auditLog.findMany({
      where: { action: 'PASTORAL_FOLLOW_UP' },
      orderBy: { createdAt: 'desc' },
      take: 500
    })
  ]);

  // Index services and calculate attendance count per service in-memory (sub-millisecond)
  const serviceMap = new Map();
  allHistoricalServices.forEach(s => serviceMap.set(s.id, s));

  const serviceAttendanceCountMap = new Map();
  allHistoricalAttendances.forEach(att => {
    serviceAttendanceCountMap.set(att.serviceId, (serviceAttendanceCountMap.get(att.serviceId) || 0) + 1);
  });

  // Derive Month Services with attendance count
  const monthServices = allHistoricalServices
    .filter(s => {
      const dt = new Date(s.serviceDate);
      return dt >= startOfMonth && dt <= endOfMonth;
    })
    .map(s => ({
      ...s,
      _count: { attendance: serviceAttendanceCountMap.get(s.id) || 0 }
    }));

  // Derive Month, M-1, and M-2 attendances in-memory without extra DB round-trips
  const monthAttendances = [];
  const prevMonthAttendances = [];
  const twoMonthsAgoAttendances = [];

  allHistoricalAttendances.forEach(att => {
    const s = serviceMap.get(att.serviceId);
    if (!s) return;
    const dt = new Date(s.serviceDate);
    if (dt >= startOfMonth && dt <= endOfMonth) {
      monthAttendances.push({
        ...att,
        service: s
      });
    } else if (dt >= startOfPrevMonth && dt <= endOfPrevMonth) {
      prevMonthAttendances.push({
        memberId: att.memberId,
        serviceId: att.serviceId
      });
    } else if (dt >= startOfTwoMonthsAgo && dt <= endOfTwoMonthsAgo) {
      twoMonthsAgoAttendances.push({
        memberId: att.memberId,
        serviceId: att.serviceId
      });
    }
  });

  const prevMonthServicesCount = allHistoricalServices.filter(s => {
    const dt = new Date(s.serviceDate);
    return dt >= startOfPrevMonth && dt <= endOfPrevMonth;
  }).length;

  const twoMonthsAgoServicesCount = allHistoricalServices.filter(s => {
    const dt = new Date(s.serviceDate);
    return dt >= startOfTwoMonthsAgo && dt <= endOfTwoMonthsAgo;
  }).length;

  const regularMembers = allMembers.filter(m => {
    const role = (m.role || '').toLowerCase();
    const cat = (m.category || '').toLowerCase();
    return !role.includes('visitor') && !role.includes('guest') && !cat.includes('visitor') && !cat.includes('guest');
  });
  const visitorMembers = allMembers.filter(m => !regularMembers.includes(m));

  // Select target members based on attendeeType: 'ALL', 'MEMBERS', or 'VISITORS'
  let targetMembers = allMembers;
  if (attendeeType === 'MEMBERS') {
    targetMembers = regularMembers;
  } else if (attendeeType === 'VISITORS') {
    targetMembers = visitorMembers;
  }

  const allSundayServices = [];
  const allWednesdayServices = [];
  const allFridayServices = [];
  const allEventServices = [];

  allHistoricalServices.forEach(s => {
    const cat = classifyServiceCategory(s.serviceType?.name || '', s.name || '');
    if (cat === 'SUNDAY') allSundayServices.push(s);
    else if (cat === 'WEDNESDAY') allWednesdayServices.push(s);
    else if (cat === 'FRIDAY') allFridayServices.push(s);
    else allEventServices.push(s);
  });

  const excusedMap = new Map();
  outOfTownRecords.forEach(rec => {
    if (!excusedMap.has(rec.memberId)) excusedMap.set(rec.memberId, []);
    excusedMap.get(rec.memberId).push(rec);
  });

  // Multi-Service Streaks across History for target members
  const targetMemberIds = targetMembers.map(m => m.id);
  const sundayProfiles = calculateConsecutiveStreaks(allSundayServices, allHistoricalAttendances, excusedMap, targetMemberIds, 'Sunday');
  const wednesdayProfiles = calculateConsecutiveStreaks(allWednesdayServices, allHistoricalAttendances, excusedMap, targetMemberIds, 'Wednesday');
  const fridayProfiles = calculateConsecutiveStreaks(allFridayServices, allHistoricalAttendances, excusedMap, targetMemberIds, 'Friday');
  const overallProfiles = calculateConsecutiveStreaks(allHistoricalServices, allHistoricalAttendances, excusedMap, targetMemberIds, 'Overall');

  // Filter Month Services by Service Category
  const categorizedMonthServices = monthServices.map(s => {
    const category = classifyServiceCategory(s.serviceType?.name || '', s.serviceType?.name || '');
    return { ...s, category };
  });

  const sundaysInMonth = categorizedMonthServices.filter(s => s.category === 'SUNDAY');
  const wednesdaysInMonth = categorizedMonthServices.filter(s => s.category === 'WEDNESDAY');
  const fridaysInMonth = categorizedMonthServices.filter(s => s.category === 'FRIDAY');
  const eventsInMonth = categorizedMonthServices.filter(s => s.category === 'EVENT');

  const totalSundayOpportunities = sundaysInMonth.length;
  const totalWednesdayOpportunities = wednesdaysInMonth.length;
  const totalFridayOpportunities = fridaysInMonth.length;
  const totalEventOpportunities = eventsInMonth.length;
  const totalMonthOpportunities = categorizedMonthServices.length;

  // Map member attendances for this month
  const memberMonthAttendances = new Map();
  monthAttendances.forEach(att => {
    if (!memberMonthAttendances.has(att.memberId)) {
      memberMonthAttendances.set(att.memberId, []);
    }
    memberMonthAttendances.get(att.memberId).push(att);
  });

  // Map M-1 count per member
  const memberPrevCount = new Map();
  prevMonthAttendances.forEach(att => {
    memberPrevCount.set(att.memberId, (memberPrevCount.get(att.memberId) || 0) + 1);
  });

  // Map M-2 count per member
  const memberTwoMonthsAgoCount = new Map();
  twoMonthsAgoAttendances.forEach(att => {
    memberTwoMonthsAgoCount.set(att.memberId, (memberTwoMonthsAgoCount.get(att.memberId) || 0) + 1);
  });
  const memberLatestFollowUp = new Map();
  pastoralFollowUpLogs.forEach(log => {
    const targetMemberId = log.entityId;
    if (targetMemberId && !memberLatestFollowUp.has(targetMemberId)) {
      memberLatestFollowUp.set(targetMemberId, {
        status: (log.metadata && log.metadata.status) || 'Follow-Up Required',
        note: (log.metadata && log.metadata.note) || '',
        updatedAt: log.createdAt,
        actorId: log.actorId
      });
    }
  });

  // 9. Build Individual Member Metrics
  const memberMetrics = targetMembers.map(member => {
    const atts = memberMonthAttendances.get(member.id) || [];
    const sunProfile = sundayProfiles.get(member.id) || createDefaultProfile('Sunday');
    const wedProfile = wednesdayProfiles.get(member.id) || createDefaultProfile('Wednesday');
    const friProfile = fridayProfiles.get(member.id) || createDefaultProfile('Friday');
    const ovProfile = overallProfiles.get(member.id) || createDefaultProfile('Overall');

    // Break down by service type in current month
    let sundayAttended = 0;
    let wednesdayAttended = 0;
    let fridayAttended = 0;
    let eventAttended = 0;

    atts.forEach(a => {
      const cat = classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '');
      if (cat === 'SUNDAY') sundayAttended++;
      else if (cat === 'WEDNESDAY') wednesdayAttended++;
      else if (cat === 'FRIDAY') fridayAttended++;
      else eventAttended++;
    });

    const totalAttended = atts.length;
    const totalMissed = Math.max(0, totalMonthOpportunities - totalAttended);

    // Independent percentages
    const sundayRate = totalSundayOpportunities > 0 ? Math.round((sundayAttended / totalSundayOpportunities) * 100) : 0;
    const wednesdayRate = totalWednesdayOpportunities > 0 ? Math.round((wednesdayAttended / totalWednesdayOpportunities) * 100) : 0;
    const fridayRate = totalFridayOpportunities > 0 ? Math.round((fridayAttended / totalFridayOpportunities) * 100) : 0;
    const eventRate = totalEventOpportunities > 0 ? Math.round((eventAttended / totalEventOpportunities) * 100) : 0;
    const overallRate = totalMonthOpportunities > 0 ? Math.round((totalAttended / totalMonthOpportunities) * 100) : 0;

    // Previous month attendance rate
    const prevAttended = memberPrevCount.get(member.id) || 0;
    const prevRate = prevMonthServicesCount > 0 ? Math.round((prevAttended / prevMonthServicesCount) * 100) : 0;

    // Two months ago attendance rate
    const twoMonthsAgoAttended = memberTwoMonthsAgoCount.get(member.id) || 0;
    const twoMonthsAgoRate = twoMonthsAgoServicesCount > 0 ? Math.round((twoMonthsAgoAttended / twoMonthsAgoServicesCount) * 100) : 0;

    const rateDelta = overallRate - prevRate;

    // Detect Rapid Multi-Month Decline
    const isRapidlyDeclining = (
      (twoMonthsAgoRate >= 50 && prevRate >= 40 && overallRate <= 25) ||
      (prevRate >= 50 && overallRate <= 20) ||
      (rateDelta <= -35 && prevRate >= 40)
    );

    // Check if new member (joined within last 45 days)
    const joinDate = new Date(member.createdAt);
    const isNewMember = (startOfMonth - joinDate) <= (45 * 24 * 3600 * 1000);

    // Calculate 0-100 Engagement Score
    const engagement = calculateEngagementScore({
      overallRate,
      sundayRate,
      currentSundayStreak: sunProfile.currentStreak,
      consecutiveSundaysMissed: sunProfile.consecutiveMissed,
      wednesdayCount: wednesdayAttended,
      fridayCount: fridayAttended,
      eventCount: eventAttended,
      rateDelta,
      isNewMember
    });

    // Determine Habit Profile Classification
    let habitProfile = 'MODERATE';
    let habitLabel = 'Occasional Attendee';
    let habitColor = '#b45309';

    if (overallRate >= 70 && (wednesdayAttended > 0 || fridayAttended > 0)) {
      habitProfile = 'ALL_ROUND_PILLAR';
      habitLabel = 'All-Round Pillar';
      habitColor = '#15803d';
    } else if (sundayRate >= 80) {
      habitProfile = 'SUNDAY_FAITHFUL';
      habitLabel = 'Sunday Faithful';
      habitColor = '#0284c7';
    } else if (wednesdayRate >= 50 && fridayRate >= 50) {
      habitProfile = 'MIDWEEK_DEVOTED';
      habitLabel = 'Midweek & Friday Devoted';
      habitColor = '#7c3aed';
    } else if (wednesdayRate >= 50) {
      habitProfile = 'WEDNESDAY_FAITHFUL';
      habitLabel = 'Wednesday Faithful';
      habitColor = '#8b5cf6';
    } else if (fridayRate >= 50) {
      habitProfile = 'FRIDAY_FAITHFUL';
      habitLabel = 'Friday Faithful';
      habitColor = '#ec4899';
    } else if (isRapidlyDeclining) {
      habitProfile = 'RAPIDLY_DECLINING';
      habitLabel = 'Rapidly Declining';
      habitColor = '#dc2626';
    } else if (totalAttended === 0) {
      habitProfile = 'ZERO_ATTENDANCE';
      habitLabel = 'Zero Attendance (Absent)';
      habitColor = '#475569';
    } else if (overallRate < 30) {
      habitProfile = 'FREQUENTLY_ABSENT';
      habitLabel = 'Frequently Absent';
      habitColor = '#ea580c';
    }

    const isVisitor = visitorMembers.some(v => v.id === member.id);

    // Pastoral Care Status
    let defaultStatus = 'In Good Standing';
    if (ovProfile.consecutiveMissed >= 3 && ovProfile.totalAttended > 0) {
      defaultStatus = 'Follow-Up Required';
    } else if (ovProfile.consecutiveMissed === 2 && ovProfile.totalAttended > 0) {
      defaultStatus = 'Concern (Missed 2)';
    } else if (ovProfile.consecutiveMissed === 1 && ovProfile.totalAttended > 0) {
      defaultStatus = 'Watch (Missed 1)';
    } else if (ovProfile.totalAttended === 0) {
      defaultStatus = isVisitor ? 'First-Timer Welcome' : 'First Outreach Needed';
    } else {
      defaultStatus = 'In Good Standing';
    }

    const followUp = memberLatestFollowUp.get(member.id) || {
      status: defaultStatus,
      note: '',
      updatedAt: null,
      isAutoAssigned: true
    };

    return {
      memberId: member.id,
      name: `${member.firstName} ${member.lastName}`,
      firstName: member.firstName,
      lastName: member.lastName,
      phone: member.phone || '',
      email: member.email || '',
      gender: member.gender || 'Not Specified',
      category: member.category || 'Adult',
      role: member.role || 'Member',
      photoUrl: member.photoUrl,
      createdAt: member.createdAt,
      isNewMember,
      isVisitor,

      // Sunday Specifics
      sunday: {
        attended: sundayAttended,
        available: totalSundayOpportunities,
        rate: sundayRate,
        currentStreak: sunProfile.currentStreak,
        longestStreak: sunProfile.longestStreak,
        consecutiveMissed: sunProfile.consecutiveMissed,
        totalAttended: sunProfile.totalAttended,
        totalSundaysExcused: sunProfile.totalExcused,
        lastAttendedDate: sunProfile.lastAttendedDate,
        streakStartDate: sunProfile.streakStartDate,
        alertStatus: sunProfile.alertStatus,
        alertLabel: sunProfile.alertLabel,
        alertColor: sunProfile.alertColor
      },

      // Wednesday Specifics
      wednesday: {
        attended: wednesdayAttended,
        available: totalWednesdayOpportunities,
        rate: wednesdayRate,
        currentStreak: wedProfile.currentStreak,
        longestStreak: wedProfile.longestStreak,
        consecutiveMissed: wedProfile.consecutiveMissed,
        totalAttended: wedProfile.totalAttended,
        lastAttendedDate: wedProfile.lastAttendedDate,
        streakStartDate: wedProfile.streakStartDate,
        alertStatus: wedProfile.alertStatus,
        alertLabel: wedProfile.alertLabel,
        alertColor: wedProfile.alertColor
      },

      // Friday Specifics
      friday: {
        attended: fridayAttended,
        available: totalFridayOpportunities,
        rate: fridayRate,
        currentStreak: friProfile.currentStreak,
        longestStreak: friProfile.longestStreak,
        consecutiveMissed: friProfile.consecutiveMissed,
        totalAttended: friProfile.totalAttended,
        lastAttendedDate: friProfile.lastAttendedDate,
        streakStartDate: friProfile.streakStartDate,
        alertStatus: friProfile.alertStatus,
        alertLabel: friProfile.alertLabel,
        alertColor: friProfile.alertColor
      },

      // Special Events
      event: {
        attended: eventAttended,
        available: totalEventOpportunities,
        rate: eventRate
      },

      // Overall
      overall: {
        attended: totalAttended,
        missed: totalMissed,
        available: totalMonthOpportunities,
        rate: overallRate,
        currentStreak: ovProfile.currentStreak,
        longestStreak: ovProfile.longestStreak,
        consecutiveMissed: ovProfile.consecutiveMissed,
        totalAttended: ovProfile.totalAttended,
        lastAttendedDate: ovProfile.lastAttendedDate,
        streakStartDate: ovProfile.streakStartDate,
        alertStatus: ovProfile.alertStatus,
        alertLabel: ovProfile.alertLabel,
        alertColor: ovProfile.alertColor,
        prevMonthRate: prevRate,
        twoMonthsAgoRate,
        rateDelta,
        isRapidlyDeclining
      },

      // Habit & Score
      habitProfile,
      habitLabel,
      habitColor,
      engagement,

      // Pastoral Care Status
      pastoralFollowUp: followUp
    };
  });

  // Filter if serviceTypeFilter is active
  let filteredMetrics = memberMetrics;
  if (serviceTypeFilter === 'SUNDAY') {
    filteredMetrics = memberMetrics.filter(m => m.sunday.attended > 0 || m.sunday.currentStreak > 0);
  } else if (serviceTypeFilter === 'WEDNESDAY') {
    filteredMetrics = memberMetrics.filter(m => m.wednesday.attended > 0 || m.wednesday.currentStreak > 0);
  } else if (serviceTypeFilter === 'FRIDAY') {
    filteredMetrics = memberMetrics.filter(m => m.friday.attended > 0 || m.friday.currentStreak > 0);
  } else if (serviceTypeFilter === 'EVENT') {
    filteredMetrics = memberMetrics.filter(m => m.event.attended > 0);
  }

  // Multi-Service Leaderboards
  // Sunday
  const currentSundayStreaks = [...memberMetrics].filter(m => m.sunday.currentStreak > 0).sort((a, b) => b.sunday.currentStreak - a.sunday.currentStreak).slice(0, 15);
  const longestSundayStreaks = [...memberMetrics].filter(m => m.sunday.longestStreak > 0).sort((a, b) => b.sunday.longestStreak - a.sunday.longestStreak).slice(0, 15);
  const sundayWatch = memberMetrics.filter(m => m.sunday.consecutiveMissed === 1 && m.sunday.totalAttended > 0);
  const sundayConcern = memberMetrics.filter(m => m.sunday.consecutiveMissed === 2 && m.sunday.totalAttended > 0);
  const sundayFollowUp = memberMetrics.filter(m => m.sunday.consecutiveMissed >= 3 && m.sunday.totalAttended > 0);
  const sundayFaithful = memberMetrics.filter(m => m.sunday.consecutiveMissed === 0 && m.sunday.totalAttended > 0);

  // Wednesday
  const currentWednesdayStreaks = [...memberMetrics].filter(m => m.wednesday.currentStreak > 0).sort((a, b) => b.wednesday.currentStreak - a.wednesday.currentStreak).slice(0, 15);
  const longestWednesdayStreaks = [...memberMetrics].filter(m => m.wednesday.longestStreak > 0).sort((a, b) => b.wednesday.longestStreak - a.wednesday.longestStreak).slice(0, 15);
  const wednesdayWatch = memberMetrics.filter(m => m.wednesday.consecutiveMissed === 1 && m.wednesday.totalAttended > 0);
  const wednesdayConcern = memberMetrics.filter(m => m.wednesday.consecutiveMissed === 2 && m.wednesday.totalAttended > 0);
  const wednesdayFollowUp = memberMetrics.filter(m => m.wednesday.consecutiveMissed >= 3 && m.wednesday.totalAttended > 0);
  const wednesdayFaithful = memberMetrics.filter(m => m.wednesday.consecutiveMissed === 0 && m.wednesday.totalAttended > 0);

  // Friday
  const currentFridayStreaks = [...memberMetrics].filter(m => m.friday.currentStreak > 0).sort((a, b) => b.friday.currentStreak - a.friday.currentStreak).slice(0, 15);
  const longestFridayStreaks = [...memberMetrics].filter(m => m.friday.longestStreak > 0).sort((a, b) => b.friday.longestStreak - a.friday.longestStreak).slice(0, 15);
  const fridayWatch = memberMetrics.filter(m => m.friday.consecutiveMissed === 1 && m.friday.totalAttended > 0);
  const fridayConcern = memberMetrics.filter(m => m.friday.consecutiveMissed === 2 && m.friday.totalAttended > 0);
  const fridayFollowUp = memberMetrics.filter(m => m.friday.consecutiveMissed >= 3 && m.friday.totalAttended > 0);
  const fridayFaithful = memberMetrics.filter(m => m.friday.consecutiveMissed === 0 && m.friday.totalAttended > 0);

  // Overall
  const currentOverallStreaks = [...memberMetrics].filter(m => m.overall.currentStreak > 0).sort((a, b) => b.overall.currentStreak - a.overall.currentStreak).slice(0, 15);
  const longestOverallStreaks = [...memberMetrics].filter(m => m.overall.longestStreak > 0).sort((a, b) => b.overall.longestStreak - a.overall.longestStreak).slice(0, 15);
  const overallWatch = memberMetrics.filter(m => m.overall.consecutiveMissed === 1 && m.overall.totalAttended > 0);
  const overallConcern = memberMetrics.filter(m => m.overall.consecutiveMissed === 2 && m.overall.totalAttended > 0);
  const overallFollowUp = memberMetrics.filter(m => m.overall.consecutiveMissed >= 3 && m.overall.totalAttended > 0);
  const overallFaithful = memberMetrics.filter(m => m.overall.consecutiveMissed === 0 && m.overall.totalAttended > 0);

  // Special Lists
  const rapidlyDecliningList = memberMetrics
    .filter(m => m.overall.isRapidlyDeclining || (m.overall.rateDelta <= -30 && m.overall.prevMonthRate >= 35))
    .sort((a, b) => a.overall.rateDelta - b.overall.rateDelta);

  const consistentList = [...memberMetrics]
    .filter(m => m.overall.rate >= 60 || m.sunday.rate >= 80 || m.wednesday.rate >= 70 || m.friday.rate >= 70)
    .sort((a, b) => b.engagement.score - a.engagement.score)
    .slice(0, 25);

  const zeroAttendanceList = memberMetrics.filter(m => m.overall.attended === 0);
  const newMemberList = memberMetrics.filter(m => m.isNewMember);

  // Summary KPI Totals
  const totalRegisteredMembers = allMembers.length;
  const totalRegularCount = regularMembers.length;
  const totalVisitorsCount = visitorMembers.length;
  const analyzedCount = targetMembers.length;

  const activeAttendeesThisMonth = memberMetrics.filter(m => m.overall.attended > 0).length;
  const monthlyParticipationRate = analyzedCount > 0
    ? Math.round((activeAttendeesThisMonth / analyzedCount) * 100)
    : 0;

  const totalPossibleAttendances = analyzedCount * totalMonthOpportunities;
  const actualAttendancesCount = monthAttendances.length;
  const overallAttendancePct = totalPossibleAttendances > 0
    ? Math.round((actualAttendancesCount / totalPossibleAttendances) * 100)
    : 0;

  // Service Averages
  const sundayAttendances = monthAttendances.filter(a => classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '') === 'SUNDAY');
  const wednesdayAttendances = monthAttendances.filter(a => classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '') === 'WEDNESDAY');
  const fridayAttendances = monthAttendances.filter(a => classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '') === 'FRIDAY');
  const eventAttendances = monthAttendances.filter(a => classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '') === 'EVENT');

  const sundayAvg = totalSundayOpportunities > 0 ? Math.round(sundayAttendances.length / totalSundayOpportunities) : 0;
  const wednesdayAvg = totalWednesdayOpportunities > 0 ? Math.round(wednesdayAttendances.length / totalWednesdayOpportunities) : 0;
  const fridayAvg = totalFridayOpportunities > 0 ? Math.round(fridayAttendances.length / totalFridayOpportunities) : 0;
  const eventAvg = totalEventOpportunities > 0 ? Math.round(eventAttendances.length / totalEventOpportunities) : 0;

  // Average Engagement Score
  const avgScore = memberMetrics.length > 0
    ? Math.round(memberMetrics.reduce((acc, m) => acc + m.engagement.score, 0) / memberMetrics.length)
    : 0;

  const periodLabel = new Date(Date.UTC(currentYear, currentMonth - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return {
    period: {
      year: currentYear,
      month: currentMonth,
      label: periodLabel,
      startDate: startOfMonth.toISOString().slice(0, 10),
      endDate: endOfMonth.toISOString().slice(0, 10)
    },
    summary: {
      totalRegisteredMembers,
      totalRegularCount,
      totalVisitorsCount,
      analyzedCount,
      attendeeTypeFilter: attendeeType,
      activeMembersThisMonth: activeAttendeesThisMonth,
      monthlyParticipationRate,
      totalServicesHeld: totalMonthOpportunities,
      totalCheckinsCount: actualAttendancesCount,
      overallAttendancePct,
      averageEngagementScore: avgScore,
      serviceBreakdown: {
        sunday: { servicesCount: totalSundayOpportunities, totalAttendance: sundayAttendances.length, average: sundayAvg },
        wednesday: { servicesCount: totalWednesdayOpportunities, totalAttendance: wednesdayAttendances.length, average: wednesdayAvg },
        friday: { servicesCount: totalFridayOpportunities, totalAttendance: fridayAttendances.length, average: fridayAvg },
        event: { servicesCount: totalEventOpportunities, totalAttendance: eventAttendances.length, average: eventAvg }
      },
      pastoralAlertCounts: {
        sundayFaithful: sundayFaithful.length,
        sundayWatch: sundayWatch.length,
        sundayConcern: sundayConcern.length,
        sundayFollowUpRequired: sundayFollowUp.length,

        wednesdayFaithful: wednesdayFaithful.length,
        wednesdayWatch: wednesdayWatch.length,
        wednesdayConcern: wednesdayConcern.length,
        wednesdayFollowUpRequired: wednesdayFollowUp.length,

        fridayFaithful: fridayFaithful.length,
        fridayWatch: fridayWatch.length,
        fridayConcern: fridayConcern.length,
        fridayFollowUpRequired: fridayFollowUp.length,

        overallFaithful: overallFaithful.length,
        overallWatch: overallWatch.length,
        overallConcern: overallConcern.length,
        overallFollowUpRequired: overallFollowUp.length,

        rapidlyDeclining: rapidlyDecliningList.length,
        zeroAttendance: zeroAttendanceList.length,
        newMembers: newMemberList.length
      }
    },
    leaderboards: {
      // Multi-service leaderboards
      sunday: {
        currentStreaks: currentSundayStreaks,
        longestStreaks: longestSundayStreaks,
        watch: sundayWatch,
        concern: sundayConcern,
        followUpRequired: sundayFollowUp,
        faithful: sundayFaithful
      },
      wednesday: {
        currentStreaks: currentWednesdayStreaks,
        longestStreaks: longestWednesdayStreaks,
        watch: wednesdayWatch,
        concern: wednesdayConcern,
        followUpRequired: wednesdayFollowUp,
        faithful: wednesdayFaithful
      },
      friday: {
        currentStreaks: currentFridayStreaks,
        longestStreaks: longestFridayStreaks,
        watch: fridayWatch,
        concern: fridayConcern,
        followUpRequired: fridayFollowUp,
        faithful: fridayFaithful
      },
      overall: {
        currentStreaks: currentOverallStreaks,
        longestStreaks: longestOverallStreaks,
        watch: overallWatch,
        concern: overallConcern,
        followUpRequired: overallFollowUp,
        faithful: overallFaithful
      },
      // Backward compatible top-level shortcuts
      currentSundayStreaks,
      longestSundayStreaks,
      consistentMembers: consistentList,
      sundayWatch,
      sundayConcern,
      sundayFollowUpRequired: sundayFollowUp,
      rapidlyDeclining: rapidlyDecliningList,
      zeroAttendance: zeroAttendanceList,
      newMembers: newMemberList
    },
    members: filteredMetrics
  };

  setCachedAnalytics(cacheKey, payload);
  return payload;
}

/**
 * 6 to 12 Month Attendance Trends for Visual Charts
 */
async function getAttendanceTrends({ months = 12, forceRefresh = false } = {}) {
  const cacheKey = `trends_${months}`;
  if (!forceRefresh) {
    const cached = getCachedAnalytics(cacheKey);
    if (cached) return cached;
  }

  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  // Fetch all services and all attendances across the multi-month window in 2 parallel queries
  const [allPeriodServices, allPeriodAttendances] = await Promise.all([
    prisma.service.findMany({
      where: { active: true, serviceDate: { gte: startDate, lte: endDate } },
      select: { id: true, serviceDate: true, serviceType: { select: { name: true } } }
    }),
    prisma.attendance.findMany({
      where: {
        service: { active: true, serviceDate: { gte: startDate, lte: endDate } },
        member: { active: true, deletedAt: null }
      },
      select: {
        id: true,
        memberId: true,
        service: { select: { serviceDate: true, serviceType: { select: { name: true } } } }
      }
    })
  ]);

  const trendPoints = [];

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;

    const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));

    const monthLabel = d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

    // In-memory filter (sub-millisecond)
    const monthSvcs = allPeriodServices.filter(s => {
      const dt = new Date(s.serviceDate);
      return dt >= start && dt <= end;
    });

    const monthAtts = allPeriodAttendances.filter(a => {
      const dt = new Date(a.service?.serviceDate);
      return dt >= start && dt <= end;
    });

    let sundayCheckins = 0;
    let wednesdayCheckins = 0;
    let fridayCheckins = 0;
    let eventCheckins = 0;

    monthAtts.forEach(a => {
      const cat = classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '');
      if (cat === 'SUNDAY') sundayCheckins++;
      else if (cat === 'WEDNESDAY') wednesdayCheckins++;
      else if (cat === 'FRIDAY') fridayCheckins++;
      else eventCheckins++;
    });

    const uniqueAttendees = new Set(monthAtts.map(a => a.memberId)).size;

    trendPoints.push({
      year: y,
      month: m,
      monthLabel,
      totalServices: monthSvcs.length,
      totalCheckins: monthAtts.length,
      uniqueAttendeesCount: uniqueAttendees,
      sundayCheckins,
      wednesdayCheckins,
      fridayCheckins,
      eventCheckins
    });
  }

  setCachedAnalytics(cacheKey, trendPoints);
  return trendPoints;
}

/**
 * Individual Attendee Attendance Dossier (Pastoral Deep Dive)
 */
async function getMemberAttendanceAnalytics(memberId) {
  // Fetch Member Details
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      role: true,
      category: true,
      photoUrl: true,
      createdAt: true
    }
  });
  if (!member) {
    throw new Error('Member not found');
  }

  // Fetch All Historical Services
  const allHistoricalServices = await prisma.service.findMany({
    where: { active: true },
    include: { serviceType: true },
    orderBy: { serviceDate: 'asc' }
  });

  const allSundayServices = [];
  const allWednesdayServices = [];
  const allFridayServices = [];

  allHistoricalServices.forEach(s => {
    const cat = classifyServiceCategory(s.serviceType?.name || '', s.name || '');
    if (cat === 'SUNDAY') allSundayServices.push(s);
    else if (cat === 'WEDNESDAY') allWednesdayServices.push(s);
    else if (cat === 'FRIDAY') allFridayServices.push(s);
  });

  // All member attendances across history
  const allMemberAttendances = await prisma.attendance.findMany({
    where: { memberId },
    include: {
      service: { include: { serviceType: true } }
    },
    orderBy: { checkedInAt: 'desc' }
  });

  // Excused Absences for Member
  const outOfTownRecords = await prisma.outOfTown.findMany({
    where: { memberId },
    select: { startsAt: true, endsAt: true, note: true }
  });
  const memberExcusedList = outOfTownRecords;

  const excusedMap = new Map();
  excusedMap.set(memberId, memberExcusedList);

  // Run streak algorithms for all four streams
  const allHistoricalAttendances = await prisma.attendance.findMany({
    where: { member: { active: true, deletedAt: null } },
    select: { id: true, memberId: true, serviceId: true, checkedInAt: true, method: true }
  });

  const sunProfile = calculateConsecutiveStreaks(allSundayServices, allHistoricalAttendances, excusedMap, [memberId], 'Sunday').get(memberId) || createDefaultProfile('Sunday');
  const wedProfile = calculateConsecutiveStreaks(allWednesdayServices, allHistoricalAttendances, excusedMap, [memberId], 'Wednesday').get(memberId) || createDefaultProfile('Wednesday');
  const friProfile = calculateConsecutiveStreaks(allFridayServices, allHistoricalAttendances, excusedMap, [memberId], 'Friday').get(memberId) || createDefaultProfile('Friday');
  const ovProfile = calculateConsecutiveStreaks(allHistoricalServices, allHistoricalAttendances, excusedMap, [memberId], 'Overall').get(memberId) || createDefaultProfile('Overall');

  // Cumulative service type check-in totals
  let sundayTotal = 0;
  let wednesdayTotal = 0;
  let fridayTotal = 0;
  let eventTotal = 0;

  allMemberAttendances.forEach(a => {
    const cat = classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.name || '');
    if (cat === 'SUNDAY') sundayTotal++;
    else if (cat === 'WEDNESDAY') wednesdayTotal++;
    else if (cat === 'FRIDAY') fridayTotal++;
    else eventTotal++;
  });

  // Total services held across history
  const totalServicesHeld = allHistoricalServices.length;
  const totalAttended = allMemberAttendances.length;
  const overallRate = totalServicesHeld > 0 ? Math.round((totalAttended / totalServicesHeld) * 100) : 0;

  // Month-by-month breakdown for past 12 months (in-memory services count)
  const monthlyHistory = [];
  const now = new Date();

  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));

    // Zero extra DB round-trips: filter from already retrieved allHistoricalServices
    const totalSvcs = allHistoricalServices.filter(s => {
      const dt = new Date(s.serviceDate);
      return dt >= start && dt <= end;
    }).length;

    const monthAtts = allMemberAttendances.filter(a => {
      const sDate = new Date(a.service?.serviceDate || a.checkedInAt);
      return sDate >= start && sDate <= end;
    });

    const attendedCount = monthAtts.length;
    const rate = totalSvcs > 0 ? Math.round((attendedCount / totalSvcs) * 100) : 0;

    monthlyHistory.push({
      year: y,
      month: m,
      monthLabel: d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      attended: attendedCount,
      totalServices: totalSvcs,
      rate,
      sundayCount: monthAtts.filter(a => classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '') === 'SUNDAY').length,
      wednesdayCount: monthAtts.filter(a => classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '') === 'WEDNESDAY').length,
      fridayCount: monthAtts.filter(a => classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '') === 'FRIDAY').length
    });
  }

  // Recent 15 check-ins
  const recentCheckins = allMemberAttendances.slice(0, 15).map(a => ({
    id: a.id,
    serviceDate: a.service?.serviceDate ? new Date(a.service.serviceDate).toISOString().slice(0, 10) : 'N/A',
    serviceName: a.service?.serviceType?.name || 'Service',
    checkedInAt: a.checkedInAt,
    time: new Date(a.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    method: a.method
  }));

  // Pastoral Follow-Up logs for this member
  const followUpLogs = await prisma.auditLog.findMany({
    where: { action: 'PASTORAL_FOLLOW_UP', entityId: member.id },
    orderBy: { createdAt: 'desc' },
    take: 20
  });

  let defaultDossierStatus = 'In Good Standing';
  if (ovProfile.consecutiveMissed >= 3 && ovProfile.totalAttended > 0) {
    defaultDossierStatus = 'Follow-Up Required';
  } else if (ovProfile.consecutiveMissed === 2 && ovProfile.totalAttended > 0) {
    defaultDossierStatus = 'Concern (Missed 2)';
  } else if (ovProfile.consecutiveMissed === 1 && ovProfile.totalAttended > 0) {
    defaultDossierStatus = 'Watch (Missed 1)';
  } else if (ovProfile.totalAttended === 0) {
    defaultDossierStatus = (member.role || '').toLowerCase().includes('visitor') ? 'First-Timer Welcome' : 'First Outreach Needed';
  }

  const latestFollowUp = followUpLogs[0] ? {
    status: (followUpLogs[0].metadata && followUpLogs[0].metadata.status) || 'Follow-Up Required',
    note: (followUpLogs[0].metadata && followUpLogs[0].metadata.note) || '',
    updatedAt: followUpLogs[0].createdAt
  } : {
    status: defaultDossierStatus,
    note: '',
    updatedAt: null,
    isAutoAssigned: true
  };

  return {
    member: {
      id: member.id,
      name: `${member.firstName} ${member.lastName}`,
      firstName: member.firstName,
      lastName: member.lastName,
      phone: member.phone || '',
      email: member.email || '',
      gender: member.gender || 'Not Specified',
      category: member.category || 'Adult',
      role: member.role || 'Member',
      photoUrl: member.photoUrl,
      createdAt: member.createdAt
    },
    sunday: sunProfile,
    wednesday: wedProfile,
    friday: friProfile,
    overall: ovProfile,
    lifetime: {
      totalAttended,
      totalServicesHeld,
      overallRate,
      byCategory: {
        sunday: sundayTotal,
        wednesday: wednesdayTotal,
        friday: fridayTotal,
        event: eventTotal
      }
    },
    monthlyHistory,
    recentCheckins,
    pastoralFollowUp: latestFollowUp,
    followUpHistory: followUpLogs.map(l => ({
      id: l.id,
      status: (l.metadata && l.metadata.status) || 'Follow-Up Required',
      note: (l.metadata && l.metadata.note) || '',
      createdAt: l.createdAt,
      actorName: (l.metadata && l.metadata.actorName) || 'Pastor / Admin'
    }))
  };
}

/**
 * Log Pastoral Follow-Up Action & Note
 */
async function logPastoralFollowUp({ memberId, status, note = '', actorId = null, actorName = 'Admin' } = {}) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new Error('Member not found');

  const log = await prisma.auditLog.create({
    data: {
      action: 'PASTORAL_FOLLOW_UP',
      entity: 'Member',
      entityId: memberId,
      actorId,
      metadata: {
        status,
        note,
        actorName,
        memberName: `${member.firstName} ${member.lastName}`,
        loggedAt: new Date().toISOString()
      }
    }
  });

  return { success: true, logId: log.id, status, note, loggedAt: log.createdAt };
}

/**
 * Snapshot & Archive Final Monthly Attendance Report
 */
async function saveMonthlyReportSnapshot({ year, month, generatedBy = 'Admin' } = {}) {
  const reportData = await getMonthlyAttendanceAnalytics({ year, month, serviceTypeFilter: 'ALL', attendeeType: 'ALL' });

  const snapshotKey = `MONTHLY_ATTENDANCE_${reportData.period.year}_${String(reportData.period.month).padStart(2, '0')}`;

  const existing = await prisma.auditLog.findFirst({
    where: { action: 'MONTHLY_REPORT_ARCHIVE', entity: snapshotKey }
  });

  if (existing) {
    await prisma.auditLog.update({
      where: { id: existing.id },
      data: {
        metadata: {
          ...reportData,
          archivedAt: new Date().toISOString(),
          generatedBy,
          version: ((existing.metadata && existing.metadata.version) || 1) + 1
        }
      }
    });
    return { success: true, updated: true, key: snapshotKey, period: reportData.period };
  }

  await prisma.auditLog.create({
    data: {
      action: 'MONTHLY_REPORT_ARCHIVE',
      entity: snapshotKey,
      metadata: {
        ...reportData,
        archivedAt: new Date().toISOString(),
        generatedBy,
        version: 1
      }
    }
  });

  return { success: true, created: true, key: snapshotKey, period: reportData.period };
}

/**
 * Fetch List of Saved Monthly Report Snapshots
 */
async function listSavedMonthlyReports() {
  const logs = await prisma.auditLog.findMany({
    where: { action: 'MONTHLY_REPORT_ARCHIVE' },
    orderBy: { createdAt: 'desc' }
  });

  return logs.map(l => ({
    id: l.id,
    key: l.entity,
    period: (l.metadata && l.metadata.period) || {},
    summary: (l.metadata && l.metadata.summary) || {},
    archivedAt: (l.metadata && l.metadata.archivedAt) || l.createdAt,
    generatedBy: (l.metadata && l.metadata.generatedBy) || 'System'
  }));
}

module.exports = {
  classifyServiceCategory,
  calculateConsecutiveStreaks,
  calculateSundayConsecutiveStreaks,
  calculateEngagementScore,
  getMonthlyAttendanceAnalytics,
  getAttendanceTrends,
  getMemberAttendanceAnalytics,
  logPastoralFollowUp,
  saveMonthlyReportSnapshot,
  listSavedMonthlyReports,
  invalidateAnalyticsCache
};
