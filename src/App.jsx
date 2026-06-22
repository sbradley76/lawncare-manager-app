import React, { useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import { scoreLead } from './lib/scoring';
import { estimateQuote } from './lib/pricing';
import { buildAddress, centsToDollars, dollarsToCents, formatDate, formatDateTime, getFullName, labelize, mapsUrl, normalizeServices } from './lib/format';

const STATUS_OPTIONS = ['new', 'contacted', 'quoted', 'scheduled', 'won', 'lost', 'spam'];
const QUOTE_STATUS_OPTIONS = ['draft', 'sent', 'accepted', 'declined', 'expired'];
const JOB_STATUS_OPTIONS = ['scheduled', 'in_progress', 'completed', 'cancelled'];
const PAYMENT_STATUS_OPTIONS = ['unpaid', 'paid_cash', 'paid_cash_app', 'paid_venmo', 'paid_card', 'invoiced'];
const INVOICE_STATUS_OPTIONS = ['draft', 'sent', 'viewed', 'paid', 'partially_paid', 'overdue', 'void'];
const PAYMENT_METHOD_OPTIONS = ['cash', 'check', 'cash_app', 'venmo', 'zelle', 'card', 'other'];
const ROUTE_STATUS_OPTIONS = ['draft', 'scheduled', 'in_progress', 'completed', 'cancelled'];
const TEAM_ROLE_OPTIONS = ['admin', 'manager', 'crew'];
const TEAM_STATUS_OPTIONS = ['active', 'inactive'];
const IMAGE_BUCKET = 'lawncare-lead-images';

function makeInvoiceNumber() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const suffix = String(now.getTime()).slice(-5);
  return `LC-${stamp}-${suffix}`;
}

function addDaysIso(dateValue, days) {
  const base = dateValue ? new Date(`${dateValue}T12:00:00`) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function getJobInvoice(job, invoices) {
  return invoices.find((invoice) => invoice.job_id === job.id);
}

function getInvoiceTotal(invoice, items = []) {
  if (invoice?.total_cents !== null && invoice?.total_cents !== undefined) return Number(invoice.total_cents);
  return items.reduce((sum, item) => sum + Number(item.line_total_cents || 0), 0) - Number(invoice?.discount_cents || 0);
}

function getInvoiceBalance(invoice, items = []) {
  const total = getInvoiceTotal(invoice, items);
  const paid = Number(invoice?.amount_paid_cents || 0);
  return Math.max(0, total - paid);
}

function invoiceStatusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'paid') return 'paid';
  if (value === 'sent' || value === 'viewed' || value === 'partially_paid') return 'sent';
  if (value === 'overdue') return 'overdue';
  if (value === 'void') return 'void';
  return '';
}


function makeQuoteNumber() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const suffix = String(now.getTime()).slice(-5);
  return `Q-${stamp}-${suffix}`;
}

function quoteStatusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'accepted') return 'paid';
  if (value === 'sent') return 'sent';
  if (value === 'declined' || value === 'expired') return 'void';
  return '';
}

function getQuoteAmount(quote) {
  return Number(quote?.final_price_cents || quote?.suggested_price_cents || 0);
}

function getQuoteNumber(quote) {
  return quote?.quote_number || `Quote ${String(quote?.id || '').slice(0, 8)}`;
}

function quoteValidUntil() {
  return addDaysIso(null, 14);
}

function buildQuoteMessage(quote, lead, settings) {
  const business = settings?.business_name || DEFAULT_SETTINGS.business_name;
  const phone = settings?.phone || DEFAULT_SETTINGS.phone;
  const customer = lead ? getFullName(lead) : 'there';
  const services = lead ? normalizeServices(lead.services_requested).map(labelize).join(', ') : 'lawn care service';
  const address = lead ? buildAddress(lead) : '';
  const amount = centsToDollars(getQuoteAmount(quote));
  const validText = quote?.valid_until ? `\nValid until: ${formatDate(`${quote.valid_until}T12:00:00`)}` : '';
  const notes = quote?.quote_notes ? `\nNotes: ${quote.quote_notes}` : '';

  return `Hi ${customer}, this is your ${business} quote.\n\nService: ${services}${address ? `\nProperty: ${address}` : ''}\nQuote: ${amount}${validText}${notes}\n\nReply YES to approve and I can get you scheduled. Questions? Call/text ${phone}.`;
}

function smsHref(phone, message) {
  if (!phone) return '#';
  return `sms:${phone}?&body=${encodeURIComponent(message)}`;
}

function mailtoHref(email, subject, message) {
  if (!email) return '#';
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
}


const DEFAULT_SETTINGS = {
  business_name: 'Affordable Residential Lawn Care',
  owner_name: '',
  phone: '(336) 552-1877',
  service_areas: ['Fort Walton Beach', 'Shalimar', 'Cinco Bayou', 'Mary Esther', 'Destin'],
  small_base_cents: 6500,
  medium_base_cents: 9000,
  large_base_cents: 13500,
  weekly_discount_percent: 10,
  biweekly_discount_percent: 5,
};

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isAdminRole(member) {
  return ['admin', 'manager'].includes(String(member?.role || '').toLowerCase()) || member?.implicit_admin;
}

function memberDisplayName(member, fallbackEmail = '') {
  return member?.name || member?.email || fallbackEmail || 'Team member';
}

function getRouteLabel(route) {
  if (!route) return 'Route';
  const date = route.route_date ? ` · ${formatDate(`${route.route_date}T12:00:00`)}` : '';
  return `${route.name || 'Route'}${date}`;
}

function msToHoursLabel(ms) {
  if (!ms || ms < 0) return '0h 00m';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function entryDurationMs(entry) {
  if (!entry?.clock_in_at) return 0;
  const start = new Date(entry.clock_in_at).getTime();
  const end = entry.clock_out_at ? new Date(entry.clock_out_at).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}

function isToday(value) {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function isThisWeek(value) {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(now.getDate() - now.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return date >= start && date < end;
}

function useSession() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return undefined;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  return { session, loading };
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) setError(authError.message);
    setBusy(false);
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">🌿</div>
        <p className="eyebrow">Private Manager</p>
        <h1>Lawncare Manager</h1>
        <p className="muted centered">Pull leads from Supabase, rank them, quote fairly, schedule jobs, manage routes, and keep your crew moving.</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Email
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>
          {error ? <div className="error-box">{error}</div> : null}
          <button className="primary-button full" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </section>
    </main>
  );
}

function StatCard({ label, value, hint }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </article>
  );
}

function LeadBadge({ score }) {
  return <span className={classNames('score-badge', score.score >= 80 && 'hot', score.score >= 55 && score.score < 80 && 'good')}>{score.tier} · {score.score}</span>;
}

function EmptyState({ title, body }) {
  return (
    <div className="empty-state">
      <div>🌱</div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function TopBar({ userEmail, activeView, setActiveView, onLogout, currentMember, teamReady }) {
  const adminTabs = [
    ['dashboard', 'Leads'],
    ['quotes', 'Quotes'],
    ['routes', 'Routes'],
    ['invoices', 'Invoices'],
    ['calendar', 'Calendar'],
    ['team', 'Team'],
    ['settings', 'Settings'],
  ];
  const crewTabs = [
    ['crew', 'My Route'],
  ];
  const tabs = isAdminRole(currentMember) ? adminTabs : crewTabs;

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="logo-block">
          <div className="logo-icon">🌿</div>
          <div>
            <strong>Lawncare Manager</strong>
            <span>{isAdminRole(currentMember) ? 'Lead → Quote → Route → Crew' : 'Crew route and time clock'}</span>
          </div>
        </div>
        <nav className="tab-nav" aria-label="Manager navigation">
          {tabs.map(([key, label]) => (
            <button key={key} className={activeView === key ? 'active' : ''} onClick={() => setActiveView(key)}>{label}</button>
          ))}
        </nav>
        <div className="user-actions">
          <span>{teamReady ? `${memberDisplayName(currentMember, userEmail)} · ${labelize(currentMember?.role || 'admin')}` : userEmail}</span>
          <button className="ghost-button" onClick={onLogout}>Sign out</button>
        </div>
      </div>
    </header>
  );
}

function AccessSetup({ userEmail, teamMembers, refreshData }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function createFirstAdmin(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const { error } = await supabase.from('lawncare_team_members').insert({
      name: name || userEmail || 'Admin',
      email: userEmail,
      role: 'admin',
      status: 'active',
    });
    setBusy(false);
    if (error) setMessage(error.message);
    else {
      setMessage('Admin profile created. Loading manager…');
      await refreshData(false);
    }
  }

  if (teamMembers.length === 0) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark">👑</div>
          <p className="eyebrow">First Admin Setup</p>
          <h1>Create your admin profile</h1>
          <p className="muted centered">No team members exist yet. Create the first admin, then add your crew from the Team page.</p>
          <form className="login-form" onSubmit={createFirstAdmin}>
            <label>Your name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Sabastian" /></label>
            <button className="primary-button full" disabled={busy}>{busy ? 'Creating…' : 'Create admin profile'}</button>
            {message ? <div className={message.includes('created') ? 'success-box' : 'error-box'}>{message}</div> : null}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">🔒</div>
        <p className="eyebrow">Crew Access Needed</p>
        <h1>No team profile found</h1>
        <p className="muted centered">You are signed in as {userEmail}. Ask an admin to add this email to Team as an active admin, manager, or crew member.</p>
        <button className="ghost-button full" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </section>
    </main>
  );
}

function Dashboard({ leads, quotes, jobs, invoices, images, selectedLead, setSelectedLead, refreshData, settings }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const enriched = useMemo(() => {
    return leads
      .map((lead) => ({ ...lead, leadScore: scoreLead(lead) }))
      .sort((a, b) => b.leadScore.score - a.leadScore.score || new Date(b.created_at) - new Date(a.created_at));
  }, [leads]);

  const photoCounts = useMemo(() => images.reduce((acc, image) => {
    acc[image.lead_id] = (acc[image.lead_id] || 0) + 1;
    return acc;
  }, {}), [images]);

  const filtered = enriched.filter((lead) => {
    const haystack = [getFullName(lead), lead.phone, lead.city, lead.street_address, lead.status, normalizeServices(lead.services_requested).join(' ')]
      .join(' ')
      .toLowerCase();
    const matchesSearch = haystack.includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || lead.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const newLeads = leads.filter((lead) => lead.status === 'new').length;
  const hotLeads = enriched.filter((lead) => lead.leadScore.score >= 80).length;
  const scheduledJobs = jobs.filter((job) => job.job_status === 'scheduled').length;
  const unpaidJobs = jobs.filter((job) => ['unpaid', 'invoiced'].includes(job.payment_status)).length;
  const openInvoices = invoices.filter((invoice) => !['paid', 'void'].includes(invoice.status)).length;

  return (
    <main className="app-grid">
      <section className="main-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Lead Dashboard</p>
            <h1>Ranked lawncare leads</h1>
          </div>
          <button className="ghost-button" onClick={refreshData}>Refresh</button>
        </div>

        <div className="stats-grid">
          <StatCard label="New Leads" value={newLeads} hint="Need follow-up" />
          <StatCard label="Hot Leads" value={hotLeads} hint="Highest route fit" />
          <StatCard label="Quotes Saved" value={quotes.length} hint="Drafts and sent quotes" />
          <StatCard label="Open Invoices" value={openInvoices} hint="Drafts, sent, overdue" />
          <StatCard label="Unpaid / Invoiced" value={unpaidJobs} hint={`${scheduledJobs} scheduled jobs`} />
        </div>

        <div className="filter-row">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, city, phone, service…" />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All statuses</option>
            {STATUS_OPTIONS.map((status) => <option value={status} key={status}>{labelize(status)}</option>)}
          </select>
        </div>

        <div className="lead-list">
          {filtered.length ? filtered.map((lead) => (
            <button
              key={lead.id}
              className={classNames('lead-card', selectedLead?.id === lead.id && 'selected')}
              onClick={() => setSelectedLead(lead)}
            >
              <div className="lead-card-top">
                <div>
                  <h3>{getFullName(lead)}</h3>
                  <p>{buildAddress(lead) || 'No address'}</p>
                </div>
                <LeadBadge score={lead.leadScore} />
              </div>
              <div className="pill-row">
                <span>{labelize(lead.status || 'new')}</span>
                <span>{labelize(lead.requested_frequency)}</span>
                <span>{labelize(lead.property_type)}</span>
                <span>{labelize(lead.yard_condition)}</span>
                {photoCounts[lead.id] ? <span>📷 {photoCounts[lead.id]} photo{photoCounts[lead.id] === 1 ? '' : 's'}</span> : null}
              </div>
              <p className="small-muted">{normalizeServices(lead.services_requested).map(labelize).join(' · ') || 'No services listed'}</p>
              <p className="small-muted">Created {formatDateTime(lead.created_at)}</p>
            </button>
          )) : <EmptyState title="No matching leads" body="Change the filter or wait for the QR form to capture the next request." />}
        </div>
      </section>

      <aside className="detail-panel">
        {selectedLead ? (
          <LeadDetail lead={selectedLead} setSelectedLead={setSelectedLead} refreshData={refreshData} settings={settings} leadImages={images.filter((image) => image.lead_id === selectedLead.id)} leadQuotes={quotes.filter((quote) => quote.lead_id === selectedLead.id)} />
        ) : (
          <EmptyState title="Select a lead" body="Pick a lead to view details, build a quote, and convert it to a scheduled job." />
        )}
      </aside>
    </main>
  );
}

function LeadImages({ images }) {
  const [signedImages, setSignedImages] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadImages() {
      setSignedImages([]);
      setError('');
      if (!images?.length) return;

      const results = [];
      for (const image of images) {
        const { data, error: signedError } = await supabase.storage
          .from(image.bucket_id || IMAGE_BUCKET)
          .createSignedUrl(image.storage_path, 60 * 60);

        if (signedError) {
          setError(signedError.message);
          continue;
        }
        results.push({ ...image, signedUrl: data?.signedUrl });
      }
      if (!cancelled) setSignedImages(results);
    }

    loadImages();
    return () => { cancelled = true; };
  }, [images]);

  if (!images?.length) return null;

  return (
    <section className="mini-section">
      <div className="photo-section-header">
        <h3>Yard photos</h3>
        <span>{images.length} uploaded</span>
      </div>
      {error ? <div className="error-box">Photo preview error: {error}</div> : null}
      <div className="image-grid">
        {signedImages.map((image) => (
          <a className="image-card" key={image.id || image.storage_path} href={image.signedUrl} target="_blank" rel="noreferrer">
            <img src={image.signedUrl} alt={image.file_name || 'Yard photo'} loading="lazy" />
            <span>{image.file_name || 'Open photo'}</span>
          </a>
        ))}
      </div>
      {!signedImages.length && !error ? <p className="small-muted">Loading photo previews…</p> : null}
    </section>
  );
}

