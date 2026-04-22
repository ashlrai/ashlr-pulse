# Personas

Three concentric circles. We ship for the innermost first.

## 1. The founding pair (Mason + cofounder)

**The canonical user.**

- 2 people, 25 repos, maybe 6 active SaaS products + 4–6 custom client
  engagements concurrently.
- Each founder spends ~60%+ of coding time in AI agents (Claude Code primary,
  Cursor or Copilot secondary, aider in terminal for specific tasks).
- They coordinate mostly async. There's no manager, no standup, no sprint
  planning ceremony that scales to what they're doing.
- They already feel the "I have no idea what my cofounder is building right
  now" problem, and solve it today with ad-hoc `#general` Slack messages +
  GitHub notifications + weekly calls.

**What they need from Pulse v0.1–v0.2:**
- Glance at a dashboard once a day, see what the other shipped and where.
- Per-project grouping so "the client work" and "our SaaS X" are visible as
  separate portfolios.
- Cost visibility per engagement — "how much AI did we spend on that client
  project this month?"
- Zero tedium. No manual tagging, no Jira-style tickets, no per-commit
  categorization.

**What they don't need:**
- DORA metrics. (They're not shipping to production on a SRE schedule.)
- Acceptance-rate comparison between them — they're partners, not rivals.
- A manager-style "are my reports productive" view.

## 2. The early team (3–20 engineers at agentic startups)

**The first commercial customer.**

- Founding pair expanded to a small team, same agentic-heavy workflow.
- Usually a mix: founding eng on everything; early hires on specific
  products; sometimes a contractor on a client engagement.
- Starting to feel Slack-plus-gut-feel breaking down. Need real portfolio
  visibility without introducing enterprise process theater.
- The buyer is still the founder, not a manager.

**What they add on top of the pair's needs:**
- Per-product ownership and staffing — who's driving SaaS X this week?
- Client engagement billing support — hours × AI cost by repo, exported.
- Opt-in per-person per-project visibility ("this new hire sees only the
  SaaS X project aggregates, not our roadmap repo").
- Eng-led not PM-led culture: the tool should feel like tooling, not process.

**What they don't want:**
- Company-wide "productivity score" leaderboards.
- Rigid sprints, rigid OKR hierarchies.
- Manager-facing "who's been offline" surveillance.

## 3. The scaling AI-native org (20–100, later)

**Future expansion. Not a v1 target.**

- Multiple product teams, each heavy on agentic engineering.
- An engineering leader exists now but still came up through the same
  agent-native workflow and rejects bossware tools.
- Integrates with Linear / Slack / Notion for planning; uses Pulse for the
  "what's actually happening" view.

**What they add:**
- Multi-team rollups and cross-team comparisons.
- Budget-style AI spend allocation per team.
- Correlation between AI adoption and delivery outcomes, benchmarked vs
  peer companies.
- SSO, audit logs, the usual enterprise things.

## Anti-personas

We don't build for, and will cheerfully decline to build for:

- **The "monitor my employees" manager.** Pulse is peer-visibility; the data
  model doesn't support surveillance asymmetry.
- **The traditional-shop VP Eng.** Their DORA-driven, Jira-heavy workflow is
  served by Swarmia et al. We're building for the teams those tools don't fit.
- **The compliance-first enterprise** where every AI usage fact must flow
  through central IT. Good problem for someone else; wrong shape for v1.

## The 500-day vision

**Mason and cofounder use Pulse every morning as their glass-of-water
dashboard.** They know at a glance what the other shipped, which client
engagement is behind, which SaaS product is accelerating, and how much the
month's AI spend bought them. They use an AI-generated weekly recap to skip a
status meeting. When they hire a third engineer, that person is onboarded into
Pulse's configurable-sharing model in fifteen minutes.

A handful of AI-native cofounder pairs hear about Pulse through AshlrAI's
channels and the OSS release, install it in an afternoon, and start paying for
cloud hosting within their first week. Pulse is the default tool for "we are a
two-founder AI startup and we have too many repos to track in our heads." Then
it grows.
