# CHECKINSOLUTIONS
### Solutions Faith Ministry International — Church Management System

Full-stack Church Management & Attendance Kiosk System built for Solutions Faith Ministry International.

## ✨ Modules & Interfaces
- **Administration Portal** (`/admin.html`): Attendance tracking, attendee demographics, member directory, service & custom program manager, sub-admin staff privilege controls.
- **Self-Service Check-In Kiosk** (`/checkin.html`): Fast phone/name member lookup, live service flyer display, multi-family check-in, real-time Sunday/Wednesday/Friday schedules.
- **Treasury Portal** (`/finance.html`): Mobile-responsive vertical step-by-step financial entries, multi-category collection (Tithes, Offerings, Seeds, Building, Thanksgiving), payment breakdowns, immutable posting.
- **Secure Backend API**: Node.js + Express + Prisma + PostgreSQL + JWT Authentication & crypto-hardened token verification.

## 🚀 Quick Start

1. **Configure Environment**:
   ```bash
   cp backend/.env.example backend/.env
   ```
2. **Install Dependencies**:
   ```bash
   cd backend && npm install
   cd ../web && npm install
   ```
3. **Database Setup**:
   ```bash
   cd backend
   npx prisma generate
   npx prisma migrate dev --name init
   npm run seed
   ```
4. **Run Application**:
   ```bash
   ./start.sh
   ```
   - **Backend API**: `http://localhost:4000`
   - **Web Application**: `http://localhost:5173`
     - Kiosk: `http://localhost:5173/checkin.html`
     - Admin Portal: `http://localhost:5173/admin.html`
     - Treasury Portal: `http://localhost:5173/finance.html`