function LeadDetail({ lead, setSelectedLead, refreshData, settings, leadImages, leadQuotes = [] }) {
  const [status, setStatus] = useState(lead.status || 'new');
  const [internalNotes, setInternalNotes] = useState(lead.internal_notes || '');
  const [finalPrice, setFinalPrice] = useState('');
  const [quoteNotes, setQuoteNotes] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setStatus(lead.status || 'new');
    setInternalNotes(lead.internal_notes || '');
    setFinalPrice('');
    setQuoteNotes('');
    setScheduledDate('');
    setScheduledTime('');
    setMessage('');
  }, [lead.id]);

  const leadScore = useMemo(() => scoreLead(lead), [lead]);
  const estimate = useMemo(() => estimateQuote(lead, settings), [lead, settings]);
  const displayedFinalCents = finalPrice ? dollarsToCents(finalPrice) : estimate.suggested_price_cents;

  async function updateLead(patch) {
    setBusy(true);
    setMessage('');
    const { data, error } = await supabase
      .from('lawncare_leads')
      .update(patch)
      .eq('id', lead.id)
      .select('*')
      .single();
    setBusy(false);
    if (error) {
      setMessage(error.message);
      return null;
    }
    setSelectedLead(data);
    await refreshData(false);
    setMessage('Saved.');
    return data;
  }

  async function saveStatusAndNotes() {
    await updateLead({ status, internal_notes: internalNotes || null });
  }

  async function saveQuote() {
    setBusy(true);
    setMessage('');
    const finalPriceCents = displayedFinalCents;
    const payload = {
      lead_id: lead.id,
      suggested_price_cents: estimate.suggested_price_cents,
      min_price_cents: estimate.min_price_cents,
      max_price_cents: estimate.max_price_cents,
      final_price_cents: finalPriceCents,
      frequency: estimate.frequency,
      quote_reason: estimate.quote_reason,
      quote_notes: quoteNotes || null,
      status: 'draft',
      quote_number: makeQuoteNumber(),
      valid_until: quoteValidUntil(),
    };

    const { error: quoteError } = await supabase.from('lawncare_quotes').insert(payload);
    if (quoteError) {
      setBusy(false);
      setMessage(quoteError.message);
      return;
    }

    const { data, error: leadError } = await supabase
      .from('lawncare_leads')
      .update({ status: 'quoted', quoted_price_cents: finalPriceCents, quote_notes: quoteNotes || estimate.quote_reason })
      .eq('id', lead.id)
      .select('*')
      .single();

    setBusy(false);
    if (leadError) {
      setMessage(leadError.message);
      return;
    }
    setStatus('quoted');
    setSelectedLead(data);
    await refreshData(false);
    setMessage('Quote saved.');
  }

  async function convertToJob() {
    if (!scheduledDate) {
      setMessage('Pick a scheduled date first.');
      return;
    }
    setBusy(true);
    setMessage('');
    const finalPriceCents = displayedFinalCents;
    const { error: jobError } = await supabase.from('lawncare_jobs').insert({
      lead_id: lead.id,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime || null,
      customer_name: getFullName(lead),
      phone: lead.phone,
      street_address: lead.street_address,
      city: lead.city,
      zip_code: lead.zip_code,
      services: normalizeServices(lead.services_requested),
      job_notes: [lead.gate_or_pet_notes, lead.additional_notes, quoteNotes].filter(Boolean).join('\n'),
      quoted_price_cents: finalPriceCents,
      final_price_cents: finalPriceCents,
      job_status: 'scheduled',
      payment_status: 'unpaid',
    });

    if (jobError) {
      setBusy(false);
      setMessage(jobError.message);
      return;
    }

    const { data, error: leadError } = await supabase
      .from('lawncare_leads')
      .update({ status: 'scheduled', quoted_price_cents: finalPriceCents })
      .eq('id', lead.id)
      .select('*')
      .single();

    setBusy(false);
    if (leadError) {
      setMessage(leadError.message);
      return;
    }
    setStatus('scheduled');
    setSelectedLead(data);
    await refreshData(false);
    setMessage('Job scheduled.');
  }

  return (
    <div className="lead-detail">
      <div className="detail-header">
        <div>
          <p className="eyebrow">Lead Detail</p>
          <h2>{getFullName(lead)}</h2>
          <p>{buildAddress(lead)}</p>
        </div>
        <LeadBadge score={leadScore} />
      </div>

      <div className="action-row">
        {lead.phone ? <a className="primary-button compact" href={`tel:${lead.phone}`}>Call</a> : null}
        {lead.phone ? <a className="ghost-button compact" href={`sms:${lead.phone}`}>Text</a> : null}
        {buildAddress(lead) ? <a className="ghost-button compact" href={mapsUrl(lead)} target="_blank" rel="noreferrer">Maps</a> : null}
      </div>

      <div className="info-grid">
        <div><span>Phone</span><strong>{lead.phone || '—'}</strong></div>
        <div><span>Email</span><strong>{lead.email || '—'}</strong></div>
        <div><span>Frequency</span><strong>{labelize(lead.requested_frequency)}</strong></div>
        <div><span>Condition</span><strong>{labelize(lead.yard_condition)}</strong></div>
        <div><span>Property</span><strong>{labelize(lead.property_type)}</strong></div>
        <div><span>Source</span><strong>{labelize(lead.source)}</strong></div>
      </div>

      <section className="mini-section">
        <h3>Services</h3>
        <div className="pill-row">
          {normalizeServices(lead.services_requested).map((service) => <span key={service}>{labelize(service)}</span>)}
        </div>
      </section>

      <section className="mini-section">
        <h3>Ranking reason</h3>
        <ul className="reason-list">
          {leadScore.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      </section>

      {(lead.additional_notes || lead.gate_or_pet_notes) ? (
        <section className="mini-section note-box">
          <h3>Customer notes</h3>
          {lead.gate_or_pet_notes ? <p><strong>Gate/Pets:</strong> {lead.gate_or_pet_notes}</p> : null}
          {lead.additional_notes ? <p>{lead.additional_notes}</p> : null}
        </section>
      ) : null}

      <LeadImages images={leadImages} />

      <section className="mini-section quote-box">
        <div className="quote-main">
          <div>
            <span>Suggested quote</span>
            <strong>{centsToDollars(estimate.suggested_price_cents)}</strong>
          </div>
          <div>
            <span>Fair range</span>
            <strong>{centsToDollars(estimate.min_price_cents)} – {centsToDollars(estimate.max_price_cents)}</strong>
          </div>
        </div>
        <p>{estimate.quote_reason}</p>
        <label>
          Final price override
          <input value={finalPrice} onChange={(event) => setFinalPrice(event.target.value)} placeholder={`${estimate.suggested_price_cents / 100}`} inputMode="decimal" />
        </label>
        <label>
          Quote notes
          <textarea value={quoteNotes} onChange={(event) => setQuoteNotes(event.target.value)} placeholder="Example: Includes mow, weedeat, edge, blow. Overgrown cleanup included for first visit." />
        </label>
        <button className="primary-button full" onClick={saveQuote} disabled={busy}>Save quote</button>
      </section>

      <section className="mini-section">
        <div className="photo-section-header">
          <h3>Saved quotes</h3>
          <span>{leadQuotes.length}</span>
        </div>
        {leadQuotes.length ? (
          <div className="quote-history">
            {leadQuotes
              .slice()
              .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
              .map((quote) => {
                const text = buildQuoteMessage(quote, lead, settings);
                return (
                  <div className="quote-history-row" key={quote.id}>
                    <div>
                      <strong>{getQuoteNumber(quote)} · {centsToDollars(getQuoteAmount(quote))}</strong>
                      <p className="small-muted">{labelize(quote.status || 'draft')} · {quote.created_at ? formatDateTime(quote.created_at) : 'Saved quote'}</p>
                    </div>
                    <div className="button-row compact-row">
                      {lead.phone ? <a className="ghost-button compact" href={smsHref(lead.phone, text)}>Text</a> : null}
                      {lead.email ? <a className="ghost-button compact" href={mailtoHref(lead.email, getQuoteNumber(quote), text)}>Email</a> : null}
                    </div>
                  </div>
                );
              })}
          </div>
        ) : <p className="small-muted">No saved quotes yet. Save the suggested quote above, then send it from the Quotes tab.</p>}
      </section>

      <section className="mini-section">
        <h3>Schedule job</h3>
        <div className="two-col">
          <label>
            Date
            <input type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} />
          </label>
          <label>
            Time note
            <input value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} placeholder="Morning / after 3pm" />
          </label>
        </div>
        <button className="secondary-button full" onClick={convertToJob} disabled={busy}>Convert to scheduled job</button>
      </section>

      <section className="mini-section">
        <h3>Internal management</h3>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            {STATUS_OPTIONS.map((option) => <option key={option} value={option}>{labelize(option)}</option>)}
          </select>
        </label>
        <label>
          Internal notes
          <textarea value={internalNotes} onChange={(event) => setInternalNotes(event.target.value)} placeholder="Private notes for follow-up, quote concerns, route fit, etc." />
        </label>
        <button className="ghost-button full" onClick={saveStatusAndNotes} disabled={busy}>Save lead notes/status</button>
      </section>

      {message ? <div className={message.includes('saved') || message.includes('scheduled') || message.includes('Saved') || message.includes('Quote') ? 'success-box' : 'error-box'}>{message}</div> : null}
    </div>
  );
}


