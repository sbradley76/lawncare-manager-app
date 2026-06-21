import React, { useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import { scoreLead } from './lib/scoring';
import { estimateQuote } from './lib/pricing';
import { buildAddress, centsToDollars, dollarsToCents, formatDate, formatDateTime, getFullName, labelize, mapsUrl, normalizeServices } from './lib/format';

const STATUS_OPTIONS = ['new', 'contacted', 'quoted', 'scheduled', 'won', 'lost', 'spam'];
const JOB_STATUS_OPTIONS = ['scheduled', 'in_progress', 'completed', 'cancelled'];
const PAYMENT_STATUS_OPTIONS = ['unpaid', 'paid_cash', 'paid_cash_app', 'paid_venmo', 'paid_card', 'invoiced'];
const IMAGE_BUCKET = 'lawncare-lead-images';

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
        <p className="muted centered">Pull leads from Supabase, rank them, quote fairly, schedule jobs, and keep your route moving.</p>
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

function TopBar({ userEmail, activeView, setActiveView, onLogout }) {
  const tabs = [
    ['dashboard', 'Leads'],
    ['routes', 'Routes'],
    ['settings', 'Settings'],
  ];

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="logo-block">
          <div className="logo-icon">🌿</div>
          <div>
            <strong>Lawncare Manager</strong>
            <span>Lead → Quote → Route</span>
          </div>
        </div>
        <nav className="tab-nav" aria-label="Manager navigation">
          {tabs.map(([key, label]) => (
            <button key={key} className={activeView === key ? 'active' : ''} onClick={() => setActiveView(key)}>{label}</button>
          ))}
        </nav>
        <div className="user-actions">
          <span>{userEmail}</span>
          <button className="ghost-button" onClick={onLogout}>Sign out</button>
        </div>
      </div>
    </header>
  );
}

function Dashboard({ leads, quotes, jobs, images, selectedLead, setSelectedLead, refreshData, settings }) {
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
          <LeadDetail lead={selectedLead} setSelectedLead={setSelectedLead} refreshData={refreshData} settings={settings} leadImages={images.filter((image) => image.lead_id === selectedLead.id)} />
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
    return () => {
      cancelled = true;
    };
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

function LeadDetail({ lead, setSelectedLead, refreshData, settings, leadImages }) {
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

function Routes({ jobs, refreshData }) {
  const [savingId, setSavingId] = useState(null);
  const sorted = useMemo(() => {
    return [...jobs].sort((a, b) => {
      if (!a.scheduled_date && b.scheduled_date) return 1;
      if (a.scheduled_date && !b.scheduled_date) return -1;
      return String(a.scheduled_date || '').localeCompare(String(b.scheduled_date || ''));
    });
  }, [jobs]);

  const groups = sorted.reduce((acc, job) => {
    const key = job.scheduled_date || 'Unscheduled';
    if (!acc[key]) acc[key] = [];
    acc[key].push(job);
    return acc;
  }, {});

  async function updateJob(job, patch) {
    setSavingId(job.id);
    const { error } = await supabase.from('lawncare_jobs').update(patch).eq('id', job.id);
    setSavingId(null);
    if (error) alert(error.message);
    await refreshData(false);
  }

  return (
    <main className="page-shell">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Route Board</p>
          <h1>Scheduled jobs and payments</h1>
        </div>
        <button className="ghost-button" onClick={refreshData}>Refresh</button>
      </div>

      {Object.keys(groups).length ? Object.entries(groups).map(([date, dayJobs]) => (
        <section className="route-day" key={date}>
          <h2>{date === 'Unscheduled' ? date : formatDate(`${date}T12:00:00`)}</h2>
          <div className="job-grid">
            {dayJobs.map((job) => (
              <article className="job-card" key={job.id}>
                <div className="job-top">
                  <div>
                    <h3>{job.customer_name}</h3>
                    <p>{buildAddress(job)}</p>
                  </div>
                  <strong>{centsToDollars(job.final_price_cents || job.quoted_price_cents)}</strong>
                </div>
                <div className="pill-row">
                  {normalizeServices(job.services).map((service) => <span key={service}>{labelize(service)}</span>)}
                </div>
                {job.scheduled_time ? <p className="small-muted">Time: {job.scheduled_time}</p> : null}
                {job.job_notes ? <p className="job-notes">{job.job_notes}</p> : null}
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
                <div className="action-row">
                  {job.phone ? <a className="ghost-button compact" href={`tel:${job.phone}`}>Call</a> : null}
                  {buildAddress(job) ? <a className="ghost-button compact" href={mapsUrl(job)} target="_blank" rel="noreferrer">Maps</a> : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      )) : <EmptyState title="No jobs yet" body="Convert a quoted lead to a job and it will show up here." />}
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
  const [images, setImages] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [selectedLead, setSelectedLead] = useState(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  async function refreshData(showSpinner = true) {
    if (!supabase || !session) return;
    if (showSpinner) setDataLoading(true);
    setLoadError('');

    const [leadsResponse, quotesResponse, jobsResponse, settingsResponse, imagesResponse] = await Promise.all([
      supabase.from('lawncare_leads').select('*').order('created_at', { ascending: false }),
      supabase.from('lawncare_quotes').select('*').order('created_at', { ascending: false }),
      supabase.from('lawncare_jobs').select('*').order('scheduled_date', { ascending: true, nullsFirst: false }),
      supabase.from('lawncare_settings').select('*').order('created_at', { ascending: true }).limit(1),
      supabase.from('lawncare_lead_images').select('*').order('created_at', { ascending: true }),
    ]);

    if (leadsResponse.error) setLoadError(leadsResponse.error.message);
    else setLeads(leadsResponse.data || []);

    if (!quotesResponse.error) setQuotes(quotesResponse.data || []);
    if (!jobsResponse.error) setJobs(jobsResponse.data || []);
    if (!imagesResponse.error) setImages(imagesResponse.data || []);
    if (!settingsResponse.error && settingsResponse.data?.[0]) setSettings(settingsResponse.data[0]);

    if (selectedLead) {
      const updated = (leadsResponse.data || []).find((lead) => lead.id === selectedLead.id);
      if (updated) setSelectedLead(updated);
    }

    if (showSpinner) setDataLoading(false);
  }

  useEffect(() => {
    if (session) refreshData();
  }, [session]);

  if (!isSupabaseConfigured) return <MissingConfig />;
  if (loading) return <main className="loading-screen">Loading manager…</main>;
  if (!session) return <LoginScreen />;

  return (
    <div className="manager-app">
      <TopBar
        userEmail={session.user?.email}
        activeView={activeView}
        setActiveView={setActiveView}
        onLogout={() => supabase.auth.signOut()}
      />

      {loadError ? <div className="global-error">{loadError}</div> : null}
      {dataLoading ? <div className="global-loading">Syncing Supabase…</div> : null}

      {activeView === 'dashboard' ? (
        <Dashboard
          leads={leads}
          quotes={quotes}
          jobs={jobs}
          images={images}
          selectedLead={selectedLead}
          setSelectedLead={setSelectedLead}
          refreshData={refreshData}
          settings={settings}
        />
      ) : null}

      {activeView === 'routes' ? <Routes jobs={jobs} refreshData={refreshData} /> : null}
      {activeView === 'settings' ? <Settings settings={settings} setSettings={setSettings} refreshData={refreshData} /> : null}
    </div>
  );
}
