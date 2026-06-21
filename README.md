# Lawncare Manager

Private lead management app for the lawncare lead capture system.

This is a separate Vite + React app that connects to the same Supabase project as the public QR lead capture form.

## What it does

- Supabase Auth login
- Pulls leads from `lawncare_leads`
- Scores and ranks leads
- Lead detail view
- Fair quote builder
- Saves quotes to `lawncare_quotes`
- Converts accepted quotes to jobs in `lawncare_jobs`
- Route board / schedule board
- Payment status and job status tracking
- Pricing settings from `lawncare_settings`

## Setup

Create `.env` from `.env.example`:

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

Install and run:

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## Supabase

Create yourself an auth user in Supabase:

Supabase Dashboard → Authentication → Users → Add User

Then log in with that account.

The public lead capture app should only insert into `lawncare_leads`. This private manager uses Auth + RLS to read and update the same database.

## Vercel

Use these settings:

- Framework: Vite
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: `dist`
- Environment Variables:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`


## Yard photo previews

This version also pulls lead photos from `public.lawncare_lead_images` and creates signed preview URLs from the private `lawncare-lead-images` Storage bucket.

Run `supabase-image-support.sql` in the same Supabase project before expecting image previews to work.

The manager can view uploaded photos, while public visitors cannot list or read images from the bucket.
