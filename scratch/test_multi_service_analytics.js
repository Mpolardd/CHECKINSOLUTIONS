const { getMonthlyAttendanceAnalytics, getMemberAttendanceAnalytics } = require('../backend/src/modules/attendance/attendanceAnalytics.service');
const prisma = require('../backend/src/config/prisma');

async function testAnalytics() {
  console.log('--- Testing Monthly Analytics with attendeeType = ALL ---');
  const allData = await getMonthlyAttendanceAnalytics({ year: 2026, month: 9, serviceTypeFilter: 'ALL', attendeeType: 'ALL' });
  console.log(`Analyzed Attendees: ${allData.summary.analyzedCount}`);
  console.log(`Total Regular Members: ${allData.summary.totalRegularCount}`);
  console.log(`Total Visitors: ${allData.summary.totalVisitorsCount}`);
  console.log(`Total Check-ins count: ${allData.summary.totalCheckinsCount}`);
  console.log(`Active Attendees this month: ${allData.summary.activeMembersThisMonth}`);
  console.log(`Service Breakdown:`, JSON.stringify(allData.summary.serviceBreakdown, null, 2));
  console.log(`Pastoral Alert Counts:`, JSON.stringify(allData.summary.pastoralAlertCounts, null, 2));

  // Find John Nii Akushie
  const john = allData.members.find(m => m.name.toLowerCase().includes('akushie') || m.name.toLowerCase().includes('nii'));
  if (john) {
    console.log('\n--- Found John Nii Akushie in ALL data ---');
    console.log(`Name: ${john.name}`);
    console.log(`Is Visitor: ${john.isVisitor}`);
    console.log(`Sunday:`, john.sunday);
    console.log(`Wednesday:`, john.wednesday);
    console.log(`Friday:`, john.friday);
    console.log(`Overall:`, john.overall);
    console.log(`Score:`, john.engagement);

    console.log('\n--- Testing Member Dossier for John Nii Akushie ---');
    const dossier = await getMemberAttendanceAnalytics(john.memberId);
    console.log(`Dossier Name: ${dossier.member.name}`);
    console.log(`Sunday Streak: 🔥 ${dossier.sunday.currentStreak}, Longest: ${dossier.sunday.longestStreak}`);
    console.log(`Wednesday Streak: 🔥 ${dossier.wednesday.currentStreak}, Longest: ${dossier.wednesday.longestStreak}`);
    console.log(`Friday Streak: 🔥 ${dossier.friday.currentStreak}, Longest: ${dossier.friday.longestStreak}`);
    console.log(`Overall Streak: 🔥 ${dossier.overall.currentStreak}, Longest: ${dossier.overall.longestStreak}`);
    console.log(`Recent checkins count: ${dossier.recentCheckins.length}`);
    dossier.recentCheckins.forEach(c => {
      console.log(`  -> ${c.serviceDate}: ${c.serviceName} (${c.method})`);
    });
  } else {
    console.log('Could not find John Nii Akushie');
  }

  console.log('\n--- Leaderboards summary ---');
  console.log(`Sunday streaks leaderboard count: ${allData.leaderboards.sunday.currentStreaks.length}`);
  console.log(`Wednesday streaks leaderboard count: ${allData.leaderboards.wednesday.currentStreaks.length}`);
  console.log(`Friday streaks leaderboard count: ${allData.leaderboards.friday.currentStreaks.length}`);
  console.log(`Overall streaks leaderboard count: ${allData.leaderboards.overall.currentStreaks.length}`);

  if (allData.leaderboards.wednesday.currentStreaks.length > 0) {
    console.log('Top Wednesday attendees:');
    allData.leaderboards.wednesday.currentStreaks.slice(0, 5).forEach(m => {
      console.log(`  - ${m.name} (${m.isVisitor ? 'Visitor' : 'Member'}): 🔥 ${m.wednesday.currentStreak} Midweek (Rate: ${m.wednesday.rate}%)`);
    });
  }

  if (allData.leaderboards.friday.currentStreaks.length > 0) {
    console.log('Top Friday attendees:');
    allData.leaderboards.friday.currentStreaks.slice(0, 5).forEach(m => {
      console.log(`  - ${m.name} (${m.isVisitor ? 'Visitor' : 'Member'}): 🔥 ${m.friday.currentStreak} Friday (Rate: ${m.friday.rate}%)`);
    });
  }

  await prisma.$disconnect();
}

testAnalytics().catch(err => {
  console.error(err);
  process.exit(1);
});
