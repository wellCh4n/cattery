# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Teams that work with an AI coding agent together: software engineers who use it to change code, run commands and preview apps, plus non-engineers (for example product, design and operations) who use it for prototypes, documents and data work. Platform administrators also use the product to manage users, the skill library and usage, but they are not the primary audience.

## Product Purpose

Cattery is a self-hosted, team-oriented AI coding agent platform. Work is organized into Projects, shared workspaces with their own files and members. People drive the agent through Sessions inside a Project. Success is a team that shares one workspace and one agent environment without each member setting up their own.

## Positioning

What a neighboring product could not truthfully copy:

- **Shared project workspace.** Each Project has one isolated sandbox and one file workspace shared by all its members. Sessions are private to their creator, but any member can follow a session live and fork it into their own copy.
- **Self-hosted, data stays inside the network.** It runs on the team's own Kubernetes cluster. Model endpoints and keys are managed by the platform, not by individual users.
- **Platform-wide model and skill catalog.** Members can only pick models from the platform catalog, and skills are installed per project from a shared library.

## Operating Context

- Deployed on self-hosted Kubernetes, internal use only. There is no SSO and no audit log yet.
- Accounts are created by an admin; there is no self-signup.
- Two project roles only: owner and member.
- Users work across several surfaces at once: chat sessions, a file browser and editor, web terminals, port previews of apps the agent starts, a skill browser, and usage dashboards.
- A single agent (pi) runs inside each project sandbox.

## Capabilities and Constraints

- Sessions stream the agent's replies, thinking, tool calls and token usage live; a message sent while the agent runs is steered into the current turn.
- Models come from a catalog file, with an effort level per session. There are no custom model ids.
- Sessions are writable only by their creator; other members read and follow them.
- Terminology: Project, Session, Sandbox, Skill, Apps (listening ports), Members.
- Detailed architecture lives in CLAUDE.md and README.md and is not repeated here.

## Brand Commitments

- Name: Cattery.
- Mark: a cat silhouette with terminal prompt strokes inside it (`web/components/cattery-logo.tsx`, `web/app/icon.svg`). It follows the text color and inverts in dark mode.
- The current interface is a single monospace family (Geist Mono). This is the incumbent state, not a decision recorded as binding.

## Evidence on Hand

- README.md and CLAUDE.md describe the product and architecture.
- The logo and icon above.
- Absent, and not to be fabricated: customer names, testimonials, case studies, benchmarks, pricing, licensing terms, and marketing copy.

## Product Principles

- **One shared workspace, private sessions.** Collaboration happens around the project's files and live following, not around shared chat.
- **Usable by non-engineers.** Do not assume terminal fluency; engineers still keep fast access to terminals, files and raw tool output.
- **The platform decides, members choose within it.** Models, skills and access are curated centrally, so the interface should show clear options rather than free-form configuration.
- **Self-hosted means no outward dependencies.** Do not add features that need third-party hosted services.

## Accessibility & Inclusion

- The interface must support both Chinese and English. It is English-only today (`<html lang="en">`). Layout and copy work must allow for text length changes and CJK rendering.
- No formal accessibility standard (such as WCAG AA) was specified. Treat contrast, keyboard operation and screen reader support as good practice, and record any stricter requirement here when the team sets one.
