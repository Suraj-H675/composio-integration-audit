"use client";

import { useEffect, useMemo, useState } from "react";

type Evidence = {
  url: string;
  originalUrl?: string;
  sourceType: string;
  retrievalMethod: string;
  checkedAt: string | null;
  httpStatus: number | null;
  statement: string;
};

type Claim = {
  field: string;
  value: unknown;
  status: string;
  confidence: string;
  reason: string | null;
  evidenceQuality: string;
  humanApproved: boolean;
  evidence: Evidence[];
};

type AppRecord = {
  app: string;
  category: string;
  assignmentHint: string;
  oneLiner: string;
  identity: { vendor: string | null; product: string | null; status: string; hintStatus: string | null; conflict: boolean };
  identityEvidence: Evidence[];
  technicalBuildability: string;
  customerCredentialAccess: string;
  distributedIntegrationAccess: string;
  sandboxAccess: string;
  publicApiAvailable: string;
  apiBreadth: string;
  apiStyles: string[];
  authMethods: string[];
  primaryAuth: string;
  webhooks: string;
  vendorOfficialMcp: boolean | string;
  vendorMcpType: string;
  vendorMcpStage: string;
  communityMcp: string;
  composioToolkitExists: string;
  composioToolkitMatchType: string | null;
  composioToolkitIdentifier: string | null;
  commercialFriction: string;
  setupFriction: string;
  mainBlocker: string;
  confidence: Record<string, number>;
  evidenceQuality: Record<string, number>;
  unknowns: string[];
  humanReviewed: boolean;
  claims: Claim[];
};

type Metric = { label: string; numerator: number; denominator: number; value: number | null; percent?: number; display: string; definition: string };

export type PresentationData = {
  dataset: { id: string; schemaVersion: string; status: string; frozenAt: string; appCount: number; holdoutSize: number; humanReviewStatus: string; sourceLedgerCount: number; sourceAppsSha256: string; sourceLedgerSha256: string; paidCostUsd: number; catalogSnapshot: string | null };
  metrics: {
    appCount: number;
    source: { rows: number; uniqueUrls: number; live: number; retrieval: Record<string, number> };
    claims: { count: number; evidenceBacked: number };
    headline: { technicallyBuildable: Metric; openDistribution: Metric; productActionMcp: Metric; productActionMcpAbsent: Metric; composioCoverage: Metric; resolvedHoldoutAccuracy: Metric; paidCost: { display: string; value: number; definition: string }; unresolvedIdentities: Metric };
    distribution: { customerCredentialAccess: Record<string, number>; distributedIntegrationAccess: Record<string, number>; customerEasyDistributionGated: Metric; documentedDistributionGates: Metric };
    buildability: Record<string, number>;
    api: { public: Record<string, number>; breadth: Record<string, number>; styles: Record<string, number> };
    mcp: { officialCount: number; officialDistribution: Record<string, number>; typeAmongOfficial: Record<string, number>; lifecycleAmongOfficial: Record<string, number>; lifecycleAcrossAllApps: Record<string, number>; unknownStageAmongOfficial: number; unknownStageAcrossAllApps: number; nonOfficialUnknownStage: number; sanityExplanation: string };
    composio: { distribution: Record<string, number>; publicApiAbsent: number; technicallyBuildableAbsent: number; officialMcpAbsent: number; productActionMcpAbsent: number; catalogSnapshot: string | null };
    verification: { challengeCount: number; agreement: Metric; sourceDisjoint: Metric; sourceDisjointWhenAlternate: Metric };
    holdout: { appCount: number; fieldCount: number; exact: Metric; resolved: Metric; automationAbstentions: Metric; humanUnresolved: Metric; schemaRepair: { repaired: number; accepted: number; stillNeeded: number; acceptedPercent: number; denominator: number } };
    evidenceQuality: Record<string, number>;
    opportunities: { easyWins: Opportunity[]; partnership: Opportunity[]; customerManaged: Opportunity[] };
    categoryPatterns: Record<string, CategoryPattern>;
    metricSanityCheck: { explanation: string };
  };
  apps: AppRecord[];
  fieldLabels: Record<string, string>;
  methodology: { thesis: string; evidence: string; unknowns: string; legacy: string };
  integrity: { sourceAppsSha256: string; sourceLedgerSha256: string; presentationPayloadSha256: string };
};

type Opportunity = { rank: number; app: string; score: number; reasons: string[] };
type CategoryPattern = { app_count: number; technical_buildability: Record<string, number>; official_mcp: number; product_action_mcp: number; composio_toolkit: number };
type Replay = { app: string; steps: { id: string; label: string; status: string; detail: string }[]; final: Record<string, unknown> };
type Integrity = { ok: boolean; datasetId: string; checks: { label: string; ok: boolean; detail: string }[] };