function QuoteDetail({ quote, lead, jobs, settings, refreshData, invoices = [], invoiceItems = [], quoteEvents = [] }) {
  const [status, setStatus] = useState(quote.status || 'draft');
  const [quoteNotes, setQuoteNotes] = useState(quote.quote_notes || '');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [manualPaymentMethod, setManualPaymentMethod] = useState('cash');
  const [manualPaymentAmount, setManualPaymentAmount] = useState('');
  const [manualPaymentNote, setManualPaymentNote] = useState('');

  useEffect(() => {
    setStatus(quote.status || 'draft');
    setQuoteNotes(quote.quote_notes || '');
    setScheduledDate('');
    setScheduledTime('');
    setManualPaymentMethod(quote.payment_method || 'cash');
    setManualPaymentAmount(quote.amount_paid_cents ? String(quote.amount_paid_cents / 100) : String((getQuoteAmount(quote) || 0) / 100));
    setManualPaymentNote(quote.payment_notes || '');
    setMessage('');
  }, [quote.id]);

  const linkedJobs = jobs.filter((job) => job.quote_id === quote.id || job.lead_id === quote.lead_id);
  const quoteText = buildQuoteMessage(quote, lead, settings);
  const subject = `${settings?.business_name || DEFAULT_SETTINGS.business_name} quote ${getQuoteNumber(quote)}`;
  const quoteInvoice = getQuoteInvoice(quote, invoices);
  const quoteInvoiceItems = quoteInvoice ? invoiceItems.filter((item) => item.invoice_id === quoteInvoice.id) : [];
  const quotePaymentEvents = quoteEvents.filter((event) => event.quote_id === quote.id);

  async function saveQuotePatch(patch, successMessage = 'Quote saved.') {
    setBusy(true);
    setMessage('');
    const { error } = await supabase.from('lawncare_quotes').update(patch).eq('id', quote.id);
    setBusy(false);
    if (error) setMessage(error.message);
    else {
      setMessage(successMessage);
      await refreshData(false);
    }
  }

  async function copyQuoteText(nextStatus = null) {
    try {
      await navigator.clipboard.writeText(quoteText);
      setMessage('Quote text copied.');
    } catch {
      setMessage(quoteText);
    }
    if (nextStatus) {
      const patch = {
        status: nextStatus,
        sent_at: nextStatus === 'sent' ? new Date().toISOString() : quote.sent_at || null,
      };
      await saveQuotePatch(patch, 'Quote copied and marked sent.');
    }
  }

  async function markSent() {
    await saveQuotePatch({ status: 'sent', sent_at: new Date().toISOString(), quote_notes: quoteNotes || null }, 'Quote marked sent.');
  }

  async function markAccepted() {
    await saveQuotePatch({ status: 'accepted', accepted_at: new Date().toISOString(), quote_notes: quoteNotes || null }, 'Quote marked accepted.');
    if (lead) await supabase.from('lawncare_leads').update({ status: 'quoted', quoted_price_cents: getQuoteAmount(quote), quote_notes: quoteNotes || quote.quote_notes || quote.quote_reason }).eq('id', lead.id);
    await refreshData(false);
  }

  async function markDeclined() {
    await saveQuotePatch({ status: 'declined', declined_at: new Date().toISOString(), quote_notes: quoteNotes || null }, 'Quote marked declined.');
  }

  async function logQuotePaymentEvent(payload) {
    await supabase.from('lawncare_quote_payment_events').insert({
      quote_id: quote.id,
      lead_id: lead?.id || quote.lead_id || null,
      ...payload,
    });
  }

  async function createInvoiceFromQuote({ markSent = false, openEmail = false, markPaid = false, manualMethod = null, acceptQuote = false } = {}) {
    if (!lead) {
      setMessage('This quote is missing its lead.');
      return null;
    }

    if (openEmail && !lead.email) {
      setMessage('This lead does not have an email address yet. Add one before emailing an invoice.');
      return null;
    }

    setBusy(true);
    setMessage('');

    const amount = getQuoteAmount(quote);
    const dueDate = addDaysIso(null, 7);
    const method = manualMethod || manualPaymentMethod || null;
    const paidAmount = markPaid ? (dollarsToCents(manualPaymentAmount || String(amount / 100)) || amount) : 0;
    let invoice = quoteInvoice;
    let itemsForMessage = quoteInvoiceItems;

    if (!invoice) {
      const invoicePayload = {
        quote_id: quote.id,
        lead_id: lead.id,
        invoice_number: makeInvoiceNumber(),
        customer_name: getFullName(lead),
        phone: lead.phone || null,
        email: lead.email || null,
        street_address: lead.street_address || null,
        city: lead.city || null,
        zip_code: lead.zip_code || null,
        service_date: null,
        due_date: dueDate,
        subtotal_cents: amount,
        discount_cents: 0,
        total_cents: amount,
        amount_paid_cents: paidAmount,
        status: markPaid ? 'paid' : markSent ? 'sent' : 'draft',
        payment_method: markPaid ? method : null,
        payment_reference: markPaid ? manualPaymentNote || null : null,
        paid_at: markPaid ? new Date().toISOString() : null,
        notes: quote.quote_notes || quote.quote_reason || null,
        internal_notes: markPaid ? 'Created from accepted quote and marked paid manually.' : 'Created from accepted quote.',
      };

      const { data: invoiceData, error: invoiceError } = await supabase
        .from('lawncare_invoices')
        .insert(invoicePayload)
        .select('*')
        .single();

      if (invoiceError) {
        setBusy(false);
        setMessage(invoiceError.message);
        return null;
      }

      invoice = invoiceData;
      const serviceText = normalizeServices(lead.services_requested).map(labelize).join(', ') || 'Lawn care service';
      const itemPayload = {
        invoice_id: invoice.id,
        description: `${serviceText} — ${getQuoteNumber(quote)}`,
        quantity: 1,
        unit_price_cents: amount,
        line_total_cents: amount,
        sort_order: 1,
      };
      const { data: itemData, error: itemError } = await supabase
        .from('lawncare_invoice_items')
        .insert(itemPayload)
        .select('*')
        .single();

      if (itemError) {
        setBusy(false);
        setMessage(itemError.message);
        return null;
      }
      itemsForMessage = [itemData];
    } else if (markPaid || markSent) {
      const invoicePatch = markPaid
        ? {
            status: 'paid',
            payment_method: method,
            payment_reference: manualPaymentNote || null,
            amount_paid_cents: paidAmount,
            paid_at: new Date().toISOString(),
          }
        : { status: 'sent' };
      const { error: invoiceUpdateError } = await supabase.from('lawncare_invoices').update(invoicePatch).eq('id', invoice.id);
      if (invoiceUpdateError) {
        setBusy(false);
        setMessage(invoiceUpdateError.message);
        return null;
      }
      invoice = { ...invoice, ...invoicePatch };
    }

    const quotePatch = markPaid
      ? {
          status: 'accepted',
          accepted_at: quote.accepted_at || new Date().toISOString(),
          payment_type: 'manual',
          payment_status: 'paid',
          payment_method: method,
          amount_paid_cents: paidAmount,
          paid_at: new Date().toISOString(),
          payment_notes: manualPaymentNote || null,
          invoice_id: invoice.id,
        }
      : {
          status: acceptQuote ? 'accepted' : markSent ? (quote.status === 'accepted' ? 'accepted' : 'sent') : (quote.status === 'accepted' ? 'accepted' : quote.status || 'draft'),
          payment_type: 'invoice_email',
          payment_status: markSent ? 'invoice_sent' : 'invoice_draft',
          payment_method: null,
          invoice_id: invoice.id,
          sent_at: markSent ? new Date().toISOString() : quote.sent_at || null,
          accepted_at: acceptQuote ? (quote.accepted_at || new Date().toISOString()) : quote.accepted_at || null,
        };

    const { error: quoteError } = await supabase.from('lawncare_quotes').update(quotePatch).eq('id', quote.id);
    if (quoteError) {
      setBusy(false);
      setMessage(quoteError.message);
      return null;
    }

    if (lead) {
      await supabase.from('lawncare_leads').update({ status: markPaid ? 'won' : markSent ? 'quoted' : 'quoted', quoted_price_cents: amount }).eq('id', lead.id);
    }

    await logQuotePaymentEvent({
      event_type: markPaid ? 'manual_payment_recorded' : markSent ? 'invoice_emailed' : 'invoice_created',
      payment_type: markPaid ? 'manual' : 'invoice_email',
      payment_method: markPaid ? method : null,
      amount_cents: markPaid ? paidAmount : amount,
      invoice_id: invoice.id,
      event_note: markPaid ? (manualPaymentNote || `Manual ${labelize(method)} payment recorded.`) : (markSent ? 'Invoice email opened from quote.' : 'Invoice draft created from quote.'),
    });

    setBusy(false);
    setMessage(markPaid ? 'Manual payment recorded and quote marked paid.' : markSent ? 'Invoice created and email draft opened.' : 'Invoice draft created from quote.');
    await refreshData(false);

    if (openEmail) {
      window.location.href = mailtoHref(lead.email, buildInvoiceEmailSubject(invoice, settings), buildInvoiceEmailBody(invoice, itemsForMessage, settings));
    }

    return invoice;
  }

  async function acceptAndEmailInvoice() {
    await createInvoiceFromQuote({ markSent: true, openEmail: true, acceptQuote: true });
  }

  async function recordManualPayment() {
    if (!manualPaymentMethod) {
      setMessage('Choose a payment method first.');
      return;
    }
    await createInvoiceFromQuote({ markPaid: true, manualMethod: manualPaymentMethod });
  }

  async function convertQuoteToJob() {
    if (!lead) {
      setMessage('This quote is missing its lead.');
      return;
    }
    if (!scheduledDate) {
      setMessage('Pick a scheduled date first.');
      return;
    }
    setBusy(true);
    setMessage('');
    const amount = getQuoteAmount(quote);
    const { error: jobError } = await supabase.from('lawncare_jobs').insert({
      lead_id: lead.id,
      quote_id: quote.id,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime || null,
      customer_name: getFullName(lead),
      phone: lead.phone,
      street_address: lead.street_address,
      city: lead.city,
      zip_code: lead.zip_code,
      services: normalizeServices(lead.services_requested),
      job_notes: [lead.gate_or_pet_notes, lead.additional_notes, quoteNotes || quote.quote_notes].filter(Boolean).join('\n'),
      quoted_price_cents: amount,
      final_price_cents: amount,
      job_status: 'scheduled',
      payment_status: 'unpaid',
    });
    if (jobError) {
      setBusy(false);
      setMessage(jobError.message);
      return;
    }
    await supabase.from('lawncare_quotes').update({ status: 'accepted', accepted_at: quote.accepted_at || new Date().toISOString() }).eq('id', quote.id);
    await supabase.from('lawncare_leads').update({ status: 'scheduled', quoted_price_cents: amount }).eq('id', lead.id);
    setBusy(false);
    setMessage('Accepted quote converted to scheduled job. Add it to a route from Routes.');
    await refreshData(false);
  }

  if (!lead) {
    return <EmptyState title="Missing lead" body="This quote exists, but its matching lead was not found." />;
  }

  return (
    <div className="lead-detail quote-detail">
      <div className="detail-header">
        <div>
          <p className="eyebrow">Quote Detail</p>
          <h2>{getQuoteNumber(quote)}</h2>
          <p>{getFullName(lead)} · {buildAddress(lead)}</p>
        </div>
        <span className={classNames('invoice-status', quoteStatusTone(quote.status))}>{labelize(quote.status || 'draft')}</span>
      </div>

      <div className="invoice-total-card">
        <span>Quote amount</span>
        <strong>{centsToDollars(getQuoteAmount(quote))}</strong>
        <small>Fair range: {centsToDollars(quote.min_price_cents)} – {centsToDollars(quote.max_price_cents)}</small>
      </div>

      <section className="mini-section">
        <h3>Customer</h3>
        <div className="info-grid">
          <div><span>Phone</span><strong>{lead.phone || '—'}</strong></div>
          <div><span>Email</span><strong>{lead.email || '—'}</strong></div>
          <div><span>Frequency</span><strong>{labelize(quote.frequency || lead.requested_frequency)}</strong></div>
          <div><span>Services</span><strong>{normalizeServices(lead.services_requested).map(labelize).join(', ') || '—'}</strong></div>
        </div>
      </section>

      <section className="mini-section note-box">
        <h3>Quote reason</h3>
        <p>{quote.quote_reason || 'No quote reason saved.'}</p>
      </section>

      <section className="mini-section">
        <h3>Send / track quote</h3>
        <label>Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            {QUOTE_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{labelize(option)}</option>)}
          </select>
        </label>
        <label>Quote notes
          <textarea value={quoteNotes} onChange={(event) => setQuoteNotes(event.target.value)} placeholder="Customer-facing quote notes." />
        </label>
        <div className="button-row">
          <button className="primary-button compact" type="button" onClick={() => saveQuotePatch({ status, quote_notes: quoteNotes || null }, 'Quote saved.')} disabled={busy}>Save quote</button>
          <button className="secondary-button compact" type="button" onClick={markSent} disabled={busy}>Mark sent</button>
          <button className="secondary-button compact" type="button" onClick={markAccepted} disabled={busy}>Mark accepted</button>
          <button className="ghost-button compact" type="button" onClick={markDeclined} disabled={busy}>Declined</button>
        </div>
        <div className="button-row">
          <button className="ghost-button compact" type="button" onClick={() => copyQuoteText('sent')}>Copy + mark sent</button>
          {lead.phone ? <a className="ghost-button compact" href={smsHref(lead.phone, quoteText)} onClick={() => markSent()}>Open text</a> : null}
          {lead.email ? <a className="ghost-button compact" href={mailtoHref(lead.email, subject, quoteText)} onClick={() => markSent()}>Open email</a> : null}
        </div>
      </section>

      <section className="mini-section payment-path-box">
        <div className="photo-section-header">
          <h3>Payment path</h3>
          <span>{paymentPathLabel(quote)}{quote.payment_status ? ` · ${labelize(quote.payment_status)}` : ''}</span>
        </div>
        <p className="small-muted">Use free email invoicing when the customer approves, or record cash/Cash App/Venmo/etc. manually when they pay another way.</p>
        {quoteInvoice ? (
          <div className="invoice-mini-panel">
            <span className={classNames('invoice-status', invoiceStatusTone(quoteInvoice.status))}>{labelize(quoteInvoice.status)} · {quoteInvoice.invoice_number}</span>
            <strong>{centsToDollars(getInvoiceTotal(quoteInvoice, quoteInvoiceItems))}</strong>
          </div>
        ) : <p className="small-muted">No invoice has been created from this quote yet.</p>}
        <div className="button-row">
          <button className="secondary-button compact" type="button" onClick={() => createInvoiceFromQuote()} disabled={busy}>Create invoice draft</button>
          <button className="primary-button compact" type="button" onClick={() => createInvoiceFromQuote({ markSent: true, openEmail: true })} disabled={busy || !lead.email}>Email invoice</button>
          <button className="primary-button compact" type="button" onClick={acceptAndEmailInvoice} disabled={busy || !lead.email}>Accept + email invoice</button>
        </div>
        {!lead.email ? <p className="small-muted">Add an email to this lead before emailing an invoice.</p> : null}
        <div className="two-col">
          <label>Manual payment method
            <select value={manualPaymentMethod} onChange={(event) => setManualPaymentMethod(event.target.value)}>
              {PAYMENT_METHOD_OPTIONS.filter((option) => option !== 'card').map((option) => <option key={option} value={option}>{labelize(option)}</option>)}
              <option value="card">Card</option>
            </select>
          </label>
          <label>Amount received
            <input value={manualPaymentAmount} onChange={(event) => setManualPaymentAmount(event.target.value)} placeholder={`${getQuoteAmount(quote) / 100}`} inputMode="decimal" />
          </label>
        </div>
        <label>Manual payment note
          <textarea value={manualPaymentNote} onChange={(event) => setManualPaymentNote(event.target.value)} placeholder="Example: Paid Cash App after quote approval." />
        </label>
        <button className="secondary-button full" type="button" onClick={recordManualPayment} disabled={busy}>Record cash / Cash App / manual payment</button>
        {quotePaymentEvents.length ? (
          <div className="quote-history compact-history">
            {quotePaymentEvents.slice().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).map((event) => (
              <div className="quote-history-row" key={event.id}>
                <div>
                  <strong>{labelize(event.event_type)}</strong>
                  <p className="small-muted">{formatDateTime(event.created_at)} · {event.payment_type ? labelize(event.payment_type) : 'Payment'}{event.payment_method ? ` · ${labelize(event.payment_method)}` : ''}{event.amount_cents ? ` · ${centsToDollars(event.amount_cents)}` : ''}</p>
                  {event.event_note ? <p className="small-muted">{event.event_note}</p> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="mini-section">
        <h3>Convert quote to job</h3>
        <p className="small-muted">When the customer approves, schedule the job here. It will appear under Routes as an unrouted job.</p>
        <div className="two-col">
          <label>Date<input type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} /></label>
          <label>Time note<input value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} placeholder="Morning / after 3pm" /></label>
        </div>
        <button className="primary-button full" type="button" onClick={convertQuoteToJob} disabled={busy}>Accept + schedule job</button>
        {linkedJobs.length ? <p className="small-muted">Related jobs: {linkedJobs.map((job) => `${formatDate(`${job.scheduled_date}T12:00:00`)} · ${labelize(job.job_status)}`).join(' | ')}</p> : null}
      </section>

      <section className="mini-section quote-preview-box">
        <h3>Quote text preview</h3>
        <pre>{quoteText}</pre>
      </section>

      {message ? <div className={message.includes('saved') || message.includes('sent') || message.includes('accepted') || message.includes('copied') || message.includes('scheduled') ? 'success-box' : 'error-box'}>{message}</div> : null}
    </div>
  );
}

function Quotes({ quotes, leads, jobs, settings, refreshData, invoices = [], invoiceItems = [], quoteEvents = [] }) {
  const [selectedQuoteId, setSelectedQuoteId] = useState(quotes[0]?.id || null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    if (!selectedQuoteId && quotes[0]) setSelectedQuoteId(quotes[0].id);
  }, [quotes, selectedQuoteId]);

  const leadById = useMemo(() => Object.fromEntries(leads.map((lead) => [lead.id, lead])), [leads]);
  const filtered = quotes.filter((quote) => {
    const lead = leadById[quote.lead_id];
    const haystack = [getQuoteNumber(quote), quote.status, quote.frequency, quote.quote_notes, quote.quote_reason, lead ? getFullName(lead) : '', lead ? buildAddress(lead) : '', lead?.phone, lead?.email].join(' ').toLowerCase();
    return haystack.includes(search.toLowerCase()) && (statusFilter === 'all' || quote.status === statusFilter);
  });
  const selectedQuote = quotes.find((quote) => quote.id === selectedQuoteId) || filtered[0] || null;
  const selectedLead = selectedQuote ? leadById[selectedQuote.lead_id] : null;
  const sentCount = quotes.filter((quote) => quote.status === 'sent').length;
  const acceptedCount = quotes.filter((quote) => quote.status === 'accepted').length;
  const openValue = quotes.filter((quote) => ['draft', 'sent'].includes(quote.status || 'draft')).reduce((sum, quote) => sum + getQuoteAmount(quote), 0);

  return (
    <main className="app-grid quotes-grid">
      <section className="main-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Quote Pipeline</p>
            <h1>Saved quotes and approvals</h1>
          </div>
          <button className="ghost-button" onClick={refreshData}>Refresh</button>
        </div>

        <div className="stats-grid">
          <StatCard label="Quotes" value={quotes.length} hint="Saved from leads" />
          <StatCard label="Sent" value={sentCount} hint="Waiting on customer" />
          <StatCard label="Accepted" value={acceptedCount} hint="Ready to schedule" />
          <StatCard label="Open Value" value={centsToDollars(openValue)} hint="Draft + sent" />
        </div>

        <div className="filter-row">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search quote, customer, address…" />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All quote statuses</option>
            {QUOTE_STATUS_OPTIONS.map((status) => <option value={status} key={status}>{labelize(status)}</option>)}
          </select>
        </div>

        <div className="lead-list">
          {filtered.length ? filtered.map((quote) => {
            const lead = leadById[quote.lead_id];
            return (
              <button key={quote.id} className={classNames('lead-card', selectedQuote?.id === quote.id && 'selected')} onClick={() => setSelectedQuoteId(quote.id)}>
                <div className="lead-card-top">
                  <div>
                    <h3>{getQuoteNumber(quote)}</h3>
                    <p>{lead ? `${getFullName(lead)} · ${buildAddress(lead) || 'No address'}` : 'Lead missing'}</p>
                  </div>
                  <span className={classNames('invoice-status', quoteStatusTone(quote.status))}>{labelize(quote.status || 'draft')}</span>
                </div>
                <div className="pill-row">
                  <span>{centsToDollars(getQuoteAmount(quote))}</span>
                  <span>{quote.created_at ? formatDateTime(quote.created_at) : 'No date'}</span>
                  {quote.valid_until ? <span>Valid until {formatDate(`${quote.valid_until}T12:00:00`)}</span> : null}
                </div>
                <p className="small-muted">{quote.quote_reason || 'No quote reason saved.'}</p>
              </button>
            );
          }) : <EmptyState title="No quotes yet" body="Open a lead and save a quote. It will appear here for sending, acceptance, and scheduling." />}
        </div>
      </section>

      <aside className="detail-panel">
        {selectedQuote ? (
          <QuoteDetail quote={selectedQuote} lead={selectedLead} jobs={jobs} settings={settings} refreshData={refreshData} invoices={invoices} invoiceItems={invoiceItems} quoteEvents={quoteEvents} />
        ) : (
          <EmptyState title="Select a quote" body="Open a quote to send it, mark accepted, or convert it into a scheduled job." />
        )}
      </aside>
    </main>
  );
}

function Routes({ jobs, routes, routeAssignments, routeJobs, teamMembers, invoices, invoiceItems, settings, refreshData }) {
  const [savingId, setSavingId] = useState(null);
  const [newRoute, setNewRoute] = useState({ name: '', route_date: '', notes: '' });
  const [message, setMessage] = useState('');

  const jobById = useMemo(() => Object.fromEntries(jobs.map((job) => [job.id, job])), [jobs]);
  const memberById = useMemo(() => Object.fromEntries(teamMembers.map((member) => [member.id, member])), [teamMembers]);
  const routedJobIds = useMemo(() => new Set(routeJobs.map((item) => item.job_id)), [routeJobs]);
  const availableJobs = jobs.filter((job) => !routedJobIds.has(job.id) && job.job_status !== 'cancelled');

  async function createRoute(event) {
    event.preventDefault();
    setMessage('');
    if (!newRoute.name || !newRoute.route_date) {
      setMessage('Route name and date are required.');
      return;
    }
    const { error } = await supabase.from('lawncare_routes').insert({
      name: newRoute.name,
      route_date: newRoute.route_date,
      notes: newRoute.notes || null,
      status: 'draft',
    });
    if (error) setMessage(error.message);
    else {
      setNewRoute({ name: '', route_date: '', notes: '' });
      setMessage('Route created.');
      await refreshData(false);
    }
  }

  async function updateRoute(route, patch) {
    setSavingId(route.id);
    const { error } = await supabase.from('lawncare_routes').update(patch).eq('id', route.id);
    setSavingId(null);
    if (error) alert(error.message);
    await refreshData(false);
  }

  async function assignMember(routeId, teamMemberId) {
    if (!teamMemberId) return;
    const { error } = await supabase.from('lawncare_route_assignments').insert({ route_id: routeId, team_member_id: teamMemberId });
    if (error && !String(error.message).includes('duplicate')) alert(error.message);
    await refreshData(false);
  }

  async function removeAssignment(assignmentId) {
    const { error } = await supabase.from('lawncare_route_assignments').delete().eq('id', assignmentId);
    if (error) alert(error.message);
    await refreshData(false);
  }

  async function addJobToRoute(routeId, jobId) {
    if (!jobId) return;
    const existingCount = routeJobs.filter((item) => item.route_id === routeId).length;
    const { error } = await supabase.from('lawncare_route_jobs').insert({ route_id: routeId, job_id: jobId, stop_order: existingCount + 1 });
    if (error && !String(error.message).includes('duplicate')) alert(error.message);
    await refreshData(false);
  }

  async function removeRouteJob(routeJobId) {
    const { error } = await supabase.from('lawncare_route_jobs').delete().eq('id', routeJobId);
    if (error) alert(error.message);
    await refreshData(false);
  }

  async function updateStopOrder(routeJobId, stopOrder) {
    const { error } = await supabase.from('lawncare_route_jobs').update({ stop_order: Number(stopOrder) || 0 }).eq('id', routeJobId);
    if (error) alert(error.message);
    await refreshData(false);
  }

  async function updateJob(job, patch) {
    setSavingId(job.id);
    const { error } = await supabase.from('lawncare_jobs').update(patch).eq('id', job.id);
    setSavingId(null);
    if (error) alert(error.message);
    await refreshData(false);
  }


  async function createInvoiceFromJob(job) {
    const existing = getJobInvoice(job, invoices);
    if (existing) {
      setMessage(`Invoice already exists: ${existing.invoice_number}`);
      return;
    }

    setSavingId(job.id);
    setMessage('');
    const amount = Number(job.final_price_cents || job.quoted_price_cents || 0);
    const invoicePayload = {
      job_id: job.id,
      quote_id: job.quote_id || null,
      lead_id: job.lead_id || null,
      invoice_number: makeInvoiceNumber(),
      customer_name: job.customer_name || 'Customer',
      phone: job.phone || null,
      street_address: job.street_address || null,
      city: job.city || null,
      zip_code: job.zip_code || null,
      service_date: job.scheduled_date || new Date().toISOString().slice(0, 10),
      due_date: addDaysIso(job.scheduled_date, 7),
      subtotal_cents: amount,
      discount_cents: 0,
      total_cents: amount,
      amount_paid_cents: 0,
      status: 'draft',
      notes: 'Thank you for your business.',
    };

    const { data: invoice, error: invoiceError } = await supabase
      .from('lawncare_invoices')
      .insert(invoicePayload)
      .select('*')
      .single();

    if (invoiceError) {
      setSavingId(null);
      setMessage(`Invoice error: ${invoiceError.message}`);
      return;
    }

    const serviceText = normalizeServices(job.services).map(labelize).join(', ') || 'Lawn care service';
    const { error: itemError } = await supabase.from('lawncare_invoice_items').insert({
      invoice_id: invoice.id,
      description: serviceText,
      quantity: 1,
      unit_price_cents: amount,
      line_total_cents: amount,
      sort_order: 1,
    });

    if (itemError) {
      setSavingId(null);
      setMessage(`Invoice item error: ${itemError.message}`);
      return;
    }

    await supabase.from('lawncare_jobs').update({ payment_status: 'invoiced' }).eq('id', job.id);
    if (job.quote_id) {
      await supabase.from('lawncare_quotes').update({ payment_type: 'invoice_email', payment_status: 'invoice_draft', invoice_id: invoice.id }).eq('id', job.quote_id);
      await supabase.from('lawncare_quote_payment_events').insert({
        quote_id: job.quote_id,
        lead_id: job.lead_id || null,
        invoice_id: invoice.id,
        event_type: 'invoice_created',
        payment_type: 'invoice_email',
        amount_cents: amount,
        event_note: 'Invoice draft created from scheduled job.'
      });
    }
    setSavingId(null);
    setMessage(`Invoice created: ${invoice.invoice_number}`);
    await refreshData(false);
  }

  const sortedRoutes = [...routes].sort((a, b) => String(a.route_date || '').localeCompare(String(b.route_date || '')) || String(a.name).localeCompare(String(b.name)));

  return (
    <main className="page-shell">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Route Operations</p>
          <h1>Build routes and assign your crew</h1>
        </div>
        <button className="ghost-button" onClick={refreshData}>Refresh</button>
      </div>

      <form className="route-builder card-section" onSubmit={createRoute}>
        <div>
          <h2>Create route</h2>
          <p className="small-muted">Example: Monday Racetrack Route, Shalimar Bi-weekly Route, or Mary Esther Cleanup Day.</p>
        </div>
        <div className="three-col">
          <label>Route name<input value={newRoute.name} onChange={(event) => setNewRoute((current) => ({ ...current, name: event.target.value }))} placeholder="Monday Racetrack Route" /></label>
          <label>Date<input type="date" value={newRoute.route_date} onChange={(event) => setNewRoute((current) => ({ ...current, route_date: event.target.value }))} /></label>
          <label>Notes<input value={newRoute.notes} onChange={(event) => setNewRoute((current) => ({ ...current, notes: event.target.value }))} placeholder="Small yards first" /></label>
        </div>
        <button className="primary-button">Create route</button>
        {message ? <div className={message.includes('created') ? 'success-box' : 'error-box'}>{message}</div> : null}
      </form>

      <div className="route-layout">
        <section className="route-list-column">
          {sortedRoutes.length ? sortedRoutes.map((route) => {
            const assignments = routeAssignments.filter((item) => item.route_id === route.id);
            const stops = routeJobs
              .filter((item) => item.route_id === route.id)
              .sort((a, b) => Number(a.stop_order || 0) - Number(b.stop_order || 0));
            return (
              <article className="route-card-large" key={route.id}>
                <div className="route-card-header">
                  <div>
                    <p className="eyebrow">{formatDate(`${route.route_date}T12:00:00`)}</p>
                    <h2>{route.name}</h2>
                    {route.notes ? <p className="small-muted">{route.notes}</p> : null}
                  </div>
                  <select value={route.status || 'draft'} onChange={(event) => updateRoute(route, { status: event.target.value })} disabled={savingId === route.id}>
                    {ROUTE_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{labelize(option)}</option>)}
                  </select>
                </div>

                <div className="mini-section soft">
                  <div className="subheading-row"><h3>Assigned crew</h3><span>{assignments.length}</span></div>
                  <div className="chip-list">
                    {assignments.map((assignment) => (
                      <span className="chip removable" key={assignment.id}>
                        {memberDisplayName(memberById[assignment.team_member_id])}
                        <button onClick={() => removeAssignment(assignment.id)} type="button">×</button>
                      </span>
                    ))}
                    {!assignments.length ? <p className="small-muted">No crew assigned yet.</p> : null}
                  </div>
                  <div className="inline-control">
                    <select defaultValue="" onChange={(event) => { assignMember(route.id, event.target.value); event.target.value = ''; }}>
                      <option value="">Assign team member…</option>
                      {teamMembers.filter((member) => member.status === 'active').map((member) => <option key={member.id} value={member.id}>{memberDisplayName(member)} · {labelize(member.role)}</option>)}
                    </select>
                  </div>
                </div>

                <div className="mini-section soft">
                  <div className="subheading-row"><h3>Stops</h3><span>{stops.length}</span></div>
                  <div className="stop-list">
                    {stops.map((routeJob) => {
                      const job = jobById[routeJob.job_id];
                      if (!job) return null;
                      return (
                        <article className="stop-card" key={routeJob.id}>
                          <input className="stop-order" value={routeJob.stop_order ?? 0} onChange={(event) => updateStopOrder(routeJob.id, event.target.value)} aria-label="Stop order" />
                          <div>
                            <strong>{job.customer_name}</strong>
                            <p>{buildAddress(job)}</p>
                            <div className="pill-row"><span>{labelize(job.job_status)}</span><span>{centsToDollars(job.final_price_cents || job.quoted_price_cents)}</span></div>
                            {(() => {
                              const invoice = getJobInvoice(job, invoices);
                              const items = invoice ? invoiceItems.filter((item) => item.invoice_id === invoice.id) : [];
                              return invoice ? (
                                <div className="invoice-mini-panel">
                                  <span className={classNames('invoice-status', invoiceStatusTone(invoice.status))}>{labelize(invoice.status)} · {invoice.invoice_number}</span>
                                  <strong>{centsToDollars(getInvoiceTotal(invoice, items))}</strong>
                                </div>
                              ) : null;
                            })()}
                          </div>
                          <div className="stacked-actions">
                            <button className="secondary-button compact" type="button" onClick={() => createInvoiceFromJob(job)} disabled={savingId === job.id || Boolean(getJobInvoice(job, invoices))}>Invoice</button>
                            <button className="ghost-button compact" type="button" onClick={() => removeRouteJob(routeJob.id)}>Remove</button>
                          </div>
                        </article>
                      );
                    })}
                    {!stops.length ? <p className="small-muted">No stops on this route yet.</p> : null}
                  </div>
                  <div className="inline-control">
                    <select defaultValue="" onChange={(event) => { addJobToRoute(route.id, event.target.value); event.target.value = ''; }}>
                      <option value="">Add scheduled job…</option>
                      {availableJobs.map((job) => <option key={job.id} value={job.id}>{job.customer_name} · {buildAddress(job)}</option>)}
                    </select>
                  </div>
                </div>
              </article>
            );
          }) : <EmptyState title="No routes yet" body="Create your first route, add scheduled jobs, and assign it to a crew member." />}
        </section>

        <aside className="route-side-panel">
          <h2>Unrouted jobs</h2>
          <p className="small-muted">These jobs are scheduled but not placed on a route yet.</p>
          <div className="job-mini-list">
            {availableJobs.length ? availableJobs.map((job) => (
              <article className="job-mini-card" key={job.id}>
                <strong>{job.customer_name}</strong>
                <p>{buildAddress(job)}</p>
                <div className="two-col">
                  <label>
                    Job status
                    <select value={job.job_status || 'scheduled'} onChange={(event) => updateJob(job, { job_status: event.target.value })} disabled={savingId === job.id}>
                      {JOB_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{labelize(option)}</option>)}
                    </select>
                  </label>
                  <label>
                    Payment
                    <select value={job.payment_status || 'unpaid'} onChange={(event) => updateJob(job, { payment_status: event.target.value })} disabled={savingId === job.id}>
                      {PAYMENT_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{labelize(option)}</option>)}
                    </select>
                  </label>
                </div>
                {(() => {
                  const invoice = getJobInvoice(job, invoices);
                  const items = invoice ? invoiceItems.filter((item) => item.invoice_id === invoice.id) : [];
                  return invoice ? (
                    <div className="invoice-mini-panel">
                      <span className={classNames('invoice-status', invoiceStatusTone(invoice.status))}>{labelize(invoice.status)} · {invoice.invoice_number}</span>
                      <strong>{centsToDollars(getInvoiceTotal(invoice, items))}</strong>
                    </div>
                  ) : (
                    <button className="secondary-button full" type="button" onClick={() => createInvoiceFromJob(job)} disabled={savingId === job.id}>Generate invoice</button>
                  );
                })()}
              </article>
            )) : <p className="small-muted">Everything is routed.</p>}
          </div>
        </aside>
      </div>
    </main>
  );
}


