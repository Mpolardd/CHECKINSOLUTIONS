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
 * 🔴 Mandatory Consecutive Sunday Attendance Engine
 *
 * Evaluates all Sunday services held across church history chronologically.
 * Tracks continuous Sunday streaks across calendar months and years without monthly resets.
 * Preserves streaks through excused absences.
 *
 * @param {Array} allSundayServices Chronologically ordered Sunday services (oldest to newest)
 * @param {Array} allAttendances All attendance records across church history
 * @param {Map} excusedMap Map of memberId -> Array of excused absence ranges or dates
 * @returns {Map} memberId -> Sunday streak profile
 */
function calculateSundayConsecutiveStreaks(allSundayServices = [], allAttendances = [], excusedMap = new Map(), targetMemberIds = []) {
  const sundayProfiles = new Map();

  // Sort Sunday services chronologically (oldest to newest)
  const sortedSundays = [...allSundayServices].sort((a, b) => {
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

  // Also collect members who have an excused record
  for (const [mId] of excusedMap) {
    allMemberIds.add(mId);
  }

  // Evaluate each member's Sunday journey
  for (const memberId of allMemberIds) {
    let currentStreak = 0;
    let longestStreak = 0;
    let runningStreak = 0;
    let consecutiveMissed = 0;
    let totalSundaysAttended = 0;
    let totalSundaysMissed = 0;
    let totalSundaysExcused = 0;
    let lastSundayAttendedDate = null;
    let streakStartDate = null;
    let currentStreakStartedAt = null;

    const memberExcusedRanges = excusedMap.get(memberId) || [];

    // Iterate through each Sunday service chronologically
    for (let i = 0; i < sortedSundays.length; i++) {
      const svc = sortedSundays[i];
      const svcDate = new Date(svc.serviceDate || svc.startsAt);
      const isAttended = attendanceByServiceId.get(svc.id)?.has(memberId) || false;

      // Check if this date falls within an excused absence range
      const isExcused = !isAttended && memberExcusedRanges.some(range => {
        const start = new Date(range.startsAt || range.startDate);
        const end = new Date(range.endsAt || range.endDate || range.startsAt);
        end.setHours(23, 59, 59, 999);
        return svcDate >= start && svcDate <= end;
      });

      if (isAttended) {
        totalSundaysAttended++;
        consecutiveMissed = 0;
        if (runningStreak === 0) {
          currentStreakStartedAt = svcDate.toISOString().slice(0, 10);
        }
        runningStreak++;
        if (runningStreak > longestStreak) {
          longestStreak = runningStreak;
        }
        lastSundayAttendedDate = svcDate.toISOString().slice(0, 10);
      } else if (isExcused) {
        // Excused: Preserves streak (neither incremented nor reset to zero), does not increment consecutive missed
        totalSundaysExcused++;
      } else {
        // Unexcused Miss: Breaks current streak!
        totalSundaysMissed++;
        runningStreak = 0;
        currentStreakStartedAt = null;
        consecutiveMissed++;
      }
    }

    currentStreak = runningStreak;
    streakStartDate = currentStreakStartedAt;

    // Determine Progressive Sunday Pastoral Alert Tier
    let sundayAlertStatus = 'SUNDAY_FAITHFUL'; // 🟢
    let alertLabel = 'Sunday Faithful';
    let alertColor = '#137333'; // green

    if (consecutiveMissed >= 8) {
      sundayAlertStatus = 'INACTIVE'; // ⚫
      alertLabel = 'Inactive (Prolonged Absence)';
      alertColor = '#475569';
    } else if (consecutiveMissed >= 3) {
      sundayAlertStatus = 'FOLLOW_UP_REQUIRED'; // 🔴
      alertLabel = `Pastoral Follow-Up Required (${consecutiveMissed} Missed)`;
      alertColor = '#dc2626';
    } else if (consecutiveMissed === 2) {
      sundayAlertStatus = 'SUNDAY_CONCERN'; // 🟠
      alertLabel = 'Sunday Concern (2 Missed)';
      alertColor = '#ea580c';
    } else if (consecutiveMissed === 1) {
      sundayAlertStatus = 'SUNDAY_WATCH'; // 🟡
      alertLabel = 'Sunday Watch (1 Missed)';
      alertColor = '#d97706';
    } else {
      sundayAlertStatus = 'SUNDAY_FAITHFUL'; // 🟢
      alertLabel = currentStreak >= 4 ? `Sunday Faithful (🔥 ${currentStreak} Streak)` : 'Sunday Faithful';
      alertColor = '#137333';
    }

    const totalSundayOpportunities = sortedSundays.length;
    const sundayAttendancePct = totalSundayOpportunities > 0
      ? Math.round((totalSundaysAttended / totalSundayOpportunities) * 100)
      : 0;

    sundayProfiles.set(memberId, {
      memberId,
      currentSundayStreak: currentStreak,
      longestSundayStreak: longestStreak,
      consecutiveSundaysMissed: consecutiveMissed,
      totalSundaysAttended,
      totalSundaysMissed,
      totalSundaysExcused,
      totalSundayOpportunities,
      sundayAttendancePct,
      lastSundayAttendedDate,
      streakStartDate,
      sundayAlertStatus,
      alertLabel,
      alertColor
    });
  }

  return sundayProfiles;
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

  // 2. Sunday fidelity (0-30)
  score += Math.round((Math.min(100, sundayRate) / 100) * 20);
  if (currentSundayStreak >= 4) score += 10;
  else if (currentSundayStreak >= 2) score += 5;

  // Penalize consecutive missed Sundays
  if (consecutiveSundaysMissed >= 3) score -= 15;
  else if (consecutiveSundaysMissed === 2) score -= 8;
  else if (consecutiveSundaysMissed === 1) score -= 3;

  // 3. Midweek & Event diversity (0-20)
  const serviceDiversity = (wednesdayCount > 0 ? 1 : 0) + (fridayCount > 0 ? 1 : 0) + (eventCount > 0 ? 1 : 0);
  if (serviceDiversity >= 2) score += 20;
  else if (serviceDiversity === 1) score += 10;

  // 4. Recency & Trajectory (0-15)
  if (rateDelta >= 15) score += 15;
  else if (rateDelta >= 0) score += 10;
  else if (rateDelta >= -20) score += 5;
  if (rateDelta <= -35) score -= 10;

  if (isNewMember) {
    score = Math.max(score, Math.round(overallRate * 0.8));
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

/**
 * Main Monthly Attendance Analytics Engine
 */
async function getMonthlyAttendanceAnalytics({ year, month, serviceTypeFilter = 'ALL' } = {}) {
  const currentYear = year ? parseInt(year, 10) : new Date().getFullYear();
  const currentMonth = month ? parseInt(month, 10) : new Date().getMonth() + 1; // 1-indexed

  // Month date range (UTC boundaries)
  const startOfMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1, 0, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(currentYear, currentMonth, 0, 23, 59, 59, 999));

  // Previous Month (M-1)
  const prevMonthDate = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
  const startOfPrevMonth = new Date(Date.UTC(prevMonthDate.getUTCFullYear(), prevMonthDate.getUTCMonth(), 1, 0, 0, 0, 0));
  const endOfPrevMonth = new Date(Date.UTC(prevMonthDate.getUTCFullYear(), prevMonthDate.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  // Two Months Ago (M-2) for 3-month trajectory detection
  const twoMonthsAgoDate = new Date(Date.UTC(currentYear, currentMonth - 3, 1));
  const startOfTwoMonthsAgo = new Date(Date.UTC(twoMonthsAgoDate.getUTCFullYear(), twoMonthsAgoDate.getUTCMonth(), 1, 0, 0, 0, 0));
  const endOfTwoMonthsAgo = new Date(Date.UTC(twoMonthsAgoDate.getUTCFullYear(), twoMonthsAgoDate.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  // 1. Fetch All Active Registered Members (excluding soft-deleted)
  const allMembers = await prisma.member.findMany({
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
  });

  // Separate regular church members vs visitors
  const regularMembers = allMembers.filter(m => {
    const role = (m.role || '').toLowerCase();
    const cat = (m.category || '').toLowerCase();
    return !role.includes('visitor') && !role.includes('guest') && !cat.includes('visitor') && !cat.includes('guest');
  });
  const visitorMembers = allMembers.filter(m => !regularMembers.includes(m));

  // 2. Fetch All Services Held in Month
  const monthServices = await prisma.service.findMany({
    where: {
      active: true,
      serviceDate: { gte: startOfMonth, lte: endOfMonth }
    },
    include: {
      serviceType: true,
      _count: { select: { attendance: true } }
    },
    orderBy: { serviceDate: 'asc' }
  });

  // 3. Fetch All Sunday Services Held in Church History for Consecutive Sunday Streak Engine
  const allSundayServices = await prisma.service.findMany({
    where: {
      active: true,
      OR: [
        { serviceType: { name: { contains: 'Sunday', mode: 'insensitive' } } },
        { serviceType: { name: { contains: 'Family', mode: 'insensitive' } } },
        { serviceType: { dayOfWeek: 0 } }
      ]
    },
    include: { serviceType: true },
    orderBy: { serviceDate: 'asc' }
  });

  // 4. Fetch All Attendance Records across History for Streak Calculations
  const allHistoricalAttendances = await prisma.attendance.findMany({
    where: { member: { active: true, deletedAt: null } },
    select: { id: true, memberId: true, serviceId: true, checkedInAt: true, method: true }
  });

  // 5. Fetch OutOfTown / Excused Absences
  const outOfTownRecords = await prisma.outOfTown.findMany({
    select: { memberId: true, startsAt: true, endsAt: true, note: true }
  });
  const excusedMap = new Map();
  outOfTownRecords.forEach(rec => {
    if (!excusedMap.has(rec.memberId)) excusedMap.set(rec.memberId, []);
    excusedMap.get(rec.memberId).push(rec);
  });

  // 🔴 Run Mandatory Sunday Consecutive Attendance Engine
  const targetMemberIds = regularMembers.map(m => m.id);
  const sundayProfiles = calculateSundayConsecutiveStreaks(allSundayServices, allHistoricalAttendances, excusedMap, targetMemberIds);

  // 6. Filter Month Services by Service Category
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

  // 7. Fetch Attendance Records for this Month, M-1, and M-2
  const monthAttendances = await prisma.attendance.findMany({
    where: {
      service: { serviceDate: { gte: startOfMonth, lte: endOfMonth }, active: true },
      member: { active: true, deletedAt: null }
    },
    include: {
      service: { include: { serviceType: true } }
    }
  });

  const prevMonthAttendances = await prisma.attendance.findMany({
    where: {
      service: { serviceDate: { gte: startOfPrevMonth, lte: endOfPrevMonth }, active: true },
      member: { active: true, deletedAt: null }
    },
    select: { memberId: true, serviceId: true }
  });

  const prevMonthServicesCount = await prisma.service.count({
    where: { serviceDate: { gte: startOfPrevMonth, lte: endOfPrevMonth }, active: true }
  });

  const twoMonthsAgoAttendances = await prisma.attendance.findMany({
    where: {
      service: { serviceDate: { gte: startOfTwoMonthsAgo, lte: endOfTwoMonthsAgo }, active: true },
      member: { active: true, deletedAt: null }
    },
    select: { memberId: true, serviceId: true }
  });

  const twoMonthsAgoServicesCount = await prisma.service.count({
    where: { serviceDate: { gte: startOfTwoMonthsAgo, lte: endOfTwoMonthsAgo }, active: true }
  });

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

  // 8. Fetch Pastoral Follow-Up History from AuditLog
  const pastoralFollowUpLogs = await prisma.auditLog.findMany({
    where: { action: 'PASTORAL_FOLLOW_UP' },
    orderBy: { createdAt: 'desc' },
    take: 300
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
  const memberMetrics = regularMembers.map(member => {
    const atts = memberMonthAttendances.get(member.id) || [];
    const sunProfile = sundayProfiles.get(member.id) || {
      currentSundayStreak: 0,
      longestSundayStreak: 0,
      consecutiveSundaysMissed: 0,
      totalSundaysAttended: 0,
      totalSundaysMissed: 0,
      totalSundaysExcused: 0,
      sundayAttendancePct: 0,
      lastSundayAttendedDate: null,
      streakStartDate: null,
      sundayAlertStatus: 'SUNDAY_WATCH',
      alertLabel: 'Sunday Watch',
      alertColor: '#d97706'
    };

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
      currentSundayStreak: sunProfile.currentSundayStreak,
      consecutiveSundaysMissed: sunProfile.consecutiveSundaysMissed,
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

    if (overallRate >= 75 && (wednesdayAttended > 0 || fridayAttended > 0)) {
      habitProfile = 'ALL_ROUND_PILLAR';
      habitLabel = 'All-Round Pillar';
      habitColor = '#15803d'; // dark green
    } else if (sundayRate >= 80) {
      habitProfile = 'SUNDAY_FAITHFUL';
      habitLabel = 'Sunday Faithful';
      habitColor = '#0284c7'; // blue
    } else if ((wednesdayRate >= 60 || fridayRate >= 60) && sundayRate < 50) {
      habitProfile = 'MIDWEEK_DEVOTED';
      habitLabel = 'Midweek Devoted';
      habitColor = '#7c3aed'; // purple
    } else if (isRapidlyDeclining) {
      habitProfile = 'RAPIDLY_DECLINING';
      habitLabel = 'Rapidly Declining';
      habitColor = '#dc2626'; // red
    } else if (totalAttended === 0) {
      habitProfile = 'ZERO_ATTENDANCE';
      habitLabel = 'Zero Attendance (Absent)';
      habitColor = '#475569'; // gray
    } else if (overallRate < 30) {
      habitProfile = 'FREQUENTLY_ABSENT';
      habitLabel = 'Frequently Absent';
      habitColor = '#ea580c'; // orange
    }

    // Pastoral Care Status
    const followUp = memberLatestFollowUp.get(member.id) || {
      status: sunProfile.consecutiveSundaysMissed >= 3 ? 'Follow-Up Required' : 'None',
      note: '',
      updatedAt: null
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

      // Sunday Specifics (🔴 Mandatory Rule)
      sunday: {
        attended: sundayAttended,
        available: totalSundayOpportunities,
        rate: sundayRate,
        currentStreak: sunProfile.currentSundayStreak,
        longestStreak: sunProfile.longestSundayStreak,
        consecutiveMissed: sunProfile.consecutiveSundaysMissed,
        totalSundaysExcused: sunProfile.totalSundaysExcused,
        lastAttendedDate: sunProfile.lastSundayAttendedDate,
        streakStartDate: sunProfile.streakStartDate,
        alertStatus: sunProfile.sundayAlertStatus,
        alertLabel: sunProfile.alertLabel,
        alertColor: sunProfile.alertColor
      },

      // Midweek & Events
      wednesday: { attended: wednesdayAttended, available: totalWednesdayOpportunities, rate: wednesdayRate },
      friday: { attended: fridayAttended, available: totalFridayOpportunities, rate: fridayRate },
      event: { attended: eventAttended, available: totalEventOpportunities, rate: eventRate },

      // Overall
      overall: {
        attended: totalAttended,
        missed: totalMissed,
        available: totalMonthOpportunities,
        rate: overallRate,
        prevMonthRate: prevRate,
        twoMonthsAgoRate: twoMonthsAgoRate,
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
    filteredMetrics = memberMetrics.filter(m => m.wednesday.attended > 0);
  } else if (serviceTypeFilter === 'FRIDAY') {
    filteredMetrics = memberMetrics.filter(m => m.friday.attended > 0);
  } else if (serviceTypeFilter === 'EVENT') {
    filteredMetrics = memberMetrics.filter(m => m.event.attended > 0);
  }

  // Curate Pastoral Lists & Honor Rolls
  // 1. Current Sunday Streak Leaderboard
  const currentSundayStreakLeaderboard = [...memberMetrics]
    .filter(m => m.sunday.currentStreak > 0)
    .sort((a, b) => b.sunday.currentStreak - a.sunday.currentStreak)
    .slice(0, 15);

  // 2. Longest Sunday Streak Hall of Fame
  const longestSundayStreakLeaderboard = [...memberMetrics]
    .filter(m => m.sunday.longestStreak > 0)
    .sort((a, b) => b.sunday.longestStreak - a.sunday.longestStreak)
    .slice(0, 15);

  // 3. Sunday Watch List (Missed 1 Sunday)
  const sundayWatchList = memberMetrics.filter(m => m.sunday.consecutiveMissed === 1);

  // 4. Sunday Concern List (Missed 2 Consecutive Sundays)
  const sundayConcernList = memberMetrics.filter(m => m.sunday.consecutiveMissed === 2);

  // 5. Sunday Pastoral Follow-Up Required List (Missed 3+ Consecutive Sundays)
  const sundayFollowUpRequiredList = memberMetrics.filter(m => m.sunday.consecutiveMissed >= 3);

  // 6. Rapidly Declining Attendance List
  const rapidlyDecliningList = memberMetrics
    .filter(m => m.overall.isRapidlyDeclining || (m.overall.rateDelta <= -30 && m.overall.prevMonthRate >= 35))
    .sort((a, b) => a.overall.rateDelta - b.overall.rateDelta);

  // 7. All-Round Pillars / Most Consistent Overall
  const consistentList = [...memberMetrics]
    .filter(m => m.overall.rate >= 70 || m.sunday.rate >= 85)
    .sort((a, b) => b.engagement.score - a.engagement.score)
    .slice(0, 20);

  // 8. Zero Attendance / Inactive List
  const zeroAttendanceList = memberMetrics.filter(m => m.overall.attended === 0);

  // 9. New Members Retention Watch
  const newMemberList = memberMetrics.filter(m => m.isNewMember);

  // 10. Summary KPI Totals
  const totalRegisteredMembers = regularMembers.length;
  const totalVisitorsCount = visitorMembers.length;
  const activeMembersThisMonth = memberMetrics.filter(m => m.overall.attended > 0).length;
  const monthlyParticipationRate = totalRegisteredMembers > 0
    ? Math.round((activeMembersThisMonth / totalRegisteredMembers) * 100)
    : 0;

  const totalPossibleAttendances = totalRegisteredMembers * totalMonthOpportunities;
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
      totalVisitorsCount,
      activeMembersThisMonth,
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
        sundayWatch: sundayWatchList.length,
        sundayConcern: sundayConcernList.length,
        sundayFollowUpRequired: sundayFollowUpRequiredList.length,
        rapidlyDeclining: rapidlyDecliningList.length,
        zeroAttendance: zeroAttendanceList.length,
        newMembers: newMemberList.length
      }
    },
    leaderboards: {
      currentSundayStreaks: currentSundayStreakLeaderboard,
      longestSundayStreaks: longestSundayStreakLeaderboard,
      consistentMembers: consistentList,
      sundayWatch: sundayWatchList,
      sundayConcern: sundayConcernList,
      sundayFollowUpRequired: sundayFollowUpRequiredList,
      rapidlyDeclining: rapidlyDecliningList,
      zeroAttendance: zeroAttendanceList,
      newMembers: newMemberList
    },
    members: filteredMetrics
  };
}

/**
 * 6 to 12 Month Attendance Trends for Visual Charts
 */
async function getAttendanceTrends({ months = 12 } = {}) {
  const trendPoints = [];
  const now = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;

    const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));

    const monthLabel = d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

    // Fetch services for this month
    const services = await prisma.service.findMany({
      where: { active: true, serviceDate: { gte: start, lte: end } },
      include: { serviceType: true }
    });

    const attendances = await prisma.attendance.findMany({
      where: { service: { serviceDate: { gte: start, lte: end }, active: true } },
      include: { service: { include: { serviceType: true } } }
    });

    let sundayCount = 0;
    let wednesdayCount = 0;
    let fridayCount = 0;
    let eventCount = 0;
    const uniqueAttendees = new Set();

    attendances.forEach(a => {
      uniqueAttendees.add(a.memberId);
      const cat = classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '');
      if (cat === 'SUNDAY') sundayCount++;
      else if (cat === 'WEDNESDAY') wednesdayCount++;
      else if (cat === 'FRIDAY') fridayCount++;
      else eventCount++;
    });

    trendPoints.push({
      year: y,
      month: m,
      monthLabel,
      totalServices: services.length,
      totalCheckins: attendances.length,
      uniqueAttendeesCount: uniqueAttendees.size,
      sundayCheckins: sundayCount,
      wednesdayCheckins: wednesdayCount,
      fridayCheckins: fridayCount,
      eventCheckins: eventCount
    });
  }

  return trendPoints;
}

/**
 * Individual Member Attendance Dossier
 */
async function getMemberAttendanceAnalytics(memberId) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: {
      outOfTown: true
    }
  });
  if (!member) {
    throw new Error('Member not found');
  }

  // All Sunday services across history
  const allSundayServices = await prisma.service.findMany({
    where: {
      active: true,
      OR: [
        { serviceType: { name: { contains: 'Sunday', mode: 'insensitive' } } },
        { serviceType: { name: { contains: 'Family', mode: 'insensitive' } } },
        { serviceType: { dayOfWeek: 0 } }
      ]
    },
    include: { serviceType: true },
    orderBy: { serviceDate: 'asc' }
  });

  // All member attendances across history
  const allMemberAttendances = await prisma.attendance.findMany({
    where: { memberId },
    include: {
      service: { include: { serviceType: true } }
    },
    orderBy: { checkedInAt: 'desc' }
  });

  // Calculate Sunday streak for this specific member
  const allHistoricalAttendances = await prisma.attendance.findMany({
    where: { member: { active: true, deletedAt: null } },
    select: { id: true, memberId: true, serviceId: true, checkedInAt: true, method: true }
  });

  const excusedMap = new Map();
  if (member.outOfTown) {
    excusedMap.set(member.id, [member.outOfTown]);
  }

  const sundayProfiles = calculateSundayConsecutiveStreaks(allSundayServices, allHistoricalAttendances, excusedMap);
  const sunProfile = sundayProfiles.get(member.id) || {
    currentSundayStreak: 0,
    longestSundayStreak: 0,
    consecutiveSundaysMissed: 0,
    totalSundaysAttended: 0,
    totalSundaysMissed: 0,
    totalSundaysExcused: 0,
    sundayAttendancePct: 0,
    lastSundayAttendedDate: null,
    streakStartDate: null,
    sundayAlertStatus: 'SUNDAY_WATCH',
    alertLabel: 'Sunday Watch',
    alertColor: '#d97706'
  };

  // Lifetime counts by service category
  let sundayTotal = 0;
  let wednesdayTotal = 0;
  let fridayTotal = 0;
  let eventTotal = 0;

  allMemberAttendances.forEach(a => {
    const cat = classifyServiceCategory(a.service?.serviceType?.name || '', a.service?.serviceType?.name || '');
    if (cat === 'SUNDAY') sundayTotal++;
    else if (cat === 'WEDNESDAY') wednesdayTotal++;
    else if (cat === 'FRIDAY') fridayTotal++;
    else eventTotal++;
  });

  // Total services held across history
  const totalServicesHeld = await prisma.service.count({ where: { active: true } });
  const totalAttended = allMemberAttendances.length;
  const overallRate = totalServicesHeld > 0 ? Math.round((totalAttended / totalServicesHeld) * 100) : 0;

  // Month-by-month breakdown for past 12 months
  const monthlyHistory = [];
  const now = new Date();

  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));

    const totalSvcs = await prisma.service.count({
      where: { active: true, serviceDate: { gte: start, lte: end } }
    });

    const attendedCount = allMemberAttendances.filter(a => {
      const sDate = new Date(a.service?.serviceDate || a.checkedInAt);
      return sDate >= start && sDate <= end;
    }).length;

    const rate = totalSvcs > 0 ? Math.round((attendedCount / totalSvcs) * 100) : 0;

    monthlyHistory.push({
      year: y,
      month: m,
      monthLabel: d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      attended: attendedCount,
      totalServices: totalSvcs,
      rate
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

  const latestFollowUp = followUpLogs[0] ? {
    status: (followUpLogs[0].metadata && followUpLogs[0].metadata.status) || 'Follow-Up Required',
    note: (followUpLogs[0].metadata && followUpLogs[0].metadata.note) || '',
    updatedAt: followUpLogs[0].createdAt
  } : {
    status: sunProfile.consecutiveSundaysMissed >= 3 ? 'Follow-Up Required' : 'None',
    note: '',
    updatedAt: null
  };

  return {
    member: {
      id: member.id,
      name: `${member.firstName} ${member.lastName}`,
      phone: member.phone,
      email: member.email,
      gender: member.gender,
      category: member.category,
      role: member.role,
      photoUrl: member.photoUrl,
      createdAt: member.createdAt
    },
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
    sunday: sunProfile,
    monthlyHistory,
    recentCheckins,
    pastoralFollowUp: latestFollowUp,
    followUpHistory: followUpLogs.map(l => ({
      id: l.id,
      status: l.metadata?.status,
      note: l.metadata?.note,
      createdAt: l.createdAt,
      actorId: l.actorId
    }))
  };
}

/**
 * Log Pastoral Follow-Up Note & Status
 */
async function logPastoralFollowUp({ memberId, status, note = '', actorId = null, actorName = 'Admin / Pastor' }) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new Error('Member not found');

  const log = await prisma.auditLog.create({
    data: {
      actorId,
      action: 'PASTORAL_FOLLOW_UP',
      entity: 'MEMBER_PASTORAL_CARE',
      entityId: memberId,
      metadata: {
        status,
        note,
        actorName,
        memberName: `${member.firstName} ${member.lastName}`,
        loggedAt: new Date().toISOString()
      }
    }
  });

  return { success: true, log };
}

/**
 * Save / Archive Finalized Monthly Report Snapshot
 */
async function saveMonthlyReportSnapshot({ year, month, generatedBy = 'Admin' } = {}) {
  const analytics = await getMonthlyAttendanceAnalytics({ year, month });
  const entityId = `${analytics.period.year}-${String(analytics.period.month).padStart(2, '0')}`;

  const log = await prisma.auditLog.create({
    data: {
      actorId: null,
      action: 'MONTHLY_ATTENDANCE_REPORT',
      entity: 'ATTENDANCE_REPORT_ARCHIVE',
      entityId,
      metadata: {
        periodLabel: analytics.period.label,
        summary: analytics.summary,
        leaderboards: analytics.leaderboards,
        generatedBy,
        generatedAt: new Date().toISOString()
      }
    }
  });

  return { success: true, entityId, log };
}

/**
 * List Archived Monthly Reports
 */
async function listSavedMonthlyReports() {
  const logs = await prisma.auditLog.findMany({
    where: { action: 'MONTHLY_ATTENDANCE_REPORT' },
    orderBy: { createdAt: 'desc' },
    take: 50
  });

  return logs.map(l => ({
    id: l.id,
    reportMonth: l.entityId,
    periodLabel: l.metadata?.periodLabel || l.entityId,
    generatedAt: l.createdAt,
    generatedBy: l.metadata?.generatedBy || 'System',
    summary: l.metadata?.summary || null
  }));
}

module.exports = {
  calculateSundayConsecutiveStreaks,
  calculateEngagementScore,
  getMonthlyAttendanceAnalytics,
  getAttendanceTrends,
  getMemberAttendanceAnalytics,
  logPastoralFollowUp,
  saveMonthlyReportSnapshot,
  listSavedMonthlyReports
};