const categoryLabels: Record<string, string> = {
  crm_sales: "CRM & sales",
  customer_support: "Customer support",
  communication: "Communication",
  marketing_analytics: "Marketing & analytics",
  commerce: "Commerce",
  data_seo_scraping: "Data, SEO & scraping",
  developer_tools: "Developer tools",
  productivity: "Productivity",
  finance_payments: "Finance & payments",
  ai_media: "AI & media"
};

const labels: Record<string, string> = {
  self_serve_free: "Self-serve · free",
  self_serve_trial: "Self-serve · trial",
  self_serve_paid: "Self-serve · paid",
  admin_required: "Admin required",
  vendor_approval_required: "Vendor approval",
  partner_program_required: "Partner program",
  enterprise_contract_required: "Enterprise contract",
  customer_managed_only: "Customer-managed",
  app_review_required: "App review",
  open_self_serve: "Open self-serve",
  not_applicable: "Not applicable",
  unavailable: "Unavailable",
  unknown: "Unknown",
  product_action: "Product action",
  documentation: "Documentation",
  developer_tooling: "Developer tooling",
  mixed: "Mixed",
  public_preview: "Public preview",
  beta: "Beta",
  ga: "GA",
  yes: "Yes",
  no: "No",
  limited: "Limited",
  broad: "Broad",
  moderate: "Moderate",
  narrow: "Narrow",
  action_specific: "Action-specific",
  free_tier_limited: "Free tier limited",
  paid_plan_required: "Paid plan required",
  usage_pricing: "Usage pricing",
  enterprise_plan_required: "Enterprise plan",
  oauth_configuration: "OAuth configuration",
  admin_configuration: "Admin configuration",
  merchant_underwriting: "Merchant underwriting",
  interface_limited: "Interface limited",
  identity_unresolved: "Identity unresolved",
  none: "None",
  confirmed: "Confirmed",
  unresolved: "Unresolved"
};

function valueLabel(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => valueLabel(item)).join(" · ");
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === null || value === undefined) return "Unknown";
  const raw = String(value);
  return labels[raw] ?? raw.replaceAll("_", " ");
}

function tone(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (["yes", "confirmed", "open_self_serve", "product_action", "self_serve_free", "self_serve_trial", "self_serve_paid", "none"].includes(String(raw))) return "positive";
  if (["unknown", "unresolved", "not_applicable"].includes(String(raw))) return "muted";
  if (["no", "unavailable", "identity_unresolved", "interface_limited"].includes(String(raw))) return "negative";
  return "caution";
}

function StatusPill({ value, compact = false }: { value: unknown; compact?: boolean }) {
  return <span className={`status-pill ${tone(value)} ${compact ? "compact" : ""}`}>{valueLabel(value)}</span>;
}

function SectionLabel({ index, children }: { index: string; children: React.ReactNode }) {
  return <div className="section-label"><span>{index}</span>{children}</div>;
}

function MetricCard({ metric, detail, accent = "" }: { metric: Metric | { display: string; value: number; definition: string }; detail: string; accent?: string }) {
  return <div className={`metric-card ${accent}`}>
    <div className="metric-value">{metric.display}</div>
    <div className="metric-label">{detail}</div>
  </div>;
}

function BarList({ values, total, colors = ["teal", "orange", "ink", "violet", "blue"] }: { values: Record<string, number>; total: number; colors?: string[] }) {
  return <div className="bar-list">
    {Object.entries(values).filter(([, value]) => value > 0).map(([key, value], index) => <div className="bar-row" key={key}>
      <div className="bar-row-top"><span>{valueLabel(key)}</span><strong>{value}</strong></div>
      <div className="bar-track"><span className={`bar-fill ${colors[index % colors.length]}`} style={{ width: `${Math.max(2, value / total * 100)}%` }} /></div>
    </div>)}
  </div>;
}

function StackedBar({ values, total }: { values: Record<string, number>; total: number }) {
  const colors = ["teal", "orange", "blue", "violet", "ink", "slate"];
  return <div className="stacked-bar" aria-label="Distribution breakdown">
    {Object.entries(values).filter(([, value]) => value > 0).map(([key, value], index) => <span key={key} className={`stack-segment ${colors[index % colors.length]}`} style={{ width: `${value / total * 100}%` }} title={`${valueLabel(key)}: ${value}`} />)}
  </div>;
}

function EvidenceLink({ evidence }: { evidence: Evidence }) {
  return <a className="evidence-link" href={evidence.url} target="_blank" rel="noreferrer">
    <span className="evidence-link-icon">↗</span>
    <span><strong>{evidence.sourceType.replaceAll("_", " ")}</strong><small>{new URL(evidence.url).hostname}</small></span>
  </a>;
}