function buildInvoiceMessage(invoice, items, settings) {
  const total = getInvoiceTotal(invoice, items);
  const lines = items.map((item) => `- ${item.description}: ${centsToDollars(item.line_total_cents)}`).join('\n');
  return `${settings?.business_name || 'Lawn Care'}\nInvoice ${invoice.invoice_number}\n\nCustomer: ${invoice.customer_name}\nService date: ${invoice.service_date ? formatDate(`${invoice.service_date}T12:00:00`) : '—'}\nAddress: ${buildAddress(invoice) || '—'}\n\n${lines || '- Lawn care service'}\n\nTotal due: ${centsToDollars(total)}\nDue date: ${invoice.due_date ? formatDate(`${invoice.due_date}T12:00:00`) : 'Upon receipt'}\n\nThank you!`;
}

function buildInvoiceEmailSubject(invoice, settings) {
  return `${settings?.business_name || 'Lawn Care'} invoice ${invoice.invoice_number}`;
}

function buildInvoiceEmailBody(invoice, items, settings) {
  const business = settings?.business_name || 'Lawn Care';
  const phone = settings?.phone || '';
  const message = buildInvoiceMessage(invoice, items, settings);
  const payLine = invoice.payment_method
    ? `\n\nPayment method recorded: ${labelize(invoice.payment_method)}`
    : '\n\nYou can reply to this email or text me when payment is ready. Cash, Cash App, Venmo, Zelle, check, or card can be tracked in the manager.';
  return `Hi ${invoice.customer_name || 'there'},\n\nThanks again for choosing ${business}. Here is your invoice:\n\n${message}${payLine}${phone ? `\n\nQuestions? Call/text ${phone}.` : ''}`;
}

