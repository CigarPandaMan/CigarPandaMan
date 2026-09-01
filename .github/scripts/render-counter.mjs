#!/usr/bin/env node
// Renders the past-year contribution carpet cards (dark + light) plus a
// shields.io endpoint badge. Runs locally to seed and in Actions on a cron.
//
// Data sources:
//   - Contribution calendar via GraphQL (trailing 365 days): includes private
//     activity because the profile's "include private contributions" setting
//     is on, so the default GITHUB_TOKEN is enough.
//   - Exact commit count via the commit-search API: needs a token that can see
//     the private repos. When HAS_PAT != "true" the number is carried from
//     state.json and labeled with its count date instead.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USER = "CigarPandaMan";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const HAS_PAT = process.env.HAS_PAT === "true";
if (!TOKEN) {
  console.error("GH_TOKEN is required");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const statePath = join(here, "state.json");
const distDir = join(repoRoot, "dist");
mkdirSync(distDir, { recursive: true });

async function gql(query) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL failed: ${res.status} ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`REST ${path} failed: ${res.status}`);
  return res.json();
}

// --- trailing-year contribution calendar (same window the profile graph shows) ---
const now = new Date();
const data = await gql(`query {
  user(login: "${USER}") {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount date weekday } }
      }
    }
  }
}`);
const cal = data.user.contributionsCollection.contributionCalendar;
const weeks = cal.weeks;
const total = cal.totalContributions;

let bestDay = { count: 0, date: null };
const nonzero = [];
for (const w of weeks) {
  for (const d of w.contributionDays) {
    if (d.contributionCount > bestDay.count) bestDay = { count: d.contributionCount, date: d.date };
    if (d.contributionCount > 0) nonzero.push(d.contributionCount);
  }
}
const dailyAvg = total / 365;

// Quantile thresholds over active days -> 4 intensity levels above zero.
nonzero.sort((a, b) => a - b);
const q = (p) => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] || 1;
const T = [q(0.25), q(0.5), q(0.75)];
const level = (c) => (c === 0 ? 0 : c <= T[0] ? 1 : c <= T[1] ? 2 : c <= T[2] ? 3 : 4);