function OpportunityCard({ opportunity, app, kind }: { opportunity: Opportunity; app?: AppRecord; kind: "easy" | "partnership" }) {
  if (!app) return null;
  return <button className="opportunity-card" onClick={() => document.dispatchEvent(new CustomEvent("open-app", { detail: app.app }))}>
    <div className="opportunity-rank">{String(opportunity.rank).padStart(2, "0")}</div>
    <div className="opportunity-body">
      <div className="opportunity-title"><strong>{app.app}</strong><StatusPill value={kind === "easy" ? "open_self_serve" : app.distributedIntegrationAccess} compact /></div>
      <p>{app.oneLiner}</p>
      <div className="opportunity-meta"><span>{valueLabel(app.apiBreadth)} API</span><span>{valueLabel(app.customerCredentialAccess)}</span><span>{valueLabel(app.composioToolkitExists)} toolkit</span></div>
    </div>
    <span className="opportunity-arrow">↗</span>
  </button>;
}

export default function CaseStudy({ data }: { data: PresentationData }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [buildability, setBuildability] = useState("all");
  const [distribution, setDistribution] = useState("all");
  const [composio, setComposio] = useState("all");
  const [mcp, setMcp] = useState("all");
  const [selectedApp, setSelectedApp] = useState<AppRecord | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [integrityLoading, setIntegrityLoading] = useState(false);

  const appByName = useMemo(() => new Map(data.apps.map((app) => [app.app, app])), [data.apps]);
  const metrics = data.metrics;
  const selfServeCount = (metrics.distribution.customerCredentialAccess.self_serve_free ?? 0) + (metrics.distribution.customerCredentialAccess.self_serve_trial ?? 0) + (metrics.distribution.customerCredentialAccess.self_serve_paid ?? 0);
  const filteredApps = useMemo(() => data.apps.filter((app) => {
    const searchable = `${app.app} ${app.oneLiner} ${app.assignmentHint}`.toLowerCase();
    if (query && !searchable.includes(query.toLowerCase())) return false;
    if (category !== "all" && app.category !== category) return false;
    if (buildability !== "all" && app.technicalBuildability !== buildability) return false;
    if (distribution !== "all" && app.distributedIntegrationAccess !== distribution) return false;
    if (composio !== "all" && app.composioToolkitExists !== composio) return false;
    if (mcp === "official" && app.vendorOfficialMcp !== true) return false;
    if (mcp === "none" && app.vendorOfficialMcp !== false) return false;
    if (mcp === "unknown" && app.vendorOfficialMcp !== "unknown") return false;
    return true;
  }), [data.apps, query, category, buildability, distribution, composio, mcp]);

  useEffect(() => {
    const open = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      const app = appByName.get(name);
      if (app) { setSelectedApp(app); setReplay(null); }
    };
    document.addEventListener("open-app", open);
    return () => document.removeEventListener("open-app", open);
  }, [appByName]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedApp(null); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, []);

  async function runReplay() {
    if (!selectedApp) return;
    setReplayLoading(true);
    setReplay(null);
    try {
      const response = await fetch("/api/replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: selectedApp.app }) });
      if (!response.ok) throw new Error("Replay failed");
      setReplay(await response.json());
    } catch {
      setReplay({ app: selectedApp.app, steps: [{ id: "error", label: "Replay unavailable", status: "fail", detail: "The deterministic audit endpoint did not respond." }], final: {} });
    } finally { setReplayLoading(false); }
  }

  async function runIntegrity() {
    setIntegrityLoading(true);
    try {
      const response = await fetch("/api/integrity");
      if (!response.ok) throw new Error("Integrity check failed");
      setIntegrity(await response.json());
    } catch {
      setIntegrity({ ok: false, datasetId: data.dataset.id, checks: [{ label: "Integrity endpoint", ok: false, detail: "Could not complete the read-only check." }] });
    } finally { setIntegrityLoading(false); }
  }

  const paygent = appByName.get("Paygent Connect");
  const categoryRows = Object.entries(metrics.categoryPatterns);
  const distributionValues = metrics.distribution.distributedIntegrationAccess;
  const mcpTypeValues = metrics.mcp.typeAmongOfficial;

  return <main className="case-study">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Composio integration audit home"><span className="brand-mark">/</span><span>COMPOSIO</span><em>PRODUCT OPS</em></a>
      <nav className="topnav" aria-label="Page navigation"><a href="#insight">Findings</a><a href="#opportunities">Action</a><a href="#explore">{data.dataset.appCount} apps</a><a href="#method">Method</a></nav>
      <span className="dataset-chip">FINAL / V2 <i /> {data.dataset.appCount} APPS</span>
    </header>

    <section className="hero section-shell" id="top">
      <div className="hero-copy">
        <SectionLabel index="01">Agent buildability audit</SectionLabel>
        <h1>{data.dataset.appCount} integrations researched.<br /><span>The hard part wasn't the API.</span></h1>
        <p className="hero-lede">Most integrations are technically possible. Distribution is the real bottleneck.</p>
        <p className="hero-support">An evidence-first audit of {data.dataset.appCount} apps across {Object.keys(metrics.categoryPatterns).length} categories — separating what can be built from what can actually be shipped to everyone.</p>
        <div className="hero-actions"><a className="button primary" href="#explore">Explore the {data.dataset.appCount} apps <span>↓</span></a><a className="button text-button" href="#method">See how it was verified <span>↘</span></a></div>
      </div>
      <div className="hero-aside">
        <div className="aside-kicker">THE DECISION LENS</div>
        <div className="lens-row"><span>01</span><strong>Can it be built?</strong><small>Technical surface</small></div>
        <div className="lens-row active"><span>02</span><strong>Can it be distributed?</strong><small>Access + approval</small></div>
        <div className="lens-row"><span>03</span><strong>Can we prove it?</strong><small>Evidence + review</small></div>
        <div className="hero-aside-foot"><span className="live-dot" /> frozen dataset <strong>{data.dataset.id}</strong></div>
      </div>
    </section>

    <section className="metric-strip section-shell" aria-label="Key findings">
      <MetricCard metric={metrics.headline.technicallyBuildable} detail="Technically buildable" accent="accent-teal" />
      <MetricCard metric={metrics.headline.openDistribution} detail="Open distribution" accent="accent-orange" />
      <MetricCard metric={metrics.headline.productActionMcp} detail="Product-action MCPs" accent="accent-violet" />
      <MetricCard metric={metrics.headline.productActionMcpAbsent} detail="Product-action MCPs missing" accent="accent-ink" />
      <MetricCard metric={{ ...metrics.headline.resolvedHoldoutAccuracy, display: `${metrics.headline.resolvedHoldoutAccuracy.percent?.toFixed(1)}%` }} detail="Human-reviewed holdout" accent="accent-blue" />
    </section>

    <section className="section-shell insight-section" id="insight">
      <div className="section-intro split-intro"><div><SectionLabel index="02">The product ops insight</SectionLabel><h2>API access has<br /><i>two gates.</i></h2></div><p>Customer credentials answer “can this account connect?” Public distribution answers “can Composio safely offer this to every customer?” Those are different queues, with different owners.</p></div>
      <div className="gate-grid">
        <div className="gate-card customer-gate"><div className="gate-number">01</div><div className="gate-icon">◎</div><h3>Customer can get credentials</h3><p>Self-serve access to their own account or workspace.</p><div className="gate-stat"><strong>{selfServeCount}</strong><span>of {data.dataset.appCount} have a self-serve customer path</span></div></div>
        <div className="gate-connector"><span>then ask</span><b>→</b></div>
        <div className="gate-card distribution-gate"><div className="gate-number">02</div><div className="gate-icon">↗</div><h3>Can Composio distribute it?</h3><p>Public OAuth, review, partner, or vendor approval path.</p><div className="gate-stat"><strong>{metrics.distribution.documentedDistributionGates.numerator}</strong><span>documented distribution gates</span></div></div>
      </div>
      <div className="insight-callout"><span className="callout-mark">!</span><p><strong>{metrics.distribution.customerEasyDistributionGated.numerator} apps look self-service from the customer's side</strong> but still gate public distribution. Route those to Partnerships, not an engineering backlog.</p><span className="callout-arrow">↗</span></div>
      <div className="breakdown-block"><div className="breakdown-head"><div><span className="eyebrow">DISTRIBUTION ACCESS / {data.dataset.appCount} APPS</span><h3>The launch path is not binary</h3></div><span className="small-note">Final classifications · v2 rubric</span></div><StackedBar values={distributionValues} total={data.dataset.appCount} /><div className="legend-grid">{Object.entries(distributionValues).filter(([, value]) => value > 0).map(([key, value]) => <div className="legend-item" key={key}><span className={`legend-dot dot-${key}`} /><strong>{value}</strong><span>{valueLabel(key)}</span></div>)}</div></div>
    </section>

    <section className="section-shell mcp-section" id="mcp">
      <div className="section-intro split-intro"><div><SectionLabel index="03">MCP reality check</SectionLabel><h2>“Official MCP”<br /><i>is not one thing.</i></h2></div><p>{metrics.mcp.officialCount} vendors operate an official MCP. Its usefulness depends on what the server can actually do — product action, documentation, or a mix.</p></div>
      <div className="mcp-layout"><div className="mcp-hero-stat"><div className="overline">OFFICIAL VENDOR MCP</div><strong>{metrics.mcp.officialCount}</strong><p>out of {data.dataset.appCount} audited apps</p><div className="mcp-stage-note"><span>{metrics.mcp.unknownStageAmongOfficial}</span> have no documented lifecycle label</div></div><div className="mcp-type-panel"><div className="panel-head"><span>Capability type among official MCPs</span><span>n = {metrics.mcp.officialCount}</span></div><BarList values={mcpTypeValues} total={metrics.mcp.officialCount} colors={["teal", "violet", "orange", "slate"]} /><div className="mcp-definition"><span className="definition-mark">↳</span><span><strong>Product-action</strong> operates on customer/product data. <strong>Documentation</strong> helps an agent find vendor knowledge. Both matter — they solve different jobs.</span></div></div></div>
      <div className="mcp-bottom"><div className="mcp-gap"><span className="eyebrow">NATIVE COVERAGE GAP</span><strong>{metrics.headline.productActionMcpAbsent.display}</strong><span>product-action MCP apps without a current Composio toolkit</span></div><div className="mcp-sanity"><span className="eyebrow">WHY 67 ≠ 92?</span><p>{metrics.mcp.sanityExplanation}</p></div></div>
    </section>

    <section className="section-shell action-section" id="opportunities">
      <div className="section-intro split-intro"><div><SectionLabel index="04">Recommended action</SectionLabel><h2>Turn research<br /><i>into a queue.</i></h2></div><p>Not one giant ranking. Three operating lanes: build the open wins, partner on the gates, and support customer-managed connections where central distribution is not yet available.</p></div>
      <div className="lane-grid"><div className="lane lane-build"><div className="lane-head"><span className="lane-index">A</span><div><h3>Build now</h3><p>Open distribution + accessible credentials</p></div><span className="lane-count">{metrics.opportunities.easyWins.length}</span></div><div className="opportunity-list">{metrics.opportunities.easyWins.map((item) => <OpportunityCard key={item.app} opportunity={item} app={appByName.get(item.app)} kind="easy" />)}</div></div><div className="lane lane-partner"><div className="lane-head"><span className="lane-index">B</span><div><h3>Partner / get approved</h3><p>The technology exists; the gate is external</p></div><span className="lane-count">{metrics.opportunities.partnership.length}</span></div><div className="opportunity-list">{metrics.opportunities.partnership.map((item) => <OpportunityCard key={item.app} opportunity={item} app={appByName.get(item.app)} kind="partnership" />)}</div></div><div className="lane lane-customer"><div className="lane-head"><span className="lane-index">C</span><div><h3>Customer-managed</h3><p>Useful, but not centrally distributable yet</p></div><span className="lane-count">{metrics.opportunities.customerManaged.length}</span></div><div className="customer-managed-summary"><strong>{metrics.opportunities.customerManaged.length}</strong><p>technically useful apps where each customer manages their own credentials or setup.</p><details><summary>See all {metrics.opportunities.customerManaged.length}</summary><div className="name-cloud">{metrics.opportunities.customerManaged.map((item) => <button key={item.app} onClick={() => setSelectedApp(appByName.get(item.app) ?? null)}>{item.app}</button>)}</div></details></div></div></div>
    </section>

    <section className="section-shell category-section" id="categories">
      <div className="section-intro split-intro"><div><SectionLabel index="05">Across the categories</SectionLabel><h2>Where the<br /><i>shape changes.</i></h2></div><p>Technical feasibility is broadest in developer tools and productivity. Commerce and AI/media show more access uncertainty and distribution friction.</p></div>
      <div className="category-chart"><div className="category-chart-head"><span>Category</span><span>Buildable / official MCP / Composio</span></div>{categoryRows.map(([key, row]) => <div className="category-row" key={key}><div className="category-name">{categoryLabels[key] ?? key}</div><div className="category-bars"><span className="cat-bar build" style={{ width: `${(row.technical_buildability.yes ?? 0) / row.app_count * 100}%` }} /><span className="cat-bar mcp" style={{ width: `${row.official_mcp / row.app_count * 100}%` }} /><span className="cat-bar composio" style={{ width: `${row.composio_toolkit / row.app_count * 100}%` }} /></div><div className="category-values"><strong>{row.technical_buildability.yes ?? 0}</strong><span>{row.official_mcp}</span><span>{row.composio_toolkit}</span></div></div>)}<div className="category-legend"><span><i className="legend-line build" />Buildable</span><span><i className="legend-line mcp" />Official MCP</span><span><i className="legend-line composio" />Composio</span></div></div>
    </section>

    <section className="section-shell method-section" id="method">
      <div className="section-intro split-intro"><div><SectionLabel index="06">How the agent worked</SectionLabel><h2>Evidence in.<br /><i>Decisions out.</i></h2></div><p>Every claim carries its source, retrieval method, timestamp, and confidence. The verifier challenges important claims; the human holdout decides where semantics still need judgment.</p></div>
      <div className="pipeline"><div className="pipeline-step"><span>01</span><strong>Manifest</strong><small>{data.dataset.appCount} apps</small></div><i>→</i><div className="pipeline-step"><span>02</span><strong>Resolve identity</strong><small>hint-aware</small></div><i>→</i><div className="pipeline-step"><span>03</span><strong>Collect evidence</strong><small>{metrics.source.uniqueUrls} unique URLs</small></div><i>→</i><div className="pipeline-step"><span>04</span><strong>Classify</strong><small>field-level claims</small></div><i>→</i><div className="pipeline-step"><span>05</span><strong>Falsify</strong><small>{metrics.verification.challengeCount} challenges</small></div><i>→</i><div className="pipeline-step"><span>06</span><strong>Human holdout</strong><small>{metrics.holdout.appCount} apps</small></div><i>→</i><div className="pipeline-step final"><span>07</span><strong>Freeze</strong><small>{data.dataset.id}</small></div></div>
      <div className="proof-grid"><div className="proof-item"><strong>{metrics.source.uniqueUrls}</strong><span>unique evidence URLs</span></div><div className="proof-item"><strong>{metrics.source.retrieval.browser ?? 0}</strong><span>browser fallbacks</span></div><div className="proof-item"><strong>{metrics.verification.sourceDisjoint.percent?.toFixed(1)}%</strong><span>source-disjoint verification</span></div><div className="proof-item"><strong>{metrics.evidenceQuality.high ?? 0}</strong><span>high-quality claim records</span></div><div className="proof-item"><strong>{metrics.headline.paidCost.display}</strong><span>paid research cost</span></div></div>
      <div className="integrity-panel"><div><span className="eyebrow">RUNNABLE PROOF</span><h3>Replay the frozen audit</h3><p>Choose any app below to replay its read-only identity, evidence, validator, and frozen-result path. Nothing in the research dataset can be mutated from this page.</p></div><button className="button outline" onClick={runIntegrity} disabled={integrityLoading}>{integrityLoading ? "Checking…" : "Run dataset integrity check"}<span>↗</span></button>{integrity && <div className={`integrity-result ${integrity.ok ? "ok" : "bad"}`}><strong>{integrity.ok ? "Integrity check passed" : "Integrity check found an issue"}</strong>{integrity.checks.map((check) => <div key={check.label}><span>{check.ok ? "✓" : "×"}</span>{check.label}<small>{check.detail}</small></div>)}</div>}</div>
    </section>

    <section className="section-shell unknown-section">
      <div className="unknown-card"><div className="unknown-index">?</div><div className="unknown-copy"><SectionLabel index="07">The correct result can be unknown</SectionLabel><h2>Don't resolve the<br /><i>wrong product.</i></h2><p>“Paygent Connect — paygent (NMI-powered)” did not reconcile cleanly with the current first-party evidence. The pipeline kept the identity unresolved instead of attaching API claims to a similarly named product.</p><div className="unknown-tags"><span>Assignment hint: <strong>{paygent?.assignmentHint}</strong></span><StatusPill value="unresolved" /><span>{metrics.headline.unresolvedIdentities.display} unresolved identities in total</span></div><div className="unknown-evidence">{paygent?.identityEvidence.slice(0, 2).map((item) => <EvidenceLink evidence={item} key={item.url} />)}</div></div><div className="unknown-side"><span className="eyebrow">ABSTENTION IS A FEATURE</span><strong>{metrics.headline.unresolvedIdentities.display}</strong><p>identities remain unresolved rather than becoming confident false matches.</p></div></div>
    </section>

    <section className="section-shell verification-section" id="verification">
      <div className="section-intro split-intro"><div><SectionLabel index="08">Verification, measured</SectionLabel><h2>First pass.<br /><i>Then scrutiny.</i></h2></div><p>These are human-reviewed calibration metrics on the fixed {metrics.holdout.appCount}-app holdout — not an accuracy claim about the entire {data.dataset.appCount}-app dataset.</p></div>
      <div className="verification-grid"><div className="verification-primary"><span className="eyebrow">RESOLVED-FIELD ACCURACY</span><strong>{metrics.holdout.resolved.percent?.toFixed(1)}%</strong><p>{metrics.holdout.resolved.numerator} correct / {metrics.holdout.resolved.denominator} resolved fields</p></div><div className="verification-secondary"><div><strong>{metrics.holdout.exact.percent?.toFixed(1)}%</strong><span>exact field agreement</span><small>{metrics.holdout.exact.display} fields</small></div><div><strong>{metrics.holdout.automationAbstentions.percent?.toFixed(1)}%</strong><span>automation abstention</span><small>{metrics.holdout.automationAbstentions.display} fields</small></div><div><strong>{metrics.holdout.humanUnresolved.percent?.toFixed(1)}%</strong><span>human-unresolved</span><small>{metrics.holdout.humanUnresolved.display} fields</small></div></div></div>
      <div className="verification-foot"><div className="repair-note"><span className="eyebrow">SCHEMA REPAIR</span><p><strong>{metrics.holdout.schemaRepair.repaired}</strong> v1→v2 fields changed; <strong>{metrics.holdout.schemaRepair.accepted}</strong> were accepted by human review.</p><span className="repair-bar"><i style={{ width: `${metrics.holdout.schemaRepair.acceptedPercent}%` }} /></span><small>{metrics.holdout.schemaRepair.acceptedPercent.toFixed(2)}% accepted · same holdout before and after repair</small></div><div className="method-note"><span className="eyebrow">READ THE DENOMINATOR</span><p>Resolved accuracy excludes automation abstentions and fields the human intentionally left unknown. Exact agreement includes approved unknowns.</p><a href="#explore">Inspect the field-level records ↗</a></div></div>
    </section>

    <section className="section-shell explorer-section" id="explore">
      <div className="explorer-head"><div><SectionLabel index="09">Explore the dataset</SectionLabel><h2>{data.dataset.appCount} apps. One<br /><i>operating view.</i></h2></div><div className="explorer-summary"><strong>{filteredApps.length}</strong><span>matching apps</span><small>Every row opens its evidence trail</small></div></div>
      <div className="filter-bar"><label className="search-field"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps, hints, descriptions" aria-label="Search apps" /></label><select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter by category"><option value="all">All categories</option>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select value={buildability} onChange={(event) => setBuildability(event.target.value)} aria-label="Filter by technical buildability"><option value="all">Any buildability</option><option value="yes">Technically buildable</option><option value="limited">Limited</option><option value="unknown">Unknown</option></select><select value={distribution} onChange={(event) => setDistribution(event.target.value)} aria-label="Filter by distribution access"><option value="all">Any distribution path</option>{Object.keys(distributionValues).map((key) => <option key={key} value={key}>{valueLabel(key)}</option>)}</select><select value={composio} onChange={(event) => setComposio(event.target.value)} aria-label="Filter by Composio toolkit"><option value="all">Any Composio status</option><option value="yes">Toolkit present</option><option value="no">Toolkit missing</option></select><select value={mcp} onChange={(event) => setMcp(event.target.value)} aria-label="Filter by official MCP"><option value="all">Any MCP status</option><option value="official">Official MCP</option><option value="unknown">MCP unknown</option></select></div>
      <div className="table-wrap"><table><thead><tr><th>App</th><th>Category</th><th>Buildability</th><th>Customer access</th><th>Distribution</th><th>API</th><th>Official MCP</th><th>MCP type</th><th>Composio</th><th>Status</th></tr></thead><tbody>{filteredApps.map((app) => <tr key={app.app} onClick={() => setSelectedApp(app)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedApp(app); } }}><td><button className="app-name-button" onClick={(event) => { event.stopPropagation(); setSelectedApp(app); }}><strong>{app.app}</strong><small>{app.humanReviewed ? "Human-reviewed" : app.oneLiner}</small></button></td><td><span className="category-text">{categoryLabels[app.category] ?? app.category}</span></td><td><StatusPill value={app.technicalBuildability} compact /></td><td><StatusPill value={app.customerCredentialAccess} compact /></td><td><StatusPill value={app.distributedIntegrationAccess} compact /></td><td><span className="plain-value">{valueLabel(app.publicApiAvailable)}</span></td><td><StatusPill value={app.vendorOfficialMcp === true ? "yes" : app.vendorOfficialMcp} compact /></td><td><StatusPill value={app.vendorMcpType} compact /></td><td><StatusPill value={app.composioToolkitExists} compact /></td><td><span className="plain-value">{valueLabel(app.mainBlocker)}</span></td></tr>)}</tbody></table></div>
      <div className="mobile-app-list">{filteredApps.map((app) => <button key={app.app} className="mobile-app-card" onClick={() => setSelectedApp(app)}><div className="mobile-app-head"><strong>{app.app}</strong><span>{categoryLabels[app.category] ?? app.category}</span></div><p>{app.oneLiner}</p><div className="mobile-app-pills"><StatusPill value={app.technicalBuildability} compact /><StatusPill value={app.distributedIntegrationAccess} compact /><StatusPill value={app.composioToolkitExists} compact /></div></button>)}</div>
    </section>

    <footer className="footer section-shell"><div className="footer-brand"><span className="brand-mark">/</span><strong>COMPOSIO / PRODUCT OPS</strong><p>Evidence-first agent buildability audit.</p></div><div className="footer-meta"><div><span>Dataset</span><strong>{data.dataset.id}</strong></div><div><span>Schema</span><strong>{data.dataset.schemaVersion}</strong></div><div><span>Source URLs</span><strong>{metrics.source.uniqueUrls}</strong></div><div><span>Cost</span><strong>{metrics.headline.paidCost.display}</strong></div></div><div className="footer-links"><a href="#top">Back to top ↑</a><a href="https://github.com/Suraj-H675/composio-integration-audit" target="_blank" rel="noreferrer">View source ↗</a></div></footer>

    {selectedApp && <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedApp(null); }}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-label={`${selectedApp.app} detail`}><div className="drawer-head"><div><span className="eyebrow">{categoryLabels[selectedApp.category] ?? selectedApp.category}</span><h2>{selectedApp.app}</h2></div><button className="close-button" onClick={() => setSelectedApp(null)} aria-label="Close details">×</button></div><p className="drawer-description">{selectedApp.oneLiner}</p><div className="drawer-tags"><StatusPill value={selectedApp.technicalBuildability} /><StatusPill value={selectedApp.distributedIntegrationAccess} /><span className="review-badge">{selectedApp.humanReviewed ? "✓ Human-reviewed" : "Automated record"}</span></div><div className="drawer-actions"><button className="button primary" onClick={runReplay} disabled={replayLoading}>{replayLoading ? "Replaying…" : "Replay audit"}<span>↗</span></button><span>Read-only · frozen record</span></div>{replay && <div className="replay-panel"><div className="panel-head"><span>Replay result</span><span>{replay.steps.filter((step) => step.status === "pass").length}/{replay.steps.length} checks pass</span></div>{replay.steps.map((step) => <div className="replay-step" key={step.id}><span className={`replay-status ${step.status}`}>{step.status === "pass" ? "✓" : step.status === "warn" ? "!" : "×"}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></div>)}</div>}<div className="detail-grid"><div><span>Identity</span><strong>{valueLabel(selectedApp.identity.status)}</strong><small>{selectedApp.identity.vendor ?? "No confirmed vendor"}</small></div><div><span>Customer credentials</span><strong>{valueLabel(selectedApp.customerCredentialAccess)}</strong><small>Own account access</small></div><div><span>Distribution</span><strong>{valueLabel(selectedApp.distributedIntegrationAccess)}</strong><small>Multi-customer path</small></div><div><span>API surface</span><strong>{valueLabel(selectedApp.apiBreadth)}</strong><small>{valueLabel(selectedApp.apiStyles)}</small></div><div><span>Official MCP</span><strong>{valueLabel(selectedApp.vendorOfficialMcp)}</strong><small>{valueLabel(selectedApp.vendorMcpType)} · {valueLabel(selectedApp.vendorMcpStage)}</small></div><div><span>Composio</span><strong>{valueLabel(selectedApp.composioToolkitExists)}</strong><small>{selectedApp.composioToolkitIdentifier ?? valueLabel(selectedApp.composioToolkitMatchType)}</small></div><div><span>Auth</span><strong>{valueLabel(selectedApp.primaryAuth)}</strong><small>{valueLabel(selectedApp.authMethods)}</small></div><div><span>Friction / blocker</span><strong>{valueLabel(selectedApp.mainBlocker)}</strong><small>{valueLabel(selectedApp.commercialFriction)} · {valueLabel(selectedApp.setupFriction)}</small></div></div><div className="claim-evidence"><div className="panel-head"><span>Evidence trail</span><span>{selectedApp.claims.reduce((sum, claim) => sum + claim.evidence.length, 0)} claim sources</span></div>{selectedApp.claims.filter((claim) => claim.evidence.length > 0).map((claim) => <details key={claim.field}><summary><span>{data.fieldLabels[claim.field] ?? valueLabel(claim.field)}</span><StatusPill value={claim.value} compact /></summary><p>{claim.evidence[0].statement}</p><EvidenceLink evidence={claim.evidence[0]} /><small className="evidence-time">Checked {claim.evidence[0].checkedAt ?? "unknown"} · {claim.evidence[0].retrievalMethod}</small></details>)}</div></aside></div>}
  </main>;
}
