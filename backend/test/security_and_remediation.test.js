/**
 * Solutions Faith Ministry International — Production Security & Remediation Automated Test Suite
 * Uses Node.js native fetch & assert to validate zero-trust authorization, PII sanitization, role matrix,
 * member persistence, soft deletion, phone normalization, and cron execution without external dependencies.
 */
const assert = require('assert');
const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { normalizePhone } = require('../src/utils/phone');

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'church_mgmt_secret_dev_fallback_only';

function makeToken(sub, role) {
  return jwt.sign({ sub, role, memberId: null }, JWT_SECRET, { expiresIn: '1h' });
}

const superAdminToken = makeToken('super_admin_test_id', 'SUPER_ADMIN');
const subAdminToken = makeToken('sub_admin_test_id', 'ADMIN');
const financeToken = makeToken('finance_test_id', 'FINANCE');

async function runTests() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  console.log('\n======================================================');
  console.log(`🚀 RUNNING SECURITY & REMEDIATION TEST SUITE ON PORT ${port}`);
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  try {
    // ── 1. PHONE NORMALIZATION ──
    await test('Phone Normalization handles +233, spaces, hyphens, and 9-digit formats', async () => {
      assert.strictEqual(normalizePhone('+233550402859'), '0550402859');
      assert.strictEqual(normalizePhone('233550402859'), '0550402859');
      assert.strictEqual(normalizePhone('055 040 2859'), '0550402859');
      assert.strictEqual(normalizePhone('055-040-2859'), '0550402859');
      assert.strictEqual(normalizePhone('550402859'), '0550402859');
      assert.strictEqual(normalizePhone(null), null);
    });

    // ── 2. FINANCE AUTHORIZATION ──
    await test('Finance: Anonymous request to GET /finance/service-entries returns 401', async () => {
      const res = await fetch(`${baseUrl}/finance/service-entries`);
      assert.strictEqual(res.status, 401);
    });

    await test('Finance: Sub-Admin (ADMIN role) request to GET /finance/service-entries returns 403', async () => {
      const res = await fetch(`${baseUrl}/finance/service-entries`, {
        headers: { 'Authorization': `Bearer ${subAdminToken}` }
      });
      assert.strictEqual(res.status, 403);
    });

    await test('Finance: Treasury Officer (FINANCE role) request to GET /finance/service-entries returns 200', async () => {
      const res = await fetch(`${baseUrl}/finance/service-entries`, {
        headers: { 'Authorization': `Bearer ${financeToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
    });

    await test('Finance: Super Admin request to GET /finance/analytics returns 200', async () => {
      const res = await fetch(`${baseUrl}/finance/analytics`, {
        headers: { 'Authorization': `Bearer ${superAdminToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.totalCollections !== undefined);
    });

    // ── 3. SUB-ADMIN MANAGEMENT AUTHORIZATION ──
    await test('Sub-Admin: Anonymous request to GET /auth/subadmins returns 401', async () => {
      const res = await fetch(`${baseUrl}/auth/subadmins`);
      assert.strictEqual(res.status, 401);
    });

    await test('Sub-Admin: Sub-Admin (ADMIN role) cannot list subadmins (returns 403)', async () => {
      const res = await fetch(`${baseUrl}/auth/subadmins`, {
        headers: { 'Authorization': `Bearer ${subAdminToken}` }
      });
      assert.strictEqual(res.status, 403);
    });

    await test('Sub-Admin: Treasury Officer (FINANCE role) cannot create subadmin (returns 403)', async () => {
      const res = await fetch(`${baseUrl}/auth/subadmins`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${financeToken}`
        },
        body: JSON.stringify({ name: 'Hacker Admin', email: 'hacker@test.com', password: 'Password123!' })
      });
      assert.strictEqual(res.status, 403);
    });

    await test('Sub-Admin: Super Admin can list subadmins (returns 200)', async () => {
      const res = await fetch(`${baseUrl}/auth/subadmins`, {
        headers: { 'Authorization': `Bearer ${superAdminToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
    });

    // ── 4. PII SANITIZATION ON LIVE ATTENDANCE ──
    await test('Attendance Live-Count: Public unauthenticated response redacts PII (no phone, no address)', async () => {
      const svc = await prisma.service.findFirst({ where: { active: true } });
      if (svc) {
        const res = await fetch(`${baseUrl}/attendance/live-count/${svc.id}`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(data.count !== undefined);
        if (data.recent && data.recent.length > 0) {
          const sample = data.recent[0];
          assert.strictEqual(sample.member.phone, undefined, 'Public attendee must not expose phone');
          assert.strictEqual(sample.member.address, undefined, 'Public attendee must not expose address');
        }
      }
    });

    await test('Attendance Live-Count: Authenticated Super Admin response includes full administrative data', async () => {
      const svc = await prisma.service.findFirst({ where: { active: true } });
      if (svc) {
        const res = await fetch(`${baseUrl}/attendance/live-count/${svc.id}`, {
          headers: { 'Authorization': `Bearer ${superAdminToken}` }
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        if (data.recent && data.recent.length > 0) {
          const sample = data.recent[0];
          assert.ok(sample.member !== undefined);
          assert.ok(sample.member.gender !== undefined);
        }
      }
    });

    // ── 5. MEMBER PERSISTENCE & SOFT DELETION ──
    let testMemberId = null;
    await test('Members: POST /members persists category, role, guardian, dateOfBirth, anniversary', async () => {
      const res = await fetch(`${baseUrl}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${superAdminToken}`
        },
        body: JSON.stringify({
          firstName: 'TestAudited',
          lastName: 'Member',
          email: 'testaudited@sfmi.org',
          phone: '+233550999888',
          gender: 'Male',
          address: 'Accra Central',
          category: 'Youth',
          role: 'Praise & Worship Leader',
          guardian: 'Elder John',
          dateOfBirth: '1995-06-15',
          anniversary: '2020-10-10'
        })
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.category, 'Youth');
      assert.strictEqual(data.role, 'Praise & Worship Leader');
      assert.strictEqual(data.guardian, 'Elder John');
      assert.strictEqual(data.phone, '0550999888'); // Normalized
      testMemberId = data.id;
    });

    await test('Members: DELETE /members/:id performs soft delete (preserves record as inactive)', async () => {
      if (!testMemberId) return;
      const res = await fetch(`${baseUrl}/members/${testMemberId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${superAdminToken}` }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);

      const dbMember = await prisma.member.findUnique({ where: { id: testMemberId } });
      assert.ok(dbMember !== null, 'Member record must still exist in DB');
      assert.strictEqual(dbMember.active, false, 'Member must be marked active: false');
      assert.ok(dbMember.deletedAt !== null, 'Member deletedAt must be populated');

      // Clean up test member
      await prisma.member.delete({ where: { id: testMemberId } });
    });

    // ── 6. SERVERLESS CRON REMINDERS ──
    await test('Reminders: Anonymous request to /reminders/process returns 401', async () => {
      const res = await fetch(`${baseUrl}/reminders/process`);
      assert.strictEqual(res.status, 401);
    });

    await test('Reminders: Request with valid x-cron-secret processes pending jobs and returns 200', async () => {
      const res = await fetch(`${baseUrl}/reminders/process`, {
        headers: { 'x-cron-secret': 'solutions_cron_secure_key_2026' }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.processedCount !== undefined);
    });

    // ── 7. RATE LIMITING & SECURITY RESPONSE ──
    await test('Rate Limiting & Auth: Login rejects invalid credentials with 401', async () => {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'fake@sfmi.org', password: 'wrongpassword' })
      });
      assert.strictEqual(res.status, 401);
    });

  } finally {
    server.close();
  }

  console.log('\n======================================================');
  console.log(`📊 FINAL TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
