require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('./src/config/prisma');
const { execSync } = require('child_process');

function normalizePhone(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const digits = str.replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.startsWith('233') && digits.length >= 12) return '0' + digits.slice(3);
  if (digits.length === 9 && !digits.startsWith('0')) return '0' + digits;
  if (digits.length === 10) return digits;
  return digits;
}

function parseName(fullNameStr) {
  let raw = String(fullNameStr || '').trim();
  if (!raw) return { firstName: 'Member', lastName: '' };

  const prefixes = ['Mr.', 'Mrs.', 'Ps.', 'Ps', 'Mr', 'Mrs', 'Bro', 'Bro.'];
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

async function importExcelMembers() {
  const excelPath = path.join(__dirname, '../web/public/contact_list_1_70.xlsx');
  console.log('Reading Excel file from:', excelPath);

  const pyScriptPath = path.join(__dirname, 'parse_excel.py');
  const pyCode = `import zipfile, xml.etree.ElementTree as ET, json, sys

excel_path = sys.argv[1]
with zipfile.ZipFile(excel_path) as z:
    shared_strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        tree = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for elem in tree.iter():
            if elem.tag.endswith("t") and elem.text:
                shared_strings.append(elem.text)

    sheet_tree = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for row_elem in sheet_tree.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row"):
        r = []
        for c in row_elem.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
            t = c.attrib.get("t")
            v_elem = c.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v")
            val = v_elem.text if v_elem is not None else ""
            if t == "s" and val.isdigit() and int(val) < len(shared_strings):
                val = shared_strings[int(val)]
            r.append(val)
        rows.append(r)

print(json.dumps(rows))
`;

  fs.writeFileSync(pyScriptPath, pyCode);
  const output = execSync(`python3 "${pyScriptPath}" "${excelPath}"`, { encoding: 'utf-8' });
  try { fs.unlinkSync(pyScriptPath); } catch (e) {}

  const rawRows = JSON.parse(output);
  console.log(`Parsed ${rawRows.length} total rows from Excel.`);

  // Load all existing members in bulk for fast matching
  const allExisting = await prisma.member.findMany({ where: { active: true } });
  const phoneMap = new Map();
  const nameMap = new Map();

  allExisting.forEach(m => {
    if (m.phone) phoneMap.set(m.phone, m);
    const key = `${m.firstName} ${m.lastName}`.toLowerCase().trim();
    nameMap.set(key, m);
  });

  let insertedCount = 0;
  let updatedCount = 0;

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || row.length < 2) continue;

    const no = row[0] ? String(row[0]).trim() : '';
    const fullNameRaw = row[1] ? String(row[1]).trim() : '';
    if (!fullNameRaw || fullNameRaw.toLowerCase() === 'name') continue;

    let rawPhone = '';
    let rawLocation = '';

    if (row.length === 3) {
      const third = String(row[2]).trim();
      if (/^\d{8,15}$/.test(third.replace(/[^\d]/g, ''))) {
        rawPhone = third;
      } else {
        rawLocation = third;
      }
    } else if (row.length >= 4) {
      rawPhone = row[2] ? String(row[2]).trim() : '';
      rawLocation = row[3] ? String(row[3]).trim() : '';
    }

    const { firstName, lastName } = parseName(fullNameRaw);
    const phone = normalizePhone(rawPhone);
    const address = rawLocation ? (rawLocation.startsWith('📍') ? rawLocation : `📍 ${rawLocation}`) : null;

    const nameKey = `${firstName} ${lastName}`.toLowerCase().trim();
    let existing = (phone ? phoneMap.get(phone) : null) || nameMap.get(nameKey);

    if (existing) {
      const updatePayload = {};
      if (phone && !existing.phone) updatePayload.phone = phone;
      if (address && !existing.address) updatePayload.address = address;

      if (Object.keys(updatePayload).length > 0) {
        const updated = await prisma.member.update({
          where: { id: existing.id },
          data: updatePayload
        });
        if (phone) phoneMap.set(phone, updated);
        nameMap.set(nameKey, updated);
        updatedCount++;
        console.log(`Updated [${no}] ${firstName} ${lastName}`);
      } else {
        console.log(`Skipped [${no}] ${firstName} ${lastName} (Already complete)`);
      }
    } else {
      const createPayload = {
        firstName: firstName || 'Member',
        lastName: lastName || '',
        category: 'Adult',
        role: 'Member',
        active: true
      };
      if (phone) createPayload.phone = phone;
      if (address) createPayload.address = address;

      const created = await prisma.member.create({ data: createPayload });
      if (phone) phoneMap.set(phone, created);
      nameMap.set(nameKey, created);
      insertedCount++;
      console.log(`Inserted [${no}] ${firstName} ${lastName}`);
    }
  }

  console.log(`\n🎉 Import Complete! Inserted: ${insertedCount}, Updated: ${updatedCount}, Total Processed: ${insertedCount + updatedCount}`);
}

importExcelMembers()
  .catch(err => {
    console.error('Import failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