// --- exact commit count: live with a PAT, otherwise carried from state ---
let state = JSON.parse(readFileSync(statePath, "utf8"));
if (HAS_PAT) {
  const from = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const yr = await rest(`/search/commits?q=author:${USER}+author-date:${from}..${to}&per_page=1`);
  state = {
    commits_last_year: yr.total_count,
    counted_at: to,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

const fmt = (n) => n.toLocaleString("en-US");
const stampDate = new Date(state.counted_at + "T00:00:00Z").toLocaleDateString("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const bestDayLabel = new Date(bestDay.date + "T00:00:00Z").toLocaleDateString("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const renderedAt = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";

// --- render ---
const THEMES = {
  dark: {
    bg: "#0D1117", border: "#30363D", text: "#C9D1D9", muted: "#8B949E",
    faint: "#6E7681", gold: "#B08D57", pill: "#161B22",
    // ember ramp: empty -> deep crimson -> bright gold
    ramp: ["#161B22", "#4A160D", "#7E2A12", "#B0662E", "#E6C88A"],
  },
  light: {
    bg: "#FFFFFF", border: "#D0D7DE", text: "#1F2328", muted: "#57606A",
    faint: "#6E7781", gold: "#8A6D3B", pill: "#F6F8FA",
    // reversed for a light ground: pale gold -> deep crimson
    ramp: ["#EFF1F3", "#EBD9B4", "#D9A85F", "#B0662E", "#7E1A0C"],
  },
};

const W = 860, H = 348;
const FONT = `'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, 'Liberation Mono', monospace`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function card(theme) {
  const t = THEMES[theme];

  // --- carpet geometry ---
  const left = 30, top = 112;
  const cols = weeks.length;
  const slot = (W - left * 2) / cols; // ~15.1 for 53 weeks
  const cell = slot - 2.6;
  const rowH = 15.2;

  let carpet = "";
  let monthLabels = "";
  let lastMonth = -1;
  weeks.forEach((w, wi) => {
    const x = left + wi * slot;
    const first = new Date(w.contributionDays[0].date + "T00:00:00Z");
    const m = first.getUTCMonth();
    // label a month at its first full week; skip a cramped label in the last column
    if (m !== lastMonth && first.getUTCDate() <= 7 && wi < cols - 1) {
      monthLabels += `<text x="${x.toFixed(1)}" y="${top - 10}" font-family="${FONT}" font-size="11" fill="${t.faint}">${MONTHS[m]}</text>`;
    }
    lastMonth = m;
    const delay = (wi * 0.022).toFixed(3);
    let col = "";
    for (const d of w.contributionDays) {
      const y = top + d.weekday * rowH;
      col += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="3" fill="${t.ramp[level(d.contributionCount)]}"/>`;
    }
    carpet += `<g class="wk" style="animation-delay:${delay}s">${col}</g>`;
  });

  const legendY = top + 7 * rowH + 14;
  let legend = `<text x="${W - left - 118}" y="${legendY}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${t.faint}">less</text>`;
  t.ramp.forEach((c, i) => {
    legend += `<rect x="${W - left - 110 + i * 17}" y="${legendY - 9}" width="12" height="12" rx="3" fill="${c}"/>`;
  });
  legend += `<text x="${W - left - 110 + 5 * 17 + 4}" y="${legendY}" font-family="${FONT}" font-size="11" fill="${t.faint}">more</text>`;

  // --- stat pills ---
  const pills = [
    { label: "CONTRIBUTIONS", value: fmt(total) },
    { label: "COMMITS AUTHORED", value: fmt(state.commits_last_year), note: HAS_PAT ? "" : `tallied ${stampDate}` },
    { label: "BEST DAY", value: fmt(bestDay.count), note: bestDayLabel },
    { label: "DAILY AVG", value: dailyAvg.toFixed(1) },
  ];
  const pillY = H - 78, pillH = 52;
  const widths = [172, 236, 168, 148];
  let px = left;
  let pillsSvg = "";
  pills.forEach((p, i) => {
    const w = widths[i];
    const noteSvg = p.note
      ? `<text x="${px + 16 + 13.2 * (p.value.length + 0.6)}" y="${pillY + 42}" font-family="${FONT}" font-size="11" fill="${t.faint}">${p.note}</text>`
      : "";
    pillsSvg += `
      <g class="fade" style="animation-delay:${(0.9 + i * 0.12).toFixed(2)}s">
        <rect x="${px}" y="${pillY}" width="${w}" height="${pillH}" rx="10" fill="${t.pill}" stroke="${t.border}"/>
        <text x="${px + 16}" y="${pillY + 21}" font-family="${FONT}" font-size="11" letter-spacing="1.5" fill="${t.faint}">${p.label}</text>
        <text x="${px + 16}" y="${pillY + 42}" font-family="${MONO}" font-size="19" font-weight="700" fill="${t.gold}">${p.value}</text>${noteSvg}
      </g>`;
    px += w + 14;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
  aria-label="Contribution heatmap for the past year: ${fmt(total)} contributions across public and private repos, best day ${fmt(bestDay.count)}">
  <style>
    .wk{opacity:0;animation:sweep .5s ease-out forwards}
    @keyframes sweep{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    .fade{opacity:0;animation:fadein .6s ease-out forwards}
    @keyframes fadein{to{opacity:1}}
    @media (prefers-reduced-motion: reduce){.wk,.fade{animation:none;opacity:1}}
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${t.bg}" stroke="${t.border}"/>
  <text x="${left}" y="44" font-family="${FONT}" font-size="16" font-weight="700" letter-spacing="3" fill="${t.gold}">EXHIBIT A &#183; THE PAST 365 DAYS</text>
  <text x="${left}" y="66" font-family="${FONT}" font-size="12.5" fill="${t.muted}">every square sworn, notarized, and re-counted every 6 hours by a robot paralegal</text>
  ${monthLabels}
  ${carpet}
  ${legend}
  ${pillsSvg}
  <text x="${W - left}" y="${H - 12}" text-anchor="end" font-family="${FONT}" font-size="10.5" fill="${t.faint}">auto-tallied ${renderedAt}</text>
</svg>`;
}

for (const theme of ["dark", "light"]) {
  writeFileSync(join(distDir, `counter-${theme}.svg`), card(theme));
}

writeFileSync(
  join(distDir, "badge.json"),
  JSON.stringify({
    schemaVersion: 1,
    label: "contributions · past year",
    message: fmt(total),
    color: "b08d57",
    labelColor: "0d1117",
  }) + "\n"
);
writeFileSync(
  join(distDir, "meta.json"),
  JSON.stringify({ total, bestDay, dailyAvg: +dailyAvg.toFixed(2), thresholds: T, commits: state, renderedAt }, null, 2) + "\n"
);

console.log(`past-year contributions: ${total}`);
console.log(`best day: ${bestDay.count} on ${bestDay.date}; daily avg ${dailyAvg.toFixed(1)}`);
console.log(`commits (past year): ${state.commits_last_year} (as of ${state.counted_at}, live=${HAS_PAT})`);
