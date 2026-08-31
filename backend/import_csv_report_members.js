require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('./src/config/prisma');

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += char;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseName(fullNameStr) {
  let raw = String(fullNameStr || '').trim();
  if (!raw) return { firstName: 'Member', lastName: '' };

  const prefixes = ['PS', 'Ps.', 'Ps', 'Mr.', 'Mr', 'Mrs.', 'Mrs', 'Bro.', 'Bro', 'Sis.', 'Sis'];
  for (const p of prefixes) {
    if (raw.toLowerCase().startsWith(p.toLowerCase() + ' ')) {
      raw = raw.slice(p.length).trim();
      break;
    }
  }

  const parts = raw.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ');
  return { firstName, lastName };
}

function normalizePhone(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (str === '0000000000' || str === '0') return null;
  const digits = str.replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.startsWith('233') && digits.length >= 12) return '0' + digits.slice(3);
  if (digits.length === 9 && !digits.startsWith('0')) return '0' + digits;
  if (digits.length === 10) return digits;
  return digits;
}

function cleanAddress(loc) {
  if (!loc) return null;
  let str = String(loc).trim();
  if (str.startsWith('📍')) {
    str = str.replace(/^📍\s*/, '').trim();
  }
  return str || null;
}

async function runImport() {
  const csvPath = path.join(__dirname, '../SFMI_Attendance_Report_Sunday__Family___Friends_Service (1).csv');
  console.log('Reading CSV from:', csvPath);

  if (!fs.existsSync(csvPath)) {
    console.error('File not found:', csvPath);
    process.exit(1);
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  const rows = lines.slice(1);
  console.log(`Processing ${rows.length} rows...`);

  // Pre-fetch existing members
  const existingMembers = await prisma.member.findMany({ where: { active: true } });
  const phoneMap = new Map();
  const nameMap = new Map();

  for (const m of existingMembers) {
    if (m.phone) phoneMap.set(m.phone, m);
    nameMap.set(`${m.firstName.toLowerCase()}|${m.lastName.toLowerCase()}`, m);
  }

  const toCreate = [];
  const updatePromises = [];
  let countSkipped = 0;

  for (const line of rows) {
    const cols = parseCSVLine(line);
    if (cols.length < 4) continue;

    const rawName = cols[1];
    const category = cols[2] || 'Adult';
    const rawPhone = cols[3];
    const guardian = cols[4] || null;
    const genderRaw = cols[5] || null;
    const addressRaw = cols[6] || null;
    const roleRaw = cols[7] || 'Member';

    if (/test/i.test(rawName) || /^P P$/i.test(rawName) || /TYSGGHDSGDS/i.test(addressRaw)) {
      console.log(`Skipping test entry: ${rawName}`);
      countSkipped++;
      continue;
    }

    const { firstName, lastName } = parseName(rawName);
    const phone = normalizePhone(rawPhone);
    const address = cleanAddress(addressRaw);
    let gender = null;
    if (genderRaw) {
      if (/female/i.test(genderRaw)) gender = 'Female';
      else if (/male/i.test(genderRaw)) gender = 'Male';
    }

    let role = 'Member';
    if (/visitor/i.test(roleRaw) || /first timer/i.test(roleRaw)) {
      role = 'Visitor';
    } else if (roleRaw) {
      role = roleRaw;
    }

    let existing = null;
    if (phone && phoneMap.has(phone)) {
      existing = phoneMap.get(phone);
    }
    if (!existing) {
      const key = `${firstName.toLowerCase()}|${lastName.toLowerCase()}`;
      if (nameMap.has(key)) {
        existing = nameMap.get(key);
      }
    }

    if (existing) {
      updatePromises.push(
        prisma.member.update({
          where: { id: existing.id },
          data: {
            phone: phone || existing.phone,
            gender: gender || existing.gender,
            address: address || existing.address,
            category: category || existing.category,
            role: role || existing.role,
            guardian: guardian || existing.guardian
          }
        })
      );
    } else {
      toCreate.push({
        firstName,
        lastName,
        phone,
        gender,
        address,
        category,
        role,
        guardian
      });
      // Deduplicate within loop
      const key = `${firstName.toLowerCase()}|${lastName.toLowerCase()}`;
      nameMap.set(key, { firstName, lastName });
      if (phone) phoneMap.set(phone, { phone });
    }
  }

  console.log(`Sending batch: ${toCreate.length} to create, ${updatePromises.length} to update...`);

  if (toCreate.length > 0) {
    await prisma.member.createMany({ data: toCreate });
  }

  if (updatePromises.length > 0) {
    await prisma.$transaction(updatePromises);
  }

  console.log(`Import completed successfully! Created: ${toCreate.length}, Updated: ${updatePromises.length}, Skipped: ${countSkipped}`);

  const totalMembers = await prisma.member.count({ where: { active: true } });
  console.log(`Total active members now in database: ${totalMembers}`);

  process.exit(0);
}

runImport().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