function getQuoteInvoice(quote, invoices = []) {
  if (!quote) return null;
  return invoices.find((invoice) => invoice.id === quote.invoice_id || invoice.quote_id === quote.id) || null;
}

function mapPaymentMethodToJobStatus(method) {
  const value = String(method || '').toLowerCase();
  if (value === 'cash') return 'paid_cash';
  if (value === 'cash_app') return 'paid_cash_app';
  if (value === 'venmo') return 'paid_venmo';
  if (value === 'card') return 'paid_card';
  return 'invoiced';
}

function paymentPathLabel(quote) {
  if (quote?.payment_type === 'manual') return 'Manual payment';
  if (quote?.payment_type === 'invoice_email') return 'Email invoice';
  return 'Not selected';
}


function InvoiceDetail({ invoice, items, settings, refreshData, jobs }) {
  const [status, setStatus] = useState(invoice.status || 'draft');
  const [paymentMethod, setPaymentMethod] = useState(invoice.payment_method || '');
  const [amountPaid, setAmountPaid] = useState(invoice.amount_paid_cents ? String(invoice.amount_paid_cents / 100) : '');
  const [notes, setNotes] = useState(invoice.notes || '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState({ description: '', quantity: '1', unitPrice: '' });

  useEffect(() => {
    setStatus(invoice.status || 'draft');
    setPaymentMethod(invoice.payment_method || '');
    setAmountPaid(invoice.amount_paid_cents ? String(invoice.amount_paid_cents / 100) : '');
    setNotes(invoice.notes || '');
    setMessage('');
    setNewItem({ description: '', quantity: '1', unitPrice: '' });
  }, [invoice.id]);

  const total = getInvoiceTotal(invoice, items);
  const balance = getInvoiceBalance(invoice, items);
  const linkedJob = jobs.find((job) => job.id === invoice.job_id);

  async function recalcInvoiceTotals(nextItems = items) {
    const subtotal = nextItems.reduce((sum, item) => sum + Number(item.line_total_cents || 0), 0);
    const discount = Number(invoice.discount_cents || 0);
    await supabase
      .from('lawncare_invoices')
      .update({ subtotal_cents: subtotal, total_cents: Math.max(0, subtotal - discount) })
      .eq('id', invoice.id);
  }

  async function saveInvoice() {
    setBusy(true);
    setMessage('');
    const paidCents = dollarsToCents(amountPaid || '0') || 0;
    const patch = {
      status,
      payment_method: paymentMethod || null,
      amount_paid_cents: paidCents,
      notes: notes || null,
      paid_at: status === 'paid' ? new Date().toISOString() : invoice.paid_at || null,
    };

    const { error } = await supabase.from('lawncare_invoices').update(patch).eq('id', invoice.id);
    if (!error && linkedJob) {
      const paymentStatus = status === 'paid'
        ? paymentMethod === 'cash' ? 'paid_cash' : paymentMethod === 'cash_app' ? 'paid_cash_app' : paymentMethod === 'venmo' ? 'paid_venmo' : paymentMethod === 'card' ? 'paid_card' : 'invoiced'
        : 'invoiced';
      await supabase.from('lawncare_jobs').update({ payment_status: paymentStatus }).eq('id', linkedJob.id);
    }
    setBusy(false);
    if (error) setMessage(error.message);
    else {
      setMessage('Invoice saved.');
      await refreshData(false);
    }
  }

  async function markPaid() {
    setBusy(true);
    setMessage('');
    const method = paymentMethod || 'cash';
    const { error } = await supabase.from('lawncare_invoices').update({
      status: 'paid',
      payment_method: method,
      amount_paid_cents: total,
      paid_at: new Date().toISOString(),
      notes: notes || null,
    }).eq('id', invoice.id);

    if (!error && linkedJob) {
      const paymentStatus = method === 'cash' ? 'paid_cash' : method === 'cash_app' ? 'paid_cash_app' : method === 'venmo' ? 'paid_venmo' : method === 'card' ? 'paid_card' : 'invoiced';
      await supabase.from('lawncare_jobs').update({ payment_status: paymentStatus }).eq('id', linkedJob.id);
    }

    setBusy(false);
    if (error) setMessage(error.message);
    else {
      setStatus('paid');
      setPaymentMethod(method);
      setAmountPaid(String(total / 100));
      setMessage('Invoice marked paid.');
      await refreshData(false);
    }
  }

  async function addItem(event) {
    event.preventDefault();
    if (!newItem.description || !newItem.unitPrice) return;
    setBusy(true);
    const quantity = Number(newItem.quantity || 1);
    const unitPriceCents = dollarsToCents(newItem.unitPrice) || 0;
    const lineTotalCents = Math.round(quantity * unitPriceCents);
    const { data, error } = await supabase.from('lawncare_invoice_items').insert({
      invoice_id: invoice.id,
      description: newItem.description,
      quantity,
      unit_price_cents: unitPriceCents,
      line_total_cents: lineTotalCents,
      sort_order: items.length + 1,
    }).select('*').single();

    if (error) {
      setMessage(error.message);
    } else {
      await recalcInvoiceTotals([...items, data]);
      setNewItem({ description: '', quantity: '1', unitPrice: '' });
      setMessage('Line item added.');
      await refreshData(false);
    }
    setBusy(false);
  }

  async function deleteItem(item) {
    setBusy(true);
    const { error } = await supabase.from('lawncare_invoice_items').delete().eq('id', item.id);
    if (error) setMessage(error.message);
    else {
      await recalcInvoiceTotals(items.filter((current) => current.id !== item.id));
      await refreshData(false);
    }
    setBusy(false);
  }

  async function copyInvoiceText() {
    const text = buildInvoiceMessage(invoice, items, settings);
    try {
      await navigator.clipboard.writeText(text);
      setMessage('Invoice text copied.');
    } catch {
      setMessage(text);
    }
  }

  return (
    <div className="lead-detail invoice-detail">
      <div className="detail-header">
        <div>
          <p className="eyebrow">Invoice Detail</p>
          <h2>{invoice.invoice_number}</h2>
          <p>{invoice.customer_name} · {buildAddress(invoice)}</p>
        </div>
        <span className={classNames('invoice-status', invoiceStatusTone(invoice.status))}>{labelize(invoice.status)}</span>
      </div>

      <div className="invoice-total-card">
        <span>Total</span>
        <strong>{centsToDollars(total)}</strong>
        <small>Balance: {centsToDollars(balance)}</small>
      </div>

      <section className="mini-section">
        <h3>Line items</h3>
        <div className="invoice-items">
          {items.map((item) => (
            <div className="invoice-item" key={item.id}>
              <div>
                <strong>{item.description}</strong>
                <p className="small-muted">Qty {item.quantity} × {centsToDollars(item.unit_price_cents)}</p>
              </div>
              <span>{centsToDollars(item.line_total_cents)}</span>
              <button className="ghost-button compact" type="button" onClick={() => deleteItem(item)} disabled={busy}>Remove</button>
            </div>
          ))}
          {!items.length ? <p className="small-muted">No line items yet.</p> : null}
        </div>
        <form className="add-item-row" onSubmit={addItem}>
          <input value={newItem.description} onChange={(event) => setNewItem((current) => ({ ...current, description: event.target.value }))} placeholder="Service description" />
          <input value={newItem.quantity} onChange={(event) => setNewItem((current) => ({ ...current, quantity: event.target.value }))} placeholder="Qty" />
          <input value={newItem.unitPrice} onChange={(event) => setNewItem((current) => ({ ...current, unitPrice: event.target.value }))} placeholder="Price" />
          <button className="secondary-button compact" disabled={busy}>Add</button>
        </form>
      </section>

      <section className="mini-section">
        <h3>Payment tracking</h3>
        <div className="two-col">
          <label>Status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {INVOICE_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{labelize(option)}</option>)}
            </select>
          </label>
          <label>Payment method
            <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
              <option value="">Not paid yet</option>
              {PAYMENT_METHOD_OPTIONS.map((option) => <option key={option} value={option}>{labelize(option)}</option>)}
            </select>
          </label>
        </div>
        <label>Amount paid
          <input value={amountPaid} onChange={(event) => setAmountPaid(event.target.value)} placeholder="0.00" />
        </label>
        <label>Invoice notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Thank you note, payment details, or customer-facing notes." />
        </label>
        <div className="button-row">
          <button className="primary-button compact" type="button" onClick={saveInvoice} disabled={busy}>Save invoice</button>
          <button className="secondary-button compact" type="button" onClick={markPaid} disabled={busy}>Mark paid</button>
          <button className="ghost-button compact" type="button" onClick={copyInvoiceText}>Copy invoice text</button>
          <button className="ghost-button compact" type="button" onClick={() => window.print()}>Print</button>
        </div>
        {message ? <div className={message.includes('saved') || message.includes('copied') || message.includes('added') ? 'success-box' : 'error-box'}>{message}</div> : null}
      </section>
    </div>
  );
}

