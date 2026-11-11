// The four platform onboarding guides, served from the app so customers can reach them.
// Source of truth: docs/guides/*.md (see scripts/build-guides.mjs).

import { renderMarkdown, titleOf } from '../core/markdown';
import { GUIDE_MARKDOWN } from './guides-content';

export interface GuideInfo {
  slug: string;
  platform: string;
  summary: string;
}

export const GUIDES: GuideInfo[] = [
  { slug: 'zapier', platform: 'Zapier', summary: 'Add a “Webhooks by Zapier” POST step to the end of a Zap.' },
  { slug: 'make', platform: 'Make', summary: 'Add an HTTP “Make a request” module to the end of a scenario.' },
  { slug: 'n8n', platform: 'n8n', summary: 'Add an HTTP Request node to the end of a workflow.' },
  { slug: 'pipedream', platform: 'Pipedream', summary: 'Add a “Send any HTTP Request” step to the end of a workflow.' },
];

/** "What is a check?": the concept page every other page links to for a definition. */
export const CONCEPT_SLUG = 'checks';

const DOC_HOST = 'https://ping.stepcanary.com';

/**
 * Render a guide. `pingBase` is this deployment's ping hostname; with `token` (a signed-in
 * user's own check) every example URL becomes that check's real ping URL, ready to copy.
 */
export function renderGuide(slug: string, pingBase: string, token?: string): { title: string; html: string } | null {
  const source = GUIDE_MARKDOWN[slug];
  if (!source) return null;
  const base = pingBase.replace(/\/$/, '');
  let md = source.split(DOC_HOST).join(base);
  if (token) {
    md = md
      .split('…/p/your-token').join(`${base}/p/${token}`)
      .split('/p/YOUR-TOKEN').join(`/p/${token}`)
      .split('/p/your-token').join(`/p/${token}`)
      .split(`${base}/p/…`).join(`${base}/p/${token}`);
  }
  return { title: titleOf(md), html: renderMarkdown(md) };
}
