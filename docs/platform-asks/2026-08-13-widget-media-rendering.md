# Platform ask: let the chat widget render media from a tool

**Date:** 2026-08-13 · **From:** Hari · **Context:** the "Multimedia AI Assistants" feature request

## What works today

Assistants can already send images, video, voice notes and documents on SMS,
WhatsApp, Instagram, Facebook and email, through a custom tool that posts to the
CRM's `/conversations/messages` with an `attachments` array. Live and working.

## What does not

The same tool runs in the chat widget — `chat-widget.ts:1050` loads the
assistant's custom tools and `:197` executes them through `executeProxiedTool`,
same as voice and chat — but the media cannot appear in the widget.

Two reasons, both in the platform:

**1. The widget renders rich content only from `search_artifacts`.** The
frontend keys off that specific tool name and renders its `items` as cards
(`chat-widget.ts:276`: *"The widget renders cards inline — do NOT paste image
URLs or repeat raw fields"*). Any other tool's result is text.

**2. Artifacts have no public API.** The `Artifact` model already carries
exactly the right fields — `kind`, `title`, `description`, `imageUrl`, `url`,
`priceCents` — but there are no v3 endpoints for it, so an integration cannot
register anything the widget would render.

There is also no channel to fall back to: the widget creates a bare CRM contact
with no conversation, so there is nothing to attach a file to. We currently
degrade to putting the URL in the reply text as a link, which works but looks
like a link rather than a video.

## What we are asking for

Either one of these unblocks it. The second is smaller.

**Option A — public artifact endpoints.** `POST/PATCH/DELETE /v3/artifacts`
against the existing model. Any integration could then register cards the widget
already knows how to render, and this stops being a special case.

**Option B — a generic media renderer in the widget.** Have the widget render a
tool result that declares itself as media, regardless of tool name. For example,
any tool result shaped:

```json
{ "media": [ { "kind": "image|video|audio|document",
              "url": "https://...",
              "title": "optional",
              "caption": "optional" } ] }
```

renders inline the way artifact cards already do. This needs no new API surface,
no new model, and no per-integration work — every custom tool gains the ability
to show something.

## Why it is worth doing

The original customer request was explicitly about showing a demo video instead
of another paragraph. That lands on WhatsApp today and falls flat in the widget,
which is the surface most prospects meet first on a website. Option B in
particular is a small change that every tool builder benefits from, not just us.

## Reference

Working implementation, both directions (read and send):
`github.com/Hari487-coder/assistable-media-bridge`