function Invoices({ invoices, invoiceItems, jobs, settings, refreshData }) {
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(invoices[0]?.id || null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    if (!selectedInvoiceId && invoices[0]) setSelectedInvoiceId(invoices[0].id);
  }, [invoices, selectedInvoiceId]);

  const filtered = invoices.filter((invoice) => {
    const haystack = [invoice.invoice_number, invoice.customer_name, buildAddress(invoice), invoice.status].join(' ').toLowerCase();
    return haystack.includes(search.toLowerCase()) && (statusFilter === 'all' || invoice.status === statusFilter);
  });
  const selectedInvoice = invoices.find((invoice) => invoice.id === selectedInvoiceId) || filtered[0] || null;
  const selectedItems = selectedInvoice ? invoiceItems.filter((item) => item.invoice_id === selectedInvoice.id) : [];
  const paidCount = invoices.filter((invoice) => invoice.status === 'paid').length;
  const openCount = invoices.filter((invoice) => !['paid', 'void'].includes(invoice.status)).length;
  const openTotal = invoices
    .filter((invoice) => !['paid', 'void'].includes(invoice.status))
    .reduce((sum, invoice) => sum + getInvoiceBalance(invoice, invoiceItems.filter((item) => item.invoice_id === invoice.id)), 0);

  return (
    <main className="app-grid invoices-grid">
      <section className="main-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Invoice Lite</p>
            <h1>Invoices & payment tracking</h1>
          </div>
          <button className="ghost-button" onClick={refreshData}>Refresh</button>
        </div>

        <div className="stats-grid">
          <StatCard label="Invoices" value={invoices.length} hint="Generated from jobs" />
          <StatCard label="Open" value={openCount} hint={centsToDollars(openTotal)} />
          <StatCard label="Paid" value={paidCount} hint="Closed invoices" />
        </div>

        <div className="filter-row">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search invoice, customer, address…" />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All invoice statuses</option>
            {INVOICE_STATUS_OPTIONS.map((status) => <option value={status} key={status}>{labelize(status)}</option>)}
          </select>
        </div>

        <div className="lead-list">
          {filtered.length ? filtered.map((invoice) => {
            const items = invoiceItems.filter((item) => item.invoice_id === invoice.id);
            return (
              <button key={invoice.id} className={classNames('lead-card', selectedInvoice?.id === invoice.id && 'selected')} onClick={() => setSelectedInvoiceId(invoice.id)}>
                <div className="lead-card-top">
                  <div>
                    <h3>{invoice.invoice_number}</h3>
                    <p>{invoice.customer_name} · {buildAddress(invoice) || 'No address'}</p>
                  </div>
                  <span className={classNames('invoice-status', invoiceStatusTone(invoice.status))}>{labelize(invoice.status)}</span>
                </div>
                <div className="pill-row">
                  <span>{invoice.service_date ? formatDate(`${invoice.service_date}T12:00:00`) : 'No service date'}</span>
                  <span>Due {invoice.due_date ? formatDate(`${invoice.due_date}T12:00:00`) : 'upon receipt'}</span>
                  <span>{centsToDollars(getInvoiceTotal(invoice, items))}</span>
                </div>
                <p className="small-muted">Balance: {centsToDollars(getInvoiceBalance(invoice, items))}</p>
              </button>
            );
          }) : <EmptyState title="No invoices yet" body="Generate invoices from completed or scheduled jobs on the Routes page." />}
        </div>
      </section>

      <aside className="detail-panel">
        {selectedInvoice ? (
          <InvoiceDetail invoice={selectedInvoice} items={selectedItems} settings={settings} refreshData={refreshData} jobs={jobs} />
        ) : (
          <EmptyState title="Select an invoice" body="Open an invoice to add line items, copy invoice text, and mark payments." />
        )}
      </aside>
    </main>
  );
}

function Calendar({ jobs, routes, routeJobs, teamMembers, routeAssignments }) {
  const memberById = useMemo(() => Object.fromEntries(teamMembers.map((member) => [member.id, member])), [teamMembers]);
  const jobCountsByRoute = useMemo(() => routeJobs.reduce((acc, item) => {
    acc[item.route_id] = (acc[item.route_id] || 0) + 1;
    return acc;
  }, {}), [routeJobs]);

  const dates = useMemo(() => {
    const allDates = new Set();
    jobs.forEach((job) => { if (job.scheduled_date) allDates.add(job.scheduled_date); });
    routes.forEach((route) => { if (route.route_date) allDates.add(route.route_date); });
    return [...allDates].sort();
  }, [jobs, routes]);

  return (
    <main className="page-shell">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Calendar</p>
          <h1>Routes and scheduled jobs by day</h1>
        </div>
      </div>

      {dates.length ? dates.map((date) => {
        const dayRoutes = routes.filter((route) => route.route_date === date);
        const dayJobs = jobs.filter((job) => job.scheduled_date === date);
        return (
          <section className="calendar-day" key={date}>
            <h2>{formatDate(`${date}T12:00:00`)}</h2>
            <div className="calendar-grid">
              <div className="calendar-column">
                <h3>Routes</h3>
                {dayRoutes.length ? dayRoutes.map((route) => {
                  const assignments = routeAssignments.filter((item) => item.route_id === route.id);
                  return (
                    <article className="calendar-card" key={route.id}>
                      <strong>{route.name}</strong>
                      <p>{labelize(route.status)} · {jobCountsByRoute[route.id] || 0} stops</p>
                      <p className="small-muted">Crew: {assignments.map((assignment) => memberDisplayName(memberById[assignment.team_member_id])).join(', ') || 'Unassigned'}</p>
                    </article>
                  );
                }) : <p className="small-muted">No routes for this day.</p>}
              </div>
              <div className="calendar-column">
                <h3>Jobs</h3>
                {dayJobs.length ? dayJobs.map((job) => (
                  <article className="calendar-card" key={job.id}>
                    <strong>{job.customer_name}</strong>
                    <p>{buildAddress(job)}</p>
                    <p className="small-muted">{labelize(job.job_status)} · {labelize(job.payment_status)}</p>
                  </article>
                )) : <p className="small-muted">No jobs for this day.</p>}
              </div>
            </div>
          </section>
        );
      }) : <EmptyState title="Nothing scheduled" body="Convert leads to jobs or create routes to fill the calendar." />}
    </main>
  );
}

