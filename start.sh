#!/bin/sh
docker compose up -d
cd backend
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm run dev
