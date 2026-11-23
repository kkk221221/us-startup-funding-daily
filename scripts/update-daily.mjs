#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const FORMDPULSE_ORIGIN = "https://formdpulse.formdpulse.workers.dev";
const SEC_USER_AGENT = "USStartupFundingDaily/0.1 (support@formdpulse.com)";

const EXCLUDED_INDUSTRIES = new Set([
  "Pooled Investment Fund",
  "Residential",
  "Commercial",
  "Other Real Estate",
  "Construction",
  "REITS and Finance",
]);

function isOperatingStartup(filing) {
  if (!filing || typeof filing !== "object") return false;
  if (filing.isPooledInvestmentFund === true) return false;
  const name = String(filing.entityName || "");
  if (/GS Finance Corp/i.test(name)) return false;
  if (/^(CRE |AHRC )/i.test(name)) return false;
  const industry = String(filing.industryGroupType || "");
  if (EXCLUDED_INDUSTRIES.has(industry)) return false;
  return true;
}

function getTodayDateUtc() {
  return new Date().toISOString().slice(0, 10);
}

function formatUsd(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "Undisclosed";
  if (amount === 0) return "$0";
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function escapeMd(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function csvCell(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function decodeXmlEntities(input) {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(input) {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTag(block, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "i");
  const match = block.match(re);
  return match ? match[1].trim() : "";
}

function extractAttr(block, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, "i");
  const match = block.match(re);
  return match ? decodeXmlEntities(match[1].trim()) : "";
}

async function fetchFormDPulsePreview() {
  try {
    const res = await fetch(
      `${FORMDPULSE_ORIGIN}/api/v1/filings?preview=1&exclude_funds=true&limit=5`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": SEC_USER_AGENT,
        },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!res.ok) {
      return { ok: false, filings: [], note: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const filings = Array.isArray(data?.filings) ? data.filings : [];
    return { ok: true, filings, note: null };
  } catch (err) {
    return {
      ok: false,
      filings: [],
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchLiveSecOperatingFeed() {
  try {
    const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&count=40&output=atom";
    const res = await fetch(url, {
      headers: {
        "User-Agent": SEC_USER_AGENT,
        Accept: "application/atom+xml, application/xml, text/xml;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return { ok: false, entries: [], note: `HTTP ${res.status}` };
    }
    const xml = await res.text();
    const entries = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
    let match;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = decodeXmlEntities(extractTag(block, "title"));
      const categoryTerm = extractAttr(block, "category", "term");
      const linkHref = extractAttr(block, "link", "href");
      const updated = decodeXmlEntities(extractTag(block, "updated"));
      const idTag = decodeXmlEntities(extractTag(block, "id"));
      const summary = stripTags(decodeXmlEntities(extractTag(block, "summary")));

      const m = title.match(/^([A-Z0-9/+-]+)\s+-\s+(.+?)\s+\((\d{10})\)/i);
      const formType = (categoryTerm || m?.[1] || "").trim().toUpperCase();
      if (formType !== "D" && formType !== "D/A") continue;

      const entityName = m ? m[2].trim() : title;
      const cik = m ? m[3] : "";
      const accNo =
        idTag.match(/accession-number=([0-9-]+)/i)?.[1] ||
        summary.match(/AccNo:\s*([0-9-]+)/i)?.[1] ||
        "";
      const filedDate = summary.match(/Filed:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || updated.slice(0, 10);

      // Filter out obvious pooled investment funds / 3(c) funds
      const looksLikeFund =
        /Investment Company Act Section 3\(c\)/i.test(summary) ||
        /\b(Fund|Ventures|Capital Partners|Feeder|Offshore|QP)\b.*\b(LP|L\.P\.|LLC)\b/i.test(
          entityName,
        );
      if (looksLikeFund) continue;
      if (/GS Finance Corp/i.test(entityName)) continue;

      const cikNum = cik ? String(Number(cik)) : "";
      const accNoDash = accNo.replace(/-/g, "");
      const primaryXml =
        cikNum && accNoDash
          ? `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/primary_doc.xml`
          : linkHref;

      entries.push({
        entityName,
        formType,
        filedDate,
        cik,
        accessionNumber: accNo,
        edgarIndexUrl: linkHref,
        primaryXmlUrl: primaryXml,
      });
    }
    return { ok: true, entries: entries.slice(0, 15), note: null };
  } catch (err) {
    return {
      ok: false,
      entries: [],
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

function loadExistingFilings(todayFile) {
  if (fs.existsSync(todayFile)) {
    return JSON.parse(fs.readFileSync(todayFile, "utf8"));
  }
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  if (files.length > 0) {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[0]), "utf8"));
  }
  return [];
}

function writeCsv(filings, csvPath) {
  const headers = [
    "entity_name",
    "form_type",
    "filed_at",
    "state",
    "industry",
    "total_amount_sold_usd",
    "total_offering_amount_usd",
    "resolved_domain",
    "mx_provider",
    "detected_ats",
    "signal_score",
    "cik",
    "accession_number",
    "sec_filing_url",
    "formdpulse_dossier_url",
  ];
  const rows = [headers.join(",")];
  for (const f of filings) {
    const t = f.telemetry ?? {};
    const dossierUrl = f.slug ? `${FORMDPULSE_ORIGIN}/filing/${f.slug}` : FORMDPULSE_ORIGIN;
    rows.push(
      [
        f.entityName,
        f.formType ?? "D",
        f.filedAt ?? "",
        f.stateOrCountry ?? "",
        f.industryGroupType ?? "",
        f.totalAmountSold ?? "",
        f.totalOfferingAmount ?? "",
        t.resolvedDomain ?? "",
        t.mxProvider ?? "",
        t.detectedAts ?? "",
        f.signalScore ?? "",
        f.cik ?? "",
        f.accessionNumber ?? "",
        f.filingUrl ?? "",
        dossierUrl,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  fs.writeFileSync(csvPath, `${rows.join("\n")}\n`, "utf8");
}

function renderReadme({ dateStr, filings, secFeed }) {
  const sorted = [...filings].sort((a, b) => {
    const soldDiff = (b.totalAmountSold ?? 0) - (a.totalAmountSold ?? 0);
    if (soldDiff !== 0) return soldDiff;
    return String(b.filedAt ?? "").localeCompare(String(a.filedAt ?? ""));
  });

  const enrichedRows = sorted
    .map((f) => {
      const domain = f.telemetry?.resolvedDomain ? `\`${f.telemetry.resolvedDomain}\`` : "—";
      const secLink = f.filingUrl ? `[SEC XML](${f.filingUrl})` : "—";
      const dossierUrl = f.slug ? `${FORMDPULSE_ORIGIN}/filing/${f.slug}` : FORMDPULSE_ORIGIN;
      const dossierLink = `[Dossier](${dossierUrl})`;
      const amount = formatUsd(f.totalAmountSold);
      return `| ${escapeMd(f.entityName)} | ${amount} | ${escapeMd(f.stateOrCountry || "—")} | ${escapeMd(f.industryGroupType || "—")} | ${escapeMd(f.formType || "D")} | ${domain} | ${secLink} | ${dossierLink} |`;
    })
    .join("\n");

  const secSection =
    secFeed.ok && secFeed.entries.length > 0
      ? [
          "## Live SEC EDGAR Form D Feed (Latest Non-Fund Candidates)",
          "",
          "| Issuer Name | Form | Filed | CIK | SEC Index | Primary XML |",
          "| --- | --- | --- | --- | --- | --- |",
          ...secFeed.entries.map(
            (e) =>
              `| ${escapeMd(e.entityName)} | ${escapeMd(e.formType)} | ${escapeMd(e.filedDate)} | \`${escapeMd(e.cik)}\` | [Index](${e.edgarIndexUrl}) | [XML](${e.primaryXmlUrl}) |`,
          ),
        ].join("\n")
      : `## Live SEC EDGAR Form D Feed\n\n_Feed check note: ${secFeed.note || "No non-fund entries in current batch."}_`;

  return `# US Startup Funding Daily (SEC Form D Open Dataset)

Automated daily open dataset of newly filed **U.S. SEC Regulation D (Form D / D/A)** startup funding rounds, filtered to exclude pooled investment funds, structured finance vehicles, and obvious real estate holding LLCs.

- **Latest Snapshot Date:** \`${dateStr}\`
- **Operating Startup Filings Tracked:** **${sorted.length}**
- **Files:** [\`data/${dateStr}.json\`](./data/${dateStr}.json) · [\`data/latest-operating-filings.csv\`](./data/latest-operating-filings.csv)
- **Automated Schedule:** Updated Monday–Friday at 22:15 UTC via GitHub Actions ([\`daily-sync.yml\`](./.github/workflows/daily-sync.yml))

## Enriched Operating Startup Filings

| Issuer Name | Amount Raised | State | Industry | Form Type | Corporate Domain | SEC Filing | FormDPulse Dossier |
| --- | ---: | --- | --- | --- | --- | --- | --- |
${enrichedRows}

${secSection}

## Tools & API

- **MCP Server & CLI:** [\`kkk221221/formdpulse-mcp\`](https://github.com/kkk221221/formdpulse-mcp) — Query SEC EDGAR Form D filings directly from Claude Desktop, Cursor, or terminal (\`npx github:kkk221221/formdpulse-mcp --latest\`).
- **Full Enriched Telemetry & API:** [FormDPulse](${FORMDPULSE_ORIGIN}) — Corporate domain resolution, MX provider, ATS hiring signals, and filtered CSV/JSON API (\`/api/v1/filings\`).

## License

MIT
`;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dateStr = getTodayDateUtc();
  const todayFile = path.join(DATA_DIR, `${dateStr}.json`);
  const csvFile = path.join(DATA_DIR, "latest-operating-filings.csv");

  const existing = loadExistingFilings(todayFile).filter(isOperatingStartup);
  const byAcc = new Map();
  for (const f of existing) {
    const key = f.accessionNumber || f.slug || f.entityName;
    byAcc.set(key, f);
  }

  const [previewRes, secFeed] = await Promise.all([
    fetchFormDPulsePreview(),
    fetchLiveSecOperatingFeed(),
  ]);

  if (previewRes.ok) {
    for (const f of previewRes.filings) {
      if (!isOperatingStartup(f)) continue;
      const key = f.accessionNumber || f.slug || f.entityName;
      byAcc.set(key, f);
    }
  } else {
    console.warn(`[update-daily] FormDPulse preview fetch skipped (${previewRes.note})`);
  }

  const merged = Array.from(byAcc.values()).sort((a, b) =>
    String(b.filedAt ?? "").localeCompare(String(a.filedAt ?? "")),
  );

  fs.writeFileSync(todayFile, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  writeCsv(merged, csvFile);

  const readme = renderReadme({ dateStr, filings: merged, secFeed });
  fs.writeFileSync(path.join(ROOT, "README.md"), readme, "utf8");

  console.log(
    `[update-daily] Wrote ${merged.length} operating filings to data/${dateStr}.json, data/latest-operating-filings.csv, and README.md (SEC live entries: ${secFeed.entries.length}).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