function Team({ teamMembers, routes, routeAssignments, timeClockEntries, refreshData, session }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', role: 'crew', status: 'active' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const activeClockByMember = useMemo(() => {
    const map = {};
    timeClockEntries.filter((entry) => !entry.clock_out_at).forEach((entry) => { map[entry.team_member_id] = entry; });
    return map;
  }, [timeClockEntries]);

  async function addMember(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const payload = {
      name: form.name.trim(),
      email: normalizeEmail(form.email) || null,
      phone: form.phone.trim() || null,
      role: form.role,
      status: form.status,
    };
    if (!payload.name) {
      setBusy(false);
      setMessage('Name is required.');
      return;
    }
    const { error } = await supabase.from('lawncare_team_members').insert(payload);
    setBusy(false);
    if (error) setMessage(error.message);
    else {
      setForm({ name: '', email: '', phone: '', role: 'crew', status: 'active' });
      setMessage('Team member added.');
      await refreshData(false);
    }
  }

  return (
    <main className="page-shell">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Crew Management</p>
          <h1>Team members and time clock</h1>
        </div>
        <button className="ghost-button" onClick={refreshData}>Refresh</button>
      </div>

      <div className="stats-grid">
        <StatCard label="Active Crew" value={teamMembers.filter((member) => member.status === 'active').length} hint="Can be assigned routes" />
        <StatCard label="Clocked In" value={Object.keys(activeClockByMember).length} hint="Open time clock sessions" />
        <StatCard label="Admins/Managers" value={teamMembers.filter(isAdminRole).length} hint="Full dashboard access" />
        <StatCard label="Crew Members" value={teamMembers.filter((member) => member.role === 'crew').length} hint="Route + clock access" />
      </div>

      <form className="card-section team-form" onSubmit={addMember}>
        <div>
          <h2>Add team member</h2>
          <p className="small-muted">For a crew login, create the auth user in Supabase using the same email, then add that email here as Crew.</p>
        </div>
        <div className="three-col">
          <label>Name<input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Mike Johnson" /></label>
          <label>Email<input value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} placeholder="crew@example.com" /></label>
          <label>Phone<input value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} placeholder="555-555-5555" /></label>
        </div>
        <div className="two-col">
          <label>Role<select value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}>{TEAM_ROLE_OPTIONS.map((role) => <option key={role} value={role}>{labelize(role)}</option>)}</select></label>
          <label>Status<select value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}>{TEAM_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}</select></label>
        </div>
        <button className="primary-button" disabled={busy}>{busy ? 'Adding…' : 'Add team member'}</button>
        {message ? <div className={message.includes('added') ? 'success-box' : 'error-box'}>{message}</div> : null}
      </form>

      <div className="team-grid">
        {teamMembers.length ? teamMembers.map((member) => (
          <TeamMemberCard
            key={member.id}
            member={member}
            activeClock={activeClockByMember[member.id]}
            assignedRoutes={routes.filter((route) => routeAssignments.some((assignment) => assignment.route_id === route.id && assignment.team_member_id === member.id))}
            entries={timeClockEntries.filter((entry) => entry.team_member_id === member.id)}
            refreshData={refreshData}
            currentUserEmail={session.user?.email}
          />
        )) : <EmptyState title="No team yet" body="Add yourself as admin, then add your crew members." />}
      </div>
    </main>
  );
}

function TeamMemberCard({ member, activeClock, assignedRoutes, entries, refreshData, currentUserEmail }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(member);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm(member);
  }, [member]);

  const todayMs = entries.filter((entry) => isToday(entry.clock_in_at)).reduce((total, entry) => total + entryDurationMs(entry), 0);
  const weekMs = entries.filter((entry) => isThisWeek(entry.clock_in_at)).reduce((total, entry) => total + entryDurationMs(entry), 0);

  async function saveMember() {
    setBusy(true);
    const { error } = await supabase.from('lawncare_team_members').update({
      name: form.name || member.name,
      email: normalizeEmail(form.email) || null,
      phone: form.phone || null,
      role: form.role || 'crew',
      status: form.status || 'active',
    }).eq('id', member.id);
    setBusy(false);
    if (error) alert(error.message);
    else {
      setEditing(false);
      await refreshData(false);
    }
  }

  return (
    <article className="team-card">
      <div className="team-card-top">
        <div>
          <h2>{memberDisplayName(member)}</h2>
          <p>{member.email || 'No email'}{normalizeEmail(member.email) === normalizeEmail(currentUserEmail) ? ' · You' : ''}</p>
        </div>
        <span className={classNames('clock-pill', activeClock && 'in')}>{activeClock ? 'Clocked In' : 'Clocked Out'}</span>
      </div>

      {editing ? (
        <div className="team-edit-form">
          <label>Name<input value={form.name || ''} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
          <label>Email<input value={form.email || ''} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} /></label>
          <label>Phone<input value={form.phone || ''} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} /></label>
          <div className="two-col">
            <label>Role<select value={form.role || 'crew'} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}>{TEAM_ROLE_OPTIONS.map((role) => <option key={role} value={role}>{labelize(role)}</option>)}</select></label>
            <label>Status<select value={form.status || 'active'} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}>{TEAM_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}</select></label>
          </div>
          <div className="action-row"><button className="primary-button compact" onClick={saveMember} disabled={busy}>Save</button><button className="ghost-button compact" onClick={() => setEditing(false)}>Cancel</button></div>
        </div>
      ) : (
        <>
          <div className="info-grid compact-grid">
            <div><span>Role</span><strong>{labelize(member.role)}</strong></div>
            <div><span>Status</span><strong>{labelize(member.status)}</strong></div>
            <div><span>Today</span><strong>{msToHoursLabel(todayMs)}</strong></div>
            <div><span>This week</span><strong>{msToHoursLabel(weekMs)}</strong></div>
          </div>
          <section className="mini-section soft">
            <h3>Assigned routes</h3>
            <div className="chip-list">
              {assignedRoutes.length ? assignedRoutes.map((route) => <span className="chip" key={route.id}>{getRouteLabel(route)}</span>) : <p className="small-muted">No assigned routes yet.</p>}
            </div>
          </section>
          <section className="mini-section soft">
            <h3>Recent clock entries</h3>
            {entries.slice(0, 4).map((entry) => (
              <p className="small-muted clock-row" key={entry.id}>{formatDateTime(entry.clock_in_at)} → {entry.clock_out_at ? formatDateTime(entry.clock_out_at) : 'Still clocked in'} · {msToHoursLabel(entryDurationMs(entry))}</p>
            ))}
            {!entries.length ? <p className="small-muted">No time entries yet.</p> : null}
          </section>
          <button className="ghost-button full" onClick={() => setEditing(true)}>Edit team member</button>
        </>
      )}
    </article>
  );
}

function CrewHome({ currentMember, routes, routeAssignments, routeJobs, jobs, timeClockEntries, refreshData }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const activeClock = timeClockEntries.find((entry) => entry.team_member_id === currentMember.id && !entry.clock_out_at);
  const myRouteIds = new Set(routeAssignments.filter((assignment) => assignment.team_member_id === currentMember.id).map((assignment) => assignment.route_id));
  const myRoutes = routes
    .filter((route) => myRouteIds.has(route.id) && route.status !== 'cancelled')
    .sort((a, b) => String(a.route_date || '').localeCompare(String(b.route_date || '')));
  const jobById = useMemo(() => Object.fromEntries(jobs.map((job) => [job.id, job])), [jobs]);
  const todayMs = timeClockEntries.filter((entry) => entry.team_member_id === currentMember.id && isToday(entry.clock_in_at)).reduce((total, entry) => total + entryDurationMs(entry), 0);
  const weekMs = timeClockEntries.filter((entry) => entry.team_member_id === currentMember.id && isThisWeek(entry.clock_in_at)).reduce((total, entry) => total + entryDurationMs(entry), 0);

  async function getLocation() {
    if (!navigator.geolocation) return {};
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
        () => resolve({}),
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 },
      );
    });
  }

  async function clockIn() {
    setBusy(true);
    setMessage('');
    const location = await getLocation();
    const { error } = await supabase.from('lawncare_time_clock_entries').insert({
      team_member_id: currentMember.id,
      clock_in_lat: location.lat ?? null,
      clock_in_lng: location.lng ?? null,
    });
    setBusy(false);
    if (error) setMessage(error.message);
    else {
      setMessage('Clocked in.');
      await refreshData(false);
    }
  }

  async function clockOut() {
    if (!activeClock) return;
    setBusy(true);
    setMessage('');
    const location = await getLocation();
    const { error } = await supabase.from('lawncare_time_clock_entries').update({
      clock_out_at: new Date().toISOString(),
      clock_out_lat: location.lat ?? null,
      clock_out_lng: location.lng ?? null,
    }).eq('id', activeClock.id);
    setBusy(false);
    if (error) setMessage(error.message);
    else {
      setMessage('Clocked out.');
      await refreshData(false);
    }
  }

  async function updateJob(job, patch) {
    const { error } = await supabase.from('lawncare_jobs').update(patch).eq('id', job.id);
    if (error) alert(error.message);
    await refreshData(false);
  }

  return (
    <main className="page-shell">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Crew Dashboard</p>
          <h1>Good morning, {memberDisplayName(currentMember)}</h1>
        </div>
        <button className="ghost-button" onClick={refreshData}>Refresh</button>
      </div>

      <section className="clock-hero">
        <div>
          <p className="eyebrow">Clock Status</p>
          <h2>{activeClock ? `Clocked in at ${formatDateTime(activeClock.clock_in_at)}` : 'You are currently clocked out.'}</h2>
          <p className="small-muted">Today: {msToHoursLabel(todayMs)} · This week: {msToHoursLabel(weekMs)}</p>
        </div>
        {activeClock ? <button className="primary-button" onClick={clockOut} disabled={busy}>Clock Out</button> : <button className="secondary-button" onClick={clockIn} disabled={busy}>Clock In</button>}
      </section>
      {message ? <div className={message.includes('Clocked') ? 'success-box' : 'error-box'}>{message}</div> : null}

      <div className="crew-route-list">
        {myRoutes.length ? myRoutes.map((route) => {
          const stops = routeJobs.filter((item) => item.route_id === route.id).sort((a, b) => Number(a.stop_order || 0) - Number(b.stop_order || 0));
          return (
            <section className="route-card-large" key={route.id}>
              <div className="route-card-header">
                <div>
                  <p className="eyebrow">{formatDate(`${route.route_date}T12:00:00`)}</p>
                  <h2>{route.name}</h2>
                  {route.notes ? <p className="small-muted">{route.notes}</p> : null}
                </div>
                <span className="score-badge good">{labelize(route.status)}</span>
              </div>
              <div className="stop-list">
                {stops.length ? stops.map((routeJob) => {
                  const job = jobById[routeJob.job_id];
                  if (!job) return null;
                  return (
                    <article className="stop-card crew-stop" key={routeJob.id}>
                      <span className="stop-number">{routeJob.stop_order || 0}</span>
                      <div>
                        <strong>{job.customer_name}</strong>
                        <p>{buildAddress(job)}</p>
                        <div className="pill-row">
                          {normalizeServices(job.services).map((service) => <span key={service}>{labelize(service)}</span>)}
                        </div>
                        {job.job_notes ? <p className="job-notes">{job.job_notes}</p> : null}
                        <div className="action-row">
                          {job.phone ? <a className="ghost-button compact" href={`tel:${job.phone}`}>Call</a> : null}
                          {buildAddress(job) ? <a className="ghost-button compact" href={mapsUrl(job)} target="_blank" rel="noreferrer">Maps</a> : null}
                          <button className="secondary-button compact" onClick={() => updateJob(job, { job_status: 'completed' })}>Mark complete</button>
                        </div>
                      </div>
                    </article>
                  );
                }) : <p className="small-muted">No stops on this route yet.</p>}
              </div>
            </section>
          );
        }) : <EmptyState title="No assigned routes" body="Ask an admin to assign you to a route. Your route and stops will appear here." />}
      </div>
    </main>
  );
}

function Settings({ settings, setSettings, refreshData }) {
  const [form, setForm] = useState(settings || DEFAULT_SETTINGS);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm(settings || DEFAULT_SETTINGS);
  }, [settings]);

  function setField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function saveSettings(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const payload = {
      business_name: form.business_name || DEFAULT_SETTINGS.business_name,
      owner_name: form.owner_name || null,
      phone: form.phone || null,
      service_areas: String(form.service_areas_text || (form.service_areas || []).join('\n'))
        .split(/\n|,/)
        .map((area) => area.trim())
        .filter(Boolean),
      small_base_cents: dollarsToCents(form.small_base_dollars) ?? form.small_base_cents ?? DEFAULT_SETTINGS.small_base_cents,
      medium_base_cents: dollarsToCents(form.medium_base_dollars) ?? form.medium_base_cents ?? DEFAULT_SETTINGS.medium_base_cents,
      large_base_cents: dollarsToCents(form.large_base_dollars) ?? form.large_base_cents ?? DEFAULT_SETTINGS.large_base_cents,
      weekly_discount_percent: Number(form.weekly_discount_percent || DEFAULT_SETTINGS.weekly_discount_percent),
      biweekly_discount_percent: Number(form.biweekly_discount_percent || DEFAULT_SETTINGS.biweekly_discount_percent),
    };

    let error;
    let data;
    if (form.id) {
      const response = await supabase.from('lawncare_settings').update(payload).eq('id', form.id).select('*').single();
      error = response.error;
      data = response.data;
    } else {
      const response = await supabase.from('lawncare_settings').insert(payload).select('*').single();
      error = response.error;
      data = response.data;
    }

    setBusy(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setSettings(data);
    await refreshData(false);
    setMessage('Settings saved.');
  }

  return (
    <main className="page-shell narrow">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Pricing Rules</p>
          <h1>Manager settings</h1>
        </div>
      </div>
      <form className="settings-form" onSubmit={saveSettings}>
        <div className="card-section">
          <h2>Business info</h2>
          <label>Business name<input value={form.business_name || ''} onChange={(event) => setField('business_name', event.target.value)} /></label>
          <div className="two-col">
            <label>Owner name<input value={form.owner_name || ''} onChange={(event) => setField('owner_name', event.target.value)} /></label>
            <label>Phone<input value={form.phone || ''} onChange={(event) => setField('phone', event.target.value)} /></label>
          </div>
          <label>Service areas<textarea value={form.service_areas_text ?? (form.service_areas || DEFAULT_SETTINGS.service_areas).join('\n')} onChange={(event) => setField('service_areas_text', event.target.value)} /></label>
        </div>

        <div className="card-section">
          <h2>Fair quote defaults</h2>
          <div className="three-col">
            <label>Small base<input value={form.small_base_dollars ?? ((form.small_base_cents ?? 6500) / 100)} onChange={(event) => setField('small_base_dollars', event.target.value)} /></label>
            <label>Medium base<input value={form.medium_base_dollars ?? ((form.medium_base_cents ?? 9000) / 100)} onChange={(event) => setField('medium_base_dollars', event.target.value)} /></label>
            <label>Large base<input value={form.large_base_dollars ?? ((form.large_base_cents ?? 13500) / 100)} onChange={(event) => setField('large_base_dollars', event.target.value)} /></label>
          </div>
          <div className="two-col">
            <label>Weekly discount %<input value={form.weekly_discount_percent ?? 10} onChange={(event) => setField('weekly_discount_percent', event.target.value)} /></label>
            <label>Bi-weekly discount %<input value={form.biweekly_discount_percent ?? 5} onChange={(event) => setField('biweekly_discount_percent', event.target.value)} /></label>
          </div>
        </div>

        <button className="primary-button full" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
        {message ? <div className={message.includes('saved') || message.includes('Settings') ? 'success-box' : 'error-box'}>{message}</div> : null}
      </form>
    </main>
  );
}

function MissingConfig() {
  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">⚠️</div>
        <h1>Missing Supabase env vars</h1>
        <p className="muted centered">Create a `.env` file with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then restart the dev server.</p>
      </section>
    </main>
  );
}

export default function App() {
  const { session, loading } = useSession();
  const [activeView, setActiveView] = useState('dashboard');
  const [leads, setLeads] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [invoiceItems, setInvoiceItems] = useState([]);
  const [quoteEvents, setQuoteEvents] = useState([]);
  const [images, setImages] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [teamMembers, setTeamMembers] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [routeAssignments, setRouteAssignments] = useState([]);
  const [routeJobs, setRouteJobs] = useState([]);
  const [timeClockEntries, setTimeClockEntries] = useState([]);
  const [selectedLead, setSelectedLead] = useState(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [teamTablesMissing, setTeamTablesMissing] = useState(false);

  const currentMember = useMemo(() => {
    if (!session) return null;
    const userId = session.user?.id;
    const email = normalizeEmail(session.user?.email);
    const match = teamMembers.find((member) => member.user_id === userId || normalizeEmail(member.email) === email);
    if (match && match.status !== 'inactive') return match;
    if (!teamMembers.length && !teamTablesMissing) {
      return { implicit_admin: true, role: 'admin', name: session.user?.email || 'Admin', email: session.user?.email };
    }
    return null;
  }, [session, teamMembers, teamTablesMissing]);

  async function refreshData(showSpinner = true) {
    if (!supabase || !session) return;
    if (showSpinner) setDataLoading(true);
    setLoadError('');
    setTeamTablesMissing(false);

    const responses = await Promise.all([
      supabase.from('lawncare_leads').select('*').order('created_at', { ascending: false }),
      supabase.from('lawncare_quotes').select('*').order('created_at', { ascending: false }),
      supabase.from('lawncare_jobs').select('*').order('scheduled_date', { ascending: true, nullsFirst: false }),
      supabase.from('lawncare_settings').select('*').order('created_at', { ascending: true }).limit(1),
      supabase.from('lawncare_lead_images').select('*').order('created_at', { ascending: true }),
      supabase.from('lawncare_invoices').select('*').order('created_at', { ascending: false }),
      supabase.from('lawncare_invoice_items').select('*').order('sort_order', { ascending: true }),
      supabase.from('lawncare_quote_payment_events').select('*').order('created_at', { ascending: false }),
      supabase.from('lawncare_team_members').select('*').order('created_at', { ascending: true }),
      supabase.from('lawncare_routes').select('*').order('route_date', { ascending: true, nullsFirst: false }),
      supabase.from('lawncare_route_assignments').select('*').order('assigned_at', { ascending: true }),
      supabase.from('lawncare_route_jobs').select('*').order('stop_order', { ascending: true }),
      supabase.from('lawncare_time_clock_entries').select('*').order('clock_in_at', { ascending: false }).limit(200),
    ]);

    const [leadsResponse, quotesResponse, jobsResponse, settingsResponse, imagesResponse, invoicesResponse, invoiceItemsResponse, quoteEventsResponse, teamResponse, routesResponse, assignmentsResponse, routeJobsResponse, clockResponse] = responses;

    if (leadsResponse.error) setLoadError(leadsResponse.error.message);
    else setLeads(leadsResponse.data || []);

    if (!quotesResponse.error) setQuotes(quotesResponse.data || []);
    if (!jobsResponse.error) setJobs(jobsResponse.data || []);
    if (!imagesResponse.error) setImages(imagesResponse.data || []);
    if (!invoicesResponse.error) setInvoices(invoicesResponse.data || []);
    if (!invoiceItemsResponse.error) setInvoiceItems(invoiceItemsResponse.data || []);
    if (!quoteEventsResponse.error) setQuoteEvents(quoteEventsResponse.data || []);
    if (invoicesResponse.error || invoiceItemsResponse.error) {
      setLoadError(`Invoice tables are not ready yet. Run invoice-lite-addon.sql in Supabase. First error: ${(invoicesResponse.error || invoiceItemsResponse.error).message}`);
    } else if (quoteEventsResponse.error) {
      setLoadError(`Quote payment workflow is not ready yet. Run quote-payment-invoice-addon.sql in Supabase. First error: ${quoteEventsResponse.error.message}`);
    }
    if (!settingsResponse.error && settingsResponse.data?.[0]) setSettings(settingsResponse.data[0]);

    const teamErrors = [teamResponse, routesResponse, assignmentsResponse, routeJobsResponse, clockResponse].filter((response) => response.error);
    if (teamErrors.length) {
      setTeamTablesMissing(true);
      setLoadError(`Team tables are not ready yet. Run team-ops-addon.sql in Supabase. First error: ${teamErrors[0].error.message}`);
    } else {
      setTeamMembers(teamResponse.data || []);
      setRoutes(routesResponse.data || []);
      setRouteAssignments(assignmentsResponse.data || []);
      setRouteJobs(routeJobsResponse.data || []);
      setTimeClockEntries(clockResponse.data || []);
    }

    if (selectedLead) {
      const updated = (leadsResponse.data || []).find((lead) => lead.id === selectedLead.id);
      if (updated) setSelectedLead(updated);
    }

    if (showSpinner) setDataLoading(false);
  }

  useEffect(() => {
    if (session) refreshData();
  }, [session]);

  useEffect(() => {
    if (!currentMember) return;
    if (isAdminRole(currentMember)) {
      if (activeView === 'crew') setActiveView('dashboard');
    } else if (activeView !== 'crew') {
      setActiveView('crew');
    }
  }, [currentMember, activeView]);

  if (!isSupabaseConfigured) return <MissingConfig />;
  if (loading) return <main className="loading-screen">Loading manager…</main>;
  if (!session) return <LoginScreen />;
  if (teamTablesMissing) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark">🧰</div>
          <p className="eyebrow">Database Update Needed</p>
          <h1>Run team-ops-addon.sql</h1>
          <p className="muted centered">The manager app is ready, but Supabase needs the team, route assignment, and time clock tables.</p>
          {loadError ? <div className="error-box">{loadError}</div> : null}
          <button className="ghost-button full" onClick={() => refreshData(true)}>Retry</button>
        </section>
      </main>
    );
  }
  if (!currentMember) return <AccessSetup userEmail={session.user?.email} teamMembers={teamMembers} refreshData={refreshData} />;

  return (
    <div className="manager-app">
      <TopBar
        userEmail={session.user?.email}
        activeView={activeView}
        setActiveView={setActiveView}
        onLogout={() => supabase.auth.signOut()}
        currentMember={currentMember}
        teamReady={!teamTablesMissing}
      />

      {loadError ? <div className="global-error">{loadError}</div> : null}
      {dataLoading ? <div className="global-loading">Syncing Supabase…</div> : null}

      {activeView === 'dashboard' && isAdminRole(currentMember) ? (
        <Dashboard
          leads={leads}
          quotes={quotes}
          jobs={jobs}
          invoices={invoices}
          images={images}
          selectedLead={selectedLead}
          setSelectedLead={setSelectedLead}
          refreshData={refreshData}
          settings={settings}
        />
      ) : null}

      {activeView === 'quotes' && isAdminRole(currentMember) ? <Quotes quotes={quotes} leads={leads} jobs={jobs} settings={settings} refreshData={refreshData} invoices={invoices} invoiceItems={invoiceItems} quoteEvents={quoteEvents} /> : null}
      {activeView === 'routes' && isAdminRole(currentMember) ? <Routes jobs={jobs} routes={routes} routeAssignments={routeAssignments} routeJobs={routeJobs} teamMembers={teamMembers} invoices={invoices} invoiceItems={invoiceItems} settings={settings} refreshData={refreshData} /> : null}
      {activeView === 'invoices' && isAdminRole(currentMember) ? <Invoices invoices={invoices} invoiceItems={invoiceItems} jobs={jobs} settings={settings} refreshData={refreshData} /> : null}
      {activeView === 'calendar' && isAdminRole(currentMember) ? <Calendar jobs={jobs} routes={routes} routeJobs={routeJobs} teamMembers={teamMembers} routeAssignments={routeAssignments} /> : null}
      {activeView === 'team' && isAdminRole(currentMember) ? <Team teamMembers={teamMembers} routes={routes} routeAssignments={routeAssignments} timeClockEntries={timeClockEntries} refreshData={refreshData} session={session} /> : null}
      {activeView === 'settings' && isAdminRole(currentMember) ? <Settings settings={settings} setSettings={setSettings} refreshData={refreshData} /> : null}
      {activeView === 'crew' ? <CrewHome currentMember={currentMember} routes={routes} routeAssignments={routeAssignments} routeJobs={routeJobs} jobs={jobs} timeClockEntries={timeClockEntries} refreshData={refreshData} /> : null}
    </div>
  );
}
